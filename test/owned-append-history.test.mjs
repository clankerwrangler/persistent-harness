import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionHistoryIndex } from "../src/session-history-index.mjs";
import { VisibleTranscriptReader, transcriptFingerprint } from "../src/visible-transcript-reader.mjs";
import { normalizeSourceWatermark } from "../src/source-watermark.mjs";

const stamp = "2026-01-01T00:00:00.000Z";
const line = entry => JSON.stringify(entry) + "\n";
const message = (id, parentId, text, role = "user") => ({ type: "message", id, parentId, timestamp: stamp,
  message: { role, content: [{ type: "text", text }] } });
async function fixture(t, { receiptReader = null, padding = 256 * 1024 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owned-append-history-"));
  const sessionId = "public-owned-source", sessionFile = path.join(root, "session.jsonl"), databasePath = path.join(root, "history.sqlite");
  const source = { sessionId, sessionFile }, reader = new VisibleTranscriptReader({ inputReceiptReader: receiptReader });
  const index = new SessionHistoryIndex({ databasePath, reader });
  const bytes = line({ type: "session", version: 3, id: sessionId, timestamp: stamp, cwd: root })
    + line(message("padding", null, "x".repeat(padding), "toolResult"))
    + line(message("seed", "padding", "public seed oldword"));
  await writeFile(sessionFile, bytes);
  let hash = createHash("sha256").update(bytes), sequence = 0, epoch = 1, owner = randomUUID(), generation = 1;
  const hint = async () => ({ version: 1, owner, epoch, generation, revision: sequence + epoch, sequence,
    ...source, bytes: Number((await stat(sessionFile)).size), digest: hash.copy().digest("hex"),
    fingerprint: transcriptFingerprint(await stat(sessionFile, { bigint: true })) });
  const append = async entries => { const suffix = entries.map(line).join(""); await appendFile(sessionFile, suffix);
    hash.update(suffix); sequence += entries.length; return Buffer.byteLength(suffix); };
  const refresh = async () => index.refresh([source], { automatic: true, sourceWatermark: await hint() });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const state = () => db.prepare("SELECT * FROM sources WHERE session_id = ?").get(sessionId);
  t.after(async () => { db.close(); index.close(); await rm(root, { recursive: true, force: true }); });
  return { source, root, reader, index, databasePath, sessionFile, hint, append, refresh, state,
    rebase: async () => { hash = createHash("sha256").update(await readFile(sessionFile)); epoch++; generation++; },
    restartOwner: () => { owner = randomUUID(); epoch = 1; generation = 1; sequence = 0; } };
}
async function countReads(file, operation) {
  const originalOpen = fs.open; let bytes = 0;
  fs.open = async function(name, ...args) {
    const handle = await originalOpen.call(this, name, ...args);
    if (name === file) { const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const result = await read(...readArgs); bytes += result.bytesRead; return result; }; }
    return handle;
  };
  syncBuiltinESMExports();
  try { return { value: await operation(), bytes: () => bytes }; }
  finally { fs.open = originalOpen; syncBuiltinESMExports(); }
}

test("normal and coalesced owned appends hash only their contiguous suffix; snapshots expose durable provenance", async t => {
  const f = await fixture(t); await f.refresh();
  assert.equal(f.state().requires_reconcile, 0);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const suffix = await f.append([
      { type: "custom", id: `custom${i}`, parentId: i ? `next${i - 1}` : "seed", timestamp: stamp, customType: "public", data: { public: i } },
      message(`next${i}`, `custom${i}`, "public new suffix"),
    ]);
    const result = await countReads(f.sessionFile, () => f.refresh());
    assert.deepEqual(result.value.indexed, [f.source.sessionId]);
    assert.equal(result.bytes(), suffix);
    assert.equal(f.state().requires_reconcile, 1);
    samples.push({ appendBytes: suffix, archiveBytes: (await stat(f.sessionFile)).size, refreshBytes: result.bytes() });
  }
  const repeated = await countReads(f.sessionFile, () => f.refresh());
  assert.equal(repeated.bytes(), 0, "the reconciliation bit must not make automatic maintenance hot-loop");
  const found = await f.index.search({ sessions: [f.source], query: "new suffix", snapshot: true });
  assert.equal(found.matches.length, 3); assert.equal(found.freshness.current, false);
  assert.equal(found.freshness.unverifiedPrefixSources, 1); assert.equal(found.freshness.reconciliationRequired, true);
  assert.deepEqual(found.pendingSessionIds, [], "full reconciliation is distinct from physical catch-up");
  await assert.rejects(f.index.search({ sessions: [f.source], query: "new suffix" }), /strict reconciliation/);
  const strict = await countReads(f.sessionFile, () => f.index.refresh([f.source]));
  assert.equal(strict.bytes(), (await stat(f.sessionFile)).size, "strict bypasses both unchanged DB and cached prefix shortcuts");
  assert.equal(f.state().requires_reconcile, 0);
  t.diagnostic(JSON.stringify(samples));
});

test("shared-reader cache advancement preserves an accepted cursor without certifying prefix bytes", async t => {
  const f = await fixture(t); await f.refresh();
  const suffix = await f.append([message("advanced", "seed", "public advanced suffix")]);
  const all = await countReads(f.sessionFile, async () => {
    await f.reader.read({ ...f.source, includeTitleTurn: true });
    return f.refresh();
  });
  assert.equal(all.bytes(), suffix, "history must reuse the same authenticated suffix hash, not reread the old prefix");
  assert.equal(f.state().requires_reconcile, 1);
});

test("same-fingerprint unverified source versions force canonical strict reconciliation and reject rewritten citations", async t => {
  const f = await fixture(t); await f.refresh();
  await f.append([message("soft", "seed", "public soft suffix")]); await f.refresh();
  const original = await readFile(f.sessionFile, "utf8");
  await writeFile(f.sessionFile, original.replace("oldword", "newword"));
  // Simulate an equal recorded fingerprint for an explicitly unverified source version.
  const fp = transcriptFingerprint(await stat(f.sessionFile, { bigint: true }));
  const db = new DatabaseSync(f.databasePath);
  db.prepare("UPDATE sources SET dev=?, ino=?, size=?, mtime_ns=?, ctime_ns=? WHERE session_id=?")
    .run(fp.dev, fp.ino, fp.size, fp.mtimeNs, fp.ctimeNs, f.source.sessionId); db.close();
  await f.reader.read(f.source); // observing new metadata is not prefix verification
  const before = await f.index.search({ sessions: [f.source], query: "oldword", snapshot: true });
  assert.deepEqual(before.matches, []); assert.deepEqual(before.unavailableSessionIds, [f.source.sessionId]);
  const strict = await countReads(f.sessionFile, () => f.index.refresh([f.source]));
  assert.equal(strict.bytes(), Buffer.byteLength(original));
  assert.equal(f.state().requires_reconcile, 0);
  assert.equal((await f.index.search({ sessions: [f.source], query: "oldword" })).matches.length, 0);
  assert.equal((await f.index.search({ sessions: [f.source], query: "newword" })).matches[0].entryId, "seed");
});

test("strict rewrite plus growth and restart recover unverified prefixes before clearing the durable bit", async t => {
  const f = await fixture(t); await f.refresh(); await f.append([message("soft", "seed", "public soft suffix")]); await f.refresh();
  const rewritten = (await readFile(f.sessionFile, "utf8")).replace("oldword", "newword") + line(message("growth", "soft", "public growth"));
  await writeFile(f.sessionFile, rewritten);
  f.index.close();
  const restarted = new SessionHistoryIndex({ databasePath: f.databasePath }); t.after(() => restarted.close());
  assert.equal(f.state().requires_reconcile, 1);
  const result = await countReads(f.sessionFile, () => restarted.refresh([f.source]));
  assert.equal(result.bytes(), Buffer.byteLength(rewritten)); assert.equal(f.state().requires_reconcile, 0);
  assert.equal((await restarted.search({ sessions: [f.source], query: "oldword" })).matches.length, 0);
  assert.equal((await restarted.search({ sessions: [f.source], query: "growth" })).matches[0].entryId, "growth");
});

test("wrong digest, owner restart, epoch/branch changes and cold caches take canonical recovery", async t => {
  for (const mode of ["digest", "owner", "epoch", "cold"]) {
    const f = await fixture(t); await f.refresh();
    const suffix = await f.append([message(`suffix-${mode}`, "seed", "public suffix")]);
    if (mode === "owner") f.restartOwner();
    if (mode === "epoch") await f.rebase();
    if (mode === "cold") f.reader.clear(f.sessionFile);
    const hint = await f.hint(); if (mode === "digest") hint.digest = "0".repeat(64);
    const result = await countReads(f.sessionFile, () => f.index.refresh([f.source], { automatic: true, sourceWatermark: hint }));
    assert.deepEqual(result.value.errors, []); assert.ok(result.bytes() > suffix, mode);
    assert.equal(f.state().requires_reconcile, 0, mode);
  }
});

test("receipt-only invalidation and complete-inventory ambiguity retain selected-span and marker checks", async t => {
  const inputId = "public-input";
  let receipt = null;
  const f = await fixture(t, { receiptReader: candidate => candidate === inputId ? receipt : null, padding: 1024 });
  await f.append([message("legacy", "seed", `body\n\n<!-- persistent-harness-input:${inputId} -->`)]);
  await f.refresh();
  receipt = { sessionId: f.source.sessionId, inputId, outcome: "delivered", acceptedAt: Date.parse(stamp), source: "user",
    origin: null, entryId: "legacy", message: "body", images: [], clientMessageId: null };
  await f.append([message("after-receipt", "legacy", "public suffix")]); await f.refresh();
  assert.equal(f.state().requires_reconcile, 0, "receipt invalidation disallows the soft path");
  assert.equal((await f.index.open({ session: f.source, entryId: "legacy", snapshot: true, before: 0, after: 0 })).messages[0].text, "body");
  // Complete inventory, not suffix-only marker matching, must make an unbound duplicate ambiguous.
  receipt = { ...receipt, entryId: null }; await f.refresh();
  await f.append([message("duplicate", "after-receipt", `body\n\n<!-- persistent-harness-input:${inputId} -->`)]); await f.refresh();
  const opened = await f.index.open({ session: f.source, entryId: "legacy", snapshot: true, before: 0, after: 0 });
  assert.match(opened.messages[0].text, /persistent-harness-input/);
  assert.equal(f.state().requires_reconcile, 1);
});

test("watermarks project only bounded fixed fields and bind to the exact authenticated source", () => {
  assert.equal(normalizeSourceWatermark({ owner: "credential" }), null);
  const value = { version: 1, owner: randomUUID(), epoch: 1, revision: 1, generation: 1, sequence: 0, bytes: 0,
    sessionId: "public", sessionFile: "/public", digest: "0".repeat(64), fingerprint: { dev: "1", ino: "2", size: 0, mtimeNs: "3", ctimeNs: "4" },
    untrustedExtra: "not retained" };
  assert.equal(normalizeSourceWatermark(value, { sessionId: "other", sessionFile: "/public" }), null);
  assert.equal("untrustedExtra" in normalizeSourceWatermark(value), false);
});


test("validated populated v3 indexes migrate additively without archive rescanning or losing FTS/receipt rows", async t => {
  const inputId = "public-migration-input";
  const receipt = { sessionId: "public-owned-source", inputId, outcome: "delivered", acceptedAt: Date.parse(stamp),
    source: "user", origin: null, entryId: "migration-user", message: "migration body", images: [], clientMessageId: null };
  const f = await fixture(t, { receiptReader: candidate => candidate === inputId ? receipt : null });
  await f.append([message("migration-user", "seed", `migration body\n\n<!-- persistent-harness-input:${inputId} -->`)]);
  await f.refresh();
  f.index.close();
  const db = new DatabaseSync(f.databasePath);
  const before = { rows: db.prepare("SELECT * FROM documents").all(), fts: db.prepare("SELECT rowid FROM message_fts").all(),
    receipts: db.prepare("SELECT * FROM receipt_dependencies").all() };
  assert.equal(before.receipts.length, 1, "the populated v3 fixture includes a real receipt dependency");
  assert.equal(f.reader.historyReceiptsMatch(f.source.sessionId, before.receipts), true);
  db.exec("ALTER TABLE sources DROP COLUMN source_cursor; ALTER TABLE sources DROP COLUMN requires_reconcile; PRAGMA user_version=3;");
  db.close();
  class NoArchiveReader extends VisibleTranscriptReader { async read() { assert.fail("migration must not scan canonical archives"); } }
  const migrated = new SessionHistoryIndex({ databasePath: f.databasePath, reader: new NoArchiveReader({ inputReceiptReader: candidate => candidate === inputId ? receipt : null }) }); t.after(() => migrated.close());
  assert.equal(f.state().requires_reconcile, 0); assert.equal(f.state().source_cursor, null);
  assert.deepEqual((await migrated.refresh([f.source])).unchanged, [f.source.sessionId]);
  const after = new DatabaseSync(f.databasePath, { readOnly: true });
  assert.deepEqual(after.prepare("SELECT * FROM documents").all(), before.rows);
  assert.deepEqual(after.prepare("SELECT rowid FROM message_fts").all(), before.fts);
  assert.deepEqual(after.prepare("SELECT * FROM receipt_dependencies").all(), before.receipts);
  after.close();
  const result = await countReads(f.sessionFile, () => migrated.search({ sessions: [f.source], query: "seed", snapshot: true }));
  assert.equal(result.value.matches[0].entryId, "seed");
  assert.ok(result.bytes() > 0 && result.bytes() < 1024, "only the selected canonical citation is hydrated");
});
