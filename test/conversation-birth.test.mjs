import assert from "node:assert/strict";
import test from "node:test";
import { ConversationBirthClock, ConversationOrder, conversationBirth } from "../src/conversation-birth.mjs";
import { createActorStreamPlanner } from "../src/actor-stream.mjs";
import { assistantTextPart, sortVisibleHistory } from "../src/conversation-projection.mjs";
import { projectProgressEntry, PROGRESS_ENTRY_TYPE } from "../src/progress-projection.mjs";
import { sanitizePresentationText } from "../src/presentation-directive.mjs";
import { LiveConversation } from "../src/live-conversation.mjs";
import { toWorkerRpcEvent } from "../src/sdk-worker.mjs";
const at = "2026-01-01T23:59:10.000Z";
const stamp = sequence => ({ version: 1, createdAt: at, sequence });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function fixture({ root = false, content = [{ type: "text", text: "ahead" }] } = {}) {
  const clock = new ConversationBirthClock([], { now: () => at });
  const raw = { role: "assistant", id: "segment", api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, usage, content, stopReason: "pending" };
  const planner = createActorStreamPlanner({ message: { ...raw, content: [] }, createMessageId: ({ segmentIndex }) => `segment-${segmentIndex}`,
    createTextId: ({ sourceIndex }) => `core-${sourceIndex}`, createTextBirth: text => (root ? sanitizePresentationText(text).text : text).trim() ? clock.next() : undefined });
  const emit = (type, index = 0, extra = {}, proof = null) => planner.consume({ type, contentIndex: index, partial: raw, ...extra }, proof);
  const end = () => { raw.stopReason = "stop"; return planner.consume({ type: "done", reason: "stop", message: raw }).final; };
  const prepare = (plan, message = structuredClone(plan.message)) => planner.prepareCommit({ planId: plan.planId, message });
  emit("start"); return { clock, raw, planner, emit, end, prepare };
}
test("birth schema is exact and bounded; canonical text/progress retain IDs and legacy fallback", () => {
  assert.deepEqual(conversationBirth(stamp(1)), stamp(1));
  for (const bad of [null, [], {}, { ...stamp(1), version: 2 }, { ...stamp(1), sequence: 0 }, { ...stamp(1), sequence: 1.5 },
    { ...stamp(1), sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...stamp(1), createdAt: "yesterday" }, { ...stamp(1), extra: true }]) assert.equal(conversationBirth(bad), undefined);
  const message = { role: "assistant", id: "segment", timestamp: 1, content: [{ type: "text", id: "core", text: "same" }] };
  const legacy = assistantTextPart(message, 0); message.content[0].harnessBirth = stamp(4);
  const born = assistantTextPart(message, 0); assert.equal(born.id, legacy.id); assert.equal(born.createdAt, at); assert.equal(born.timelineSequence, 4);
  message.content[0].harnessBirth = { ...stamp(1), version: 2 }; assert.deepEqual(assistantTextPart(message, 0), legacy);
  assert.deepEqual(projectProgressEntry({ type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p", timestamp: new Date(1).toISOString(), data: { summary: "Checking", harnessBirth: stamp(3) } }),
    { kind: "progress", id: "p", summary: "Checking", createdAt: at, timelineSequence: 3 });
});
test("empty starts and ahead-of-event provider partials do not predate interleaved progress", () => {
  const f = fixture({ content: [{ type: "text", text: "A", harnessBirth: stamp(800) }, { type: "text", text: "B" }] });
  assert.equal(f.emit("text_start").update.message.content[0].harnessBirth, undefined); assert.equal(f.clock.sequence, 0);
  const p = f.clock.next(); const a = f.emit("text_delta", 0, { delta: "A", harnessBirth: stamp(999) }).update;
  assert.equal(a.message.content[1].harnessBirth, undefined); assert.deepEqual(a.message.content[0].harnessBirth, stamp(2));
  f.emit("text_start", 1); const q = f.clock.next(); const b = f.emit("text_delta", 1, { delta: "B" }).update;
  assert.deepEqual([p.sequence, a.message.content[0].harnessBirth.sequence, q.sequence, b.message.content[1].harnessBirth.sequence], [1, 2, 3, 4]);
  const wire = toWorkerRpcEvent({ type: "message_update", ...a });
  assert.deepEqual(wire.assistantMessageEvent.harnessBirth, stamp(2)); assert.equal(wire.message, undefined); assert.equal(wire.assistantMessageEvent.partial, undefined);
  f.emit("text_end", 0, { content: "A" }); f.emit("text_end", 1, { content: "B" });
  const prepared = f.prepare(f.end()); assert.deepEqual(prepared.message.content.map(p => p.harnessBirth), [stamp(2), stamp(4)]);
  assert.doesNotThrow(() => f.planner.acknowledge({ planId: prepared.planId, entryId: "committed", message: prepared.message }));
});
test("root reserved/whitespace text is born only when public; child text is not scrubbed", () => {
  const hidden = "<!-- harness.presentation.v1 body=happy face=smile -->\n  ";
  const f = fixture({ root: true }); f.emit("text_start");
  for (const delta of ["<", hidden.slice(1)]) { const step = f.emit("text_delta", 0, { delta }); assert.equal(step.update.message.content[0].harnessBirth, undefined); }
  assert.equal(f.clock.sequence, 0); f.clock.next();
  const visible = f.emit("text_delta", 0, { delta: "Visible" }); assert.deepEqual(visible.update.message.content[0].harnessBirth, stamp(2));
  const child = fixture(); child.emit("text_start"); assert.deepEqual(child.emit("text_delta", 0, { delta: hidden }).update.message.content[0].harnessBirth, stamp(1));
});
test("terminal-only hook text is stamped after validation; omission restores and explicit metadata forgery rejects", () => {
  const f = fixture({ content: [{ type: "text", text: "  ", harnessBirth: stamp(900) }] });
  const plan = f.end(); assert.equal(plan.message.content[0].harnessBirth, undefined);
  f.clock.next(); const replacement = structuredClone(plan.message); replacement.content[0].text = "Hook text";
  assert.deepEqual(f.prepare(plan, replacement).message.content[0].harnessBirth, stamp(2));
  const hidden = fixture(); const h = hidden.end(), removed = structuredClone(h.message); removed.content[0].text = "";
  assert.equal(hidden.prepare(h, removed).message.content[0].harnessBirth, undefined);
  for (const conflict of ["birth", "other"]) {
    const bad = fixture(); bad.emit("text_start"); bad.emit("text_delta", 0, { delta: "ahead" }); const p = bad.end(), edited = structuredClone(p.message);
    if (conflict === "birth") edited.content[0].harnessBirth = stamp(999); else edited.content[0].invented = true;
    assert.throws(() => bad.prepare(p, edited), { code: "ERR_STREAM_PROTECTED_TEXT_METADATA" });
  }
  const omitted = fixture(); omitted.emit("text_start"); omitted.emit("text_delta", 0, { delta: "ahead" }); const p = omitted.end(), edited = structuredClone(p.message);
  delete edited.content[0].harnessBirth; assert.deepEqual(omitted.prepare(p, edited).message.content[0].harnessBirth, stamp(1));
  const forgery = fixture(); const fp = forgery.end(), fm = structuredClone(fp.message); fm.content[0].harnessBirth = stamp(1);
  assert.throws(() => forgery.prepare(fp, fm), { code: "ERR_STREAM_PROTECTED_TEXT_METADATA" });
});
test("native prefix/remainder and exact acknowledgments keep each core text birth", () => {
  const call = { type: "toolCall", id: "call|item", providerCallId: "call", providerItemId: "item", name: "fixture", arguments: {}, async: true };
  const f = fixture({ content: [{ type: "text", text: "A" }, call, { type: "text", text: "B" }] });
  f.emit("text_start", 0); f.emit("text_delta", 0, { delta: "A" }); f.emit("text_end", 0, { content: "A" });
  f.emit("toolcall_start", 1); f.clock.next(); f.emit("text_start", 2); f.emit("text_delta", 2, { delta: "B" });
  const prefix = f.emit("toolcall_end", 1, { toolCall: call }, { native: true, complete: true, responseId: "response", itemId: "item", callId: "call", call }).prefix;
  const prepared = f.prepare(prefix); const ack = f.planner.acknowledge({ planId: prefix.planId, entryId: "prefix", message: prepared.message });
  assert.deepEqual(ack.remainder.content[0].harnessBirth, stamp(3)); assert.equal(ack.remainder.content[0].id, "core-2");
  f.emit("text_end", 2, { content: "B" }); const final = f.prepare(f.end());
  assert.deepEqual(final.message.content[0].harnessBirth, stamp(3)); assert.equal(final.message.content[0].id, "core-2");
  const changed = structuredClone(final.message); changed.content[0].harnessBirth.sequence++;
  assert.throws(() => f.planner.acknowledge({ planId: final.planId, entryId: "bad", message: changed }), { code: "ERR_STREAM_COMMIT_MISMATCH" });
});
test("restart/fork seed only active canonical ancestry, tolerate malformed metadata, and preserve compaction ancestry", () => {
  const text = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "A", harnessBirth: stamp(4) }] } };
  const progress = { type: "custom", customType: PROGRESS_ENTRY_TYPE, data: { harnessBirth: stamp(8) } };
  const malformed = { ...progress, data: { harnessBirth: { ...stamp(800), version: 2 } } };
  const clock = new ConversationBirthClock([text, progress, malformed, { type: "compaction" }], { now: () => at });
  assert.deepEqual(clock.next(), stamp(9));
  clock.reset([text]); assert.deepEqual(clock.next(), stamp(5));
  const fork = new ConversationBirthClock(JSON.parse(JSON.stringify([text, progress])), { now: () => at }); assert.deepEqual(fork.next(), stamp(9));
});
test("equal-millisecond reverse arrival uses birth sequence; unstamped ties remain stable before stamped rows", () => {
  const row = (id, sequence) => ({ kind: "message", id, message: { id, createdAt: at, ...(sequence ? { timelineSequence: sequence } : {}) } });
  const a = row("a", 2), p = { kind: "progress", id: "p", createdAt: at, timelineSequence: 1 };
  assert.deepEqual(sortVisibleHistory([a, row("receipt"), row("legacy"), p]).map(r => r.id), ["receipt", "legacy", "p", "a"]);
});
test("live empty placeholders upgrade; conflicts reject only ordering, including after reconciliation", () => {
  const live = new LiveConversation(); const old = new Date(1).toISOString();
  const update = (type, fields = {}) => ({ type: "message_update", messageId: "a", createdAt: old, assistantMessageEvent: { type, delta: "Text" }, ...fields });
  live.accept(update("text_start")); live.accept(update("text_delta", { createdAt: at, timelineSequence: 2 }));
  live.accept({ type: "message_end", message: { role: "assistant", content: [{ type: "text", id: "a", createdAt: old, timelineSequence: 9, text: "Completed" }] } });
  assert.deepEqual(live.snapshot().map(r => [r.text, r.createdAt, r.timelineSequence]), [["Completed", at, 2]]);
  live.reconcile(new Set(["a"])); assert.equal(live.snapshot().length, 0);
  const normalized = live.accept(update("text_delta", { timelineSequence: 99 }));
  assert.equal(normalized.createdAt, at); assert.equal(normalized.timelineSequence, 2); assert.equal(live.snapshot()[0].text, "Text");
  const order = new ConversationOrder(); order.keep({ id: "p", createdAt: at, timelineSequence: 1 });
  assert.equal(order.keep({ id: "p", createdAt: old, timelineSequence: 90 }).createdAt, at);
});
