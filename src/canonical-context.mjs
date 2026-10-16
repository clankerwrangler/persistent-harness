import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { conversationBirth } from "./conversation-birth.mjs";
import { inputIdForEntry } from "./conversation-projection.mjs";

/** appendCustomEntry(THINKING_SIGNATURE_CUSTOM_TYPE, data). No message append. */
export const THINKING_SIGNATURE_CUSTOM_TYPE = "persistent-harness:assistant-thinking-signature:v1";
export const THINKING_SIGNATURE_VERSION = 1;
export const CANONICAL_CONTEXT_LIMITS = Object.freeze({
  entries: 100_000,
  nodes: 2_000_000,
  depth: 64,
  stringCodeUnits: 64 * 1024 * 1024,
  signatureCodeUnits: 4 * 1024 * 1024,
  contentBlocks: 10_000,
  idCodeUnits: 4096,
});

export class CanonicalContextError extends Error {
  constructor(code) {
    super(`Canonical context rejected: ${code}`);
    this.name = "CanonicalContextError";
    this.code = code;
  }
}

function requireThat(condition, code) {
  if (!condition) throw new CanonicalContextError(code);
}

/** Effective process-wide materialized-view budget; no per-request override. */
export function getCanonicalContextStringCodeUnits() {
  const value = process.env.PI_HARNESS_CONTEXT_STRING_CODE_UNITS;
  if (value === undefined) return CANONICAL_CONTEXT_LIMITS.stringCodeUnits;
  requireThat(/^[1-9][0-9]{0,8}$/.test(value), "ERR_CONTEXT_BUDGET_CONFIG");
  const units = Number(value);
  requireThat(Number.isSafeInteger(units) && units >= CANONICAL_CONTEXT_LIMITS.stringCodeUnits
    && units <= 256 * 1024 * 1024, "ERR_CONTEXT_BUDGET_CONFIG");
  return units;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === "string" && value.length > 0
    && value.length <= CANONICAL_CONTEXT_LIMITS.idCodeUnits;
}

// Accept plain SDK data, including optional undefined object fields. Do not invoke
// getters, toJSON(), or custom clone hooks. Returned data never aliases the input.
function copyData(value, { archiveRecordUnits, stringCodeUnits = CANONICAL_CONTEXT_LIMITS.stringCodeUnits, budget } = {}) {
  let nodes = budget?.nodes ?? 0, codeUnits = budget?.codeUnits ?? 0;
  const ancestors = new Set();
  function copy(item, depth) {
    requireThat(++nodes <= CANONICAL_CONTEXT_LIMITS.nodes && depth <= CANONICAL_CONTEXT_LIMITS.depth,
      "ERR_CONTEXT_DATA_LIMIT");
    if (typeof item === "string") {
      codeUnits += item.length;
      requireThat(codeUnits <= stringCodeUnits, "ERR_CONTEXT_DATA_LIMIT");
      return item;
    }
    if (item === null || item === undefined || typeof item === "boolean") return item;
    if (typeof item === "number") {
      requireThat(Number.isFinite(item), "ERR_CONTEXT_DATA_TYPE");
      return item;
    }
    requireThat(typeof item === "object", "ERR_CONTEXT_DATA_TYPE");
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    requireThat(array ? proto === Array.prototype : proto === Object.prototype || proto === null,
      "ERR_CONTEXT_DATA_TYPE");
    requireThat(!ancestors.has(item), "ERR_CONTEXT_DATA_CYCLE");
    ancestors.add(item);
    const keys = Reflect.ownKeys(item);
    requireThat(keys.length <= CANONICAL_CONTEXT_LIMITS.nodes - nodes, "ERR_CONTEXT_DATA_LIMIT");
    if (array) requireThat(item.length <= CANONICAL_CONTEXT_LIMITS.nodes - nodes, "ERR_CONTEXT_DATA_LIMIT");
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      requireThat(typeof key === "string", "ERR_CONTEXT_DATA_TYPE");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireThat(descriptor.enumerable && Object.hasOwn(descriptor, "value"), "ERR_CONTEXT_DATA_TYPE");
      if (array) requireThat(/^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length,
        "ERR_CONTEXT_DATA_TYPE");
      // Archive records share the node/depth/cycle budget, not a lifetime string sum.
      // Include the top-level array slot key in that record's string accounting.
      if (archiveRecordUnits && depth === 0) codeUnits = 0;
      codeUnits += key.length;
      requireThat(codeUnits <= stringCodeUnits, "ERR_CONTEXT_DATA_LIMIT");
      const copied = copy(descriptor.value, depth + 1);
      if (archiveRecordUnits && depth === 0 && copied !== null && typeof copied === "object") {
        archiveRecordUnits.set(copied, codeUnits);
      }
      Object.defineProperty(result, key, {
        value: copied, enumerable: true, writable: true, configurable: true,
      });
    }
    if (array) requireThat(result.length === item.length && keys.length === item.length + 1,
      "ERR_CONTEXT_DATA_TYPE");
    ancestors.delete(item);
    return result;
  }
  const result = copy(value, budget?.depth ?? 0);
  if (budget) { budget.nodes = nodes; budget.codeUnits = codeUnits; }
  return result;
}

// This policy is private to archive snapshots. The returned view and other data
// copies retain aggregate string limits. All records and opaque fields survive.
function copyArchive(entries) {
  requireThat(Array.isArray(entries) && entries.length <= CANONICAL_CONTEXT_LIMITS.entries,
    "ERR_CONTEXT_ENTRIES");
  const recordUnits = new WeakMap();
  return { entries: copyData(entries, { archiveRecordUnits: recordUnits }), recordUnits };
}

/** Detach every archive container while sharing immutable strings. Keep opaque
 * and inactive records intact, with the same validation as canonical projection.
 */
export function snapshotCanonicalArchive(entries) {
  return copyArchive(entries).entries;
}

function selectBranch(entries, leafId) {
  requireThat(Array.isArray(entries) && entries.length <= CANONICAL_CONTEXT_LIMITS.entries,
    "ERR_CONTEXT_ENTRIES");
  requireThat(leafId === null || identifier(leafId), "ERR_CONTEXT_LEAF");
  const byId = new Map();
  for (const entry of entries) {
    requireThat(isRecord(entry) && identifier(entry.id) && identifier(entry.type)
      && (entry.parentId === null || identifier(entry.parentId)), "ERR_CONTEXT_ENTRY");
    requireThat(!byId.has(entry.id), "ERR_CONTEXT_DUPLICATE_ENTRY_ID");
    byId.set(entry.id, entry);
  }
  const reverse = [], seen = new Set();
  for (let id = leafId; id !== null;) {
    requireThat(!seen.has(id), "ERR_CONTEXT_BRANCH_CYCLE");
    const entry = byId.get(id);
    requireThat(entry !== undefined, "ERR_CONTEXT_BRANCH_MISSING");
    seen.add(id);
    reverse.push(entry);
    id = entry.parentId;
  }
  return reverse.reverse();
}

function parseSignature(signature) {
  requireThat(typeof signature === "string" && signature.length > 0
    && signature.length <= CANONICAL_CONTEXT_LIMITS.signatureCodeUnits, "ERR_SIGNATURE_DATA");
  let parsed;
  try { parsed = JSON.parse(signature); } catch { throw new CanonicalContextError("ERR_SIGNATURE_JSON"); }
  parsed = copyData(parsed);
  // JSON.parse accepts duplicate object keys. Reject them before choosing an item
  // identity or encryption value. Syntax was checked by JSON.parse, so tokens
  // inside strings and primitive values cannot be mistaken for object keys.
  const stack = [];
  for (const match of signature.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]/g)) {
    const token = match[0];
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && stack.at(-1)) stack.at(-1).key = true;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const frame = stack.at(-1), key = JSON.parse(token);
      requireThat(!frame.keys.has(key), "ERR_SIGNATURE_DUPLICATE_KEY");
      frame.keys.add(key);
      frame.key = false;
    }
  }
  requireThat(isRecord(parsed), "ERR_SIGNATURE_DATA");
  return parsed;
}

function overlaySignatures(selected, diagnostics, recordUnits) {
  const prior = new Map();
  for (const entry of selected) {
    let data;
    if (entry.type === "assistant_thinking_signature") data = entry;
    if (entry.type === "custom" && entry.customType === THINKING_SIGNATURE_CUSTOM_TYPE) {
      requireThat(isRecord(entry.data) && entry.data.version === THINKING_SIGNATURE_VERSION,
        "ERR_SIGNATURE_VERSION");
      data = entry.data;
    }
    if (data) {
      requireThat(identifier(data.messageEntryId) && identifier(data.messageId) && identifier(data.itemId)
        && Number.isSafeInteger(data.contentIndex) && data.contentIndex >= 0
        && data.contentIndex < CANONICAL_CONTEXT_LIMITS.contentBlocks
        && typeof data.encryptedContent === "string" && data.encryptedContent.length > 0
        && data.encryptedContent.length <= CANONICAL_CONTEXT_LIMITS.signatureCodeUnits,
      "ERR_SIGNATURE_DATA");
      const target = prior.get(data.messageEntryId);
      requireThat(target?.type === "message" && target.message?.role === "assistant"
        && target.message.id === data.messageId, "ERR_SIGNATURE_TARGET");
      const block = target.message.content?.[data.contentIndex];
      requireThat(block?.type === "thinking", "ERR_SIGNATURE_CONTENT_INDEX");
      const item = parseSignature(block.thinkingSignature);
      requireThat(item.type === "reasoning" && item.id === data.itemId, "ERR_SIGNATURE_ITEM");
      requireThat(item.encrypted_content === undefined || item.encrypted_content === null
        || item.encrypted_content === "" || item.encrypted_content === data.encryptedContent,
      "ERR_SIGNATURE_ENCRYPTION_CONFLICT");
      if (item.encrypted_content !== data.encryptedContent) {
        const signature = JSON.stringify({ ...item, encrypted_content: data.encryptedContent });
        const units = recordUnits.get(target) - block.thinkingSignature.length + signature.length;
        requireThat(units <= CANONICAL_CONTEXT_LIMITS.stringCodeUnits, "ERR_CONTEXT_DATA_LIMIT");
        // Separately bounded amendments must not concentrate an oversized target.
        recordUnits.set(target, units);
        block.thinkingSignature = signature;
      }
      diagnostics.push({ code: "SIGNATURE_OVERLAY", severity: "info", entryId: entry.id,
        messageEntryId: data.messageEntryId, contentIndex: data.contentIndex });
    }
    prior.set(entry.id, entry);
  }
}

function validateMessage(message) {
  requireThat(isRecord(message) && identifier(message.role), "ERR_CONTEXT_MESSAGE");
  if (message.role === "assistant" || message.role === "toolResult") {
    requireThat(Array.isArray(message.content) && message.content.length <= CANONICAL_CONTEXT_LIMITS.contentBlocks,
      "ERR_CONTEXT_CONTENT");
    for (const block of message.content) requireThat(isRecord(block) && identifier(block.type), "ERR_CONTEXT_CONTENT");
  }
  if (message.role === "toolResult") requireThat(identifier(message.toolCallId)
    && identifier(message.toolName) && typeof message.isError === "boolean", "ERR_CONTEXT_RESULT");
}

function indexMessages(records) {
  const calls = new Map(), results = new Map();
  records.forEach(({ message, entryId }, order) => {
    validateMessage(message);
    if (message.role === "assistant") {
      message.content.forEach((call, contentIndex) => {
        if (call.type !== "toolCall") return;
        requireThat(identifier(call.id) && identifier(call.name) && isRecord(call.arguments)
          && (call.async === undefined || typeof call.async === "boolean"), "ERR_CONTEXT_CALL");
        requireThat(!calls.has(call.id), "ERR_CONTEXT_DUPLICATE_CALL_ID");
        calls.set(call.id, { call, message, entryId, contentIndex, order });
      });
    }
    if (message.role === "toolResult") {
      requireThat(!results.has(message.toolCallId), "ERR_CONTEXT_DUPLICATE_RESULT_ID");
      results.set(message.toolCallId, { message, entryId, order });
    }
  });
  for (const [id, result] of results) {
    const call = calls.get(id);
    if (!call) continue;
    requireThat(call.call.name === result.message.toolName, "ERR_CONTEXT_RESULT_NAME");
    requireThat(call.order < result.order, "ERR_CONTEXT_RESULT_BEFORE_CALL");
  }
  return { calls, results };
}

function validateCompactions(selected) {
  const latest = selected.findLastIndex(entry => entry.type === "compaction");
  if (latest < 0) return;
  const effective = selected[latest];
  const kept = selected.findIndex(entry => entry.id === effective.firstKeptEntryId);
  // The installed coding SDK reads only the effective firstKept anchor. An
  // unused retainedTail extra is not context, an admission, or a recovery result.
  requireThat(identifier(effective.firstKeptEntryId) && kept >= 0 && kept <= latest,
    "ERR_CONTEXT_COMPACTION");
  // Stock 0.99 projects only the latest checkpoint, even if an older one lies
  // in its retained range. Obsolete summary fields are not model context.
  requireThat(typeof effective.summary === "string" && Number.isFinite(effective.tokensBefore)
    && effective.tokensBefore >= 0, "ERR_CONTEXT_COMPACTION");
}

// Stock owns branch-local edit application and checkpoint expansion. Preserve
// entry metadata using its public source provenance, not summary-text matching.
function projectStockContext(context, selected, stringCodeUnits, editedTargets) {
  requireThat(isRecord(context) && Array.isArray(context.entries) && Array.isArray(context.messages), "ERR_CONTEXT_HELPER_RESULT");
  const sources = copyArchive(context.entries.map(entry => entry.sourceEntry)).entries;
  const groups = copyData(context.entries.map(entry => entry.messages), { stringCodeUnits });
  requireThat(groups.every(Array.isArray), "ERR_CONTEXT_HELPER_RESULT");
  const messages = groups.flat();
  requireThat(isDeepStrictEqual(messages, context.messages), "ERR_CONTEXT_HELPER_RESULT");
  const byId = new Map(selected.map(entry => [entry.id, entry]));
  const seen = new Set(), provenance = new WeakMap();
  for (const source of sources) {
    requireThat(!seen.has(source.id) && isDeepStrictEqual(source, byId.get(source.id)), "ERR_CONTEXT_SOURCE_PROJECTION");
    seen.add(source.id);
  }
  const edited = editedTargets ?? new Set(sources.filter(entry => entry.type === "context_edit").map(entry => entry.targetId));
  groups.forEach((group, index) => {
    const source = sources[index];
    for (const message of group) {
      provenance.set(message, { source, edited: edited.has(source.id) });
      const generated = source.type === "compaction" && message.role === "compactionSummary"
        || source.type === "branch_summary" && message.role === "branchSummary";
      if (!generated) continue;
      for (const [key, value] of Object.entries(source)) {
        if (["type", "id", "parentId", "timestamp", "summary", "fromId", "tokensBefore", "firstKeptEntryId", "retainedTail", "systemMessage"].includes(key)) continue;
        requireThat(!Object.hasOwn(message, key) || isDeepStrictEqual(message[key], value), "ERR_CONTEXT_SUMMARY_CONFLICT");
        Object.defineProperty(message, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  });
  return { messages, provenance };
}

function sameProjectedMessage(record, canonical, provenance) {
  const proof = provenance.get(record.message);
  if (!canonical || proof?.source.id !== canonical.entryId) return false;
  if (!proof.edited) return isDeepStrictEqual(record.message, canonical.message);
  const { content: projectedContent, ...projectedEnvelope } = record.message;
  const { content: canonicalContent, ...canonicalEnvelope } = canonical.message;
  // Edits may change content, never source identity or native-call provenance.
  return isDeepStrictEqual(projectedEnvelope, canonicalEnvelope)
    && (!record.call || isDeepStrictEqual(record.call, canonical.call));
}

function identity(record, retainedInContext) {
  return { toolCallId: record.call.id, toolName: record.call.name,
    messageEntryId: record.entryId, contentIndex: record.contentIndex, retainedInContext };
}

// This is evidence for exclusion, not a new admission or recovery rule. Fail
// closed on malformed, unfenced, cross-attempt, or identity-conflicting reports.
function providerPart(value) {
  return identifier(value) && !value.includes("|");
}

function providerTuple(call) {
  const parts = call.id.split("|");
  if (parts.length !== 2 || !parts.every(providerPart)) return null;
  if (Object.hasOwn(call, "providerCallId") || Object.hasOwn(call, "providerItemId")) {
    if (call.providerCallId !== parts[0] || call.providerItemId !== parts[1]) return null;
  }
  return parts;
}

function incompleteObservations(report) {
  if (!isRecord(report) || report.version !== 1 || !identifier(report.requestId)
    || !Array.isArray(report.attempts) || report.attempts.length === 0
    || report.attempts.length > CANONICAL_CONTEXT_LIMITS.contentBlocks) return new Set();
  const { version, requestId, attempts, ...latest } = report;
  if (!isDeepStrictEqual(latest, attempts.at(-1))) return new Set();
  const seenAttempts = new Set(), observations = new Map(), aliases = new Map();
  for (const [index, attempt] of attempts.entries()) {
    if (!isRecord(attempt) || !identifier(attempt.attemptId) || seenAttempts.has(attempt.attemptId)
      || attempt.attemptNumber !== index + 1 || !["websocket", "sse"].includes(attempt.transport)
      || !["sent", "created", "providerTools", "retired", "fenced", "possibleUsage"]
        .every(key => typeof attempt[key] === "boolean")
      || attempt.retired !== true || attempt.fenced !== true
      || !["not_sent", "unknown", "rejected", "failed", "completed"].includes(attempt.outcome)
      || (attempt.responseId !== undefined && !identifier(attempt.responseId))
      || !Array.isArray(attempt.observedCalls)
      || attempt.observedCalls.length > CANONICAL_CONTEXT_LIMITS.contentBlocks) return new Set();
    if ((!attempt.sent && (attempt.outcome !== "not_sent" || attempt.responseId !== undefined
      || attempt.created || attempt.possibleUsage || attempt.observedCalls.length))
      || (attempt.outcome === "not_sent" && attempt.sent)
      || (attempt.outcome === "rejected" && (attempt.created || attempt.possibleUsage || attempt.observedCalls.length))) return new Set();
    seenAttempts.add(attempt.attemptId);
    const inAttempt = new Set();
    for (const row of attempt.observedCalls) {
      if (!isRecord(row) || !providerPart(row.callId) || !providerPart(row.itemId)
        || typeof row.complete !== "boolean" || typeof row.native !== "boolean"
        || (row.native && !row.complete) || !attempt.sent) return new Set();
      const tuple = `${row.callId}|${row.itemId}`;
      // Duplicate rows and component collisions in one attempt cannot prove a
      // unique negative. Cross-attempt conflicts veto only the affected tuples.
      if (inAttempt.has(row.callId) || inAttempt.has(row.itemId)) return new Set();
      inAttempt.add(row.callId); inAttempt.add(row.itemId);
      for (const alias of [row.callId, row.itemId]) {
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(tuple);
      }
      observations.set(tuple, (observations.get(tuple) ?? true) && !row.complete && !row.native);
    }
  }
  if (latest.sent !== true || latest.created !== true
    || !["unknown", "failed"].includes(latest.outcome)) return new Set();
  return new Set(latest.observedCalls.filter(row => {
    const tuple = `${row.callId}|${row.itemId}`;
    return observations.get(tuple) === true
      && aliases.get(row.callId).size === 1 && aliases.get(row.itemId).size === 1;
  }).map(row => `${row.callId}|${row.itemId}`));
}

// STOCK WebSocket and harness-observed SSE body-read diagnostics identify
// failed ordinary streams. Both STOCK agent-loop and ActorStreamPlanner admit
// ordinary calls only on a
// successful terminal, so even complete calls on this failed terminal did not
// execute. This producer discriminator is deliberately narrower than absence of
// nativeTransport: a missing/malformed native report is not ordinary evidence.
function ordinaryFailedTerminal(message) {
  return message.api === "openai-codex-responses" && message.provider === "openai-codex"
    && !Object.hasOwn(message, "nativeTransport") && !Object.hasOwn(message, "nativeProviderError")
    && message.content.every(call => call.type !== "toolCall"
      || (call.async !== true && !Object.hasOwn(call, "nativeProvenance")
        && !Object.hasOwn(call, "providerCallId") && !Object.hasOwn(call, "providerItemId")))
    && Array.isArray(message.diagnostics) && message.diagnostics.some(item =>
      isRecord(item) && item.type === "provider_transport_failure"
      && isRecord(item.details) && item.details.eventsEmitted === true
      && item.details.phase === "after_message_stream_start"
      && (Object.hasOwn(item.details, "producer") || Object.hasOwn(item.details, "transport")
        ? item.details.producer === "persistent-harness-sse-body-read-v1" && item.details.transport === "sse"
          && ["auto", "sse", "websocket"].includes(item.details.configuredTransport) && message.stopReason === "error"
        : ["auto", "websocket"].includes(item.details.configuredTransport)));
}

function omissionAliases(canonical, selected) {
  // Index the FULL selected branch, including calls/results before a compaction
  // cut. Even an orphan result with a plain provider call ID vetoes exclusion.
  const aliases = new Map();
  const addAliases = (owner, id, call) => {
    const values = [id, ...id.split("|"), call?.providerCallId, call?.providerItemId];
    for (const value of values) if (identifier(value)) {
      if (!aliases.has(value)) aliases.set(value, new Set());
      aliases.get(value).add(owner);
    }
  };
  for (const [id, record] of canonical.calls) addAliases(record, id, record.call);
  for (const [id, record] of canonical.results) addAliases(record, id);
  // Peer envelopes can carry terminal observations without a call block (for
  // example a coordinator failure). They may veto, but never grant, exclusion.
  const observedAliases = new Map();
  for (const entry of selected) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const report = entry.message.nativeTransport;
    if (!isRecord(report)) continue;
    for (const snapshot of [report, ...(Array.isArray(report.attempts) ? report.attempts : [])]) {
      if (!isRecord(snapshot) || !Array.isArray(snapshot.observedCalls)) continue;
      for (const row of snapshot.observedCalls) {
        if (!isRecord(row)) continue;
        const tuple = providerPart(row.callId) && providerPart(row.itemId)
          && row.complete === false && row.native === false ? `${row.callId}|${row.itemId}` : null;
        for (const alias of [row.callId, row.itemId]) if (identifier(alias)) {
          if (!observedAliases.has(alias)) observedAliases.set(alias, new Set());
          observedAliases.get(alias).add(tuple);
        }
      }
    }
  }
  return { aliases, observedAliases };
}

function omitUnadmittedCalls(messages, canonical, selected, diagnostics, aliasFacts) {
  const { aliases, observedAliases } = aliasFacts ?? omissionAliases(canonical, selected);
  const proof = new Map();
  for (const message of messages) {
    if (message.role !== "assistant" || !["error", "aborted"].includes(message.stopReason)) continue;
    message.content = message.content.filter(call => {
      if (call.type !== "toolCall" || call.async === true || Object.hasOwn(call, "nativeProvenance")) return true;
      const tuple = providerTuple(call), record = canonical.calls.get(call.id);
      if (!tuple || tuple.some(alias => aliases.get(alias)?.size !== 1
        || (observedAliases.has(alias) && (observedAliases.get(alias).size !== 1 || !observedAliases.get(alias).has(call.id))))
        || canonical.results.has(call.id)) return true;
      const ordinary = ordinaryFailedTerminal(record.message)
        && tuple.every(alias => !observedAliases.has(alias));
      if (!ordinary) {
        if (!proof.has(record.message)) proof.set(record.message, incompleteObservations(record.message.nativeTransport));
        if (!proof.get(record.message).has(call.id)) return true;
      }
      diagnostics.push({ code: "UNADMITTED_CALL_OMITTED", severity: "info", ...identity(record, true) });
      return false;
    });
  }
}

function ordinaryDiagnostics(messages, diagnostics) {
  let pending = new Map();
  const flush = () => {
    for (const call of pending.values()) diagnostics.push({ code: "ORDINARY_REPLAY_BLOCKED", severity: "blocking",
      toolCallId: call.id, toolName: call.name });
    pending = new Map();
  };
  for (const message of messages) {
    // Public STOCK convertToLlm omits these display/extension-only messages.
    if (message.role === "bashExecution" && message.excludeFromContext) continue;
    if (!["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(message.role)) continue;
    if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
      continue;
    }
    flush();
    if (message.role === "assistant") for (const call of message.content) {
      if (call.type !== "toolCall") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        diagnostics.push({ code: "ORDINARY_ASSISTANT_NOT_REPLAYABLE", severity: "blocking",
          toolCallId: call.id, toolName: call.name, stopReason: message.stopReason });
      } else pending.set(call.id, call);
    }
  }
  flush();
}

/** Detached selected entries, validated and signature-overlaid without compaction pruning. */
export function projectCanonicalBranch({ entries, leafId } = {}) {
  const archive = copyArchive(entries);
  const selected = selectBranch(archive.entries, leafId);
  const diagnostics = [];
  validateCompactions(selected);
  overlaySignatures(selected, diagnostics, archive.recordUnits);
  indexMessages(selected.filter(entry => entry.type === "message")
    .map(entry => ({ message: entry.message, entryId: entry.id })));
  return { entries: selected, diagnostics };
}

/**
 * Read-only selected-branch projection. entries excludes the session header;
 * leafId is explicit (null means the empty branch). buildSessionProjection is the
 * synchronous public STOCK helper, not a SessionManager method bound elsewhere.
 *
 * New signature data: {version:1, messageEntryId, messageId, contentIndex,
 * itemId, encryptedContent}. Legacy raw assistant_thinking_signature entries
 * have the same identity fields without version. Neither format grants fresh
 * native admission; async===true classifies already committed history only.
 *
 * outstanding includes compaction-pruned unanswered native calls. The owner
 * must gate ordinary handback on outstanding and all blocking diagnostics.
 */
export function projectCanonicalContext({ entries, leafId, buildSessionProjection, mode, sessionManager } = {}) {
  if (sessionManager && snapshotManagers.has(sessionManager)) return projectManagedContext(sessionManager, mode);
  const stringCodeUnits = getCanonicalContextStringCodeUnits();
  requireThat(mode === "native" || mode === "ordinary", "ERR_CONTEXT_MODE");
  requireThat(typeof buildSessionProjection === "function", "ERR_CONTEXT_HELPER");
  const { entries: selected, diagnostics } = projectCanonicalBranch({ entries, leafId });
  const canonical = indexMessages(selected.filter(entry => entry.type === "message")
    .map(entry => ({ message: entry.message, entryId: entry.id })));
  let context;
  try { context = buildSessionProjection(copyArchive(selected).entries, leafId); }
  catch { throw new CanonicalContextError("ERR_CONTEXT_HELPER_FAILED"); }
  let { messages, provenance } = projectStockContext(context, selected, stringCodeUnits);
  let retained = indexMessages(messages.map(message => ({ message })));
  for (const [id, record] of retained.calls) {
    requireThat(sameProjectedMessage(record, canonical.calls.get(id), provenance), "ERR_CONTEXT_CALL_PROJECTION");
  }
  for (const [id, record] of retained.results) {
    requireThat(sameProjectedMessage(record, canonical.results.get(id), provenance), "ERR_CONTEXT_RESULT_PROJECTION");
  }
  return finishContext({ messages, canonical, selected, diagnostics, mode, stringCodeUnits });
}

function finishContext({ messages, canonical, selected, diagnostics, mode, stringCodeUnits, aliasFacts }) {
  let retained;
  // Validate STOCK provenance and overlay canonical signatures BEFORE omitting
  // any block. The canonical index and error envelopes remain untouched.
  omitUnadmittedCalls(messages, canonical, selected, diagnostics, aliasFacts);
  retained = indexMessages(messages.map(message => ({ message })));
  const outstanding = [];
  for (const [id, record] of canonical.calls) {
    if (record.call.async === true && !canonical.results.has(id)) {
      outstanding.push(identity(record, retained.calls.has(id)));
    }
    if (retained.calls.has(id) && canonical.results.has(id) && !retained.results.has(id)) {
      diagnostics.push({ code: "RESULT_PRUNED", severity: mode === "ordinary" ? "blocking" : "info",
        ...identity(record, true) });
    }
  }
  for (const [id, record] of canonical.results) {
    if (!canonical.calls.has(id)) diagnostics.push({ code: "ORPHAN_RESULT", severity: "info",
      toolCallId: id, messageEntryId: record.entryId });
    else if (retained.results.has(id) && !retained.calls.has(id)) diagnostics.push({ code: "CALL_PRUNED", severity: "info",
      toolCallId: id, messageEntryId: record.entryId });
  }
  if (mode === "ordinary") {
    const movable = new Set([...retained.calls].filter(([id, record]) => record.call.async === true
      && retained.results.has(id)).map(([id]) => id));
    const projected = [];
    for (const message of messages) {
      if (message.role === "toolResult" && movable.has(message.toolCallId)) continue;
      projected.push(message);
      if (message.role === "assistant") for (const call of message.content) {
        if (call.type === "toolCall" && movable.has(call.id)) projected.push(retained.results.get(call.id).message);
      }
    }
    messages = projected;
    ordinaryDiagnostics(messages, diagnostics);
  }
  // Measure the whole returned view from its root, after metadata and reordering.
  return copyData({ messages, outstanding, diagnostics }, { stringCodeUnits });
}


// Registration is an ownership assertion made only by the SDK bootstrap after
// opting a literal SessionManager into committed-value snapshots. A revision
// method alone never makes default/custom managers immutable.
const snapshotManagers = new WeakMap();
export function registerCanonicalSessionManager(manager, { estimateContextTokens } = {}) {
  requireThat(typeof manager.getRevision === "function" && typeof manager.getEntriesRange === "function",
    "ERR_CONTEXT_MANAGER");
  snapshotManagers.set(manager, { state: null, estimateContextTokens });
}

export function sessionContextInput(manager, buildSessionProjection, mode) {
  return snapshotManagers.has(manager) ? { sessionManager: manager, mode }
    : { entries: manager.getEntries(), leafId: manager.getLeafId(), buildSessionProjection, mode };
}

function newArchiveState() {
  return { headers: [], byId: new Map(), profiles: new Map(), nodes: 1, stamp: null, generation: null, factCount: 0, leaf: null, selected: [], facts: null };
}

// Exact plain-data value identity: object key order is irrelevant, presence and array holes are not.
function valueDigest(value) {
  const hash = createHash("sha256");
  const visit = item => {
    if (item === null) { hash.update("null;"); return; }
    const type = typeof item;
    hash.update(`${type}:`);
    if (type !== "object") { hash.update(type === "number" && Object.is(item, -0) ? "-0;" : `${JSON.stringify(item)};`); return; }
    hash.update(Array.isArray(item) ? `array:${item.length}:` : "object:");
    for (const key of Object.keys(item).sort()) { hash.update(`${JSON.stringify(key)}:`); visit(item[key]); }
    hash.update(";");
  };
  visit(value);
  return hash.digest("hex");
}

function archiveHeader(entry, position, units, strict = true) {
  if (!strict && !isRecord(entry)) return { position };
  if (strict) requireThat(isRecord(entry) && identifier(entry.id) && identifier(entry.type)
    && (entry.parentId === null || identifier(entry.parentId)), "ERR_CONTEXT_ENTRY");
  const header = { id: entry.id, type: entry.type, parentId: entry.parentId, position, units, sourceDigest: valueDigest(entry) };
  if (entry.type === "compaction") {
    header.firstKeptEntryId = identifier(entry.firstKeptEntryId) ? entry.firstKeptEntryId : null;
    header.validCompaction = typeof entry.summary === "string" && Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0;
  }
  if (entry.type === "context_edit" && typeof entry.targetId === "string") header.editTargetId = entry.targetId;
  header.contributionRoles = entry.type === "message" ? [typeof entry.message?.role === "string" ? entry.message.role : undefined]
    : entry.type === "custom_message" ? ["custom"]
      : entry.type === "branch_summary" && entry.summary ? ["branchSummary"]
        : entry.type === "compaction" ? [...(entry.systemMessage ? ["system"] : []), "compactionSummary"] : [];
  if (entry.type === "message" && isRecord(entry.message)) header.message = messageFacts(entry.message);
  if (entry.type === "context_edit") header.edit = entry.replacement === null ? { omitted: true }
    : contentFacts(entry.replacement?.content, true);
  if (entry.type === "compaction" && entry.systemMessage) header.systemDigest = valueDigest(entry.systemMessage);
  header.customType = typeof entry.customType === "string" ? entry.customType : undefined;
  header.role = typeof entry.message?.role === "string" ? entry.message.role : undefined;
  // Selectors retain identities, never notification bodies or tool arguments.
  header.inputId = inputIdForEntry(entry);
  if (typeof header.inputId !== "string") delete header.inputId;
  for (const key of ["messageId", "childId", "direction", "entryId"]) {
    const value = entry.data?.[key] ?? entry.details?.[key];
    if (identifier(value)) header[key] = value;
  }
  if (header.role === "assistant" && Array.isArray(entry.message.content)) header.callIds = entry.message.content
    .filter(part => part?.type === "toolCall" && identifier(part.id)).map(part => part.id);
  if (header.role === "assistant") header.nativeNamespace = Array.isArray(entry.message.content)
    && entry.message.content.some(part => part?.type === "toolCall" && part.name === "ipython" && part.async === true);
  if (header.role === "toolResult" && entry.message.toolName === "ipython") {
    const details = entry.message.details;
    header.namespace = { toolCallId: entry.message.toolCallId,
      checkpoint: Boolean(details?.namespaceCheckpoint), attempt: Boolean(details?.namespaceCheckpointAttempt),
      pending: details?.namespaceCheckpointState === "pending",
      executionId: Boolean(details?.executionId), ok: typeof details?.ok === "boolean" ? details.ok : undefined,
      executionOk: typeof details?.executionOk === "boolean" ? details.executionOk : undefined,
      recovery: identifier(details?.nativeAsyncRecovery) ? details.nativeAsyncRecovery : undefined };
  }
  header.birthSequence = 0;
  const births = entry.type === "message" && header.role === "assistant"
    ? (Array.isArray(entry.message.content) ? entry.message.content : []).filter(part => part?.type === "text").map(part => part.harnessBirth)
    : entry.type === "custom" && header.customType === "persistent-harness.progress-v1" ? [entry.data?.harnessBirth] : [];
  for (const value of births) header.birthSequence = Math.max(header.birthSequence, conversationBirth(value)?.sequence ?? 0);
  return header;
}

// These are validation/projection facts, never message/source-entry-shaped values.
function contentFacts(content, replacement = false) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const valid = Array.isArray(blocks) && blocks.length <= CANONICAL_CONTEXT_LIMITS.contentBlocks
    && blocks.every(block => isRecord(block) && identifier(block.type));
  return { valid, ...(replacement ? { digest: valueDigest(content), blockDigest: valueDigest(blocks) } : {}), calls: valid ? blocks.filter(block => block.type === "toolCall").map(call => ({
    id: identifier(call.id) ? call.id : undefined, name: identifier(call.name) ? call.name : undefined,
    async: typeof call.async === "boolean" ? call.async : undefined, digest: valueDigest(call),
    valid: identifier(call.id) && identifier(call.name) && isRecord(call.arguments)
      && (call.async === undefined || typeof call.async === "boolean"),
    nativeProvenance: Object.hasOwn(call, "nativeProvenance"), tuple: identifier(call.id) ? providerTuple(call) : null,
  })) : [] };
}
function finalizedInputMessage(message) {
  return message.content == null && ["system", "user"].includes(message.role)
    ? { ...message, content: message.role === "system" ? "" : [] } : message;
}
function messageFacts(message) {
  const { content, ...envelope } = message;
  const incomplete = message.role === "assistant" ? incompleteObservations(message.nativeTransport) : new Set();
  return { digest: valueDigest(finalizedInputMessage(message)), envelopeDigest: valueDigest(envelope), role: typeof message.role === "string" ? message.role : undefined,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    toolCallId: identifier(message.toolCallId) ? message.toolCallId : undefined,
    toolName: identifier(message.toolName) ? message.toolName : undefined,
    excludeFromContext: message.excludeFromContext === true,
    ordinaryFailed: message.role === "assistant" && Array.isArray(content) && ordinaryFailedTerminal(message),
    ...contentFacts(content), incomplete: [...incomplete] };
}

function compactCall(record) {
  const { id, name, async, providerCallId, providerItemId } = record.call;
  // The original call is read only when exposed/issued. Provenance, arguments,
  // reports, results, text and encryption strings do not live in this index.
  return { ...record, message: undefined, callDigest: valueDigest(record.call), call: { id, name, async,
    ...(identifier(providerCallId) ? { providerCallId } : {}),
    ...(identifier(providerItemId) ? { providerItemId } : {}) } };
}

function addAliasFacts(facts, entry, records) {
  // Reuse the exact existing alias/observation rules on one validated entry.
  const added = omissionAliases(records, [entry]);
  for (const name of ["aliases", "observedAliases"]) for (const [key, values] of added[name]) {
    if (!facts[name].has(key)) facts[name].set(key, new Set());
    for (const value of values) facts[name].get(key).add(value);
  }
}

function readManagedEntry(manager, state, id) {
  const header = state.byId.get(id);
  requireThat(header !== undefined, "ERR_CONTEXT_BRANCH_MISSING");
  const entry = manager.getEntry(id);
  requireThat(entry?.id === id && entry.type === header.type && entry.parentId === header.parentId
    && valueDigest(entry) === header.sourceDigest, "ERR_CONTEXT_SOURCE_PROJECTION");
  return entry;
}

function overlaidEntry(manager, state, facts, id) {
  const entry = readManagedEntry(manager, state, id);
  const amendments = facts.signatures.get(id) ?? [];
  if (amendments.length) overlaySignatures([entry, ...amendments.map(source => readManagedEntry(manager, state, source))], [],
    new WeakMap([[entry, state.byId.get(id).units]]));
  return entry;
}

function addSelectedFacts(manager, state, facts, header, order, estimateContextTokens) {
  const entry = readManagedEntry(manager, state, header.id);
  if (entry.type === "assistant_thinking_signature"
    || (entry.type === "custom" && entry.customType === THINKING_SIGNATURE_CUSTOM_TYPE)) {
    const data = entry.type === "custom" ? entry.data : entry;
    if (entry.type === "custom") requireThat(isRecord(data) && data.version === THINKING_SIGNATURE_VERSION, "ERR_SIGNATURE_VERSION");
    const targetId = data?.messageEntryId;
    requireThat(facts.positions.has(targetId), "ERR_SIGNATURE_TARGET");
    const target = overlaidEntry(manager, state, facts, targetId);
    const units = { codeUnits: String(state.byId.get(targetId).position).length, depth: 1 };
    copyData(target, { budget: units });
    const diagnostics = [];
    overlaySignatures([target, entry], diagnostics, new WeakMap([[target, units.codeUnits]]));
    facts.signatureDiagnostics.push(...diagnostics);
    const amendments = facts.signatures.get(targetId) ?? [];
    // One latest source per content block suffices after validating all prior
    // overlays. Retain only IDs; never keep cold encrypted content.
    const previous = facts.signatureBlocks.get(targetId) ?? new Map();
    previous.set(data.contentIndex, entry.id);
    facts.signatureBlocks.set(targetId, previous);
    facts.signatures.set(targetId, [...previous.values()]);
  }
  if (entry.type === "message") {
    const indexed = indexMessages([{ message: entry.message, entryId: entry.id }]);
    if (estimateContextTokens) header.profile = copyData(estimateContextTokens([finalizedInputMessage(entry.message)]));
    const compact = { calls: new Map(), results: new Map() };
    for (const [id, source] of indexed.calls) {
      requireThat(!facts.calls.has(id), "ERR_CONTEXT_DUPLICATE_CALL_ID");
      const record = compactCall({ ...source, order });
      const result = facts.results.get(id);
      if (result) {
        requireThat(record.call.name === result.toolName, "ERR_CONTEXT_RESULT_NAME");
        requireThat(order < result.order, "ERR_CONTEXT_RESULT_BEFORE_CALL");
      }
      facts.calls.set(id, record); compact.calls.set(id, record);
    }
    for (const [id, source] of indexed.results) {
      requireThat(!facts.results.has(id), "ERR_CONTEXT_DUPLICATE_RESULT_ID");
      const record = { entryId: source.entryId, order, toolName: source.message.toolName };
      const call = facts.calls.get(id);
      if (call) {
        requireThat(call.call.name === record.toolName, "ERR_CONTEXT_RESULT_NAME");
        requireThat(call.order < order, "ERR_CONTEXT_RESULT_BEFORE_CALL");
      }
      facts.results.set(id, record); compact.results.set(id, record);
    }
    addAliasFacts(facts, entry, compact);
  }
  facts.positions.set(header.id, order);
}

function managedState(manager, factsRequired = true) {
  const owner = snapshotManagers.get(manager);
  requireThat(owner !== undefined, "ERR_CONTEXT_MANAGER");
  let state = owner.state;
  const stamp = manager.getRevision(), count = manager.getEntryCount(), leaf = manager.getLeafId();
  requireThat(Number.isSafeInteger(stamp?.revision) && Number.isSafeInteger(stamp?.generation)
    && Number.isSafeInteger(count) && count >= 0 && count <= CANONICAL_CONTEXT_LIMITS.entries, "ERR_CONTEXT_MANAGER");
  if (factsRequired && state?.stamp?.revision === stamp.revision && state.stamp.generation === stamp.generation && state.leaf === leaf) return state;
  const old = state;
  if (!state || state.generation !== stamp.generation || count < state.headers.length) {
    state = newArchiveState(); state.generation = stamp.generation;
  }
  // Never publish partially validated facts after an append/reload failure.
  owner.state = null;
  const start = state.headers.length;
  for (let i = start; i < count; i++) {
    const range = manager.getEntriesRange(i, 1);
    requireThat(range.length === 1, "ERR_CONTEXT_MANAGER");
    const budget = { nodes: state.nodes, depth: 1, codeUnits: String(i).length };
    const entry = copyData(range[0], { budget });
    const header = archiveHeader(entry, i, budget.codeUnits);
    requireThat(!state.byId.has(header.id), "ERR_CONTEXT_DUPLICATE_ENTRY_ID");
    state.headers.push(header); state.byId.set(header.id, header); state.nodes = budget.nodes;
  }
  if (!factsRequired) { owner.state = state; return state; }
  const suffix = state.headers.slice(state.factCount);
  const extendsBranch = state === old && state.facts && old.stamp?.generation === stamp.generation
    && stamp.revision - old.stamp.revision === count - state.factCount
    && suffix.every((entry, i) => entry.parentId === (i ? suffix[i - 1].id : old.leaf))
    && leaf === (suffix.at(-1)?.id ?? old.leaf);
  const selectedStart = extendsBranch ? state.selected.length : 0;
  const selected = extendsBranch ? state.selected : selectBranch(state.headers, leaf);
  if (extendsBranch) for (const header of suffix) selected.push(header);
  const checkpoint = selected.findLastIndex(entry => entry.type === "compaction");
  if (checkpoint >= 0) {
    const header = selected[checkpoint], kept = selected.findIndex(entry => entry.id === header.firstKeptEntryId);
    requireThat(header.validCompaction && kept >= 0 && kept <= checkpoint, "ERR_CONTEXT_COMPACTION");
  }
  const facts = extendsBranch ? state.facts : { calls: new Map(), results: new Map(), aliases: new Map(),
    observedAliases: new Map(), signatures: new Map(), signatureBlocks: new Map(), signatureDiagnostics: [], positions: new Map() };
  for (let i = selectedStart; i < selected.length; i++) addSelectedFacts(manager, state, facts, selected[i], i, owner.estimateContextTokens);
  state.selected = selected; state.facts = facts; state.stamp = { ...stamp }; state.factCount = count; state.leaf = leaf;
  owner.state = state;
  return state;
}

function projectManagedContext(manager, mode) {
  if (typeof manager.buildSessionSource === "function") {
    const stringCodeUnits = getCanonicalContextStringCodeUnits();
    const { source, outstanding, diagnostics } = projectManagedSource(manager, mode, stringCodeUnits);
    return copyData({ messages: source.readAll(), outstanding, diagnostics }, { stringCodeUnits });
  }
  requireThat(mode === "native" || mode === "ordinary", "ERR_CONTEXT_MODE");
  const stringCodeUnits = getCanonicalContextStringCodeUnits(), state = managedState(manager), facts = state.facts;
  let context;
  try {
    const full = manager.buildSessionProjection();
    context = { ...full, contextEntryIds: full.contextEntryIds ?? full.entries.map(group => group.sourceEntry.id) };
  }
  catch { throw new CanonicalContextError("ERR_CONTEXT_HELPER_FAILED"); }
  requireThat(isRecord(context) && Array.isArray(context.entries) && Array.isArray(context.messages), "ERR_CONTEXT_HELPER_RESULT");
  const checkpoint = state.selected.findLastIndex(entry => entry.type === "compaction");
  let selected = state.selected;
  if (checkpoint >= 0) {
    const entry = selected[checkpoint], kept = selected.findIndex(item => item.id === entry.firstKeptEntryId);
    selected = [entry, ...selected.slice(kept, checkpoint).filter(item => !(item.type === "message" && item.role === "system")),
      ...selected.slice(checkpoint + 1)];
  }
  requireThat(isDeepStrictEqual(copyData(context.contextEntryIds), selected.map(entry => entry.id)), "ERR_CONTEXT_SOURCE_PROJECTION");
  const editedTargets = new Set(selected.filter(entry => entry.type === "context_edit").map(entry => entry.editTargetId));
  const active = new Map();
  for (const group of context.entries) {
    const source = group.sourceEntry;
    requireThat(facts.positions.has(source?.id), "ERR_CONTEXT_SOURCE_PROJECTION");
    active.set(source.id, readManagedEntry(manager, state, source.id));
  }
  let { messages, provenance } = projectStockContext(context, [...active.values()], stringCodeUnits, editedTargets);
  const canonical = { calls: new Map(facts.calls), results: new Map(facts.results) };
  // Only exposed source records need complete message/call comparisons. Compact
  // cold facts still veto omissions and restore genuine outstanding identities.
  for (const entry of active.values()) if (entry.type === "message") {
    const indexed = indexMessages([{ message: entry.message, entryId: entry.id }]);
    for (const [id, record] of indexed.calls) canonical.calls.set(id, record);
    for (const [id, record] of indexed.results) canonical.results.set(id, record);
  }
  const retained = indexMessages(messages.map(message => ({ message })));
  for (const [id, record] of retained.calls) requireThat(sameProjectedMessage(record, canonical.calls.get(id), provenance), "ERR_CONTEXT_CALL_PROJECTION");
  for (const [id, record] of retained.results) requireThat(sameProjectedMessage(record, canonical.results.get(id), provenance), "ERR_CONTEXT_RESULT_PROJECTION");
  for (const message of messages) {
    const proof = provenance.get(message);
    if (message.role !== "assistant" || proof?.edited || !facts.signatures.has(proof?.source.id)) continue;
    const target = overlaidEntry(manager, state, facts, proof.source.id);
    for (const [index, block] of target.message.content.entries()) if (block.type === "thinking") {
      message.content[index].thinkingSignature = block.thinkingSignature;
    }
  }
  return finishContext({ messages, canonical, selected: [], diagnostics: facts.signatureDiagnostics.map(item => ({ ...item })),
    mode, stringCodeUnits, aliasFacts: facts });
}

/** A borrowed, generation-fenced model projection. Full-value APIs materialize only on demand. */
export function projectCanonicalSource(input = {}) {
  const stringCodeUnits = getCanonicalContextStringCodeUnits();
  const manager = input.sessionManager;
  if (manager && snapshotManagers.has(manager) && typeof manager.buildSessionSource === "function") {
    return projectManagedSource(manager, input.mode, stringCodeUnits);
  }
  const { messages, outstanding, diagnostics } = projectCanonicalContext(input);
  // Compatibility owns these genuine detached values; never claim the legacy path is lazy.
  const contributions = Object.freeze(messages.map((message, index) => Object.freeze({
    key: `${index}:${valueDigest(message)}`, role: message.role,
  })));
  const read = index => {
    requireThat(Number.isSafeInteger(index) && index >= 0 && index < messages.length, "ERR_CONTEXT_SOURCE_PROJECTION");
    return copyData(messages[index], { stringCodeUnits });
  };
  return { outstanding, diagnostics, source: Object.freeze({ length: messages.length, contributions, read,
    readAll: () => copyData(messages, { stringCodeUnits }), validate: () => {},
    // System replay belongs to the SDK. Legacy callers use their normal array hook.
    currentSystemMessage: () => input.sessionManager?.buildSessionSource?.().currentSystemMessage(),
  }) };
}

function selectedContextHeaders(state) {
  const checkpoint = state.selected.findLastIndex(entry => entry.type === "compaction");
  if (checkpoint < 0) return state.selected;
  const entry = state.selected[checkpoint], kept = state.selected.findIndex(item => item.id === entry.firstKeptEntryId);
  return [entry, ...state.selected.slice(kept, checkpoint).filter(item => !(item.type === "message" && item.role === "system")),
    ...state.selected.slice(checkpoint + 1)];
}

function projectManagedSource(manager, mode, stringCodeUnits) {
  requireThat(mode === "native" || mode === "ordinary", "ERR_CONTEXT_MODE");
  const state = managedState(manager), facts = state.facts, selected = selectedContextHeaders(state);
  let sdkSource;
  try { sdkSource = manager.buildSessionSource(); }
  catch { throw new CanonicalContextError("ERR_CONTEXT_HELPER_FAILED"); }
  requireThat(isDeepStrictEqual(copyData(sdkSource.contextEntryIds), selected.map(entry => entry.id)), "ERR_CONTEXT_SOURCE_PROJECTION");
  const selectedIds = new Set(selected.map(entry => entry.id)), edits = new Map();
  for (const header of selected) if (header.type === "context_edit") edits.set(header.editTargetId, header);
  const expected = selected.flatMap((header, position) => edits.get(header.id)?.edit?.omitted
    || header.type === "compaction" && position > 0 ? [] : header.contributionRoles.map((role, messageIndex) => ({
      sourceEntryId: header.id, messageIndex, role, ...(edits.has(header.id) ? { editEntryId: edits.get(header.id).id } : {}),
    })));
  requireThat(Array.isArray(sdkSource.contributions) && sdkSource.contributions.length === expected.length,
    "ERR_CONTEXT_SOURCE_PROJECTION");
  sdkSource.contributions.forEach((item, index) => {
    const { sourceEntryId, messageIndex, role, editEntryId } = item;
    requireThat(isDeepStrictEqual({ sourceEntryId, messageIndex, role, ...(editEntryId === undefined ? {} : { editEntryId }) }, expected[index]),
      "ERR_CONTEXT_SOURCE_PROJECTION");
  });
  const diagnostics = facts.signatureDiagnostics.map(item => ({ ...item }));
  const retainedCalls = new Map(), retainedResults = new Map(), seen = new Set();
  let descriptors = sdkSource.contributions.map((contribution, index) => {
    const header = state.byId.get(contribution.sourceEntryId), edit = edits.get(contribution.sourceEntryId);
    requireThat(header && selectedIds.has(header.id) && typeof contribution.key === "string"
      && Number.isSafeInteger(contribution.messageIndex) && contribution.messageIndex >= 0
      && contribution.editEntryId === edit?.id, "ERR_CONTEXT_SOURCE_PROJECTION");
    const identityKey = `${header.id}:${contribution.messageIndex}`;
    requireThat(!seen.has(identityKey), "ERR_CONTEXT_SOURCE_PROJECTION"); seen.add(identityKey);
    requireThat(!edit?.edit?.omitted, "ERR_CONTEXT_SOURCE_PROJECTION");
    const info = header.message;
    const role = info?.role ?? contribution.role;
    requireThat(identifier(role) && (contribution.role === undefined || contribution.role === role), "ERR_CONTEXT_SOURCE_PROJECTION");
    const edited = Boolean(edit && ["user", "assistant", "toolResult", "custom"].includes(role));
    const content = edited ? edit.edit : info;
    if (["assistant", "toolResult"].includes(role)) requireThat(content?.valid, "ERR_CONTEXT_CONTENT");
    const calls = role === "assistant" ? content.calls.map(call => {
      requireThat(call.valid, "ERR_CONTEXT_CALL");
      const canonical = facts.calls.get(call.id);
      requireThat(canonical?.entryId === header.id && canonical.callDigest === call.digest, "ERR_CONTEXT_CALL_PROJECTION");
      requireThat(!retainedCalls.has(call.id), "ERR_CONTEXT_DUPLICATE_CALL_ID");
      const value = { ...call, entryId: header.id, contentIndex: canonical.contentIndex, order: index };
      retainedCalls.set(call.id, value); return value;
    }) : [];
    if (role === "toolResult") {
      const canonical = facts.results.get(info.toolCallId);
      requireThat(canonical?.entryId === header.id && canonical.toolName === info.toolName, "ERR_CONTEXT_RESULT_PROJECTION");
      requireThat(!retainedResults.has(info.toolCallId), "ERR_CONTEXT_DUPLICATE_RESULT_ID");
      retainedResults.set(info.toolCallId, index);
    }
    const omitted = [];
    if (role === "assistant" && ["error", "aborted"].includes(info.stopReason)) for (const call of calls) {
      if (call.async === true || call.nativeProvenance || !call.tuple) continue;
      if (call.tuple.some(alias => facts.aliases.get(alias)?.size !== 1
        || (facts.observedAliases.has(alias) && (facts.observedAliases.get(alias).size !== 1 || !facts.observedAliases.get(alias).has(call.id))))
        || facts.results.has(call.id)) continue;
      const ordinary = info.ordinaryFailed && call.tuple.every(alias => !facts.observedAliases.has(alias));
      if (!ordinary && !info.incomplete.includes(call.id)) continue;
      omitted.push(call.id); retainedCalls.delete(call.id);
      diagnostics.push({ code: "UNADMITTED_CALL_OMITTED", severity: "info", ...identity(facts.calls.get(call.id), true) });
    }
    const signatureIds = edited ? [] : [...(facts.signatures.get(header.id) ?? [])];
    // Freeze only the relevant policy and committed-source facts, never a live growing archive map.
    const signatures = signatureIds.map(id => ({ id, digest: state.byId.get(id).sourceDigest }));
    const descriptor = { index, sourceEntryId: header.id, sourceDigest: header.sourceDigest,
      type: header.type, messageIndex: contribution.messageIndex, role, edited,
      profile: !edited && omitted.length === 0 && signatures.length === 0 ? header.profile : undefined,
      messageDigest: info?.digest ?? (role === "system" ? header.systemDigest : undefined),
      envelopeDigest: info?.envelopeDigest,
      contentDigest: edited ? (["assistant", "toolResult"].includes(role) ? content.blockDigest : content.digest) : undefined,
      signatures, omitted,
      calls: calls.filter(call => !omitted.includes(call.id)),
      toolCallId: info?.toolCallId, stopReason: info?.stopReason, excludeFromContext: info?.excludeFromContext,
      key: `${contribution.key}:${mode}:${valueDigest(signatures)}:${JSON.stringify(omitted)}` };
    return Object.freeze(descriptor);
  });
  for (const [id, resultIndex] of retainedResults) {
    const call = retainedCalls.get(id);
    if (call) requireThat(call.order < resultIndex, "ERR_CONTEXT_RESULT_BEFORE_CALL");
  }
  const outstanding = [];
  for (const [id, record] of facts.calls) {
    if (record.call.async === true && !facts.results.has(id)) outstanding.push(identity(record, retainedCalls.has(id)));
    if (retainedCalls.has(id) && facts.results.has(id) && !retainedResults.has(id)) diagnostics.push({
      code: "RESULT_PRUNED", severity: mode === "ordinary" ? "blocking" : "info", ...identity(record, true) });
  }
  for (const [id, record] of facts.results) {
    if (!facts.calls.has(id)) diagnostics.push({ code: "ORPHAN_RESULT", severity: "info", toolCallId: id, messageEntryId: record.entryId });
    else if (retainedResults.has(id) && !retainedCalls.has(id)) diagnostics.push({ code: "CALL_PRUNED", severity: "info", toolCallId: id, messageEntryId: record.entryId });
  }
  if (mode === "ordinary") {
    const movable = new Map(descriptors.filter(item => item.role === "toolResult"
      && retainedCalls.get(item.toolCallId)?.async === true).map(item => [item.toolCallId, item]));
    descriptors = descriptors.flatMap(item => item.role === "toolResult" && movable.has(item.toolCallId) ? []
      : [item, ...item.calls.flatMap(call => movable.has(call.id) ? [movable.get(call.id)] : [])]);
    let pending = new Map();
    const flush = () => {
      for (const call of pending.values()) diagnostics.push({ code: "ORDINARY_REPLAY_BLOCKED", severity: "blocking", toolCallId: call.id, toolName: call.name });
      pending = new Map();
    };
    for (const item of descriptors) {
      if (item.role === "bashExecution" && item.excludeFromContext) continue;
      if (!["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(item.role)) continue;
      if (item.role === "toolResult") { pending.delete(item.toolCallId); continue; }
      flush();
      for (const call of item.calls) {
        if (["error", "aborted"].includes(item.stopReason)) diagnostics.push({ code: "ORDINARY_ASSISTANT_NOT_REPLAYABLE", severity: "blocking",
          toolCallId: call.id, toolName: call.name, stopReason: item.stopReason });
        else pending.set(call.id, call);
      }
    }
    flush();
  }
  const keys = new Set(descriptors.map(item => item.key));
  for (const key of state.profiles.keys()) if (!keys.has(key)) state.profiles.delete(key);
  const source = createProjectedSource(manager, sdkSource, descriptors, stringCodeUnits,
    snapshotManagers.get(manager).estimateContextTokens, state.profiles);
  return { source, ...copyData({ outstanding, diagnostics }, { stringCodeUnits }) };
}

function createProjectedSource(manager, sdkSource, descriptors, stringCodeUnits, estimator, profiles) {
  const read = index => {
    sdkSource.validate();
    requireThat(Number.isSafeInteger(index) && index >= 0 && index < descriptors.length, "ERR_CONTEXT_SOURCE_PROJECTION");
    const item = descriptors[index], message = copyData(sdkSource.read(item.index), { stringCodeUnits });
    validateMessage(message);
    if (item.messageDigest !== undefined) {
      const { content, ...envelope } = message;
      requireThat(item.edited ? valueDigest(envelope) === item.envelopeDigest && valueDigest(content) === item.contentDigest
        : valueDigest(message) === item.messageDigest, "ERR_CONTEXT_SOURCE_PROJECTION");
    }
    if (item.type === "compaction" && item.role === "compactionSummary" || item.type === "branch_summary" && item.role === "branchSummary") {
      const raw = sdkSource.readSource(item.sourceEntryId);
      requireThat(valueDigest(raw) === item.sourceDigest, "ERR_CONTEXT_SOURCE_PROJECTION");
      for (const [key, value] of Object.entries(raw)) {
        if (["type", "id", "parentId", "timestamp", "summary", "fromId", "tokensBefore", "firstKeptEntryId", "retainedTail", "systemMessage"].includes(key)) continue;
        requireThat(!Object.hasOwn(message, key) || isDeepStrictEqual(message[key], value), "ERR_CONTEXT_SUMMARY_CONFLICT");
        Object.defineProperty(message, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
    for (const signature of item.signatures) {
      const entry = manager.getEntry(signature.id);
      requireThat(valueDigest(entry) === signature.digest, "ERR_CONTEXT_SOURCE_PROJECTION");
      const data = entry.type === "custom" ? entry.data : entry;
      const block = message.content[data.contentIndex], parsed = parseSignature(block.thinkingSignature);
      if (parsed.encrypted_content !== data.encryptedContent)
        block.thinkingSignature = JSON.stringify({ ...parsed, encrypted_content: data.encryptedContent });
    }
    if (item.omitted.length) message.content = message.content.filter(block => block.type !== "toolCall" || !item.omitted.includes(block.id));
    sdkSource.validate();
    if (estimator && !profiles.has(item.key)) profiles.set(item.key, copyData(estimator([message])));
    return copyData(message, { stringCodeUnits });
  };
  const contributions = Object.freeze(descriptors.map(item => Object.freeze({ key: item.key, role: item.role })));
  const source = Object.freeze({ length: descriptors.length, contributions, read,
    readAll: () => { sdkSource.validate(); return copyData(descriptors.map((_, index) => read(index)), { stringCodeUnits }); },
    currentSystemMessage: () => sdkSource.currentSystemMessage(), validate: () => sdkSource.validate(),
    estimateContextTokens: estimator ? () => {
      sdkSource.validate();
      let tokens = 0, usageTokens = 0, trailingTokens = 0, lastUsageIndex = null;
      descriptors.forEach((item, index) => {
        let profile = profiles.get(item.key) ?? item.profile;
        if (!profile) { read(index); profile = profiles.get(item.key); }
        if (profile.lastUsageIndex !== null) {
          tokens = profile.tokens; usageTokens = profile.usageTokens;
          trailingTokens = profile.trailingTokens; lastUsageIndex = index;
        } else { tokens += profile.tokens; trailingTokens += profile.tokens; }
      });
      return { tokens, usageTokens, trailingTokens, lastUsageIndex };
    } : undefined });
  return source;
}

/** Internal streaming reads share the same compact committed-source index.
 * Explicit history/tree APIs continue to return complete ordinary arrays. */
export function sessionEntryHeaders(manager) {
  if (snapshotManagers.has(manager)) return managedState(manager, false).headers;
  return manager.getEntries().map((entry, i) => archiveHeader(entry, i, 0, false));
}
export function sessionEntriesMatching(manager, predicate) {
  if (!snapshotManagers.has(manager)) return manager.getEntries().filter((entry, i) => predicate(archiveHeader(entry, i, 0, false)));
  return sessionEntryHeaders(manager).filter(predicate).map(header => manager.getEntry(header.id));
}
export function sessionBranchHeaders(manager) {
  if (snapshotManagers.has(manager)) return managedState(manager).selected;
  return manager.getBranch().map((entry, i) => archiveHeader(entry, i, 0, false));
}
export function sessionNamespaceHistory(manager) {
  const headers = sessionBranchHeaders(manager);
  const latest = headers.findLast(header => header.namespace?.checkpoint || header.namespace?.pending);
  return headers.filter(header => header.nativeNamespace || header.namespace).map(header => {
    if (header.nativeNamespace) return { type: "message", message: { role: "assistant",
      content: [{ type: "toolCall", name: "ipython", async: true }] } };
    const value = header.namespace;
    const details = { executionId: value.executionId, ok: value.ok, executionOk: value.executionOk,
      ...(value.checkpoint ? { namespaceCheckpoint: {} } : {}),
      ...(value.attempt ? { namespaceCheckpointAttempt: {} } : {}),
      nativeAsyncRecovery: value.recovery, ...(value.pending ? { namespaceCheckpointState: "pending" } : {}) };
    if (header === latest) {
      const source = manager.getEntry(header.id)?.message.details;
      details.namespaceCheckpoint = source?.namespaceCheckpoint;
      details.namespaceCheckpointAttempt = source?.namespaceCheckpointAttempt;
    }
    return { type: "message", message: { role: "toolResult", toolName: "ipython", toolCallId: value.toolCallId, details } };
  });
}
export function sessionCallIssuer(manager, id) {
  if (snapshotManagers.has(manager)) {
    const record = managedState(manager).facts.calls.get(id);
    return record ? manager.getEntry(record.entryId)?.message : undefined;
  }
  return manager.getBranch().map(entry => entry.message).findLast(message => message?.role === "assistant"
    && message.content.some(part => part.type === "toolCall" && part.id === id));
}

/** Return standard results for the canonical owner to append after interruption.
 * Planning never runs tools or writes entries. The owner must revalidate the
 * snapshot/leaf and serialize result appends against real completion delivery.
 */
export function planUnknownRecovery({ timestamp, ...input } = {}) {
  requireThat(Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000,
    "ERR_RECOVERY_TIMESTAMP");
  const { outstanding } = projectCanonicalSource(input);
  return outstanding.map(({ toolCallId, toolName }) => ({
    role: "toolResult", toolCallId, toolName,
    content: [{ type: "text", text: "Tool execution was interrupted; its outcome is unknown. The original call was not re-executed." }],
    details: { nativeAsyncRecovery: "interrupted-unknown" },
    isError: true,
    timestamp,
  }));
}
