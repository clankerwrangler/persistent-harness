import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MESSAGE_ENTRY_TYPE, CHILD_CREATION_ENTRY_TYPE, INCOMING_AGENT_MESSAGE_TYPE, collectDurableIncomingMessageIds, isSupersededIncomingCustomMessage, projectAgentMessageEntry, projectAgentMessageHistoryMessage, projectChildCreationHistoryMessage } from "../src/agent-message-projection.mjs";

const timestamp = "2026-01-01T00:00:00Z";
test("agent message projection allowlists durable incoming and outgoing communication", () => {
  const incoming = projectAgentMessageEntry({ type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE,
    id: "incoming", timestamp, content: "Direct agent message from audit:\nLegacy body",
    details: { senderId: "peer", senderName: "audit", relationship: "sibling" } });
  assert.deepEqual(incoming, { kind: "agent_message", id: "incoming", direction: "from", relationship: "sister",
    peerName: "audit", body: "Legacy body", createdAt: "2026-01-01T00:00:00.000Z" });
  const outgoing = projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE,
    id: "outgoing", timestamp, data: { messageId: "m1", direction: "to", peerId: "child", peerName: "reviewer",
      relationship: "child", body: "Check this" } });
  assert.equal(outgoing.direction, "to"); assert.equal(outgoing.relationship, "child");
  const liveIncoming = projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE,
    id: "live-from", timestamp, data: { messageId: "m2", direction: "from", peerId: "peer", peerName: "audit",
      relationship: "sibling", body: "Live body" } });
  assert.deepEqual(liveIncoming, { kind: "agent_message", id: "live-from", direction: "from", relationship: "sister",
    peerName: "audit", body: "Live body", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(projectAgentMessageHistoryMessage(outgoing), { id: "outgoing", role: "agent_message", text: "Check this",
    direction: "to", relationship: "child", peerName: "reviewer", createdAt: "2026-01-01T00:00:00.000Z", status: "complete" });
});

test("durable incoming entries supersede the later Pi custom_message for the same messageId", () => {
  const durable = { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "live-from", timestamp,
    data: { messageId: "m2", direction: "from", peerId: "peer", peerName: "audit", relationship: "sibling", body: "Live body" } };
  const injected = { type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE, id: "injected", timestamp,
    content: "Direct agent message from audit:\nLive body", details: { messageId: "m2", senderName: "audit", relationship: "sibling", body: "Live body" } };
  const ids = collectDurableIncomingMessageIds([durable, injected]);
  assert.deepEqual([...ids], ["m2"]);
  assert.equal(isSupersededIncomingCustomMessage(injected, ids), true);
  assert.equal(isSupersededIncomingCustomMessage(durable, ids), false);
});

test("agent message projection fails closed for malformed or private custom entries", () => {
  assert.equal(projectAgentMessageEntry({ type: "custom", customType: "private", id: "x", timestamp,
    data: { body: "secret" } }), undefined);
  assert.equal(projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "x", timestamp,
    data: { messageId: "m", direction: "to", peerId: "p", peerName: "peer", relationship: "cousin", body: "secret" } }), undefined);
  assert.equal(projectAgentMessageHistoryMessage({ id: "x", direction: "to", relationship: "child", peerName: "peer",
    body: "x".repeat(16 * 1024 + 1), createdAt: timestamp }), undefined);
});


test("child creation entries remain distinct from messages with an exact 32 KiB task body", () => {
  const body = "x".repeat(32 * 1024);
  const projected = projectAgentMessageEntry({ type: "custom", customType: CHILD_CREATION_ENTRY_TYPE, id: "creation", timestamp,
    data: { taskId: "task", childId: "child", childName: "reviewer", relationship: "child", body } });
  assert.deepEqual(projected, { kind: "child_creation", id: "creation", taskId: "task", childId: "child",
    childName: "reviewer", relationship: "child", body, createdAt: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(projectChildCreationHistoryMessage(projected), { id: "creation", role: "child_creation", text: body,
    taskId: "task", childId: "child", childName: "reviewer", relationship: "child",
    createdAt: "2026-01-01T00:00:00.000Z", status: "complete" });
  assert.equal(projectAgentMessageHistoryMessage(projected), undefined);
  assert.equal(projectAgentMessageEntry({ type: "custom", customType: CHILD_CREATION_ENTRY_TYPE, id: "bad", timestamp,
    data: { taskId: "task", childId: "child", childName: "reviewer", relationship: "child", body: body + "x" } }), undefined);
});
