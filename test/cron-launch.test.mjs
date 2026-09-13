import assert from "node:assert/strict";
import test from "node:test";
import { cronLaunchFromRequest, mergeCronLaunch, normalizeCronLaunch } from "../src/cron-launch.mjs";

const settings = {
  model: { requested: null, resolved: null, source: "settings" },
  thinking: { requested: null, resolved: null, source: "settings" },
  capabilityIds: [],
};

test("settings snapshots from create time are not treated as pins", () => {
  assert.deepEqual(normalizeCronLaunch({
    model: { requested: null, resolved: { provider: "openai-codex", id: "gpt-5.6-sol" }, source: "settings" },
    thinking: { requested: null, resolved: "xhigh", source: "settings" },
    capabilityIds: ["files"],
  }), settings);
  assert.deepEqual(normalizeCronLaunch({
    model: { resolved: { provider: "fake", id: "model" } },
  }), settings);
});

test("explicit model pins survive normalization", () => {
  const pinned = normalizeCronLaunch({
    model: { requested: "grok-cli/grok-4.6", resolved: { provider: "grok-cli", id: "grok-4.6" }, source: "explicit" },
    thinking: { requested: "high", resolved: "high", source: "explicit" },
  });
  assert.deepEqual(pinned.model, {
    requested: "grok-cli/grok-4.6", resolved: { provider: "grok-cli", id: "grok-4.6" }, source: "explicit",
  });
  assert.deepEqual(pinned.thinking, { requested: "high", resolved: "high", source: "explicit" });
});

test("create requests pin only when provider and model are both present", () => {
  assert.deepEqual(cronLaunchFromRequest({}), settings);
  assert.deepEqual(cronLaunchFromRequest({ provider: null, model: null, thinkingLevel: null }), settings);
  assert.deepEqual(cronLaunchFromRequest({ provider: "grok-cli", model: "grok-4.6", thinkingLevel: "high" }), {
    model: { requested: "grok-cli/grok-4.6", resolved: { provider: "grok-cli", id: "grok-4.6" }, source: "explicit" },
    thinking: { requested: "high", resolved: "high", source: "explicit" },
    capabilityIds: [],
  });
});

test("update can pin, keep, or clear a model independently of thinking", () => {
  const pinned = cronLaunchFromRequest({ provider: "fake", model: "one", thinkingLevel: "high" });
  assert.deepEqual(mergeCronLaunch(pinned, {}), pinned);
  assert.deepEqual(mergeCronLaunch(pinned, { provider: "fake", model: "two" }).model.resolved, { provider: "fake", id: "two" });
  assert.equal(mergeCronLaunch(pinned, { provider: "fake", model: "two" }).thinking.resolved, "high");
  assert.deepEqual(mergeCronLaunch(pinned, { provider: null, model: null }).model, settings.model);
  assert.equal(mergeCronLaunch(pinned, { thinkingLevel: null }).thinking.resolved, null);
  assert.equal(mergeCronLaunch(pinned, { thinkingLevel: null }).model.source, "explicit");
});
