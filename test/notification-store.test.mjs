import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.mjs";
import { NotificationStore } from "../src/notification-store.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-store-")), file = path.join(dir, "h.sqlite"), harness = new HarnessStore(file);
  harness.createRoot({ sessionId: "root", sessionFile: path.join(dir, "root.jsonl"), cwd: dir, repositoryRoot: dir, name: "Root", actorToken: "token", launch: {} });
  harness.markActorLifecycle("root", 1, "stopped");
  const store = new NotificationStore(file, { idleMs: 100 });
  t.after(async () => { store.close(); harness.close(); await rm(dir, { recursive: true, force: true }); });
  return { file, harness, store };
}
const request = { key: "choice", title: "Exact choice", body: "Choose the target", expiresIn: 86400 };
const endpoint = "a".repeat(64);

test("delivery retries, lease crash recovery, stale receipts, and accepted restart dedupe are durable", async t => {
  const { file, store } = await fixture(t); const item = store.request("root", request, 1000);
  assert.deepEqual(store.claim([], 1000), []); assert.deepEqual(store.deliveries(item.id), []);
  let claim = store.claim([endpoint], 1000)[0]; assert.equal(claim.attempt, 1);
  assert.deepEqual(store.claim([endpoint], 1001), []);
  const reconnected = new NotificationStore(file); t.after(() => reconnected.close());
  assert.deepEqual(reconnected.claim([endpoint], 60999), []);
  const recovered = reconnected.claim([endpoint], 61000)[0]; assert.equal(recovered.attempt, 2); assert.notEqual(recovered.leaseId, claim.leaseId);
  assert.deepEqual(store.receipt({ id: item.id, endpointId: endpoint, leaseId: claim.leaseId, status: "accepted" }, 61001), { recorded: false });
  store.receipt({ id: item.id, endpointId: endpoint, leaseId: recovered.leaseId, status: "retry" }, 61001);
  assert.deepEqual(store.claim([endpoint], 91000), []);
  claim = store.claim([endpoint], 91001)[0]; assert.equal(claim.attempt, 3);
  store.receipt({ id: item.id, endpointId: endpoint, leaseId: claim.leaseId, status: "accepted" }, 91002);
  assert.deepEqual(reconnected.claim([endpoint], 200000), []);
  assert.deepEqual({ ...store.deliveries(item.id)[0] }, { endpointId: endpoint, state: "accepted", attempts: 3, code: "accepted", acceptedAt: 91002 });
  assert.equal(store.request("root", { ...request, expiresIn: 1 }, 200000).expiresAt, item.expiresAt);
});

test("read suppresses pending retry without resolution; expiry cannot reopen; exhausted crash leases terminate", async t => {
  const { store } = await fixture(t); const item = store.request("root", request, 1000);
  const claim = store.claim([endpoint], 1000)[0]; store.receipt({ id: item.id, endpointId: endpoint, leaseId: claim.leaseId, status: "retry" }, 1001);
  assert.equal(store.read(item.id, 2000).state, "pending"); assert.deepEqual(store.claim([endpoint], 10000), []);
  assert.equal(store.deliveries(item.id)[0].state, "expired");
  store.resolveKey("root", request.key, 10001); assert.equal(store.request("root", request, 10002).state, "resolved");
  const exp = store.request("root", { ...request, key: "expiry", expiresIn: 1 }, 20000); assert.equal(store.get(exp.id, 21000).state, "expired");
  assert.equal(store.resolveKey("root", "expiry", 21001).state, "expired");
  const exhaust = store.request("root", { ...request, key: "exhaust" }, 30000);
  for (let n = 1; n <= 5; n++) assert.equal(store.claim([endpoint], 30000 + (n - 1) * 60000)[0].attempt, n);
  assert.deepEqual(store.claim([endpoint], 330000), []); assert.equal(store.deliveries(exhaust.id)[0].state, "failed");
});

test("family episode survives store restart and detached jobs do not extend idle", async t => {
  const { file, store } = await fixture(t);
  store.observe("root", { liveActors: ["root"], now: 1000 }); store.observe("root", { now: 1100 });
  const restarted = new NotificationStore(file, { idleMs: 100 }); t.after(() => restarted.close());
  const item = restarted.observe("root", { backgroundCount: 2, now: 1200 }); assert.equal(item.kind, "idle"); assert.match(item.body, /2 background jobs are still running/);
  assert.equal(store.observe("root", { now: 1500 }), null); assert.equal(store.list({}, 1500).notifications.length, 1);
});

test("future notification format rejects before adding tables and leaves core guards intact", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-format-")), file = path.join(dir, "h.sqlite"); t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file); db.exec("CREATE TABLE notification_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO notification_meta VALUES('version','99'); PRAGMA user_version=2;");
  assert.throws(() => new NotificationStore(file), /unsupported notification/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='notifications'").get().n, 0);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2); db.close();
});

for (const origin of ["user", "cron"]) test(`durable ${origin} origin survives intervening ownership, restart and duplicate handoff`, async t => {
  const { file, store } = await fixture(t);
  store.observe("root", { liveActors: ["root"], owner: origin, now: 1000 });
  const bound = store.bindOrigin("root", "background:job", 1050); assert.equal(bound.owner, origin);
  store.observe("root", { now: 1100 }); store.observe("root", { now: 1200 });
  if (origin === "cron") store.noteUserInput("root", 1250);
  store.observe("root", { liveActors: ["root"], owner: origin === "user" ? "cron" : "user", now: 1300 });
  store.observe("root", { now: 1400 }); store.observe("root", { now: 1500 });
  const restarted = new NotificationStore(file, { idleMs: 100 }); t.after(() => restarted.close());
  assert.equal(restarted.bindOrigin("root", "background:job", 1400).owner, origin, "retry cannot reattribute immutable origin");
  restarted.noteContinuation("root", "background:job", 1050, 1600);
  restarted.observe("root", { liveActors: ["root"], now: 1700 });
  restarted.observe("root", { now: 1800 }); const notice = restarted.observe("root", { now: 1900 });
  assert.equal(notice?.kind ?? null, origin === "user" ? "idle" : null);
  restarted.noteContinuation("root", "background:job", 1050, 2000);
  const db = new DatabaseSync(file); t.after(() => db.close());
  assert.equal(db.prepare("SELECT pending_owner FROM notification_families WHERE root_id='root'").get().pending_owner, null, "duplicate completion cannot seed another episode");
  assert.equal(db.prepare("SELECT count(*) AS n FROM notification_origins").get().n, 1);
});

test("origin ties, missing timestamps and prehistory remain explicit unknown, never latest-owner user work", async t => {
  const { store } = await fixture(t);
  store.observe("root", { liveActors: ["root"], owner: "user", now: 1000 });
  store.observe("root", { now: 1100 }); store.observe("root", { now: 1200 });
  store.observe("root", { liveActors: ["root"], owner: "cron", now: 2000 });
  store.noteUserInput("root", 2000);
  for (const [key, stamp] of [["missing", null], ["invalid", "bad"], ["prehistory", 900], ["first-tie", 1000], ["conflicting-tie", 2000]]) {
    assert.equal(store.bindOrigin("root", key, stamp).owner, "unknown", key);
  }
  assert.equal(store.bindOrigin("root", "before-conflict", 1999).owner, "user");
  assert.equal(store.bindOrigin("root", "after-conflict", 2001).owner, "user", "sequence orders checkpoints once launch is strictly later");
  store.observe("root", { now: 2100 }); store.observe("root", { now: 2200 });
  store.noteContinuation("root", "missing", null, 2300);
  store.observe("root", { liveActors: ["root"], now: 2400 }); store.observe("root", { now: 2500 });
  assert.equal(store.observe("root", { now: 2600 }), null);
  store.noteUserInput("root", 2700); store.observe("root", { liveActors: ["root"], now: 2800 }); store.observe("root", { now: 2900 });
  assert.equal(store.observe("root", { now: 3000 }).kind, "idle", "real user admission overrides unknown");
});
