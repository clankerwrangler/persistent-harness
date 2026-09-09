import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HarnessStore } from "../src/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-read-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "harness.sqlite") };
}
function rootInput(root, sessionId = "origin") {
  return { sessionId, sessionFile: path.join(root, `${sessionId}.jsonl`), cwd: root, repositoryRoot: root,
    name: sessionId, actorToken: "private-test-token" };
}
async function snapshot(directory) {
  const entries = {};
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), metadata = await stat(file, { bigint: true });
    entries[name] = { inode: metadata.ino, size: metadata.size, modified: metadata.mtimeNs,
      digest: createHash("sha256").update(await readFile(file)).digest("hex") };
  }
  return entries;
}

test("read-only metadata lookup does not migrate old tables or change journal mode", async (t) => {
  const { root, file } = await fixture(t);
  const writer = new HarnessStore(file);
  writer.createRoot(rootInput(root), 1); writer.close();
  const legacy = new DatabaseSync(file);
  legacy.exec("PRAGMA journal_mode = DELETE; PRAGMA user_version = 1; ALTER TABLE sessions DROP COLUMN last_activity_at; DROP TABLE actor_input_receipts;");
  legacy.close();
  const before = await snapshot(root);
  const reader = new HarnessStore(file, { readOnly: true });
  try {
    assert.equal(reader.schemaVersion, 1);
    const session = reader.getSession("origin");
    assert.equal(session.cwd, root); assert.equal(session.kind, "root"); assert.equal(session.lastActivityAt, 1);
  } finally { reader.close(); }
  assert.deepEqual(await snapshot(root), before);
  const inspected = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(inspected.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE name = 'actor_input_receipts'").get(), undefined);
  } finally { inspected.close(); }
});

test("read-only SQL rejects writes and sees committed rows in an active WAL", async (t) => {
  const { root, file } = await fixture(t);
  const writer = new HarnessStore(file); t.after(() => writer.close());
  writer.createRoot(rootInput(root), 1);
  const reader = new HarnessStore(file, { readOnly: true }); t.after(() => reader.close());
  writer.createRoot(rootInput(root, "late-root"), 2);
  assert.equal(reader.getSession("late-root").sessionId, "late-root");
  assert.throws(() => reader.recordSessionActivity("origin", 3), /readonly|read-only/i);
  assert.throws(() => reader.createRoot(rootInput(root, "forbidden"), 4), /readonly|read-only/i);
  assert.equal(writer.getSession("origin").lastActivityAt, 1);
  assert.equal(writer.getSession("forbidden"), undefined);
});

test("read-only opening rejects missing files and invalid mode values without creating a database", async (t) => {
  const { file, root } = await fixture(t);
  assert.throws(() => new HarnessStore(file, { readOnly: true }), /open|exist/i);
  assert.deepEqual(await readdir(root), []);
  assert.throws(() => new HarnessStore(file, { readOnly: "true" }), /readOnly/);
  assert.deepEqual(await readdir(root), []);
});
