import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { reduceIdleMemory, IDLE_MEMORY_GAP_BYTES } from "../src/idle-memory.mjs";
import { SDKWorker, runSDKWorkerRpc } from "../src/sdk-worker.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("idle-index fixture condition did not complete");
}
async function fixture(t, { configured = true, supported = true, reduceMemory } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-entry-index-"));
  const calls = [], gates = []; let closed = false;
  const manager = supported ? { prepareEntryIndex({ signal }) {
    const gate = Promise.withResolvers(); calls.push({ signal }); gates.push(gate); return gate.promise;
  } } : {};
  const session = { sessionManager: manager, isIdle: true, pendingMessageCount: 0,
    subscribe: () => () => {}, dispose() { closed = true; }, settingsManager: { flush: async () => {} } };
  const coordinator = { isBusy: false, pendingMessageCount: 0, submit: async () => ({ outcome: "accepted" }),
    getState: () => ({ isStreaming: false }), abort: async () => {}, close: async () => {}, waitForIdle: async () => {} };
  const cachePath = path.join(root, "private", "source.index");
  const worker = new SDKWorker({ session, coordinator, runner: { invalidate() {} }, broker: { close() {}, cancelAll() {} },
    sdk: {}, lifecycle: {}, publish() {}, entryIndexCachePath: configured ? cachePath : undefined, reduceMemory });
  t.after(async () => { for (const gate of gates) gate.resolve(false); await worker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, worker, session, coordinator, manager, calls, gates, cachePath, closed: () => closed };
}

test("entry-index worker skips unsupported, unconfigured, busy and pending state without creating a directory", async t => {
  for (const options of [{ supported: false }, { configured: false }, {}]) {
    const f = await fixture(t, options);
    if (options.supported !== false && options.configured !== false) {
      f.coordinator.isBusy = true;
    }
    assert.equal(await f.worker.handle({ type: "prepare_entry_index", token: "skip" }), false);
    assert.equal(f.calls.length, 0);
    await assert.rejects(stat(path.dirname(f.cachePath)), { code: "ENOENT" });
  }
  const f = await fixture(t);
  for (const [owner, key, value] of [[f.session, "isIdle", false], [f.session, "pendingMessageCount", 1], [f.coordinator, "pendingMessageCount", 1]]) {
    const previous = owner[key]; owner[key] = value;
    assert.equal(await f.worker.handle({ type: "prepare_entry_index", token: "pending" }), false);
    owner[key] = previous;
  }
  assert.equal(f.calls.length, 0);
});

test("entry-index worker token cancellation leaves prompt and successor preparation independent", async t => {
  const f = await fixture(t);
  const first = f.worker.handle({ type: "prepare_entry_index", token: "old" });
  await until(() => f.calls.length === 1);
  assert.equal((await stat(path.dirname(f.cachePath))).mode & 0o777, 0o700);
  assert.equal(await f.worker.handle({ type: "prepare_entry_index", token: "duplicate" }), false);
  assert.equal(await f.worker.handle({ type: "cancel_entry_index", token: "foreign" }), false);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.deepEqual(await f.worker.handle({ type: "prompt", message: "new input" }), { outcome: "accepted" });
  assert.equal(f.calls[0].signal.aborted, true);
  f.gates[0].resolve(true); assert.equal(await first, true, "late sealed publication is not rewritten as freshness");
  const second = f.worker.handle({ type: "prepare_entry_index", token: "new" });
  await until(() => f.calls.length === 2);
  assert.equal(await f.worker.handle({ type: "cancel_entry_index", token: "old" }), false);
  assert.equal(f.calls[1].signal.aborted, false);
  assert.equal(await f.worker.handle({ type: "cancel_entry_index", token: "new" }), true);
  assert.equal(f.calls[1].signal.aborted, true);
  f.gates[1].resolve(false); assert.equal(await second, false);
});

for (const type of ["steer", "follow_up", "abort", "abort_retry", "close"]) {
  test(`entry-index ${type} aborts preparation without joining its promise`, async t => {
    const f = await fixture(t); const work = f.worker.handle({ type: "prepare_entry_index", token: type });
    await until(() => f.calls.length === 1);
    if (type === "close") { await f.worker.close(); assert.equal(f.closed(), true); }
    else await f.worker.handle({ type, message: "wake" });
    assert.equal(f.calls[0].signal.aborted, true);
    f.gates[0].resolve(false); await work;
  });
}

test("entry-index optional filesystem failure does not mutate a blocking source or dispatch SDK work", async t => {
  const f = await fixture(t); await writeFile(path.dirname(f.cachePath), "owned synthetic blocker");
  assert.equal(await f.worker.handle({ type: "prepare_entry_index", token: "failed-directory" }), false);
  assert.equal(await readFile(path.dirname(f.cachePath), "utf8"), "owned synthetic blocker"); assert.equal(f.calls.length, 0);
});

test("entry-index held RPC leaves prompt, cancellation and transport close concurrent", async t => {
  const f = await fixture(t); const input = new PassThrough(), output = new PassThrough(); const frames = [];
  output.on("data", chunk => { for (const line of chunk.toString().trim().split("\n")) frames.push(JSON.parse(line)); });
  const run = runSDKWorkerRpc({ input, output, bootstrap: async () => f.worker, installSignalHandlers: false });
  input.write(JSON.stringify({ id: "prepare", type: "prepare_entry_index", token: "rpc" }) + "\n");
  await until(() => f.calls.length === 1);
  input.write(JSON.stringify({ id: "prompt", type: "prompt", message: "continue" }) + "\n");
  input.write(JSON.stringify({ id: "cancel", type: "cancel_entry_index", token: "rpc" }) + "\n");
  await until(() => frames.some(frame => frame.id === "cancel") && frames.some(frame => frame.id === "prompt"));
  assert.equal(frames.find(frame => frame.id === "prompt").success, true);
  assert.equal(frames.some(frame => frame.id === "prepare"), false);
  input.end(); await run; assert.equal(f.closed(), true);
  f.gates[0].resolve(true); await tick();
});


test("entry-index optional RPC does not block extension-requested shutdown", async t => {
  const f = await fixture(t), input = new PassThrough(), output = new PassThrough(); output.resume();
  const run = runSDKWorkerRpc({ input, output, installSignalHandlers: false, bootstrap: async ({ lifecycle }) => {
    f.coordinator.submit = async () => { lifecycle.requestShutdown(); return { outcome: "handled" }; }; return f.worker;
  } });
  input.write(JSON.stringify({ id: "prep", type: "prepare_entry_index", token: "shutdown" }) + "\n");
  await until(() => f.calls.length === 1);
  input.write(JSON.stringify({ id: "shutdown", type: "prompt", message: "shutdown" }) + "\n");
  await run; assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.closed(), true);
  f.gates[0].resolve(true); input.destroy();
});


test("entry-index shutdown exclusion retains the drain for ordinary RPC requests", async t => {
  const f = await fixture(t), input = new PassThrough(), output = new PassThrough(); output.resume();
  const ordinary = Promise.withResolvers(); let ordinaryEntered = false;
  f.coordinator.getState = () => { ordinaryEntered = true; return ordinary.promise; };
  const run = runSDKWorkerRpc({ input, output, installSignalHandlers: false, bootstrap: async ({ lifecycle }) => {
    f.coordinator.submit = async () => { lifecycle.requestShutdown(); return { outcome: "handled" }; }; return f.worker;
  } });
  input.write(JSON.stringify({ id: "prep", type: "prepare_entry_index", token: "ordinary-drain" }) + "\n");
  await until(() => f.calls.length === 1);
  input.write(JSON.stringify({ id: "ordinary", type: "get_state" }) + "\n"); await until(() => ordinaryEntered);
  input.write(JSON.stringify({ id: "shutdown", type: "prompt", message: "shutdown" }) + "\n");
  await tick(); await tick(); assert.equal(f.closed(), false, "normal RPC ownership still blocks the drain");
  ordinary.resolve({ isStreaming: false }); await run;
  assert.equal(f.closed(), true); assert.equal(f.calls[0].signal.aborted, true);
  f.gates[0].resolve(false); input.destroy();
});

function collector(gc) {
  return eligible => reduceIdleMemory(eligible, { gc,
    memoryUsage: () => ({ rss: IDLE_MEMORY_GAP_BYTES + 100, heapTotal: 80, external: 20 }) });
}

test("idle-memory worker independently excludes busy, pending and index preparation", async t => {
  let calls = 0;
  const f = await fixture(t, { reduceMemory: collector(async () => { calls++; }) });
  for (const [owner, key, value] of [[f.coordinator,"isBusy",true], [f.session,"isIdle",false],
    [f.session,"pendingMessageCount",1], [f.coordinator,"pendingMessageCount",1]]) {
    const previous = owner[key]; owner[key] = value;
    assert.equal(await f.worker.handle({ type: "reduce_idle_memory", token: "blocked" }), false);
    owner[key] = previous;
  }
  const prep = f.worker.handle({ type: "prepare_entry_index", token: "held-index" });
  await until(() => f.calls.length === 1);
  assert.equal(await f.worker.handle({ type: "reduce_idle_memory", token: "index" }), false);
  f.gates[0].resolve(true); await prep;
  const pending = f.worker.handle({ type: "reduce_idle_memory", token: "late-busy" });
  f.coordinator.isBusy = true; assert.equal(await pending, false); f.coordinator.isBusy = false;
  assert.equal(calls, 0);
});

test("idle-memory token and new input cancel before invocation without changing retained aliases", async t => {
  let calls = 0;
  const f = await fixture(t, { reduceMemory: collector(async () => { calls++; }) });
  const retained = { value: "public state" }; f.session.retained = retained; const alias = f.session.retained;
  const first = f.worker.handle({ type: "reduce_idle_memory", token: "old" });
  assert.equal(await f.worker.handle({ type: "cancel_idle_memory", token: "foreign" }), false);
  assert.equal(await f.worker.handle({ type: "cancel_idle_memory", token: "old" }), true);
  assert.equal(await first, false);
  const second = f.worker.handle({ type: "reduce_idle_memory", token: "new" });
  assert.equal(await f.worker.handle({ type: "cancel_idle_memory", token: "old" }), false);
  assert.deepEqual(await f.worker.handle({ type: "prompt", message: "continue" }), { outcome: "accepted" });
  assert.equal(await second, false); assert.equal(calls, 0);
  assert.equal(await f.worker.handle({ type: "reduce_idle_memory", token: "finish" }), true);
  assert.equal(calls, 1); assert.equal(f.session.retained, alias); assert.equal(alias.value, "public state");
});

test("started idle GC leaves prompt, ordinary RPC drain and extension shutdown independent", async t => {
  const gc = Promise.withResolvers(), ordinary = Promise.withResolvers(); let entered = false, ordinaryEntered = false;
  t.after(() => { gc.resolve(); ordinary.resolve({}); });
  const f = await fixture(t, { reduceMemory: collector(() => { entered = true; return gc.promise; }) });
  const input = new PassThrough(), output = new PassThrough(), frames = [];
  output.on("data", chunk => { for (const line of chunk.toString().trim().split("\n")) frames.push(JSON.parse(line)); });
  f.coordinator.getState = () => { ordinaryEntered = true; return ordinary.promise; };
  const run = runSDKWorkerRpc({ input, output, installSignalHandlers: false, bootstrap: async ({ lifecycle }) => {
    f.coordinator.submit = async () => { lifecycle.requestShutdown(); return { outcome: "handled" }; }; return f.worker;
  } });
  input.write(JSON.stringify({ id: "gc", type: "reduce_idle_memory", token: "running" }) + "\n");
  await until(() => entered);
  input.write(JSON.stringify({ id: "ordinary", type: "get_state" }) + "\n");
  await until(() => ordinaryEntered);
  input.write(JSON.stringify({ id: "prompt", type: "prompt", message: "shutdown" }) + "\n");
  await until(() => frames.some(frame => frame.id === "prompt"));
  assert.equal(f.closed(), false, "ordinary work retains the existing shutdown drain");
  ordinary.resolve({ isStreaming: false }); await run;
  assert.equal(f.closed(), true); assert.equal(frames.some(frame => frame.id === "gc"), false);
  gc.resolve(); await tick(); assert.equal(frames.some(frame => frame.id === "gc"), false, "late optional response stays suppressed");
  input.destroy();
});
