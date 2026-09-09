import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateSessionTelemetry,
  cacheHitRatio,
  projectAssistantUsageEntry,
  projectContextUsage,
  sessionTelemetryInternals,
} from "../src/session-telemetry.mjs";

function assistantEntry(id, overrides = {}) {
  const base = {
    role: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 2,
      reasoning: 4,
      totalTokens: 37,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
  };
  return { type: "message", id, message: { ...base, ...overrides } };
}

test("projects only strict canonical Pi assistant-entry usage", () => {
  assert.deepEqual(projectAssistantUsageEntry(assistantEntry("entry-1")), {
    entryId: "entry-1", provider: "openai-codex", model: "gpt-5.6",
    input: 10, output: 5, cacheRead: 20, cacheWrite: 2, reasoning: 4,
    totalTokens: 37, costTotal: 0.03,
  });
  assert.deepEqual(projectAssistantUsageEntry(assistantEntry("without-reasoning", {
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
  })), {
    entryId: "without-reasoning", provider: "openai-codex", model: "gpt-5.6",
    input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3, costTotal: 0,
  });

  for (const entry of [
    null,
    { type: "custom", id: "entry-1", message: assistantEntry("x").message },
    { ...assistantEntry("user"), message: { ...assistantEntry("x").message, role: "user" } },
    assistantEntry("", {}),
    assistantEntry("bad-provider", { provider: "bad\nprovider" }),
    assistantEntry("bad-token", { usage: { ...assistantEntry("x").message.usage, input: -1 } }),
    assistantEntry("bad-fraction", { usage: { ...assistantEntry("x").message.usage, output: 1.5 } }),
    assistantEntry("bad-reasoning", { usage: { ...assistantEntry("x").message.usage, reasoning: 6 } }),
    assistantEntry("bad-cost", { usage: { ...assistantEntry("x").message.usage, cost: { total: Infinity } } }),
  ]) assert.equal(projectAssistantUsageEntry(entry), undefined);
});

test("bounds entry identity, provider, and model without truncating them", () => {
  const { MAX_ENTRY_ID_CHARACTERS, MAX_PROVIDER_CHARACTERS, MAX_MODEL_CHARACTERS } = sessionTelemetryInternals;
  assert.ok(projectAssistantUsageEntry(assistantEntry("e".repeat(MAX_ENTRY_ID_CHARACTERS), {
    provider: "p".repeat(MAX_PROVIDER_CHARACTERS), model: "m".repeat(MAX_MODEL_CHARACTERS),
  })));
  assert.equal(projectAssistantUsageEntry(assistantEntry("e".repeat(MAX_ENTRY_ID_CHARACTERS + 1))), undefined);
  assert.equal(projectAssistantUsageEntry(assistantEntry("provider-long", {
    provider: "p".repeat(MAX_PROVIDER_CHARACTERS + 1),
  })), undefined);
  assert.equal(projectAssistantUsageEntry(assistantEntry("model-long", {
    model: "m".repeat(MAX_MODEL_CHARACTERS + 1),
  })), undefined);
});

test("aggregates unique assistant entries and keeps the last unique turn", () => {
  const first = assistantEntry("first");
  const second = assistantEntry("second", {
    provider: "anthropic", model: "claude",
    usage: { input: 6, output: 3, cacheRead: 3, cacheWrite: 0, reasoning: 2,
      totalTokens: 12, cost: { total: 0.07 } },
  });
  const duplicateWithDifferentValues = assistantEntry("first", {
    provider: "spoof", model: "spoof",
    usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      totalTokens: 1998, cost: { total: 10 } },
  });
  const entries = [first, { type: "message", id: "user", message: { role: "user" } }, second,
    duplicateWithDifferentValues, { type: "compaction", usage: first.message.usage }];
  const snapshot = structuredClone(entries);

  assert.deepEqual(aggregateSessionTelemetry(entries, { tokens: 64, contextWindow: 128, percent: 50 }), {
    session: {
      input: 16, output: 8, cacheRead: 23, cacheWrite: 2, reasoning: 6,
      totalTokens: 49, costTotal: 0.1, cacheHitRatio: 23 / 41,
    },
    latestTurn: {
      entryId: "second", provider: "anthropic", model: "claude",
      input: 6, output: 3, cacheRead: 3, cacheWrite: 0, reasoning: 2,
      totalTokens: 12, costTotal: 0.07, cacheHitRatio: 1 / 3,
    },
    context: { tokens: 64, contextWindow: 128, percent: 50 },
  });
  assert.deepEqual(entries, snapshot, "aggregation must not mutate canonical entries");
});

test("reasoning is an output subset and is never added to total tokens", () => {
  const result = aggregateSessionTelemetry([
    assistantEntry("a", { usage: { input: 2, output: 7, cacheRead: 0, cacheWrite: 0,
      reasoning: 6, totalTokens: 9, cost: { total: 0 } } }),
    assistantEntry("b", { usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0,
      reasoning: 3, totalTokens: 5, cost: { total: 0 } } }),
  ]);
  assert.equal(result.session.output, 11);
  assert.equal(result.session.reasoning, 9);
  assert.equal(result.session.totalTokens, 14);
});

test("cache hit ratio uses prompt-side tokens and is null for a zero or unsafe denominator", () => {
  assert.equal(cacheHitRatio({ input: 10, cacheRead: 30, cacheWrite: 10, output: 999 }), 0.6);
  assert.equal(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRatio({ input: Number.MAX_SAFE_INTEGER, cacheRead: 1, cacheWrite: 0 }), null);
  assert.deepEqual(aggregateSessionTelemetry([]), {
    session: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      totalTokens: 0, costTotal: 0, cacheHitRatio: null },
    latestTurn: null,
    context: { tokens: null, contextWindow: null, percent: null },
  });
});

test("projects context only from explicit valid current-context usage", () => {
  assert.deepEqual(projectContextUsage({ tokens: 800, contextWindow: 1000, percent: 80 }),
    { tokens: 800, contextWindow: 1000, percent: 80 });
  assert.deepEqual(projectContextUsage({ tokens: 5, maxTokens: 10, percent: 50 }),
    { tokens: 5, contextWindow: null, percent: null });
  assert.deepEqual(projectContextUsage({ tokens: null, contextWindow: 1000, percent: null }),
    { tokens: null, contextWindow: 1000, percent: null });
  assert.deepEqual(projectContextUsage(null), { tokens: null, contextWindow: null, percent: null });
  assert.deepEqual(projectContextUsage({ tokens: 800, contextWindow: 1000, percent: 80 }, { contextValid: false }),
    { tokens: null, contextWindow: null, percent: null });
});

test("invalid context fields stay unknown and never fall back to cumulative usage", () => {
  assert.deepEqual(projectContextUsage({ tokens: -1, contextWindow: 0, percent: Infinity }),
    { tokens: null, contextWindow: null, percent: null });
  assert.deepEqual(projectContextUsage({ tokens: 10, contextWindow: "100", percent: 10 }),
    { tokens: 10, contextWindow: null, percent: null });
  const telemetry = aggregateSessionTelemetry([assistantEntry("large")], null);
  assert.deepEqual(telemetry.context, { tokens: null, contextWindow: null, percent: null });
  assert.notEqual(telemetry.session.totalTokens, telemetry.context.tokens);
});
