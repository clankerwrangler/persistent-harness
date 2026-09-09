import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessStore } from "../src/store.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "input-boundary-hooks-"));
after(() => rm(directory, { recursive: true, force: true }));
process.env.PI_HARNESS_ACTOR_ID = "boundary-fixture";
process.env.PI_HARNESS_ACTOR_TOKEN = "fixture-only";
process.env.PI_HARNESS_ACTOR_GENERATION = "1";
delete process.env.PI_HARNESS_ACTOR_SKILL_GRANT;
process.env.PI_CODING_AGENT_DIR = directory;
const { default: extension } = await import("../src/extension.mjs");

async function fixture(t, flush, acknowledge = () => ({})) {
  const hooks = new Map(), commands = new Map(), sent = [], requests = [], trace = [], entries = [];
  const owner = {};
  let client;
  t.mock.method(HarnessClient.prototype, "start", async function () { client = this; return { session: { depth: 1 } }; });
  t.mock.getter(HarnessClient.prototype, "isConnected", () => true);
  t.mock.getter(HarnessClient.prototype, "connectedSession", () => ({ sessionId: "boundary-fixture", actorGeneration: 1, depth: 1 }));
  t.mock.method(HarnessClient.prototype, "request", async (type, params) => {
    requests.push({ type, params });
    if (type === "ack_message") return acknowledge(params.messageId);
    if (type === "flush_actor_inputs") { trace.push("flush"); return flush(); }
    if (type === "get_actor_input") return { input: { inputId: "cron", sessionId: "boundary-fixture", state: "queued",
      source: "cron", origin: { jobId: "job", runId: "run" }, acceptedAt: 10, message: "scheduled work", behavior: "auto" } };
    return {};
  });
  const file = path.join(directory, `${t.name.replace(/[^a-z]/gi, "-")}.jsonl`);
  await writeFile(file, "");
  const ctx = { cwd: directory, model: { provider: "fixture", id: "ordinary" },
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "boundary-fixture", getSessionFile: () => file,
      getEntries: () => entries, getBranch: () => { trace.push("namespace"); return entries; },
      getEntry: (id) => entries.find((entry) => entry.id === id),
      appendCustomEntry: (customType, data) => { const id = `custom-${entries.length}`;
        entries.push({ id, type: "custom", customType, data, timestamp: new Date().toISOString() }); return id; } },
    isIdle: () => false };
  extension({ events: { on() {} }, registerTool() {}, registerMessageRenderer() {}, registerCommand: (name, command) => commands.set(name, command),
    on: (name, hook) => hooks.set(name, hook), getActiveTools: () => ["ipython"], setActiveTools() {},
    getAllTools: () => [{ name: "ipython" }], getCommands: () => { trace.push("manifest"); return []; },
    sendMessage: (payload, options) => sent.push({ payload, options }) }, owner);
  await hooks.get("session_start")({}, ctx);
  return { hooks, owner, commands, sent, requests, trace, ctx, entries, client };
}

const request = { systemPrompt: "base prompt", systemPromptOptions: { contextFiles: [] } };

test("request preparation waits for the final queue barrier while internal receipt callbacks remain independent", async (t) => {
  const started = Promise.withResolvers(); const release = Promise.withResolvers();
  const f = await fixture(t, () => { started.resolve(); return release.promise; });
  let finished = false;
  const prepared = f.owner.prepareRequest(request, f.ctx).then((result) => { finished = true; return result; });
  await started.promise;
  assert.equal(finished, false); assert(f.trace.indexOf("manifest") < f.trace.indexOf("flush"));
  await f.commands.get("persistent-harness-input").handler("cron", f.ctx);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.customType, "persistent-harness-input");
  assert(f.requests.some(({ type }) => type === "accept_actor_input"));
  assert.equal(finished, false, "the receipt callback does not bypass or release the model-request barrier");
  release.resolve({ flushed: true });
  assert.match((await prepared).systemPrompt, /base prompt/);
});

test("a failed queue barrier is not swallowed as a prompt-preparation diagnostic", async (t) => {
  const f = await fixture(t, () => { throw new Error("queue barrier failed"); });
  await assert.rejects(f.owner.prepareRequest(request, f.ctx), /queue barrier failed/);
  assert(f.trace.includes("manifest")); assert.equal(f.trace.at(-1), "flush");
});

test("context-admitted family messages free durable pending capacity while native work stays active", async (t) => {
  const store = new HarnessStore(":memory:"); t.after(() => store.close());
  store.createRoot({ sessionId: "sender", cwd: directory, name: "sender", actorToken: "fixture-owner", launch: {} }, 1);
  store.createChild("sender", { sessionId: "boundary-fixture", actorToken: "fixture-child", policy: { name: "receiver" }, now: 2 });
  const queue = (messageId, deliveryMode = "auto") => {
    const message = store.createMessage("sender", { messageId, target: "boundary-fixture", body: messageId, deliveryMode }, { pendingLimit: 1 });
    store.recordMessageSenderEntry("sender", { messageId, entryId: `sender-${messageId}`, peerId: "boundary-fixture", relationship: "child", body: messageId });
    store.markMessageDelivered(messageId, "boundary-fixture");
    return { ...message, relationship: "parent", senderName: "sender", senderShortId: "short", senderDepth: 0 };
  };
  const first = queue("consumed");
  const f = await fixture(t, () => ({}), (messageId) => ({ message: store.acknowledgeMessage(messageId, "boundary-fixture") }));
  f.hooks.get("agent_start")();
  const receive = async (message) => {
    f.client.emit("event", { event: "message_available", data: { message, deliverAs: message.deliveryMode === "follow_up" ? "follow_up" : "steer" } });
    await new Promise(setImmediate);
  };
  await receive(first);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.deliverAs, "steer");
  await f.owner.prepareRequest(request, f.ctx);
  assert.equal(store.getMessage("consumed").state, "delivered", "the non-context from-entry is not acknowledgement evidence");
  assert.throws(() => store.createMessage("sender", { messageId: "blocked", target: "boundary-fixture", body: "result", deliveryMode: "auto" }, { pendingLimit: 1 }), /pending-message limit/);
  f.entries.push({ type: "custom_message", id: "admitted", timestamp: new Date().toISOString(), ...f.sent[0].payload });
  await f.owner.prepareRequest(request, f.ctx);
  assert.equal(store.getMessage("consumed").state, "acknowledged");
  assert.equal(f.ctx.isIdle(), false, "no settlement or tool completion is needed to acknowledge admitted context");
  const followUp = queue("after-work", "follow_up");
  await receive(followUp);
  assert.equal(f.sent[1].options.deliverAs, "followUp");
  await f.owner.prepareRequest(request, f.ctx);
  assert.equal(store.getMessage("after-work").state, "delivered", "queued follow-up must retain pending capacity until model admission");
});

test("a lost family acknowledgement is retried on redelivery without another context injection", async (t) => {
  const store = new HarnessStore(":memory:"); t.after(() => store.close());
  store.createRoot({ sessionId: "sender", cwd: directory, name: "sender", actorToken: "fixture-owner", launch: {} }, 1);
  store.createChild("sender", { sessionId: "boundary-fixture", actorToken: "fixture-child", policy: { name: "receiver" }, now: 2 });
  const message = store.createMessage("sender", { messageId: "retry-ack", target: "boundary-fixture", body: "result", deliveryMode: "auto" });
  store.recordMessageSenderEntry("sender", { messageId: message.messageId, entryId: "sender-entry", peerId: "boundary-fixture", relationship: "child", body: message.body });
  store.markMessageDelivered(message.messageId, "boundary-fixture");
  let attempts = 0;
  const f = await fixture(t, () => ({}), (messageId) => {
    attempts += 1; if (attempts === 1) throw new Error("simulated acknowledgement transport loss");
    return { message: store.acknowledgeMessage(messageId, "boundary-fixture") };
  });
  f.hooks.get("agent_start")();
  const frame = { event: "message_available", data: { message: { ...message, relationship: "parent", senderName: "sender" }, deliverAs: "steer" } };
  f.client.emit("event", frame); await new Promise(setImmediate);
  f.entries.push({ type: "custom_message", id: "admitted", timestamp: new Date().toISOString(), ...f.sent[0].payload });
  await f.owner.prepareRequest(request, f.ctx);
  assert.equal(attempts, 1); assert.equal(store.getMessage(message.messageId).state, "delivered");
  f.client.emit("event", frame); await new Promise(setImmediate);
  assert.equal(attempts, 2); assert.equal(store.getMessage(message.messageId).state, "acknowledged");
  assert.equal(f.sent.length, 1); assert.equal(f.ctx.isIdle(), false);
});


test("retry branch command rejects busy actors without mutating the session", async (t) => {
  const f = await fixture(t, () => ({}));
  let navigations = 0;
  f.ctx.navigateTree = async () => { navigations += 1; };
  const entries = structuredClone(f.entries);
  await assert.rejects(f.commands.get("persistent-harness-branch").handler("original-input", f.ctx),
    /session must be idle before retry branching/);
  assert.equal(navigations, 0); assert.deepEqual(f.entries, entries);
});

test("retry branch command awaits canonical navigation for an idle actor", async (t) => {
  const f = await fixture(t, () => ({}));
  f.ctx.isIdle = () => true;
  f.entries.push({ id: "input", parentId: null, type: "custom_message" },
    { id: "answer", parentId: "input", type: "message", message: { role: "assistant" } });
  let leaf = "answer", release;
  f.ctx.sessionManager.getLeafId = () => leaf;
  f.ctx.navigateTree = async (id, options) => {
    assert.equal(id, "input"); assert.deepEqual(options, { summarize: false });
    await new Promise(resolve => { release = resolve; }); leaf = null; return { cancelled: false };
  };
  let finished = false;
  const command = f.commands.get("persistent-harness-branch").handler("input", f.ctx).then(() => { finished = true; });
  assert.equal(finished, false); assert.equal(leaf, "answer");
  release(); await command;
  assert.equal(leaf, null); assert.equal(finished, true);
});
