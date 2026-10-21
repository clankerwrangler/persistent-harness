import assert from "node:assert/strict";
import test from "node:test";
import { reduceIdleMemory, IDLE_MEMORY_GAP_BYTES } from "../src/idle-memory.mjs";

const sample = gap => () => ({ rss: gap + 100, heapTotal: 80, external: 20 });

test("idle reduction requires the fixed substantial numeric gap and an available collector", async () => {
  const calls = [];
  const gc = async options => { calls.push(options); };
  for (const gap of [0, IDLE_MEMORY_GAP_BYTES - 1]) {
    assert.equal(await reduceIdleMemory(() => true, { gc, memoryUsage: sample(gap) }), false);
  }
  for (const value of [NaN, Infinity, -1, undefined]) {
    assert.equal(await reduceIdleMemory(() => true, { gc, memoryUsage: () => ({ rss: value, heapTotal: 0, external: 0 }) }), false);
  }
  assert.equal(await reduceIdleMemory(() => true, { gc: null, memoryUsage: sample(IDLE_MEMORY_GAP_BYTES) }), false);
  assert.equal(calls.length, 0);
  assert.equal(await reduceIdleMemory(() => true, { gc, memoryUsage: sample(IDLE_MEMORY_GAP_BYTES) }), true);
  assert.deepEqual(calls, [{ type: "major", execution: "async", flavor: "last-resort" }]);
});

test("idle reduction rechecks eligibility at its deferred boundary and awaits the actual collector", async () => {
  let eligible = true, calls = 0;
  const gate = Promise.withResolvers();
  const options = { gc: () => { calls++; return gate.promise; }, memoryUsage: sample(IDLE_MEMORY_GAP_BYTES) };
  const cancelled = reduceIdleMemory(() => eligible, options);
  eligible = false;
  assert.equal(await cancelled, false); assert.equal(calls, 0);
  eligible = true;
  let returned = false;
  const active = reduceIdleMemory(() => eligible, options).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(returned, false);
  gate.resolve(); assert.equal(await active, true);
});

test("idle reduction failures remain failures, not a successful release result", async () => {
  await assert.rejects(reduceIdleMemory(() => true, {
    gc: async () => { throw new Error("synthetic collector failure"); }, memoryUsage: sample(IDLE_MEMORY_GAP_BYTES),
  }), /synthetic collector failure/);
});
