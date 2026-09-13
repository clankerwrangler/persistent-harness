// Pure policy/record construction. The caller owns fresh observations, delay,
// canonical append, generation fencing, and every provider/tool invocation.
const MAX_TIMER_DELAY_MS = 2_147_483_647; // Node timers overflow beyond this value.
const UNKNOWN_TRANSPORT_ERRORS = new Set([
  "websocket_closed", "websocket_transport_error", "provider_timeout", "provider_response_not_successful", "provider_stream_incomplete",
]);
const OUTCOMES = new Set(["not_sent", "rejected", "unknown", "failed", "completed"]);
const value = (object, key) => {
  if (!object || typeof object !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};
const boolean = input => typeof input === "boolean" ? input : null;
const count = input => Number.isSafeInteger(input) && input >= 0 ? input : null;
const ordinal = input => Number.isSafeInteger(input) && input > 0 ? input : null;
const id = input => typeof input === "string" && input.length > 0 && input.length <= 1024
  && !/[\u0000-\u0020\u007f]/u.test(input) ? input : null;
function freeze(object) {
  if (object && typeof object === "object") { Object.values(object).forEach(freeze); Object.freeze(object); }
  return object;
}
function projectReport(report) {
  const calls = value(report, "observedCalls");
  let validCalls = Array.isArray(calls) && calls.length <= 10_000;
  const observedCalls = validCalls ? calls.map(call => {
    const projected = { itemId: id(value(call, "itemId")), callId: id(value(call, "callId")),
      complete: boolean(value(call, "complete")), native: boolean(value(call, "native")) };
    if (Object.values(projected).some(field => field === null) || (projected.native && !projected.complete)) validCalls = false;
    return projected;
  }) : [];
  const outcome = value(report, "outcome");
  const projected = {
    version: value(report, "version") === 1 ? 1 : null,
    requestId: id(value(report, "requestId")), attemptId: id(value(report, "attemptId")),
    transportAttemptNumber: ordinal(value(report, "attemptNumber")),
    transport: ["sse", "websocket"].includes(value(report, "transport")) ? value(report, "transport") : null,
    outcome: OUTCOMES.has(outcome) ? outcome : "unproven",
    sent: boolean(value(report, "sent")), created: boolean(value(report, "created")),
    responseId: id(value(report, "responseId")), providerTools: boolean(value(report, "providerTools")),
    retired: boolean(value(report, "retired")), fenced: boolean(value(report, "fenced")),
    possibleUsage: boolean(value(report, "possibleUsage")), observedCalls,
  };
  const required = ["version", "requestId", "attemptId", "transportAttemptNumber", "transport", "sent", "created", "providerTools", "retired", "fenced", "possibleUsage"];
  const valid = required.every(key => projected[key] !== null) && projected.outcome !== "unproven" && validCalls
    && !(projected.created && !projected.sent) && !(projected.outcome === "unknown" && !projected.sent);
  return { projected, valid };
}

/** Evaluate ONE failed logical inference attempt (initial attemptNumber = 1).
 * api injects stock pi-ai's pure isRetryableAssistantError/isContextOverflow.
 * error is the terminal AssistantMessage, not a raw exception. Counts are
 * monotonically accumulated attempt-local history, never outstanding work.
 * This decision is NOT a lease: re-evaluate a fresh snapshot after any delay.
 */
export function evaluateInferenceRetry(input = {}) {
  const api = value(input, "api"), rawReport = value(input, "transportReport");
  const hasReport = rawReport !== undefined;
  const { projected: report, valid: validReport } = projectReport(rawReport);
  const policy = value(input, "policy"), error = value(input, "error");
  const requestId = id(value(input, "requestId")), attemptId = id(value(input, "attemptId"));
  const attemptNumber = ordinal(value(input, "attemptNumber")), snapshotVersion = count(value(input, "snapshotVersion"));
  const observations = {
    admittedCount: count(value(input, "admittedCount")), dispatchedCount: count(value(input, "dispatchedCount")),
    providerTools: boolean(value(input, "providerTools")), aborted: boolean(value(input, "aborted")),
    retired: boolean(value(input, "retired")), fenced: boolean(value(input, "fenced")),
  };
  const priorAttempt = hasReport ? {
    ...report, possibleProcessing: report.outcome === "unknown" || report.sent !== false,
    possibleUsage: report.outcome === "unknown" ? true : report.possibleUsage ?? true,
  } : {
    requestId, attemptId, transportAttemptNumber: null, transport: null, outcome: "unreported",
    sent: null, created: null, responseId: null, possibleProcessing: true, possibleUsage: true, observedCalls: [],
  };
  const finish = (classification, retry = false, delayMs = 0) => freeze({ retry, delayMs, classification,
    record: { type: "inference_retry_decision", version: 1, requestId, attemptId, attemptNumber, snapshotVersion,
      classification, decision: { retry, delayMs }, observations, priorAttempt } });

  if (!requestId || !attemptId || attemptNumber === null || snapshotVersion === null) return finish("invalid_snapshot");
  if (observations.aborted === true || value(error, "stopReason") === "aborted") return finish("aborted");
  if (Object.values(observations).some(field => field === null)) return finish("unproven_observations");
  if (observations.admittedCount !== 0) return finish("local_admissions");
  if (observations.dispatchedCount !== 0) return finish("local_effects");
  if (observations.providerTools) return finish("provider_tools");
  if (!observations.retired || !observations.fenced) return finish("unfenced_attempt");
  if (hasReport) {
    if (!validReport) return finish("invalid_transport_report");
    if (report.requestId !== requestId || report.attemptId !== attemptId) return finish("identity_mismatch");
    if (report.providerTools) return finish("provider_tools");
    if (!report.retired || !report.fenced) return finish("unfenced_attempt");
    if (["not_sent", "rejected"].includes(report.outcome)) return finish("adapter_owned_retry");
    if (report.outcome === "completed") return finish("completed_attempt");
  }
  if (policy === undefined) return finish("policy_disabled");
  const enabled = boolean(value(policy, "enabled")), maxRetries = count(value(policy, "maxRetries"));
  const baseDelayMs = value(policy, "baseDelayMs");
  if (enabled === null || maxRetries === null || typeof baseDelayMs !== "number" || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) return finish("invalid_policy");
  if (!enabled) return finish("policy_disabled");
  if (attemptNumber > maxRetries) return finish("retry_budget_exhausted");
  const delayMs = baseDelayMs * 2 ** (attemptNumber - 1);
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS || !Number.isSafeInteger(attemptNumber + 1)) return finish("unsafe_timer_delay");
  const stopReason = value(error, "stopReason"), errorMessage = value(error, "errorMessage");
  if (stopReason !== "error") return finish("not_error");
  if (typeof errorMessage !== "string" || !errorMessage || errorMessage.length > 65536) return finish("unproven_error");
  if (typeof api?.isRetryableAssistantError !== "function" || typeof api?.isContextOverflow !== "function") return finish("missing_public_retry_api");
  // Pass only the two public classifier inputs, never a private message payload.
  const failed = Object.freeze({ stopReason, errorMessage });
  try {
    if (api.isContextOverflow(failed) === true) return finish("context_overflow");
    if (hasReport && report.outcome === "unknown") {
      if (!UNKNOWN_TRANSPORT_ERRORS.has(errorMessage)) return finish("unknown_condition_not_proven");
      return finish("retry_unknown", true, delayMs);
    }
    if (api.isRetryableAssistantError(failed) !== true) return finish("not_retryable");
    return finish("retry_transient", true, delayMs);
  } catch {
    // No raw helper exception (which could include request data) enters a record.
    return finish("classifier_failed");
  }
}
