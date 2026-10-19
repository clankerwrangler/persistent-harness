import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CronStore } from "../src/cron-store.mjs";
import { HarnessStore } from "../src/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cron-store-"));
  const file = path.join(root, "harness.sqlite");
  const harness = new HarnessStore(file);
  harness.createRoot({ sessionId: "origin", sessionFile: path.join(root, "origin.jsonl"), cwd: root,
    repositoryRoot: root, name: "Origin", actorToken: "token", launch: {} }, 1);
  const cron = new CronStore(file);
  t.after(async () => { cron.close(); harness.close(); await rm(root, { recursive: true, force: true }); });
  return { root, cron, harness };
}

function jobParams(root, overrides = {}) {
  return { jobId: "job-one", name: "Morning", prompt: "Report status", schedule: { kind: "every", intervalSeconds: 300, timezone: "Europe/Paris" },
    scheduleDisplay: "every 300 seconds", timezone: "Europe/Paris", executionMode: "origin",
    originSessionId: "origin", cwd: root, repositoryRoot: root, launch: {}, repeat: null, nextRunAt: 1_000,
    ...overrides };
}

test("cron store claims each due occurrence once and fast-forwards state before execution", async (t) => {
  const { root, cron } = await fixture(t); cron.createJob(jobParams(root), 10);
  const claim = cron.claimScheduledRun("job-one", { runId: "scheduled-one", scheduledAt: 1_000, nextRunAt: 301_000 }, 2_000);
  assert.equal(claim.claimed, true); assert.equal(claim.run.status, "claimed");
  assert.equal(cron.getJob("job-one").nextRunAt, 301_000); assert.equal(cron.getJob("job-one").fireCount, 1);
  assert.deepEqual(cron.claimScheduledRun("job-one", { runId: "duplicate", scheduledAt: 1_000, nextRunAt: 301_000 }, 2_001),
    { claimed: false, reason: "not_due" });
  cron.markRunRunning("scheduled-one", { executionModeUsed: "origin", sessionId: "origin", inputId: "cron-scheduled-one" }, 2_100);
  cron.finishRun("scheduled-one", "completed", { output: "done" }, 2_200);
  assert.equal(cron.listRuns("job-one")[0].output, "done");
});

test("overlap is recorded as skipped while advancing the next occurrence", async (t) => {
  const { root, cron } = await fixture(t); cron.createJob(jobParams(root), 10);
  cron.claimScheduledRun("job-one", { runId: "first", scheduledAt: 1_000, nextRunAt: 301_000 }, 1_100);
  const skipped = cron.claimScheduledRun("job-one", { runId: "second", scheduledAt: 301_000, nextRunAt: 601_000 }, 301_100);
  assert.equal(skipped.claimed, false); assert.equal(skipped.skipped, true); assert.equal(skipped.run.status, "skipped_overlap");
  assert.equal(cron.getJob("job-one").nextRunAt, 601_000);
});

test("finite repeats complete after claimed occurrences and restart recovery never retries an uncertain run", async (t) => {
  const { root, cron } = await fixture(t); cron.createJob(jobParams(root, { repeat: 1 }), 10);
  cron.claimScheduledRun("job-one", { runId: "once", scheduledAt: 1_000, nextRunAt: 301_000 }, 1_100);
  assert.equal(cron.getJob("job-one").state, "completed"); assert.equal(cron.getJob("job-one").nextRunAt, null);
  const recovered = cron.reconcileInterruptedRuns(1_200);
  assert.equal(recovered.length, 1); assert.equal(cron.getRun("once").status, "unknown");
  assert.deepEqual(cron.listDueJobs(1_000_000), []);
});

test("live names are case-insensitively unique and removed names may be reused", async (t) => {
  const { root, cron } = await fixture(t); cron.createJob(jobParams(root), 10);
  assert.throws(() => cron.createJob(jobParams(root, { jobId: "job-two", name: "morning" }), 11), /UNIQUE/);
  cron.removeJob("job-one", 12);
  assert.equal(cron.createJob(jobParams(root, { jobId: "job-two", name: "morning" }), 13).jobId, "job-two");
});

test("settings-sourced launch snapshots are not treated as pins", async (t) => {
  const { root, cron } = await fixture(t);
  const job = cron.createJob(jobParams(root, {
    launch: {
      model: { requested: null, resolved: { provider: "openai-codex", id: "gpt-5.6-sol" }, source: "settings" },
      thinking: { requested: null, resolved: "xhigh", source: "settings" },
    },
  }), 10);
  assert.deepEqual(job.launch.model, { requested: null, resolved: null, source: "settings" });
  assert.deepEqual(job.launch.thinking, { requested: null, resolved: null, source: "settings" });
  const pinned = cron.createJob(jobParams(root, {
    jobId: "job-pin", name: "Pinned",
    launch: {
      model: { requested: "grok-cli/grok-4.6", resolved: { provider: "grok-cli", id: "grok-4.6" }, source: "explicit" },
    },
  }), 11);
  assert.deepEqual(pinned.launch.model.resolved, { provider: "grok-cli", id: "grok-4.6" });
  assert.equal(pinned.launch.model.source, "explicit");
});


test("initially paused jobs exclude ordinary scheduled claims, including from another writer", async (t) => {
  const { root, cron } = await fixture(t);
  const competing = new CronStore(path.join(root, "harness.sqlite")); t.after(() => competing.close());
  const staged = cron.createJob(jobParams(root, { initiallyPaused: true }), 10);
  assert.equal(staged.state, "paused"); assert.equal(staged.enabled, false);
  assert.deepEqual(competing.listDueJobs(1_000_000), []);
  assert.deepEqual(competing.claimScheduledRun(staged.jobId,
    { runId: "forced-paused", scheduledAt: staged.nextRunAt, nextRunAt: null }, 1_000_000),
  { claimed: false, reason: "not_due" });
  assert.deepEqual(competing.getJob(staged.jobId), staged);
  assert.deepEqual(competing.listRuns(staged.jobId), []);
  const ordinary = cron.createJob(jobParams(root, { jobId: "ordinary", name: "Ordinary" }), 10);
  assert.equal(ordinary.state, "scheduled"); assert.equal(ordinary.enabled, true);
});

test("conditional resume rejects a changed snapshot without changing a competing writer's row", async (t) => {
  const { root, cron } = await fixture(t);
  const competing = new CronStore(path.join(root, "harness.sqlite")); t.after(() => competing.close());
  const staged = cron.createJob(jobParams(root, { initiallyPaused: true }), 10);
  // Use the same timestamp to prove that the guard covers content, not only updatedAt.
  const changed = competing.replaceJob(staged.jobId, { ...staged, prompt: "Changed task" }, staged.updatedAt);
  assert.throws(() => cron.resumeJob(staged.jobId, 2_000, 20, { expectedJob: staged }), /changed before resume/);
  assert.deepEqual(competing.getJob(staged.jobId), changed);
  const resumed = cron.resumeJob(staged.jobId, 3_000, 30, { expectedJob: changed });
  assert.equal(resumed.nextRunAt, 3_000); assert.equal(resumed.state, "scheduled");
  assert.throws(() => competing.resumeJob(staged.jobId, 4_000, 40, { expectedJob: changed }), /changed before resume/);
  assert.deepEqual(cron.getJob(staged.jobId), resumed);
});


test("job inspection binds the canonical row and latest status in one bounded result without run output", async (t) => {
  const { root, cron } = await fixture(t);
  assert.deepEqual(cron.inspectJob("missing"), { job: undefined, runStatus: null });
  const saved = cron.createJob(jobParams(root, { repeat: 1 }), 10);
  assert.deepEqual(cron.inspectJob(saved.jobId), { job: saved, runStatus: null });
  cron.claimScheduledRun(saved.jobId, { runId: "inspection-run", scheduledAt: saved.nextRunAt, nextRunAt: null }, 2_000);
  const claimed = cron.inspectJob(saved.jobId);
  assert.equal(claimed.job.state, "completed"); assert.equal(claimed.runStatus, "claimed");
  cron.finishRun("inspection-run", "completed", { output: "SYNTHETIC_PRIVATE_RUN_OUTPUT" }, 3_000);
  const completed = cron.inspectJob(saved.jobId);
  assert.equal(completed.runStatus, "completed"); assert.equal(completed.job.lastStatus, "completed");
  assert.doesNotMatch(JSON.stringify(completed), /SYNTHETIC_PRIVATE_RUN_OUTPUT/);
});


test("active-run existence is session-specific, fresh, and independent of full run payloads", async (t) => {
  const { root, cron, harness } = await fixture(t);
  harness.createRoot({ sessionId: "other", cwd: root, name: "Other", actorToken: "synthetic", launch: {} }, 1);
  const raw = new DatabaseSync(path.join(root, "harness.sqlite")); t.after(() => raw.close());
  const writer = new CronStore(path.join(root, "harness.sqlite")); t.after(() => writer.close());
  const originalPrepare = DatabaseSync.prototype.prepare;
  const probe = (sessionId, expected) => {
    const selected = [];
    DatabaseSync.prototype.prepare = function (...args) {
      const statement = originalPrepare.apply(this, args);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...values) => {
          const result = value.apply(target, values);
          if (key === "get" || key === "all") selected.push(...(key === "all" ? result : result === undefined ? [] : [result]));
          return result;
        };
      } });
    };
    try { assert.equal(cron.hasActiveRunForSession(sessionId), expected); }
    finally { DatabaseSync.prototype.prepare = originalPrepare; }
    assert(selected.length <= 1, "an existence check materializes at most one row");
    assert(selected.every(row => Object.keys(row).length === 1 && Object.values(row)[0] === 1), "an existence check selects only a constant");
  };
  probe("origin", false); probe("missing", false);
  const statuses = ["claimed", "running", "completed", "failed", "unknown", "skipped_overlap"];
  for (const [index, status] of statuses.entries()) {
    const jobId = `probe-${index}`;
    writer.createJob(jobParams(root, { jobId, name: jobId }), 10);
    writer.claimManualRun(jobId, { runId: jobId, scheduledAt: 20 }, 20);
    // A claimed run can be unassigned; SQL NULL must not match a session.
    probe("origin", false); probe(null, false);
    raw.prepare("UPDATE cron_runs SET session_id = 'origin', status = ?, notification_body = ? WHERE id = ?")
      .run(status, "Synthetic body".repeat(50), jobId);
    const active = status === "claimed" || status === "running";
    probe("origin", active); probe("other", false);
    if (active) {
      const full = cron.listActiveRunsForSession("origin");
      assert.equal(full.length, 1); assert.equal(full[0].notificationBody, "Synthetic body".repeat(50));
      assert.equal(full[0].runId, jobId); assert.equal(full[0].status, status);
    }
    raw.prepare("UPDATE cron_runs SET session_id = 'other' WHERE id = ?").run(jobId);
    probe("origin", false); probe("other", active);
    if (active) writer.finishRun(jobId, "completed", { output: "Preserved full history" }, 30);
    probe("other", false);
  }
  // Different jobs can have simultaneous active runs for the same session.
  for (const jobId of ["multiple-a", "multiple-b"]) {
    writer.createJob(jobParams(root, { jobId, name: jobId }), 40);
    writer.claimManualRun(jobId, { runId: jobId, scheduledAt: 50 }, 50);
    writer.markRunRunning(jobId, { executionModeUsed: "origin", sessionId: "origin", inputId: jobId }, 60);
  }
  probe("origin", true);
  assert.equal(cron.listActiveRunsForSession("origin").length, 2);
  writer.finishRun("multiple-a", "completed", {}, 70); probe("origin", true);
  writer.finishRun("multiple-b", "failed", { error: "Synthetic failure" }, 80); probe("origin", false);
});

test("active-run existence retains database errors after close", async (t) => {
  const { root } = await fixture(t);
  const closed = new CronStore(path.join(root, "harness.sqlite")); closed.close();
  assert.throws(() => closed.hasActiveRunForSession("origin"), /not open|closed/i);
});
