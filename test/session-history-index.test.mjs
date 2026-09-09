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

class CountingReader {
  constructor() { this.delegate = new VisibleTranscriptReader(); this.reads = 0; this.clears = 0; }
  clear(file) { this.clears += 1; this.delegate.clear(file); }
  async read(options) { this.reads += 1; return this.delegate.read(options); }
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
  const directive = "<!-- taihou.presentation.v1 body=happy face=smile -->\n\u001b[31mPublic\u001b[0m assistant \u001b]0;private-osc-title\u0007text\u0001";
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
  for (const secret of ["abandoned", "reasoning", "private-tool-token", "progress", "taihou", "hidden-input-id", "private-osc-title"]) {
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
  assert.equal(reader.reads, 1, "a process without a projection cache must reread canonically through VisibleTranscriptReader");
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
  assert.equal(reader.reads, 1, "subsequent open must reuse the canonical projection cache");
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
  assert.equal(reader.reads, 11, "the oldest complete projection must be evicted after the eight-session cap");
});

for (const knownReceipt of [false, true]) {
  test(`index preserves ordinary marker-looking user text without matching receipt evidence${knownReceipt ? " when another entry owns the receipt" : " when no receipt exists"}`, async (t) => {
    const f = await fixture(t); const { id, sessionFile, databasePath } = f;
    const store = inputReceiptStore(t, f);
    const inputId = "literal-marker-input";
    const literal = `Commander quotes a marker\n\n<!-- persistent-harness-input:${inputId} -->`;
    const entries = [header(id)];
    if (knownReceipt) {
      entries.push(message("original", null, "user", `Original accepted body\n\n<!-- persistent-harness-input:${inputId} -->`));
      store.createActorInput(id, { inputId, message: "Original accepted body" }, Date.parse("2026-01-01T00:00:00Z"));
      store.completeActorInput(inputId, id, Date.parse("2026-01-01T00:00:00Z"), "original");
      assert.throws(() => store.createActorInput(id, { inputId, message: "Commander quotes a marker" }), /different input/);
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
  const oldReader = { clear: file => reader.clear(file), async read(options) {
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
