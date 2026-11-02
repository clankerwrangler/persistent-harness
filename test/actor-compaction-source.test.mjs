import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { loadExternalPi } from "../src/external-pi.mjs";
import { createCompactionDriver, createCompactionPreparationCapture } from "../src/actor-compaction.mjs";
import { createAgentStartPromptCapture } from "../src/actor-prompt.mjs";
import { registerCanonicalSessionManager, projectCanonicalSource } from "../src/canonical-context.mjs";
import { renderMessageTimes } from "../src/message-time.mjs";
import { renderUserLocations } from "../src/input-location.mjs";
import { createNativeProviderAdapter } from "../src/native-provider.mjs";

const ownersPath = process.env.PI_HARNESS_TEST_COMPACTION_OWNERS;
const usage = () => ({ input: 70, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 72, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = text => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text, content = [{ type: "text", text }]) => ({ role: "assistant", content, timestamp: 2,
  provider: "fixture", api: "fixture", model: "fixture", stopReason: "stop", usage: usage() });
const digest = value => createHash("sha256").update(value).digest("hex");

test("large managed history uses accepted CLM preparation, appends/reopens, and yields a small complete native request", { skip: !ownersPath }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "compaction-source-"));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: temporary, PI_CODING_AGENT_DIR: path.join(temporary, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  let network = 0;
  const deny = () => { network++; throw new Error("Offline source fixture cannot use a network"); };
  mock.method(globalThis, "fetch", deny); mock.method(net.Socket.prototype, "connect", deny);
  mock.method(http, "request", deny); mock.method(https, "request", deny);
  t.after(async () => { mock.restoreAll(); for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); await rm(temporary, { recursive: true, force: true }); assert.equal(network, 0); });
  const external = await loadExternalPi(), owners = await import(ownersPath);
  const sdk = { ...external.sdk, prepareCompactionFromSource: owners.prepareCompactionFromSource, ExtensionRunner: owners.ExtensionRunner };
  const { api, core, responsesApi } = external;
  const manager = sdk.SessionManager.create(temporary, path.join(temporary, "sessions"), { entryRetention: { maxCachedBytes: 256 * 1024 } });
  manager.appendMessage(user("old raw question")); const bookmark = manager.appendMessage(assistant("old raw answer"));
  // The unchanged archive budget rejects this lifetime data; managed readers must not copy it.
  for (let i = 0; i < 6000; i++) manager.appendCustomEntry("opaque-fixture-history", { nested: Array.from({ length: 180 }, () => ({ value: "opaque" })) });
  manager.appendCustomEntry("live-context-state", { version: 1, enabled: true, revision: 174, checkpoint: {
    version: 1, revision: 174, sourceMessageCount: 2, sourceEntryId: bookmark, sourceDigest: "a".repeat(64),
    projectedMessages: [user("Accepted notes, exact pins and completed receipts. ".repeat(1000))], beforeEstimate: 50000, afterEstimate: 1000,
    estimateUnit: "tokens", createdAt: "2026-11-03T00:00:00Z",
  } });
  const frameSizes = [797316, 765676, 822296, 758544, 749260, 860576, 806816, 825632, 802820, 804848, 782020, 785636, 797968, 785276, 876468, 866996, 835328, 869464, 818040];
  const pending = [];
  let expectedCut;
  for (let i = 0; i < frameSizes.length; i++) {
    if (i === 16) expectedCut = manager.getLeafId(); // Stock retains adjacent receipt metadata before the first kept turn.
    manager.appendMessage(user(`frame ${i} observation request ` + "context ".repeat(100)));
    const callId = `call_fixture${i}|fc_fixture${i}`;
    const issuer = manager.appendMessage(assistant("", [{ type: "toolCall", id: callId, name: "ipython", arguments: { code: `synthetic_frame_${i}()` }, async: true, providerCallId: `call_fixture${i}`, providerItemId: `fc_fixture${i}` }]));
    const frame = { role: "toolResult", toolCallId: callId, toolName: "ipython", isError: false, timestamp: 3,
      content: [{ type: "text", text: `synthetic frame ${i}; review pending` }, { type: "image", mimeType: "image/webp", data: String.fromCharCode(65 + i).repeat(frameSizes[i]) }],
      details: { receipt: `receipt-${i}`, original: `fixture-original-${i}.png`, review: "pending" } };
    const result = manager.appendMessage(frame);
    manager.appendCustomEntry("fixture-receipt", { issuer, result, receipt: `receipt-${i}`, review: "pending" });
    if (i >= 16) { pending.push({ issuer, result, frame: structuredClone(frame), hash: digest(frame.content[1].data) });  }
  }
  manager.appendMessage(user("Continue reviewing the three latest synthetic originals; no new tool invocation."));
  const original = await readFile(manager.getSessionFile()), sessionId = manager.getSessionId();
  const models = await sdk.ModelRuntime.create({ authPath: path.join(temporary, "auth.json"), modelsPath: null, modelsStorePath: path.join(temporary, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let summaries = 0;
  models.registerProvider("fixture", { baseUrl: "http://127.0.0.1:1", apiKey: "offline", api: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096, cost: usage().cost }],
    streamSimple: () => { summaries++; const stream = api.createAssistantMessageEventStream(), message = assistant("Accepted synthetic recovery summary; completed receipts remain canonical."); queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); }); return stream; } });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 4500 }, retry: { enabled: false } });
  const capture = createCompactionPreparationCapture();
  const dormant = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "capture", factory: capture.factory }] }); await dormant.reload();
  const { session } = await sdk.createAgentSession({ cwd: temporary, agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: manager, modelRuntime: models, model: models.getModel("fixture", "fixture"), settingsManager: settings, resourceLoader: dormant, noTools: "all", contextMode: "source" });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const promptCapture = createAgentStartPromptCapture();
  let purposeReads = 0, hookViews = 0, providerHook = 0;
  const active = new sdk.DefaultResourceLoader({ cwd: temporary, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionsOverride: promptCapture.orderLast, extensionFactories: [pi => owners.liveContextExtension(pi, { editingMode: "clm", nativeCompaction: "on", overflow: { mode: "off" } }),
      pi => { pi.on("context_source", event => { if (event.purpose === "compaction") purposeReads++; });
        pi.on("session_before_compact", event => { hookViews++; assert.equal(event.branchEntries.length, manager.buildSessionEntrySource().branch.length); assert.equal(event.branchEntries.at(-1).id, manager.getLeafId()); });
        pi.on("before_provider_request", event => { providerHook++; return { ...event.payload, metadata: { offline_fixture: "complete-hooks" } }; }); }, promptCapture.extension] }); await active.reload();
  const loaded = active.getExtensions(); assert.deepEqual(loaded.errors, []);
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, temporary, manager, new sdk.ModelRegistry(models));
  const noop = () => {};
  runner.bindCore({ sendMessage: noop, sendUserMessage: noop, appendEntry: (type, data) => manager.appendCustomEntry(type, data), setSessionName: noop, getSessionName: noop, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => session.thinkingLevel, setThinkingLevel: noop },
    { getModel: () => session.model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: noop, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: noop, compact: noop, getSystemPrompt: () => "fixture system", getSystemPromptOptions: () => ({ cwd: temporary }) });
  const errors = []; runner.onError(error => errors.push(error));
  await runner.emit({ type: "session_start", reason: "startup" });
  registerCanonicalSessionManager(manager, { estimateContextTokens: sdk.estimateContextTokens });
  // Refuse the original lifetime archive APIs; the real source path must not use them.
  for (const name of ["getEntries", "getBranch", "getEntriesRange"]) mock.method(manager, name, () => { throw new Error(`Lifetime body materialization: ${name}`); });
  const entryReader = manager.buildSessionEntryReader.bind(manager), coldReads = [];
  mock.method(manager, "buildSessionEntryReader", () => { const source = entryReader(); return { ...source, read: (i, key) => { if (source.getEntryHeader(i).customType === "opaque-fixture-history") coldReads.push(i); return source.read(i, key); } }; });
  const driver = createCompactionDriver({ sdk, core, runner, session, models, capture });
  const answer = await driver({ coordinator: { manager, session }, signal: new AbortController().signal });
  assert.equal(answer.firstKeptEntryId, expectedCut);
  assert.equal(purposeReads, 1); assert.equal(hookViews, 1); assert(summaries >= 1);
  assert.equal(coldReads.length, 0);
  assert.equal(manager.getSessionId(), sessionId);
  const committed = await readFile(manager.getSessionFile()); assert(committed.subarray(0, original.length).equals(original));
  const reopened = sdk.SessionManager.open(manager.getSessionFile(), undefined, temporary, { entryRetention: { maxCachedBytes: 256 * 1024 } });
  assert.equal(reopened.getSessionId(), sessionId);
  for (const frame of pending) { assert.deepEqual(reopened.getEntry(frame.result).message, frame.frame); assert.equal(digest(reopened.getEntry(frame.result).message.content[1].data), frame.hash); assert(reopened.getEntry(frame.issuer)); }
  const finalMessages = reopened.buildSessionSource().readAll();
  assert.equal(finalMessages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image") : []).length, 3);
  // Complete normal post-recovery context/prompt/notice/provider-hook/native serialization.
  const preparedPrompt = await promptCapture.prepare(runner, "continue", [], { cwd: temporary, customPrompt: "Offline rendered system section. ".repeat(32768), selectedTools: ["ipython", "wait_for_ipython"] });
  const source = projectCanonicalSource({ sessionManager: manager, mode: "native" }).source;
  const effective = (await runner.emitContextSource(source)).readAll();
  assert(effective.some(message => message.customType === "live-context-notice"));
  const tools = [{ name: "ipython", description: "Execute Python in the persistent namespace.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false }, async: true }, { name: "wait_for_ipython", description: "Wait for Python.", parameters: { type: "object", properties: {}, additionalProperties: false } }];
  const nativeModel = { id: "gpt-6.1-sol", name: "Fixture native serializer", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://example.invalid", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096, cost: usage().cost, compat: { supportsAsyncTools: true } };
  let wireBytes = 0, imageBytes = 0;
  const adapter = createNativeProviderAdapter({ api, responsesApi, modelRuntime: { getAuth: async () => ({ auth: {} }) }, transportOptions: { fetch: deny, WebSocket: class { constructor() { deny(); } } } });
  await adapter.stream(nativeModel, { systemPrompt: preparedPrompt.systemPrompt, messages: sdk.convertToLlm(renderMessageTimes(renderUserLocations(effective))), tools }, { sessionId, reasoning: "xhigh", transport: "auto", onPayload: async payload => {
    const complete = await runner.emitBeforeProviderRequest(payload);
    assert.equal(complete.metadata.offline_fixture, "complete-hooks");
    wireBytes = Buffer.byteLength(JSON.stringify({ ...complete, type: "response.create" }));
    JSON.stringify(complete, (key, value) => { if (key === "image_url" && typeof value === "string" && value.startsWith("data:")) imageBytes += Buffer.byteLength(value); return value; });
    throw new Error("OFFLINE_CAPTURE_COMPLETE");
  } }).result(); await adapter.close();
  assert(wireBytes > imageBytes && imageBytes > 2500000); assert(wireBytes < 5 * 1024 * 1024);
  assert.equal(providerHook, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidence: "synthetic-complete-post-recovery-request", wireBytes, imageUriBytes: imageBytes, priorLeadBytes: 16743564, marginBytes: 16743564 - wireBytes, keptImages: 3, coldBodyReads: coldReads.length, summaries, canonicalPrefixBytesPreserved: original.length, networkCalls: network }));
  await runner.emit({ type: "session_shutdown", reason: "exit" });
});


test("an async span crossing from an unanchored accepted prefix cannot dispatch a summary", { skip: !ownersPath }, async () => {
  const external = await loadExternalPi(), owners = await import(ownersPath);
  const sdk = { ...external.sdk, prepareCompactionFromSource: owners.prepareCompactionFromSource };
  const manager = sdk.SessionManager.inMemory();
  manager.appendMessage(user("old user"));
  const callId = "call_unanchored|fc_unanchored";
  const call = manager.appendMessage(assistant("", [{ type: "toolCall", id: callId, name: "ipython", arguments: { code: "past()" }, async: true, providerCallId: "call_unanchored", providerItemId: "fc_unanchored" }]));
  manager.appendMessage(assistant("progress ".repeat(100)));
  manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "ipython", isError: false, timestamp: 3,
    content: [{ type: "text", text: "done" }, { type: "image", mimeType: "image/png", data: "QUFB" }] });
  manager.appendMessage(user("latest"));
  registerCanonicalSessionManager(manager);
  let providers = 0;
  const session = { sessionManager: manager, isIdle: true, model: {}, extensionRunner: {}, settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 0, keepRecentTokens: 2000 }) } };
  const runner = { emitContextSource: async source => owners.compactionSource(source, { version: 1, revision: 1, sourceMessageCount: 2, sourceEntryId: call,
    sourceDigest: "a".repeat(64), projectedMessages: [source.read(1)], beforeEstimate: 1, afterEstimate: 1, createdAt: "2026-11-03T00:00:00Z" }, owners.resolveObservationCap(undefined), () => {}), createContext: () => ({}), emit: () => {} };
  const driver = createCompactionDriver({ sdk, session, runner, models: { streamSimple: () => { providers++; throw new Error("unexpected summary"); } } });
  const count = manager.getEntryCount();
  await assert.rejects(driver({ coordinator: { manager, session }, signal: new AbortController().signal }), { code: "ERR_COMPACTION_KEPT_ANCHOR" });
  assert.equal(providers, 0); assert.equal(manager.getEntryCount(), count);
});
