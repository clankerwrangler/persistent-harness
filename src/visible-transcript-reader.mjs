import { open, stat as fileStat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MAX_INPUT_REQUEST_BYTES, normalizeInputImages } from "./input-images.mjs";
import { inputIdForEntry, canonicalUserInputId, cleanHarnessInput, createActorInputAssociation, actorInputRenderEvidence, associateVisibleInput, projectVisibleMessage, assistantMessageParts, sortVisibleHistory } from "./conversation-projection.mjs";
import { sanitizePresentationText } from "./presentation-directive.mjs";
import { selectIncomingFamilyMessages, projectAgentMessageEntry } from "./agent-message-projection.mjs";
import { projectProgressEntry } from "./progress-projection.mjs";
import { firstCompletedTitleTurn, rootTitleExcerpt } from "./root-title.mjs";
import { followsSourceWatermark, sameSourceWatermark } from "./source-watermark.mjs";
import { canonicalRetryInput } from "./session-actions.mjs";

const READ_CHUNK_BYTES = 256 * 1024;
const MAX_JSONL_LINE_BYTES = 256 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const HISTORY_CURSOR_MAX = 2048;

function historyError(code, message) { return Object.assign(new Error(message), { code }); }
function parseHistoryCursor(value) {
  if (typeof value !== "string" || !value || value.length > HISTORY_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw historyError("invalid_history_cursor", "history cursor is invalid");
  }
  try {
    const encoded = Buffer.from(value, "base64url");
    if (encoded.toString("base64url") !== value) throw new Error();
    const parts = JSON.parse(utf8.decode(encoded));
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 1
      || [parts[1], parts[3]].some((part) => typeof part !== "string" || !part || part.length > 128)
      || typeof parts[2] !== "string" || !/^[a-f0-9]{64}$/.test(parts[2])) throw new Error();
    return { sessionId: parts[1], branchId: parts[2], beforeId: parts[3] };
  } catch { throw historyError("invalid_history_cursor", "history cursor is invalid"); }
}
function historyCursor(record, beforeId) {
  return Buffer.from(JSON.stringify([1, record.sessionId, record.branchId, beforeId])).toString("base64url");
}

export function transcriptFingerprint(stat) {
  if (!stat.isFile()) throw new Error("canonical Pi transcript is not a regular file");
  return Object.fromEntries(["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));
}
export function sameTranscriptFingerprint(left, right) {
  return Boolean(left && right && ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => left[key] === right[key]));
}

function sameFile(record, stat) {
  return record.dev === stat.dev && record.ino === stat.ino && stat.size >= record.offset;
}

function publicHistoryItem(item) {
  return item.kind === "message" ? { kind: "message", id: item.message.id } : item;
}

function historyProjection(items) {
  return {
    messages: items.filter((item) => item.kind === "message").map((item) => item.message),
    history: items.map(publicHistoryItem),
  };
}

export function boundVisibleHistory(history, { maxMessages = 512, maxBytes = 48 * 1024 } = {}) {
  const source = Array.isArray(history) ? history : [];
  const selected = [];
  let bytes = Buffer.byteLength(JSON.stringify({ messages: [], history: [] }), "utf8");
  let messageCount = 0; let historyCount = 0;
  for (let index = source.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    let item = source[index].kind === "message"
      ? { ...source[index], message: { ...source[index].message } }
      : { ...source[index] };
    const cost = (candidate) => (candidate.kind === "message"
      ? Buffer.byteLength(JSON.stringify(candidate.message), "utf8") + (messageCount ? 1 : 0) : 0)
      + Buffer.byteLength(JSON.stringify(publicHistoryItem(candidate)), "utf8") + (historyCount ? 1 : 0);
    let encodedBytes = cost(item);
    // A large row must not prevent the next page from reaching its predecessors.
    if (bytes + encodedBytes > maxBytes && selected.length === 0
      && (item.kind === "message" || typeof item.body === "string")) {
      const original = String(item.kind === "message" ? item.message.text ?? "" : item.body);
      let low = 0; let high = original.length; let fitted;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const prefix = original.slice(0, middle).replace(/[\uD800-\uDBFF]$/, "");
        const text = middle < original.length ? `${prefix}…` : prefix;
        const candidate = item.kind === "message" ? { ...item, message: { ...item.message, text } } : { ...item, body: text };
        if (bytes + cost(candidate) <= maxBytes) { fitted = candidate; low = middle + 1; }
        else high = middle - 1;
      }
      if (fitted) { item = fitted; encodedBytes = cost(item); }
    }
    if (bytes + encodedBytes > maxBytes) break;
    selected.push(item); bytes += encodedBytes; historyCount += 1;
    if (item.kind === "message") messageCount += 1;
  }
  selected.reverse();
  return { ...historyProjection(selected), truncated: selected.length < source.length };
}

export function boundVisibleMessages(messages, options) {
  const bounded = boundVisibleHistory((Array.isArray(messages) ? messages : []).map((message) => ({ kind: "message", message })), options);
  return { messages: bounded.messages, truncated: bounded.truncated };
}

function newRecord(filePath, stat, sessionId, verifySource = false) {
  return {
    filePath, sessionId, dev: stat.dev, ino: stat.ino, offset: 0,
    headerValidated: false, branchId: null, entries: new Map(), leafId: null,
    hash: verifySource ? createHash("sha256") : null, fingerprint: null, verified: false,
    pendingParts: [], pendingBytes: 0, pendingLineOffset: null, touchedAt: Date.now(),
  };
}

/**
 * Read-only, rebuildable projection over Pi's canonical append-only JSONL.
 * It never opens a SessionManager and therefore can never become a writer.
 */
export class VisibleTranscriptReader {
  #records = new Map();
  #inflight = new Map();

  constructor({ maxCachedSessions = 64, inputReceiptReader = null } = {}) {
    this.maxCachedSessions = maxCachedSessions;
    this.inputReceiptReader = inputReceiptReader;
  }

  async read(options) { return (await this.#readSnapshot(options)).projection; }

  historyReceiptsMatch(sessionId, dependencies) {
    return dependencies.every(row => this.#receiptHash(this.inputReceiptReader?.(row.input_id, sessionId)) === row.receipt_hash);
  }

  #receiptHash(receipt) { return createHash("sha256").update(JSON.stringify(receipt ?? null)).digest("hex"); }

  /** Hydrate only rows of an already verified active-branch index version. */
  async readHistoryEntries({ sessionFile, sessionId, fingerprint, entries, sanitizePresentation, signal, snapshot = false }) {
    if (!Array.isArray(entries) || entries.length > 1000) throw new Error("history hydration exceeds the entry limit");
    const handle = await open(sessionFile, "r");
    try {
      const observed = transcriptFingerprint(await handle.stat({ bigint: true }));
      // A snapshot citation describes the indexed branch, not the current leaf.
      // Append changes timestamps/size; identity, bounded entry digests and a
      // stable read still prove the requested canonical bytes.
      if (snapshot && (observed.dev !== fingerprint.dev || observed.ino !== fingerprint.ino
        || BigInt(observed.size) < BigInt(fingerprint.size))) throw new Error("indexed history source was replaced or truncated");
      const accepted = snapshot ? observed : fingerprint;
      const check = async () => {
        signal?.throwIfAborted();
        if (!sameTranscriptFingerprint(accepted, transcriptFingerprint(await handle.stat({ bigint: true })))
          || !sameTranscriptFingerprint(accepted, transcriptFingerprint(await fileStat(sessionFile, { bigint: true })))) {
          throw new Error("canonical Pi transcript changed during history hydration");
        }
      };
      await check();
      const messages = [];
      for (const row of entries) {
        signal?.throwIfAborted();
        if (row.session_id !== sessionId || !Number.isSafeInteger(row.source_offset) || row.source_offset < 0
          || !Number.isSafeInteger(row.source_length) || row.source_length < 1 || row.source_length > MAX_JSONL_LINE_BYTES
          || row.source_offset + row.source_length > Number(fingerprint.size)) throw new Error("invalid history source span");
        const buffer = Buffer.allocUnsafe(row.source_length);
        let offset = 0;
        while (offset < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, offset, Math.min(READ_CHUNK_BYTES, buffer.length - offset), row.source_offset + offset);
          if (!bytesRead) throw new Error("canonical Pi transcript was truncated during history hydration");
          offset += bytesRead;
        }
        const line = buffer.at(-1) === 0x0d ? buffer.subarray(0, -1) : buffer;
        if (createHash("sha256").update(line).digest("hex") !== row.source_hash) throw new Error("canonical history entry changed");
        const entry = JSON.parse(utf8.decode(line));
        if (entry.id !== row.entry_id) throw new Error("canonical history entry identity changed");
        let message = projectVisibleMessage(entry, { imageReferences: true, sanitizePresentation });
        if (!message || message.role !== row.role) throw new Error("canonical history entry role changed");
        // This bit was produced by complete-inventory receipt association, not
        // marker matching. The index additionally checks the projected digest.
        if (row.strip_marker) message = { ...message, text: cleanHarnessInput(message.text) };
        messages.push({ ...message, createdAt: row.created_at });
      }
      await check();
      return { messages };
    } finally { await handle.close(); }
  }

  async #readSnapshot({ inputProofIds = null, familyMessageId = null, sessionFile, sessionId, maxMessages = 512, maxBytes = 48 * 1024, sanitizePresentation = false, includeTitleTurn = false, before = null, publicView = false, verifySource = false, historyIndex = false, allowToolImages = false, signal, sourceWatermark = null, ownedAppendBase = null, forceFull = false }) {
    // Internal call-site scope, not a protocol/configuration option. Own it across awaits.
    if (Array.isArray(inputProofIds)) inputProofIds = [...new Set(inputProofIds)];
    const cursor = before === null ? null : parseHistoryCursor(before);
    const filePath = path.resolve(sessionFile);
    const options = { inputProofIds, familyMessageId, sessionFile: filePath, sessionId, maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, before, publicView, verifySource, historyIndex, allowToolImages, signal, sourceWatermark, ownedAppendBase, forceFull };
    const projectionKey = JSON.stringify([sessionId, inputProofIds, familyMessageId, maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, before, publicView, verifySource, historyIndex, allowToolImages, sourceWatermark, ownedAppendBase, forceFull]);
    const active = this.#inflight.get(filePath);
    if (active) {
      // Independently owned history requests must never share an abort signal.
      if (signal) { await active.promise.catch(() => {}); signal.throwIfAborted(); return this.#readSnapshot(options); }
      let trailing = active.trailing.get(projectionKey);
      if (!trailing) {
        // Serialize file access, not request outcomes. A stale cursor must not
        // reject an unrelated latest, title, image, or branch projection.
        trailing = active.promise.catch(() => {}).then(() => this.#readSnapshot(options));
        active.trailing.set(projectionKey, trailing);
      }
      return trailing;
    }
    const state = { promise: null, trailing: new Map() };
    state.promise = this.#read(filePath, sessionId, { inputProofIds, familyMessageId, maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, cursor, publicView, verifySource, historyIndex, allowToolImages, signal, sourceWatermark, ownedAppendBase, forceFull })
      .catch((error) => { if (!verifySource && error.code !== "history_cursor_stale") this.#records.delete(filePath); throw error; })
      .finally(() => { if (this.#inflight.get(filePath) === state) this.#inflight.delete(filePath); });
    this.#inflight.set(filePath, state);
    return state.promise;
  }

  clear(sessionFile) {
    if (sessionFile) this.#records.delete(path.resolve(sessionFile));
    else this.#records.clear();
  }

  // Read a fixed active-branch prefix from the same canonical offsets used by
  // history retrieval. Never open the source with a writable SessionManager.
  async readBranch({ sessionFile, sessionId, leafId, maxBytes = 64 * 1024 * 1024, maxEntries = 100_000 }) {
    if (leafId !== null && (typeof leafId !== "string" || !leafId || leafId.length > 128)) throw new Error("context fork leaf is invalid");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) throw new Error("context fork snapshot bounds are invalid");
    const filePath = path.resolve(sessionFile);
    await this.read({ sessionFile: filePath, sessionId, inputProofIds: [] });
    const record = this.#records.get(filePath);
    if (!record) throw new Error("context fork source is unavailable");
    const ids = [...this.#activeEntryIds(record, leafId)].reverse();
    if (ids.length > maxEntries) throw new Error("context fork source exceeds the entry limit");
    const selected = [{ source: record.headerSource }, ...ids.map((id) => ({ id, ...record.entries.get(id) }))];
    if (selected.reduce((total, entry) => total + entry.source.length, 0) > maxBytes) {
      throw new Error("context fork source exceeds the byte limit");
    }
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !sameFile(record, stat)) throw new Error("context fork source changed during read");
      const entries = [];
      for (const selectedEntry of selected) {
        const { source } = selectedEntry;
        const buffer = Buffer.allocUnsafe(source.length);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, source.offset + offset);
          if (bytesRead === 0) throw new Error("context fork source was truncated during read");
          offset += bytesRead;
        }
        const line = buffer.at(-1) === 0x0d ? buffer.subarray(0, -1) : buffer;
        if (createHash("sha256").update(line).digest("hex") !== source.hash) throw new Error("context fork source changed during read");
        const entry = JSON.parse(utf8.decode(line));
        if (entry.type !== "session") entries.push(entry);
      }
      return { entries, leafId };
    } finally { await handle.close(); }
  }

  async resolveRetryTurn({ sessionFile, sessionId, assistantId }) {
    const snapshot = await this.#readSnapshot({ sessionFile, sessionId, inputProofIds: [] });
    return this.#retryTurn(snapshot.record, assistantId, snapshot.projection.leafId);
  }

  #retryTurn(record, assistantId, leafId) {
    if (typeof assistantId !== "string" || !assistantId || assistantId.length > 128) throw new Error("retry target is invalid");
    const active = this.#activeEntryIds(record, leafId);
    const matches = [...active].filter((id) => {
      const entry = record.entries.get(id);
      return entry.item?.kind === "message" && entry.item.message.role === "assistant"
        && (id === assistantId || entry.assistantParts?.some((part) => part.id === assistantId));
    });
    if (matches.length > 1) throw new Error("retry target matches more than one canonical assistant message");
    if (matches.length === 0) {
      if (active.has(assistantId)) throw new Error("retry target is not an assistant message");
      throw new Error("retry target is not on the active transcript branch");
    }
    assistantId = matches[0];
    const assistant = record.entries.get(assistantId);
    let id = assistant.parentId;
    while (id !== null) {
      const entry = record.entries.get(id);
      if (!entry) throw new Error("canonical Pi transcript branch has a missing parent");
      if (entry.inputBoundary) return { assistantId, userId: id, branchFromId: entry.parentId };
      id = entry.parentId;
    }
    throw new Error("retry target has no preceding canonical input");
  }

  async resolveRetryInput({ sessionFile, sessionId, assistantId }) {
    const snapshot = await this.#readSnapshot({ sessionFile, sessionId, inputProofIds: [] });
    const turn = this.#retryTurn(snapshot.record, assistantId, snapshot.projection.leafId);
    const entry = await this.#readCanonicalEntry(snapshot.record, turn.userId);
    const inputId = inputIdForEntry(entry);
    const inputReceipt = inputId ? this.inputReceiptReader?.(inputId, sessionId) : null;
    const associations = await this.#inputAssociations(snapshot.record, undefined, undefined, { inputIds: new Set([inputId]), physical: true });
    return { ...turn, input: canonicalRetryInput(entry, { sessionId, inputReceipt, inputAssociation: associations.get(inputId) }) };
  }

  async #readCanonicalEntry(record, entryId, { handle: sharedHandle, signal } = {}) {
    const selected = record?.entries.get(entryId);
    const limit = selected?.inputCandidate?.kind === "user-id" ? MAX_JSONL_LINE_BYTES : MAX_INPUT_REQUEST_BYTES;
    if (!selected?.source || selected.source.length > limit) throw new Error("canonical input source exceeds the input limit");
    const handle = sharedHandle ?? await open(record.filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !sameFile(record, stat)) throw new Error("canonical input source changed during read");
      const buffer = Buffer.allocUnsafe(selected.source.length);
      let offset = 0;
      while (offset < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, offset, Math.min(READ_CHUNK_BYTES, buffer.length - offset), selected.source.offset + offset);
        if (bytesRead === 0) throw new Error("canonical input source changed during read");
        offset += bytesRead;
      }
      const line = buffer.at(-1) === 0x0d ? buffer.subarray(0, -1) : buffer;
      if (createHash("sha256").update(line).digest("hex") !== selected.source.hash) throw new Error("canonical input source changed during read");
      const entry = JSON.parse(utf8.decode(line));
      if (entry?.id !== entryId) throw new Error("canonical input source does not match its transcript entry");
      return entry;
    } finally { if (!sharedHandle) await handle.close(); }
  }

  async readImage({ sessionFile, sessionId, entryId, index, sanitizePresentation = false, allowToolImages = false }) {
    const filePath = path.resolve(sessionFile);
    await this.read({ sessionFile: filePath, sessionId, sanitizePresentation, inputProofIds: [] });
    const record = this.#records.get(filePath);
    const selected = record?.entries.get(entryId);
    const reference = selected?.item?.kind === "message" ? selected.item.message.images?.[index]?.ref : undefined;
    const inputImage = reference && reference.entryId === entryId && reference.index === index;
    const toolImage = allowToolImages && Number.isInteger(index) && index >= 0 && index < selected?.toolImageCount;
    if ((!inputImage && !toolImage) || !this.#activeEntryIds(record).has(entryId)) {
      throw new Error("visible image does not exist on the active transcript branch");
    }
    const entry = await this.#readCanonicalEntry(record, entryId);
    const content = entry.type === "message" && (entry.message?.role === "user" || (toolImage && entry.message?.role === "toolResult")) ? entry.message.content
      : entry.type === "custom_message" && ["scheduled_job", "background_notification"].includes(selected.item?.message?.role) ? entry.content : null;
    if (!content) throw new Error("visible image source does not match its transcript entry");
    const candidates = Array.isArray(content) ? content.filter((part) => part?.type === "image")
      .map((part) => ({ type: "image", data: part.data, mimeType: part.mimeType })) : [];
    const image = normalizeInputImages(candidates)[index];
    if (!image) throw new Error("visible image index does not exist");
    return image;
  }

  async #inputAssociations(record, handle, signal, { dependencies = null, inputIds = null, provisional = false, physical = false } = {}) {
    const associations = new Map();
    if ((!this.inputReceiptReader && !dependencies) || inputIds?.size === 0) return associations;
    const groups = new Map();
    for (const entry of record.entries.values()) {
      const candidate = entry.inputCandidate; if (!candidate || inputIds && !inputIds.has(candidate.inputId)) continue;
      const group = groups.get(candidate.inputId) ?? [];
      group.push(entry); groups.set(candidate.inputId, group);
    }
    for (const [inputId, entries] of groups) {
      signal?.throwIfAborted();
      const inputReceipt = this.inputReceiptReader?.(inputId, record.sessionId);
      if (dependencies) dependencies.push({ input_id: inputId, receipt_hash: this.#receiptHash(inputReceipt) });
      if (!inputReceipt) continue;
      const verifier = createActorInputAssociation({ sessionId: record.sessionId, inputReceipt });
      for (const entry of entries) {
        const candidate = entry.inputCandidate;
        if (inputReceipt.entryId != null && inputReceipt.entryId !== candidate.entry.id) continue;
        if (candidate.kind !== "user-id" && entry.source.length > MAX_INPUT_REQUEST_BYTES) {
          verifier.incomplete({ entryId: candidate.entry.id, kind: candidate.kind }); continue;
        }
        if (provisional) verifier.addRenderEvidence(candidate.evidence);
        else {
          // Full/index identity matching stays metadata-only for canonical user IDs.
          // Explicit delivery/retry IDs must also validate canonical-ID physical spans.
          const canonical = candidate.kind === "user-id" && !physical ? candidate.entry
            : await this.#readCanonicalEntry(record, candidate.entry.id, { handle, signal });
          verifier.add(canonical);
        }
      }
      associations.set(inputId, verifier.result());
    }
    return associations;
  }

  async #read(filePath, sessionId, bounds) {
    const handle = await open(filePath, "r");
    try {
      bounds.signal?.throwIfAborted();
      const fingerprint = transcriptFingerprint(await handle.stat({ bigint: true }));
      const stat = { dev: Number(fingerprint.dev), ino: Number(fingerprint.ino), size: Number(fingerprint.size) };
      let record = this.#records.get(filePath);
      if (bounds.forceFull || !record || record.sessionId !== sessionId || !sameFile(record, stat) || (bounds.verifySource && !record.hash)) record = newRecord(filePath, stat, sessionId, bounds.verifySource);
      const next = bounds.sourceWatermark, base = bounds.ownedAppendBase;
      // Only a previously accepted owner cursor can waive old-byte reconciliation.
      // A shared-reader append may already have advanced this same logical hash.
      const ownedAppend = Boolean(bounds.verifySource && followsSourceWatermark(base, next)
        && sameTranscriptFingerprint(next.fingerprint, fingerprint) && record.hash && record.pendingBytes === 0
        && record.offset >= base.bytes && record.offset <= next.bytes
        && (sameSourceWatermark(record.indexWatermark, base)
          || (record.offset === base.bytes && record.hash.copy().digest("hex") === base.digest)));
      if (bounds.verifySource && !ownedAppend && record.offset && (!record.verified || !sameTranscriptFingerprint(record.fingerprint, fingerprint))) {
        // Arbitrary same-inode rewrites (including rewrite + growth) are legal.
        // Verify every accepted prefix byte before reusing parsed metadata.
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let offset = 0;
        while (offset < record.offset) {
          bounds.signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, record.offset - offset), offset);
          if (!bytesRead) throw new Error("canonical Pi transcript changed during prefix verification");
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        if (hash.digest("hex") !== record.hash.copy().digest("hex")) record = newRecord(filePath, stat, sessionId, bounds.verifySource);
      }
      if (bounds.verifySource) record = { ...record, entries: new Map(record.entries), incomingMessageIds: new Set(record.incomingMessageIds),
        pendingParts: [...record.pendingParts], hash: record.hash.copy() };
      const target = stat.size;
      // Observing new metadata is not proof of the cached bytes, even when a
      // non-history consumer sees a same-size rewrite and parses no suffix.
      if (!sameTranscriptFingerprint(record.fingerprint, fingerprint)) record.verified = false;
      while (record.offset < target) {
        bounds.signal?.throwIfAborted();
        const length = Math.min(READ_CHUNK_BYTES, target - record.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, record.offset);
        if (bytesRead === 0) throw new Error("canonical Pi transcript changed during read");
        const chunk = buffer.subarray(0, bytesRead);
        record.hash?.update(chunk); record.offset += bytesRead;
        this.#consume(record, chunk, record.offset - bytesRead);
      }
      if (ownedAppend && (record.pendingBytes || record.offset !== next.bytes || record.hash.copy().digest("hex") !== next.digest)) {
        throw Object.assign(new Error("owned append cursor does not match the complete suffix"), { code: "owned_append_unavailable" });
      }
      if (!record.headerValidated) throw new Error(`canonical Pi transcript header is incomplete: ${filePath}`);
      const receiptDependencies = bounds.historyIndex ? [] : null;
      const pageScoped = bounds.inputProofIds === "page";
      const selectedInputIds = Array.isArray(bounds.inputProofIds) ? new Set(bounds.inputProofIds) : null;
      const associations = await this.#inputAssociations(record, handle, bounds.signal,
        { dependencies: receiptDependencies, inputIds: selectedInputIds, provisional: pageScoped, physical: selectedInputIds !== null });
      if (bounds.familyMessageId) for (const [id, entry] of record.entries) {
        if (entry.item?.familyMessageId === bounds.familyMessageId) await this.#readCanonicalEntry(record, id, { handle, signal: bounds.signal });
      }
      const visible = this.#visibleBranch(record, bounds, associations);
      const title = bounds.includeTitleTurn
        ? { titleTurn: rootTitleExcerpt(firstCompletedTitleTurn(visible.filter((item) => item.kind === "message").map((item) => item.message))),
          titleUser: visible.find((item) => item.kind === "message" && item.message.role === "user")?.message.text ?? null }
        : {};
      let end = visible.length;
      if (bounds.cursor) {
        const cursor = bounds.cursor;
        if (cursor.sessionId !== record.sessionId || cursor.branchId !== record.branchId) {
          throw historyError("history_cursor_stale", "history changed; load the conversation again");
        }
        end = visible.findIndex((item) => (item.kind === "message" ? item.message.id : item.id) === cursor.beforeId);
        if (end < 0) throw historyError("history_cursor_stale", "history changed; load the conversation again");
      }
      const page = bounds.historyIndex ? { ...historyProjection(visible), truncated: false } : boundVisibleHistory(visible.slice(0, end), bounds);
      if (end > 0 && page.history.length === 0) throw historyError("history_page_too_small", "history row exceeds the page byte limit");
      if (pageScoped) {
        // Include a byte-rejected boundary row and the cursor anchor: their exact
        // association can change page membership, byte accounting, and identity.
        const boundary = page.truncated && page.history.length < bounds.maxMessages ? 1 : 0;
        const relevant = visible.slice(Math.max(0, end - page.history.length - boundary), end + (bounds.cursor ? 1 : 0));
        const ids = new Set(relevant.map(item => item.kind === "message"
          ? record.entries.get(item.message.entryId ?? item.message.id)?.inputCandidate?.inputId : null).filter(Boolean));
        // UI canonical IDs keep their original metadata-only matching contract;
        // legacy/custom candidates still validate physical spans for every relevant ID.
        const verified = await this.#inputAssociations(record, handle, bounds.signal, { inputIds: ids });
        for (const id of ids) if (!isDeepStrictEqual(associations.get(id), verified.get(id))) {
          throw new Error("canonical input association changed during page verification");
        }
        // A page is rendering only. In particular, metadata-only canonical-ID
        // associations must never escape as physical delivery evidence.
        associations.clear();
      }
      const hasMore = page.truncated;
      const historyPage = { hasMore, nextCursor: hasMore ? historyCursor(record, page.history[0].id) : null, branchId: record.branchId };
      const proven = [...associations].filter(([, result]) => result.state === "proven");
      const projection = { ...page, historyPage, ...title, leafId: record.leafId,
        // Internal read evidence is scoped to this active branch. The supervisor
        // consumes it before bounding pending routes; it never becomes wire history.
        familyMessages: Object.fromEntries(visible.filter(item => item.kind === "agent_message" && item.direction === "from" && item.familyMessageId)
          .map(item => [item.familyMessageId, item])),
        inputIds: proven.map(([inputId]) => inputId),
        inputEntries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, result.entryId])),
        inputDeliveries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, { entryId: result.entryId, deliveredAt: result.deliveredAt }])),
        inputAssociationStates: Object.fromEntries([...associations].map(([inputId, result]) => [inputId, result.state])) };
      bounds.signal?.throwIfAborted();
      if (bounds.verifySource) {
        if (!sameTranscriptFingerprint(fingerprint, transcriptFingerprint(await handle.stat({ bigint: true })))
          || !sameTranscriptFingerprint(fingerprint, transcriptFingerprint(await fileStat(filePath, { bigint: true })))) {
          throw new Error("canonical Pi transcript changed during verified read");
        }
        bounds.signal?.throwIfAborted(); record.verified = !ownedAppend;
      }
      record.fingerprint = fingerprint; record.touchedAt = Date.now();
      this.#touch(filePath, record); this.#evict();
      if (bounds.historyIndex) {
        projection.sourceEntries = new Map(projection.messages.map(message => {
          const entry = record.entries.get(message.id);
          return [message.id, { ...entry.source, stripMarker: entry.inputCandidate
            && associations.get(entry.inputCandidate.inputId)?.state === "proven"
            && associations.get(entry.inputCandidate.inputId)?.entryId === message.id
            && associations.get(entry.inputCandidate.inputId)?.proof.kind === "legacy-marker" ? 1 : 0 }];
        }));
        projection.fingerprint = fingerprint;
        projection.receiptDependencies = receiptDependencies;
        projection.sourceDigest = record.hash?.copy().digest("hex") ?? null;
        projection.prefixVerified = record.verified;
        // The binding is reconstructible cache state; durable reconciliation lives in the index owner.
        record.indexWatermark = next && next.digest === projection.sourceDigest
          && sameTranscriptFingerprint(next.fingerprint, fingerprint) ? next : null;
      }
      return { projection, record, associations };
    } finally {
      await handle.close();
    }
  }

  #consume(record, chunk, chunkOffset) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        if (record.pendingBytes === 0) record.pendingLineOffset = chunkOffset + start;
        this.#appendPart(record, chunk.subarray(start));
        return;
      }
      if (record.pendingBytes === 0) record.pendingLineOffset = chunkOffset + start;
      this.#appendPart(record, chunk.subarray(start, newline));
      const source = { offset: record.pendingLineOffset, length: record.pendingBytes };
      let line = record.pendingParts.length === 1
        ? record.pendingParts[0]
        : Buffer.concat(record.pendingParts, record.pendingBytes);
      record.pendingParts = []; record.pendingBytes = 0; record.pendingLineOffset = null;
      if (line.length > 0 && line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) throw new Error("canonical Pi transcript contains an empty JSONL frame");
      let entry;
      try { entry = JSON.parse(utf8.decode(line)); }
      catch { throw new Error("canonical Pi transcript contains invalid JSON"); }
      source.hash = createHash("sha256").update(line).digest("hex");
      this.#acceptEntry(record, entry, source);
      start = newline + 1;
    }
  }

  #appendPart(record, part) {
    if (part.length === 0) return;
    record.pendingBytes += part.length;
    if (record.pendingBytes > MAX_JSONL_LINE_BYTES) throw new Error(`canonical Pi transcript line exceeds ${MAX_JSONL_LINE_BYTES} bytes`);
    record.pendingParts.push(part);
  }

  #acceptEntry(record, entry, source) {
    if (!record.headerValidated) {
      if (entry?.type !== "session" || entry.id !== record.sessionId) throw new Error("canonical Pi transcript session header does not match registry identity");
      record.headerValidated = true;
      record.headerSource = source;
      record.branchId = createHash("sha256").update(JSON.stringify([record.sessionId, record.dev, record.ino, source.hash])).digest("hex");
      return;
    }
    if (!entry || entry.type === "session" || typeof entry.id !== "string"
      || !(entry.parentId === null || typeof entry.parentId === "string")) {
      throw new Error("canonical Pi transcript contains an invalid session entry");
    }
    if (record.entries.has(entry.id)) throw new Error("canonical Pi transcript contains a duplicate entry id");
    const inputId = inputIdForEntry(entry);
    const candidateId = typeof inputId === "string" && inputId && inputId.length <= 128 ? inputId : null;
    const authoritativeUser = Boolean(canonicalUserInputId(entry));
    const inputCandidate = candidateId ? { inputId: candidateId,
      evidence: authoritativeUser || source.length <= MAX_INPUT_REQUEST_BYTES ? actorInputRenderEvidence(entry) : null,
      kind: authoritativeUser ? "user-id" : entry.type === "custom_message" ? "custom" : "legacy-marker",
      entry: { id: entry.id, type: entry.type, timestamp: entry.timestamp,
        ...(authoritativeUser ? { message: { role: "user", id: candidateId } } : {}) } } : null;
    const message = projectVisibleMessage(entry, { imageReferences: true });
    const toolImageMessage = entry.type === "message" && entry.message?.role === "toolResult" && source.length <= MAX_INPUT_REQUEST_BYTES
      ? projectVisibleMessage(entry, { imageReferences: true, allowToolImages: true }) : undefined;
    const progress = projectProgressEntry(entry);
    const agentMessage = projectAgentMessageEntry(entry);
    // Ordinary appends keep the pagination identity. A branch switch invalidates
    // every previously loaded suffix, including after this cache is rebuilt.
    if (entry.parentId !== record.leafId) {
      record.branchId = createHash("sha256").update(JSON.stringify([record.branchId, entry.id, entry.parentId])).digest("hex");
    }
    // Cache availability only, never tool text, arguments, details, or image bytes.
    // The image reader revalidates canonical bytes under the input-image bounds.
    const toolImageCount = entry.type === "message" && entry.message?.role === "toolResult" && Array.isArray(entry.message.content)
      ? entry.message.content.filter((part) => part?.type === "image").length : 0;
    record.entries.set(entry.id, { parentId: entry.parentId, source, inputCandidate, toolImageCount, toolImageMessage: toolImageMessage?.role === "tool_output" ? toolImageMessage : null, assistantParts: assistantMessageParts(entry),
      inputBoundary: entry.type === "custom_message" || (entry.type === "message" && entry.message?.role === "user"),
      item: message ? { kind: "message", message } : progress ?? agentMessage ?? null });
    record.leafId = entry.id;
  }

  #activeEntryIds(record, leafId = record?.leafId ?? null) {
    const result = new Set(); let id = leafId;
    while (id !== null) {
      if (result.has(id)) throw new Error("canonical Pi transcript branch contains a cycle");
      result.add(id); const entry = record.entries.get(id);
      if (!entry) throw new Error("canonical Pi transcript branch has a missing parent");
      id = entry.parentId;
    }
    return result;
  }

  #visibleBranch(record, { sanitizePresentation = false, publicView = false, allowToolImages = false } = {}, associations = new Map()) {
    const reversed = [];
    const seen = new Set();
    let id = record.leafId;
    while (id !== null) {
      if (seen.has(id)) throw new Error("canonical Pi transcript branch contains a cycle");
      seen.add(id);
      const entry = record.entries.get(id);
      if (!entry) throw new Error("canonical Pi transcript branch has a missing parent");
      if (publicView && allowToolImages && entry.toolImageMessage) {
        reversed.push({ kind: "message", message: entry.toolImageMessage });
      } else if (publicView && entry.assistantParts?.length) {
        const parts = entry.assistantParts.map((part) => ({ ...part,
          text: sanitizePresentation ? sanitizePresentationText(part.text).text : part.text })).filter((part) => part.text);
        for (const message of parts.reverse()) reversed.push({ kind: "message", message });
      } else if (entry.item && !(entry.item.kind === "agent_message" && entry.item.direction === "from"
          && entry.item.delivery?.state === "accepted")) {
        let item = sanitizePresentation && entry.item.kind === "message" && entry.item.message.role === "assistant"
          ? { ...entry.item, message: { ...entry.item.message,
            text: sanitizePresentationText(entry.item.message.text).text } }
          : entry.item;
        if (item.kind === "message" && entry.inputCandidate) {
          item = { ...item, message: associateVisibleInput(item.message, entry.inputCandidate.entry,
            associations.get(entry.inputCandidate.inputId)) };
        }
        if (publicView && item.kind === "message" && item.message.inputId) {
          item = { ...item, message: { ...item.message, id: item.message.inputId, entryId: item.message.id } };
        }
        if (item.kind !== "message" || item.message.role !== "assistant" || item.message.text) reversed.push(item);
      }
      id = entry.parentId;
    }
    const visible = selectIncomingFamilyMessages(reversed.reverse());
    return publicView ? sortVisibleHistory(visible) : visible;
  }

  #touch(filePath, record) {
    this.#records.delete(filePath);
    this.#records.set(filePath, record);
  }

  #evict() {
    while (this.#records.size > this.maxCachedSessions) this.#records.delete(this.#records.keys().next().value);
  }
}
