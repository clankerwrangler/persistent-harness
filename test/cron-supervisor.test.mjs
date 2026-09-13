import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { ACTOR_INPUT_COMMAND, actorInputCustomPayload } from "../src/protocol.mjs";

async function eventually(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("condition not reached");
}

class CronFakeActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.streaming = false; this.submits = []; this.args = options.args; this.env = options.env; this.connection = null; }
  #state() {
    return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming,
      model: this.session.launch?.model?.resolved ?? null, thinkingLevel: this.session.launch?.thinking?.resolved ?? "off" };
  }
  async start() {
    this.connection = new HarnessClient({ socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.connection.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    this.isRunning = true; return this.#state();
  }
  emit(name, value) { if (name === "event" && value?.type === "agent_start") this.streaming = true;
    if (name === "event" && value?.type === "agent_settled") this.streaming = false; return super.emit(name, value); }
  async request(type, params = {}) {
    if (type === "get_commands") return { commands: [{ name: ACTOR_INPUT_COMMAND, source: "extension", sourceInfo: { path: this.args[this.args.indexOf("--extension") + 1] } }] };
    if (type === "prompt") {
      assert(params.message.startsWith(`/${ACTOR_INPUT_COMMAND} `));
      const inputId = decodeURIComponent(params.message.slice(ACTOR_INPUT_COMMAND.length + 2));
      const { input } = await this.connection.request("get_actor_input", { inputId });
      const payload = actorInputCustomPayload(input);
      this.submits.push({ message: payload.content, behavior: input.behavior, images: input.images, payload });
      await this.connection.request("accept_actor_input", { inputId }); return {};
    }
    if (type === "get_state") return this.#state(); if (type === "get_entries") return { entries: [] };
    throw new Error(`unexpected fake request ${type}`); }
  async submit(message, behavior, images = []) { this.submits.push({ message, behavior, images }); return {}; }
  send() {}
  async close() { if (!this.isRunning) return; this.isRunning = false; await this.connection?.stop();
    this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}

function entry(id, parentId, role, text) {
  return { type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }] } };
}

test("supervisor cron steers an origin, completes durable history, isolates fresh runs, and falls back after origin deletion", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cron-supervisor-")); const skillsPath = path.join(root, "skills");
  await mkdir(skillsPath); const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0, cronTickIntervalMs: 100,
    runtimeProvisioner: async () => ({}), actorFactory: (options) => { const actor = new CronFakeActor(options);
      actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }), logger: { error() {}, log() {} } });
  let browser; let origin; let fresh;
  await supervisor.start();
  t.after(async () => {
    await Promise.allSettled([origin?.stop(), fresh?.stop(), browser?.stop()]);
    await supervisor.stop();
    await rm(root, { recursive: true, force: true });
  });

  browser = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await browser.start({ registrationType: "register_client", clientInstanceId: "cron-browser" });
  const admission = (await browser.request("create_root", { cwd: root, repositoryRoot: root, name: "Cron origin",
    provider: null, model: null, thinkingLevel: null })).admission;
  const originActor = await eventually(() => actors.get(admission.sessionId)); await eventually(() => originActor.isRunning);
  const launch = supervisor.store.getActorLaunch(admission.sessionId);
  origin = originActor.connection;
  const originJob = (await origin.request("cron_job", { action: "create", name: "Origin check", prompt: "Return the check result.",
    schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, executionMode: "origin", repeat: 1 })).job;
  const manual = (await origin.request("cron_job", { action: "run", selector: originJob.jobId })).run;
  await eventually(() => originActor.submits.length === 1);
  assert.equal(originActor.submits[0].behavior, "auto", "origin execution must permit steering active work");
  assert.doesNotMatch(originActor.submits[0].message, /Scheduled job/);
  assert.doesNotMatch(originActor.submits[0].message, /Do not create, update, or remove scheduled jobs/);
  const listed = await origin.request("cron_job", { action: "list", includeRemoved: false });
  assert.equal(listed.jobs.some((job) => job.jobId === originJob.jobId), true);
  const spawned = await origin.request("spawn_child", {
    prompt: "Watch the install.", name: "watcher", model: null, thinkingLevel: null,
    parentModel: { provider: "test", id: "model", reasoning: false, thinkingLevels: ["off"] },
    parentThinkingLevel: "off",
    availableModels: [{ provider: "test", id: "model", reasoning: false, thinkingLevels: ["off"] }],
  });
  assert.ok(spawned.admission.sessionId, "origin delivery must still admit children");
  await origin.request("delete_child", { selector: spawned.admission.sessionId });
  const removed = (await origin.request("cron_job", { action: "remove", selector: originJob.jobId })).job;
  assert.equal(removed.state, "removed");

  await appendFile(launch.sessionFile, `${JSON.stringify({ type: "custom_message", id: "cron-user", parentId: null, timestamp: new Date().toISOString(), ...originActor.submits[0].payload })}
`);
  await appendFile(launch.sessionFile, `${JSON.stringify(entry("cron-answer", "cron-user", "assistant", "Scheduled result."))}
`);
  const visible = await browser.request("get_visible_messages", { sessionId: admission.sessionId });
  assert.deepEqual(visible.messages.map(({ role, text }) => ({ role, text })), [
    { role: "scheduled_job", text: originActor.submits[0].message },
    { role: "assistant", text: "Scheduled result." },
  ]);
  assert.equal("inputIds" in visible, false); assert.doesNotMatch(JSON.stringify(visible), /persistent-harness-input/);
  originActor.emit("event", { type: "agent_start" }); originActor.emit("event", { type: "agent_settled" });
  const completed = await eventually(() => supervisor.cronStore.getRun(manual.runId)?.status === "completed"
    ? supervisor.cronStore.getRun(manual.runId) : null);
  assert.equal(completed.output, "Scheduled result."); assert.equal(completed.executionModeUsed, "origin");
  const freshJob = (await origin.request("cron_job", { action: "create", name: "Fresh check", prompt: "Return fresh result.",
    schedule: { kind: "at", at: "2030-01-02T00:00:00Z" }, executionMode: "fresh", repeat: 1 })).job;
  assert.equal(freshJob.launch.model.source, "settings");
  assert.equal(freshJob.launch.model.resolved, null);
  const freshManual = (await origin.request("cron_job", { action: "run", selector: freshJob.jobId })).run;
  const freshRun = await eventually(() => { const value = supervisor.cronStore.getRun(freshManual.runId);
    return value?.status === "running" ? value : null; });
  assert.notEqual(freshRun.sessionId, admission.sessionId); assert.equal(freshRun.executionModeUsed, "fresh");
  await eventually(() => actors.get(freshRun.sessionId)?.submits.length === 1);
  assert.match(actors.get(freshRun.sessionId).submits[0].message, /Do not create, update, or remove scheduled jobs/);
  const freshLaunch = supervisor.store.getActorLaunch(freshRun.sessionId);
  assert.equal(freshLaunch.launch.model?.resolved ?? null, null);
  assert.equal(actors.get(freshRun.sessionId).args.includes("--model"), false);
  fresh = actors.get(freshRun.sessionId).connection;
  await assert.rejects(fresh.request("cron_job", { action: "list", includeRemoved: false }), /scheduled runs cannot manage/);
  const fallbackAt = new Date(Date.now() + 700).toISOString();
  const fallbackJob = (await origin.request("cron_job", { action: "create", name: "Fallback check", prompt: "Run after deletion.",
    schedule: { kind: "at", at: fallbackAt }, executionMode: "origin", repeat: 1 })).job;
  await browser.request("delete_session", { sessionId: admission.sessionId });
  const fallback = await eventually(() => supervisor.cronStore.listRuns(fallbackJob.jobId, 1)[0]?.status === "running"
    ? supervisor.cronStore.listRuns(fallbackJob.jobId, 1)[0] : null, 5000);
  assert.equal(fallback.executionModeUsed, "fresh"); assert.equal(fallback.fallbackReason, "origin session no longer exists");
  assert.notEqual(fallback.sessionId, admission.sessionId);
  await eventually(() => actors.get(fallback.sessionId)?.submits.length === 1, 5000);
});
