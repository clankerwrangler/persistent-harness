import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_INPUT_REQUEST_BYTES, normalizeInputImages } from "./input-images.mjs";
import { inputIdForEntry, canonicalUserInputId, createActorInputAssociation, associateVisibleInput, projectVisibleMessage, assistantMessageParts, sortVisibleHistory } from "./conversation-projection.mjs";
import { sanitizePresentationText } from "./presentation-directive.mjs";
import { durableIncomingMessageId, isSupersededIncomingCustomMessage, projectAgentMessageEntry } from "./agent-message-projection.mjs";
import { projectProgressEntry } from "./progress-projection.mjs";
import { firstCompletedTitleTurn, rootTitleExcerpt } from "./root-title.mjs";
import { canonicalRetryInput } from "./session-actions.mjs";

const READ_CHUNK_BYTES = 64 * 1024;
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

function newRecord(filePath, stat, sessionId) {
  return {
    filePath, sessionId, dev: stat.dev, ino: stat.ino, offset: 0,
    headerValidated: false, branchId: null, entries: new Map(), incomingMessageIds: new Set(), leafId: null,
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

  async #readSnapshot({ sessionFile, sessionId, maxMessages = 512, maxBytes = 48 * 1024, sanitizePresentation = false, includeTitleTurn = false, before = null, publicView = false }) {
    const cursor = before === null ? null : parseHistoryCursor(before);
    const filePath = path.resolve(sessionFile);
    const options = { sessionFile: filePath, sessionId, maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, before, publicView };
    const projectionKey = JSON.stringify([sessionId, maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, before, publicView]);
    const active = this.#inflight.get(filePath);
    if (active) {
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
    state.promise = this.#read(filePath, sessionId, { maxMessages, maxBytes, sanitizePresentation, includeTitleTurn, cursor, publicView })
      .catch((error) => { if (error.code !== "history_cursor_stale") this.#records.delete(filePath); throw error; })
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
    await this.read({ sessionFile: filePath, sessionId });
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
    const snapshot = await this.#readSnapshot({ sessionFile, sessionId });
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
    const snapshot = await this.#readSnapshot({ sessionFile, sessionId });
    const turn = this.#retryTurn(snapshot.record, assistantId, snapshot.projection.leafId);
    const entry = await this.#readCanonicalEntry(snapshot.record, turn.userId);
    const inputId = inputIdForEntry(entry);
    const inputReceipt = inputId ? this.inputReceiptReader?.(inputId, sessionId) : null;
    return { ...turn, input: canonicalRetryInput(entry, { sessionId, inputReceipt, inputAssociation: snapshot.associations.get(inputId) }) };
  }

  async #readCanonicalEntry(record, entryId, { handle: sharedHandle } = {}) {
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
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, selected.source.offset + offset);
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

  async readImage({ sessionFile, sessionId, entryId, index, sanitizePresentation = false }) {
    const filePath = path.resolve(sessionFile);
    await this.read({ sessionFile: filePath, sessionId, sanitizePresentation });
    const record = this.#records.get(filePath);
    const selected = record?.entries.get(entryId);
    const reference = selected?.item?.kind === "message" ? selected.item.message.images?.[index]?.ref : undefined;
    if (!reference || reference.entryId !== entryId || reference.index !== index || !this.#activeEntryIds(record).has(entryId)) {
      throw new Error("visible user image does not exist on the active transcript branch");
    }
    const entry = await this.#readCanonicalEntry(record, entryId);
    const content = entry.type === "message" && entry.message?.role === "user" ? entry.message.content
      : entry.type === "custom_message" && ["scheduled_job", "background_notification"].includes(selected.item.message.role) ? entry.content : null;
    if (!content) throw new Error("visible input image source does not match its transcript entry");
    const candidates = Array.isArray(content) ? content.filter((part) => part?.type === "image")
      .map((part) => ({ type: "image", data: part.data, mimeType: part.mimeType })) : [];
    const image = normalizeInputImages(candidates)[index];
    if (!image) throw new Error("visible user image index does not exist");
    return image;
  }

  async #inputAssociations(record, handle) {
    const associations = new Map(); if (!this.inputReceiptReader) return associations;
    const groups = new Map();
    for (const entry of record.entries.values()) {
      const candidate = entry.inputCandidate; if (!candidate) continue;
      const group = groups.get(candidate.inputId) ?? [];
      group.push(entry); groups.set(candidate.inputId, group);
    }
    for (const [inputId, entries] of groups) {
      const inputReceipt = this.inputReceiptReader(inputId, record.sessionId); if (!inputReceipt) continue;
      const verifier = createActorInputAssociation({ sessionId: record.sessionId, inputReceipt });
      for (const entry of entries) {
        const candidate = entry.inputCandidate;
        if (inputReceipt.entryId != null && inputReceipt.entryId !== candidate.entry.id) continue;
        if (candidate.kind !== "user-id" && entry.source.length > MAX_INPUT_REQUEST_BYTES) {
          verifier.incomplete({ entryId: candidate.entry.id, kind: candidate.kind }); continue;
        }
        // Canonical user identity neither rereads nor retains expanded payloads.
        const canonical = candidate.kind === "user-id" ? candidate.entry
          : await this.#readCanonicalEntry(record, candidate.entry.id, { handle });
        verifier.add(canonical);
      }
      associations.set(inputId, verifier.result());
    }
    return associations;
  }

  async #read(filePath, sessionId, bounds) {
    const handle = await open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`canonical Pi transcript is not a regular file: ${filePath}`);
      let record = this.#records.get(filePath);
      if (!record || record.sessionId !== sessionId || !sameFile(record, stat)) {
        record = newRecord(filePath, stat, sessionId);
        this.#records.set(filePath, record);
      }
      const target = stat.size;
      while (record.offset < target) {
        const length = Math.min(READ_CHUNK_BYTES, target - record.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, record.offset);
        if (bytesRead === 0) break;
        record.offset += bytesRead;
        this.#consume(record, buffer.subarray(0, bytesRead), record.offset - bytesRead);
      }
      if (!record.headerValidated) throw new Error(`canonical Pi transcript header is incomplete: ${filePath}`);
      record.touchedAt = Date.now();
      this.#touch(filePath, record);
      this.#evict();
      const associations = await this.#inputAssociations(record, handle);
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
      const page = boundVisibleHistory(visible.slice(0, end), bounds);
      if (end > 0 && page.history.length === 0) throw historyError("history_page_too_small", "history row exceeds the page byte limit");
      const hasMore = page.truncated;
      const historyPage = { hasMore, nextCursor: hasMore ? historyCursor(record, page.history[0].id) : null, branchId: record.branchId };
      const proven = [...associations].filter(([, result]) => result.state === "proven");
      const projection = { ...page, historyPage, ...title, leafId: record.leafId,
        inputIds: proven.map(([inputId]) => inputId),
        inputEntries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, result.entryId])),
        inputDeliveries: Object.fromEntries(proven.map(([inputId, result]) => [inputId, { entryId: result.entryId, deliveredAt: result.deliveredAt }])),
        inputAssociationStates: Object.fromEntries([...associations].map(([inputId, result]) => [inputId, result.state])) };
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
      kind: authoritativeUser ? "user-id" : entry.type === "custom_message" ? "custom" : "legacy-marker",
      entry: { id: entry.id, type: entry.type, timestamp: entry.timestamp,
        ...(authoritativeUser ? { message: { role: "user", id: candidateId } } : {}) } } : null;
    const message = projectVisibleMessage(entry, { imageReferences: true });
    const progress = projectProgressEntry(entry);
    const incomingId = durableIncomingMessageId(entry);
    if (incomingId) record.incomingMessageIds.add(incomingId);
    const agentMessage = isSupersededIncomingCustomMessage(entry, record.incomingMessageIds)
      ? undefined : projectAgentMessageEntry(entry);
    // Ordinary appends keep the pagination identity. A branch switch invalidates
    // every previously loaded suffix, including after this cache is rebuilt.
    if (entry.parentId !== record.leafId) {
      record.branchId = createHash("sha256").update(JSON.stringify([record.branchId, entry.id, entry.parentId])).digest("hex");
    }
    record.entries.set(entry.id, { parentId: entry.parentId, source, inputCandidate, assistantParts: assistantMessageParts(entry),
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

  #visibleBranch(record, { sanitizePresentation = false, publicView = false } = {}, associations = new Map()) {
    const reversed = [];
    const seen = new Set();
    let id = record.leafId;
    while (id !== null) {
      if (seen.has(id)) throw new Error("canonical Pi transcript branch contains a cycle");
      seen.add(id);
      const entry = record.entries.get(id);
      if (!entry) throw new Error("canonical Pi transcript branch has a missing parent");
      if (publicView && entry.assistantParts?.length) {
        const parts = entry.assistantParts.map((part) => ({ ...part,
          text: sanitizePresentation ? sanitizePresentationText(part.text).text : part.text })).filter((part) => part.text);
        for (const message of parts.reverse()) reversed.push({ kind: "message", message });
      } else if (entry.item) {
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
    const visible = reversed.reverse();
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
