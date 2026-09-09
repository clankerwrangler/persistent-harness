import assert from "node:assert/strict";
import test from "node:test";

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
  }, owner);
  return { tools, hooks, owner };
}

test("native opt-in is exact and does not broaden the Python schema or execution lane", () => {
  assert.equal(nativeAsyncEnabled(astra, "1"), true);
  for (const enabled of [undefined, "", "0", "true", "yes"]) assert.equal(nativeAsyncEnabled(astra, enabled), false);
  for (const model of [null, { ...astra, id: "gpt-5.6-sol" }, { ...astra, provider: "openai" },
    { ...astra, api: "openai-responses" }, { ...astra, id: "gpt-6-astra-other" },
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
    assert.deepEqual(Object.keys(tool.parameters.properties), ["code"]);
    assert.deepEqual(tool.parameters.required, ["code"]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual([...tools.keys()], ["ipython", "wait_for_ipython"]);
    assert.equal(tools.get("wait_for_ipython").async, undefined, "the existing scheduler owns the synchronous barrier");
    assert.deepEqual(tools.get("wait_for_ipython").parameters.properties, {});
    assert.equal(hooks.has("before_agent_start"), false, "shared preparation uses one canonical request hook");
    assert.equal(hooks.has("before_agent_request"), false, "stock Pi has no patched per-request hook");
    assert.equal(typeof owner.prepareRequest, "function", "the sole actor owner invokes request preparation");
    hooks.get("model_select")({ model: { ...astra, id: "gpt-5.6-sol" } });
    assert.equal(tools.get("ipython").async, undefined);
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
