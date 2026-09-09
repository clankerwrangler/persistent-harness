
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, ProtocolError, validateRequest, validateServerFrame } from "../src/protocol.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const frame = (type, params) => ({ version: PROTOCOL_VERSION, id: crypto.randomUUID(), type, params });
test("protocol separates one authenticated actor from detachable clients", () => {
  const actor = validateRequest(frame("register_actor", { sessionId: "actor", sessionFile: "/tmp/a.jsonl", cwd: "/tmp", repositoryRoot: null, actorToken: "token", actorGeneration: 2 }));
  assert.equal(actor.params.actorGeneration, 2);
  const client = validateRequest(frame("register_client", { clientInstanceId: "ui-a" }));
  assert.equal(client.params.clientInstanceId, "ui-a");
  const input = validateRequest(frame("submit_input", { sessionId: "actor", message: "hello", behavior: "follow_up", clientRequestId: "browser-1" }));
  assert.equal(input.params.behavior, "follow_up"); assert.equal(input.params.clientRequestId, "browser-1");
  const imageInput = validateRequest(frame("submit_input", { sessionId: "actor", message: "", images: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }] }));
  assert.equal(imageInput.params.images[0].mimeType, "image/png");
  const ui = validateRequest(frame("respond_extension_ui", { sessionId: "actor", uiRequestId: "dialog", confirmed: true }));
  assert.equal(ui.params.confirmed, true);
  const rename = validateRequest(frame("rename_session", { sessionId: "actor", name: "new name" }));
  assert.equal(rename.params.name, "new name");
  assert.equal(validateRequest(frame("get_visible_messages", { sessionId: "actor" })).params.sessionId, "actor");
  assert.deepEqual(validateRequest(frame("get_visible_image", { sessionId: "actor", entryId: "entry", index: 0 })).params, { sessionId: "actor", entryId: "entry", index: 0 });
  assert.deepEqual(validateRequest(frame("record_progress_entry", { entryId: "p1", summary: "Inspecting history", createdAt: "2026-01-01T00:00:00Z" })).params, { entryId: "p1", summary: "Inspecting history", createdAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(validateRequest(frame("record_agent_message_entry", { entryId: "am1", messageId: "message-1", direction: "to", peerId: "child-1", peerName: "audit", relationship: "child", body: "Review this", createdAt: "2026-01-01T00:00:00Z" })).params,
    { entryId: "am1", messageId: "message-1", direction: "to", peerId: "child-1", peerName: "audit", relationship: "child", body: "Review this", createdAt: "2026-01-01T00:00:00Z" });
  assert.throws(() => validateRequest(frame("register_session", {})), (error) => error instanceof ProtocolError && error.code === "unknown_request");
  assert.throws(() => validateRequest(frame("register_actor", { sessionId: "a" })), /not supported|required|must be/);
});

test("protocol validates bounded agent and user inputs and exact fields", () => {
  assert.equal(validateRequest(frame("send_message", { target: "b", body: "ok", deliveryMode: "auto" })).params.body, "ok");
  assert.throws(() => validateRequest(frame("submit_input", { sessionId: "a", message: "x".repeat(32 * 1024 + 1), behavior: "auto" })), /at most/);
  assert.throws(() => validateRequest(frame("submit_input", { sessionId: "a", message: "" })), /empty only with images/);
  assert.throws(() => validateRequest(frame("submit_input", { sessionId: "a", message: "image", images: [{ type: "image", mimeType: "image/png", data: "AA==" }] })), /container/);
  const retry = validateRequest(frame("submit_input", { sessionId: "a", message: "hello", behavior: "auto", retryOf: "assistant-1" }));
  assert.equal(retry.params.retryOf, "assistant-1");
  assert.throws(() => validateRequest(frame("submit_input", { sessionId: "a", message: "hello", behavior: "steer", retryOf: "assistant-1" })), /retryOf requires params.behavior auto/);
  assert.throws(() => validateRequest(frame("create_root", { cwd: "/tmp", repositoryRoot: null, name: null, provider: "p", model: null, thinkingLevel: null })), /supplied together/);
  assert(MAX_FRAME_BYTES >= 5 * 1024 * 1024);
});

test("server frames retain request correlation and version checks", () => {
  assert.equal(validateServerFrame({ version: PROTOCOL_VERSION, type: "response", id: "1", requestType: "get_status", ok: true, data: {} }).ok, true);
  assert.throws(() => validateServerFrame({ version: 1, type: "event", event: "x", data: {} }), /unsupported/);
});

test("protocol validates passive observation and bounded progress headings", () => {
  assert.equal(validateRequest(frame("subscribe_session", { selector: "actor", passive: true })).params.passive, true);
  assert.deepEqual(validateRequest(frame("update_progress_heading", { phase: "heading", turnId: "turn-1", summary: "Inspecting the actor" })).params, { phase: "heading", turnId: "turn-1", summary: "Inspecting the actor" });
  assert.throws(() => validateRequest(frame("update_progress_heading", { phase: "start", turnId: "turn-1", summary: "not allowed" })), /must not include/);
  assert.throws(() => validateRequest(frame("update_progress_heading", { phase: "heading", turnId: "turn-1" })), /requires/);
});

test("protocol validates durable progress entry frames", () => {
  assert.throws(() => validateRequest(frame("record_progress_entry", { entryId: "p1", summary: "ok", createdAt: "not-a-date" })), /ISO timestamp/);
  assert.throws(() => validateRequest(frame("record_progress_entry", { entryId: "p1", summary: "ok", createdAt: "2026-01-01T00:00:00Z", private: true })), /not supported/);
});


test("protocol strictly bounds durable agent-message display events", () => {
  const value = { entryId: "am1", messageId: "message-1", direction: "to", peerId: "peer", peerName: "review", relationship: "sibling", body: "Result", createdAt: "2026-01-01T00:00:00Z" };
  assert.equal(validateRequest(frame("record_agent_message_entry", value)).params.body, "Result");
  assert.equal(validateRequest(frame("record_agent_message_entry", { ...value, direction: "from" })).params.direction, "from");
  assert.throws(() => validateRequest(frame("record_agent_message_entry", { ...value, relationship: "cousin" })), /parent, child, or sibling/);
  assert.throws(() => validateRequest(frame("record_agent_message_entry", { ...value, direction: "side" })), /from or to/);
  assert.throws(() => validateRequest(frame("record_agent_message_entry", { ...value, body: "x".repeat(16 * 1024 + 1) })), /at most/);
  assert.throws(() => validateRequest(frame("record_agent_message_entry", { ...value, private: true })), /not supported/);
});


test("protocol strictly validates selected-session inference and context telemetry", () => {
  assert.deepEqual(validateRequest(frame("get_session_inference", { sessionId: "actor" })).params, { sessionId: "actor" });
  const changed = validateRequest(frame("set_session_inference", { sessionId: "actor", provider: "p", model: "m2", thinkingLevel: "high",
    expected: { provider: "p", model: "m1", thinkingLevel: "medium" } }));
  assert.equal(changed.params.expected.model, "m1");
  assert.throws(() => validateRequest(frame("set_session_inference", { sessionId: "actor", provider: "p", model: "m", thinkingLevel: "turbo",
    expected: { provider: "p", model: "m", thinkingLevel: "off" } })), /unsupported/);
  assert.throws(() => validateRequest(frame("set_session_inference", { sessionId: "actor", provider: "p", model: "m", thinkingLevel: "off",
    expected: { provider: "p", model: "m", thinkingLevel: "off", secret: true } })), /not supported/);
  assert.deepEqual(validateRequest(frame("record_context_usage", { tokens: null, contextWindow: 200000, percent: null })).params,
    { tokens: null, contextWindow: 200000, percent: null });
  assert.throws(() => validateRequest(frame("record_context_usage", { tokens: null, contextWindow: 200000, percent: 1 })), /both be known or null/);
  assert.throws(() => validateRequest(frame("record_usage", { entryId: "u", provider: "p", model: "m", input: 1, output: 2,
    cacheRead: 0, cacheWrite: 0, reasoning: 3, totalTokens: 3, costTotal: 0 })), /must not exceed/);
  const maximumUsage = { entryId: "maximum", provider: "p", model: "m", input: Number.MAX_SAFE_INTEGER,
    output: Number.MAX_SAFE_INTEGER, cacheRead: Number.MAX_SAFE_INTEGER, cacheWrite: Number.MAX_SAFE_INTEGER,
    reasoning: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER, costTotal: 1_000_000_000 };
  assert.deepEqual(validateRequest(frame("record_usage", maximumUsage)).params, maximumUsage,
    "the overflow regression uses values accepted by telemetry validation");
  assert.deepEqual(validateRequest(frame("get_usage", { windowMinutes: 60 })).params, { windowMinutes: 60 });
  assert.throws(() => validateRequest(frame("get_usage", { windowMinutes: 0 })), /1 through 10080/);
  assert.throws(() => validateRequest(frame("get_usage", { windowMinutes: 60, query: "SELECT" })), /not supported/);
});


test("protocol strictly validates child creation history independently of agent messages", () => {
  const value = { entryId: "entry-1", taskId: "task-1", childId: "child-1", childName: "reviewer", relationship: "child",
    body: "x".repeat(32 * 1024), createdAt: "2026-01-01T00:00:00Z" };
  assert.equal(validateRequest(frame("record_child_creation_entry", value)).params.body.length, 32 * 1024);
  assert.throws(() => validateRequest(frame("record_child_creation_entry", { ...value, relationship: "sibling" })), /must be child/);
  assert.throws(() => validateRequest(frame("record_child_creation_entry", { ...value, body: "x".repeat(32 * 1024 + 1) })), /at most/);
  assert.throws(() => validateRequest(frame("record_child_creation_entry", { ...value, messageId: "must-not-be-present" })), /not supported/);
});


test("root-output subscription cursor is exact and bounded", () => {
  assert.deepEqual(validateRequest(frame("subscribe_root_output", {})).params, null);
  assert.deepEqual(validateRequest(frame("subscribe_root_output", { generation: "generation-a", afterSeq: 7 })).params, { generation: "generation-a", afterSeq: 7 });
  assert.deepEqual(validateRequest(frame("subscribe_root_output", { invalidCursor: true })).params, { invalid: true });
  assert.throws(() => validateRequest(frame("subscribe_root_output", { generation: "generation-a" })), /supplied together/);
  assert.throws(() => validateRequest(frame("subscribe_root_output", { afterSeq: 1 })), /supplied together/);
  assert.throws(() => validateRequest(frame("subscribe_root_output", { invalidCursor: true, generation: "x", afterSeq: 1 })), /must not include/);
});


test("root-output unsubscribe is exact and generation cursor shape is canonical", () => {
  assert.deepEqual(validateRequest({ version: PROTOCOL_VERSION, id: "unsub", type: "unsubscribe_root_output", params: {} }).params, {});
  assert.throws(() => validateRequest({ version: PROTOCOL_VERSION, id: "bad-unsub", type: "unsubscribe_root_output", params: { extra: true } }), /not supported/);
  assert.throws(() => validateRequest({ version: PROTOCOL_VERSION, id: "bad-generation", type: "subscribe_root_output", params: { generation: "bad/generation", afterSeq: 1 } }), /invalid shape/);
});


test("operator actions are session-scoped and runtime approval is fingerprint-bound", () => {
  assert.equal(validateRequest(frame("restart_kernel", { sessionId: "session-a" })).params.sessionId, "session-a");
  assert.deepEqual(validateRequest(frame("get_skill_runtime_plan", {})).params, {});
  const fingerprint = "a".repeat(64);
  assert.deepEqual(validateRequest(frame("provision_skill_runtime", { fingerprint })).params, { fingerprint });
  assert.throws(() => validateRequest(frame("provision_skill_runtime", { fingerprint: "A".repeat(64) })), /lowercase SHA-256/);
  assert.throws(() => validateRequest(frame("provision_skill_runtime", { fingerprint, packages: ["evil"] })), /not supported/);
});

test("extension UI responses allow exact empty input without permitting extra fields", () => {
  assert.equal(validateRequest(frame("respond_extension_ui", { sessionId: "session-a", uiRequestId: "request-a", value: "" })).params.value, "");
  assert.throws(() => validateRequest(frame("respond_extension_ui", { sessionId: "session-a", uiRequestId: "request-a", value: "", extra: true })), /not supported/);
  assert.throws(() => validateRequest(frame("respond_extension_ui", { sessionId: "session-a", uiRequestId: "request-a", value: "x".repeat(32 * 1024 + 1) })), /32768 UTF-8 bytes/);
});


test("protocol validates exact durable cron operations and execution modes", () => {
  const created = validateRequest(frame("cron_job", { action: "create", name: "Morning", prompt: "Report",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" }, executionMode: "origin", repeat: null }));
  assert.equal(created.params.schedule.expression, "0 9 * * *"); assert.equal(created.params.executionMode, "origin");
  const updated = validateRequest(frame("cron_job", { action: "update", selector: "Morning", repeat: null }));
  assert.equal(updated.params.repeat, null);
  assert.throws(() => validateRequest(frame("cron_job", { action: "create", name: "bad", prompt: "x",
    schedule: { kind: "every", intervalSeconds: 300 }, executionMode: "steer" })), /fresh or origin/);
  assert.throws(() => validateRequest(frame("cron_job", { action: "update", selector: "Morning" })), /at least one/);
  assert.throws(() => validateRequest(frame("cron_job", { action: "list", includeRemoved: false, secret: true })), /not supported/);
  const pinned = validateRequest(frame("cron_job", { action: "create", name: "Pinned", prompt: "Report",
    schedule: { kind: "every", intervalSeconds: 300 }, provider: "grok-cli", model: "grok-4.6", thinkingLevel: "high" }));
  assert.equal(pinned.params.provider, "grok-cli"); assert.equal(pinned.params.model, "grok-4.6");
  assert.equal(pinned.params.thinkingLevel, "high");
  const cleared = validateRequest(frame("cron_job", { action: "update", selector: "Pinned", provider: null, model: null }));
  assert.equal(cleared.params.provider, null); assert.equal(cleared.params.model, null);
  assert.throws(() => validateRequest(frame("cron_job", { action: "create", name: "bad", prompt: "x",
    schedule: { kind: "every", intervalSeconds: 300 }, provider: "grok-cli" })), /supplied together/);
});


test("visible history pagination accepts only bounded cursors and page counts", () => {
  assert.deepEqual(validateRequest(frame("get_visible_messages", { sessionId: "actor" })).params, { sessionId: "actor" });
  assert.deepEqual(validateRequest(frame("get_visible_messages", { sessionId: "actor", before: "opaque_cursor-1", limit: 100 })).params,
    { sessionId: "actor", before: "opaque_cursor-1", limit: 100 });
  for (const limit of [0, 101, -1, 1.5, true, "10", null]) {
    assert.throws(() => validateRequest(frame("get_visible_messages", { sessionId: "actor", limit })), /1 through 100/);
  }
  for (const before of ["", "a=", "a b", "a".repeat(2049), true, null]) {
    assert.throws(() => validateRequest(frame("get_visible_messages", { sessionId: "actor", before })), /before/);
  }
  for (const extra of [{ offset: 100 }, { maxBytes: 9999999 }, { sanitizePresentation: false }, { sessionFile: "/tmp/private" }]) {
    assert.throws(() => validateRequest(frame("get_visible_messages", { sessionId: "actor", ...extra })), /not supported/);
  }
});
