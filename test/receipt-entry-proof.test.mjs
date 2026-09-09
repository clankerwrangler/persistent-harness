import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessStore } from "../src/store.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";
import { normalizeInputImages } from "../src/input-images.mjs";
import { canonicalRetryInput } from "../src/session-actions.mjs";
import { projectVisibleMessage, resolveActorInputAssociation } from "../src/conversation-projection.mjs";
import { createActorInputDelivery } from "../src/extension.mjs";

const acceptedAt = 10, timestamp = new Date(20).toISOString();
const image = normalizeInputImages([{ type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }])[0];
const marker = inputId => `\n\n<!-- persistent-harness-input:${inputId} -->`;
const user = (id, inputId, body, images = []) => ({ type: "message", id, parentId: null, timestamp,
  message: { role: "user", content: [{ type: "text", text: body + marker(inputId) }, ...images] } });

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-entry-proof-"));
  const database = path.join(dir, "harness.sqlite"), sessionFile = path.join(dir, "session.jsonl");
  let store = new HarnessStore(database);
  store.createRoot({ sessionId: "s", sessionFile, cwd: dir, name: "Proof", actorToken: "fixture-only" }, 1);
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (id, sessionId) => store.getActorInput(id, sessionId, { includeDigest: true }) });
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, reader, sessionFile,
    reopen() { store.close(); store = new HarnessStore(database); reader.clear(sessionFile); },
    async read(entries) {
      await writeFile(sessionFile, [ { type: "session", version: 3, id: "s", timestamp, cwd: dir }, ...entries ].map(JSON.stringify).join("\n") + "\n");
      reader.clear(sessionFile);
      return reader.read({ sessionFile, sessionId: "s", publicView: true });
    } };
}
function assertLedger(result, entries) {
  assert.deepEqual(result.inputIds, entries.map(([inputId]) => inputId));
  assert.deepEqual(result.inputEntries, Object.fromEntries(entries.map(([inputId, entry]) => [inputId, entry.id])));
  assert.deepEqual(result.inputDeliveries, Object.fromEntries(entries.map(([inputId, entry]) => [inputId, { entryId: entry.id, deliveredAt: entry.timestamp }])));
  assert.doesNotMatch(JSON.stringify(result), /"digest"/);
}

for (const behavior of ["auto", "steer", "follow_up"]) test(`legacy ${behavior} exact body/image proof survives pending, completion, and reopen`, async (t) => {
  const f = await fixture(t);
  const input = f.store.createActorInput("s", { inputId: behavior, message: " exact\nbody ", images: [image], behavior,
    clientMessageId: "browser" }, acceptedAt);
  const entry = user("entry", input.inputId, input.message, [{ mimeType: image.mimeType, data: image.data, type: "image" }]);
  for (const completed of [false, true]) {
    if (completed) { f.store.completeActorInput(input.inputId, "s", 20, entry.id); f.reopen(); }
    const visible = await f.read([entry]); assertLedger(visible, [[input.inputId, entry]]);
    const row = visible.messages[0]; assert.equal(row.id, input.inputId); assert.equal(row.entryId, entry.id);
    assert.equal(row.text, input.message); assert.equal(row.clientMessageId, "browser"); assert.equal(row.delivery.state, "delivered");
    const proof = f.store.getActorInput(input.inputId, "s", { includeDigest: true });
    assert.equal(typeof proof.digest, "string");
    for (const dto of [f.store.getActorInput(input.inputId, "s"), ...f.store.listActorInputReceipts("s"),
      ...f.store.listPendingActorInputs("s"), f.store.createActorInput("s", { inputId: input.inputId, message: input.message, images: [image], behavior })]) {
      assert.equal(Object.hasOwn(dto, "digest"), false, "Default and public receipt DTOs do not expose the private digest");
    }
    assert.deepEqual(canonicalRetryInput(entry, { sessionId: "s", inputReceipt: proof, canonicalEntries: [entry] }), {
      entryId: entry.id, originalInputId: input.inputId, message: input.message, images: [image], source: "user", origin: null });
    assert.deepEqual((await f.reader.readImage({ sessionFile: f.sessionFile, sessionId: "s", entryId: entry.id, index: 0 })), image);
  }
  const bytes = await readFile(f.sessionFile), inode = (await stat(f.sessionFile)).ino;
  f.reopen(); assertLedger(await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s", publicView: true }), [[input.inputId, entry]]);
  assert.deepEqual(await readFile(f.sessionFile), bytes); assert.equal((await stat(f.sessionFile)).ino, inode);
  assert.equal(f.store.markActorInputAccepted(input.inputId, "s", 1, 30).delivery.state, "delivered");
  assert.equal(f.store.listPendingActorInputs("s").length, 0);
});

for (const variant of ["no receipt", "wrong entry", "same entry wrong body", "same entry wrong images", "wrong session", "pending wrong body", "pending wrong images", "handled"]) {
  test(`legacy ${variant} remains literal, unassociated, and absent from all three ledgers`, async (t) => {
    const f = await fixture(t), inputId = "literal", entry = user("entry", inputId, "Exact original", [image]);
    if (variant !== "no receipt") {
      f.store.createActorInput("s", { inputId, message: "Exact original", images: [image] }, acceptedAt);
      if (variant === "handled") f.store.markActorInputHandled(inputId, "s", 20);
      else if (!variant.startsWith("pending")) f.store.completeActorInput(inputId, "s", 20, variant === "wrong entry" ? "actual-original" : entry.id);
    }
    if (variant.includes("wrong body")) entry.message.content[0].text = "Changed body" + marker(inputId);
    if (variant.endsWith("wrong images")) entry.message.content.pop();
    if (variant === "wrong session") f.reader.inputReceiptReader = (id) => ({ ...f.store.getActorInput(id, "s", { includeDigest: true }), sessionId: "other" });
    const visible = await f.read([entry]); assertLedger(visible, []);
    assert.equal(visible.messages[0].id, entry.id); assert.equal(visible.messages[0].inputId, undefined);
    assert.equal(visible.messages[0].delivery, undefined); assert.equal(visible.messages[0].role, "user");
    assert.equal(visible.messages[0].text, entry.message.content[0].text);
    const receipt = f.reader.inputReceiptReader(inputId, "s");
    const retried = canonicalRetryInput(entry, { sessionId: "s", inputReceipt: receipt });
    assert.equal(retried.originalInputId, null); assert.equal(retried.source, "user"); assert.equal(retried.message, entry.message.content[0].text);
  });
}

test("a completed legacy receipt without private payload evidence cannot strip even its own entry", async (t) => {
  const f = await fixture(t), inputId = "legacy", entry = user("entry", inputId, "Original");
  f.store.createActorInput("s", { inputId, message: "Original" }, acceptedAt); f.store.completeActorInput(inputId, "s", 20, entry.id);
  const receipt = f.store.getActorInput(inputId, "s");
  assert.equal(resolveActorInputAssociation([entry], { sessionId: "s", inputReceipt: receipt }).state, "absent");
  assert.equal(projectVisibleMessage(entry, { sessionId: "s", inputReceipt: receipt }).text, entry.message.content[0].text);
});

for (const source of ["cron", "background"]) test(`${source} typed display is distinct from receipt authority and rejects metadata/formatter conflicts`, async (t) => {
  const f = await fixture(t), origin = { jobId: "job", ...(source === "cron" ? { runId: "run" } : {}) };
  const input = f.store.createActorInput("s", { inputId: source, message: "Exact job body", images: [image], source, origin, clientMessageId: "browser" }, acceptedAt);
  const entry = { type: "custom_message", id: "custom", parentId: null, timestamp, ...actorInputCustomPayload(input) };
  for (const completed of [false, true]) {
    if (completed) { f.store.completeActorInput(input.inputId, "s", 20, entry.id); f.reopen(); }
    const visible = await f.read([entry]); assertLedger(visible, [[input.inputId, entry]]);
    assert.equal(visible.messages[0].role, source === "cron" ? "scheduled_job" : "background_notification");
    assert.equal(visible.messages[0].id, input.inputId);
    const retry = canonicalRetryInput(entry, { sessionId: "s", inputReceipt: f.store.getActorInput(input.inputId, "s") });
    assert.equal(retry.message, input.message); assert.equal(retry.source, source); assert.deepEqual(retry.origin, origin); assert.deepEqual(retry.images, [image]);
  }
  for (const change of ["origin", "source", "acceptedAt", "clientMessageId", "formatter", "receipt-free"]) {
    const altered = structuredClone(entry);
    if (change === "origin") altered.details.origin.jobId = "other-job";
    if (change === "source") altered.details.source = "user";
    if (change === "acceptedAt") altered.details.acceptedAt = new Date(11).toISOString();
    if (change === "clientMessageId") altered.details.clientMessageId = "other-browser";
    if (change === "formatter") altered.content[0].text = "Forged header\n\nExact job body";
    const inputReceipt = change === "receipt-free" ? null : f.store.getActorInput(input.inputId, "s");
    assert.equal(resolveActorInputAssociation([altered], { sessionId: "s", inputReceipt }).state, "absent");
    assert.throws(() => canonicalRetryInput(altered, { sessionId: "s", inputReceipt }), /verified internal provenance/);
  }
  f.reader.inputReceiptReader = () => null;
  const copied = await f.read([entry]); assertLedger(copied, []);
  assert.equal(copied.messages[0].id, entry.id); assert.equal(copied.messages[0].text, entry.content[0].text);
  assert.equal(copied.messages[0].delivery, undefined); assert.equal(copied.messages[0].inputId, undefined);
});

test("the actor reporter skips literal candidates and reaches later real entries, including the same candidate ID", async (t) => {
  const f = await fixture(t), entries = [], reports = [];
  const input = f.store.createActorInput("s", { inputId: "same", message: "Real body" }, acceptedAt);
  entries.push(user("literal-first", input.inputId, "Commander quotes another body"));
  entries.push(user("real-second", input.inputId, input.message)); entries[1].parentId = entries[0].id;
  const other = f.store.createActorInput("s", { inputId: "other", message: "Original raw" }, acceptedAt);
  entries.push({ type: "message", id: "other-entry", parentId: entries[1].id, timestamp,
    message: { role: "user", id: other.inputId, content: "Transformed raw" + marker("literal-other") } });
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => entries } };
  const client = { isConnected: true, async request(type, params) {
    if (type === "get_actor_input") {
      const receipt = f.store.getActorInput(params.inputId, "s"); assert.equal(Object.hasOwn(receipt, "digest"), false); return { input: receipt };
    }
    assert.equal(type, "record_input_delivery");
    // Use the same canonical owner that gates the real supervisor's completion.
    const canonical = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s" });
    assert.equal(canonical.inputDeliveries[params.inputId]?.entryId, params.entryId);
    reports.push(params.entryId); f.store.completeActorInput(params.inputId, "s", Date.parse(params.deliveredAt), params.entryId); return { accepted: true };
  } };
  await f.read(entries);
  const helper = createActorInputDelivery({ pi: { sendMessage() { assert.fail("Reporting must not inject"); } }, getClient: () => client, getContext: () => ctx });
  await helper.flush(); await helper.flush();
  assert.deepEqual(reports, ["real-second", "other-entry"]); assert.equal(f.store.listPendingActorInputs("s").length, 0);
  f.reader.clear(f.sessionFile); assertLedger(await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s" }), [[input.inputId, entries[1]], [other.inputId, entries[2]]]);
});


for (const variant of ["two active legacy matches", "later inactive legacy duplicate", "anchored legacy identity", "authoritative identity before a legacy quotation"]) {
  test(`one receipt has no first-plausible association under historical uniqueness: ${variant}`, async (t) => {
    const f = await fixture(t), inputId = "one-receipt", body = "Identical original body";
    f.store.createActorInput("s", { inputId, message: body, images: [image] }, acceptedAt);
    const original = user("original", inputId, body, [image]);
    const quotation = user("quotation", inputId, body, [image]); quotation.parentId = original.id;
    const answer = { type: "message", id: "answer", parentId: quotation.id, timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Reply" }] } };
    if (variant === "later inactive legacy duplicate") {
      quotation.parentId = null; answer.parentId = original.id;
    }
    if (variant === "anchored legacy identity") f.store.completeActorInput(inputId, "s", 20, original.id);
    if (variant === "authoritative identity before a legacy quotation") {
      original.message.id = inputId; original.message.content[0].text = body;
    }
    const visible = await f.read([original, quotation, answer]);
    const diagnostic = { variant, receiptAnchored: f.store.getActorInput(inputId, "s").entryId !== null,
      inputIds: visible.inputIds, inputEntries: visible.inputEntries, inputDeliveries: visible.inputDeliveries,
      messages: visible.messages.map(({ id, entryId, role, text, delivery }) => ({ id, entryId, role, text, delivery })) };
    if (process.env.PI_HARNESS_INPUT_AMBIGUITY_ARTIFACTS) {
      const output = path.join(process.env.PI_HARNESS_INPUT_AMBIGUITY_ARTIFACTS, variant.replaceAll(" ", "-") + ".json");
      await writeFile(output, JSON.stringify(diagnostic, null, 2) + "\n");
    }
    // Root superseded the active-wins expectation; both reciprocal weak matches are unresolved.
    const ambiguous = variant === "two active legacy matches" || variant === "later inactive legacy duplicate";
    assertLedger(visible, ambiguous ? [] : [[inputId, original]]);
    assert.equal(visible.inputAssociationStates[inputId], ambiguous ? "unresolved" : "proven");
    const rows = visible.messages.filter(row => row.role === "user");
    if (ambiguous) {
      assert.deepEqual(rows.map(row => row.id), variant === "later inactive legacy duplicate" ? [original.id] : [original.id, quotation.id]);
      assert(rows.every(row => row.text === body + marker(inputId) && row.delivery === undefined));
      assert.equal(f.store.getActorInput(inputId, "s").delivery.state, "accepted");
    } else {
      assert.equal(rows[0].id, inputId); assert.equal(rows[0].entryId, original.id); assert.equal(rows[0].text, body);
      if (variant !== "later inactive legacy duplicate") {
        assert.equal(rows[1].id, quotation.id); assert.equal(rows[1].text, body + marker(inputId));
        assert.equal(rows[1].inputId, undefined); assert.equal(rows[1].delivery, undefined);
      }
    }
  });
}


for (const kind of ["authoritative", "transformed authoritative", "anchored legacy", "unique legacy"]) {
  test(`historical incorporation survives inactivity without relabeling active rows: ${kind}`, async (t) => {
    const f = await fixture(t), inputId = "historical", body = "Accepted original body";
    f.store.createActorInput("s", { inputId, message: body, images: [image], clientMessageId: "browser" }, acceptedAt);
    const original = user("incorporated", inputId, body, [image]);
    if (kind.includes("authoritative")) {
      original.message.id = inputId;
      original.message.content[0].text = kind.startsWith("transformed") ? "Expanded canonical body" + marker("literal-transformed") : body;
    }
    if (kind === "anchored legacy") f.store.completeActorInput(inputId, "s", 20, original.id);
    const active = { type: "message", id: "active", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: kind === "unique legacy" ? "Unrelated current work" : body + marker(inputId) }, image] } };
    const visible = await f.read([original, active]);
    assertLedger(visible, [[inputId, original]]); assert.equal(visible.inputAssociationStates[inputId], "proven");
    assert.deepEqual(visible.messages.map(row => row.id), [active.id]);
    assert.equal(visible.messages[0].text, active.message.content[0].text); assert.equal(visible.messages[0].delivery, undefined);
    const bytes = await readFile(f.sessionFile), inode = (await stat(f.sessionFile)).ino;
    const proof = visible.inputDeliveries[inputId];
    f.store.completeActorInput(inputId, "s", Date.parse(proof.deliveredAt), proof.entryId);
    assert.equal(f.store.getActorInput(inputId, "s").entryId, original.id);
    assert.equal(f.store.listPendingActorInputs("s").length, 0);
    const reread = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s", publicView: true });
    assertLedger(reread, [[inputId, original]]); assert.deepEqual(reread.messages.map(row => row.id), [active.id]);
    assert.deepEqual(await readFile(f.sessionFile), bytes); assert.equal((await stat(f.sessionFile)).ino, inode);
  });
}

test("the reciprocal inactive-original/active-quotation legacy case is unresolved, not active-first", async (t) => {
  const f = await fixture(t), inputId = "reciprocal", body = "Same accepted body";
  f.store.createActorInput("s", { inputId, message: body, images: [image], behavior: "follow_up" }, acceptedAt);
  const original = user("inactive-original", inputId, body, [image]), quotation = user("active-quotation", inputId, body, [image]);
  const before = f.store.getActorInput(inputId, "s");
  const visible = await f.read([original, quotation]);
  assertLedger(visible, []); assert.equal(visible.inputAssociationStates[inputId], "unresolved");
  assert.deepEqual(visible.messages.map(row => row.id), [quotation.id]); assert.equal(visible.messages[0].text, body + marker(inputId));
  assert.deepEqual(f.store.getActorInput(inputId, "s"), before);
});

for (const inactive of [false, true]) test(`conflicting authoritative entries stay unresolved${inactive ? " across branches" : " on one branch"}`, async (t) => {
  const f = await fixture(t), inputId = "strong-conflict";
  f.store.createActorInput("s", { inputId, message: "Raw accepted text", images: [image] }, acceptedAt);
  const entries = [user("first", inputId, "Raw accepted text", [image]), user("second", inputId, "A transformed body", [image])];
  for (const entry of entries) entry.message.id = inputId;
  entries[1].parentId = inactive ? null : entries[0].id;
  const before = f.store.getActorInput(inputId, "s"), visible = await f.read(entries);
  assertLedger(visible, []); assert.equal(visible.inputAssociationStates[inputId], "unresolved");
  assert(visible.messages.every(row => row.id !== inputId && row.delivery === undefined));
  assert.deepEqual(f.store.getActorInput(inputId, "s"), before);
});

test("true absence and an ineligible literal candidate leave the pending payload untouched", async (t) => {
  const f = await fixture(t), inputId = "not-incorporated";
  f.store.createActorInput("s", { inputId, message: "Required body", images: [image] }, acceptedAt);
  const before = f.store.getActorInput(inputId, "s");
  const absent = await f.read([{ type: "message", id: "ordinary", parentId: null, timestamp,
    message: { role: "user", content: "Harness cron input and background headings are ordinary prose" } }]);
  assertLedger(absent, []); assert.equal(absent.inputAssociationStates[inputId] ?? "absent", "absent");
  for (const invalidId of [true, 1, {}, []]) {
    const literal = user("literal", inputId, "Different quoted body", [image]); literal.message.id = invalidId;
    const visible = await f.read([literal]); assertLedger(visible, []);
    assert.equal(visible.inputAssociationStates[inputId], "absent"); assert.equal(visible.messages[0].text, literal.message.content[0].text);
  }
  assert.deepEqual(f.store.getActorInput(inputId, "s"), before);
});

test("a proof beyond the visible page cannot be ignored when checking historical uniqueness", async (t) => {
  const f = await fixture(t), inputId = "outside-page", body = "Same exact body";
  f.store.createActorInput("s", { inputId, message: body, images: [image] }, acceptedAt);
  const entries = [user("old", inputId, body, [image])];
  for (let index = 0; index < 600; index += 1) entries.push({ type: "message", id: `middle-${index}`, parentId: entries.at(-1).id, timestamp,
    message: { role: "assistant", content: [{ type: "text", text: `History item ${index}` }] } });
  const quotation = user("recent", inputId, body, [image]); quotation.parentId = entries.at(-1).id; entries.push(quotation);
  const visible = await f.read(entries);
  assert(visible.historyPage.hasMore); assert(!visible.messages.some(row => row.id === "old"));
  assertLedger(visible, []); assert.equal(visible.inputAssociationStates[inputId], "unresolved");
});

test("new strong evidence resolves ambiguity without a cached verdict or previously stripped rows", async (t) => {
  const f = await fixture(t), inputId = "resolution", body = "Original accepted body";
  f.store.createActorInput("s", { inputId, message: body, images: [image] }, acceptedAt);
  const entries = [user("legacy-a", inputId, body, [image]), user("legacy-b", inputId, body, [image])]; entries[1].parentId = entries[0].id;
  const before = f.store.getActorInput(inputId, "s"), unresolved = await f.read(entries);
  assert.equal(unresolved.inputAssociationStates[inputId], "unresolved"); assertLedger(unresolved, []);
  const strong = { type: "message", id: "new-authoritative", parentId: entries[1].id, timestamp: new Date(30).toISOString(),
    message: { role: "user", id: inputId, content: [{ type: "text", text: "Expanded actual body" + marker("literal-in-expansion") }, image] } };
  await appendFile(f.sessionFile, JSON.stringify(strong) + "\n");
  const resolved = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s", publicView: true });
  assertLedger(resolved, [[inputId, strong]]); assert.equal(resolved.inputAssociationStates[inputId], "proven");
  assert.deepEqual(new Set(resolved.messages.map(row => row.id)), new Set([entries[0].id, entries[1].id, inputId]));
  assert(resolved.messages.filter(row => row.id !== inputId).every(row => row.text === body + marker(inputId) && row.delivery === undefined));
  const delivered = resolved.messages.find(row => row.id === inputId);
  assert.equal(delivered.text, strong.message.content[0].text);
  assert.equal(delivered.createdAt, new Date(acceptedAt).toISOString(), "Public input order retains the original acceptance time");
  assert.equal(delivered.delivery.deliveredAt, strong.timestamp);
  assert.deepEqual(f.store.getActorInput(inputId, "s"), before, "Reading neither accepts nor retires a reservation");
  assert.equal(Object.hasOwn(resolved, "record"), false); assert.equal(Object.hasOwn(resolved, "associations"), false);
  f.store.completeActorInput(inputId, "s", 30, strong.id);
  assertLedger(await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s" }), [[inputId, strong]]);
});

test("a later duplicate revokes an earlier weak projection without retaining a stripped cache row", async (t) => {
  const f = await fixture(t), inputId = "revoked", body = "Exact original";
  f.store.createActorInput("s", { inputId, message: body }, acceptedAt);
  const original = user("first", inputId, body), first = await f.read([original]); assertLedger(first, [[inputId, original]]);
  const duplicate = user("second", inputId, body); duplicate.parentId = original.id;
  await appendFile(f.sessionFile, JSON.stringify(duplicate) + "\n");
  const ambiguous = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s", publicView: true });
  assertLedger(ambiguous, []); assert.equal(ambiguous.inputAssociationStates[inputId], "unresolved");
  assert.deepEqual(ambiguous.messages.map(row => row.id), [original.id, duplicate.id]);
  assert(ambiguous.messages.every(row => row.text === body + marker(inputId) && row.delivery === undefined));
  // A delayed completion from a previously validated snapshot becomes a real anchor.
  f.store.completeActorInput(inputId, "s", 20, original.id);
  const anchored = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s", publicView: true });
  assertLedger(anchored, [[inputId, original]]); assert.equal(anchored.messages[1].id, duplicate.id);
  assert.equal(anchored.messages[1].text, body + marker(inputId)); assert.equal(anchored.messages[1].delivery, undefined);
});

test("reporter retains unresolved work, reports unrelated input, and rechecks later strong evidence", async (t) => {
  const f = await fixture(t), inputId = "blocked", body = "Original body", reports = [];
  f.store.createActorInput("s", { inputId, message: body, images: [image], behavior: "follow_up" }, acceptedAt);
  f.store.createActorInput("s", { inputId: "valid", message: "Raw valid body" }, acceptedAt);
  const entries = [user("weak-a", inputId, body, [image]), user("weak-b", inputId, body, [image]),
    { type: "message", id: "valid-entry", parentId: "weak-b", timestamp, message: { role: "user", id: "valid", content: "Expanded valid body" } }];
  entries[1].parentId = entries[0].id;
  await f.read(entries); const before = f.store.getActorInput(inputId, "s");
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => entries } };
  const client = { isConnected: true, async request(type, params) {
    if (type === "get_actor_input") return { input: f.store.getActorInput(params.inputId, "s") };
    assert.equal(type, "record_input_delivery");
    const canonical = await f.reader.read({ sessionFile: f.sessionFile, sessionId: "s" });
    assert.equal(canonical.inputAssociationStates[params.inputId], "proven");
    assert.equal(canonical.inputEntries[params.inputId], params.entryId);
    reports.push(params.inputId); f.store.completeActorInput(params.inputId, "s", Date.parse(params.deliveredAt), params.entryId); return { accepted: true };
  } };
  const helper = createActorInputDelivery({ pi: { sendMessage() { assert.fail("Proof reporting must not replay input"); } }, getClient: () => client, getContext: () => ctx });
  await helper.flush(); await helper.flush();
  assert.deepEqual(reports, ["valid"]); assert.deepEqual(f.store.getActorInput(inputId, "s"), before);
  const strong = { type: "message", id: "strong", parentId: "valid-entry", timestamp: new Date(30).toISOString(),
    message: { role: "user", id: inputId, content: [{ type: "text", text: body }, image] } };
  entries.push(strong); await appendFile(f.sessionFile, JSON.stringify(strong) + "\n");
  await helper.flush(); await helper.flush();
  assert.deepEqual(reports, ["valid", inputId]); assert.equal(f.store.listPendingActorInputs("s").length, 0);
});

test("an internal command that observes conflicting strong evidence neither injects nor acknowledges transport", async (t) => {
  const f = await fixture(t);
  const input = f.store.createActorInput("s", { inputId: "internal-conflict", message: "Exact internal body", source: "background", origin: { jobId: "job" } }, acceptedAt);
  const entries = ["a", "b"].map((id, index) => ({ type: "custom_message", id, parentId: index ? "a" : null, timestamp, ...actorInputCustomPayload(input) }));
  const visible = await f.read(entries); assertLedger(visible, []); assert.equal(visible.inputAssociationStates[input.inputId], "unresolved");
  const ctx = { sessionManager: { getSessionId: () => "s", getEntries: () => entries } }, calls = [];
  const client = { isConnected: true, async request(type, params) { calls.push(type); assert.equal(type, "get_actor_input"); return { input: f.store.getActorInput(params.inputId, "s") }; } };
  const helper = createActorInputDelivery({ pi: { sendMessage() { assert.fail("Unresolved is not absent"); } }, getClient: () => client, getContext: () => ctx });
  await helper.handle(input.inputId, ctx); await helper.flush();
  assert.deepEqual(calls, ["get_actor_input", "get_actor_input"]); assert.deepEqual(f.store.getActorInput(input.inputId, "s"), input);
});

test("authoritative expansion larger than the legacy input read limit retains proof, images, and Retry content", async (t) => {
  const f = await fixture(t), inputId = "large-transformation", expanded = "x".repeat(6 * 1024 * 1024) + marker("literal-large-body");
  f.store.createActorInput("s", { inputId, message: "/template tiny raw input", images: [image] }, acceptedAt);
  const userEntry = { type: "message", id: "large-user", parentId: null, timestamp,
    message: { role: "user", id: inputId, content: [{ type: "text", text: expanded }, image] } };
  const answer = { type: "message", id: "answer", parentId: userEntry.id, timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "Reply" }] } };
  const visible = await f.read([userEntry, answer]); assertLedger(visible, [[inputId, userEntry]]);
  assert.equal(visible.inputAssociationStates[inputId], "proven");
  assert.deepEqual(await f.reader.readImage({ sessionFile: f.sessionFile, sessionId: "s", entryId: userEntry.id, index: 0 }), image);
  const retry = await f.reader.resolveRetryInput({ sessionFile: f.sessionFile, sessionId: "s", assistantId: answer.id });
  assert(retry.input.message === expanded, "The original canonical expansion is not truncated or digest-compared");
  assert.deepEqual(retry.input.images, [image]); assert.equal(retry.input.originalInputId, inputId);
});
