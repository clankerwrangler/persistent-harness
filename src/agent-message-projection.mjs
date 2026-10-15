export const INCOMING_AGENT_MESSAGE_TYPE = "persistent-harness-incoming-message";
export const AGENT_MESSAGE_ENTRY_TYPE = "persistent-harness.agent-message-v1";
export const CHILD_CREATION_ENTRY_TYPE = "persistent-harness.child-creation-v1";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CHILD_BODY_BYTES = 32 * 1024;

function bounded(value, maxCharacters, maxBytes = maxCharacters * 4) {
  return typeof value === "string" && value.length > 0 && value.length <= maxCharacters
    && Buffer.byteLength(value, "utf8") <= maxBytes ? value : undefined;
}
function timestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
function relationship(value) {
  if (value === "sibling") return "sister";
  return ["parent", "child", "sister"].includes(value) ? value : undefined;
}
function messageBody(entry) {
  const explicit = bounded(entry?.details?.body, MAX_BODY_BYTES, MAX_BODY_BYTES);
  if (explicit) return explicit;
  const content = bounded(entry?.content, MAX_BODY_BYTES + 1024, MAX_BODY_BYTES + 1024);
  const newline = content?.indexOf("\n") ?? -1;
  return newline >= 0 ? bounded(content.slice(newline + 1), MAX_BODY_BYTES, MAX_BODY_BYTES) : undefined;
}

export function projectAgentMessageEntry(entry) {
  const id = bounded(entry?.id, 128, 512); const createdAt = timestamp(entry?.timestamp);
  if (!id || !createdAt) return undefined;
  if (entry.type === "custom_message" && entry.customType === INCOMING_AGENT_MESSAGE_TYPE) {
    const peerName = bounded(entry.details?.senderName, 256, 1024)
      ?? bounded(entry.details?.senderShortId, 128, 512);
    const peerRelationship = relationship(entry.details?.relationship); const body = messageBody(entry);
    if (!peerName || !peerRelationship || !body) return undefined;
    const messageId = injectedIncomingMessageId(entry);
    return { kind: "agent_message", id: messageId ? incomingFamilyRowId(messageId) : id,
      entryId: id, ...(messageId ? { familyMessageId: messageId } : {}), direction: "from", relationship: peerRelationship,
      peerName, ...(bounded(entry.details?.senderId, 128, 512) ? { peerId: entry.details.senderId } : {}), body, createdAt,
      ...(entry.details?.deliveryMode === "follow_up" ? { deliveryMode: "follow_up" } : {}),
      delivery: { state: "delivered", deliveredAt: createdAt } };
  }
  if (entry.type === "custom" && entry.customType === AGENT_MESSAGE_ENTRY_TYPE) {
    const data = entry.data; const peerName = bounded(data?.peerName, 256, 1024);
    const peerRelationship = relationship(data?.relationship); const body = bounded(data?.body, MAX_BODY_BYTES, MAX_BODY_BYTES);
    const direction = data?.direction === "from" || data?.direction === "to" ? data.direction : undefined;
    if (!direction || !peerName || !peerRelationship || !body
      || !bounded(data?.messageId, 128, 512) || !bounded(data?.peerId, 128, 512)) return undefined;
    return { kind: "agent_message", id: direction === "from" ? incomingFamilyRowId(data.messageId) : id,
      direction, relationship: peerRelationship, peerName, body, createdAt,
      ...(direction === "from" ? { familyMessageId: data.messageId, peerId: data.peerId,
        delivery: { state: "accepted", acceptedAt: createdAt, deliveredAt: null } } : {}) };
  }
  if (entry.type === "custom" && entry.customType === CHILD_CREATION_ENTRY_TYPE) {
    const data = entry.data; const childName = bounded(data?.childName, 256, 1024);
    const taskId = bounded(data?.taskId, 128, 512); const childId = bounded(data?.childId, 128, 512);
    const body = bounded(data?.body, MAX_CHILD_BODY_BYTES, MAX_CHILD_BODY_BYTES);
    if (!childName || data?.relationship !== "child" || !body || !taskId || !childId) return undefined;
    return { kind: "child_creation", id, taskId, childId, childName,
      relationship: "child", body, createdAt };
  }
  return undefined;
}

export function projectAgentMessageHistoryMessage(item) {
  const id = bounded(item?.id ?? item?.entryId, 256, 1024); const createdAt = timestamp(item?.createdAt);
  const direction = ["from", "to"].includes(item?.direction) ? item.direction : undefined;
  const peerRelationship = relationship(item?.relationship);
  const peerName = bounded(item?.peerName, 256, 1024);
  const body = bounded(item?.body, MAX_BODY_BYTES, MAX_BODY_BYTES);
  if (!id || !createdAt || !direction || !peerRelationship || !peerName || !body) return undefined;
  return { id, role: "agent_message", text: body, direction, relationship: peerRelationship,
    peerName, createdAt, status: "complete",
    ...Object.fromEntries(["familyMessageId", "peerId", "entryId", "deliveryMode", "transportState", "delivery"]
      .filter(key => item[key] !== undefined).map(key => [key, item[key]])) };
}

export function durableIncomingMessageId(entry) {
  if (entry?.type !== "custom" || entry.customType !== AGENT_MESSAGE_ENTRY_TYPE || entry.data?.direction !== "from") return undefined;
  return bounded(entry.data?.messageId, 128, 512);
}
export function injectedIncomingMessageId(entry) {
  if (entry?.type !== "custom_message" || entry.customType !== INCOMING_AGENT_MESSAGE_TYPE) return undefined;
  return bounded(entry.details?.messageId, 128, 512);
}
export function incomingFamilyRowId(messageId) { return `family-${messageId}`; }

// Use the canonical context entry, never its non-context transport receipt, when
// both exist. Distinct message IDs with identical bodies remain distinct rows.
export function selectIncomingFamilyMessages(items) {
  const selected = new Map();
  for (const item of items) {
    if (item?.direction !== "from" || !item.familyMessageId) continue;
    const previous = selected.get(item.familyMessageId);
    if (!previous || previous.delivery?.state !== "delivered" && item.delivery?.state === "delivered") selected.set(item.familyMessageId, item);
  }
  return items.filter(item => item?.direction !== "from" || !item.familyMessageId || selected.get(item.familyMessageId) === item);
}

export function pendingFamilyMessage(message, sender) {
  const item = projectAgentMessageEntry({ type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE,
    id: message.messageId, timestamp: message.acceptedAt,
    data: { messageId: message.messageId, direction: "from", peerId: message.senderId,
      peerName: sender?.name ?? sender?.shortId ?? message.senderId,
      relationship: message.relationship === "parent" ? "child" : message.relationship === "child" ? "parent" : message.relationship,
      body: message.body } });
  if (!item) return undefined;
  return projectAgentMessageHistoryMessage({ ...item, deliveryMode: message.deliveryMode, transportState: message.state });
}

export function projectChildCreationHistoryMessage(item) {
  const id = bounded(item?.id ?? item?.entryId, 128, 512); const createdAt = timestamp(item?.createdAt);
  const taskId = bounded(item?.taskId, 128, 512); const childId = bounded(item?.childId, 128, 512);
  const childName = bounded(item?.childName, 256, 1024);
  const body = bounded(item?.body, MAX_CHILD_BODY_BYTES, MAX_CHILD_BODY_BYTES);
  if (!id || !createdAt || !taskId || !childId || !childName || item?.relationship !== "child" || !body) return undefined;
  return { id, role: "child_creation", text: body, taskId, childId, childName,
    relationship: "child", createdAt, status: "complete" };
}
