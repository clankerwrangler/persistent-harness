import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";

const launch = (name, prompt = null) => ({
  name,
  prompt,
  model: { resolved: { provider: "fake", id: "model" } },
  thinking: { resolved: "off" },
  capabilities: [],
  skillCatalog: [],
});

test("one actor table owns root and child lifecycle, recovery, activity, and routing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-actor-store-"));
  const databasePath = path.join(dir, "store.sqlite");
  const store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const root = store.createRoot({
    sessionId: "root-a", sessionFile: "/sessions/root-a.jsonl", cwd: "/workspace",
    repositoryRoot: "/workspace", name: "root-a", actorToken: "root-token", launch: launch("root-a"),
  }, 1).session;
  assert.equal(root.kind, "root");
  assert.equal(root.lifecycle, "starting");
  assert.equal(root.actorGeneration, 1);

  const admitted = store.createChild("root-a", {
    sessionId: "child-a", sessionFile: "/sessions/child-a.jsonl", actorToken: "child-token",
    policy: { ...launch("child-a", "do work"), cwd: "/workspace", repositoryRoot: "/workspace", depth: 1 }, now: 2,
  });
  assert.equal(admitted.session.parentSessionId, "root-a");
  assert.equal(admitted.task.state, "queued");
  assert.deepEqual(store.listQueuedActorIds(), ["root-a", "child-a"]);

  assert.throws(() => store.registerActor({
    sessionId: "child-a", actorToken: "stale", actorGeneration: 1,
  }), /stale/);
  store.registerActor({
    sessionId: "child-a", actorToken: "child-token", actorGeneration: 1,
    sessionFile: "/sessions/child-a.jsonl", cwd: "/workspace", repositoryRoot: "/workspace",
  }, 3);
  store.markActorStarted("root-a", 1, { pid: 101, processIdentity: { startTime: 1 } }, 4);
  store.markActorStarted("child-a", 1, { pid: 102, processIdentity: { startTime: 2 } }, 4);
  store.setActorActivity("child-a", 1, true, 5);
  assert.equal(store.getSession("root-a").activity, "delegating");
  assert.equal(store.getSession("root-a").workingDescendantCount, 1);
  assert.equal(store.getSession("root-a").quietSince, 4);
  assert.equal(store.findIdleResidentActor()?.sessionId, "root-a", "own-idle parent remains a capacity candidate");
  store.setActorActivity("root-a", 1, false, 6);
  assert.equal(store.getSession("root-a").quietSince, 4, "repeated settled updates retain own age");
  assert.equal(store.findIdleResidentActor(null, { excludeIds: ["root-a"] }), undefined);

  const first = store.createMessage("root-a", {
    messageId: "durable-id", target: "child-a", deliveryMode: "auto", body: "hello",
  }, { now: 6 });
  const duplicate = store.createMessage("root-a", {
    messageId: "durable-id", target: "child-a", deliveryMode: "auto", body: "hello",
  }, { now: 7 });
  assert.deepEqual(duplicate, first);
  assert.equal(first.deliveryMode, "auto");
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.prepare("UPDATE messages SET delivery_mode = 'follow_up' WHERE id = ?").run(first.messageId);
  legacyDb.close();
  const legacy = store.getMessage(first.messageId);
  for (const deliveryMode of [undefined, "auto", "follow_up"]) {
    assert.deepEqual(store.createMessage("root-a", { messageId: first.messageId,
      target: "child-a", body: "hello", deliveryMode }), legacy, "a legacy receipt retries without rewriting its mode or identity");
  }
  assert.throws(() => store.createMessage("root-a", { messageId: first.messageId,
    target: "child-a", body: "changed" }), /different content/);
  assert.throws(() => store.createMessage("child-a", { messageId: first.messageId,
    target: "root-a", body: "hello" }), /different content/);
  assert.throws(() => store.createMessage("root-a", { messageId: first.messageId,
    target: "child-a", body: "hello", deliveryMode: "later" }), /delivery mode/);

  assert.equal(first.state, "accepted"); assert.equal(first.senderEntryId, null);
  assert.deepEqual(store.listMessagesAwaitingSenderEntry("root-a").map((message) => message.messageId), ["durable-id"]);
  assert.deepEqual(store.listPendingMessages("child-a"), []);
  const recordedMessage = store.recordMessageSenderEntry("root-a", { messageId: "durable-id", entryId: "entry-1",
    peerId: "child-a", relationship: "child", body: "hello" }, 8);
  assert.equal(recordedMessage.newlyQueued, true); assert.equal(recordedMessage.message.state, "queued");
  assert.equal(recordedMessage.message.senderEntryId, "entry-1");
  assert.equal(store.recordMessageSenderEntry("root-a", { messageId: "durable-id", entryId: "entry-1",
    peerId: "child-a", relationship: "child", body: "hello" }, 9).newlyQueued, false);
  assert.throws(() => store.recordMessageSenderEntry("root-a", { messageId: "durable-id", entryId: "other",
    peerId: "child-a", relationship: "child", body: "hello" }), /different transcript entry/);
  assert.deepEqual(store.listMessagesAwaitingSenderEntry("root-a"), []);
  assert.equal(store.listPendingMessages("child-a")[0].messageId, "durable-id");
  const deliveredOnce = store.markMessageDelivered("durable-id", "child-a", 10);
  const deliveredAgain = store.markMessageDelivered("durable-id", "child-a", 11);
  assert.equal(deliveredAgain.attemptCount, deliveredOnce.attemptCount);
  assert.equal(deliveredAgain.deliveredAt, deliveredOnce.deliveredAt);
  assert.equal(store.listMessages().length, 1);

  const queuedInput = store.createActorInput("root-a", { inputId: "input-1", message: "queued user work", behavior: "follow_up" }, 7);
  assert.equal(queuedInput.state, "queued");
  assert.equal(store.findIdleResidentActor(), undefined, "durable own input excludes the otherwise idle parent");
  assert.deepEqual(store.createActorInput("root-a", { inputId: "input-1", message: "queued user work", behavior: "follow_up" }, 8), queuedInput);
  assert.throws(() => store.createActorInput("root-a", { inputId: "input-1", message: "different", behavior: "follow_up" }, 8), /reused/);
  store.markActorInputAccepted("input-1", "root-a", 1, 7);
  assert.equal(store.listPendingActorInputs("root-a")[0].acceptedGeneration, 1);

  const previous = store.reconcileAfterDaemonStart(8);
  assert.deepEqual(previous.map((item) => item.sessionId).sort(), ["child-a", "root-a"]);
  assert.deepEqual(store.listQueuedActorIds(), ["root-a", "child-a"]);
  assert.equal(store.getSession("root-a").actorGeneration, 2);
  assert.equal(store.getSession("child-a").activity, "inactive");
  assert.equal(store.listPendingActorInputs("root-a")[0].acceptedGeneration, 1);
  assert.equal(store.completeActorInput("input-1", "root-a"), true);
  assert.equal(store.createActorInput("root-a", { inputId: "input-1", message: "queued user work", behavior: "follow_up" }, 9).state, "completed");
  assert.throws(() => store.createActorInput("root-a", { inputId: "input-1", message: "different", behavior: "follow_up" }, 9), /reused/);
  assert.throws(() => store.createActorInput("root-a", { inputId: "too-large", message: "two bytes", pendingBytesLimit: 1 }, 9), /byte limit/);

  const db = new DatabaseSync(databasePath, { readOnly: true });
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  const childColumns = db.prepare("PRAGMA table_info(children)").all().map((row) => row.name);
  const inputColumns = db.prepare("PRAGMA table_info(actor_inputs)").all().map((row) => row.name);
  const receipt = db.prepare("SELECT digest FROM actor_input_receipts WHERE id = 'input-1'").get();
  const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((row) => row.name);
  const messageEntryIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'message_sender_entries'").get();
  db.close();
  assert.deepEqual(childColumns, ["session_id"]);
  assert(inputColumns.includes("images_json")); assert(inputColumns.includes("digest")); assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert(messageColumns.includes("sender_entry_id")); assert.equal(messageEntryIndex.name, "message_sender_entries");
  for (const forbidden of ["artifact_dir", "client_instance_id", "connected_at", "disconnected_at", "worker_pid", "worker_generation"]) {
    assert.equal(sessionColumns.includes(forbidden), false, forbidden);
  }
  for (const required of ["lifecycle", "actor_token", "actor_generation", "actor_pid", "actor_identity_json", "launch_json", "quiet_since"]) {
    assert.equal(sessionColumns.includes(required), true, required);
  }
});


test("bounded navigator selection keeps relevant family context and newest fresh roots", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-navigator-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const rootParams = (sessionId, name, now) => ({ sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/workspace",
    repositoryRoot: "/workspace", name, actorToken: `token-${sessionId}`, launch: launch(name), now });

  store.createRoot(rootParams("old-family-root", "Old family", 1));
  store.markActorLifecycle("old-family-root", 1, "stopped", null, 2);
  for (let index = 0; index < 20; index += 1) {
    const sessionId = `old-child-${index}`;
    store.createChild("old-family-root", { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, actorToken: `token-${sessionId}`,
      policy: { ...launch(`Old child ${index}`, "retained work"), cwd: "/workspace", repositoryRoot: "/workspace", depth: 1 }, now: 3 + index });
    store.markActorLifecycle(sessionId, 1, "stopped", null, 30 + index);
  }
  store.prepareActorRevival("old-child-0", "active-child-token", 60, { force: true });
  store.markActorStarted("old-child-0", 2, { pid: 101 }, 61);
  store.setActorActivity("old-child-0", 2, true, 62);

  for (let index = 0; index < 520; index += 1) {
    const sessionId = `cron-fresh-${String(index).padStart(3, "0")}`;
    store.createRoot(rootParams(sessionId, `Cron fresh ${index}`, 100 + index));
    store.markActorLifecycle(sessionId, 1, "stopped", null, 1000 + index);
  }
  const totalBefore = store.listSessions().length;
  assert.equal(totalBefore, 541, "fresh scheduling growth must retain every root and child transcript record");

  const first = store.listNavigatorSessions(); const second = store.listNavigatorSessions();
  assert.equal(first.sessions.length, 512); assert.equal(first.total, 541); assert.equal(first.truncated, true);
  assert.deepEqual(second.sessions.map((item) => item.sessionId), first.sessions.map((item) => item.sessionId), "selection and presentation order must be stable");
  assert.equal(first.work.newestReserve, 64);
  for (let index = 456; index < 520; index += 1) assert(first.sessions.some((item) => item.sessionId === `cron-fresh-${String(index).padStart(3, "0")}`),
    `reserved newest fresh cron root ${index} must remain reachable`);
  assert(first.sessions.some((item) => item.sessionId === "old-child-0" && item.activity === "working"), "an old active session must remain reachable");
  for (let index = 0; index < 20; index += 1) assert(first.sessions.some((item) => item.sessionId === `old-child-${index}`),
    `old child ${index} with pending durable work must remain reachable`);
  const parent = first.sessions.find((item) => item.sessionId === "old-family-root");
  assert(parent, "the active child's parent context must be retained");
  assert.equal(parent.workingDescendantCount, 1); assert.equal(first.sessions.find((item) => item.sessionId === "old-child-0").lineage, "Old family/Old child 0");
  assert(first.sessions.every((item, index, all) => index === 0 || all[index - 1].createdAt < item.createdAt
    || all[index - 1].createdAt === item.createdAt && all[index - 1].sessionId.localeCompare(item.sessionId) <= 0), "returned navigator order must be deterministic chronological order");
  assert(first.work.queryCount <= 5); assert(first.work.priorityRows <= 512); assert(first.work.newestRows <= 512);
  assert(first.work.candidateRows <= 1024); assert(first.work.mappedRows <= 512);
  assert.equal(store.listSessions().length, totalBefore, "selection must never archive or delete canonical sessions");
});

test("descendant skill grants refresh within the immediate parent's current grant", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-skill-grant-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const alpha = { id: "alpha", version: "1", contentHash: "a".repeat(64), skillPath: "/skills/alpha/SKILL.md", pythonBacked: false };
  const beta = { id: "beta", version: "2", contentHash: "b".repeat(64), skillPath: "/skills/beta/SKILL.md", pythonBacked: true };
  const rogue = { id: "rogue", version: "1", contentHash: "c".repeat(64), skillPath: "/skills/rogue/SKILL.md", pythonBacked: false };
  store.createRoot({ sessionId: "grant-root", sessionFile: "/sessions/grant-root.jsonl", cwd: "/workspace",
    repositoryRoot: "/workspace", name: "grant-root", actorToken: "root-token", launch: launch("grant-root") }, 1);
  store.setSessionSkillGrant("grant-root", [alpha], 2);
  store.createChild("grant-root", { sessionId: "grant-child", sessionFile: "/sessions/grant-child.jsonl", actorToken: "child-token",
    policy: { ...launch("grant-child", "work"), skillCatalog: [alpha], cwd: "/workspace", repositoryRoot: "/workspace", depth: 1 }, now: 3 });
  store.setSessionSkillGrant("grant-child", [alpha], 4);

  store.setSessionSkillGrant("grant-root", [alpha, beta], 5);
  assert.deepEqual(store.setSessionSkillGrant("grant-child", [alpha, beta], 6).skills, [alpha, beta]);
  assert.throws(() => store.setSessionSkillGrant("grant-child", [alpha, beta, rogue], 7), /exceeds or differs from immediate parent/);

  store.setSessionSkillGrant("grant-root", [alpha], 8);
  assert.throws(() => store.setSessionSkillGrant("grant-child", [alpha, beta], 9), /exceeds or differs from immediate parent/);
  assert.deepEqual(store.setSessionSkillGrant("grant-child", [alpha], 10).skills, [alpha]);
});


test("resolved default inference becomes durable session launch metadata", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-resolved-inference-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "root", sessionFile: "/sessions/root.jsonl", cwd: "/workspace", repositoryRoot: null,
    name: "root", actorToken: "token", launch: { model: null,
      thinking: { requested: null, resolved: null, source: "settings" }, capabilities: [] } }, 1);
  const resolved = store.recordResolvedSessionInference("root", 1,
    { provider: "safe", model: "default", thinkingLevel: "xhigh" }, 2);
  assert.deepEqual(resolved.launch.model, { requested: null, resolved: { provider: "safe", id: "default" }, source: "settings" });
  assert.deepEqual(resolved.launch.thinking, { requested: null, resolved: "xhigh", source: "settings" });
  assert.deepEqual(store.recordResolvedSessionInference("root", 1,
    { provider: "safe", model: "default", thinkingLevel: "xhigh" }, 3).launch, resolved.launch);
  assert.throws(() => store.recordResolvedSessionInference("root", 1,
    { provider: "safe", model: "other", thinkingLevel: "xhigh" }), /differs from its launch policy/);
  assert.throws(() => store.recordResolvedSessionInference("root", 2,
    { provider: "safe", model: "default", thinkingLevel: "xhigh" }), /generation does not own/);
});

test("session inference policy and telemetry are durable and session-scoped", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-inference-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const original = { ...launch("root"), fastMode: false, prompt: "preserve me", capabilities: [{ id: "files" }] };
  store.createRoot({ sessionId: "root", sessionFile: "/sessions/root.jsonl", cwd: "/workspace", repositoryRoot: null,
    name: "root", actorToken: "token", launch: original }, 1);
  assert.equal(store.hasPendingSessionWork("root"), false);
  store.recordContextUsage("root", { tokens: 4000, contextWindow: 100000, percent: 4 }, 1);
  const updated = store.updateSessionInference("root", { provider: "safe", model: "next", thinkingLevel: "high", contextWindow: 200000 }, original, 2);
  assert.equal(updated.launch.prompt, "preserve me"); assert.deepEqual(updated.launch.capabilities, [{ id: "files" }]);
  assert.deepEqual(updated.launch.model.resolved, { provider: "safe", id: "next" }); assert.equal(updated.launch.thinking.resolved, "high");
  assert.deepEqual(store.getSessionTelemetry("root").context, { tokens: null, contextWindow: 200000, percent: null });
  assert.throws(() => store.updateSessionInference("root", { provider: "safe", model: "other", thinkingLevel: "off" }, original), /concurrently/);
  store.recordUsage("root", { entryId: "u1", provider: "safe", model: "next", input: 10, output: 5,
    cacheRead: 30, cacheWrite: 10, reasoning: 2, totalTokens: 55, costTotal: 0.1 }, 3);
  store.recordUsage("root", { entryId: "u2", provider: "safe", model: "next", input: 20, output: 8,
    cacheRead: 20, cacheWrite: 0, reasoning: 3, totalTokens: 48, costTotal: 0.2 }, 4);
  assert.equal(store.recordUsage("root", { entryId: "u2", provider: "safe", model: "next", input: 999, output: 0,
    cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 999, costTotal: 1 }, 5).recorded, false);
  store.recordContextUsage("root", { tokens: 1200, contextWindow: 200000, percent: 0.6 }, 6);
  const telemetry = store.getSessionTelemetry("root");
  assert.deepEqual({ entries: telemetry.session.entries, input: telemetry.session.input, output: telemetry.session.output,
    reasoning: telemetry.session.reasoning, totalTokens: telemetry.session.totalTokens }, { entries: 2, input: 30, output: 13, reasoning: 5, totalTokens: 103 });
  assert.equal(telemetry.session.cacheHitRatio, 50 / 90); assert.equal(telemetry.latestTurn.provider, "safe"); assert.equal(telemetry.latestTurn.model, "next"); assert.equal(Object.hasOwn(telemetry.latestTurn, "entryId"), false);
  assert.equal(telemetry.latestTurn.cacheHitRatio, 0.5); assert.equal(Object.hasOwn(telemetry.session, "costTotal"), false); assert.equal(Object.hasOwn(telemetry.latestTurn, "costTotal"), false); assert.deepEqual(telemetry.context, { tokens: 1200, contextWindow: 200000, percent: 0.6 });
  const input = store.createActorInput("root", { inputId: "pending", message: "work", behavior: "auto" }, 7);
  assert.equal(store.hasPendingSessionWork("root"), true); store.completeActorInput(input.inputId, "root", 8);
  assert.equal(store.hasPendingSessionWork("root"), false);
});


test("child creation history is independently durable and idempotent", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-history-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "parent", sessionFile: "/sessions/parent.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "parent", actorToken: "parent-token", launch: launch("parent") }, 1);
  const admitted = store.createChild("parent", { sessionId: "child", sessionFile: "/sessions/child.jsonl", actorToken: "child-token",
    policy: { ...launch("created-name", "exact initial task"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 2 });
  assert.equal(admitted.task.historyPeerName, "created-name"); assert.equal(admitted.task.historyEntryId, null);
  assert.deepEqual(store.listPendingChildCreationHistory("parent"), [{ taskId: admitted.task.taskId, childId: "child",
    childName: "created-name", relationship: "child", body: "exact initial task", createdAt: 2 }]);
  const first = store.recordChildCreationEntry("parent", { taskId: admitted.task.taskId, childId: "child", childName: "created-name",
    relationship: "child", entryId: "entry-1", body: "exact initial task" }, 3);
  assert.equal(first.newlyRecorded, true); assert.equal(first.task.historyEntryId, "entry-1");
  assert.equal(store.recordChildCreationEntry("parent", { taskId: admitted.task.taskId, childId: "child", childName: "created-name",
    relationship: "child", entryId: "entry-1", body: "exact initial task" }, 4).newlyRecorded, false);
  assert.deepEqual(store.listPendingChildCreationHistory("parent"), []);
  assert.throws(() => store.recordChildCreationEntry("parent", { taskId: admitted.task.taskId, childId: "child", childName: "created-name",
    relationship: "child", entryId: "entry-2", body: "exact initial task" }), /different transcript entry/);
  assert.throws(() => store.recordChildCreationEntry("parent", { taskId: admitted.task.taskId, childId: "child", childName: "created-name",
    relationship: "child", entryId: "entry-1", body: "changed" }), /does not match/);
  assert.equal(store.listMessages().length, 0);
});


test("schema-2 startup preserves genuinely pending child history receipts", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-history-restart-"));
  const databasePath = path.join(dir, "store.sqlite");
  let store = new HarnessStore(databasePath);
  store.createRoot({ sessionId: "parent", sessionFile: "/sessions/parent.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "parent", actorToken: "parent-token", launch: launch("parent") }, 1);
  const admitted = store.createChild("parent", { sessionId: "child", sessionFile: "/sessions/child.jsonl", actorToken: "child-token",
    policy: { ...launch("reviewer", "pending task"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 2 });
  store.close(); store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.getChildTask(admitted.task.taskId).historyEntryId, null);
  assert.equal(store.listPendingChildCreationHistory("parent")[0].body, "pending task");
  store.deleteChild("parent", "child");
  assert.equal(store.listPendingChildCreationHistory("parent")[0].childName, "reviewer");
});


test("deleting a child terminalizes undeliverable messages and its unfinished task", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-delete-work-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "parent", sessionFile: "/sessions/parent.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "parent", actorToken: "parent-token", launch: launch("parent") }, 1);
  const admitted = store.createChild("parent", { sessionId: "child", sessionFile: "/sessions/child.jsonl", actorToken: "child-token",
    policy: { ...launch("child", "unfinished task"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 2 });
  const incoming = store.createMessage("parent", { target: "child", body: "queued steer", deliveryMode: "auto" }, { now: 3 });
  store.recordMessageSenderEntry("parent", { messageId: incoming.messageId, entryId: "incoming-entry", peerId: "child",
    relationship: "child", body: "queued steer" }, 4);
  const outgoing = store.createMessage("child", { target: "parent", body: "unrecorded reply", deliveryMode: "auto" }, { now: 5 });

  store.deleteChild("parent", "child", 6);
  assert.deepEqual({ state: store.getMessage(incoming.messageId).state, error: store.getMessage(incoming.messageId).lastError },
    { state: "rejected", error: "target session was deleted" });
  assert.deepEqual({ state: store.getMessage(outgoing.messageId).state, error: store.getMessage(outgoing.messageId).lastError },
    { state: "rejected", error: "sender session was deleted before its transcript entry was recorded" });
  assert.deepEqual({ state: store.getChildTask(admitted.task.taskId).state, error: store.getChildTask(admitted.task.taskId).error },
    { state: "failed", error: "child session was deleted before its task completed" });
  assert.deepEqual(store.listPendingMessages("child"), []);
  assert.equal(store.listPendingChildCreationHistory("parent")[0].body, "unfinished task",
    "historical child-creation projection must survive task terminalization");
  assert.deepEqual(store.diagnose(), []);
});


test("schema-2 startup repairs legacy queued work that targets a deleted child", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-deleted-work-repair-"));
  const databasePath = path.join(dir, "store.sqlite");
  let store = new HarnessStore(databasePath);
  store.createRoot({ sessionId: "parent", sessionFile: "/sessions/parent.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "parent", actorToken: "parent-token", launch: launch("parent") }, 1);
  const admitted = store.createChild("parent", { sessionId: "child", sessionFile: "/sessions/child.jsonl", actorToken: "child-token",
    policy: { ...launch("child", "legacy task"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 2 });
  const message = store.createMessage("parent", { target: "child", body: "legacy queued steer", deliveryMode: "auto" }, { now: 3 });
  store.recordMessageSenderEntry("parent", { messageId: message.messageId, entryId: "legacy-entry", peerId: "child",
    relationship: "child", body: "legacy queued steer" }, 4);
  store.close();
  const raw = new DatabaseSync(databasePath);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.prepare("UPDATE sessions SET lifecycle = 'deleted', activity = 'inactive', streaming = 0, deleted_at = 5 WHERE id = 'child'").run();
  raw.close();

  store = new HarnessStore(databasePath);
  store.reconcileAfterDaemonStart(6);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.getMessage(message.messageId).state, "rejected");
  assert.equal(store.getMessage(message.messageId).lastError, "target session was deleted");
  assert.equal(store.getChildTask(admitted.task.taskId).state, "failed");
  assert.equal(store.getChildTask(admitted.task.taskId).error, "child session was deleted before its task completed");
  assert.deepEqual(store.diagnose(), []);
});


test("searchable session sources follow family reach and require explicit deleted/self access", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-search-sources-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "root-a", sessionFile: "/sessions/root-a.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "root-a", actorToken: "a", launch: launch("root-a") }, 1);
  store.createRoot({ sessionId: "root-b", sessionFile: "/sessions/root-b.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "root-b", actorToken: "b", launch: launch("root-b") }, 2);
  store.createChild("root-a", { sessionId: "child-a", sessionFile: "/sessions/child-a.jsonl", actorToken: "c",
    policy: { ...launch("child-a", "task"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 3 });

  const assertHistoryProjection = (callerId, options = {}) => {
    const expected = store.listSearchableSessions(callerId, options).map((session) => {
      const copy = structuredClone(session);
      if (copy.launch) { delete copy.launch.fastMode; delete copy.launch.fastModeRootSessionId; }
      return copy;
    });
    const originalFast = store.getSessionFastModePreference;
    let fastReads = 0, projected;
    store.getSessionFastModePreference = function (...args) { fastReads += 1; return originalFast.apply(this, args); };
    try { projected = store.listSearchableSessions(callerId, { ...options, includeFastMode: false }); }
    finally { store.getSessionFastModePreference = originalFast; }
    assert.equal(fastReads, 0, "history metadata does not resolve unused Fast preferences");
    assert.deepEqual(projected, expected, "only the unused derived Fast fields may be omitted");
  };
  assertHistoryProjection("root-a");
  assertHistoryProjection("child-a", { includeSelf: true });

  assert.deepEqual(store.listSearchableSessions("root-a").map((session) => session.sessionId), ["child-a", "root-b"]);
  assert.deepEqual(store.listSearchableSessions("root-a", { includeSelf: true }).map((session) => session.sessionId),
    ["child-a", "root-b", "root-a"]);
  assert.deepEqual(store.listSearchableSessions("child-a").map((session) => session.sessionId), ["root-b", "root-a"],
    "same workspace family must see sibling/--workspace-- roots, not only the direct parent");
  store.deleteChild("root-a", "child-a", 4); store.deleteSession("root-b", 5);
  assert.deepEqual(store.listSearchableSessions("root-a"), []);
  assertHistoryProjection("root-a", { includeDeleted: true });
  const deletedBeforeRepeat = store.listSearchableSessions("root-a", { includeDeleted: true });
  assert.deepEqual(deletedBeforeRepeat.map((session) => session.sessionId), ["root-b", "child-a"]);
  assert(deletedBeforeRepeat.every((session) => session.lifecycle === "deleted" && session.sessionFile));
  assert.deepEqual(deletedBeforeRepeat.map((session) => session.name), ["root-b", "child-a"]);
  assert.match(deletedBeforeRepeat.find((session) => session.sessionId === "child-a").lineage, /^root-a\//);

  const repeatedRootDeletion = store.deleteSession("root-b", 6);
  assert.equal(repeatedRootDeletion.lifecycle, "deleted");
  assertHistoryProjection("root-a", { includeDeleted: true, includeSelf: true });
  const deletedAfterRepeat = store.listSearchableSessions("root-a", { includeDeleted: true });
  assert.deepEqual(deletedAfterRepeat, deletedBeforeRepeat, "repeat root deletion must not change historical name or lineage");
  assert.equal(store.getSession("root-b").name, repeatedRootDeletion.name);
});


const usagePrecision = (overrides = {}) => ({
  safeMaximum: Number.MAX_SAFE_INTEGER,
  saturated: {
    entries: false, sessions: false, inputTokens: false, outputTokens: false,
    cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false,
    totalTokens: false, estimatedCost: false, ...overrides,
  },
});

test("recent usage aggregation is inclusive, sanitized, and grouped by model", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-usage-window-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ["one", "two"]) store.createRoot({ sessionId: id, sessionFile: `/sessions/${id}.jsonl`, cwd: "/workspace",
    repositoryRoot: null, name: id, actorToken: `token-${id}`, launch: launch(id) }, 1);
  const usage = (entryId, provider, model, input, output, cacheRead, cacheWrite, reasoning, costTotal) => ({
    entryId, provider, model, input, output, cacheRead, cacheWrite, reasoning,
    totalTokens: input + output + cacheRead + cacheWrite, costTotal,
  });
  store.recordUsage("one", usage("old-private-entry", "p", "outside", 99, 1, 0, 0, 0, 9), 939_999);
  store.recordUsage("one", usage("boundary-private-entry", "p", "alpha", 10, 4, 3, 2, 1, 0.1), 940_000);
  store.recordUsage("two", usage("middle-private-entry", "p", "alpha", 5, 2, 1, 0, 2, 0.2), 970_000);
  store.recordUsage("one", usage("end-private-entry", "q", "beta", 7, 3, 0, 4, 2, 0.3), 1_000_000);

  const result = store.getUsageWindow(1, 1_000_000);
  assert.deepEqual(result.window, { minutes: 1, since: 940_000, observedAt: 1_000_000, boundaries: "inclusive" });
  assert.deepEqual(result.aggregate, { entries: 3, sessions: 2, inputTokens: 22, outputTokens: 9,
    cacheReadTokens: 4, cacheWriteTokens: 6, reasoningTokens: 5, totalTokens: 41, estimatedCost: 0.6,
    precision: usagePrecision() });
  assert.deepEqual(result.byModel, [
    { provider: "p", model: "alpha", entries: 2, sessions: 2, inputTokens: 15, outputTokens: 6,
      cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 27, estimatedCost: 0.30000000000000004,
      precision: usagePrecision() },
    { provider: "q", model: "beta", entries: 1, sessions: 1, inputTokens: 7, outputTokens: 3,
      cacheReadTokens: 0, cacheWriteTokens: 4, reasoningTokens: 2, totalTokens: 14, estimatedCost: 0.3,
      precision: usagePrecision() },
  ]);
  assert.equal(result.byModelTruncated, false);
  assert.doesNotMatch(JSON.stringify(result), /private-entry|token-one|token-two|sessionFile|prompt|body/i);
  for (let index = 0; index < 65; index += 1) {
    store.recordUsage("one", usage(`bounded-${index}`, "many", `model-${String(index).padStart(2, "0")}`, 1, 0, 0, 0, 0, 0), 980_000);
  }
  const bounded = store.getUsageWindow(1, 1_000_000);
  assert.equal(bounded.byModel.length, 64);
  assert.equal(bounded.byModelTruncated, true);
  assert.equal(bounded.aggregate.entries, 68, "the aggregate remains exact when per-model output is truncated");
  assert.deepEqual(bounded.aggregate.precision, usagePrecision());
  assert.ok(bounded.byModel.every((row) => JSON.stringify(row.precision) === JSON.stringify(usagePrecision())),
    "every returned truncated-model row carries the fixed precision contract");
  assert.throws(() => store.getUsageWindow(10_081, 1_000_000), /1 through 10080/);
});


test("recent usage aggregation saturates every overflowing token total without SQLite integer overflow", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-usage-window-overflow-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "overflow", sessionFile: "/sessions/overflow.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "overflow", actorToken: "overflow-token", launch: launch("overflow") }, 1);
  const maximum = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < 1_025; index += 1) {
    store.recordUsage("overflow", {
      entryId: `overflow-${index}`, provider: "provider", model: "huge", input: maximum, output: maximum,
      cacheRead: maximum, cacheWrite: maximum, reasoning: maximum, totalTokens: maximum, costTotal: 1_000_000_000,
    }, 1_000_000);
  }

  const result = store.getUsageWindow(1, 1_000_000);
  const tokenSaturation = {
    inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true,
    reasoningTokens: true, totalTokens: true,
  };
  assert.deepEqual(result.aggregate, {
    entries: 1_025, sessions: 1, inputTokens: maximum, outputTokens: maximum,
    cacheReadTokens: maximum, cacheWriteTokens: maximum, reasoningTokens: maximum,
    totalTokens: maximum, estimatedCost: 1_025_000_000_000,
    precision: usagePrecision(tokenSaturation),
  });
  assert.deepEqual(result.byModel, [{
    provider: "provider", model: "huge", entries: 1_025, sessions: 1,
    inputTokens: maximum, outputTokens: maximum, cacheReadTokens: maximum,
    cacheWriteTokens: maximum, reasoningTokens: maximum, totalTokens: maximum,
    estimatedCost: 1_025_000_000_000, precision: usagePrecision(tokenSaturation),
  }]);
  assert.equal(result.byModelTruncated, false);

  // The database schema admits larger historical REAL values than current protocol telemetry.
  // They follow the same finite cap rather than emitting Infinity or an unsafe JSON number.
  store.recordUsage("overflow", {
    entryId: "cost-overflow", provider: "provider", model: "cost", input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: maximum,
  }, 1_000_000);
  store.recordUsage("overflow", {
    entryId: "cost-overflow-two", provider: "provider", model: "cost", input: 0, output: 0,
    cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: maximum,
  }, 1_000_000);
  const withCostOverflow = store.getUsageWindow(1, 1_000_000);
  assert.equal(withCostOverflow.aggregate.estimatedCost, maximum);
  assert.equal(withCostOverflow.aggregate.precision.saturated.estimatedCost, true);
  const costRow = withCostOverflow.byModel.find((row) => row.model === "cost");
  assert.equal(costRow.estimatedCost, maximum);
  assert.equal(costRow.precision.saturated.estimatedCost, true);
});

test("default-named roots take an assigned title and keep user names", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-root-title-store-"));
  const store = new HarnessStore(path.join(dir, "store.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const unnamed = store.createRoot({
    sessionId: "untitled", sessionFile: "/sessions/untitled.jsonl", cwd: "/workspace",
    repositoryRoot: null, actorToken: "untitled-token", launch: launch("untitled"),
  }, 1).session;
  assert.match(unnamed.name, /^workspace-[0-9a-f]{8}$/);

  const named = store.autoNameDefaultRoot("untitled", "Depth 0 Sessions to Be Renamed Automatically");
  assert.equal(named.renamed, true);
  assert.equal(named.session.name, "Depth 0 Sessions to Be Renamed Automatically");

  const again = store.autoNameDefaultRoot("untitled", "A Later Prompt Must Not Steal the Title");
  assert.equal(again.renamed, false);
  assert.equal(again.session.name, "Depth 0 Sessions to Be Renamed Automatically");

  store.createRoot({
    sessionId: "named", sessionFile: "/sessions/named.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "Example 3D Avatar", actorToken: "named-token", launch: launch("named"),
  }, 2);
  const preserved = store.autoNameDefaultRoot("named", "This Must Stay the user Title");
  assert.equal(preserved.renamed, false);
  assert.equal(preserved.session.name, "Example 3D Avatar");

  const collision = store.createRoot({
    sessionId: "collision", sessionFile: "/sessions/collision.jsonl", cwd: "/workspace",
    repositoryRoot: null, actorToken: "collision-token", launch: launch("collision"),
  }, 3).session;
  const disambiguated = store.autoNameDefaultRoot("collision", "Depth 0 Sessions to Be Renamed Automatically");
  assert.equal(disambiguated.renamed, true);
  assert.equal(disambiguated.session.name, `Depth 0 Sessions to Be Renamed Automatically ${collision.shortId}`);

  const parent = store.createRoot({
    sessionId: "parent", sessionFile: "/sessions/parent.jsonl", cwd: "/workspace",
    repositoryRoot: null, name: "Parent", actorToken: "parent-token", launch: launch("parent"),
  }, 4).session;
  const child = store.createChild("parent", {
    sessionId: "child", sessionFile: "/sessions/child.jsonl", actorToken: "child-token",
    policy: { ...launch("child-name", "do work"), cwd: "/workspace", repositoryRoot: null, depth: 1 }, now: 5,
  }).session;
  const childResult = store.autoNameDefaultRoot("child", "This Must Not Rename a Child");
  assert.equal(childResult.renamed, false);
  assert.equal(store.getSession("child").name, "child-name");
  assert.equal(parent.name, "Parent");
});


test("child-exit receipts are atomic, generation-idempotent, private and restart-compatible", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-exit-store-"));
  const databasePath = path.join(dir, "store.sqlite"); let store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  for (const id of ["parent", "unrelated"]) store.createRoot({ sessionId: id, sessionFile: `/${id}.jsonl`, cwd: dir,
    name: `PRIVATE NAME ${id}`, actorToken: id, launch: {} });
  const addChild = (id, parent = "parent") => store.createChild(parent, { sessionId: id, sessionFile: `/${id}.jsonl`,
    actorToken: id, policy: { name: `PRIVATE CHILD ${id}`, depth: parent === "parent" ? 1 : 2, cwd: dir, prompt: "SECRET PROMPT" } });
  addChild("child"); addChild("grandchild", "child");
  const injection = new DatabaseSync(databasePath);
  injection.exec("CREATE TRIGGER deny_exit_receipt BEFORE INSERT ON messages WHEN NEW.child_exit_generation IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  assert.throws(() => store.markActorLifecycle("child", 1, "error", "private", 9, { reportChildExit: true }), /synthetic receipt failure/);
  assert.equal(store.getSession("child").lifecycle, "starting", "receipt and lifecycle commit atomically");
  injection.exec("DROP TRIGGER deny_exit_receipt"); injection.close();
  const fail = (id, generation = 1, error = "PRIVATE STDERR") => store.markActorLifecycle(id, generation, "error", error, 10, { reportChildExit: true });
  fail("child"); fail("child", 1, "different private stderr");
  let message = store.listPendingMessages("parent")[0];
  assert.equal(store.listMessages().length, 1);
  assert.equal(message.senderEntryId, null);
  assert.equal(message.state, "queued"); assert.equal(message.childExitGeneration, 1);
  assert.equal(message.relationship, "parent"); assert.match(message.body, /actor_exit/);
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE|SECRET/);
  assert.deepEqual(store.listMessagesAwaitingSenderEntry("child"), []);
  assert.equal(fail("child", 0), false);
  assert.throws(() => store.createMessage("child", { messageId: message.messageId, target: "parent", deliveryMode: "auto", body: message.body }), /reserved/);
  fail("grandchild");
  assert.equal(store.listPendingMessages("child")[0].senderId, "grandchild");
  assert.equal(store.listPendingMessages("parent").length, 1, "no grandparent reach");
  assert.deepEqual(store.listPendingMessages("unrelated"), []);
  store.close(); store = new HarnessStore(databasePath);
  assert.deepEqual(store.getMessage(message.messageId), message);
  store.markMessageDelivered(message.messageId, "parent", 20);
  store.close(); store = new HarnessStore(databasePath);
  assert.equal(store.getMessage(message.messageId).state, "delivered");
  store.acknowledgeMessage(message.messageId, "parent", 21);
  fail("child"); assert.equal(store.getMessage(message.messageId).state, "acknowledged");
  store.prepareActorRevival("child", "new-token", 22);
  fail("child", 2);
  assert.equal(store.listPendingMessages("parent").length, 1);
  assert.equal(store.listPendingMessages("parent")[0].childExitGeneration, 2);
  // Intentional transitions and stale failure callbacks after them are silent.
  for (const state of ["stopped", "passivated"]) {
    addChild(state); store.markActorLifecycle(state, 1, state);
    assert.equal(fail(state), false);
    assert.equal(store.listMessages().some(m => m.senderId === state), false);
  }
  // Root failure has no family recipient.
  fail("unrelated"); assert.equal(store.listMessages().some(m => m.senderId === "unrelated"), false);
  assert.deepEqual(store.diagnose(), []);
});

test("child-exit queue preserves unavailable parents and deletion fencing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-exit-deletion-"));
  const store = new HarnessStore(path.join(dir,"store.sqlite"));
  t.after(async () => { store.close(); await rm(dir,{recursive:true,force:true}); });
  store.createRoot({ sessionId:"parent", sessionFile:"/parent.jsonl",cwd:dir,name:"Parent",actorToken:"token",launch:{} });
  const add = id => store.createChild("parent", {sessionId:id,sessionFile:`/${id}.jsonl`,actorToken:id,policy:{name:id,depth:1,cwd:dir,prompt:"work"}});
  add("child");
  store.markActorLifecycle("parent",1,"stopped");
  store.markActorLifecycle("child",1,"error","secret",10,{reportChildExit:true});
  assert.equal(store.listPendingChildExitMessages().length,0);
  store.markActorLifecycle("parent",1,"error");
  assert.equal(store.listPendingChildExitMessages().length,0);
  store.markActorLifecycle("parent",1,"passivated");
  assert.equal(store.listPendingChildExitMessages().length,1);
  const message=store.listPendingChildExitMessages()[0];
  // A deleted parent must terminalize its outstanding receipt rather than wake.
  store.deleteSession("parent");
  assert.equal(store.getMessage(message.messageId).state,"rejected");
  assert.equal(store.listPendingChildExitMessages().length,0);
  assert.deepEqual(store.diagnose(),[]);
});


test("child-exit retry batches do not strand receipts behind unacknowledged messages", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-exit-batches-"));
  const store = new HarnessStore(path.join(dir,"store.sqlite"));
  t.after(async () => {store.close(); await rm(dir,{recursive:true,force:true});});
  store.createRoot({sessionId:"parent",sessionFile:"/parent.jsonl",cwd:dir,name:"Parent",actorToken:"t",launch:{}});
  for(let n=0;n<103;n++) {
    const id=`child-${n}`;
    store.createChild("parent",{sessionId:id,sessionFile:`/${id}.jsonl`,actorToken:id,policy:{name:id,depth:1,cwd:dir,prompt:"work"}});
    store.markActorLifecycle(id,1,"error","private",n,{reportChildExit:true});
  }
  const first=store.listPendingChildExitMessages(); assert.equal(first.length,100);
  for(const m of first) store.markMessageDelivered(m.messageId,"parent");
  const second=store.listPendingChildExitMessages(first.at(-1).messageId); assert.equal(second.length,3);
  assert.equal(new Set([...first,...second].map(m=>m.messageId)).size,103);
  assert.equal(store.listPendingChildExitMessages(second.at(-1).messageId).length,0);
  assert.equal(store.listPendingChildExitMessages().length,100,"a fresh scan retries earlier unacknowledged receipts");
});


test("local actor-state reads stay fresh without mapping family or launch metadata", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-local-state-"));
  const databasePath = path.join(dir, "store.sqlite"), store = new HarnessStore(databasePath), writer = new DatabaseSync(databasePath);
  t.after(async () => { writer.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const metadata = { ...launch("Root"), capabilities: [{ id: "large-unused", description: "x".repeat(8192) }] };
  store.createRoot({ sessionId: "root", sessionFile: "/root.jsonl", cwd: dir, name: "Root", actorToken: "root", launch: metadata }, 1);
  for (const [id, parent, depth] of [["child", "root", 1], ["grandchild", "child", 2]]) {
    store.createChild(parent, { sessionId: id, sessionFile: `/${id}.jsonl`, actorToken: id,
      policy: { ...launch(id, "work"), cwd: dir, depth }, now: 2 + depth });
  }
  const keys = ["lifecycle", "actorGeneration", "activity", "quietSince", "lastError"];
  const select = session => session && Object.fromEntries(keys.map(key => [key, session[key]]));
  function read(id) {
    const prepare = DatabaseSync.prototype.prepare, parse = JSON.parse, executions = []; let parses = 0;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = Reflect.apply(prepare, this, [sql]), get = statement.get;
      statement.get = function(...args) { executions.push(sql); return Reflect.apply(get, this, args); };
      return statement;
    };
    JSON.parse = function(...args) { parses++; return Reflect.apply(parse, this, args); };
    let value;
    try { value = store.getSessionActorState(id); }
    finally { DatabaseSync.prototype.prepare = prepare; JSON.parse = parse; }
    assert.deepEqual(executions, ["SELECT lifecycle, actor_generation, activity, quiet_since, last_error FROM sessions WHERE id = ?"]);
    assert.equal(parses, 0);
    if (value) assert.deepEqual(Object.keys(value), keys);
    return value;
  }
  assert.equal(read("absent"), undefined);
  for (const id of ["root", "child", "grandchild"]) assert.deepEqual(read(id), select(store.getSession(id)));
  const identity = { pid: 101, synthetic: "identity" };
  for (const id of ["root", "child", "grandchild"]) store.markActorStarted(id, 1, { pid: 101, processIdentity: identity }, 5);
  store.setActorActivity("grandchild", 1, true, 6);
  assert.equal(read("root").activity, "delegating"); assert.equal(read("root").quietSince, 5);
  for (const id of ["root", "child", "grandchild"]) assert.deepEqual(read(id), select(store.getSession(id)));
  const before = Object.freeze(read("root"));
  writer.prepare("UPDATE sessions SET lifecycle='resident', actor_generation=7, activity='idle', quiet_since=0, last_error='' WHERE id='root'").run();
  const current = read("root");
  assert.notEqual(current, before);
  assert.deepEqual(before, { lifecycle: "resident", actorGeneration: 1, activity: "delegating", quietSince: 5, lastError: null });
  assert.deepEqual(current, { lifecycle: "resident", actorGeneration: 7, activity: "idle", quietSince: 0, lastError: "" });
  const full = store.getSession("root");
  assert.deepEqual(read("root"), select(full)); assert.deepEqual(store.getSession("root"), full);
  assert.equal(full.workingDescendantCount, 1); assert.equal(full.lineage, "Root");
  assert.deepEqual(full.actorIdentity, identity); assert.deepEqual(full.launch.capabilityIds, ["large-unused"]);
  assert.equal(store.getActorLaunch("root").launch.capabilities[0].description.length, 8192);
  const victim = store.findIdleResidentActor();
  assert.equal(victim.sessionId, "root"); assert.equal(victim.lineage, "Root"); assert.deepEqual(victim.launch, full.launch);
  store.markActorLifecycle("root", 7, "error", "fresh error", 7);
  assert.deepEqual(read("root"), select(store.getSession("root"))); assert.equal(read("root").lastError, "fresh error");
  store.prepareActorRevival("root", "next", 8);
  assert.equal(read("root").actorGeneration, 8); assert.equal(read("root").lifecycle, "starting");
  store.markActorLifecycle("root", 8, "stopped", null, 9);
  store.deleteSession("root", 10);
  for (const id of ["root", "child", "grandchild"]) {
    assert.equal(read(id).lifecycle, "deleted"); assert.deepEqual(read(id), select(store.getSession(id)));
  }
  assert.equal(read("still-absent"), undefined);
});


test("skill grant context reads raw local identity fields freshly without full session mapping", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-grant-context-"));
  const databasePath = path.join(dir, "store.sqlite"), store = new HarnessStore(databasePath), writer = new DatabaseSync(databasePath);
  t.after(async () => { writer.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const metadata = { ...launch("Root"), capabilities: [{ id: "unrelated", description: "x".repeat(8192) }] };
  for (const id of ["root", "alternate"]) store.createRoot({ sessionId: id, sessionFile: `/${id}.jsonl`, cwd: dir,
    name: id, actorToken: id, launch: metadata }, 1);
  for (const [id, parent, depth] of [["child", "root", 1], ["grandchild", "child", 2]]) store.createChild(parent, {
    sessionId: id, sessionFile: `/${id}.jsonl`, actorToken: id, policy: { ...launch(id, "work"), cwd: dir, depth }, now: 2 + depth });
  const keys = ["lifecycle", "sessionFile", "kind", "parentSessionId"];
  const select = value => value && Object.fromEntries(keys.map(key => [key, value[key]]));
  function read(id) {
    const prepare = DatabaseSync.prototype.prepare, parse = JSON.parse, stringify = JSON.stringify, executions = []; let jsonCalls = 0;
    DatabaseSync.prototype.prepare = function(sql) { const statement = Reflect.apply(prepare, this, [sql]), get = statement.get;
      statement.get = function(...args) { executions.push({ sql, args }); return Reflect.apply(get, this, args); }; return statement; };
    JSON.parse = function(...args) { jsonCalls++; return Reflect.apply(parse, this, args); };
    JSON.stringify = function(...args) { jsonCalls++; return Reflect.apply(stringify, this, args); };
    let value;
    try { value = store.getSessionSkillGrantContext(id); }
    finally { DatabaseSync.prototype.prepare = prepare; JSON.parse = parse; JSON.stringify = stringify; }
    assert.deepEqual(executions, [{ sql: "SELECT lifecycle, session_file, kind, parent_session_id FROM sessions WHERE id = ?", args: [id] }]);
    assert.equal(jsonCalls, 0); if (value) assert.deepEqual(Object.keys(value), keys); return value;
  }
  assert.equal(read("absent"), undefined); assert.equal(read("'; DROP TABLE sessions; --"), undefined);
  for (const id of ["root", "child", "grandchild"]) assert.deepEqual(read(id), select(store.getSession(id)));
  const before = Object.freeze(read("child"));
  writer.prepare("UPDATE sessions SET session_file=?, parent_session_id=? WHERE id='child'").run("/fresh-child.jsonl", "alternate");
  assert.deepEqual(read("child"), { lifecycle: "starting", sessionFile: "/fresh-child.jsonl", kind: "child", parentSessionId: "alternate" });
  assert.deepEqual(before, { lifecycle: "starting", sessionFile: "/child.jsonl", kind: "child", parentSessionId: "root" });
  writer.prepare("UPDATE sessions SET kind='root', parent_session_id=NULL, depth=0 WHERE id='child'").run();
  assert.equal(read("child").kind, "root"); assert.equal(read("child").parentSessionId, null);
  writer.prepare("UPDATE sessions SET kind='child', parent_session_id='root', depth=1 WHERE id='child'").run();
  for (const file of [null, "", "/restored-child.jsonl"]) {
    writer.prepare("UPDATE sessions SET session_file=? WHERE id='child'").run(file);
    assert.equal(read("child").sessionFile, file); assert.deepEqual(read("child"), select(store.getSession("child")));
  }
  for (const id of ["root", "child", "grandchild"]) store.markActorStarted(id, 1, { pid: 101, processIdentity: { synthetic: id } }, 5);
  store.setActorActivity("grandchild", 1, true, 6);
  const full = store.getSession("root"); assert.equal(full.workingDescendantCount, 1); assert.equal(full.lineage, "root");
  assert.deepEqual(full.actorIdentity, { synthetic: "root" }); assert.deepEqual(full.launch.capabilityIds, ["unrelated"]);
  assert.equal(store.getActorLaunch("root").launch.capabilities[0].description.length, 8192);
  assert.equal(store.findIdleResidentActor().lineage, "root"); assert.deepEqual(read("root"), select(full));
  for (const lifecycle of ["error", "stopped", "passivated"]) { store.markActorLifecycle("root", 1, lifecycle); assert.equal(read("root").lifecycle, lifecycle); }
  store.prepareActorRevival("root", "next"); assert.equal(read("root").lifecycle, "starting");
  store.markActorLifecycle("root", 2, "stopped"); store.deleteSession("root");
  for (const id of ["root", "child", "grandchild"]) { assert.equal(read(id).lifecycle, "deleted"); assert.deepEqual(read(id), select(store.getSession(id))); }
  assert.equal(read("still-absent"), undefined);
});


test("resident abnormal turns share durable lifecycle receipts without replaying child work", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-child-turn-store-"));
  const databasePath = path.join(dir, "store.sqlite"); let store = new HarnessStore(databasePath);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  store.createRoot({ sessionId: "parent", sessionFile: "/parent.jsonl", cwd: dir, name: "PRIVATE PARENT", actorToken: "p", launch: {} });
  for (const id of ["child", "other"]) store.createChild("parent", { sessionId: id, sessionFile: `/${id}.jsonl`,
    actorToken: id, policy: { name: `PRIVATE CHILD ${id}`, depth: 1, cwd: dir, prompt: "SECRET INPUT" } });
  store.markActorStarted("child", 1); store.setActorActivity("child", 1, true);
  const report = { version: 1, turnId: "turn-1", failureClass: "request_preparation", dispatchBoundary: "before_provider_dispatch" };
  const injection = new DatabaseSync(databasePath);
  injection.exec("CREATE TRIGGER deny_turn_receipt BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  assert.throws(() => store.recordActorTurnFailure("child", 1, report), /synthetic receipt failure/);
  assert.equal(store.listMessages().length, 0);
  injection.exec("DROP TRIGGER deny_turn_receipt"); injection.close();
  store.close(); store = new HarnessStore(databasePath);
  store.recordActorTurnFailure("child", 1, report); store.recordActorTurnFailure("child", 1, report);
  const message = store.listPendingChildExitMessages()[0];
  assert(message.messageId.length <= 128); assert.equal(message.senderId, "child"); assert.equal(message.targetId, "parent");
  assert.match(message.body, /direct child child.*request_preparation.*before provider dispatch.*extension effects/);
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE|SECRET/);
  assert.equal(store.getSession("child").lifecycle, "resident"); assert.equal(store.getSession("child").activity, "working");
  assert.equal(store.nextQueuedChildTask("child").prompt, "SECRET INPUT");
  assert.deepEqual(store.listMessagesAwaitingSenderEntry("child"), []);
  assert.equal(store.listMessages().length, 1);
  store.markMessageDelivered(message.messageId, "parent");
  store.close(); store = new HarnessStore(databasePath);
  assert.equal(store.getMessage(message.messageId).state, "delivered");
  store.acknowledgeMessage(message.messageId, "parent");
  store.markActorLifecycle("child", 1, "passivated"); store.prepareActorRevival("child", "new-token");
  store.recordActorTurnFailure("child", 2, report);
  assert.equal(store.listMessages().length, 1); assert.equal(store.getMessage(message.messageId).state, "acknowledged");
  for (const [turnId, dispatchBoundary] of [["turn-2", "provider_dispatch_unknown"], ["turn-3", "tool_effects_possible"]]) {
    store.recordActorTurnFailure("child", 2, { ...report, turnId, dispatchBoundary });
  }
  const pending = store.listPendingChildExitMessages(); assert.equal(pending.length, 2);
  assert(pending.some(item => /Provider dispatch was attempted.*unknown/.test(item.body)));
  assert(pending.some(item => /Tool execution was admitted or started.*external effects/.test(item.body)));
  assert.throws(() => store.recordActorTurnFailure("child", 1, report), /stale/);
  store.recordActorTurnFailure("parent", 1, report); assert.equal(store.listMessages().length, 3);
  store.deleteSession("parent"); assert.equal(store.listPendingChildExitMessages().length, 0);
});
