import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionHistoryIndex, SESSION_HISTORY_SCHEMA_VERSION, parseSessionHistoryQuery } from "../src/session-history-index.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { PROGRESS_ENTRY_TYPE } from "../src/progress-projection.mjs";
import { HarnessStore } from "../src/store.mjs";

function header(id, cwd = "/tmp") {
  return { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd };
}

function message(id, parentId, role, text, timestamp = "2026-01-01T00:00:00Z") {
  return { type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }] } };
}

async function fixture(t, id = "session-a") {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-history-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    id,
    sessionFile: path.join(root, `${id}.jsonl`),
    databasePath: path.join(root, "history.sqlite"),
  };
}

function source(id, sessionFile, sanitizePresentation = false) {
  return { sessionId: id, sessionFile, sanitizePresentation };
}

function inputReceiptStore(t, { root, id, sessionFile }) {
  const store = new HarnessStore(path.join(root, "harness.sqlite"));
  t.after(() => store.close());
  store.createRoot({ sessionId: id, sessionFile, cwd: root, repositoryRoot: null,
    name: "Receipt fixture", actorToken: "fixture-actor-token", launch: {} }, 1);
  return store;
}

function receiptAwareReader(store) {
  return new VisibleTranscriptReader({ inputReceiptReader: (inputId, sessionId) =>
    store.getActorInput(inputId, sessionId, { includeDigest: true }) });
}

class CountingReader extends VisibleTranscriptReader {
  constructor() { super(); this.reads = 0; this.hydrations = []; }
  async read(options) { this.reads += 1; return super.read(options); }
  async readHistoryEntries(options) { this.hydrations.push(options.entries.length); return super.readHistoryEntries(options); }
}

test("warm search is FTS-only after refresh and supports literal terms, phrases, prefixes, roles, and citations", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  await writeFile(sessionFile, [
    header(id),
    message("u1", null, "user", "alpha exact phrase prefixable", "2026-01-01T00:00:01Z"),
    message("a1", "u1", "assistant", "alpha OR operator is text", "2026-01-01T00:00:02Z"),
  ].map(JSON.stringify).join("\n") + "\n");
  const reader = new CountingReader();
  const index = new SessionHistoryIndex({ databasePath, reader });
  t.after(() => index.close());
  assert.deepEqual(await index.refresh([source(id, sessionFile)]), {
    indexed: [id], unchanged: [], removed: [], errors: [],
  });
  assert.equal(reader.reads, 1);

  const phrase = await index.search({ sessions: [source(id, sessionFile)], query: 'alpha "exact phrase" pre*', limit: 5 });
  assert.deepEqual(phrase.matches.map((hit) => hit.entryId), ["u1"]);
  assert.deepEqual(phrase.matches[0].citation, { sessionId: id, entryId: "u1" });
  assert.equal(phrase.matches[0].snippet.includes("exact phrase"), true);
  const literalOperator = await index.search({ sessions: [source(id, sessionFile)], query: "OR", roles: ["assistant"] });
  assert.deepEqual(literalOperator.matches.map((hit) => hit.entryId), ["a1"]);
  assert.deepEqual((await index.search({ sessions: [source(id, sessionFile)], query: "alpha", sort: "newest" }))
    .matches.map((hit) => hit.entryId), ["a1", "u1"]);
  assert.deepEqual((await index.search({ sessions: [source(id, sessionFile)], query: "alpha", sort: "oldest" }))
    .matches.map((hit) => hit.entryId), ["u1", "a1"]);
  await assert.rejects(index.search({ sessions: [source(id, sessionFile)], query: "alpha", limit: 21 }), /limit/);
  await assert.rejects(index.search({ sessions: [source(id, sessionFile)], query: "alpha", snippetChars: 801 }), /snippetChars/);
  assert.equal(reader.reads, 1, "warm searches must use the projection cached by refresh");
  assert.equal((await index.refresh([source(id, sessionFile)])).unchanged[0], id);
  assert.equal(reader.reads, 1, "an unchanged refresh must not reread the transcript");

  assert.equal(parseSessionHistoryQuery("alpha OR beta").match, '"alpha" AND "OR" AND "beta"');
  assert.throws(() => parseSessionHistoryQuery('"unterminated'), /unterminated/);
  assert.throws(() => parseSessionHistoryQuery("alpha\u0000beta"), /control characters/);
  assert.throws(() => parseSessionHistoryQuery("bad*middle"), /supported only/);
});

test("append and file replacement rebuild only the changed canonical session and remove stale FTS rows", async (t) => {
  const { root, id, sessionFile, databasePath } = await fixture(t);
  const otherId = "session-b";
  const otherFile = path.join(root, `${otherId}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "old unique"))}\n`);
  await writeFile(otherFile, `${JSON.stringify(header(otherId))}\n${JSON.stringify(message("b1", null, "user", "stable other"))}\n`);
  const reader = new CountingReader();
  const index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  const sessions = [source(id, sessionFile), source(otherId, otherFile)];
  assert.deepEqual((await index.refresh(sessions)).indexed, [id, otherId]);
  assert.equal(reader.reads, 2);

  await appendFile(sessionFile, `${JSON.stringify(message("a1", "u1", "assistant", "new appended"))}\n`);
  const appended = await index.refresh(sessions);
  assert.deepEqual(appended.indexed, [id]);
  assert.deepEqual(appended.unchanged, [otherId]);
  assert.equal(reader.reads, 3);
  assert.deepEqual((await index.search({ sessions, query: "appended" })).matches.map((hit) => hit.entryId), ["a1"]);

  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u2", null, "user", "replacement only"))}\n`);
  await rename(replacement, sessionFile);
  const replaced = await index.refresh(sessions);
  assert.deepEqual(replaced.indexed, [id]);
  assert.equal((await index.search({ sessions, query: "appended" })).matches.length, 0);
  assert.deepEqual((await index.search({ sessions, query: "replacement" })).matches.map((hit) => hit.entryId), ["u2"]);
});

test("index follows only the active branch and inherits visible transcript privacy projection", async (t) => {
  const f = await fixture(t); const { id, sessionFile, databasePath } = f;
  const store = inputReceiptStore(t, f);
  const input = { inputId: "hidden-input-id", message: "hello", behavior: "auto" };
  store.createActorInput(id, input, Date.parse("2026-01-01T00:00:00Z"));
  store.completeActorInput(input.inputId, id, Date.parse("2026-01-01T00:00:00Z"), "u1");
  assert.equal(store.getActorInput(input.inputId, id).entryId, "u1");
  assert.throws(() => store.createActorInput(id, { ...input, message: "different body" }), /different input/,
    "The actual receipt owner binds the canonical input body digest");
  const directive = "<!-- harness.presentation.v1 body=happy face=smile -->\n\u001b[31mPublic\u001b[0m assistant \u001b]0;private-osc-title\u0007text\u0001";
  const entries = [
    header(id),
    message("u1", null, "user", "hello\n\n<!-- persistent-harness-input:hidden-input-id -->"),
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "private reasoning phrase" },
        { type: "toolCall", name: "ipython", arguments: { token: "private-tool-token" } },
        { type: "text", text: directive },
      ] } },
    message("abandoned", "a1", "user", "abandoned branch phrase"),
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "progress", parentId: "a1",
      timestamp: "2026-01-01T00:00:02Z", data: { summary: "private progress phrase" } },
    message("selected", "progress", "user", "selected branch phrase"),
  ];
  await writeFile(sessionFile, `${entries.map(JSON.stringify).join("\n")}\n`);
  const index = new SessionHistoryIndex({ databasePath, reader: receiptAwareReader(store) }); t.after(() => index.close());
  const sessions = [source(id, sessionFile, true)];
  await index.refresh(sessions);
  assert.deepEqual((await index.search({ sessions, query: "selected" })).matches.map((hit) => hit.entryId), ["selected"]);
  for (const secret of ["abandoned", "reasoning", "private-tool-token", "progress", "harness", "hidden-input-id", "private-osc-title"]) {
    assert.equal((await index.search({ sessions, query: secret })).matches.length, 0, `${secret} must not be searchable`);
  }
  const visible = await index.search({ sessions, query: "Public" });
  assert.equal(visible.matches[0].snippet, "Public assistant text");
});

test("derived database stores no raw transcript text column and wrong schema versions rebuild destructively", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  await writeFile(sessionFile, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "never stored as document content"))}\n`);
  let index = new SessionHistoryIndex({ databasePath });
  await index.refresh([source(id, sessionFile)]);
  index.close();

  let db = new DatabaseSync(databasePath);
  assert.equal(db.prepare("SELECT text FROM message_fts LIMIT 1").get().text, null,
    "contentless FTS must not expose indexed source text");
  const documentColumns = db.prepare("PRAGMA table_info(documents)").all().map((column) => column.name);
  assert.equal(documentColumns.includes("text"), false);
  db.exec("PRAGMA user_version = 99");
  db.close();

  index = new SessionHistoryIndex({ databasePath });
  t.after(() => index.close());
  db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SESSION_HISTORY_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT count(*) AS count FROM documents").get().count, 0,
    "a wrong derived schema version must be discarded rather than migrated as authority");
  db.close();
  assert.deepEqual((await index.refresh([source(id, sessionFile)])).indexed, [id]);
});

test("open rereads through an injected reader after restart and bounds active chronological context around the cited target", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  const entries = [header(id),
    message("m0", null, "user", "x", "2026-01-01T00:00:00Z"),
    message("m1", "m0", "assistant", "B".repeat(100), "2026-01-01T00:00:01Z"),
    message("target", "m1", "user", "T".repeat(40), "2026-01-01T00:00:02Z"),
    message("m3", "target", "assistant", "after three", "2026-01-01T00:00:03Z"),
    message("m4", "m3", "user", "after four", "2026-01-01T00:00:04Z")];
  await writeFile(sessionFile, `${entries.map(JSON.stringify).join("\n")}\n`);
  let index = new SessionHistoryIndex({ databasePath });
  await index.refresh([source(id, sessionFile)]);
  index.close();

  const reader = new CountingReader();
  index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  const opened = await index.open({
    session: source(id, sessionFile), entryId: "target", before: 2, after: 2, maxChars: 12,
  });
  assert.equal(reader.reads, 0);
  assert.deepEqual(reader.hydrations, [5], "restart hydration reads only the requested ordinal window");
  assert.deepEqual(opened.messages.map((item) => item.entryId), ["target"]);
  assert.equal(Array.from(opened.messages[0].text).length, 12);
  assert.match(opened.messages[0].text, /…$/);
  assert.deepEqual(opened.messages[0].citation, { sessionId: id, entryId: "target" });
  assert.equal(opened.truncated, true);
  assert.equal(opened.truncatedBefore, true);
  assert.equal(opened.truncatedAfter, true);
  assert.equal(opened.messages.reduce((sum, item) => sum + Array.from(item.text).length, 0) <= 12, true);

  const contiguous = await index.open({ session: source(id, sessionFile), entryId: "target", before: 2, after: 2, maxChars: 60 });
  assert.deepEqual(contiguous.messages.map((item) => item.entryId), ["target", "m3"],
    "a skipped oversized near neighbor must not permit a farther message on that side");
  assert.equal(contiguous.truncatedBefore, true);
  assert.equal(contiguous.truncatedAfter, true);

  const wider = await index.open({ session: source(id, sessionFile), entryId: "target", before: 1, after: 1, maxChars: 200 });
  assert.deepEqual(wider.messages.map((item) => item.entryId), ["m1", "target", "m3"]);
  assert.equal(reader.reads, 0, "bounded opens never hydrate the entire archive");
  assert.deepEqual(reader.hydrations, [5, 5, 3]);
  await assert.rejects(index.open({ session: source(id, sessionFile), entryId: "not-active" }), /does not exist/);
  await assert.rejects(index.open({ session: source(id, sessionFile), entryId: "target", before: 9 }), /before/);
  await assert.rejects(index.open({ session: source(id, sessionFile), entryId: "target", maxChars: 16_001 }), /maxChars/);
});

test("refresh is caller-scoped while an explicitly missing canonical file fails only its own rows closed", async (t) => {
  const { root, id, sessionFile, databasePath } = await fixture(t);
  const otherId = "other-caller-session";
  const otherFile = path.join(root, "other.jsonl");
  await writeFile(sessionFile, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "removable phrase"))}\n`);
  await writeFile(otherFile, `${JSON.stringify(header(otherId))}\n${JSON.stringify(message("o1", null, "user", "retained phrase"))}\n`);
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  const selected = source(id, sessionFile);
  const other = source(otherId, otherFile);
  await index.refresh([selected, other]);

  const scoped = await index.refresh([selected]);
  assert.deepEqual(scoped.removed, []);
  assert.deepEqual((await index.search({ sessions: [other], query: "retained" })).matches.map((hit) => hit.entryId), ["o1"],
    "omitting another caller's source must not erase its index rows");

  await rm(sessionFile);
  const missing = await index.refresh([selected]);
  assert.equal(missing.errors.length, 1);
  assert.deepEqual(missing.removed, [id]);
  assert.equal((await index.search({ sessions: [selected], query: "removable" })).matches.length, 0);
  assert.deepEqual((await index.search({ sessions: [other], query: "retained" })).matches.map((hit) => hit.entryId), ["o1"]);
  await assert.rejects(index.open({ session: selected, entryId: "u1" }), /not present/);
});


test("malformed derived database bytes self-heal without touching the canonical transcript", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  const canonical = `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "canonical remains intact"))}\n`;
  await writeFile(sessionFile, canonical); await writeFile(databasePath, "not a sqlite database");
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  assert.deepEqual((await index.refresh([source(id, sessionFile)])).indexed, [id]);
  assert.deepEqual((await index.search({ sessions: [source(id, sessionFile)], query: "canonical" })).matches
    .map((match) => match.entryId), ["u1"]);
  assert.equal(await readFile(sessionFile, "utf8"), canonical);
});


test("same-version schema damage and live SQLite corruption rebuild the disposable index", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  const canonical = `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "recoverable canonical words"))}\n`;
  await writeFile(sessionFile, canonical);
  let damaged = new DatabaseSync(databasePath);
  damaged.exec(`CREATE TABLE sources(wrong_column TEXT); PRAGMA user_version = ${SESSION_HISTORY_SCHEMA_VERSION};`); damaged.close();

  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  assert.deepEqual((await index.refresh([source(id, sessionFile)])).indexed, [id]);
  damaged = new DatabaseSync(databasePath);
  damaged.exec("DROP TABLE message_fts"); damaged.close();
  assert.deepEqual((await index.refresh([source(id, sessionFile)])).indexed, [id],
    "live FTS schema damage must be detected even when the canonical source fingerprint is unchanged");
  damaged = new DatabaseSync(databasePath);
  damaged.exec("DROP TABLE documents"); damaged.close();
  assert.deepEqual((await index.search({ sessions: [source(id, sessionFile)], query: "recoverable" })).matches
    .map((match) => match.entryId), ["u1"],
    "a database failure inside search must destructively rebuild, reindex the allowed sources, and retry once");
  assert.equal(await readFile(sessionFile, "utf8"), canonical);
});

test("derived database, WAL, and shared-memory files remain private under a permissive umask", async (t) => {
  const { root, id, sessionFile, databasePath } = await fixture(t);
  await writeFile(sessionFile, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "private token pages"))}\n`);
  const previousUmask = process.umask(0);
  let index;
  try {
    index = new SessionHistoryIndex({ databasePath });
    await index.refresh([source(id, sessionFile)]);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600, `${path.basename(file)} must be owner-only`);
    }
  } finally {
    process.umask(previousUmask);
    index?.close();
  }
  await chmod(root, 0o755);
  assert.throws(() => new SessionHistoryIndex({ databasePath: path.join(root, "unsafe.sqlite") }),
    /must not be accessible by group or other users/);
  await chmod(root, 0o700);
});

test("complete transcript projections use a strict small least-recently-used cache", async (t) => {
  const { root, databasePath } = await fixture(t);
  const reader = new CountingReader();
  const index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  const sources = [];
  for (let number = 0; number < 10; number += 1) {
    const id = `cache-${number}`;
    const sessionFile = path.join(root, `${id}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify(header(id))}\n${JSON.stringify(message(`m-${number}`, null, "user", `cache phrase ${number}`))}\n`);
    sources.push(source(id, sessionFile));
  }
  await index.refresh(sources);
  assert.equal(reader.reads, 10);
  await index.open({ session: sources[0], entryId: "m-0", before: 0, after: 0, maxChars: 100 });
  assert.equal(reader.reads, 10);
  assert.deepEqual(reader.hydrations, [1], "an evicted complete projection uses bounded canonical hydration");
});

for (const knownReceipt of [false, true]) {
  test(`index preserves ordinary marker-looking user text without matching receipt evidence${knownReceipt ? " when another entry owns the receipt" : " when no receipt exists"}`, async (t) => {
    const f = await fixture(t); const { id, sessionFile, databasePath } = f;
    const store = inputReceiptStore(t, f);
    const inputId = "literal-marker-input";
    const literal = `user quotes a marker\n\n<!-- persistent-harness-input:${inputId} -->`;
    const entries = [header(id)];
    if (knownReceipt) {
      entries.push(message("original", null, "user", `Original accepted body\n\n<!-- persistent-harness-input:${inputId} -->`));
      store.createActorInput(id, { inputId, message: "Original accepted body" }, Date.parse("2026-01-01T00:00:00Z"));
      store.completeActorInput(inputId, id, Date.parse("2026-01-01T00:00:00Z"), "original");
      assert.throws(() => store.createActorInput(id, { inputId, message: "user quotes a marker" }), /different input/);
    }
    entries.push(message("literal", knownReceipt ? "original" : null, "user", literal));
    const canonical = `${entries.map(JSON.stringify).join("\n")}\n`;
    await writeFile(sessionFile, canonical);
    const reader = receiptAwareReader(store);
    const raw = await reader.read({ sessionFile, sessionId: id });
    assert.deepEqual(raw.inputIds, knownReceipt ? [inputId] : [], "Candidate markers are not receipt evidence");
    assert.deepEqual(raw.inputEntries, knownReceipt ? { [inputId]: "original" } : {});
    assert.deepEqual(raw.inputDeliveries, knownReceipt
      ? { [inputId]: { entryId: "original", deliveredAt: "2026-01-01T00:00:00Z" } } : {});
    const index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
    const sessions = [source(id, sessionFile)];
    await index.refresh(sessions);
    const opened = await index.open({ session: sessions[0], entryId: "literal", before: 0, after: 0, maxChars: 1000 });
    assert.equal(opened.messages[0].text, literal, "A marker match alone cannot strip real user text");
    assert.deepEqual((await index.search({ sessions, query: inputId })).matches.map((hit) => hit.entryId), ["literal"]);
    assert.equal(await readFile(sessionFile, "utf8"), canonical);
  });
}


test("version 1 stale receipt projection rebuilds with an unchanged canonical fingerprint", async (t) => {
  const f = await fixture(t), { id, sessionFile, databasePath } = f;
  const store = inputReceiptStore(t, f), inputId = "stale-marker";
  const original = message("original", null, "user", `Original body\n\n<!-- persistent-harness-input:${inputId} -->`);
  const literal = message("literal", original.id, "user", `Quoted marker\n\n<!-- persistent-harness-input:${inputId} -->`);
  store.createActorInput(id, { inputId, message: "Original body" }, Date.parse(original.timestamp));
  store.completeActorInput(inputId, id, Date.parse(original.timestamp), original.id);
  await writeFile(sessionFile, [header(id), original, literal].map(JSON.stringify).join("\n") + "\n");
  const canonicalBefore = await readFile(sessionFile), inode = (await stat(sessionFile)).ino;
  const receiptBefore = store.getActorInput(inputId, id);
  const registryBefore = await readFile(path.join(f.root, "harness.sqlite"));
  const registryWalBefore = await readFile(path.join(f.root, "harness.sqlite-wal"));
  const sessions = [source(id, sessionFile)], reader = receiptAwareReader(store);
  // Seed the known old projected text through the existing derived-index writer.
  const oldReader = { historyReceiptsMatch: (...args) => reader.historyReceiptsMatch(...args), async read(options) {
    const result = await reader.read(options);
    return { ...result, messages: result.messages.map(row => row.id === literal.id ? { ...row, text: "Quoted marker" } : row) };
  } };
  const oldIndex = new SessionHistoryIndex({ databasePath, reader: oldReader });
  await oldIndex.refresh(sessions);
  assert.deepEqual((await oldIndex.search({ sessions, query: inputId })).matches, []);
  oldIndex.close();
  const staleDb = new DatabaseSync(databasePath);
  const fingerprintBefore = staleDb.prepare("SELECT dev, ino, size, mtime_ns, ctime_ns FROM sources WHERE session_id = ?").get(id);
  staleDb.exec("PRAGMA user_version = 1"); staleDb.close();
  const rebuilt = new SessionHistoryIndex({ databasePath, reader: receiptAwareReader(store) }); t.after(() => rebuilt.close());
  const refresh = await rebuilt.refresh(sessions);
  assert.deepEqual(refresh.indexed, [id]); assert.deepEqual(refresh.unchanged, []);
  assert.deepEqual((await rebuilt.search({ sessions, query: inputId })).matches.map(hit => hit.citation), [{ sessionId: id, entryId: literal.id }]);
  const opened = await rebuilt.open({ session: sessions[0], entryId: literal.id, before: 0, after: 0, maxChars: 1000 });
  assert.equal(opened.messages[0].text, literal.message.content[0].text);
  const currentDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(currentDb.prepare("PRAGMA user_version").get().user_version, SESSION_HISTORY_SCHEMA_VERSION);
  assert.deepEqual(currentDb.prepare("SELECT dev, ino, size, mtime_ns, ctime_ns FROM sources WHERE session_id = ?").get(id), fingerprintBefore);
  currentDb.close();
  assert.deepEqual(await readFile(sessionFile), canonicalBefore); assert.equal((await stat(sessionFile)).ino, inode);
  assert.deepEqual(store.getActorInput(inputId, id), receiptBefore);
  assert.deepEqual(await readFile(path.join(f.root, "harness.sqlite")), registryBefore);
  assert.deepEqual(await readFile(path.join(f.root, "harness.sqlite-wal")), registryWalBefore);
});


test("verified prefixes retain partial lines, diff append rows, and reject rewrite-with-growth, branch switches, truncation and replacement", async (t) => {
  const { root, id, sessionFile, databasePath } = await fixture(t);
  const serialize = entries => entries.map(JSON.stringify).join("\n") + "\n";
  let frames = [header(id), message("u1", null, "user", "retained alpha"), message("u2", "u1", "assistant", "abandoned beta")];
  await writeFile(sessionFile, serialize(frames));
  const reader = new CountingReader(), index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  const sessions = [source(id, sessionFile)]; await index.refresh(sessions);
  const originalParse = JSON.parse; let parses = 0;
  JSON.parse = (...args) => { const value = originalParse(...args); if (value?.type && value?.id) parses++; return value; };
  t.after(() => { JSON.parse = originalParse; });
  const appended = JSON.stringify(message("u3", "u2", "user", "completed gamma")) + "\n";
  await appendFile(sessionFile, appended.slice(0, 40));
  assert.deepEqual((await index.refresh(sessions)).errors, []); assert.equal(parses, 0);
  await appendFile(sessionFile, appended.slice(40));
  assert.deepEqual((await index.refresh(sessions)).errors, []); assert.equal(parses, 1, "only the completed suffix frame is parsed");
  assert.equal((await index.search({ sessions, query: "gamma" })).matches[0].entryId, "u3");
  const inode = (await stat(sessionFile)).ino;
  frames = [header(id), message("u1", null, "user", "rewritten delta"), message("u2", "u1", "assistant", "abandoned beta"), message("u3", "u2", "user", "completed gamma"), message("grow", "u3", "user", "growth epsilon")];
  await writeFile(sessionFile, serialize(frames)); assert.equal((await stat(sessionFile)).ino, inode);
  await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "alpha" })).matches.length, 0);
  assert.equal((await index.search({ sessions, query: "delta" })).matches[0].entryId, "u1");
  parses = 0;
  await appendFile(sessionFile, serialize([message("branch", "u1", "user", "selected zeta")])); await index.refresh(sessions);
  assert.equal(parses, 1); assert.equal((await index.search({ sessions, query: "gamma" })).matches.length, 0);
  await assert.rejects(index.open({ session: sessions[0], entryId: "u2" }), /does not exist/);
  await writeFile(sessionFile, serialize([header(id), message("short", null, "user", "short eta")])); await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "delta" })).matches.length, 0);
  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, serialize([header(id), message("replace", null, "user", "replacement theta")])); await rename(replacement, sessionFile);
  await index.refresh(sessions); assert.equal((await index.search({ sessions, query: "theta" })).matches[0].entryId, "replace");
});

test("large projections and restarted indexes hydrate only matched rows or the bounded ordinal window", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t);
  const frames = [header(id)];
  for (let i = 0; i < 600; i++) frames.push(message(`m${i}`, i ? `m${i - 1}` : null, "user", `${i === 300 ? "needletarget" : "ordinary"} ${"x".repeat(8192)}`));
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  let reader = new CountingReader(), index = new SessionHistoryIndex({ databasePath, reader });
  const sessions = [source(id, sessionFile)]; await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "needletarget", limit: 1 })).matches[0].entryId, "m300");
  assert.deepEqual(reader.hydrations, [1]); assert.equal(reader.reads, 1);
  index.close(); reader = new CountingReader(); index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  assert.deepEqual((await index.refresh(sessions)).unchanged, [id]);
  const opened = await index.open({ session: sessions[0], entryId: "m300", before: 1, after: 1, maxChars: 16000 });
  assert.equal(opened.entryId, "m300"); assert.equal(reader.reads, 0); assert.deepEqual(reader.hydrations, [3]);
  await appendFile(sessionFile, JSON.stringify(message("new", "m599", "user", "added later")) + "\n");
  await assert.rejects(index.search({ sessions, query: "needletarget" }), /changed during history hydration/);
});

test("aborted refresh retains committed rows and cannot publish a partly parsed version", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  await writeFile(sessionFile, [header(id), message("old", null, "user", "old snapshot")].map(JSON.stringify).join("\n") + "\n");
  let abortAfterRead;
  class AbortReader extends VisibleTranscriptReader { async read(options) { const result = await super.read(options); abortAfterRead?.abort(new Error("test cancellation")); return result; } }
  const index = new SessionHistoryIndex({ databasePath, reader: new AbortReader() }); t.after(() => index.close());
  await index.refresh(sessions);
  const db = new DatabaseSync(databasePath, { readOnly: true }); t.after(() => db.close());
  const snapshot = () => ({ source: db.prepare("SELECT * FROM sources").all(), rows: db.prepare("SELECT * FROM documents").all() });
  const before = snapshot();
  await appendFile(sessionFile, JSON.stringify(message("new", "old", "user", "new snapshot")) + "\n");
  abortAfterRead = new AbortController();
  await assert.rejects(index.refresh(sessions, { signal: abortAfterRead.signal }), /test cancellation/);
  assert.deepEqual(snapshot(), before, "abort is not source failure and never deletes committed rows");
  abortAfterRead = null; await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "new" })).matches[0].entryId, "new");
});

test("bounded receipt rendering matches complete-inventory projection across restart, ambiguity and receipt-only changes", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), inputId = "legacy-proof";
  const stamp = "2026-01-01T00:00:00.000Z";
  let receipt = { sessionId: id, inputId, outcome: "delivered", acceptedAt: Date.parse(stamp), source: "user", origin: null,
    entryId: null, message: "body", images: [], clientMessageId: null };
  const inputReceiptReader = candidate => candidate === inputId ? receipt : null;
  const proven = message("proven", null, "user", `body\n\n<!-- persistent-harness-input:${inputId} -->`, stamp);
  const literal = message("literal", "proven", "user", `quoted\n\n<!-- persistent-harness-input:${inputId} -->`, stamp);
  await writeFile(sessionFile, [header(id), proven, literal].map(JSON.stringify).join("\n") + "\n");
  const selected = source(id, sessionFile); let index;
  t.after(() => index?.close());
  const compare = async () => {
    const baseline = await new VisibleTranscriptReader({ inputReceiptReader }).read({ sessionFile, sessionId: id, maxMessages: 100, maxBytes: 100000 });
    index?.close(); index = new SessionHistoryIndex({ databasePath, reader: new VisibleTranscriptReader({ inputReceiptReader }) });
    await index.refresh([selected]);
    // Restart once more to ensure direct canonical spans, not a full cache, supply the rendering.
    index.close(); index = new SessionHistoryIndex({ databasePath, reader: new VisibleTranscriptReader({ inputReceiptReader }) });
    for (const expected of baseline.messages.filter(item => ["user", "assistant"].includes(item.role))) {
      const actual = (await index.open({ session: selected, entryId: expected.id, before: 0, after: 0 })).messages[0];
      assert.deepEqual({ text: actual.text, role: actual.role, createdAt: actual.createdAt },
        { text: expected.text, role: expected.role, createdAt: expected.createdAt });
    }
    return baseline;
  };
  let baseline = await compare(); assert.equal(baseline.messages[0].text, "body"); assert.equal(baseline.messages[1].text, literal.message.content[0].text);
  await appendFile(sessionFile, JSON.stringify(message("duplicate", "literal", "user", proven.message.content[0].text, stamp)) + "\n");
  baseline = await compare(); assert.equal(baseline.messages[0].text, proven.message.content[0].text, "duplicate inventory makes legacy proof ambiguous");
  const bytes = await readFile(sessionFile);
  receipt = { ...receipt, entryId: "proven", acceptedAt: receipt.acceptedAt + 1000 };
  await assert.rejects(index.open({ session: selected, entryId: "proven", before: 0, after: 0 }), /receipt dependency changed/);
  baseline = await compare(); assert.equal(baseline.messages[0].text, "body");
  assert.equal(baseline.messages[0].createdAt, stamp, "receipt metadata cannot retime canonical admission");
  assert.equal(baseline.messages[0].delivery.acceptedAt, new Date(receipt.acceptedAt).toISOString());
  assert.equal(baseline.messages[0].delivery.deliveredAt, stamp);
  receipt = null;
  baseline = await compare(); assert.equal(baseline.messages[0].text, proven.message.content[0].text);
  assert.deepEqual(await readFile(sessionFile), bytes, "receipt-only refresh never mutates canonical bytes");
});


for (const growth of [false, true]) test(`ordinary shared-reader observations cannot certify rewritten cached history${growth ? " plus growth" : " at the same size"}`, async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), reader = new VisibleTranscriptReader();
  const frames = [header(id), message("u1", null, "user", "old marker")];
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  const sessions = [source(id, sessionFile)], index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  await index.refresh(sessions);
  frames[1] = message("u1", null, "user", "new marker");
  if (growth) frames.push(message("u2", "u1", "user", "suffix"));
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  await reader.read({ sessionFile, sessionId: id, includeTitleTurn: true });
  await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "old" })).matches.length, 0);
  assert.equal((await index.search({ sessions, query: "new" })).matches[0].entryId, "u1");
});


test("real prefix reads and incremental FTS transactions stop on cancellation without losing the old version", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  await writeFile(sessionFile, [header(id), message("padding", null, "toolResult", "x".repeat(1024 * 1024)), message("old", "padding", "user", "old snapshot")].map(JSON.stringify).join("\n") + "\n");
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close()); await index.refresh(sessions);
  const db = new DatabaseSync(databasePath, { readOnly: true }); t.after(() => db.close());
  const snapshot = () => ({ source: db.prepare("SELECT * FROM sources").all(), rows: db.prepare("SELECT * FROM documents").all() });
  const before = snapshot();
  await appendFile(sessionFile, JSON.stringify(message("new", "old", "user", "abort-row")) + "\n");
  const originalOpen = fs.open; const reading = new AbortController(); let reads = 0;
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === sessionFile) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); reads++; reading.abort(new Error("cancel prefix")); return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(index.refresh(sessions, { signal: reading.signal }), /cancel prefix/); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  assert.equal(reads, 1); assert.deepEqual(snapshot(), before);
  const originalPrepare = DatabaseSync.prototype.prepare, indexing = new AbortController(); let inserts = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO message_fts")) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = run(...args); inserts++; indexing.abort(new Error("cancel indexing")); return result; };
    }
    return statement;
  };
  try { await assert.rejects(index.refresh(sessions, { signal: indexing.signal }), /cancel indexing/); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.equal(inserts, 1, "only the appended row needs indexing"); assert.deepEqual(snapshot(), before);
  await index.refresh(sessions); assert.equal((await index.search({ sessions, query: "abort-row" })).matches[0].entryId, "new");
});


test("snapshot coverage keeps the full internal pending set beyond the recovery-admission limit", async (t) => {
  const { root, databasePath } = await fixture(t);
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  const sessions = Array.from({ length: 65 }, (_, i) => source(`missing-${i}`, path.join(root, `missing-${i}.jsonl`)));
  const result = await index.search({ sessions, query: "public synthetic", snapshot: true });
  assert.equal(result.freshness.pendingSources, 65);
  assert.equal(result.pendingSessionIds.length, 65, "the supervisor can deduplicate the complete caller-scoped coverage count");
});


test("verified append refresh reads the accepted prefix again for every changed fingerprint", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  await writeFile(sessionFile, [header(id), message("padding", null, "toolResult", "x".repeat(256 * 1024)),
    message("seed", "padding", "user", "public synthetic seed")].map(JSON.stringify).join("\n") + "\n");
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  await index.refresh(sessions);
  const originalOpen = fs.open; let bytesRead = 0;
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === sessionFile) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); bytesRead += result.bytesRead; return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  const samples = [];
  try {
    for (let i = 0; i < 3; i++) {
      const line = JSON.stringify(message(`append-${i}`, i ? `append-${i - 1}` : "seed", "user", "public synthetic append")) + "\n";
      await appendFile(sessionFile, line);
      const before = bytesRead; await index.refresh(sessions);
      const archiveBytes = (await stat(sessionFile)).size;
      const refreshBytes = bytesRead - before;
      assert.equal(refreshBytes, archiveBytes, "verified reuse hashes the entire accepted prefix plus the new suffix");
      samples.push({ appendBytes: Buffer.byteLength(line), archiveBytes, refreshBytes });
    }
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  t.diagnostic(JSON.stringify(samples));
});


test("indexed snapshot queries do not refresh and safely hydrate an appended older branch", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  const reader = new CountingReader(), index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  await writeFile(sessionFile, [header(id), message("old", null, "user", "snapshot anchor")].map(JSON.stringify).join("\n") + "\n");
  await index.refresh(sessions); const reads = reader.reads;
  await appendFile(sessionFile, JSON.stringify(message("padding", "old", "toolResult", "x".repeat(2 * 1024 * 1024))) + "\n"
    + JSON.stringify(message("branch", null, "user", "newbranch newest")) + "\n");
  const originalOpen = fs.open; let bytesRead = 0;
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === sessionFile) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); bytesRead += result.bytesRead; return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  let old;
  try { old = await index.search({ sessions, query: "anchor", snapshot: true }); }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  assert.ok(bytesRead > 0 && bytesRead < 1024, `only the selected canonical entry was read: ${bytesRead} bytes`);
  assert.equal(old.matches[0].entryId, "old"); assert.equal(old.freshness.branch, "indexed");
  assert.equal(old.freshness.current, false); assert.equal(old.freshness.changedSources, 1);
  assert.equal((await index.search({ sessions, query: "newest", snapshot: true })).matches.length, 0);
  assert.equal(reader.reads, reads, "snapshot lookup must not reconstruct the archive");
  await index.refresh(sessions);
  assert.equal((await index.search({ sessions, query: "anchor", snapshot: true })).matches.length, 0);
  assert.equal((await index.search({ sessions, query: "newest", snapshot: true })).matches[0].entryId, "branch");
});

test("snapshot hydration excludes rewritten spans, replacement and changed receipt renderings explicitly", async (t) => {
  const f = await fixture(t), { id, sessionFile, databasePath } = f, sessions = [source(id, sessionFile)];
  let receipt = null;
  const reader = new VisibleTranscriptReader({ inputReceiptReader: () => receipt });
  const index = new SessionHistoryIndex({ databasePath, reader }); t.after(() => index.close());
  const bytes = [header(id), message("entry", null, "user", "oldword\n\n<!-- persistent-harness-input:test -->")].map(JSON.stringify).join("\n") + "\n";
  await writeFile(sessionFile, bytes); await index.refresh(sessions);
  receipt = { inputId: "test", sessionId: id };
  let found = await index.search({ sessions, query: "oldword", snapshot: true });
  assert.equal(found.matches.length, 0); assert.deepEqual(found.unavailableSessionIds, [id]);
  receipt = null;
  await writeFile(sessionFile, bytes.replace("oldword", "newword"));
  found = await index.search({ sessions, query: "oldword", snapshot: true });
  assert.equal(found.matches.length, 0); assert.deepEqual(found.unavailableSessionIds, [id]);
  const replacement = path.join(f.root, "replacement"); await writeFile(replacement, bytes); await rename(replacement, sessionFile);
  found = await index.search({ sessions, query: "oldword", snapshot: true });
  assert.equal(found.matches.length, 0); assert.deepEqual(found.unavailableSessionIds, [id]);
  await writeFile(sessionFile, "");
  found = await index.search({ sessions, query: "oldword", snapshot: true });
  assert.equal(found.matches.length, 0); assert.deepEqual(found.unavailableSessionIds, [id]);
});

test("snapshot readers pin committed source and FTS rows across a yielding maintenance transaction", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  await writeFile(sessionFile, [header(id), message("old", null, "user", "committed anchor")].map(JSON.stringify).join("\n") + "\n");
  await index.refresh(sessions);
  let parent = "old"; const appended = [];
  for (let i = 0; i < 256; i++) { appended.push(message(`new${i}`, parent, "user", "uncommitted addition")); parent = `new${i}`; }
  await appendFile(sessionFile, appended.map(JSON.stringify).join("\n") + "\n");
  const originalPrepare = DatabaseSync.prototype.prepare; let queries;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith("INSERT INTO message_fts")) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const result = run(...args);
        queries ??= Promise.all([
          index.search({ sessions, query: "anchor", snapshot: true }),
          index.search({ sessions, query: "addition", snapshot: true }),
        ]);
        return result;
      };
    }
    return statement;
  };
  try {
    await index.refresh(sessions);
    const [old, added] = await queries;
    assert.equal(old.matches[0].entryId, "old"); assert.equal(added.matches.length, 0);
    assert.equal(old.freshness.changedSources, 1, "freshness belongs to the same committed source version");
  } finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.ok((await index.search({ sessions, query: "addition", snapshot: true })).matches.length);
});


test("an empty or damaged snapshot reports coverage/failure without invoking index recovery", async (t) => {
  const { id, sessionFile, databasePath } = await fixture(t), sessions = [source(id, sessionFile)];
  const index = new SessionHistoryIndex({ databasePath }); t.after(() => index.close());
  const missing = await index.search({ sessions, query: "needle", snapshot: true });
  assert.equal(missing.freshness.missingSources, 1); assert.equal(missing.matches.length, 0);
  await writeFile(sessionFile, [header(id), message("old", null, "user", "needle")].map(JSON.stringify).join("\n") + "\n");
  await index.refresh(sessions);
  const db = new DatabaseSync(databasePath); t.after(() => db.close());
  db.exec("DROP TABLE message_fts");
  await assert.rejects(index.search({ sessions, query: "needle", snapshot: true }));
  assert.equal(db.prepare("SELECT count(*) AS count FROM sources").get().count, 1, "ordinary query cannot discard/rebuild the index");
});
