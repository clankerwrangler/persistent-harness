import assert from "node:assert/strict";
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
  assert.fail("expected actual idle entry-index dispatch did not complete");
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
    if (type === "get_state") return Promise.resolve(this.state());
    if (type === "get_commands") return Promise.resolve({ commands: [{ name: "persistent-harness-input", source: "extension", sourceInfo: { path: this.commandPath } }] });
    if (type === "prompt") {
      const inputId = decodeURIComponent(params.message.slice("/persistent-harness-input ".length));
      this.supervisor.store.markActorInputAccepted(inputId, this.session.sessionId, this.session.actorGeneration);
      return Promise.resolve({ accepted: true });
    }
    throw new Error(`unexpected fixture RPC ${type}`);
  }
  async submit() { return { outcome: "handled" }; }
  activity(type) { this.streaming = type === "agent_start"; this.emit("event", { type }); }
  async close() { if (!this.isRunning) return; this.isRunning = false; this.emit("exit", { code: 0, expected: true }); }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-entry-index-")), actors = [], errors = [];
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run/h.sock"), databasePath: path.join(root, "state/h.sqlite"),
    pidPath: path.join(root, "run/h.pid"), skillsPath, backgroundJobsDirectory: path.join(root, "jobs"), backgroundCompletionIntervalMs: 100,
    runtimeProvisioner: async () => ({}), titleGenerator: null, actorInactivityMs: 0,
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
  return { root, actors, supervisor, client, id, actor: actors[0], async connectActor() {
    const launch = supervisor.store.getActorLaunch(id), connection = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
    const events = []; connection.on("event", frame => events.push({ frame, cancellations: [...actors.at(-1).cancellations] }));
    connections.push(connection); const registered = await connection.start({ registrationType: "register_actor", sessionId: id,
      sessionFile: launch.sessionFile, cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration }); assert.equal(registered?.session?.sessionId, id); return { connection, events };
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
