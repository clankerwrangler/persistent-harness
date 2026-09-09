import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ACTOR_INPUT_MESSAGE_TYPE, actorInputCustomPayload, actorInputDigest } from "./protocol.mjs";
import { normalizeInputImages } from "./input-images.mjs";
import { sanitizePresentationText } from "./presentation-directive.mjs";

const TRAILING_INPUT_MARKER = /\n\n<!-- persistent-harness-input:([^>\s]{1,128}) -->$/;
export const SCHEDULED_JOB_ROLE = "scheduled_job";

function contentText(content) {
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
}
export function parseHarnessInput(text) {
  const source = String(text ?? ""); const match = TRAILING_INPUT_MARKER.exec(source);
  return match ? { inputId: match[1], text: source.slice(0, match.index) } : undefined;
}
export function cleanHarnessInput(text) { return parseHarnessInput(text)?.text ?? String(text ?? ""); }
export function visibleContentText(content, { sanitizePresentation = false } = {}) {
  const text = contentText(content);
  return sanitizePresentation ? sanitizePresentationText(text).text : text;
}

function visibleUserImages(content, { references = false, entryId } = {}) {
  if (!Array.isArray(content)) return [];
  const candidates = content.filter((part) => part?.type === "image")
    .map((part) => ({ type: "image", data: part.data, mimeType: part.mimeType }));
  try {
    return normalizeInputImages(candidates).map((image, index) => ({
      type: "image", mimeType: image.mimeType, name: `Pasted image ${index + 1}`,
      size: Buffer.from(image.data, "base64").length,
      ...(references ? { ref: { entryId, index } } : { data: image.data }),
    }));
  } catch { return []; }
}

function iso(value) { if (value === undefined || value === null) return null; const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }

export function canonicalUserInputId(entry) {
  return entry?.type === "message" && entry.message?.role === "user"
    && typeof entry.message.id === "string" && entry.message.id ? entry.message.id : undefined;
}

export function inputIdForEntry(entry) {
  if (entry?.type === "custom_message" && entry.customType === ACTOR_INPUT_MESSAGE_TYPE) return entry.details?.inputId;
  if (entry?.type !== "message" || entry.message?.role !== "user") return undefined;
  return canonicalUserInputId(entry) ?? parseHarnessInput(contentText(entry.message.content ?? entry.message.text))?.inputId;
}

export function canonicalInputContent(content) {
  if (typeof content === "string") return { message: content, images: [] };
  if (!Array.isArray(content) || content.some((part) => !part || !["text", "image"].includes(part.type)
    || (part.type === "text" && typeof part.text !== "string"))) throw new Error("canonical retry input has unsupported content");
  return { message: visibleContentText(content), images: normalizeInputImages(content.filter((part) => part.type === "image")
    .map((part) => ({ type: "image", data: part.data, mimeType: part.mimeType }))) };
}

export function canonicalActorInputContent(entry, receipt) {
  if (entry.type === "message" && entry.message?.role === "user") {
    const content = canonicalInputContent(entry.message.content ?? entry.message.text);
    if (!canonicalUserInputId(entry)) content.message = cleanHarnessInput(content.message);
    return content;
  }
  if (entry.type !== "custom_message" || entry.customType !== ACTOR_INPUT_MESSAGE_TYPE
    || !["cron", "background"].includes(receipt?.source) || entry.details?.source !== receipt.source
    || !isDeepStrictEqual(entry.details?.origin, receipt.origin) || entry.details?.acceptedAt !== iso(receipt.acceptedAt)
    || (entry.details.clientMessageId != null && entry.details.clientMessageId !== receipt.clientMessageId)) {
    throw new Error("canonical input has no verified internal provenance");
  }
  const content = canonicalInputContent(entry.content);
  const envelope = { ...receipt, clientMessageId: entry.details.clientMessageId ?? null, images: [] };
  const prefix = actorInputCustomPayload({ ...envelope, message: "" }).content;
  if (!content.message.startsWith(prefix)) throw new Error("canonical input does not match its formatter");
  content.message = content.message.slice(prefix.length);
  const expected = actorInputCustomPayload({ ...envelope, ...content });
  if (!isDeepStrictEqual(expected.content, entry.content) || !isDeepStrictEqual(expected.details, entry.details)) {
    throw new Error("canonical input does not match its formatter");
  }
  return content;
}

// A match is evidence, not an association. The complete inventory resolves identity.
function actorInputEntryMatch(entry, receipt) {
  if (inputIdForEntry(entry) !== receipt.inputId || (receipt.entryId != null && receipt.entryId !== entry.id)
    || !iso(entry.timestamp)) return null;
  try {
    let kind;
    if (entry.type === "message" && entry.message?.role === "user") {
      kind = canonicalUserInputId(entry) ? "user-id" : "legacy-marker";
      if (kind === "legacy-marker") {
        const content = canonicalActorInputContent(entry, receipt);
        if (typeof receipt.message === "string") {
          if (receipt.message !== content.message
            || !isDeepStrictEqual(normalizeInputImages(receipt.images), content.images)) return null;
        } else if (typeof receipt.digest !== "string" || !["auto", "steer", "follow_up"].some((behavior) =>
          actorInputDigest(content.message, JSON.stringify(content.images), behavior) === receipt.digest)) return null;
      }
      // Canonical IDs survive expansions. Identity proof needs no body reread.
      if (["cron", "background"].includes(receipt.source)) actorInputCustomPayload({ ...receipt, message: "", images: [] });
    } else if (entry.type === "custom_message" && entry.customType === ACTOR_INPUT_MESSAGE_TYPE) {
      canonicalActorInputContent(entry, receipt); kind = "custom";
    } else return null;
    return { inputId: receipt.inputId, kind, source: receipt.source, origin: receipt.origin,
      acceptedAt: receipt.acceptedAt, clientMessageId: receipt.clientMessageId };
  } catch { return null; }
}

// Per-read verification supports sequential reads without retaining input payloads.
export function createActorInputAssociation({ sessionId, inputReceipt: receipt } = {}) {
  const eligible = receipt && sessionId && receipt.sessionId === sessionId && typeof receipt.inputId === "string"
    && receipt.inputId.length > 0 && receipt.inputId.length <= 128 && receipt.outcome !== "handled"
    && Number.isSafeInteger(receipt.acceptedAt) && iso(receipt.acceptedAt)
    && [null, "user", "cron", "background"].includes(receipt.source);
  let strong = null, legacy = null, strongCount = 0, legacyCount = 0, unknownStrong = false, unknownLegacy = false;
  return {
    add(entry) {
      if (!eligible) return;
      const proof = actorInputEntryMatch(entry, receipt); if (!proof) return;
      const match = { entryId: entry.id, deliveredAt: entry.timestamp, proof };
      if (receipt.entryId != null || proof.kind !== "legacy-marker") {
        strongCount = Math.min(2, strongCount + 1); strong = match;
      } else { legacyCount = Math.min(2, legacyCount + 1); legacy = match; }
    },
    incomplete({ entryId, kind }) {
      if (!eligible || (receipt.entryId != null && receipt.entryId !== entryId)) return;
      if (kind === "custom" && !["cron", "background"].includes(receipt.source)) return;
      if (receipt.entryId === entryId || kind !== "legacy-marker") unknownStrong = true;
      else unknownLegacy = true;
    },
    result({ complete = true } = {}) {
      if (strongCount > 1 || unknownStrong) return { state: "unresolved" };
      if (strongCount === 1) return { state: "proven", ...strong };
      if (unknownLegacy || legacyCount > 1 || (legacyCount && !complete)) return { state: "unresolved" };
      return legacyCount === 1 ? { state: "proven", ...legacy } : { state: "absent" };
    },
  };
}

export function resolveActorInputAssociation(entries, { complete = true, ...options } = {}) {
  const association = createActorInputAssociation(options);
  for (const entry of entries ?? []) association.add(entry);
  return association.result({ complete });
}

export function associateVisibleInput(message, entry, association) {
  if (!message || association?.state !== "proven" || association.entryId !== entry.id) return message;
  const proof = association.proof;
  return { ...message, inputId: proof.inputId, role: publicInputRole(proof.source),
    text: proof.kind === "legacy-marker" ? cleanHarnessInput(message.text) : message.text,
    source: proof.source, origin: proof.origin, createdAt: iso(proof.acceptedAt),
    delivery: { state: "delivered", inputId: proof.inputId, acceptedAt: iso(proof.acceptedAt), deliveredAt: iso(association.deliveredAt) },
    ...(proof.clientMessageId ? { clientMessageId: proof.clientMessageId } : {}) };
}

export function publicInputRole(source) { return source === "cron" ? SCHEDULED_JOB_ROLE : source === "background" ? "background_notification" : "user"; }

export function pendingInputMessage(input) {
  return { id: input.inputId, role: publicInputRole(input.source), text: input.message ?? "",
    createdAt: iso(input.acceptedAt ?? input.createdAt), status: "complete", delivery: input.delivery,
    source: input.source, origin: input.origin, ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
    ...(input.images?.length ? { images: input.images.map((image, index) => ({ type: "image", mimeType: image.mimeType,
      ref: { entryId: input.inputId, index }, size: Buffer.from(image.data, "base64").length })) } : {}) };
}
export function projectVisibleMessage(entry, { streaming = false, imageReferences = false, sanitizePresentation = false,
  inputAssociation, canonicalEntries, sessionId, inputReceipt } = {}) {
  const association = inputAssociation ?? (inputReceipt ? resolveActorInputAssociation(canonicalEntries ?? [entry],
    { sessionId, inputReceipt, complete: canonicalEntries !== undefined }) : null);
  if (entry?.type === "custom_message" && entry.customType === ACTOR_INPUT_MESSAGE_TYPE) {
    const details = entry.details;
    if (!["cron", "background"].includes(details?.source) || typeof details.inputId !== "string" || !details.inputId || details.inputId.length > 128
      || !iso(details.acceptedAt) || !iso(entry.timestamp)) return undefined;
    const images = visibleUserImages(entry.content, { references: imageReferences, entryId: entry.id });
    return associateVisibleInput({ id: entry.id, role: publicInputRole(details.source), text: contentText(entry.content),
      ...(images.length ? { images } : {}), source: details.source, origin: details.origin,
      createdAt: iso(details.acceptedAt), status: "complete" }, entry, association);
  }
  if (entry?.type !== "message") return undefined;
  const message = entry.message; if (!message || !["user", "assistant"].includes(message.role)) return undefined;
  const content = message.content ?? message.text;
  const text = visibleContentText(content, { sanitizePresentation: sanitizePresentation && message.role === "assistant" });
  if (message.role === "assistant" && !text && !streaming) return undefined;
  const images = message.role === "user" ? visibleUserImages(content, { references: imageReferences, entryId: entry.id }) : [];
  return associateVisibleInput({ id: String(entry.id ?? message.id ?? `message-${entry.timestamp ?? Date.now()}`), role: message.role, text,
    ...(images.length ? { images } : {}), createdAt: iso(message.timestamp ?? entry.timestamp), status: streaming ? "streaming" : "complete" }, entry, association);
}
export function projectVisibleMessages(entries, options = {}) {
  const source = Array.isArray(entries) ? entries : [], associations = new Map();
  for (const entry of source) {
    const inputId = inputIdForEntry(entry); if (!inputId) continue;
    if (!associations.has(inputId)) {
      const inputReceipt = options.inputReceiptReader?.(inputId, options.sessionId) ?? options.inputReceipt;
      associations.set(inputId, createActorInputAssociation({ ...options, inputReceipt }));
    }
    associations.get(inputId).add(entry);
  }
  for (const [inputId, verifier] of associations) associations.set(inputId, verifier.result());
  return source.map((entry) => projectVisibleMessage(entry, { ...options, inputAssociation: associations.get(inputIdForEntry(entry)) })).filter(Boolean);
}

export function assistantTextPart(message, contentIndex, { entryId, timestamp, sanitizePresentation = false } = {}) {
  const part = message?.content?.[contentIndex];
  if (message?.role !== "assistant" || part?.type !== "text" || typeof part.text !== "string") return undefined;
  let providerId;
  if (typeof part.textSignature === "string" && part.textSignature.length <= 2048) {
    try {
      const signature = JSON.parse(part.textSignature);
      if (signature?.v === 1 && typeof signature.id === "string" && signature.id.length > 0
        && signature.id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(signature.id)) providerId = signature.id;
    } catch {}
  }
  const startedAt = message.timestamp ?? timestamp;
  const date = new Date(startedAt);
  const textId = typeof part.id === "string" && part.id.length > 0 && part.id.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(part.id) ? part.id : undefined;
  // A core text item keeps its identity when early execution rebases its segment.
  // Provider signatures and segment positions identify only legacy entries.
  const base = textId ? `assistant-${createHash("sha256").update(textId).digest("hex")}`
    : providerId ? `assistant-${createHash("sha256").update(String(message.provider ?? "")).update("\0").update(providerId).digest("hex")}`
      : typeof message.id === "string" && message.id ? `assistant-${createHash("sha256").update(message.id).digest("hex")}-text-${contentIndex}`
      : entryId ? `${entryId}-text-${contentIndex}`
        : Number.isSafeInteger(startedAt) && startedAt >= 0 ? `assistant-${startedAt}-text-${contentIndex}` : undefined;
  if (!base || Number.isNaN(date.valueOf())) return undefined;
  return { id: base, role: "assistant", text: sanitizePresentation ? sanitizePresentationText(part.text).text : part.text,
    contentIndex, createdAt: date.toISOString(), status: "complete", ...(entryId ? { entryId } : {}) };
}

export function assistantMessageParts(entry, options = {}) {
  if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.map((_part, index) => assistantTextPart(entry.message, index,
    { ...options, entryId: entry.id, timestamp: entry.timestamp })).filter((part) => part?.text);
}

export function sortVisibleHistory(items) {
  return items.sort((left, right) => {
    const time = (item) => Date.parse(item.kind === "message" ? item.message.createdAt : item.createdAt);
    const a = time(left); const b = time(right);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
  });
}
