import assert from "node:assert/strict";
import test from "node:test";
import { TurnFailureReporter, normalizeTurnFailure, pendingTurnFailureJournal, TURN_FAILURE_ENTRY_TYPE, TURN_FAILURE_ACCEPTED_TYPE } from "../src/child-turn-failure.mjs";
import { PROTOCOL_VERSION, validateRequest } from "../src/protocol.mjs";

const report = { version: 1, turnId: "turn-1", failureClass: "request_preparation", dispatchBoundary: "before_provider_dispatch" };

test("turn receipt protocol accepts only fixed safe categories and bounded identity", () => {
  assert.deepEqual(normalizeTurnFailure(report), report);
  const frame = value => ({ version: PROTOCOL_VERSION, id: "request", type: "record_actor_turn_failure", params: value });
  assert.deepEqual(validateRequest(frame(report)).params, report);
  for (const patch of [{ error: "SECRET" }, { version: 2 }, { turnId: "private\nvalue" },
    { turnId: "a".repeat(129) }, { failureClass: "SECRET" }, { dispatchBoundary: "certain_success" }]) {
    assert.throws(() => validateRequest(frame({ ...report, ...patch })), /invalid actor turn failure receipt/);
  }
});

test("lost report ACK retries only the durable receipt; restart restores the same report", async t => {
  const requests = [], accepted = new Set(); let fail = true;
  const client = { isConnected: true, async request(type, value) {
    requests.push({ type, value }); accepted.add(value.turnId);
    if (fail) { fail = false; throw new Error("lost ACK"); }
    return { recorded: true };
  } };
  let reporter = new TurnFailureReporter({ client: () => client, retryMs: 5 });
  t.after(() => reporter.close());
  reporter.remember(report); await reporter.flush();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(requests.length, 2); assert.equal(accepted.size, 1); assert.equal(reporter.pending.size, 0);
  reporter.close();
  reporter = new TurnFailureReporter({ client: () => client });
  reporter.remember(JSON.parse(JSON.stringify(report))); await reporter.flush();
  assert.equal(requests.length, 3); assert.equal(accepted.size, 1);
  assert(requests.every(request => request.type === "record_actor_turn_failure"));
  assert(requests.every(request => JSON.stringify(request.value) === JSON.stringify(report)));
  client.isConnected = false;
  reporter.remember({ ...report, turnId: "turn-2" }); await reporter.flush();
  assert.equal(requests.length, 3); assert.equal(reporter.pending.size, 1);
  client.isConnected = true; await reporter.flush();
  assert.equal(requests.length, 4); assert.equal(reporter.pending.size, 0);
});


test("a report arriving as an empty flush completes cannot be stranded", async t => {
  const requests = [], client = { isConnected: true, async request(type, value) {
    requests.push({ type, value }); return { recorded: true };
  } };
  const reporter = new TurnFailureReporter({ client: () => client }); t.after(() => reporter.close());
  const initial = reporter.flush(); reporter.remember(report); await reporter.flush(); await initial;
  assert.equal(requests.length, 1); assert.equal(reporter.pending.size, 0);
});


test("startup reads only the last acceptance witness and unaccepted failure bodies", () => {
  const headers = [], entries = new Map(), reads = [];
  for (let i = 0; i < 1000; i++) {
    const marker = { id: `failure-${i}`, type: "custom", customType: TURN_FAILURE_ENTRY_TYPE, position: headers.length };
    headers.push(marker); entries.set(marker.id, { ...marker, data: { ...report, turnId: `turn-${i}` } });
    const ack = { id: `accepted-${i}`, type: "custom", customType: TURN_FAILURE_ACCEPTED_TYPE, position: headers.length };
    headers.push(ack); entries.set(ack.id, { ...ack, data: { version: 1, entryId: marker.id, position: marker.position } });
  }
  const marker = { id: "pending", type: "custom", customType: TURN_FAILURE_ENTRY_TYPE, position: headers.length };
  headers.push(marker); entries.set(marker.id, { ...marker, data: report });
  const restored = pendingTurnFailureJournal(headers, id => { reads.push(id); return entries.get(id); });
  assert.deepEqual(reads, ["accepted-999", "pending"]);
  assert.equal(restored.acceptedThrough, 1998); assert.equal(restored.pending.length, 1);
  assert.equal(restored.pending[0].journal.entryId, "pending");
});

test("a lost local acceptance witness retries its pending receipt before advancing the frontier", async t => {
  const requests = [], witnesses = []; let fail = true;
  const client = { isConnected: true, async request(_type, value) { requests.push(value.turnId); return { recorded: true }; } };
  const reporter = new TurnFailureReporter({ client: () => client, retryMs: 5,
    async onRecorded(_report, journal) { if (fail) { fail = false; throw new Error("witness append failed"); } witnesses.push(journal); } });
  t.after(() => reporter.close());
  reporter.remember(report, { entryId: "first", position: 3 });
  reporter.remember({ ...report, turnId: "turn-2" }, { entryId: "second", position: 5 });
  await reporter.flush(); assert.equal(reporter.acceptedThrough, -1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(requests, ["turn-1", "turn-1", "turn-2"]);
  assert.deepEqual(witnesses.map(item => item.entryId), ["first", "second"]);
  assert.equal(reporter.acceptedThrough, 5); assert.equal(reporter.pending.size, 0);
  reporter.remember(report, { entryId: "first", position: 3 }); await reporter.flush();
  assert.equal(requests.length, 3, "already witnessed reports are not resent");
});
