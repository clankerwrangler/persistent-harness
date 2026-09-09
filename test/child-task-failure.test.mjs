import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantTurnFailureFromEvents,
  assistantTurnFailureFromMessage,
  captureAssistantTurn,
  resetAssistantTurn,
} from "../src/child-task-failure.mjs";

test("assistant turn failure surfaces provider errors and stillborn empty turns", () => {
  assert.equal(assistantTurnFailureFromMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: "Provided authentication token is expired.",
    content: [],
  }), "Provided authentication token is expired.");

  assert.equal(assistantTurnFailureFromMessage({
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 },
    diagnostics: [{ type: "provider_transport_failure", error: { message: "openai-codex OAuth was expired" } }],
  }), "openai-codex OAuth was expired");

  assert.equal(assistantTurnFailureFromMessage({
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
    usage: { input: 3, output: 1, totalTokens: 4 },
  }), null);

  const record = {};
  resetAssistantTurn(record);
  assert.equal(assistantTurnFailureFromEvents(record), "assistant turn settled without a message");
  captureAssistantTurn(record, {
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, totalTokens: 0 },
    diagnostics: [{ error: { message: "WebSocket error" } }],
  });
  assert.equal(assistantTurnFailureFromEvents(record), "WebSocket error");
});
