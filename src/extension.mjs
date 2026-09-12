import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessClient } from "./client.mjs";
import { ACTOR_INPUT_COMMAND, ACTOR_INPUT_MESSAGE_TYPE, actorInputCustomPayload } from "./protocol.mjs";
export { actorInputCustomPayload } from "./protocol.mjs";
import { AGENT_MESSAGE_ENTRY_TYPE, CHILD_CREATION_ENTRY_TYPE, INCOMING_AGENT_MESSAGE_TYPE } from "./agent-message-projection.mjs";
import { assembleActorSystemPrompt, loadDepthPrompt } from "./depth-prompt.mjs";
import { formatPrefixPrompt, loadPromptPrefix } from "./prompt-prefix.mjs";
import { createHostHandlers } from "./host-handlers.mjs";
import { PythonKernel } from "./kernel.mjs";
import { PythonRuntimeManager } from "./python-runtime.mjs";
import { PROGRESS_ENTRY_TYPE, ProgressHeadingTracker } from "./progress-projection.mjs";
import { discoverSkills, manifestForSkills, writeManifestAtomic } from "./skills.mjs";
import { sessionSidecarPaths } from "./session-paths.mjs";
import { applyRetryBranch, KERNEL_RELOAD_COMMAND } from "./session-actions.mjs";
import { inputIdForEntry, resolveActorInputAssociation } from "./conversation-projection.mjs";
import { projectAssistantUsageEntry, projectContextUsage } from "./session-telemetry.mjs";
import { sanitizeGrokCliProviderPayload } from "./grok-cli-payload.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE_SKILLS_PATH = path.resolve(process.env.PI_HARNESS_SKILLS_PATH || path.join(PACKAGE_ROOT, "skills"));
const PYTHON_RUNTIME_SUPPORT = path.join(PACKAGE_ROOT, "python-runtime");
const KERNEL_SCRIPT = path.join(PYTHON_RUNTIME_SUPPORT, "kernel.py");
const INCOMING_MESSAGE_TYPE = INCOMING_AGENT_MESSAGE_TYPE;
const USAGE_ENTRY_TYPE = "persistent-harness-usage";
const STATUS_KEY = "persistent-harness";
const ACTOR_ID = process.env.PI_HARNESS_ACTOR_ID || null;
const ACTOR_TOKEN = process.env.PI_HARNESS_ACTOR_TOKEN || null;
const ACTOR_GENERATION = process.env.PI_HARNESS_ACTOR_GENERATION
  ? Number(process.env.PI_HARNESS_ACTOR_GENERATION)
  : null;
const ACTOR_SKILL_GRANT_PATH = process.env.PI_HARNESS_ACTOR_SKILL_GRANT || null;

let actorGrantPromise;
async function actorSkillGrant() {
  if (!ACTOR_SKILL_GRANT_PATH) return null;
  actorGrantPromise ??= readFile(ACTOR_SKILL_GRANT_PATH, "utf8").then((content) => {
    const grant = JSON.parse(content);
    if (grant?.version !== 1 || !Array.isArray(grant.skills) || !Array.isArray(grant.capabilities)) {
      throw new Error("invalid actor skill grant");
    }
    return grant;
  });
  return actorGrantPromise;
}

function applyActorSkillGrant(skills, grant) {
  if (!grant) return skills;
  const discovered = new Map(skills.map((skill) => [skill.id, skill]));
  const capabilityIds = new Set(grant.capabilities.map((item) => item.id));
  const selected = grant.skills.map((expected) => {
    const skill = discovered.get(expected.id);
    if (!skill) throw new Error(`granted actor skill was not discovered: ${expected.id}`);
    if (skill.version !== expected.version || skill.contentHash !== expected.contentHash
      || path.resolve(skill.skillPath) !== path.resolve(expected.skillPath)) {
      throw new Error(`granted actor skill changed after admission: ${expected.id}`);
    }
    if (Boolean(skill.python) !== expected.pythonBacked) throw new Error(`granted actor skill backing changed: ${expected.id}`);
    if (skill.python && !capabilityIds.has(skill.id)) throw new Error(`Python skill exceeds actor capability manifest: ${skill.id}`);
    return skill;
  });
  for (const capability of grant.capabilities) {
    const expected = grant.skills.find((skill) => skill.id === capability.id);
    if (!expected?.pythonBacked || expected.version !== capability.version || expected.contentHash !== capability.contentHash) {
      throw new Error(`invalid executable actor capability: ${capability.id}`);
    }
  }
  return selected;
}

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function defaultSocketPath() {
  return path.join(agentDir(), "harness", "supervisor.sock");
}

function deliveredMessageIds(entries) {
  return new Set(entries
    .filter((entry) => entry?.type === "custom_message"
      && entry.customType === INCOMING_MESSAGE_TYPE
      && typeof entry.details?.messageId === "string")
    .map((entry) => entry.details.messageId));
}

function agentMessageEntries(entries, direction) {
  const result = new Map();
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== AGENT_MESSAGE_ENTRY_TYPE
      || entry.data?.direction !== direction || typeof entry.data?.messageId !== "string") continue;
    if (result.has(entry.data.messageId)) throw new Error(`duplicate ${direction === "to" ? "outgoing" : "incoming"} agent message entry: ${entry.data.messageId}`);
    result.set(entry.data.messageId, entry);
  }
  return result;
}
function outgoingAgentMessageEntries(entries) { return agentMessageEntries(entries, "to"); }
function incomingAgentMessageEntries(entries) { return agentMessageEntries(entries, "from"); }
function childCreationEntries(entries) {
  const result = new Map();
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry.customType !== CHILD_CREATION_ENTRY_TYPE
      || typeof entry.data?.childId !== "string") continue;
    if (result.has(entry.data.childId)) throw new Error(`duplicate child creation entry: ${entry.data.childId}`);
    result.set(entry.data.childId, entry);
  }
  return result;
}

function recordedUsageEntryIds(entries) {
  return new Set(entries
    .filter((entry) => entry?.type === "custom" && entry.customType === USAGE_ENTRY_TYPE
      && typeof entry.data?.entryId === "string")
    .map((entry) => entry.data.entryId));
}

function usageFromMessageEntry(entry) { return projectAssistantUsageEntry(entry); }

function contextUsageFromExtension(value) {
  const projected = projectContextUsage(value);
  if (projected.contextWindow === null) return undefined;
  return { tokens: projected.tokens, contextWindow: projected.contextWindow, percent: projected.percent };
}

function sessionEntryIdentity(entry) {
  if (typeof entry?.id === "string" && entry.id) return `id:${entry.id}`;
  return [entry?.type, entry?.timestamp, entry?.customType, entry?.data?.entryId, entry?.details?.messageId]
    .map((value) => String(value ?? "")).join("\0");
}

function appendedSessionEntries(entries, cursor = { index: 0, anchor: null }) {
  const source = Array.isArray(entries) ? entries : [];
  let start = cursor.index;
  if (!Number.isInteger(start) || start < 0 || start > source.length
    || (start > 0 && sessionEntryIdentity(source[start - 1]) !== cursor.anchor)) start = 0;
  return {
    entries: source.slice(start),
    cursor: { index: source.length, anchor: source.length ? sessionEntryIdentity(source.at(-1)) : null },
  };
}

async function canonicalLocation(pi, cwd) {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {}

  let repositoryRoot = null;
  try {
    const result = await pi.exec("git", ["-C", canonicalCwd, "rev-parse", "--show-toplevel"], { timeout: 1500 });
    if (result.code === 0 && result.stdout.trim()) repositoryRoot = await realpath(result.stdout.trim());
  } catch {}
  return { cwd: canonicalCwd, repositoryRoot };
}

function truncatePlain(text, width) {
  if (width <= 0) return "";
  return text.length <= width ? text : width === 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function linesComponent(lines, color = (text) => text) {
  return {
    render(width) {
      return lines.map((line) => color(truncatePlain(String(line), width)));
    },
    invalidate() {},
  };
}

function pythonOutputContent(result) {
  const outputs = Array.isArray(result.outputs) ? result.outputs : [
    ...[result.stdout, result.stderr].filter(Boolean).map((text) => ({ text: text.trimEnd() })),
    ...(result.mime ? [{ mime: result.mime }] : []),
  ];
  const content = [];
  for (const output of outputs) {
    if (typeof output.text === "string" && output.text) content.push({ type: "text", text: output.text });
    const mime = output.mime ?? {};
    const text = [mime["text/plain"], mime["text/x-diff"]].filter(Boolean).map(String).join("\n");
    if (text) content.push({ type: "text", text });
    for (const [mimeType, data] of Object.entries(mime)) {
      if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType) && typeof data === "string") {
        content.push({ type: "image", data, mimeType });
      }
    }
  }
  if (result.error) content.push({ type: "text", text: `${result.errorType ?? "Error"}: ${result.error}` });
  if (!content.length) content.push({ type: "text", text: result.ok ? "Execution completed." : "Execution failed." });
  return content;
}

function pythonResultText(result) {
  return pythonOutputContent(result).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function pythonToolResult(result) {
  let details = result;
  if (Array.isArray(result.outputs)) {
    // Canonical outputs already contain this derived MIME summary.
    details = { ...result };
    delete details.mime;
  }
  const content = pythonOutputContent(result);
  if (result.namespaceCheckpointState === "pending") {
    content.push({ type: "text", text: "Python execution has ended; its namespace save is pending." });
  }
  return { content, details };
}

function skillPrompt(skills, nativeAsync = false) {
  const rows = skills.map((skill) => {
    const calls = skill.python
      ? skill.python.entryPoint
        ? `${skill.alias}(...) or ${skill.alias}.operation(...)`
        : `${skill.alias}.operation(...)`
      : "guidance-only";
    return `- ${skill.alias}? — ${skill.description} [${calls}]`;
  });
  return [
    "# Persistent Python skill interface",
    "`ipython` is the only execution tool. Ordinary Pi tools are unavailable.",
    "Every skill is one Python object. Use `<skill>?` to display its complete SKILL.md.",
    "If a skill has Python backing, call `<skill>(...)` when it defines an entry point or `<skill>.operation(...)`.",
    "Calling a guidance-only skill raises a clear error; read its instructions with `?` and follow them using Python or backed skills.",
    ...(nativeAsync ? [
      "Python calls can run while you continue thinking. Their results become visible on a subsequent model request.",
      "Continue independent work while Python runs. When your next step depends on a Python result, call wait_for_ipython as the last tool call of the current response.",
      "The wait is a handoff, not task completion. When it returns, read the original Python results and continue from them.",
      "Do not repeat a call just because its result is not visible yet. Pending results alone do not mean the tool channel has failed.",
      "Claim an action was dispatched or succeeded only after reading the corresponding call result; reading instructions does not dispatch an action.",
      "Python results arrive before namespace saving finishes. The next cell waits for the save in the existing Python queue. A pending save is not proof of recoverable state; a save failure arrives as a separate diagnostic. Never replay external side effects to repair a save failure.",
    ] : []),
    "Available skill aliases:",
    ...rows,
  ].join("\n");
}

export function nativeAsyncEnabled(model, enabled = process.env.PI_HARNESS_NATIVE_ASYNC) {
  return enabled === "1" && model?.provider === "openai-codex"
    && model?.id === "gpt-6-astra" && model?.api === "openai-codex-responses"
    && model?.compat?.supportsAsyncTools === true;
}

export function hasNativeNamespaceHistory(entries) {
  return entries.some((entry) => entry.type === "message" && (
    (entry.message?.role === "assistant" && entry.message.content?.some((part) =>
      part.type === "toolCall" && part.name === "ipython" && part.async === true))
    || (entry.message?.role === "toolResult" && entry.message.toolName === "ipython"
      && (entry.message.details?.namespaceCheckpoint || entry.message.details?.namespaceCheckpointAttempt
        || entry.message.details?.nativeAsyncRecovery))
  ));
}

export function projectNamespaceRecovery(entries, restore) {
  const results = entries.filter((entry) => entry.type === "message"
    && entry.message?.role === "toolResult" && entry.message.toolName === "ipython").map((entry) => entry.message);
  const expectedResult = results.findLast((result) => result.details?.namespaceCheckpoint
    || result.details?.namespaceCheckpointState === "pending");
  const expectedCheckpoint = expectedResult?.details.namespaceCheckpoint ?? expectedResult?.details.namespaceCheckpointAttempt ?? null;
  const restoredCheckpoint = restore?.namespaceCheckpoint ?? null;
  const keys = ["version", "sessionId", "toolCallId", "actorGeneration", "executionId"];
  const identityMatches = Boolean(expectedCheckpoint && restoredCheckpoint
    && keys.every((key) => expectedCheckpoint[key] === restoredCheckpoint[key]));
  return {
    expectedCheckpoint, restoredCheckpoint,
    identityMatches,
    snapshotFound: restore?.found === true,
    restorationError: restore?.error ?? null,
    skippedValues: restore?.skipped ?? [],
    interruptedOrUncheckpointed: results.filter((result) => result.details?.nativeAsyncRecovery === "interrupted-unknown"
      || (result.details?.executionId && result.details.ok === false && !result.details.namespaceCheckpoint
        && result.details.namespaceCheckpointState !== "pending")
      || (result === expectedResult && result.details?.namespaceCheckpointState === "pending" && !identityMatches))
      .map((result) => ({ toolCallId: result.toolCallId,
        state: result.details.nativeAsyncRecovery ?? "execution-ended-without-checkpoint",
        executionOk: result.details.executionOk ?? (result.details.namespaceCheckpointState === "pending" ? result.details.ok : null) })),
  };
}

export function namespaceRecoveryText(report) {
  if (!report) return "";
  return [
    "# Python namespace recovery diagnostic",
    `Expected canonical checkpoint: ${JSON.stringify(report.expectedCheckpoint)}`,
    `Restored checkpoint: ${JSON.stringify(report.restoredCheckpoint)}`,
    `Checkpoint identities match: ${report.identityMatches}. Snapshot found: ${report.snapshotFound}.`,
    `Restoration error: ${JSON.stringify(report.restorationError)}`,
    `Skipped values: ${JSON.stringify(report.skippedValues)}`,
    `Interrupted/unknown or uncheckpointed original calls: ${JSON.stringify(report.interruptedOrUncheckpointed)}`,
    "This describes this kernel's initial restoration, not exact current namespace state or a replacement tool result.",
    "Matching identities do not prove exact restoration. Later verified mutations may supersede this report.",
    "Verify or reconstruct needed Python state before dependent work. Do not repeat unknown external side effects or replay interrupted cells automatically.",
  ].join("\n");
}

export function incomingSendOptions(deliverAs, turnActive = false) {
  if (deliverAs === "follow_up") return { triggerTurn: true, deliverAs: "followUp" };
  if (turnActive) return { triggerTurn: true, deliverAs: "steer" };
  return { triggerTurn: true };
}

export function incomingCustomPayload(message) {
  const source = `${message.senderName ?? "agent"} ${message.senderShortId ?? "unknown"} [d${message.senderDepth ?? "?"}]`;
  return {
    customType: INCOMING_MESSAGE_TYPE,
    content: `Direct agent message from ${source}:\n${message.body}`,
    display: true,
    details: {
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      senderShortId: message.senderShortId,
      senderDepth: message.senderDepth,
      relationship: message.relationship,
      deliveryMode: message.deliveryMode,
      body: message.body,
    },
  };
}

export async function deliverIncomingFamilyMessage({ persist, inject, onPersistError }, message, options) {
  try {
    await persist(message);
  } catch (error) {
    onPersistError?.(error);
  }
  inject(message, options);
}


export function createActorInputDelivery({ pi, getClient, getContext }) {
  const enqueued = new Set();
  const pendingReports = new Set();
  let cursor = { index: 0, anchor: null };
  function validateInput(inputId, input) {
    if (input && (input.inputId !== inputId || input.sessionId !== getContext()?.sessionManager.getSessionId())) {
      throw new Error("input is not reserved for this actor");
    }
  }
  async function report(inputId, input, association, entries) {
    const client = getClient(); if (!client?.isConnected) return false;
    if (!input) return true;
    validateInput(inputId, input);
    if (input.deliveredAt !== null && input.deliveredAt !== undefined) { enqueued.delete(inputId); return true; }
    if (association.state === "unresolved") return false;
    if (association.state === "absent") {
      if (entries.some((entry) => entry.type === "custom_message")) throw new Error("input entry provenance conflicts with its receipt");
      return true;
    }
    await client.request("record_input_delivery", { inputId, entryId: association.entryId, deliveredAt: association.deliveredAt });
    enqueued.delete(inputId); return true;
  }
  async function flush() {
    const scanned = appendedSessionEntries(getContext()?.sessionManager?.getEntries(), cursor);
    cursor = scanned.cursor;
    for (const entry of scanned.entries) {
      const inputId = inputIdForEntry(entry);
      if (typeof inputId === "string" && inputId && inputId.length <= 128) pendingReports.add(inputId);
    }
    const receipts = new Map();
    for (const inputId of pendingReports) {
      const client = getClient(); if (!client?.isConnected) return;
      const { input } = await client.request("get_actor_input", { inputId });
      validateInput(inputId, input); receipts.set(inputId, input);
    }
    // Capture complete historical evidence after receipt awaits, then resolve once per input.
    const groups = new Map();
    for (const entry of getContext()?.sessionManager?.getEntries() ?? []) {
      const inputId = inputIdForEntry(entry); if (!receipts.has(inputId)) continue;
      const entries = groups.get(inputId) ?? []; entries.push(entry); groups.set(inputId, entries);
    }
    for (const [inputId, input] of receipts) {
      const entries = groups.get(inputId) ?? [];
      const association = resolveActorInputAssociation(entries, { sessionId: input?.sessionId, inputReceipt: input });
      if (await report(inputId, input, association, entries)) pendingReports.delete(inputId);
    }
  }
  async function deliver(args, ctx) {
    const inputId = decodeURIComponent(args);
    if (!inputId || inputId.length > 128 || encodeURIComponent(inputId) !== args) throw new Error("invalid durable input selector");
    const client = getClient(); if (!client?.isConnected) throw new Error("harness is offline");
    const { input } = await client.request("get_actor_input", { inputId });
    if (!input || input.inputId !== inputId || input.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("input is not reserved for this actor");
    if (!["cron", "background"].includes(input.source)) throw new Error("custom input requires a verified internal source");
    if (input.state === "completed") { enqueued.delete(inputId); return; }
    const payload = actorInputCustomPayload(input);
    const entries = (ctx.sessionManager.getEntries() ?? []).filter((entry) => inputIdForEntry(entry) === inputId);
    const association = resolveActorInputAssociation(entries, { sessionId: input.sessionId, inputReceipt: input });
    if (association.state === "unresolved") { pendingReports.add(inputId); return; }
    if (association.state === "proven") {
      const existing = entries.find((entry) => entry.id === association.entryId);
      if (association.proof.kind === "custom" && (!isDeepStrictEqual(existing.details, payload.details)
        || !isDeepStrictEqual(existing.content, payload.content))) throw new Error("canonical input conflicts with its durable reservation");
      await report(inputId, input, association, entries); return;
    }
    if (entries.some((entry) => entry.type === "custom_message")) throw new Error("canonical input conflicts with its durable reservation");
    if (!enqueued.has(inputId)) {
      // Pi sends internal inputs through its existing steering/follow-up queues.
      pi.sendMessage(payload, { triggerTurn: true, deliverAs: input.behavior === "follow_up" ? "followUp" : "steer" });
      enqueued.add(inputId);
    }
    await client.request("accept_actor_input", { inputId });
  }
  return {
    handle: deliver,
    flush,
    reset() { enqueued.clear(); pendingReports.clear(); cursor = { index: 0, anchor: null }; },
  };
}

export default function persistentHarnessExtension(pi, owner = null) {
  if (owner) pi.events.on("persistent-harness:project-canonical-context:v1", (request) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) return;
    try {
      delete request.result; delete request.error;
      request.result = owner.projectContext(request);
    } catch { request.error = { code: "canonical_context_unavailable" }; }
  });
  if (!ACTOR_ID || !ACTOR_TOKEN || !Number.isInteger(ACTOR_GENERATION)) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "harness client only");
      ctx.ui.notify("Persistent Harness sessions are supervisor-hosted. Use persistent-pi to create or attach to one.", "info");
    });
    return;
  }
  let client;
  let activeContext;
  let actorDepth;
  const actorInputs = createActorInputDelivery({ pi, getClient: () => client, getContext: () => activeContext });
  let knownDeliveredIds = new Set();
  let persistedDeliveredIds = new Set();
  let knownUsageEntryIds = new Set();
  let pendingUsageEntries = new Map();
  let settlementEntryCursor = { index: 0, anchor: null };
  let pendingAcknowledgements = new Set();
  let deliveryChain = Promise.resolve();
  let outgoingHistoryTail = Promise.resolve();
  let kernel;
  let kernelPromise;
  let kernelRestartPromise;
  let currentManifest;
  let lastRestoreReport;
  let namespaceRecovery;
  const progressTracker = new ProgressHeadingTracker();
  let progressTurnId = null;
  let forwardedProgress;
  let pendingProgressHeading = null;
  let progressHeadingFlushActive = false;
  let progressTail = Promise.resolve();
  const runtimeManager = new PythonRuntimeManager({ runtimeDir: path.join(agentDir(), "harness", "kernel-runtime") });

  function queueActorRequest(type, params) {
    progressTail = progressTail.then(async () => {
      if (client?.isConnected) await client.request(type, params);
    }).catch(() => {});
    return progressTail;
  }

  function agentMessageRequest(entry, data) {
    return { entryId: entry.id, ...data,
      createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString() };
  }

  async function ensureOutgoingAgentMessage(message) {
    const sessionManager = activeContext?.sessionManager;
    if (!sessionManager || sessionManager.getSessionId() !== ACTOR_ID || !client?.isConnected) {
      throw new Error("actor session context is unavailable for agent message history");
    }
    const expected = { messageId: message.messageId, direction: "to", peerId: message.targetId,
      peerName: message.targetName ?? message.targetShortId, relationship: message.relationship, body: message.body };
    let entry = outgoingAgentMessageEntries(sessionManager.getEntries()).get(message.messageId);
    if (entry) {
      for (const key of ["messageId", "direction", "peerId", "relationship", "body"]) {
        if (entry.data?.[key] !== expected[key]) throw new Error("outgoing agent message entry conflicts with its durable reservation");
      }
    } else {
      const entryId = sessionManager.appendCustomEntry(AGENT_MESSAGE_ENTRY_TYPE, expected);
      entry = sessionManager.getEntry(entryId);
    }
    await client.request("record_agent_message_entry", agentMessageRequest(entry, entry.data));
  }

  function persistOutgoingAgentMessage(message) {
    const operation = outgoingHistoryTail.then(() => ensureOutgoingAgentMessage(message));
    outgoingHistoryTail = operation.catch(() => {});
    return operation;
  }

  function repairOutgoingAgentMessage(message) { return persistOutgoingAgentMessage(message); }

  async function ensureIncomingAgentMessage(message) {
    const sessionManager = activeContext?.sessionManager;
    if (!sessionManager || sessionManager.getSessionId() !== ACTOR_ID || !client?.isConnected) {
      throw new Error("actor session context is unavailable for incoming agent message history");
    }
    const expected = { messageId: message.messageId, direction: "from", peerId: message.senderId,
      peerName: message.senderName ?? message.senderShortId, relationship: message.relationship, body: message.body };
    let entry = incomingAgentMessageEntries(sessionManager.getEntries()).get(message.messageId);
    if (entry) {
      for (const key of ["messageId", "direction", "peerId", "relationship", "body"]) {
        if (entry.data?.[key] !== expected[key]) throw new Error("incoming agent message entry conflicts with its durable reservation");
      }
    } else {
      const entryId = sessionManager.appendCustomEntry(AGENT_MESSAGE_ENTRY_TYPE, expected);
      entry = sessionManager.getEntry(entryId);
    }
    await client.request("record_agent_message_entry", agentMessageRequest(entry, entry.data));
  }

  function persistIncomingAgentMessage(message) {
    const operation = outgoingHistoryTail.then(() => ensureIncomingAgentMessage(message));
    outgoingHistoryTail = operation.catch(() => {});
    return operation;
  }

  function childCreationRequest(entry, data) {
    return { entryId: entry.id, ...data,
      createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString() };
  }

  async function ensureChildCreation(message) {
    const sessionManager = activeContext?.sessionManager;
    if (!sessionManager || sessionManager.getSessionId() !== ACTOR_ID || !client?.isConnected) {
      throw new Error("actor session context is unavailable for child creation history");
    }
    const expected = { taskId: message.taskId, childId: message.childId, childName: message.childName,
      relationship: "child", body: message.body };
    let entry = childCreationEntries(sessionManager.getEntries()).get(message.childId);
    if (entry) {
      for (const key of ["taskId", "childId", "childName", "relationship", "body"]) {
        if (entry.data?.[key] !== expected[key]) throw new Error("child creation entry conflicts with its durable task");
      }
    } else {
      const entryId = sessionManager.appendCustomEntry(CHILD_CREATION_ENTRY_TYPE, expected);
      entry = sessionManager.getEntry(entryId);
    }
    await client.request("record_child_creation_entry", childCreationRequest(entry, entry.data));
  }

  function persistChildCreation(message) {
    const operation = outgoingHistoryTail.then(() => ensureChildCreation(message));
    outgoingHistoryTail = operation.catch(() => {});
    return operation;
  }

  async function persistProgressHeading(summary) {
    const sessionManager = activeContext?.sessionManager;
    if (!sessionManager || sessionManager.getSessionId() !== ACTOR_ID) {
      throw new Error("actor session context is unavailable for progress history");
    }
    const entryId = sessionManager.appendCustomEntry(PROGRESS_ENTRY_TYPE, { summary });
    const entry = sessionManager.getEntry(entryId);
    await queueActorRequest("record_progress_entry", {
      entryId,
      summary,
      createdAt: typeof entry?.timestamp === "string" ? entry.timestamp : new Date().toISOString(),
    });
  }

  function queueProgressHeading(turnId, summary) {
    pendingProgressHeading = { turnId, summary };
    if (progressHeadingFlushActive) return;
    progressHeadingFlushActive = true;
    const flush = async () => {
      const pending = pendingProgressHeading;
      pendingProgressHeading = null;
      if (pending && client?.isConnected) await client.request("update_progress_heading", { phase: "heading", ...pending });
    };
    progressTail = progressTail.then(flush).catch(() => {}).finally(() => {
      progressHeadingFlushActive = false;
      if (pendingProgressHeading) queueProgressHeading(pendingProgressHeading.turnId, pendingProgressHeading.summary);
    });
  }

  function restoreTransientProgress() {
    if (!progressTurnId) return;
    queueActorRequest("update_progress_heading", { phase: "start", turnId: progressTurnId });
    if (forwardedProgress) queueActorRequest("update_progress_heading", { phase: "heading", turnId: progressTurnId, summary: forwardedProgress });
  }

  function enforceHarnessTools(model) {
    const expected = nativeAsyncEnabled(model) ? ["ipython", "wait_for_ipython"] : ["ipython"];
    pi.setActiveTools(expected);
    const active = pi.getActiveTools();
    if (active.length !== expected.length || expected.some((name) => !active.includes(name))) {
      throw new Error("Persistent Harness requires only its Python execution and synchronization tools");
    }
  }

  async function resolveSkillManifest(_ctx) {
    const grant = await actorSkillGrant();
    const catalog = await discoverSkills(pi.getCommands());
    if (catalog.diagnostics.length) {
      throw new Error(`Invalid skill package:
${catalog.diagnostics.map((item) => item.error).join("\n")}`);
    }
    return manifestForSkills(applyActorSkillGrant(catalog.skills, grant));
  }

  async function persistSessionMetadata(ctx, manifest) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("persistent harness actor requires a canonical Pi session file");
    const sidecars = sessionSidecarPaths(sessionFile);
    const capabilities = manifest.skills.filter((skill) => skill.python).map((skill) => ({
      id: skill.id,
      version: skill.version,
      contentHash: skill.contentHash,
      hostRequests: skill.python.hostRequests,
    }));
    await Promise.all([
      writeManifestAtomic(sidecars.skillManifestPath, manifest),
      writeManifestAtomic(sidecars.capabilitiesPath, { version: 1, capabilities }),
    ]);
    return sidecars;
  }

  function scheduleKernelRestart() {
    if (kernelRestartPromise) return kernelRestartPromise;
    const restarting = kernel;
    kernelRestartPromise = new Promise((resolve) => setImmediate(resolve))
      .then(async () => {
        if (kernel === restarting) kernel = undefined;
        await restarting?.close();
      })
      .finally(() => { kernelRestartPromise = undefined; });
    return kernelRestartPromise;
  }

  async function ensureKernel(ctx) {
    if (kernelRestartPromise) await kernelRestartPromise;
    if (kernel && !kernel.isRunning) {
      const exited = kernel;
      kernel = undefined;
      await exited.close({ snapshot: false }).catch(() => {});
    }
    if (kernel) return kernel;
    if (kernelPromise) return kernelPromise;
    kernelPromise = (async () => {
      const manifest = currentManifest ?? await resolveSkillManifest(ctx);
      currentManifest = manifest;
      const sidecars = await persistSessionMetadata(ctx, manifest);
      const stateDir = sidecars.kernelStatePath;
      const runtime = await runtimeManager.ensure({
        skills: manifest.skills,
        consent: async ({ pythonVersion, packages }) => {
          if (!ctx.hasUI) return false;
          return ctx.ui.confirm(
            "Install managed Python runtime?",
            `Persistent Harness needs CPython ${pythonVersion} and:\n${packages.join("\n")}`,
            { timeout: 60_000 },
          );
        },
        onProgress: (message) => {
          if (message) ctx.ui.setStatus(STATUS_KEY, `python: ${truncatePlain(message, 60)}`);
        },
      });
      const created = new PythonKernel({
        pythonPath: runtime.pythonPath,
        kernelScript: KERNEL_SCRIPT,
        runtimeSupportDir: PYTHON_RUNTIME_SUPPORT,
        cwd: ctx.cwd,
        stateDir,
        manifest,
        shutdownTimeoutMs: Number(process.env.PI_HARNESS_KERNEL_SHUTDOWN_TIMEOUT_MS ?? 1500),
        killTimeoutMs: Number(process.env.PI_HARNESS_KERNEL_KILL_TIMEOUT_MS ?? 1000),
        interruptTimeoutMs: Number(process.env.PI_HARNESS_KERNEL_INTERRUPT_TIMEOUT_MS ?? 2000),
        hostHandlers: createHostHandlers({
          cwd: ctx.cwd,
          getClient: () => client,
          getContext: () => activeContext,
          getManifest: () => currentManifest,
          getKernel: () => kernel,
          getKernelRestore: () => lastRestoreReport,
          recordAgentMessage: persistOutgoingAgentMessage,
          recordChildCreation: persistChildCreation,
          restartKernel: scheduleKernelRestart,
        }),
      });
      const ready = await created.start();
      kernel = created;
      lastRestoreReport = ready.restore ?? null;
      const shortId = client?.connectedSession?.shortId;
      ctx.ui.setStatus(STATUS_KEY, shortId ? `harness ${shortId}` : "harness connected");
      if (ready.restore?.found && ready.restore.skipped?.length) {
        ctx.ui.notify(`Python restored with ${ready.restore.skipped.length} skipped value(s)`, "warning");
      }
      return created;
    })().finally(() => {
      kernelPromise = undefined;
    });
    return kernelPromise;
  }

  async function reconcileNamespace(ctx, resultEvent) {
    if (!resultEvent && kernel?.isRunning && namespaceRecovery?.kernel === kernel) {
      return namespaceRecoveryText(namespaceRecovery.report);
    }
    const entries = ctx.sessionManager.getBranch();
    if (!nativeAsyncEnabled(ctx.model) && !hasNativeNamespaceHistory(entries)) return "";
    const source = resultEvent ? [...entries, { type: "message", message: {
      role: "toolResult", toolName: resultEvent.toolName, toolCallId: resultEvent.toolCallId, details: resultEvent.details,
    } }] : entries;
    let activeKernel;
    try { activeKernel = await ensureKernel(ctx); }
    catch (error) {
      namespaceRecovery = { kernel, visible: false,
        report: projectNamespaceRecovery(source, { error: error instanceof Error ? error.message : String(error) }) };
      return namespaceRecoveryText(namespaceRecovery.report);
    }
    if (namespaceRecovery?.kernel !== activeKernel || resultEvent) {
      namespaceRecovery = { kernel: activeKernel, visible: false,
        report: projectNamespaceRecovery(source, lastRestoreReport) };
    }
    return namespaceRecoveryText(namespaceRecovery.report);
  }

  pi.registerCommand(KERNEL_RELOAD_COMMAND.slice(1), {
    description: "Reload the persistent Python kernel from its latest valid snapshot",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await scheduleKernelRestart();
      await ensureKernel(ctx);
      ctx.ui.notify("Python kernel reloaded from the latest valid snapshot", "info");
    },
  });

  pi.registerCommand("persistent-harness-branch", {
    description: "Move the session leaf before retrying a turn",
    handler: async (args, ctx) => {
      const sessionManager = ctx.sessionManager;
      if (!sessionManager || sessionManager.getSessionId() !== ACTOR_ID) {
        throw new Error("actor session context is unavailable for retry branching");
      }
      if (!ctx.isIdle()) throw new Error("session must be idle before retry branching");
      await applyRetryBranch(ctx, args);
    },
  });

  async function executePython(code, ctx, signal, onUpdate, toolCallId) {
    if (typeof code !== "string" || !code.trim()) throw new Error("Python code is required");
    if (kernelRestartPromise) await kernelRestartPromise;
    const activeKernel = await ensureKernel(ctx);
    const namespaceCheckpoint = nativeAsyncEnabled(ctx.model)
      ? { version: 1, sessionId: ACTOR_ID, toolCallId, actorGeneration: ACTOR_GENERATION }
      : undefined;
    const result = await activeKernel.execute(code, {
      signal, onUpdate, namespaceCheckpoint, checkpointInBackground: Boolean(namespaceCheckpoint),
      onCheckpoint: (outcome) => {
        owner?.onCheckpoint?.(toolCallId, outcome);
        if (outcome.ok) return;
        pi.sendMessage({
          customType: "persistent-harness-checkpoint-failure",
          content: `Python namespace save failed after execution for call ${toolCallId}: ${outcome.error}. `
            + "The original execution result is unchanged. Side effects may already have occurred. "
            + "Verify or reconstruct Python state; do not replay the cell automatically.",
          display: true,
          details: outcome,
        }, { deliverAs: "followUp", triggerTurn: Boolean(client?.isConnected && kernel === activeKernel) });
      },
    });
    if (!activeKernel.isRunning || (!result.ok && /Python kernel exited|control channel is closed|EPIPE|ECONNRESET/.test(result.error ?? ""))) {
      if (kernel === activeKernel) kernel = undefined;
      await activeKernel.close({ snapshot: false }).catch(() => {});
    }
    return result;
  }

  function collectNewSettlementEntries() {
    if (!activeContext) return;
    const scanned = appendedSessionEntries(activeContext.sessionManager.getEntries(), settlementEntryCursor);
    settlementEntryCursor = scanned.cursor;
    for (const entry of scanned.entries) {
      if (entry?.type === "custom_message" && entry.customType === INCOMING_MESSAGE_TYPE
        && typeof entry.details?.messageId === "string") persistedDeliveredIds.add(entry.details.messageId);
      if (entry?.type === "custom" && entry.customType === USAGE_ENTRY_TYPE
        && typeof entry.data?.entryId === "string") knownUsageEntryIds.add(entry.data.entryId);
      const usage = usageFromMessageEntry(entry);
      if (usage && !knownUsageEntryIds.has(usage.entryId)) pendingUsageEntries.set(usage.entryId, usage);
    }
    for (const entryId of knownUsageEntryIds) pendingUsageEntries.delete(entryId);
  }

  async function acknowledge(messageId) {
    if (!client?.isConnected) return;
    await client.request("ack_message", { messageId });
    pendingAcknowledgements.delete(messageId);
  }

  async function flushAcknowledgements() {
    collectNewSettlementEntries();
    for (const messageId of [...pendingAcknowledgements]) {
      if (!persistedDeliveredIds.has(messageId)) continue;
      try {
        await acknowledge(messageId);
      } catch {}
    }
  }

  function waitForActorRegistration(activeClient, signal) {
    signal?.throwIfAborted();
    if (activeClient.isConnected && activeClient.connectedSession) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeClient.off("registered", registered);
        activeClient.off("status", status);
        signal?.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error); else resolve();
      };
      const registered = () => {
        if (activeClient.isConnected && activeClient.connectedSession) finish();
      };
      const status = ({ state }) => {
        if (state === "rejected" || state === "stopped") {
          finish(new Error(`actor input delivery registration ${state}`));
        }
      };
      const aborted = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error("actor input delivery registration timed out")), activeClient.requestTimeoutMs);
      timer.unref();
      activeClient.on("registered", registered);
      activeClient.on("status", status);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted(); else registered();
    });
  }

  async function flushUsageEntries() {
    if (!client?.isConnected || !activeContext) return;
    collectNewSettlementEntries();
    for (const [entryId, usage] of [...pendingUsageEntries]) {
      if (knownUsageEntryIds.has(entryId)) {
        pendingUsageEntries.delete(entryId);
        continue;
      }
      try {
        await client.request("record_usage", usage);
        activeContext.sessionManager.appendCustomEntry(USAGE_ENTRY_TYPE, { entryId });
        knownUsageEntryIds.add(entryId);
        pendingUsageEntries.delete(entryId);
      } catch {}
    }
  }

  async function flushContextUsage() {
    if (!client?.isConnected || !activeContext) return;
    const usage = contextUsageFromExtension(activeContext.getContextUsage?.());
    if (!usage) return;
    try {
      await client.request("record_context_usage", usage);
    } catch {}
  }

  async function receiveMessage(data) {
    const message = data?.message;
    if (!message?.messageId || !activeContext || !client) return;
    if (knownDeliveredIds.has(message.messageId)) {
      collectNewSettlementEntries();
      if (persistedDeliveredIds.has(message.messageId)) {
        pendingAcknowledgements.add(message.messageId);
        await acknowledge(message.messageId);
      }
      return;
    }

    await deliverIncomingFamilyMessage({
      persist: persistIncomingAgentMessage,
      inject: (_message, options) => {
        knownDeliveredIds.add(message.messageId);
        pendingAcknowledgements.add(message.messageId);
        pi.sendMessage(incomingCustomPayload(message), options);
      },
      onPersistError: (error) => {
        activeContext?.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
      },
    }, message, incomingSendOptions(data.deliverAs, Boolean(progressTurnId)));
  }

  pi.registerCommand(ACTOR_INPUT_COMMAND, {
    description: "Deliver a supervisor-reserved internal input to this actor",
    handler: (args, ctx) => { activeContext = ctx; return actorInputs.handle(args, ctx); },
  });

  pi.on("resources_discover", async () => {
    const grant = await actorSkillGrant();
    return { skillPaths: grant ? grant.skills.map((skill) => skill.skillPath) : [WORKSPACE_SKILLS_PATH] };
  });

  const ipythonTool = {
    name: "ipython",
    label: "IPython",
    description: "Execute Python in this session's persistent IPython namespace. Use skill? for full skill instructions.",
    promptSnippet: "Execute Python in the persistent namespace; use skill? to inspect any skill's SKILL.md.",
    promptGuidelines: [
      "Use Python for all execution; ordinary Pi tools are unavailable.",
      "Inspect a skill with skill? before first use when its workflow is relevant.",
    ],
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "Python/IPython code to execute" } },
      required: ["code"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await executePython(params.code, ctx, signal, (partial) => {
          onUpdate?.({
            content: [{ type: "text", text: [partial.stdout, partial.stderr].filter(Boolean).join("\n") }],
            details: partial,
          });
        }, toolCallId);
        return pythonToolResult(result);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    },
    renderCall(args, theme) {
      return linesComponent([`ipython ${truncatePlain(args.code ?? "", 120)}`], (text) => theme.fg("toolTitle", text));
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details ?? {};
      const lines = [pythonResultText(details)];
      if (expanded) lines.push(`${details.durationMs ?? 0}ms${details.truncated ? " · truncated" : ""}`);
      return linesComponent(lines, (text) => theme.fg(details.ok === false ? "error" : "toolOutput", text));
    },
  };
  const registerPythonTool = (model) => pi.registerTool({
    ...ipythonTool,
    ...(nativeAsyncEnabled(model) ? { async: true } : {}),
  });
  registerPythonTool();
  pi.registerTool({
    name: "wait_for_ipython",
    label: "Wait for Python",
    description: "Wait for prior Python calls to settle. Make this the last tool call of the current response. When it returns, read the original Python results and continue.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    executionMode: "sequential",
    // An ordinary synchronous tool is already a native scheduler barrier. The
    // scheduler settles prior calls and publishes their results before this runs.
    async execute() {
      return { content: [{ type: "text", text: "Prior Python calls have settled. Read their original results and continue." }], details: {} };
    },
  });
  pi.on("model_select", (event) => registerPythonTool(event.model));
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "ipython") return;
    const diagnostic = await reconcileNamespace(ctx);
    if (namespaceRecovery && !namespaceRecovery.visible) {
      return { block: true, reason: "This cell was planned before the replacement namespace diagnostic reached the model. "
        + "It did not run. Review the diagnostic and verify needed state before issuing another cell.\n\n" + diagnostic };
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "ipython" || typeof event.details?.ok !== "boolean") return;
    const outcome = { isError: !event.details.ok };
    if (namespaceRecovery?.kernel && namespaceRecovery.kernel !== kernel) {
      return reconcileNamespace(ctx, event).then((diagnostic) => ({ ...outcome,
        content: [...event.content, { type: "text", text: diagnostic }],
        details: { ...event.details, namespaceRecovery: namespaceRecovery.report },
      }));
    }
    return outcome;
  });

  pi.registerMessageRenderer(INCOMING_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details ?? {};
    const heading = `← ${details.senderName ?? "agent"} ${details.senderShortId ?? ""} [d${details.senderDepth ?? "?"}]`;
    const body = typeof message.content === "string" ? message.content.split("\n").slice(1) : ["(non-text message)"];
    const lines = [heading, ...body];
    if (expanded && details.messageId) lines.push(`message ${details.messageId} · ${details.relationship ?? "unknown"}`);
    return linesComponent(lines, (text) => theme.fg("customMessageText", text));
  });

  pi.on("session_start", async (_event, ctx) => {
    if (kernel) await kernel.close();
    kernel = undefined;
    currentManifest = undefined;
    namespaceRecovery = undefined;
    if (client) await client.stop();
    activeContext = ctx;
    actorInputs.reset();
    registerPythonTool(ctx.model);
    enforceHarnessTools(ctx.model);
    const entries = ctx.sessionManager.getEntries();
    knownDeliveredIds = deliveredMessageIds(entries);
    persistedDeliveredIds = new Set(knownDeliveredIds);
    knownUsageEntryIds = recordedUsageEntryIds(entries);
    pendingUsageEntries = new Map();
    const initialScan = appendedSessionEntries(entries);
    settlementEntryCursor = initialScan.cursor;
    for (const entry of initialScan.entries) {
      const usage = usageFromMessageEntry(entry);
      if (usage && !knownUsageEntryIds.has(usage.entryId)) pendingUsageEntries.set(usage.entryId, usage);
    }
    pendingAcknowledgements = new Set();
    deliveryChain = Promise.resolve();
    outgoingHistoryTail = Promise.resolve();
    progressTracker.reset();
    progressTurnId = null;
    forwardedProgress = undefined;
    pendingProgressHeading = null;
    progressHeadingFlushActive = false;
    progressTail = Promise.resolve();
    const socketPath = process.env.PI_HARNESS_SOCKET || defaultSocketPath();
    client = new HarnessClient({
      socketPath,
      reconnectBaseMs: 100,
      reconnectMaxMs: 2000,
    });

    client.on("status", ({ state }) => {
      if (state === "connected") {
        const shortId = client?.connectedSession?.shortId;
        ctx.ui.setStatus(STATUS_KEY, shortId ? `harness ${shortId}` : "harness connected");
        restoreTransientProgress();
      } else if (state === "connecting") {
        ctx.ui.setStatus(STATUS_KEY, "harness connecting");
      } else if (state === "superseded") {
        ctx.ui.setStatus(STATUS_KEY, "harness superseded");
      } else if (state === "rejected") {
        ctx.ui.setStatus(STATUS_KEY, "harness rejected");
      } else if (state === "stopped") {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      } else {
        ctx.ui.setStatus(STATUS_KEY, "harness offline");
      }
    });

    client.on("event", (frame) => {
      if (!["message_available", "message_history_required", "child_creation_history_required"].includes(frame.event)) return;
      deliveryChain = deliveryChain
        .then(() => frame.event === "message_available"
          ? receiveMessage(frame.data)
          : frame.event === "message_history_required"
            ? repairOutgoingAgentMessage(frame.data?.message)
            : persistChildCreation(frame.data?.child))
        .catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
    });

    const location = await canonicalLocation(pi, ctx.cwd);
    const commonRegistration = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      cwd: location.cwd,
      repositoryRoot: location.repositoryRoot,
    };
    if (commonRegistration.sessionId !== ACTOR_ID) {
      throw new Error(`actor Pi session mismatch: expected ${ACTOR_ID}, received ${commonRegistration.sessionId}`);
    }
    const registered = await client.start({
      registrationType: "register_actor",
      sessionId: commonRegistration.sessionId,
      sessionFile: commonRegistration.sessionFile,
      cwd: commonRegistration.cwd,
      repositoryRoot: commonRegistration.repositoryRoot,
      actorToken: ACTOR_TOKEN,
      actorGeneration: ACTOR_GENERATION,
    });
    if (!Number.isInteger(registered.session?.depth) || registered.session.depth < 0) {
      throw new Error("supervisor registration did not provide a valid RLM depth");
    }
    actorDepth = registered.session.depth;
    await actorInputs.flush();
    await flushUsageEntries();
    await flushContextUsage();
  });

  const prepareRequest = async (event, ctx) => {
    let systemPrompt;
    try {
      activeContext = ctx;
      enforceHarnessTools(ctx.model);
      if (!Number.isInteger(actorDepth) || actorDepth < 0) throw new Error("actor RLM depth is unavailable");
      const manifest = currentManifest ?? await resolveSkillManifest(ctx);
      if (!currentManifest) {
        currentManifest = manifest;
        await persistSessionMetadata(ctx, manifest);
      }
      const recoveryDiagnostic = await reconcileNamespace(ctx);
      const depthPrompt = await loadDepthPrompt(event.systemPromptOptions.contextFiles, actorDepth);
      let prefixPrompt = "";
      if (actorDepth === 0) {
        prefixPrompt = formatPrefixPrompt(await loadPromptPrefix());
      }
      systemPrompt = assembleActorSystemPrompt({
          depth: actorDepth,
          basePrompt: event.systemPrompt,
          depthPrompt: depthPrompt.prompt,
          skillPrompt: skillPrompt(manifest.skills, nativeAsyncEnabled(ctx.model)),
          prefixPrompt,
        }) + (recoveryDiagnostic ? `\n\n${recoveryDiagnostic}` : "");
      const checkpointError = kernel?.snapshotStats.checkpointError;
      if (checkpointError) systemPrompt += `\n\nPython namespace save diagnostic: ${JSON.stringify(checkpointError)}. `
        + "Do not replay external side effects to repair a save failure.";
    } catch (error) {
      if (owner) throw error;
      systemPrompt = `${event.systemPrompt}\n\nPersistent harness prompt error: ${error instanceof Error ? error.message : String(error)}`;
    }
    // This is the accepted-input cutoff before the native request snapshot, not HTTP-send freshness.
    const deliveryClient = client;
    if (!deliveryClient) throw new Error("actor input delivery channel is not registered");
    await flushAcknowledgements();
    // A lost ACK can close the transport. Reuse its authenticated registration owner.
    await waitForActorRegistration(deliveryClient, ctx.signal);
    if (client !== deliveryClient) throw new Error("actor input delivery channel changed during request preparation");
    await deliveryClient.request("flush_actor_inputs", {});
    return { systemPrompt };
  };
  if (owner) owner.prepareRequest = prepareRequest;
  else pi.on("before_agent_start", prepareRequest);

  pi.on("session_info_changed", async (event, ctx) => {
    if (!client?.isConnected) return;
    try {
      await client.request("set_session_name", { name: event.name ?? null });
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });

  pi.on("agent_start", () => {
    progressTracker.reset();
    progressTurnId = randomUUID();
    forwardedProgress = undefined;
    pendingProgressHeading = null;
    queueActorRequest("update_progress_heading", { phase: "start", turnId: progressTurnId });
  });

  pi.on("context", () => actorInputs.flush());

  pi.on("message_start", async (event) => {
    // Earlier message_end events have persisted before this assistant event.
    if (event.message?.role === "assistant") await actorInputs.flush();
  });

  pi.on("message_update", async (event) => {
    if (!progressTurnId) return;
    const summary = progressTracker.update(event.message, event.assistantMessageEvent);
    if (!summary || summary === forwardedProgress) return;
    forwardedProgress = summary;
    try { await persistProgressHeading(summary); }
    catch (error) { console.error(`Could not persist progress history: ${error instanceof Error ? error.message : String(error)}`); }
    queueProgressHeading(progressTurnId, summary);
  });

  pi.on("agent_settled", async () => {
    const settledTurnId = progressTurnId;
    progressTurnId = null;
    forwardedProgress = undefined;
    pendingProgressHeading = null;
    progressTracker.reset();
    if (settledTurnId) queueActorRequest("update_progress_heading", { phase: "settled", turnId: settledTurnId });
    await flushAcknowledgements();
    await actorInputs.flush();
    await flushUsageEntries();
    await flushContextUsage();
  });

  const prepareCompaction = async (event, ctx) => {
    const diagnostic = await reconcileNamespace(ctx);
    return { customInstructions: [event.customInstructions, diagnostic].filter(Boolean).join("\n\n") };
  };
  // Stock Pi accepts complete custom compactions, not an instruction-return patch.
  // The actor owner composes these instructions before calling any compaction hook.
  if (owner) owner.prepareCompaction = prepareCompaction;


  pi.on("before_provider_request", (event, ctx) => {
    // A result can settle after the request context was captured. Release the
    // preflight only when this actual payload includes the complete diagnostic.
    if (namespaceRecovery && namespaceRecovery.kernel === kernel) {
      const diagnostic = JSON.stringify(namespaceRecoveryText(namespaceRecovery.report)).slice(1, -1);
      if (JSON.stringify(event.payload).includes(diagnostic)) namespaceRecovery.visible = true;
    }
    return sanitizeGrokCliProviderPayload(event.payload, ctx.model?.provider);
  });

  pi.on("session_compact", async (_event, ctx) => {
    activeContext = ctx;
    await flushContextUsage();
  });

  if (owner) owner.afterCommit = async () => {
    await actorInputs.flush();
    await flushAcknowledgements();
    // Canonical entries are the durable accounting journal. Keep accounting on
    // the existing awaited registration, settlement, compaction, and shutdown
    // boundaries instead of delaying Python dispatch or a result continuation.
  };

  pi.on("session_shutdown", async () => {
    const activeClient = client;
    const activeKernel = kernel;
    const activeRestart = kernelRestartPromise;
    await flushUsageEntries();
    await flushContextUsage();
    await outgoingHistoryTail;
    await progressTail;
    client = undefined;
    kernel = undefined;
    currentManifest = undefined;
    namespaceRecovery = undefined;
    activeContext = undefined;
    actorDepth = undefined;
    pendingAcknowledgements.clear();
    pendingUsageEntries.clear();
    persistedDeliveredIds.clear();
    settlementEntryCursor = { index: 0, anchor: null };
    progressTracker.reset();
    progressTurnId = null;
    forwardedProgress = undefined;
    pendingProgressHeading = null;
    await activeRestart;
    await activeKernel?.close();
    await activeClient?.stop();
  });
}

export const extensionInternals = {
  INCOMING_MESSAGE_TYPE,
  AGENT_MESSAGE_ENTRY_TYPE,
  CHILD_CREATION_ENTRY_TYPE,
  PROGRESS_ENTRY_TYPE,
  USAGE_ENTRY_TYPE,
  deliveredMessageIds,
  outgoingAgentMessageEntries,
  incomingAgentMessageEntries,
  childCreationEntries,
  recordedUsageEntryIds,
  usageFromMessageEntry,
  contextUsageFromExtension,
  pythonResultText,
  pythonToolResult,
  nativeAsyncEnabled,
  hasNativeNamespaceHistory,
  projectNamespaceRecovery,
  namespaceRecoveryText,
  skillPrompt,
  appendedSessionEntries,
  incomingSendOptions,
  incomingCustomPayload,
  deliverIncomingFamilyMessage,
};
