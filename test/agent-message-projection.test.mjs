import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MESSAGE_ENTRY_TYPE, CHILD_CREATION_ENTRY_TYPE, INCOMING_AGENT_MESSAGE_TYPE, selectIncomingFamilyMessages, pendingFamilyMessage, projectAgentMessageEntry, projectAgentMessageHistoryMessage, projectChildCreationHistoryMessage } from "../src/agent-message-projection.mjs";

const timestamp = "2026-01-01T00:00:00Z";
test("agent message projection allowlists durable incoming and outgoing communication", () => {
  const incoming = projectAgentMessageEntry({ type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE,
    id: "incoming", timestamp, content: "Direct agent message from audit:\nLegacy body",
    details: { senderId: "peer", senderName: "audit", relationship: "sibling" } });
  assert.deepEqual(incoming, { kind: "agent_message", id: "incoming", direction: "from", relationship: "sister",
    peerName: "audit", peerId: "peer", body: "Legacy body", createdAt: "2026-01-01T00:00:00.000Z", entryId: "incoming",
    delivery: { state: "delivered", deliveredAt: "2026-01-01T00:00:00.000Z" } });
  const outgoing = projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE,
    id: "outgoing", timestamp, data: { messageId: "m1", direction: "to", peerId: "child", peerName: "reviewer",
      relationship: "child", body: "Check this" } });
  assert.equal(outgoing.direction, "to"); assert.equal(outgoing.relationship, "child");
  const liveIncoming = projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE,
    id: "live-from", timestamp, data: { messageId: "m2", direction: "from", peerId: "peer", peerName: "audit",
      relationship: "sibling", body: "Live body" } });
  assert.deepEqual(liveIncoming, { kind: "agent_message", id: "family-m2", direction: "from", relationship: "sister",
    peerName: "audit", body: "Live body", createdAt: "2026-01-01T00:00:00.000Z", familyMessageId: "m2", peerId: "peer",
    delivery: { state: "accepted", acceptedAt: "2026-01-01T00:00:00.000Z", deliveredAt: null } });
  assert.deepEqual(projectAgentMessageHistoryMessage(outgoing), { id: "outgoing", role: "agent_message", text: "Check this",
    direction: "to", relationship: "child", peerName: "reviewer", createdAt: "2026-01-01T00:00:00.000Z", status: "complete" });
});

test("canonical incoming context supersedes the receipt by identity, not body or ack", () => {
  const durable = { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "live-from", timestamp,
    data: { messageId: "m2", direction: "from", peerId: "peer", peerName: "audit", relationship: "sibling", body: "Live body" } };
  const injected = { type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE, id: "injected", timestamp: "2026-01-01T00:01:00Z",
    content: "Direct agent message from audit:\nLive body", details: { messageId: "m2", senderName: "audit", relationship: "sibling", body: "Live body" } };
  const before = projectAgentMessageEntry(durable), after = projectAgentMessageEntry(injected);
  assert.equal(before.id, after.id); assert.equal(before.delivery.state, "accepted");
  assert.equal(after.delivery.state, "delivered"); assert.equal(after.entryId, "injected");
  assert.deepEqual(selectIncomingFamilyMessages([before, after]), [after]);
  assert.deepEqual(selectIncomingFamilyMessages([after, before]), [after]);
  const repeated = projectAgentMessageEntry({ ...injected, id: "intentional-repeat", details: { ...injected.details, messageId: "m3" } });
  assert.equal(selectIncomingFamilyMessages([before, after, repeated]).length, 2);
});

test("family transport states never certify context admission and preserve sender provenance", () => {
  for (const state of ["accepted", "queued", "delivered"]) for (const relationship of ["parent", "child", "sibling"]) {
    const row = pendingFamilyMessage({ messageId: "m", senderId: "peer", targetId: "target", acceptedAt: 10,
      body: "Same body", relationship, state, deliveryMode: "follow_up" }, { name: "Peer" });
    assert.equal(row.role, "agent_message"); assert.equal(row.direction, "from"); assert.equal(row.peerId, "peer");
    assert.equal(row.delivery.state, "accepted"); assert.equal(row.delivery.deliveredAt, null);
    assert.equal(row.transportState, state); assert.equal(row.deliveryMode, "follow_up");
    assert.equal(row.relationship, { parent: "child", child: "parent", sibling: "sister" }[relationship]);
  }
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
