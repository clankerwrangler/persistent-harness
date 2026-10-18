import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actorInputCustomPayload } from "../src/extension.mjs";
import { projectVisibleMessage, pendingInputMessage } from "../src/conversation-projection.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { normalizeInputImages } from "../src/input-images.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A complete 1x1 grayscale JPEG with one constant block.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA//9k=";
const acceptedAt = Date.parse("2026-01-01T00:00:00.000Z");
const receipt = (inputId, source = "user") => ({ inputId, sessionId: "session", source, origin: source === "user" ? null : { jobId: "bg-proof" },
  acceptedAt, clientMessageId: "client-proof", delivery: { state: "accepted", inputId,
    acceptedAt: new Date(acceptedAt).toISOString(), deliveredAt: null } });

test("a receipt, not body or marker text, supplies legacy input provenance", () => {
  const inputId = "background-completion-bg-000000000001";
  const text = `A real user can quote this marker.\n\n<!-- persistent-harness-input:${inputId} -->`;
  const entry = { type: "message", id: "canonical", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text } };
  assert.equal(projectVisibleMessage(entry).role, "user"); assert.equal(projectVisibleMessage(entry).text, text);
  const proven = projectVisibleMessage(entry, { sessionId: "session", canonicalEntries: [entry], inputReceipt: { ...receipt(inputId, "background"), message: "A real user can quote this marker.", images: [] } });
  assert.equal(proven.role, "background_notification"); assert.equal(proven.text, "A real user can quote this marker.");
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
  assert.equal(visible.messages[0].createdAt, "2026-01-01T00:00:01.000Z");
  assert.equal(visible.messages[0].delivery.deliveredAt, "2026-01-01T00:00:01.000Z");
  assert.equal((await reader.readImage({ sessionFile, sessionId: "session", entryId: "pi-entry", index: 0 })).data, PNG);
  const pending = pendingInputMessage({ ...receipt(inputId), message: text, images: [{ type: "image", mimeType: "image/png", data: PNG }] });
  assert.deepEqual(pending.images[0].ref, { entryId: inputId, index: 0 });
  assert.equal(pending.images[0].mimeType, "image/png");
  assert.equal(pending.images[0].size, Buffer.from(PNG, "base64").length);
  const expectedHash = createHash("sha256").update("image/png\0").update(PNG, "base64").digest("hex");
  assert.equal(pending.images[0].contentHash, expectedHash);
  assert.equal(visible.messages[0].images[0].contentHash, expectedHash, "entry-reference changes do not change content identity");
  const replacement = Buffer.from(PNG, "base64"); replacement[replacement.length - 1] ^= 1;
  const changed = pendingInputMessage({ ...receipt(inputId), images: [{ type: "image", mimeType: "image/png", data: replacement.toString("base64") }] });
  assert.equal(changed.images[0].size, pending.images[0].size);
  assert.notEqual(changed.images[0].contentHash, expectedHash, "content identity distinguishes equal-size bytes");
  assert.equal(projectVisibleMessage(entry).images[0].contentHash, undefined, "inline images do not add reference metadata");
});

test("custom background and cron entries retain explicit non-user provenance", () => {
  for (const source of ["background", "cron"]) {
    const input = { ...receipt(`internal-${source}`, source), message: "Background process completed.",
      origin: { jobId: "job", ...(source === "cron" ? { runId: "run" } : {}) } };
    const payload = actorInputCustomPayload(input);
    assert.match(payload.content, /internal harness event, not a new user submission/);
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

test("visible image metadata preserves names, order, references, and input values across projection roles", () => {
  const png = { type: "image", data: PNG, mimeType: "image/png" };
  const jpeg = { type: "image", data: JPEG, mimeType: "image/jpeg" };
  for (const images of [[png, jpeg], [jpeg, png]]) {
    const content = [{ type: "text", text: "before" },
      ...images.map(image => ({ ...image, name: "caller name", size: -1, ref: { index: 99 }, contentHash: "caller hash" })),
      { type: "text", text: "after" }];
    const entries = [
      { type: "message", id: "user", message: { role: "user", content } },
      ...["background", "cron"].map(source => ({ type: "custom_message", id: source,
        timestamp: "2026-01-01T00:00:01.000Z",
        ...actorInputCustomPayload({ ...receipt(source, source), message: "internal", images,
          origin: { jobId: "job", runId: "run" } }), content })),
      { type: "message", id: "tool", message: { role: "toolResult", content } },
    ];
    for (const entry of entries) for (const imageReferences of [false, true]) {
      const original = structuredClone(entry);
      const tool = entry.id === "tool";
      if (tool) assert.equal(projectVisibleMessage(entry), undefined, "tool images still require authorization");
      const visible = projectVisibleMessage(entry, { imageReferences, allowToolImages: tool });
      assert.equal(visible.text, tool ? "" : "beforeafter");
      assert.equal(visible.role, tool ? "tool_output" : entry.id === "cron" ? "scheduled_job"
        : entry.id === "background" ? "background_notification" : "user");
      const expected = images.map((image, index) => ({ type: "image", mimeType: image.mimeType,
        name: `${tool ? "Output" : "Pasted"} image ${index + 1}`, size: Buffer.from(image.data, "base64").length,
        ...(imageReferences ? { ref: { entryId: entry.id, index },
          contentHash: createHash("sha256").update(image.mimeType).update("\0").update(image.data, "base64").digest("hex") }
          : { data: image.data }) }));
      assert.deepEqual(visible.images, expected);
      for (let i = 0; i < expected.length; i += 1) assert.deepEqual(Object.keys(visible.images[i]), Object.keys(expected[i]));
      assert.deepEqual(entry, original, "projection must not rewrite caller metadata or input content");
    }
  }
});

test("visible image metadata reuse retains validation and hides the whole invalid image set", () => {
  const image = { type: "image", data: PNG, mimeType: "image/png" };
  const png = (width, height, depth = 8) => {
    const bytes = Buffer.from(PNG, "base64"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    bytes[24] = depth; bytes[25] = 6; return bytes.toString("base64");
  };
  const padded = Buffer.alloc(2 * 1024 * 1024); Buffer.from(PNG, "base64").copy(padded);
  for (const [name, images, error] of [
    ["count", Array(5).fill(image), /at most 4/],
    ["MIME", [{ ...image, mimeType: "image/gif" }], /mimeType/],
    ["base64 syntax", [{ ...image, data: "!png" }], /canonical base64/],
    ["base64 pad bits", [{ ...image, data: "AB==" }], /canonical base64/],
    ["encoded bound", [{ ...image, data: "A".repeat(4 * 1024 * 1024 + 4) }], /bounded/],
    ["total bytes", Array(2).fill({ ...image, data: padded.toString("base64") }), /byte total limit/],
    ["PNG container", [{ ...image, data: "AA==" }], /container/],
    ["JPEG container", [{ ...image, mimeType: "image/jpeg" }], /container/],
    ["zero dimension", [{ ...image, data: png(0, 1) }], /oversized/],
    ["dimension bound", [{ ...image, data: png(8193, 1) }], /oversized/],
    ["pixel bound", [{ ...image, data: png(4096, 4096) }], /oversized/],
    ["decoded bound", [{ ...image, data: png(4096, 2100, 16) }], /oversized/],
    ["mixed invalid", [image, { ...image, data: "AA==" }], /container/],
  ]) {
    assert.throws(() => normalizeInputImages(images), error, name);
    const content = [{ type: "text", text: "kept" }, ...images];
    const original = structuredClone(content);
    for (const role of ["user", "toolResult"]) for (const imageReferences of [false, true]) {
      const visible = projectVisibleMessage({ type: "message", id: "invalid", message: { role, content } },
        { imageReferences, allowToolImages: true });
      if (role === "toolResult") assert.equal(visible, undefined, name);
      else { assert.equal(visible.text, "kept", name); assert.equal(Object.hasOwn(visible, "images"), false, name); }
    }
    assert.deepEqual(content, original, name);
  }
});
