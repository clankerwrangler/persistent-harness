import assert from "node:assert/strict";
import test from "node:test";
import { getCanonicalContextStringCodeUnits, projectCanonicalSource, registerCanonicalSessionManager } from "../src/canonical-context.mjs";

function fixture(messages, { onMaterialize, expireAfterRead } = {}) {
  const entries = messages.map((message, index) => ({ type: "message", id: `e${index}`,
    parentId: index ? `e${index - 1}` : null, message }));
  let materializing = false, expired = false, reads = 0;
  const validate = () => { if (expired) throw new Error("source expired"); };
  const manager = {
    getRevision: () => ({ revision: 0, generation: 0 }), getEntryCount: () => entries.length,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getEntriesRange: (start, count) => structuredClone(entries.slice(start, start + count)),
    getEntry: id => structuredClone(entries.find(entry => entry.id === id)),
    buildSessionSource: () => ({ contextEntryIds: entries.map(entry => entry.id),
      contributions: entries.map(entry => ({ key: entry.id, sourceEntryId: entry.id, messageIndex: 0, role: entry.message.role })),
      read: index => { if (++reads === expireAfterRead) expired = true; return messages[index]; },
      validate, currentSystemMessage: () => undefined }),
  };
  registerCanonicalSessionManager(manager, { estimateContextTokens: values => {
    if (materializing) onMaterialize?.(values[0]);
    return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
  } });
  const { source } = projectCanonicalSource({ sessionManager: manager, mode: "ordinary" });
  materializing = true;
  return source;
}
const user = content => ({ role: "user", content, timestamp: 1 });

test("source materialization stays detached from the SDK, estimators and other returned views", () => {
  const messages = [user([{ type: "text", text: "first", extra: { value: 1 } }]), user("second")], captured = [];
  const source = fixture(messages, { onMaterialize: message => captured.push(message) });
  const first = source.readAll(), second = source.readAll();
  assert.deepEqual(first, messages);
  first[0].content[0].extra.value = 2; first.push(user("local"));
  captured[0].content[0].extra.value = 3;
  assert.equal(messages[0].content[0].extra.value, 1);
  assert.deepEqual(second, messages);
  assert.deepEqual(source.read(0), messages[0]);
});

test("source materialization counts the outer array slot in its aggregate string budget", () => {
  // A trusted estimator can retain or annotate its input. The final copy still
  // validates that result, including the surrounding readAll array's slot key.
  const text = "x".repeat(getCanonicalContextStringCodeUnits() - 24);
  const make = () => fixture([user("base")], { onMaterialize: message => { message.content = text; } });
  assert.equal(make().read(0).content.length, text.length);
  assert.throws(() => make().readAll(), { code: "ERR_CONTEXT_DATA_LIMIT" });
});

test("source materialization keeps the outer array depth in its aggregate budget", () => {
  let nested = "leaf";
  for (let i = 0; i < 63; i++) nested = { next: nested };
  const make = () => fixture([user("base")], { onMaterialize: message => { message.details = nested; } });
  assert(make().read(0).details);
  assert.throws(() => make().readAll(), { code: "ERR_CONTEXT_DATA_LIMIT" });
});

test("source materialization preserves empty views and rejects a source that expires during a read", () => {
  assert.deepEqual(fixture([]).readAll(), []);
  assert.throws(() => fixture([user("first"), user("second")], { expireAfterRead: 2 }).readAll(), /source expired/);
});
