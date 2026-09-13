import assert from "node:assert/strict";
import test from "node:test";
import { extensionInternals } from "../src/extension.mjs";

function assistantEntry(id, overrides = {}) {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      provider: "fake",
      model: "model-a",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        totalTokens: 18,
        cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
      },
      ...overrides,
    },
  };
}

test("derives bounded usage only from canonical Pi assistant entries", () => {
  assert.deepEqual(extensionInternals.usageFromMessageEntry(assistantEntry("entry-1")), {
    entryId: "entry-1",
    provider: "fake",
    model: "model-a",
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    reasoning: 3,
    totalTokens: 18,
    costTotal: 0.2,
  });
  assert.equal(extensionInternals.usageFromMessageEntry({ type: "custom", id: "x" }), undefined);
  assert.equal(extensionInternals.usageFromMessageEntry(assistantEntry("bad", { usage: { totalTokens: -1 } })), undefined);
});

test("tracks persisted usage attribution markers by Pi entry ID", () => {
  const entries = [
    { type: "custom", customType: extensionInternals.USAGE_ENTRY_TYPE, data: { entryId: "entry-1" } },
    { type: "custom", customType: "other", data: { entryId: "entry-2" } },
  ];
  assert.deepEqual([...extensionInternals.recordedUsageEntryIds(entries)], ["entry-1"]);
});


test("recognizes only canonical incoming agent messages as durably delivered", () => {
  const entries = [
    { type: "custom_message", customType: extensionInternals.INCOMING_MESSAGE_TYPE, details: { messageId: "persisted" } },
    { type: "custom", customType: extensionInternals.INCOMING_MESSAGE_TYPE, data: { messageId: "wrong-shape" } },
    { type: "custom_message", customType: "other", details: { messageId: "private" } },
  ];
  assert.deepEqual([...extensionInternals.deliveredMessageIds(entries)], ["persisted"]);
});


test("indexes canonical outgoing agent-message entries for crash reconciliation", () => {
  const entries = [
    { type: "custom", customType: extensionInternals.AGENT_MESSAGE_ENTRY_TYPE, id: "entry-1",
      data: { messageId: "message-1", direction: "to" } },
    { type: "custom_message", customType: extensionInternals.AGENT_MESSAGE_ENTRY_TYPE, id: "wrong",
      data: { messageId: "message-2", direction: "to" } },
  ];
  assert.equal(extensionInternals.outgoingAgentMessageEntries(entries).get("message-1")?.id, "entry-1");
  assert.equal(extensionInternals.outgoingAgentMessageEntries(entries).has("message-2"), false);
});


test("indexes canonical incoming agent-message entries separately from Pi injection", () => {
  const entries = [
    { type: "custom", customType: extensionInternals.AGENT_MESSAGE_ENTRY_TYPE, id: "from-1",
      data: { messageId: "message-1", direction: "from" } },
    { type: "custom", customType: extensionInternals.AGENT_MESSAGE_ENTRY_TYPE, id: "to-1",
      data: { messageId: "message-2", direction: "to" } },
    { type: "custom_message", customType: extensionInternals.INCOMING_MESSAGE_TYPE, id: "injected",
      details: { messageId: "message-1" } },
  ];
  assert.equal(extensionInternals.incomingAgentMessageEntries(entries).get("message-1")?.id, "from-1");
  assert.equal(extensionInternals.incomingAgentMessageEntries(entries).has("message-2"), false);
  assert.equal(extensionInternals.outgoingAgentMessageEntries(entries).get("message-2")?.id, "to-1");
  assert.deepEqual([...extensionInternals.deliveredMessageIds(entries)], ["message-1"]);
});


test("normalizes only Pi's explicit compaction-aware context reading", () => {
  assert.deepEqual(extensionInternals.contextUsageFromExtension({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    { tokens: 1000, contextWindow: 200000, percent: 0.5 });
  assert.deepEqual(extensionInternals.contextUsageFromExtension({ tokens: null, contextWindow: 200000, percent: null }),
    { tokens: null, contextWindow: 200000, percent: null });
  assert.equal(extensionInternals.contextUsageFromExtension(undefined), undefined);
});


test("indexes child creation entries separately from outgoing message reconciliation", () => {
  const entries = [{ type: "custom", customType: extensionInternals.CHILD_CREATION_ENTRY_TYPE, id: "creation-1",
    data: { taskId: "task-1", childId: "child-1", childName: "reviewer", relationship: "child", body: "exact task" } },
    { type: "custom", customType: extensionInternals.AGENT_MESSAGE_ENTRY_TYPE, id: "message-1",
      data: { messageId: "message-1", direction: "to" } }];
  assert.equal(extensionInternals.childCreationEntries(entries).get("child-1")?.id, "creation-1");
  assert.equal(extensionInternals.outgoingAgentMessageEntries(entries).has("child-1"), false);
});


test("scans only appended settlement entries and resets when the append-only anchor changes", () => {
  const first = [{ id: "one", type: "message" }, { id: "two", type: "message" }];
  const initial = extensionInternals.appendedSessionEntries(first);
  assert.deepEqual(initial.entries, first);
  const appended = extensionInternals.appendedSessionEntries([...first, { id: "three", type: "custom" }], initial.cursor);
  assert.deepEqual(appended.entries.map((entry) => entry.id), ["three"]);
  const replaced = extensionInternals.appendedSessionEntries([{ id: "one" }, { id: "different" }], initial.cursor);
  assert.deepEqual(replaced.entries.map((entry) => entry.id), ["one", "different"]);
  const shortened = extensionInternals.appendedSessionEntries([{ id: "one" }], appended.cursor);
  assert.deepEqual(shortened.entries.map((entry) => entry.id), ["one"]);
});


const familyMessage = {
  messageId: "m-idle", senderId: "child-1", senderName: "builder", senderShortId: "b1",
  senderDepth: 1, relationship: "child", deliveryMode: "auto", body: "Frame thumbnail result",
};

test("idle auto starts a turn for incoming family messages and acks after Pi persistence", async () => {
  assert.deepEqual(extensionInternals.incomingSendOptions("steer", false), { triggerTurn: true });
  assert.equal("deliverAs" in extensionInternals.incomingSendOptions("steer", false), false);
  const injected = [];
  await extensionInternals.deliverIncomingFamilyMessage({
    persist: async () => {},
    inject: (message, options) => { injected.push({ message, options }); },
  }, familyMessage, extensionInternals.incomingSendOptions("steer", false));
  assert.equal(injected.length, 1);
  assert.equal(injected[0].message.messageId, "m-idle");
  assert.deepEqual(injected[0].options, { triggerTurn: true });
  const payload = extensionInternals.incomingCustomPayload(familyMessage);
  assert.equal(payload.customType, extensionInternals.INCOMING_MESSAGE_TYPE);
  assert.match(payload.content, /Frame thumbnail result/);
  assert.deepEqual([...extensionInternals.deliveredMessageIds([
    { type: "custom_message", customType: payload.customType, details: payload.details },
  ])], ["m-idle"]);
});


test("busy auto steers incoming family messages between tool calls", () => {
  assert.deepEqual(extensionInternals.incomingSendOptions("steer", true), { triggerTurn: true, deliverAs: "steer" });
  assert.deepEqual(extensionInternals.incomingSendOptions("follow_up", true), { triggerTurn: true, deliverAs: "followUp" });
  assert.deepEqual(extensionInternals.incomingSendOptions("follow_up", false), { triggerTurn: true, deliverAs: "followUp" });
});


test("incoming persist or record failure still injects the family message", async () => {
  const injected = [];
  const persistErrors = [];
  await extensionInternals.deliverIncomingFamilyMessage({
    persist: async () => { throw new Error("incoming agent message transcript entry does not match its durable message"); },
    inject: (message, options) => { injected.push({ message, options }); },
    onPersistError: (error) => persistErrors.push(error.message),
  }, familyMessage, extensionInternals.incomingSendOptions("steer", false));
  assert.deepEqual(persistErrors, ["incoming agent message transcript entry does not match its durable message"]);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].message.body, "Frame thumbnail result");
  assert.deepEqual(injected[0].options, { triggerTurn: true });
});
