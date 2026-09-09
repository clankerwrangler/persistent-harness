import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HarnessClient } from "./client.mjs";
import { controlRequest } from "./control.mjs";
import { processOwnershipInternals } from "./process-ownership.mjs";

const execFileAsync = promisify(execFile);
export const RESTART_JOB_VERSION = 1;
export const DEFAULT_RESTART_TIMEOUT_MS = 10 * 60 * 1000;
export const POST_RESTART_NUDGE = "Automated post-restart continuation: verify that the requested persistent-harness restart completed, report the result, and continue the task that initiated it. This is a local harness nudge, not a new instruction typed by the Commander. Do not initiate another restart solely because of this nudge.";
const MIN_RESTART_TIMEOUT_MS = 10_000;
const MAX_RESTART_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_SESSION_ID_BYTES = 128;
const MAX_RESTART_JOB_BYTES = 64 * 1024;
const MAX_TERMINAL_RESTART_JOBS = 64;
const RESTART_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function boundedString(value, name, maxBytes) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\n") || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${name} must be a non-empty bounded single-line string`);
  }
  return value;
}
function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_RESTART_TIMEOUT_MS || parsed > MAX_RESTART_TIMEOUT_MS) {
    throw new Error(`timeout must be an integer from ${MIN_RESTART_TIMEOUT_MS} through ${MAX_RESTART_TIMEOUT_MS}`);
  }
  return parsed;
}
function resolvePaths(values, env) {
  const agentDir = path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const harnessDir = path.join(agentDir, "harness");
  return {
    agentDir,
    socketPath: path.resolve(values.socketPath || env.PI_HARNESS_SOCKET || path.join(harnessDir, "supervisor.sock")),
    databasePath: path.resolve(values.databasePath || env.PI_HARNESS_DATABASE || path.join(harnessDir, "harness.sqlite")),
    pidPath: path.resolve(values.pidPath || env.PI_HARNESS_PID || path.join(harnessDir, "supervisor.pid")),
  };
}

export function parseRestartArgs(argv, env = process.env) {
  const values = { resumeSessionId: env.PI_HARNESS_ACTOR_ID || null, timeoutMs: DEFAULT_RESTART_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--worker") {
      if (!value) throw new Error("--worker requires a job path");
      values.workerJobPath = path.resolve(value); index += 1;
    } else if (["--resume", "--timeout-ms", "--socket", "--db", "--pid"].includes(flag)) {
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--resume") values.resumeSessionId = value;
      else if (flag === "--timeout-ms") values.timeoutMs = boundedTimeout(value);
      else if (flag === "--socket") values.socketPath = value;
      else if (flag === "--db") values.databasePath = value;
      else values.pidPath = value;
      index += 1;
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (values.workerJobPath) {
    if (env.PI_HARNESS_RESTART_WORKER !== "1") throw new Error("worker mode is available only to a scheduled restart process");
    return { workerJobPath: values.workerJobPath };
  }
  values.resumeSessionId = boundedString(values.resumeSessionId, "resume session id", MAX_SESSION_ID_BYTES);
  if (env.PI_HARNESS_ACTOR_ID && values.resumeSessionId !== env.PI_HARNESS_ACTOR_ID) {
    throw new Error("an actor may restart and resume only its own session");
  }
  return { ...resolvePaths(values, env), resumeSessionId: values.resumeSessionId, timeoutMs: boundedTimeout(values.timeoutMs) };
}

export function sanitizedRestartEnvironment(env = process.env) {
  const result = { ...env };
  for (const name of ["PI_HARNESS_ACTOR_ID", "PI_HARNESS_ACTOR_TOKEN", "PI_HARNESS_ACTOR_GENERATION", "PI_HARNESS_ACTOR_SKILL_GRANT", "PI_HARNESS_RESTART_WORKER", "PI_SESSION_ID", "PI_SESSION_FILE"]) delete result[name];
  return result;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
async function readJobJson(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > MAX_RESTART_JOB_BYTES) throw new Error("restart job exceeds its size boundary");
  return JSON.parse(await readFile(file, "utf8"));
}
async function pruneRestartJobs(directory) {
  const terminal = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    try {
      const metadata = await stat(file);
      if (metadata.size > MAX_RESTART_JOB_BYTES) continue;
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value?.state === "complete" || value?.state === "failed") terminal.push({ file, mtimeMs: metadata.mtimeMs });
    } catch {}
  }
  terminal.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const cutoff = Date.now() - RESTART_JOB_RETENTION_MS;
  await Promise.all(terminal.filter((item, index) => index >= MAX_TERMINAL_RESTART_JOBS || item.mtimeMs < cutoff).map((item) => rm(item.file, { force: true })));
}
function activeCount(status) {
  const counts = status?.counts?.sessions ?? {};
  return Object.entries(counts).reduce((sum, [key, value]) => sum + ((key.endsWith(":working") || key.endsWith(":delegating")) && Number.isInteger(value) ? value : 0), 0)
    + (status?.capacity?.starting ?? 0) + (status?.capacity?.queued ?? 0);
}
async function waitForIdle(job, request = controlRequest) {
  const deadline = Date.now() + job.timeoutMs;
  let stable = false;
  while (Date.now() < deadline) {
    const status = await request(job.socketPath, "get_status", {}, { timeoutMs: 3000 });
    const clear = activeCount(status) === 0;
    if (clear && stable) return status;
    stable = clear;
    await sleep(clear ? 1500 : 500);
  }
  throw new Error("timed out waiting for all harness actors to settle");
}
async function processStartTime(pid) {
  return processOwnershipInternals.parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8")).startTime;
}
async function waitForShutdown(socketPath, pid, startTime, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let socketDown = false;
  let processGone = !Number.isInteger(pid) || pid <= 0;
  while (Date.now() < deadline) {
    try { await controlRequest(socketPath, "get_status", {}, { timeoutMs: 250 }); }
    catch { socketDown = true; }
    if (!processGone) {
      try { processGone = typeof startTime === "string" && await processStartTime(pid) !== startTime; }
      catch (error) { if (error?.code === "ESRCH" || error?.code === "ENOENT") processGone = true; else throw error; }
    }
    if (socketDown && processGone) return;
    await sleep(100);
  }
  throw new Error(`old supervisor ${pid} did not fully stop`);
}
async function submitNudge(job) {
  const client = new HarnessClient({ socketPath: job.socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 });
  try {
    const registered = await client.start({ registrationType: "register_client", clientInstanceId: `restart-${job.jobId}` });
    if (!registered) throw new Error("could not register post-restart client");
    return await client.request("submit_input", {
      sessionId: job.resumeSessionId,
      message: POST_RESTART_NUDGE,
      behavior: "auto",
      clientRequestId: `post-restart-${job.jobId}`,
    });
  } finally { await client.stop().catch(() => {}); }
}
const JOB_STATES = new Set(["scheduled", "waiting_for_idle", "stopping", "starting", "nudging", "complete", "failed"]);
function validateJob(value) {
  if (!value || value.version !== RESTART_JOB_VERSION || typeof value.jobId !== "string" || !JOB_STATES.has(value.state)) throw new Error("invalid restart job");
  const job = {
    version: RESTART_JOB_VERSION,
    jobId: boundedString(value.jobId, "job id", 128),
    state: value.state,
    createdAt: boundedString(value.createdAt, "createdAt", 128),
    resumeSessionId: boundedString(value.resumeSessionId, "resume session id", MAX_SESSION_ID_BYTES),
    socketPath: path.resolve(boundedString(value.socketPath, "socket path", 4096)),
    databasePath: path.resolve(boundedString(value.databasePath, "database path", 4096)),
    pidPath: path.resolve(boundedString(value.pidPath, "pid path", 4096)),
    timeoutMs: boundedTimeout(value.timeoutMs),
  };
  for (const key of ["oldPid", "newPid"]) if (Number.isInteger(value[key]) && value[key] > 0) job[key] = value[key];
  if (typeof value.oldStartTime === "string") job.oldStartTime = boundedString(value.oldStartTime, "old process start time", 64);
  if (typeof value.inputId === "string") job.inputId = boundedString(value.inputId, "input id", 256);
  if (value.ensured && typeof value.ensured === "object" && !Array.isArray(value.ensured)) job.ensured = value.ensured;
  if (typeof value.updatedAt === "string") job.updatedAt = boundedString(value.updatedAt, "updatedAt", 128);
  if (typeof value.error === "string") job.error = value.error.slice(0, 2048);
  return job;
}
function assertCanonicalJob(jobPath, job, env = process.env) {
  const expected = resolvePaths({}, env);
  if (job.socketPath !== expected.socketPath || job.databasePath !== expected.databasePath || job.pidPath !== expected.pidPath) {
    throw new Error("restart job paths do not match the worker environment");
  }
  const expectedPath = path.join(path.dirname(job.databasePath), "restart-jobs", `${job.jobId}.json`);
  if (path.resolve(jobPath) !== expectedPath) throw new Error("restart job is outside the canonical job directory");
}
async function acquireJobLock(jobPath) {
  const lockPath = `${jobPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const identity = processOwnershipInternals.parseProcStat(await readFile(`/proc/${process.pid}/stat`, "utf8"));
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startTime: identity.startTime, createdAt: new Date().toISOString() })}\n`);
      return async () => { await handle.close().catch(() => {}); await rm(lockPath, { force: true }).catch(() => {}); };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerAlive = false;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.startTime === "string") {
          try {
            const identity = processOwnershipInternals.parseProcStat(await readFile(`/proc/${owner.pid}/stat`, "utf8"));
            ownerAlive = identity.startTime === owner.startTime;
          } catch {}
        }
      } catch {}
      if (ownerAlive) throw new Error("restart job is already claimed by a live worker");
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("could not claim restart job");
}

export async function schedulePostRestart(options, { scriptPath, spawnImpl = spawn, request = controlRequest } = {}) {
  if (!scriptPath) throw new Error("scriptPath is required");
  const status = await request(options.socketPath, "get_status", {}, { timeoutMs: 3000 });
  const session = (status.sessions ?? []).find((item) => item.sessionId === options.resumeSessionId);
  if (!session || session.lifecycle === "deleted") throw new Error("initiating session is not visible to the supervisor");
  const jobId = randomUUID();
  const jobsDir = path.join(path.dirname(options.databasePath), "restart-jobs");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  await pruneRestartJobs(jobsDir);
  const jobPath = path.join(jobsDir, `${jobId}.json`);
  const job = { version: RESTART_JOB_VERSION, jobId, state: "scheduled", createdAt: new Date().toISOString(), resumeSessionId: options.resumeSessionId,
    socketPath: options.socketPath, databasePath: options.databasePath, pidPath: options.pidPath, timeoutMs: options.timeoutMs };
  await writeJsonAtomic(jobPath, job);
  const workerEnv = {
    ...sanitizedRestartEnvironment(process.env),
    PI_HARNESS_SOCKET: options.socketPath,
    PI_HARNESS_DATABASE: options.databasePath,
    PI_HARNESS_PID: options.pidPath,
    PI_HARNESS_RESTART_WORKER: "1",
  };
  const child = spawnImpl(process.execPath, [path.resolve(scriptPath), "--worker", jobPath], {
    detached: true, stdio: "ignore", env: workerEnv,
  });
  child.unref();
  return { scheduled: true, jobId, jobPath, resumeSessionId: options.resumeSessionId, workerPid: child.pid };
}

export async function runPostRestartJob(jobPath, { supervisorBin } = {}) {
  if (!supervisorBin) throw new Error("supervisorBin is required");
  const release = await acquireJobLock(jobPath);
  let job;
  try {
    job = validateJob(await readJobJson(jobPath));
    assertCanonicalJob(jobPath, job);
  } catch (error) {
    await release();
    throw error;
  }
  const update = async (state, details = {}) => {
    job = validateJob({ ...job, state, updatedAt: new Date().toISOString(), ...details });
    await writeJsonAtomic(jobPath, job);
    return job;
  };
  try {
    if (job.state === "complete") return { oldPid: job.oldPid, newPid: job.newPid, input: { inputId: job.inputId } };
    if (job.state === "failed") throw new Error(`restart job previously failed: ${job.error ?? "unknown error"}`);

    if (job.state === "scheduled" || job.state === "waiting_for_idle") {
      if (job.state === "scheduled") await update("waiting_for_idle");
      const status = await waitForIdle(job);
      const oldPid = status.daemon?.pid ?? status.pid;
      if (!Number.isInteger(oldPid) || oldPid <= 0) throw new Error("running supervisor did not report a valid PID");
      await update("stopping", { oldPid, oldStartTime: await processStartTime(oldPid) });
    }

    if (job.state === "stopping") {
      let current;
      try { current = await controlRequest(job.socketPath, "get_status", {}, { timeoutMs: 1000 }); } catch {}
      const currentPid = current?.daemon?.pid ?? current?.pid;
      if (currentPid === job.oldPid) {
        await controlRequest(job.socketPath, "shutdown_daemon", {}, { timeoutMs: 5000 });
        await waitForShutdown(job.socketPath, job.oldPid, job.oldStartTime);
        await update("starting");
      } else if (Number.isInteger(currentPid) && currentPid > 0) {
        await update("nudging", { newPid: currentPid });
      } else {
        await waitForShutdown(job.socketPath, job.oldPid, job.oldStartTime);
        await update("starting");
      }
    }

    if (job.state === "starting") {
      const { stdout } = await execFileAsync(process.execPath, [supervisorBin, "ensure", "--socket", job.socketPath, "--db", job.databasePath, "--pid", job.pidPath], {
        env: sanitizedRestartEnvironment(process.env), timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      const ensured = JSON.parse(stdout);
      const restarted = await controlRequest(job.socketPath, "get_status", {}, { timeoutMs: 5000 });
      const newPid = restarted.daemon?.pid ?? restarted.pid;
      if (!Number.isInteger(newPid) || newPid <= 0 || newPid === job.oldPid) throw new Error("supervisor did not restart with a new PID");
      await update("nudging", { newPid, ensured });
    }

    if (job.state === "nudging") {
      const restarted = await controlRequest(job.socketPath, "get_status", {}, { timeoutMs: 5000 });
      const newPid = restarted.daemon?.pid ?? restarted.pid;
      if (!Number.isInteger(newPid) || newPid <= 0 || newPid === job.oldPid) throw new Error("replacement supervisor is unavailable");
      const input = await submitNudge(job);
      await update("complete", { newPid, inputId: input.inputId });
      return { oldPid: job.oldPid, newPid, input };
    }
    throw new Error(`restart job reached unexpected state ${job.state}`);
  } catch (error) {
    if (job.state !== "complete" && !String(error?.message ?? error).includes("already claimed")) {
      await update("failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
    throw error;
  } finally { await release(); }
}
