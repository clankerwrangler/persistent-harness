import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { PiSessionActor } from "../src/session-actor.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { acceptedNativeRuntime } from "./fixtures/accepted-native-runtime.mjs";

async function until(probe, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${description}`);
}
class Actor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.streaming = false;
    this.compactEntered = Promise.withResolvers(); this.compactGate = Promise.withResolvers(); this.closeSettled = 0; this.inputs = []; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming, model: null, thinkingLevel: "off" }; }
  async start() { this.isRunning = true; return this.state(); }
  emit(name, event) {
    if (name === "event" && event.type === "agent_start") this.streaming = true;
    if (name === "event" && event.type === "agent_settled") this.streaming = false;
    return super.emit(name, event);
  }
  async request(type) {
    if (type === "get_state") return this.state();
    if (type === "get_entries") return { entries: [], leafId: null };
    if (type === "compact") { this.compactEntered.resolve(); await this.compactGate.promise; return { summary: "Synthetic compaction" }; }
    throw new Error(`Unexpected fixture actor request: ${type}`);
  }
  async submit(message) { this.inputs.push(message); return { outcome: "handled" }; }
  crash() { this.isRunning = false; this.emit("exit", { code: 1, signal: null, expected: false }); }
  async close() {
    if (!this.isRunning) return;
    this.closeSettled += 1; this.emit("event", { type: "agent_settled" });
    this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM", expected: true });
  }
}
async function fixture(t, { real = false } = {}) {
  const native = real ? await acceptedNativeRuntime() : null;
  const directory = await mkdtemp(path.join(os.tmpdir(), "settled-stop-"));
  const skillDir = path.join(directory, "skills"); const cwd = path.join(directory, "project");
  const agentDir = path.join(directory, "agent"); const home = path.join(directory, "home");
  await Promise.all([mkdir(skillDir), mkdir(cwd), mkdir(agentDir), mkdir(home)]);
  const saved = { ...process.env }; const workers = []; const rawEvents = []; const errors = [];
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const readinessReturned = Promise.withResolvers();
  const providerEntered = Promise.withResolvers(); const providerRelease = Promise.withResolvers();
  let hold = false; let gatedCalls = 0; let server; let supervisor; let client;
  t.after(async () => {
    hold = false; release.resolve(); providerRelease.resolve();
    for (const worker of workers) worker.compactGate?.resolve();
    await client?.stop(); await supervisor?.stop();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(errors, []);
  });
  const runtime = real ? await new PythonRuntimeManager({ runtimeDir: path.join(directory, "runtime") }).ensure({
    skills: [], consent: async () => true,
  }) : null;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir,
    PI_HARNESS_AUTO_INSTALL: "0", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", UV_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1",
    ...Object.fromEntries(["PI_HARNESS_PI_COMMAND", "PI_HARNESS_PI_MODULE", "PI_HARNESS_PYTHON"].filter((key) => saved[key]).map((key) => [key, saved[key]])),
    ...(real ? { PI_HARNESS_PI_COMMAND: native.cli, PI_HARNESS_PI_MODULE: native.sdk, PI_HARNESS_PYTHON: runtime.pythonPath } : {}) });
  if (real) {
    server = http.createServer(async (request, response) => {
      try {
        for await (const _chunk of request) { /* Consume the synthetic request. */ }
        providerEntered.resolve(); await providerRelease.promise;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "stop-proof", object: "chat.completion.chunk", model: "fake-model",
          choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.end(chunk({ role: "assistant", content: "REAL_WRITER_COMPLETE" }) + chunk({}, "stop") + "data: [DONE]\n\n");
      } catch (error) { errors.push(error); response.destroy(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.HARNESS_FAKE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  }
  const socketPath = path.join(directory, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "state", "harness.sqlite"),
    pidPath: path.join(directory, "run", "supervisor.pid"), backgroundJobsDirectory: path.join(directory, "jobs"),
    skillsPath: skillDir, actorInactivityMs: 0, titleGenerator: async () => null,
    actorExtensionPaths: real ? [path.join(import.meta.dirname, "fixtures", "fake-provider.ts")] : [],
    actorFactory(options) { const worker = real ? new PiSessionActor(options) : new Actor(options); workers.push(worker);
      worker.on("event", (event) => rawEvents.push(event)); return worker; },
    runtimeProvisioner: async () => { if (hold) { gatedCalls += 1; entered.resolve(); await release.promise; readinessReturned.resolve(); } return {}; },
    ...(real ? {} : { processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "synthetic", ownerToken: "synthetic" }),
      processTerminator: async () => ({ terminated: true }) }), logger: { error: (error) => errors.push(String(error)) } });
  await supervisor.start(); client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 30_000 });
  await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  let sessionId;
  if (real) sessionId = (await client.request("create_root", { cwd, repositoryRoot: null, name: "Stop ordering proof",
    provider: "harness-fake", model: "fake-model", thinkingLevel: "off" })).admission.sessionId;
  else {
    sessionId = crypto.randomUUID(); const sessionFile = path.join(directory, `${sessionId}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
    supervisor.store.createRoot({ sessionId, sessionFile, cwd, repositoryRoot: null, name: "Stop ordering proof", actorToken: crypto.randomUUID() });
  }
  await client.request("subscribe_session", { selector: sessionId });
  return { directory, sessionId, client, supervisor, workers, rawEvents, entered, release, readinessReturned, providerEntered, providerRelease,
    gatedCalls: () => gatedCalls,
    async connectActor(id = sessionId) {
      const launch = supervisor.store.getActorLaunch(id); const connection = new HarnessClient({ socketPath, heartbeatMs: 0 });
      await connection.start({ registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile,
        cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
      t.after(() => connection.stop()); return connection;
    },
    async changeSkills() {
      const directory = path.join(skillDir, "changed"); await mkdir(directory);
      await writeFile(path.join(directory, "SKILL.md"), "---\nname: changed\ndescription: Synthetic settled-readiness fixture.\n---\nUse only for this isolated regression.\n"); hold = true;
    },
    releaseReadiness() { hold = false; release.resolve(); },
  };
}
async function assertStopped(f) {
  const stopped = f.supervisor.store.getSession(f.sessionId); assert.equal(stopped.lifecycle, "stopped");
  const count = f.workers.length;
  assert(f.workers.every((worker) => !worker.isRunning));
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await f.client.request("subscribe_session", { selector: f.sessionId, passive: true })).passive, true);
    await f.client.request("get_visible_messages", { sessionId: f.sessionId });
    assert.equal((await f.client.request("heartbeat")).alive, true);
  }
  assert.equal(f.supervisor.store.getSession(f.sessionId).lifecycle, "stopped");
  assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, stopped.actorGeneration);
  assert.equal(f.workers.length, count);
  return stopped;
}

test("settled readiness owns its await before a later stop, without blocking connection reads or shutdown callbacks", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); await f.changeSkills();
  f.workers[0].emit("event", { type: "agent_start" }); f.workers[0].emit("event", { type: "agent_settled" });
  await f.entered.promise;
  let acknowledged = false; const stop = f.client.request("stop_session", { sessionId: f.sessionId }).then((reply) => { acknowledged = true; return reply; });
  assert.equal((await f.client.request("heartbeat")).alive, true);
  await f.client.request("list_sessions"); assert.equal(acknowledged, false, "The stop cannot acknowledge ahead of the earlier owned readiness await");
  f.releaseReadiness(); assert.equal((await stop).session.lifecycle, "stopped");
  const stopped = await assertStopped(f); assert(f.workers.every((worker) => worker.closeSettled === 1));
  await f.client.request("revive_session", { sessionId: f.sessionId });
  await until(() => f.supervisor.store.getSession(f.sessionId).lifecycle === "resident", "explicit later revival");
  assert(f.supervisor.store.getSession(f.sessionId).actorGeneration > stopped.actorGeneration);
});

test("a settled callback queued behind stop cannot reenter readiness with a stale actor", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); const actor = f.workers[0];
  const compact = f.client.request("compact_session", { sessionId: f.sessionId }); await actor.compactEntered.promise;
  const stop = f.client.request("stop_session", { sessionId: f.sessionId });
  await f.client.request("heartbeat"); await f.changeSkills();
  actor.emit("event", { type: "agent_settled" });
  await f.client.request("heartbeat"); assert.equal(f.gatedCalls(), 0, "The later settled callback must wait behind the admitted stop");
  actor.compactGate.resolve(); await compact; assert.equal((await stop).session.lifecycle, "stopped");
  f.releaseReadiness(); await assertStopped(f); assert.equal(f.gatedCalls(), 0);
});

test("real Pi writer stays stopped after held settled readiness and resumes only on explicit activation", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { real: true });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "Complete the private stop proof.", behavior: "auto" });
  await f.providerEntered.promise; await f.changeSkills(); f.providerRelease.resolve(); await f.entered.promise;
  assert(f.rawEvents.some((event) => event.type === "agent_settled"));
  let acknowledged = false; const stop = f.client.request("stop_session", { sessionId: f.sessionId }).then((reply) => { acknowledged = true; return reply; });
  await f.client.request("heartbeat"); assert.equal(acknowledged, false);
  f.releaseReadiness(); assert.equal((await stop).session.lifecycle, "stopped");
  const session = f.supervisor.store.getSession(f.sessionId); const bytes = await readFile(session.sessionFile);
  assert.match(bytes.toString("utf8"), /REAL_WRITER_COMPLETE/);
  await assertStopped(f); assert.deepEqual(await readFile(session.sessionFile), bytes, "No retired writer appends after stop acknowledgement");
  const generation = session.actorGeneration;
  await f.client.request("revive_session", { sessionId: f.sessionId });
  await until(() => f.supervisor.store.getSession(f.sessionId).lifecycle === "resident", "real explicit activation");
  assert(f.supervisor.store.getSession(f.sessionId).actorGeneration > generation);
  assert.equal(f.rawEvents.filter((event) => event.type === "agent_start").length, 1, "Revival does not fabricate another prompt");
});

for (const freshInput of [false, true]) test(`settled readiness fences an exited empty actor${freshInput ? " but preserves fresh arrival" : " without revival"}`, { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); const actor = f.workers[0];
  const generation = f.supervisor.store.getSession(f.sessionId).actorGeneration;
  assert.deepEqual(f.supervisor.store.listPendingActorInputs(f.sessionId), []);
  assert.equal(f.supervisor.store.nextQueuedChildTask(f.sessionId), undefined);
  assert.equal(f.supervisor.store.submittedChildTask(f.sessionId), undefined);
  await f.changeSkills(); actor.emit("event", { type: "agent_settled" }); await f.entered.promise;
  actor.crash(); assert.equal(f.supervisor.store.getSession(f.sessionId).lifecycle, "error");
  if (freshInput) await f.client.request("submit_input", { sessionId: f.sessionId, message: "FRESH_AFTER_EXIT", behavior: "auto" });
  f.releaseReadiness(); await f.readinessReturned.promise;
  if (freshInput) {
    await until(() => f.workers.some((worker) => worker.inputs.includes("FRESH_AFTER_EXIT")), "fresh input delivered after exited readiness");
    assert.equal(f.workers.flatMap((worker) => worker.inputs).filter((message) => message === "FRESH_AFTER_EXIT").length, 1);
    assert.deepEqual(f.supervisor.store.listPendingActorInputs(f.sessionId), []);
    assert(f.supervisor.store.getSession(f.sessionId).actorGeneration > generation);
  } else {
    // Passive RPC cuts observe the completed readiness continuation without granting revival.
    for (let i = 0; i < 3; i += 1) {
      await f.client.request("heartbeat"); await f.client.request("list_sessions");
      await f.client.request("subscribe_session", { selector: f.sessionId, passive: true });
    }
    assert.equal(f.supervisor.store.getSession(f.sessionId).lifecycle, "error");
    assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, generation);
    assert.equal(f.workers.length, 1);
    assert.deepEqual(f.supervisor.store.listPendingActorInputs(f.sessionId), []);
  }
});

test("family stop_child drains earlier settled readiness without reviving its stopped child", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); const parent = await f.connectActor();
  const childId = crypto.randomUUID(), childFile = path.join(f.directory, "child.jsonl");
  await writeFile(childFile, `${JSON.stringify({ type: "session", version: 3, id: childId, timestamp: new Date().toISOString(), cwd: f.directory })}\n`);
  f.supervisor.store.createChild(f.sessionId, { sessionId: childId, sessionFile: childFile, actorToken: crypto.randomUUID(),
    policy: { name: "stop-proof-child", prompt: "Complete once", cwd: f.directory, repositoryRoot: null } });
  await f.client.request("subscribe_session", { selector: childId });
  const child = f.workers.find((worker) => worker.session.sessionId === childId);
  await until(() => f.supervisor.store.submittedChildTask(childId), "child initial task submission");
  child.emit("event", { type: "agent_settled" });
  await f.client.request("get_actor_state", { sessionId: childId });
  assert.equal(f.supervisor.store.nextQueuedChildTask(childId), undefined);
  assert.equal(f.supervisor.store.submittedChildTask(childId), undefined);
  await f.changeSkills(); child.emit("event", { type: "agent_settled" }); await f.entered.promise;
  const generation = f.supervisor.store.getSession(childId).actorGeneration;
  let acknowledged = false;
  const stop = parent.request("stop_child", { selector: childId }).then((reply) => { acknowledged = true; return reply; });
  await until(() => f.supervisor.store.getSession(childId).lifecycle === "stopped", "family stop reaches child shutdown before readiness release");
  await f.client.request("heartbeat");
  assert.equal(acknowledged, false, "Family stop joins its earlier readiness owner before acknowledging");
  f.releaseReadiness();
  assert.equal((await stop).child.lifecycle, "stopped"); await f.readinessReturned.promise;
  for (let i = 0; i < 3; i += 1) {
    await f.client.request("heartbeat"); await f.client.request("list_sessions");
    await f.client.request("subscribe_session", { selector: childId, passive: true });
  }
  assert.equal(f.supervisor.store.getSession(childId).lifecycle, "stopped");
  assert.equal(f.supervisor.store.getSession(childId).actorGeneration, generation);
  assert.equal(f.workers.filter((worker) => worker.session.sessionId === childId).length, 1);
});


test("standalone readiness and every queued read retire before Stop acknowledges", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t); await f.changeSkills();
  const outcomes = [];
  const read = (type, params) => f.client.request(type, params).then(
    () => outcomes.push("ready"), error => { outcomes.push(error.message); });
  const first = read("get_actor_state", { sessionId: f.sessionId }); await f.entered.promise;
  const queued = [read("get_actor_entries", { sessionId: f.sessionId }), read("subscribe_session", { selector: f.sessionId })];
  await f.client.request("heartbeat");
  let acknowledged = false;
  const stop = f.client.request("stop_session", { sessionId: f.sessionId }).then(reply => { acknowledged = true; return reply; });
  await until(() => f.supervisor.store.getSession(f.sessionId).lifecycle === "stopped", "explicit stop reaches shutdown");
  // Same-connection reads remain available while the older skill owner is held.
  await f.client.request("heartbeat"); await f.client.request("list_sessions");
  const acknowledgedWhileHeld = acknowledged;
  const generation = f.supervisor.store.getSession(f.sessionId).actorGeneration;
  const duringRead = f.client.request("get_actor_state", { sessionId: f.sessionId }).then(() => "ready", error => error.message);
  await f.client.request("heartbeat");
  f.releaseReadiness(); const during = await duringRead; await Promise.all([first, ...queued, stop]);
  t.diagnostic(JSON.stringify({ acknowledgedWhileHeld, outcomes, during, generations: [generation, f.supervisor.store.getSession(f.sessionId).actorGeneration], workers: f.workers.length }));
  assert.equal(acknowledgedWhileHeld, false);
  assert.match(during, /stopped|retiring/);
  assert.equal(outcomes.length, 3); for (const outcome of outcomes) assert.match(outcome, /stopped|retiring/);
  await assertStopped(f); assert.equal(f.workers.length, 1);
  assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, generation);
  // A later explicit read supplies fresh authority and does not replay an input.
  await f.client.request("get_actor_entries", { sessionId: f.sessionId });
  assert.equal(f.workers.length, 2); assert.deepEqual(f.workers.flatMap(worker => worker.inputs), []);
});


test("resident skill refresh completes without self-join and leaves durable admission independent", { timeout: 30_000 }, async t => {
  const f = await fixture(t); await f.changeSkills();
  const ready = f.client.request("get_actor_state", { sessionId: f.sessionId }); await f.entered.promise;
  const receipt = await f.client.request("submit_input", { sessionId: f.sessionId, message: "FRESH_DURING_REFRESH", behavior: "auto" });
  assert.equal(receipt.accepted, true); assert.equal(f.gatedCalls(), 1);
  assert.equal(f.supervisor.store.listPendingActorInputs(f.sessionId).length, 1);
  assert.equal(f.workers.length, 1);
  f.releaseReadiness(); await ready;
  await until(() => f.workers.some(worker => worker.inputs.includes("FRESH_DURING_REFRESH")), "fresh input after resident refresh");
  assert.equal(f.workers.length, 2); assert.equal(f.workers[0].isRunning, false);
  assert.equal(f.workers.flatMap(worker => worker.inputs).filter(message => message === "FRESH_DURING_REFRESH").length, 1);
  assert.deepEqual(f.supervisor.store.listPendingActorInputs(f.sessionId), []);
  const grant = f.supervisor.store.getSessionSkillGrant(f.sessionId);
  assert.equal(grant.skills.length, 1); assert.equal(grant.skills[0].id, "changed");
  const before = JSON.stringify(grant);
  await f.client.request("get_actor_entries", { sessionId: f.sessionId });
  assert.equal(f.workers.length, 2); assert.equal(JSON.stringify(f.supervisor.store.getSessionSkillGrant(f.sessionId)), before);
});
