import assert from "node:assert/strict";
import test from "node:test";
import { extensionInternals, SHOWN_IMAGE_MIME } from "../src/extension.mjs";
import { projectVisibleMessage, toolResultImages } from "../src/conversation-projection.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("an image shown to the user only stays out of the model's content and is kept for display", () => {
  const result = { ok: true, outputs: [{ mime: { "text/plain": "{'fileName': 'card.png', 'shownTo': 'user only'}",
    [SHOWN_IMAGE_MIME]: { mimeType: "image/png", data: PNG, fileName: "card.png" } } }] };
  const { content, details } = extensionInternals.pythonToolResult(result);
  assert.equal(content.some((part) => part.type === "image"), false, "the model receives no pixels");
  assert.match(content.map((part) => part.text).join("\n"), /\[Image shown to Commander: card\.png\. It is not visible to you\.\]/);
  assert.deepEqual(details.shownImages, [{ type: "image", data: PNG, mimeType: "image/png", name: "card.png" }]);
  const entry = { type: "message", id: "e1", timestamp: "2026-10-27T18:00:00Z",
    message: { role: "toolResult", toolCallId: "c", toolName: "ipython", content, details, isError: false, timestamp: Date.parse("2026-10-27T18:00:00Z") } };
  assert.equal(toolResultImages(entry.message).length, 1);
  const visible = projectVisibleMessage(entry, { allowToolImages: true });
  assert.equal(visible.role, "tool_output"); assert.equal(visible.images.length, 1); assert.equal(visible.images[0].data, PNG);
});

test("an ordinary attachment still reaches the model, and unknown shown types are ignored", () => {
  const seen = extensionInternals.pythonToolResult({ ok: true, outputs: [{ mime: { "image/png": PNG } }] });
  assert.equal(seen.content.filter((part) => part.type === "image").length, 1); assert.equal(seen.details.shownImages, undefined);
  const odd = extensionInternals.pythonToolResult({ ok: true, outputs: [{ mime: { [SHOWN_IMAGE_MIME]: { mimeType: "text/html", data: "PGI+" } } }] });
  assert.equal(odd.details.shownImages, undefined); assert.equal(odd.content.some((part) => /shown to Commander/.test(part.text ?? "")), false);
});
