import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveExternalPi } from "../src/external-pi.mjs";
import { evaluateInferenceRetry } from "../src/inference-retry.mjs";

// Public root exports provide the pure retry/overflow helpers; no runtime/auth creation.
const paths = await resolveExternalPi();
const api = await import(pathToFileURL(paths.api).href);
const copy = value => structuredClone(value);
function report(change = {}) {
  return { version: 1, requestId: "request-one", attemptId: "transport-attempt-two", attemptNumber: 2,
    transport: "websocket", outcome: "unknown", sent: true, created: false, observedCalls: [],
    providerTools: false, retired: true, fenced: true, possibleUsage: true, ...change };
}
function input(change = {}) {
  return { api, requestId: "request-one", attemptId: "transport-attempt-two", snapshotVersion: 7,
    attemptNumber: 1, policy: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    transportReport: report(), error: { role: "assistant", stopReason: "error", errorMessage: "websocket_closed" },
    admittedCount: 0, dispatchedCount: 0, providerTools: false, aborted: false, retired: true, fenced: true, ...change };
}
const evaluate = change => evaluateInferenceRetry(input(change));
const deny = (change, classification) => {
  const result = evaluate(change); assert.equal(result.retry, false); assert.equal(result.delayMs, 0);
  if (classification) assert.equal(result.classification, classification);
  return result;
};

test("unknown inference-only retry preserves immutable original attempt uncertainty and identity", () => {
  const data = input({ transportReport: report({ possibleUsage: false }) });
  const before = copy({ ...data, api: undefined });
  const result = evaluateInferenceRetry(data);
  assert.equal(result.retry, true); assert.equal(result.delayMs, 2000); assert.equal(result.classification, "retry_unknown");
  assert.equal(result.record.requestId, "request-one"); assert.equal(result.record.attemptId, "transport-attempt-two");
  assert.equal(result.record.attemptNumber, 1); assert.equal(result.record.priorAttempt.transportAttemptNumber, 2);
  assert.equal(result.record.snapshotVersion, 7); assert.equal(result.record.priorAttempt.outcome, "unknown");
  assert.equal(result.record.priorAttempt.possibleProcessing, true); assert.equal(result.record.priorAttempt.possibleUsage, true);
  assert.deepEqual({ ...data, api: undefined }, before); assert.deepEqual(evaluateInferenceRetry(data), result);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.record)); assert.ok(Object.isFrozen(result.record.observations));
  assert.ok(Object.isFrozen(result.record.priorAttempt.observedCalls));
});

for (const code of ["websocket_closed", "websocket_transport_error", "provider_timeout", "provider_response_not_successful", "provider_stream_incomplete"]) {
  test(`proven transport/final-missing condition: ${code}`, () => {
    assert.equal(evaluate({ error: { stopReason: "error", errorMessage: code } }).retry, true);
  });
}
for (const code of ["provider_request_failed", "invalid_provider_json", "invalid_complete_arguments", "incomplete_output_item", "retired_output_identity", "response_identity_changed", "503", "unknown"]) {
  test(`unknown report cannot turn protocol/unproven condition into transient: ${code}`, () => {
    deny({ error: { stopReason: "error", errorMessage: code } }, "unknown_condition_not_proven");
  });
}
for (const [cut, admittedCount, dispatchedCount] of [
  ["canonical admission before Python", 1, 0], ["Python dispatch before start notification", 1, 1],
  ["Python start before real result", 1, 1], ["real result already persisted", 1, 1], ["unexplained dispatched effect", 0, 1],
]) test(`no retry after ${cut}`, () => {
  const result = deny({ admittedCount, dispatchedCount }, admittedCount ? "local_admissions" : "local_effects");
  assert.equal(result.record.priorAttempt.outcome, "unknown"); assert.equal(result.record.priorAttempt.possibleUsage, true);
  assert.equal(result.record.observations.dispatchedCount, dispatchedCount);
});

test("observed raw partial/complete calls are not fabricated canonical admission counts", () => {
  for (const complete of [false, true]) {
    const observedCalls = [{ itemId: "item-original", callId: "call-original", complete, native: complete }];
    const result = evaluate({ transportReport: report({ created: true, responseId: "response-original", observedCalls }) });
    assert.equal(result.retry, true); assert.deepEqual(result.record.priorAttempt.observedCalls, observedCalls);
    observedCalls[0].callId = "later mutation"; assert.equal(result.record.priorAttempt.observedCalls[0].callId, "call-original");
  }
});

for (const field of ["admittedCount", "dispatchedCount", "providerTools", "aborted", "retired", "fenced"]) {
  test(`missing or typed-wrong owner ${field} denies rather than inferring safe metadata`, () => {
    deny({ [field]: undefined }, "unproven_observations"); deny({ [field]: "false" }, "unproven_observations");
  });
}
for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, false]) test(`invalid historical count ${String(value)}`, () => {
  deny({ admittedCount: value }, "unproven_observations"); deny({ dispatchedCount: value }, "unproven_observations");
});

test("native and ordinary retries require explicit retired/fenced/no-provider-tools observations", () => {
  for (const transportReport of [undefined, report()]) {
    const ordinary = { transportReport, error: { stopReason: "error", errorMessage: "websocket_closed" } };
    deny({ ...ordinary, retired: false }, "unfenced_attempt"); deny({ ...ordinary, fenced: false }, "unfenced_attempt");
    deny({ ...ordinary, providerTools: true }, "provider_tools");
  }
  deny({ transportReport: report({ providerTools: true }) }, "provider_tools");
  deny({ transportReport: report({ retired: false }) }, "unfenced_attempt");
  deny({ transportReport: report({ fenced: false }) }, "unfenced_attempt");
});

test("user abort remains terminal in either owner observations or terminal assistant", () => {
  deny({ aborted: true }, "aborted"); deny({ error: { stopReason: "aborted", errorMessage: "network error" } }, "aborted");
});

test("identity and freshness metadata must name the same failed attempt", () => {
  deny({ requestId: undefined }, "invalid_snapshot"); deny({ attemptId: "" }, "invalid_snapshot");
  deny({ snapshotVersion: undefined }, "invalid_snapshot"); deny({ snapshotVersion: -1 }, "invalid_snapshot");
  deny({ snapshotVersion: 1.5 }, "invalid_snapshot");
  deny({ transportReport: report({ requestId: "request-old" }) }, "identity_mismatch");
  deny({ transportReport: report({ attemptId: "attempt-old" }) }, "identity_mismatch");
  deny({ attemptNumber: 0 }, "invalid_snapshot");
});

test("malformed native metadata cannot fall through to the ordinary classifier", () => {
  for (const transportReport of [null, {}, report({ version: 2 }), report({ sent: false }), report({ created: true, sent: false }),
    report({ observedCalls: undefined }), report({ observedCalls: [{ itemId: "item", callId: "call", complete: false, native: true }] }),
    report({ observedCalls: [{ itemId: "item", callId: "call", complete: "true", native: true }] }), report({ retired: "true" }),
    report({ providerTools: undefined }), report({ attemptNumber: 0 }), report({ outcome: "unexplained" })]) {
    deny({ transportReport }, "invalid_transport_report");
  }
});

test("before-send/rejected adapter paths and completed attempts are not retried by this planner", () => {
  for (const outcome of ["not_sent", "rejected"]) deny({ transportReport: report({ outcome }) }, "adapter_owned_retry");
  deny({ transportReport: report({ outcome: "completed" }) }, "completed_attempt");
});

for (const errorMessage of ["503 service unavailable", "network error", "429 rate limit", "stream ended without message_stop", "500 provider error"]) {
  test(`ordinary stock transient path preserved with owner facts: ${errorMessage}`, () => {
    const result = evaluate({ transportReport: undefined, error: { stopReason: "error", errorMessage } });
    assert.equal(result.retry, true); assert.equal(result.classification, "retry_transient");
    assert.equal(result.record.priorAttempt.outcome, "unreported"); assert.equal(result.record.priorAttempt.possibleProcessing, true);
    assert.equal(result.record.priorAttempt.possibleUsage, true);
  });
}

test("native known HTTP failure still uses the ordinary public stock classifier", () => {
  assert.equal(evaluate({ transportReport: report({ outcome: "failed" }), error: { stopReason: "error", errorMessage: "provider_http_503" } }).retry, true);
});

for (const errorMessage of ["429 insufficient_quota", "429 billing exhausted", "FreeUsageLimitError", "invalid API key", "malformed provider response"]) {
  test(`ordinary deterministic/account failure: ${errorMessage}`, () => {
    deny({ transportReport: undefined, error: { stopReason: "error", errorMessage } }, "not_retryable");
  });
}

test("context overflow stays compaction-owned even when stock retry also matches", () => {
  const error = { stopReason: "error", errorMessage: "503 context_length_exceeded" };
  assert.equal(api.isRetryableAssistantError(error), true); assert.equal(api.isContextOverflow(error), true);
  deny({ transportReport: undefined, error }, "context_overflow");
});

test("logical attempts follow stock budget and exponential delay, not adapter transport attempts", () => {
  for (const [attemptNumber, delayMs] of [[1, 2000], [2, 4000], [3, 8000]]) {
    const result = evaluate({ attemptNumber }); assert.equal(result.retry, true); assert.equal(result.delayMs, delayMs);
  }
  deny({ attemptNumber: 4 }, "retry_budget_exhausted");
  deny({ policy: { enabled: true, maxRetries: 0, baseDelayMs: 2000 } }, "retry_budget_exhausted");
  deny({ policy: undefined }, "policy_disabled"); deny({ policy: { enabled: false, maxRetries: 3, baseDelayMs: 2000 } }, "policy_disabled");
});

test("invalid policy or timer overflow is explicit; no invented delay cap or sleep", () => {
  for (const policy of [null, {}, { enabled: "true", maxRetries: 3, baseDelayMs: 2 },
    { enabled: true, maxRetries: Infinity, baseDelayMs: 2 }, { enabled: true, maxRetries: 1.5, baseDelayMs: 2 },
    { enabled: true, maxRetries: -1, baseDelayMs: 2 }, { enabled: true, maxRetries: 3, baseDelayMs: -1 },
    { enabled: true, maxRetries: 3, baseDelayMs: NaN }, { enabled: true, maxRetries: 3, baseDelayMs: "2000" }]) deny({ policy }, "invalid_policy");
  deny({ policy: { enabled: true, maxRetries: 3, baseDelayMs: 2_147_483_648 } }, "unsafe_timer_delay");
  deny({ attemptNumber: 1025, policy: { enabled: true, maxRetries: 2000, baseDelayMs: 1 } }, "unsafe_timer_delay");
  assert.equal(evaluate({ policy: { enabled: true, maxRetries: 3, baseDelayMs: 2_147_483_647 } }).delayMs, 2_147_483_647);
  assert.equal(evaluate({ policy: { enabled: true, maxRetries: 3, baseDelayMs: 0 } }).delayMs, 0);
  assert.equal(evaluate({ policy: { enabled: true, maxRetries: 3, baseDelayMs: 0.5 } }).delayMs, 0.5);
});

test("fresh evaluation after delay denies newly observed admission, dispatch, abort, and old generation", () => {
  const firstInput = input(), planned = evaluateInferenceRetry(firstInput); assert.equal(planned.retry, true);
  for (const change of [{ admittedCount: 1 }, { dispatchedCount: 1 }, { aborted: true }, { attemptId: "replacement-attempt" }, { fenced: false }]) {
    const fresh = evaluateInferenceRetry({ ...firstInput, ...change, snapshotVersion: 8 });
    assert.equal(fresh.retry, false); assert.equal(fresh.record.snapshotVersion, 8); assert.equal(planned.record.snapshotVersion, 7);
    assert.equal(planned.retry, true, "old immutable plan is evidence, not a current execution lease");
  }
  assert.equal(evaluateInferenceRetry({ ...firstInput, snapshotVersion: 8 }).retry, true, "fresh safe same-attempt evidence still allows inference");
});

test("record projection is detached, data-only, and excludes raw errors, arguments, usage payloads and unknown keys", () => {
  const secret = "PRIVATE_FIXTURE_NO_RETURN";
  const data = input({ error: { stopReason: "error", errorMessage: "websocket_closed", content: [{ arguments: secret }], headers: { authorization: secret } },
    transportReport: report({ headers: secret, observedCalls: [{ itemId: "item", callId: "call", complete: true, native: true, arguments: secret }] }),
    tools: [{ execute() { throw Error("must not execute"); } }], canonicalRecords: [{ private: secret }] });
  const result = evaluateInferenceRetry(data); assert.equal(result.retry, true); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("websocket_closed"), false);
  assert.equal(JSON.stringify(result).includes("execute"), false); assert.equal(JSON.stringify(result).includes("canonicalRecords"), false);
  data.transportReport.observedCalls[0].itemId = "changed"; assert.equal(result.record.priorAttempt.observedCalls[0].itemId, "item");
});

test("no raw helper errors, inherited safe flags, or accessors become authority", () => {
  deny({ api: {} }, "missing_public_retry_api");
  const result = deny({ api: { ...api, isContextOverflow() { throw Error("PRIVATE_FAILURE"); } } }, "classifier_failed");
  assert.equal(JSON.stringify(result).includes("PRIVATE_FAILURE"), false);
  const data = input(); delete data.fenced; Object.setPrototypeOf(data, { fenced: true });
  assert.equal(evaluateInferenceRetry(data).classification, "unproven_observations");
  Object.defineProperty(data, "fenced", { get() { throw Error("must not execute accessor"); } });
  assert.equal(evaluateInferenceRetry(data).classification, "unproven_observations");
  const privateError = {}; Object.defineProperty(privateError, "stopReason", { get() { throw Error("must not execute error accessor"); } });
  deny({ error: privateError }, "not_error");
});

test("ordinary successful/length messages and missing errors never trigger general retry", () => {
  for (const stopReason of ["stop", "length", "toolUse", "pending"]) deny({ error: { stopReason, errorMessage: "503" } }, "not_error");
  deny({ error: { stopReason: "error" } }, "unproven_error");
});


test("typed raw EOF needs matching native report and every safe owner fact", () => {
  const error = { stopReason: "error", errorMessage: "provider_stream_incomplete" };
  assert.equal(api.isRetryableAssistantError(error), false, "stock does not guess this adapter-owned code");
  assert.equal(evaluate({ error }).retry, true);
  for (const change of [{ admittedCount: 1 }, { dispatchedCount: 1 }, { retired: false }, { fenced: false },
    { providerTools: true }, { aborted: true }, { attemptId: "old-attempt" }, { transportReport: report({ outcome: "completed" }) }]) {
    deny({ error, ...change });
  }
  deny({ error, transportReport: undefined }, "not_retryable");
  deny({ error: { stopReason: "error", errorMessage: "OpenAI Responses stream ended before a terminal response event" } }, "unknown_condition_not_proven");
  deny({ error: { stopReason: "error", errorMessage: "conflicting_terminal_reasoning" } }, "unknown_condition_not_proven");
});
