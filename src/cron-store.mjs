import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { normalizeCronLaunch } from "./cron-launch.mjs";

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "unknown", "skipped_overlap"]);

function parseJson(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapJob(row) {
  if (!row) return undefined;
  return {
    jobId: row.id, name: row.name, prompt: row.prompt, schedule: parseJson(row.schedule_json),
    scheduleDisplay: row.schedule_display, timezone: row.timezone, executionMode: row.execution_mode,
    notificationIntent: row.notification_intent ?? null,
    originSessionId: row.origin_session_id, cwd: row.cwd, repositoryRoot: row.repository_root,
    launch: normalizeCronLaunch(parseJson(row.launch_json, {})), repeat: row.repeat_times == null ? null : Number(row.repeat_times),
    fireCount: Number(row.fire_count), enabled: Boolean(row.enabled), state: row.state,
    nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at), lastStatus: row.last_status,
    lastError: row.last_error, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function mapRun(row) {
  if (!row) return undefined;
  return {
    runId: row.id, jobId: row.job_id, source: row.source, scheduledAt: Number(row.scheduled_at), status: row.status,
    executionModeRequested: row.execution_mode_requested, executionModeUsed: row.execution_mode_used,
    sessionId: row.session_id, fallbackReason: row.fallback_reason, inputId: row.input_id,
    notificationIntent: row.notification_intent ?? null, notificationDisposition: row.notification_disposition ?? null,
    notificationBody: row.notification_body ?? null, notificationEvaluatedAt: row.notification_evaluated_at ?? null,
    output: row.output, error: row.error, claimedAt: Number(row.claimed_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
  };
}

const CRON_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cron_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO cron_meta(key, value) VALUES ('schema_version', '1');
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    schedule_display TEXT NOT NULL,
    timezone TEXT NOT NULL,
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('fresh', 'origin')),
    origin_session_id TEXT REFERENCES sessions(id),
    cwd TEXT NOT NULL,
    repository_root TEXT,
    launch_json TEXT NOT NULL,
    repeat_times INTEGER CHECK (repeat_times IS NULL OR repeat_times > 0),
    fire_count INTEGER NOT NULL DEFAULT 0 CHECK (fire_count >= 0),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('scheduled', 'paused', 'completed', 'removed')),
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS cron_job_live_name ON cron_jobs(lower(name)) WHERE state <> 'removed';
  CREATE INDEX IF NOT EXISTS cron_jobs_due ON cron_jobs(enabled, next_run_at, created_at, id);
  CREATE TABLE IF NOT EXISTS cron_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES cron_jobs(id),
    source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'completed', 'failed', 'unknown', 'skipped_overlap')),
    execution_mode_requested TEXT NOT NULL CHECK (execution_mode_requested IN ('fresh', 'origin')),
    execution_mode_used TEXT CHECK (execution_mode_used IS NULL OR execution_mode_used IN ('fresh', 'origin')),
    session_id TEXT REFERENCES sessions(id),
    fallback_reason TEXT,
    input_id TEXT,
    output TEXT,
    error TEXT,
    claimed_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS cron_scheduled_occurrence ON cron_runs(job_id, scheduled_at) WHERE source = 'scheduled';
  CREATE UNIQUE INDEX IF NOT EXISTS cron_one_active_run ON cron_runs(job_id) WHERE status IN ('claimed', 'running');
  CREATE INDEX IF NOT EXISTS cron_runs_job_history ON cron_runs(job_id, claimed_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS cron_runs_active_session ON cron_runs(session_id, claimed_at, id) WHERE status IN ('claimed', 'running');
`;

export class CronStore {
  #db;

  constructor(databasePath) {
    this.#db = new DatabaseSync(databasePath);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (databasePath !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`BEGIN IMMEDIATE; ${CRON_SCHEMA} COMMIT;`);
    const version = this.#db.prepare("SELECT value FROM cron_meta WHERE key = 'schema_version'").get()?.value;
    if (version !== "1") throw new Error(`unsupported cron schema version: ${String(version)}`);
    const notificationVersion = this.#db.prepare("SELECT value FROM cron_meta WHERE key='notification_schema_version'").get()?.value;
    if (notificationVersion !== undefined && notificationVersion !== "1") throw new Error("unsupported cron notification schema version");
    // Additive, independently versioned fields. Core user_version and execution
    // schema guards stay unchanged; baseline writers can preserve these fields.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, columns] of Object.entries({ cron_jobs: { notification_intent: "TEXT CHECK(notification_intent IN ('result','conditional','silent'))" },
        cron_runs: { notification_intent: "TEXT CHECK(notification_intent IN ('result','conditional','silent'))",
          notification_disposition: "TEXT CHECK(notification_disposition IN ('deliver','no_finding'))", notification_body: "TEXT",
          notification_evaluated_at: "INTEGER", notification_recorded: "INTEGER NOT NULL DEFAULT 0" } })) {
        const present = new Set(this.#db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
        for (const [name, type] of Object.entries(columns)) if (!present.has(name)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      }
      this.#db.exec("INSERT OR IGNORE INTO cron_meta VALUES ('notification_schema_version','1'); COMMIT;");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  createJob(params, now = Date.now()) {
    const initiallyPaused = params.initiallyPaused === undefined ? false : params.initiallyPaused;
    if (typeof initiallyPaused !== "boolean") throw new TypeError("initiallyPaused must be a boolean");
    this.#db.prepare(`INSERT INTO cron_jobs(id, name, prompt, schedule_json, schedule_display, timezone,
      execution_mode, origin_session_id, cwd, repository_root, launch_json, repeat_times, fire_count,
      enabled, state, next_run_at, created_at, updated_at, notification_intent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(params.jobId, params.name, params.prompt, JSON.stringify(params.schedule), params.scheduleDisplay,
        params.timezone, params.executionMode, params.originSessionId, params.cwd, params.repositoryRoot,
        JSON.stringify(normalizeCronLaunch(params.launch ?? {})), params.repeat,
        initiallyPaused ? 0 : 1, initiallyPaused ? "paused" : "scheduled", params.nextRunAt, now, now, params.notificationIntent ?? null);
    return this.getJob(params.jobId);
  }

  getJob(jobId) { return mapJob(this.#db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId)); }

  inspectJob(jobId) {
    const row = this.#db.prepare(`SELECT job.*, (SELECT status FROM cron_runs WHERE job_id = job.id
      ORDER BY claimed_at DESC, id DESC LIMIT 1) AS run_status FROM cron_jobs job WHERE job.id = ?`).get(jobId);
    return { job: mapJob(row), runStatus: row?.run_status ?? null };
  }

  resolveJob(selector, { includeRemoved = false } = {}) {
    const exact = this.#db.prepare(`SELECT * FROM cron_jobs WHERE id = ? AND (? OR state <> 'removed')`).get(selector, includeRemoved ? 1 : 0);
    if (exact) return mapJob(exact);
    const matches = this.#db.prepare(`SELECT * FROM cron_jobs WHERE lower(name) = lower(?) AND (? OR state <> 'removed') ORDER BY created_at, id`)
      .all(selector, includeRemoved ? 1 : 0);
    if (matches.length === 0) throw new Error(`cron job not found: ${selector}`);
    if (matches.length > 1) throw new Error(`cron job selector is ambiguous: ${selector}`);
    return mapJob(matches[0]);
  }

  listJobs({ includeRemoved = false } = {}) {
    return this.#db.prepare(`SELECT * FROM cron_jobs WHERE (? OR state <> 'removed') ORDER BY created_at, id`)
      .all(includeRemoved ? 1 : 0).map(mapJob);
  }

  replaceJob(jobId, params, now = Date.now()) {
    const result = this.#db.prepare(`UPDATE cron_jobs SET name = ?, prompt = ?, schedule_json = ?,
      schedule_display = ?, timezone = ?, execution_mode = ?, launch_json = ?, repeat_times = ?, fire_count = ?,
      enabled = ?, state = ?, next_run_at = ?, last_error = NULL, updated_at = ?, notification_intent = ?
      WHERE id = ? AND state <> 'removed'`).run(params.name, params.prompt, JSON.stringify(params.schedule),
        params.scheduleDisplay, params.timezone, params.executionMode,
        JSON.stringify(normalizeCronLaunch(params.launch ?? {})), params.repeat, params.fireCount,
        params.enabled ? 1 : 0, params.state, params.nextRunAt, now, params.notificationIntent ?? null, jobId);
    if (result.changes !== 1) throw new Error("cron job does not exist");
    return this.getJob(jobId);
  }

  pauseJob(jobId, now = Date.now()) {
    const result = this.#db.prepare(`UPDATE cron_jobs SET enabled = 0, state = 'paused', updated_at = ?
      WHERE id = ? AND state = 'scheduled'`).run(now, jobId);
    if (result.changes !== 1) throw new Error("cron job is not scheduled");
    return this.getJob(jobId);
  }

  resumeJob(jobId, nextRunAt, now = Date.now(), { expectedJob } = {}) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (expectedJob && !isDeepStrictEqual(this.getJob(jobId), expectedJob)) {
        throw new Error("cron job changed before resume");
      }
      const result = this.#db.prepare(`UPDATE cron_jobs SET enabled = 1, state = 'scheduled', next_run_at = ?,
        last_error = NULL, updated_at = ? WHERE id = ? AND state = 'paused'`).run(nextRunAt, now, jobId);
      if (result.changes !== 1) throw new Error("cron job is not paused");
      const job = this.getJob(jobId);
      this.#db.exec("COMMIT");
      return job;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  removeJob(jobId, now = Date.now()) {
    const result = this.#db.prepare(`UPDATE cron_jobs SET enabled = 0, state = 'removed', next_run_at = NULL,
      updated_at = ? WHERE id = ? AND state <> 'removed'`).run(now, jobId);
    if (result.changes !== 1) throw new Error("cron job does not exist");
    return this.getJob(jobId);
  }

  listDueJobs(now = Date.now(), limit = 32) {
    return this.#db.prepare(`SELECT * FROM cron_jobs WHERE enabled = 1 AND state = 'scheduled'
      AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, created_at, id LIMIT ?`)
      .all(now, limit).map(mapJob);
  }

  countActiveRuns() {
    return Number(this.#db.prepare("SELECT count(*) AS count FROM cron_runs WHERE status IN ('claimed', 'running')").get().count);
  }

  claimScheduledRun(jobId, { runId, scheduledAt, nextRunAt }, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId);
      if (!row || row.enabled !== 1 || row.state !== "scheduled" || Number(row.next_run_at) !== scheduledAt) {
        this.#db.exec("COMMIT"); return { claimed: false, reason: "not_due" };
      }
      const active = this.#db.prepare("SELECT id FROM cron_runs WHERE job_id = ? AND status IN ('claimed', 'running') LIMIT 1").get(jobId);
      const status = active ? "skipped_overlap" : "claimed";
      const fireCount = Number(row.fire_count) + 1;
      const exhausted = row.repeat_times != null && fireCount >= Number(row.repeat_times);
      const finalNext = exhausted ? null : nextRunAt;
      const state = exhausted || finalNext == null ? "completed" : "scheduled";
      const enabled = state === "scheduled" ? 1 : 0;
      this.#db.prepare(`INSERT INTO cron_runs(id, job_id, source, scheduled_at, status,
        execution_mode_requested, claimed_at, completed_at, error, notification_intent)
        VALUES (?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, jobId, scheduledAt, status, row.execution_mode, now,
          active ? now : null, active ? `overlap with active run ${active.id}` : null, row.notification_intent);
      this.#db.prepare(`UPDATE cron_jobs SET fire_count = ?, enabled = ?, state = ?, next_run_at = ?,
        last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(fireCount, enabled, state, finalNext, scheduledAt, status,
          active ? `overlap with active run ${active.id}` : null, now, jobId);
      const run = mapRun(this.#db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(runId));
      this.#db.exec("COMMIT");
      return { claimed: !active, skipped: Boolean(active), run, job: mapJob(this.#db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId)) };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  claimManualRun(jobId, { runId = randomUUID(), scheduledAt = Date.now() } = {}, now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.#db.prepare("SELECT * FROM cron_jobs WHERE id = ? AND state <> 'removed'").get(jobId);
      if (!job) throw new Error("cron job does not exist");
      const active = this.#db.prepare("SELECT id FROM cron_runs WHERE job_id = ? AND status IN ('claimed', 'running') LIMIT 1").get(jobId);
      if (active) throw new Error(`cron job is already running: ${active.id}`);
      this.#db.prepare(`INSERT INTO cron_runs(id, job_id, source, scheduled_at, status,
        execution_mode_requested, claimed_at, notification_intent) VALUES (?, ?, 'manual', ?, 'claimed', ?, ?, ?)`)
        .run(runId, jobId, scheduledAt, job.execution_mode, now, job.notification_intent);
      this.#db.prepare("UPDATE cron_jobs SET last_run_at = ?, last_status = 'claimed', last_error = NULL, updated_at = ? WHERE id = ?")
        .run(scheduledAt, now, jobId);
      const run = mapRun(this.#db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(runId));
      this.#db.exec("COMMIT");
      return run;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  markRunRunning(runId, { executionModeUsed, sessionId, fallbackReason = null, inputId }, now = Date.now()) {
    const result = this.#db.prepare(`UPDATE cron_runs SET status = 'running', execution_mode_used = ?, session_id = ?,
      fallback_reason = ?, input_id = ?, started_at = ? WHERE id = ? AND status = 'claimed'`)
      .run(executionModeUsed, sessionId, fallbackReason, inputId, now, runId);
    if (result.changes !== 1) throw new Error("cron run is not claimed");
    this.#db.prepare("UPDATE cron_jobs SET last_status = 'running', last_error = NULL, updated_at = ? WHERE id = (SELECT job_id FROM cron_runs WHERE id = ?)")
      .run(now, runId);
    return this.getRun(runId);
  }

  finishRun(runId, status, { output = null, error = null } = {}, now = Date.now()) {
    if (!TERMINAL_RUN_STATES.has(status) || status === "skipped_overlap") throw new Error("unsupported cron run terminal state");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#db.prepare(`UPDATE cron_runs SET status = ?, output = ?, error = ?, completed_at = ?
        WHERE id = ? AND status IN ('claimed', 'running')`).run(status, output, error, now, runId);
      if (result.changes !== 1) { this.#db.exec("COMMIT"); return this.getRun(runId); }
      this.#db.prepare(`UPDATE cron_jobs SET last_status = ?, last_error = ?, updated_at = ?
        WHERE id = (SELECT job_id FROM cron_runs WHERE id = ?)`).run(status, error, now, runId);
      const run = mapRun(this.#db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(runId));
      this.#db.exec("COMMIT"); return run;
    } catch (error_) { this.#db.exec("ROLLBACK"); throw error_; }
  }

  reconcileInterruptedRuns(now = Date.now()) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const runs = this.#db.prepare("SELECT * FROM cron_runs WHERE status IN ('claimed', 'running')").all();
      this.#db.prepare(`UPDATE cron_runs SET status = 'unknown', error = 'supervisor restarted during execution; outcome is unknown',
        completed_at = ? WHERE status IN ('claimed', 'running')`).run(now);
      this.#db.prepare(`UPDATE cron_jobs SET last_status = 'unknown',
        last_error = 'supervisor restarted during execution; outcome is unknown', updated_at = ?
        WHERE id IN (SELECT job_id FROM cron_runs WHERE status = 'unknown' AND completed_at = ?)` ).run(now, now);
      this.#db.exec("COMMIT"); return runs.map(mapRun);
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  getRun(runId) { return mapRun(this.#db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(runId)); }
  listRuns(jobId, limit = 50) {
    return this.#db.prepare("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY claimed_at DESC, id DESC LIMIT ?")
      .all(jobId, limit).map(mapRun);
  }
  listActiveRunsForSession(sessionId) {
    return this.#db.prepare("SELECT * FROM cron_runs WHERE session_id = ? AND status IN ('claimed', 'running') ORDER BY claimed_at, id")
      .all(sessionId).map(mapRun);
  }
  hasActiveRunForSession(sessionId) { return this.listActiveRunsForSession(sessionId).length > 0; }
  activeRunSessionIds() { return this.#db.prepare("SELECT DISTINCT session_id FROM cron_runs WHERE status IN ('claimed','running') AND session_id IS NOT NULL").all().map(row => row.session_id); }

  reportNotification(runId, sessionId, { disposition, body = null }, now = Date.now()) {
    if (!["deliver", "no_finding"].includes(disposition) || disposition === "deliver" && (typeof body !== "string" || !body.trim() || body.length > 1000)
      || disposition === "no_finding" && body !== null) throw new Error("invalid cron delivery disposition");
    const run = this.getRun(runId);
    if (!run || run.sessionId !== sessionId || !["result", "conditional"].includes(run.notificationIntent)) throw new Error("run does not accept a disposition from this actor");
    if (disposition === "no_finding" && run.notificationIntent !== "conditional") throw new Error("result runs require a deliver disposition");
    if (run.notificationDisposition !== null) {
      if (run.notificationDisposition !== disposition || run.notificationBody !== body) throw new Error("cron run already has a different disposition");
      return run;
    }
    if (run.status !== "running") throw new Error("cron run is no longer evaluating");
    this.#db.prepare("UPDATE cron_runs SET notification_disposition=?,notification_body=?,notification_evaluated_at=? WHERE id=? AND notification_disposition IS NULL")
      .run(disposition, body, now, runId);
    return this.getRun(runId);
  }
  pendingNotifications(limit = 100) {
    return this.#db.prepare(`SELECT * FROM cron_runs WHERE notification_intent IS NOT NULL AND notification_recorded=0
      AND status NOT IN ('claimed','running') ORDER BY completed_at,id LIMIT ?`).all(limit).map(mapRun);
  }
  notificationRecorded(runId) { this.#db.prepare("UPDATE cron_runs SET notification_recorded=1 WHERE id=?").run(runId); }
  pruneRuns(keepPerJob = 50) {
    return this.#db.prepare(`DELETE FROM cron_runs WHERE (notification_intent IS NULL OR notification_recorded=1) AND status IN ('completed', 'failed', 'unknown', 'skipped_overlap')
      AND id IN (SELECT id FROM cron_runs older WHERE older.job_id = cron_runs.job_id ORDER BY claimed_at DESC, id DESC LIMIT -1 OFFSET ?)`)
      .run(keepPerJob).changes;
  }

  getOperationalCounts() {
    const jobs = Object.fromEntries(this.#db.prepare("SELECT state, count(*) AS count FROM cron_jobs GROUP BY state").all()
      .map((row) => [row.state, Number(row.count)]));
    const runs = Object.fromEntries(this.#db.prepare("SELECT status, count(*) AS count FROM cron_runs GROUP BY status").all()
      .map((row) => [row.status, Number(row.count)]));
    return { jobs, runs };
  }

  close() { this.#db.close(); }
}
