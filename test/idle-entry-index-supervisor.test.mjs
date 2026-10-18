import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const end = Date.now() + 2500;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("expected supervisor lifecycle boundary did not complete");
}
class Actor extends EventEmitter {
  constructor(options, supervisor) { super(); this.session = options.session; this.supervisor = supervisor;
    this.pid = process.pid; this.isRunning = false; this.streaming = false; this.preparations = []; this.cancellations = [];
    this.commandPath = options.args[options.args.indexOf("--extension") + 1]; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
    isStreaming: this.streaming, model: null, thinkingLevel: "off" }; }
  async start() { this.isRunning = true; return this.state(); }
  request(type, params = {}) {
    if (type === "prepare_entry_index") { const gate = Promise.withResolvers(); this.preparations.push({ token: params.token, gate }); return gate.promise; }
    if (type === "cancel_entry_index") { this.cancellations.push(params.token); return Promise.resolve(true); }
    if (type === "compact") { this.compactEntered = true; return this.compactHold ?? Promise.resolve({}); }
    if (type === "get_state") return Promise.resolve(this.state());
    if (type === "get_commands") return Promise.resolve({ commands: [{ name: "persistent-harness-input", source: "extension", sourceInfo: { path: this.commandPath } }] });
    if (type === "prompt") {
      const inputId = decodeURIComponent(params.message.slice("/persistent-harness-input ".length));
      this.supervisor.store.markActorInputAccepted(inputId, this.session.sessionId, this.session.actorGeneration);
      return Promise.resolve({ accepted: true });
    }
    throw new Error(`unexpected fixture RPC ${type}`);
  }
  async submit() { this.submitEntered = true; await this.submitHold; return { outcome: "handled" }; }
  activity(type) { this.streaming = type === "agent_start"; this.emit("event", { type }); }
  async close() { if (!this.isRunning) return; this.isRunning = false; this.emit("exit", { code: 0, expected: true }); }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-entry-index-")), actors = [], errors = [];
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run/h.sock"), databasePath: path.join(root, "state/h.sqlite"),
    pidPath: path.join(root, "run/h.pid"), skillsPath, backgroundJobsDirectory: path.join(root, "jobs"), backgroundCompletionIntervalMs: 100,
    runtimeProvisioner: async () => ({}), titleGenerator: null, actorInactivityMs: 0, ...options,
    actorFactory: options => { const actor = new Actor(options, supervisor); actors.push(actor); return actor; },
    sessionHistoryIndex: { close() {} }, processIdentityFactory: async pid => ({ pid }), processTerminator: async () => ({}),
    logger: { error: value => errors.push(String(value)) } });
  await supervisor.start();
  const client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 }); const connections = [];
  t.after(async () => { for (const actor of actors) for (const prep of actor.preparations) prep.gate.resolve(true);
    for (const connection of connections) await connection.stop(); await client.stop(); await supervisor.stop();
    await rm(root, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  await client.start({ registrationType: "register_client", clientInstanceId: "entry-index-fixture" });
  const id = (await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Index fixture", provider: null, model: null, thinkingLevel: null })).admission.sessionId;
  await client.request("get_actor_state", { sessionId: id });
  return { root, actors, supervisor, client, id, actor: actors[0], async connectActor(sessionId = id) {
    const launch = supervisor.store.getActorLaunch(sessionId), connection = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
    const events = []; connection.on("event", frame => events.push({ frame, cancellations: [...actors.at(-1).cancellations] }));
    connections.push(connection); const registered = await connection.start({ registrationType: "register_actor", sessionId,
      sessionFile: launch.sessionFile, cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration }); assert.equal(registered?.session?.sessionId, sessionId); return { connection, events };
  } };
}

test("entry-index actual idle dispatch survives the automatic settled wake and occurs once per idle interval", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  f.actor.preparations[0].gate.resolve(true); await tick(); await tick();
  f.actor.activity("agent_settled"); await f.client.request("heartbeat"); await tick(); await tick();
  assert.equal(f.actor.preparations.length, 1, "repeated settled observation is not a new idle interval");
  f.actor.activity("agent_start"); f.actor.activity("agent_settled");
  await until(() => f.actor.preparations.length === 2);
  assert.notEqual(f.actor.preparations[0].token, f.actor.preparations[1].token);
});

test("entry-index own activity updates reset the attempt without relying on worker events", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  const { connection } = await f.connectActor();
  await connection.request("update_activity", { streaming: true });
  await connection.request("update_activity", { streaming: false });
  await until(() => f.actor.preparations.length === 2);
  assert.equal(f.supervisor.store.getSession(f.id).activity, "idle");
});

test("entry-index predecessor completion cannot clear successor cancellation or delay admission and stop", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  const old = f.actor.preparations[0];
  f.actor.activity("agent_start"); f.actor.activity("agent_settled");
  await until(() => f.actor.preparations.length === 2);
  const current = f.actor.preparations[1]; assert(f.actor.cancellations.includes(old.token));
  old.gate.resolve(true); await tick(); await tick();
  assert.equal((await f.client.request("submit_input", { sessionId: f.id, message: "human wake", behavior: "auto" })).accepted, true);
  assert(f.actor.cancellations.includes(current.token), "late old completion did not clear the current token");
  assert.equal((await f.client.request("stop_session", { sessionId: f.id })).session.lifecycle, "stopped");
  await f.client.request("revive_session", { sessionId: f.id }); await until(() => f.actors.length === 2 && f.actors[1].preparations.length === 1);
  const successor = f.actors[1].preparations[0]; current.gate.resolve(true); await tick(); await tick();
  await f.client.request("submit_input", { sessionId: f.id, message: "new generation wake", behavior: "auto" });
  assert(f.actors[1].cancellations.includes(successor.token), "retired generation completion did not clear its successor");
});

test("entry-index family delivery cancels before the existing actor message event", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  const token = f.actor.preparations[0].token;
  f.supervisor.store.createChild(f.id, { sessionId: "sender", sessionFile: path.join(f.root, "sender.jsonl"), actorToken: "sender",
    policy: { name: "sender", prompt: "fixture", depth: 1, cwd: f.root } });
  const message = f.supervisor.store.createMessage("sender", { target: f.id, body: "family wake" });
  f.supervisor.store.recordMessageSenderEntry("sender", { messageId: message.messageId, entryId: "sender-entry", peerId: f.id, relationship: "parent", body: message.body });
  const { events } = await f.connectActor();
  await until(() => events.some(({ frame }) => frame.event === "message_available"));
  const delivered = events.find(({ frame }) => frame.event === "message_available");
  assert(delivered.cancellations.includes(token)); assert.equal(delivered.frame.data.message.messageId, message.messageId);
});

test("entry-index background completion wake cancels without waiting for preparation", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  const token = f.actor.preparations[0].token, jobId = "bg-000000000001", directory = path.join(f.root, "jobs", jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "meta.json"), JSON.stringify({ schema: "background.job.v1", id: jobId, name: jobId, kind: "launched", session_id: f.id }));
  await writeFile(path.join(directory, "exit.json"), JSON.stringify({ exit_code: 0, signal: null, ended_at: new Date().toISOString() }));
  await until(() => f.supervisor.store.getActorInput(`background-completion-${jobId}`, f.id)?.state === "accepted");
  assert(f.actor.cancellations.includes(token)); assert.equal(f.actors.length, 1);
});


async function workingChild(f) {
  f.actor.activity("agent_start");
  const id = "working-child";
  f.supervisor.store.createChild(f.id, { sessionId: id, sessionFile: path.join(f.root, "child.jsonl"), actorToken: "child-token",
    policy: { name: id, prompt: "continue independently", depth: 1, cwd: f.root } });
  await f.client.request("revive_session", { sessionId: id });
  await until(() => f.actors.find(actor => actor.session.sessionId === id)?.isRunning);
  const actor = f.actors.find(actor => actor.session.sessionId === id);
  actor.activity("agent_start");
  f.actor.activity("agent_settled");
  assert.equal(f.supervisor.store.getSession(f.id).activity, "delegating");
  return { id, actor };
}

test("own-idle delegating parent prepares and expires without stopping its working child", async t => {
  const f = await fixture(t, { actorInactivityMs: 250 });
  const initialPreparations = f.actor.preparations.length;
  const child = await workingChild(f);
  const quiet = f.supervisor.store.getSession(f.id).quietSince;
  assert.equal(typeof quiet, "number", "family display must not erase own settled age");
  await until(() => f.actor.preparations.length > initialPreparations);
  const prep = f.actor.preparations.at(-1);
  child.actor.activity("agent_settled"); child.actor.activity("agent_start");
  assert.equal(f.supervisor.store.getSession(f.id).quietSince, quiet, "descendant transitions preserve own idle age");
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
  assert(f.actor.cancellations.includes(prep.token), "retirement cancels optional preparation without joining it");
  assert.equal(child.actor.isRunning, true);
  assert.equal(f.supervisor.store.getSession(child.id).activity, "working");
});

test("own-idle capacity retires delegating parent while child continues and input revives it", async t => {
  const f = await fixture(t, { maxResidentActors: 2 }); const child = await workingChild(f);
  const other = (await f.client.request("create_root", { cwd: f.root, repositoryRoot: null, name: "Capacity entrant",
    provider: null, model: null, thinkingLevel: null })).admission.sessionId;
  await until(() => f.supervisor.store.getSession(other).lifecycle === "resident");
  assert.equal(f.supervisor.store.getSession(f.id).lifecycle, "passivated");
  assert.equal(child.actor.isRunning, true);
  await f.client.request("submit_input", { sessionId: f.id, message: "wake after capacity retirement", behavior: "auto" });
  await until(() => f.supervisor.store.getSession(f.id).actorGeneration === 2 && f.supervisor.store.getSession(f.id).lifecycle === "resident");
  assert.equal(child.actor.isRunning, true);
});


for (const mode of ["expiry", "capacity"]) for (const wakeOnly of [false, true]) {
  test(`own-idle ${mode} excludes ${wakeOnly ? "wake owner after durable handling" : "pending own input"}`, async t => {
    const f = await fixture(t, { actorInactivityMs: mode === "expiry" ? 250 : 0, maxResidentActors: 2 });
    const child = await workingChild(f); const gate = Promise.withResolvers(); f.actor.submitHold = gate.promise;
    t.after(() => gate.resolve());
    const receipt = await f.client.request("submit_input", { sessionId: f.id, message: "held own command", behavior: "auto" });
    await until(() => f.actor.submitEntered);
    if (wakeOnly) f.supervisor.store.markActorInputHandled(receipt.inputId, f.id);
    let entrant;
    if (mode === "capacity") entrant = (await f.client.request("create_root", { cwd: f.root, repositoryRoot: null, name: "Waiting entrant",
      provider: null, model: null, thinkingLevel: null })).admission.sessionId;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(f.supervisor.store.getSession(f.id).lifecycle, "resident");
    if (entrant) assert.equal(f.supervisor.store.getSession(entrant).lifecycle, "starting");
    assert.equal(child.actor.isRunning, true);
    gate.resolve();
    await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
    if (entrant) await until(() => f.supervisor.store.getSession(entrant).lifecycle === "resident");
    assert.equal(f.supervisor.store.getActorInput(receipt.inputId, f.id).outcome, "handled");
    assert.equal(child.actor.isRunning, true);
  });
}

for (const kind of ["tool", "compaction"]) test(`own-idle expiry excludes unsettled ${kind} work and reconsiders on completion`, async t => {
  const f = await fixture(t, { actorInactivityMs: 250 }); const child = await workingChild(f);
  const frame = kind === "tool" ? { type: "tool_execution_start", toolCallId: "held-tool" } : { type: "compaction_start" };
  f.actor.emit("event", frame);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(f.supervisor.store.getSession(f.id).lifecycle, "resident");
  assert.equal(f.supervisor.store.getSession(f.id).activity, "delegating");
  f.actor.emit("event", { ...frame, type: kind === "tool" ? "tool_execution_end" : "compaction_end" });
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
  assert.equal(child.actor.isRunning, true);
});

test("own-idle capacity waits for held control and already queued admission before retiring", async t => {
  const f = await fixture(t, { maxResidentActors: 2 }); const child = await workingChild(f);
  const control = Promise.withResolvers(), input = Promise.withResolvers();
  f.actor.compactHold = control.promise; f.actor.submitHold = input.promise;
  t.after(() => { control.resolve({}); input.resolve(); });
  const compact = f.client.request("compact_session", { sessionId: f.id });
  await until(() => f.actor.compactEntered);
  const admission = f.client.request("submit_input", { sessionId: f.id, message: "queued behind own control", behavior: "auto" });
  const entrant = (await f.client.request("create_root", { cwd: f.root, repositoryRoot: null, name: "Control entrant",
    provider: null, model: null, thinkingLevel: null })).admission.sessionId;
  await tick(); await tick();
  assert.equal(f.supervisor.store.getSession(entrant).lifecycle, "starting");
  assert.equal(f.actor.isRunning, true);
  control.resolve({}); await compact; await admission;
  await until(() => f.actor.submitEntered);
  assert.equal(f.actor.isRunning, true, "queued admission owns its input wake before capacity can retire");
  input.resolve();
  await until(() => f.supervisor.store.getSession(entrant).lifecycle === "resident");
  assert.equal(f.actor.isRunning, false); assert.equal(child.actor.isRunning, true);
});

test("own-idle expiry honors a fresh own interval after held control and input revives the retired parent", async t => {
  const f = await fixture(t, { actorInactivityMs: 180 }); const child = await workingChild(f);
  const gate = Promise.withResolvers(); f.actor.compactHold = gate.promise; t.after(() => gate.resolve({}));
  const compact = f.client.request("compact_session", { sessionId: f.id }); await until(() => f.actor.compactEntered);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(f.actor.isRunning, true);
  f.actor.activity("agent_start"); f.actor.activity("agent_settled");
  gate.resolve({}); await compact; await tick();
  assert.equal(f.actor.isRunning, true, "expiry must use the fresh interval, not an old queued deadline");
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
  await f.client.request("submit_input", { sessionId: f.id, message: "input after expiry", behavior: "auto" });
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "resident" && f.supervisor.status().capacity.starting === 0
    && f.actors.some(actor => actor.session.sessionId === f.id && actor.session.actorGeneration === 2 && actor.submitEntered));
  assert.equal(child.actor.isRunning, true);
});

test("own-idle family wake protects a delegating parent before expiry and revives it after retirement", async t => {
  const f = await fixture(t, { actorInactivityMs: 250 }); const child = await workingChild(f);
  const sender = await f.connectActor(child.id); let receiver = await f.connectActor();
  const send = async body => {
    const { message } = await sender.connection.request("send_message", { target: f.id, body, deliveryMode: "auto" });
    await sender.connection.request("record_agent_message_entry", { entryId: `entry-${message.messageId}`, messageId: message.messageId,
      direction: "to", peerId: f.id, peerName: "parent", relationship: "parent", body, createdAt: new Date().toISOString() });
    return message;
  };
  const before = await send("family wake before expiry");
  await until(() => receiver.events.some(({ frame }) => frame.event === "message_available" && frame.data.message.messageId === before.messageId));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.actor.isRunning, true, "unacknowledged family work prevents retirement");
  await receiver.connection.request("ack_message", { messageId: before.messageId });
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
  const after = await send("family wake after retirement");
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "resident"
    && f.actors.some(actor => actor.session.sessionId === f.id && actor.session.actorGeneration === 2 && actor.isRunning));
  receiver = await f.connectActor();
  await until(() => receiver.events.some(({ frame }) => frame.event === "message_available" && frame.data.message.messageId === after.messageId));
  assert.equal(f.supervisor.store.getSession(f.id).activity, "delegating");
  assert.equal(child.actor.isRunning, true);
  await receiver.connection.request("ack_message", { messageId: after.messageId });
  assert.equal(f.supervisor.store.getMessage(after.messageId).state, "acknowledged");
});


test("entry-index deferred admission samples fresh local generation, quiet, deletion and absence", async t => {
  const f = await fixture(t); await until(() => f.actor.preparations.length === 1);
  const db = new DatabaseSync(f.supervisor.databasePath);
  t.after(() => db.close());
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(f.id);
  const columns = Object.keys(row);
  const restore = () => {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(f.id);
    db.prepare(`INSERT INTO sessions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(key => row[key]));
  };
  for (const change of [
    () => db.prepare("UPDATE sessions SET actor_generation = actor_generation + 1 WHERE id = ?").run(f.id),
    () => db.prepare("UPDATE sessions SET activity = 'working', quiet_since = NULL WHERE id = ?").run(f.id),
    () => db.prepare("UPDATE sessions SET lifecycle = 'deleted' WHERE id = ?").run(f.id),
    () => db.prepare("DELETE FROM sessions WHERE id = ?").run(f.id),
  ]) {
    f.actor.activity("agent_start");
    f.supervisor.store.setActorActivity(f.id, 1, false);
    const count = f.actor.preparations.length;
    f.actor.emit("event", { type: "compaction_end" });
    change();
    await tick(); await tick();
    assert.equal(f.actor.preparations.length, count, "the deferred callback must reject changed local eligibility");
    restore();
    f.actor.emit("event", { type: "compaction_end" });
    await until(() => f.actor.preparations.length === count + 1);
  }
});

test("own-idle expiry callback rereads quiet time even without a rescheduling event", async t => {
  const f = await fixture(t, { actorInactivityMs: 180 });
  f.actor.emit("event", { type: "compaction_start" });
  const db = new DatabaseSync(f.supervisor.databasePath); t.after(() => db.close());
  db.prepare("UPDATE sessions SET quiet_since = ? WHERE id = ?").run(Date.now() - 165, f.id);
  f.actor.emit("event", { type: "compaction_end" });
  const fresh = Date.now();
  db.prepare("UPDATE sessions SET quiet_since = ? WHERE id = ?").run(fresh, f.id);
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(f.actor.isRunning, true, "an old callback cannot retire a newer quiet interval");
  assert.equal(f.supervisor.store.getSession(f.id).quietSince, fresh);
  f.actor.emit("event", { type: "compaction_end" });
  await until(() => f.supervisor.store.getSession(f.id).lifecycle === "passivated");
});
