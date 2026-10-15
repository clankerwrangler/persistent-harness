import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { ACTOR_INPUT_COMMAND } from "../src/protocol.mjs";
import { actorInputCustomPayload } from "../src/extension.mjs";

class FakeActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.env = options.env; this.pid = process.pid; this.isRunning = false; this.submits = []; this.connection = null; }
  async start() {
    this.connection = new HarnessClient({ socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.connection.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    this.isRunning = true;
    return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null, thinkingLevel: "off" };
  }
  async request(type, params = {}) {
    if (type === "prompt") {
      assert(params.message.startsWith(`/${ACTOR_INPUT_COMMAND} `));
      const inputId = decodeURIComponent(params.message.slice(ACTOR_INPUT_COMMAND.length + 2));
      const { input } = await this.connection.request("get_actor_input", { inputId });
      const payload = actorInputCustomPayload(input);
      this.submits.push({ ...payload, message: payload.content, behavior: input.behavior });
      await this.connection.request("accept_actor_input", { inputId });
      return {};
    }
    if (type === "get_commands") return { commands: [{ name: "persistent-harness-input", source: "extension",
      sourceInfo: { path: path.resolve(import.meta.dirname, "../index.ts") } }] };
    if (type === "get_state") return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null, thinkingLevel: "off" };
    if (type === "get_entries") return { entries: [], leafId: null };
    throw new Error(`unexpected fake actor request ${type}`);
  }
  async submit(message, behavior, images = []) { this.submits.push({ message, behavior, images }); }
  async close() { this.isRunning = false; await this.connection?.stop(); }
}

async function eventually(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition did not become true");
}

test("Python background launch reaches the owning actor as one durable follow-up", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-background-completion-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const agentDirectory = path.join(root, "agent");
  const jobsDirectory = path.join(agentDirectory, "state", "background-jobs");
  await mkdir(path.join(root, "skills"), { recursive: true });
  const actors = new Map();
  const supervisor = new HarnessSupervisor({
    socketPath,
    databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"),
    backgroundJobsDirectory: jobsDirectory,
    backgroundCompletionIntervalMs: 100,
    skillsPath: path.join(root, "skills"),
    runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new FakeActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
    logger: { error() {}, log() {} },
  });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const sessionFile = path.join(root, "owner.jsonl");
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "owner", timestamp: new Date().toISOString(), cwd: root })}\n`);
  supervisor.store.createRoot({ sessionId: "owner", sessionFile, cwd: root, repositoryRoot: null,
    name: "Owner", actorToken: "owner-token", launch: {} }, 1);
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "background-presentation" });
  t.after(() => client.stop());
  const waiting = [];
  client.on("event", frame => {
    const message = frame.event === "input_state" ? frame.data.message : frame.data?.event?.type === "input_state" ? frame.data.event.message : null;
    if (message) waiting.push(message);
  });
  await client.request("subscribe_session", { selector: "owner", passive: true });
  const { stdout } = await promisify(execFile)(process.env.PI_HARNESS_PYTHON || "python3", ["-c", `
import asyncio, json
import harness_background
print(json.dumps(asyncio.run(harness_background.run(
    operation="launch", name="completion-integration", command="sleep 0.2; printf completion-proof"))))
`], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_HARNESS_ACTOR_ID: "owner",
      PYTHONPATH: path.join(process.env.PI_HARNESS_SKILLS_PATH || path.resolve(import.meta.dirname, "../skills"), "background", "src"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  const launched = JSON.parse(stdout);
  assert.equal(launched.ok, true);
  const jobId = launched.id;
  const jobDirectory = path.join(jobsDirectory, jobId);
  const meta = JSON.parse(await readFile(path.join(jobDirectory, "meta.json"), "utf8"));
  assert.equal(meta.session_id, "owner");

  await eventually(() => actors.has("owner"));
  const actor = actors.get("owner");
  await eventually(() => actor.submits.length === 1);
  assert.equal(actor.submits[0].behavior, "follow_up");
  assert.equal(actor.submits[0].customType, "persistent-harness-input");
  assert.equal(actor.submits[0].details.source, "background");
  assert.match(actor.submits[0].message, /not a new user submission/);
  assert.match(actor.submits[0].message, /completion-integration.*completed successfully/);
  assert.match(actor.submits[0].message, new RegExp(jobId));
  let marker;
  await eventually(async () => {
    try { marker = JSON.parse(await readFile(path.join(jobDirectory, "notification.json"), "utf8")); return marker.state === "sent"; }
    catch { return false; }
  });
  assert.equal(marker.state, "sent");
  const inputs = supervisor.store.listPendingActorInputs("owner");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].inputId, `background-completion-${jobId}`);
  assert.equal(inputs[0].state, "accepted");
  assert.equal(waiting.length, 1, "completion acceptance publishes to the already-subscribed owner");
  assert.equal(waiting[0].id, inputs[0].inputId);
  assert.equal(waiting[0].role, "background_notification");
  assert.equal(waiting[0].delivery.state, "accepted");
  assert.equal(waiting[0].delivery.deliveredAt, null, "publication is not canonical admission");
  assert.equal(JSON.parse(await readFile(path.join(jobDirectory, "exit.json"), "utf8")).exit_code, 0);
  assert.equal(await readFile(path.join(jobDirectory, "output.log"), "utf8"), "completion-proof");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(actor.submits.length, 1);
  assert.equal(supervisor.store.listPendingActorInputs("owner").length, 1);
});

test("cold background owners do not block completion enqueue, publication, or startup retries", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "background-cold-owners-")), jobsDirectory = path.join(root, "jobs");
  const gate = Promise.withResolvers(), actors = [], errors = [], published = new Set(), tails = new Map();
  let failStartup = true, held = false;
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run/h.sock"), databasePath: path.join(root, "state/h.sqlite"), pidPath: path.join(root, "run/h.pid"),
    skillsPath: path.join(root, "skills"), backgroundJobsDirectory: jobsDirectory, backgroundCompletionIntervalMs: 100,
    runtimeProvisioner: async () => ({}), titleGenerator: null,
    actorFactory: options => {
      const actor = new FakeActor(options), start = actor.start.bind(actor), request = actor.request.bind(actor);
      actors.push(actor);
      actor.start = async () => {
        if (options.session.sessionId === "owner-a") { held = true; await gate.promise; if (failStartup) throw new Error("synthetic startup failure"); }
        return start();
      };
      actor.request = async (type, params = {}) => {
        const result = await request(type, params);
        if (type === "prompt") {
          const inputId = decodeURIComponent(params.message.slice(ACTOR_INPUT_COMMAND.length + 2));
          const { input } = await actor.connection.request("get_actor_input", { inputId });
          const id = `canonical-${input.origin.jobId}`, timestamp = new Date().toISOString(), sessionId = input.sessionId;
          await appendFile(actor.session.sessionFile, JSON.stringify({ type: "custom_message", id, parentId: tails.get(sessionId) ?? null, timestamp, ...actorInputCustomPayload(input) }) + "\n");
          tails.set(sessionId, id);
          await actor.connection.request("record_input_delivery", { inputId, entryId: id, deliveredAt: timestamp });
        }
        return result;
      };
      return actor;
    },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }), logger: { error: error => errors.push(String(error)), log() {} },
  });
  await mkdir(path.join(root, "skills")); await supervisor.start();
  t.after(async () => { gate.resolve(); await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "background-cold-owners" }); t.after(() => client.stop());
  client.on("event", frame => {
    const message = frame.event === "input_state" ? frame.data.message : frame.data?.event?.type === "input_state" ? frame.data.event.message : null;
    if (message?.delivery?.state === "accepted") published.add(message.id);
  });
  for (const owner of ["owner-a", "owner-b"]) {
    const sessionFile = path.join(root, `${owner}.jsonl`);
    await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: owner, timestamp: new Date().toISOString(), cwd: root }) + "\n");
    supervisor.store.createRoot({ sessionId: owner, sessionFile, cwd: root, repositoryRoot: null, name: owner, actorToken: `${owner}-token`, launch: {} }, 1);
    await client.request("subscribe_session", { selector: owner, passive: true });
  }
  const jobs = ["bg-000000000001", "bg-000000000002", "bg-000000000003"], inputId = id => `background-completion-${id}`;
  const complete = async (id, owner) => {
    const directory = path.join(jobsDirectory, id); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "meta.json"), JSON.stringify({ schema: "background.job.v1", id, name: id, kind: "launched", session_id: owner }));
    await writeFile(path.join(directory, "exit.json"), JSON.stringify({ exit_code: 0, signal: null, ended_at: new Date().toISOString() }));
  };
  await complete(jobs[0], "owner-a"); await eventually(() => held);
  // These arrive on later scans while the first owner's startup remains held.
  await complete(jobs[1], "owner-a"); await complete(jobs[2], "owner-b");
  await eventually(() => published.size === 3);
  assert.deepEqual(supervisor.store.listPendingActorInputs("owner-a").map(input => input.inputId), jobs.slice(0, 2).map(inputId));
  await eventually(() => supervisor.store.getActorInput(inputId(jobs[2]), "owner-b")?.state === "completed");
  for (const id of jobs.slice(0, 2)) await assert.rejects(readFile(path.join(jobsDirectory, id, "notification.json")), { code: "ENOENT" });
  gate.resolve(); await eventually(() => errors.some(error => error.includes("synthetic startup failure")));
  for (const id of jobs.slice(0, 2)) await assert.rejects(readFile(path.join(jobsDirectory, id, "notification.json")), { code: "ENOENT" });
  failStartup = false;
  await eventually(async () => {
    try { return (await Promise.all(jobs.map(id => readFile(path.join(jobsDirectory, id, "notification.json"), "utf8")))).every(text => JSON.parse(text).state === "sent"); } catch { return false; }
  }, 5000);
  await eventually(() => supervisor.store.listPendingActorInputs("owner-a").length === 0);
  const submitted = actors.flatMap(actor => actor.submits);
  for (const id of jobs) assert.equal(submitted.filter(input => input.details.inputId === inputId(id)).length, 1);
  assert(submitted.every(input => input.behavior === "follow_up"));
  const canonical = (await readFile(path.join(root, "owner-a.jsonl"), "utf8")).trim().split("\n").map(JSON.parse).filter(entry => entry.type === "custom_message");
  assert.deepEqual(canonical.map(entry => entry.details.inputId), jobs.slice(0, 2).map(inputId));
  for (let i = 0; i < jobs.length; i++) assert.equal(supervisor.store.getActorInput(inputId(jobs[i]), i === 2 ? "owner-b" : "owner-a").state, "completed");
});
