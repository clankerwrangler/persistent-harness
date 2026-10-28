import assert from "node:assert/strict";
import test from "node:test";
import { formatMessageTime, renderMessageTimes } from "../src/message-time.mjs";

const zone = { timeZone: "Europe/Berlin" };
const at = Date.UTC(2026, 9, 28, 21, 16);
const minutes = n => n * 60 * 1000;

test("formats local wall-clock time with the zone name", () => {
  assert.equal(formatMessageTime(at, "Europe/Berlin"), "[Wed, 28 Oct 2026, 22:16 CET]");
  assert.equal(formatMessageTime(Date.UTC(2026, 6, 1, 6, 5), "Europe/Berlin"), "[Wed, 1 Jul 2026, 08:05 CEST]");
});

test("stamps user and custom messages without touching the originals", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: at },
    { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: at + 1 },
    { role: "custom", customType: "incoming", content: "from inbox", display: true, timestamp: at + minutes(1) },
    { role: "compactionSummary", summary: "s", timestamp: at },
  ];
  const before = structuredClone(messages);
  const rendered = renderMessageTimes(messages, zone);
  assert.deepEqual(messages, before);
  assert.deepEqual(rendered[0].content, [{ type: "text", text: "[Wed, 28 Oct 2026, 22:16 CET]" }, { type: "text", text: "hi" }]);
  assert.equal(rendered[1], messages[1]);
  assert.deepEqual(rendered[2].content, [{ type: "text", text: "[Wed, 28 Oct 2026, 22:17 CET]" }, { type: "text", text: "from inbox" }]);
  assert.equal(rendered[3], messages[3]);
  assert.deepEqual(renderMessageTimes(rendered, zone), rendered);
});

test("tool results are stamped only after a long quiet stretch", () => {
  const result = (time, text) => ({ role: "toolResult", toolCallId: text, content: [{ type: "text", text }], timestamp: time });
  const rendered = renderMessageTimes([
    { role: "user", content: "go", timestamp: at },
    result(at + minutes(5), "a"),
    result(at + minutes(16), "b"),
    result(at + minutes(20), "c"),
    result(at + minutes(31), "d"),
  ], zone);
  assert.deepEqual(rendered.slice(1).map(message => message.content.length), [1, 2, 1, 2]);
  assert.deepEqual(rendered[2].content, [{ type: "text", text: "b" }, { type: "text", text: "[Wed, 28 Oct 2026, 22:32 CET]" }]);
  assert.deepEqual(renderMessageTimes(rendered, zone), rendered);
});

test("messages without a usable timestamp pass through", () => {
  const message = { role: "user", content: "x" };
  assert.equal(renderMessageTimes([message], zone)[0], message);
});
