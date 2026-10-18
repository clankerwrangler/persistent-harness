import assert from "node:assert/strict";
import fs, { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { sessionSidecarPaths } from "../src/session-paths.mjs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { deletionFixture, until } from "./fixtures/recursive-delete-fixture.mjs";
import { fauxForkSessionSdk } from "./fixtures/faux-fork-session-sdk.mjs";

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


test("spawn preflight already in flight rechecks the parent before admitting a child", { timeout: 10_000 }, async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), actor = await f.actorClient(root);
  const sdk = await fauxForkSessionSdk(t, f.dir), removed = new Set(), cleanupDone = Promise.withResolvers(), remove = fs.rm;
  const sourceBefore = await readFile(root.sessionFile);
  t.after(() => { fs.rm = remove; syncBuiltinESMExports(); });
  fs.rm = async (file, ...args) => {
    const result = await remove(file, ...args), candidate = sdk.calls.openedFiles.at(-1);
    if (candidate) {
      const paths = sessionSidecarPaths(candidate);
      if ([candidate, paths.skillManifestPath, paths.capabilitiesPath, paths.skillGrantPath, paths.kernelStatePath].includes(file)) removed.add(file);
      if (removed.size === 5) cleanupDone.resolve();
    }
    return result;
  };
  syncBuiltinESMExports();
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
  await cleanupDone.promise;
  assert.equal(sdk.calls.contexts, 1); assert.equal(sdk.calls.creates, 1); assert.equal(sdk.calls.openedFiles.length, 2);
  assert.deepEqual(sdk.calls.names, ["too-late"]); assert.equal(sdk.calls.forks.length, 1);
  assert.equal(sdk.calls.forks[0].details.sourceSessionId, root.sessionId);
  assert.deepEqual(await readFile(root.sessionFile), sourceBefore);
  assert.deepEqual(await fs.readdir(sdk.sessionDirectory), []);
  assert.deepEqual(f.errors, []);
  t.diagnostic(JSON.stringify({ sdkContextCalls: sdk.calls.contexts, sdkCreates: sdk.calls.creates,
    sdkOpens: sdk.calls.openedFiles.length, admissionError: admissionError.message, removedCandidates: removed.size }));
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


for (const [operation, selected] of [["delete_session", "root"], ["delete_session", "child"], ["stop_session", "root"], ["stop_session", "child"], ["stop_session", "ancestor"]]) test(`${operation} drains an in-flight ${selected} readiness grant publication`, async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), rename = fs.rename, originalRead = fs.readFile;
  t.after(() => { gate.resolve(); fs.rename = rename; fs.readFile = originalRead; syncBuiltinESMExports(); });
  const f = await deletionFixture(t), root = await f.admit("Root"), child = await f.admit("Child", root);
  const session = selected === "child" ? child : root;
  const readTargets = selected === "ancestor" ? [child, await f.admit("Second child", root)] : [session];
  const grantPath = sessionSidecarPaths(root.sessionFile).skillGrantPath;
  const publications = []; let held = false, grantReads = 0;
  fs.readFile = async (file, ...args) => { if (file === grantPath) grantReads += 1; return originalRead(file, ...args); };
  fs.rename = async (source, target) => {
    if (target === grantPath && !held) {
      held = true; entered.resolve(); await gate.promise;
      publications.push(f.supervisor.store.getSession(session.sessionId).lifecycle);
    }
    return rename(source, target);
  };
  syncBuiltinESMExports(); await writeFile(grantPath, "{}\n");
  const ready = Promise.all(readTargets.map(target => f.client.request("get_actor_entries", { sessionId: target.sessionId }).catch(error => error.message)));
  await entered.promise; await f.client.request("heartbeat");
  let acknowledged = false;
  const deletion = f.client.request(operation, { sessionId: session.sessionId }).then(result => { acknowledged = true; return result; });
  await until(() => !f.actors.get(session.sessionId).isRunning);
  await f.client.request("heartbeat"); await f.client.request("list_sessions");
  const acknowledgedWhileHeld = acknowledged;
  gate.resolve(); await Promise.all([ready, deletion]);
  t.diagnostic(JSON.stringify({ selected, acknowledgedWhileHeld, publications }));
  assert.equal(acknowledgedWhileHeld, false);
  assert.equal(publications.length, 1); assert.notEqual(publications[0], "deleted");
  assert.equal(grantReads, 1, "a cancelled ancestor-grant waiter cannot acquire fresh authority");
  if (selected === "ancestor") {
    for (const outcome of await ready) assert.match(outcome, /stopped|retiring/);
    for (const target of readTargets) assert(f.actors.get(target.sessionId).isRunning, "parent Stop keeps its children running");
  }
  assert.equal(f.supervisor.store.getSession(session.sessionId).lifecycle, operation === "delete_session" ? "deleted" : "stopped");
  assert.equal(f.actors.get(session.sessionId).isRunning, false);
  assert.deepEqual(JSON.parse(await readFile(grantPath, "utf8")), { version: 1, skills: [], capabilities: [] });
  assert.equal(f.supervisor.store.isSessionDeleting(session.sessionId), false);
});


test("Stop joins an older launch held after startup validation", async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(); t.after(() => gate.resolve());
  const f = await deletionFixture(t), session = await f.admit("Starting root", null, { start: false });
  f.identityGate = async () => { entered.resolve(); await gate.promise; };
  await f.client.request("revive_session", { sessionId: session.sessionId }); await entered.promise;
  let acknowledged = false;
  const stop = f.client.request("stop_session", { sessionId: session.sessionId }).then(reply => { acknowledged = true; return reply; });
  await until(() => !f.actors.get(session.sessionId).isRunning);
  await f.client.request("heartbeat"); assert.equal(acknowledged, false);
  const generation = f.supervisor.store.getSession(session.sessionId).actorGeneration;
  gate.resolve(); await stop;
  await f.client.request("subscribe_session", { selector: session.sessionId, passive: true });
  assert.equal(f.supervisor.store.getSession(session.sessionId).lifecycle, "stopped");
  assert.equal(f.supervisor.store.getSession(session.sessionId).actorGeneration, generation);
  assert.deepEqual(f.actors.get(session.sessionId).submits, []); assert.deepEqual(f.errors, []);
  f.identityGate = null;
  await f.client.request("get_actor_state", { sessionId: session.sessionId });
  assert(f.supervisor.store.getSession(session.sessionId).actorGeneration > generation);
});

test("failed Stop retains its writer and releases retirement for retry and later activation", async t => {
  const f = await deletionFixture(t), session = await f.admit("Close failure"), worker = f.actors.get(session.sessionId);
  worker.failClose = true;
  await assert.rejects(f.client.request("stop_session", { sessionId: session.sessionId }), /synthetic close failure/);
  assert(worker.isRunning);
  await f.client.request("get_actor_state", { sessionId: session.sessionId });
  assert.equal(f.actors.get(session.sessionId), worker);
  worker.failClose = false; await f.client.request("stop_session", { sessionId: session.sessionId });
  assert.equal(worker.isRunning, false);
  await f.client.request("get_actor_entries", { sessionId: session.sessionId });
  assert.notEqual(f.actors.get(session.sessionId), worker); assert(f.actors.get(session.sessionId).isRunning);
});


test("stored changed grant finishes both sidecars when Stop cancels its held read", async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), originalRead = fs.readFile, originalRename = fs.rename;
  t.after(() => { gate.resolve(); fs.readFile = originalRead; fs.rename = originalRename; syncBuiltinESMExports(); });
  const f = await deletionFixture(t), session = await f.admit("Changed grant");
  const sidecars = sessionSidecarPaths(session.sessionFile), publications = []; let held = false;
  fs.readFile = async (file, ...args) => {
    const value = await originalRead(file, ...args);
    if (file === sidecars.skillGrantPath && !held) { held = true; entered.resolve(); await gate.promise; }
    return value;
  };
  fs.rename = async (source, target) => {
    if ([sidecars.skillGrantPath, sidecars.capabilitiesPath].includes(target)) publications.push(target);
    return originalRename(source, target);
  };
  syncBuiltinESMExports(); await fs.mkdir(`${f.dir}/skills/changed`);
  await writeFile(`${f.dir}/skills/changed/SKILL.md`, "---\nname: changed\ndescription: Private changed-grant fixture.\n---\nUse only in this fixture.\n");
  const ready = f.client.request("get_actor_state", { sessionId: session.sessionId }).catch(error => error.message);
  await entered.promise;
  assert.equal(f.supervisor.store.getSessionSkillGrant(session.sessionId).skills[0].id, "changed");
  let acknowledged = false;
  const stop = f.client.request("stop_session", { sessionId: session.sessionId }).then(reply => { acknowledged = true; return reply; });
  await until(() => !f.actors.get(session.sessionId).isRunning); await f.client.request("heartbeat");
  const acknowledgedWhileHeld = acknowledged;
  gate.resolve(); await Promise.all([ready, stop]);
  assert.equal(acknowledgedWhileHeld, false);
  assert.deepEqual(publications, [sidecars.skillGrantPath, sidecars.capabilitiesPath]);
  const grant = JSON.parse(await readFile(sidecars.skillGrantPath, "utf8"));
  assert.equal(grant.skills[0].id, "changed");
  assert.deepEqual(JSON.parse(await readFile(sidecars.capabilitiesPath, "utf8")), { version: 1, capabilities: grant.capabilities });
  await f.client.request("get_actor_state", { sessionId: session.sessionId });
  assert.deepEqual(publications, [sidecars.skillGrantPath, sidecars.capabilitiesPath], "unchanged grants do not republish sidecars");
});

test("ordinary capacity and inactivity passivation still allow fresh activation", async t => {
  const f = await deletionFixture(t), first = await f.admit("First"), firstWorker = f.actors.get(first.sessionId);
  f.supervisor.maxResidentActors = 1;
  const second = await f.admit("Second");
  assert.equal(firstWorker.isRunning, false); assert.equal(f.supervisor.store.getSession(first.sessionId).lifecycle, "passivated");
  const secondWorker = f.actors.get(second.sessionId);
  await f.client.request("get_actor_state", { sessionId: first.sessionId });
  assert.equal(secondWorker.isRunning, false);
  f.supervisor.actorInactivityMs = 20;
  await f.client.request("get_actor_state", { sessionId: first.sessionId });
  await until(() => f.supervisor.store.getSession(first.sessionId).lifecycle === "passivated");
  f.supervisor.actorInactivityMs = 0;
  await f.client.request("get_actor_state", { sessionId: first.sessionId });
  assert(f.actors.get(first.sessionId).isRunning); assert.deepEqual(f.errors, []);
});


test("cold reconciliation promotes a verified grant before capacity and retains it at launch", { timeout: 10_000 }, async t => {
  const slotEntered = Promise.withResolvers(), releaseSlot = Promise.withResolvers();
  t.after(() => releaseSlot.resolve());
  const f = await deletionFixture(t);
  await fs.mkdir(`${f.dir}/skills/alpha`);
  await writeFile(`${f.dir}/skills/alpha/SKILL.md`, "---\nname: alpha\ndescription: Valid retained guidance.\n---\nAlpha.\n");
  f.supervisor.maxConcurrentStarts = 1;
  const blocker = await f.admit("Slot owner", null, { start: false });
  f.startGate = async actor => { if (actor.session.sessionId === blocker.sessionId) { slotEntered.resolve(); await releaseSlot.promise; } };
  const occupying = f.client.request("get_actor_state", { sessionId: blocker.sessionId });
  await slotEntered.promise;
  const target = await f.admit("Early promotion", null, { start: false, seedGrant: false });
  assert.equal(f.supervisor.store.getSessionSkillGrant(target.sessionId), undefined);
  const sidecars = sessionSidecarPaths(target.sessionFile), promoted = Promise.withResolvers(), rename = fs.rename;
  t.after(() => { fs.rename = rename; syncBuiltinESMExports(); });
  fs.rename = async (from, to) => { const result = await rename(from, to); if (to === sidecars.capabilitiesPath) promoted.resolve(); return result; };
  syncBuiltinESMExports();
  const ready = f.client.request("get_actor_entries", { sessionId: target.sessionId });
  await promoted.promise; await f.client.request("heartbeat");
  const previous = f.supervisor.store.getSessionSkillGrant(target.sessionId);
  assert.deepEqual(previous.skills.map(skill => skill.id), ["alpha"]);
  assert.equal(f.actors.has(target.sessionId), false, "capacity still separates the two observations");
  await fs.mkdir(`${f.dir}/skills/invalid`); await writeFile(`${f.dir}/skills/invalid/SKILL.md`, "# malformed package\n");
  releaseSlot.resolve(); await Promise.all([occupying, ready]);
  assert(f.actors.get(target.sessionId).isRunning);
  assert.deepEqual(f.supervisor.store.getSessionSkillGrant(target.sessionId), previous);
  assert.deepEqual(JSON.parse(await readFile(sidecars.skillGrantPath, "utf8")).skills, previous.skills);
  assert.deepEqual(JSON.parse(await readFile(sidecars.capabilitiesPath, "utf8")), { version: 1, capabilities: [] });
  assert((await f.client.request("get_status")).diagnostics.some(item => item.code === "skill_catalog_not_ready"));
  assert.deepEqual(f.errors, []);
});

test("cold reconciliation fails before revival intent and a later repaired read remains available", { timeout: 10_000 }, async t => {
  const f = await deletionFixture(t), session = await f.admit("Pre-intent failure", null, { start: false, seedGrant: false });
  f.supervisor.store.markActorLifecycle(session.sessionId, session.actorGeneration, "stopped");
  await fs.mkdir(`${f.dir}/skills/invalid`); await writeFile(`${f.dir}/skills/invalid/SKILL.md`, "# malformed package\n");
  await assert.rejects(f.client.request("get_actor_state", { sessionId: session.sessionId }), /skill catalog reconciliation failed/);
  const failed = f.supervisor.store.getSession(session.sessionId);
  assert.equal(failed.lifecycle, "stopped"); assert.equal(failed.actorGeneration, session.actorGeneration);
  assert.equal(f.actors.has(session.sessionId), false);
  await fs.rm(`${f.dir}/skills/invalid`, { recursive: true });
  await f.client.request("get_actor_state", { sessionId: session.sessionId });
  assert.equal(f.supervisor.store.getSession(session.sessionId).actorGeneration, session.actorGeneration + 1);
  assert(f.actors.get(session.sessionId).isRunning); assert.deepEqual(f.errors, []);
});
