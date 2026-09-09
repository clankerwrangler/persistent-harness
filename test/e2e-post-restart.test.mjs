import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessClient } from "../src/client.mjs";
import { controlRequest } from "../src/control.mjs";
import { POST_RESTART_NUDGE, sanitizedRestartEnvironment } from "../src/post-restart.mjs";

const execFileAsync = promisify(execFile);
const supervisorBin = path.resolve(import.meta.dirname, "..", "bin", "harness-supervisor.mjs");
const restartBin = path.resolve(import.meta.dirname, "..", "bin", "harness-restart.mjs");
const fakeProviderPath = path.join(import.meta.dirname, "fixtures", "fake-provider.ts");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(probe, description, timeoutMs = 90_000) { const deadline = Date.now() + timeoutMs; let last; while (Date.now() < deadline) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await sleep(50); } throw new Error(`timed out waiting for ${description}${last ? `: ${last.message}` : ""}`); }
function waitLine(stream, timeoutMs = 30_000) { return new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => finish(new Error("startup timeout")), timeoutMs); const onData = (chunk) => { buffer += chunk; const newline = buffer.indexOf("\n"); if (newline >= 0) { try { finish(undefined, JSON.parse(buffer.slice(0, newline))); } catch (error) { finish(error); } } }; const finish = (error, value) => { clearTimeout(timer); stream.off("data", onData); error ? reject(error) : resolve(value); }; stream.on("data", onData); }); }
async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const [stat, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    const close = stat.lastIndexOf(")");
    const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(parentPid) || !Number.isInteger(processGroup) || !startTime) throw new Error(`invalid /proc stat for ${pid}`);
    return { pid, parentPid, processGroup, startTime, state: fields[0], argv: cmdline.toString("utf8").split("\0").filter(Boolean) };
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error?.code)) return null;
    throw error;
  }
}
function sameIdentity(left, right) { return Boolean(left && right && left.pid === right.pid && left.startTime === right.startTime); }
async function identityIsAlive(identity) {
  const current = await processIdentity(identity?.pid);
  return sameIdentity(current, identity);
}
async function processTable() {
  const entries = await readdir("/proc", { withFileTypes: true });
  const identities = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map((entry) => processIdentity(Number(entry.name))));
  return identities.filter(Boolean);
}
async function waitForIdentityExit(identity, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await identityIsAlive(identity)) return true;
    await sleep(50);
  }
  return !await identityIsAlive(identity);
}
async function terminateTestProcess(identity) {
  if (!identity || !await identityIsAlive(identity)) return;
  for (const [signal, timeoutMs] of [["SIGTERM", 3000], ["SIGKILL", 3000]]) {
    if (!await identityIsAlive(identity)) return;
    try { process.kill(identity.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    if (await waitForIdentityExit(identity, timeoutMs)) return;
  }
  throw new Error(`test process ${identity.pid} survived SIGTERM and SIGKILL`);
}
async function processGroupMembers(processGroup) {
  return (await processTable()).filter((identity) => identity.processGroup === processGroup);
}
async function waitForProcessGroupExit(processGroup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processGroupMembers(processGroup)).length === 0) return true;
    await sleep(50);
  }
  return (await processGroupMembers(processGroup)).length === 0;
}
async function terminateTestProcessGroup(group) {
  if (!group || !Number.isInteger(group.processGroup) || group.processGroup <= 0) return;
  let members = await processGroupMembers(group.processGroup);
  if (!members.length) return;
  const bound = members.some((member) => [...group.members.values()].some((known) => sameIdentity(member, known)));
  if (!bound) throw new Error(`refusing to signal unbound process group ${group.processGroup}`);
  for (const [signal, timeoutMs] of [["SIGTERM", 3000], ["SIGKILL", 3000]]) {
    members = await processGroupMembers(group.processGroup);
    if (!members.length) return;
    try { process.kill(-group.processGroup, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    if (await waitForProcessGroupExit(group.processGroup, timeoutMs)) return;
    if (signal === "SIGKILL") {
      for (const member of await processGroupMembers(group.processGroup)) {
        try { process.kill(member.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      }
    }
  }
  members = await processGroupMembers(group.processGroup);
  if (members.length) throw new Error(`process group ${group.processGroup} survived teardown: ${members.map((item) => item.pid).join(", ")}`);
}
function supervisorCommandMatches(identity, socketPath, pidPath) {
  const args = identity?.argv ?? [];
  const flagValue = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  return args.includes(supervisorBin) && args.includes("start") && flagValue("--socket") === socketPath && flagValue("--pid") === pidPath;
}
async function readBoundPidFile(pidPath, socketPath, expectedSupervisor) {
  let value;
  try { value = JSON.parse(await readFile(pidPath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (value?.socketPath !== socketPath || !Number.isInteger(value?.pid) || value.pid <= 0) throw new Error(`untrusted supervisor pid file ${pidPath}`);
  const identity = await processIdentity(value.pid);
  if (!identity) return null;
  if (!sameIdentity(identity, expectedSupervisor) && !supervisorCommandMatches(identity, socketPath, pidPath)) {
    throw new Error(`supervisor pid file ${pidPath} points at unrelated process ${value.pid}`);
  }
  return identity;
}
function mergeProcessGroup(groups, processGroup, identities) {
  if (!Number.isInteger(processGroup) || processGroup <= 0) return;
  let group = groups.get(processGroup);
  if (!group) { group = { processGroup, members: new Map() }; groups.set(processGroup, group); }
  for (const identity of identities) group.members.set(`${identity.pid}:${identity.startTime}`, identity);
}
function discoverDescendantGroups(table, supervisors, actorIdentities, groups) {
  const descendants = new Set(supervisors.map((item) => item.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of table) {
      if (!descendants.has(identity.pid) && descendants.has(identity.parentPid)) { descendants.add(identity.pid); changed = true; }
    }
  }
  const supervisorPids = new Set(supervisors.map((item) => item.pid));
  for (const identity of table) {
    if (descendants.has(identity.pid) && !supervisorPids.has(identity.pid) && identity.processGroup === identity.pid) {
      mergeProcessGroup(groups, identity.processGroup, table.filter((member) => member.processGroup === identity.processGroup));
    }
  }
  for (const known of actorIdentities.values()) {
    if (known.processGroup !== known.pid) continue;
    const members = table.filter((member) => member.processGroup === known.processGroup);
    if (members.length) mergeProcessGroup(groups, known.processGroup, members);
  }
}
async function discoverTestSupervisors({ socketPath, pidPath, expectedSupervisor, request = controlRequest }) {
  let status = null;
  try { status = await request(socketPath, "get_status", {}, { timeoutMs: 300 }); } catch {}
  const table = await processTable();
  const candidates = new Map();
  const add = (identity) => { if (identity) candidates.set(`${identity.pid}:${identity.startTime}`, identity); };
  if (await identityIsAlive(expectedSupervisor)) add(expectedSupervisor);
  for (const identity of table) if (supervisorCommandMatches(identity, socketPath, pidPath)) add(identity);
  const fromPidFile = await readBoundPidFile(pidPath, socketPath, expectedSupervisor);
  add(fromPidFile);
  const statusPid = status?.daemon?.pid ?? status?.pid;
  if (Number.isInteger(statusPid) && statusPid > 0) {
    if ((status.daemon?.socketPath ?? status.socketPath) !== socketPath) throw new Error("supervisor status came from an unexpected socket");
    const identity = table.find((item) => item.pid === statusPid);
    if (!identity) throw new Error(`supervisor status reported dead PID ${statusPid}`);
    add(identity);
  }
  return { status, table, candidates: [...candidates.values()] };
}
async function stopCurrentTestSupervisor({ socketPath, pidPath, expectedSupervisor, actorIdentities, request = controlRequest }) {
  const stoppedPids = new Set();
  const groups = new Map();
  const deadline = Date.now() + 12_000;
  let quietSince = null;
  while (Date.now() < deadline) {
    const discovered = await discoverTestSupervisors({ socketPath, pidPath, expectedSupervisor, request });
    for (const session of discovered.status?.sessions ?? []) {
      const identity = discovered.table.find((item) => item.pid === session.actorPid);
      if (identity) actorIdentities.set(`${identity.pid}:${identity.startTime}`, identity);
    }
    discoverDescendantGroups(discovered.table, discovered.candidates, actorIdentities, groups);
    if (discovered.candidates.length) {
      quietSince = null;
      const statusPid = discovered.status?.daemon?.pid ?? discovered.status?.pid;
      let gracefulPid = null;
      if (Number.isInteger(statusPid) && discovered.candidates.some((item) => item.pid === statusPid)) {
        try { await request(socketPath, "shutdown_daemon", {}, { timeoutMs: 3000 }); gracefulPid = statusPid; } catch {}
      }
      await sleep(100);
      for (const supervisor of discovered.candidates) {
        stoppedPids.add(supervisor.pid);
        if (supervisor.pid !== gracefulPid || !await waitForIdentityExit(supervisor, 4000)) await terminateTestProcess(supervisor);
        if (await identityIsAlive(supervisor)) throw new Error(`supervisor ${supervisor.pid} did not exit`);
      }
      for (const group of groups.values()) await terminateTestProcessGroup(group);
      continue;
    }
    for (const group of groups.values()) await terminateTestProcessGroup(group);
    if (quietSince === null) quietSince = Date.now();
    if (Date.now() - quietSince >= 1500) return stoppedPids;
    await sleep(50);
  }
  const remaining = await discoverTestSupervisors({ socketPath, pidPath, expectedSupervisor, request });
  throw new Error(`timed out waiting for detached supervisor publication/exit${remaining.candidates.length ? `: ${remaining.candidates.map((item) => item.pid).join(", ")}` : ""}`);
}
async function client(socketPath) { const value = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 }); assert(await value.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() })); return value; }
async function submitAndSettle(value, sessionId, message) { const settled = new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error("settle timeout")); }, 60_000); const listener = (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === sessionId && frame.data?.event?.type === "agent_settled") { cleanup(); resolve(); } }; const cleanup = () => { clearTimeout(timer); value.off("event", listener); }; value.on("event", listener); }); await value.request("submit_input", { sessionId, message, behavior: "auto" }); await settled; }

test("teardown discovers actor process groups from supervisor descendants", () => {
  const supervisor = { pid: 100, parentPid: 1, processGroup: 100, startTime: "1", argv: [] };
  const actor = { pid: 200, parentPid: 100, processGroup: 200, startTime: "2", argv: [] };
  const actorChild = { pid: 201, parentPid: 200, processGroup: 200, startTime: "3", argv: [] };
  const groups = new Map();
  discoverDescendantGroups([supervisor, actor, actorChild], [supervisor], new Map(), groups);
  assert.deepEqual([...groups.keys()], [200]);
  assert.deepEqual([...groups.get(200).members.values()].map((item) => item.pid), [200, 201]);
});

test("teardown waits for detached supervisor publication when control is unavailable", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-post-restart-publication-"));
  const socketPath = path.join(root, "run", "supervisor.sock"); const databasePath = path.join(root, "state", "harness.sqlite"); const pidPath = path.join(root, "run", "supervisor.pid");
  const env = { ...sanitizedRestartEnvironment(process.env), PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_HARNESS_AUTO_INSTALL: process.env.PI_HARNESS_AUTO_INSTALL ?? "1" };
  let daemon = null;
  const publication = (async () => {
    await sleep(250);
    daemon = spawn(process.execPath, [supervisorBin, "start", "--socket", socketPath, "--db", databasePath, "--pid", pidPath], { env, stdio: "ignore" });
  })();
  try {
    const stoppedPids = await stopCurrentTestSupervisor({ socketPath, pidPath, expectedSupervisor: null, actorIdentities: new Map(), request: async () => { throw new Error("injected unavailable control"); } });
    await publication;
    assert(daemon?.pid); assert(stoppedPids.has(daemon.pid));
    assert.equal(await processIdentity(daemon.pid), null);
  } finally {
    await publication;
    await terminateTestProcess(await processIdentity(daemon?.pid));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("external restart revives and nudges the initiating session exactly once", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-post-restart-e2e-"));
  const agentDir = path.join(root, "agent"); const cwd = path.join(root, "project");
  const socketPath = path.join(root, "run", "supervisor.sock"); const databasePath = path.join(root, "state", "harness.sqlite"); const pidPath = path.join(root, "run", "supervisor.pid");
  const clients = new Set(); const actorIdentities = new Map();
  let expectedSupervisor = null; let restartWorker = null; let replacementPid = null;
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `restart-${calls}`, object: "chat.completion.chunk", created: 1, model: "fake-model" };
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { content: `restart-answer-${calls}` }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
    response.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    const failures = [];
    for (const value of clients) {
      try { await value.stop(); } catch (error) { failures.push(error); }
    }
    let processesVerified = true;
    try {
      if (restartWorker?.processGroup === restartWorker?.pid) {
        const group = { processGroup: restartWorker.processGroup, members: new Map([[`${restartWorker.pid}:${restartWorker.startTime}`, restartWorker]]) };
        await terminateTestProcessGroup(group);
      } else await terminateTestProcess(restartWorker);
    } catch (error) { processesVerified = false; failures.push(error); }
    try {
      const stoppedPids = await stopCurrentTestSupervisor({ socketPath, pidPath, expectedSupervisor, actorIdentities });
      if (replacementPid !== null) assert(stoppedPids.has(replacementPid), `teardown did not target replacement supervisor ${replacementPid}`);
    } catch (error) { processesVerified = false; failures.push(error); }
    if (server.listening) {
      try { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } catch (error) { failures.push(error); }
    }
    if (processesVerified) {
      try { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "post-restart E2E teardown failed");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address === "object");
  const env = { ...sanitizedRestartEnvironment(process.env), PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_SOCKET: socketPath, PI_HARNESS_DATABASE: databasePath, PI_HARNESS_PID: pidPath,
    PI_HARNESS_ACTOR_EXTENSIONS: JSON.stringify([fakeProviderPath]), PI_HARNESS_ACTOR_INACTIVITY_MS: "0", PI_HARNESS_AUTO_INSTALL: process.env.PI_HARNESS_AUTO_INSTALL ?? "1", HARNESS_FAKE_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
  const daemon = spawn(process.execPath, [supervisorBin, "start", "--socket", socketPath, "--db", databasePath, "--pid", pidPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  await waitLine(daemon.stdout); const oldPid = daemon.pid;
  expectedSupervisor = await processIdentity(oldPid); assert(expectedSupervisor);
  const ui = await client(socketPath); clients.add(ui);
  const admitted = (await ui.request("create_root", { cwd, repositoryRoot: null, name: "restart-root", provider: "harness-fake", model: "fake-model", thinkingLevel: null })).admission;
  await ui.request("subscribe_session", { selector: admitted.sessionId });
  await submitAndSettle(ui, admitted.sessionId, "before restart");
  const before = (await ui.request("get_status")).sessions.find((item) => item.sessionId === admitted.sessionId);
  const sessionFile = before.sessionFile; const oldActorPid = before.actorPid;
  const oldActor = await processIdentity(oldActorPid); assert(oldActor); actorIdentities.set(`${oldActor.pid}:${oldActor.startTime}`, oldActor);
  const scheduled = JSON.parse((await execFileAsync(process.execPath, [restartBin, "--resume", admitted.sessionId, "--socket", socketPath, "--db", databasePath, "--pid", pidPath], { env, timeout: 15_000 })).stdout);
  restartWorker = await processIdentity(scheduled.workerPid);
  await ui.stop(); clients.delete(ui);
  await once(daemon, "exit");
  const restarted = await waitUntil(async () => { const status = await controlRequest(socketPath, "get_status", {}, { timeoutMs: 1000 }); return status.pid !== oldPid ? status : undefined; }, "new supervisor");
  assert.notEqual(restarted.pid, oldPid);
  replacementPid = restarted.pid; expectedSupervisor = await processIdentity(replacementPid); assert(expectedSupervisor);
  const completedJob = await waitUntil(async () => { const job = JSON.parse(await readFile(scheduled.jobPath, "utf8")); return job.state === "complete" ? job : job.state === "failed" ? Promise.reject(new Error(job.error)) : undefined; }, "restart job completion");
  assert.equal(completedJob.newPid, restarted.pid); assert(completedJob.inputId);
  const ui2 = await client(socketPath); clients.add(ui2);
  const history = await waitUntil(async () => { const result = await ui2.request("get_actor_entries", { sessionId: admitted.sessionId, since: null }); const serialized = JSON.stringify(result.entries); return serialized.includes(POST_RESTART_NUDGE) && serialized.includes("restart-answer-2") ? result : undefined; }, "automatic nudge settlement");
  const serialized = JSON.stringify(history.entries);
  assert.match(serialized, /before restart/); assert.match(serialized, /Automated post-restart continuation/);
  assert.equal(history.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry).includes(POST_RESTART_NUDGE)).length, 1);
  // Simulate a worker crash after submit_input succeeded but before the terminal job update.
  await writeFile(scheduled.jobPath, `${JSON.stringify({ ...completedJob, state: "nudging" }, null, 2)}\n`, { mode: 0o600 });
  const replayWorkers = await Promise.allSettled([1, 2].map(() => execFileAsync(process.execPath, [restartBin, "--worker", scheduled.jobPath], { env: { ...env, PI_HARNESS_RESTART_WORKER: "1" }, timeout: 30_000 })));
  assert(replayWorkers.some((result) => result.status === "fulfilled"));
  const replayedJob = JSON.parse(await readFile(scheduled.jobPath, "utf8")); assert.equal(replayedJob.state, "complete");
  const replayedHistory = await ui2.request("get_actor_entries", { sessionId: admitted.sessionId, since: null });
  assert.equal(replayedHistory.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry).includes(POST_RESTART_NUDGE)).length, 1);
  const after = (await ui2.request("get_status")).sessions.find((item) => item.sessionId === admitted.sessionId);
  assert.equal(after.sessionFile, sessionFile); assert.notEqual(after.actorPid, oldActorPid);
  const replacementActor = await processIdentity(after.actorPid); assert(replacementActor); actorIdentities.set(`${replacementActor.pid}:${replacementActor.startTime}`, replacementActor);
  await ui2.stop(); clients.delete(ui2);
});
