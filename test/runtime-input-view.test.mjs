import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actorInputCustomPayload } from "../src/extension.mjs";
import { projectVisibleMessage, pendingInputMessage } from "../src/conversation-projection.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const acceptedAt = Date.parse("2026-01-01T00:00:00.000Z");
const receipt = (inputId, source = "user") => ({ inputId, sessionId: "session", source, origin: source === "user" ? null : { jobId: "bg-proof" },
  acceptedAt, clientMessageId: "client-proof", delivery: { state: "accepted", inputId,
    acceptedAt: new Date(acceptedAt).toISOString(), deliveredAt: null } });

test("a receipt, not body or marker text, supplies legacy input provenance", () => {
  const inputId = "background-completion-bg-000000000001";
  const text = `A real Commander can quote this marker.\n\n<!-- persistent-harness-input:${inputId} -->`;
  const entry = { type: "message", id: "canonical", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text } };
  assert.equal(projectVisibleMessage(entry).role, "user"); assert.equal(projectVisibleMessage(entry).text, text);
  const proven = projectVisibleMessage(entry, { sessionId: "session", canonicalEntries: [entry], inputReceipt: { ...receipt(inputId, "background"), message: "A real Commander can quote this marker.", images: [] } });
  assert.equal(proven.role, "background_notification"); assert.equal(proven.text, "A real Commander can quote this marker.");
  assert.equal(proven.delivery.state, "delivered");
});

test("new user identity does not rewrite literal marker text and keeps canonical image references", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "input-view-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const inputId = "client-stable"; const text = "First line\nSecond line\n\n<!-- persistent-harness-input:literal -->";
  const entry = { type: "message", id: "pi-entry", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", id: inputId, content: [{ type: "text", text }, { type: "image", data: PNG, mimeType: "image/png" }] } };
  const sessionFile = path.join(directory, "session.jsonl");
  await writeFile(sessionFile, [ { type: "session", id: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z" }, entry ].map(JSON.stringify).join("\n") + "\n");
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (id) => id === inputId ? receipt(id) : null });
  const visible = await reader.read({ sessionFile, sessionId: "session", publicView: true });
  assert.equal(visible.messages[0].id, inputId); assert.equal(visible.messages[0].entryId, "pi-entry");
  assert.equal(visible.messages[0].text, text); assert.equal(visible.messages[0].clientMessageId, "client-proof");
  assert.equal(visible.messages[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(visible.messages[0].delivery.deliveredAt, "2026-01-01T00:00:01.000Z");
  assert.equal((await reader.readImage({ sessionFile, sessionId: "session", entryId: "pi-entry", index: 0 })).data, PNG);
  const pending = pendingInputMessage({ ...receipt(inputId), message: text, images: [{ type: "image", mimeType: "image/png", data: PNG }] });
  assert.deepEqual(pending.images[0].ref, { entryId: inputId, index: 0 });
  assert.equal(pending.images[0].mimeType, "image/png");
  assert.equal(pending.images[0].size, Buffer.from(PNG, "base64").length);
});

test("custom background and cron entries retain explicit non-Commander provenance", () => {
  for (const source of ["background", "cron"]) {
    const input = { ...receipt(`internal-${source}`, source), message: "Background process completed.",
      origin: { jobId: "job", ...(source === "cron" ? { runId: "run" } : {}) } };
    const payload = actorInputCustomPayload(input);
    assert.match(payload.content, /internal harness event, not a new Commander submission/);
    const visible = projectVisibleMessage({ type: "custom_message", id: "canonical", timestamp: "2026-01-01T00:00:01.000Z", ...payload }, { sessionId: "session", inputReceipt: input });
    assert.equal(visible.role, source === "background" ? "background_notification" : "scheduled_job");
    assert.equal(visible.inputId, input.inputId); assert.equal(visible.delivery.state, "delivered");
  }
});

test("retrying a later text item stops at its internal input, never an older user prompt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "input-retry-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  const input = { ...receipt("background-input", "background"), message: "Completed process details.", origin: { jobId: "job" } };
  const entries = [ { type: "session", id: "session", version: 3, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "old-user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Unrelated earlier request." } },
    { type: "custom_message", id: "internal", parentId: "old-user", timestamp: "2026-01-01T00:00:01.000Z", ...actorInputCustomPayload(input) },
    { type: "message", id: "answer", parentId: "internal", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", timestamp: acceptedAt + 2000,
      content: [{ type: "text", text: "First reply.", textSignature: JSON.stringify({ v: 1, id: "first" }) },
        { type: "text", text: "Later reply.", textSignature: JSON.stringify({ v: 1, id: "later" }) }] } } ];
  await writeFile(sessionFile, entries.map(JSON.stringify).join("\n") + "\n");
  const reader = new VisibleTranscriptReader(); const visible = await reader.read({ sessionFile, sessionId: "session", publicView: true });
  const later = visible.messages.find((message) => message.text === "Later reply.");
  assert.deepEqual(await reader.resolveRetryTurn({ sessionFile, sessionId: "session", assistantId: later.id }),
    { assistantId: "answer", userId: "internal", branchFromId: "old-user" });
});
