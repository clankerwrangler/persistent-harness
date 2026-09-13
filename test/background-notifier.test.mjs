import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BackgroundCompletionMonitor, backgroundCompletionMessage, defaultBackgroundJobsDirectory } from "../src/background-notifier.mjs";

test("background job storage follows the configured agent directory", () => {
  assert.equal(defaultBackgroundJobsDirectory({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent/state/background-jobs");
});

async function createJob(directory, id, { sessionId = "session-a", exitCode = 0, signal = null, kind = "launched", owner = true } = {}) {
  const job = path.join(directory, id);
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "meta.json"), JSON.stringify({ schema: "background.job.v1", id, name: "bootc-install", kind, ...(owner ? { session_id: sessionId } : {}) }));
  await writeFile(path.join(job, "exit.json"), JSON.stringify({ exit_code: exitCode, signal, ended_at: new Date().toISOString() }));
}

async function eventually(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition did not become true");
}

test("background completion monitor durably queues one follow-up and survives a monitor restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = "bg-0123456789ab";
  await createJob(directory, id);
  const deliveries = [];
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async (job) => { deliveries.push(job); return "sent"; } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => deliveries.length === 1);
  assert.equal(deliveries[0].sessionId, "session-a");
  assert.equal(deliveries[0].message, backgroundCompletionMessage(deliveries[0]));
  assert.match(deliveries[0].message, /completed successfully/);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, id, "notification.json"), "utf8")).state, "sent");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(deliveries.length, 1);

  await monitor.stop();
  const restarted = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => { throw new Error("must not redeliver"); } });
  restarted.start(); t.after(() => restarted.stop());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(deliveries.length, 1);
});

test("background completion monitor delivers an adopted process with an unknown exit result", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-adopted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createJob(directory, "bg-111122223333", { kind: "adopted", exitCode: null });
  const deliveries = [];
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async (job) => { deliveries.push(job); return "sent"; } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => deliveries.length === 1);
  assert.match(deliveries[0].message, /finished with an unknown result/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(deliveries.length, 1);
});

test("background completion monitor retries an unavailable actor handoff and ignores old unowned jobs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createJob(directory, "bg-abcdefabcdef", { exitCode: 1 });
  await createJob(directory, "bg-fedcbafedcba", { owner: false });
  let attempts = 0;
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("actor temporarily unavailable");
    return "sent";
  }, logger: { error() {} } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(async () => {
    try { return JSON.parse(await readFile(path.join(directory, "bg-abcdefabcdef", "notification.json"), "utf8")).state === "sent"; }
    catch { return false; }
  });
  assert.equal(attempts, 2);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(attempts, 2);
  await assert.rejects(readFile(path.join(directory, "bg-fedcbafedcba", "notification.json")));
});

async function liveProcess(t, jobId) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore", env: jobId ? { PI_BACKGROUND_JOB_ID: jobId } : {},
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  });
  await once(child, "spawn");
  const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { child, pid: child.pid, starttime: fields[19] };
}

async function createActiveJob(directory, id, identity, overrides = {}) {
  const job = path.join(directory, id);
  await mkdir(job, { recursive: true });
  const meta = {
    schema: "background.job.v1", id, name: "local-proof", kind: "adopted", session_id: "session-a",
    pid: identity.pid, starttime: identity.starttime, created_at: "2026-09-05T10:00:00.000Z",
    command: "unused-private-command", log_path: "/unused/private-log", cwd: "/unused/private-cwd",
    ...overrides,
  };
  await writeFile(path.join(job, "meta.json"), JSON.stringify(meta));
  return meta;
}

test("active background jobs are grouped by owner and publish only changed safe summaries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-active-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const launchedId = "bg-000000000002";
  const launched = await liveProcess(t, launchedId);
  const adopted = await liveProcess(t);
  await createActiveJob(directory, launchedId, launched, { kind: "launched", name: "launched-proof" });
  await createActiveJob(directory, "bg-000000000001", adopted, { name: "  adopted\nproof\u0000  " });
  await createActiveJob(directory, "bg-000000000003", adopted, { session_id: "session-b", created_at: "invalid" });
  const changes = [];
  const deliveries = [];
  const monitor = new BackgroundCompletionMonitor({
    directory, intervalMs: 100, dispatch: async (job) => { deliveries.push(job); },
    onActiveJobsChanged: (sessionId, jobs) => { changes.push({ sessionId, jobs }); },
  });
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), []);
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => changes.length === 2);
  const expected = [
    { id: "bg-000000000001", name: "adopted proof", startedAt: "2026-09-05T10:00:00.000Z" },
    { id: launchedId, name: "launched-proof", startedAt: "2026-09-05T10:00:00.000Z" },
  ];
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), expected);
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-b"), [{ id: "bg-000000000003", name: "local-proof", startedAt: null }]);
  assert.deepEqual(monitor.getActiveBackgroundJobs("unknown"), []);
  assert.equal(deliveries.length, 0);
  for (const change of changes) {
    for (const job of change.jobs) assert.deepEqual(Object.keys(job).sort(), ["id", "name", "startedAt"]);
  }
  monitor.getActiveBackgroundJobs("session-a")[0].name = "mutated getter";
  changes.find((change) => change.sessionId === "session-a").jobs[0].name = "mutated callback";
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), expected);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(changes.length, 2, "unchanged scans do not publish navigator updates");
});

test("a missing terminal marker does not make stale, unowned, or mismatched jobs active", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await liveProcess(t, "bg-111111111111");
  const cases = [
    { pid: null, starttime: null },
    { starttime: String(BigInt(identity.starttime) + 1n) },
    { pid: -1 },
    { pid: true },
    { starttime: 123 },
    { session_id: null },
    { session_id: "../other-owner" },
    { schema: "other" },
    { kind: "launched" },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    await createActiveJob(directory, `bg-${index.toString(16).padStart(12, "0")}`, identity, cases[index]);
  }
  const activeId = "bg-aaaaaaaaaaaa";
  await createActiveJob(directory, activeId, identity);
  const changes = [];
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => {},
    onActiveJobsChanged: (sessionId, jobs) => { changes.push({ sessionId, jobs }); } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => changes.length === 1);
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a").map((job) => job.id), [activeId]);
  const exited = once(identity.child, "exit");
  identity.child.kill("SIGKILL");
  await exited;
  await eventually(() => changes.length === 2);
  assert.deepEqual(changes[1], { sessionId: "session-a", jobs: [] });
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), []);
});

test("terminal jobs clear active summaries before completion dispatch and recover after restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-active-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = "bg-123412341234";
  const identity = await liveProcess(t, id);
  await createActiveJob(directory, id, identity, { kind: "launched" });
  const first = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => {} });
  first.start(); t.after(() => first.stop());
  await eventually(() => first.getActiveBackgroundJobs("session-a").length === 1);
  await first.stop();
  let completions = 0;
  const order = [];
  const restarted = new BackgroundCompletionMonitor({ directory, intervalMs: 100,
    onActiveJobsChanged: (sessionId, jobs) => { order.push(jobs.length ? "active" : "clear"); },
    dispatch: async () => {
      assert.deepEqual(restarted.getActiveBackgroundJobs("session-a"), []);
      order.push("complete"); completions += 1;
    },
  });
  restarted.start(); t.after(() => restarted.stop());
  await eventually(() => restarted.getActiveBackgroundJobs("session-a").length === 1);
  await writeFile(path.join(directory, id, "exit.json"), JSON.stringify({ exit_code: 0, signal: null, ended_at: new Date().toISOString() }));
  await eventually(() => completions === 1);
  assert.deepEqual(order, ["active", "clear", "complete"]);
  await eventually(async () => {
    try { return JSON.parse(await readFile(path.join(directory, id, "notification.json"), "utf8")).state === "sent"; } catch { return false; }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(completions, 1);
});


test("activity callback failures and pending callbacks do not block completion delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-callback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await liveProcess(t);
  for (const [index, sessionId] of ["session-a", "session-b", "session-c"].entries()) {
    await createActiveJob(directory, `bg-${index.toString(16).padStart(12, "0")}`, identity, { session_id: sessionId });
  }
  await createJob(directory, "bg-ffffffffffff");
  let completions = 0;
  const errors = [];
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100,
    onActiveJobsChanged: (sessionId) => {
      if (sessionId === "session-a") throw new Error("private-error-detail");
      if (sessionId === "session-b") return Promise.reject(new Error("private-error-detail"));
      return new Promise(() => {});
    },
    logger: { error: (message) => { errors.push(message); } },
    dispatch: async () => { completions += 1; },
  });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => completions === 1 && errors.length === 2);
  for (const sessionId of ["session-a", "session-b", "session-c"]) assert.equal(monitor.getActiveBackgroundJobs(sessionId).length, 1);
  assert.deepEqual(errors, ["background activity update failed", "background activity update failed"]);
  await monitor.stop();
  assert.equal(JSON.parse(await readFile(path.join(directory, "bg-ffffffffffff", "notification.json"), "utf8")).state, "sent");
});

test("oversized and nonregular metadata do not leak or block active and terminal jobs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await liveProcess(t);
  await createActiveJob(directory, "bg-000000000001", identity, { name: "x".repeat(100), command: "x".repeat(64 * 1024) });
  const validId = "bg-000000000002";
  await createActiveJob(directory, validId, identity, { name: "x".repeat(100) });
  const symlinkId = "bg-000000000003";
  await mkdir(path.join(directory, symlinkId));
  const outside = path.join(directory, "outside.json");
  await writeFile(outside, JSON.stringify({ schema: "background.job.v1", id: symlinkId, kind: "adopted", session_id: "session-a", pid: identity.pid, starttime: identity.starttime }));
  await symlink(outside, path.join(directory, symlinkId, "meta.json"));
  await symlink(path.join(directory, validId), path.join(directory, "bg-000000000004"));
  const fifo = path.join(directory, "bg-000000000005", "meta.json");
  await mkdir(path.dirname(fifo));
  await promisify(execFile)("mkfifo", [fifo], { timeout: 1000 });
  await mkdir(path.join(directory, "bg-000000000006", "meta.json"), { recursive: true });
  await createJob(directory, "bg-ffffffffffff");
  let completions = 0;
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => { completions += 1; } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => completions === 1);
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), [{ id: validId, name: "x".repeat(64), startedAt: "2026-09-05T10:00:00.000Z" }]);
  await rm(path.join(directory, validId), { recursive: true });
  await eventually(() => monitor.getActiveBackgroundJobs("session-a").length === 0);
});

test("canonical Python launch and adoption stay visible until their terminal markers arrive", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "background-notifier-canonical-"));
  const agentDirectory = path.join(root, "agent");
  const directory = path.join(agentDirectory, "state", "background-jobs");
  const release = path.join(root, "release");
  const identity = await liveProcess(t);
  let ids = [];
  t.after(async () => {
    await writeFile(release, "release");
    await eventually(async () => {
      try { await Promise.all(ids.map((id) => readFile(path.join(directory, id, "exit.json")))); return true; } catch { return false; }
    }, 3000).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const { stdout } = await promisify(execFile)(process.env.PI_HARNESS_PYTHON || "python3", ["-c", `
import asyncio, json, sys
import harness_background
async def run():
    launched = await harness_background.run(operation="launch", name="canonical-launch", command="for i in {1..200}; do if test -f release; then exit 0; fi; sleep 0.05; done; exit 124")
    adopted = await harness_background.run(operation="adopt", name="canonical-adopt", pid=int(sys.argv[1]))
    assert launched["ok"] and adopted["ok"]
    print(json.dumps([launched["id"], adopted["id"]]))
asyncio.run(run())
`, String(identity.pid)], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDirectory, PI_HARNESS_ACTOR_ID: "canonical-owner",
      PYTHONPATH: path.join(process.env.PI_HARNESS_SKILLS_PATH || path.resolve(import.meta.dirname, "../skills"), "background", "src"),
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 5000, maxBuffer: 64 * 1024,
  });
  ids = JSON.parse(stdout);
  const deliveries = [];
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async (job) => { deliveries.push(job); } });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => monitor.getActiveBackgroundJobs("canonical-owner").length === 2);
  assert.deepEqual(monitor.getActiveBackgroundJobs("canonical-owner").map((job) => job.id), [...ids].sort());
  assert.deepEqual(monitor.getActiveBackgroundJobs("canonical-owner").map((job) => job.name).sort(), ["canonical-adopt", "canonical-launch"]);
  assert.equal(deliveries.length, 0);
  await writeFile(release, "release");
  const exited = once(identity.child, "exit");
  identity.child.kill("SIGKILL");
  await exited;
  await eventually(() => deliveries.length === 2);
  assert.deepEqual(monitor.getActiveBackgroundJobs("canonical-owner"), []);
  await monitor.stop();
  for (const id of ids) assert.equal(JSON.parse(await readFile(path.join(directory, id, "notification.json"), "utf8")).state, "sent");
});


test("a zombie with a matching starttime and no terminal marker is not active", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-zombie-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const holder = spawn(process.env.PI_HARNESS_PYTHON || "python3", ["-c", `
import os, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
print(pid, flush=True)
sys.stdin.read(1)
os.waitpid(pid, 0)
`], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore"] });
  t.after(async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    const exited = once(holder, "exit");
    holder.stdin.end();
    await exited;
  });
  const output = once(holder.stdout, "data");
  await once(holder, "spawn");
  const [chunk] = await output;
  const pid = Number(chunk.toString("utf8").trim());
  let fields;
  await eventually(async () => {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] === "Z";
  });
  await createActiveJob(directory, "bg-000000000001", { pid, starttime: fields[19] });
  await createJob(directory, "bg-ffffffffffff");
  let completions = 0;
  let changes = 0;
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100,
    dispatch: async () => { completions += 1; }, onActiveJobsChanged: () => { changes += 1; },
  });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => completions === 1);
  assert.deepEqual(monitor.getActiveBackgroundJobs("session-a"), []);
  assert.equal(changes, 0);
});

test("active summaries stay bounded while discovery advances", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-job-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await liveProcess(t);
  for (let index = 0; index < 129; index += 1) {
    await createActiveJob(directory, `bg-${index.toString(16).padStart(12, "0")}`, identity);
  }
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => {} });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => monitor.getActiveBackgroundJobs("session-a").length > 0);
  assert.equal(monitor.getActiveBackgroundJobs("session-a").length, 128);
});


test("fair discovery reaches jobs beyond retained history without stale activity or lost completions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-notifier-fair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = await liveProcess(t);
  for (let index = 0; index < 260; index += 1) {
    const id = `bg-${index.toString(16).padStart(12, "0")}`;
    await createJob(directory, id);
    await writeFile(path.join(directory, id, "notification.json"), JSON.stringify({ version: 1, jobId: id, state: "sent" }));
  }
  const activeId = "bg-fffffffffff0";
  const terminalId = "bg-fffffffffff1";
  await createActiveJob(directory, activeId, identity);
  await createJob(directory, terminalId);
  const changes = [];
  let attempts = 0;
  const monitor = new BackgroundCompletionMonitor({ directory, intervalMs: 100,
    onActiveJobsChanged: (sessionId, jobs) => { changes.push({ sessionId, jobs }); },
    dispatch: async (job) => {
      assert.equal(job.id, terminalId);
      attempts += 1;
      if (attempts === 1) throw new Error("temporary delivery failure");
    },
    logger: { error() {} },
  });
  monitor.start(); t.after(() => monitor.stop());
  await eventually(() => monitor.getActiveBackgroundJobs("session-a").some((job) => job.id === activeId) && attempts === 2, 4000);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(changes.length, 1, "unvisited discovery batches do not clear verified live jobs");
  assert.equal(attempts, 2, "notification markers still prevent redelivery across scan cycles");
  assert.equal(JSON.parse(await readFile(path.join(directory, terminalId, "notification.json"), "utf8")).state, "sent");
  await rm(path.join(directory, activeId), { recursive: true });
  await eventually(() => monitor.getActiveBackgroundJobs("session-a").length === 0);
  assert.deepEqual(changes.at(-1), { sessionId: "session-a", jobs: [] });
  await monitor.stop();
  await createActiveJob(directory, activeId, identity);
  const restarted = new BackgroundCompletionMonitor({ directory, intervalMs: 100, dispatch: async () => { throw new Error("must not redeliver"); } });
  restarted.start(); t.after(() => restarted.stop());
  await eventually(() => restarted.getActiveBackgroundJobs("session-a").some((job) => job.id === activeId), 4000);
  const exited = once(identity.child, "exit");
  identity.child.kill("SIGKILL");
  await exited;
  await eventually(() => restarted.getActiveBackgroundJobs("session-a").length === 0);
});
