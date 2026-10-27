import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_CRON_CHECK_OUTPUT_BYTES, normalizeCronCheck, runCronCheck } from "../src/cron-check.mjs";
import { CronScheduler, cronOriginPrompt } from "../src/cron-scheduler.mjs";
import { CronStore } from "../src/cron-store.mjs";
import { HarnessStore } from "../src/store.mjs";

async function eventually(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
}

// The check is scripted per test: each entry is the result of one check run.
async function fixture(t, results = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cron-check-")); const db = path.join(root, "harness.sqlite");
  const sessions = new HarnessStore(db); sessions.createRoot({ sessionId: "origin", sessionFile: path.join(root, "origin.jsonl"),
    cwd: root, repositoryRoot: root, name: "Origin", actorToken: "token", launch: { model: { resolved: { provider: "fake", id: "model" } } } }, 1);
  const cron = new CronStore(db); const dispatches = []; const checks = [];
  const make = (store) => new CronScheduler({ cronStore: store, sessionStore: sessions, now: () => 10_000, tickIntervalMs: 3_600_000,
    runCheck: async (check, options) => { checks.push({ check, options }); return results.shift() ?? { ok: true, output: "" }; },
    dispatchRun: async (value) => { dispatches.push(value); store.markRunRunning(value.run.runId,
      { executionModeUsed: "origin", sessionId: "origin", inputId: `input-${value.run.runId}` }, 10_001); }, logger: { error() {} } });
  const scheduler = make(cron);
  t.after(async () => { await scheduler.stop(); cron.close(); sessions.close(); await rm(root, { recursive: true, force: true }); });
  const job = scheduler.create("origin", { name: "Watch", prompt: "Tell the user about these.", executionMode: "origin",
    schedule: { kind: "every", intervalSeconds: 60 }, check: { command: "watch-something" } }, 10_000);
  return { root, db, sessions, cron, scheduler, make, dispatches, checks, job };
}

const occurrence = (n) => 10_000 + n * 60_000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a silent check starts no run and only moves the schedule forward", async (t) => {
  const { scheduler, cron, dispatches, checks, job, root } = await fixture(t, [{ ok: true, output: "" }]);
  assert.deepEqual(job.check, { command: "watch-something", timeoutSeconds: 30 });
  scheduler.start(); await scheduler.tick(occurrence(1)); await settle();
  assert.equal(checks.length, 1); assert.equal(checks[0].options.cwd, root);
  assert.deepEqual(dispatches, []); assert.deepEqual(cron.listRuns(job.jobId), []);
  const after = cron.getJob(job.jobId);
  assert.equal(after.nextRunAt, occurrence(2)); assert.equal(after.fireCount, 0); assert.equal(after.pendingCheck, null);
});

test("check output wakes the agent once with the output after the task", async (t) => {
  const { scheduler, cron, dispatches, job } = await fixture(t, [{ ok: true, output: "2 new emails" }]);
  scheduler.start(); await scheduler.tick(occurrence(1));
  await eventually(() => dispatches.length === 1);
  const [{ run, prompt }] = dispatches;
  assert.deepEqual(run.check, { kind: "output", text: "2 new emails" });
  assert.match(prompt, /## Scheduled task\n\nTell the user about these\.\n\n## Check output\n\n2 new emails$/);
  assert.equal(cronOriginPrompt(job, run), "Tell the user about these.\n\n## Check output\n\n2 new emails");
  assert.equal(cronOriginPrompt(job, { ...run, check: null }), "Tell the user about these.", "jobs without a check keep their plain prompt");
  assert.equal(cron.getJob(job.jobId).fireCount, 1); assert.equal(cron.getJob(job.jobId).pendingCheck, null);
  await scheduler.tick(occurrence(2)); await settle();
  assert.equal(dispatches.length, 1, "a check is skipped while the previous run is active");
  assert.equal(cron.getJob(job.jobId).nextRunAt, occurrence(3));
});

test("three failures in a row wake the agent once, and a success re-arms the alert", async (t) => {
  const failure = { ok: false, error: "exited with code 2: helper unreachable" };
  const { scheduler, cron, dispatches, job } = await fixture(t, [failure, failure, failure, failure, { ok: true, output: "" }, failure, failure, failure]);
  scheduler.start();
  for (let n = 1; n <= 3; n++) { await scheduler.tick(occurrence(n)); await settle(); }
  await eventually(() => dispatches.length === 1);
  assert.equal(dispatches[0].run.check.kind, "failure");
  assert.match(dispatches[0].prompt, /failed 3 times in a row\. Last error: exited with code 2: helper unreachable/);
  assert.match(dispatches[0].prompt, /The task did not run/);
  cron.finishRun(dispatches[0].run.runId, "completed", {}, 20_000);
  await scheduler.tick(occurrence(4)); await settle();
  assert.equal(cron.getJob(job.jobId).checkFailures, 4); assert.match(cron.getJob(job.jobId).lastError, /check failed/);
  assert.equal(dispatches.length, 1, "the same failing streak alerts only once");
  await scheduler.tick(occurrence(5)); await settle();
  assert.equal(cron.getJob(job.jobId).checkFailures, 0); assert.equal(cron.getJob(job.jobId).lastError, null);
  for (let n = 6; n <= 8; n++) { await scheduler.tick(occurrence(n)); await settle(); }
  await eventually(() => dispatches.length === 2);
});

test("a check result that cannot run yet survives a restart and is delivered exactly once", async (t) => {
  const { scheduler, cron, make, dispatches, job, db } = await fixture(t, [{ ok: true, output: "first" }]);
  // Started first: start() marks runs left over from a previous supervisor as unknown.
  scheduler.start(); cron.claimManualRun(job.jobId, { runId: "busy", scheduledAt: 10_000 }, 10_000);
  await scheduler.tick(occurrence(1)); await settle();
  assert.equal(cron.getJob(job.jobId).nextRunAt, occurrence(2), "the active run also skips the check");
  cron.finishRun("busy", "completed", {}, 11_000);
  // Simulate a check that finished while a run was still active: the result waits durably.
  assert.equal(cron.setPendingCheck(job.jobId, { kind: "output", text: "waiting", at: occurrence(2) }, 12_000), true);
  cron.claimManualRun(job.jobId, { runId: "busy-again", scheduledAt: 12_000 }, 12_000);
  await scheduler.tick(occurrence(2)); await settle();
  assert.deepEqual(dispatches, [], "a pending result waits while the job is busy, and no new check starts");
  await scheduler.stop(); cron.finishRun("busy-again", "completed", {}, 13_000);
  const reopened = new CronStore(db); t.after(() => reopened.close());
  const restarted = make(reopened); restarted.start(); t.after(() => restarted.stop());
  await restarted.tick(occurrence(2));
  await eventually(() => dispatches.length === 1);
  assert.equal(dispatches[0].run.check.text, "waiting");
  await restarted.tick(occurrence(2)); await settle();
  assert.equal(dispatches.length, 1);
});

test("checks allow one-minute intervals, need a recurring schedule, and can be removed", async (t) => {
  const { scheduler, job } = await fixture(t);
  assert.throws(() => scheduler.create("origin", { name: "Plain", prompt: "Task", schedule: { kind: "every", intervalSeconds: 60 } }, 10_000), /intervalSeconds/);
  assert.throws(() => scheduler.create("origin", { name: "Once", prompt: "Task", schedule: { kind: "at", at: "2030-01-01T00:00:00Z" },
    check: { command: "true" } }, 10_000), /recurring/);
  assert.throws(() => scheduler.update(job.jobId, { check: null }), /at least 300 seconds/);
  const plain = scheduler.update(job.jobId, { check: null, schedule: { kind: "every", intervalSeconds: 300 } });
  assert.equal(plain.check, null);
  const rechecked = scheduler.update(job.jobId, { check: { command: "other", timeoutSeconds: 5 } });
  assert.deepEqual(rechecked.check, { command: "other", timeoutSeconds: 5 });
  for (const check of [{ command: " " }, { command: "x", timeoutSeconds: 0 }, { command: "x", timeoutSeconds: 121 }, { command: "x", extra: 1 }, "x"]) {
    assert.throws(() => normalizeCronCheck(check), TypeError);
  }
});

test("the real check runner separates silence, output, failure, timeout, and oversized output", async () => {
  const run = (command, timeoutSeconds = 5) => runCronCheck({ command, timeoutSeconds }, { cwd: os.tmpdir() });
  assert.deepEqual(await run("true"), { ok: true, output: "" });
  assert.deepEqual(await run("printf '  found it\\n\\n'"), { ok: true, output: "found it" });
  const failed = await run("echo partial; echo broken >&2; exit 3");
  assert.equal(failed.ok, false); assert.match(failed.error, /exited with code 3: broken/);
  const started = Date.now();
  const slow = await run("sleep 10 & wait", 1);
  assert.equal(slow.ok, false); assert.match(slow.error, /timed out after 1 s/); assert(Date.now() - started < 5000);
  const big = await run(`head -c ${MAX_CRON_CHECK_OUTPUT_BYTES * 2} /dev/zero | tr '\\0' x`);
  assert.equal(big.ok, true); assert.match(big.output, /\[check output truncated\]$/);
  assert(big.output.length < MAX_CRON_CHECK_OUTPUT_BYTES + 100);
});
