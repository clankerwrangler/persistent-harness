import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.mjs";
import { NotificationStore } from "../src/notification-store.mjs";
import { IDLE_NOTIFICATION_TTL_MS } from "../src/notification-store.mjs";

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

test("withdrawn and dismissed requests record their closer and close each accepted device once", async t => {
  const { file, store } = await fixture(t), other = "b".repeat(64);
  const withdrawn = store.request("root", request, 1000), dismissed = store.request("root", { ...request, key: "dismiss" }, 1000);
  const unsent = store.request("root", { ...request, key: "unsent" }, 1000);
  for (const claim of store.claim([endpoint, other], 1000)) {
    if (claim.notification.id === unsent.id) continue;
    store.receipt({ id: claim.notification.id, endpointId: claim.endpointId, leaseId: claim.leaseId,
      status: claim.endpointId === other && claim.notification.id === dismissed.id ? "failed" : "accepted" }, 1001);
  }
  assert.deepEqual(store.claimClosures([endpoint, other], 1002), []);
  assert.equal(store.resolveKey("root", request.key, 2000).closedBy, "agent");
  assert.equal(store.transition(dismissed.id, "resolved", 2000, "user").closedBy, "user");
  store.transition(unsent.id, "resolved", 2000, "user");
  assert.throws(() => store.transition(unsent.id, "resolved", 2000, "someone"), /invalid notification closer/);
  const closures = store.claimClosures([endpoint, other], 2001).map(c => [c.notification.id, c.endpointId]).sort();
  assert.deepEqual(closures, [[withdrawn.id, endpoint], [withdrawn.id, other], [dismissed.id, endpoint]].sort());
  const reconnected = new NotificationStore(file); t.after(() => reconnected.close());
  assert.deepEqual(reconnected.claimClosures([endpoint, other], 3000), []);
  assert.equal(reconnected.get(withdrawn.id).closedBy, "agent");
});

test("closes already finished before the close column existed are not sent", async t => {
  const { file, store } = await fixture(t), item = store.request("root", request, 1000);
  const claim = store.claim([endpoint], 1000)[0]; store.receipt({ id: item.id, endpointId: endpoint, leaseId: claim.leaseId, status: "accepted" }, 1001);
  store.resolveKey("root", request.key, 2000);
  const db = new DatabaseSync(file); db.exec("ALTER TABLE notification_deliveries DROP COLUMN close_claimed_at"); db.close();
  const upgraded = new NotificationStore(file); t.after(() => upgraded.close());
  assert.deepEqual(upgraded.claimClosures([endpoint], 3000), []);
});

for (const updatedRowsBeforeFailure of [0, 1]) test(`close migration rolls back schema and rows after ${updatedRowsBeforeFailure} legacy updates`, async t => {
  const { file, store } = await fixture(t);
  for (const key of ["old-a", "old-b"]) {
    const item = store.request("root", { ...request, key }, 1000);
    const claim = store.claim([endpoint], 1000)[0];
    store.receipt({ id: item.id, endpointId: endpoint, leaseId: claim.leaseId, status: "accepted" }, 1001);
    store.resolveKey("root", key, 2000);
  }
  const db = new DatabaseSync(file); t.after(() => db.close());
  db.exec("ALTER TABLE notification_deliveries DROP COLUMN close_claimed_at");
  const before = db.prepare("SELECT * FROM notification_deliveries ORDER BY notification_id").all();
  const version = db.prepare("PRAGMA user_version").get().user_version;
  // Fail the real second migration statement, after the ALTER and optionally
  // a prior row update, rather than mocking the constructor's call sequence.
  db.exec(`CREATE TRIGGER interrupted_close_initialization BEFORE UPDATE ON notification_deliveries
    WHEN (SELECT count(*) FROM notification_deliveries WHERE close_claimed_at=0) >= ${updatedRowsBeforeFailure}
    BEGIN SELECT RAISE(ABORT, 'interrupted_close_initialization'); END;`);
  assert.throws(() => new NotificationStore(file), /interrupted_close_initialization/);
  assert.equal(db.prepare("PRAGMA table_info(notification_deliveries)").all().some(c => c.name === "close_claimed_at"), false,
    "a failed initialization must not publish a column that makes reopen skip it");
  assert.deepEqual(db.prepare("SELECT * FROM notification_deliveries ORDER BY notification_id").all(), before);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
  db.exec("DROP TRIGGER interrupted_close_initialization");
  const upgraded = new NotificationStore(file); t.after(() => upgraded.close());
  assert.deepEqual(upgraded.claimClosures([endpoint], 3000), [], "reopen must initialize all historical closed deliveries");
  assert.deepEqual(db.prepare("SELECT close_claimed_at FROM notification_deliveries").all().map(r => r.close_claimed_at), [0, 0]);
});

test("family episode survives store restart and detached jobs do not extend idle", async t => {
  const { file, store } = await fixture(t);
  store.observe("root", { liveActors: ["root"], now: 1000 }); store.observe("root", { now: 1100 });
  const restarted = new NotificationStore(file, { idleMs: 100 }); t.after(() => restarted.close());
  const item = restarted.observe("root", { backgroundCount: 2, now: 1200 }); assert.equal(item.kind, "idle"); assert.match(item.body, /2 background jobs are still running/);
  assert.equal(store.observe("root", { now: 1500 }), null); assert.equal(store.list({}, 1500).notifications.length, 1);
  const writer = new HarnessStore(file); t.after(() => writer.close());
  const readFamily = store.family.bind(store); let reads = 0;
  t.mock.method(store, "family", id => { reads++; return readFamily(id); });
  writer.setSessionName("root", "Renamed root");
  store.observe("root", { liveActors: ["root"], now: 1600 });
  assert.equal(reads, 1, "ordinary callers still read once");
  const supplied = store.family("root");
  const saved = { ...supplied, members: supplied.members.map(row => Object.assign(Object.create(Object.getPrototypeOf(row)), row)) };
  supplied.members.forEach(Object.freeze); Object.freeze(supplied.members); Object.freeze(supplied);
  reads = 0;
  store.observe("root", { now: 1700 }, supplied);
  assert.equal(reads, 0, "a supplied projection is not read again");
  assert.deepEqual(supplied, saved);
  writer.createChild("root", { sessionId: "starting-child", sessionFile: null, actorToken: "faux-token",
    policy: { name: "Starting", depth: 1, prompt: "fixture" } });
  reads = 0;
  assert.equal(store.observe("root", { now: 1800 }), null, "the next default read sees a newly starting child");
  assert.equal(reads, 1);
  writer.markActorLifecycle("starting-child", 1, "stopped"); writer.setSessionName("root", "Next title");
  reads = 0;
  assert.equal(store.observe("root", { now: 1900 }, undefined), null);
  assert.equal(reads, 1, "explicit undefined also reads current state");
  const next = store.observe("root", { now: 2000, backgroundCount: 2 });
  assert.equal(next.title, "Next title"); assert.match(next.body, /2 background jobs are still running/);
  assert.equal(next.createdAt, 2000); assert.equal(next.expiresAt, 2000 + IDLE_NOTIFICATION_TTL_MS);
  const order = [], now = Date.now;
  store.family = id => { order.push("family"); return readFamily(id); };
  Date.now = () => { order.push("now"); return 2100; };
  try { assert.equal(store.observe("root"), null); } finally { Date.now = now; }
  assert.deepEqual(order, ["now", "family"], "default time is sampled before default family resolution");
});

test("explicit null cancels without fallback and family resolution retains deleted-descendant semantics", async t => {
  const { harness, store } = await fixture(t);
  for (const [id, parent, depth] of [["child", "root", 1], ["grandchild", "child", 2]]) {
    harness.createChild(parent, { sessionId: id, sessionFile: null, actorToken: "faux-token",
      policy: { name: id, depth, prompt: "fixture" } });
    harness.markActorLifecycle(id, 1, "stopped");
  }
  store.observe("grandchild", { liveActors: ["root"], now: 1000 });
  harness.deleteSession("grandchild");
  const family = store.family("grandchild");
  assert.equal(family.rootId, "root"); assert.deepEqual(family.members.map(s => s.id).sort(), ["child", "root"]);
  assert.equal(store.observe("grandchild", { now: 1010 }), null);
  const item = store.request("root", request, 1020), readFamily = store.family;
  store.family = () => assert.fail("explicit null must not fall back to a family read");
  try { assert.equal(store.observe("root", { now: 1030 }, null), null); }
  finally { store.family = readFamily; }
  assert.equal(store.get(item.id, 1030).state, "cancelled");
  assert.equal(harness.getSession("root").lifecycle, "stopped", "null is authoritative even with an extant root");
  const deleted = store.request("root", { ...request, key: "deleted-root" }, 1040);
  harness.deleteSession("root");
  assert.equal(store.observe("root", { now: 1050 }), null); assert.equal(store.get(deleted.id, 1050).state, "cancelled");
  assert.equal(store.observe("missing", { now: 1060 }), null);
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

test("inbox and history partition canonical kinds before bounded pagination without changing unread", async t => {
  const { file, store } = await fixture(t), now = 5000;
  const old = store.request("root", { ...request, key: "old-read-action" }, 1000);
  store.read(old.id, 1001);
  for (let i = 0; i < 105; i++) {
    const item = store.create({ key: `history:${i}`, rootId: "root", sessionId: "root", kind: "idle", title: "Read information", body: "History", expiresAt: 100000, source: { type: "family_idle" } }, 1100 + i);
    store.read(item.id, 2000);
  }
  const expectedInbox = [old.id], expectedUnread = [];
  for (const kind of ["idle", "cron", "attention"]) for (const state of ["pending", "resolved", "cancelled", "superseded", "expired"]) for (const read of [false, true]) {
    const item = store.create({ key: `${kind}:${state}:${read}`, rootId: "root", sessionId: "root", kind,
      title: "Type, not prose", body: "This text does not classify the request", expiresAt: state === "expired" ? 4000 : 100000,
      source: { type: kind === "attention" ? "extension_ui" : kind === "idle" ? "family_idle" : "cron" } }, 3000);
    if (["resolved", "cancelled", "superseded"].includes(state)) store.transition(item.id, state, 3001);
    if (read) store.read(item.id, 3002);
    if (state === "pending" && (!read || kind === "attention")) expectedInbox.push(item.id);
    if (state === "pending" && !read) expectedUnread.push(item.id);
  }
  const page = store.list({ view: "inbox" }, now);
  assert.deepEqual(page.notifications.map(n => n.id).sort(), expectedInbox.sort(), "old read action must not be buried behind over 100 newer historical rows");
  assert.equal(page.unread, expectedUnread.length);
  assert.equal(page.notifications.find(n => n.id === old.id).readAt, 1001);
  const readAll = view => {
    const rows = []; let before;
    for (let pages = 0; pages < 30; pages++) {
      const value = store.list({ view, limit: 7, ...(before ? { before } : {}) }, now);
      assert.equal(value.unread, expectedUnread.length); assert.ok(value.notifications.length <= 7);
      rows.push(...value.notifications); before = value.nextBefore;
      if (before === null) return rows;
    }
    assert.fail("pagination did not terminate");
  };
  const all = readAll("all"), inbox = readAll("inbox"), history = readAll("history");
  assert.deepEqual(store.list({}, now), store.list({ view: "all" }, now), "omitted view retains the legacy all-record feed");
  assert.equal(all.length, 136);
  assert.deepEqual([...inbox, ...history].map(n => n.id).sort(), all.map(n => n.id).sort());
  assert.equal(new Set([...inbox, ...history].map(n => n.id)).size, all.length, "views are disjoint");
  for (const rows of [all, inbox, history]) assert.ok(rows.every((row, i) => i === 0 || row.seq < rows[i - 1].seq));
  const restarted = new NotificationStore(file); t.after(() => restarted.close());
  assert.deepEqual(restarted.list({ view: "inbox" }, now), page, "viewing preserves durable read and pending state across reopen");
  for (const view of [null, "", "active", "INBOX", 1, {}, []]) assert.throws(() => store.list({ view }, now), /view/);
});

