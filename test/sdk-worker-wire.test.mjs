import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fixture as supervisorFixture } from "./fixtures/notification-supervisor.mjs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { loadExternalPi } from "../src/external-pi.mjs";
import { ActorCoordinator } from "../src/actor-coordinator.mjs";
import { bootstrapSDKWorker, runSDKWorkerRpc, toWorkerRpcEvent } from "../src/sdk-worker.mjs";

// Public synthetic data only. Real SDK, coordinator, persistence and JSONL channel;
// the registered offline stream is the sole provider boundary replacement.
const external = await loadExternalPi();
const temporary = await mkdtemp(path.join(os.tmpdir(), "sdk-worker-wire-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: savedEnv.PATH, HOME: temporary, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
let networkAttempts = 0;
const denied = () => { networkAttempts++; throw new Error("Fixture network denied"); };
mock.method(globalThis, "fetch", denied);
mock.method(http, "request", denied); mock.method(https, "request", denied);
const connect = net.Socket.prototype.connect;
mock.method(net.Socket.prototype, "connect", function (...args) {
  // Supervisor differential fixtures use only a private local Unix socket.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const socketPath = typeof first === "string" ? first : first?.path;
  if (typeof socketPath === "string" && socketPath.startsWith(temporary + path.sep)) return connect.apply(this, args);
  return denied();
});
after(async () => {
  assert.equal(networkAttempts, 0);
  mock.restoreAll();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(temporary, { recursive: true, force: true });
});
const unit = "PUBLIC-SYNTHETIC-TOOL-RESULT:";
const body = unit.repeat(8192);
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
const result = { content: [{ type: "text", text: body }, image], details: { public: body }, structuredContent: { public: body } };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, "fixture timed out"); await tick(); }
}
async function runTurn(eventMode) {
  const dir = await mkdtemp(path.join(temporary, eventMode + "-"));
  const agentDir = path.join(dir, "agent"); await mkdir(agentDir);
  const input = new PassThrough(), output = new PassThrough(), chunks = [], raw = [], hooks = [];
  output.on("data", chunk => chunks.push(Buffer.from(chunk)));
  let worker, calls = 0;
  class ObservedCoordinator extends ActorCoordinator {
    constructor(options) { super({ ...options, publish(event) { raw.push(structuredClone(event)); return options.publish(event); } }); }
  }
  const running = runSDKWorkerRpc({ input, output, eventMode, installSignalHandlers: false,
    bootstrap: async options => worker = await bootstrapSDKWorker({ ...options, external, Coordinator: ObservedCoordinator,
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      argv: ["--mode", "rpc", "--session", path.join(dir, "session.jsonl"), "--provider", "wire-fixture", "--model", "fixture",
        "--no-extensions", "--no-skills", "--no-context-files", "--tools", "wire_tool"],
      extensionFactory(pi) {
        pi.on("session_start", () => pi.setActiveTools(["wire_tool"]));
        pi.registerTool({ name: "wire_tool", label: "Wire fixture", description: "Public synthetic result",
          parameters: { type: "object", properties: {} },
          async execute(_id, _args, _signal, update) { update({ content: [{ type: "text", text: "public progress" }] }); return structuredClone(result); } });
        pi.on("tool_result", event => { assert.equal(event.content[0].text, body); hooks.push("tool_result"); });
        pi.on("message_end", ({ message }) => { if (message.role === "toolResult") { assert.deepEqual(message.content, result.content); hooks.push("message_end"); } });
        pi.on("turn_end", event => { if (event.toolResults.length) { assert.equal(event.toolResults[0].details.public, body); hooks.push("turn_end"); } });
        pi.registerProvider("wire-fixture", { baseUrl: "http://127.0.0.1:1", apiKey: "public-fixture", api: "wire-fixture",
          models: [{ id: "fixture", name: "Wire fixture", reasoning: true, input: ["text", "image"], contextWindow: 128000,
            maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model) {
            const tool = calls++ === 0;
            const stream = external.api.createAssistantMessageEventStream();
            const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
              content: [], stopReason: "pending", timestamp: Date.now(), usage: structuredClone(usage) };
            queueMicrotask(() => {
              stream.push({ type: "start", partial: message });
              if (tool) {
                message.content.push({ type: "toolCall", id: "public-call", name: "wire_tool", arguments: {} });
                stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
                stream.push({ type: "toolcall_end", contentIndex: 0, partial: message, toolCall: message.content[0] });
              } else {
                message.content.push({ type: "thinking", thinking: "private reasoning fixture" });
                stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
                stream.push({ type: "thinking_delta", contentIndex: 0, delta: "private reasoning fixture", partial: message });
                stream.push({ type: "thinking_end", contentIndex: 0, content: "private reasoning fixture", partial: message });
                message.content.push({ type: "text", text: "public answer" });
                stream.push({ type: "text_start", contentIndex: 1, partial: message });
                stream.push({ type: "text_delta", contentIndex: 1, delta: "public answer", partial: message });
                stream.push({ type: "text_end", contentIndex: 1, content: "public answer", partial: message });
              }
              message.stopReason = tool ? "toolUse" : "stop";
              stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
            }); return stream;
          } });
      } }) });
  try {
    await until(() => worker);
    input.write(JSON.stringify({ id: "public-prompt", type: "prompt", message: "public input", messageId: "public-input" }) + "\n");
    await until(() => raw.some(event => event.type === "agent_settled"));
    await worker.coordinator.waitForIdle();
    assert.equal(worker.coordinator.failure, null); assert.equal(calls, 2);
    const entries = (await worker.handle({ type: "get_entries" })).entries;
    const canonical = entries.find(entry => entry.message?.role === "toolResult");
    assert.deepEqual(canonical.message.content, result.content);
    assert.equal(canonical.message.details.public, body); assert.equal(canonical.message.structuredContent.public, body);
    assert.deepEqual(hooks, ["tool_result", "message_end", "turn_end"]);
    const persisted = (await readFile(worker.session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(persisted.find(entry => entry.message?.role === "toolResult"), canonical);
    const wire = Buffer.concat(chunks).toString(), frames = wire.trim().split("\n").map(JSON.parse);
    const resultFrames = frames.filter(frame => JSON.stringify(frame).includes(unit));
    const metrics = { eventMode, bodyBytes: Buffer.byteLength(body), resultBytes: Buffer.byteLength(JSON.stringify(result)),
      wireBytes: Buffer.byteLength(wire), resultFrames: resultFrames.map(frame => ({ type: frame.type,
        role: frame.message?.role, bytes: Buffer.byteLength(JSON.stringify(frame) + "\n"),
        bodyCopies: JSON.stringify(frame).split(body).length - 1 })) };
    return { raw, frames, metrics, canonical, persisted };
  } finally { input.end(); await running; }
}

test("real worker JSONL measures result multiplicity and preserves direct full events", { timeout: 15000 }, async t => {
  const reports = []; let supervised;
  for (const eventMode of ["supervised-source", "full"]) {
    const run = await runTurn(eventMode);
    reports.push(run.metrics);
    if (eventMode === "supervised-source") {
      supervised = run;
      assert.deepEqual(run.metrics.resultFrames, [], "supervised wire contains no synthetic result bodies");
      assert(run.metrics.wireBytes < 16 * 1024);
      assert.deepEqual(run.frames.find(frame => frame.type === "message_end" && frame.message?.role === "toolResult").message.content, [{ type: "image" }]);
    }
    if (eventMode === "full") {
      assert.equal(run.frames.find(event => event.type === "tool_execution_end").result.details.public, body);
      assert.equal(run.frames.find(event => event.type === "turn_end" && event.toolResults.length).toolResults[0].structuredContent.public, body);
      assert.equal(run.frames.find(event => event.type === "agent_end").messages.find(message => message.role === "toolResult").content[0].text, body);
    }
  }
  await verifySupervisor(t, supervised);
  t.diagnostic(JSON.stringify(reports));
  if (savedEnv.PI_HARNESS_WIRE_REPORT) await writeFile(savedEnv.PI_HARNESS_WIRE_REPORT, JSON.stringify(reports, null, 2) + "\n");
});

async function verifySupervisor(t, run) {
  const f = await supervisorFixture(t, { socketPath: path.join(temporary, "supervisor.sock") });
  const oldRoot = await f.actor(), newRoot = await f.actor();
  const pairs = [[oldRoot, newRoot], [await f.actor(oldRoot.session.sessionId), await f.actor(newRoot.session.sessionId)]];
  const received = [];
  f.client.on("event", frame => { if (frame.event === "actor_event") received.push(frame.data); });
  const jsonFrame = frame => JSON.parse(JSON.stringify(frame));
  // Actual coordinator events, followed by finite error/cancellation/progress
  // boundaries that must pass unchanged through the transport optimization.
  const variants = [];
  for (const stopReason of ["error", "aborted"]) variants.push(
    { type: "agent_start" },
    { type: "progress_entry", entryId: "public-progress", summary: "Checking wire parity", createdAt: "2026-01-01T00:00:00Z" },
    { type: "message_start", message: { role: "assistant", id: stopReason, timestamp: 1, content: [] } },
    { type: "message_end", message: { role: "assistant", id: stopReason, timestamp: 1,
      content: [{ type: "thinking", thinking: "private reasoning fixture" }, { type: "text", id: "public-error-text", text: "public failure" }],
      stopReason, errorMessage: "public fixture failure", usage } },
    { type: "tool_execution_end", toolCallId: "failed-call", toolName: "wire_tool", result: { content: [{ type: "text", text: body }] }, isError: true },
    { type: "auto_retry_end", success: false, attempt: 1 },
    { type: "agent_end", messages: [] }, { type: "agent_settled" });
  for (const [oldActor, newActor] of pairs) {
    const isRoot = oldActor === oldRoot;
    for (const actor of [oldActor, newActor]) {
      await writeFile(actor.session.sessionFile, run.persisted.map((entry, index) => JSON.stringify(index === 0 ? { ...entry, id: actor.session.sessionId } : entry)).join("\n") + "\n");
      await f.client.request("subscribe_session", { selector: actor.session.sessionId });
    }
    const compare = async sequence => {
      const deliver = async (actor, mode) => {
        const sessionId = actor.session.sessionId, start = received.length;
        actor.streaming = true;
        for (const raw of sequence.slice(0, -1)) {
          const frame = toWorkerRpcEvent(raw, { eventMode: mode });
          if (frame) actor.emit("event", jsonFrame(frame));
        }
        const replay = await f.client.request("subscribe_session", { selector: sessionId });
        assert(replay.events.length > 0, "exercise reconnect replay while active");
        actor.streaming = false;
        actor.emit("event", jsonFrame(sequence.at(-1)));
        await until(() => received.slice(start).some(frame => frame.sessionId === sessionId && frame.event.type === "agent_settled"));
        await f.client.request("heartbeat");
        const live = received.slice(start).filter(frame => frame.sessionId === sessionId).map(frame => frame.event);
        return { live, replay: replay.events.map(frame => frame.event) };
      };
      const before = await deliver(oldActor, "full"), after = await deliver(newActor, "supervised-source");
      assert.deepEqual(after, before, "live and replay supervisor events are exactly equal");
      assert.doesNotMatch(JSON.stringify(after), /PUBLIC-SYNTHETIC|private reasoning fixture|structuredContent/);
      return after;
    };
    const projected = await compare(run.raw);
    const toolEnd = projected.live.find(frame => frame.type === "tool_execution_end");
    assert.deepEqual(toolEnd, { type: "tool_execution_end", toolCallId: "public-call", toolName: "wire_tool", isError: false });
    const imageEnd = projected.live.filter(frame => frame.type === "message_end").find(frame => frame.message?.role === "toolResult");
    assert.equal(Boolean(imageEnd), isRoot, "only roots receive the committed-image invalidation marker");
    const sessionId = newActor.session.sessionId;
    const visible = await f.client.request("get_visible_messages", { sessionId });
    assert(visible.messages.some(message => message.text === "public input"));
    assert(visible.messages.some(message => message.text === "public answer"));
    if (isRoot) {
      const output = visible.messages.find(message => message.role === "tool_output");
      assert(output); assert.equal("data" in output.images[0], false);
      assert.deepEqual((await f.client.request("get_visible_image", { sessionId, entryId: run.canonical.id, index: 0 })).image, image);
    } else {
      assert.equal(visible.messages.some(message => message.role === "tool_output"), false);
      await assert.rejects(f.client.request("get_visible_image", { sessionId, entryId: run.canonical.id, index: 0 }), /does not exist/);
    }
    for (let index = 0; index < variants.length; index += 8) await compare(variants.slice(index, index + 8));
  }
  assert.deepEqual(f.errors, []);
}
