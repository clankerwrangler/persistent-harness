import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";
import { JsonLineDecoder, encodeFrame } from "../src/framing.mjs";
import { PROTOCOL_VERSION, ProtocolError } from "../src/protocol.mjs";
import { CONTEXT_FORK_TYPE } from "../src/context-fork.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const models = ["parent", "pinned"].map((id) => ({ provider: "fake", id, reasoning: false, thinkingLevels: ["off"] }));
const params = (overrides = {}) => ({ prompt: "ONLY_NEW_TASK", name: "forked", parentModel: models[0], parentThinkingLevel: "off", availableModels: models, forkContext: true, forkLeafId: "pending", model: "fake/pinned", ...overrides });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(probe) { const end = Date.now() + 5000; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(10); } throw new Error("condition did not become true"); }
async function entries(file) { return (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse); }
async function append(file, row) { await appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`); }
class FakeActor extends EventEmitter {
  constructor(options, actors) { super(); this.session = options.session; this.args = options.args; this.pid = process.pid; this.isRunning = false; this.submits = []; actors.push(this); }
  async start() { this.isRunning = true; return this.state(); }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: this.session.launch.model.resolved, thinkingLevel: "off" }; }
  async request(type) { if (type === "get_state") return this.state(); if (type === "get_entries") return { entries: await entries(this.session.sessionFile) }; throw new Error(`unexpected request ${type}`); }
  async submit(message) {
    this.submits.push(message); this.emit("event", { type: "agent_start" });
    await append(this.session.sessionFile, { type: "message", id: crypto.randomUUID(), parentId: (await entries(this.session.sessionFile)).at(-1)?.id ?? null, message: { role: "user", content: message, timestamp: Date.now() } });
    const messageResult = { role: "assistant", content: [{ type: "text", text: "CHILD_DONE" }], stopReason: "stop", provider: "fake", model: "pinned", timestamp: Date.now() };
    await append(this.session.sessionFile, { type: "message", id: crypto.randomUUID(), parentId: (await entries(this.session.sessionFile)).at(-1)?.id ?? null, message: messageResult });
    this.emit("event", { type: "message_end", message: messageResult }); this.emit("event", { type: "agent_settled" }); return {};
  }
  send() {}
  async close() { if (!this.isRunning) return; this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM", expected: true }); }
}

test("fork admission freezes queued context, cleans failures, rejects replay, and resumes only the child's own task", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-fork-admission-")); const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const previousAgent = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const actors = []; const clients = []; let supervisor;
  const config = { socketPath: path.join(root, "run", "supervisor.sock"), databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    skillsPath, actorInactivityMs: 0, maxResidentActors: 1, maxDepth: 2, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => new FakeActor(options, actors),
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }) };
  t.after(async () => { await Promise.all(clients.map((client) => client.stop())); await supervisor?.stop(); if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent; await rm(root, { recursive: true, force: true }); });
  supervisor = new HarnessSupervisor(config); await supervisor.start();
  async function connect(registration) { const client = new HarnessClient({ socketPath: config.socketPath, heartbeatMs: 0 }); clients.push(client); await client.start(registration); return client; }
  const ui = await connect({ registrationType: "register_client", clientInstanceId: "fork-unit-ui" });
  const rootAdmission = (await ui.request("create_root", { cwd: root, name: "parent", repositoryRoot: root, provider: "fake", model: "parent", thinkingLevel: "off" })).admission;
  const parentActor = await eventually(() => actors.find((actor) => actor.session.sessionId === rootAdmission.sessionId && actor.isRunning));
  parentActor.emit("event", { type: "agent_start" });
  const launch = supervisor.store.getActorLaunch(rootAdmission.sessionId);
  const registration = { registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile, cwd: root, repositoryRoot: root, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration };
  let parent = await connect(registration); await parent.request("set_skill_manifest", { skills: [] });
  await append(launch.sessionFile, { type: "message", id: "source-user", parentId: (await entries(launch.sessionFile)).at(-1).id, message: { role: "user", content: "SOURCE_FACT\n\n<!-- persistent-harness-input:source-input -->", timestamp: 1 } });
  await append(launch.sessionFile, { type: "message", id: "pending", parentId: "source-user", message: { role: "assistant", provider: "fake", model: "parent", stopReason: "toolUse", content: [{ type: "toolCall", id: "source-call", name: "ipython", arguments: { code: "REPLAY_FORBIDDEN" } }], timestamp: 2 } });
  const sourceBefore = await readFile(launch.sessionFile); const filesBefore = await readdir(path.dirname(launch.sessionFile));
  for (const invalid of [null, "true", 1]) {
    const errors = []; parent.on("protocolError", (error) => errors.push(error));
    await assert.rejects(parent.request("spawn_child", params({ forkContext: invalid })), (error) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, "invalid_request");
      assert.equal(error.message, "params.forkContext must be boolean");
      return true;
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "invalid_request");
    assert.equal(errors[0].message, "params.forkContext must be boolean");
    assert.deepEqual(supervisor.store.listChildren(launch.sessionId), [], "malformed forkContext cannot admit a child");
    assert.deepEqual(await readFile(launch.sessionFile), sourceBefore);
    assert.deepEqual((await readdir(path.dirname(launch.sessionFile))).sort(), [...filesBefore].sort(), "malformed admission creates no transcript or sidecar");
    await parent.stop(); parent = await connect(registration);
  }
  await assert.rejects(parent.request("spawn_child", params({ forkLeafId: "absent" })), /missing parent/);
  await assert.rejects(parent.request("spawn_child", params({ model: "not-available" })), /resolve exactly/);
  const originalCreate = supervisor.store.createChild.bind(supervisor.store);
  supervisor.store.createChild = () => { throw new Error("injected transaction failure"); };
  await assert.rejects(parent.request("spawn_child", params()), /injected transaction failure/);
  supervisor.store.createChild = originalCreate;
  assert.deepEqual(supervisor.store.listChildren(launch.sessionId), []);
  assert.deepEqual(await readFile(launch.sessionFile), sourceBefore);
  assert.deepEqual((await readdir(path.dirname(launch.sessionFile))).sort(), filesBefore.sort(), "failed admission cleans the private child transcript and sidecars");
  const forked = (await parent.request("spawn_child", params())).admission;
  const child = supervisor.store.getSession(forked.sessionId);
  assert.equal(child.lifecycle, "starting"); assert.equal(actors.length, 1, "capacity holds the child after durable admission");
  assert.equal(supervisor.store.getChildTask(forked.initialTaskId).state, "queued");
  const seeded = await entries(child.sessionFile); const inherited = seeded.find((entry) => entry.customType === CONTEXT_FORK_TYPE);
  assert.equal(seeded.filter((entry) => entry.type === "message").length, 0);
  assert.equal(inherited.details.sourceSessionId, launch.sessionId); assert.equal(inherited.details.sourceLeafId, "pending");
  assert.deepEqual(child.launch.contextFork, inherited.details); assert.deepEqual(forked.contextFork, inherited.details);
  assert.match(JSON.stringify(inherited.content), /SOURCE_FACT/); assert.doesNotMatch(JSON.stringify(inherited), /source-input|source-call|REPLAY_FORBIDDEN/);
  assert.deepEqual(child.launch.model.resolved, { provider: "fake", id: "pinned" });
  assert.deepEqual(await readFile(launch.sessionFile), sourceBefore);
  await append(launch.sessionFile, { type: "message", id: "late", parentId: "pending", message: { role: "user", content: "LATE_PARENT_WRITE", timestamp: 3 } });

  // The existing per-connection replay guard protects a spawn just as it does
  // other mutations. It never retries a submission under a new request ID.
  await parent.stop();
  const raw = net.createConnection(config.socketPath); const decoded = []; const decoder = new JsonLineDecoder();
  raw.on("data", (chunk) => decoded.push(...decoder.push(chunk))); t.after(() => raw.destroy()); await once(raw, "connect");
  raw.write(encodeFrame({ version: PROTOCOL_VERSION, id: "register-raw", type: "register_actor", params: { ...registration, registrationType: undefined } }));
  await eventually(() => decoded.find((item) => item.id === "register-raw" && item.ok));
  const spawnFrame = { version: PROTOCOL_VERSION, id: "replay-spawn", type: "spawn_child", params: params({ name: "replay-check" }) };
  raw.write(encodeFrame(spawnFrame)); await eventually(() => decoded.find((item) => item.id === "replay-spawn" && item.ok));
  raw.write(encodeFrame(spawnFrame)); await eventually(() => decoded.some((item) => item.code === "duplicate_request_id"));
  assert.equal(supervisor.store.listChildren(launch.sessionId).length, 2);
  const replayChild = supervisor.store.listChildren(launch.sessionId).find((item) => item.name === "replay-check");
  await ui.request("delete_session", { sessionId: replayChild.sessionId });
  await Promise.all(clients.map((client) => client.stop()));
  await supervisor.stop();
  supervisor = new HarnessSupervisor(config); await supervisor.start();
  const startedChild = await eventually(() => actors.find((actor) => actor.session.sessionId === child.sessionId && actor.isRunning));
  await eventually(() => supervisor.store.getChildTask(forked.initialTaskId).state === "completed");
  assert.equal(startedChild.submits.length, 1); assert.match(startedChild.submits[0], /ONLY_NEW_TASK/); assert.doesNotMatch(startedChild.submits[0], /SOURCE_FACT|LATE_PARENT_WRITE/);
  assert.equal(startedChild.args[startedChild.args.indexOf("--model") + 1], "pinned");
  const finalEntries = await entries(child.sessionFile);
  assert.equal(finalEntries.filter((entry) => entry.customType === CONTEXT_FORK_TYPE).length, 1);
  assert.deepEqual(finalEntries.find((entry) => entry.customType === CONTEXT_FORK_TYPE), inherited);
  assert.doesNotMatch(JSON.stringify(finalEntries), /LATE_PARENT_WRITE/);
  const visible = await new VisibleTranscriptReader().read({ sessionFile: child.sessionFile, sessionId: child.sessionId });
  assert.deepEqual(visible.inputIds, []); assert.deepEqual(visible.inputEntries, {});
  assert.equal(visible.messages.filter((item) => item.role === "user").length, 1);
  await supervisor.stop(); supervisor = new HarnessSupervisor(config); await supervisor.start();
  const ui2 = await connect({ registrationType: "register_client", clientInstanceId: "fork-revival-ui" });
  await ui2.request("revive_session", { sessionId: child.sessionId });
  await eventually(() => actors.filter((actor) => actor.session.sessionId === child.sessionId && actor.isRunning).length === 1);
  assert.equal(actors.filter((actor) => actor.session.sessionId === child.sessionId).reduce((sum, actor) => sum + actor.submits.length, 0), 1, "completed initial task and inherited history are not resubmitted on revival");
});
