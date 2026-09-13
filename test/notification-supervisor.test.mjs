import assert from "node:assert/strict";
import test from "node:test";
import { fixture, delay, eventually } from "./fixtures/notification-supervisor.mjs";

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
});
