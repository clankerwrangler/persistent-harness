import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";
import { CronStore } from "../src/cron-store.mjs";
import { NotificationStore } from "../src/notification-store.mjs";
import { actorInputCustomPayload, actorInputDigest } from "../src/protocol.mjs";

const baseline = process.env.PI_NOTIFICATION_BASELINE_SOURCE, snapshot = process.env.PI_NOTIFICATION_COLD_COPY;
test("actual recovery baseline writable startup preserves successor notification and canonical input state on a consistent isolated copy", { skip: !baseline || !snapshot }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-compatibility-")), file = path.join(dir, "h.sqlite"); t.after(() => rm(dir, { recursive: true, force: true }));
  // Caller supplies a read-only-source SQLite backup, never a live path for mutation.
  await cp(snapshot, file);
  const baselineStore = await import(pathToFileURL(path.join(baseline, "src/store.mjs")));
  const baselineCron = await import(pathToFileURL(path.join(baseline, "src/cron-store.mjs")));
  const baselineProtocol = await import(pathToFileURL(path.join(baseline, "src/protocol.mjs")));
  const old = new baselineStore.HarnessStore(file), oldCron = new baselineCron.CronStore(file);
  const sessionId = "notification-compatibility-root";
  old.createRoot({ sessionId, sessionFile: path.join(dir, "root.jsonl"), cwd: dir, repositoryRoot: dir, name: sessionId, actorToken: "isolated-token", launch: {} });
  old.createActorInput(sessionId, { inputId: "before-input", message: "Before migration", source: "user" }); oldCron.close(); old.close();
  const current = new HarnessStore(file), cron = new CronStore(file), notices = new NotificationStore(file);
  assert.equal(current.getActorInput("before-input", sessionId).message, "Before migration");
  notices.observe(sessionId, { liveActors: [sessionId], owner: "cron", now: 1000 });
  const originBefore = notices.bindOrigin(sessionId, "background:compatibility-job", 1100);
  assert.equal(originBefore.owner, "cron");
  const item = notices.request(sessionId, { key: "choice", title: "Choice", body: "Choose safely", expiresIn: 86400 });
  const claim = notices.claim(["a".repeat(64)])[0]; notices.receipt({ id: claim.notification.id, endpointId: claim.endpointId, leaseId: claim.leaseId, status: "accepted" });
  cron.createJob({ jobId: "compat-job", name: "Compatibility check", prompt: "Bounded task", schedule: { kind: "every", intervalSeconds: 300, timezone: "UTC" },
    scheduleDisplay: "every 300 seconds", timezone: "UTC", executionMode: "origin", notificationIntent: "conditional", originSessionId: sessionId,
    cwd: dir, repositoryRoot: dir, launch: {}, repeat: null, nextRunAt: Date.now()+300000, initiallyPaused: true });
  cron.claimManualRun("compat-job", { runId: "compat-run", scheduledAt: Date.now() });
  cron.markRunRunning("compat-run", { executionModeUsed: "origin", sessionId, inputId: "after-input" });
  current.createActorInput(sessionId, { inputId: "after-input", message: "Successor task", source: "cron", origin: { jobId: "compat-job", runId: "compat-run" } });
  cron.reportNotification("compat-run", sessionId, { disposition: "no_finding" }); cron.finishRun("compat-run", "completed");
  const receiptBefore = current.getActorInput("after-input", sessionId, { includeDigest: true });
  const jobBefore = cron.getJob("compat-job"), runBefore = cron.getRun("compat-run"), noticeBefore = notices.get(item.id), deliveriesBefore = notices.deliveries(item.id);
  const synthetic = { inputId: "after-input", source: "cron", origin: { jobId: "compat-job", runId: "compat-run" }, message: "Successor task", acceptedAt: Date.now(), images: [] };
  assert.equal(actorInputDigest(synthetic.message, "[]", "auto"), baselineProtocol.actorInputDigest(synthetic.message, "[]", "auto"));
  // Historical role headers and new generic headers remain canonical verifier inputs.
  assert.deepEqual(actorInputCustomPayload(synthetic, "Commander"), baselineProtocol.actorInputCustomPayload(synthetic));
  assert.equal(actorInputCustomPayload(synthetic, "user").details.inputId, "after-input");
  notices.close(); cron.close(); current.close();
  const recovery = new baselineStore.HarnessStore(file), recoveryCron = new baselineCron.CronStore(file);
  assert.deepEqual(recovery.getActorInput("after-input", sessionId, { includeDigest: true }), receiptBefore);
  assert.equal(recoveryCron.getJob("compat-job").prompt, jobBefore.prompt);
  recovery.createActorInput(sessionId, { inputId: "recovery-input", message: "Recovery reader writes without restoring history", source: "user" });
  recoveryCron.resumeJob("compat-job", Date.now()+300000); recoveryCron.close(); recovery.close();
  const successor = new HarnessStore(file), successorCron = new CronStore(file), successorNotices = new NotificationStore(file);
  assert.equal(successor.getActorInput("recovery-input", sessionId).message, "Recovery reader writes without restoring history");
  assert.equal(successorCron.getJob("compat-job").notificationIntent, "conditional");
  assert.deepEqual(successorCron.getRun("compat-run"), runBefore); assert.deepEqual(successorNotices.get(item.id), noticeBefore);
  assert.deepEqual(successorNotices.deliveries(item.id), deliveriesBefore);
  assert.deepEqual(successorNotices.bindOrigin(sessionId, "background:compatibility-job", 9999), originBefore);
  successorNotices.noteContinuation(sessionId, "background:compatibility-job", 1100);
  const db = new DatabaseSync(file); assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); db.close();
  successorNotices.close(); successorCron.close(); successor.close();
});
