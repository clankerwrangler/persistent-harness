import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticCompactionPermission, AUTOMATIC_COMPACTION_CHECK as channel } from "../src/automatic-compaction-permission.mjs";
import { loadExternalPi } from "../src/external-pi.mjs";
const { sdk } = await loadExternalPi();

test("synchronous permission composes vetoes, isolates queries and ignores async callbacks", async () => {
  assert.equal(createAutomaticCompactionPermission()("threshold", 272000), true);
  const bus = sdk.createEventBus(), other = sdk.createEventBus();
  const check = createAutomaticCompactionPermission(bus);
  assert.equal(check("threshold", 272000), true);
  let previous, seen;
  const off = bus.on(channel, request => {
    assert(Object.isFrozen(request));
    assert.deepEqual(Object.keys(request), ["version", "reason", "contextWindow", "veto"]);
    assert.equal(request.version, 1); seen = request;
    previous = request.veto; request.veto(); request.veto();
  });
  bus.on(channel, () => true); // Returning allow cannot undo another listener's veto.
  assert.equal(check("threshold", 272000), false);
  assert.equal(seen.reason, "threshold"); assert.equal(seen.contextWindow, 272000);
  assert.equal(createAutomaticCompactionPermission(other)("threshold", 272000), true);
  off();
  bus.on(channel, async request => { await Promise.resolve(); request.veto(); });
  bus.on(channel, () => previous());
  assert.equal(check("overflow", 32000), true);
  await Promise.resolve();
  assert.equal(check("threshold", 64000), true);
});

test("a throwing emitter closes the veto fence in finally", () => {
  let late, calls = 0;
  const error = new Error("emitter failed");
  const check = createAutomaticCompactionPermission({ emit(_channel, request) {
    if (calls++ === 0) { late = request.veto; throw error; }
    late();
  } });
  assert.throws(() => check("threshold", 1), e => e === error);
  assert.equal(check("threshold", {}), true);
});
