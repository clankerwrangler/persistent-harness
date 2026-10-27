import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CRON_CHECK_FAILURE_ALERT_THRESHOLD, MIN_CHECKED_INTERVAL_SECONDS, normalizeCronCheck, runCronCheck } from "./cron-check.mjs";
import { cronLaunchFromRequest, mergeCronLaunch } from "./cron-launch.mjs";
import { DEFAULT_CRON_TIMEZONE, MIN_CRON_INTERVAL_SECONDS, nextCronRunAfter, normalizeCronSchedule } from "./cron-schedule.mjs";

const MAX_CONCURRENT_CHECKS = 4;

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

function checkSection(run) {
  if (run.check?.kind === "output") return ["## Check output", run.check.text];
  if (run.check?.kind === "failure") {
    return ["## Check failure", `${run.check.text}\n\nThe task did not run. Tell Commander that this job's check needs fixing.`];
  }
  return [];
}

export function cronRunPrompt(job, run) {
  return [
    `Scheduled job ${job.name} (${job.jobId}) is firing.`,
    `Scheduled occurrence: ${new Date(run.scheduledAt).toISOString()}.`,
    "Complete the task below. Do not create, update, or remove scheduled jobs during this run.",
    "## Scheduled task",
    job.prompt,
    ...checkSection(run),
  ].join("\n\n");
}

// Origin runs land in an existing conversation, so they carry only the task and what its check found.
export function cronOriginPrompt(job, run) {
  return [job.prompt, ...checkSection(run)].join("\n\n");
}

export class CronScheduler {
  #timer;
  #ticking = false;
  #stopped = true;
  #launches = new Set();
  #checks = new Set();

  constructor({ cronStore, sessionStore, dispatchRun, tickIntervalMs = 60_000, maxParallel = 2,
    defaultTimezone = DEFAULT_CRON_TIMEZONE, now = () => Date.now(), logger = console, runCheck = runCronCheck }) {
    if (!cronStore || !sessionStore || typeof dispatchRun !== "function") throw new Error("cron scheduler dependencies are required");
    if (!Number.isInteger(tickIntervalMs) || tickIntervalMs < 100 || tickIntervalMs > 60 * 60 * 1000) throw new Error("tickIntervalMs is invalid");
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 32) throw new Error("maxParallel is invalid");
    Object.assign(this, { cronStore, sessionStore, dispatchRun, tickIntervalMs, maxParallel,
      defaultTimezone, now, logger, runCheck });
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
      // A check result is already consumed by its script, so it goes out before anything new starts.
      for (const job of this.cronStore.listPendingCheckJobs(64)) {
        if (capacity <= 0) break;
        const result = this.cronStore.claimCheckedRun(job.jobId, { runId: scheduledRunId(job.jobId, job.pendingCheck.at) }, now);
        if (!result.claimed) continue;
        claimed += 1; capacity -= 1; this.#launch(result.run, result.job);
      }
      for (const job of this.cronStore.listDueJobs(now, 64)) {
        if (job.check) { this.#startCheck(job, now); continue; }
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

  #startCheck(job, now) {
    if (this.#checks.has(job.jobId) || job.pendingCheck || this.#checks.size >= MAX_CONCURRENT_CHECKS) return;
    const scheduledAt = job.nextRunAt;
    if (!this.cronStore.deferCheckedOccurrence(job.jobId, scheduledAt, nextCronRunAfter(job.schedule, scheduledAt, now), now)) return;
    // Skipping loses nothing: the check keeps its own place, so the next one picks up whatever arrived meanwhile.
    if (this.cronStore.hasActiveRun(job.jobId)) return;
    this.#checks.add(job.jobId);
    const operation = Promise.resolve().then(() => this.runCheck(job.check, { cwd: job.cwd }))
      .then((result) => this.#checkFinished(job, scheduledAt, result))
      .catch((error) => this.logger.error?.(`cron check for ${job.jobId} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.#checks.delete(job.jobId); this.#launches.delete(operation); });
    this.#launches.add(operation);
  }

  #checkFinished(job, scheduledAt, result) {
    const now = this.now();
    let pending;
    if (result.ok) {
      this.cronStore.recordCheckSuccess(job.jobId, now);
      if (result.output) pending = { kind: "output", text: result.output, at: scheduledAt };
    } else {
      const { failures, alert } = this.cronStore.recordCheckFailure(job.jobId, result.error, CRON_CHECK_FAILURE_ALERT_THRESHOLD, now);
      if (alert) pending = { kind: "failure", text: `The check command failed ${failures} times in a row. Last error: ${result.error}`, at: scheduledAt };
    }
    if (pending && this.cronStore.setPendingCheck(job.jobId, pending, now) && !this.#stopped) setImmediate(() => void this.tick());
  }

  #creationParams(originSessionId, params, createdAt, { allowPastAt = false } = {}) {
    const origin = this.sessionStore.getSession(originSessionId);
    if (!origin || origin.lifecycle === "deleted" || origin.kind !== "root" || origin.depth !== 0) {
      throw new Error("cron jobs may only be created from a live root session");
    }
    const check = normalizeCronCheck(params.check);
    const normalized = normalizeCronSchedule(params.schedule, { now: createdAt, defaultTimezone: params.timezone ?? this.defaultTimezone, allowPastAt,
      minIntervalSeconds: check ? MIN_CHECKED_INTERVAL_SECONDS : MIN_CRON_INTERVAL_SECONDS });
    if (check && !normalized.recurring) throw new TypeError("a check needs a recurring schedule");
    return {
      check, name: params.name, prompt: params.prompt, schedule: normalized.schedule,
      scheduleDisplay: normalized.display, timezone: normalized.schedule.timezone,
      executionMode: params.executionMode ?? "fresh", notificationIntent: params.notificationIntent ?? null, originSessionId,
      cwd: origin.cwd, repositoryRoot: origin.repositoryRoot,
      launch: cronLaunchFromRequest(params),
      repeat: requireRepeat(params.repeat, normalized.recurring), nextRunAt: normalized.nextRunAt,
    };
  }

  #reuseCreation(existing, originSessionId, params) {
    // An existing fixed-ID intent can contain an at-time that was already due when staged.
    const requested = this.#creationParams(originSessionId, params, existing.createdAt, { allowPastAt: true });
    for (const key of ["name", "prompt", "schedule", "timezone", "executionMode", "notificationIntent", "originSessionId", "cwd", "repositoryRoot", "launch", "repeat", "check"]) {
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
    const check = patch.check === undefined ? current.check : normalizeCronCheck(patch.check);
    const minIntervalSeconds = check ? MIN_CHECKED_INTERVAL_SECONDS : MIN_CRON_INTERVAL_SECONDS;
    const normalized = scheduleChanged
      ? normalizeCronSchedule(patch.schedule, { now, defaultTimezone: patch.timezone ?? current.timezone, minIntervalSeconds })
      : { schedule: current.schedule, display: current.scheduleDisplay, nextRunAt: current.nextRunAt,
        recurring: current.schedule.kind !== "at" };
    if (check && !normalized.recurring) throw new TypeError("a check needs a recurring schedule");
    if (!check && normalized.schedule.kind === "every" && normalized.schedule.intervalSeconds < MIN_CRON_INTERVAL_SECONDS) {
      throw new TypeError(`a job without a check needs an interval of at least ${MIN_CRON_INTERVAL_SECONDS} seconds`);
    }
    const repeat = requireRepeat(repeatChanged ? patch.repeat : current.repeat, normalized.recurring);
    const reset = scheduleChanged || repeatChanged;
    const paused = current.state === "paused";
    const completed = current.state === "completed" && !reset;
    return this.cronStore.replaceJob(current.jobId, {
      name: patch.name ?? current.name, prompt: patch.prompt ?? current.prompt,
      schedule: normalized.schedule, scheduleDisplay: normalized.display, timezone: normalized.schedule.timezone,
      executionMode: patch.executionMode ?? current.executionMode, notificationIntent: patch.notificationIntent ?? current.notificationIntent, repeat,
      launch: mergeCronLaunch(current.launch, patch), check,
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
