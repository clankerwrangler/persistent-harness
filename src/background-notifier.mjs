import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const JOB_ID = /^bg-[0-9a-f]{12}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_JOBS = 128;
const NOTIFICATION_FILE = "notification.json";

export function defaultBackgroundJobsDirectory(env = process.env) {
  const root = typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR
    ? env.PI_CODING_AGENT_DIR
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(root, "state", "background-jobs");
}

function safeName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 64) : fallback;
}

async function readBoundedText(file, maxBytes = MAX_FILE_BYTES) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return length > maxBytes ? null : buffer.toString("utf8", 0, length);
  } finally { await handle.close(); }
}

async function readJson(file) {
  try {
    const text = await readBoundedText(file);
    if (text === null) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

async function isActiveProcess(meta) {
  if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0 || meta.pid > 2 ** 31 - 1
    || typeof meta.starttime !== "string" || !/^[0-9]{1,20}$/.test(meta.starttime)) return false;
  let stat;
  try { stat = await readBoundedText(`/proc/${meta.pid}/stat`, 4096); } catch { return false; }
  if (stat === null) return false;
  // Linux comm can contain spaces and parentheses. Fields after its final ')' start at state.
  const close = stat.lastIndexOf(")");
  if (close < 0) return false;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  if (["Z", "X", "x"].includes(fields[0]) || fields[19] !== meta.starttime) return false;
  if (meta.kind === "launched") {
    try {
      const environment = await readBoundedText(`/proc/${meta.pid}/environ`);
      if (environment === null || !environment.split("\0").includes(`PI_BACKGROUND_JOB_ID=${meta.id}`)) return false;
    } catch {
      // Match the skill: an unreadable environment does not invalidate a matching PID/starttime.
    }
  }
  return true;
}

function startedAt(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function terminalExit(value) {
  if (!value || Object.keys(value).some((key) => !["exit_code", "signal", "ended_at"].includes(key))) return null;
  const exitCode = value.exit_code === null || Number.isSafeInteger(value.exit_code) ? value.exit_code : undefined;
  const signal = value.signal === null || typeof value.signal === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(value.signal) ? value.signal : undefined;
  const endedAt = typeof value.ended_at === "string" && Number.isFinite(Date.parse(value.ended_at)) ? value.ended_at : undefined;
  if (exitCode === undefined || signal === undefined || endedAt === undefined) return null;
  return { exitCode, signal, endedAt };
}

async function readJob(directory, id) {
  try { if (!(await lstat(path.join(directory, id))).isDirectory()) return null; } catch { return null; }
  const meta = await readJson(path.join(directory, id, "meta.json"));
  if (!meta || meta.schema !== "background.job.v1" || meta.id !== id || !["launched", "adopted"].includes(meta.kind)
    || typeof meta.session_id !== "string" || !SESSION_ID.test(meta.session_id)) return null;
  const exit = terminalExit(await readJson(path.join(directory, id, "exit.json")));
  if (!exit) {
    if (!await isActiveProcess(meta)) return null;
    return { active: { id, name: safeName(meta.name, id), sessionId: meta.session_id, startedAt: startedAt(meta.created_at) } };
  }
  const notification = await readJson(path.join(directory, id, NOTIFICATION_FILE));
  const notificationState = notification?.version === 1 && notification.jobId === id
    && (notification.state === "sent" || notification.state === "skipped") ? notification.state : null;
  return { completed: {
    id,
    name: safeName(meta.name, id),
    sessionId: meta.session_id,
    exitCode: exit.exitCode,
    signal: exit.signal,
    endedAt: exit.endedAt,
    notificationState,
  } };
}

export function backgroundCompletionMessage(job) {
  const outcome = job.signal
    ? `was terminated by ${job.signal}`
    : job.exitCode === 0
      ? "completed successfully (exit code 0)"
      : job.exitCode === null
        ? "finished with an unknown result"
        : `failed (exit code ${job.exitCode})`;
  return `Background process "${safeName(job.name, job.id)}" ${outcome}.\nJob ID: ${job.id}.\nContinue with background(operation="status", selector="${job.id}") and inspect its logs if needed.`;
}

async function markNotification(directory, job, state) {
  const target = path.join(directory, job.id, NOTIFICATION_FILE);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, state, jobId: job.id, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, target); }
  catch (error) { try { await unlink(temporary); } catch {} throw error; }
}

export class BackgroundCompletionMonitor {
  #directory;
  #dispatch;
  #logger;
  #intervalMs;
  #timer;
  #scanPromise;
  #inFlight = new Set();
  #stopped = true;
  #activeJobs = new Map();
  #onActiveJobsChanged;
  #directoryReader;
  #retryJobs = new Set();

  constructor({ directory = defaultBackgroundJobsDirectory(), dispatch, onActiveJobsChanged = () => {}, intervalMs = 1_000, logger = console } = {}) {
    if (typeof directory !== "string" || !directory) throw new Error("background jobs directory is required");
    if (typeof dispatch !== "function") throw new Error("background completion dispatch is required");
    if (typeof onActiveJobsChanged !== "function") throw new Error("background activity callback is invalid");
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60 * 60 * 1000) throw new Error("background completion interval is invalid");
    this.#directory = path.resolve(directory); this.#dispatch = dispatch; this.#intervalMs = intervalMs; this.#logger = logger;
    this.#onActiveJobsChanged = onActiveJobsChanged;
  }

  getActiveBackgroundJobs(sessionId) {
    return (this.#activeJobs.get(sessionId) ?? []).map((job) => ({ ...job }));
  }

  #publishActiveJobs(jobs) {
    const next = new Map();
    let count = 0;
    for (const { active } of jobs) {
      if (!active) continue;
      if (count++ >= MAX_JOBS) break;
      const summaries = next.get(active.sessionId) ?? [];
      summaries.push({ id: active.id, name: active.name, startedAt: active.startedAt });
      next.set(active.sessionId, summaries);
    }
    const previous = this.#activeJobs;
    this.#activeJobs = next;
    for (const sessionId of new Set([...previous.keys(), ...next.keys()])) {
      if (JSON.stringify(previous.get(sessionId) ?? []) === JSON.stringify(next.get(sessionId) ?? [])) continue;
      // Activity consumers cannot delay or fail the durable completion handoff.
      const report = () => this.#logger.error?.("background activity update failed");
      try { Promise.resolve(this.#onActiveJobsChanged(sessionId, this.getActiveBackgroundJobs(sessionId))).catch(report); }
      catch { report(); }
    }
  }

  async #closeDirectoryReader() {
    const reader = this.#directoryReader;
    this.#directoryReader = undefined;
    try { await reader?.close(); } catch {}
  }

  async #scanJobs() {
    // Recheck known activity on every scan, not only when discovery reaches it again.
    const ids = new Set(this.#retryJobs);
    for (const jobs of this.#activeJobs.values()) for (const job of jobs) ids.add(job.id);
    try {
      this.#directoryReader ??= await opendir(this.#directory, { bufferSize: 32 });
      for (let count = 0; count < MAX_JOBS; count += 1) {
        const entry = await this.#directoryReader.read();
        if (!entry) { await this.#closeDirectoryReader(); break; }
        if (entry.isDirectory() && JOB_ID.test(entry.name)) ids.add(entry.name);
      }
    } catch { await this.#closeDirectoryReader(); }
    const jobs = (await Promise.all([...ids].sort().map((id) => readJob(this.#directory, id)))).filter(Boolean);
    const retryable = new Set(jobs.filter((job) => job.completed && !job.completed.notificationState).map((job) => job.completed.id));
    for (const id of this.#retryJobs) if (!retryable.has(id)) this.#retryJobs.delete(id);
    return jobs;
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#runScan();
    this.#timer = setInterval(() => { void this.#runScan(); }, this.#intervalMs);
    this.#timer.unref?.();
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#scanPromise;
    await this.#closeDirectoryReader();
  }

  async #runScan() {
    if (this.#stopped || this.#scanPromise) return this.#scanPromise;
    const operation = (async () => {
      const jobs = await this.#scanJobs();
      if (this.#stopped) return;
      this.#publishActiveJobs(jobs);
      for (const { completed: job } of jobs) {
        if (!job) continue;
        if (this.#stopped || job.notificationState || this.#inFlight.has(job.id)) continue;
        this.#inFlight.add(job.id);
        try {
          const result = await this.#dispatch({ ...job, message: backgroundCompletionMessage(job) });
          await markNotification(this.#directory, job, result === "skipped" ? "skipped" : "sent");
          this.#retryJobs.delete(job.id);
        } catch (error) {
          if (this.#retryJobs.size < MAX_JOBS) this.#retryJobs.add(job.id);
          this.#logger.error?.(`background completion delivery failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
        } finally { this.#inFlight.delete(job.id); }
      }
    })();
    this.#scanPromise = operation;
    try { await operation; } finally { if (this.#scanPromise === operation) this.#scanPromise = undefined; }
  }
}
