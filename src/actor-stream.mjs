import { isDeepStrictEqual as equal } from "node:util";
import { THINKING_SIGNATURE_CUSTOM_TYPE, THINKING_SIGNATURE_VERSION } from "./canonical-context.mjs";

export const ACTOR_STREAM_LIMITS = Object.freeze({
  events: 100_000, contentBlocks: 10_000, nodes: 2_000_000,
  depth: 64, stringCodeUnits: 64 * 1024 * 1024, signatureCodeUnits: 4 * 1024 * 1024, idCodeUnits: 4096,
});
export class ActorStreamError extends Error {
  constructor(code) { super(`Actor stream rejected: ${code}`); this.name = "ActorStreamError"; this.code = code; }
}
const requireThat = (ok, code) => { if (!ok) throw new ActorStreamError(code); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const id = value => typeof value === "string" && value.length > 0 && value.length <= ACTOR_STREAM_LIMITS.idCodeUnits;

// No getters, serialization hooks, cycles, sparse arrays, or shared mutable data.
function copy(value) {
  let nodes = 0, units = 0;
  const active = new Set();
  function visit(v, depth) {
    requireThat(++nodes <= ACTOR_STREAM_LIMITS.nodes && depth <= ACTOR_STREAM_LIMITS.depth, "ERR_STREAM_DATA_LIMIT");
    if (typeof v === "string") {
      units += v.length; requireThat(units <= ACTOR_STREAM_LIMITS.stringCodeUnits, "ERR_STREAM_DATA_LIMIT"); return v;
    }
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "number") { requireThat(Number.isFinite(v), "ERR_STREAM_DATA_TYPE"); return v; }
    requireThat(typeof v === "object" && !active.has(v), "ERR_STREAM_DATA_TYPE");
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    requireThat(array ? proto === Array.prototype : proto === Object.prototype || proto === null, "ERR_STREAM_DATA_TYPE");
    const keys = Reflect.ownKeys(v);
    requireThat(keys.length <= ACTOR_STREAM_LIMITS.nodes - nodes, "ERR_STREAM_DATA_LIMIT");
    if (array) requireThat(v.length <= ACTOR_STREAM_LIMITS.nodes - nodes && keys.length === v.length + 1, "ERR_STREAM_DATA_TYPE");
    active.add(v); const out = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      requireThat(typeof key === "string", "ERR_STREAM_DATA_TYPE");
      if (array) requireThat(/^(0|[1-9]\d*)$/.test(key) && Number(key) < v.length, "ERR_STREAM_DATA_TYPE");
      const d = Object.getOwnPropertyDescriptor(v, key);
      requireThat(d.enumerable && Object.hasOwn(d, "value"), "ERR_STREAM_DATA_TYPE");
      units += key.length; requireThat(units <= ACTOR_STREAM_LIMITS.stringCodeUnits, "ERR_STREAM_DATA_LIMIT");
      Object.defineProperty(out, key, { value: visit(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(v); return out;
  }
  return visit(value, 0);
}
function freeze(value) {
  if (value && typeof value === "object") { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function signature(value) {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= ACTOR_STREAM_LIMITS.signatureCodeUnits,
    "ERR_STREAM_REASONING_SIGNATURE");
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new ActorStreamError("ERR_STREAM_REASONING_SIGNATURE"); }
  // JSON.parse alone accepts duplicate keys, including escaped duplicate names.
  const stack = [];
  for (const m of value.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]/g)) {
    const token = m[0];
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && stack.at(-1)) stack.at(-1).key = true;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const frame = stack.at(-1), key = JSON.parse(token);
      requireThat(!frame.keys.has(key), "ERR_STREAM_REASONING_SIGNATURE"); frame.keys.add(key); frame.key = false;
    }
  }
  parsed = copy(parsed);
  requireThat(record(parsed) && parsed.type === "reasoning" && id(parsed.id), "ERR_STREAM_REASONING_SIGNATURE");
  return parsed;
}
function encryptionAddition(before, after) {
  if (equal(before, after)) return null;
  requireThat(before?.type === "thinking" && after?.type === "thinking", "ERR_STREAM_CLOSED_CONTENT_CHANGED");
  const { thinkingSignature: oldSignature, ...oldBody } = before;
  const { thinkingSignature: newSignature, ...newBody } = after;
  requireThat(equal(oldBody, newBody), "ERR_STREAM_CLOSED_CONTENT_CHANGED");
  const oldItem = signature(oldSignature), newItem = signature(newSignature);
  const { encrypted_content: oldEncryption, ...oldFields } = oldItem;
  const { encrypted_content: newEncryption, ...newFields } = newItem;
  requireThat(equal(oldFields, newFields), "ERR_STREAM_REASONING_ITEM_CHANGED");
  requireThat(oldEncryption === undefined || oldEncryption === null || oldEncryption === "", "ERR_STREAM_REASONING_ENCRYPTION_CONFLICT");
  requireThat(typeof newEncryption === "string" && newEncryption.length > 0
    && newEncryption.length <= ACTOR_STREAM_LIMITS.signatureCodeUnits, "ERR_STREAM_REASONING_ENCRYPTION_CONFLICT");
  return { itemId: oldItem.id, encryptedContent: newEncryption };
}
function validateUsage(usage) {
  requireThat(record(usage) && record(usage.cost), "ERR_STREAM_USAGE");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
    requireThat(Number.isFinite(usage[key]) && usage[key] >= 0, "ERR_STREAM_USAGE");
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"])
    requireThat(Number.isFinite(usage.cost[key]) && usage.cost[key] >= 0, "ERR_STREAM_USAGE");
}
function validateCall(call) {
  requireThat(call?.type === "toolCall" && id(call.id) && id(call.name) && record(call.arguments), "ERR_STREAM_CALL");
}

/**
 * One original, read-only stream planner per inference epoch. The caller passes
 * only adapter.nativeCompletion(event) receipts, validates message_end replacements
 * through prepareCommit before writing, acknowledges the actual canonical entry,
 * rechecks its epoch, and owns all tool dispatch/results.
 * Serializable async/provenance fields never establish admission authority here.
 */
export function createActorStreamPlanner({ message, createMessageId, createTextId }) {
  const base = copy(message);
  requireThat(base?.role === "assistant" && id(base.id) && Array.isArray(base.content) && base.content.length === 0
    && Number.isFinite(base.timestamp) && [base.api, base.provider, base.model].every(id), "ERR_STREAM_BASE_MESSAGE");
  validateUsage(base.usage);
  requireThat(typeof createMessageId === "function" && typeof createTextId === "function", "ERR_STREAM_ID_FACTORY");
  const slots = new Map(), proofs = new Map(), textIds = new Map(), identities = new Set([base.id]);
  const bindings = new Map(), entryIds = new Set(), callIds = new Map(), reasoningIds = new Map(), acknowledgedCallIds = new Set();
  let started = false, terminal = false, canceled = false, failed = false, cursor = 0;
  let count = 0, planNumber = 0, segmentNumber = 0, segmentId = base.id, pending = null, latest = base, responseIdentity, nextSegmentId, prepared = false, pendingRemainder;

  function newId(factory, input) {
    const value = factory(input);
    requireThat(id(value) && !identities.has(value), "ERR_STREAM_DUPLICATE_CORE_ID"); identities.add(value); return value;
  }
  function normalize(block, index, admitted = false) {
    requireThat(record(block) && ["text", "thinking", "toolCall", "image"].includes(block.type), "ERR_STREAM_CONTENT");
    const result = copy(block);
    if (block.type === "text") {
      requireThat(typeof block.text === "string", "ERR_STREAM_CONTENT");
      if (!textIds.has(index)) textIds.set(index, newId(createTextId, { sourceIndex: index }));
      result.id = textIds.get(index);
    }
    if (block.type === "image") requireThat(typeof block.data === "string" && id(block.mimeType), "ERR_STREAM_CONTENT");
    if (block.type === "thinking") requireThat(typeof block.thinking === "string", "ERR_STREAM_CONTENT");
    for (const key of ["thinkingSignature", "textSignature", "thoughtSignature"]) if (block[key] !== undefined)
      requireThat(typeof block[key] === "string" && block[key].length <= ACTOR_STREAM_LIMITS.signatureCodeUnits, "ERR_STREAM_SIGNATURE_LIMIT");
    if (block.type === "toolCall" && !admitted) delete result.async;
    return result;
  }
  function envelope(raw, content, stopReason) {
    const result = { ...base, ...raw, id: segmentId, timestamp: base.timestamp, content, stopReason };
    result.usage = stopReason === "pending" || stopReason === "toolUse" && !terminal ? zeroUsage() : copy(raw.usage);
    return result;
  }
  function live() {
    requireThat(!canceled, "ERR_STREAM_CANCELED"); requireThat(!failed, "ERR_STREAM_FAILED");
    requireThat(pending === null, "ERR_STREAM_ACK_REQUIRED");
  }
  function view(raw) {
    return raw.content.map((block, i) => slots.get(i)?.block ?? normalize(block, i));
  }
  function makePlan(kind, content, end, reason) {
    const calls = [];
    const executable = kind === "prefix" || reason === "stop" || reason === "toolUse";
    const seen = new Set();
    for (let i = 0; i < content.length; i++) {
      const block = content[i], sourceIndex = cursor + i;
      if (block.type !== "toolCall") continue;
      if (executable || reason === "length") validateCall(block);
      if (id(block.id)) {
        requireThat(!seen.has(block.id), "ERR_STREAM_DUPLICATE_CALL_ID"); seen.add(block.id);
      }
      const native = executable && proofs.has(sourceIndex);
      if (!native) delete block.async;
      if (executable || reason === "length") calls.push({ call: copy(block), native, sourceIndex, contentIndex: i,
        disposition: executable ? "execute" : "blocked_truncated" });
    }
    pendingRemainder = undefined;
    if (kind === "prefix") {
      nextSegmentId = newId(createMessageId, { segmentIndex: segmentNumber + 1, sourceStart: end });
      let observedEnd = end;
      for (const index of slots.keys()) observedEnd = Math.max(observedEnd, index + 1);
      if (observedEnd > end) {
        // Prepare before any write. Shared provider partials can be ahead of
        // event delivery; previously observed slot bodies remain authoritative.
        const remaining = latest.content.slice(end, observedEnd)
          .map((block, localIndex) => slots.get(end + localIndex)?.block ?? normalize(block, end + localIndex));
        pendingRemainder = freeze({ ...envelope(latest, copy(remaining), "pending"), id: nextSegmentId });
      }
    }
    prepared = false;
    pending = freeze({ planId: ++planNumber, kind, sourceStart: cursor, sourceEnd: end,
      message: envelope(latest, content, reason), calls });
    return pending;
  }
  function consume(input, verifiedProof = null) {
    try {
      live(); requireThat(!terminal, "ERR_STREAM_TERMINAL");
      requireThat(++count <= ACTOR_STREAM_LIMITS.events, "ERR_STREAM_EVENT_LIMIT");
      const event = copy(input), proof = verifiedProof == null ? null : copy(verifiedProof);
      requireThat(record(event), "ERR_STREAM_EVENT");
      const ending = event.type === "done" || event.type === "error";
      const raw = event.partial ?? (event.type === "done" ? event.message : event.error);
      requireThat(record(raw) && raw.role === "assistant" && Array.isArray(raw.content)
        && raw.content.length <= ACTOR_STREAM_LIMITS.contentBlocks && raw.content.length >= cursor, "ERR_STREAM_MESSAGE");
      for (const key of ["api", "provider", "model"]) requireThat(raw[key] === base[key], "ERR_STREAM_PROVIDER_CHANGED");
      requireThat(!proof || event.type === "toolcall_end", "ERR_STREAM_PROOF_EVENT");
      if (raw.responseId !== undefined) {
        requireThat(id(raw.responseId) && (responseIdentity === undefined || raw.responseId === responseIdentity), "ERR_STREAM_RESPONSE_CHANGED");
        responseIdentity = raw.responseId;
      }
      for (const [i, slot] of slots) {
        requireThat(i < raw.content.length && slot.block.type === raw.content[i]?.type, "ERR_STREAM_SOURCE_CHANGED");
        if (slot.closed) {
          if (proofs.has(i)) requireThat(equal(proofs.get(i).call, raw.content[i]), "ERR_STREAM_PROVED_CALL_CHANGED");
          encryptionAddition(normalize(slot.block, i, proofs.has(i)), normalize(raw.content[i], i, proofs.has(i)));
        }
      }
      latest = raw;
      if (event.type === "start") {
        requireThat(!started, "ERR_STREAM_DUPLICATE_START"); started = true;
        return freeze({ update: { message: envelope(raw, [], "pending"), assistantMessageEvent: { type: "start" } }, amendments: [] });
      }
      requireThat(started || event.type === "error", "ERR_STREAM_START_REQUIRED");
      if (ending) {
        const reason = event.reason;
        requireThat(event.type === "done" ? ["stop", "toolUse", "length", "deferred"].includes(reason)
          : ["error", "aborted"].includes(reason), "ERR_STREAM_TERMINAL_REASON");
        requireThat(raw.stopReason === reason, "ERR_STREAM_TERMINAL_REASON");
        validateUsage(raw.usage);
        const successful = reason === "stop" || reason === "toolUse";
        const contents = raw.content.map((block, i) => normalize(block, i, proofs.has(i) && (i < cursor || successful)));
        const seen = new Set(), amendments = [];
        contents.forEach((block, i) => {
          if (block.type === "thinking" && base.api.endsWith("responses") && block.thinkingSignature !== undefined) {
            const item = signature(block.thinkingSignature);
            requireThat(!reasoningIds.has(item.id) || reasoningIds.get(item.id) === i, "ERR_STREAM_DUPLICATE_REASONING_ID");
            reasoningIds.set(item.id, i);
          }
        });
        for (const [i, slot] of slots) {
          requireThat(i < contents.length && slot.block.type === contents[i].type, "ERR_STREAM_SOURCE_CHANGED");
          if (slot.closed) {
            // Receipt equality is checked before fresh admission-marker normalization.
            if (proofs.has(i)) requireThat(equal(proofs.get(i).call, raw.content[i]), "ERR_STREAM_PROVED_CALL_CHANGED");
            const before = normalize(slot.block, i, proofs.has(i) && (i < cursor || successful));
            const addition = encryptionAddition(before, contents[i]);
            if (addition && i < cursor) {
              const binding = bindings.get(i);
              requireThat(binding && equal(binding.block, slot.block), "ERR_STREAM_AMENDMENT_TARGET");
              amendments.push({ customType: THINKING_SIGNATURE_CUSTOM_TYPE,
                data: { version: THINKING_SIGNATURE_VERSION, messageEntryId: binding.entryId,
                  messageId: binding.messageId, contentIndex: binding.contentIndex, ...addition } });
            }
          }
        }
        for (const part of contents) if (part.type === "toolCall" && id(part.id)) {
          requireThat(!seen.has(part.id), "ERR_STREAM_DUPLICATE_CALL_ID"); seen.add(part.id);
        }
        terminal = true;
        return freeze({ final: makePlan("final", contents.slice(cursor), contents.length, reason), amendments });
      }
      const match = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(event.type);
      requireThat(match && Number.isInteger(event.contentIndex) && event.contentIndex >= cursor
        && event.contentIndex < raw.content.length, "ERR_STREAM_CONTENT_INDEX");
      const index = event.contentIndex, kind = match[1] === "toolcall" ? "toolCall" : match[1], phase = match[2];
      const incoming = normalize(raw.content[index], index);
      requireThat(incoming.type === kind, "ERR_STREAM_BLOCK_KIND");
      let slot = slots.get(index);
      requireThat(!slot?.closed, "ERR_STREAM_DUPLICATE_END");
      if (phase === "start") {
        requireThat(!slot, "ERR_STREAM_DUPLICATE_BLOCK_START");
        if (kind === "text" || kind === "thinking") incoming[kind] = kind === "thinking" && incoming.redacted ? incoming.thinking : "";
        slot = { block: incoming, closed: false }; slots.set(index, slot);
      } else {
        requireThat(slot && slot.block.type === kind, "ERR_STREAM_BLOCK_START_REQUIRED");
        if (kind === "toolCall") {
          for (const key of ["id", "name"]) if (id(slot.block[key]))
            requireThat(slot.block[key] === incoming[key], "ERR_STREAM_CALL_IDENTITY_CHANGED");
          slot.block = incoming;
          if (phase === "end") {
            validateCall(event.toolCall);
            requireThat(!callIds.has(event.toolCall.id) || callIds.get(event.toolCall.id) === index, "ERR_STREAM_DUPLICATE_CALL_ID");
            callIds.set(event.toolCall.id, index);
            requireThat(equal(normalize(event.toolCall, index), incoming), "ERR_STREAM_CALL_EVENT_MISMATCH");
            slot.block = normalize(event.toolCall, index);
            if (proof) {
              requireThat(proof.native === true && proof.complete === true && id(proof.responseId)
                && id(proof.itemId) && id(proof.callId) && proof.call?.async === true
                && proof.call.providerCallId === proof.callId && proof.call.providerItemId === proof.itemId
                && proof.call.id === `${proof.callId}|${proof.itemId}` && equal(proof.call, event.toolCall)
                && (!raw.responseId || proof.responseId === raw.responseId), "ERR_STREAM_PROOF_MISMATCH");
              requireThat(responseIdentity === undefined || responseIdentity === proof.responseId, "ERR_STREAM_RESPONSE_CHANGED");
              responseIdentity = proof.responseId;
              proofs.set(index, freeze(proof)); slot.block = copy(proof.call);
            }
          } else requireThat(typeof event.delta === "string", "ERR_STREAM_DELTA");
        } else {
          requireThat(typeof (phase === "end" ? event.content : event.delta) === "string", "ERR_STREAM_DELTA");
          const body = phase === "end" ? event.content : slot.block[kind] + event.delta;
          slot.block = { ...incoming, [kind]: body };
        }
        if (phase === "end") {
          if (kind === "thinking" && base.api.endsWith("responses") && slot.block.thinkingSignature !== undefined) {
            const item = signature(slot.block.thinkingSignature);
            requireThat(!reasoningIds.has(item.id) || reasoningIds.get(item.id) === index, "ERR_STREAM_DUPLICATE_REASONING_ID");
            reasoningIds.set(item.id, index);
          }
          slot.closed = true;
        }
      }
      const content = view(raw), updateEvent = { ...event, contentIndex: index - cursor };
      delete updateEvent.partial;
      if (kind === "text" && phase === "start") updateEvent.id = textIds.get(index);
      const result = { update: { message: envelope(raw, copy(content.slice(cursor)), "pending"), assistantMessageEvent: updateEvent }, amendments: [] };
      let end = cursor;
      for (let i = cursor; i < content.length; i++) {
        const item = slots.get(i);
        if (!item?.closed) break;
        if (item.block.type === "toolCall") { if (!proofs.has(i)) break; end = i + 1; }
      }
      if (end > cursor) result.prefix = makePlan("prefix", copy(content.slice(cursor, end)), end, "toolUse");
      return freeze(result);
    } catch (error) { failed = true; throw error; }
  }
  // Call after the public message_end hook and before the sole writer appends.
  // This validates a detached replacement; it never runs hooks or writes history.
  function prepareCommit(input) {
    try {
      requireThat(!canceled && !failed, canceled ? "ERR_STREAM_CANCELED" : "ERR_STREAM_FAILED");
      const request = copy(input);
      requireThat(pending && !prepared && request.planId === pending.planId, "ERR_STREAM_PREPARE_PLAN");
      const candidate = request.message, original = pending.message;
      requireThat(record(candidate) && Array.isArray(candidate.content)
        && candidate.content.length <= ACTOR_STREAM_LIMITS.contentBlocks, "ERR_STREAM_COMMIT_MESSAGE");
      const protectedEnvelope = ({ content, usage, errorMessage, stopReason, ...rest }) => rest;
      requireThat(equal(protectedEnvelope(candidate), protectedEnvelope(original)), "ERR_STREAM_PROTECTED_ENVELOPE");
      validateUsage(candidate.usage);
      requireThat(candidate.errorMessage === undefined || typeof candidate.errorMessage === "string", "ERR_STREAM_COMMIT_MESSAGE");
      requireThat(["stop", "toolUse", "length", "error", "aborted", "deferred"].includes(candidate.stopReason), "ERR_STREAM_TERMINAL_REASON");
      const executable = candidate.stopReason === "stop" || candidate.stopReason === "toolUse";
      const wasExecutable = original.stopReason === "stop" || original.stopReason === "toolUse";
      requireThat(wasExecutable || !executable, "ERR_STREAM_UNSAFE_STOP_UPGRADE");
      if (pending.kind === "prefix") requireThat(candidate.stopReason === "toolUse"
        && candidate.content.length === original.content.length, "ERR_STREAM_PROTECTED_PREFIX");

      const oldNonCalls = original.content.filter(block => block.type !== "toolCall");
      const nonCalls = candidate.content.filter(block => block?.type !== "toolCall");
      requireThat(nonCalls.length === oldNonCalls.length, "ERR_STREAM_UNSUPPORTED_NONCALL_LAYOUT");
      nonCalls.forEach((block, i) => {
        const before = oldNonCalls[i];
        requireThat(record(block) && block.type === before.type, "ERR_STREAM_UNSUPPORTED_NONCALL_LAYOUT");
        if (block.type === "text") {
          requireThat(typeof block.text === "string", "ERR_STREAM_CONTENT");
          // Common hook replacements omit harness identity fields. Restore them,
          // but never accept an explicitly conflicting core/provider identity.
          if (block.id === undefined) block.id = before.id;
          if (block.textSignature === undefined && Object.hasOwn(before, "textSignature")) block.textSignature = before.textSignature;
          const { text: oldText, ...oldFields } = before;
          const { text: newText, ...newFields } = block;
          requireThat(equal(oldFields, newFields), "ERR_STREAM_PROTECTED_TEXT_METADATA");
        } else requireThat(equal(block, before), "ERR_STREAM_PROTECTED_CONTENT");
      });
      if (pending.kind === "prefix") candidate.content.forEach((block, i) => {
        const before = original.content[i];
        requireThat(block.type === before.type && (block.type === "text" || equal(block, before)), "ERR_STREAM_PROTECTED_PREFIX");
      });

      const originalCalls = new Map();
      original.content.forEach((block, i) => { if (block.type === "toolCall" && id(block.id)) originalCalls.set(block.id, pending.sourceStart + i); });
      const seen = new Set(), calls = [];
      let lastNativeSource = -1;
      candidate.content.forEach((block, contentIndex) => {
        if (block.type !== "toolCall") return;
        if (executable || candidate.stopReason === "length") validateCall(block);
        if (id(block.id)) {
          requireThat(!seen.has(block.id) && !acknowledgedCallIds.has(block.id), "ERR_STREAM_DUPLICATE_CALL_ID");
          seen.add(block.id);
        }
        const sourceIndex = originalCalls.get(block.id) ?? null;
        const proof = sourceIndex === null ? undefined : proofs.get(sourceIndex);
        const native = executable && !!proof && equal(block, proof.call);
        if (native) {
          requireThat(sourceIndex > lastNativeSource, "ERR_STREAM_NATIVE_SOURCE_ORDER"); lastNativeSource = sourceIndex;
        } else delete block.async;
        if (executable || candidate.stopReason === "length") calls.push({ call: copy(block), native, sourceIndex, contentIndex,
          disposition: executable ? "execute" : "blocked_truncated" });
      });
      // Recheck aggregate bounds after restoring omitted identity fields.
      pending = freeze({ ...pending, message: copy(candidate), calls }); prepared = true;
      return pending;
    } catch (error) { failed = true; throw error; }
  }
  function acknowledge(input) {
    try {
      requireThat(!canceled && !failed, canceled ? "ERR_STREAM_CANCELED" : "ERR_STREAM_FAILED");
      const ack = copy(input);
      requireThat(pending && ack.planId === pending.planId && id(ack.entryId) && !entryIds.has(ack.entryId)
        && equal(ack.message, pending.message), "ERR_STREAM_COMMIT_MISMATCH");
      const plan = pending;
      for (let i = 0; i < plan.message.content.length; i++) bindings.set(cursor + i, {
        entryId: ack.entryId, messageId: ack.message.id, contentIndex: i, block: copy(ack.message.content[i]),
      });
      for (const block of ack.message.content) if (block.type === "toolCall" && id(block.id)) acknowledgedCallIds.add(block.id);
      entryIds.add(ack.entryId); cursor = plan.sourceEnd; pending = null;
      if (!terminal) { segmentId = nextSegmentId; segmentNumber++; }
      // Publication is the caller's job, after the full commit and an epoch
      // check. No new provider event is needed to rebase an already-open suffix.
      const remainder = pendingRemainder; pendingRemainder = undefined;
      return freeze({ calls: copy(plan.calls), ...(remainder ? { remainder } : {}) });
    } catch (error) { failed = true; throw error; }
  }
  return Object.freeze({ consume, prepareCommit, acknowledge, cancel() { canceled = true; pending = null; pendingRemainder = undefined; } });
}
