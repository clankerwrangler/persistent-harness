import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CronScheduler } from "../src/cron-scheduler.mjs";
import { CronStore } from "../src/cron-store.mjs";
import { HarnessStore } from "../src/store.mjs";

async function eventually(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
}

async function fixture(t, now = 10_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cron-scheduler-")); const db = path.join(root, "harness.sqlite");
  const sessions = new HarnessStore(db); sessions.createRoot({ sessionId: "origin", sessionFile: path.join(root, "origin.jsonl"),
    cwd: root, repositoryRoot: root, name: "Origin", actorToken: "token", launch: { model: { resolved: { provider: "fake", id: "model" } } } }, 1);
  const cron = new CronStore(db); const dispatches = [];
  const scheduler = new CronScheduler({ cronStore: cron, sessionStore: sessions, now: () => now, tickIntervalMs: 3_600_000,
    dispatchRun: async (value) => { dispatches.push(value); cron.markRunRunning(value.run.runId,
      { executionModeUsed: "origin", sessionId: "origin", inputId: `input-${value.run.runId}` }, now + 1); }, logger: { error() {} } });
  t.after(async () => { await scheduler.stop(); cron.close(); sessions.close(); await rm(root, { recursive: true, force: true }); });
  return { root, sessions, cron, scheduler, dispatches };
}

test("scheduler creates unpinned origin jobs and dispatches a deterministic overdue occurrence once", async (t) => {
  const { scheduler, cron, dispatches } = await fixture(t);
  const job = scheduler.create("origin", { name: "Check", prompt: "Check the workspace",
    schedule: { kind: "every", intervalSeconds: 300 }, executionMode: "origin" });
  assert.equal(job.timezone, "Europe/Berlin"); assert.equal(job.originSessionId, "origin");
  assert.deepEqual(job.launch.model, { requested: null, resolved: null, source: "settings" });
  assert.deepEqual(job.launch.thinking, { requested: null, resolved: null, source: "settings" });
  scheduler.start(); await scheduler.tick(400_000); await eventually(() => dispatches.length === 1);
  assert.equal(dispatches[0].run.runId, cron.listRuns(job.jobId)[0].runId);
  assert.equal(cron.listRuns(job.jobId)[0].status, "running");
  assert.match(dispatches[0].prompt, /Do not create, update, or remove scheduled jobs/);
  await scheduler.tick(1_000_000);
  assert.equal(dispatches.length, 1, "same-job overlap must skip rather than dispatch again");
  assert(cron.listRuns(job.jobId).some((run) => run.status === "skipped_overlap"));
});

test("manual runs do not consume a finite scheduled repeat", async (t) => {
  const { scheduler, cron, dispatches } = await fixture(t);
  const job = scheduler.create("origin", { name: "Once", prompt: "One task",
    schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, executionMode: "fresh", repeat: 1 });
  scheduler.runNow(job.jobId); await eventually(() => dispatches.length === 1);
  assert.equal(cron.getJob(job.jobId).fireCount, 0); assert.equal(cron.getJob(job.jobId).state, "scheduled");
});

test("pause and resume re-anchor recurring schedules without altering their timezone", async (t) => {
  const { scheduler } = await fixture(t);
  const job = scheduler.create("origin", { name: "Recurring", prompt: "Task",
    schedule: { kind: "cron", expression: "0 9 * * *" } });
  assert.equal(scheduler.pause(job.jobId).state, "paused");
  const resumed = scheduler.resume(job.jobId, Date.parse("2026-03-28T10:00:00Z"));
  assert.equal(new Date(resumed.nextRunAt).toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(resumed.timezone, "Europe/Berlin");
});

test("explicit provider and model pin a job and can be cleared later", async (t) => {
  const { scheduler } = await fixture(t);
  const job = scheduler.create("origin", { name: "Pinned", prompt: "Task",
    schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, provider: "grok-cli", model: "grok-4.6",
    thinkingLevel: "high" });
  assert.deepEqual(job.launch.model, {
    requested: "grok-cli/grok-4.6", resolved: { provider: "grok-cli", id: "grok-4.6" }, source: "explicit",
  });
  assert.deepEqual(job.launch.thinking, { requested: "high", resolved: "high", source: "explicit" });
  const cleared = scheduler.update(job.jobId, { provider: null, model: null, thinkingLevel: null });
  assert.deepEqual(cleared.launch.model, { requested: null, resolved: null, source: "settings" });
  assert.deepEqual(cleared.launch.thinking, { requested: null, resolved: null, source: "settings" });
});


test("stable create identity survives due, completion, removal, and reopen without mutation", async (t) => {
  const { root, scheduler, cron, sessions, dispatches } = await fixture(t);
  const params = { name: "Stable once", prompt: "One accepted task", schedule: { kind: "at", at: new Date(20_000).toISOString() },
    executionMode: "origin", repeat: 1 };
  const options = { jobId: "maintenance-once-1" };
  const job = scheduler.create("origin", params, 10_000, options);
  assert.equal(job.jobId, options.jobId);
  assert.deepEqual(scheduler.create("origin", params, 15_000, options), job);
  assert.deepEqual(scheduler.create("origin", params, 30_000, options), job);
  cron.claimScheduledRun(job.jobId, { runId: "stable-run", scheduledAt: job.nextRunAt, nextRunAt: null }, 30_000);
  cron.finishRun("stable-run", "completed", { output: "done" }, 31_000);
  const completed = cron.getJob(job.jobId);
  const reopened = new CronStore(path.join(root, "harness.sqlite"));
  t.after(() => reopened.close());
  const restarted = new CronScheduler({ cronStore: reopened, sessionStore: sessions, dispatchRun: async () => { throw new Error("no dispatch"); } });
  assert.deepEqual(restarted.create("origin", params, 60_000, options), completed);
  const removed = scheduler.remove(job.jobId, 70_000);
  assert.deepEqual(restarted.create("origin", params, 80_000, options), removed);
  assert.equal(cron.listJobs({ includeRemoved: true }).length, 1);
  assert.equal(cron.listRuns(job.jobId).length, 1);
  assert.deepEqual(dispatches, []);
});

test("stable create rejects changed immutable intent without changing the saved job", async (t) => {
  const { scheduler, cron, sessions, root } = await fixture(t);
  sessions.createRoot({ sessionId: "other", sessionFile: path.join(root, "other.jsonl"), cwd: root,
    repositoryRoot: root, name: "Other", actorToken: "other-token" }, 1);
  const params = { name: "Stable recurring", prompt: "Task", schedule: { kind: "every", intervalSeconds: 300 },
    provider: "fake", model: "model", thinkingLevel: "high", executionMode: "origin", repeat: 2 };
  const options = { jobId: "intent-check" };
  const saved = scheduler.create("origin", params, 10_000, options);
  const changes = [
    { name: "Different" }, { prompt: "Other task" }, { schedule: { kind: "every", intervalSeconds: 600 } },
    { timezone: "UTC" }, { provider: "other" }, { model: "other" }, { thinkingLevel: "low" },
    { executionMode: "fresh" }, { repeat: 3 },
  ];
  for (const patch of changes) {
    assert.throws(() => scheduler.create("origin", { ...params, ...patch }, 20_000, options), /different intent/);
    assert.deepEqual(cron.getJob(saved.jobId), saved);
  }
  assert.throws(() => scheduler.create("other", params, 20_000, options), /different intent/);
  assert.deepEqual(cron.getJob(saved.jobId), saved);
  assert.equal(cron.listJobs().length, 1);
});

test("controlled create IDs are bounded and new one-shots still require a future schedule", async (t) => {
  const { scheduler, cron } = await fixture(t);
  const params = { name: "Controlled", prompt: "Task", schedule: { kind: "every", intervalSeconds: 300 } };
  for (const jobId of [null, "", "a".repeat(129), "../job", "white space", "bad\nidentity", "a/b", 7, {}]) {
    assert.throws(() => scheduler.create("origin", params, 10_000, { jobId }), /jobId/);
  }
  assert.throws(() => scheduler.create("origin", { ...params, schedule: { kind: "at", at: new Date(5_000).toISOString() } },
    10_000, { jobId: "new-past-job" }), /future/);
  assert.equal(cron.listJobs().length, 0);
});

test("a stable create reconciles a competing same-ID insert but rejects a conflicting winner", async (t) => {
  const { scheduler, cron, root } = await fixture(t);
  const competing = new CronStore(path.join(root, "harness.sqlite"));
  t.after(() => competing.close());
  const originalCreate = cron.createJob.bind(cron);
  cron.createJob = (params, now) => {
    competing.createJob(params, now);
    return originalCreate(params, now);
  };
  const params = { name: "Race", prompt: "Task", schedule: { kind: "every", intervalSeconds: 300 } };
  const saved = scheduler.create("origin", params, 10_000, { jobId: "same-id-race" });
  assert.deepEqual(saved, competing.getJob(saved.jobId));
  cron.createJob = (input, now) => {
    competing.createJob({ ...input, prompt: "Conflicting task" }, now);
    return originalCreate(input, now);
  };
  assert.throws(() => scheduler.create("origin", { ...params, name: "Conflict" }, 10_000, { jobId: "conflicting-race" }), /different intent/);
  assert.equal(competing.getJob("conflicting-race").prompt, "Conflicting task");
  assert.equal(cron.listJobs().length, 2);
});


test("stable initially paused creation stays paused through forced scans and an expired admission ACK", async (t) => {
  const { scheduler, cron, dispatches } = await fixture(t);
  const params = { name: "Staged once", prompt: "One staged task", executionMode: "origin", repeat: 1,
    schedule: { kind: "at", at: new Date(20_000).toISOString() } };
  const options = { jobId: "staged-once", initiallyPaused: true };
  const staged = scheduler.create("origin", params, 10_000, options);
  assert.equal(staged.state, "paused"); assert.equal(staged.enabled, false);
  scheduler.start();
  assert.deepEqual(await scheduler.tick(1_000_000), { claimed: 0, skipped: 0 });
  assert.deepEqual(scheduler.create("origin", params, 1_000_000, options), staged);
  assert.deepEqual(scheduler.inspectCreation("origin", params, options).job, staged);
  assert.deepEqual(cron.listRuns(staged.jobId), []); assert.deepEqual(dispatches, []);
  const resumed = scheduler.resume(staged.jobId, 30_000, { expectedJob: staged });
  assert.equal(resumed.nextRunAt, 30_000);
  assert.deepEqual(scheduler.create("origin", params, 40_000, options), resumed, "retry must not pause an armed row");
  assert.deepEqual(await scheduler.tick(40_000), { claimed: 1, skipped: 0 });
  await eventually(() => dispatches.length === 1);
  assert.equal(cron.getJob(staged.jobId).fireCount, 1);
});

test("creation inspection never inserts and initial pause options are validated without changing defaults", async (t) => {
  const { scheduler, cron } = await fixture(t);
  const params = { name: "Inspection", prompt: "Task", schedule: { kind: "every", intervalSeconds: 300 } };
  assert.equal(scheduler.inspectCreation("origin", params, { jobId: "missing" }).job, undefined);
  for (const initiallyPaused of [null, 0, "true", {}]) {
    assert.throws(() => scheduler.create("origin", params, 10_000, { jobId: "invalid", initiallyPaused }), /initiallyPaused/);
  }
  assert.deepEqual(cron.listJobs(), []);
  const ordinary = scheduler.create("origin", params, 10_000);
  assert.equal(ordinary.state, "scheduled"); assert.equal(ordinary.enabled, true);
});


test("only initially paused new jobs admit a due sealed at-time, and exact-ID inspection retains it", async (t) => {
  const { scheduler, cron } = await fixture(t);
  const params = { name: "Already due", prompt: "Sealed task", executionMode: "origin", repeat: 1,
    schedule: { kind: "at", at: new Date(5_000).toISOString() } };
  assert.throws(() => scheduler.create("origin", params, 10_000), /future/);
  assert.throws(() => scheduler.create("origin", params, 10_000, { jobId: "ordinary-due", initiallyPaused: false }), /future/);
  const staged = scheduler.create("origin", params, 10_000, { jobId: "sealed-due", initiallyPaused: true });
  assert.equal(staged.createdAt, 10_000); assert.equal(staged.nextRunAt, 5_000);
  assert.equal(staged.state, "paused"); assert.equal(staged.enabled, false);
  assert.deepEqual(scheduler.create("origin", params, 20_000, { jobId: staged.jobId, initiallyPaused: true }), staged);
  assert.deepEqual(scheduler.inspectCreation("origin", params, { jobId: staged.jobId }).job, staged);
  assert.throws(() => scheduler.inspectCreation("origin", { ...params, schedule: { kind: "at", at: new Date(4_000).toISOString() } },
    { jobId: staged.jobId }), /different intent/);
  assert.deepEqual(cron.listDueJobs(1_000_000), []);
  const armed = scheduler.resume(staged.jobId, 30_000, { expectedJob: staged });
  assert.equal(armed.nextRunAt, 30_000); assert.equal(armed.schedule.at, params.schedule.at);
});
