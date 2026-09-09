import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import { pathToFileURL } from "node:url";
import { loadExternalPi } from "../src/external-pi.mjs";
import { createNativeProviderAdapter } from "../src/native-provider.mjs";

// Resolve the explicit stock graph, with the harness's directly pinned WebSocket dependency.
const { sdk: { ModelRuntime }, api, responsesApi, paths } = await loadExternalPi();
const apiPackageFile = findPackageJSON(pathToFileURL(paths.api));
const apiPackage = JSON.parse(await readFile(apiPackageFile, "utf8"));
assert.equal(apiPackage.name, "@earendil-works/pi-ai");
assert.equal(apiPackage.version, "0.85.1");
const apiExport = apiPackage.exports["./api/*"].import;
assert.equal(apiExport, "./dist/api/*.js", "stock 0.85.1 public API wildcard export");
const codexApiUrl = new URL(apiExport.replace("*", "openai-codex-responses"), pathToFileURL(apiPackageFile));
const syntheticKey = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const tool = { name: "ipython", description: "fixture", async: true, parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const model = { id: "fixture-native", provider: "fixture-provider", api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1", reasoning: true,
  input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }, maxTokens: 4096, contextWindow: 16000, compat: { supportsAsyncTools: true } };
const context = { systemPrompt: "fixture system", messages: [{ role: "user", content: "fixture prompt", timestamp: 1 }], tools: [tool] };
const copied = (value) => JSON.parse(JSON.stringify(value));
function callItem(overrides = {}) { return { type: "function_call", id: "fc_original", call_id: "call_original", name: "ipython", arguments: '{"code":"print(1)"}', async: true, ...overrides }; }
const created = (id = "resp_original") => ({ type: "response.created", response: { id, status: "in_progress" } });
const complete = (id = "resp_original", output = [], overrides = {}) => ({ type: "response.completed", response: { id, status: "completed", output,
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 }, output_tokens: 12,
    output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 112 }, ...overrides } });
const doneCall = (item = callItem(), index = 0) => ({ type: "response.output_item.done", output_index: index, item });
function frames(item = callItem(), id = "resp_original") { return [created(id), { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, doneCall(item), complete(id)]; }
function encoded(events, delimiter = "\n") { return events.map((event) => `event: ignored${delimiter}data: ${JSON.stringify(event)}${delimiter}${delimiter}`).join(""); }
function response(events) { return new Response(encoded(events), { headers: { "content-type": "text/event-stream" } }); }
function networkDenied() { throw new Error("unexpected_network"); }
async function runtime(t, selected = model) {
  const result = await ModelRuntime.create({ credentials: new api.InMemoryCredentialStore(), modelsStore: new api.InMemoryModelsStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  result.registerNativeProvider(api.createProvider({ id: selected.provider, models: [selected], auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: syntheticKey, headers: { "x-auth-fixture": "auth" } } }) } },
    api: { stream() { throw new Error("fixture_fallback_not_scripted"); }, streamSimple() { throw new Error("fixture_fallback_not_scripted"); } } }));
  return result;
}
async function adapter(t, transportOptions = {}, selected = model) {
  const instance = createNativeProviderAdapter({ api, responsesApi, modelRuntime: await runtime(t, selected), transportOptions: { fetch: networkDenied, ...transportOptions } });
  t.after(() => instance.close()); return instance;
}
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return { events, message: await stream.result() }; }
async function server(t, handler) {
  const server = http.createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
function loopbackFetch(url, init) {
  assert.equal(new URL(url).hostname, "127.0.0.1"); return fetch(url, init);
}

test("SSE loopback: raw complete call precedes terminal, headers/hooks, reasoning, usage, and ordinary wait", { timeout: 10000 }, async (t) => {
  let release, requestBody, headers;
  const gate = new Promise((resolve) => { release = resolve; });
  const reason = { type: "reasoning", id: "rs_original", summary: [{ type: "summary_text", text: "réason" }], encrypted_content: "opaque-fixture" };
  const text = { type: "message", id: "msg_original", phase: "commentary", role: "assistant", status: "completed", content: [{ type: "output_text", text: "évidence", annotations: [] }] };
  const waitItem = callItem({ id: "fc_wait", call_id: "call_wait", name: "wait_for_ipython", arguments: "{}", async: undefined });
  const local = await server(t, async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body); headers = req.headers;
    res.writeHead(200, { "content-type": "text/event-stream", "x-fixture-reply": "yes" });
    const start = [created(), { type: "response.output_item.added", output_index: 1, item: reason }, { type: "response.reasoning_summary_text.delta", output_index: 1, delta: "réason" },
      { type: "response.output_item.added", output_index: 0, item: { ...callItem(), arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"code":' },
      { type: "response.output_item.done", output_index: 1, item: reason }, doneCall()];
    // Split CRLF and UTF-8 across byte boundaries.
    for (const byte of Buffer.from(encoded(start, "\r\n"))) res.write(Buffer.from([byte]));
    await gate;
    res.end(encoded([doneCall(waitItem, 2), { type: "response.output_item.done", output_index: 3, item: text }, complete("resp_original", [reason])]));
  });
  const selected = { ...model, baseUrl: local.url, headers: { "X-Choice": "model" } };
  const a = await adapter(t, { fetch: loopbackFetch }, selected);
  let onResponse = false;
  const stream = a.stream(selected, { ...context, tools: [tool, { name: "wait_for_ipython", description: "barrier", parameters: { type: "object", properties: {} } }] }, {
    transport: "sse", maxTokens: 100, reasoning: "high", headers: { "X-Choice": "explicit" },
    transformHeaders: (h) => { assert.equal(h["x-choice"], "explicit"); return { ...h, "x-choice": "transformed", "x-auth-fixture": null }; },
    onPayload: (body) => { assert.equal(body.tools[0].async, true); body.temperature = 0.2; },
    onResponse: (reply) => { onResponse = reply.headers["x-fixture-reply"] === "yes"; },
  });
  const observed = [];
  for await (const event of stream) {
    observed.push(event);
    if (event.type === "toolcall_end" && event.toolCall.name === "ipython") {
      const proof = a.nativeCompletion(event);
      assert.equal(proof.responseId, "resp_original"); assert.equal(proof.itemId, "fc_original"); assert.equal(proof.callId, "call_original");
      assert.deepEqual(proof.call.arguments, { code: "print(1)" }); assert.ok(Object.isFrozen(proof.call.arguments));
      assert.equal(a.nativeCompletion(copied(event)), null); assert.equal(a.nativeCompletion({ type: "toolcall_end", native: true, async: true }), null);
      assert.equal(observed.some((e) => e.type === "done"), false);
      release();
    }
  }
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse"); assert.equal(result.responseId, "resp_original"); assert.equal(onResponse, true);
  assert.equal(headers["x-choice"], "transformed"); assert.equal(headers["x-auth-fixture"], undefined);
  assert.equal(requestBody.max_output_tokens, 100); assert.equal(requestBody.reasoning.effort, "high"); assert.equal(requestBody.temperature, 0.2);
  assert.equal(requestBody.instructions, "fixture system");
  const waitEvent = observed.find((e) => e.type === "toolcall_end" && e.toolCall.name === "wait_for_ipython");
  assert.equal(a.nativeCompletion(waitEvent), null); assert.equal(waitEvent.toolCall.providerCallId, "call_wait");
  assert.deepEqual(JSON.parse(result.content.find((b) => b.type === "thinking").thinkingSignature), reason);
  const { cost, ...counts } = result.usage;
  assert.deepEqual(counts, { input: 75, output: 12, cacheRead: 20, cacheWrite: 5, reasoning: 3, totalTokens: 112 });
  for (const [field, value] of Object.entries({ input: 0.000075, output: 0.000024, cacheRead: 0.00001, cacheWrite: 0.000005, total: 0.000114 })) assert.ok(Math.abs(cost[field] - value) < 1e-15);
});

for (const [name, settings] of Object.entries({
  "no returned marker": { item: { async: undefined } }, "string marker": { item: { async: "true" } },
  "false returned marker": { item: { async: false } }, "added-only marker": { item: { async: undefined }, addedMarker: true },
  "no advertised tool": { tool: { async: undefined } }, "no model opt-in": { model: { compat: {} } },
  "effective hook removed opt-in": { hook: (p) => { delete p.tools[0].async; } },
  "effective hook replaced payload": { hook: (p) => ({ ...p, tools: p.tools.map((tool) => ({ ...tool, async: false })) }) },
  "effective model changed": { hook: (p) => { p.model = "other-model"; } },
  "effective schema changed": { hook: (p) => { p.tools[0].parameters = { type: "object" }; } },
  "no response ID": { noResponse: true },
})) test(`${name}: ordinary terminal tool barrier remains executable`, async (t) => {
  const selected = { ...model, ...settings.model };
  let raw = frames(callItem(settings.item));
  if (settings.addedMarker) raw[1].item.async = true;
  if (settings.noResponse) { raw = raw.slice(1); delete raw.at(-1).response.id; }
  let sent;
  const a = await adapter(t, { fetch: async (_url, init) => { sent = JSON.parse(init.body); return response(raw); } }, selected);
  const { events, message } = await collect(a.stream(selected, { ...context, tools: [{ ...tool, ...settings.tool }] }, { transport: "sse", onPayload: settings.hook }));
  assert.equal(message.stopReason, "toolUse"); assert.equal(sent.tools.length, 1);
  const end = events.find((event) => event.type === "toolcall_end"); assert.ok(end); assert.equal(a.nativeCompletion(end), null);
  assert.deepEqual(end.toolCall.arguments, { code: "print(1)" });
});

test("SSE full-history replay retains exact IDs, pending calls, signed reasoning, images, and real outputs only", async (t) => {
  const id = "fc_LONG_" + "x".repeat(90), callId = "call_LONG_" + "y".repeat(90);
  const reason = { type: "reasoning", id: "rs_replay", summary: [], encrypted_content: "opaque-replay" };
  let sent = [], count = 0;
  const a = await adapter(t, { fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); count++;
    return count === 1 ? response([created(), { type: "response.output_item.done", output_index: 1, item: reason }, doneCall(callItem({ id, call_id: callId })), complete()]) : response([created("resp_two"), complete("resp_two")]); } });
  const first = await a.stream(model, context, { transport: "sse" }).result();
  const pending = { ...context, messages: [...context.messages, first, { role: "user", content: "continue while pending", timestamp: 2 }] };
  await a.stream(model, pending, { transport: "sse", previousResponseId: first.responseId }).result();
  assert.equal(sent[1].input.filter((i) => i.type?.endsWith("_output")).length, 0);
  assert.deepEqual(sent[1].input.find((i) => i.type === "reasoning"), reason);
  const call = sent[1].input.find((i) => i.type === "function_call"); assert.equal(call.id, id); assert.equal(call.call_id, callId); assert.equal(call.async, true);
  const real = { role: "toolResult", toolCallId: `${callId}|${id}`, toolName: "ipython", content: [{ type: "text", text: "real returned value" }, { type: "image", mimeType: "image/png", data: "fixture-data" }], isError: false, timestamp: 3 };
  await a.stream(model, { ...pending, messages: [...pending.messages, real] }, { transport: "sse" }).result();
  const result = sent[2].input.find((i) => i.type === "function_call_output");
  assert.equal(result.call_id, callId); assert.deepEqual(result.output, [{ type: "input_text", text: "real returned value" }, { type: "input_image", image_url: "data:image/png;base64,fixture-data", detail: "auto" }]);
  assert.equal(JSON.stringify(sent).includes("No result provided"), false);
});

for (const [name, build] of Object.entries({
  "changed call ID": () => [created(), { type: "response.output_item.added", output_index: 0, item: callItem() }, doneCall(callItem({ call_id: "other" })), complete()],
  "changed response ID": () => [created(), { ...doneCall(), response_id: "different" }, complete()],
  "invalid JSON arguments": () => frames(callItem({ arguments: '{"code":' })),
  "array arguments": () => frames(callItem({ arguments: "[]" })),
  "duplicate complete item": () => [created(), doneCall(), doneCall(), complete()],
  "duplicate call across indices": () => [created(), doneCall(), doneCall(callItem({ id: "fc_other" }), 1), complete()],
  "missing terminal": () => [created(), doneCall()],
  "queued terminal is not success": () => [created(), complete("resp_original", [], { status: "queued" })],
})) test(`protocol error: ${name}`, async (t) => {
  const a = await adapter(t, { fetch: async () => response(build()) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(events.at(-1).type, "error");
  const ends = events.filter((e) => e.type === "toolcall_end"); assert.ok(ends.length <= 1);
});

test("abort, close, and concurrent requests cannot open a second flight", async (t) => {
  let requests = 0, release;
  const gotCall = new Promise((resolve) => { release = resolve; });
  const a = await adapter(t, { fetch: async () => { requests++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(encoded([created(), doneCall()]))); } })); } });
  const abort = new AbortController();
  const stream = a.stream(model, context, { transport: "sse", signal: abort.signal });
  const early = [];
  const collecting = (async () => { for await (const event of stream) { early.push(event); if (event.type === "toolcall_end") release(event); } })();
  const end = await gotCall;
  assert.ok(a.nativeCompletion(end));
  assert.equal((await a.stream(model, context, { transport: "sse" }).result()).errorMessage, "provider_flight_active");
  assert.equal(requests, 1); abort.abort(); await collecting;
  assert.equal((await stream.result()).stopReason, "aborted"); assert.ok(a.nativeCompletion(end));
  a.close(); assert.equal((await a.stream(model, context).result()).errorMessage, "provider_adapter_closed");
});

test("terminal incomplete length and reasoning signature backfill use stock parser", async (t) => {
  const reason = { type: "reasoning", id: "rs_backfill", summary: [{ type: "summary_text", text: "summary" }] };
  const a = await adapter(t, { fetch: async () => response([created(), { type: "response.output_item.done", output_index: 0, item: reason },
    { ...complete("resp_original", [{ ...reason, encrypted_content: "backfilled" }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), type: "response.incomplete" }]) });
  const result = await a.stream(model, context, { transport: "sse" }).result();
  assert.equal(result.stopReason, "length"); assert.equal(result.rawStopReason, "incomplete.max_output_tokens");
  assert.equal(JSON.parse(result.content[0].thinkingSignature).encrypted_content, "backfilled");
});

async function websocketFixture(t, handler) {
  const local = await server(t, (_req, res) => { res.writeHead(500); res.end(); });
  const wss = new WebSocketServer({ server: local.server });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  let connectionCount = 0, requests = [];
  wss.on("connection", (socket, request) => {
    const connection = ++connectionCount;
    assert.equal(request.headers["chatgpt-account-id"], "fixture-account");
    assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`);
    socket.on("message", (data) => { const body = JSON.parse(data.toString()); requests.push(body); handler({ socket, body, connection, count: requests.length }); });
  });
  const selected = { ...model, baseUrl: local.url };
  const a = await adapter(t, { WebSocket, fetch: networkDenied }, selected);
  return { a, selected, requests, connections: () => connectionCount };
}
const send = (socket, raw) => raw.forEach((event) => socket.send(JSON.stringify(event)));

test("WebSocket loopback: exact raw provenance, reused chain delta, changed-prefix full replay", { timeout: 10000 }, async (t) => {
  const f = await websocketFixture(t, ({ socket, count }) => send(socket, count === 1 ? frames() : [created(`resp_${count}`), complete(`resp_${count}`)]));
  const first = await collect(f.a.stream(f.selected, context, { transport: "websocket-cached", sessionId: "session" }));
  assert.ok(f.a.nativeCompletion(first.events.find((e) => e.type === "toolcall_end")));
  const next = { ...context, messages: [...context.messages, first.message, { role: "user", content: "pending continuation", timestamp: 2 }] };
  await f.a.stream(f.selected, next, { transport: "websocket-cached", sessionId: "session", previousResponseId: first.message.responseId }).result();
  assert.equal(f.connections(), 1); assert.equal(f.requests[1].previous_response_id, "resp_original");
  assert.deepEqual(f.requests[1].input, [{ role: "user", content: [{ type: "input_text", text: "pending continuation" }] }]);
  await f.a.stream(f.selected, context, { transport: "websocket-cached", sessionId: "session" }).result();
  assert.equal(f.requests[2].previous_response_id, undefined); assert.equal(f.requests[2].input.length, 1);
});

for (const rejection of ["previous_response_not_found", "websocket_connection_limit_reached"]) test(`WebSocket explicit ${rejection}: reconnect full history without duplicate call`, { timeout: 10000 }, async (t) => {
  const f = await websocketFixture(t, ({ socket, count }) => {
    if (count === 2) socket.send(JSON.stringify({ type: "error", code: rejection, message: "fixture rejection" }));
    else send(socket, count === 1 ? frames() : [created("resp_reconnected"), complete("resp_reconnected")]);
  });
  const first = await f.a.stream(f.selected, context, { transport: "auto", sessionId: "session" }).result();
  const next = { ...context, messages: [...context.messages, first, { role: "user", content: "continue", timestamp: 2 }] };
  const result = await f.a.stream(f.selected, next, { transport: "auto", sessionId: "session" }).result();
  assert.equal(result.stopReason, "stop"); assert.equal(f.connections(), 2); assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1].previous_response_id, "resp_original"); assert.equal(f.requests[2].previous_response_id, undefined);
  assert.equal(f.requests[2].input.find((i) => i.type === "function_call").call_id, "call_original");
  assert.equal(f.requests[2].input.some((i) => i.type === "function_call_output"), false);
});

test("auto falls back before WebSocket send; explicit WebSocket stays visible if unavailable", async (t) => {
  let fetched = 0;
  const a = await adapter(t, { WebSocket: class { constructor() { throw new Error("fixture_connect_denied"); } }, fetch: async () => { fetched++; return response(frames()); } });
  const first = await collect(a.stream(model, context, { transport: "auto" }));
  assert.equal(first.message.stopReason, "toolUse"); assert.ok(a.nativeCompletion(first.events.find((e) => e.type === "toolcall_end")));
  assert.equal(fetched, 1);
  assert.equal((await a.stream(model, context, { transport: "websocket" }).result()).stopReason, "error"); assert.equal(fetched, 1);
});

test("WebSocket unexplained close after send reports unknown inference, never silently replays", { timeout: 10000 }, async (t) => {
  const f = await websocketFixture(t, ({ socket }) => socket.close());
  const result = await f.a.stream(f.selected, context, { transport: "auto", sessionId: "session" }).result();
  assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "websocket_closed"); assert.equal(f.requests.length, 1);
});


for (const [cut, raw, expected] of [
  ["post-send/pre-created", [], { created: false, count: 0 }],
  ["created/pre-complete", [created(), { type: "response.output_item.added", output_index: 0, item: { ...callItem(), arguments: "" } }], { created: true, count: 1, complete: false }],
  ["complete-item", [created(), doneCall()], { created: true, count: 1, complete: true }],
]) test(`fault cut ${cut}: typed UNKNOWN is fenced before publication`, { timeout: 10000 }, async (t) => {
  const f = await websocketFixture(t, ({ socket }) => { send(socket, raw); socket.close(); });
  const { events, message } = await collect(f.a.stream(f.selected, context, { transport: "auto", sessionId: "fault-session" }));
  const report = message.nativeTransport;
  assert.equal(message.stopReason, "error"); assert.equal(report.outcome, "unknown");
  assert.equal(report.sent, true); assert.equal(report.created, expected.created); assert.equal(report.possibleUsage, true);
  assert.equal(report.retired, true); assert.equal(report.fenced, true); assert.equal(report.providerTools, false);
  assert.equal(report.observedCalls.length, expected.count); assert.equal(f.requests.length, 1);
  if (expected.count) assert.equal(report.observedCalls[0].complete, expected.complete);
  assert.ok(report.attemptId); assert.ok(report.requestId); assert.notEqual(report.attemptId, report.requestId);
  assert.equal(report.attemptNumber, 1); assert.equal(report.attempts.length, 1); assert.ok(Object.isFrozen(report.observedCalls));
  assert.equal(events.filter((event) => f.a.nativeCompletion(event)).length, expected.complete ? 1 : 0);
  assert.equal(JSON.stringify(report).includes("fixture-account"), false); assert.equal(JSON.stringify(report).includes("print(1)"), false);
});

test("before-send failure is not UNKNOWN; retired old callbacks cannot admit late frames", async (t) => {
  let socket, sends = 0;
  class LateSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); socket = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
    send() { sends++; queueMicrotask(() => this.dispatchEvent(new Event("close"))); }
    close() { this.readyState = 3; }
  }
  const a = await adapter(t, { WebSocket: LateSocket });
  const { events, message } = await collect(a.stream(model, context, { transport: "websocket" }));
  assert.equal(message.nativeTransport.outcome, "unknown"); assert.equal(sends, 1);
  const size = events.length;
  for (const raw of frames()) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(raw) }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, size); assert.equal(events.some((event) => a.nativeCompletion(event)), false);
  assert.equal(message.nativeTransport.observedCalls.length, 0);
  const b = await adapter(t, { WebSocket: class { constructor() { throw new Error("connect_denied"); } } });
  const before = await b.stream(model, context, { transport: "websocket" }).result();
  assert.equal(before.nativeTransport.sent, false); assert.equal(before.nativeTransport.outcome, "not_sent");
  assert.equal(before.nativeTransport.possibleUsage, false); assert.equal(before.nativeTransport.retired, true);
});

test("SSE unknown reports provider-side tools; explicit provider failure retains usage without private errors", async (t) => {
  const a = await adapter(t, { fetch: async () => response([created()]) });
  const unknown = await a.stream(model, context, { transport: "sse", onPayload: (body) => { body.tools.push({ type: "web_search" }); } }).result();
  assert.equal(unknown.nativeTransport.outcome, "unknown"); assert.equal(unknown.nativeTransport.providerTools, true);
  const b = await adapter(t, { fetch: async () => response([created(), { ...complete("resp_original", [], { status: "failed", error: { code: "context_length_exceeded", message: "PRIVATE_FIXTURE_DO_NOT_RETURN" } }), type: "response.failed" }]) });
  const failed = await b.stream(model, context, { transport: "sse" }).result();
  assert.equal(failed.nativeTransport.outcome, "failed"); assert.equal(failed.nativeTransport.possibleUsage, false);
  assert.equal(failed.errorMessage, "context_length_exceeded"); assert.equal(failed.usage.totalTokens, 112); assert.equal(failed.rawStopReason, "failed");
  assert.equal(JSON.stringify(failed).includes("PRIVATE_FIXTURE_DO_NOT_RETURN"), false);
});

test("timeout cancels transport and exposes an error plus UNKNOWN, not caller abort", async (t) => {
  const a = await adapter(t, { fetch: async () => new Response(new ReadableStream({ start() {} })) });
  const result = await a.stream(model, context, { transport: "sse", timeoutMs: 10 }).result();
  assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "provider_timeout");
  assert.equal(result.nativeTransport.outcome, "unknown"); assert.equal(result.nativeTransport.fenced, true);
});

test("ordinary providers delegate through public ModelRuntime streamSimple without native admission", async (t) => {
  const selected = { ...model, api: "faux-api", compat: {} };
  const runtime = { getAuth() { throw new Error("must_not_resolve_twice"); }, streamSimple(m, c, o) {
    assert.equal(o.reasoning, "low"); assert.equal(c.tools[0].name, "ipython");
    const stream = api.createAssistantMessageEventStream();
    const output = api.fauxAssistantMessage([api.fauxToolCall("ipython", { code: "ordinary" })]);
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: output.content[0], partial: output });
    stream.push({ type: "done", reason: "toolUse", message: { ...output, stopReason: "toolUse" } }); stream.end(); return stream;
  } };
  const a = createNativeProviderAdapter({ api, responsesApi, modelRuntime: runtime }); t.after(() => a.close());
  const result = await collect(a.stream(selected, { ...context, tools: [{ ...tool, async: undefined }] }, { reasoning: "low" }));
  assert.equal(result.message.stopReason, "toolUse"); assert.ok(result.events.some((e) => e.type === "toolcall_end"));
  assert.ok(result.events.every((e) => !a.nativeCompletion(e)));
});

test("raw grammar calls retain original custom item and exact input on replay", async (t) => {
  const selected = { ...model, compat: { ...model.compat, supportsOpenAIGrammarTools: true } };
  const grammarTool = { name: "patch", description: "fixture grammar", async: true,
    parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/s" } } };
  const item = { type: "custom_tool_call", id: "ctc_original", call_id: "call_custom", name: "patch", input: "literal\npatch", async: true };
  let sent;
  const a = await adapter(t, { fetch: async (_url, init) => { sent = JSON.parse(init.body); return response([created(), doneCall(item), complete()]); } }, selected);
  const first = await collect(a.stream(selected, { ...context, tools: [grammarTool] }, { transport: "sse" }));
  const event = first.events.find((e) => e.type === "toolcall_end");
  assert.equal(a.nativeCompletion(event).itemId, "ctc_original"); assert.deepEqual(event.toolCall.arguments, { input: "literal\npatch" });
  const result = { role: "toolResult", toolCallId: event.toolCall.id, toolName: "patch", content: [{ type: "text", text: "patched" }], timestamp: 2, isError: false };
  await a.stream(selected, { ...context, tools: [grammarTool], messages: [...context.messages, first.message, result] }, { transport: "sse" }).result();
  assert.equal(sent.tools[0].type, "custom");
  assert.equal(sent.input.find((i) => i.type === "custom_tool_call").input, item.input);
  assert.equal(sent.input.find((i) => i.type === "custom_tool_call_output").call_id, "call_custom");
});

test("raw API-key Responses path honors mapped reasoning and original IDs", async (t) => {
  const selected = { ...model, api: "openai-responses", thinkingLevelMap: { high: "mapped-high" } };
  let sent, url;
  const a = await adapter(t, { fetch: async (u, init) => { url = u; sent = JSON.parse(init.body); return response(frames()); } }, selected);
  const result = await collect(a.stream(selected, context, { transport: "sse", reasoning: "high", serviceTier: "flex", maxTokens: 17 }));
  assert.equal(url, `${selected.baseUrl}/responses`); assert.equal(sent.reasoning.effort, "mapped-high"); assert.equal(sent.max_output_tokens, 17);
  assert.equal(sent.input[0].role, "developer"); assert.ok(a.nativeCompletion(result.events.find((e) => e.type === "toolcall_end")));
  assert.ok(Math.abs(result.message.usage.cost.total - 0.000057) < 1e-15);
});

test("missing full item at terminal cannot turn partial arguments into an ordinary executable call", async (t) => {
  const raw = [created(), { type: "response.output_item.added", output_index: 0, item: { ...callItem(), arguments: "", async: undefined } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"code":' }, complete()];
  const a = await adapter(t, { fetch: async () => response(raw) });
  const result = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(result.message.stopReason, "error"); assert.equal(result.message.errorMessage, "incomplete_tool_item_at_terminal");
  assert.equal(result.events.some((e) => e.type === "toolcall_end"), false);
});

test("raw ID delimiters survive result replay via retained original identity", async (t) => {
  let sent, count = 0;
  const item = callItem({ id: "fc_item|suffix", call_id: "call|original" });
  const a = await adapter(t, { fetch: async (_url, init) => { sent = JSON.parse(init.body); return response(++count === 1 ? frames(item) : [created("resp_after"), complete("resp_after")]); } });
  const first = await a.stream(model, context, { transport: "sse" }).result();
  const call = first.content.find((block) => block.type === "toolCall");
  const result = { role: "toolResult", toolCallId: call.id, toolName: "ipython", content: [{ type: "text", text: "actual" }], isError: false, timestamp: 2 };
  const last = await a.stream(model, { ...context, messages: [...context.messages, first, result] }, { transport: "sse" }).result();
  assert.equal(last.stopReason, "stop");
  assert.equal(sent.input.find((i) => i.type === "function_call").id, item.id);
  assert.equal(sent.input.find((i) => i.type === "function_call_output").call_id, item.call_id);
});


test("public hook errors never become a private error-payload log", async (t) => {
  const a = await adapter(t);
  const result = await a.stream(model, context, { transport: "sse", onPayload() { throw new Error("privatepayloadwithoutspaces"); } }).result();
  assert.equal(result.errorMessage, "provider_request_failed");
});

test("explicit rejection retry reports each retired attempt with a distinct ID", { timeout: 10000 }, async (t) => {
  const f = await websocketFixture(t, ({ socket, count }) => {
    if (count === 1) socket.send(JSON.stringify({ type: "error", code: "websocket_connection_limit_reached" }));
    else send(socket, [created("resp_accepted"), complete("resp_accepted")]);
  });
  const result = await f.a.stream(f.selected, context, { transport: "auto", sessionId: "session" }).result();
  assert.equal(result.nativeTransport.attempts.length, 2);
  const [rejected, accepted] = result.nativeTransport.attempts;
  assert.equal(rejected.outcome, "rejected"); assert.equal(rejected.retired, true); assert.equal(rejected.fenced, true);
  assert.equal(accepted.outcome, "completed"); assert.notEqual(rejected.attemptId, accepted.attemptId);
});

for (const transport of ["sse", "websocket"]) test(`${transport}: actual terminal-only items preserve complete-call provenance`, { timeout: 10000 }, async (t) => {
  const item = callItem({ id: "fc_terminal", call_id: "call_terminal", status: "completed" });
  const reason = { type: "reasoning", id: "rs_terminal", summary: [], encrypted_content: "opaque-terminal" };
  const text = { type: "message", id: "msg_terminal", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "terminal text", annotations: [] }] };
  const raw = [complete("resp_terminal", [reason, item, text])];
  let a, selected;
  if (transport === "websocket") {
    const f = await websocketFixture(t, ({ socket }) => send(socket, raw)); a = f.a; selected = f.selected;
  } else { a = await adapter(t, { fetch: async () => response(raw) }); selected = model; }
  const { events, message } = await collect(a.stream(selected, context, { transport }));
  assert.equal(message.stopReason, "toolUse"); assert.equal(message.responseId, "resp_terminal");
  const ends = events.filter((e) => e.type === "toolcall_end"); assert.equal(ends.length, 1);
  const proof = a.nativeCompletion(ends[0]); assert.equal(proof.responseId, "resp_terminal"); assert.equal(proof.itemId, "fc_terminal");
  assert.equal(proof.callId, "call_terminal"); assert.equal(proof.call.async, true);
  assert.equal(message.content.find((b) => b.type === "text").text, "terminal text");
  assert.deepEqual(JSON.parse(message.content.find((b) => b.type === "thinking").thinkingSignature), reason);
});

for (const partial of [false, true]) test(`terminal list does not double-admit a ${partial ? "partially streamed" : "completed"} item`, async (t) => {
  const item = callItem();
  const raw = [created(), partial ? { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } } : doneCall(item), complete("resp_original", [item])];
  const a = await adapter(t, { fetch: async () => response(raw) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "toolUse"); assert.equal(events.filter((e) => a.nativeCompletion(e)).length, 1);
  assert.equal(events.filter((e) => e.type === "toolcall_start").length, 1);
  assert.equal(events.filter((e) => e.type === "toolcall_end").length, 1);
});

for (const change of [{ arguments: '{"code":"other"}' }, { async: false }, { call_id: "other" }, { status: "in_progress" }]) test(`conflicting terminal item keeps earlier verified completion: ${Object.keys(change)[0]}`, async (t) => {
  const a = await adapter(t, { fetch: async () => response([created(), doneCall(), complete("resp_original", [callItem(change)])]) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "conflicting_terminal_item");
  const proven = events.filter((e) => a.nativeCompletion(e)); assert.equal(proven.length, 1);
  assert.deepEqual(a.nativeCompletion(proven[0]).call.arguments, { code: "print(1)" });
});

test("incomplete terminal items cannot supply native or ordinary complete calls", async (t) => {
  const a = await adapter(t, { fetch: async () => response([created(), complete("resp_original", [callItem({ status: "in_progress" })])]) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "incomplete_terminal_item");
  assert.equal(events.filter((e) => e.type === "toolcall_end").length, 0);
});



function memorySocket(onSend) {
  const sockets = [], requests = [];
  class MemorySocket extends EventTarget {
    readyState = 0;
    constructor() {
      super(); sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
    }
    send(text) { const request = JSON.parse(text); requests.push(request); onSend(this, requests.length, request); }
    emit(raw) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(raw) })); }
    close() { this.readyState = 3; }
  }
  return { WebSocket: MemorySocket, sockets, requests };
}

for (const [name, stale] of Object.entries({
  "terminal-only": (item) => [complete("r-first", [item])],
  "created then done then terminal": (item) => [created("r-first"), doneCall(item), complete("r-first", [item])],
  "done without response ID": (item) => [doneCall(item)],
  "retired call ID without old item ID": (item) => [doneCall({ ...item, id: "renamed-old-item" })],
  "terminal without response ID": (item) => [complete(undefined, [item], { id: undefined })],
  "added and argument delta": (item) => [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }],
  "response_id alias": (item) => [{ ...doneCall({ ...item, id: "not-previously-seen" }), response_id: "r-first" }],
})) test(`cached successful generation fences delayed ${name} before any new event`, { timeout: 10000 }, async (t) => {
  const prior = callItem({ id: "i-first", call_id: "c-first", status: "completed" });
  const nextItem = callItem({ id: "i-second", call_id: "c-second", status: "completed", arguments: '{"code":"second"}' });
  let staleSent;
  const sentStale = new Promise((resolve) => { staleSent = resolve; });
  const wire = memorySocket((socket, number) => {
    queueMicrotask(() => {
      if (number === 1) for (const raw of frames(prior, "r-first")) socket.emit(raw);
      else if (number === 2) { for (const raw of stale(prior)) socket.emit(raw); staleSent(); }
      else for (const raw of [complete("r-first", [prior]), complete("r-third")]) socket.emit(raw);
    });
  });
  const a = await adapter(t, { WebSocket: wire.WebSocket });
  const options = { transport: "websocket-cached", sessionId: "successful-cache", timeoutMs: 1000 };
  const first = await collect(a.stream(model, context, options));
  const originalEvent = first.events.find((event) => a.nativeCompletion(event));
  assert.ok(originalEvent); assert.equal(first.message.nativeTransport.fenced, true);
  const next = { ...context, messages: [...context.messages, first.message, { role: "user", content: "second request", timestamp: 2 }] };
  const secondStream = a.stream(model, next, options), secondEvents = [];
  const collecting = (async () => { for await (const event of secondStream) secondEvents.push(event); })();
  await sentStale; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wire.sockets.length, 1, "must preserve a healthy cached socket");
  assert.equal(wire.requests[1].previous_response_id, "r-first");
  assert.equal(secondEvents.length, 0, "stale frames cannot emit even a start event");
  // The real new response can still be terminal-only, without response.created.
  wire.sockets[0].emit(complete("r-second", [nextItem]));
  await collecting;
  const second = await secondStream.result();
  assert.equal(second.stopReason, "toolUse"); assert.equal(second.responseId, "r-second");
  const calls = secondEvents.filter((event) => event.type === "toolcall_end"); assert.equal(calls.length, 1);
  const proof = a.nativeCompletion(calls[0]); assert.equal(proof.responseId, "r-second"); assert.equal(proof.itemId, "i-second");
  assert.equal(proof.callId, "c-second"); assert.deepEqual(proof.call.arguments, { code: "second" });
  assert.deepEqual(second.nativeTransport.observedCalls, [{ itemId: "i-second", callId: "c-second", complete: true, native: true }]);
  assert.equal(a.nativeCompletion(originalEvent).responseId, "r-first");
  // Retain more than the immediately preceding chain's identities.
  const third = await collect(a.stream(model, { ...next, messages: [...next.messages, second] }, options));
  assert.equal(third.message.responseId, "r-third"); assert.equal(third.message.stopReason, "stop");
  assert.equal(third.events.filter((event) => event.type === "toolcall_end").length, 0);
  assert.equal(wire.sockets.length, 1); assert.equal(wire.requests[2].previous_response_id, "r-second");
});

test("cached generation fences old identities after the new response.created", { timeout: 10000 }, async (t) => {
  const prior = callItem({ id: "i-first", call_id: "c-first" });
  const nextItem = callItem({ id: "i-second", call_id: "c-second" });
  const wire = memorySocket((socket, number) => queueMicrotask(() => {
    const raw = number === 1 ? frames(prior, "r-first") : [created("r-second"), created("r-first"), doneCall(prior),
      complete("r-first", [prior]), doneCall(nextItem), complete("r-second", [nextItem])];
    raw.forEach((frame) => socket.emit(frame));
  }));
  const a = await adapter(t, { WebSocket: wire.WebSocket });
  const options = { transport: "websocket-cached", sessionId: "successful-cache", timeoutMs: 1000 };
  await a.stream(model, context, options).result();
  const result = await collect(a.stream(model, context, options));
  assert.equal(result.message.stopReason, "toolUse"); assert.equal(result.message.responseId, "r-second");
  assert.equal(result.events.filter((event) => event.type === "start").length, 1);
  const proven = result.events.filter((event) => a.nativeCompletion(event)); assert.equal(proven.length, 1);
  assert.equal(a.nativeCompletion(proven[0]).itemId, "i-second"); assert.equal(wire.sockets.length, 1);
});

for (const grammar of [false, true]) for (const native of [false, true]) {
  test(`${grammar ? "grammar" : "function"} ${native ? "native" : "ordinary"}: explicit incomplete done never emits a complete call`, async (t) => {
    const selected = { ...model, compat: { ...model.compat, supportsOpenAIGrammarTools: true } };
    const selectedTool = grammar ? { name: "patch", description: "fixture grammar", async: native,
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/s" } } } : { ...tool, async: native };
    for (const status of ["in_progress", "incomplete", "failed", "queued", null]) for (const added of [false, true]) {
      const item = grammar ? { type: "custom_tool_call", id: "ctc_incomplete", call_id: "call_incomplete", name: "patch", input: "valid input", async: native, status }
        : callItem({ async: native, status });
      const raw = [created(), ...(added ? [{ type: "response.output_item.added", output_index: 0, item }] : []), doneCall(item), complete()];
      const a = await adapter(t, { fetch: async () => response(raw) }, selected);
      const result = await collect(a.stream(selected, { ...context, tools: [selectedTool] }, { transport: "sse" }));
      assert.equal(result.message.stopReason, "error", `status=${status}, added=${added}`);
      assert.equal(result.message.errorMessage, "incomplete_output_item");
      assert.equal(result.events.some((event) => event.type === "toolcall_end"), false);
      assert.equal(result.events.some((event) => a.nativeCompletion(event)), false);
      assert.equal(result.message.nativeTransport.observedCalls.some((call) => call.complete), false);
      a.close();
    }
  });
}

test("invalid done status cannot retract an earlier verified complete call", async (t) => {
  const partial = callItem({ id: "fc_incomplete", call_id: "call_incomplete", status: "in_progress" });
  const a = await adapter(t, { fetch: async () => response([created(), doneCall(), doneCall(partial, 1), complete()]) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "incomplete_output_item");
  const calls = events.filter((event) => event.type === "toolcall_end"); assert.equal(calls.length, 1);
  assert.equal(a.nativeCompletion(calls[0]).itemId, "fc_original");
});


test("stale completed usage cannot turn a new unexplained close into success", async (t) => {
  const prior = callItem();
  const wire = memorySocket((socket, number) => queueMicrotask(() => {
    if (number === 1) frames(prior, "r-first").forEach((raw) => socket.emit(raw));
    else { socket.emit(complete("r-first", [prior])); socket.dispatchEvent(new Event("close")); }
  }));
  const a = await adapter(t, { WebSocket: wire.WebSocket });
  const options = { transport: "auto", sessionId: "successful-cache" };
  await a.stream(model, context, options).result();
  const result = await collect(a.stream(model, context, options));
  assert.equal(result.message.stopReason, "error"); assert.equal(result.message.errorMessage, "websocket_closed");
  assert.equal(result.message.nativeTransport.outcome, "unknown"); assert.equal(result.message.nativeTransport.possibleUsage, true);
  assert.equal(result.message.nativeTransport.created, false); assert.equal(result.message.nativeTransport.responseId, undefined);
  assert.deepEqual(result.message.nativeTransport.observedCalls, []); assert.equal(result.message.usage.totalTokens, 0);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].type, "error"); assert.equal(wire.requests.length, 2);
});

for (const source of ["done", "terminal"]) test(`new response cannot claim a retired item identity via ${source}`, async (t) => {
  const prior = callItem();
  const wire = memorySocket((socket, number) => queueMicrotask(() => {
    const raw = number === 1 ? frames(prior, "r-first") : source === "done"
      ? [{ ...doneCall(prior), response_id: "r-second" }, complete("r-second")]
      : [complete("r-second", [prior])];
    raw.forEach((frame) => socket.emit(frame));
  }));
  const a = await adapter(t, { WebSocket: wire.WebSocket });
  const options = { transport: "websocket-cached", sessionId: "successful-cache" };
  await a.stream(model, context, options).result();
  const result = await collect(a.stream(model, context, options));
  assert.equal(result.message.stopReason, "error"); assert.equal(result.message.errorMessage, "retired_output_identity");
  assert.equal(result.events.some((event) => event.type === "toolcall_end"), false);
  assert.equal(result.events.some((event) => a.nativeCompletion(event)), false);
  assert.deepEqual(result.message.nativeTransport.observedCalls, []);
});


for (const [name, reasoning, options, thinkingLevelMap] of [
  ["non-reasoning model", false, {}, undefined],
  ["reasoning enabled with off effort", true, { reasoning: "off" }, undefined],
  ["reasoning enabled mapped high", true, { reasoning: "high" }, { high: "mapped-high" }],
  ["explicit mapped high effort", true, { reasoningEffort: "high" }, { high: "mapped-high" }],
]) test(`Codex ciphertext request/default tool policy and real reasoning replay: ${name}`, async (t) => {
  const selected = { ...model, reasoning, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
  const reason = { type: "reasoning", id: "reason-policy", summary: [], encrypted_content: "opaque-real-wire-ciphertext" };
  const sent = [];
  const a = await adapter(t, { fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return response(sent.length === 1 ? [complete("policy-first", [reason])] : [complete("policy-second")]);
  } }, selected);
  const first = await a.stream(selected, context, { transport: "sse", ...options }).result();
  assert.equal(first.stopReason, "stop");
  assert.deepEqual(JSON.parse(first.content.find(block => block.type === "thinking").thinkingSignature), reason);
  const last = await a.stream(selected, { ...context, messages: [...context.messages, first] }, { transport: "sse", ...options }).result();
  assert.equal(last.stopReason, "stop");
  for (const body of sent) { assert.deepEqual(body.include, ["reasoning.encrypted_content"]); assert.equal(body.tool_choice, "auto"); }
  assert.deepEqual(sent[1].input.find(item => item.type === "reasoning"), reason);
  if (!reasoning) assert.equal(sent[0].reasoning, undefined);
  if (thinkingLevelMap) assert.equal(sent[0].reasoning.effort, "mapped-high");
});

for (const toolChoice of ["auto", "none", "required"]) test(`Codex supported explicit toolChoice=${toolChoice} keeps ciphertext request`, async (t) => {
  let sent;
  const selected = { ...model, reasoning: false };
  const a = await adapter(t, { fetch: async (_url, init) => { sent = JSON.parse(init.body); return response([complete()]); } }, selected);
  const result = await a.stream(selected, context, { transport: "sse", toolChoice }).result();
  assert.equal(result.stopReason, "stop"); assert.equal(sent.tool_choice, toolChoice); assert.deepEqual(sent.include, ["reasoning.encrypted_content"]);
});

test("Codex wire defaults match exact public stock payload before any network operation", async (t) => {
  const codex = await import(codexApiUrl.href);
  for (const reasoning of [false, true]) for (const toolChoice of [undefined, "none", "required"]) {
    const selected = { ...model, reasoning };
    let stockBody, candidateBody;
    // This public hook aborts before stock can dispatch a request. No credential
    // resolution or global/provider patch is involved; the key is synthetic.
    const stockResult = await codex.stream(selected, context, { apiKey: syntheticKey, transport: "sse", toolChoice,
      fetch: networkDenied, onPayload(body) { stockBody = copied(body); throw Error("fixture_stop_before_network"); } }).result();
    assert.equal(stockResult.stopReason, "error"); assert.ok(stockBody);
    const a = await adapter(t, { fetch: async (_url, init) => { candidateBody = JSON.parse(init.body); return response([complete()]); } }, selected);
    await a.stream(selected, context, { transport: "sse", toolChoice }).result();
    assert.deepEqual(candidateBody.include, stockBody.include); assert.equal(candidateBody.tool_choice, stockBody.tool_choice);
  }
});


const completeReason = (changes = {}) => ({ type: "reasoning", id: "rs-consistent", summary: [{ type: "summary_text", text: "original summary" }],
  content: [{ type: "reasoning_text", text: "original body" }], encrypted_content: "cipher-original", ...changes });
for (const [name, change] of Object.entries({
  ciphertext: reason => ({ ...reason, encrypted_content: "cipher-conflict" }),
  "removed ciphertext": ({ encrypted_content, ...reason }) => reason,
  summary: reason => ({ ...reason, summary: [{ type: "summary_text", text: "changed summary" }] }),
  body: reason => ({ ...reason, content: [{ type: "reasoning_text", text: "changed body" }] }),
  "extra field": reason => ({ ...reason, unexpected: "changed field" }),
})) test(`raw completed reasoning conflict before parser: ${name}`, async (t) => {
  const original = completeReason(), conflicting = change(original);
  const lateCall = callItem({ id: "call-not-admitted-item", call_id: "call-not-admitted", status: "completed" });
  const a = await adapter(t, { fetch: async () => response([created(), doneCall(),
    { type: "response.output_item.done", output_index: 1, item: original }, complete("resp_original", [lateCall, conflicting])]) });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "conflicting_terminal_reasoning");
  const calls = events.filter(event => event.type === "toolcall_end"); assert.equal(calls.length, 1, "preflight precedes ALL terminal-only item normalization");
  const proof = a.nativeCompletion(calls[0]); assert.equal(proof.itemId, "fc_original"); assert.deepEqual(proof.call.arguments, { code: "print(1)" });
  assert.deepEqual(JSON.parse(message.content.find(block => block.type === "thinking").thinkingSignature), original);
  assert.equal(message.usage.totalTokens, 112, "actual terminal usage is retained even on a provenance error");
});

for (const missing of [undefined, null, ""]) test(`raw completed reasoning allows only ciphertext backfill from ${String(missing)}`, async (t) => {
  const original = completeReason({ encrypted_content: missing });
  if (missing === undefined) delete original.encrypted_content;
  const final = { ...original, encrypted_content: "cipher-backfilled" };
  let sent, requests = 0;
  const a = await adapter(t, { fetch: async (_url, init) => {
    sent = JSON.parse(init.body);
    return response(++requests === 1 ? [created(), { type: "response.output_item.done", output_index: 0, item: original }, complete("resp_original", [final])] : [complete("resp-next")]);
  } });
  const first = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(first.message.stopReason, "stop");
  assert.equal(first.events.filter(event => event.type === "thinking_end").length, 1);
  assert.deepEqual(JSON.parse(first.message.content[0].thinkingSignature), final);
  await a.stream(model, { ...context, messages: [...context.messages, first.message] }, { transport: "sse" }).result();
  assert.deepEqual(sent.input.find(item => item.type === "reasoning"), final);
  assert.equal(original.encrypted_content, missing, "actual original raw item was not overwritten");
});

test("unchanged complete reasoning and identical nonempty ciphertext are valid repeated terminal items", async (t) => {
  const original = completeReason();
  const a = await adapter(t, { fetch: async () => response([created(), { type: "response.output_item.done", output_index: 0, item: original }, complete("resp_original", [copied(original)])]) });
  const result = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(result.message.stopReason, "stop"); assert.deepEqual(JSON.parse(result.message.content[0].thinkingSignature), original);
  assert.equal(result.events.filter(event => event.type === "thinking_end").length, 1);
});

for (const source of ["done", "terminal", "repeated-terminal"]) test(`invalid non-string/non-null reasoning ciphertext rejected at ${source}`, async (t) => {
  for (const encrypted_content of [false, 0, {}, []]) {
    const invalid = completeReason({ encrypted_content });
    const raw = [created(), doneCall()];
    if (source === "done") raw.push({ type: "response.output_item.done", output_index: 1, item: invalid }, complete());
    else {
      if (source === "repeated-terminal") raw.push({ type: "response.output_item.done", output_index: 1, item: completeReason() });
      raw.push(complete("resp_original", [invalid]));
    }
    const a = await adapter(t, { fetch: async () => response(raw) });
    const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
    assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "invalid_reasoning_encryption");
    assert.equal(events.filter(event => a.nativeCompletion(event)).length, 1);
    if (source !== "repeated-terminal") assert.equal(events.some(event => event.type === "thinking_end"), false);
  }
});

for (const [cut, raw, observed] of [
  ["empty wire", [], 0], ["created only", [created()], 0],
  ["partial item", [created(), { type: "response.output_item.added", output_index: 0, item: { ...callItem(), arguments: "" } }], 1],
  ["complete item", [created(), doneCall()], 1],
]) test(`SSE raw EOF ${cut} produces typed UNKNOWN without guessing exceptions`, async (t) => {
  let requests = 0;
  const a = await adapter(t, { fetch: async () => { requests++; return response(raw); } });
  const { events, message } = await collect(a.stream(model, context, { transport: "sse" }));
  assert.equal(message.stopReason, "error"); assert.equal(message.errorMessage, "provider_stream_incomplete");
  assert.equal(message.nativeTransport.outcome, "unknown"); assert.equal(message.nativeTransport.sent, true);
  assert.equal(message.nativeTransport.retired, true); assert.equal(message.nativeTransport.fenced, true); assert.equal(message.nativeTransport.possibleUsage, true);
  assert.equal(message.nativeTransport.observedCalls.length, observed); assert.equal(requests, 1);
  assert.equal(events.filter(event => a.nativeCompletion(event)).length, cut === "complete item" ? 1 : 0);
});

test("SSE EOF code cannot swallow malformed raw JSON or private hook exceptions", async (t) => {
  const malformed = await adapter(t, { fetch: async () => new Response('data: {broken\n\n') });
  assert.equal((await malformed.stream(model, context, { transport: "sse" }).result()).errorMessage, "invalid_provider_json");
  const hook = await adapter(t, { fetch: async () => response([created()]) });
  assert.equal((await hook.stream(model, context, { transport: "sse", onResponse() { throw Error("private failure"); } }).result()).errorMessage, "provider_request_failed");
  const ended = await adapter(t, { fetch: async () => new Response('data: [DONE]\n\n') });
  assert.equal((await ended.stream(model, context, { transport: "sse" }).result()).errorMessage, "provider_stream_incomplete");
});
