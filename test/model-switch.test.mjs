import assert from "node:assert/strict";
import test from "node:test";
import { modelSwitchFixture } from "./fixtures/model-switch.mjs";

test("real worker switches after streaming and tools without replacing Python or replaying input", { timeout: 90_000 }, async t => {
  const f = await modelSwitchFixture(t); await f.start();
  const before = await f.inference(), generation = f.supervisor.store.getSession(f.sessionId).actorGeneration;
  assert.equal(before.busy, true);
  const start = performance.now();
  const queued = await f.client.request("set_session_inference", { sessionId: f.sessionId,
    provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: "off", expected: before.selection });
  assert(performance.now() - start < 1000);
  assert.equal(queued.pending.model, "gpt-6.1-sol"); assert.equal(queued.selection.model, "gpt-6-astra");
  assert.equal((await f.inference()).selection.model, "gpt-6-astra", "a running tool still owns the old model");
  await f.releaseTool();
  await f.toolFinished();
  assert.equal((await f.inference()).selection.model, "gpt-6-astra", "the provider stream is still immutable");
  f.finishStream(); await f.settled();
  assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, generation);
  assert.deepEqual(f.requests.map(body => body.model), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol"]);
  const entries = await f.entries(), messages = entries.filter(e => e.type === "message").map(e => e.message);
  assert.equal(messages.filter(m => m.role === "user").length, 1);
  assert.equal(messages.filter(m => m.role === "toolResult").length, 2);
  assert(messages.some(m => m.role === "toolResult" && JSON.stringify(m.content).includes("KEPT_NAMESPACE 42")));
  const after = await f.inference(); assert.equal(after.pending, null); assert.equal(after.selection.model, "gpt-6.1-sol");
});
