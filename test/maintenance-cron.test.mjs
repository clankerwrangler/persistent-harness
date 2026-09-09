import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";
import { CronStore } from "../src/cron-store.mjs";
import { CronScheduler } from "../src/cron-scheduler.mjs";
import { maintenanceCron } from "../src/maintenance-cron.mjs";

const now = Date.parse("2026-01-01T00:00:00.000Z");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-cron-")); t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "harness.sqlite"); const store = new HarnessStore(databasePath);
  store.createRoot({ sessionId: "parent", sessionFile: path.join(root, "parent.jsonl"), cwd: root,
    repositoryRoot: null, name: "Parent", actorToken: "fixture-only", launch: {} }, now);
  store.close();
  const intent = { version: 1, jobId: "fixed-maintenance-job", originSessionId: "parent",
    request: { name: "Finite continuation", prompt: "PRIVATE_SYNTHETIC_PARENT_INTENT", executionMode: "origin", repeat: 1,
      schedule: { kind: "at", at: new Date(now + 1000).toISOString() } } };
  return { databasePath, intent };
}

test("canonical maintenance creates one finite root-owned job and inspects unknown ACK without resetting it", async (t) => {
  const args = await fixture(t); let timers = 0; const interval = globalThis.setInterval;
  globalThis.setInterval = (...values) => { timers += 1; return interval(...values); };
  try {
    const first = maintenanceCron({ ...args, operation: "admit", now });
    assert.equal(first.found, true); assert.equal(first.reused, false); assert.equal(first.repeat, 1);
    assert.equal(first.state, "paused"); assert.equal(first.enabled, false); assert.equal(first.disposition, "paused"); assert.equal(first.armed, false);
    const inspected = maintenanceCron({ ...args, operation: "inspect", now: now + 10000 });
    assert.equal(inspected.jobId, first.jobId); assert.equal(inspected.createdAt, first.createdAt); assert.equal(inspected.reused, true);
    assert.equal(inspected.intentSha256, first.intentSha256); assert.equal(timers, 0);
    const cron = new CronStore(args.databasePath); assert.equal(cron.listJobs().length, 1); cron.close();
    assert.doesNotMatch(JSON.stringify([first, inspected]), /PRIVATE_SYNTHETIC_PARENT_INTENT|fixture-only/);
  } finally { globalThis.setInterval = interval; }
});

test("inspection never creates a missing job and changed intent cannot reuse the same admission", async (t) => {
  const args = await fixture(t);
  assert.equal(maintenanceCron({ ...args, operation: "inspect", now }).found, false);
  maintenanceCron({ ...args, operation: "admit", now });
  const intent = { ...args.intent, request: { ...args.intent.request, prompt: "Changed intent" } };
  assert.throws(() => maintenanceCron({ ...args, intent, operation: "admit", now: now + 2000 }), /maintenance admission failed/);
  const cron = new CronStore(args.databasePath); assert.equal(cron.listJobs().length, 1); cron.close();
});

test("constructor effects are an earlier mutation boundary than job insertion", async (t) => {
  const args = await fixture(t);
  let db = new DatabaseSync(args.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_jobs'").get(), undefined); db.close();
  assert.throws(() => maintenanceCron({ ...args, operation: "admit", now,
    intent: { ...args.intent, originSessionId: "missing-root" } }), (error) => error.phase === "admission" && error.mutationPossible === true);
  db = new DatabaseSync(args.databasePath, { readOnly: true });
  assert(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cron_jobs'").get());
  assert.equal(db.prepare("SELECT count(*) AS count FROM cron_jobs").get().count, 0); db.close();
});

test("invalid non-finite or non-origin intent fails before opening the stores", async (t) => {
  const args = await fixture(t);
  assert.throws(() => maintenanceCron({ ...args, operation: "admit", now,
    intent: { ...args.intent, request: { ...args.intent.request, executionMode: "fresh" } } }),
    (error) => error.phase === "validation" && error.mutationPossible === false);
});

test("close failures never claim that an admitted operation was mutation-free", async (t) => {
  const args = await fixture(t); const close = CronStore.prototype.close;
  CronStore.prototype.close = function () { close.call(this); throw new Error("fixture close failure"); };
  try {
    assert.throws(() => maintenanceCron({ ...args, operation: "admit", now }),
      (error) => error.phase === "admission" && error.mutationPossible === true);
  } finally { CronStore.prototype.close = close; }
  const cron = new CronStore(args.databasePath); assert(cron.getJob(args.intent.jobId)); cron.close();
});

test("one-shot entry point admits and inspects the same intent, then exits without a service", async (t) => {
  const args = await fixture(t);
  args.intent.request.schedule.at = new Date(Date.now() + 60000).toISOString();
  const intentFile = path.join(path.dirname(args.databasePath), "intent.json");
  await writeFile(intentFile, JSON.stringify(args.intent));
  const run = async (operation) => {
    const result = await promisify(execFile)(process.execPath, [path.resolve("bin/maintenance-cron.mjs"),
      "--database", args.databasePath, "--intent", intentFile, "--operation", operation],
      { env: { PATH: process.env.PATH, HOME: path.dirname(args.databasePath) }, timeout: 5000, maxBuffer: 16384 });
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.ok, true); return receipt;
  };
  const first = await run("admit"); const second = await run("inspect"); const repeated = await run("admit");
  assert.equal(second.jobId, first.jobId); assert.equal(repeated.createdAt, first.createdAt);
  assert.equal(second.intentSha256, first.intentSha256); assert.equal(repeated.reused, true);
  const db = new DatabaseSync(args.databasePath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM cron_jobs").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM actor_inputs").get().n, 0); db.close();
});


test("ordinary scheduled dispatch cannot claim paused maintenance admission before arming", async (t) => {
  const args = await fixture(t);
  const staged = maintenanceCron({ ...args, operation: "admit", now });
  const cron = new CronStore(args.databasePath); t.after(() => cron.close());
  const saved = cron.getJob(args.intent.jobId);
  assert.equal(staged.disposition, "paused"); assert.equal(staged.mutationPossible, true);
  assert.deepEqual(cron.listDueJobs(now + 1_000_000), []);
  assert.deepEqual(cron.claimScheduledRun(saved.jobId,
    { runId: "forced-paused-claim", scheduledAt: saved.nextRunAt, nextRunAt: null }, now + 1_000_000),
  { claimed: false, reason: "not_due" });
  assert.deepEqual(cron.listRuns(saved.jobId), []);
  const repeated = maintenanceCron({ ...args, operation: "admit", now: now + 1_000_000 });
  assert.equal(repeated.disposition, "paused"); assert.deepEqual(cron.getJob(saved.jobId), saved);
  const armed = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 1_000_000 });
  assert.equal(armed.armed, true); assert.equal(armed.disposition, "armed"); assert.equal(armed.armingAction, "transitioned");
  assert.equal(armed.nextRunAt, now + 1_000_000, "resume uses max(now, at), not a staging delay");
  const accepted = cron.getJob(saved.jobId);
  const observed = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 2_000_000 });
  assert.equal(observed.nextRunAt, armed.nextRunAt); assert.equal(observed.armingAction, "observed");
  assert.equal(maintenanceCron({ ...args, operation: "admit", now: now + 3_000_000 }).armed, true);
  assert.deepEqual(cron.getJob(saved.jobId), accepted);
});


test("manual Run executes a paused job without consuming its scheduled occurrence and exposes run evidence", async (t) => {
  const args = await fixture(t);
  const staged = maintenanceCron({ ...args, operation: "admit", now });
  const cron = new CronStore(args.databasePath);
  const sessions = new HarnessStore(args.databasePath, { readOnly: true });
  const dispatches = []; const dispatchErrors = []; let afterRunning;
  const scheduler = new CronScheduler({ cronStore: cron, sessionStore: sessions,
    now: () => now + 4_000,
    dispatchRun({ run }) {
      dispatches.push(run.runId);
      cron.markRunRunning(run.runId, { executionModeUsed: "origin", sessionId: args.intent.originSessionId,
        inputId: "synthetic-manual-input" }, now + 3_000);
      afterRunning = maintenanceCron({ ...args, operation: "inspect", now: now + 3_000 });
      cron.finishRun(run.runId, "completed", { output: "PRIVATE_SYNTHETIC_MANUAL_OUTPUT" }, now + 4_000);
    },
    logger: { error(message) { dispatchErrors.push(message); } },
  });
  t.after(async () => { await scheduler.stop(); cron.close(); sessions.close(); });

  // Manual admission is synchronous; its dispatch runs in the next microtask.
  const run = scheduler.runNow(args.intent.jobId, now + 2_000);
  const afterClaim = maintenanceCron({ ...args, operation: "inspect", now: now + 2_000 });
  await scheduler.stop();
  const afterCompletion = maintenanceCron({ ...args, operation: "inspect", now: now + 5_000 });
  assert.equal(run.source, "manual"); assert.equal(run.status, "claimed");
  assert.deepEqual(dispatchErrors, []); assert.deepEqual(dispatches, [run.runId]);
  const completed = cron.getRun(run.runId);
  assert.equal(completed.source, "manual"); assert.equal(completed.status, "completed");
  assert.equal(completed.output, "PRIVATE_SYNTHETIC_MANUAL_OUTPUT");
  assert.equal(cron.listRuns(args.intent.jobId).length, 1);
  assert.equal(staged.runStatus, null); assert.equal(staged.lastStatus, null); assert.equal(staged.armed, false);
  for (const [status, receipt] of [["claimed", afterClaim], ["running", afterRunning], ["completed", afterCompletion]]) {
    assert.equal(receipt.operation, "inspect"); assert.equal(receipt.found, true);
    assert.equal(receipt.jobId, args.intent.jobId); assert.equal(receipt.originSessionId, args.intent.originSessionId);
    assert.equal(receipt.intentSha256, staged.intentSha256);
    assert.equal(receipt.state, "paused"); assert.equal(receipt.enabled, false); assert.equal(receipt.fireCount, 0);
    assert.equal(receipt.repeat, 1); assert.equal(receipt.nextRunAt, staged.nextRunAt); assert.equal(receipt.createdAt, staged.createdAt);
    assert.equal(receipt.lastStatus, status); assert.equal(receipt.runStatus, status); assert.equal(receipt.disposition, status);
    assert.equal(receipt.armed, true); assert.equal(receipt.armingAction, null);
  }
  assert.deepEqual(cron.listDueJobs(now + 1_000_000), []);
  const evidence = { control: "paused-manual-run", source: run.source, dispatchCount: dispatches.length,
    afterClaim, afterRunning, afterCompletion };
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_SYNTHETIC|fixture-only|databasePath|inputId|runId/);
  t.diagnostic(JSON.stringify(evidence));
});

test("ensure-armed requires an existing same-intent row", async (t) => {
  const args = await fixture(t);
  assert.throws(() => maintenanceCron({ ...args, operation: "ensure-armed", now }),
    (error) => error.phase === "arming" && error.mutationPossible === true
      && error.receipt.disposition === "missing" && error.receipt.found === false);
  const cron = new CronStore(args.databasePath); t.after(() => cron.close());
  assert.deepEqual(cron.listJobs(), []);
  maintenanceCron({ ...args, operation: "admit", now }); const saved = cron.getJob(args.intent.jobId);
  const intent = { ...args.intent, request: { ...args.intent.request, prompt: "Different continuation" } };
  for (const operation of ["admit", "inspect", "ensure-armed"]) {
    assert.throws(() => maintenanceCron({ ...args, intent, operation, now: now + 2_000 }), /maintenance admission failed/);
    assert.deepEqual(cron.getJob(saved.jobId), saved);
  }
});

test("unknown admission and arming ACKs reconcile the same canonical row without resetting it", async (t) => {
  const args = await fixture(t); const close = CronStore.prototype.close;
  const loseCloseAck = (operation, at) => {
    CronStore.prototype.close = function () { close.call(this); throw new Error("synthetic lost ACK"); };
    try {
      assert.throws(() => maintenanceCron({ ...args, operation, now: at }),
        (error) => error.mutationPossible === true && error.message === "canonical maintenance close failed");
    } finally { CronStore.prototype.close = close; }
  };
  loseCloseAck("admit", now);
  const staged = maintenanceCron({ ...args, operation: "inspect", now: now + 2_000 });
  assert.equal(staged.disposition, "paused");
  loseCloseAck("ensure-armed", now + 3_000);
  const inspected = maintenanceCron({ ...args, operation: "inspect", now: now + 4_000 });
  const repeated = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 5_000 });
  assert.equal(inspected.disposition, "armed"); assert.equal(repeated.armed, true);
  assert.equal(repeated.createdAt, staged.createdAt); assert.equal(repeated.nextRunAt, now + 3_000);
  const cron = new CronStore(args.databasePath); t.after(() => cron.close());
  assert.equal(cron.listJobs().length, 1); assert.deepEqual(cron.listRuns(args.intent.jobId), []);
});

test("concurrent resume is reconciled without resetting the winning canonical deadline", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
  const writer = new CronStore(args.databasePath); t.after(() => writer.close());
  const resume = CronStore.prototype.resumeJob; let calls = 0;
  CronStore.prototype.resumeJob = function (jobId, nextRunAt, at, options) {
    calls += 1;
    resume.call(writer, jobId, now + 2_000, now + 2_000);
    return resume.call(this, jobId, nextRunAt, at, options);
  };
  let receipt;
  try { receipt = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 3_000 }); }
  finally { CronStore.prototype.resumeJob = resume; }
  assert.equal(calls, 1); assert.equal(receipt.armingAction, "observed"); assert.equal(receipt.armed, true); assert.equal(receipt.nextRunAt, now + 2_000);
  assert.equal(writer.getJob(args.intent.jobId).updatedAt, now + 2_000);
});

test("a changed-intent concurrent writer cannot be armed after inspection", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
  const writer = new CronStore(args.databasePath); t.after(() => writer.close());
  const staged = writer.getJob(args.intent.jobId); const resume = CronStore.prototype.resumeJob;
  CronStore.prototype.resumeJob = function (...values) {
    writer.replaceJob(staged.jobId, { ...staged, prompt: "Concurrent different intent" }, staged.updatedAt);
    return resume.apply(this, values);
  };
  try { assert.throws(() => maintenanceCron({ ...args, operation: "ensure-armed", now: now + 2_000 }), /maintenance admission failed/); }
  finally { CronStore.prototype.resumeJob = resume; }
  const changed = writer.getJob(staged.jobId);
  assert.equal(changed.state, "paused"); assert.equal(changed.enabled, false); assert.equal(changed.prompt, "Concurrent different intent");
  assert.deepEqual(writer.listRuns(staged.jobId), []);
});

test("claimed and completed continuations are inspected without replay; uncertain outcomes remain explicit", async (t) => {
  for (const status of ["claimed", "running", "completed", "failed", "unknown", "removed", "skipped_overlap"]) {
    await t.test(status, async (t) => {
      const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
      const cron = new CronStore(args.databasePath); t.after(() => cron.close());
      if (status === "removed") cron.removeJob(args.intent.jobId, now + 2_000);
      else {
        const armed = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 2_000 });
        if (status === "skipped_overlap") cron.claimManualRun(args.intent.jobId,
          { runId: "active-overlap", scheduledAt: now + 2_500 }, now + 2_500);
        cron.claimScheduledRun(args.intent.jobId,
          { runId: "once", scheduledAt: armed.nextRunAt, nextRunAt: null }, now + 3_000);
        if (status === "running") cron.markRunRunning("once", { executionModeUsed: "origin", sessionId: "parent", inputId: "synthetic-input" }, now + 4_000);
        else if (!["claimed", "skipped_overlap"].includes(status)) cron.finishRun("once", status, {}, now + 4_000);
      }
      const saved = cron.getJob(args.intent.jobId); const runs = cron.listRuns(saved.jobId);
      for (const operation of ["inspect", "ensure-armed", "admit"]) {
        const positive = ["claimed", "running", "completed"].includes(status);
        let receipt;
        if (operation === "ensure-armed" && !positive) {
          assert.throws(() => maintenanceCron({ ...args, operation, now: now + 10_000 }), (error) => {
            receipt = error.receipt; return error.phase === "arming" && receipt?.disposition === status;
          });
        } else receipt = maintenanceCron({ ...args, operation, now: now + 10_000 });
        assert.equal(receipt.disposition, status);
        assert.equal(receipt.runStatus, status === "removed" ? null : status);
        assert.equal(receipt.armed, positive);
        assert.equal(receipt.armingAction, operation === "ensure-armed" ? "observed" : null);
        assert.deepEqual(cron.getJob(saved.jobId), saved); assert.deepEqual(cron.listRuns(saved.jobId), runs);
      }
    });
  }
});

test("post-commit helper processes share the active scheduler's canonical row and dispatch at most once", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now: now + 10_000 });
  const cron = new CronStore(args.databasePath); const sessions = new HarnessStore(args.databasePath);
  const dispatches = []; const scheduler = new CronScheduler({ cronStore: cron, sessionStore: sessions,
    now: () => Date.now() + 100_000, tickIntervalMs: 100,
    dispatchRun: async ({ run }) => { dispatches.push(run); cron.finishRun(run.runId, "completed"); }, logger: { error() {} } });
  t.after(async () => { await scheduler.stop(); cron.close(); sessions.close(); });
  scheduler.start(); assert.deepEqual(await scheduler.tick(Number.MAX_SAFE_INTEGER), { claimed: 0, skipped: 0 });
  assert.deepEqual(dispatches, []);
  const root = path.dirname(args.databasePath); const intentFile = path.join(root, "live-writer-intent.json");
  await writeFile(intentFile, JSON.stringify(args.intent));
  const arm = async () => {
    const result = await promisify(execFile)(process.execPath, [path.resolve("bin/maintenance-cron.mjs"),
      "--database", args.databasePath, "--intent", intentFile, "--operation", "ensure-armed"],
    { env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_HARNESS_SKILLS_PATH: path.join(root, "skills") }, timeout: 5_000, maxBuffer: 16_384 });
    const receipt = JSON.parse(result.stdout); assert.equal(receipt.ok, true); assert.equal(receipt.armed, true);
    assert.equal(receipt.mutationPossible, true); return receipt;
  };
  const receipts = await Promise.all([arm(), arm()]);
  const deadline = Date.now() + 2_000;
  while (dispatches.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  await scheduler.stop();
  assert.equal(dispatches.length, 1); assert.equal(cron.listRuns(args.intent.jobId).length, 1);
  assert.equal(cron.getJob(args.intent.jobId).fireCount, 1); assert.equal(cron.getJob(args.intent.jobId).lastStatus, "completed");
  assert(receipts.every((receipt) => receipt.jobId === args.intent.jobId));
  const saved = cron.getJob(args.intent.jobId);
  assert.equal((await arm()).disposition, "completed"); assert.deepEqual(cron.getJob(args.intent.jobId), saved);
  const db = new DatabaseSync(args.databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT value FROM cron_meta WHERE key = 'schema_version'").get().value, "1");
    assert.equal(db.prepare("SELECT count(*) AS n FROM cron_jobs").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM actor_inputs").get().n, 0);
  } finally { db.close(); }
});


test("a completed job label without a terminal run outcome cannot satisfy ensure-armed", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
  const db = new DatabaseSync(args.databasePath);
  try { db.prepare("UPDATE cron_jobs SET state = 'completed', enabled = 0, fire_count = 1, next_run_at = NULL, last_status = 'completed' WHERE id = ?").run(args.intent.jobId); }
  finally { db.close(); }
  const inspected = maintenanceCron({ ...args, operation: "inspect", now: now + 2_000 });
  assert.equal(inspected.state, "completed"); assert.equal(inspected.lastStatus, "completed");
  assert.equal(inspected.runStatus, null); assert.equal(inspected.disposition, "unknown");
  assert.throws(() => maintenanceCron({ ...args, operation: "ensure-armed", now: now + 3_000 }),
    (error) => error.receipt.disposition === "unknown" && error.receipt.armed === false);
});

test("one-shot ensure-armed failures retain safe inspected evidence and a failing exit status", async (t) => {
  const args = await fixture(t); const root = path.dirname(args.databasePath);
  const intentFile = path.join(root, "strict-intent.json"); await writeFile(intentFile, JSON.stringify(args.intent));
  const run = async (operation) => {
    try {
      const result = await promisify(execFile)(process.execPath, [path.resolve("bin/maintenance-cron.mjs"),
        "--database", args.databasePath, "--intent", intentFile, "--operation", operation],
      { env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_HARNESS_SKILLS_PATH: path.join(root, "skills") }, timeout: 5_000, maxBuffer: 16_384 });
      return { code: 0, receipt: JSON.parse(result.stdout) };
    } catch (error) { return { code: error.code, receipt: JSON.parse(error.stdout) }; }
  };
  const missing = await run("ensure-armed");
  assert.equal(missing.code, 1); assert.equal(missing.receipt.ok, false); assert.equal(missing.receipt.disposition, "missing");
  maintenanceCron({ ...args, operation: "admit", now });
  const cron = new CronStore(args.databasePath); t.after(() => cron.close());
  cron.removeJob(args.intent.jobId, now + 2_000);
  const failure = await run("ensure-armed"); const inspection = await run("inspect");
  assert.equal(failure.code, 1); assert.equal(failure.receipt.ok, false); assert.equal(failure.receipt.disposition, "removed");
  assert.equal(failure.receipt.armed, false); assert.equal(failure.receipt.jobId, args.intent.jobId);
  assert.equal(failure.receipt.originSessionId, args.intent.originSessionId); assert.equal(failure.receipt.operation, "ensure-armed");
  assert.equal(failure.receipt.intentSha256, inspection.receipt.intentSha256);
  assert.equal(inspection.code, 0); assert.equal(inspection.receipt.ok, true); assert.equal(inspection.receipt.disposition, "removed");
  assert.doesNotMatch(JSON.stringify([missing, failure, inspection]), /PRIVATE_SYNTHETIC_PARENT_INTENT|fixture-only|intentFile|databasePath/);
});


test("sealed past and timezone-local at intents stage unchanged and arm causally", async (t) => {
  for (const at of ["2025-12-31T23:00:00Z", "2026-01-01T00:00:00"]) {
    await t.test(at, async (t) => {
      const args = await fixture(t); args.intent.request.schedule = { kind: "at", at, timezone: "Europe/Berlin" };
      const first = maintenanceCron({ ...args, operation: "admit", now });
      assert.equal(first.state, "paused"); assert.equal(first.enabled, false); assert.equal(first.createdAt, now);
      assert.equal(first.nextRunAt, Date.parse("2025-12-31T23:00:00Z"));
      const inspected = maintenanceCron({ ...args, operation: "inspect", now: now + 5_000 });
      assert.equal(inspected.nextRunAt, first.nextRunAt); assert.equal(inspected.intentSha256, first.intentSha256);
      const armed = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 10_000 });
      assert.equal(armed.nextRunAt, now + 10_000); assert.equal(armed.armingAction, "transitioned");
      const cron = new CronStore(args.databasePath); t.after(() => cron.close());
      assert.equal(cron.getJob(args.intent.jobId).schedule.at, "2025-12-31T23:00:00.000Z");
      assert.equal(cron.listDueJobs(now + 10_000).length, 1);
    });
  }
});

test("the one-shot CLI stages an already due sealed intent without a replacement deadline", async (t) => {
  const args = await fixture(t); const root = path.dirname(args.databasePath);
  const intentFile = path.join(root, "past-intent.json"); await writeFile(intentFile, JSON.stringify(args.intent));
  const run = async (operation) => {
    const result = await promisify(execFile)(process.execPath, [path.resolve("bin/maintenance-cron.mjs"),
      "--database", args.databasePath, "--intent", intentFile, "--operation", operation],
    { env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_HARNESS_SKILLS_PATH: path.join(root, "skills") }, timeout: 5_000, maxBuffer: 16_384 });
    return JSON.parse(result.stdout);
  };
  const staged = await run("admit");
  assert.equal(staged.state, "paused"); assert.equal(staged.enabled, false); assert.equal(staged.nextRunAt, now + 1_000);
  assert(staged.createdAt > staged.nextRunAt); assert.equal(staged.armingAction, null);
  const beforeArm = Date.now(); const armed = await run("ensure-armed"); const afterArm = Date.now();
  assert.equal(armed.armingAction, "transitioned"); assert(armed.nextRunAt >= beforeArm && armed.nextRunAt <= afterArm);
  const observed = await run("ensure-armed"); assert.equal(observed.armingAction, "observed"); assert.equal(observed.nextRunAt, armed.nextRunAt);
});


test("a lost conditional-resume acknowledgment is reconciled as observation without a second transition", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
  const resume = CronStore.prototype.resumeJob; let calls = 0;
  CronStore.prototype.resumeJob = function (...values) {
    calls += 1; resume.apply(this, values); throw new Error("synthetic lost post-commit resume ACK");
  };
  let receipt;
  try { receipt = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 2_000 }); }
  finally { CronStore.prototype.resumeJob = resume; }
  assert.equal(calls, 1); assert.equal(receipt.disposition, "armed"); assert.equal(receipt.armingAction, "observed");
  assert.equal(receipt.nextRunAt, now + 2_000);
  const repeated = maintenanceCron({ ...args, operation: "ensure-armed", now: now + 3_000 });
  assert.equal(repeated.nextRunAt, receipt.nextRunAt); assert.equal(repeated.armingAction, "observed");
});


test("inspection cannot combine an old intent row with a newer writer's completed run", async (t) => {
  const args = await fixture(t); maintenanceCron({ ...args, operation: "admit", now });
  const writer = new CronStore(args.databasePath); t.after(() => writer.close());
  const getJob = CronStore.prototype.getJob; let injected = false;
  // Expose the former gap after a row lookup but before a separate history lookup.
  CronStore.prototype.getJob = function (jobId) {
    const row = getJob.call(this, jobId);
    if (!injected && jobId === args.intent.jobId && row) {
      injected = true;
      writer.replaceJob(jobId, { ...row, prompt: "A different concurrent intent" }, now + 1_000);
      writer.resumeJob(jobId, now + 2_000, now + 2_000);
      writer.claimScheduledRun(jobId, { runId: "different-intent-run", scheduledAt: now + 2_000, nextRunAt: null }, now + 3_000);
      writer.finishRun("different-intent-run", "completed", {}, now + 4_000);
    }
    return row;
  };
  try {
    const receipt = maintenanceCron({ ...args, operation: "inspect", now: now + 5_000 });
    assert.equal(receipt.disposition, "paused", "a later run cannot complete the old inspected intent");
    assert.equal(receipt.runStatus, null); assert.equal(receipt.armed, false);
  } finally { CronStore.prototype.getJob = getJob; }
});
