import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { CronStore } from "../src/cron-store.mjs";
import { NotificationStore } from "../src/notification-store.mjs";
import { fixture, delay, eventually } from "./fixtures/notification-supervisor.mjs";

for (const scenario of [
  { intent: "result", output: "The exact scheduled result", expected: 1 },
  { intent: "conditional", disposition: "deliver", body: "The exact finding", expected: 1 },
  { intent: "conditional", disposition: "no_finding", expected: 0 },
  { intent: "conditional", output: "No prose inference", expected: 1, failed: true },
  { intent: "result", status: "failed", expected: 1, failed: true },
  { intent: "silent", output: "Quiet progress", expected: 0 },
]) test(`cron ${JSON.stringify(scenario)} has exact-run delivery, independent execution, and no cron-only idle bypass`, async t => {
  const f = await fixture(t), root = await f.actor(), other = await f.actor();
  const cron = new CronStore(path.join(f.dir, "state/h.sqlite")); t.after(() => cron.close());
  const job = (await root.connection.request("cron_job", { action: "create", name: "Check", prompt: "Original task meaning", schedule: { kind: "every", intervalSeconds: 600 }, executionMode: "origin", notificationIntent: scenario.intent })).job;
  const run = (await root.connection.request("cron_job", { action: "run", selector: job.jobId })).run;
  await eventually(() => cron.getRun(run.runId).status === "running");
  const input = f.supervisor.store.getActorInput(cron.getRun(run.runId).inputId, root.session.sessionId);
  assert.ok(input.message.startsWith(job.prompt)); assert.match(input.message, new RegExp(`intent ${scenario.intent}`)); assert.ok(input.message.includes(run.runId));
  assert.equal(cron.getJob(job.jobId).prompt, "Original task meaning");
  root.busy();
  if (scenario.disposition) {
    const params = { action: "report", runId: run.runId, disposition: scenario.disposition, ...(scenario.body ? { body: scenario.body } : {}) };
    await assert.rejects(other.connection.request("cron_job", params), /does not accept/);
    const saved = (await root.connection.request("cron_job", params)).run;
    assert.deepEqual((await root.connection.request("cron_job", params)).run, saved);
    await assert.rejects(root.connection.request("cron_job", { ...params, disposition: scenario.disposition === "deliver" ? "no_finding" : "deliver", body: "Different" }), /body|different/);
  }
  cron.finishRun(run.runId, scenario.status ?? "completed", { output: scenario.output ?? null });
  root.idle(); await delay(160);
  const feed = (await f.client.request("list_notifications")).notifications;
  assert.equal(feed.length, scenario.expected); assert.equal(cron.listRuns(job.jobId).length, 1);
  if (feed.length) {
    const item = feed[0]; assert.equal(item.kind, "cron"); assert.equal(item.source.runId, run.runId); assert.equal(item.source.failed, Boolean(scenario.failed));
    if (!scenario.failed) assert.equal(item.body, scenario.body ?? scenario.output);
    else assert.match(item.body, /not established|did not produce/);
    const endpoints = ["a".repeat(64)];
    const claim = (await f.client.request("claim_notification_delivery", { endpointIds: endpoints })).claims[0];
    await f.client.request("record_notification_delivery", { id: item.id, endpointId: claim.endpointId, leaseId: claim.leaseId, status: "retry" });
    const outbox = new NotificationStore(path.join(f.dir, "state/h.sqlite"));
    const retry = outbox.claim(endpoints, Date.now()+6000)[0]; assert.equal(retry.notification.id, item.id); assert.equal(retry.attempt, 2); outbox.close();
    assert.equal(cron.listRuns(job.jobId).length, 1, "delivery retry cannot rerun execution");
  }
  await delay(100); assert.equal((await f.client.request("list_notifications")).notifications.length, scenario.expected);
});

for (const intent of ["conditional", "silent"]) test(`user activity sharing an origin ${intent} cron retains the user idle notification`, async t => {
  const f = await fixture(t), root = await f.actor(), cron = new CronStore(path.join(f.dir, "state/h.sqlite")); t.after(() => cron.close());
  const job = (await root.connection.request("cron_job", { action: "create", name: "Quiet check", prompt: "Check", schedule: { kind: "every", intervalSeconds: 600 }, executionMode: "origin", notificationIntent: intent })).job;
  const run = (await root.connection.request("cron_job", { action: "run", selector: job.jobId })).run;
  await eventually(() => cron.getRun(run.runId).status === "running"); root.busy();
  // Real client admission marks user provenance, without requiring an empty queue.
  await f.client.request("submit_input", { sessionId: root.session.sessionId, message: "User requested work", behavior: "follow_up" });
  if (intent === "conditional") {
    assert.equal(cron.getRun(run.runId).status, "running", JSON.stringify({ run: cron.getRun(run.runId), errors: f.errors }));
    await root.connection.request("cron_job", { action: "report", runId: run.runId, disposition: "no_finding" });
  }
  cron.finishRun(run.runId, "completed", { output: "Quiet cron output" }); root.idle();
  const feed = await eventually(async () => { const value = (await f.client.request("list_notifications")).notifications; return value.length && value; });
  assert.equal(feed.length, 1); assert.equal(feed[0].kind, "idle");
});

for (const nextRole of ["user", "scheduled_job", "background_notification"]) for (const validAnswer of [false, true]) test(`cron completion binds to its input before later ${nextRole}; prior valid answer=${validAnswer}`, async t => {
  let messages = [], inputEntries = {};
  const f = await fixture(t, { transcriptReader: { read: async () => ({ messages, inputEntries }) } }), root = await f.actor();
  const cron = new CronStore(path.join(f.dir, "state/h.sqlite")); t.after(() => cron.close());
  const job = (await root.connection.request("cron_job", { action: "create", name: "Exact turn", prompt: "Check", schedule: { kind: "every", intervalSeconds: 600 }, executionMode: "origin", notificationIntent: "result" })).job;
  const run = (await root.connection.request("cron_job", { action: "run", selector: job.jobId })).run;
  await eventually(() => cron.getRun(run.runId).status === "running");
  inputEntries[cron.getRun(run.runId).inputId] = "scheduled-entry";
  messages = [{ id: "old", role: "assistant", text: "OLD SECRET ANSWER" }, { id: "scheduled-entry", role: "scheduled_job", text: "task" }, ...(validAnswer ? [{ id: "exact", role: "assistant", text: "Exact scheduled answer" }] : []),
    { id: "next", role: nextRole, text: "another task" }, { id: "later", role: "assistant", text: "UNRELATED LATER ANSWER" }];
  root.busy(); root.idle(); await eventually(() => cron.getRun(run.runId).status === (validAnswer ? "completed" : "failed"));
  const feed = await eventually(async () => { const value = (await f.client.request("list_notifications")).notifications; return value.length && value; });
  assert.equal(feed.length, 1); assert.equal(feed[0].source.failed, !validAnswer); if (validAnswer) assert.equal(feed[0].body, "Exact scheduled answer"); assert.doesNotMatch(JSON.stringify(feed), /OLD SECRET|UNRELATED LATER/);
});

for (const intent of ["silent", "conditional"]) for (const origin of ["cron", "user"]) test(`${origin} background continuation after terminal ${intent} cron retains causal notification ownership`, async t => {
  const f = await fixture(t, { backgroundCompletionIntervalMs: 100 }), root = await f.actor();
  const cron = new CronStore(path.join(f.dir, "state/h.sqlite")); t.after(() => cron.close());
  let createdAt;
  const list = async () => (await f.client.request("list_notifications")).notifications;
  if (origin === "user") {
    root.busy(); await delay(15); createdAt = new Date().toISOString(); root.idle(); await delay(150);
    assert.equal((await list()).filter(n => n.kind === "idle").length, 1);
  }
  const job = (await root.connection.request("cron_job", { action: "create", name: "Quiet check", prompt: "Check", schedule: { kind: "every", intervalSeconds: 600 }, executionMode: "origin", notificationIntent: intent })).job;
  const run = (await root.connection.request("cron_job", { action: "run", selector: job.jobId })).run;
  await eventually(() => cron.getRun(run.runId).status === "running"); root.busy();
  if (origin === "cron") { await delay(15); createdAt = new Date().toISOString(); }
  if (intent === "conditional") await root.connection.request("cron_job", { action: "report", runId: run.runId, disposition: "no_finding" });
  else cron.finishRun(run.runId, "completed", { output: "quiet" });
  root.idle(); await delay(150);
  const before = (await list()).filter(n => n.kind === "idle").length;
  const id = "bg-0123456789ab", directory = path.join(f.dir, "jobs", id); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "meta.json"), JSON.stringify({ schema: "background.job.v1", id, name: "causal fixture", kind: "launched", session_id: root.session.sessionId, created_at: createdAt }));
  await writeFile(path.join(directory, "exit.json"), JSON.stringify({ exit_code: 0, signal: null, ended_at: new Date().toISOString() }));
  await eventually(() => f.supervisor.store.getActorInput(`background-completion-${id}`, root.session.sessionId));
  root.busy(); root.idle(); await delay(160);
  assert.equal((await list()).filter(n => n.kind === "idle").length, before + (origin === "user" ? 1 : 0));
  assert.equal(cron.listRuns(job.jobId).length, 1);
  // Actual Commander admission must still win after a cron-owned continuation.
  await f.client.request("submit_input", { sessionId: root.session.sessionId, message: "New user task", behavior: "follow_up" });
  root.busy(); root.idle(); await delay(160);
  assert.equal((await list()).filter(n => n.kind === "idle").length, before + (origin === "user" ? 2 : 1));
});

for (const intent of ["result", "conditional"]) test(`delegated ${intent} cron does not finalize at parent settlement before descendant result`, async t => {
  let messages = [], inputEntries = {};
  const f = await fixture(t, { maxDepth: 2, transcriptReader: { read: async () => ({ messages, inputEntries }) } });
  const root = await f.actor(), child = await f.actor(root.session.sessionId), grandchild = await f.actor(child.session.sessionId);
  const cron = new CronStore(path.join(f.dir, "state/h.sqlite")); t.after(() => cron.close());
  const job = (await root.connection.request("cron_job", { action: "create", name: "Delegated check", prompt: "Check", schedule: { kind: "every", intervalSeconds: 600 }, executionMode: "origin", notificationIntent: intent })).job;
  const run = (await root.connection.request("cron_job", { action: "run", selector: job.jobId })).run;
  await eventually(() => cron.getRun(run.runId).status === "running");
  inputEntries[cron.getRun(run.runId).inputId] = "scheduled";
  messages = [{ id: "scheduled", role: "scheduled_job", text: "task" }, { id: "interim", role: "assistant", text: "I delegated the check, still working" }];
  root.busy(); grandchild.busy(); root.idle(); await delay(180);
  assert.equal(cron.getRun(run.runId).status, "running"); assert.equal((await f.client.request("list_notifications")).notifications.length, 0);
  grandchild.idle(); await delay(20); root.busy();
  messages.push({ id: "final", role: "assistant", text: "The genuine final result" });
  if (intent === "conditional") {
    child.busy(); // Explicit readiness is independent of unrelated live family work.
    await root.connection.request("cron_job", { action: "report", runId: run.runId, disposition: "deliver", body: "The genuine final result" });
    assert.equal(cron.getRun(run.runId).status, "completed");
  }
  root.idle();
  await eventually(() => cron.getRun(run.runId).status === "completed");
  const notice = await eventually(async () => (await f.client.request("list_notifications")).notifications.find(n => n.kind === "cron"));
  assert.equal(notice.body, "The genuine final result"); assert.equal(notice.source.failed, false);
  child.idle(); await delay(160); assert.equal((await f.client.request("list_notifications")).notifications.length, 1);
});
