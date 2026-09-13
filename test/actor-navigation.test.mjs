import assert from "node:assert/strict";
import { after, test, mock } from "node:test";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { loadExternalPi } from "../src/external-pi.mjs";
import { bootstrapSDKWorker } from "../src/sdk-worker.mjs";
import { THINKING_SIGNATURE_CUSTOM_TYPE } from "../src/canonical-context.mjs";
import { createNavigationDriver, prepareActorNavigation } from "../src/actor-navigation.mjs";

const saved = { ...process.env }, temporary = await mkdtemp(path.join(os.tmpdir(), "actor-navigation-"));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: saved.PATH, HOME: temporary, PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
  PI_HARNESS_PI_MODULE: saved.PI_HARNESS_PI_MODULE, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
await mkdir(process.env.PI_CODING_AGENT_DIR);
let network = 0;
const deny = () => { network++; throw new Error("Navigation fixture network denied"); };
mock.method(globalThis, "fetch", deny); mock.method(net.Socket.prototype, "connect", deny);
mock.method(http, "request", deny); mock.method(https, "request", deny);
after(async () => { mock.restoreAll(); for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved); await rm(temporary, { recursive: true, force: true }); assert.equal(network, 0); });
const external = await loadExternalPi(), { sdk, api, core } = external;
const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = text => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "navigation-fixture",
  model: "fixture", usage, stopReason: "stop", timestamp: 2, ...extra });
async function fixture(t, { hooks = () => {}, lifecycle = {}, streamSimple, publish } = {}) {
  const cwd = await mkdtemp(path.join(temporary, "case-")), agentDir = path.join(cwd, "agent"); await mkdir(agentDir);
  const events = [], requests = [];
  const worker = await bootstrapSDKWorker({ external, cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, lifecycle,
    argv: ["--mode", "rpc", "--session", path.join(cwd, "session.jsonl"), "--provider", "navigation-fixture", "--model", "fixture",
      "--no-extensions", "--no-skills", "--no-context-files", "--no-tools"], publish: event => { events.push(event); return publish?.(event); },
    extensionFactory(pi) {
      pi.registerProvider("navigation-fixture", { api: "fixture", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only",
        models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, context, options) {
          requests.push({ model, context: structuredClone(context), options });
          if (streamSimple) return streamSimple(model, context, options);
          const stream = api.createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = assistant("default branch summary");
            stream.push({ type: "start", partial: { ...message, content: [] } });
            stream.push({ type: "done", reason: "stop", message }); stream.end();
          });
          return stream;
        },
      }); hooks(pi);
    },
  });
  const manager = worker.session.sessionManager;
  const driver = createNavigationDriver({ sdk, core, runner: worker.runner, session: worker.session, models: worker.models, lifecycle,
    publish: event => { events.push(event); return publish?.(event); } });
  const navigate = (target, options, signal = new AbortController().signal) => worker.coordinator.withServiceMutation(
    () => driver(target, options, { coordinator: worker.coordinator, signal }));
  t.after(() => worker.close());
  return { worker, manager, navigate, driver, events, requests, cwd, agentDir };
}
function seed(manager, kind = "user", prior = false) {
  const parent = prior ? manager.appendMessage(user("prior")) : manager.getLeafId();
  const input = kind === "custom" ? manager.appendCustomMessageEntry("internal", " exact custom ", true, { source: "background", inputId: "input" })
    : manager.appendMessage({ ...user(" exact input "), id: "input" });
  const answer = manager.appendMessage(assistant("abandoned"));
  return { parent, input, answer };
}

test("public cancel-hook oracle matches branch preparation across target types and branch summaries", async t => {
  for (const kind of ["user", "custom", "other", "compacted", "branched"]) {
    const f = await fixture(t), ids = seed(f.manager, kind, true);
    let target = kind === "other" ? ids.answer : ids.input;
    if (kind === "compacted") f.manager.appendCompaction("compact", ids.input, 100);
    if (kind === "branched") { f.manager.branch(ids.input); target = f.manager.appendMessage(user("alternate")); f.manager.branch(ids.answer); }
    f.manager.appendMessage(assistant("latest"));
    const observed = [], resources = new sdk.DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir,
      settingsManager: f.worker.session.settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => pi.on("session_before_tree", event => { observed.push(structuredClone(event.preparation)); return { cancel: true }; })] });
    await resources.reload();
    const { session: oracle } = await sdk.createAgentSession({ cwd: f.cwd, agentDir: f.agentDir, sessionManager: f.manager,
      modelRuntime: f.worker.models, model: f.worker.session.model, settingsManager: f.worker.session.settingsManager, resourceLoader: resources, noTools: "all" });
    await oracle.bindExtensions({});
    try {
      const before = structuredClone(f.manager.getEntries()), leaf = f.manager.getLeafId();
      const options = { summarize: true, customInstructions: "focus", replaceInstructions: true, label: "bookmark" };
      assert.deepEqual(await oracle.navigateTree(target, options), { cancelled: true });
      assert.deepEqual(prepareActorNavigation({ sdk, manager: f.manager, targetId: target, options }).preparation, observed[0], kind);
      assert.deepEqual(f.manager.getEntries(), before); assert.equal(f.manager.getLeafId(), leaf); assert.equal(f.requests.length, 0);
    } finally { oracle.dispose(); }
  }
});

for (const kind of ["user", "custom"]) for (const prior of [false, true]) test(`navigation excludes ${kind} input at ${prior ? "prior" : "root"} without replay`, async t => {
  let before = 0, after = 0, commits = 0;
  const f = await fixture(t, { hooks(pi) { pi.on("session_before_tree", () => { before++; }); pi.on("session_tree", () => { after++; }); },
    lifecycle: { afterCommit: () => { commits++; } } });
  // Drop bootstrap inference metadata so the false case is a literal null parent.
  if (!prior) f.manager.resetLeaf();
  const ids = seed(f.manager, kind, prior), original = structuredClone(f.manager.getEntries());
  const file = f.manager.getSessionFile(), bytes = await readFile(file), inode = (await stat(file)).ino;
  const result = await f.navigate(ids.input, { summarize: false });
  assert.equal(result.cancelled, false); assert.equal(result.editorText, kind === "custom" ? " exact custom " : " exact input ");
  assert.equal(f.manager.getLeafId(), ids.parent); assert.deepEqual(f.manager.getEntries(), original);
  assert.deepEqual(f.worker.session.messages, f.manager.buildSessionContext().messages);
  assert.equal(JSON.stringify(f.worker.session.messages).includes("abandoned"), false);
  assert.deepEqual([before, after, commits, f.requests.length], [1, 1, 1, 0]);
  assert.equal((await stat(file)).ino, inode); assert.deepEqual(await readFile(file), bytes);
});

test("active cancellation and abort preserve the leaf and context before any canonical mutation", async t => {
  let trees = 0;
  const f = await fixture(t, { hooks(pi) { pi.on("session_before_tree", () => ({ cancel: true })); pi.on("session_tree", () => { trees++; }); } });
  const ids = seed(f.manager), before = structuredClone(f.manager.getEntries()), messages = structuredClone(f.worker.session.messages);
  assert.deepEqual(await f.navigate(ids.input, { summarize: true }), { cancelled: true });
  assert.deepEqual(await f.navigate(ids.input, {}, AbortSignal.abort()), { cancelled: true, aborted: true });
  assert.deepEqual(f.manager.getEntries(), before); assert.deepEqual(f.worker.session.messages, messages);
  assert.equal(f.manager.getLeafId(), ids.answer); assert.equal(trees, 0); assert.equal(f.requests.length, 0);
});

test("custom summary and label retain details, usage, fromId and one canonical commit", async t => {
  const f = await fixture(t, { hooks(pi) { pi.on("session_before_tree", () => ({ summary: { summary: "custom summary", details: { proof: true }, usage }, label: "hook label" })); } });
  const ids = seed(f.manager), count = f.manager.getEntries().length;
  const outcome = await f.navigate(ids.input, { summarize: true });
  assert.equal(outcome.summaryEntry.parentId, ids.parent); assert.equal(outcome.summaryEntry.fromId, ids.answer);
  assert.equal(outcome.summaryEntry.fromHook, true); assert.deepEqual(outcome.summaryEntry.usage, usage); assert.deepEqual(outcome.summaryEntry.details, { proof: true });
  assert.equal(f.manager.getLabel(outcome.summaryEntry.id), "hook label"); assert.equal(f.manager.getEntries().length, count + 2);
  assert.equal(f.requests.length, 0); assert.equal(f.events.filter(event => event.type === "entry_appended").length, 2);
});

test("default public branch summary honors active instruction overrides and provider hooks", async t => {
  let payloads = 0;
  const f = await fixture(t, { hooks(pi) {
    pi.on("session_before_tree", () => ({ customInstructions: "REPLACEMENT_FOCUS", replaceInstructions: true, label: "default label" }));
    pi.on("before_provider_request", () => { payloads++; });
    pi.on("before_provider_headers", event => { event.headers["x-navigation-fixture"] = "active"; });
  } });
  const ids = seed(f.manager), outcome = await f.navigate(ids.input, { summarize: true, customInstructions: "original" });
  assert.equal(f.requests.length, 1); assert.match(JSON.stringify(f.requests[0].context), /REPLACEMENT_FOCUS/);
  assert.doesNotMatch(JSON.stringify(f.requests[0].context), /Create a structured summary/);
  assert.match(outcome.summaryEntry.summary, /default branch summary/); assert.equal(outcome.summaryEntry.fromHook, false);
  assert.deepEqual(outcome.summaryEntry.usage, usage); assert.equal(f.manager.getLabel(outcome.summaryEntry.id), "default label");
  await f.requests[0].options.onPayload({ fixture: true }); assert.equal(payloads, 1);
  assert.equal(f.requests[0].options.headers["x-navigation-fixture"], "active"); assert.equal(typeof f.requests[0].options.onResponse, "function");
});

test("stale hooks and invalid summary data reject before driver writes", async t => {
  const f = await fixture(t, { hooks(pi) { pi.on("session_before_tree", () => { pi.appendEntry("external", {}); return { cancel: true }; }); } });
  const ids = seed(f.manager), count = f.manager.getEntries().length;
  await assert.rejects(f.navigate(ids.input, {}), { code: "ERR_NAVIGATION_STALE_SNAPSHOT" });
  assert.equal(f.manager.getEntries().length, count + 1); assert.equal(f.manager.getLeafEntry().customType, "external");
  const g = await fixture(t, { hooks(pi) { pi.on("session_before_tree", () => ({ summary: { summary: 7 } })); } });
  const target = seed(g.manager), original = structuredClone(g.manager.getEntries());
  await assert.rejects(g.navigate(target.input, { summarize: true }), { code: "ERR_NAVIGATION_SUMMARY" });
  assert.deepEqual(g.manager.getEntries(), original);
});

test("service lease remains held until summary cancellation drains", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { streamSimple() {
    const stream = api.createAssistantMessageEventStream(); entered.resolve();
    void release.promise.then(() => { stream.push({ type: "error", reason: "aborted", error: assistant("", { stopReason: "aborted" }) }); stream.end(); });
    return stream;
  } });
  const ids = seed(f.manager), controller = new AbortController(), pending = f.navigate(ids.input, { summarize: true }, controller.signal);
  await entered.promise; controller.abort();
  assert.equal(f.worker.coordinator.serviceMutation, true); assert.equal(f.worker.session.isIdle, true);
  let settled = false; pending.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release.resolve(); assert.deepEqual(await pending, { cancelled: true, aborted: true });
  assert.equal(f.worker.coordinator.serviceMutation, false); assert.equal(f.manager.getLeafId(), ids.answer);
});

test("post-commit failures are explicit and never replay navigation or summary", async t => {
  const f = await fixture(t, { lifecycle: { afterCommit: () => { throw new Error("observer failed"); } } });
  const ids = seed(f.manager), count = f.manager.getEntries().length;
  await assert.rejects(f.navigate(ids.input, { summarize: true }), error => error.code === "ERR_NAVIGATION_COMMITTED" && error.committed === true);
  assert.equal(f.requests.length, 1); assert.equal(f.manager.getEntries().length, count + 1);
  assert.equal(f.manager.getLeafEntry().type, "branch_summary");
});

test("committed navigation notification failure invalidates owner recovery before the next canonical request", async t => {
  const observerFailure = new Error("navigation observer failed");
  let failNotification = false, before = 0, after = 0;
  const f = await fixture(t, { hooks(pi) {
    pi.on("session_before_tree", () => { before++; }); pi.on("session_tree", () => { after++; });
  }, lifecycle: { afterCommit() { if (failNotification) { failNotification = false; throw observerFailure; } } } });
  const manager = f.manager, coor = f.worker.coordinator;
  f.worker.session.settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  const common = manager.appendMessage(user("common question"));
  const selectedCall = manager.appendMessage(assistant("", { stopReason: "toolUse", content: [
    { type: "toolCall", id: "selected-unfinished", name: "never_execute", arguments: {}, async: true }] }));
  const target = manager.appendMessage(user("selected retry input"));
  manager.appendMessage(assistant("selected abandoned answer"));
  manager.branch(common);
  manager.appendMessage(assistant("", { stopReason: "toolUse", content: [
    { type: "toolCall", id: "old-only", name: "never_execute", arguments: {} }] }));
  manager.appendMessage({ role: "toolResult", toolCallId: "old-only", toolName: "never_execute",
    content: [{ type: "text", text: "old result" }], isError: false, timestamp: 3 });
  await f.worker.handle({ type: "prompt", message: "warm up old branch" }); await coor.waitForIdle();
  assert.equal(coor.recoveryDone, true); assert.deepEqual([...coor.seenCalls], ["old-only"]);
  assert.equal(coor.failure, null, coor.failure?.stack);
  assert.ok(coor.getContextUsage().tokens > 0); assert.equal(f.requests.length, 1);
  const oldLeaf = manager.getLeafId(), previousController = coor.controller;
  const count = manager.getEntries().length, file = manager.getSessionFile();
  const bytes = await readFile(file), inode = (await stat(file)).ino;
  failNotification = true;
  let failure;
  await assert.rejects(f.worker.runner.createCommandContext().navigateTree(target, { summarize: true }), error => {
    failure = error;
    return error.code === "ERR_NAVIGATION_COMMITTED" && error.committed === true && error.cause === observerFailure;
  });
  const summary = manager.getLeafEntry();
  assert.equal(summary.type, "branch_summary"); assert.equal(summary.parentId, selectedCall); assert.equal(summary.fromId, oldLeaf);
  assert.equal(failure.result.summaryEntry.id, summary.id); assert.equal(failure.result.cancelled, false);
  assert.deepEqual([before, after, f.requests.length, manager.getEntries().length], [1, 1, 2, count + 1]);
  assert.equal(coor.controller, previousController); assert.equal(coor.serviceMutation, false); assert.equal(coor.isBusy, false);
  assert.equal(coor.recoveryDone, false); assert.deepEqual([...coor.seenCalls], []); assert.equal(coor.getContextUsage(), undefined);
  assert.ok(JSON.stringify(f.worker.session.messages).includes("selected-unfinished"));
  assert.equal(JSON.stringify(f.worker.session.messages).includes("old-only"), false);
  await f.worker.handle({ type: "prompt", message: "next canonical request" }); await coor.waitForIdle();
  assert.equal(coor.failure, null, coor.failure?.stack);
  assert.equal(f.requests.length, 3); assert.equal(coor.recoveryDone, true);
  assert.deepEqual([...coor.seenCalls], ["selected-unfinished"]); assert.ok(coor.getContextUsage().tokens > 0);
  const next = f.requests[2].context.messages, recovered = next.filter(message => message.role === "toolResult");
  assert.equal(recovered.length, 1); assert.equal(recovered[0].toolCallId, "selected-unfinished");
  assert.deepEqual(recovered[0].details, { nativeAsyncRecovery: "interrupted-unknown" });
  assert.equal(recovered[0].isError, true); assert.match(recovered[0].content[0].text, /not re-executed/);
  assert.equal(JSON.stringify(next).includes("old-only"), false); assert.equal(JSON.stringify(next).includes("warm up old branch"), false);
  assert.equal(JSON.stringify(next).includes("selected abandoned answer"), false);
  const appended = manager.getEntries().slice(count), recoveryEntry = appended.find(entry => entry.message?.toolCallId === "selected-unfinished");
  const nextInput = appended.find(entry => entry.message?.role === "user");
  assert.equal(recoveryEntry.parentId, summary.id); assert.equal(nextInput.parentId, recoveryEntry.id);
  await f.worker.handle({ type: "prompt", message: "one more request" }); await coor.waitForIdle();
  assert.equal(f.requests.length, 4); assert.deepEqual([before, after], [1, 1]);
  assert.equal(manager.getEntries().slice(count).filter(entry => entry.type === "branch_summary").length, 1);
  assert.equal(manager.getEntries().slice(count).filter(entry => entry.message?.toolCallId === "selected-unfinished").length, 1);
  assert.equal(f.events.filter(event => event.type.startsWith("tool_execution_")).length, 0);
  assert.equal((await stat(file)).ino, inode); assert.deepEqual((await readFile(file)).subarray(0, bytes.length), bytes);
});

test("navigation rejects missing lease, signal and target, and preserves current-leaf no-op", async t => {
  const f = await fixture(t), ids = seed(f.manager);
  await assert.rejects(f.driver(ids.input, {}, { coordinator: f.worker.coordinator, signal: AbortSignal.abort() }), { code: "ERR_NAVIGATION_OWNER" });
  await assert.rejects(f.worker.coordinator.withServiceMutation(() => f.driver(ids.input, {}, { coordinator: f.worker.coordinator })), { code: "ERR_NAVIGATION_SIGNAL" });
  await assert.rejects(f.navigate("missing", {}), { code: "ERR_NAVIGATION_TARGET" });
  assert.deepEqual(await f.navigate(ids.answer, {}), { cancelled: false });
});

for (const terminal of ["stop", "aborted", "error"]) test(`held ${terminal} summary excludes queued inference and projects only selected signature metadata`, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const hooks = [], observed = [], signature = JSON.stringify({ type: "reasoning", id: "rs-navigation", summary: [] });
  let calls = 0;
  const f = await fixture(t, { hooks(pi) {
    pi.on("session_before_tree", (event, ctx) => { hooks.push("before"); assert.equal(ctx.isIdle(), false); assert.equal(event.signal.aborted, false); });
    pi.on("session_tree", (event, ctx) => { hooks.push("after"); assert.equal(ctx.isIdle(), false); observed.push(event); });
  }, streamSimple() {
    const number = ++calls, stream = api.createAssistantMessageEventStream();
    const finish = () => {
      const reason = number === 1 ? terminal : "stop";
      const message = assistant(number === 1 ? "held branch summary" : "queued response", {
        stopReason: reason, ...(reason === "error" ? { errorMessage: "Invalid fixture summary" } : {}) });
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push(reason === "error" || reason === "aborted" ? { type: "error", reason, error: message } : { type: "done", reason, message });
      stream.end();
    };
    if (number === 1) { entered.resolve(); void release.promise.then(finish); } else queueMicrotask(finish);
    return stream;
  } });
  f.worker.session.settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
  const manager = f.manager, file = manager.getSessionFile();
  manager.appendMessage(user("original question"));
  const reasoningId = manager.appendMessage(assistant("", { id: "reasoning-message", content: [
    { type: "thinking", thinking: "reasoning text", thinkingSignature: signature }, { type: "text", text: "selected answer" }] }));
  const data = encryptedContent => ({ version: 1, messageEntryId: reasoningId, messageId: "reasoning-message", contentIndex: 0,
    itemId: "rs-navigation", encryptedContent });
  const selected = manager.appendCustomEntry(THINKING_SIGNATURE_CUSTOM_TYPE, data("selected-encryption"));
  const input = manager.appendMessage(user("abandoned input")), oldLeaf = manager.appendMessage(assistant("abandoned answer"));
  manager.branch(reasoningId); manager.appendCustomEntry(THINKING_SIGNATURE_CUSTOM_TYPE, data("excluded-encryption"));
  manager.appendMessage(assistant("excluded sibling")); manager.branch(oldLeaf);
  const count = manager.getEntries().length, bytes = await readFile(file), inode = (await stat(file)).ino;
  const navigation = f.worker.runner.createCommandContext().navigateTree(input, { summarize: true });
  const result = navigation.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  assert.equal(f.worker.coordinator.serviceMutation, true); assert.equal(f.worker.session.isIdle, true);
  assert.equal(f.worker.runner.createContext().sessionManager, manager); assert.equal(f.worker.session.sessionManager, manager);
  assert.deepEqual(await f.worker.handle({ type: "prompt", message: "queued input", messageId: "queued-id" }), { outcome: "accepted" });
  await assert.rejects(f.worker.runner.createCommandContext().navigateTree(reasoningId, {}), /idle/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "queued inference cannot overlap summary flight");
  assert.equal(manager.getLeafId(), oldLeaf); assert.equal(manager.getEntries().length, count); assert.deepEqual(hooks, ["before"]);
  if (terminal === "aborted") f.worker.coordinator.controller.abort();
  release.resolve(); const settled = await result;
  if (terminal === "error") assert.equal(settled.error.code, "ERR_NAVIGATION_SUMMARY");
  else assert.equal(settled.value.cancelled, terminal === "aborted");
  await f.worker.coordinator.waitForIdle();
  assert.equal(f.worker.coordinator.serviceMutation, false); assert.equal(calls, 2);
  assert.equal(f.worker.coordinator.failure, null, f.worker.coordinator.failure?.stack);
  assert.equal(f.events.filter(event => event.type.startsWith("tool_execution_")).length, 0);
  const summaryEntries = manager.getEntries().slice(count).filter(entry => entry.type === "branch_summary");
  assert.equal(summaryEntries.length, terminal === "stop" ? 1 : 0);
  assert.deepEqual(hooks, terminal === "stop" ? ["before", "after"] : ["before"]);
  if (terminal === "stop") {
    assert.equal(summaryEntries[0].parentId, selected); assert.equal(summaryEntries[0].fromId, oldLeaf);
    assert.equal(observed[0].summaryEntry.id, summaryEntries[0].id);
  }
  const nextContext = f.requests[1].context.messages;
  const thinking = nextContext.flatMap(message => message.content ?? []).find(part => part.type === "thinking");
  assert.equal(JSON.parse(thinking.thinkingSignature).encrypted_content, "selected-encryption");
  assert.equal(JSON.stringify(nextContext).includes("excluded-encryption"), false);
  assert.equal(JSON.stringify(nextContext).includes("abandoned answer"), terminal !== "stop");
  if (terminal === "stop") {
    const dormantThinking = f.worker.session.messages.flatMap(message => message.content ?? []).find(part => part.type === "thinking");
    assert.equal(JSON.parse(dormantThinking.thinkingSignature).encrypted_content, "selected-encryption");
  }
  assert.equal(manager.getEntry(reasoningId).message.content[0].thinkingSignature, signature, "stored original signature stays immutable");
  assert.equal((await stat(file)).ino, inode); assert.deepEqual((await readFile(file)).subarray(0, bytes.length), bytes);
});
