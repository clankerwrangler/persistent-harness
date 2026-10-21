import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { JsonLineDecoder, encodeFrame } from "../src/framing.mjs";
import { PROTOCOL_VERSION } from "../src/protocol.mjs";
import { HarnessSupervisor, socketOutputBufferLimit } from "./fixtures/isolated-supervisor.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const deferred = () => Promise.withResolvers();
async function bounded(promise, description, timeout = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(probe, description, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Timed out: ${description}`);
}

// Use the same actor/runtime/process seams as the adjacent supervisor tests.
// No fake actor starts an OS process, loads credentials, or calls a provider.
class TransportActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.compacts = 0; this.compactGate = null; this.submits = []; this.callbackRounds = 0; this.pendingCallbacks = new Map(); this.receivedCallbacks = []; }
  async start() { this.isRunning = true; return this.state(); }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null, thinkingLevel: "off" }; }
  async request(type) {
    if (type === "get_state") return this.state();
    if (type === "get_entries") return { entries: [], leafId: null };
    if (type === "compact") {
      const index = ++this.compacts;
      if (this.callbackRounds > 0) {
        this.callbackRounds--; const id = `transport-dialog-${index}`, gate = deferred(); this.pendingCallbacks.set(id, gate);
        const response = await gate.promise; return { summary: `compaction-${index}`, confirmed: response.confirmed === true };
      }
      if (index === 1 && this.compactGate) { this.compactGate.started.resolve(); await this.compactGate.release.promise; }
      return { summary: `compaction-${index}` };
    }
    if (type === "prompt") return {};
    throw new Error(`Unexpected synthetic actor request: ${type}`);
  }
  async submit(message, behavior, images = []) { this.submits.push({ message, behavior, images }); return {}; }
  showCallback(id) {
    assert(this.pendingCallbacks.has(id));
    this.emit("event", { type: "extension_ui_request", id, method: "confirm", title: "Synthetic transport callback",
      message: "Private fixture only", timeout: 1000 });
  }
  send(frame) {
    if (frame?.type !== "extension_ui_response") return;
    const gate = this.pendingCallbacks.get(frame.id); if (!gate) return;
    this.pendingCallbacks.delete(frame.id); this.receivedCallbacks.push(frame); gate.resolve(frame);
  }
  async close() { if (!this.isRunning) return;
    for (const gate of this.pendingCallbacks.values()) gate.resolve({ cancelled: true }); this.pendingCallbacks.clear();
    this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}

async function fixture(t, { maxFrameBytes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-transport-"));
  const saved = { ...process.env }, clients = [], sockets = [], gates = [], actors = new Map();
  let supervisor;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_HARNESS_AUTO_INSTALL: "0",
    ...Object.fromEntries(["PI_HARNESS_PI_COMMAND", "PI_HARNESS_PI_MODULE", "NODE_TEST_CONTEXT"].filter(key => saved[key]).map(key => [key, saved[key]])) });
  await Promise.all([mkdir(process.env.HOME), mkdir(process.env.PI_CODING_AGENT_DIR), mkdir(path.join(root, "skills"))]);
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    for (const socket of sockets) socket.destroy();
    await Promise.all(clients.map(client => client.stop())); await supervisor?.stop();
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const reader = new VisibleTranscriptReader(), readGates = new Map();
  const socketPath = path.join(root, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    skillsPath: path.join(root, "skills"), runtimeDir: path.join(root, "runtime"), backgroundJobsDirectory: path.join(root, "background-jobs"),
    actorInactivityMs: 0, ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }), runtimeProvisioner: async () => ({}), titleGenerator: async () => "Synthetic",
    actorFactory: options => { const actor = new TransportActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "synthetic", ownerToken: "synthetic" }),
    processTerminator: async () => ({ terminated: true }), logger: { error() {} },
    transcriptReader: { async read(options) {
      const result = await reader.read(options), gate = readGates.get(options.sessionId);
      if (gate) { gate.started.resolve(); await gate.release.promise; }
      return result;
    } },
  });
  await supervisor.start();
  const add = async id => {
    const sessionFile = path.join(root, `${id}.jsonl`);
    await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: root }) + "\n");
    return supervisor.store.createRoot({ sessionId: id, sessionFile, cwd: root, repositoryRoot: null, name: `Synthetic ${id}`,
      actorToken: `synthetic-${id}`, launch: {} }, 1).session;
  };
  const a = await add("transport-a"), b = await add("transport-b");
  const connect = async () => { const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 10_000 }); clients.push(client);
    await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() }); return client; };
  const hold = id => { const gate = { started: deferred(), release: deferred() }; gates.push(gate); if (id) readGates.set(id, gate); return gate; };
  const raw = async () => {
    const socket = net.createConnection(socketPath), decoder = new JsonLineDecoder(), frames = []; let closed = false;
    sockets.push(socket); socket.on("data", chunk => frames.push(...decoder.push(chunk))); socket.once("close", () => { closed = true; }); socket.on("error", () => {});
    await once(socket, "connect");
    return { socket, frames, closed: () => closed,
      frame: (id, type, params = {}) => encodeFrame({ version: PROTOCOL_VERSION, id, type, params }),
      send(id, type, params = {}) { socket.write(this.frame(id, type, params)); } };
  };
  return { root, supervisor, actors, a, b, add, connect, hold, raw };
}

test("a held history read does not block unrelated input admission, reads, or a healthy peer", { timeout: 15_000 }, async t => {
  const f = await fixture(t), client = await f.connect(), peer = await f.connect();
  const gate = f.hold(f.a.sessionId), held = client.request("get_visible_messages", { sessionId: f.a.sessionId }); held.catch(() => {});
  await bounded(gate.started.promise, "held canonical read");
  const admitted = client.request("submit_input", { sessionId: f.b.sessionId, message: "Synthetic independent input", behavior: "auto", clientRequestId: "transport-admission" }); admitted.catch(() => {});
  const catalog = client.request("list_sessions"); catalog.catch(() => {});
  const [input, own, healthy] = await bounded(Promise.all([admitted, catalog, peer.request("list_sessions")]), "unrelated operations before held read release");
  assert.equal(input.accepted, true); assert.equal(input.sessionId, f.b.sessionId);
  assert.equal(own.sessions.length, 2); assert.equal(healthy.sessions.length, 2);
  assert(f.supervisor.store.listPendingActorInputs(f.b.sessionId).some(row => row.inputId === input.inputId));
  gate.release.resolve(); await held;
});

test("same-session mutations remain ordered while another session remains available", { timeout: 15_000 }, async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), healthy = await f.connect();
  await first.request("subscribe_session", { selector: f.a.sessionId }); await healthy.request("subscribe_session", { selector: f.b.sessionId });
  const actor = f.actors.get(f.a.sessionId), gate = f.hold(); actor.compactGate = gate;
  const one = first.request("compact_session", { sessionId: f.a.sessionId }); one.catch(() => {}); await bounded(gate.started.promise, "first compaction");
  const two = second.request("compact_session", { sessionId: f.a.sessionId }); two.catch(() => {});
  const other = await bounded(healthy.request("compact_session", { sessionId: f.b.sessionId }), "unrelated session compaction");
  assert.equal(other.result.summary, "compaction-1"); assert.equal(actor.compacts, 1, "A second mutation cannot enter the held session");
  gate.release.resolve(); assert.equal((await one).result.summary, "compaction-1"); assert.equal((await two).result.summary, "compaction-2");
});

test("registration admission is immediate and cannot retroactively grant or replace a role", { timeout: 15_000 }, async t => {
  const f = await fixture(t), raw = await f.raw();
  raw.socket.write(Buffer.concat([
    raw.frame("before-register", "list_sessions"),
    raw.frame("register", "register_client", { clientInstanceId: "transport-registration" }),
    raw.frame("after-register", "list_sessions"),
    raw.frame("register-again", "register_actor", { sessionId: f.a.sessionId, sessionFile: f.a.sessionFile, cwd: f.root,
      repositoryRoot: null, actorToken: `synthetic-${f.a.sessionId}`, actorGeneration: 1 }),
    raw.frame("after-role-attempt", "list_sessions"),
  ]));
  await eventually(() => raw.frames.filter(frame => frame.type === "response").length === 5, "pipelined registration responses");
  const responses = new Map(raw.frames.map(frame => [frame.id, frame]));
  assert.equal(responses.get("before-register").ok, false); assert.equal(responses.get("register").ok, true);
  assert.equal(responses.get("after-register").ok, true); assert.equal(responses.get("register-again").ok, false);
  assert.equal(responses.get("after-role-attempt").ok, true); assert.equal(raw.closed(), false);
});

test("an in-flight duplicate ID is rejected before a held ordinary read finishes", { timeout: 15_000 }, async t => {
  const f = await fixture(t), raw = await f.raw(), healthy = await f.connect();
  raw.send("register", "register_client", { clientInstanceId: "transport-duplicate" });
  await eventually(() => raw.frames.some(frame => frame.id === "register" && frame.ok), "raw registration");
  const gate = f.hold(f.a.sessionId); raw.send("held-id", "get_visible_messages", { sessionId: f.a.sessionId });
  await bounded(gate.started.promise, "held ordinary read");
  raw.socket.write(Buffer.concat([raw.frame("held-id", "list_sessions"), raw.frame("after-duplicate", "list_sessions")]));
  await eventually(() => raw.closed() && raw.frames.some(frame => frame.type === "protocol_error" && frame.code === "duplicate_request_id"),
    "synchronous duplicate admission rejects only the offending connection");
  assert.equal(raw.frames.some(frame => frame.id === "after-duplicate"), false);
  assert.equal((await bounded(healthy.request("list_sessions"), "healthy peer after duplicate")).sessions.length, 2);
  gate.release.resolve();
});


test("bounded indexed output disconnects only a nonreader and keeps a healthy peer responsive", { timeout: 15_000 }, async t => {
  const maxFrameBytes = 256 * 1024, budget = socketOutputBufferLimit(maxFrameBytes);
  assert.equal(socketOutputBufferLimit(), 5_505_025, "Use the reviewed default budget, not the smaller root-output budget");
  assert.equal(budget, maxFrameBytes + 1 + 256 * 1024, "The budget admits one complete legal frame plus headroom");
  const f = await fixture(t, { maxFrameBytes });
  for (let index = 2; index < 128; index++) await f.add(`transport-${index}`);
  const healthy = await f.connect(), slow = await f.raw();
  slow.send("register-slow", "register_client", { clientInstanceId: "transport-nonreader" });
  await eventually(() => slow.frames.some(frame => frame.id === "register-slow" && frame.ok), "slow registration before pausing");
  const write = net.Socket.prototype.write; let socket, maximum = 0, replies = 0, falseWrites = 0;
  net.Socket.prototype.write = function (chunk, ...args) {
    const match = (typeof chunk === "string" || Buffer.isBuffer(chunk)) && String(chunk).includes('"id":"slow-catalog-');
    const result = write.call(this, chunk, ...args);
    if (match) { socket = this; maximum = Math.max(maximum, this.writableLength); replies++; if (!result) falseWrites++; }
    return result;
  };
  t.after(() => { net.Socket.prototype.write = write; });
  slow.socket.pause();
  let sent = 0;
  for (; sent < 128 && !socket?.destroyed && maximum <= budget * 2; sent++) {
    slow.send(`slow-catalog-${sent}`, "list_sessions");
    await new Promise(resolve => setImmediate(resolve));
    if (sent % 8 === 0) assert.equal((await bounded(healthy.request("list_sessions"), "healthy peer during nonreader pressure")).sessions.length, 128);
  }
  await eventually(() => socket?.destroyed, "bounded queue terminates its slow server socket");
  assert(replies > 0 && falseWrites > 0, "The fixture must create actual socket backpressure");
  assert(maximum <= budget, `Observed socket buffering ${maximum} must fit the canonical budget ${budget}`);
  slow.socket.resume(); await eventually(() => slow.closed(), "slow client observes termination after resuming reads");
  assert.equal((await bounded(healthy.request("heartbeat"), "healthy peer after slow disconnect")).alive, true);
  assert.equal((await healthy.request("list_sessions")).sessions.length, 128);
  t.diagnostic(JSON.stringify({ sent, replies, falseWrites, maximumSocketBytes: maximum, canonicalBudgetBytes: budget }));
});


test("bounded admission cannot obstruct the legal callback needed by one executing mutation", { timeout: 15_000 }, async t => {
  const f = await fixture(t), client = await f.connect(), healthy = await f.connect(), requests = [], callbacks = new Map();
  let server, disconnected = 0, arrivedCompactions = 0;
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (chunk, ...args) {
    if ((typeof chunk === "string" || Buffer.isBuffer(chunk)) && String(chunk).includes('"requestType":"subscribe_session"')) server = this;
    return write.call(this, chunk, ...args);
  };
  t.after(async () => { net.Socket.prototype.write = write; await Promise.allSettled(requests); });
  client.on("disconnected", () => disconnected++);
  client.on("event", frame => {
    if (frame.event !== "actor_event" || frame.data?.event?.type !== "extension_ui_request") return;
    const id = frame.data.event.id;
    const promise = client.request("respond_extension_ui", { sessionId: f.a.sessionId, uiRequestId: id, confirmed: true });
    promise.catch(() => {}); callbacks.set(id, promise); requests.push(promise);
  });
  await client.request("subscribe_session", { selector: f.a.sessionId }); assert(server);
  const observed = new JsonLineDecoder();
  server.on("data", chunk => {
    for (const frame of observed.push(chunk)) if (frame.type === "compact_session" && frame.params?.sessionId === f.a.sessionId) arrivedCompactions++;
  });
  const actor = f.actors.get(f.a.sessionId); actor.callbackRounds = 2;
  const control = client.request("compact_session", { sessionId: f.a.sessionId }); control.catch(() => {}); requests.push(control);
  await eventually(() => actor.pendingCallbacks.has("transport-dialog-1"), "unpressured compaction starts");
  actor.showCallback("transport-dialog-1");
  assert.equal((await bounded(control, "unpressured confirmation")).result.confirmed, true);
  assert.equal((await callbacks.get("transport-dialog-1")).delivered, true);
  const active = client.request("compact_session", { sessionId: f.a.sessionId }); active.catch(() => {}); requests.push(active);
  await eventually(() => actor.pendingCallbacks.has("transport-dialog-2"), "pressured compaction starts");
  const queued = Array.from({ length: 511 }, () => client.request("compact_session", { sessionId: f.a.sessionId }));
  for (const promise of queued) { promise.catch(() => {}); requests.push(promise); }
  // Observe wire arrival, not a particular socket.pause implementation. Every waiter precedes the callback on this stream.
  await eventually(() => arrivedCompactions === 513, "all finite same-session waiters arrive");
  assert.equal(actor.compacts, 2, "Only the one pressured operation runs;511 others wait on its mutation tail");
  actor.showCallback("transport-dialog-2");
  await eventually(() => callbacks.has("transport-dialog-2"), "the subscribed client sends its real confirmation");
  assert.equal((await bounded(healthy.request("heartbeat"), "healthy peer under callback pressure")).alive, true);
  const outcome = await bounded(active, "confirmation must complete admitted work, not require timeout cancellation");
  assert.equal(outcome.result.confirmed, true, "A prompt legal confirmation must win before the existing dialog timeout");
  assert.equal((await callbacks.get("transport-dialog-2")).delivered, true);
  // Callback responsiveness is bounded above. Draining 511 real owner-leased
  // compactions is a completion/order claim, not a three-second throughput SLA.
  // Each admitted request retains the client deadline and this test's outer bound.
  const drained = await Promise.all(queued);
  assert.deepEqual(drained.map(reply => reply.result.summary), Array.from({ length: 511 }, (_, index) => `compaction-${index + 3}`));
  assert.equal(actor.compacts, 513); assert.equal(disconnected, 0);
  assert.equal(actor.receivedCallbacks.find(frame => frame.id === "transport-dialog-2")?.cancelled, undefined);
  t.diagnostic(JSON.stringify({ unpressuredConfirmed: true, admittedWaiters: queued.length, pressuredExecutingOperations: 1,
    pressuredConfirmed: outcome.result.confirmed, actorOperationsAfterDrain: actor.compacts, disconnected }));
});

// Observe real encoding and socket writes without replacing the supervisor or framing owners.
function observeBroadcasts(t) {
  const stringify = JSON.stringify, write = net.Socket.prototype.write;
  const encodes = [], writes = [], writesWhileBlocked = [], blocked = new Set();
  JSON.stringify = function (value, ...args) {
    const text = stringify.call(this, value, ...args);
    if (value?.type === "event") encodes.push({ frame: value, text });
    return text;
  };
  net.Socket.prototype.write = function (chunk, ...args) {
    if (blocked.has(this)) writesWhileBlocked.push(this);
    const ok = write.call(this, chunk, ...args);
    if (!ok && !blocked.has(this)) { blocked.add(this); this.prependOnceListener("drain", () => blocked.delete(this)); }
    if (Buffer.isBuffer(chunk)) {
      let frame; try { frame = JSON.parse(chunk); } catch {}
      if (frame) writes.push({ socket: this, chunk, frame, ok, buffered: this.writableLength });
    }
    return ok;
  };
  t.after(() => { JSON.stringify = stringify; net.Socket.prototype.write = write; });
  return { encodes, writes, writesWhileBlocked };
}
const actorFrames = (frames, type) => frames.filter(frame => frame.event === "actor_event" && frame.data.event.type === type);
function assertShared(observed, predicate, recipients) {
  const encodes = observed.encodes.filter(({ frame }) => predicate(frame));
  const writes = observed.writes.filter(({ frame }) => predicate(frame));
  assert.equal(encodes.length, 1, "one real encode per unchanged broadcast");
  assert.equal(writes.length, recipients);
  for (const { chunk } of writes) { assert.equal(chunk, writes[0].chunk); assert.equal(String(chunk), `${encodes[0].text}\n`); }
}

test("identical broadcasts encode once and retain public subscriptions, generations, and input order", { timeout: 15000 }, async t => {
  const f = await fixture(t), one = await f.connect(), two = await f.connect(), outsider = await f.connect();
  await one.request("subscribe_session", { selector: f.a.sessionId });
  await two.request("subscribe_session", { selector: f.a.sessionId });
  const seen = [[], [], []];
  [one, two, outsider].forEach((client, i) => client.on("event", frame => seen[i].push(frame)));
  const observed = observeBroadcasts(t), actor = f.actors.get(f.a.sessionId);
  actor.emit("event", { type: "extension_ui_request", method: "notify", id: "shared-notice", message: "Synthetic shared notice" });
  await one.request("rename_session", { sessionId: f.a.sessionId, name: "Shared navigator" });
  const submit = actor.submit.bind(actor);
  actor.submit = async (...args) => { await submit(...args); return { outcome: "handled" }; };
  const input = await one.request("submit_input", { sessionId: f.a.sessionId, message: "/synthetic-handled", behavior: "auto", clientRequestId: "shared-input" });
  await eventually(() => seen.slice(0, 2).every(frames => frames.some(frame => frame.event === "input_outcome" && frame.data.inputId === input.inputId)), "shared input outcome");
  const notice = frame => frame.event === "actor_event" && frame.data.event.id === "shared-notice";
  const state = frame => frame.event === "actor_event" && frame.data.event.type === "input_state" && frame.data.event.message.id === input.inputId;
  const outcome = frame => frame.event === "input_outcome" && frame.data.inputId === input.inputId;
  assertShared(observed, notice, 2); assertShared(observed, state, 2); assertShared(observed, outcome, 2);
  assertShared(observed, frame => frame.event === "navigator_changed" && frame.data.reason === "name_changed", 3);
  const selected = frames => frames.filter(frame => notice(frame) || state(frame) || outcome(frame));
  assert.deepEqual(selected(seen[0]), selected(seen[1])); assert.equal(selected(seen[2]).length, 0);
  const ordered = selected(seen[0]); assert(notice(ordered[0])); assert(state(ordered[1])); assert(outcome(ordered[2]));
  assert.equal(ordered[0].data.actorGeneration, ordered[1].data.actorGeneration);
  assert(ordered[0].data.seq < ordered[1].data.seq);
  await one.request("stop_session", { sessionId: f.a.sessionId });
  const cold = await one.request("submit_input", { sessionId: f.a.sessionId, message: "Synthetic cold input", behavior: "auto", clientRequestId: "shared-cold-input" });
  const coldState = frame => frame.event === "input_state" && frame.data.message.id === cold.inputId;
  await eventually(() => seen.slice(0, 2).every(frames => frames.some(coldState)), "nonresident input-state delivery");
  assertShared(observed, coldState, 2);
  await one.request("unsubscribe_session", { sessionId: f.a.sessionId });
  await two.request("unsubscribe_session", { sessionId: f.a.sessionId });
  const before = observed.encodes.length;
  f.actors.get(f.a.sessionId).emit("event", { type: "extension_ui_request", method: "notify", id: "unselected-notice", message: "No subscriber" });
  assert.equal(observed.encodes.length, before, "an unselected actor event does no encoding");
  t.diagnostic(JSON.stringify({ broadcastEncodes: { actor: 1, navigator: 1, inputState: 1, inputOutcome: 1 }, actorRecipients: 2, navigatorRecipients: 3 }));
});

test("dialogs do not retarget closing, ended, or destroyed selected sockets", { timeout: 15000 }, async t => {
  for (const mode of ["closing", "ended", "destroyed"]) await t.test(mode, async t => {
    const f = await fixture(t), first = await f.raw();
    first.send("register-first", "register_client", { clientInstanceId: `dialog-${mode}` });
    await eventually(() => first.frames.some(frame => frame.id === "register-first" && frame.ok), "first registration");
    const two = await f.connect(), observed = observeBroadcasts(t), seen = [];
    two.on("event", frame => seen.push(frame));
    first.send("subscribe-first", "subscribe_session", { selector: f.a.sessionId });
    await eventually(() => first.frames.some(frame => frame.id === "subscribe-first" && frame.ok), "first subscription");
    const server = observed.writes.find(({ frame }) => frame.type === "response" && frame.id === "subscribe-first").socket;
    await two.request("subscribe_session", { selector: f.a.sessionId });
    const actor = f.actors.get(f.a.sessionId);
    actor.emit("event", { type: "extension_ui_request", method: "confirm", id: "selected-dialog", message: "Select once", timeout: 10000 });
    await eventually(() => actorFrames(first.frames, "extension_ui_request").length === 1, "selected dialog");
    assertShared(observed, frame => frame.event === "actor_event" && frame.data.event.id === "selected-dialog", 1);
    assert.equal(actorFrames(seen, "extension_ui_request").length, 0);
    first.send("respond-first", "respond_extension_ui", { sessionId: f.a.sessionId, uiRequestId: "selected-dialog", confirmed: true });
    await eventually(() => first.frames.some(frame => frame.id === "respond-first" && frame.data?.delivered), "selected response");
    const write = net.Socket.prototype.write; let closeCallback;
    try {
      if (mode === "closing") {
        net.Socket.prototype.write = function(chunk, callback) {
          if (this === server && Buffer.isBuffer(chunk) && chunk.includes('"type":"protocol_error"')) {
            closeCallback = callback; return write.call(this, chunk);
          }
          return write.call(this, chunk, callback);
        };
        first.send("register-first", "heartbeat");
        await eventually(() => first.frames.some(frame => frame.type === "protocol_error"), "closing protocol-error response");
        assert.equal(typeof closeCallback, "function"); assert.equal(server.destroyed, false);
      } else if (mode === "ended") { server.end(); assert.equal(server.writableEnded, true); }
      else { server.destroy(); assert.equal(server.destroyed, true); }
      // Selection precedes #write eligibility, even before close cleanup removes the subscription.
      const before = observed.encodes.length;
      actor.emit("event", { type: "extension_ui_request", method: "confirm", id: "ineligible-dialog", message: "Do not retarget", timeout: 10000 });
      assert.equal(observed.encodes.length, before, "no eligible selected recipient means no encoding");
      actor.emit("event", { type: "extension_ui_request", method: "notify", id: "eligible-peer", message: "Still shared" });
      await eventually(() => seen.some(frame => frame.data?.event?.id === "eligible-peer"), "eligible peer delivery");
      assert.equal(seen.some(frame => frame.data?.event?.id === "ineligible-dialog"), false);
      assertShared(observed, frame => frame.event === "actor_event" && frame.data.event.id === "eligible-peer", 1);
    } finally { net.Socket.prototype.write = write; closeCallback?.(); }
  });
});

test("ordinary oversized broadcasts share the existing fallback and encoding failures isolate recipients", { timeout: 15000 }, async t => {
  const f = await fixture(t, { maxFrameBytes: 4096 }), one = await f.connect(), two = await f.connect();
  await one.request("subscribe_session", { selector: f.a.sessionId }); await two.request("subscribe_session", { selector: f.a.sessionId });
  const observed = observeBroadcasts(t), actor = f.actors.get(f.a.sessionId), seen = [[], []];
  [one, two].forEach((client, i) => client.on("event", frame => seen[i].push(frame)));
  actor.emit("event", { type: "extension_ui_request", method: "notify", id: "oversized-notice", message: "x".repeat(6000) });
  await eventually(() => seen.every(frames => frames.some(frame => frame.event === "frame_truncated")), "ordinary fallback delivery");
  assert.equal(observed.encodes.filter(({ frame }) => frame.data?.event?.id === "oversized-notice").length, 1, "the oversized source frame is tried once");
  assertShared(observed, frame => frame.event === "frame_truncated", 2);
  assert.deepEqual(seen[0].find(frame => frame.event === "frame_truncated").data, { originalType: "event", originalEvent: "actor_event" });
  assert.equal((await one.request("heartbeat")).alive, true); assert.equal((await two.request("heartbeat")).alive, true);
  const unrelated = await f.connect();
  const recipientSockets = observed.writes.filter(({ frame }) => frame.event === "frame_truncated").map(({ socket }) => socket);
  const stringify = JSON.stringify; let failedEncodes = 0;
  JSON.stringify = function(value, ...args) {
    if (value?.type === "event" && value.data?.event?.id === "failed-encoding") { failedEncodes++; throw new Error("synthetic encoder failure"); }
    return stringify.call(this, value, ...args);
  };
  try { actor.emit("event", { type: "extension_ui_request", method: "notify", id: "failed-encoding", message: "Fail eligible recipients" }); }
  finally { JSON.stringify = stringify; }
  assert.equal(failedEncodes, 1, "a failed encoding is not retried for each selected recipient");
  assert(recipientSockets.every(socket => socket.destroyed), "encoding failure closes each selected recipient");
  assert.equal((await unrelated.request("heartbeat")).alive, true, "an unselected existing client is unaffected");
});

test("shared broadcast queues drain immutable bytes in order and bound only the stalled client", { timeout: 20000 }, async t => {
  const maxFrameBytes = 64 * 1024, budget = socketOutputBufferLimit(maxFrameBytes);
  const f = await fixture(t, { maxFrameBytes }), healthy = await f.connect(), slow = await f.raw();
  await healthy.request("subscribe_session", { selector: f.a.sessionId });
  slow.send("register-broadcast-slow", "register_client", { clientInstanceId: "broadcast-slow" });
  await eventually(() => slow.frames.some(frame => frame.id === "register-broadcast-slow" && frame.ok), "slow registration");
  const observed = observeBroadcasts(t);
  slow.send("subscribe-broadcast-slow", "subscribe_session", { selector: f.a.sessionId });
  await eventually(() => slow.frames.some(frame => frame.id === "subscribe-broadcast-slow" && frame.ok), "slow subscription");
  const server = observed.writes.find(({ frame }) => frame.type === "response" && frame.id === "subscribe-broadcast-slow").socket;
  const actor = f.actors.get(f.a.sessionId), seen = [];
  healthy.on("event", frame => seen.push(frame));
  const send = index => {
    const source = { type: "extension_ui_request", method: "notify", id: `immutable-${index}`, message: `${index}:` + "x".repeat(20000) };
    actor.emit("event", source); source.message = "mutated after synchronous broadcast";
  };
  slow.socket.pause(); for (let i = 0; i < 6; i++) send(i);
  await eventually(() => actorFrames(seen, "extension_ui_request").length === 6, "healthy delivery while peer paused");
  assert.equal(server.destroyed, false); slow.socket.resume();
  await eventually(() => actorFrames(slow.frames, "extension_ui_request").length === 6, "slow drain retains queued frames");
  assert.deepEqual(actorFrames(slow.frames, "extension_ui_request"), actorFrames(seen, "extension_ui_request"));
  actorFrames(slow.frames, "extension_ui_request").forEach((frame, i) => {
    assert.equal(frame.data.event.message, `${i}:` + "x".repeat(20000), "post-broadcast source mutation cannot change queued wire bytes");
  });
  for (let i = 0; i < 6; i++) assertShared(observed, frame => frame.data?.event?.id === `immutable-${i}`, 2);
  slow.socket.pause(); let sent = 6;
  for (; sent < 160 && !server.destroyed; sent++) {
    send(sent); await new Promise(resolve => setImmediate(resolve));
    if (sent % 4 === 0) assert.equal((await healthy.request("heartbeat")).alive, true);
  }
  await eventually(() => server.destroyed, "only stalled broadcast recipient reaches its logical byte bound");
  await eventually(() => actorFrames(seen, "extension_ui_request").length === sent, "healthy peer retains every source event");
  slow.socket.resume(); await eventually(() => slow.closed(), "stalled client observes its close");
  const ids = actorFrames(seen, "extension_ui_request").map(frame => frame.data.event.id);
  assert.deepEqual(ids, Array.from({ length: sent }, (_, i) => `immutable-${i}`));
  const slowWrites = observed.writes.filter(item => item.socket === server);
  assert(slowWrites.some(item => !item.ok), "real writes produce backpressure");
  assert(Math.max(...slowWrites.map(item => item.buffered)) <= budget);
  const afterClose = observed.encodes.length; send(sent++);
  assert.equal(observed.encodes.length, afterClose + 1);
  assert.equal((await healthy.request("heartbeat")).alive, true);
  assert.equal(observed.encodes.filter(({ frame }) => frame.data?.event?.id?.startsWith("immutable-")).length, sent);
  assert.equal(observed.writesWhileBlocked.length, 0, "each socket waits for its own drain");
  for (let i = 0; i < 6; i++) assertShared(observed, frame => frame.data?.event?.id === `immutable-${i}`, 2);
  t.diagnostic(JSON.stringify({ sourceEvents: sent, slowWrites: slowWrites.length, maximumSocketBytes: Math.max(...slowWrites.map(item => item.buffered)), budget }));
});
