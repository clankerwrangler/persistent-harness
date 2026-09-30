import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadExternalPi } from "../src/external-pi.mjs";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";
import { projectCanonicalContext } from "../src/canonical-context.mjs";
import { createAgentStartPromptCapture } from "../src/actor-prompt.mjs";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";
import { extensionInternals } from "../src/extension.mjs";
import { NESTED_LIMITS } from "../src/actor-tool-dispatch.mjs";

const { sdk, api, core } = await loadExternalPi();
const packageRoot = path.resolve(import.meta.dirname, "..");
const usage = n => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: n,
  cost: { input: n / 100, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 100 } });
const object = properties => ({ type: "object", properties, additionalProperties: false });
const wait = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("fixture did not settle")), 15000); timer.unref();
})]);

async function fixture(t, { cells = [], configure = () => {}, grant = true } = {}) {
  t.mock.method(globalThis, "fetch", () => { throw new Error("fixture forbids network"); });
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-tool-skill-"));
  const catalog = await discoverSkills(grant ? [{ source: "skill", path: path.join(packageRoot, "skills/clm/SKILL.md") }] : []);
  assert.deepEqual(catalog.diagnostics, []);
  const manifest = manifestForSkills(catalog.skills);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(dir, "runtime") }).ensure({ skills: [], consent: async () => false });
  const kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(packageRoot, "python-runtime/kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: dir, stateDir: path.join(dir, "state"), manifest, hostHandlers: {} });
  const model = { id: "fixture", name: "Fixture", provider: "tool-skill-fixture", api: "tool-skill-fixture-api", reasoning: false,
    input: ["text"], cost: usage(0).cost, contextWindow: 32000, maxTokens: 1000 };
  const models = await sdk.ModelRuntime.create({ credentials: new api.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  const requests = [], events = [], contexts = [], errors = [];
  models.registerProvider(model.provider, { api: model.api, apiKey: "offline", baseUrl: "https://example.invalid", models: [model],
    streamSimple(_model, context) {
      requests.push(structuredClone(context));
      const n = requests.length;
      const content = n <= cells.length ? [{ type: "toolCall", id: `cell-${n}`, name: "ipython", arguments: { code: cells[n - 1] } }] : [{ type: "text", text: "DONE" }];
      const message = { role: "assistant", content, provider: model.provider, api: model.api, model: model.id, usage: usage(0),
        timestamp: Date.now(), stopReason: n <= cells.length ? "toolUse" : "stop" };
      const stream = api.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", message, reason: message.stopReason }); stream.end(); return stream;
    } });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  const promptCapture = createAgentStartPromptCapture();
  const loader = options => new sdk.DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, ...options });
  const active = loader({ extensionsOverride: promptCapture.orderLast, extensionFactories: [pi => {
    pi.registerTool({ name: "ipython", label: "Python", description: "Python fixture", exposure: "model-only", executionMode: "sequential",
      parameters: { ...object({ code: { type: "string" } }), required: ["code"] },
      async execute(_id, { code }, signal, onUpdate, ctx) {
        contexts.push(ctx);
        return extensionInternals.pythonToolResult(await kernel.execute(code, { signal, toolContext: ctx,
          onUpdate: partial => onUpdate({ content: [{ type: "text", text: partial.stdout }], details: partial }) }));
      } });
    configure(pi);
    pi.on("tool_result", event => { if (event.toolName === "ipython") return { isError: event.details?.ok === false }; });
    pi.on("session_start", () => pi.setActiveTools(["ipython"]));
  }, promptCapture.extension] });
  const dormant = loader({}); await active.reload(); await dormant.reload();
  assert.deepEqual(active.getExtensions().errors, []);
  const manager = sdk.SessionManager.inMemory(dir);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: path.join(dir, "agent"), model: models.getModel(model.provider, model.id),
    modelRuntime: models, settingsManager: settings, sessionManager: manager, resourceLoader: dormant, tools: [] });
  const loaded = active.getExtensions();
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, dir, manager, new sdk.ModelRegistry(models));
  runner.onError(error => errors.push(error));
  const coor = new ActorCoordinator({ session, runner, sdk, api, core, models, resources: active, promptCapture, projectContext: projectCanonicalContext, publish: event => events.push(event),
    basePromptOptions: { cwd: dir, contextFiles: [], appendSystemPrompt: extensionInternals.skillPrompt(manifest.skills) } });
  await coor.start(); await runner.emit({ type: "session_start", reason: "startup" });
  t.after(async () => { await coor.close(); await kernel.close({ snapshot: false }); await rm(dir, { recursive: true, force: true }); });
  return { coor, kernel, manager, manifest, requests, events, contexts, errors };
}

function tool(pi, name, exposure, execute, parameters = object({})) {
  pi.registerTool({ name, label: name, description: `UNRELATED_SCHEMA_${name}`, exposure, parameters, execute });
}

const annotationParameters = { ...object({ action: { type: "string" }, source: { type: "string" }, title: { type: "string" },
  reason: { type: "string" }, futureAction: { type: "string" }, retention: { type: "string" }, id: { type: "string" }, resolution: { type: "string" } }), required: ["action"] };

test("dedicated companion skill invokes exact grants through ordinary replay gates, real Python, and native hooks", { timeout: 30000 }, async t => {
  const executions = [], hooks = [];
  const f = await fixture(t, { cells: [String.raw`
from _persistent_harness import host_request
assert not hasattr(clm, "host_request")
assert not hasattr(clm, "call") and not hasattr(clm, "describe") and not hasattr(clm, "list")
a = clm.annotate("create", source="entry", title="Title", reason="Reason", future_action="Next", retention="continuity")
assert a["isError"] is False and a["result"]["structuredContent"] == {"retained": True}
b = clm.recall("redact", max_tokens=512)
assert b["isError"] is False and "structuredContent" not in b["result"] and b["result"]["content"][0]["text"] == "REDACTED"
assert clm.annotate("blocked")["isError"] is True
assert clm.annotate({})["isError"] is True
for name in ["unrelated_code", "unrelated_deferred", "ipython"]:
    try:
        host_request("extension_tool." + name, {})
        raise AssertionError("ungranted operation ran")
    except RuntimeError as error:
        assert "not granted" in str(error)
print("EXACT_OPERATIONS_PASSED")`], configure(pi) {
    tool(pi, "live_context_annotate", "codemode", async (_id, args, _signal, onUpdate) => {
      executions.push(args); onUpdate({ content: [{ type: "text", text: "PROGRESS" }], details: {} });
      return { content: [{ type: "text", text: "CREATED" }], details: { source: args.source }, structuredContent: { retained: true }, usage: usage(2) };
    }, annotationParameters);
    tool(pi, "live_context_recall", "deferred", async () => ({ content: [{ type: "text", text: "PRIVATE" }],
      structuredContent: { private: true }, details: {}, usage: usage(3) }), { ...object({ id: { type: "string" }, maxTokens: { type: "number" } }), required: ["id"] });
    for (const [name, exposure] of [["unrelated_code", "codemode"], ["unrelated_deferred", "deferred"]])
      tool(pi, name, exposure, async () => { throw new Error("must not execute unrelated tool"); });
    pi.on("tool_call", event => { hooks.push(event); if (event.input.action === "blocked") return { block: true, reason: "blocked by fixture" }; });
    pi.on("tool_result", event => { if (event.toolName === "live_context_recall") return { content: [{ type: "text", text: "REDACTED" }] }; });
  } });
  await f.coor.submit("test"); await wait(f.coor.waitForIdle());
  assert.equal(f.coor.failure, null, "admitted tool execution must not require a completed provider transcript");
  const results = f.manager.getBranch().filter(entry => entry.message?.role === "toolResult").map(entry => entry.message);
  assert.equal(results.length, 1, "only outer native result is canonical");
  assert.match(results[0].details.stdout, /EXACT_OPERATIONS_PASSED/);
  assert.equal(results[0].details.ok, true);
  assert.equal(results[0].isError, false); assert.equal(results[0].usage.input, 5);
  assert.deepEqual(results[0].nestedCalls.calls.map(call => call.status), ["ok", "ok", "error", "error"]);
  assert.equal(results[0].nestedCalls.complete, true);
  assert.equal(executions.length, 1); assert.equal(executions[0].futureAction, "Next");
  assert.ok(hooks.filter(event => event.toolName !== "ipython").every(event => event.parentToolCallId === "cell-1"));
  assert.ok(f.events.some(event => event.type === "tool_execution_update" && event.parentToolCallId === "cell-1"));
  assert.deepEqual(f.manifest.skills.map(skill => skill.alias), ["clm"]);
  for (const request of f.requests) {
    assert.deepEqual(request.messages.find(message => message.role === "system").toolsAdded.map(tool => tool.name), ["ipython"]);
    assert.doesNotMatch(request.messages.find(message => message.role === "system").content, /UNRELATED_SCHEMA_|live_context_annotate|live_context_recall|extension_tools/);
  }
  assert.deepEqual(f.errors, []);
  const stale = await f.contexts[0].executeTool("live_context_annotate", { action: "create" });
  assert.equal(stale.isError, true); assert.equal(executions.length, 1);
});

for (const exposure of ["direct", "model-only", "hidden"]) test(`exact grant cannot bypass ${exposure} callable policy`, { timeout: 30000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { cells: ['assert clm.annotate("list")["isError"] is True\nprint("DENIED")'], configure(pi) {
    tool(pi, "live_context_annotate", exposure, async () => { calls++; return { content: [], details: {} }; }, annotationParameters);
  } });
  await f.coor.submit("test"); await wait(f.coor.waitForIdle());
  assert.equal(calls, 0);
  assert.match(JSON.stringify(f.manager.getEntries()), /DENIED/);
  assert.equal(f.manager.getBranch().find(entry => entry.message?.role === "toolResult").message.isError, false);
});

test("an uninstalled companion grants nothing, and missing per-cell context fails closed", { timeout: 30000 }, async t => {
  const absent = await fixture(t, { grant: false });
  assert.deepEqual((await absent.kernel.start()).skills, []);
  let result = await absent.kernel.execute('from _persistent_harness import host_request\nhost_request("extension_tool.live_context_annotate", {})', {
    toolContext: { executeTool() { throw new Error("ungranted dispatch"); } },
  });
  assert.equal(result.ok, false); assert.match(result.error, /not granted/);
  const present = await fixture(t);
  result = await present.kernel.execute('clm.annotate("list")');
  assert.equal(result.ok, false); assert.match(result.error, /live tool-owned Python cell/);
});

test("bounded outcomes fail explicitly after one execution without retry", { timeout: 30000 }, async t => {
  let calls = 0;
  const f = await fixture(t, { cells: [String.raw`
try:
    clm.annotate("list")
    raise AssertionError("oversized outcome accepted")
except RuntimeError as error:
    assert "completed" in str(error) and "do not retry" in str(error)
print("BOUNDED")`], configure(pi) {
    tool(pi, "live_context_annotate", "codemode", async () => { calls++; return { content: [{ type: "text", text: "x".repeat(600000) }], details: {}, usage: usage(7) }; }, annotationParameters);
  } });
  await f.coor.submit("test"); await wait(f.coor.waitForIdle());
  assert.equal(calls, 1);
  const result = f.manager.getBranch().find(entry => entry.message?.role === "toolResult").message;
  assert.match(JSON.stringify(result.content), /BOUNDED/); assert.equal(result.usage.input, 7); assert.equal(result.nestedCalls.calls[0].status, "ok");
});

test("nested records remain bounded while all nested usage is counted", { timeout: 30000 }, async t => {
  const f = await fixture(t, { configure(pi) { tool(pi, "counter", "codemode", async () => ({ content: [], details: {}, usage: usage(1) }), object({ data: { type: "string" } })); } });
  const dispatch = f.coor.toolDispatch, signal = new AbortController().signal;
  dispatch.open("outer", signal, f.coor.assistant([]), []);
  await dispatch.execute("outer", "counter", { data: "x".repeat(9000) });
  for (let i = 0; i < NESTED_LIMITS.calls; i++) await dispatch.execute("outer", "counter", {});
  const summary = await dispatch.finish("outer");
  assert.equal(summary.nestedCalls.calls.length, NESTED_LIMITS.calls); assert.equal(summary.nestedCalls.complete, false);
  assert.equal(summary.nestedCalls.calls[0].arguments, undefined); assert.ok(summary.nestedCalls.calls[0].argumentsBytes > 8192);
  assert.equal(summary.usage.input, NESTED_LIMITS.calls + 1);
  assert.equal(f.manager.getEntries().filter(entry => entry.message?.role === "toolResult").length, 0);
});


test("nested cancellation follows the originating cell and a later cell runs once", { timeout: 30000 }, async t => {
  const started = Promise.withResolvers(); let attempts = 0, cancelled = false;
  const f = await fixture(t, { cells: ['clm.annotate("wait")', 'assert not clm.recall("next")["isError"]\nprint("NEXT_CELL")'], configure(pi) {
    tool(pi, "live_context_annotate", "codemode", async (_id, _args, signal) => {
      attempts++; started.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("nested cancelled")); }, { once: true }));
    }, annotationParameters);
    tool(pi, "live_context_recall", "codemode", async () => { attempts++; return { content: [{ type: "text", text: "ok" }], details: {} }; }, object({ id: { type: "string" } }));
  } });
  await f.coor.submit("first"); await wait(started.promise); await wait(f.coor.abort());
  assert.equal(cancelled, true); assert.equal(attempts, 1);
  await f.coor.submit("second"); await wait(f.coor.waitForIdle());
  assert.equal(attempts, 2);
  const results = f.manager.getBranch().filter(entry => entry.message?.role === "toolResult").map(entry => entry.message);
  assert.equal(results.length, 2); assert.equal(results[0].nestedCalls.calls[0].status, "error");
  assert.equal(results[1].nestedCalls.calls[0].id, "cell-2/1"); assert.match(results[1].details.stdout, /NEXT_CELL/);
});

test("late host completion cannot borrow a new cell's context or deliver its response there", { timeout: 30000 }, async t => {
  const f = await fixture(t), started = Promise.withResolvers(), released = Promise.withResolvers();
  const controller = new AbortController(); let firstSignal, firstCalls = 0, nextCalls = 0;
  const outcome = name => ({ toolCall: { id: name, name, arguments: {}, type: "toolCall" }, result: { content: [], details: {} }, isError: false });
  const first = f.kernel.execute('clm.annotate("list")', { signal: controller.signal, toolContext: {
    async executeTool(_name, _args, { signal }) { firstCalls++; firstSignal = signal; started.resolve(); await released.promise; return outcome("first"); },
  } });
  await wait(started.promise); controller.abort(); assert.equal((await wait(first)).ok, false); assert.equal(firstSignal.aborted, true);
  const next = f.kernel.execute('clm.recall("next")', { toolContext: {
    async executeTool() { nextCalls++; released.resolve(); return outcome("next"); },
  } });
  const result = await wait(next);
  assert.equal(result.ok, true); assert.match(result.mime["text/plain"], /'id': 'next'/);
  assert.equal(firstCalls, 1); assert.equal(nextCalls, 1);
  const wrongIdentity = await f.kernel.execute('from _persistent_harness import _execution_id\n_execution_id.set("old-cell")\nclm.annotate("list")', {
    toolContext: { executeTool() { throw new Error("wrong cell dispatched"); } },
  });
  assert.equal(wrongIdentity.ok, false); assert.match(wrongIdentity.error, /no live originating cell/);
});

test("nested contexts retain parentage, honor active direct tools, and cannot recurse into orchestration", { timeout: 30000 }, async t => {
  const f = await fixture(t, { configure(pi) {
    tool(pi, "first", "codemode", async (_id, _args, _signal, _update, ctx) => {
      const child = await ctx.executeTool("second", {});
      assert.equal(child.isError, false);
      const denied = await ctx.executeTool("ipython", { code: "raise Exception('not callable')" });
      assert.equal(denied.isError, true);
      pi.setActiveTools(["ipython", "direct_helper"]);
      assert.equal((await ctx.executeTool("direct_helper", {})).isError, false);
      pi.setActiveTools(["ipython"]);
      assert.equal((await ctx.executeTool("direct_helper", {})).isError, true);
      return { content: [], details: {}, usage: usage(2) };
    });
    tool(pi, "second", "codemode", async () => ({ content: [], details: {}, usage: usage(3) }));
    tool(pi, "direct_helper", "direct", async () => ({ content: [], details: {} }));
  } });
  f.coor.toolDispatch.open("outer", new AbortController().signal, f.coor.assistant([]), []);
  assert.equal((await wait(f.coor.toolDispatch.execute("outer", "first", {}))).isError, false);
  const summary = await f.coor.toolDispatch.finish("outer");
  assert.equal(summary.usage.input, 5); assert.equal(summary.nestedCalls.complete, true);
  assert.deepEqual(summary.nestedCalls.calls.map(call => call.id), ["outer/1", "outer/1/1", "outer/1/2", "outer/1/3", "outer/1/4"]);
  assert.deepEqual(f.contexts, []);
});
