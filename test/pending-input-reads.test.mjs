import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HarnessStore } from "../src/store.mjs";

const image = { type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCwAAAABJRU5ErkJggg==" };
const location = { latitude: 12, longitude: -76, accuracy: 8.5, timestamp: 1700000000123 };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pending-input-reads-"));
  const databasePath = path.join(directory, "store.sqlite");
  const store = new HarnessStore(databasePath);
  const raw = new DatabaseSync(databasePath);
  t.after(async () => { raw.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const sessionId of ["root", "other"]) store.createRoot({ sessionId, cwd: directory,
    name: sessionId, actorToken: "synthetic-owner", launch: {} }, 1);
  const inputs = [
    { inputId: "z-first", message: " exact user text\n", images: [image], location, clientMessageId: "browser",
      retryIntent: { targetId: "old-answer", mode: "explicit" } },
    { inputId: "a-second", message: "scheduled", source: "cron", origin: { jobId: "job", runId: "run" } },
    { inputId: "m-third", message: "completed job", source: "background", origin: { jobId: "background" }, behavior: "follow_up" },
    { inputId: "legacy", message: "legacy" },
  ];
  for (const input of inputs) store.createActorInput("root", input, 10);
  store.markActorInputAccepted("z-first", "root", 2, 20);
  store.createActorInput("other", { inputId: "unrelated", message: "other session" }, 10);
  for (const inputId of ["completed", "handled"]) store.createActorInput("root", { inputId, message: inputId }, 10);
  store.completeActorInput("completed", "root", 30, "canonical-entry");
  store.markActorInputHandled("handled", "root", 30);
  raw.exec(`UPDATE actor_input_receipts SET source = NULL, origin_json = NULL, client_message_id = NULL WHERE id = 'legacy';
    UPDATE actor_inputs SET created_at = 9999 WHERE id = 'z-first';
    CREATE TABLE wake_updates (input_id TEXT);
    CREATE TRIGGER count_wake_update AFTER UPDATE OF wake_error_generation ON actor_inputs
      BEGIN INSERT INTO wake_updates VALUES (NEW.id); END;`);
  const payloads = new Set([JSON.stringify([]), JSON.stringify([image]), JSON.stringify(location)]);
  const updates = () => Number(raw.prepare("SELECT count(*) AS count FROM wake_updates").get().count);
  return { store, raw, databasePath, inputs, payloads, updates };
}

// Instrument only synchronous fixture calls; no production or unrelated state is read.
function measure(payloads, operation) {
  const prepare = DatabaseSync.prototype.prepare, parse = JSON.parse;
  let queries = 0, payloadParses = 0, payloadBytes = 0;
  DatabaseSync.prototype.prepare = function (...args) { queries += 1; return prepare.apply(this, args); };
  JSON.parse = function (value, ...args) {
    if (payloads.has(value)) { payloadParses += 1; payloadBytes += Buffer.byteLength(value); }
    return parse.call(this, value, ...args);
  };
  try { return { value: operation(), work: () => ({ queries, payloadParses, payloadBytes }) }; }
  finally { DatabaseSync.prototype.prepare = prepare; JSON.parse = parse; }
}

test("one joined pending read preserves ordered per-ID receipt and payload values", async (t) => {
  const { store, inputs, payloads } = await fixture(t);
  const expected = inputs.map(({ inputId }) => store.getActorInput(inputId, "root"));
  const observed = measure(payloads, () => store.listPendingActorInputs("root"));
  assert.deepEqual(observed.value, expected);
  assert.deepEqual(observed.value.map(input => input.inputId), ["z-first", "a-second", "m-third", "legacy"]);
  assert.equal(observed.value[0].createdAt, 10, "acceptance belongs to the receipt, not the pending payload");
  assert.equal(observed.value[0].transportAcceptedAt, 20); assert.equal(observed.value[0].acceptedGeneration, 2);
  assert.equal(Object.hasOwn(observed.value[0], "digest"), false);
  const expectedBytes = inputs.reduce((sum, input) => sum + Buffer.byteLength(JSON.stringify(input.images ?? []))
    + (input.location ? Buffer.byteLength(JSON.stringify(input.location)) : 0), 0);
  assert.deepEqual(observed.work(), { queries: 1, payloadParses: inputs.length + 1, payloadBytes: expectedBytes });
  observed.value[0].images[0].data = "changed caller value"; observed.value[0].location.latitude = 90;
  assert.deepEqual(store.getActorInput("z-first", "root"), expected[0], "joined results remain independent snapshots");
  assert.equal(store.getActorInput("completed", "root").entryId, "canonical-entry");
  assert.equal(store.getActorInput("handled", "root").outcome, "handled");
  t.diagnostic(`pending list: ${JSON.stringify(observed.work())}`);
});

test("existence and no-op wake clearing do not hydrate pending payloads", async (t) => {
  const { store, payloads, updates } = await fixture(t);
  for (const [sessionId, expected] of [["root", true], ["other", true], ["missing", false]]) {
    const observed = measure(payloads, () => store.hasPendingActorInputs(sessionId));
    assert.equal(observed.value, expected);
    assert.deepEqual(observed.work(), { queries: 1, payloadParses: 0, payloadBytes: 0 });
  }
  const cleared = measure(payloads, () => store.setActorInputWakeError("root"));
  assert.deepEqual(cleared.value, []);
  assert.deepEqual(cleared.work(), { queries: 1, payloadParses: 0, payloadBytes: 0 });
  assert.equal(updates(), 0, "an already-clear queue performs no row mutation");
  for (const generation of [0, -1, 1.5, NaN, "2"]) {
    assert.throws(() => store.setActorInputWakeError("root", generation), /invalid actor generation/);
  }
});

test("wake failures still publish the full queue on repeats and clear only affected inputs", async (t) => {
  const { store, raw, inputs, payloads, updates } = await fixture(t);
  const failed = measure(payloads, () => store.setActorInputWakeError("root", 3));
  assert.equal(failed.work().queries, 2); assert.equal(failed.work().payloadParses, inputs.length + 1);
  assert.equal(updates(), inputs.length);
  assert(failed.value.every(input => input.delivery.retryableError.generation === 3));
  const repeated = measure(payloads, () => store.setActorInputWakeError("root", 3));
  assert.deepEqual(repeated.value, failed.value, "same-generation publication is preserved");
  assert.equal(repeated.work().queries, 2); assert.equal(repeated.work().payloadParses, inputs.length + 1);
  assert.equal(updates(), inputs.length, "repeat publication does not rewrite unchanged rows");
  assert.equal(store.getActorInput("unrelated", "other").delivery.retryableError, undefined);
  raw.exec("UPDATE actor_inputs SET wake_error_generation = NULL WHERE id IN ('a-second', 'legacy')");
  const beforeClear = updates();
  const cleared = measure(payloads, () => store.setActorInputWakeError("root"));
  assert.deepEqual(cleared.value.map(input => input.inputId), ["z-first", "m-third"]);
  assert.deepEqual(cleared.value, cleared.value.map(input => store.getActorInput(input.inputId, "root")));
  assert(cleared.value.every(input => input.delivery.retryableError === undefined));
  assert.equal(cleared.work().queries, 2); assert.equal(cleared.work().payloadParses, 3);
  assert.equal(updates() - beforeClear, 2);
  const noOp = measure(payloads, () => store.setActorInputWakeError("root"));
  assert.deepEqual(noOp.value, []);
  assert.deepEqual(noOp.work(), { queries: 1, payloadParses: 0, payloadBytes: 0 });
  for (const input of inputs) store.completeActorInput(input.inputId, "root", 40, `entry-${input.inputId}`);
  assert.equal(store.hasPendingActorInputs("root"), false);
  assert.equal(store.hasPendingActorInputs("other"), true);
  assert.deepEqual(store.setActorInputWakeError("root", 4), []);
  t.diagnostic(`affected clear: ${JSON.stringify(cleared.work())}; no-op: ${JSON.stringify(noOp.work())}`);
});

test("a rejected payload releases its joined cursor before later store work", async (t) => {
  const { store, raw } = await fixture(t);
  raw.prepare("UPDATE actor_inputs SET location_json = ? WHERE id = 'z-first'").run("{bad json");
  assert.throws(() => store.listPendingActorInputs("root"), SyntaxError);
  raw.prepare("UPDATE actor_inputs SET location_json = ? WHERE id = 'z-first'").run(JSON.stringify(location));
  assert.deepEqual(store.listPendingActorInputs("root").map(input => input.inputId), ["z-first", "a-second", "m-third", "legacy"]);
  assert.equal(store.createActorInput("root", { inputId: "after-rejection", message: "next" }, 40).state, "queued");
});
