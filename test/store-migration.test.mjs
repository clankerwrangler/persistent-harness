import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";

test("schema-1 storage migrates image receipts and sender transcript linkage in place", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-image-migration-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "harness.sqlite"); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, actor_token TEXT NOT NULL, actor_generation INTEGER NOT NULL);
    CREATE TABLE actor_inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL,
      behavior TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_at INTEGER, accepted_generation INTEGER) STRICT;
    CREATE TABLE messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES sessions(id), target_id TEXT NOT NULL REFERENCES sessions(id),
      relationship TEXT NOT NULL, delivery_mode TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      accepted_at INTEGER NOT NULL, queued_at INTEGER, delivered_at INTEGER, acknowledged_at INTEGER, last_error TEXT) STRICT;
    INSERT INTO sessions VALUES ('s', 'token', 1);
    INSERT INTO actor_inputs VALUES ('i', 's', 'legacy', 'auto', 'queued', 1, NULL, NULL);
    PRAGMA user_version = 1;`); db.close();
  const store = new HarnessStore(file); store.close();
  const migrated = new DatabaseSync(file, { readOnly: true });
  const columns = migrated.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name);
  const row = migrated.prepare("SELECT images_json, digest FROM actor_inputs WHERE id = 'i'").get();
  const receipt = migrated.prepare("SELECT digest FROM actor_input_receipts WHERE id = 'i'").get();
  const messageColumns = migrated.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
  const messageIndex = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_sender_entries'").get();
  const contextUsageTable = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_usage'").get(); migrated.close();
  assert(columns.includes("images_json")); assert(columns.includes("digest")); assert.equal(row.images_json, "[]");
  assert.match(row.digest, /^[a-f0-9]{64}$/); assert.equal(receipt.digest, row.digest);
  assert(messageColumns.includes("sender_entry_id")); assert.equal(messageIndex.name, "message_sender_entries"); assert.equal(contextUsageTable.name, "session_context_usage");
});


test("schema-1 child tasks receive legacy receipts without retroactive history rows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-child-migration-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "harness.sqlite"); const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, actor_token TEXT NOT NULL, actor_generation INTEGER NOT NULL, display_name TEXT NOT NULL);
    CREATE TABLE actor_inputs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL,
      behavior TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, accepted_at INTEGER, accepted_generation INTEGER) STRICT;
    CREATE TABLE messages (id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES sessions(id), target_id TEXT NOT NULL REFERENCES sessions(id),
      relationship TEXT NOT NULL, delivery_mode TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL,
      accepted_at INTEGER NOT NULL, queued_at INTEGER, delivered_at INTEGER, acknowledged_at INTEGER, last_error TEXT) STRICT;
    CREATE TABLE children (session_id TEXT PRIMARY KEY REFERENCES sessions(id));
    CREATE TABLE child_tasks (id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(session_id), kind TEXT NOT NULL,
      prompt TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, submitted_at INTEGER, completed_at INTEGER, error TEXT) STRICT;
    INSERT INTO sessions VALUES ('parent', 'token', 1, 'parent'), ('child', 'child-token', 1, 'old-child');
    INSERT INTO children VALUES ('child');
    INSERT INTO child_tasks VALUES ('task-old', 'child', 'initial', 'old prompt', 'completed', 1, NULL, 2, NULL);
    PRAGMA user_version = 1;`); db.close();
  const store = new HarnessStore(file); store.close();
  const migrated = new DatabaseSync(file, { readOnly: true });
  const columns = migrated.prepare("PRAGMA table_info(child_tasks)").all().map((row) => row.name);
  const row = migrated.prepare("SELECT history_peer_name, history_entry_id FROM child_tasks WHERE id = 'task-old'").get();
  const index = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'child_tasks_history_entries'").get();
  const version = migrated.prepare("PRAGMA user_version").get().user_version; migrated.close();
  assert(columns.includes("history_peer_name")); assert(columns.includes("history_entry_id"));
  assert.equal(row.history_peer_name, "old-child"); assert.equal(row.history_entry_id, "legacy-child-history:task-old");
  assert.equal(index.name, "child_tasks_history_entries"); assert.equal(version, 2);
});
