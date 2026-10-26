import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

process.env.PI_HARNESS_ACTOR_ID = "fixture-session";
process.env.PI_HARNESS_ACTOR_TOKEN = "fixture-token-not-a-credential";
process.env.PI_HARNESS_ACTOR_GENERATION = "1";
const { default: extension, nativeAsyncEnabled, hasNativeNamespaceHistory, projectNamespaceRecovery, namespaceRecoveryText, extensionInternals } = await import("../src/extension.mjs");
const astra = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses",
  compat: { supportsAsyncTools: true } };

function fixture() {
  const tools = new Map(); const hooks = new Map(); const owner = {};
  extension({
    registerTool: (definition) => tools.set(definition.name, definition),
    registerCommand() {}, registerMessageRenderer() {}, events: { on() {} },
    on: (name, handler) => hooks.set(name, handler),
    getCommands: () => [],
  }, owner);
  return { tools, hooks, owner };
}

test("native opt-in follows the catalog async flag and does not broaden the Python schema or execution lane", () => {
  assert.equal(nativeAsyncEnabled(astra, "1"), true);
  assert.equal(nativeAsyncEnabled({ ...astra, id: "gpt-6.1-sol" }, "1"), true, "any Codex Responses model the catalog marks async is opted in");
  for (const enabled of [undefined, "", "0", "true", "yes"]) assert.equal(nativeAsyncEnabled(astra, enabled), false);
  for (const model of [null, { ...astra, provider: "openai" },
    { ...astra, api: "openai-responses" }, { ...astra, id: "gpt-6.1-sol", compat: undefined },
    { ...astra, compat: undefined }, { ...astra, compat: { supportsAsyncTools: false } },
    { ...astra, compat: { supportsAsyncTools: "true" } }]) {
    assert.equal(nativeAsyncEnabled(model, "1"), false);
  }
  process.env.PI_HARNESS_NATIVE_ASYNC = "1";
  try {
    const { tools, hooks, owner } = fixture();
    assert.equal(tools.get("ipython").async, undefined, "no model is opted in before selection");
    hooks.get("model_select")({ model: astra });
    const tool = tools.get("ipython");
    assert.equal(tool.async, true);
    assert.equal(tool.executionMode, "sequential");
    assert.equal(tool.exposure, "model-only", "Python orchestration cannot be nested");
    assert.equal(tools.get("wait_for_ipython").exposure, "model-only");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["code"]);
    assert.deepEqual(tool.parameters.required, ["code"]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual([...tools.keys()], ["ipython", "wait_for_ipython"]);
    assert.equal(tools.get("wait_for_ipython").async, undefined, "the existing scheduler owns the synchronous barrier");
    assert.deepEqual(tools.get("wait_for_ipython").parameters.properties, {});
    assert.equal(hooks.has("before_agent_start"), false, "shared preparation uses one canonical request hook");
    assert.equal(hooks.has("before_agent_request"), false, "stock Pi has no patched per-request hook");
    assert.equal(typeof owner.prepareRequest, "function", "the sole actor owner invokes request preparation");
    hooks.get("model_select")({ model: { ...astra, id: "gpt-5.6-sol", compat: {} } });
    assert.equal(tools.get("ipython").async, undefined, "switching to a model without the catalog flag removes async");
  } finally { delete process.env.PI_HARNESS_NATIVE_ASYNC; }
});

test("native prompt explains result visibility and uses the existing synchronous barrier", async () => {
  const prompt = extensionInternals.skillPrompt([], true);
  assert.match(prompt, /wait_for_ipython as the last tool call of the current response/);
  assert.match(prompt, /handoff, not task completion/);
  assert.match(prompt, /reading instructions does not dispatch an action/);
  assert.doesNotMatch(extensionInternals.skillPrompt([]), /wait_for_ipython/);
  const { tools } = fixture();
  const result = await tools.get("wait_for_ipython").execute();
  assert.match(result.content[0].text, /Read their original results and continue/);
  assert.equal(result.details.executionId, undefined, "waiting does not execute or checkpoint Python");
});

test("ordinary mode stays opt-out even for Astra", () => {
  const { tools, hooks } = fixture();
  hooks.get("model_select")({ model: astra });
  assert.equal(tools.get("ipython").async, undefined);
});

test("Python cancellation and failures use Pi's canonical result error hook", async () => {
  const { tools, hooks } = fixture();
  const result = await tools.get("ipython").execute("call-original", { code: "" }, undefined, undefined, {});
  assert.equal(result.details.ok, false);
  assert.deepEqual(hooks.get("tool_result")({ toolName: "ipython", ...result }), { isError: true });
  assert.deepEqual(hooks.get("tool_result")({ toolName: "ipython", details: { ok: true } }), { isError: false });
  assert.equal(hooks.get("tool_result")({ toolName: "other", details: { ok: false } }), undefined);
  assert.equal(hooks.get("tool_result")({ toolName: "ipython", isError: true }), undefined);
});

const checkpoint = (toolCallId, actorGeneration = 1) => ({ version: 1, sessionId: "fixture-session", toolCallId,
  actorGeneration, executionId: `execution-${toolCallId}` });
const resultEntry = (toolCallId, details, toolName = "ipython") => ({ type: "message", message: {
  role: "toolResult", toolCallId, toolName, details,
} });

test("namespace recovery projects known results and explicit unknown outcomes without a substitute result", () => {
  const expected = checkpoint("known"); const restored = checkpoint("unknown");
  const entries = [resultEntry("known", { namespaceCheckpoint: expected }),
    resultEntry("unknown", { nativeAsyncRecovery: "interrupted-unknown" })];
  const report = projectNamespaceRecovery(entries, { found: true, namespaceCheckpoint: restored,
    skipped: [{ name: "connection", reason: "live runtime object" }] });
  assert.deepEqual(report.expectedCheckpoint, expected);
  assert.deepEqual(report.restoredCheckpoint, restored);
  assert.equal(report.identityMatches, false);
  assert.deepEqual(report.interruptedOrUncheckpointed, [{ toolCallId: "unknown", state: "interrupted-unknown", executionOk: null }]);
  const diagnostic = namespaceRecoveryText(report);
  assert.match(diagnostic, /Expected canonical checkpoint/);
  assert.match(diagnostic, /Restored checkpoint/);
  assert.match(diagnostic, /connection/);
  assert.match(diagnostic, /Do not repeat unknown external side effects/);
  assert.equal(entries.length, 2, "projection never appends or repairs canonical results");
});

test("matching namespace identities preserve skipped-value and non-exact-restoration diagnostics", () => {
  const identity = checkpoint("known");
  const report = projectNamespaceRecovery([resultEntry("known", { namespaceCheckpoint: identity })], {
    found: true, namespaceCheckpoint: { ...identity }, skipped: [{ name: "large", reason: "size limit" }],
  });
  assert.equal(report.identityMatches, true);
  assert.match(namespaceRecoveryText(report), /Matching identities do not prove exact restoration/);
  assert.deepEqual(report.skippedValues, [{ name: "large", reason: "size limit" }]);
  assert.equal(projectNamespaceRecovery([resultEntry("known", { namespaceCheckpoint: identity })], {
    found: true, namespaceCheckpoint: checkpoint("known", 2),
  }).identityMatches, false, "actor generation participates in identity");
});

test("early execution results recover against the completed manifest without changing the original result", () => {
  const attempt = checkpoint("early");
  const entries = [resultEntry("old", { namespaceCheckpoint: checkpoint("old") }),
    resultEntry("early", { ok: true, executionId: attempt.executionId,
      namespaceCheckpointAttempt: attempt, namespaceCheckpointState: "pending" })];
  const original = structuredClone(entries);
  const saved = projectNamespaceRecovery(entries, { found: true, namespaceCheckpoint: attempt });
  assert.equal(saved.identityMatches, true);
  assert.deepEqual(saved.interruptedOrUncheckpointed, []);
  const lost = projectNamespaceRecovery(entries, { found: true, namespaceCheckpoint: checkpoint("old") });
  assert.equal(lost.identityMatches, false);
  assert.deepEqual(lost.interruptedOrUncheckpointed, [{ toolCallId: "early", state: "execution-ended-without-checkpoint", executionOk: true }]);
  assert.match(namespaceRecoveryText(lost), /Do not repeat unknown external side effects/);
  assert.deepEqual(entries, original);
});

test("failed checkpoint and missing restore remain explicit while ordinary unrelated results stay ordinary", () => {
  const entries = [resultEntry("ordinary", { ok: true }), resultEntry("uncheckpointed", {
    ok: false, executionOk: true, executionId: "real-execution", errorType: "NamespaceCheckpointError",
  }), resultEntry("foreign-tool", { namespaceCheckpoint: checkpoint("foreign") }, "other")];
  const report = projectNamespaceRecovery(entries, { found: false, error: "runtime unavailable" });
  assert.equal(report.expectedCheckpoint, null);
  assert.equal(report.restoredCheckpoint, null);
  assert.equal(report.snapshotFound, false);
  assert.equal(report.restorationError, "runtime unavailable");
  assert.deepEqual(report.interruptedOrUncheckpointed, [{ toolCallId: "uncheckpointed",
    state: "execution-ended-without-checkpoint", executionOk: true }]);
  assert.equal(hasNativeNamespaceHistory(entries), false);
  assert.equal(hasNativeNamespaceHistory([resultEntry("known", { namespaceCheckpoint: checkpoint("known") })]), true);
  assert.equal(hasNativeNamespaceHistory([resultEntry("attempted", { namespaceCheckpointAttempt: checkpoint("attempted") })]), true);
  assert.equal(hasNativeNamespaceHistory([resultEntry("unknown", { nativeAsyncRecovery: "interrupted-unknown" })]), true);
  assert.equal(hasNativeNamespaceHistory([{ type: "message", message: { role: "assistant", content: [
    { type: "toolCall", name: "ipython", async: true },
  ] } }]), true);
});

test("ordinary preflight and compaction keep the existing path without starting a kernel", async () => {
  const { hooks, owner } = fixture();
  const ctx = { model: { provider: "other", id: "ordinary" }, sessionManager: { getBranch: () => [] } };
  assert.equal(await hooks.get("tool_call")({ toolName: "ipython" }, ctx), undefined);
  assert.deepEqual(await owner.prepareCompaction({ customInstructions: "keep caller instructions" }, ctx), { customInstructions: "keep caller instructions" });
  assert.deepEqual(hooks.get("before_provider_request")({ payload: { model: "ordinary" } }, ctx), { model: "ordinary" });
});


test("namespace recovery visibility latches only after the complete diagnostic and resets for a new kernel", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "namespace-latch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const enabled = process.env.PI_HARNESS_NATIVE_ASYNC;
  process.env.PI_HARNESS_NATIVE_ASYNC = "1";
  t.after(() => { if (enabled === undefined) delete process.env.PI_HARNESS_NATIVE_ASYNC;
    else process.env.PI_HARNESS_NATIVE_ASYNC = enabled; });
  let activeKernel, reportThrows = false;
  const reportError = new SyntaxError("report getter"), payloadError = new SyntaxError("payload getter");
  const skipped = { get name() { if (reportThrows) throw reportError; return "fixture"; } };
  t.mock.method(PythonRuntimeManager.prototype, "launch", async () => {
    activeKernel = { isRunning: true, async close() {}, snapshotStats: {} };
    return { kernel: activeKernel, ready: { restore: { found: true, skipped: [skipped] } } };
  });
  const { hooks } = fixture();
  const ctx = { cwd: directory, model: astra, ui: { setStatus() {}, notify() {} },
    sessionManager: { getBranch: () => [], getSessionId: () => "fixture-session",
      getSessionFile: () => path.join(directory, "session.jsonl") } };
  const gate = () => hooks.get("tool_call")({ toolName: "ipython" }, ctx);
  const payload = value => hooks.get("before_provider_request")({ payload: value }, ctx);
  const initial = await gate();
  assert.equal(initial.block, true);
  const diagnostic = initial.reason.slice(initial.reason.indexOf("\n\n") + 2);
  payload({ text: "missing" }); assert.equal((await gate()).block, true);
  payload({ text: diagnostic.slice(0, -1) }); assert.equal((await gate()).block, true);
  let payloadReads = 0;
  const throwing = { get text() { payloadReads++; throw payloadError; } };
  reportThrows = true;
  assert.throws(() => payload(throwing), error => error === reportError);
  assert.equal(payloadReads, 0, "unresolved report errors precede payload observations");
  reportThrows = false;
  assert.throws(() => payload(throwing), error => error === payloadError);
  assert.equal(payloadReads, 1);
  payload({ text: diagnostic }); assert.equal(await gate(), undefined);
  reportThrows = true;
  assert.equal(payload(throwing), throwing, "latched diagnostic and serialization-only errors disappear");
  assert.equal(payloadReads, 1);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(payload(cyclic), cyclic);
  let jsonReads = 0;
  const customJSON = { toJSON() { jsonReads++; throw payloadError; } };
  assert.equal(payload(customJSON), customJSON); assert.equal(jsonReads, 0);
  const grok = { model: { provider: "grok-cli" } };
  const emptyTools = { tool_choice: "none", toolChoice: "none" };
  assert.equal(hooks.get("before_provider_request")({ payload: emptyTools }, grok), emptyTools);
  assert.deepEqual(emptyTools, {}, "the required sanitizer still edits each latched request");
  const tools = { tools: [{ name: "fixture" }], tool_choice: "auto" };
  assert.equal(hooks.get("before_provider_request")({ payload: tools }, grok), tools);
  assert.equal(tools.tool_choice, "auto");
  const badTools = Object.defineProperty({}, "tools", { get() { throw payloadError; } });
  assert.throws(() => hooks.get("before_provider_request")({ payload: badTools }, grok), error => error === payloadError);
  reportThrows = false; activeKernel.isRunning = false;
  assert.equal((await gate()).block, true);
  assert.throws(() => payload(throwing), error => error === payloadError, "replacement kernels require a fresh diagnostic");
  await hooks.get("session_shutdown")();
  assert.equal(payload(throwing), throwing, "shutdown clears the recovery owner");
});
