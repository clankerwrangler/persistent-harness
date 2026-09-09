import assert from "node:assert/strict";
import test from "node:test";
import { findModels, resolveChildLaunchPolicy } from "../src/child-policy.mjs";

const availableModels = [
  { provider: "fake-a", id: "shared", name: "Shared A", reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
  { provider: "fake-b", id: "shared", name: "Shared B", reasoning: true, thinkingLevels: ["off", "low", "high"] },
  { provider: "fake-a", id: "parent", name: "Parent", reasoning: true, thinkingLevels: ["off", "low"] },
  { provider: "fake-c", id: "plain", name: "Plain", reasoning: false, thinkingLevels: ["off"] },
];
const skills = [
  { id: "files", version: "1", contentHash: "a", skillPath: "/skills/files/SKILL.md", pythonBacked: true },
  { id: "workflow", version: "sha", contentHash: "b", skillPath: "/skills/workflow/SKILL.md", pythonBacked: false },
];
const parent = { kind: "root", depth: 0, cwd: "/project", repositoryRoot: "/project" };

function request(overrides = {}) {
  return {
    prompt: "Investigate this.",
    name: "reviewer",
    model: null,
    thinkingLevel: null,
    parentModel: { provider: "fake-a", id: "parent" },
    parentThinkingLevel: "low",
    availableModels,
    skillCatalog: skills,
    ...overrides,
  };
}

test("resolves child model and thinking independently with non-amplifying capabilities", () => {
  const inherited = resolveChildLaunchPolicy({ request: request(), parent });
  assert.deepEqual(inherited.model, {
    requested: null,
    resolved: { provider: "fake-a", id: "parent" },
    source: "parent",
  });
  assert.deepEqual(inherited.thinking, { requested: null, resolved: "low", source: "parent" });
  assert.deepEqual(inherited.capabilities.map((skill) => skill.id), ["files"]);
  assert.equal(inherited.skillCatalog.length, 2, "guidance and backed skills share one catalog");

  const configured = resolveChildLaunchPolicy({
    request: request(),
    parent,
    configuredModel: "fake-a/shared",
    configuredThinkingLevel: "medium",
  });
  assert.equal(configured.model.source, "configured");
  assert.deepEqual(configured.model.resolved, { provider: "fake-a", id: "shared" });
  assert.deepEqual(configured.thinking, { requested: null, resolved: "medium", source: "configured" });

  const explicit = resolveChildLaunchPolicy({
    request: request({ model: "fake-b/shared", thinkingLevel: "high" }),
    parent,
    configuredModel: "fake-a/shared",
    configuredThinkingLevel: "medium",
  });
  assert.equal(explicit.model.source, "explicit");
  assert.deepEqual(explicit.model.resolved, { provider: "fake-b", id: "shared" });
  assert.deepEqual(explicit.thinking, { requested: "high", resolved: "high", source: "explicit" });
});

test("rejects ambiguous or missing models, invalid options, and excessive depth", () => {
  assert.throws(() => resolveChildLaunchPolicy({ request: request({ model: "shared" }), parent }), /ambiguous/);
  assert.throws(() => resolveChildLaunchPolicy({ request: request({ model: "missing" }), parent }), /did not resolve exactly/);
  assert.throws(() => resolveChildLaunchPolicy({ request: request(), parent, configuredModel: "missing" }), /configured child model did not resolve exactly/);
  assert.throws(() => resolveChildLaunchPolicy({ request: request({ thinkingLevel: "ultra" }), parent }), /unsupported/);
  assert.throws(() => resolveChildLaunchPolicy({
    request: request({ model: "fake-c/plain", thinkingLevel: "high" }), parent,
  }), /not supported.*supported levels: off/);
  assert.throws(() => resolveChildLaunchPolicy({ request: request({ name: "bad name" }), parent }), /child name/);
  assert.throws(() => resolveChildLaunchPolicy({ request: request(), parent, maxDepth: 0 }), /maximum child depth/);
  assert.throws(() => resolveChildLaunchPolicy({
    request: request({ skillCatalog: [...skills, { ...skills[0] }] }), parent,
  }), /duplicate ID/);
});

test("findModels exposes bounded public model metadata without fuzzy substitution", () => {
  assert.deepEqual(findModels(availableModels, "fake-b", 10), [availableModels[1]]);
  assert.deepEqual(findModels(availableModels, "shared", 1), [availableModels[0]]);
  assert.throws(() => findModels(availableModels, "", 0), /limit/);
  assert.deepEqual(
    findModels(availableModels, "", 2, { provider: "fake-a", id: "parent" }).map((model) => `${model.provider}/${model.id}`),
    ["fake-a/parent", "fake-a/shared"],
  );
  assert.deepEqual(findModels(availableModels, "fake-b", 10, { provider: "fake-a", id: "parent" }), [availableModels[1]]);
  assert.deepEqual(
    findModels(availableModels, "", 2, { provider: "missing", id: "nope" }).map((model) => `${model.provider}/${model.id}`),
    ["fake-a/shared", "fake-b/shared"],
  );
});

test("findModels keeps the live parent and grok-4.6 on a Codex-heavy first page", () => {
  const catalog = [
    ...Array.from({ length: 12 }, (_, index) => ({
      provider: "openai-codex",
      id: `gpt-filler-${index}`,
      name: `Codex ${index}`,
      reasoning: true,
      thinkingLevels: ["off", "low", "high"],
    })),
    { provider: "grok-cli", id: "grok-4.6", name: "Grok 4.6", reasoning: true, thinkingLevels: ["off", "low", "high"] },
  ];
  const page = findModels(catalog, "", 10, [
    { provider: "grok-cli", id: "grok-4.6" },
    { provider: "openai-codex", id: "gpt-filler-0" },
  ]).map((model) => `${model.provider}/${model.id}`);
  assert.equal(page[0], "grok-cli/grok-4.6");
  assert.ok(page.includes("grok-cli/grok-4.6"));
  assert.equal(page.length, 10);
});
