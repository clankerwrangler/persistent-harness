import assert from "node:assert/strict";
import test from "node:test";
import { fixture, delay, eventually } from "./fixtures/notification-supervisor.mjs";

test("fixture close joins concurrent startup retirement before publishing stopped state", { timeout: 10_000 }, async t => {
  const launchRead = Promise.withResolvers(), releaseLaunch = Promise.withResolvers(),
    closeEntered = Promise.withResolvers(), releaseClose = Promise.withResolvers();
  t.after(() => { releaseLaunch.resolve(); releaseClose.resolve(); });
  const f = await fixture(t);
  const started = f.supervisor.store.markActorStarted.bind(f.supervisor.store);
  f.supervisor.store.markActorStarted = (...args) => {
    const result = started(...args);
    if (args[1] === 1) f.supervisor.store.createActorInput(args[0], { inputId: "startup-close-overlap", message: "Synthetic pending input" });
    return result;
  };
  const read = f.supervisor.transcriptReader.read.bind(f.supervisor.transcriptReader);
  f.supervisor.transcriptReader.read = async params => {
    if (f.supervisor.store.getSessionActorState(params.sessionId).actorGeneration === 1) {
      launchRead.resolve(); await releaseLaunch.promise;
    }
    return read(params);
  };
  const actor = await f.actor(), sessionId = actor.session.sessionId;
  await launchRead.promise;
  const disconnect = actor.connection.stop.bind(actor.connection), close = actor.close.bind(actor);
  let closes = 0, exits = 0;
  actor.connection.stop = async () => { closeEntered.resolve(); await releaseClose.promise; return disconnect(); };
  actor.close = () => { closes += 1; return close(); };
  actor.on("exit", () => { exits += 1; });
  const stopping = f.client.request("stop_session", { sessionId });
  await closeEntered.promise;
  releaseLaunch.resolve();
  await eventually(() => closes === 2);
  assert.equal(exits, 0, "the first close still owns its asynchronous disconnect");
  releaseClose.resolve(); await stopping;
  assert.equal(exits, 1);
  assert.equal(f.supervisor.store.getSessionActorState(sessionId).lifecycle, "stopped",
    "startup cleanup must not remove the actor before its exit publishes stopped state");
  await f.client.request("submit_input", { sessionId, message: "Synthetic later input", behavior: "auto", clientRequestId: "after-close" });
  const revived = await eventually(() => f.actors.get(sessionId) !== actor && f.actors.get(sessionId)?.isRunning && f.actors.get(sessionId));
  assert.equal(revived.session.actorGeneration, 2);
});

test("root-only explicit attention is durable, idempotent, read != resolved, and expiry cannot reopen", async t => {
  const f = await fixture(t); const root = await f.actor(); const child = await f.actor(root.session.sessionId);
  const request = { key: "decision-1", title: "Choose a target", body: "Which target should I use?", expiresIn: 10 };
  root.busy();
  const item = (await root.connection.request("request_attention", request)).notification;
  assert.equal(item.rootId, root.session.sessionId); assert.match(item.url, new RegExp(item.id));
  const retry = (await root.connection.request("request_attention", { ...request, expiresIn: 20 })).notification;
  assert.equal(retry.expiresAt, item.expiresAt); assert.equal(retry.id, item.id);
  await assert.rejects(child.connection.request("request_attention", request), /current root actor/);
  await assert.rejects(f.client.request("request_attention", request), /not available to clients/);
  await assert.rejects(root.connection.request("request_attention", { ...request, recipient: child.session.sessionId }), /not supported/);
  const read = (await f.client.request("read_notification", { id: item.id })).notification;
  assert.ok(read.readAt); assert.equal(read.state, "pending");
  root.idle(); await delay(120);
  assert.equal((await f.client.request("list_notifications")).notifications.length, 1, "related idle coalesces even after reading attention");
  await root.connection.request("resolve_attention", { key: request.key });
  assert.equal((await root.connection.request("request_attention", request)).notification.state, "resolved");
  const expiring = (await root.connection.request("request_attention", { ...request, key: "expiry", expiresIn: 1 })).notification;
  await delay(1010);
  assert.equal((await root.connection.request("resolve_attention", { key: "expiry" })).notification.state, "expired");
  assert.equal((await root.connection.request("request_attention", { ...request, key: "expiry" })).notification.expiresAt, expiring.expiresAt);
});

test("recursive family settlement ignores retained inactive children, waits for live descendants, and notices stable queued stalls", async t => {
  const f = await fixture(t, { maxDepth: 2 }); const root = await f.actor(), child = await f.actor(root.session.sessionId), grandchild = await f.actor(child.session.sessionId);
  const list = async () => (await f.client.request("list_notifications")).notifications;
  root.busy(); grandchild.busy(); root.idle(); await delay(130); assert.equal((await list()).length, 0);
  grandchild.idle(); await delay(20); child.busy(); await delay(90); assert.equal((await list()).length, 0, "transient handoff is not all idle");
  child.idle();
  f.supervisor.store.createActorInput(root.session.sessionId, { message: "accepted but stalled", behavior: "follow_up", source: "user" });
  await eventually(async () => (await list()).length === 1);
  const first = (await list())[0]; assert.equal(first.kind, "idle"); assert.match(first.body, /now idle/); assert.doesNotMatch(first.body, /success|complete/);
  await delay(150); assert.equal((await list()).length, 1);
  root.busy(); assert.equal((await list())[0].state, "superseded"); root.idle();
  await eventually(async () => (await list()).length === 2);
  assert.notEqual((await list())[0].id, first.id);
  root.busy();
  const startingId = "starting-notification-child";
  f.supervisor.store.createChild(root.session.sessionId, { sessionId: startingId,
    sessionFile: `${f.dir}/${startingId}.jsonl`, actorToken: "faux-token",
    policy: { name: "Starting handoff", prompt: "fixture", cwd: f.dir, repositoryRoot: f.dir, depth: 1, capabilities: [], skillCatalog: [] } });
  root.idle(); await delay(130);
  assert.equal((await list()).length, 2, "a starting descendant clears the family quiet interval");
  f.supervisor.store.markActorLifecycle(startingId, 1, "stopped");
  root.idle();
  await eventually(async () => (await list()).length === 3);
});

test("own-idle parent retirement preserves family settlement until its working child settles", async t => {
  const f = await fixture(t, { actorInactivityMs: 200 });
  const root = await f.actor(); root.busy();
  const child = await f.actor(root.session.sessionId); child.busy(); root.idle();
  await eventually(() => f.supervisor.store.getSession(root.session.sessionId).lifecycle === "passivated");
  assert.equal(child.isRunning, true);
  assert.equal(f.supervisor.store.getSession(child.session.sessionId).activity, "working");
  assert.equal((await f.client.request("list_notifications")).notifications.length, 0);
  child.idle();
  const notifications = await eventually(async () => {
    const list = (await f.client.request("list_notifications")).notifications;
    return list.length && list;
  });
  assert.equal(notifications.length, 1); assert.equal(notifications[0].kind, "idle");
  assert.equal(notifications[0].rootId, root.session.sessionId);
  assert.equal(f.supervisor.store.getSession(root.session.sessionId).lifecycle, "passivated");
});

test("live tool execution is not idle; dialogs reach durable feed without SSE and expire/cancel without revival", async t => {
  const f = await fixture(t), root = await f.actor();
  root.busy(); root.emit("event", { type: "tool_execution_start", toolCallId: "live-tool", toolName: "ipython", args: {} }); root.idle();
  await delay(130); assert.equal((await f.client.request("list_notifications")).notifications.length, 0);
  root.emit("event", { type: "extension_ui_request", id: "dialog-expiry", method: "confirm", title: "An exact decision", message: "Approve this?", timeout: 160 });
  const item = (await f.client.request("list_notifications")).notifications[0]; assert.equal(item.kind, "attention");
  const snapshot = await f.client.request("subscribe_session", { selector: root.session.sessionId, passive: true });
  assert.equal(snapshot.pendingUiRequests[0].id, "dialog-expiry"); assert.ok(snapshot.pendingUiRequests[0].timeout <= 160);
  await f.client.request("read_notification", { id: item.id });
  assert.equal((await f.client.request("get_notification", { id: item.id })).notification.state, "pending");
  await delay(180);
  assert.equal((await f.client.request("get_notification", { id: item.id })).notification.state, "expired");
  await assert.rejects(f.client.request("respond_extension_ui", { sessionId: root.session.sessionId, uiRequestId: "dialog-expiry", confirmed: true }), /no longer pending/);
  assert.equal((await f.client.request("subscribe_session", { selector: root.session.sessionId, passive: true })).pendingUiRequests.length, 0);
  root.emit("event", { type: "extension_ui_request", id: "dialog-cancel", method: "input", title: "Choose a value", timeout: 1000 });
  const cancel = (await f.client.request("list_notifications")).notifications[0];
  await f.client.request("respond_extension_ui", { sessionId: root.session.sessionId, uiRequestId: "dialog-cancel", cancelled: true });
  assert.equal((await f.client.request("get_notification", { id: cancel.id })).notification.state, "cancelled");
  root.emit("event", { type: "tool_execution_end", toolCallId: "live-tool", toolName: "ipython", result: { content: [] } });
  await eventually(async () => (await f.client.request("list_notifications")).notifications.some(n => n.kind === "idle"));
  root.busy(); root.emit("event", { type: "compaction_start" }); root.idle();
  await delay(130);
  assert.equal((await f.client.request("list_notifications")).notifications.filter(n => n.kind === "idle").length, 1, "compaction must not create another idle notice");
  root.emit("event", { type: "compaction_end" });
  await eventually(async () => (await f.client.request("list_notifications")).notifications.filter(n => n.kind === "idle").length === 2);
});
