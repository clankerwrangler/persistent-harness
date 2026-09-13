import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { encodeFrame, JsonLineDecoder } from "../src/framing.mjs";
import { MAX_INPUT_IMAGE_BYTES, normalizeInputImages } from "../src/input-images.mjs";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, response } from "../src/protocol.mjs";
import { HarnessSupervisor, socketOutputBufferLimit } from "../src/supervisor.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(probe, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(10); }
  throw new Error("transport fixture condition did not become true");
}
async function bounded(operation, ms = 1000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("independent request was blocked")), ms); })]); }
  finally { clearTimeout(timer); }
}
function request(id, type, params = {}) { return { version: PROTOCOL_VERSION, id, type, params }; }
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervisor-transport-"));
  const file = path.join(root, "root.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "transport-root", timestamp: "2026-01-01T00:00:00Z", cwd: root })}\n`);
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), backgroundJobsDirectory: path.join(root, "background-jobs"),
    skillsPath: process.env.PI_HARNESS_SKILLS_PATH || path.resolve(import.meta.dirname, "../skills"),
    actorInactivityMs: 0, actorFactory: () => { throw new Error("unexpected actor launch in transport fixture"); },
    logger: { error() {} }, ...options });
  await supervisor.start();
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.stop())); await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const create = (id = "transport-root") => supervisor.store.createRoot({ sessionId: id, sessionFile: file, cwd: root,
    repositoryRoot: null, name: `Transport ${id}`, actorToken: "local-transport-test", launch: {} }, 1);
  create();
  const connect = async () => {
    const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 5000 });
    clients.push(client); await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() }); return client;
  };
  return { root, file, socketPath, supervisor, create, connect };
}
async function rawPeer(t, socketPath) {
  const raw = net.createConnection(socketPath); const frames = []; const decoder = new JsonLineDecoder();
  raw.on("error", () => {}); raw.on("data", (chunk) => { frames.push(...decoder.push(chunk)); });
  t.after(() => raw.destroy()); await once(raw, "connect");
  return { raw, frames, send: (id, type, params) => raw.write(encodeFrame(request(id, type, params))) };
}

test("held history reads do not block independent requests on the same connection", async (t) => {
  const held = Promise.withResolvers(); const entered = Promise.withResolvers(); const reader = new VisibleTranscriptReader();
  const setup = await fixture(t, { transcriptReader: { async read(options) { const visible = await reader.read(options); entered.resolve(); await held.promise; return visible; } } });
  const client = await setup.connect(); const peer = await setup.connect();
  const history = client.request("get_visible_messages", { sessionId: "transport-root" });
  try {
    await bounded(entered.promise);
    assert.equal((await bounded(client.request("list_sessions"))).sessions.length, 1);
    assert.equal((await bounded(client.request("heartbeat"))).alive, true);
    assert.equal((await bounded(peer.request("list_sessions"))).sessions.length, 1);
  } finally { held.resolve(); await history; }
});

test("registration and duplicate admission keep wire order without a connection-wide tail", async (t) => {
  const { socketPath, supervisor } = await fixture(t);
  const { raw, frames } = await rawPeer(t, socketPath);
  raw.write(Buffer.concat([
    encodeFrame(request("before-registration", "heartbeat")),
    encodeFrame(request("register", "register_client", { clientInstanceId: "wire-order" })),
    encodeFrame(request("after-registration", "heartbeat")),
    encodeFrame(request("second-registration", "register_client", { clientInstanceId: "cannot-replace" })),
  ]));
  await eventually(() => frames.filter((frame) => frame.type === "response").length === 4);
  assert.equal(frames.find((frame) => frame.id === "before-registration").ok, false);
  assert.equal(frames.find((frame) => frame.id === "register").ok, true);
  assert.equal(frames.find((frame) => frame.id === "after-registration").data.alive, true);
  assert.equal(frames.find((frame) => frame.id === "second-registration").ok, false);
  raw.write(Buffer.concat([
    encodeFrame(request("same-id", "rename_session", { sessionId: "transport-root", name: "Applied once" })),
    encodeFrame(request("same-id", "rename_session", { sessionId: "transport-root", name: "Never replay" })),
    encodeFrame(request("after-duplicate", "rename_session", { sessionId: "transport-root", name: "Never admitted" })),
  ]));
  await eventually(() => frames.some((frame) => frame.code === "duplicate_request_id"));
  assert.equal(supervisor.store.getSession("transport-root").name, "Applied once");
  assert.equal(frames.some((frame) => frame.id === "after-duplicate"), false);
});

test("generic replies obey drain, bound a stalled consumer, and preserve a healthy peer", async (t) => {
  const setup = await fixture(t);
  for (let index = 1; index < 128; index += 1) setup.create(`transport-${index}`);
  const healthy = await setup.connect();
  const { raw, frames, send } = await rawPeer(t, setup.socketPath);
  send("register", "register_client", { clientInstanceId: "stalled-reader" });
  await eventually(() => frames.some((frame) => frame.id === "register" && frame.ok));
  const original = net.Socket.prototype.write;
  const blocked = new Set(); let server; let peak = 0; let writesWhileBlocked = 0; let falseWrites = 0;
  net.Socket.prototype.write = function (chunk, ...args) {
    const encoded = typeof chunk === "string" || Buffer.isBuffer(chunk) ? String(chunk) : "";
    const matches = this === server || encoded.includes('"requestType":"list_sessions"');
    if (matches) { server = this; if (blocked.has(this)) writesWhileBlocked += 1; }
    const ok = original.call(this, chunk, ...args);
    if (matches) {
      peak = Math.max(peak, this.writableLength);
      if (!ok) { falseWrites += 1; if (!blocked.has(this)) { blocked.add(this); this.prependOnceListener("drain", () => blocked.delete(this)); } }
    }
    return ok;
  };
  try {
    raw.pause();
    for (let index = 0; index < 256 && !server?.destroyed; index += 1) { send(`list-${index}`, "list_sessions", {}); await delay(2); }
    await eventually(() => server?.destroyed);
    assert(falseWrites > 0);
    assert.equal(writesWhileBlocked, 0, "all socket writes stop until drain");
    assert(peak <= socketOutputBufferLimit(), "native output buffering stays within the legal-frame budget");
  } finally { net.Socket.prototype.write = original; raw.resume(); }
  assert.equal((await healthy.request("heartbeat")).alive, true);
  assert.equal((await healthy.request("list_sessions")).sessions.length, 128);
  assert.equal(setup.supervisor.store.getSession("transport-root").lifecycle, "starting", "disconnect does not alter the admitted session lifecycle");
});

test("a stalled consumer resumes thousands of small replies in order after drain", async (t) => {
  const setup = await fixture(t);
  const healthy = await setup.connect();
  const { raw, frames, send } = await rawPeer(t, setup.socketPath);
  send("register", "register_client", { clientInstanceId: "recovering-reader" });
  await eventually(() => frames.some((frame) => frame.id === "register" && frame.ok));
  const originalStatus = setup.supervisor.status.bind(setup.supervisor);
  const originalWrite = net.Socket.prototype.write;
  let admitted = 0; let writes = 0; let falseWrites = 0;
  setup.supervisor.status = () => ({ sequence: admitted++ });
  net.Socket.prototype.write = function (chunk, ...args) {
    const match = (typeof chunk === "string" || Buffer.isBuffer(chunk)) && String(chunk).includes('"requestType":"get_status"');
    const ok = originalWrite.call(this, chunk, ...args);
    if (match) { writes += 1; if (!ok) falseWrites += 1; }
    return ok;
  };
  const total = 4000;
  try {
    raw.pause();
    raw.write(Buffer.concat(Array.from({ length: total }, (_, index) => encodeFrame(request(`small-${index}`, "get_status")))));
    await eventually(() => admitted === total, 5000);
    assert(falseWrites > 0, "the consumer actually stalls socket output");
    assert(writes < total, "small replies remain queued until drain");
    assert.equal((await bounded(healthy.request("heartbeat"))).alive, true);
    raw.resume();
    await eventually(() => frames.filter((frame) => frame.requestType === "get_status").length === total, 5000);
    assert.deepEqual(frames.filter((frame) => frame.requestType === "get_status").map((frame) => [frame.id, frame.data.sequence]),
      Array.from({ length: total }, (_, index) => [`small-${index}`, index]));
    assert.equal(raw.destroyed, false);
    assert.equal(writes, total);
  } finally { net.Socket.prototype.write = originalWrite; setup.supervisor.status = originalStatus; raw.resume(); }
});

test("a legal maximum image response and an exact maximum protocol frame remain available", async (t) => {
  assert.equal(socketOutputBufferLimit(), socketOutputBufferLimit(MAX_FRAME_BYTES));
  assert.equal(socketOutputBufferLimit(1024), 263169, "custom limits retain the newline and 256 KiB headroom");
  const bytes = Buffer.alloc(MAX_INPUT_IMAGE_BYTES);
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64").copy(bytes);
  const image = normalizeInputImages([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }])[0];
  const setup = await fixture(t, { transcriptReader: { async readImage() { return image; } } });
  const healthy = await setup.connect();
  assert.deepEqual((await healthy.request("get_visible_image", { sessionId: "transport-root", entryId: "image", index: 0 })).image, image);
  const { frames, send } = await rawPeer(t, setup.socketPath);
  const id = "exact-frame";
  const data = { payload: "" };
  const overhead = encodeFrame(response(id, "get_status", data)).length - 1;
  data.payload = "x".repeat(MAX_FRAME_BYTES - overhead);
  assert.equal(encodeFrame(response(id, "get_status", data)).length - 1, MAX_FRAME_BYTES);
  const originalStatus = setup.supervisor.status.bind(setup.supervisor);
  setup.supervisor.status = () => data;
  try {
    send(id, "get_status", {});
    await eventually(() => frames.some((frame) => frame.id === id), 5000);
    assert.equal(frames.find((frame) => frame.id === id).data.payload.length, data.payload.length);
    data.payload += "x".repeat(64);
    send("oversized-frame", "get_status", {});
    await eventually(() => frames.some((frame) => frame.id === "oversized-frame"));
    assert.equal(frames.find((frame) => frame.id === "oversized-frame").code, "response_too_large");
  } finally { setup.supervisor.status = originalStatus; }
  assert.equal((await healthy.request("heartbeat")).alive, true);
});


test("new-work admission rejects excess pressure without dropping accepted requests", async (t) => {
  const held = Promise.withResolvers(); let entered = 0;
  const setup = await fixture(t, { transcriptReader: { async read() { entered += 1; await held.promise; return { messages: [], history: [], truncated: false }; } } });
  const healthy = await setup.connect();
  const { raw, frames, send } = await rawPeer(t, setup.socketPath);
  send("register", "register_client", { clientInstanceId: "held-burst" });
  await eventually(() => frames.some((frame) => frame.id === "register" && frame.ok));
  const total = 8192;
  raw.write(Buffer.concat(Array.from({ length: total }, (_, index) => encodeFrame(request(`held-${index}`, "get_visible_messages", { sessionId: "transport-root", limit: 1 })))));
  try {
    await eventually(() => entered === total, 5000);
    send("excess-work", "get_visible_messages", { sessionId: "transport-root", limit: 1 });
    await eventually(() => frames.some((frame) => frame.id === "excess-work"));
    assert.equal(frames.find((frame) => frame.id === "excess-work").code, "request_backpressure");
    assert.equal(entered, total, "excess new work is not admitted");
    assert.equal((await bounded(healthy.request("heartbeat"))).alive, true);
  } finally { held.resolve(); }
  await eventually(() => frames.filter((frame) => frame.requestType === "get_visible_messages" && frame.ok).length === total, 5000);
  send("recovered", "heartbeat");
  await eventually(() => frames.some((frame) => frame.id === "recovered" && frame.data?.alive));
  assert.equal(raw.destroyed, false);
  assert.equal(frames.some((frame) => frame.type === "protocol_error"), false);
});

test("a request can await a callback request on its own connection", async (t) => {
  const release = Promise.withResolvers(); let client;
  const setup = await fixture(t, { transcriptReader: { async read() {
    const callback = client.request("heartbeat");
    const reply = await Promise.race([callback, release.promise]);
    assert.equal(reply.alive, true);
    return { messages: [], history: [], truncated: false };
  } } });
  client = await setup.connect();
  const pending = client.request("get_visible_messages", { sessionId: "transport-root" });
  try { assert.deepEqual((await bounded(pending)).messages, []); }
  finally { release.resolve({ alive: true }); await pending; }
});


class TransportActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.closeCalls = 0; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null, thinkingLevel: "off" }; }
  async start() { this.isRunning = true; return this.state(); }
  async request(type) {
    if (type === "get_state") return this.state();
    if (type === "get_entries") return { entries: [], leafId: null };
    throw new Error(`unexpected transport actor request ${type}`);
  }
  send() {}
  async submit() { return {}; }
  async close() { this.closeCalls += 1; this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM", expected: true }); }
}

test("client disconnect leaves the resident actor and durable input queue owned by the supervisor", async (t) => {
  let actor;
  const setup = await fixture(t, {
    actorFactory: (options) => { actor = new TransportActor(options); return actor; },
    runtimeProvisioner: async () => ({}),
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  const client = await setup.connect();
  await client.request("subscribe_session", { selector: "transport-root" });
  assert.equal(actor.isRunning, true);
  setup.supervisor.store.createActorInput("transport-root", { inputId: "retained-transport-input", message: "retained local proof" });
  await client.stop();
  assert.equal(actor.isRunning, true);
  assert.equal(actor.closeCalls, 0);
  const queued = setup.supervisor.store.getActorInput("retained-transport-input", "transport-root");
  assert.equal(queued.message, "retained local proof");
  assert.equal(queued.state, "queued");
  const replacement = await setup.connect();
  assert.equal((await replacement.request("get_actor_state", { sessionId: "transport-root" })).state.sessionId, "transport-root");
  assert.equal(actor.closeCalls, 0);
});
