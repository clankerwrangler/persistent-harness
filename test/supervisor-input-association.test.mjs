import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await tick(); }
  assert.fail("bounded fixture condition did not complete");
}
class InputActor extends EventEmitter {
  constructor(options, ready) { super(); this.session = options.session; this.ready = ready;
    this.pid = process.pid; this.isRunning = false; this.submits = []; this.closes = 0; }
  async start() { await this.ready; this.isRunning = true; return this.state(); }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
    isStreaming: false, model: null, thinkingLevel: "off" }; }
  async request(type) { assert.equal(type, "get_state"); return this.state(); }
  async submit(message, behavior, images, inputId) { this.submits.push({ message, behavior, images, inputId }); return {}; }
  send() {}
  async close() { if (!this.isRunning) return; this.closes += 1; this.isRunning = false;
    this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}

test("unresolved input remains pending without stopping startup or unrelated admission, then rechecks evidence", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "input-gate-"));
  const skillsPath = path.join(directory, "skills"); await mkdir(skillsPath);
  const start = Promise.withResolvers(); const actors = [];
  const view = { messages: [], history: [], leafId: null, inputIds: [], inputEntries: {}, inputDeliveries: {},
    inputAssociationStates: { "ambiguous-input": "unresolved" }, truncated: false, historyPage: { hasMore: false, nextCursor: null, branchId: "fixture" } };
  const diagnostics = [];
  const logPath = path.join(directory, "supervisor.jsonl");
  const socketPath = path.join(directory, "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "harness.sqlite"),
    pidPath: path.join(directory, "supervisor.pid"), logPath, skillsPath, actorInactivityMs: 0,
    backgroundJobsDirectory: path.join(directory, "background"), runtimeProvisioner: async () => ({}),
    transcriptReader: { read: async () => structuredClone(view) }, sessionHistoryIndex: { close() {} },
    logger: { error: (value) => diagnostics.push(String(value)) },
    actorFactory: (options) => { const actor = new InputActor(options, start.promise); actors.push(actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fixture", ownerToken: "fixture" }),
    processTerminator: async () => ({ terminated: true }) });
  let client;
  t.after(async () => { start.resolve(); await client?.stop(); await supervisor.stop(); await rm(directory, { recursive: true, force: true }); });
  await supervisor.start();
  client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "input-association-gate" });
  const { admission } = await client.request("create_root", { cwd: directory, repositoryRoot: null, name: "Input proof gate",
    provider: null, model: null, thinkingLevel: null });
  const sessionId = admission.sessionId;
  const pending = supervisor.store.createActorInput(sessionId, { inputId: "ambiguous-input", message: "Unknown original body",
    behavior: "auto", source: "user", origin: null });
  supervisor.store.createActorInput(sessionId, { inputId: "absent-input", message: "A truly absent input", behavior: "auto" });
  const incorporated = supervisor.store.createActorInput(sessionId, { inputId: "incorporated-input", message: "Already canonical", behavior: "auto" });
  view.inputIds = [incorporated.inputId];
  view.inputAssociationStates[incorporated.inputId] = "proven";
  view.inputEntries[incorporated.inputId] = "inactive-original";
  view.inputDeliveries[incorporated.inputId] = { entryId: "inactive-original", deliveredAt: new Date(incorporated.acceptedAt + 1).toISOString() };
  start.resolve();
  await client.request("get_actor_state", { sessionId });
  const actor = actors[0];
  assert.deepEqual(actor.submits.map((input) => input.inputId), ["absent-input"],
    "An unresolved canonical input is not absence; positive historical incorporation is not replayed either");
  assert.equal(actor.isRunning, true); assert.equal(actor.closes, 0);
  assert.equal(supervisor.store.getSession(sessionId).lifecycle, "resident");
  const retained = supervisor.store.getActorInput(pending.inputId, sessionId);
  assert.equal(retained.state, "queued"); assert.equal(retained.message, pending.message);
  assert.deepEqual(retained.images, pending.images); assert.equal(retained.delivery.deliveredAt, null);
  assert.equal(supervisor.store.getActorInput(incorporated.inputId, sessionId).entryId, "inactive-original");
  assert.equal(supervisor.store.getActorInput("absent-input", sessionId).state, "accepted");
  const publicView = await client.request("get_visible_messages", { sessionId });
  assert.equal(Object.hasOwn(publicView, "inputAssociationStates"), false, "Private association status must not enter the public DTO");
  assert.equal(Object.hasOwn(publicView, "inputDeliveries"), false);
  assert.equal(publicView.messages.find((message) => message.id === pending.inputId).delivery.deliveredAt, null);
  const log = await readFile(logPath, "utf8");
  assert.match(log, /actor_input_unresolved/); assert.match(log, /ambiguous-input/);
  assert.doesNotMatch(log, /Unknown original body/, "Diagnostics contain IDs, not the pending body or digest");
  assert.deepEqual(diagnostics, [], "Unresolved input is not a failed actor startup");

  // The verdict is derived on each existing reconciliation, never persisted.
  view.inputAssociationStates = { ...view.inputAssociationStates, "ambiguous-input": "proven" };
  view.inputIds.push(pending.inputId);
  view.inputEntries[pending.inputId] = "authoritative-original";
  view.inputDeliveries[pending.inputId] = { entryId: "authoritative-original", deliveredAt: new Date(pending.acceptedAt + 2).toISOString() };
  await client.request("submit_input", { sessionId, message: "Continue with valid input", behavior: "auto", clientRequestId: "valid-after-resolution" });
  await eventually(() => supervisor.store.getActorInput(pending.inputId, sessionId).state === "completed" && actor.submits.length === 2);
  assert.equal(supervisor.store.getActorInput(pending.inputId, sessionId).entryId, "authoritative-original");
  assert.equal(actor.submits.some((input) => input.inputId === pending.inputId), false);
  assert.equal(actor.submits[1].message, "Continue with valid input");
  assert.equal(actor.closes, 0); assert.equal(actors.length, 1);
});


for (const observed of ["unresolved", "proven", "absent"]) {
  test(`late internal command ${observed} evidence does not confuse handled preflight with acceptance`, { timeout: 20_000 }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "late-input-gate-"));
    const skillsPath = path.join(directory, "skills"); await mkdir(skillsPath);
    const ready = Promise.withResolvers(); const actors = [];
    const view = { messages: [], history: [], leafId: null, inputIds: [], inputEntries: {}, inputDeliveries: {},
      inputAssociationStates: {}, truncated: false, historyPage: { hasMore: false, nextCursor: null, branchId: "fixture" } };
    let reserved;
    class LateInputActor extends InputActor {
      constructor(options) { super(options, ready.promise); this.commandPath = options.args[options.args.indexOf("--extension") + 1]; this.prompts = 0; }
      async request(type, fields) {
        if (type === "get_commands") return { commands: [{ name: "persistent-harness-input", source: "extension", sourceInfo: { path: this.commandPath } }] };
        if (type === "prompt") {
          assert.equal(fields.message, "/persistent-harness-input late-internal");
          this.prompts += 1;
          // The command sees evidence added after the supervisor's earlier read.
          view.inputAssociationStates[reserved.inputId] = observed;
          if (observed === "proven") {
            view.inputIds.push(reserved.inputId);
            view.inputEntries[reserved.inputId] = "late-canonical-original";
            view.inputDeliveries[reserved.inputId] = { entryId: "late-canonical-original", deliveredAt: new Date(reserved.acceptedAt + 1).toISOString() };
          }
          return { outcome: "handled" }; // This is deliberately not accept_actor_input.
        }
        return super.request(type, fields);
      }
    }
    const socketPath = path.join(directory, "supervisor.sock");
    const logPath = path.join(directory, "supervisor.jsonl");
    const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "harness.sqlite"),
      pidPath: path.join(directory, "supervisor.pid"), logPath, skillsPath, actorInactivityMs: 0,
      backgroundJobsDirectory: path.join(directory, "background"), runtimeProvisioner: async () => ({}),
      transcriptReader: { read: async () => structuredClone(view) }, sessionHistoryIndex: { close() {} }, logger: { error() {} },
      actorFactory: (options) => { const actor = new LateInputActor(options); actors.push(actor); return actor; },
      processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fixture", ownerToken: "fixture" }),
      processTerminator: async () => ({ terminated: true }) });
    let client;
    t.after(async () => { ready.resolve(); await client?.stop(); await supervisor.stop(); await rm(directory, { recursive: true, force: true }); });
    await supervisor.start(); client = new HarnessClient({ socketPath, heartbeatMs: 0 });
    await client.start({ registrationType: "register_client", clientInstanceId: `late-association-${observed}` });
    const { admission } = await client.request("create_root", { cwd: directory, repositoryRoot: null, name: "Late input proof",
      provider: null, model: null, thinkingLevel: null });
    const sessionId = admission.sessionId;
    reserved = supervisor.store.createActorInput(sessionId, { inputId: "late-internal", message: "Retain this internal payload",
      behavior: "auto", source: "background", origin: { jobId: "late-job" } });
    supervisor.store.createActorInput(sessionId, { inputId: "late-valid-user", message: "A separate valid input", behavior: "auto" });
    ready.resolve();
    if (observed === "absent") {
      await assert.rejects(client.request("get_actor_state", { sessionId }), /internal input was not accepted/);
      assert.equal(supervisor.store.getActorInput(reserved.inputId, sessionId).state, "queued");
      assert.equal((await client.request("get_status")).running, true);
      return;
    }
    await client.request("get_actor_state", { sessionId });
    const actor = actors[0];
    assert.equal(actor.prompts, 1); assert.equal(actor.closes, 0); assert.equal(actor.isRunning, true);
    assert.deepEqual(actor.submits.map((input) => input.inputId), ["late-valid-user"]);
    const input = supervisor.store.getActorInput(reserved.inputId, sessionId);
    if (observed === "unresolved") {
      assert.equal(input.state, "queued"); assert.equal(input.message, reserved.message);
      assert.deepEqual(input.origin, reserved.origin); assert.equal(input.delivery.deliveredAt, null);
      assert.match(await readFile(logPath, "utf8"), /actor_input_unresolved/);
    } else {
      assert.equal(input.state, "completed"); assert.equal(input.entryId, "late-canonical-original");
      assert.equal(input.message, undefined);
    }
  });
}
