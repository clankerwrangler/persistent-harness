import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessClient } from "../src/client.mjs";
import { HarnessStore } from "../src/store.mjs";
import { JsonLineDecoder, encodeFrame } from "../src/framing.mjs";
import { event, errorResponse, response, validateRequest } from "../src/protocol.mjs";

process.env.PI_HARNESS_ACTOR_ID = "reconnect-fixture";
process.env.PI_HARNESS_ACTOR_TOKEN = "fixture-only";
process.env.PI_HARNESS_ACTOR_GENERATION = "1";
delete process.env.PI_HARNESS_ACTOR_SKILL_GRANT;
const { default: extension } = await import("../src/extension.mjs");
const prompt = { systemPrompt: "base prompt", systemPromptOptions: { contextFiles: [] } };

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert(predicate(), label);
}

async function fixture(t, { holdReconnect = false, dropAck = false, rejectFlush = false, dropFlush = false, timeoutMs = 600 } = {}) {
  const dir = await mkdtemp("/tmp/ph-fr-");
  process.env.PI_CODING_AGENT_DIR = dir;
  const sessionFile = path.join(dir, "canonical.jsonl"), socketPath = path.join(dir, "actor.sock");
  await writeFile(sessionFile, "");
  process.env.PI_HARNESS_SOCKET = socketPath;
  const entries = [], sent = [], requests = [], registrations = [], acknowledgements = [], sockets = [], notices = [];
  const hooks = new Map(), owner = {}; let client, heldRegistration;
  const controller = new AbortController();
  const store = new HarnessStore(":memory:");
  store.createRoot({ sessionId: "sender", cwd: dir, name: "sender", actorToken: "fixture-parent", launch: {} }, 1);
  store.createChild("sender", { sessionId: "reconnect-fixture", actorToken: "fixture-only", policy: { name: "receiver" }, now: 2 });
  const append = entry => { entries.push(entry); appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`); return entry.id; };
  const canonicalEntries = () => readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const admit = (socket, request) => socket.write(encodeFrame(response(request.id, request.type, {
    session: { sessionId: request.params.sessionId, actorGeneration: request.params.actorGeneration, depth: 1 }, limits: {},
  })));
  const server = net.createServer(socket => {
    sockets.push(socket); socket.on("error", () => {});
    const decoder = new JsonLineDecoder();
    socket.on("data", chunk => {
      for (const raw of decoder.push(chunk)) {
        const request = validateRequest(raw);
        if (request.type === "register_actor") {
          registrations.push({ sessionId: request.params.sessionId, actorGeneration: request.params.actorGeneration });
          if (holdReconnect && registrations.length > 1) { heldRegistration = { socket, request }; continue; }
          admit(socket, request); continue;
        }
        requests.push({ type: request.type, params: request.params });
        assert(requests.length < 100, "fixture request bound");
        if (request.type === "ack_message") {
          const canonical = canonicalEntries();
          const from = canonical.find(entry => entry.type === "custom" && entry.data?.direction === "from" && entry.data.messageId === request.params.messageId);
          const incoming = canonical.find(entry => entry.type === "custom_message" && entry.details?.messageId === request.params.messageId);
          assert(from && incoming, "both canonical entry forms precede ACK");
          const acknowledged = store.acknowledgeMessage(request.params.messageId, "reconnect-fixture");
          acknowledgements.push({ messageId: request.params.messageId, fromEntryId: from.id, incomingEntryId: incoming.id, acknowledgedAt: acknowledged.acknowledgedAt });
          if (dropAck && acknowledgements.length === 1) { socket.destroy(); continue; }
          socket.write(encodeFrame(response(request.id, request.type, { message: acknowledged }))); continue;
        }
        if (request.type === "flush_actor_inputs" && rejectFlush) {
          socket.write(encodeFrame(errorResponse(request.id, request.type, "verified flush rejection"))); continue;
        }
        if (request.type === "flush_actor_inputs" && dropFlush) { socket.destroy(); continue; }
        socket.write(encodeFrame(response(request.id, request.type, request.type === "flush_actor_inputs" ? { flushed: true } : {})));
      }
    });
  });
  const start = HarnessClient.prototype.start;
  t.mock.method(HarnessClient.prototype, "start", function (registration) {
    client = this; this.heartbeatMs = 0; this.requestTimeoutMs = timeoutMs;
    this.reconnectBaseMs = 25; this.reconnectMaxMs = 25;
    return start.call(this, registration);
  });
  const ctx = { cwd: dir, model: { provider: "fixture", id: "ordinary" }, signal: controller.signal,
    ui: { setStatus() {}, notify: (...args) => notices.push(args) }, isIdle: () => false,
    sessionManager: { getSessionId: () => "reconnect-fixture", getSessionFile: () => sessionFile,
      getEntries: () => entries, getBranch: () => entries, getEntry: id => entries.find(entry => entry.id === id),
      appendCustomEntry: (customType, data) => append({ id: `entry-${entries.length}`, type: "custom", customType, data, timestamp: new Date().toISOString() }) } };
  extension({ events: { on() {} }, registerTool() {}, registerMessageRenderer() {}, registerCommand() {},
    on: (name, hook) => hooks.set(name, hook), getActiveTools: () => ["ipython"], setActiveTools() {},
    getAllTools: () => [{ name: "ipython" }], getCommands: () => [],
    sendMessage: (payload, options) => sent.push({ payload, options }) }, owner);
  t.after(async () => {
    controller.abort(); await client?.stop();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  server.listen(socketPath); await once(server, "listening");
  await hooks.get("session_start")({}, ctx);
  hooks.get("agent_start")();
  return { client, ctx, hooks, controller, store, sent, requests, registrations, acknowledgements, sockets, notices, entries, canonicalEntries,
    get heldRegistration() { return heldRegistration; },
    releaseRegistration({ reject = false } = {}) {
      const { socket, request } = heldRegistration; heldRegistration = undefined;
      if (reject) socket.end(encodeFrame(errorResponse(request.id, request.type, "fixture registration rejected")));
      else admit(socket, request);
    },
    async family() {
      const message = store.createMessage("sender", { messageId: "same-family-id", target: "reconnect-fixture", body: "held-work family result", deliveryMode: "auto" });
      store.recordMessageSenderEntry("sender", { messageId: message.messageId, entryId: "sender-entry", peerId: "reconnect-fixture", relationship: "child", body: message.body });
      store.markMessageDelivered(message.messageId, "reconnect-fixture");
      const frame = event("message_available", { message: { ...message, relationship: "parent", senderName: "sender", senderDepth: 0 }, deliverAs: "steer" });
      sockets[0].write(encodeFrame(frame)); await waitFor(() => sent.length === 1, "one family injection");
      append({ id: "incoming-entry", type: "custom_message", timestamp: new Date().toISOString(), ...sent[0].payload });
      return frame;
    },
    prepare() {
      const state = { outcome: "pending" };
      state.result = owner.prepareRequest(prompt, ctx).then(value => { state.outcome = "resolved"; return value; }, error => {
        state.outcome = "rejected"; state.error = error; return null;
      });
      return state;
    },
    async disconnect() { const closed = once(client, "disconnected"); sockets.at(-1).destroy(); await closed; },
  };
}

test("dropped committed ACK holds the request boundary until authenticated reconnect", { timeout: 5000 }, async t => {
  const f = await fixture(t, { dropAck: true, holdReconnect: true });
  const frame = await f.family();
  const closed = once(f.client, "disconnected");
  const preparation = f.prepare();
  await closed;
  await assert.rejects(f.client.request("heartbeat", {}), /harness is not connected/, "ordinary request semantics remain unchanged");
  await waitFor(() => f.heldRegistration, "reconnect reaches held registration");
  assert.equal(f.client.isConnected, true, "a socket exists before registration completes");
  assert.equal(f.client.connectedSession, undefined);
  assert.equal(preparation.outcome, "pending", `the request must not fail at the reconnect gap: ${preparation.error?.message}`);
  assert.equal(f.requests.filter(request => request.type === "flush_actor_inputs").length, 0);
  assert.equal(f.ctx.isIdle(), false); assert.equal(f.controller.signal.aborted, false);
  const reconnectSocket = f.heldRegistration.socket;
  f.releaseRegistration(); reconnectSocket.write(encodeFrame(frame));
  const prepared = await preparation.result;
  assert.equal(preparation.outcome, "resolved"); assert.match(prepared.systemPrompt, /base prompt/);
  await waitFor(() => f.acknowledgements.length === 2, "same-ID ACK retry");
  assert.deepEqual(f.acknowledgements[0], f.acknowledgements[1]);
  assert.equal(f.store.getMessage("same-family-id").state, "acknowledged");
  assert.equal(f.sent.length, 1); assert.equal(f.canonicalEntries().filter(entry => entry.type === "custom_message").length, 1);
  assert.equal(f.requests.filter(request => request.type === "flush_actor_inputs").length, 1);
  assert.equal(f.ctx.isIdle(), false); assert.equal(f.controller.signal.aborted, false);
  assert.deepEqual(f.registrations, Array(2).fill({ sessionId: "reconnect-fixture", actorGeneration: 1 }));
});


test("connected flush rejection still blocks request preparation", { timeout: 5000 }, async t => {
  const f = await fixture(t, { rejectFlush: true });
  const before = { status: f.client.listenerCount("status"), registered: f.client.listenerCount("registered") };
  const preparation = f.prepare(); await preparation.result;
  assert.equal(preparation.outcome, "rejected"); assert.match(preparation.error.message, /verified flush rejection/);
  assert.equal(f.requests.filter(request => request.type === "flush_actor_inputs").length, 1);
  assert.equal(f.client.listenerCount("status"), before.status);
  assert.equal(f.client.listenerCount("registered"), before.registered);
});

test("an in-flight flush transport failure is not silently replayed or bypassed", { timeout: 5000 }, async t => {
  const f = await fixture(t, { dropFlush: true, holdReconnect: true });
  const preparation = f.prepare(); await preparation.result;
  assert.equal(preparation.outcome, "rejected"); assert.match(preparation.error.message, /connection closed before response/);
  assert.equal(f.requests.filter(request => request.type === "flush_actor_inputs").length, 1);
});

for (const terminal of ["rejected", "stopped", "aborted", "timed out"]) {
  test(`registration wait rejects ${terminal} without issuing a flush or retaining listeners`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { holdReconnect: true, timeoutMs: terminal === "timed out" ? 140 : 600 });
    await f.disconnect();
    const before = { status: f.client.listenerCount("status"), registered: f.client.listenerCount("registered") };
    const preparation = f.prepare();
    await waitFor(() => f.heldRegistration, "held registration before terminal action");
    assert.equal(preparation.outcome, "pending");
    if (terminal === "rejected") f.releaseRegistration({ reject: true });
    else if (terminal === "stopped") await f.client.stop();
    else if (terminal === "aborted") f.controller.abort(new Error("explicit request abort"));
    await preparation.result;
    assert.equal(preparation.outcome, "rejected");
    assert.match(preparation.error.message, terminal === "aborted" ? /explicit request abort/ : new RegExp(`registration ${terminal}`));
    assert.equal(f.requests.filter(request => request.type === "flush_actor_inputs").length, 0);
    assert.equal(f.client.listenerCount("status"), before.status);
    assert.equal(f.client.listenerCount("registered"), before.registered);
  });
}
