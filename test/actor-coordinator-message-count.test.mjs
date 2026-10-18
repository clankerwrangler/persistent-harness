import assert from "node:assert/strict";
import test from "node:test";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";

function fixture(methods) {
  const manager = { getBranch: () => [], getSessionFile: () => "fixture.jsonl",
    getSessionId: () => "fixture", getSessionName: () => "Synthetic fixture", ...methods };
  const session = { sessionManager: manager, model: { id: "fixture" }, thinkingLevel: "off", autoCompactionEnabled: false };
  return { manager, coordinator: new ActorCoordinator({ session }) };
}

test("status prefers the scalar capability without constructing sources or projections", () => {
  let count = 0, queries = 0;
  const { manager, coordinator } = fixture({
    getSessionMessageCount() { assert.equal(this, manager); queries++; return count; },
    buildSessionSource() { assert.fail("status constructed a captured source"); },
    buildSessionProjection() { assert.fail("status constructed a projection"); },
  });
  coordinator.queue.push({ kind: "user" });
  assert.equal(coordinator.getState().messageCount, 0, "zero is a real scalar result");
  count = 4;
  const state = coordinator.getState();
  assert.equal(state.messageCount, 4);
  assert.equal(state.pendingMessageCount, 1);
  assert.equal(state.sessionId, "fixture");
  assert.equal(state.sessionName, "Synthetic fixture");
  assert.equal(state.isStreaming, false);
  assert.equal(queries, 2, "status observes each current value without a result cache");
});

test("status retains the captured-source fallback for older SDK managers", () => {
  let calls = 0;
  const { coordinator } = fixture({
    getSessionMessageCount: undefined,
    buildSessionSource() { calls++; return { length: 3, readAll() { assert.fail("status read source messages"); } }; },
    buildSessionProjection() { assert.fail("source-capable status used projection fallback"); },
  });
  assert.equal(coordinator.getState().messageCount, 3);
  assert.equal(calls, 1);
});

test("status retains the projection fallback for array-only managers", () => {
  let calls = 0;
  const { coordinator } = fixture({ getSessionMessageCount: null, buildSessionSource: undefined,
    buildSessionProjection() { calls++; return { messages: [{ role: "user" }, { role: "custom" }] }; },
  });
  assert.equal(coordinator.getState().messageCount, 2);
  assert.equal(calls, 1);
});

test("status preserves scalar errors rather than concealing them with a fallback", () => {
  const { coordinator } = fixture({ getSessionMessageCount() { throw new Error("Session branch contains a cycle"); },
    buildSessionSource() { assert.fail("status concealed scalar error"); },
  });
  assert.throws(() => coordinator.getState(), /branch contains a cycle/);
});
