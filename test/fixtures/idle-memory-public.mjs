import assert from "node:assert/strict";
import v8 from "node:v8";
import { performance } from "node:perf_hooks";
import { reduceIdleMemory, IDLE_MEMORY_GAP_BYTES } from "../../src/idle-memory.mjs";
import { projectCanonicalBranch } from "../../src/canonical-context.mjs";

assert.equal(typeof globalThis.gc, "function", "launch the disposable fixture with --expose-gc");
const entries = Array.from({ length: 192 }, (_, i) => ({ type: "message", id: `e${i}`,
  parentId: i ? `e${i-1}` : null, timestamp: "2026-01-01T00:00:00Z",
  message: { role: "user", timestamp: i, content: [{ type: "text", text: `public-${i}-` + "c".repeat(1024) }] } }));
const input = { entries, leafId: "e191" }, alias = entries[0].message;
const retained = projectCanonicalBranch(input), retainedAlias = retained.entries[0].message;
assert.notEqual(retainedAlias, alias, "real harness projection retains detached values");
function project() {
  const view = projectCanonicalBranch(input);
  assert.equal(view.entries.length, 192);
  assert.equal(view.entries[0].message.content[0].text, alias.content[0].text);
  return view.entries.length;
}
function bench() {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now(), cpu = process.cpuUsage(); let result = 0;
    for (let i = 0; i < 5; i++) result += project();
    const usage = process.cpuUsage(cpu);
    samples.push({ wallMs: performance.now()-start, cpuMs: (usage.user+usage.system)/1000, result });
  }
  return samples;
}
function allocate() {
  const held = [];
  for (let batch = 0; batch < 144; batch++) {
    const rows = Array.from({ length: 512 }, (_, i) => ({ id: batch*512+i,
      text: `public-row-${batch}-${i}-` + "x".repeat(752), rank: i, valid: true }));
    held.push(JSON.parse(JSON.stringify(rows)));
    if (batch%12 === 0) assert(process.memoryUsage().heapUsed < 160*1024*1024, "public fixture allocation budget");
  }
  return held;
}
const snapshot = () => ({ ...process.memoryUsage(), physical: v8.getHeapStatistics().total_physical_size });
for (let i = 0; i < 20; i++) project();
const beforeUse = bench();
let held = allocate();
gc(); assert.equal(held[100][100].id, 51300); held = null;
gc(); gc(); await gc({ type: "major", execution: "async", flavor: "regular" });
const before = snapshot();
// Only eligibility numbers are injected: this <192MiB fixture does not claim to cross the production margin.
// The imported source still invokes and awaits the untouched real globalThis.gc.
const eligibility = { rss: IDLE_MEMORY_GAP_BYTES+100, heapTotal: 80, external: 20 };
const start = performance.now();
const invoked = await reduceIdleMemory(() => true, { memoryUsage: () => eligibility });
const gcMs = performance.now()-start, after = snapshot();
assert.equal(invoked, true);
assert.equal(input.entries, entries); assert.equal(entries[0].message, alias);
assert.equal(retained.entries[0].message, retainedAlias);
assert.equal(retainedAlias.content[0].text, alias.content[0].text);
const afterUse = bench();
assert(before.rss-after.rss > 16*1024*1024, "real reducing GC must release fixture RSS");
console.log("RESULT " + JSON.stringify({ node: process.version, v8: process.versions.v8,
  invoked, eligibilityInjected: true, eligibility, actualGapBefore: before.rss-before.heapTotal-before.external,
  before, after, gcMs, releasedRss: before.rss-after.rss, aliasesRetained: true,
  contextFunction: "projectCanonicalBranch", beforeUse, afterUse }));
