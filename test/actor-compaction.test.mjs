import assert from "node:assert/strict";
import { after, test, mock } from "node:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { loadExternalPi } from "../src/external-pi.mjs";
import { prepareActorCompaction, createCompactionDriver } from "../src/actor-compaction.mjs";

const temporary = await mkdtemp(path.join(os.tmpdir(), "actor-compaction-test-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: savedEnv.PATH, HOME: temporary,
  PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
  PI_HARNESS_PI_MODULE: savedEnv.PI_HARNESS_PI_MODULE,
  PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
await mkdir(process.env.PI_CODING_AGENT_DIR);
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error("Only injected fixture transports are allowed"); };
mock.method(globalThis, "fetch", deny);
mock.method(net.Socket.prototype, "connect", deny);
mock.method(http, "request", deny); mock.method(https, "request", deny);
after(async () => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(temporary, { recursive: true, force: true });
  assert.equal(networkAttempts, 0);
});
const external = await loadExternalPi();
const { sdk, api, core } = external;
const usage = (tokens = 70) => ({ input: tokens, output: 2, cacheRead: 0, cacheWrite: 0,
  totalTokens: tokens + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }],
  api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
  usage: usage(), ...extra });
const settings = { enabled: true, reserveTokens: 256, keepRecentTokens: 20 };

async function fixture(t, { before, streamSimple, keep = 20, persist = false, retry = { enabled: false } } = {}) {
  const cwd = await mkdtemp(path.join(temporary, "case-"));
  const agentDir = path.join(cwd, "agent"); await mkdir(agentDir);
  const manager = persist ? sdk.SessionManager.create(cwd, path.join(cwd, "sessions")) : sdk.SessionManager.inMemory(cwd);
  const models = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const requests = [];
  models.registerProvider("fixture", { baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", api: "fixture",
    models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text", "image"], contextWindow: 128000,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: streamSimple ?? ((model, context, options) => {
      requests.push({ model, context: structuredClone(context), options });
      const stream = api.createAssistantMessageEventStream();
      const message = assistant("fixture summary");
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
      return stream;
    }),
  });
  const observed = [], emitted = [];
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { ...settings, keepRecentTokens: keep }, retry });
  const resources = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "oracle", factory: pi => {
      pi.on("session_before_compact", async (event, ctx) => { observed.push(structuredClone({ ...event, signal: undefined }));
        return before ? before(event, ctx) : { cancel: true }; });
      pi.on("session_compact_failed", event => emitted.push(event));
      pi.on("session_compact", event => emitted.push(event));
    } }],
  });
  await resources.reload();
  const { session } = await sdk.createAgentSession({ cwd, agentDir, sessionManager: manager, modelRuntime: models,
    model: models.getModel("fixture", "fixture"), settingsManager, resourceLoader: resources, noTools: "all" });
  await session.bindExtensions({});
  session.subscribe(event => emitted.push(event));
  t.after(() => session.dispose());
  return { session, manager, models, requests, observed, emitted, resources };
}

function addOrdinary(manager) {
  manager.appendMessage(user("old question ".repeat(100)));
  manager.appendMessage(assistant("old answer ".repeat(100)));
  manager.appendMessage(user("new question ".repeat(100)));
  manager.appendMessage(assistant("new answer ".repeat(100)));
}

test("public AgentSession cancel-hook oracle exposes preparation without provider or writes", async t => {
  const f = await fixture(t); addOrdinary(f.manager);
  const before = structuredClone(f.manager.getEntries());
  await assert.rejects(f.session.compact("focus"), /cancel|abort/i);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].reason, "manual");
  assert.equal(f.observed[0].customInstructions, "focus");
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.manager.getEntries(), before);
  assert.equal(f.observed[0].preparation.tokensBefore, 72);
});

const result = (id, text = "done") => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 });
function addScenario(manager, name) {
  const u = manager.appendMessage(user("question ".repeat(80)));
  const call = (id, name = "read", args = { path: "x" }) => assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] });
  manager.appendMessage(call("c1")); manager.appendMessage(result("c1"));
  const v = manager.appendMessage(user("second ".repeat(80)));
  manager.appendMessage(assistant("answer ".repeat(80)));
  if (name.includes("multi")) {
    manager.appendCompaction("previous", v, 100, { readFiles: ["before"], modifiedFiles: ["edited"] });
    manager.appendMessage(user("third ".repeat(80)));
    manager.appendMessage(assistant("answer ".repeat(80)));
    if (name === "multi2") {
      const k = manager.getLeafId();
      manager.appendCompaction("latest", k, 50, { readFiles: ["latest"], modifiedFiles: ["changed"] });
      manager.appendMessage(user("fourth ".repeat(80)));
      manager.appendMessage(assistant("answer ".repeat(80)));
    }
  }
  if (name === "files") {
    manager.appendMessage(call("c2", "edit", { path: "e" }));
    manager.appendMessage({ ...result("c2"), toolName: "edit" });
    manager.appendMessage(call("c3", "write", { path: "w" }));
    manager.appendMessage({ ...result("c3"), toolName: "write" });
    manager.branchWithSummary(manager.getLeafId(), "branch", { readFiles: ["branchRead"], modifiedFiles: ["branchWrite"] });
    manager.appendMessage(user("last ".repeat(80)));
    manager.appendMessage(assistant("last ".repeat(80)));
  }
  if (name === "imageResult") {
    manager.appendMessage(call("image-call"));
    const imageResult = result("image-call");
    imageResult.content.push({ type: "image", mimeType: "image/png", data: "c3ludGhldGlj" });
    manager.appendMessage(imageResult);
  }
  if (name === "trailing") manager.appendMessage(user("trail ".repeat(80)));
  if (name === "failed") manager.appendMessage(assistant("failed", { stopReason: "error", usage: usage(900) }));
  if (name === "noUsage") {
    // Usage is valid historical data, but empty usage does not anchor token estimates.
    manager.appendMessage(assistant("zero", { usage: usage(0) }));
  }
}

test("capture multi-compaction, split-turn, files and trailing usage public preparation oracle", async t => {
  for (const name of ["ordinary", "multi", "multi2", "files", "trailing", "failed", "noUsage", "imageResult"])
    for (const keep of [20, 300, 100000]) {
      const f = await fixture(t, { keep }); addScenario(f.manager, name);
      await f.session.compact().catch(error => assert.match(error.message, /cancel|abort|compact/i));
      const p = f.observed[0]?.preparation;
      const branch = f.manager.getBranch();
      const actual = prepareActorCompaction({ sdk, core, entries: f.manager.getEntries(), leafId: f.manager.getLeafId(),
        settings: { ...settings, keepRecentTokens: keep } }).preparation;
      assert.deepEqual(actual, p, `${name} keep=${keep}`);
    }
});

async function driverFixture(t, { hooks = () => {}, lifecycle = {}, ...options } = {}) {
  const f = await fixture(t, options);
  const bus = sdk.createEventBus();
  const resources = new sdk.DefaultResourceLoader({ cwd: f.manager.getCwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: f.session.settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, eventBus: bus,
    extensionFactories: [{ name: "active", factory: hooks }] });
  await resources.reload();
  const loaded = resources.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, f.manager.getCwd(), f.manager, new sdk.ModelRegistry(f.models));
  const noop = () => {};
  runner.bindCore({ sendMessage: noop, sendUserMessage: noop,
    appendEntry: (type, data) => f.manager.appendCustomEntry(type, data), setSessionName: noop, getSessionName: noop,
    setLabel: noop, getActiveTools: () => [], getAllTools: () => [], setActiveTools: noop, refreshTools: noop,
    getCommands: () => [], setModel: noop, getThinkingLevel: () => f.session.thinkingLevel, setThinkingLevel: noop }, {
    getModel: () => f.session.model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false,
    getSignal: noop, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: noop,
    compact: noop, getSystemPrompt: () => "fixture system", getSystemPromptOptions: () => ({ cwd: f.manager.getCwd() }),
  });
  const errors = []; runner.onError(error => errors.push(error));
  const notifications = [];
  runner.setUIContext({ ...runner.getUIContext(), notify: (message, level) => notifications.push({ message, level }) }, "rpc");
  const published = [];
  const driver = createCompactionDriver({ sdk, core, runner, session: f.session, models: f.models, lifecycle,
    publish: event => published.push(event) });
  const controller = new AbortController();
  const coordinator = { manager: f.manager, session: f.session };
  return { ...f, runner, bus, errors, notifications, published, controller, coordinator, driver,
    run: options => driver({ coordinator, signal: controller.signal, ...options }) };
}

test("active runner receives composed diagnostics; custom compaction uses one canonical manager and usage", async t => {
  const sequence = [];
  const f = await driverFixture(t, {
    lifecycle: { prepareCompaction: event => { sequence.push("diagnostic"); return { customInstructions: `${event.customInstructions}\nnamespace diagnostic` }; },
      afterCommit: () => sequence.push("afterCommit") },
    hooks: pi => {
      pi.on("session_before_compact", event => { sequence.push("before"); assert.equal(event.customInstructions, "focus\nnamespace diagnostic");
        return { compaction: { summary: "hook summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: 9999, usage: usage(50), details: { opaque: "fixture", provenance: { provider: "test" } } } }; });
      pi.on("session_compact", event => { sequence.push("compact"); assert.equal(event.fromExtension, true); });
    },
  });
  addOrdinary(f.manager);
  const original = structuredClone(f.manager.getEntries());
  const answer = await f.run({ customInstructions: "focus" });
  assert.deepEqual(sequence, ["diagnostic", "before", "compact", "afterCommit"]);
  assert.equal(answer.summary, "hook summary"); assert.equal(answer.tokensBefore, 72);
  assert.equal(f.manager.getEntries().length, original.length + 1);
  assert.deepEqual(f.manager.getEntries().slice(0, -1), original);
  assert.deepEqual(f.manager.getLeafEntry().usage, usage(50));
  assert.equal(f.manager.getLeafEntry().fromHook, true);
  assert.deepEqual(f.published.map(event => event.type), ["compaction_start", "entry_appended", "compaction_end"]);
  assert.equal(f.observed.length, 0, "dormant session runner never receives active hooks");
  assert.equal(f.requests.length, 0);
});

test("default compaction calls real public sdk.compact with split summaries, instructions and fresh routing", async t => {
  const f = await driverFixture(t, { lifecycle: { prepareCompaction: () => ({ customInstructions: "namespace visible" }) } });
  addOrdinary(f.manager);
  const answer = await f.run({ automatic: true });
  assert.equal(f.requests.length, 2, "split turn uses both real STOCK summary paths");
  assert.match(answer.summary, /fixture summary/);
  assert.equal(answer.usage.totalTokens, 144);
  assert.equal(f.manager.getLeafEntry().fromHook, false);
  assert.equal(f.published[0].reason, "threshold");
  for (const request of f.requests) {
    assert.match(JSON.stringify(request.context), /namespace visible/);
    assert.equal(request.options.cacheRetention, "none");
    assert.notEqual(request.options.sessionId, f.manager.getSessionId());
    assert.equal(request.options.signal.aborted, false);
  }
  assert.equal(f.requests[0].options.sessionId, f.requests[1].options.sessionId);
  f.controller.abort();
  assert.equal(f.requests.every(request => request.options.signal.aborted), true);
});

test("cancellation, stale snapshots, preparation failure and signal abort do not append", async t => {
  for (const mode of ["cancel", "abort", "move", "invalid", "diagnostic-error", "pre-abort"]) {
    let f;
    f = await driverFixture(t, { lifecycle: { prepareCompaction: () => {
      if (mode === "diagnostic-error") throw new Error("diagnostic failed");
    } }, hooks: pi => pi.on("session_before_compact", event => {
      if (mode === "cancel") return { cancel: true };
      if (mode === "abort") f.controller.abort();
      if (mode === "move") f.manager.appendCustomEntry("test-mutation", {});
      return { compaction: { summary: mode === "invalid" ? "" : "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 0 } };
    }) });
    addOrdinary(f.manager);
    if (mode === "pre-abort") f.controller.abort();
    await assert.rejects(f.run());
    assert.equal(f.manager.getEntries().filter(entry => entry.type === "compaction").length, 0, mode);
    assert.equal(f.published.filter(event => event.type === "compaction_end").length, 1);
    assert.equal(f.requests.length, 0);
  }
});

test("native signatures overlay selected branch and earliest pending turn remains canonical", async t => {
  const f = await driverFixture(t);
  addOrdinary(f.manager);
  const pendingTurn = f.manager.appendMessage(user("pending turn"));
  const call = f.manager.appendMessage(assistant("", { id: "native-message", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "reason", thinkingSignature: JSON.stringify({ type: "reasoning", id: "reason-item" }) },
    { type: "toolCall", id: "native-pending", name: "read", arguments: { path: "fixture" }, async: true, providerCallId: "native-pending", providerItemId: "fc-item" },
  ] }));
  f.manager.appendCustomEntry("persistent-harness:assistant-thinking-signature:v1", { version: 1, messageEntryId: call,
    messageId: "native-message", contentIndex: 0, itemId: "reason-item", encryptedContent: "fixture-encryption" });
  f.manager.appendMessage(assistant("progress ".repeat(100)));
  f.manager.appendMessage(user("later ".repeat(100)));
  f.manager.appendMessage(assistant("later ".repeat(100)));
  const original = structuredClone(f.manager.getEntries());
  const prepared = prepareActorCompaction({ sdk, core, entries: original, leafId: f.manager.getLeafId(), settings });
  assert.equal(prepared.preparation.firstKeptEntryId, pendingTurn);
  assert.equal(prepared.outstanding.length, 1);
  assert.match(prepared.branchEntries.find(e => e.id === call).message.content[0].thinkingSignature, /fixture-encryption/);
  assert.deepEqual(f.manager.getEntries(), original);
  await assert.rejects(f.run({ automatic: true }), { code: "ERR_COMPACTION_PENDING_CALLS" });
  assert.equal(f.requests.length, 0, "live unanswered calls do not acquire compaction capability");
  f.manager.appendMessage(result("native-pending", "actual settled result"));
  const settled = structuredClone(f.manager.getEntries());
  const answer = await f.run({ automatic: true });
  assert.equal(answer.firstKeptEntryId, pendingTurn);
  assert.equal(f.manager.buildSessionContext().messages.some(m => m.role === "assistant" && m.id === "native-message"), true);
  assert.equal(JSON.stringify(f.requests).includes("native-pending"), false, "pending turn was retained, not sent to default summarizer");
  assert.deepEqual(f.manager.getEntries().slice(0, -1), settled);
});

test("default summary length/error/aborted responses never become a canonical compaction", async t => {
  for (const stopReason of ["length", "error", "aborted"]) {
    const f = await driverFixture(t, { streamSimple: () => {
      const stream = api.createAssistantMessageEventStream();
      const message = assistant("partial must not persist", { stopReason, errorMessage: "fixture failure" });
      queueMicrotask(() => { stream.push(stopReason === "length" ? { type: "done", reason: stopReason, message }
        : { type: "error", reason: stopReason, error: message }); stream.end(); }); return stream;
    } });
    addOrdinary(f.manager);
    await assert.rejects(f.run(), undefined, stopReason);
    assert.equal(f.manager.getEntries().some(e => e.type === "compaction"), false, stopReason);
  }
});

test("real public summary retry policy emits retry events without extra compactions", async t => {
  let attempts = 0;
  const f = await driverFixture(t, { keep: 300,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    streamSimple: () => {
      const stream = api.createAssistantMessageEventStream();
      const message = ++attempts === 1 ? assistant("", { stopReason: "error", errorMessage: "socket hang up" }) : assistant("retried summary");
      queueMicrotask(() => { stream.push(message.stopReason === "error" ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: "stop", message }); stream.end(); }); return stream;
    } });
  addOrdinary(f.manager);
  const answer = await f.run({ reason: "overflow", automatic: true, willRetry: true });
  assert.match(answer.summary, /retried summary/);
  assert.equal(attempts, 2);
  assert.deepEqual(f.published.filter(e => e.type.startsWith("summarization")).map(e => e.type),
    ["summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]);
  assert.equal(f.published.at(-1).willRetry, true);
  assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 1);
});

test("post-commit notification failure reports committed and never retries the writer", async t => {
  const f = await driverFixture(t, { lifecycle: { afterCommit: () => { throw new Error("fixture notice failed"); } },
    hooks: pi => pi.on("session_before_compact", e => ({ compaction: { summary: "committed", firstKeptEntryId: e.preparation.firstKeptEntryId, tokensBefore: 1 } })) });
  addOrdinary(f.manager);
  await assert.rejects(f.run(), error => error.code === "ERR_COMPACTION_COMMITTED" && error.committed === true && error.result.summary === "committed");
  assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.equal(f.published.filter(e => e.type === "compaction_end").length, 1);
  assert.equal(f.published.at(-1).aborted, false);
});

test("compaction stays on the selected branch and preserves persisted ancestor bytes on reopen", async t => {
  const f = await driverFixture(t, { persist: true });
  addOrdinary(f.manager);
  const root = f.manager.getLeafId();
  f.manager.appendMessage(user("excluded sibling"));
  f.manager.appendMessage(assistant("excluded answer"));
  f.manager.branch(root);
  f.manager.appendMessage(user("selected ".repeat(100)));
  f.manager.appendMessage(assistant("selected answer ".repeat(100)));
  const file = f.manager.getSessionFile();
  const original = await readFile(file, "utf8");
  const returned = await f.run();
  const after = await readFile(file, "utf8");
  assert.equal(after.startsWith(original), true);
  const reopened = sdk.SessionManager.open(file);
  assert.equal(reopened.getLeafEntry().summary, returned.summary);
  assert.equal(JSON.stringify(f.requests).includes("excluded sibling"), false);
  assert.equal(reopened.getEntries().filter(e => e.type === "compaction").length, 1);
});

test("previously pruned unanswered calls and custom compactions pruning pending calls are rejected", async t => {
  const f = await driverFixture(t, { hooks: pi => pi.on("session_before_compact", event => ({ compaction: {
    summary: "unsafe", firstKeptEntryId: event.branchEntries.at(-1).id, tokensBefore: 0,
  } })) });
  addOrdinary(f.manager);
  f.manager.appendMessage(user("native turn"));
  f.manager.appendMessage(assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "pending", name: "read", arguments: {}, async: true }] }));
  const later = f.manager.appendMessage(user("later ".repeat(100)));
  f.manager.appendMessage(assistant("answer ".repeat(100)));
  await assert.rejects(f.run({ automatic: true }), { code: "ERR_COMPACTION_PENDING_CALLS" });
  f.manager.appendCompaction("already pruned", later, 20);
  await assert.rejects(f.run(), { code: "ERR_COMPACTION_PENDING_ALREADY_PRUNED" });
});

test("split summary starts are serialized and queued aborts never dispatch provider work", async t => {
  for (const outcome of ["success", "abort", "length", "error"]) {
    let starts = 0, active = 0, maximum = 0;
    const f = await driverFixture(t, { streamSimple: (_model, context, options) => {
      starts++; active++; maximum = Math.max(maximum, active);
      assert.equal(context.messages.at(-1).role, "user");
      assert.equal(context.messages.at(-1).content, "diagnostic");
      assert.doesNotMatch(context.systemPrompt, /diagnostic/);
      const stream = api.createAssistantMessageEventStream();
      let finished = false;
      const finish = stopReason => {
        if (finished) return;
        finished = true; active--;
        const message = assistant("real summary", { stopReason, errorMessage: stopReason === "error" ? "billing exhausted" : undefined });
        stream.push(stopReason === "aborted" || stopReason === "error" ? { type: "error", reason: stopReason, error: message }
          : { type: "done", reason: stopReason, message }); stream.end();
      };
      options.signal.addEventListener("abort", () => finish("aborted"), { once: true });
      if (outcome !== "abort") setTimeout(() => finish(outcome === "length" || outcome === "error" ? outcome : "stop"), 5);
      return stream;
    } });
    addOrdinary(f.manager);
    const running = f.run({ customInstructions: "diagnostic" });
    if (outcome === "abort") {
      while (!starts) await new Promise(resolve => setTimeout(resolve, 1));
      f.controller.abort();
    }
    if (outcome === "success") { await running; assert.equal(starts, 2); }
    else {
      await assert.rejects(running, outcome === "error" ? /billing exhausted/ : { code: outcome === "abort" ? "ERR_COMPACTION_ABORTED" : "ERR_COMPACTION_SUMMARY_LENGTH" });
      assert.equal(starts, 1, "queued second summary did not dispatch");
    }
    assert.equal(active, 0, "all actual streams drained before owner lease returns");
    assert.equal(maximum, 1);
  }
});
