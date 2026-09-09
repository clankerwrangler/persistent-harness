import assert from "node:assert/strict";
import test from "node:test";
import { PROGRESS_ENTRY_TYPE, ProgressHeadingTracker, normalizeProgressHeading, projectProgressEntry } from "../src/progress-projection.mjs";

const message = { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", content: [] };

test("progress tracker publishes only completed native Pi standalone headings", () => {
  const tracker = new ProgressHeadingTracker();
  tracker.update(message, { type: "thinking_start", contentIndex: 0 });
  assert.equal(tracker.update(message, { type: "thinking_delta", contentIndex: 0, delta: "private body\n**Inspecting" }), undefined);
  assert.equal(tracker.update(message, { type: "thinking_delta", contentIndex: 0, delta: " the actor path**" }), undefined);
  assert.equal(tracker.update(message, { type: "thinking_delta", contentIndex: 0, delta: "\nprivate tail" }), "Inspecting the actor path");
  assert.equal(tracker.update(message, { type: "thinking_end", contentIndex: 0, content: "ignored full body" }), "Inspecting the actor path");
});

test("progress tracker accepts a final heading only when thinking ends", () => {
  const tracker = new ProgressHeadingTracker();
  tracker.update(message, { type: "thinking_start", contentIndex: 2 });
  tracker.update(message, { type: "thinking_delta", contentIndex: 2, delta: "**Testing settlement**" });
  assert.equal(tracker.latest, undefined);
  assert.equal(tracker.update(message, { type: "thinking_end", contentIndex: 2, content: "**Testing settlement**" }), "Testing settlement");
});

test("progress tracker fails closed for generic raw-thinking providers and unsafe lines", () => {
  const tracker = new ProgressHeadingTracker();
  const raw = { ...message, api: "anthropic-messages", provider: "anthropic" };
  tracker.update(raw, { type: "thinking_start", contentIndex: 0 });
  assert.equal(tracker.update(raw, { type: "thinking_delta", contentIndex: 0, delta: "**Private reasoning**\n" }), undefined);
  tracker.update(message, { type: "thinking_start", contentIndex: 1 });
  assert.equal(tracker.update(message, { type: "thinking_delta", contentIndex: 1, delta: "**{\"secret\":true}**\n**`private`**\nordinary private body\n" }), undefined);
  assert.equal(tracker.latest, undefined);
  assert.equal(normalizeProgressHeading("Safe heading"), "Safe heading");
  assert.equal(normalizeProgressHeading("unsafe\u0000heading"), undefined);
  assert.equal(normalizeProgressHeading("unsafe \u202E heading"), undefined);
  assert.equal(normalizeProgressHeading("Inspecting {private} state"), undefined);
});

test("progress projection preserves safe custom history entries and rejects unrelated data", () => {
  const entry = { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p1", parentId: null, timestamp: "2026-01-01T00:00:00Z", data: { summary: "Inspecting the durable path", private: "ignored" } };
  assert.deepEqual(projectProgressEntry(entry), { kind: "progress", id: "p1", summary: "Inspecting the durable path", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(projectProgressEntry({ ...entry, customType: "other" }), undefined);
  assert.equal(projectProgressEntry({ ...entry, data: { summary: "`private`" } }), undefined);
  assert.doesNotMatch(JSON.stringify(projectProgressEntry(entry)), /ignored/);
});

test("progress heading length treats Unicode code points consistently", () => {
  const heading = "😀".repeat(100);
  assert.equal(normalizeProgressHeading(heading), heading);
  const tracker = new ProgressHeadingTracker();
  tracker.update(message, { type: "thinking_start", contentIndex: 0 });
  assert.equal(tracker.update(message, { type: "thinking_delta", contentIndex: 0, delta: `**${heading}**\n` }), heading);
});
