import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deletionFixture, until } from "./fixtures/recursive-delete-fixture.mjs";

const ids = rows => rows.map(row => row.sessionId).sort();
for (const selection of ["root", "child"]) test(`recursive ${selection} deletion stops exactly its subtree and retains canonical files`, async t => {
  const f = await deletionFixture(t), tree = await f.tree(), store = f.supervisor.store;
  const selected = tree[selection], subtree = store.getSessionSubtree(selected.sessionId), before = new Map();
  for (const row of subtree) {
    before.set(row.sessionId, await readFile(row.sessionFile));
    store.createActorInput(row.sessionId, { inputId: `input-${row.sessionId}`, message: "queued fixture" });
  }
  const message = store.createMessage(tree.root.sessionId, { target: tree.child.sessionId, body: "pending", deliveryMode: "auto" });
  const untouched = [tree.other, ...(selection === "child" ? [tree.root, tree.sibling] : [])];
  const snapshot = untouched.map(row => store.getActorLaunch(row.sessionId));
  const events = []; f.client.on("event", frame => events.push(frame));
  const result = await f.client.request("delete_session", { sessionId: selected.sessionId });
  assert.deepEqual(result.deletedSessionIds.sort(), ids(subtree));
  assert.equal(result.session.lifecycle, "deleted");
  assert(f.closeOrder.indexOf("Grandchild") < f.closeOrder.indexOf("Child"));
  for (const row of subtree) {
    const tombstone = store.getSession(row.sessionId);
    assert.equal(tombstone.lifecycle, "deleted"); assert.equal(store.getActorLaunch(row.sessionId), undefined); assert.equal(tombstone.actorPid, null); assert.equal(tombstone.actorIdentity, null);
    assert.equal(f.actors.get(row.sessionId).isRunning, false);
    assert.deepEqual(await readFile(row.sessionFile), before.get(row.sessionId));
    assert.deepEqual(store.listPendingActorInputs(row.sessionId), []);
    await assert.rejects(f.client.request("revive_session", { sessionId: row.sessionId }), /session does not exist/);
  }
  assert.equal(store.listMessages().find(row => row.messageId === message.messageId).state, "rejected");
  assert.deepEqual(store.diagnose(), []);
  for (let n = 0; n < untouched.length; n++) {
    const after = store.getActorLaunch(untouched[n].sessionId);
    assert.equal(after.actorToken, snapshot[n].actorToken); assert.equal(after.actorGeneration, snapshot[n].actorGeneration);
    assert(f.actors.get(untouched[n].sessionId).isRunning);
  }
  assert.deepEqual((await f.client.request("delete_session", { sessionId: selected.sessionId })).session, result.session, "idempotent tombstone");
  await until(() => events.find(frame => frame.event === "sessions_deleted"));
  assert.deepEqual(events.find(frame => frame.event === "sessions_deleted").data.sessionIds.sort(), ids(subtree));
});

test("direct-child delete keeps authorization while deleting grandchildren", async t => {
  const f = await deletionFixture(t), tree = await f.tree(), actor = await f.actorClient(tree.root);
  for (const selector of [tree.grandchild.sessionId, tree.other.sessionId, tree.root.sessionId]) {
    await assert.rejects(actor.request("delete_child", { selector }), /no direct child/);
  }
  const result = await actor.request("delete_child", { selector: tree.child.shortId });
  assert.deepEqual(result.deletedSessionIds.sort(), ids([tree.child, tree.grandchild]));
  assert.equal(result.child.lifecycle, "deleted"); assert(f.actors.get(tree.sibling.sessionId).isRunning);
});

test("legacy deleted intermediates do not hide live descendants and store rollback is atomic", async t => {
  const f = await deletionFixture(t), tree = await f.tree(), store = f.supervisor.store;
  await f.client.request("stop_session", { sessionId: tree.child.sessionId });
  const db = new DatabaseSync(f.supervisor.databasePath);
  t.after(() => db.close());
  db.prepare("UPDATE sessions SET lifecycle = 'deleted' WHERE id = ?").run(tree.child.sessionId);
  db.exec(`CREATE TRIGGER fail_tombstone BEFORE UPDATE OF lifecycle ON sessions WHEN NEW.id = '${tree.root.sessionId}' AND NEW.lifecycle = 'deleted' BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END`);
  assert.throws(() => store.deleteSession(tree.root.sessionId), /synthetic commit failure/);
  assert.notEqual(store.getSession(tree.grandchild.sessionId).lifecycle, "deleted");
  db.exec("DROP TRIGGER fail_tombstone");
  const result = await f.client.request("delete_session", { sessionId: tree.root.sessionId });
  assert(result.deletedSessionIds.includes(tree.grandchild.sessionId));
  assert.equal(store.getSession(tree.grandchild.sessionId).lifecycle, "deleted");
  assert.equal(f.actors.get(tree.grandchild.sessionId).isRunning, false);
});

test("fence rejects admission, routing, revival and overlapping deletes during shutdown", async t => {
  const f = await deletionFixture(t), tree = await f.tree(), store = f.supervisor.store, actor = await f.actorClient(tree.child);
  store.createActorInput(tree.child.sessionId, { inputId: "internal-race", message: "fixture internal input", source: "background", origin: { jobId: "fixture" } });
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  t.after(() => gate.resolve());
  f.closeGate = async worker => { if (worker.session.sessionId === tree.grandchild.sessionId) { entered.resolve(); await gate.promise; } };
  const deletion = f.client.request("delete_session", { sessionId: tree.child.sessionId }); await entered.promise;
  await assert.rejects(actor.request("spawn_child", { prompt: "must not admit", name: "Racing admission", parentModel: { provider: "fixture", id: "fixture", thinkingLevels: ["off"] }, parentThinkingLevel: "off", availableModels: [] }), /being deleted/);
  await assert.rejects(actor.request("get_actor_input", { inputId: "internal-race" }), /being deleted/);
  await assert.rejects(actor.request("accept_actor_input", { inputId: "internal-race" }), /being deleted/);
  assert.throws(() => store.createChild(tree.grandchild.sessionId, { sessionId: "new", actorToken: "fixture", policy: {} }), /being deleted/);
  assert.throws(() => store.createMessage(tree.root.sessionId, { target: tree.child.sessionId, body: "race", deliveryMode: "auto" }), /being deleted/);
  assert.throws(() => store.createActorInput(tree.grandchild.sessionId, { message: "race" }), /being deleted/);
  await assert.rejects(f.client.request("revive_session", { sessionId: tree.grandchild.sessionId }), /being deleted/);
  await assert.rejects(f.client.request("delete_session", { sessionId: tree.root.sessionId }), /being deleted/);
  assert.equal((await f.client.request("heartbeat")).alive, true);
  gate.resolve(); await deletion;
  assert.equal(store.getSession(tree.root.sessionId).lifecycle, "resident");
});

test("an already-admitted startup cannot publish resident state or a task across deletion", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), child = await f.admit("Starting child", root, { start: false });
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); t.after(() => gate.resolve());
  f.identityGate = async () => { entered.resolve(); await gate.promise; };
  await f.client.request("revive_session", { sessionId: child.sessionId }); await entered.promise;
  let finished = false;
  const deletion = f.client.request("delete_session", { sessionId: root.sessionId }).then(result => { finished = true; return result; });
  await until(() => f.supervisor.store.isSessionDeleting(child.sessionId));
  assert.equal(finished, false); gate.resolve(); await deletion;
  assert.equal(f.supervisor.store.getSession(child.sessionId).lifecycle, "deleted");
  assert.equal(f.actors.get(child.sessionId).isRunning, false); assert.deepEqual(f.actors.get(child.sessionId).submits, []);
});

test("close failure does not tombstone or lose ownership; a later retry succeeds", async t => {
  const f = await deletionFixture(t), tree = await f.tree(), worker = f.actors.get(tree.grandchild.sessionId);
  worker.failClose = true;
  await assert.rejects(f.client.request("delete_session", { sessionId: tree.child.sessionId }), /deletion was not committed/);
  assert(worker.isRunning); assert.notEqual(f.supervisor.store.getSession(tree.grandchild.sessionId).lifecycle, "deleted");
  assert.equal(f.supervisor.store.isSessionDeleting(tree.child.sessionId), false);
  worker.failClose = false;
  await f.client.request("delete_session", { sessionId: tree.child.sessionId }); assert.equal(worker.isRunning, false);
  assert.equal(f.supervisor.store.getSession(tree.child.sessionId).lifecycle, "deleted");
});


test("spawn preflight already in flight rechecks the parent before admitting a child", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), actor = await f.actorClient(root);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); t.after(() => gate.resolve());
  let admissionError;
  const store = f.supervisor.store, admit = store.createChild.bind(store);
  store.createChild = (...args) => { try { return admit(...args); } catch (error) { admissionError = error; throw error; } };
  const reader = f.supervisor.transcriptReader, read = reader.readBranch.bind(reader);
  reader.readBranch = async (...args) => { const value = await read(...args); entered.resolve(); await gate.promise; return value; };
  const model = { provider: "fixture", id: "fixture", reasoning: false, thinkingLevels: ["off"] };
  const spawn = actor.request("spawn_child", { prompt: "Disposable preflight", name: "too-late", parentModel: model,
    parentThinkingLevel: "off", availableModels: [model], forkContext: true, forkLeafId: null });
  // Closing the actor connection can reject the request before its host preflight resumes.
  const rejected = assert.rejects(spawn, /session does not exist|disconnected|connection|closed/);
  await entered.promise; await f.client.request("delete_session", { sessionId: root.sessionId }); gate.resolve();
  await rejected;
  await until(() => f.supervisor.store.listSessions().length === 0);
  await until(() => admissionError); assert.match(admissionError.message, /session does not exist/);
  assert.deepEqual(f.supervisor.store.listChildren(root.sessionId), []);
  assert.equal(f.actors.size, 1);
});


test("startup close failure keeps the live worker tracked until deletion can be retried", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), child = await f.admit("Late startup", root, { start: false });
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); t.after(() => gate.resolve());
  f.startGate = async worker => { if (worker.session.sessionId === child.sessionId) { worker.failClose = true; entered.resolve(); await gate.promise; } };
  await f.client.request("revive_session", { sessionId: child.sessionId }); await entered.promise;
  const failed = assert.rejects(f.client.request("delete_session", { sessionId: root.sessionId }), /deletion was not committed/);
  await until(() => f.closeOrder.includes("Late startup")); gate.resolve(); await failed;
  const worker = f.actors.get(child.sessionId); assert(worker.isRunning);
  assert.notEqual(f.supervisor.store.getSession(root.sessionId).lifecycle, "deleted");
  worker.failClose = false;
  await f.client.request("delete_session", { sessionId: root.sessionId });
  assert.equal(worker.isRunning, false, "retry must still own and close the original live worker");
  assert.equal(f.supervisor.store.getSession(child.sessionId).lifecycle, "deleted");
});
