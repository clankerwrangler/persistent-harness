import assert from "node:assert/strict";
import test from "node:test";
import { modelSwitchFixture, followUpBoundaryFixture } from "./fixtures/model-switch.mjs";
import { until } from "./fixtures/slim-stream.mjs";

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


test("real native answer admits explicit follow-up with concurrent auto input exactly once", { timeout: 90_000 }, async t => {
  const f = await followUpBoundaryFixture(t); const original = await f.start();
  const follow = await f.queue("OLDER_FOLLOW", "follow_up", "boundary-follow");
  const auto = await f.queue("NEWER_AUTO", "auto", "boundary-auto");
  assert.equal(f.requests.length, 1);
  f.finishAnswer(0);
  await until(() => f.requests.length === 2, "both queued inputs reach the next request");
  const next = JSON.stringify(f.requests[1].input);
  assert(next.indexOf("OLDER_FOLLOW") >= 0 && next.indexOf("OLDER_FOLLOW") < next.indexOf("NEWER_AUTO"));
  f.finishAnswer(1); await f.settled();
  const users = (await f.entries()).filter(entry => entry.message?.role === "user");
  assert.deepEqual(users.map(entry => entry.message.id), [original.inputId, follow.inputId, auto.inputId]);
  for (const receipt of [follow, auto]) assert.equal(f.supervisor.store.getActorInput(receipt.inputId, f.sessionId).state, "completed");
  assert.equal(f.requests.length, 2);
});

test("real native follow-up waits for unfinished tools and their post-result answer despite auto input", { timeout: 90_000 }, async t => {
  const f = await modelSwitchFixture(t, { maxRequests: 5, readNamespaceOnContinuation: false, holdContinuationResponse: true });
  await f.start();
  const follow = await f.client.request("submit_input", { sessionId: f.sessionId, message: "DEFERRED_FOLLOW", behavior: "follow_up", clientRequestId: "native-follow" });
  const firstAuto = await f.client.request("submit_input", { sessionId: f.sessionId, message: "FIRST_NATIVE_STEER", behavior: "auto", clientRequestId: "first-native-auto" });
  await until(() => f.supervisor.store.getActorInput(firstAuto.inputId, f.sessionId)?.state === "accepted", "first steering input reaches the queue");
  f.finishStream();
  await until(() => f.requests.length === 2, "native continuation with a pending tool");
  const secondAuto = await f.client.request("submit_input", { sessionId: f.sessionId, message: "NATIVE_AUTO", behavior: "auto", clientRequestId: "native-auto" });
  await until(() => f.supervisor.store.getActorInput(secondAuto.inputId, f.sessionId)?.state === "accepted", "second steering input reaches the queue");
  f.finishContinuation(); await until(() => f.requests.length === 3, "auto input before the held tool finishes");
  assert(f.requests.slice(0, 3).every(request => !JSON.stringify(request.input).includes("DEFERRED_FOLLOW")));
  assert.equal(f.rawEvents.filter(event => event.type === "message_end" && event.message?.role === "toolResult").length, 0);
  await f.releaseTool(); await f.toolFinished(); await f.settled();
  assert.match(JSON.stringify(f.requests[3].input), /HOLD_DONE 41/);
  assert(!JSON.stringify(f.requests[3].input).includes("DEFERRED_FOLLOW"), "newly committed results still get their own answer first");
  assert.match(JSON.stringify(f.requests[4].input), /DEFERRED_FOLLOW/);
  assert.equal(f.requests.length, 5);
  assert.equal(f.rawEvents.filter(event => event.type === "tool_execution_start").length, 1);
  assert.equal((await f.entries()).filter(entry => entry.message?.id === follow.inputId).length, 1);
});
