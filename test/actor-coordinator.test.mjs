import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";
import { createCompactionDriver } from "../src/actor-compaction.mjs";
import { projectVisibleMessage } from "../src/conversation-projection.mjs";
const { loadExternalPi } = await import("../src/external-pi.mjs");
const { sdk, api, core } = await loadExternalPi();
const deferred = () => Promise.withResolvers();
const wait = async (promise, message) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(message)), 5000); timer.unref(); })]);
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
async function fixture(t, { prepareRequest, script, retry, compaction, compactionDriver, hooks } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sc-"));
  const model = { id: "fixture", name: "Fixture", provider: "coordinator-test", api: "coordinator-test-api", reasoning: false,
    input: ["text"], cost: usage().cost, contextWindow: 32000, maxTokens: 1000 };
  const models = await sdk.ModelRuntime.create({ credentials: new api.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const requests = [], events = []; const held = deferred(), toolStarted = deferred(); let runs = 0, coor;
  models.registerProvider(model.provider, { api: model.api, apiKey: "offline-fixture", baseUrl: "https://example.invalid", models: [model],
    streamSimple(_model, context, options = {}) {
      const stream = api.createAssistantMessageEventStream();
      void (async () => {
        await options.onPayload?.({ tools: context.tools?.map(tool => ({ type: "function", name: tool.name })) ?? [] });
        requests.push(structuredClone(context)); const n = requests.length;
        const scripted = script?.(context, n);
        const content = Array.isArray(scripted) ? scripted : scripted?.content ?? (n === 1 ? [{ type: "toolCall", id: "call-one", name: "hold", arguments: {} }] : [{ type: "text", text: "done" }]);
        const message = { role: "assistant", content, provider: model.provider, api: model.api, model: model.id,
          usage: scripted?.usage ?? usage(), timestamp: Date.now(), stopReason: scripted?.stopReason ?? (content.some(p => p.type === "toolCall") ? "toolUse" : "stop"),
          ...(scripted?.errorMessage ? { errorMessage: scripted.errorMessage } : {}) };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", message, reason: message.stopReason });
        stream.end();
      })().catch(error => stream.end());
      return stream;
    } });
  const settings = sdk.SettingsManager.inMemory({ ...(retry ? { retry } : {}), ...(compaction ? { compaction } : {}) });
  const active = new sdk.DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      hooks?.(pi);
      pi.registerTool({ name: "hold", label: "Hold", description: "Held test tool", parameters: { type: "object", properties: {}, additionalProperties: false }, executionMode: "sequential",
        async execute(_id, _args, signal) { runs++; toolStarted.resolve(); await Promise.race([held.promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled actual tool")), { once: true }))]); return { content: [{ type: "text", text: "REAL" }], details: {} }; } });
      pi.on("session_start", () => pi.setActiveTools(["hold"]));
    }] });
  await active.reload();
  const empty = { getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }) };
  for (const name of ["getSkills", "getPrompts", "getThemes", "getAgentsFiles", "getSystemPrompt", "getSystemPromptSource", "getAppendSystemPrompt", "getAppendSystemPromptSources", "extendResources", "reload"]) empty[name] = active[name].bind(active);
  const manager = sdk.SessionManager.inMemory(root);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), model: models.getModel(model.provider, model.id), modelRuntime: models, settingsManager: settings, sessionManager: manager, resourceLoader: empty, tools: [] });
  const loaded = active.getExtensions(); const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, new sdk.ModelRegistry(models));
  coor = new ActorCoordinator({ session, runner, sdk, api, core, models, resources: active, lifecycle: { prepareRequest }, publish: event => events.push(event),
    basePromptOptions: { contextFiles: [], cwd: root }, isProjectTrusted: () => false, compactionDriver });
  await coor.start(); await runner.emit({ type: "session_start", reason: "startup" });
  t.after(async () => { held.resolve(); await coor.close(); await rm(root, { recursive: true, force: true }); });
  return { coor, requests, events, manager, held, toolStarted, runs: () => runs };
}

test("ordinary input keeps real result barrier and compatible canonical events", async t => {
  const f = await fixture(t); assert.equal((await f.coor.submit("start", "auto", [], "durable-input")).outcome, "accepted");
  await wait(f.toolStarted.promise, "tool did not start").catch(error => { throw new Error(`${error.message}; actor=${JSON.stringify(f.coor.getState())}; requests=${f.requests.length}`); });
  assert.equal(f.coor.getState().isStreaming, true); assert.equal(f.requests.length, 1);
  f.held.resolve(); await wait(f.coor.waitForIdle(), "actor did not settle");
  assert.equal(f.requests.length, 2); assert.equal(f.runs(), 1);
  assert.equal(f.requests[1].messages.filter(m => m.role === "toolResult").length, 1);
  assert.equal(f.manager.getBranch().filter(e => e.type === "message" && e.message.role === "user")[0].message.id, "durable-input");
  assert.equal(f.events.filter(e => e.type === "agent_settled").length, 1);
});

for (const outcome of ["success", "failure", "abort"]) test(`compaction ${outcome} releases ordered bookkeeping without changing the in-flight history`, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20 },
    script: () => [{ type: "text", text: "CONTINUED" }], hooks: pi => {
    pi.on("session_before_compact", async event => {
      entered.resolve(); await release.promise;
      if (outcome === "failure") return { cancel: true };
      return { compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 1 } };
    });
  } });
  for (const word of ["old", "recent"]) {
    f.manager.appendMessage({ role: "user", content: `${word} question `.repeat(1000), timestamp: 1 });
    f.manager.appendMessage(f.coor.assistant([{ type: "text", text: `${word} answer `.repeat(1000) }], usage(), "stop"));
  }
  f.coor.compactionDriver = createCompactionDriver({ sdk, core, runner: f.coor.runner, session: f.coor.session, models: f.coor.models, publish: event => f.events.push(event) });
  const original = structuredClone(f.manager.getEntries());
  const compacting = f.coor.compact();
  const completed = compacting.then(() => null, error => error);
  await wait(entered.promise, "compaction hook did not start");
  const writes = [
    f.coor.lifecycle.appendHistoryEntry("persistent-harness.agent-message-v1", { messageId: "child-1", direction: "from", body: "child completed" }),
    f.coor.lifecycle.appendHistoryEntry("persistent-harness-usage", { entryId: "usage-1" }),
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.manager.getEntries(), original, "bookkeeping cannot invalidate the summary snapshot");
  if (outcome === "abort") f.coor.controller.abort();
  release.resolve();
  const error = await completed;
  assert.equal(Boolean(error), outcome !== "success");
  await Promise.all(writes);
  const entries = f.manager.getEntries();
  assert.equal(entries.filter(entry => entry.type === "compaction").length, outcome === "success" ? 1 : 0);
  assert.deepEqual(entries.slice(-2).map(entry => entry.customType), ["persistent-harness.agent-message-v1", "persistent-harness-usage"]);
  assert.equal(f.coor.compactionHistoryBarrier, null);
  await f.coor.submit("continue after compaction"); await wait(f.coor.waitForIdle(), "continuation did not settle");
  assert.equal(f.requests.length, 1);
  assert.equal(f.coor.failure, null);
});

test("automatic compaction failure commits a visible error and a later user input can recover", async t => {
  let attempts = 0;
  const f = await fixture(t, {
    script: (_context, n) => ({ content: [{ type: "text", text: n === 1 ? "BEFORE_COMPACTION" : "RECOVERED" }],
      usage: n === 1 ? { ...usage(), input: 31000, totalTokens: 31001 } : usage() }),
    compactionDriver: async ({ coordinator }) => {
      if (++attempts === 1) throw new Error("fixture summary unavailable");
      const result = { summary: "recovered summary", firstKeptEntryId: coordinator.manager.getBranch()[0].id, tokensBefore: 31001 };
      coordinator.manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore);
      return result;
    },
  });
  await f.coor.submit("start"); await wait(f.coor.waitForIdle(), "failed compaction did not settle");
  const errors = f.manager.getEntries().filter(entry => entry.message?.stopReason === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message.errorMessage, "Conversation compaction failed: fixture summary unavailable");
  assert.equal(projectVisibleMessage(errors[0]).text,
    "This turn stopped because the conversation summary failed. Send another message to retry.");
  assert.equal(f.events.filter(event => event.type === "message_end" && event.message.stopReason === "error").length, 1);
  assert.equal(f.requests.length, 1); assert.equal(attempts, 1, "failure must not automatically loop");
  await f.coor.submit("try again"); await wait(f.coor.waitForIdle(), "retry input did not recover");
  assert.equal(f.requests.length, 2); assert.equal(f.coor.failure, null);
});
test("follow-up waits for the ordinary post-result answer", async t => {
  const f = await fixture(t);
  await f.coor.submit("start"); await wait(f.toolStarted.promise, "tool did not start").catch(error => { throw new Error(`${error.message}; actor=${JSON.stringify(f.coor.getState())}; requests=${f.requests.length}`); });
  await f.coor.submit("FOLLOW", "follow_up"); assert.equal(f.requests.length, 1);
  f.held.resolve(); await wait(f.coor.waitForIdle(), "followup did not settle");
  assert.equal(f.requests.length, 3);
  assert(!JSON.stringify(f.requests[1].messages).includes("FOLLOW")); assert(JSON.stringify(f.requests[2].messages).includes("FOLLOW"));
});
test("service lease queues input without concurrent provider execution", async t => {
  const f = await fixture(t, { script: () => [{ type: "text", text: "done" }] });
  const entered = deferred(), release = deferred();
  const mutation = f.coor.withServiceMutation(async () => { entered.resolve(); await release.promise; });
  await entered.promise; await f.coor.submit("after lease"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0); assert.equal(f.coor.isBusy, true);
  release.resolve(); await mutation; await wait(f.coor.waitForIdle(), "lease input did not settle");
  assert.equal(f.requests.length, 1);
});
test("critical direct preparation rejection never dispatches provider", async t => {
  const f = await fixture(t, { prepareRequest: async () => { throw new Error("flush unavailable"); } });
  await f.coor.submit("blocked"); await wait(f.coor.waitForIdle(), "rejected preparation did not settle");
  assert.equal(f.requests.length, 0); assert.match(f.coor.getState().error, /flush unavailable/);
});

test("ordinary steering stays queued until real result is canonical", async t => {
  const f = await fixture(t); await f.coor.submit("start"); await wait(f.toolStarted.promise, "tool did not start");
  await f.coor.submit("STEERING_WHILE_TOOL", "steer"); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.requests.length, 1);
  assert(!JSON.stringify(f.manager.getBranch()).includes("STEERING_WHILE_TOOL"));
  f.held.resolve(); await wait(f.coor.waitForIdle(), "steering did not settle");
  const messages = f.requests[1].messages; const resultIndex = messages.findIndex(m => m.role === "toolResult");
  const steeringIndex = messages.findIndex(m => m.role === "user" && JSON.stringify(m.content).includes("STEERING_WHILE_TOOL"));
  assert(resultIndex >= 0 && steeringIndex > resultIndex);
});

test("transient failed inference retries with a fresh queued steering snapshot", async t => {
  const f = await fixture(t, { retry: { enabled: true, maxRetries: 2, baseDelayMs: 30 },
    script: (_context, n) => n === 1 ? { content: [], stopReason: "error", errorMessage: "503 overloaded" } : [{ type: "text", text: "recovered" }] });
  await f.coor.submit("start retry");
  while (!f.events.some(e => e.type === "auto_retry_start")) await new Promise(resolve => setTimeout(resolve, 1));
  await f.coor.submit("LATEST_RETRY_INPUT", "steer");
  await wait(f.coor.waitForIdle(), "retry did not settle");
  assert.equal(f.requests.length, 2); assert.equal(f.runs(), 0);
  assert.match(JSON.stringify(f.requests[1].messages), /LATEST_RETRY_INPUT/);
  const records = f.manager.getBranch().filter(e => e.type === "custom" && e.customType === "persistent-harness.inference-retry-v1");
  assert.equal(records.length, 2); assert(records.every(e => e.data.observations.admittedCount === 0 && e.data.decision.retry));
  assert(records[1].data.snapshotVersion > records[0].data.snapshotVersion);
});
test("abort cancels retry delay before another provider request", async t => {
  const f = await fixture(t, { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
    script: () => ({ content: [], stopReason: "error", errorMessage: "503 overloaded" }) });
  await f.coor.submit("start retry");
  while (!f.events.some(e => e.type === "auto_retry_start")) await new Promise(resolve => setTimeout(resolve, 1));
  await wait(f.coor.abort(), "abort did not drain retry");
  assert.equal(f.requests.length, 1); assert.equal(f.coor.isBusy, false);
});


test("context overflow performs one owner-leased compaction and fresh inference without replaying tools", async t => {
  let summaries = 0;
  const f = await fixture(t, {
    script: (_context, n) => n === 1 ? { content: [], stopReason: "error", errorMessage: "context_length_exceeded" } : [{ type: "text", text: "recovered after summary" }],
    compactionDriver: async ({ coordinator, signal, reason, willRetry }) => {
      assert.equal(reason, "overflow"); assert.equal(willRetry, true); assert.equal(signal.aborted, false);
      assert.equal(coordinator.tasks.size, 0); assert.equal(coordinator.flight, null); summaries++;
      return { summary: "Synthetic summary", firstKeptEntryId: coordinator.manager.getBranch()[0].id, tokensBefore: 1 };
    },
  });
  await f.coor.submit("overflow source"); await wait(f.coor.waitForIdle(), "overflow recovery did not settle");
  assert.equal(summaries, 1); assert.equal(f.requests.length, 2); assert.equal(f.runs(), 0);
});

test("a repeated overflow cannot create an unbounded compaction loop", async t => {
  let summaries = 0;
  const f = await fixture(t, { script: () => ({ content: [], stopReason: "error", errorMessage: "context_length_exceeded" }),
    compactionDriver: async () => { summaries++; return { summary: "Synthetic summary", firstKeptEntryId: "fixture", tokensBefore: 1 }; } });
  await f.coor.submit("overflow source"); await wait(f.coor.waitForIdle(), "repeated overflow did not settle");
  assert.equal(summaries, 1); assert.equal(f.requests.length, 2); assert.equal(f.runs(), 0);
});

for (const kind of ["user", "background", "cron"]) test(`first ${kind} follow-up reaches the first request without empty inference`, async t => {
  const f = await fixture(t, { script: () => [{ type: "text", text: "FIRST_REPLY" }] });
  if (kind === "user") await f.coor.submit("FIRST_INTERNAL_INPUT", "follow_up");
  else await f.coor.sendCustom({ customType: `fixture:${kind}`, content: "FIRST_INTERNAL_INPUT", display: true,
    details: { source: kind, inputId: `first-${kind}` } }, { triggerTurn: true, deliverAs: "followUp" });
  await wait(f.coor.waitForIdle(), "first followup did not settle");
  assert.equal(f.coor.failure, null);
  assert.equal(f.requests.length, 1, "No inference may precede the first delivered input");
  assert.match(JSON.stringify(f.requests[0].messages), /FIRST_INTERNAL_INPUT/);
  assert.equal(f.manager.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").length, 1);
  assert.equal(f.runs(), 0);
});
