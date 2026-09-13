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
import { HarnessSupervisor, socketOutputBufferLimit } from "../src/supervisor.mjs";
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
  await bounded(Promise.all(queued), "ordered waiters drain after confirmed completion");
  assert.equal(actor.compacts, 513); assert.equal(disconnected, 0);
  assert.equal(actor.receivedCallbacks.find(frame => frame.id === "transport-dialog-2")?.cancelled, undefined);
  t.diagnostic(JSON.stringify({ unpressuredConfirmed: true, admittedWaiters: queued.length, pressuredExecutingOperations: 1,
    pressuredConfirmed: outcome.result.confirmed, actorOperationsAfterDrain: actor.compacts, disconnected }));
});
