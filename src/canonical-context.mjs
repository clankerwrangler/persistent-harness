import { isDeepStrictEqual } from "node:util";

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value) {
  return typeof value === "string" && value.length > 0
    && value.length <= CANONICAL_CONTEXT_LIMITS.idCodeUnits;
}

// Accept plain SDK data, including optional undefined object fields. Do not invoke
// getters, toJSON(), or custom clone hooks. Returned data never aliases the input.
function copyData(value) {
  let nodes = 0, codeUnits = 0;
  const ancestors = new Set();
  function copy(item, depth) {
    requireThat(++nodes <= CANONICAL_CONTEXT_LIMITS.nodes && depth <= CANONICAL_CONTEXT_LIMITS.depth,
      "ERR_CONTEXT_DATA_LIMIT");
    if (typeof item === "string") {
      codeUnits += item.length;
      requireThat(codeUnits <= CANONICAL_CONTEXT_LIMITS.stringCodeUnits, "ERR_CONTEXT_DATA_LIMIT");
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
      codeUnits += key.length;
      requireThat(codeUnits <= CANONICAL_CONTEXT_LIMITS.stringCodeUnits, "ERR_CONTEXT_DATA_LIMIT");
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
      });
    }
    if (array) requireThat(result.length === item.length && keys.length === item.length + 1,
      "ERR_CONTEXT_DATA_TYPE");
    ancestors.delete(item);
    return result;
  }
  return copy(value, 0);
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

function overlaySignatures(selected, diagnostics) {
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
        block.thinkingSignature = JSON.stringify({ ...item, encrypted_content: data.encryptedContent });
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
  for (let i = kept; i <= latest; i++) {
    const entry = selected[i];
    if (entry.type !== "compaction") continue;
    // Older kept compactions contribute summaries, not their own kept ranges.
    // Superseded compactions before this span have no context semantics to check.
    requireThat(typeof entry.summary === "string" && Number.isFinite(entry.tokensBefore)
      && entry.tokensBefore >= 0, "ERR_CONTEXT_COMPACTION");
  }
}

// STOCK converts summary entries to messages but omits entry-level metadata.
// Match backwards because kept branch summaries are a suffix of the selected
// path. This also distinguishes repeated identical summaries after compaction.
function preserveSummaryMetadata(messages, selected) {
  let before = selected.length;
  const leadingCompaction = messages[0]?.role === "compactionSummary"
    ? selected.findLastIndex(entry => entry.type === "compaction") : -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const type = message.role === "branchSummary" ? "branch_summary"
      : message.role === "compactionSummary" ? "compaction" : null;
    if (!type) continue;
    let match = -1;
    const limit = type === "compaction" && i === 0 ? selected.length : before;
    for (let j = limit - 1; j >= 0; j--) {
      if (j === leadingCompaction && i !== 0) continue;
      if (i === 0 && leadingCompaction !== -1 && j !== leadingCompaction) continue;
      const entry = selected[j];
      const raw = entry.type === "message" && isDeepStrictEqual(entry.message, message);
      const generated = entry.type === type && entry.summary === message.summary
        && Date.parse(entry.timestamp) === message.timestamp
        && (type === "branch_summary" ? entry.fromId === message.fromId : entry.tokensBefore === message.tokensBefore);
      if (raw || generated) {
        match = j;
        break;
      }
    }
    requireThat(match !== -1, "ERR_CONTEXT_SUMMARY_SOURCE");
    const source = selected[match];
    before = match;
    if (source.type === "message") continue;
    for (const [key, value] of Object.entries(source)) {
      if (!["type", "id", "parentId", "timestamp", "summary", "fromId", "tokensBefore", "firstKeptEntryId", "retainedTail"].includes(key)) {
        requireThat(!Object.hasOwn(message, key) || isDeepStrictEqual(message[key], value), "ERR_CONTEXT_SUMMARY_CONFLICT");
        Object.defineProperty(message, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }
}

function identity(record, retainedInContext) {
  return { toolCallId: record.call.id, toolName: record.call.name,
    messageEntryId: record.entryId, contentIndex: record.contentIndex, retainedInContext };
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
  const selected = selectBranch(copyData(entries), leafId);
  const diagnostics = [];
  validateCompactions(selected);
  overlaySignatures(selected, diagnostics);
  indexMessages(selected.filter(entry => entry.type === "message")
    .map(entry => ({ message: entry.message, entryId: entry.id })));
  return { entries: selected, diagnostics };
}

/**
 * Read-only selected-branch projection. entries excludes the session header;
 * leafId is explicit (null means the empty branch). buildSessionContext is the
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
export function projectCanonicalContext({ entries, leafId, buildSessionContext, mode } = {}) {
  requireThat(mode === "native" || mode === "ordinary", "ERR_CONTEXT_MODE");
  requireThat(typeof buildSessionContext === "function", "ERR_CONTEXT_HELPER");
  const { entries: selected, diagnostics } = projectCanonicalBranch({ entries, leafId });
  const canonical = indexMessages(selected.filter(entry => entry.type === "message")
    .map(entry => ({ message: entry.message, entryId: entry.id })));
  let context;
  try { context = buildSessionContext(copyData(selected), leafId); }
  catch { throw new CanonicalContextError("ERR_CONTEXT_HELPER_FAILED"); }
  requireThat(isRecord(context) && Array.isArray(context.messages), "ERR_CONTEXT_HELPER_RESULT");
  let messages = copyData(context.messages);
  const retained = indexMessages(messages.map(message => ({ message })));
  for (const [id, record] of retained.calls) {
    requireThat(canonical.calls.has(id) && isDeepStrictEqual(record.message, canonical.calls.get(id).message),
      "ERR_CONTEXT_CALL_PROJECTION");
  }
  for (const [id, record] of retained.results) {
    requireThat(canonical.results.has(id) && isDeepStrictEqual(record.message, canonical.results.get(id).message),
      "ERR_CONTEXT_RESULT_PROJECTION");
  }
  preserveSummaryMetadata(messages, selected);
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
  return { messages, outstanding, diagnostics };
}

/** Return standard results for the canonical owner to append after interruption.
 * Planning never runs tools or writes entries. The owner must revalidate the
 * snapshot/leaf and serialize result appends against real completion delivery.
 */
export function planUnknownRecovery({ timestamp, ...input } = {}) {
  requireThat(Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000,
    "ERR_RECOVERY_TIMESTAMP");
  const { outstanding } = projectCanonicalContext(input);
  return outstanding.map(({ toolCallId, toolName }) => ({
    role: "toolResult", toolCallId, toolName,
    content: [{ type: "text", text: "Tool execution was interrupted; its outcome is unknown. The original call was not re-executed." }],
    details: { nativeAsyncRecovery: "interrupted-unknown" },
    isError: true,
    timestamp,
  }));
}
