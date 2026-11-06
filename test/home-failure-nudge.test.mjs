import assert from "node:assert/strict";
import test from "node:test";
import { HOME_NUDGE_DELAYS_MS, HomeFailureNudge } from "../src/home-failure-nudge.mjs";

const report = (turnId) => ({ version: 1, turnId, failureClass: "turn_failed", dispatchBoundary: "provider_dispatch_unknown" });

test("Home nudge: waits five minutes, then fifteen, thirty and hourly while it keeps failing", () => {
  assert.deepEqual(HOME_NUDGE_DELAYS_MS, [300_000, 900_000, 1_800_000, 3_600_000]);
  const nudge = new HomeFailureNudge();
  let now = 0;
  for (const delay of [...HOME_NUDGE_DELAYS_MS, 3_600_000]) {
    nudge.failed("home", report(`t${now}`), now);
    assert.equal(nudge.due(now + delay - 1), null);
    const due = nudge.due(now + delay);
    assert.equal(due.report.turnId, `t${now}`); assert.equal(due.failedAt, now);
    now += delay; nudge.sent();
    assert.equal(nudge.due(now + 10 * 3_600_000), null, "one nudge per failure");
  }
});

test("Home nudge: a later failure keeps the earlier due time", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100] });
  nudge.failed("home", report("first"), 0);
  nudge.failed("home", report("second"), 90);
  assert.equal(nudge.due(100).report.turnId, "first");
});

test("Home nudge: the failed run's own settle keeps it; a later clean settle cancels it", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100, 500] });
  nudge.failed("home", report("first"), 0);
  nudge.settled();
  assert.equal(nudge.due(100).report.turnId, "first", "the failure was reported before this settle");
  nudge.settled();
  assert.equal(nudge.due(1_000_000), null, "a run with no failure since the last settle succeeded");
  nudge.failed("home", report("second"), 200);
  assert.equal(nudge.due(300).report.turnId, "second", "nothing was sent, so the first delay still applies");
});

test("Home nudge: a report that arrives after its run settled still arms it", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100] });
  nudge.settled();
  nudge.failed("home", report("late"), 50);
  assert.equal(nudge.due(150).report.turnId, "late");
  nudge.settled();
  assert.equal(nudge.due(150).report.turnId, "late", "the next settle counts the late failure as its own and keeps it");
});

test("Home nudge: dropped clears it without counting a send", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100, 500] });
  nudge.failed("home", report("a"), 0); nudge.dropped();
  assert.equal(nudge.due(1_000_000), null);
  nudge.failed("home", report("b"), 10);
  assert.equal(nudge.due(110).report.turnId, "b");
});

test("Home nudge: a quiet gap starts a new incident at the first delay", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100, 500], incidentGapMs: 1_000 });
  nudge.failed("home", report("a"), 0); nudge.sent();
  nudge.failed("home", report("b"), 900);
  assert.equal(nudge.due(1_399), null); assert.equal(nudge.due(1_400).report.turnId, "b");
  nudge.sent();
  nudge.failed("home", report("c"), 2_401);
  assert.equal(nudge.due(2_501).report.turnId, "c");
});

test("Home nudge: a new Home replaces a pending nudge for the old one", () => {
  const nudge = new HomeFailureNudge({ delaysMs: [100] });
  nudge.failed("old", report("a"), 0);
  nudge.failed("new", report("b"), 50);
  assert.equal(nudge.due(150).homeId, "new");
});

test("Home nudge: rejects invalid delays", () => {
  for (const delaysMs of [[], [-1], [1.5], "5"]) assert.throws(() => new HomeFailureNudge({ delaysMs }), /non-negative integers/);
});
