import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ActorToolDispatch } from "../src/actor-tool-dispatch.mjs";
import { TURN_FAILURE_ENTRY_TYPE, TURN_FAILURE_DIAGNOSTIC_TYPE } from "../src/child-turn-failure.mjs";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";

const gate = () => Promise.withResolvers();
const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Actual coordinator, dispatch, and planner; synthetic native adapter and
// canonical sink. The adapter matches the real aborted-terminal contract.
async function fixture(t) {
  const previous = process.env.PI_HARNESS_NATIVE_ASYNC;
  process.env.PI_HARNESS_NATIVE_ASYNC = "1";
  const entries = [], turns = [], ends = [], receipts = new WeakMap();
  const model = { id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses",
    compat: { supportsAsyncTools: true }, contextWindow: 32000, maxTokens: 1000 };
  let coor, current, run = 0;
  const manager = {
    getBranch: () => entries, getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null,
    appendMessage(message) { const id = `entry-${entries.length}`; entries.push({ id, type: "message", message }); return id; },
    appendCustomEntry(customType, data) { const id = `entry-${entries.length}`; entries.push({ id, type: "custom", customType, data }); return id; },
    buildSessionProjection: () => ({ messages: entries.filter(e => e.message).map(e => e.message) }),
    getSessionId: () => "result-lifetime-fixture",
  };
  const tool = { name: "fixture", async: true, parameters: { type: "object", properties: {} },
    async execute(id, _args, _signal, onUpdate) {
      current.started.resolve();
      if (current.holdUpdate) onUpdate({ content: [{ type: "text", text: "synthetic update" }] });
      if (current.mode.startsWith("late")) await current.release.promise; // Deliberately completes after cancellation.
      const result = { content: [{ type: "text", text: id.padEnd(128 * 1024, "t") },
        { type: "image", mimeType: "image/png", data: "A".repeat(128 * 1024) }],
        details: { text: "d".repeat(128 * 1024) }, structuredContent: { text: "s".repeat(128 * 1024) } };
      return result;
    } };
  const runner = { bindCore() {}, bindCommandContext() {}, createContext: () => ({}),
    getAllRegisteredTools: () => [{ definition: tool }], emitInput: async () => ({ action: "continue" }),
    emitContext: async value => value, emitBeforeProviderRequest: async value => value,
    emitToolCall: async () => undefined, emitToolResult: async () => undefined,
    emitMessageEnd: async ({ message }) => {
      if (message.role === "toolResult") message.details.canonical = true;
    },
    emit: async event => {
      if (event.type === "turn_end") {
        // No observer owns the original payload after delivery.
        turns.push({ run, index: event.turnIndex, ids: event.toolResults.map(r => r.toolCallId),
          details: event.toolResults.map(r => r.details.canonical), stopReason: event.message.stopReason });
        current.firstTurn.resolve();
      }
      if (event.type === "agent_end") {
        ends.push({ run, pending: coor.completedResults.length });
        if (current.rejectEnd) { current.rejectEnd = false; throw new Error("synthetic end hook rejection"); }
      }
    },
  };
  const adapter = { nativeCompletion: event => receipts.get(event) ?? null,
    async *stream(_model, _context, options) {
      await options.onPayload({ tools: [{ type: "function", name: "fixture" }] });
      const first = current.requests++ === 0, hasTool = first && current.mode !== "empty";
      const call = { type: "toolCall", id: `call-${run}|item-${run}`, name: "fixture", arguments: {},
        providerCallId: `call-${run}`, providerItemId: `item-${run}`, async: true };
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: hasTool ? [call] : [{ type: "text", text: "done" }], usage: usage(),
        stopReason: "pending", timestamp: 1, responseId: `response-${run}-${current.requests}` };
      yield { type: "start", partial: message };
      if (hasTool) {
        yield { type: "toolcall_start", contentIndex: 0, partial: message };
        const event = { type: "toolcall_end", contentIndex: 0, partial: message, toolCall: call };
        receipts.set(event, { native: true, complete: true, responseId: message.responseId,
          callId: call.providerCallId, itemId: call.providerItemId, call: structuredClone(call) });
        yield event;
        await (current.mode === "prepare-race" ? current.hookEntered.promise
          : current.mode.startsWith("late") ? current.started.promise : current.committed.promise);
        if (current.mode === "abort") {
          if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
          message.stopReason = "aborted"; message.errorMessage = "request_aborted";
          yield { type: "error", reason: "aborted", error: message }; return;
        }
        // A raw throw covers the coordinator boundary, not the real adapter's
        // transport-error behavior (which emits the error final below).
        if (current.mode === "throw") throw new Error("synthetic generator failure");
        if (current.mode === "error") {
          message.stopReason = "error"; message.errorMessage = "synthetic provider error";
          yield { type: "error", reason: "error", error: message }; return;
        }
      } else if (current.mode === "late") {
        current.continuation.resolve(); await current.finish.promise;
      }
      message.stopReason = hasTool ? "toolUse" : "stop";
      yield { type: "done", reason: message.stopReason, message };
    },
  };
  coor = new ActorCoordinator({ session: { sessionManager: manager, model, systemPrompt: "fixture", thinkingLevel: "off",
    settingsManager: { getRetrySettings: () => ({ enabled: false }), getCompactionSettings: () => ({ enabled: false }) }, dispose() {} },
    runner, nativeAdapter: adapter, models: {}, sdk: { convertToLlm: value => value, wrapRegisteredTool: () => tool },
    api: { validateToolArguments: (_tool, call) => call.arguments, isContextOverflow: () => false,
      isRecoverableLength: () => false, isRetryableAssistantError: () => false }, core: { estimateContextTokens: () => ({ tokens: 1 }) },
    promptCapture: { prepare: async () => ({ systemPrompt: "fixture", systemPromptOptions: {} }) },
    onTiming: event => { if (event.phase === "real_result_committed") current.committed.resolve(); },
    publish: async event => {
      if (event.type === "tool_execution_update" && current.holdUpdate) {
        const owner = current; owner.updateEntered.resolve(); await owner.updateRelease.promise; throw owner.updateError;
      }
      if (event.type === "message_end" && event.message.role === "toolResult" && current.holdCommit) {
        current.appended.resolve(); await current.publish.promise;
      }
    } });
  await coor.start(); coor.activeTools.add("fixture");
  t.after(async () => {
    current?.release.resolve(); current?.publish.resolve(); current?.finish.resolve(); current?.updateRelease.resolve();
    await coor.close();
    if (previous === undefined) delete process.env.PI_HARNESS_NATIVE_ASYNC;
    else process.env.PI_HARNESS_NATIVE_ASYNC = previous;
  });
  return { coor, turns, ends,
    results: () => entries.filter(e => e.message?.role === "toolResult").map(e => e.message),
    async start(mode, options = {}) {
      current = { mode, requests: 0, started: gate(), committed: gate(), release: gate(), firstTurn: gate(),
        continuation: gate(), finish: gate(), appended: gate(), publish: gate(), updateEntered: gate(), updateRelease: gate(), ...options };
      run++; await coor.submit(`run ${run}`); return current;
    },
  };
}

function settled(f) {
  assert.equal(f.coor.tasks.size, 0); assert.equal(f.coor.flight, null); assert.equal(f.coor.running, false);
  assert.equal(f.coor.completedResults.length, 0, "settled runs cannot own undelivered originals");
  assert(f.ends.every(end => end.pending === 0), "release precedes asynchronous end observers");
}

for (const mode of ["abort", "throw"]) test(`${mode}: settled native results never reach a later run`, { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    const state = await f.start(mode, { rejectEnd: i === 0 });
    if (mode === "abort") {
      await state.committed.promise;
      assert.equal(f.coor.completedResults.length, 1);
      const original = f.coor.completedResults[0], canonical = f.results().at(-1);
      assert.notEqual(original.content, canonical.content); assert.notEqual(original.details, canonical.details);
      assert.equal(original.details.canonical, undefined); assert.equal(canonical.details.canonical, true);
      await f.coor.abort();
    } else await f.coor.waitForIdle();
    settled(f); assert.equal(f.results().length, i + 1);
  }
  assert.equal(f.turns.length, 0, "cancellation does not invent turn_end events");
  await f.start("empty"); await f.coor.waitForIdle(); settled(f);
  assert.deepEqual(f.turns.map(turn => turn.ids), [[]]);
  assert.equal(f.results().length, 6); assert.equal(new Set(f.results().map(r => r.toolCallId)).size, 6);
});

test("normal and provider-error finals preserve original result delivery and canonical hooks", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const mode of ["normal", "error"]) { await f.start(mode); await f.coor.waitForIdle(); settled(f); }
  assert.deepEqual(f.turns.map(turn => turn.ids), [["call-1|item-1"], [], ["call-2|item-2"]]);
  assert.deepEqual(f.turns.map(turn => turn.index), [0, 1, 0]);
  assert.deepEqual(f.turns.map(turn => turn.details), [[undefined], [], [undefined]]);
  assert(f.results().every(result => result.details.canonical)); assert.equal(f.results().length, 2);
});

test("late native completion survives an earlier flight and steering within the same run", { timeout: 10000 }, async t => {
  const f = await fixture(t); const state = await f.start("late");
  await state.firstTurn.promise; await tick();
  assert.equal(f.coor.running, true); assert.equal(f.coor.flight, null); assert.equal(f.coor.tasks.size, 1);
  assert.deepEqual(f.turns.map(turn => turn.ids), [[]]);
  await assert.rejects(f.coor.withServiceMutation(async () => {}), /idle actor/);
  await assert.rejects(f.coor.compact(), /compaction requires settled tool results/);
  f.coor.navigationDriver = async () => { assert.fail("a pending task cannot enter navigation"); };
  await assert.rejects(f.coor.navigateTree("unread-tool-view"), /idle actor/);
  await f.coor.submit("steer during the pending native result");
  await state.continuation.promise;
  state.release.resolve(); await state.committed.promise;
  assert.deepEqual(f.coor.completedResults.map(r => r.toolCallId), ["call-1|item-1"]);
  state.finish.resolve(); await f.coor.waitForIdle(); settled(f);
  assert.deepEqual(f.turns.map(turn => turn.ids), [[], ["call-1|item-1"], []]);
  assert.deepEqual(f.turns.map(turn => turn.index), [0, 1, 2]);
  assert.equal(f.ends.length, 1); assert.equal(f.results().length, 1);
});

test("abort waits for a late native result and its canonical publication fence before release", { timeout: 10000 }, async t => {
  const f = await fixture(t); const state = await f.start("late-abort", { holdCommit: true });
  await state.firstTurn.promise; await tick();
  let done = false; const aborted = f.coor.abort().then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(f.coor.tasks.size, 1);
  state.release.resolve(); await state.appended.promise; await tick();
  assert.equal(done, false); assert.equal(f.coor.running, true); assert.equal(f.coor.tasks.size, 1);
  assert.equal(f.results().length, 1, "canonical append already happened exactly once");
  assert.equal(f.coor.completedResults.length, 0, "delivery cannot precede commit publication");
  state.publish.resolve(); await aborted; settled(f);
  assert.equal(f.results().length, 1); assert.deepEqual(f.turns.map(turn => turn.ids), [[]]);
  await f.start("empty"); await f.coor.waitForIdle(); settled(f);
  assert.deepEqual(f.turns.map(turn => turn.ids), [[], []]); assert.equal(f.results().length, 1);
});


test("local preparation journals possible effects before an admitted native task finishes its dispatch hook", { timeout: 10000 }, async t => {
  const f = await fixture(t), hookEntered = gate(), release = gate();
  t.after(() => release.resolve());
  f.coor.runner.emitToolCall = async () => { hookEntered.resolve(); await release.promise; };
  let preparations = 0;
  f.coor.lifecycle.prepareRequest = async () => { if (++preparations === 2) throw new Error("SECRET local preparation"); };
  f.coor.lifecycle.afterCommit = () => { if (f.results().length) throw new TypeError("SECRET secondary rejection"); };
  await f.start("prepare-race", { hookEntered });
  await hookEntered.promise; await f.coor.submit("steer before pending native dispatch");
  while (!f.coor.runFailureReport) await tick();
  assert.equal(f.coor.tasks.size, 1); assert.equal(f.coor.runToolDispatched, false);
  assert.equal(f.coor.runFailureReport.dispatchBoundary, "tool_effects_possible");
  release.resolve(); await f.coor.waitForIdle(); settled(f);
  assert.equal(f.results().length, 1);
  const reports = f.coor.manager.getEntries().filter(entry => entry.customType === TURN_FAILURE_ENTRY_TYPE);
  assert.equal(reports.length, 1); assert.equal(reports[0].data.dispatchBoundary, "tool_effects_possible");
  assert.doesNotMatch(JSON.stringify(reports[0].data), /SECRET|steer/);
  const diagnostics = f.coor.manager.getEntries().filter(e => e.customType === TURN_FAILURE_DIAGNOSTIC_TYPE);
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].data.errorCode, "ERR_LOCAL_PREPARATION");
  assert.equal(diagnostics[0].data.origin, "drive_rejection"); assert.equal(diagnostics[0].data.resultAppended, false);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|steer/);
});

test("tool session values stay borrowed through nested drain; exposed arrays survive source release", async () => {
  const { core, sdk } = await (await import("../src/external-pi.mjs")).loadExternalPi();
  for (const expose of [false, true]) {
    const entered = gate(), released = gate(), leafEntered = gate(), leafReleased = gate();
    let generation = 0, reads = 0, context, exposed, dispatch;
    const captured = generation;
    const original = [{ role: "user", content: "SDK raw public value", timestamp: 1 }];
    const source = { readAll() {
      assert.equal(generation, captured); reads++;
      return structuredClone(original);
    } };
    const definitions = [
      { name: "nested", exposure: "codemode", parameters: { type: "object", properties: {} },
        async execute(id) {
          entered.resolve(); await released.promise;
          const result = await dispatch.execute(id, "leaf", {});
          return result.result;
        } },
      { name: "leaf", exposure: "codemode", parameters: { type: "object", properties: {} },
        async execute() { leafEntered.resolve(); await leafReleased.promise; return { content: [{ type: "text", text: "real" }] }; } },
    ];
    const runner = { getAllRegisteredTools: () => definitions.map(definition => ({ definition })),
      createToolContext: () => ({}), emitToolCall: async () => undefined, emitToolResult: async () => undefined };
    dispatch = new ActorToolDispatch({ runner, sdk, activeTools: () => new Set(), emit: async () => {},
      core: { runToolCall(call, options) {
        context ??= options.context;
        if (expose && !exposed) {
          exposed = context.messages;
          exposed.push({ role: "user", content: "owned public mutation", timestamp: 2 });
        }
        return core.runToolCall(call, options);
      } } });
    dispatch.open("parent", new AbortController().signal, { role: "assistant", content: [], timestamp: 1 }, undefined, { messageSource: source });
    const outcome = dispatch.execute("parent", "nested", {});
    await entered.promise;
    assert.equal(reads, expose ? 1 : 0, "actual core and public tool callbacks do not force messages");
    let finished = false;
    const finishing = dispatch.finish("parent").then(result => { finished = true; return result; });
    released.resolve(); await leafEntered.promise;
    assert.equal(finished, false, "the source owner survives descendant calls started during drain");
    assert.equal(dispatch.scopes.has("parent"), true);
    leafReleased.resolve(); await outcome; await finishing;
    assert.equal(dispatch.scopes.size, 0);
    generation++;
    if (expose) {
      assert.equal(context.messages, exposed);
      assert.deepEqual(context.messages, [...original, { role: "user", content: "owned public mutation", timestamp: 2 }]);
      assert.equal(reads, 1, "owned public data no longer depends on the expired borrowed plan");
    } else {
      assert.equal(reads, 0);
      assert.throws(() => context.messages, /no longer borrowed/, "an unexposed plan cannot outlive its scope");
    }
  }
});


test("late callback rejection from an older run cannot own the current run diagnostic", { timeout: 10000 }, async t => {
  const f = await fixture(t), oldError = new RangeError("PRIVATE_OLD"), currentError = new TypeError("PRIVATE_CURRENT");
  const previous = await f.start("normal", { holdUpdate: true, updateError: oldError });
  t.after(() => previous.updateRelease.resolve());
  await previous.updateEntered.promise; await f.coor.waitForIdle(); const oldTurn = f.coor.runId;
  const next = await f.start("late"); await next.firstTurn.promise;
  await f.coor.submit("steer current run while its native result is pending"); await next.continuation.promise;
  const currentTurn = f.coor.runId; assert.notEqual(currentTurn, oldTurn);
  previous.updateRelease.resolve();
  while (f.coor.failure !== oldError) await tick();
  assert.equal(f.coor.runFailureDiagnostic, null, "an old scoped callback is not a current-run cause");
  let armed = true;
  f.coor.lifecycle.afterCommit = () => { if (armed && f.results().some(r => r.toolCallId === "call-2|item-2")) { armed = false; throw currentError; } };
  next.release.resolve(); next.finish.resolve(); await f.coor.waitForIdle();
  const entries = f.coor.manager.getEntries(), diagnostics = entries.filter(e => e.customType === TURN_FAILURE_DIAGNOSTIC_TYPE);
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].data.turnId, currentTurn);
  assert.equal(diagnostics[0].data.origin, "tool_tail_rejection"); assert.equal(diagnostics[0].data.operation, "after_commit");
  assert.equal(diagnostics[0].data.errorKind, "type_error"); assert.equal(diagnostics[0].data.resultAppended, true);
  assert.equal(diagnostics[0].data.resultCommitFinished, false); assert.equal(f.results().length, 2);
  assert(f.results().every(r => r.isError === false)); assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
});


test("a tool-originated drive queues a fresh run without inheriting the old result state", { timeout: 10000 }, async t => {
  const f = await fixture(t); let queued = false, firstTurn;
  f.coor.compactionDriver = async () => assert.fail("must not compact");
  f.coor.session.settingsManager.getCompactionSettings = () => ({ enabled: true });
  f.coor.session.getContextUsage = () => undefined;
  f.coor.automaticCompactionAllowed = () => {
    if (queued && f.coor.runId !== firstTurn) throw new TypeError("PRIVATE_NEW_RUN_THRESHOLD");
    return true;
  };
  const emit = f.coor.runner.emit;
  f.coor.runner.emit = async event => {
    await emit(event);
    if (event.type === "agent_settled" && !queued) {
      queued = true; await f.coor.submit("queued next logical run at previous settlement");
    }
  };
  const state = await f.start("late"); await state.firstTurn.promise; firstTurn = f.coor.runId;
  state.finish.resolve(); state.release.resolve(); await f.coor.waitForIdle();
  const entries = f.coor.manager.getEntries(), diagnostic = entries.find(e => e.customType === TURN_FAILURE_DIAGNOSTIC_TYPE).data;
  const report = entries.find(e => e.customType === TURN_FAILURE_ENTRY_TYPE).data;
  assert.notEqual(diagnostic.turnId, firstTurn); assert.equal(diagnostic.turnId, report.turnId);
  assert.equal(diagnostic.origin, "drive_rejection"); assert.equal(diagnostic.operation, "threshold_preflight");
  assert.equal(diagnostic.resultAppended, false); assert.equal(diagnostic.resultCommitFinished, false);
  assert.equal(diagnostic.flightPresent, false); assert.equal(diagnostic.toolWorkPresent, false);
  assert.equal(report.dispatchBoundary, "before_provider_dispatch"); assert.equal(f.results().length, 1);
  assert.equal(f.results()[0].isError, false);
});
