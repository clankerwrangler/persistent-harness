import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assistantMessageParts, assistantTextPart } from "../src/conversation-projection.mjs";
import { LiveConversation } from "../src/live-conversation.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const timestamp = 1788600000000;
const text = (id, value, phase = "commentary") => ({ type: "text", text: value,
  textSignature: JSON.stringify({ v: 1, id, phase }) });
const message = { role: "assistant", timestamp, provider: "openai-codex", content: [
  text("msg-first", "First message."), { type: "thinking", thinking: "PRIVATE" },
  text("msg-second", "Second message."), text("msg-final", "Final message.", "final_answer") ] };

test("adjacent Responses output items keep separate stable public IDs without exposing signatures or thinking", () => {
  const parts = assistantMessageParts({ type: "message", id: "canonical", timestamp: new Date(timestamp + 500).toISOString(), message });
  assert.deepEqual(parts.map((part) => part.text), ["First message.", "Second message.", "Final message."]);
  assert.equal(new Set(parts.map((part) => part.id)).size, 3);
  assert(parts.every((part) => part.createdAt === new Date(timestamp).toISOString() && part.entryId === "canonical"));
  assert.doesNotMatch(JSON.stringify(parts), /PRIVATE|textSignature|commentary|final_answer|msg-first/);
  assert.equal(assistantTextPart(message, 0).id, parts[0].id);
});

test("public history expands text items while canonical recall and retry keep Pi entry IDs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "part-history-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl"); const sessionId = "parts";
  const entries = [ { type: "session", id: sessionId, version: 3, timestamp: new Date(timestamp - 1000).toISOString() },
    { type: "message", id: "user", parentId: null, timestamp: new Date(timestamp - 500).toISOString(), message: { role: "user", content: "Do the task." } },
    { type: "message", id: "canonical", parentId: "user", timestamp: new Date(timestamp + 500).toISOString(), message } ];
  await writeFile(sessionFile, entries.map(JSON.stringify).join("\n") + "\n");
  const reader = new VisibleTranscriptReader();
  const visible = await reader.read({ sessionFile, sessionId, publicView: true });
  assert.equal(visible.messages.filter((item) => item.role === "assistant").length, 3);
  assert.equal((await reader.read({ sessionFile, sessionId })).messages.at(-1).id, "canonical");
  const target = visible.messages.at(-1).id;
  assert.deepEqual(await reader.resolveRetryTurn({ sessionFile, sessionId, assistantId: target }),
    { assistantId: "canonical", userId: "user", branchFromId: null });
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE|textSignature/);
});

test("live text survives replay-ring-sized streams and retains its original identity through completion", () => {
  const live = new LiveConversation(); const part = assistantTextPart(message, 0);
  const frame = (type, extra = {}) => ({ type: "message_update", messageId: part.id, createdAt: part.createdAt,
    assistantMessageEvent: { type, contentIndex: 0, ...extra } });
  live.accept(frame("text_start"));
  for (let index = 0; index < 1000; index += 1) live.accept(frame("text_delta", { delta: "x" }));
  assert.deepEqual(live.snapshot(), [{ id: part.id, role: "assistant", text: "x".repeat(1000), createdAt: part.createdAt, status: "streaming" }]);
  live.accept(frame("text_end", { text: "Complete first message." }));
  assert.equal(live.snapshot()[0].status, "complete");
  assert.equal(live.snapshot()[0].id, part.id);
  live.reconcile(new Set([part.id]));
  assert.deepEqual(live.snapshot(), []);
});

test("live snapshots bound all open items together and explicitly report truncation", () => {
  const live = new LiveConversation();
  for (let index = 0; index < 600; index += 1) live.accept({ type: "message_update", messageId: `part-${index}`,
    createdAt: new Date(timestamp).toISOString(), assistantMessageEvent: { type: "text_delta", delta: "😀".repeat(1024) } });
  const snapshot = live.snapshot();
  assert(snapshot.length <= 512);
  assert(snapshot.reduce((sum, item) => sum + Buffer.byteLength(item.text.replace(/…$/, "")), 0) <= 256 * 1024);
  assert.equal(live.truncated, true);
  assert(snapshot.every((item) => !item.text.includes("�")));
});

test("core identity survives a fixed clock and canonical entry remapping", () => {
  const make = (id) => ({ role: "assistant", id, timestamp, provider: "ordinary", content: [{ type: "text", text: "Same text" }] });
  const first = assistantTextPart(make("core-one"), 0); const second = assistantTextPart(make("core-two"), 0);
  assert.notEqual(first.id, second.id);
  assert.equal(assistantMessageParts({ type: "message", id: "entry-one", message: make("core-one") })[0].id, first.id);
});

test("private metadata amendments preserve the public cursor and remain invisible", async (t) => {
  const { appendFile, readFile, stat } = await import("node:fs/promises");
  const directory = await mkdtemp(path.join(os.tmpdir(), "metadata-cursor-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  const prefix = [ { type: "session", id: "metadata", version: 3, timestamp: new Date(timestamp).toISOString() },
    { type: "message", id: "u", parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "user", content: "Question" } },
    { type: "message", id: "a", parentId: "u", timestamp: new Date(timestamp + 1).toISOString(), message } ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(sessionFile, prefix); const inode = (await stat(sessionFile)).ino;
  const reader = new VisibleTranscriptReader(); const args = { sessionFile, sessionId: "metadata", publicView: true, maxMessages: 1 };
  const initial = await reader.read(args);
  await appendFile(sessionFile, JSON.stringify({ type: "assistant_thinking_signature", id: "amendment", parentId: "a", timestamp: new Date(timestamp + 2).toISOString(),
    messageEntryId: "a", contentIndex: 1, itemId: "rs-private", encryptedContent: "PRIVATE_REPLAY_BYTES" }) + "\n");
  const current = await reader.read(args);
  assert.equal((await stat(sessionFile)).ino, inode); assert((await readFile(sessionFile, "utf8")).startsWith(prefix));
  assert.equal(current.historyPage.branchId, initial.historyPage.branchId);
  const older = await reader.read({ ...args, before: initial.historyPage.nextCursor }); assert(older.messages.length > 0);
  assert.doesNotMatch(JSON.stringify([current, older]), /PRIVATE_REPLAY_BYTES|rs-private|thinkingSignature/);
});

test("core text item identity survives provider metadata and rebased segments", () => {
  const item = { type: "text", id: "core-text", text: "First" };
  const initial = { role: "assistant", id: "core-response", timestamp, content: [item] };
  const final = { ...initial, id: "next-segment", provider: "openai-codex", content: [{ type: "thinking", thinking: "PRIVATE" },
    { ...text("msg-provider", "First"), id: item.id }] };
  assert.equal(assistantTextPart(initial, 0).id, assistantTextPart(final, 1).id);
  const separate = { ...final, content: [final.content[0], { ...final.content[1], id: "other-core-text" }] };
  assert.notEqual(assistantTextPart(separate, 1).id, assistantTextPart(final, 1).id,
    "Provider item IDs and fixed timestamps cannot merge separate core text items");
  const legacy = { ...final, content: [final.content[0], text("msg-provider", "First")] };
  assert.equal(assistantTextPart(legacy, 1).id,
    assistantMessageParts({ type: "message", id: "legacy-entry", message: legacy })[0].id);
});
