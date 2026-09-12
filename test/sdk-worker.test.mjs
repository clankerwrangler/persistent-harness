import assert from "node:assert/strict";
import WebSocket from "ws";
import { after, test, mock } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { findPackageJSON } from "node:module";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { resolveExternalPi, loadExternalPi } from "../src/external-pi.mjs";
import { RpcDialogBroker, bootstrapSDKWorker, runSDKWorkerRpc, toWorkerRpcEvent } from "../src/sdk-worker.mjs";
import { PiSessionActor } from "../src/session-actor.mjs";

const candidate = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Resolve explicit caller selection before scrubbing private fixture environment.
const selected = await resolveExternalPi();
const stock = selected.packageRoot;
const temporary = await mkdtemp(path.join(os.tmpdir(), "stock-sdk-worker-test-"));
const savedEnv = { ...process.env };
const sdkEntry = savedEnv.PI_HARNESS_TEST_BUNDLED_SDK === "1" ? path.join(stock, "dist/bundle/index.js") : selected.sdk;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: savedEnv.PATH, HOME: temporary, PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
  PI_HARNESS_PI_MODULE: sdkEntry, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
let networkAttempts = 0;
const denied = () => { networkAttempts++; throw new Error("Test network is denied"); };
mock.method(globalThis, "fetch", denied);
mock.method(net.Socket.prototype, "connect", denied);
mock.method(http, "request", denied); mock.method(https, "request", denied);
after(async () => {
  assert.equal(networkAttempts, 0, "fixtures must not attempt network access");
  mock.restoreAll();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(temporary, { recursive: true, force: true });
});
const external = await loadExternalPi();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Condition timed out"); await delay(5); }
}
const modelConfig = { baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", api: "worker-fixture",
  models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text", "image"], contextWindow: 128000,
    maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
function fixtureExtension(pi) {
  pi.registerProvider("worker-fixture", { ...modelConfig,
    streamSimple(model) {
      const stream = external.api.createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
        stopReason: "pending", timestamp: Date.now(), usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0,
          totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        message.content.push({ type: "text", text: "fixture response" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture response", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "fixture response", partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
  pi.registerCommand("exit-worker", { description: "Fixture shutdown", handler: (_args, ctx) => { ctx.shutdown(); } });
  pi.registerCommand("dialog", { description: "Fixture dialog", handler: async (_args, ctx) => {
    const answer = await ctx.ui.input("Fixture input"); ctx.ui.notify(answer ?? "cancelled");
  } });
}
async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(temporary, "case-"));
  const agentDir = path.join(dir, "agent"); await mkdir(agentDir);
  const events = [];
  const worker = await bootstrapSDKWorker({ external, cwd: dir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, publish: (event) => events.push(structuredClone(event)),
    argv: ["--mode", "rpc", "--session", path.join(dir, "session.jsonl"), "--provider", "worker-fixture", "--model", "fixture",
      "--no-extensions", "--extension", path.join(candidate, "index.ts"), "--no-skills", "--no-context-files"],
    extensionFactory: fixtureExtension, ...options });
  return { worker, events, dir, agentDir };
}

class MockCoordinator {
  constructor(options) { Object.assign(this, options); this.calls = []; this.busy = false; }
  get isBusy() { return this.busy; }
  get pendingMessageCount() { return 0; }
  async start() {
    const no = () => {};
    this.runner.bindCore({ sendMessage: no, sendUserMessage: no, appendEntry: no, setSessionName: no, getSessionName: no,
      setLabel: no, getActiveTools: () => [], getAllTools: () => [], setActiveTools: no, refreshTools: no,
      getCommands: () => [], setModel: no, getThinkingLevel: () => this.session.thinkingLevel, setThinkingLevel: no }, {
      getModel: () => this.session.model, getScopedModels: () => [], isIdle: () => !this.busy,
      isProjectTrusted: () => false, getSignal: no, abort: no, hasPendingMessages: () => false, shutdown: no,
      getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: 0 }), compact: no,
      getSystemPrompt: () => this.session.systemPrompt, getSystemPromptOptions: () => this.basePromptOptions(),
    });
    this.runner.bindCommandContext({ waitForIdle: async () => {}, newSession: no, fork: no, navigateTree: no, switchSession: no, reload: no });
  }
  getState() { return { isStreaming: this.busy, pendingMessageCount: 0, model: this.session.model, sessionId: this.session.sessionId }; }
  async submit(...args) { this.calls.push(args); return { outcome: "accepted" }; }
  async abort() { this.busy = false; }
  async compact() { throw new Error("Fixture compaction is incomplete"); }
  async withServiceMutation(operation) { assert.equal(this.busy, false); this.busy = true; try { return await operation(); } finally { this.busy = false; } }
  async waitForIdle() {}
  async close() { await this.runner.emit({ type: "session_shutdown", reason: "quit" }); }
}

test("bootstrap injects public header-capable WebSocket without replacing fixture adapters", async () => {
  let received;
  const adapter = { close() {} };
  const { worker } = await fixture({ Coordinator: MockCoordinator,
    createNativeAdapter(options) { received = options; return adapter; } });
  try {
    assert.equal(received.transportOptions.WebSocket, WebSocket);
    assert.notEqual(received.transportOptions.WebSocket, globalThis.WebSocket);
    assert.equal(received.api, external.api);
    assert.equal(received.responsesApi, external.responsesApi);
    assert.equal(received.modelRuntime, worker.models);
    assert.equal(worker.coordinator.nativeAdapter, adapter);
  } finally { await worker.close(); }
});

test("bootstrap supplies compaction factory with active owner dependencies and preserves override", async () => {
  let received;
  const driver = async () => { throw new Error("Fixture override is not dispatched by bootstrap"); };
  const { worker, events } = await fixture({ Coordinator: MockCoordinator,
    createCompactionDriver(options) { received = options; return driver; } });
  try {
    assert.equal(received.sdk, external.sdk); assert.equal(received.core, external.core);
    assert.equal(received.runner, worker.runner); assert.notEqual(received.runner, worker.session.extensionRunner);
    assert.equal(received.session, worker.session); assert.equal(received.models, worker.models);
    assert.equal(received.lifecycle, worker.lifecycle);
    assert.equal(worker.coordinator.compactionDriver, driver);
    received.publish({ type: "compaction_start", reason: "manual" });
    assert.deepEqual(events.at(-1), { type: "compaction_start", reason: "manual" });
  } finally { await worker.close(); }
});

test("bootstrap supplies navigation factory with the same active owner dependencies", async () => {
  let received;
  const driver = async () => { throw new Error("Fixture navigation is not dispatched by bootstrap"); };
  const { worker } = await fixture({ Coordinator: MockCoordinator,
    createNavigationDriver(options) { received = options; return driver; } });
  try {
    assert.equal(received.sdk, external.sdk); assert.equal(received.core, external.core);
    assert.equal(received.runner, worker.runner); assert.notEqual(received.runner, worker.session.extensionRunner);
    assert.equal(received.session, worker.session); assert.equal(received.models, worker.models);
    assert.equal(received.lifecycle, worker.lifecycle); assert.equal(worker.coordinator.navigationDriver, driver);
  } finally { await worker.close(); }
});

test("real worker routes manual compaction through active hooks and public default summaries", async () => {
  for (const custom of [true, false]) {
    const seen = []; let owner;
    const { worker, events } = await fixture({ extensionFactory(pi, lifecycle) {
      fixtureExtension(pi);
      lifecycle.prepareCompaction = (event) => {
        assert.equal(owner.coordinator.isBusy, true); assert.equal(owner.session.isStreaming, false);
        assert.equal(event.signal.aborted, false); seen.push("prepare");
        return { customInstructions: `${event.customInstructions} namespace fixture` };
      };
      pi.on("session_before_compact", (event) => {
        seen.push("before"); assert.equal(event.customInstructions, "focus namespace fixture");
        if (custom) return { compaction: { summary: "custom fixture summary", tokensBefore: 1,
          firstKeptEntryId: event.preparation.firstKeptEntryId } };
      });
      pi.on("session_compact", () => seen.push("compact"));
    } });
    owner = worker;
    try {
      await worker.mutate(() => worker.session.settingsManager.applyOverrides({
        compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 20 }, retry: { enabled: false },
      }));
      for (const message of ["old context ".repeat(200), "recent context ".repeat(200)]) {
        await worker.handle({ type: "prompt", message }); await worker.coordinator.waitForIdle();
        assert.equal(worker.coordinator.failure, null);
      }
      const manager = worker.session.sessionManager;
      const original = structuredClone(manager.getEntries());
      const result = await worker.handle({ type: "compact", customInstructions: "focus" });
      assert.match(result.summary, custom ? /custom fixture summary/ : /fixture response/);
      assert.deepEqual(seen, ["prepare", "before", "compact"]);
      assert.deepEqual(manager.getEntries().slice(0, -1), original);
      assert.equal(manager.getEntries().length, original.length + 1);
      assert.equal(manager.getLeafEntry().type, "compaction");
      assert.equal(manager.getLeafEntry().fromHook, custom);
      assert.equal(worker.session.isStreaming, false); assert.equal(worker.coordinator.isBusy, false);
      assert.equal(events.filter((event) => event.type === "compaction_start").length, 1);
      assert.equal(events.filter((event) => event.type === "compaction_end").length, 1);
      assert.equal(events.find((event) => event.type === "compaction_end").aborted, false);
    } finally { await worker.close(); }
  }
});

test("resolver requires explicit install and uses manifest exports beside bundled command", async () => {
  await assert.rejects(resolveExternalPi({ env: {} }), /explicitly/);
  const byModule = await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(stock, "dist/index.js") } });
  const byCommand = await resolveExternalPi({ env: { PI_HARNESS_PI_COMMAND: path.join(stock, "dist/bundle/cli.js") } });
  assert.deepEqual(byModule, byCommand);
  assert.equal(byModule.version, "0.85.1");
  assert.equal(byModule.sdk, path.join(stock, "dist/index.js"));
  const apiPackageFile = findPackageJSON(pathToFileURL(byModule.api));
  const apiPackage = JSON.parse(await readFile(apiPackageFile, "utf8"));
  assert.equal(apiPackage.name, "@earendil-works/pi-ai"); assert.equal(apiPackage.version, "0.85.1");
  const target = apiPackage.exports["./api/*"].import;
  assert.equal(target, "./dist/api/*.js");
  assert.equal(byModule.responsesApi, fileURLToPath(new URL(target.replace("*", "openai-responses-shared"), pathToFileURL(apiPackageFile))));
  const executable = path.join(temporary, "explicit-pi"); await symlink(path.join(stock, "dist/bundle/cli.js"), executable);
  assert.deepEqual(await resolveExternalPi({ env: { PI_HARNESS_PI_COMMAND: executable } }), byModule);
  assert.equal(typeof external.core.formatPromptTemplateInvocation, "function");
  assert.equal(typeof external.responsesApi.processResponsesStream, "function");
});

test("resolver honors the explicit official bundled SDK without changing public helper imports", async () => {
  const main = await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: stock } });
  const bundled = await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(stock, "dist/bundle/index.js") } });
  assert.deepEqual(bundled, { ...main, sdk: path.join(stock, "dist/bundle/index.js") });
  const alias = path.join(temporary, "explicit-bundled-sdk.mjs");
  await symlink(bundled.sdk, alias);
  assert.deepEqual(await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: pathToFileURL(alias).href } }), bundled);
  await assert.rejects(resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(stock, "dist/bundle/cli.js") } }), /Unsupported explicit/);
  await assert.rejects(resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(stock, "dist/core/sdk.js") } }), /Unsupported explicit/);
});

test("resolver rejects altered bundled entry bytes before executing them", async () => {
  const directory = path.join(temporary, "altered/node_modules/@earendil-works/pi-coding-agent");
  await mkdir(path.join(directory, "dist/bundle"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1",
    exports: { ".": { import: "./dist/index.js" } }, dependencies: { "@earendil-works/pi-ai": "0.85.1", "@earendil-works/pi-agent-core": "0.85.1" } }));
  await writeFile(path.join(directory, "dist/index.js"), "throw new Error('must not execute');");
  await writeFile(path.join(directory, "dist/bundle/index.js"), "throw new Error('must not execute');");
  for (const name of ["pi-ai", "pi-agent-core"]) {
    const dependency = path.join(directory, "node_modules/@earendil-works", name);
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version: "0.85.1",
      dependencies: name === "pi-agent-core" ? { "@earendil-works/pi-ai": "0.85.1" } : {} }));
  }
  await assert.rejects(loadExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(directory, "dist/bundle/index.js") } }), /official stock bytes/);
});

test("resolver rejects a different stock version before importing code", async () => {
  const directory = path.join(temporary, "wrong/node_modules/@earendil-works/pi-coding-agent");
  const ai = path.join(directory, "node_modules/@earendil-works/pi-ai");
  const core = path.join(directory, "node_modules/@earendil-works/pi-agent-core");
  await mkdir(ai, { recursive: true }); await mkdir(core, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.0",
    dependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-agent-core": "*" } }));
  await writeFile(path.join(ai, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.85.1" }));
  await writeFile(path.join(core, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", version: "0.85.1", dependencies: { "@earendil-works/pi-ai": "*" } }));
  await assert.rejects(resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: directory } }), /Expected stock Pi 0.85.1/);
});

test("UI broker correlates overlapping dialogs, ignores invalid/stale replies, and drains cancellation", async () => {
  const frames = []; const broker = new RpcDialogBroker((event) => frames.push(event));
  const select = broker.ui.select("pick", ["A", "B"]);
  const confirm = broker.ui.confirm("confirm", "yes?");
  const input = broker.ui.input("input"); const editor = broker.ui.editor("edit", "initial");
  assert.equal(broker.respond({ id: frames[1].id, value: "not a boolean" }), false);
  assert.equal(broker.respond({ id: "unknown", value: "A" }), false);
  broker.respond({ id: frames[3].id, value: "multiline\ntext" });
  broker.respond({ id: frames[0].id, value: "B" });
  broker.respond({ id: frames[1].id, confirmed: true });
  broker.respond({ id: frames[2].id, cancelled: true });
  assert.deepEqual(await Promise.all([select, confirm, input, editor]), ["B", true, undefined, "multiline\ntext"]);
  assert.equal(broker.pendingCount, 0);
  assert.equal(broker.respond({ id: frames[0].id, value: "A" }), false);
  const controller = new AbortController();
  const aborted = broker.ui.confirm("cancel", "", { signal: controller.signal }); controller.abort();
  assert.equal(await aborted, false);
  assert.equal(await broker.ui.input("expire", "", { timeout: 5 }), undefined);
  const pending = broker.ui.editor("close"); broker.close(); assert.equal(await pending, undefined);
  assert.equal(broker.pendingCount, 0);
});

test("UI notification/degraded TUI contract stays on RPC", async () => {
  const frames = []; const broker = new RpcDialogBroker((event) => frames.push(event));
  broker.ui.notify("hello"); broker.ui.setStatus("key", "status"); broker.ui.setWidget("widget", ["line"], { placement: "belowEditor" });
  broker.ui.setTitle("title"); broker.ui.pasteToEditor("paste"); broker.ui.setWidget("factory", () => assert.fail("TUI factory ran"));
  assert.deepEqual(frames.map((frame) => frame.method), ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
  assert.equal(frames[0].notifyType, "info"); assert.equal(broker.pendingCount, 0);
  assert.equal(await broker.ui.custom(() => assert.fail("TUI custom ran")), undefined);
  assert.equal(broker.ui.getEditorText(), ""); assert.equal(broker.ui.setTheme("light").success, false); broker.close();
});

test("bootstrap uses distinct runtimes, one manager, inline harness once, companion and discovery", async () => {
  let initialized = 0, started = 0, closed = 0;
  const companion = path.join(temporary, "companion.mjs");
  const discovered = path.join(temporary, "discovered.md"); await writeFile(discovered, "---\ndescription: Discovered prompt\n---\nPrompt $1");
  await writeFile(companion, `export default function(pi) { pi.registerCommand('companion', {description:'companion',handler(){}}); }`);
  const { worker, agentDir } = await fixture({ Coordinator: MockCoordinator,
    argv: ["--mode", "rpc", "--no-session", "--provider", "worker-fixture", "--model", "fixture", "--no-extensions", "--no-skills", "--no-context-files",
      "--extension", path.join(candidate, "index.ts"), "--extension", companion],
    extensionFactory(pi, lifecycle) { initialized++; fixtureExtension(pi); lifecycle.marker = true;
      pi.on("session_start", (_event, ctx) => { started++; assert.equal(ctx.mode, "rpc"); assert.equal(ctx.hasUI, true); });
      pi.on("session_shutdown", () => { closed++; });
      pi.on("resources_discover", () => ({ promptPaths: [discovered] }));
    } });
  try {
    assert.equal(initialized, 1); assert.equal(started, 1);
    assert.notEqual(worker.runner, worker.session.extensionRunner);
    assert.notEqual(worker.resources.getExtensions().runtime, worker.session.resourceLoader.getExtensions().runtime);
    assert.equal(worker.session.resourceLoader.getExtensions().extensions.length, 0);
    assert.equal(worker.runner.createContext().sessionManager, worker.session.sessionManager);
    const commands = (await worker.handle({ type: "get_commands" })).commands;
    assert.ok(commands.some((item) => item.name === "companion")); assert.ok(commands.some((item) => item.name === "discovered"));
    const ownCommand = commands.find((item) => item.name === "dialog");
    assert.equal(ownCommand.source, "extension");
    assert.equal(ownCommand.sourceInfo?.path, "<inline:persistent-harness>", "injected factories cannot claim the paired harness entry");
    assert.deepEqual(ownCommand.sourceInfo, worker.runner.getCommand("dialog").sourceInfo);
    assert.equal(commands.find((item) => item.name === "companion").sourceInfo.path, companion, "never relabel a companion as the harness");
    assert.equal(commands.find((item) => item.name === "discovered").sourceInfo.path, discovered);
    assert.equal(worker.resources.getExtensions().extensions.filter((item) => item.path === path.join(candidate, "index.ts")).length, 0);
    const initial = await worker.handle({ type: "get_state" }); assert.equal(initial.isStreaming, false);
    await worker.handle({ type: "set_steering_mode", mode: "all", persist: false });
    await worker.session.settingsManager.flush();
    await assert.rejects(readFile(path.join(agentDir, "settings.json")), { code: "ENOENT" });
    assert.equal(worker.session.agent.steeringMode, "all");
    await worker.handle({ type: "prompt", message: "hello\u2028world", messageId: "input-1", images: [{ type: "image", mimeType: "image/png", data: "eA==" }] });
    assert.deepEqual(worker.coordinator.calls[0], ["hello\u2028world", "auto", [{ type: "image", mimeType: "image/png", data: "eA==" }], "input-1", { source: "rpc", expandPromptTemplates: true }]);
    await worker.handle({ type: "prompt", message: "follow", streamingBehavior: "followUp" });
    assert.equal(worker.coordinator.calls[1][1], "follow_up");
    assert.equal((await worker.handle({ type: "get_available_models" })).models.some((model) => model.id === "fixture"), true);
    await assert.rejects(worker.handle({ type: "compact" }), /incomplete/);
  } finally { await worker.close(); await worker.close(); }
  assert.equal(closed, 1);
});

for (const count of [0, 2]) test(`default harness rejects ${count} owned loader slots before readiness`, async () => {
  let starts = 0, slots;
  class MalformedLoader extends external.sdk.DefaultResourceLoader {
    constructor(options) {
      super({ ...options, extensionsOverride: (loaded) => {
        const owned = loaded.extensions.find((item) => item.path === "<inline:persistent-harness>");
        loaded.extensions = loaded.extensions.filter((item) => item !== owned);
        slots = Array.from({ length: count }, () => ({ ...owned }));
        loaded.extensions.push(...slots);
        return options.extensionsOverride(loaded);
      } });
    }
  }
  class UnstartedCoordinator extends MockCoordinator { async start() { starts++; await super.start(); } }
  await assert.rejects(fixture({ extensionFactory: undefined, Coordinator: UnstartedCoordinator,
    external: { ...external, sdk: { ...external.sdk, DefaultResourceLoader: MalformedLoader } } }),
    new RegExp(`Expected exactly one owned harness extension, received ${count}`));
  assert.equal(starts, 0);
  assert.ok(slots.every((item) => item.path === "<inline:persistent-harness>"), "reject before assigning any owned source identity");
});

test("only the default harness implementation receives the real paired entry identity", async () => {
  const companion = path.join(temporary, "real-harness-companion.mjs");
  await writeFile(companion, `export default function(pi) {
    pi.registerProvider("worker-fixture", ${JSON.stringify({ ...modelConfig, api: "openai-completions" })});
    pi.registerCommand("unrelated", { description: "Not the harness", handler() {} });
  }`);
  const { worker, events } = await fixture({ extensionFactory: undefined,
    argv: ["--mode", "rpc", "--no-session", "--provider", "worker-fixture", "--model", "fixture", "--no-extensions", "--no-skills", "--no-context-files",
      "--extension", path.join(candidate, "index.ts"), "--extension", companion] });
  try {
    const own = worker.resources.getExtensions().extensions.filter((item) => item.path === path.join(candidate, "index.ts"));
    assert.equal(own.length, 1);
    assert.equal(own[0].resolvedPath, path.join(candidate, "index.ts"));
    assert.equal(own[0].sourceInfo.path, own[0].resolvedPath);
    assert.equal(events.filter((event) => event.type === "extension_ui_request" && event.method === "notify"
      && event.message.startsWith("Persistent Harness sessions are supervisor-hosted.")).length, 1, "real harness factory starts once without an actor identity");
    const commands = (await worker.handle({ type: "get_commands" })).commands;
    assert.equal(commands.find((item) => item.name === "unrelated").sourceInfo.path, companion);
    assert.equal(commands.some((item) => item.sourceInfo.path === own[0].resolvedPath), false, "do not claim companion commands as harness commands");
  } finally { await worker.close(); }
});

test("RPC mutations validate and require the owner lease", async () => {
  const { worker } = await fixture({ Coordinator: MockCoordinator });
  try {
    await assert.rejects(worker.handle({ type: "set_thinking_level", level: "wrong" }), /Invalid/);
    await worker.handle({ type: "set_thinking_level", level: "high" });
    assert.equal((await worker.handle({ type: "get_thinking_level" })).level, "high");
    assert.ok((await worker.handle({ type: "get_available_thinking_levels" })).levels.includes("high"));
    await worker.handle({ type: "set_session_name", name: "renamed" }); assert.equal(worker.session.sessionName, "renamed");
    await assert.rejects(worker.handle({ type: "set_model", provider: "missing", modelId: "missing" }), /not found/);
    worker.coordinator.busy = true;
    await assert.rejects(worker.handle({ type: "set_model", provider: "worker-fixture", modelId: "fixture" }), /idle/);
    await worker.handle({ type: "abort" }); assert.equal(worker.coordinator.isBusy, false);
    await assert.rejects(worker.handle({ type: "get_entries", since: "missing" }), /Unknown/);
    assert.ok((await worker.handle({ type: "get_tree" })).tree.length > 0);
    assert.equal((await worker.handle({ type: "get_session_stats" })).contextUsage.tokens, 0);
    await assert.rejects(worker.handle({ type: "new_session" }), /supervisor/);
  } finally { await worker.close(); }
});

test("dormant SDK prompt follows active Python tools without disabled builtin metadata", async () => {
  for (const explicitSelection of [false, true]) {
    let initialized = 0, executed = 0, startupSelection;
    const prepared = [];
    const definitions = ["ipython", "wait_for_ipython"].map((name) => ({
      name, label: name, description: `Fixture ${name}`, promptSnippet: `Fixture ${name} capability`,
      promptGuidelines: [`Use fixture ${name} only when needed.`],
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { executed++; throw new Error("Fixture tools must not execute in metadata tests"); },
    }));
    const { ActorCoordinator } = await import("../src/actor-coordinator.mjs");
    const { worker } = await fixture({
      Coordinator: class extends ActorCoordinator {
        async start() { startupSelection = this.promptOptions().selectedTools; await super.start(); }
      },
      argv: ["--mode", "rpc", "--no-session", "--provider", "worker-fixture", "--model", "fixture",
        "--no-extensions", "--no-skills", "--no-context-files", ...(explicitSelection ? ["--tools", "ipython,wait_for_ipython"] : [])],
      extensionFactory(pi, lifecycle) {
        initialized++; fixtureExtension(pi);
        for (const definition of definitions) pi.registerTool(definition);
        pi.on("session_start", () => pi.setActiveTools(["ipython", "wait_for_ipython"]));
        pi.registerCommand("python-only", { handler: () => pi.setActiveTools(["ipython"]) });
        lifecycle.prepareRequest = (event) => { prepared.push(structuredClone(event)); return { systemPrompt: event.systemPrompt }; };
      },
    });
    try {
      assert.equal(initialized, 1);
      if (explicitSelection) assert.deepEqual(startupSelection, ["ipython", "wait_for_ipython"]);
      for (const definition of definitions) assert.equal(worker.session.getToolDefinition(definition.name).execute, definition.execute);
      const check = (names) => {
        const options = worker.coordinator.promptOptions();
        assert.deepEqual(options.selectedTools, names);
        assert.deepEqual(worker.session.getActiveToolNames(), names);
        assert.deepEqual([...worker.coordinator.activeTools], names);
        assert.deepEqual(Object.keys(options.toolSnippets), names);
        assert.deepEqual(options.promptGuidelines, names.map((name) => `Use fixture ${name} only when needed.`));
        for (const builtin of ["read", "bash", "edit", "write"]) {
          assert.doesNotMatch(worker.session.systemPrompt, new RegExp(`(?:^|\\n)- ${builtin}:`));
          assert.equal(options.selectedTools.includes(builtin), false);
        }
        for (const name of names) assert.match(worker.session.systemPrompt, new RegExp(`Fixture ${name} capability`));
      };
      check(["ipython", "wait_for_ipython"]);
      await worker.handle({ type: "prompt", message: "metadata before selection change" });
      await worker.coordinator.waitForIdle();
      assert.equal(worker.coordinator.failure, null);
      await worker.handle({ type: "prompt", message: "/python-only" });
      check(["ipython"]);
      await worker.handle({ type: "prompt", message: "metadata after selection change" });
      await worker.coordinator.waitForIdle();
      assert.equal(worker.coordinator.failure, null);
      assert.deepEqual(prepared.map((event) => event.systemPromptOptions.selectedTools), [["ipython", "wait_for_ipython"], ["ipython"]]);
      assert.doesNotMatch(prepared[1].systemPrompt, /Fixture wait_for_ipython capability/);
      for (const event of prepared) assert.doesNotMatch(event.systemPrompt, /(?:^|\n)- (?:read|bash|edit|write):/);
      assert.equal(executed, 0); assert.equal(worker.session.isStreaming, false);
    } finally { await worker.close(); }
  }
});

test("real coordinator ordinary prompt writes canonical messages once without stock agent flight", async () => {
  const { worker, events } = await fixture();
  try {
    await worker.handle({ type: "set_steering_mode", mode: "all", persist: false });
    assert.deepEqual(await worker.handle({ type: "prompt", message: "ordinary prompt", messageId: "ordinary-id" }), { outcome: "accepted" });
    await worker.coordinator.waitForIdle();
    assert.equal(worker.coordinator.failure, null);
    assert.equal(worker.session.isStreaming, false);
    const messages = (await worker.handle({ type: "get_messages" })).messages;
    assert.equal(messages.filter((message) => message.role === "user").length, 1);
    assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal((await worker.handle({ type: "get_last_assistant_text" })).text, "fixture response");
    assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
    const lines = (await readFile(worker.session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(lines.filter((entry) => entry.type === "message").length, 2);
    assert.equal(lines.filter((entry) => entry.type === "session").length, 1);
  } finally { await worker.close(); }
});

test("JSONL accepts split UTF-8/CRLF frames and UI replies while command waits", async () => {
  const input = new PassThrough(); const output = new PassThrough(); const frames = []; let buffer = "";
  output.on("data", (chunk) => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf("\n")) >= 0) {
    frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
  } });
  let owner;
  const run = runSDKWorkerRpc({ input, output, installSignalHandlers: false, bootstrap: async ({ publish, broker }) => {
    owner = { async handle(command) {
      if (command.type === "prompt") { await broker.ui.input(command.message); return undefined; }
      return { isStreaming: false };
    }, async close() { broker.close(); } }; return owner;
  } });
  const data = Buffer.from(JSON.stringify({ id: "a", type: "prompt", message: "é\u2028inside" }) + "\r\n");
  input.write(data.subarray(0, data.indexOf(0xc3) + 1)); input.write(data.subarray(data.indexOf(0xc3) + 1));
  await until(() => frames.some((frame) => frame.type === "extension_ui_request"));
  input.write(JSON.stringify({ id: "b", type: "get_state" }) + "\n");
  await until(() => frames.some((frame) => frame.id === "b"));
  const dialog = frames.find((frame) => frame.type === "extension_ui_request");
  assert.equal(dialog.title, "é\u2028inside");
  assert.equal(frames.some((frame) => frame.id === "a"), false);
  input.write(JSON.stringify({ id: dialog.id, type: "extension_ui_response", value: "answer" }) + "\n");
  await until(() => frames.some((frame) => frame.id === "a"));
  assert.equal(frames.filter((frame) => frame.id === "a").length, 1);
  input.end(); await run;
});

test("delta projection retains tool identity without partial messages", () => {
  const partial = { usage: { input: 1 }, content: [{ type: "toolCall", id: "call", name: "tool" }] };
  const event = toWorkerRpcEvent({ type: "message_update", message: partial,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial } });
  assert.deepEqual(event, { type: "message_update", usage: { input: 1 }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call", toolName: "tool" } });
});


test("PiSessionActor starts the worker with supervisor flags and receives ordinary events and dialog responses", async () => {
  const directory = await mkdtemp(path.join(temporary, "child-"));
  const agentDir = path.join(directory, "agent"); await mkdir(agentDir);
  const driver = path.join(directory, "fixture-driver.mjs");
  await writeFile(driver, `import net from "node:net"; import http from "node:http"; import https from "node:https";
const denied = () => { throw new Error("Fixture network denied"); };
globalThis.fetch = denied; net.Socket.prototype.connect = denied; http.request = denied; https.request = denied;
import { loadExternalPi } from ${JSON.stringify(pathToFileURL(path.join(candidate, "src/external-pi.mjs")).href)};
import { runSDKWorkerRpc, bootstrapSDKWorker } from ${JSON.stringify(pathToFileURL(path.join(candidate, "src/sdk-worker.mjs")).href)};
const external = await loadExternalPi();
const modelConfig = ${JSON.stringify(modelConfig)};
${fixtureExtension.toString()}
await runSDKWorkerRpc({ bootstrap: (options) => bootstrapSDKWorker({ ...options, external, extensionFactory: fixtureExtension }) });
`);
  const actor = new PiSessionActor({ command: process.execPath, cwd: directory,
    env: { PATH: savedEnv.PATH, HOME: directory, PI_CODING_AGENT_DIR: agentDir,
      PI_HARNESS_PI_MODULE: sdkEntry, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
    args: [driver, "--mode", "rpc", "--provider", "worker-fixture", "--model", "fixture", "--thinking", "high",
      "--extension", path.join(candidate, "index.ts"), "--no-extensions", "--no-skills", "--no-context-files",
      "--name", "Child actor", "--session", path.join(directory, "canonical.jsonl")], requestTimeoutMs: 5000,
  });
  const events = []; actor.on("event", (event) => events.push(event));
  try {
    const state = await actor.start();
    assert.equal(state.isStreaming, false); assert.equal(state.sessionName, "Child actor");
    assert.equal(state.thinkingLevel, "high"); assert.equal(state.steeringMode, "all");
    const command = (await actor.request("get_commands")).commands.find((item) => item.name === "dialog");
    assert.equal(command.source, "extension");
    assert.deepEqual(command.sourceInfo, { path: "<inline:persistent-harness>", source: "inline", scope: "temporary", origin: "top-level" });
    await actor.submit("real actor request", "auto", [], "actor-input");
    await until(() => events.some((event) => event.type === "agent_settled"), 5000);
    const messages = (await actor.request("get_messages")).messages;
    assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
    assert.equal(messages.find((message) => message.role === "user").id, "actor-input");
    const entries = await actor.request("get_entries"); assert.ok(entries.entries.some((entry) => entry.message?.role === "assistant"));
    const dialog = actor.request("prompt", { message: "/dialog" });
    await until(() => events.some((event) => event.type === "extension_ui_request" && event.method === "input"));
    const request = events.find((event) => event.type === "extension_ui_request" && event.method === "input");
    actor.send({ type: "extension_ui_response", id: request.id, value: "answer" }); assert.deepEqual(await dialog, { outcome: "handled" });
    assert.ok(events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message === "answer"));
    const exited = new Promise((resolve) => actor.once("exit", resolve));
    await actor.request("prompt", { message: "/exit-worker" });
    const exit = await exited; assert.equal(exit.code, 0);
  } finally { await actor.close(); }
  assert.equal(actor.stderr, "");
  const lines = (await readFile(path.join(directory, "canonical.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter((entry) => entry.type === "message").length, 2);
  await assert.rejects(readFile(path.join(agentDir, "settings.json")), { code: "ENOENT" });
});

test("startup extension failure rejects readiness instead of admitting prompts", async () => {
  let starts = 0;
  await assert.rejects(fixture({ Coordinator: MockCoordinator, extensionFactory(pi) {
    fixtureExtension(pi); pi.on("session_start", () => { starts++; throw new Error("critical startup fixture failure"); });
  } }), /startup failed/);
  assert.equal(starts, 1);
});

test("real owner lease excludes inference until an async service mutation finishes", async () => {
  const { worker, events } = await fixture();
  const hold = Promise.withResolvers(); let entered = false;
  try {
    const mutation = worker.mutate(async () => { entered = true; await hold.promise; });
    await until(() => entered);
    await worker.handle({ type: "prompt", message: "queued during service lease" });
    await delay(15);
    assert.equal(events.some((event) => event.type === "agent_start"), false);
    hold.resolve(); await mutation; await worker.coordinator.waitForIdle();
    assert.equal((await worker.handle({ type: "get_last_assistant_text" })).text, "fixture response");
  } finally { hold.resolve(); await worker.close(); }
});


test("service metadata updates reach active extensions once and notify canonical observers", async () => {
  const hooks = []; let commits = 0;
  const { worker, events } = await fixture({ Coordinator: MockCoordinator, extensionFactory(pi, lifecycle) {
    fixtureExtension(pi); lifecycle.afterCommit = async () => { commits++; };
    pi.on("thinking_level_select", (event) => hooks.push(event));
    pi.on("model_select", (event) => hooks.push(event));
    pi.on("session_info_changed", (event) => hooks.push(event));
  } });
  try {
    await worker.handle({ type: "set_thinking_level", level: "high" });
    assert.equal(hooks.filter((event) => event.type === "thinking_level_select").length, 1);
    assert.equal(events.filter((event) => event.type === "thinking_level_changed").length, 1);
    await worker.handle({ type: "set_session_name", name: "metadata test" });
    assert.equal(hooks.filter((event) => event.type === "session_info_changed").length, 1);
    assert.equal(events.filter((event) => event.type === "session_info_changed").length, 1);
    assert.equal(commits, 2);
  } finally { await worker.close(); }
});

test("UI bound and failed writes reject without retained dialog entries", async () => {
  const broker = new RpcDialogBroker(() => {}, { maxPending: 1 });
  const pending = broker.ui.confirm("pending", "");
  await assert.rejects(broker.ui.input("overflow"), /Too many/);
  broker.close(); assert.equal(await pending, false);
  const failed = new RpcDialogBroker(() => { throw new Error("write failed"); });
  await assert.rejects(failed.ui.input("error"), /write failed/);
  assert.equal(failed.pendingCount, 0); failed.close();
});

test("malformed JSONL yields a parse error and closes instead of dispatching data", async () => {
  const input = new PassThrough(); const output = new PassThrough(); let text = "", dispatched = 0, closed = 0;
  output.on("data", (chunk) => { text += chunk.toString(); });
  const running = runSDKWorkerRpc({ input, output, installSignalHandlers: false,
    bootstrap: async () => ({ handle: async () => { dispatched++; }, close: async () => { closed++; } }) });
  input.write("{invalid}\n");
  await assert.rejects(running, /JSON|Unexpected|property name/);
  assert.equal(dispatched, 0); assert.equal(closed, 1);
  const response = JSON.parse(text.trim()); assert.equal(response.command, "parse"); assert.equal(response.success, false);
});


test("extension-requested shutdown drains command responses, UI, and owner work before closing", async () => {
  const input = new PassThrough(); const output = new PassThrough(); const frames = []; let buffer = "", closed = false;
  const idle = Promise.withResolvers(); let requested = false;
  output.on("data", (chunk) => { buffer += chunk.toString(); let end; while ((end = buffer.indexOf("\n")) >= 0) {
    frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
  } });
  const running = runSDKWorkerRpc({ input, output, installSignalHandlers: false,
    bootstrap: async ({ broker, lifecycle }) => ({
      coordinator: { waitForIdle: () => idle.promise },
      async handle() { lifecycle.requestShutdown(); requested = true; await broker.ui.input("finish dialog"); },
      async close() { closed = true; broker.close(); },
    }),
  });
  input.write(JSON.stringify({ id: "quit", type: "prompt", message: "/quit" }) + "\n");
  await until(() => requested && frames.some((frame) => frame.method === "input"));
  assert.equal(closed, false);
  const dialog = frames.find((frame) => frame.method === "input");
  input.write(JSON.stringify({ type: "extension_ui_response", id: dialog.id, value: "answer" }) + "\n");
  await until(() => frames.some((frame) => frame.id === "quit"));
  assert.equal(frames.find((frame) => frame.id === "quit").success, true); assert.equal(closed, false);
  idle.resolve(); await running;
  assert.equal(closed, true);
});


test("external compaction hook receives canonical projections and composed namespace instructions", async () => {
  const { default: harnessExtension } = await import("../src/extension.mjs");
  const directory = await mkdtemp(path.join(temporary, "projection-hook-"));
  const extensionPath = path.join(directory, "projection-hook.mjs");
  await writeFile(extensionPath, `export default function(pi) {
    pi.on("session_before_compact", event => {
      const projections = {};
      for (const mode of ["native", "ordinary"]) {
        const request = { entries: event.branchEntries, leafId: event.branchEntries.at(-1)?.id ?? null, mode };
        pi.events.emit("persistent-harness:project-canonical-context:v1", request);
        if (request.error || !request.result) return { cancel: true };
        projections[mode] = request.result;
      }
      return { compaction: { summary: "external hook summary", tokensBefore: event.preparation.tokensBefore,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        details: { projections, instructions: event.customInstructions } } };
    });
  }`);
  let projectionBus;
  const { worker } = await fixture({
    argv: ["--mode", "rpc", "--session", path.join(directory, "session.jsonl"),
      "--provider", "worker-fixture", "--model", "fixture", "--no-extensions",
      "--extension", extensionPath, "--no-skills", "--no-context-files"],
    extensionFactory(pi, lifecycle) {
      projectionBus = pi.events;
      harnessExtension(pi, lifecycle);
      fixtureExtension(pi);
      lifecycle.prepareCompaction = event => ({
        customInstructions: `${event.customInstructions}\nNAMESPACE_DIAGNOSTIC_FIXTURE`,
      });
    },
  });
  try {
    assert.ok(worker.resources.getExtensions().extensions.some(e => e.path === extensionPath));
    await worker.mutate(() => worker.session.settingsManager.applyOverrides({
      compaction: { enabled: false, reserveTokens: 256, keepRecentTokens: 20 }, retry: { enabled: false },
    }));
    const manager = worker.session.sessionManager;
    const user = content => ({ role: "user", content, timestamp: 1 });
    const assistant = (content, extra = {}) => ({ role: "assistant", content,
      api: "openai-responses", provider: "worker-fixture", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 50, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 52,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
    manager.appendMessage(user("old context ".repeat(100)));
    manager.appendMessage(assistant([{ type: "text", text: "old answer ".repeat(100) }]));
    manager.appendMessage(user("native question"));
    const callEntry = manager.appendMessage(assistant([
      { type: "thinking", thinking: "reason", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_fixture", summary: [] }) },
      { type: "toolCall", id: "call_fixture", name: "read", arguments: { path: "x" }, async: true,
        providerCallId: "call_fixture", providerItemId: "fc_fixture" },
    ], { id: "message_fixture", stopReason: "toolUse" }));
    manager.appendCustomEntry("persistent-harness:assistant-thinking-signature:v1", {
      version: 1, messageEntryId: callEntry, messageId: "message_fixture", contentIndex: 0,
      itemId: "rs_fixture", encryptedContent: "ENCRYPTED_REASONING_FIXTURE",
    });
    manager.appendMessage(assistant([{ type: "text", text: "interleaved progress" }]));
    manager.appendMessage({ role: "toolResult", toolCallId: "call_fixture", toolName: "read",
      content: [{ type: "text", text: "ACTUAL_COMPLETED_RESULT" }], isError: false, timestamp: 3 });
    const staleRequest = { entries: structuredClone(manager.getBranch()), leafId: manager.getLeafId(), mode: "ordinary" };
    manager.appendMessage(user("retained question ".repeat(100)));
    manager.appendMessage(assistant([{ type: "text", text: "retained answer ".repeat(100) }]));
    const file = manager.getSessionFile(), before = await readFile(file, "utf8");
    const channel = "persistent-harness:project-canonical-context:v1";
    const currentRequest = { entries: structuredClone(manager.getBranch()), leafId: manager.getLeafId(), mode: "ordinary" };
    const rawRequest = structuredClone(currentRequest);
    projectionBus.emit(channel, rawRequest);
    assert.equal(rawRequest.error, undefined);
    assert.equal(rawRequest.result.messages.filter(m => m.role === "toolResult").length, 1);
    rawRequest.result.messages.length = 0;
    assert.equal((await readFile(file, "utf8")), before, "projection is detached and does not write history");
    const altered = structuredClone(currentRequest);
    altered.entries.find(e => e.type === "message").message.content = "altered payload";
    for (const invalid of [staleRequest, altered, { ...currentRequest, entries: [] },
      { ...currentRequest, leafId: "foreign-leaf" }, { ...currentRequest, mode: "unsupported" }]) {
      invalid.result = { messages: ["stale result"] };
      projectionBus.emit(channel, invalid);
      assert.deepEqual(invalid.error, { code: "canonical_context_unavailable" });
      assert.equal(invalid.result, undefined, "rejected requests cannot reuse a stale result");
    }
    assert.equal((await readFile(file, "utf8")), before);
    const result = await worker.handle({ type: "compact", customInstructions: "CALLER_INSTRUCTIONS_FIXTURE" });
    assert.equal(result.summary, "external hook summary");
    assert.equal(result.details.instructions, "CALLER_INSTRUCTIONS_FIXTURE\nNAMESPACE_DIAGNOSTIC_FIXTURE");
    const { native, ordinary } = result.details.projections;
    for (const projection of [native, ordinary]) {
      assert.deepEqual(projection.outstanding, []);
      assert.equal(projection.diagnostics.some(d => d.severity === "blocking"), false);
      assert.equal(projection.messages.filter(m => m.role === "toolResult" && m.toolCallId === "call_fixture").length, 1);
    }
    const callIndex = ordinary.messages.findIndex(m => m.role === "assistant" && m.id === "message_fixture");
    assert.equal(ordinary.messages[callIndex + 1].role, "toolResult");
    assert.equal(native.messages[native.messages.findIndex(m => m.role === "assistant" && m.id === "message_fixture") + 1].role, "assistant");
    const input = external.responsesApi.convertResponsesMessages({ ...worker.session.model, api: "openai-responses" },
      { messages: external.sdk.convertToLlm(ordinary.messages) }, new Set(["worker-fixture"]));
    const wire = JSON.stringify(input);
    assert.equal((wire.match(/ACTUAL_COMPLETED_RESULT/g) ?? []).length, 1);
    assert.equal((wire.match(/ENCRYPTED_REASONING_FIXTURE/g) ?? []).length, 1);
    assert.doesNotMatch(wire, /No result provided/);
    assert.ok((await readFile(file, "utf8")).startsWith(before));
    const reopened = external.sdk.SessionManager.open(file);
    assert.equal(reopened.getLeafEntry().summary, result.summary);
    assert.equal(reopened.getLeafEntry().fromHook, true);
    assert.equal(reopened.getEntries().filter(e => e.type === "compaction").length, 1);
  } finally { await worker.close(); }
  assert.throws(() => worker.lifecycle.projectContext({ entries: [], leafId: null, mode: "ordinary" }), /unavailable/);
});
