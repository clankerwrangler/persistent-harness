import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cronLaunchFromRequest, mergeCronLaunch } from "./cron-launch.mjs";
import { DEFAULT_CRON_TIMEZONE, nextCronRunAfter, normalizeCronSchedule } from "./cron-schedule.mjs";

function shortId(bytes = 9) { return randomBytes(bytes).toString("base64url"); }
function scheduledRunId(jobId, scheduledAt) {
  return `cron-${createHash("sha256").update(jobId).update("\0").update(String(scheduledAt)).digest("hex").slice(0, 24)}`;
}
function manualRunId(jobId, now) { return `cron-${createHash("sha256").update(jobId).update("\0manual\0").update(String(now)).update("\0").update(shortId()).digest("hex").slice(0, 24)}`; }
function requireRepeat(value, recurring) {
  if (value == null) return recurring ? null : 1;
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new TypeError("repeat must be an integer from 1 through 1000000 or null");
  if (!recurring && value !== 1) throw new TypeError("one-shot schedules require repeat 1");
  return value;
}

export function cronRunPrompt(job, run) {
  return [
    `Scheduled job ${job.name} (${job.jobId}) is firing.`,
    `Scheduled occurrence: ${new Date(run.scheduledAt).toISOString()}.`,
    "Complete the self-contained task below. Do not create, update, or remove scheduled jobs during this run.",
    "## Scheduled task",
    job.prompt,
  ].join("\n\n");
}

export class CronScheduler {
  #timer;
  #ticking = false;
  #stopped = true;
  #launches = new Set();

  constructor({ cronStore, sessionStore, dispatchRun, tickIntervalMs = 60_000, maxParallel = 2,
    defaultTimezone = DEFAULT_CRON_TIMEZONE, now = () => Date.now(), logger = console }) {
    if (!cronStore || !sessionStore || typeof dispatchRun !== "function") throw new Error("cron scheduler dependencies are required");
    if (!Number.isInteger(tickIntervalMs) || tickIntervalMs < 100 || tickIntervalMs > 60 * 60 * 1000) throw new Error("tickIntervalMs is invalid");
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32) throw new Error("maxParallel is invalid");
    Object.assign(this, { cronStore, sessionStore, dispatchRun, tickIntervalMs, maxParallel,
      defaultTimezone, now, logger });
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.cronStore.reconcileInterruptedRuns(this.now());
    this.#timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.#timer.unref?.();
    setImmediate(() => void this.tick());
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled([...this.#launches]);
  }

  async tick(now = this.now()) {
    if (this.#stopped || this.#ticking) return { claimed: 0, skipped: 0 };
    this.#ticking = true;
    let claimed = 0; let skipped = 0;
    try {
      let capacity = Math.max(0, this.maxParallel - this.cronStore.countActiveRuns());
      for (const job of this.cronStore.listDueJobs(now, 64)) {
        if (capacity <= 0) break;
        const nextRunAt = nextCronRunAfter(job.schedule, job.nextRunAt, now);
        const result = this.cronStore.claimScheduledRun(job.jobId, {
          runId: scheduledRunId(job.jobId, job.nextRunAt), scheduledAt: job.nextRunAt, nextRunAt,
        }, now);
        if (result.skipped) { skipped += 1; continue; }
        if (!result.claimed) continue;
        claimed += 1; capacity -= 1; this.#launch(result.run, result.job);
      }
      this.cronStore.pruneRuns(50);
      return { claimed, skipped };
    } finally { this.#ticking = false; }
  }

  #launch(run, job) {
    const operation = Promise.resolve().then(() => this.dispatchRun({ run, job, prompt: cronRunPrompt(job, run) }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.cronStore.finishRun(run.runId, "failed", { error: message }, this.now());
        this.logger.error?.(`cron run ${run.runId} failed to dispatch: ${message}`);
      })
      .finally(() => this.#launches.delete(operation));
    this.#launches.add(operation);
  }

  #creationParams(originSessionId, params, createdAt, { allowPastAt = false } = {}) {
    const origin = this.sessionStore.getSession(originSessionId);
    if (!origin || origin.lifecycle === "deleted" || origin.kind !== "root" || origin.depth !== 0) {
      throw new Error("cron jobs may only be created from a live root session");
    }
    const normalized = normalizeCronSchedule(params.schedule, { now: createdAt, defaultTimezone: params.timezone ?? this.defaultTimezone, allowPastAt });
    return {
      name: params.name, prompt: params.prompt, schedule: normalized.schedule,
      scheduleDisplay: normalized.display, timezone: normalized.schedule.timezone,
      executionMode: params.executionMode ?? "fresh", originSessionId,
      cwd: origin.cwd, repositoryRoot: origin.repositoryRoot,
      launch: cronLaunchFromRequest(params),
      repeat: requireRepeat(params.repeat, normalized.recurring), nextRunAt: normalized.nextRunAt,
    };
  }

  #reuseCreation(existing, originSessionId, params) {
    // An existing fixed-ID intent can contain an at-time that was already due when staged.
    const requested = this.#creationParams(originSessionId, params, existing.createdAt, { allowPastAt: true });
    for (const key of ["name", "prompt", "schedule", "timezone", "executionMode", "originSessionId", "cwd", "repositoryRoot", "launch", "repeat"]) {
      if (!isDeepStrictEqual(requested[key], existing[key])) throw new Error(`cron jobId already exists with different intent: ${key}`);
    }
    return existing;
  }

  inspectCreation(originSessionId, params, { jobId } = {}) {
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new TypeError("jobId is invalid");
    const snapshot = this.cronStore.inspectJob(jobId);
    if (snapshot.job) this.#reuseCreation(snapshot.job, originSessionId, params);
    return snapshot;
  }

  create(originSessionId, params, now = this.now(), { jobId, initiallyPaused = false } = {}) {
    if (jobId !== undefined && (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId))) {
      throw new TypeError("jobId must contain 1 through 128 ASCII letters, digits, underscores, or hyphens");
    }
    if (typeof initiallyPaused !== "boolean") throw new TypeError("initiallyPaused must be a boolean");
    const existing = jobId === undefined ? undefined : this.cronStore.getJob(jobId);
    if (existing) return this.#reuseCreation(existing, originSessionId, params);
    const input = { jobId: jobId ?? shortId(),
      ...this.#creationParams(originSessionId, params, now, { allowPastAt: initiallyPaused && params.schedule?.kind === "at" }), initiallyPaused };
    try { return this.cronStore.createJob(input, now); }
    catch (error) {
      // A separate writer can win the unique-ID insert after the first lookup.
      const concurrent = jobId === undefined ? undefined : this.cronStore.getJob(jobId);
      if (concurrent) return this.#reuseCreation(concurrent, originSessionId, params);
      throw error;
    }
  }

  list(params = {}) { return { jobs: this.cronStore.listJobs({ includeRemoved: params.includeRemoved === true }) }; }

  update(selector, patch, now = this.now()) {
    const current = this.cronStore.resolveJob(selector);
    const scheduleChanged = patch.schedule !== undefined;
    const repeatChanged = patch.repeat !== undefined;
    const normalized = scheduleChanged
      ? normalizeCronSchedule(patch.schedule, { now, defaultTimezone: patch.timezone ?? current.timezone })
      : { schedule: current.schedule, display: current.scheduleDisplay, nextRunAt: current.nextRunAt,
        recurring: current.schedule.kind !== "at" };
    const repeat = requireRepeat(repeatChanged ? patch.repeat : current.repeat, normalized.recurring);
    const reset = scheduleChanged || repeatChanged;
    const paused = current.state === "paused";
    const completed = current.state === "completed" && !reset;
    return this.cronStore.replaceJob(current.jobId, {
      name: patch.name ?? current.name, prompt: patch.prompt ?? current.prompt,
      schedule: normalized.schedule, scheduleDisplay: normalized.display, timezone: normalized.schedule.timezone,
      executionMode: patch.executionMode ?? current.executionMode, repeat,
      launch: mergeCronLaunch(current.launch, patch),
      fireCount: reset ? 0 : current.fireCount, enabled: paused || completed ? false : true,
      state: paused ? "paused" : completed ? "completed" : "scheduled",
      nextRunAt: reset ? normalized.nextRunAt : current.nextRunAt,
    }, now);
  }

  pause(selector, now = this.now()) { return this.cronStore.pauseJob(this.cronStore.resolveJob(selector).jobId, now); }

  resume(selector, now = this.now(), { expectedJob } = {}) {
    const job = this.cronStore.resolveJob(selector);
    if (job.state !== "paused") throw new Error("cron job is not paused");
    let nextRunAt;
    if (job.schedule.kind === "at") nextRunAt = Math.max(now, Date.parse(job.schedule.at));
    else if (job.schedule.kind === "every") nextRunAt = now + job.schedule.intervalSeconds * 1000;
    else nextRunAt = normalizeCronSchedule(job.schedule, { now, defaultTimezone: job.timezone }).nextRunAt;
    return this.cronStore.resumeJob(job.jobId, nextRunAt, now, { expectedJob });
  }

  remove(selector, now = this.now()) { return this.cronStore.removeJob(this.cronStore.resolveJob(selector).jobId, now); }

  runNow(selector, now = this.now()) {
    if (this.cronStore.countActiveRuns() >= this.maxParallel) throw new Error("cron parallel-run limit is reached");
    const job = this.cronStore.resolveJob(selector);
    const run = this.cronStore.claimManualRun(job.jobId, { runId: manualRunId(job.jobId, now), scheduledAt: now }, now);
    this.#launch(run, job);
    return run;
  }

  history(selector, limit = 20) {
    const job = this.cronStore.resolveJob(selector, { includeRemoved: true });
    return { job, runs: this.cronStore.listRuns(job.jobId, limit) };
  }
}
