import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";
import { loadExternalPi } from "../src/external-pi.mjs";
import { createNativeProviderAdapter } from "../src/native-provider.mjs";
import { projectCanonicalContext } from "../src/canonical-context.mjs";

// One explicitly selected stock 0.85.1 public SDK/API/core graph; no install fallback.
const { sdk, api, core, responsesApi } = await loadExternalPi();
process.env.PI_HARNESS_ACTOR_ID = "wait-private-fixture";
process.env.PI_HARNESS_ACTOR_TOKEN = "private-fixture-not-a-credential";
process.env.PI_HARNESS_ACTOR_GENERATION = "1";
const { default: extension, extensionInternals } = await import("../src/extension.mjs");
const model = { id: "gpt-6-astra", name: "Private deterministic wait fixture", api: "openai-codex-responses",
  provider: "openai-codex", baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 2048,
  compat: { supportsAsyncTools: true } };
const syntheticKey = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const gate = () => Promise.withResolvers();
const result = text => ({ content: [{ type: "text", text }], details: {} });
const nativeCall = { type: "function_call", id: "original-python-item", call_id: "original-python-call", name: "ipython",
  arguments: '{"code":"original"}', status: "completed", async: true };
const waitCall = { type: "function_call", id: "single-wait-item", call_id: "single-wait-call", name: "wait_for_ipython",
  arguments: "{}", status: "completed" };
const canonicalId = item => `${item.call_id}|${item.id}`;
function registeredWait() {
  const tools = new Map();
  extension({ registerTool: t => tools.set(t.name, t), registerCommand() {}, registerMessageRenderer() {}, on() {} });
  return tools.get("wait_for_ipython");
}

for (const state of ["pending", "already-settled"]) for (const newerSteer of [false, true]) {
  test(`${state}: one wait resumes original results and useful work${newerSteer ? " after the newer steer" : ""}`, { timeout: 10000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stock-wait-"));
    const previousNative = process.env.PI_HARNESS_NATIVE_ASYNC;
    process.env.PI_HARNESS_NATIVE_ASYNC = "1";
    // The only provider I/O is the injected in-memory SSE response below.
    t.mock.method(globalThis, "fetch", () => { throw new Error("wait fixture network denied"); });
    const started = gate(), release = gate(), originalPublished = gate();
    const counts = { original: 0, next: 0, waits: 0, requests: 0 };
    const observed = [], requests = [], wireRequests = [];
    let coor, nativeAdapter, session, originalDone = false, pendingAtWaitPublication, fixtureError;
    t.after(async () => {
      release.resolve(); started.resolve(); originalPublished.resolve();
      await coor?.close(); await nativeAdapter?.close(); session?.dispose();
      if (previousNative === undefined) delete process.env.PI_HARNESS_NATIVE_ASYNC;
      else process.env.PI_HARNESS_NATIVE_ASYNC = previousNative;
      await rm(root, { recursive: true, force: true });
    });
    const wait = registeredWait();
    assert.equal(wait.async, undefined);
    const waitExecute = wait.execute;
    wait.execute = async (...args) => {
      counts.waits++;
      assert.equal(originalDone, true, "the same native owner must settle the original call before waiting completes");
      assert.equal(counts.requests, 1, "wait is a barrier, not an extra provider wakeup");
      const originals = canonicalMessages().filter(m => m.role === "toolResult" && m.toolCallId === canonicalId(nativeCall));
      assert.equal(originals.length, 1, "the real original result must be canonical before wait executes");
      assert.equal(originals[0].content[0].text, "ORIGINAL_REAL_RESULT");
      return waitExecute(...args);
    };
    const nextCall = { type: "function_call", id: "useful-next-item", call_id: "useful-next-call", name: "ipython",
      arguments: JSON.stringify({ code: newerSteer ? "newer-next-step" : "next-step" }), status: "completed" };
    const python = { name: "ipython", label: "Private fixture execution", description: "Test-owned execution counter",
      parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
      async: true, executionMode: "sequential", execute: async (id, args) => {
        if (args.code === "original") {
          assert.equal(id, canonicalId(nativeCall)); counts.original++; started.resolve(); await release.promise;
          originalDone = true; return result("ORIGINAL_REAL_RESULT");
        }
        assert.equal(id, canonicalId(nextCall));
        assert.equal(args.code, newerSteer ? "newer-next-step" : "next-step");
        assert.equal(originalDone, true); counts.next++; return result("USEFUL_STEP_COMPLETE");
      } };
    const models = await sdk.ModelRuntime.create({ credentials: new api.InMemoryCredentialStore(), modelsStore: new api.InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const denied = () => { throw new Error("wait fixture ordinary provider fallback denied"); };
    models.registerNativeProvider(api.createProvider({ id: model.provider, models: [model],
      auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: syntheticKey } }) } },
      api: { stream: denied, streamSimple: denied } }));
    const settings = sdk.SettingsManager.inMemory({ transport: "sse", retry: { enabled: false }, compaction: { enabled: false } });
    const resources = new sdk.DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: extensionInternals.skillPrompt([], true),
      extensionFactories: [pi => {
        pi.registerTool(python); pi.registerTool(wait);
        pi.on("session_start", () => pi.setActiveTools(["ipython", "wait_for_ipython"]));
      }] });
    await resources.reload();
    // The stock session is a dormant public service shell; only this coordinator runs tools.
    const empty = { getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }) };
    for (const name of ["getSkills", "getPrompts", "getThemes", "getAgentsFiles", "getSystemPrompt", "getSystemPromptSource",
      "getAppendSystemPrompt", "getAppendSystemPromptSources", "extendResources", "reload"]) empty[name] = resources[name].bind(resources);
    const manager = sdk.SessionManager.inMemory(root);
    ({ session } = await sdk.createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), model: models.getModel(model.provider, model.id),
      modelRuntime: models, settingsManager: settings, sessionManager: manager, resourceLoader: empty, tools: [] }));
    const loaded = resources.getExtensions();
    const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, new sdk.ModelRegistry(models));
    const canonicalMessages = () => manager.getBranch().filter(e => e.type === "message").map(e => e.message);
    nativeAdapter = createNativeProviderAdapter({ api, responsesApi, modelRuntime: models, transportOptions: {
      fetch: async (_url, init) => {
        const n = ++counts.requests;
        const body = JSON.parse(init.body); wireRequests.push(body);
        const messages = structuredClone(coor.projectedMessages()); requests.push(messages);
        const stream = new ReadableStream({ start(controller) {
          const send = event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          const done = (item, output_index) => send({ type: "response.output_item.done", response_id: `wait-response-${n}`, output_index, item });
          const terminal = output => {
            send({ type: "response.completed", response: { id: `wait-response-${n}`, status: "completed", output,
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
            controller.close();
          };
          void (async () => {
            assert.equal(body.tools.find(tool => tool.name === "ipython").async, true);
            assert.equal(body.tools.find(tool => tool.name === "wait_for_ipython").async, undefined);
            send({ type: "response.created", response: { id: `wait-response-${n}`, status: "in_progress" } });
            if (n === 1) {
              done(nativeCall, 0);
              await started.promise; // Proves original execution starts from raw provenance BEFORE terminal/wait.
              if (state === "already-settled") { release.resolve(); await originalPublished.promise; }
              if (newerSteer) await coor.submit("NEWER_PRIVATE_FIXTURE_STEP", "steer", [], "private-fixture-steer");
              pendingAtWaitPublication = !originalDone;
              done(waitCall, 1); terminal([nativeCall, waitCall]);
              if (state === "pending") {
                await tick();
                assert.equal(counts.waits, 0, "wait must not execute ahead of pending original Python");
                assert.equal(counts.requests, 1, "no inference while the wait barrier is unresolved");
                release.resolve();
              }
            } else if (n === 2) {
              const originals = messages.filter(m => m.role === "toolResult" && m.toolCallId === canonicalId(nativeCall));
              const waits = messages.filter(m => m.role === "toolResult" && m.toolCallId === canonicalId(waitCall));
              assert.equal(originals.length, 1); assert.equal(waits.length, 1);
              assert.equal(originals[0].content[0].text, "ORIGINAL_REAL_RESULT");
              assert.equal(waits[0].content[0].text, "Prior Python calls have settled. Read their original results and continue.");
              assert.equal(messages.some(m => m.id === "private-fixture-steer"), newerSteer);
              assert.equal(JSON.stringify(body.input).includes("NEWER_PRIVATE_FIXTURE_STEP"), newerSteer);
              for (const item of [nativeCall, waitCall]) {
                const rawCall = body.input.filter(input => input.type === "function_call" && input.call_id === item.call_id);
                const outputs = body.input.filter(input => input.type === "function_call_output" && input.call_id === item.call_id);
                assert.equal(rawCall.length, 1); assert.equal(rawCall[0].id, item.id); assert.equal(outputs.length, 1);
                assert.equal(outputs[0].output, item === nativeCall ? "ORIGINAL_REAL_RESULT" : waits[0].content[0].text);
              }
              // No returned async marker: the next tool remains an ordinary terminal barrier.
              terminal([nextCall]);
            } else {
              assert.equal(n, 3, "no extra empty inference, wakeup, or nudge");
              const next = messages.filter(m => m.role === "toolResult" && m.toolCallId === canonicalId(nextCall));
              assert.equal(next.length, 1); assert.equal(next[0].content[0].text, "USEFUL_STEP_COMPLETE");
              const nextOutputs = body.input.filter(input => input.type === "function_call_output" && input.call_id === nextCall.call_id);
              assert.equal(nextOutputs.length, 1); assert.equal(nextOutputs[0].output, "USEFUL_STEP_COMPLETE");
              terminal([{ type: "message", id: "complete-message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "COMPLETE", annotations: [] }] }]);
            }
          })().catch(error => { fixtureError = error; release.resolve(); controller.error(error); });
        } });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    } });
    coor = new ActorCoordinator({ session, runner, sdk, api, core, models, nativeAdapter, resources,
      projectContext: projectCanonicalContext, basePromptOptions: { contextFiles: [], cwd: root }, isProjectTrusted: () => false,
      publish: event => {
        observed.push(structuredClone(event));
        if (event.type === "message_end" && event.message?.toolCallId === canonicalId(nativeCall)) originalPublished.resolve();
      } });
    await coor.start(); await runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await coor.submit("Private local fixture task", "auto", [], "private-fixture-task")).outcome, "accepted");
    await coor.waitForIdle(); await tick(); await coor.waitForIdle();
    if (fixtureError) throw fixtureError;
    assert.equal(coor.getState().error, undefined);
    assert.deepEqual(counts, { original: 1, next: 1, waits: 1, requests: 3 });
    assert.equal(pendingAtWaitPublication, state === "pending");
    for (const type of ["agent_start", "agent_end", "agent_settled"]) assert.equal(observed.filter(e => e.type === type).length, 1);
    const messages = canonicalMessages();
    const calls = messages.filter(m => m.role === "assistant").flatMap(m => m.content.filter(p => p.type === "toolCall"));
    assert.deepEqual(calls.map(call => call.id), [nativeCall, waitCall, nextCall].map(canonicalId));
    assert.deepEqual(calls.map(call => call.async), [true, undefined, undefined]);
    for (const [index, item] of [nativeCall, waitCall, nextCall].entries()) {
      assert.equal(calls[index].providerCallId, item.call_id); assert.equal(calls[index].providerItemId, item.id);
      const results = messages.filter(m => m.role === "toolResult" && m.toolCallId === canonicalId(item));
      assert.equal(results.length, 1); assert.equal(results[0].isError, false);
    }
    assert.deepEqual(observed.filter(e => e.type === "tool_execution_start").map(e => e.toolCallId), [nativeCall, waitCall, nextCall].map(canonicalId));
    const originalIndex = messages.findIndex(m => m.role === "toolResult" && m.toolCallId === canonicalId(nativeCall));
    const waitIndex = messages.findIndex(m => m.role === "toolResult" && m.toolCallId === canonicalId(waitCall));
    assert(originalIndex < waitIndex);
    if (newerSteer) assert(messages.findIndex(m => m.id === "private-fixture-steer") > waitIndex);
    assert.equal(messages.filter(m => m.id === "private-fixture-task").length, 1);
    assert.equal(messages.at(-1).content[0].text, "COMPLETE");
    assert.equal(requests.length, 3); assert.equal(wireRequests.length, 3);
  });
}
