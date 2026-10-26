import assert from "node:assert/strict";
import fs, { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VisibleTranscriptReader, boundVisibleHistory } from "../src/visible-transcript-reader.mjs";
import { projectVisibleMessage, assistantMessageParts, sortVisibleHistory } from "../src/conversation-projection.mjs";
import { projectAgentMessageEntry, selectIncomingFamilyMessages, CHILD_CREATION_ENTRY_TYPE, AGENT_MESSAGE_ENTRY_TYPE, INCOMING_AGENT_MESSAGE_TYPE } from "../src/agent-message-projection.mjs";
import { projectProgressEntry } from "../src/progress-projection.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const header = id => ({ type: "session", id, version: 3 });
const message = (id, parentId, role, text) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
async function fixture(t, id = "session") {
  const root = await mkdtemp(path.join(os.tmpdir(), "transcript-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, `${id}.jsonl`);
  const put = entries => writeFile(file, [header(id), ...entries].map(JSON.stringify).join("\n") + "\n");
  return { root, file, id, put, args: { sessionFile: file, sessionId: id, inputProofIds: [] } };
}
async function bytesFor(file, operation) {
  const original = fs.open; let bytes = 0;
  fs.open = async function(name, ...args) {
    const handle = await original.call(this, name, ...args);
    if (name === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); bytes += result.bytesRead; return result; };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { return { value: await operation(), bytes }; }
  finally { fs.open = original; syncBuiltinESMExports(); }
}

test("aggregate byte LRU and session ceiling evict ownership, not canonical history", async t => {
  const fixtures = [];
  for (const id of ["a", "b", "c", "big"]) {
    const f = await fixture(t, id); fixtures.push(f);
    await f.put(Array.from({ length: id === "big" ? 400 : 1 }, (_, i) => message(`m${i}`, i ? `m${i - 1}` : null, "user", "x".repeat(80))));
  }
  const [a, b, c, big] = fixtures;
  const reader = new VisibleTranscriptReader({ maxCachedBytes: 90_000 }); // Two small digest-block owners, never three.
  const read = f => bytesFor(f.file, () => reader.read(f.args));
  await read(a); await read(b);
  assert.equal((await read(a)).bytes, 0); // a is now most recent.
  await read(c);
  assert.equal((await read(a)).bytes, 0);
  assert((await read(b)).bytes > 0, "aggregate bytes evict even below the 64-session ceiling");
  await read(a);
  await read(big);
  assert.equal((await read(a)).bytes, 0, "an oversized owner does not evict unrelated small records");
  assert((await read(big)).bytes > 0, "oversized records remain fully readable but are not retained");
  const one = new VisibleTranscriptReader({ maxCachedSessions: 1 });
  await one.read(a.args); await one.read(b.args);
  assert((await bytesFor(a.file, () => one.read(a.args))).bytes > 0);
  for (const maxCachedBytes of [-1, Infinity, 1.5]) assert.throws(() => new VisibleTranscriptReader({ maxCachedBytes }), /invalid transcript cache/);
});

test("incomplete frame accounts for the whole pending Buffer backing store", async t => {
  const f = await fixture(t);
  await f.put([message("u", null, "user", "visible"), message("hidden", "u", "toolResult", "x".repeat(220_000))]);
  await appendFile(f.file, "{"); // one-byte view pins the complete read chunk.
  const reader = new VisibleTranscriptReader({ maxCachedBytes: 64 * 1024 });
  const first = await bytesFor(f.file, () => reader.read(f.args));
  assert.equal(first.value.messages[0].text, "visible");
  assert.equal((await bytesFor(f.file, () => reader.read(f.args))).bytes, first.bytes,
    "the tiny pending view must not admit a much larger backing allocation");
});

test("branch, image and retry snapshots work when admission is disabled", async t => {
  const f = await fixture(t), user = message("u", null, "user", "input");
  user.message.content.push({ type: "image", data: PNG, mimeType: "image/png" });
  await f.put([user, message("a", "u", "assistant", "reply".repeat(1000))]);
  const reader = new VisibleTranscriptReader({ maxCachedBytes: 0 });
  assert.equal((await reader.read(f.args)).messages.at(-1).text, "reply".repeat(1000));
  assert.deepEqual((await reader.readBranch({ ...f.args, leafId: "a" })).entries.map(e => e.id), ["u", "a"]);
  assert.equal((await reader.readImage({ ...f.args, entryId: "u", index: 0 })).data, PNG);
  assert.deepEqual(await reader.resolveRetryTurn({ ...f.args, assistantId: "a-text-0" }), { assistantId: "a", userId: "u", branchFromId: null });
  assert.equal((await reader.resolveRetryInput({ ...f.args, assistantId: "a" })).input.message, "input");
});

test("clear fences late admission without cancelling an active read or its independent successor", async t => {
  const f = await fixture(t); await f.put([message("u", null, "user", "input")]);
  const reader = new VisibleTranscriptReader(), original = fs.open;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  fs.open = async function(name, ...args) {
    const handle = await original.call(this, name, ...args);
    if (name === f.file) { const read = handle.read.bind(handle); handle.read = async (...args) => { enter(); await released; return read(...args); }; }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const pending = reader.read(f.args);
    await entered; reader.clear(f.file); release();
    assert.equal((await pending).messages[0].text, "input");
  } finally { release(); fs.open = original; syncBuiltinESMExports(); }
  assert((await bytesFor(f.file, () => reader.read(f.args))).bytes > 0, "clear cannot be undone by the old in-flight owner");
  assert.equal((await bytesFor(f.file, () => reader.read(f.args))).bytes, 0, "a later independent request can admit fresh metadata");
});

test("independent cancellation drops only the failed owner; queued privacy options still succeed", async t => {
  const f = await fixture(t); await f.put([message("a", null, "assistant", "<!-- harness.presentation.v1 body=happy face=smile -->\n" + "answer".repeat(1000))]);
  const reader = new VisibleTranscriptReader(), original = fs.open, abort = new AbortController();
  let once = true;
  fs.open = async function(name, ...args) {
    const handle = await original.call(this, name, ...args);
    if (name === f.file) { const read = handle.read.bind(handle); handle.read = async (...args) => {
      const value = await read(...args); if (once) { once = false; abort.abort(); } return value;
    }; }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const [cancelled, valid] = await Promise.allSettled([
      reader.read({ ...f.args, signal: abort.signal }), reader.read({ ...f.args, sanitizePresentation: true }),
    ]);
    assert.equal(cancelled.status, "rejected"); assert.equal(cancelled.reason.name, "AbortError");
    assert.equal(valid.status, "fulfilled"); assert.equal(valid.value.messages[0].text, "answer".repeat(1000));
  } finally { fs.open = original; syncBuiltinESMExports(); }
  assert.match((await reader.read(f.args)).messages[0].text, /harness.presentation/);
});

function reference(entries, { publicView, sanitizePresentation }) {
  const items = [];
  for (const entry of entries) {
    const parts = publicView ? assistantMessageParts(entry, { sanitizePresentation }) : [];
    if (parts.length) items.push(...parts.map(message => ({ kind: "message", message })));
    else {
      const message = projectVisibleMessage(entry, { imageReferences: true, sanitizePresentation });
      const item = message ? { kind: "message", message } : projectProgressEntry(entry) ?? projectAgentMessageEntry(entry);
      if (item) items.push(item);
    }
  }
  const visible = selectIncomingFamilyMessages(items);
  return publicView ? sortVisibleHistory(visible) : visible;
}

test("compact inline/deferred Unicode, sanitization, parts and exact page costs match full canonical projection", async t => {
  const f = await fixture(t), entries = [];
  const samples = ["x".repeat(255), "x".repeat(256), "x".repeat(257), '\\"\b\t\n\f\r\u0000\ud800\udfff😀漢é'.repeat(250),
    "<!-- harness.presentation.v1 body=happy face=smile -->\n" + "😀\ud800\\\"".repeat(500)];
  for (const text of samples) {
    const id = `m${entries.length}`;
    entries.push(message(id, entries.at(-1)?.id ?? null, "assistant", text));
  }
  const parts = message("parts", entries.at(-1).id, "assistant", "");
  parts.message.content = [
    { type: "text", text: "first".repeat(100), harnessBirth: { version: 1, sequence: 2, createdAt: "2026-01-01T00:00:00.000Z" } },
    { type: "thinking", thinking: "never visible" },
    { type: "text", text: "second😀".repeat(100), id: "stable-part", harnessBirth: { version: 1, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" } },
  ];
  entries.push(parts, { type: "custom", customType: CHILD_CREATION_ENTRY_TYPE, id: "child", parentId: "parts", timestamp: "2026-01-01T00:00:00Z",
    data: { taskId: "task", childId: "child-id", childName: "Child", relationship: "child", body: '\\"😀'.repeat(1000) } });
  await f.put(entries);
  for (const publicView of [false, true]) for (const sanitizePresentation of [false, true]) {
    const options = { publicView, sanitizePresentation };
    const expected = reference(entries, options), reader = new VisibleTranscriptReader();
    for (const maxBytes of [512, 1024, 4096, 100_000]) {
      const bounds = { maxMessages: 4, maxBytes };
      let before = null, end = expected.length;
      do {
        const value = await reader.read({ ...f.args, ...options, ...bounds, before });
        const page = boundVisibleHistory(expected.slice(0, end), bounds);
        assert.deepEqual({ messages: value.messages, history: value.history, truncated: value.truncated }, page);
        end -= page.history.length;
        before = value.historyPage.nextCursor;
        assert.equal(Boolean(before), Boolean(end));
      } while (before);
    }
    const full = await reader.read({ ...f.args, ...options, historyIndex: true, verifySource: true });
    assert.deepEqual(full.messages, expected.filter(item => item.kind === "message").map(item => item.message));
    assert.deepEqual(full.history, expected.map(item => item.kind === "message" ? { kind: "message", id: item.message.id } : item));
  }
});

test("warm deferred hydration reads only selected spans and rejects a same-inode changed payload", async t => {
  const f = await fixture(t), entries = Array.from({ length: 200 }, (_, i) => message(`m${i}`, i ? `m${i - 1}` : null, i % 2 ? "assistant" : "user", "payload".repeat(1000)));
  await f.put(entries);
  const reader = new VisibleTranscriptReader(), args = { ...f.args, maxMessages: 2, maxBytes: 48 * 1024 };
  const cold = await bytesFor(f.file, () => reader.read(args));
  const warm = await bytesFor(f.file, () => reader.read(args));
  assert.deepEqual(warm.value, cold.value);
  assert(warm.bytes > 0 && warm.bytes < cold.bytes / 20, "only selected canonical spans hydrate, not the full prefix");
  const source = await readFile(f.file, "utf8");
  await writeFile(f.file, source.replaceAll("payload", "PAYLOAD"));
  await assert.rejects(reader.read(args), /canonical input source changed/);
  assert.equal((await reader.read({ ...args, verifySource: true })).messages.at(-1).text, "PAYLOAD".repeat(1000));
});


test("eviction and clear during selected-span hydration preserve the leased result and later refresh", async t => {
  const a = await fixture(t, "lease-a"), b = await fixture(t, "lease-b");
  await a.put([message("u", null, "user", "old".repeat(2000))]);
  await b.put([message("b", null, "user", "other")]);
  const reader = new VisibleTranscriptReader({ maxCachedSessions: 1 });
  await reader.read(a.args);
  const original = fs.open; let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  fs.open = async function(name, ...args) {
    const handle = await original.call(this, name, ...args);
    if (name === a.file) { const read = handle.read.bind(handle); handle.read = async (...args) => { enter(); await released; return read(...args); }; }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const active = reader.read(a.args); await entered;
    await reader.read(b.args); reader.clear(a.file);
    release();
    const leased = await active;
    assert.equal(leased.messages[0].text, "old".repeat(2000));
    await appendFile(a.file, JSON.stringify(message("new", null, "user", "new branch")) + "\n");
    const latest = await reader.read(a.args);
    assert.deepEqual(latest.messages.map(m => m.id), ["new"]);
    assert.equal(leased.messages[0].text, "old".repeat(2000), "refresh does not mutate returned output");
  } finally { release(); fs.open = original; syncBuiltinESMExports(); }
});


function incoming(id, parentId, familyMessageId, body) {
  return { type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE, id, parentId,
    timestamp: "2026-01-01T00:00:00Z", content: `Public reviewer:\n${body}`, display: true,
    details: { messageId: familyMessageId, senderId: "reviewer", senderName: "Public reviewer", relationship: "sibling", body } };
}

test("delivery-only family evidence keeps historical bodies cold without changing pages or full reads", async t => {
  const f = await fixture(t), body = 'Public synthetic \\"😀\n'.repeat(150), entries = [];
  entries.push(incoming("abandoned", null, "inactive", body));
  for (let i = 0; i < 120; i++) entries.push(incoming(`family-${i}`, i ? `family-${i-1}` : null, `route-${i}`, body));
  const receipt = { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "receipt", parentId: entries.at(-1).id,
    timestamp: "2026-01-01T00:00:00Z", data: { messageId: "unadmitted", direction: "from", peerId: "reviewer",
      peerName: "Public reviewer", relationship: "sibling", body } };
  entries.push(receipt, message("latest", "receipt", "assistant", "Latest public answer"));
  await f.put(entries);
  const reader = new VisibleTranscriptReader(), options = { ...f.args, publicView: true, inputProofIds: "page", maxMessages: 1 };
  await reader.read({ ...options, familyDeliveryOnly: true });
  const scoped = await bytesFor(f.file, () => reader.read({ ...options, familyDeliveryOnly: true }));
  assert.equal(scoped.bytes, 0, "latest assistant-only page must not hydrate any historical family payload");
  assert.equal(Object.keys(scoped.value.familyMessages).length, 120);
  assert.equal(scoped.value.familyMessages.inactive, undefined);
  assert.equal(scoped.value.familyMessages.unadmitted, undefined);
  for (const row of Object.values(scoped.value.familyMessages)) assert.deepEqual(row, {
    delivery: { state: "delivered", deliveredAt: "2026-01-01T00:00:00.000Z" },
  });
  const full = await bytesFor(f.file, () => reader.read(options));
  assert(full.bytes > 120 * Buffer.byteLength(body), "the default read still returns every requested full family body");
  const expected = reference(entries.slice(1), options);
  for (let i = 0; i < 120; i++) assert.deepEqual(full.value.familyMessages[`route-${i}`], expected[i]);
  for (const field of ["messages", "history", "historyPage", "truncated", "inputIds", "inputEntries", "inputDeliveries"])
    assert.deepEqual(scoped.value[field], full.value[field]);
  const targeted = await bytesFor(f.file, () => reader.read({ ...options, familyMessageId: "route-0" }));
  assert.deepEqual(Object.keys(targeted.value.familyMessages), ["route-0"]);
  assert.deepEqual(targeted.value.familyMessages["route-0"], expected[0]);
  assert.equal(targeted.bytes, Buffer.byteLength(JSON.stringify(entries[1])), "explicit family admission validates and hydrates only its requested span");
  const before = scoped.value.historyPage.nextCursor;
  const page = await bytesFor(f.file, () => reader.read({ ...options, before, familyDeliveryOnly: true }));
  assert.deepEqual(page.value.history, [expected[119]]);
  assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(entries[120])), "an older family page hydrates only its selected source span");
  // In-flight keys must not coalesce delivery-only and full result contracts.
  const [limited, complete] = await Promise.all([
    reader.read({ ...options, familyDeliveryOnly: true }), reader.read(options),
  ]);
  assert.equal(limited.familyMessages["route-0"].body, undefined);
  assert.equal(complete.familyMessages["route-0"].body, body);
  // Metadata-only rendering is not a whole-source audit. Selected payloads and
  // explicit family admission keep the existing physical source verification.
  const source = await readFile(f.file, "utf8");
  await writeFile(f.file, source.replaceAll("Public synthetic", "Edited synthetic"));
  assert.equal((await reader.read({ ...options, familyDeliveryOnly: true })).messages[0].text, "Latest public answer");
  const physicalReader = new VisibleTranscriptReader();
  await writeFile(f.file, source); await physicalReader.read({ ...options, familyDeliveryOnly: true });
  await writeFile(f.file, source.replaceAll("Public synthetic", "Edited synthetic"));
  await assert.rejects(reader.read({ ...options, familyDeliveryOnly: true, before }), /canonical input source changed/);
  await assert.rejects(physicalReader.read({ ...options, familyDeliveryOnly: true, familyMessageId: "route-0" }), /canonical input source changed/);
});
