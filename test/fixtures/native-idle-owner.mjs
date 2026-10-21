import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { loadExternalPi } from "../../src/external-pi.mjs";
import { createNativeProviderAdapter } from "../../src/native-provider.mjs";

// This process owns only public synthetic values; collection never touches a worker.
const { api, responsesApi } = await loadExternalPi({ env: { PI_HARNESS_PI_MODULE: process.argv[2] } });
const model = { id: "idle-owner-fixture", provider: "fixture", api: "openai-codex-responses", baseUrl: "http://127.0.0.1:1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1024, contextWindow: 16000 };
const frames = [];
let sockets = 0, closed = 0;
class FixtureSocket extends EventTarget {
  readyState = 1;
  constructor() { super(); sockets++; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(text) {
    frames.push(JSON.parse(text));
    const id = `response-${frames.length}`;
    for (const raw of [{ type: "response.created", response: { id, status: "in_progress" } },
      { type: "response.completed", response: { id, status: "completed", output: [],
        usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 1 } } }]) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(raw) }));
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3; closed++; queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}
function adapter(options = {}) {
  return createNativeProviderAdapter({ api, responsesApi, modelRuntime: { getAuth: async () => ({ auth: {} }) },
    transportOptions: { WebSocket: FixtureSocket, fetch() { throw new Error("unexpected_network"); }, ...options } });
}
async function request(owner, texts, options = {}) {
  const context = { systemPrompt: "public fixture system", messages: texts.map(text => ({ role: "user", content: text, timestamp: 1 })), tools: [] };
  const weak = new WeakRef(context);
  const stream = owner.stream(model, context, { sessionId: "fixture-session", ...options });
  for await (const event of stream) { assert.notEqual(event.type, "error"); }
  assert.equal((await stream.result()).stopReason, "stop");
  return weak;
}
async function collected(weak) {
  for (let index = 0; index < 6; index++) { await tick(); global.gc(); }
  await tick();
  assert.equal(weak.deref(), undefined, "a completed request's caller context must not live with the idle connection");
}
const owner = adapter();
try {
  await collected(await request(owner, ["first public input"]));
  assert.equal(sockets, 1); assert.equal(closed, 0, "releasing caller context must keep the warm connection");
  await collected(await request(owner, ["first public input", "second public input"]));
  assert.equal(sockets, 1);
  assert.equal(frames[1].previous_response_id, "response-1");
  assert.equal(frames[1].input.length, 1, "the required continuation baseline must still select the suffix");
  assert.equal(frames[1].input[0].content[0].text, "second public input");
  // An identity change retires the old connection without losing the next request.
  await collected(await request(owner, ["replacement"], { sessionId: "replacement-session" }));
  assert.equal(sockets, 2); assert.equal(closed, 1);
  assert.equal(frames[2].previous_response_id, undefined);
} finally { owner.close(); }
assert.equal(closed, 2);
const expiring = adapter({ cacheTtlMs: 20 });
try {
  await request(expiring, ["expires"]);
  await sleep(60);
  assert.equal(closed, 3, "idle TTL must still retire its connection");
  await request(expiring, ["reconnects"]);
  assert.equal(sockets, 4); assert.equal(frames[4].previous_response_id, undefined);
} finally { expiring.close(); }
const uncached = adapter();
try {
  await collected(await request(uncached, ["not retained"], { cacheRetention: "none" }));
  assert.equal(closed, 5);
} finally { uncached.close(); }
console.log("native idle caller ownership passed");
