import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAvailableModels,
  resolveModelSelection,
  validateInferenceEffort,
} from "../src/inference-options.mjs";

function rawModel(overrides = {}) {
  return {
    provider: "provider-a",
    id: "model-a",
    name: "Model A",
    reasoning: true,
    contextWindow: 200_000,
    thinkingLevelMap: { minimal: null, medium: null, xhigh: undefined, max: "max" },
    apiKey: "sk-do-not-project",
    headers: { Authorization: "Bearer secret" },
    baseUrl: "https://private.invalid/secret",
    cost: { secretRate: 42 },
    ...overrides,
  };
}

test("projects only bounded public model metadata and preserves thinking map holes", () => {
  const input = rawModel();
  const projected = projectAvailableModels([input]);

  assert.deepEqual(projected, [{
    provider: "provider-a",
    id: "model-a",
    name: "Model A",
    reasoning: true,
    thinkingLevels: ["off", "low", "high", "max"],
    contextWindow: 200_000,
  }]);
  assert.deepEqual(Object.keys(projected[0]), [
    "provider", "id", "name", "reasoning", "thinkingLevels", "contextWindow",
  ]);
  assert.doesNotMatch(JSON.stringify(projected), /sk-do-not-project|Authorization|private\.invalid|secretRate/);
  assert.notEqual(projected[0], input);

  assert.deepEqual(projectAvailableModels([rawModel({
    id: "plain",
    name: "Plain",
    reasoning: false,
    thinkingLevelMap: { off: null, max: "ignored" },
  })])[0].thinkingLevels, ["off"]);
});

test("rejects oversized catalogs, malformed public fields, invalid maps, contexts, and duplicates", () => {
  assert.throws(() => projectAvailableModels(null), /array of at most 512/);
  assert.throws(() => projectAvailableModels(Array.from({ length: 513 }, (_, id) => rawModel({ id: String(id) }))), /at most 512/);
  assert.throws(() => projectAvailableModels([rawModel({ provider: "" })]), /provider.*non-empty/);
  assert.throws(() => projectAvailableModels([rawModel({ id: "x".repeat(257) })]), /id.*at most 256/);
  assert.throws(() => projectAvailableModels([rawModel({ name: "x".repeat(257) })]), /name.*at most 256/);
  assert.throws(() => projectAvailableModels([rawModel({ reasoning: "true" })]), /reasoning must be boolean/);
  assert.throws(() => projectAvailableModels([rawModel({ contextWindow: 0 })]), /positive integer/);
  assert.throws(() => projectAvailableModels([rawModel({ contextWindow: 10_000_001 })]), /positive integer/);
  assert.throws(() => projectAvailableModels([rawModel({ contextWindow: 1.5 })]), /positive integer/);
  assert.throws(() => projectAvailableModels([rawModel({ thinkingLevelMap: { low: 1 } })]), /thinkingLevelMap.low/);
  assert.throws(() => projectAvailableModels([rawModel(), rawModel({ name: "Duplicate" })]), /duplicate provider\/id/);
});

test("selects by exact provider and id without aliases or fuzzy fallback", () => {
  const models = [
    rawModel(),
    rawModel({ provider: "provider-b", name: "Other A" }),
    rawModel({ id: "model-ab", name: "Model AB" }),
  ];
  assert.equal(resolveModelSelection(models, { provider: "provider-b", id: "model-a" }).name, "Other A");
  assert.throws(() => resolveModelSelection(models, { provider: "provider", id: "model-a" }), /did not resolve exactly/);
  assert.throws(() => resolveModelSelection(models, { provider: "provider-a", id: "model" }), /did not resolve exactly/);
  assert.throws(() => resolveModelSelection(models, { provider: "PROVIDER-A", id: "model-a" }), /did not resolve exactly/);
  assert.throws(() => resolveModelSelection(models, { id: "model-a" }), /selection.provider/);
});

test("validates the effort enum and selected model support", () => {
  const projected = projectAvailableModels([rawModel()])[0];
  assert.equal(validateInferenceEffort("high", projected), "high");
  assert.throws(() => validateInferenceEffort("medium", projected), /not supported/);
  assert.throws(() => validateInferenceEffort("ultra", projected), /unsupported inference effort/);
  assert.throws(() => validateInferenceEffort(null, projected), /unsupported inference effort/);
});
