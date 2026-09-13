const MAX_ENTRY_ID_CHARACTERS = 128;
const MAX_PROVIDER_CHARACTERS = 128;
const MAX_MODEL_CHARACTERS = 256;
const MAX_COST_TOTAL = 1_000_000_000;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function boundedText(value, maxCharacters) {
  if (typeof value !== "string" || !value || value.length > maxCharacters
    || Buffer.byteLength(value, "utf8") > maxCharacters * 4 || CONTROL.test(value)) return undefined;
  return value;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finiteNonnegative(value, maximum = Number.MAX_VALUE) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value : undefined;
}

/** Return a bounded usage record only for a canonical Pi assistant message entry. */
export function projectAssistantUsageEntry(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "assistant") return undefined;
  const entryId = boundedText(entry.id, MAX_ENTRY_ID_CHARACTERS);
  const provider = boundedText(entry.message.provider, MAX_PROVIDER_CHARACTERS);
  const model = boundedText(entry.message.model, MAX_MODEL_CHARACTERS);
  const usage = entry.message.usage;
  if (!entryId || !provider || !model || !usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;

  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  const totalTokens = tokenCount(usage.totalTokens);
  const reasoning = usage.reasoning === undefined ? 0 : tokenCount(usage.reasoning);
  const costTotal = finiteNonnegative(usage.cost?.total, MAX_COST_TOTAL);
  if ([input, output, cacheRead, cacheWrite, reasoning, totalTokens].some((value) => value === undefined)
    || costTotal === undefined || reasoning > output) return undefined;

  return { entryId, provider, model, input, output, cacheRead, cacheWrite, reasoning, totalTokens, costTotal };
}

/** Cache reads are measured against all prompt-side token classes, not output. */
export function cacheHitRatio(usage) {
  const input = tokenCount(usage?.input);
  const cacheRead = tokenCount(usage?.cacheRead);
  const cacheWrite = tokenCount(usage?.cacheWrite);
  if (input === undefined || cacheRead === undefined || cacheWrite === undefined) return null;
  const denominator = input + cacheRead + cacheWrite;
  return denominator > 0 && Number.isSafeInteger(denominator) ? cacheRead / denominator : null;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    totalTokens: 0, costTotal: 0, cacheHitRatio: null };
}

function canAdd(totals, usage) {
  return ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
    .every((field) => Number.isSafeInteger(totals[field] + usage[field]))
    && Number.isFinite(totals.costTotal + usage.costTotal);
}

function withRatio(usage) {
  return { ...usage, cacheHitRatio: cacheHitRatio(usage) };
}

const UNKNOWN_CONTEXT = Object.freeze({ tokens: null, contextWindow: null, percent: null });

/**
 * Project Pi's explicit current-context reading. This intentionally has no
 * transcript/token-total fallback: missing or invalidated context stays unknown.
 */
export function projectContextUsage(contextUsage, { contextValid = true } = {}) {
  if (contextValid !== true || !contextUsage || typeof contextUsage !== "object" || Array.isArray(contextUsage)) {
    return { ...UNKNOWN_CONTEXT };
  }
  const tokens = tokenCount(contextUsage.tokens);
  const contextWindow = tokenCount(contextUsage.contextWindow);
  const percent = finiteNonnegative(contextUsage.percent);
  return {
    tokens: tokens ?? null,
    contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : null,
    percent: tokens !== undefined && contextWindow !== undefined && contextWindow > 0 ? (percent ?? null) : null,
  };
}

/** Aggregate canonical Pi assistant-entry usage once per bounded entry ID. */
export function aggregateSessionTelemetry(entries, contextUsage = null, { contextValid = true } = {}) {
  const session = emptyUsage();
  const seenEntryIds = new Set();
  let latestTurn = null;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const usage = projectAssistantUsageEntry(entry);
    if (!usage || seenEntryIds.has(usage.entryId)) continue;
    seenEntryIds.add(usage.entryId);
    // Keep every published total exact. An impossible cumulative overflow fails closed.
    if (!canAdd(session, usage)) continue;
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) {
      session[field] += usage[field];
    }
    session.costTotal += usage.costTotal;
    latestTurn = withRatio(usage);
  }

  session.cacheHitRatio = cacheHitRatio(session);
  return { session, latestTurn, context: projectContextUsage(contextUsage, { contextValid }) };
}

export const sessionTelemetryInternals = Object.freeze({
  MAX_ENTRY_ID_CHARACTERS, MAX_PROVIDER_CHARACTERS, MAX_MODEL_CHARACTERS, MAX_COST_TOTAL,
});
