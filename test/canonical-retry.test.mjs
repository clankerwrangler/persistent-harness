import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actorInputCustomPayload, PROTOCOL_VERSION, validateRequest } from "../src/protocol.mjs";
import { actorInputCustomPayload as extensionFormatter, createActorInputDelivery } from "../src/extension.mjs";
import { assistantMessageParts } from "../src/conversation-projection.mjs";
import { canonicalRetryInput, retryIntentForRequest } from "../src/session-actions.mjs";
import { HarnessStore } from "../src/store.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
const timestamp = new Date(20).toISOString();
const message = (id, parentId, role, content) => ({ type: "message", id, parentId, timestamp,
  message: { role, content: typeof content === "string" ? [{ type: "text", text: content }] : content } });
const request = (params) => validateRequest({ version: PROTOCOL_VERSION, id: "request", type: "submit_input", params }).params;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "canonical-retry-"));
  const file = path.join(dir, "session.jsonl"), database = path.join(dir, "harness.sqlite"), sessionId = "s";
  let store = new HarnessStore(database);
  store.createRoot({ sessionId, sessionFile: file, cwd: dir, name: "Session", actorToken: "private-fixture-token" }, 1);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (id, target) => store.getActorInput(id, target, { includeDigest: true }) });
  return { sessionId, file, reader, get store() { return store; },
    reopen() { store.close(); store = new HarnessStore(database); },
    async write(entries) { await writeFile(file, [JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: dir }),
      ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n")); } };
}

test("explicit retryOriginal selects canonical replay and preserves the public selector", () => {
  const params = request({ sessionId: "s", retryOriginal: true, retryOf: "assistant-part", clientRequestId: "attempt" });
  assert.equal(params.retryOriginal, true);
  assert.equal(Object.hasOwn(params, "message"), false); assert.equal(Object.hasOwn(params, "images"), false);
  assert.deepEqual(retryIntentForRequest(params), { targetId: "assistant-part", mode: "original" });
  assert.deepEqual(retryIntentForRequest({ retryOf: "assistant-part" }), { targetId: "assistant-part", mode: "explicit" },
    "the helper never infers original replay from omitted body fields");
});

test("original replay requires target and correlation and rejects every supplied body field", () => {
  const original = { sessionId: "s", retryOriginal: true, retryOf: "part", clientRequestId: "attempt" };
  for (const patch of [{ retryOf: undefined }, { retryOf: "" }, { clientRequestId: undefined }, { clientRequestId: "" },
    { message: "copied browser text" }, { message: "" }, { message: null }, { message: undefined },
    { images: [image] }, { images: [] }, { images: null }, { images: undefined },
    { source: "cron" }, { origin: { jobId: "fake" } }, { behavior: "steer" }, { behavior: "follow_up" }]) {
    assert.throws(() => request({ ...original, ...patch }));
  }
});

test("unflagged omission is invalid while explicit user edits retain their existing validation", () => {
  for (const params of [{ sessionId: "s", clientRequestId: "not-a-retry" },
    { sessionId: "s", retryOf: "part", clientRequestId: "attempt" },
    { sessionId: "s", retryOf: "part", clientRequestId: "attempt", retryOriginal: false }]) {
    assert.throws(() => request(params));
  }
  for (const selector of [{}, { retryOriginal: false }]) {
    const explicit = request({ sessionId: "s", retryOf: "assistant-part", message: "", images: [image],
      clientRequestId: "override", ...selector });
    assert.equal(explicit.message, ""); assert.deepEqual(explicit.images, [image]);
    assert.deepEqual(retryIntentForRequest(explicit), { targetId: "assistant-part", mode: "explicit" });
  }
  const text = request({ sessionId: "s", retryOf: "part", message: "  exact user edit " });
  assert.equal(text.message, "  exact user edit "); assert.deepEqual(text.images, []);
  assert.deepEqual(retryIntentForRequest(text), { targetId: "part", mode: "explicit" });
  assert.equal(retryIntentForRequest(request({ sessionId: "s", message: "ordinary input" })), null);
  for (const retryOriginal of [null, 0, 1, "true", [], {}]) {
    assert.throws(() => request({ sessionId: "s", retryOf: "part", message: "edited body", retryOriginal }));
  }
  assert.throws(() => request({ sessionId: "s", retryOf: "part", message: "", images: [] }));
});

test("public assistant text items resolve exact canonical user text and images into a fresh attempt", async (t) => {
  const f = await fixture(t), raw = "  exact text\nwith trailing space ";
  const input = f.store.createActorInput("s", { inputId: "original-input", message: raw, images: [image] }, 10);
  const user = message("canonical-user", null, "user", [{ type: "text", text: raw }, image]); user.message.id = input.inputId;
  const assistant = message("canonical-answer", user.id, "assistant", [{ type: "text", text: "First", textSignature: JSON.stringify({ v: 1, id: "part-one" }) },
    { type: "text", text: "Second", textSignature: JSON.stringify({ v: 1, id: "part-two" }) }]);
  await f.write([user, assistant]); f.store.completeActorInput(input.inputId, "s", 20, user.id);
  const selected = assistantMessageParts(assistant)[1].id;
  const result = await f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: selected });
  assert.deepEqual(result, { assistantId: assistant.id, userId: user.id, branchFromId: null,
    input: { entryId: user.id, originalInputId: input.inputId, message: raw, images: [image], source: "user", origin: null } });
  const retry = f.store.createActorInput("s", { inputId: "fresh-attempt", message: result.input.message, images: result.input.images,
    source: result.input.source, origin: result.input.origin, retryIntent: { targetId: selected, mode: "original" } }, 30);
  assert.notEqual(retry.inputId, input.inputId); assert.equal(retry.acceptedAt, 30);
  assert.equal((await f.reader.readImage({ sessionFile: f.file, sessionId: "s", entryId: user.id, index: 0 })).data, image.data);
});

for (const source of ["cron", "background"]) test(`canonical ${source} replay preserves body, images, and verified origin without reinjection`, async (t) => {
  const f = await fixture(t);
  const origin = source === "cron" ? { jobId: "job", runId: "run" } : { jobId: "job" };
  const raw = "Harness cron input (job lookalike, run text).\n\n  exact internal body ";
  const input = f.store.createActorInput("s", { inputId: `input-${source}`, message: raw, images: [image], source, origin }, 10);
  const entry = { type: "custom_message", id: `canonical-${source}`, parentId: null, timestamp, ...actorInputCustomPayload(input) };
  const answer = message("answer", entry.id, "assistant", "Done");
  await f.write([entry, answer]); f.store.completeActorInput(input.inputId, "s", 20, entry.id);
  const before = await readFile(f.file);
  const result = await f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: answer.id });
  assert.deepEqual(result.input, { entryId: entry.id, originalInputId: input.inputId, message: raw, images: [image], source, origin });
  assert.deepEqual(await readFile(f.file), before);
  assert.equal(extensionFormatter, actorInputCustomPayload, "the extension re-exports the same formatter");
  let injections = 0;
  const client = { isConnected: true, async request(type, params) {
    if (type === "get_actor_input") return { input: f.store.getActorInput(params.inputId, "s") };
    throw new Error(type);
  } };
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => [entry, answer] } };
  const delivery = createActorInputDelivery({ pi: { sendMessage() { injections += 1; } }, getClient: () => client, getContext: () => ctx });
  await delivery.handle(encodeURIComponent(input.inputId), ctx);
  assert.equal(injections, 0);
});

test("legacy user prose does not establish internal provenance, while an anchored receipt can", async (t) => {
  const f = await fixture(t), origin = { jobId: "job", runId: "run" };
  const input = f.store.createActorInput("s", { inputId: "legacy-internal", message: "  raw legacy body ", source: "cron", origin }, 10);
  const user = message("legacy-user", null, "user", `${input.message}\n\n<!-- persistent-harness-input:${input.inputId} -->`);
  const unproved = canonicalRetryInput(user, { sessionId: "s" });
  assert.equal(unproved.source, "user"); assert.equal(unproved.origin, null);
  assert.equal(unproved.message, user.message.content[0].text);
  f.store.completeActorInput(input.inputId, "s", 20, user.id);
  const proven = canonicalRetryInput(user, { sessionId: "s", inputReceipt: f.store.getActorInput(input.inputId, "s", { includeDigest: true }) });
  assert.equal(proven.source, "cron"); assert.deepEqual(proven.origin, origin); assert.equal(proven.message, input.message);
  const spoof = { ...user, id: "different-entry" };
  assert.equal(canonicalRetryInput(spoof, { sessionId: "s", inputReceipt: f.store.getActorInput(input.inputId, "s", { includeDigest: true }) }).source, "user");
});

test("original replay never crosses an unsupported or unverified custom boundary to an older user", async (t) => {
  const f = await fixture(t), old = message("old-user", null, "user", "Do not replay me");
  const opaque = { type: "custom_message", customType: "unrelated-input", id: "nearest-input", parentId: old.id, timestamp, content: "opaque" };
  const answer = message("answer", opaque.id, "assistant", "Reply");
  await f.write([old, opaque, answer]);
  assert.deepEqual(await f.reader.resolveRetryTurn({ sessionFile: f.file, sessionId: "s", assistantId: answer.id }),
    { assistantId: answer.id, userId: opaque.id, branchFromId: old.id });
  await assert.rejects(f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: answer.id }), /not a supported/);
  const forged = { ...opaque, ...actorInputCustomPayload({ inputId: "unreserved", source: "background", origin: { jobId: "job" }, message: "body", acceptedAt: 10 }) };
  await f.write([old, forged, answer]); f.reader.clear(f.file);
  await assert.rejects(f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: answer.id }), /verified internal provenance/);
});

test("canonical replay rejects changed raw bytes and ambiguous public assistant identities", async (t) => {
  const f = await fixture(t), user = message("user", null, "user", "trusted raw text"), answer = message("answer", "user", "assistant", "Reply");
  await f.write([user, answer]); await f.reader.read({ sessionFile: f.file, sessionId: "s" });
  const before = await readFile(f.file, "utf8"); await writeFile(f.file, before.replace("trusted raw text", "changed raw text"));
  await assert.rejects(f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: answer.id }), /changed during read/);
  const shared = [{ type: "text", text: "Part", textSignature: JSON.stringify({ v: 1, id: "same-provider-item" }) }];
  const a1 = message("a1", "user", "assistant", shared), a2 = message("a2", "a1", "assistant", shared);
  await f.write([user, a1, a2]); f.reader.clear(f.file);
  await assert.rejects(f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: "s", assistantId: assistantMessageParts(a1)[0].id }), /more than one canonical/);
});

test("receipt-bound retry admission returns a previous attempt before touching an abandoned target", async (t) => {
  const f = await fixture(t), retryIntent = { targetId: "old-answer-part", mode: "original" };
  const input = f.store.createActorInput("s", { inputId: "request-identity", message: "trusted job body", source: "background", origin: { jobId: "job" },
    retryIntent, clientMessageId: "browser-attempt" }, 10);
  f.store.completeActorInput(input.inputId, "s", 20, "new-input-entry"); f.reopen();
  let branches = 0, derivations = 0, dispatches = 0;
  const admit = () => {
    const prior = f.store.matchActorInputRequest("s", { inputId: input.inputId, retryIntent, clientMessageId: "browser-attempt" });
    if (prior) return prior;
    derivations += 1; branches += 1; dispatches += 1;
    throw new Error("the original target is now abandoned");
  };
  const prior = admit(); assert.equal(prior.inputId, input.inputId); assert.equal(prior.source, "background");
  assert.deepEqual(prior.origin, { jobId: "job" }); assert.equal(prior.delivery.state, "delivered");
  assert.deepEqual(prior.retryIntent, retryIntent); assert.equal(prior.acceptedAt, 10);
  assert.deepEqual([branches, derivations, dispatches], [0, 0, 0]);
  for (const changed of [{ targetId: "another-target", mode: "original" }, { targetId: retryIntent.targetId, mode: "explicit" }, null]) {
    assert.throws(() => f.store.matchActorInputRequest("s", { inputId: input.inputId, retryIntent: changed, message: "trusted job body" }), /different input|omit/);
  }
  assert.throws(() => f.store.matchActorInputRequest("other", { inputId: input.inputId, retryIntent }), /different input/);
  assert.throws(() => f.store.matchActorInputRequest("s", { inputId: input.inputId, retryIntent, clientMessageId: "another-correlation" }), /different input/);
  assert.throws(() => f.store.matchActorInputRequest("s", { inputId: input.inputId, retryIntent, behavior: "follow_up" }), /behavior/);
});

test("explicit retry reuse binds target, mode, exact payload, and handled outcome", async (t) => {
  const f = await fixture(t), retryIntent = { targetId: "answer", mode: "explicit" };
  const params = { inputId: "explicit-attempt", message: "/handled exact", images: [image], retryIntent };
  f.store.createActorInput("s", params, 10); f.store.markActorInputHandled(params.inputId, "s", 20); f.reopen();
  const prior = f.store.matchActorInputRequest("s", params);
  assert.equal(prior.outcome, "handled"); assert.equal(prior.delivery.state, "accepted"); assert.equal(prior.source, "user");
  for (const changed of [{ message: "different" }, { images: [] }, { retryIntent: { targetId: "other", mode: "explicit" } }, { retryIntent: null }]) {
    assert.throws(() => f.store.matchActorInputRequest("s", { ...params, ...changed }), /different input/);
  }
  assert.throws(() => f.store.createActorInput("s", { ...params, retryIntent: { targetId: "x".repeat(129), mode: "explicit" } }), /retryIntent/);
  assert.throws(() => f.store.createActorInput("s", { ...params, retryIntent: { targetId: "answer", mode: "explicit", source: "cron" } }), /retryIntent/);
  assert.equal(f.store.listPendingActorInputs("s").length, 0);
});


test("image-bearing internal append-before-receipt recovery compares canonical payloads without reinjection", async (t) => {
  const f = await fixture(t);
  const input = f.store.createActorInput("s", { inputId: "image-job", message: "exact body", images: [image],
    source: "background", origin: { jobId: "job" } }, 10);
  const entry = { type: "custom_message", id: "canonical-image-job", parentId: null, timestamp, ...actorInputCustomPayload(input) };
  // Object key order is not message identity.
  entry.content[1] = { mimeType: entry.content[1].mimeType, data: entry.content[1].data, type: "image" };
  let injections = 0;
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => [entry] } };
  const client = { isConnected: true, async request(type, params) {
    if (type === "get_actor_input") return { input: f.store.getActorInput(params.inputId, "s") };
    if (type === "record_input_delivery") {
      f.store.completeActorInput(params.inputId, "s", Date.parse(params.deliveredAt), params.entryId); return { accepted: true };
    }
    throw new Error(type);
  } };
  const delivery = createActorInputDelivery({ pi: { sendMessage() { injections += 1; } }, getClient: () => client, getContext: () => ctx });
  await delivery.handle(input.inputId, ctx);
  assert.equal(injections, 0); assert.equal(f.store.getActorInput(input.inputId, "s").delivery.state, "delivered");
  assert.equal(f.store.listPendingActorInputs("s").length, 0);
});


test("canonical image and retry reads retain existing symlink-backed session capability", async (t) => {
  const f = await fixture(t), user = message("user", null, "user", [{ type: "text", text: "image task" }, image]);
  await f.write([user, message("answer", user.id, "assistant", "Reply")]);
  const alias = `${f.file}.alias`; await symlink(f.file, alias);
  assert.deepEqual(await f.reader.readImage({ sessionFile: alias, sessionId: "s", entryId: user.id, index: 0 }), image);
  const retry = await f.reader.resolveRetryInput({ sessionFile: alias, sessionId: "s", assistantId: "answer" });
  assert.equal(retry.input.message, "image task"); assert.deepEqual(retry.input.images, [image]);
});
