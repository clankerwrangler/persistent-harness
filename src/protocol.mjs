import { createHash } from "node:crypto";
import { MAX_INPUT_REQUEST_BYTES, normalizeInputImages } from "./input-images.mjs";

export const PROTOCOL_VERSION = 2;
export const ACTOR_INPUT_COMMAND = "persistent-harness-input";
export const ACTOR_INPUT_MESSAGE_TYPE = "persistent-harness-input";

export function actorInputPrompt(inputId) {
  return `/${ACTOR_INPUT_COMMAND} ${encodeURIComponent(string(inputId, "inputId", 128))}`;
}
export function actorInputDigest(message, imagesJson, behavior) {
  return createHash("sha256").update(message).update("\0").update(imagesJson).update("\0").update(behavior).digest("hex");
}

export function actorInputCustomPayload(input) {
  if (!["cron", "background"].includes(input?.source)) throw new Error("custom input requires a verified internal source");
  const origin = input.origin;
  if (!origin || typeof origin.jobId !== "string" || !origin.jobId
    || (input.source === "cron" && (typeof origin.runId !== "string" || !origin.runId))) {
    throw new Error("custom input requires a verified job origin");
  }
  if (typeof input.message !== "string" || typeof input.inputId !== "string"
    || !Number.isSafeInteger(input.acceptedAt)) throw new Error("invalid durable input");
  const acceptedAt = new Date(input.acceptedAt).toISOString();
  const heading = input.source === "cron" ? `Harness cron input (job ${origin.jobId}, run ${origin.runId})`
    : `Harness background completion (job ${origin.jobId})`;
  const text = `${heading}. This is an internal harness event, not a new Commander submission.\n\n${input.message}`;
  const images = normalizeInputImages(input.images);
  return { customType: ACTOR_INPUT_MESSAGE_TYPE, display: true,
    content: images.length ? [{ type: "text", text }, ...images] : text,
    details: { inputId: input.inputId, source: input.source, origin, acceptedAt,
      ...(input.clientMessageId == null ? {} : { clientMessageId: input.clientMessageId }) } };
}

export const MAX_FRAME_BYTES = MAX_INPUT_REQUEST_BYTES;
export const MAX_ID_LENGTH = 128;
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024;
export const MAX_USER_INPUT_BYTES = 32 * 1024;

const requestTypes = new Set([
  "register_actor", "register_client", "heartbeat",
  "set_session_name", "update_activity", "update_progress_heading", "record_progress_entry", "record_agent_message_entry", "record_child_creation_entry", "set_skill_manifest", "record_usage", "record_context_usage",
  "get_actor_input", "accept_actor_input", "record_input_delivery", "flush_actor_inputs",
  "get_roster", "send_message", "ack_message", "spawn_child", "list_children", "session_history", "cron_job",
  "stop_child", "revive_child", "delete_child",
  "create_root", "list_sessions", "rename_session", "subscribe_session", "unsubscribe_session", "subscribe_root_output", "unsubscribe_root_output",
  "submit_input", "respond_extension_ui", "get_session_inference", "set_session_inference", "get_actor_state", "get_actor_entries", "get_visible_messages", "get_visible_image", "compact_session", "restart_kernel", "abort_session",
  "get_skill_runtime_plan", "provision_skill_runtime",
  "stop_session", "revive_session", "delete_session", "get_status", "get_usage", "shutdown_daemon",
]);

export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = "ProtocolError"; this.code = code; }
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function record(value, path) { if (!isRecord(value)) throw new ProtocolError("invalid_request", `${path} must be an object`); return value; }
function exact(value, keys, path) { for (const key of Object.keys(value)) if (!keys.has(key)) throw new ProtocolError("invalid_request", `${path}.${key} is not supported`); }
function string(value, path, max, { optional = false, nullable = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.length || value.length > max) throw new ProtocolError("invalid_request", `${path} must be a non-empty string of at most ${max} characters`);
  return value;
}
function utf8(value, path, max) { const result = string(value, path, max); if (Buffer.byteLength(result, "utf8") > max) throw new ProtocolError("invalid_request", `${path} must be at most ${max} UTF-8 bytes`); return result; }
function bool(value, path) { if (typeof value !== "boolean") throw new ProtocolError("invalid_request", `${path} must be boolean`); return value; }
function integer(value, path, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new ProtocolError("invalid_request", `${path} must be an integer from ${min} through ${max}`); return value; }
function array(value, path, max) { if (!Array.isArray(value) || value.length > max) throw new ProtocolError("invalid_request", `${path} must be an array of at most ${max} items`); return value; }
function empty(params) { const value = record(params, "params"); exact(value, new Set(), "params"); return value; }
function finite(value, path, min, max) { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ProtocolError("invalid_request", `${path} must be a finite number from ${min} through ${max}`); return value; }

function actorRegistration(params) {
  const value = record(params, "params");
  exact(value, new Set(["sessionId", "sessionFile", "cwd", "repositoryRoot", "actorToken", "actorGeneration"]), "params");
  return {
    sessionId: string(value.sessionId, "params.sessionId", 128),
    sessionFile: string(value.sessionFile, "params.sessionFile", 4096),
    cwd: string(value.cwd, "params.cwd", 4096),
    repositoryRoot: string(value.repositoryRoot, "params.repositoryRoot", 4096, { nullable: true }),
    actorToken: string(value.actorToken, "params.actorToken", 128),
    actorGeneration: integer(value.actorGeneration, "params.actorGeneration", 1, 1_000_000_000),
  };
}
function clientRegistration(params) { const value = record(params, "params"); exact(value, new Set(["clientInstanceId"]), "params"); return { clientInstanceId: string(value.clientInstanceId, "params.clientInstanceId", 128) }; }
function sessionIdParam(params, extra = []) { const value = record(params, "params"); exact(value, new Set(["sessionId", ...extra]), "params"); return { value, sessionId: string(value.sessionId, "params.sessionId", 128) }; }
function childSelector(params) { const value = record(params, "params"); exact(value, new Set(["selector"]), "params"); return { selector: string(value.selector, "params.selector", 256) }; }
function skill(value, path) { const item = record(value, path); exact(item, new Set(["id", "version", "contentHash", "skillPath", "pythonBacked"]), path); return { id: string(item.id, `${path}.id`, 64), version: string(item.version, `${path}.version`, 256), contentHash: string(item.contentHash, `${path}.contentHash`, 128), skillPath: string(item.skillPath, `${path}.skillPath`, 4096), pythonBacked: bool(item.pythonBacked, `${path}.pythonBacked`) }; }
function model(value, path) { const item = record(value, path); exact(item, new Set(["provider", "id", "name", "reasoning", "thinkingLevels"]), path); return { provider: string(item.provider, `${path}.provider`, 128), id: string(item.id, `${path}.id`, 256), name: item.name === undefined ? item.id : string(item.name, `${path}.name`, 256), reasoning: item.reasoning === undefined ? false : bool(item.reasoning, `${path}.reasoning`), thinkingLevels: array(item.thinkingLevels, `${path}.thinkingLevels`, 7).map((level, index) => string(level, `${path}.thinkingLevels[${index}]`, 16)) }; }
function spawnChild(params) {
  const value = record(params, "params");
  exact(value, new Set(["prompt", "name", "model", "thinkingLevel", "parentModel", "parentThinkingLevel", "availableModels", "forkContext", "forkLeafId"]), "params");
  const forkContext = value.forkContext === undefined ? false : bool(value.forkContext, "params.forkContext");
  if (!forkContext && value.forkLeafId !== undefined) throw new ProtocolError("invalid_request", "params.forkLeafId requires forkContext");
  const forkLeafId = forkContext ? string(value.forkLeafId, "params.forkLeafId", 128, { nullable: true }) : undefined;
  return {
    prompt: utf8(value.prompt, "params.prompt", 32 * 1024),
    name: value.name == null ? null : string(value.name, "params.name", 64),
    model: value.model == null ? null : string(value.model, "params.model", 384),
    thinkingLevel: value.thinkingLevel == null ? null : string(value.thinkingLevel, "params.thinkingLevel", 16),
    parentModel: model(value.parentModel, "params.parentModel"),
    parentThinkingLevel: string(value.parentThinkingLevel, "params.parentThinkingLevel", 16),
    availableModels: array(value.availableModels, "params.availableModels", 512).map((item, index) => model(item, `params.availableModels[${index}]`)),
    forkContext,
    ...(forkContext ? { forkLeafId } : {}),
  };
}
function createRoot(params) { const value = record(params, "params"); exact(value, new Set(["cwd", "repositoryRoot", "name", "provider", "model", "thinkingLevel"]), "params"); const provider = value.provider == null ? null : string(value.provider, "params.provider", 128); const selectedModel = value.model == null ? null : string(value.model, "params.model", 256); if ((provider === null) !== (selectedModel === null)) throw new ProtocolError("invalid_request", "params.provider and params.model must be supplied together"); return { cwd: string(value.cwd, "params.cwd", 4096), repositoryRoot: value.repositoryRoot == null ? null : string(value.repositoryRoot, "params.repositoryRoot", 4096), name: value.name == null ? null : string(value.name, "params.name", 256), provider, model: selectedModel, thinkingLevel: value.thinkingLevel == null ? null : string(value.thinkingLevel, "params.thinkingLevel", 16) }; }
function sendMessage(params) { const value = record(params, "params"); exact(value, new Set(["target", "body", "deliveryMode"]), "params"); const mode = value.deliveryMode ?? "auto"; if (!["auto", "follow_up"].includes(mode)) throw new ProtocolError("invalid_request", "params.deliveryMode must be auto or follow_up"); return { target: string(value.target, "params.target", 256), body: utf8(value.body, "params.body", MAX_MESSAGE_BODY_BYTES), deliveryMode: mode }; }
function usage(params) { const value = record(params, "params"); exact(value, new Set(["entryId", "provider", "model", "input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "costTotal"]), "params"); const result = { entryId: string(value.entryId, "params.entryId", 128), provider: string(value.provider, "params.provider", 128), model: string(value.model, "params.model", 256), input: integer(value.input, "params.input", 0, Number.MAX_SAFE_INTEGER), output: integer(value.output, "params.output", 0, Number.MAX_SAFE_INTEGER), cacheRead: integer(value.cacheRead, "params.cacheRead", 0, Number.MAX_SAFE_INTEGER), cacheWrite: integer(value.cacheWrite, "params.cacheWrite", 0, Number.MAX_SAFE_INTEGER), reasoning: value.reasoning === undefined ? null : integer(value.reasoning, "params.reasoning", 0, Number.MAX_SAFE_INTEGER), totalTokens: integer(value.totalTokens, "params.totalTokens", 0, Number.MAX_SAFE_INTEGER), costTotal: finite(value.costTotal, "params.costTotal", 0, 1_000_000_000) }; if (result.reasoning !== null && result.reasoning > result.output) throw new ProtocolError("invalid_request", "params.reasoning must not exceed params.output"); return result; }
function usageWindow(params) { const value = record(params, "params"); exact(value, new Set(["windowMinutes"]), "params"); return { windowMinutes: integer(value.windowMinutes, "params.windowMinutes", 1, 10_080) }; }
function subscribe(params) { const value = record(params, "params"); exact(value, new Set(["selector", "passive"]), "params"); return { selector: string(value.selector, "params.selector", 256), passive: value.passive === undefined ? false : bool(value.passive, "params.passive") }; }
function subscribeRootOutput(params) { const value = record(params, "params"); exact(value, new Set(["generation", "afterSeq", "invalidCursor"]), "params"); const generation = value.generation === undefined ? null : string(value.generation, "params.generation", 128); const afterSeq = value.afterSeq === undefined ? null : integer(value.afterSeq, "params.afterSeq", 0, Number.MAX_SAFE_INTEGER); const invalidCursor = value.invalidCursor === undefined ? false : bool(value.invalidCursor, "params.invalidCursor"); if (generation !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(generation)) throw new ProtocolError("invalid_request", "params.generation has an invalid shape"); if (!invalidCursor && ((generation === null) !== (afterSeq === null))) throw new ProtocolError("invalid_request", "params.generation and params.afterSeq must be supplied together"); if (invalidCursor && (generation !== null || afterSeq !== null)) throw new ProtocolError("invalid_request", "invalid cursor must not include generation or afterSeq"); return invalidCursor ? { invalid: true } : generation === null ? null : { generation, afterSeq }; }
function progressHeading(params) { const value = record(params, "params"); exact(value, new Set(["phase", "turnId", "summary"]), "params"); const phase = string(value.phase, "params.phase", 16); if (!["start", "heading", "settled"].includes(phase)) throw new ProtocolError("invalid_request", "params.phase must be start, heading, or settled"); if (phase === "heading" && value.summary === undefined) throw new ProtocolError("invalid_request", "heading progress requires params.summary"); if (phase !== "heading" && value.summary !== undefined) throw new ProtocolError("invalid_request", `${phase} progress must not include params.summary`); return { phase, turnId: string(value.turnId, "params.turnId", 128), ...(phase === "heading" ? { summary: utf8(value.summary, "params.summary", 512) } : {}) }; }
function progressEntry(params) {
  const value = record(params, "params");
  exact(value, new Set(["entryId", "summary", "createdAt"]), "params");
  const createdAt = string(value.createdAt, "params.createdAt", 64);
  if (Number.isNaN(Date.parse(createdAt))) throw new ProtocolError("invalid_request", "params.createdAt must be an ISO timestamp");
  return { entryId: string(value.entryId, "params.entryId", 128), summary: utf8(value.summary, "params.summary", 512), createdAt };
}
function agentMessageEntry(params) {
  const value = record(params, "params");
  exact(value, new Set(["entryId", "messageId", "direction", "peerId", "peerName", "relationship", "body", "createdAt"]), "params");
  const direction = string(value.direction, "params.direction", 4);
  if (!["from", "to"].includes(direction)) throw new ProtocolError("invalid_request", "params.direction must be from or to");
  const relationship = string(value.relationship, "params.relationship", 16);
  if (!["parent", "child", "sibling"].includes(relationship)) throw new ProtocolError("invalid_request", "params.relationship must be parent, child, or sibling");
  const createdAt = string(value.createdAt, "params.createdAt", 64);
  if (Number.isNaN(Date.parse(createdAt))) throw new ProtocolError("invalid_request", "params.createdAt must be an ISO timestamp");
  return { entryId: string(value.entryId, "params.entryId", 128), messageId: string(value.messageId, "params.messageId", 128),
    direction, peerId: string(value.peerId, "params.peerId", 128), peerName: utf8(value.peerName, "params.peerName", 1024),
    relationship, body: utf8(value.body, "params.body", MAX_MESSAGE_BODY_BYTES), createdAt };
}
function childCreationEntry(params) {
  const value = record(params, "params");
  exact(value, new Set(["entryId", "taskId", "childId", "childName", "relationship", "body", "createdAt"]), "params");
  const relationship = string(value.relationship, "params.relationship", 16);
  if (relationship !== "child") throw new ProtocolError("invalid_request", "params.relationship must be child");
  const createdAt = string(value.createdAt, "params.createdAt", 64);
  if (Number.isNaN(Date.parse(createdAt))) throw new ProtocolError("invalid_request", "params.createdAt must be an ISO timestamp");
  return { entryId: string(value.entryId, "params.entryId", 128), taskId: string(value.taskId, "params.taskId", 128),
    childId: string(value.childId, "params.childId", 128), childName: utf8(value.childName, "params.childName", 1024),
    relationship, body: utf8(value.body, "params.body", 32 * 1024), createdAt };
}
function visibleImage(params) { const { value, sessionId } = sessionIdParam(params, ["entryId", "index"]); return { sessionId,
  entryId: string(value.entryId, "params.entryId", 128), index: integer(value.index, "params.index", 0, 3) }; }
function renameSession(params) { const { value, sessionId } = sessionIdParam(params, ["name"]); return { sessionId, name: string(value.name, "params.name", 256) }; }
function submit(params) {
  const { value, sessionId } = sessionIdParam(params, ["message", "images", "behavior", "clientRequestId", "clientMessageId", "retryOf", "retryOriginal"]);
  const retryOf = value.retryOf === undefined ? null : string(value.retryOf, "params.retryOf", 128);
  const clientRequestId = value.clientRequestId === undefined ? null : string(value.clientRequestId, "params.clientRequestId", 128);
  const retryOriginal = value.retryOriginal === undefined ? false : bool(value.retryOriginal, "params.retryOriginal");
  let images;
  if (retryOriginal) {
    if (!retryOf) throw new ProtocolError("invalid_request", "original retry requires params.retryOf");
    if (!clientRequestId) throw new ProtocolError("invalid_request", "original retry requires params.clientRequestId");
    if (Object.hasOwn(value, "message") || Object.hasOwn(value, "images")) {
      throw new ProtocolError("invalid_request", "params.retryOriginal requires message and images to be omitted");
    }
  } else {
    try { images = normalizeInputImages(value.images); }
    catch (error) { throw new ProtocolError("invalid_request", error instanceof Error ? error.message : String(error)); }
    if (typeof value.message !== "string" || Buffer.byteLength(value.message, "utf8") > MAX_USER_INPUT_BYTES
      || (!value.message.length && images.length === 0)) {
      throw new ProtocolError("invalid_request", `params.message must be at most ${MAX_USER_INPUT_BYTES} UTF-8 bytes and may be empty only with images`);
    }
  }
  const behavior = value.behavior ?? "auto";
  if (!["auto", "steer", "follow_up"].includes(behavior)) throw new ProtocolError("invalid_request", "params.behavior must be auto, steer, or follow_up");
  if (retryOf && behavior !== "auto") throw new ProtocolError("invalid_request", "params.retryOf requires params.behavior auto");
  return { sessionId, ...(retryOriginal ? {} : { message: value.message, images }), behavior, clientRequestId,
    ...(value.retryOriginal === undefined ? {} : { retryOriginal }),
    ...(value.clientMessageId === undefined ? {} : { clientMessageId: string(value.clientMessageId, "params.clientMessageId", 128) }), retryOf };
}

function actorInputId(params) {
  const value = record(params, "params"); exact(value, new Set(["inputId"]), "params");
  return { inputId: string(value.inputId, "params.inputId", 128) };
}
function actorInputDelivery(params) {
  const value = record(params, "params"); exact(value, new Set(["inputId", "entryId", "deliveredAt"]), "params");
  const deliveredAt = string(value.deliveredAt, "params.deliveredAt", 64);
  if (!Number.isFinite(Date.parse(deliveredAt))) throw new ProtocolError("invalid_request", "params.deliveredAt must be an ISO timestamp");
  return { inputId: string(value.inputId, "params.inputId", 128), entryId: string(value.entryId, "params.entryId", 128), deliveredAt };
}
function extensionUiResponse(params) {
  const { value, sessionId } = sessionIdParam(params, ["uiRequestId", "value", "confirmed", "cancelled"]);
  const result = { sessionId, uiRequestId: string(value.uiRequestId, "params.uiRequestId", 128) };
  if (value.value !== undefined) {
    if (typeof value.value !== "string" || Buffer.byteLength(value.value, "utf8") > 32 * 1024) throw new ProtocolError("invalid_request", "params.value must be at most 32768 UTF-8 bytes");
    result.value = value.value;
  }
  if (value.confirmed !== undefined) result.confirmed = bool(value.confirmed, "params.confirmed");
  if (value.cancelled !== undefined) result.cancelled = bool(value.cancelled, "params.cancelled");
  if (result.value === undefined && result.confirmed === undefined && result.cancelled === undefined) throw new ProtocolError("invalid_request", "extension UI response requires value, confirmed, or cancelled");
  return result;
}
const INFERENCE_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
function thinkingLevel(value, path) { const level = string(value, path, 16); if (!INFERENCE_LEVELS.has(level)) throw new ProtocolError("invalid_request", `${path} is unsupported`); return level; }
function inferenceSelection(value, path) { const item = record(value, path); exact(item, new Set(["provider", "model", "thinkingLevel"]), path); return {
  provider: string(item.provider, `${path}.provider`, 128), model: string(item.model, `${path}.model`, 256), thinkingLevel: thinkingLevel(item.thinkingLevel, `${path}.thinkingLevel`) }; }
function setInference(params) { const { value, sessionId } = sessionIdParam(params, ["provider", "model", "thinkingLevel", "expected"]); return { sessionId,
  provider: string(value.provider, "params.provider", 128), model: string(value.model, "params.model", 256),
  thinkingLevel: thinkingLevel(value.thinkingLevel, "params.thinkingLevel"), expected: inferenceSelection(value.expected, "params.expected") }; }
function visibleMessages(params) {
  const { value, sessionId } = sessionIdParam(params, ["before", "limit"]);
  const before = value.before === undefined ? undefined : string(value.before, "params.before", 2048);
  if (before !== undefined && !/^[A-Za-z0-9_-]+$/.test(before)) throw new ProtocolError("invalid_request", "params.before is invalid");
  return { sessionId, ...(before !== undefined ? { before } : {}),
    ...(value.limit !== undefined ? { limit: integer(value.limit, "params.limit", 1, 100) } : {}) };
}
function sessionHistory(params) {
  const value = record(params, "params");
  const operation = string(value.operation, "params.operation", 16);
  if (!["list", "search", "open"].includes(operation)) throw new ProtocolError("invalid_request", "params.operation must be list, search, or open");
  const common = new Set(["operation", "sessionId", "kind", "includeDeleted", "includeCurrent"]);
  const allowed = operation === "list" ? new Set([...common, "limit"])
    : operation === "search" ? new Set([...common, "query", "roles", "limit", "sort", "snippetChars"])
      : new Set(["operation", "sessionId", "entryId", "includeDeleted", "includeCurrent", "before", "after", "maxChars"]);
  exact(value, allowed, "params");
  const includeDeleted = value.includeDeleted === undefined ? false : bool(value.includeDeleted, "params.includeDeleted");
  const includeCurrent = value.includeCurrent === undefined ? false : bool(value.includeCurrent, "params.includeCurrent");
  if (operation === "open") {
    return { operation, sessionId: string(value.sessionId, "params.sessionId", 128),
      entryId: string(value.entryId, "params.entryId", 128), includeDeleted, includeCurrent,
      before: value.before === undefined ? 2 : integer(value.before, "params.before", 0, 8),
      after: value.after === undefined ? 2 : integer(value.after, "params.after", 0, 8),
      maxChars: value.maxChars === undefined ? 8000 : integer(value.maxChars, "params.maxChars", 256, 16_000) };
  }
  const kind = value.kind ?? "any";
  if (!["any", "root", "child"].includes(kind)) throw new ProtocolError("invalid_request", "params.kind must be any, root, or child");
  const sessionId = value.sessionId === undefined ? null : string(value.sessionId, "params.sessionId", 128);
  const limit = value.limit === undefined ? (operation === "list" ? 20 : 8) : integer(value.limit, "params.limit", 1, 20);
  if (operation === "list") return { operation, sessionId, kind, includeDeleted, includeCurrent, limit };
  const roles = value.roles === undefined ? ["user", "assistant"]
    : array(value.roles, "params.roles", 2).map((role, index) => string(role, `params.roles[${index}]`, 16));
  if (roles.length === 0 || new Set(roles).size !== roles.length || roles.some((role) => !["user", "assistant"].includes(role))) {
    throw new ProtocolError("invalid_request", "params.roles must contain unique user and/or assistant roles");
  }
  const sort = value.sort ?? "relevance";
  if (!["relevance", "newest", "oldest"].includes(sort)) throw new ProtocolError("invalid_request", "params.sort must be relevance, newest, or oldest");
  const query = utf8(value.query, "params.query", 512);
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(query)) throw new ProtocolError("invalid_request", "params.query must not contain control characters");
  return { operation, query, sessionId, kind, includeDeleted, includeCurrent, roles, limit, sort,
    snippetChars: value.snippetChars === undefined ? 320 : integer(value.snippetChars, "params.snippetChars", 80, 800) };
}

function contextUsage(params) { const value = record(params, "params"); exact(value, new Set(["tokens", "contextWindow", "percent"]), "params");
  const contextWindow = integer(value.contextWindow, "params.contextWindow", 1, 10_000_000);
  const tokens = value.tokens === null ? null : integer(value.tokens, "params.tokens", 0, 10_000_000);
  const percent = value.percent === null ? null : finite(value.percent, "params.percent", 0, 10_000);
  if ((tokens === null) !== (percent === null)) throw new ProtocolError("invalid_request", "params.tokens and params.percent must both be known or null");
  return { tokens, contextWindow, percent };
}
function entries(params) { const { value, sessionId } = sessionIdParam(params, ["since"]); return { sessionId, since: value.since == null ? null : string(value.since, "params.since", 128) }; }
function provisionSkillRuntime(params) { const value = record(params, "params"); exact(value, new Set(["fingerprint"]), "params"); const fingerprint = string(value.fingerprint, "params.fingerprint", 64); if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new ProtocolError("invalid_request", "params.fingerprint must be a lowercase SHA-256 digest"); return { fingerprint }; }

function cronSchedule(value, path) {
  const item = record(value, path); const kind = string(item.kind, `${path}.kind`, 16);
  const timezone = item.timezone === undefined ? undefined : string(item.timezone, `${path}.timezone`, 128);
  if (kind === "at") { exact(item, new Set(["kind", "at", "timezone"]), path); return { kind, at: string(item.at, `${path}.at`, 128), ...(timezone ? { timezone } : {}) }; }
  if (kind === "every") { exact(item, new Set(["kind", "intervalSeconds", "timezone"]), path); return { kind,
    intervalSeconds: integer(item.intervalSeconds, `${path}.intervalSeconds`, 1, 366 * 24 * 60 * 60), ...(timezone ? { timezone } : {}) }; }
  if (kind === "cron") { exact(item, new Set(["kind", "expression", "timezone"]), path); return { kind,
    expression: string(item.expression, `${path}.expression`, 256), ...(timezone ? { timezone } : {}) }; }
  throw new ProtocolError("invalid_request", `${path}.kind must be at, every, or cron`);
}
function optionalProviderModel(value) {
  const providerPresent = Object.hasOwn(value, "provider");
  const modelPresent = Object.hasOwn(value, "model");
  if (providerPresent !== modelPresent) {
    throw new ProtocolError("invalid_request", "params.provider and params.model must be supplied together");
  }
  if (!providerPresent) return {};
  const provider = value.provider == null ? null : string(value.provider, "params.provider", 128);
  const model = value.model == null ? null : string(value.model, "params.model", 256);
  if ((provider === null) !== (model === null)) {
    throw new ProtocolError("invalid_request", "params.provider and params.model must be supplied together");
  }
  return { provider, model };
}
function optionalThinkingLevel(value) {
  if (!Object.hasOwn(value, "thinkingLevel")) return {};
  if (value.thinkingLevel == null) return { thinkingLevel: null };
  return { thinkingLevel: thinkingLevel(value.thinkingLevel, "params.thinkingLevel") };
}
function cronJob(params) {
  const value = record(params, "params"); const action = string(value.action, "params.action", 16);
  if (!["create", "list", "update", "pause", "resume", "run", "remove", "history"].includes(action)) {
    throw new ProtocolError("invalid_request", "params.action is unsupported");
  }
  if (action === "list") { exact(value, new Set(["action", "includeRemoved"]), "params"); return { action,
    includeRemoved: value.includeRemoved === undefined ? false : bool(value.includeRemoved, "params.includeRemoved") }; }
  if (action === "create") {
    exact(value, new Set(["action", "name", "prompt", "schedule", "executionMode", "repeat", "provider", "model", "thinkingLevel"]), "params");
    const executionMode = value.executionMode ?? "fresh";
    if (!["fresh", "origin"].includes(executionMode)) throw new ProtocolError("invalid_request", "params.executionMode must be fresh or origin");
    return { action, name: utf8(value.name, "params.name", 128), prompt: utf8(value.prompt, "params.prompt", MAX_USER_INPUT_BYTES),
      schedule: cronSchedule(value.schedule, "params.schedule"), executionMode,
      repeat: value.repeat == null ? null : integer(value.repeat, "params.repeat", 1, 1_000_000),
      ...optionalProviderModel(value), ...optionalThinkingLevel(value) };
  }
  const selector = string(value.selector, "params.selector", 256);
  if (action === "update") {
    exact(value, new Set(["action", "selector", "name", "prompt", "schedule", "executionMode", "repeat", "provider", "model", "thinkingLevel"]), "params");
    const executionMode = value.executionMode;
    if (executionMode !== undefined && !["fresh", "origin"].includes(executionMode)) throw new ProtocolError("invalid_request", "params.executionMode must be fresh or origin");
    const pin = optionalProviderModel(value);
    const thinking = optionalThinkingLevel(value);
    if ([value.name, value.prompt, value.schedule, value.executionMode, value.repeat, pin.provider, thinking.thinkingLevel].every((item) => item === undefined)) {
      throw new ProtocolError("invalid_request", "cron update requires at least one changed field");
    }
    return { action, selector,
      ...(value.name === undefined ? {} : { name: utf8(value.name, "params.name", 128) }),
      ...(value.prompt === undefined ? {} : { prompt: utf8(value.prompt, "params.prompt", MAX_USER_INPUT_BYTES) }),
      ...(value.schedule === undefined ? {} : { schedule: cronSchedule(value.schedule, "params.schedule") }),
      ...(executionMode === undefined ? {} : { executionMode }),
      ...(value.repeat === undefined ? {} : { repeat: value.repeat === null ? null : integer(value.repeat, "params.repeat", 1, 1_000_000) }),
      ...pin, ...thinking };
  }
  if (action === "history") { exact(value, new Set(["action", "selector", "limit"]), "params"); return { action, selector,
    limit: value.limit === undefined ? 20 : integer(value.limit, "params.limit", 1, 50) }; }
  exact(value, new Set(["action", "selector"]), "params"); return { action, selector };
}

const validators = new Map([
  ["register_actor", actorRegistration], ["register_client", clientRegistration],
  ["set_session_name", (p) => { const value = record(p, "params"); exact(value, new Set(["name"]), "params"); return { name: value.name == null ? null : string(value.name, "params.name", 256) }; }],
  ["update_activity", (p) => { const value = record(p, "params"); exact(value, new Set(["streaming"]), "params"); return { streaming: bool(value.streaming, "params.streaming") }; }],
  ["update_progress_heading", progressHeading], ["record_progress_entry", progressEntry], ["record_agent_message_entry", agentMessageEntry], ["record_child_creation_entry", childCreationEntry],
  ["set_skill_manifest", (p) => { const value = record(p, "params"); exact(value, new Set(["skills"]), "params"); return { skills: array(value.skills, "params.skills", 128).map((item, index) => skill(item, `params.skills[${index}]`)) }; }],
  ["record_usage", usage], ["record_context_usage", contextUsage], ["get_usage", usageWindow], ["send_message", sendMessage], ["session_history", sessionHistory], ["cron_job", cronJob],
  ["get_actor_input", actorInputId], ["accept_actor_input", actorInputId], ["record_input_delivery", actorInputDelivery], ["flush_actor_inputs", empty],
  ["ack_message", (p) => { const value = record(p, "params"); exact(value, new Set(["messageId"]), "params"); return { messageId: string(value.messageId, "params.messageId", 128) }; }],
  ["spawn_child", spawnChild], ["stop_child", childSelector], ["revive_child", childSelector], ["delete_child", childSelector],
  ["create_root", createRoot], ["rename_session", renameSession], ["subscribe_session", subscribe], ["subscribe_root_output", subscribeRootOutput], ["unsubscribe_root_output", empty],
  ["unsubscribe_session", (p) => sessionIdParam(p)], ["submit_input", submit], ["respond_extension_ui", extensionUiResponse],
  ["get_session_inference", (p) => ({ sessionId: sessionIdParam(p).sessionId })], ["set_session_inference", setInference],
  ["get_actor_state", (p) => sessionIdParam(p)], ["get_actor_entries", entries], ["get_visible_messages", visibleMessages], ["get_visible_image", visibleImage], ["compact_session", (p) => sessionIdParam(p)], ["restart_kernel", (p) => sessionIdParam(p)], ["abort_session", (p) => sessionIdParam(p)],
  ["get_skill_runtime_plan", empty], ["provision_skill_runtime", provisionSkillRuntime],
  ["stop_session", (p) => sessionIdParam(p)], ["revive_session", (p) => sessionIdParam(p)], ["delete_session", (p) => sessionIdParam(p)],
]);

export function validateRequest(frame) {
  const value = record(frame, "frame"); exact(value, new Set(["version", "id", "type", "params"]), "frame");
  if (value.version !== PROTOCOL_VERSION) throw new ProtocolError("unsupported_version", `protocol version ${String(value.version)} is unsupported`);
  const id = string(value.id, "frame.id", MAX_ID_LENGTH); const type = string(value.type, "frame.type", 64);
  if (!requestTypes.has(type)) throw new ProtocolError("unknown_request", `unknown request type: ${type}`);
  return { version: PROTOCOL_VERSION, id, type, params: (validators.get(type) ?? empty)(value.params) };
}
export function validateServerFrame(frame) {
  const value = record(frame, "frame");
  if (value.version !== PROTOCOL_VERSION) throw new ProtocolError("unsupported_version", `protocol version ${String(value.version)} is unsupported`);
  if (value.type === "response") { string(value.id, "frame.id", MAX_ID_LENGTH); string(value.requestType, "frame.requestType", 64); if (typeof value.ok !== "boolean") throw new ProtocolError("invalid_response", "frame.ok must be boolean"); if (!value.ok && (typeof value.error !== "string" || !value.error)) throw new ProtocolError("invalid_response", "failed responses require an error"); return value; }
  if (value.type === "event") { string(value.event, "frame.event", 64); return value; }
  if (value.type === "protocol_error") { string(value.code, "frame.code", 64); string(value.message, "frame.message", 1024); return value; }
  throw new ProtocolError("invalid_response", `unknown server frame type: ${String(value.type)}`);
}
export function response(id, requestType, data) { return { version: PROTOCOL_VERSION, type: "response", id, requestType, ok: true, data }; }
export function errorResponse(id, requestType, error, code = "request_failed") { return { version: PROTOCOL_VERSION, type: "response", id, requestType, ok: false, code, error: error instanceof Error ? error.message : String(error) }; }
export function protocolErrorFrame(error) { return { version: PROTOCOL_VERSION, type: "protocol_error", code: error instanceof ProtocolError ? error.code : "malformed_frame", message: error instanceof Error ? error.message : String(error) }; }
export function event(eventName, data = {}) { return { version: PROTOCOL_VERSION, type: "event", event: eventName, data }; }
