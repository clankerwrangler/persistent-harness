import assert from "node:assert/strict";
import test from "node:test";
import { LEAD_NUDGE_DELAYS_MS, LeadFailureNudge } from "../src/lead-failure-nudge.mjs";

const report = (turnId) => ({ version: 1, turnId, failureClass: "turn_failed", dispatchBoundary: "provider_dispatch_unknown" });

test("Lead nudge: waits five minutes, then fifteen, thirty and hourly while it keeps failing", () => {
  assert.deepEqual(LEAD_NUDGE_DELAYS_MS, [300_000, 900_000, 1_800_000, 3_600_000]);
  const nudge = new LeadFailureNudge();
  let now = 0;
  for (const delay of [...LEAD_NUDGE_DELAYS_MS, 3_600_000]) {
    nudge.failed("lead", report(`t${now}`), now);
    assert.equal(nudge.due(now + delay - 1), null);
    const due = nudge.due(now + delay);
    assert.equal(due.report.turnId, `t${now}`); assert.equal(due.failedAt, now);
    now += delay; nudge.sent();
    assert.equal(nudge.due(now + 10 * 3_600_000), null, "one nudge per failure");
  }
});

test("Lead nudge: a later failure keeps the earlier due time", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100] });
  nudge.failed("lead", report("first"), 0);
  nudge.failed("lead", report("second"), 90);
  assert.equal(nudge.due(100).report.turnId, "first");
});

test("Lead nudge: the failed run's own settle keeps it; a later clean settle cancels it", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100, 500] });
  nudge.failed("lead", report("first"), 0);
  nudge.settled();
  assert.equal(nudge.due(100).report.turnId, "first", "the failure was reported before this settle");
  nudge.settled();
  assert.equal(nudge.due(1_000_000), null, "a run with no failure since the last settle succeeded");
  nudge.failed("lead", report("second"), 200);
  assert.equal(nudge.due(300).report.turnId, "second", "nothing was sent, so the first delay still applies");
});

test("Lead nudge: a report that arrives after its run settled still arms it", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100] });
  nudge.settled();
  nudge.failed("lead", report("late"), 50);
  assert.equal(nudge.due(150).report.turnId, "late");
  nudge.settled();
  assert.equal(nudge.due(150).report.turnId, "late", "the next settle counts the late failure as its own and keeps it");
});

test("Lead nudge: dropped clears it without counting a send", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100, 500] });
  nudge.failed("lead", report("a"), 0); nudge.dropped();
  assert.equal(nudge.due(1_000_000), null);
  nudge.failed("lead", report("b"), 10);
  assert.equal(nudge.due(110).report.turnId, "b");
});

test("Lead nudge: a quiet gap starts a new incident at the first delay", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100, 500], incidentGapMs: 1_000 });
  nudge.failed("lead", report("a"), 0); nudge.sent();
  nudge.failed("lead", report("b"), 900);
  assert.equal(nudge.due(1_399), null); assert.equal(nudge.due(1_400).report.turnId, "b");
  nudge.sent();
  nudge.failed("lead", report("c"), 2_401);
  assert.equal(nudge.due(2_501).report.turnId, "c");
});

test("Lead nudge: a new Lead replaces a pending nudge for the old one", () => {
  const nudge = new LeadFailureNudge({ delaysMs: [100] });
  nudge.failed("old", report("a"), 0);
  nudge.failed("new", report("b"), 50);
  assert.equal(nudge.due(150).leadId, "new");
});

test("Lead nudge: rejects invalid delays", () => {
  for (const delaysMs of [[], [-1], [1.5], "5"]) assert.throws(() => new LeadFailureNudge({ delaysMs }), /non-negative integers/);
});
