import assert from "node:assert/strict";
import test from "node:test";
import { GROK_CLI_PROVIDER } from "../src/grok-cli-remaining.mjs";
import {
  grokCliToolsSpecified,
  sanitizeGrokCliProviderPayload,
  sanitizeGrokCliToolChoice,
} from "../src/grok-cli-payload.mjs";

test("detects only a non-empty tools array as specified", () => {
  assert.equal(grokCliToolsSpecified(undefined), false);
  assert.equal(grokCliToolsSpecified({}), false);
  assert.equal(grokCliToolsSpecified({ tools: [] }), false);
  assert.equal(grokCliToolsSpecified({ tools: "none" }), false);
  assert.equal(grokCliToolsSpecified({ tools: [{ type: "function", name: "ipython" }] }), true);
});

test("drops tool_choice from grok summarization payloads that have no tools", () => {
  const payload = { model: "grok-4.6", input: [], tool_choice: "none", reasoning: { effort: "high" } };
  assert.equal(sanitizeGrokCliToolChoice(payload), payload);
  assert.equal(Object.hasOwn(payload, "tool_choice"), false);
  assert.deepEqual(payload, { model: "grok-4.6", input: [], reasoning: { effort: "high" } });
});

test("keeps tool_choice when grok-cli actually sent tools", () => {
  const payload = {
    tools: [{ type: "function", name: "ipython" }],
    tool_choice: "auto",
  };
  assert.equal(sanitizeGrokCliToolChoice(payload), payload);
  assert.equal(payload.tool_choice, "auto");
});

test("does not rewrite other providers, including openai-codex inference", () => {
  const payload = { tool_choice: "none" };
  assert.equal(sanitizeGrokCliProviderPayload(payload, "openai-codex"), payload);
  assert.equal(payload.tool_choice, "none");
  sanitizeGrokCliProviderPayload(payload, GROK_CLI_PROVIDER);
  assert.equal(Object.hasOwn(payload, "tool_choice"), false);
});
