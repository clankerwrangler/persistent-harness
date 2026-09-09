import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assert.match(actor.submits[0].message, /not a new Commander submission/);
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
  assert.equal(JSON.parse(await readFile(path.join(jobDirectory, "exit.json"), "utf8")).exit_code, 0);
  assert.equal(await readFile(path.join(jobDirectory, "output.log"), "utf8"), "completion-proof");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(actor.submits.length, 1);
  assert.equal(supervisor.store.listPendingActorInputs("owner").length, 1);
});
