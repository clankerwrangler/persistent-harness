import assert from "node:assert/strict";
import test from "node:test";
import { RootOutputProjector, parseRootOutputCursor } from "../src/root-output-projector.mjs";

const root = (id) => ({ sessionId: id, kind: "root", depth: 0 });
const child = { sessionId: "child", kind: "child", depth: 1 };
function accept(projector, session, actorGeneration, actorEventSeq, event) {
  return projector.accept({ session, actorGeneration, actorEventSeq, event });
}

test("authoritative registry filter includes concurrent roots and excludes children and private events", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  projector.subscribe();
  const seen = []; projector.on("event", (frame) => seen.push(frame));
  accept(projector, root("A"), 3, 1, { type: "agent_start" });
  accept(projector, root("B"), 5, 1, { type: "agent_start" });
  accept(projector, child, 2, 1, { type: "agent_start" });
  accept(projector, root("A"), 3, 2, { type: "message_start", message: { role: "assistant" } });
  accept(projector, root("A"), 3, 3, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "secret" } });
  accept(projector, root("A"), 3, 4, { type: "tool_execution_update", privateToolArguments: "secret" });
  accept(projector, root("A"), 3, 5, { type: "progress_entry", summary: "private-adjacent" });
  accept(projector, root("A"), 3, 6, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Ready. " } });
  assert.deepEqual(seen.map((frame) => [frame.event.type, frame.event.sessionId]), [
    ["turn_start", "A"], ["turn_start", "B"], ["text_delta", "A"],
  ]);
  assert.doesNotMatch(JSON.stringify(seen), /secret|private-adjacent|child/);
  assert.equal(seen[0].event.turnId, "A:g3:t1");
  assert.equal(seen[1].event.turnId, "B:g5:t1");
});

test("text deltas are emitted early with stable message/content sequencing before terminal", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  projector.subscribe();
  accept(projector, root("A"), 1, 10, { type: "agent_start" });
  accept(projector, root("A"), 1, 11, { type: "message_start", message: { role: "assistant" } });
  const first = accept(projector, root("A"), 1, 12, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First sentence. " } });
  const second = accept(projector, root("A"), 1, 13, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second" } });
  assert.equal(first[0].event.type, "text_delta"); assert.equal(first[0].event.deltaSeq, 1);
  assert.equal(first[0].event.messageIndex, 1); assert.equal(first[0].event.contentIndex, 0);
  assert.equal(second[0].event.deltaSeq, 2);
  const terminal = accept(projector, root("A"), 1, 14, { type: "message_end", message: { role: "assistant", stopReason: "stop", id: "message-1", timestamp: 7, content: [{ type: "text", text: "First sentence. Second" }] } });
  assert.deepEqual(terminal[0].event, { type: "assistant_terminal", messageIndex: 1, status: "complete", stopReason: "stop", text: "First sentence. Second",
    presentation: { schema: "taihou.presentation.v1", body: "talk-01", face: "common" },
    messageId: "message-1", timestamp: 7, sessionId: "A", turnId: "A:g1:t10", actorGeneration: 1 });
  const settled = accept(projector, root("A"), 1, 15, { type: "agent_settled" });
  assert.equal(settled[0].event.status, "settled");
});

test("missing content index and truncated terminal fail the turn closed", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  assert.deepEqual(accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "unsafe" } }), []);
  const truncated = accept(projector, root("A"), 1, 3, { type: "message_end", truncated: true });
  assert.equal(truncated[0].event.status, "truncated"); assert.equal("text" in truncated[0].event, false);
  const settled = accept(projector, root("A"), 1, 4, { type: "agent_settled" });
  assert.equal(settled[0].event.status, "failed");
});

test("bounded replay is ordered and reports cursor generation gaps without snapshots", () => {
  const projector = new RootOutputProjector({ generation: "generation-a", maxEvents: 3, maxBytes: 4096 });
  projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" }); // 1, eventually evicted
  accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "one. " } }); // 2
  accept(projector, root("A"), 1, 3, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two. " } }); // 3
  accept(projector, root("A"), 1, 4, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "one. two." }] } }); // 4
  assert.equal(projector.oldestSeq, 2);
  assert.deepEqual(projector.subscribe(null), { generation: "generation-a", cursor: 4, oldestSeq: 2, gap: false, events: [] });
  assert.deepEqual(projector.subscribe({ generation: "generation-a", afterSeq: 2 }).events.map((frame) => frame.seq), [3, 4]);
  assert.equal(projector.subscribe({ generation: "generation-a", afterSeq: 0 }).gapReason, "replay_overrun");
  assert.equal(projector.subscribe({ generation: "generation-b", afterSeq: 4 }).gapReason, "generation_mismatch");
  assert.equal(projector.subscribe({ generation: "generation-a", afterSeq: 99 }).gapReason, "invalid_cursor");
  assert.equal(projector.subscribe({ invalid: true }).gapReason, "invalid_cursor");
  const oversized = new RootOutputProjector({ generation: "generation-z", maxEvents: 2, maxBytes: 1024 });
  oversized.subscribe();
  accept(oversized, root("Z"), 1, 1, { type: "agent_start" });
  accept(oversized, root("Z"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(2000) } });
  assert.equal(oversized.oldestSeq, null);
  assert.equal(oversized.subscribe({ generation: "generation-z", afterSeq: 1 }).gapReason, "replay_overrun");
});

test("cursor parser and replay identifiers support exact SSE dedupe", () => {
  assert.deepEqual(parseRootOutputCursor("generation-a:42"), { generation: "generation-a", afterSeq: 42 });
  assert.equal(parseRootOutputCursor(null), null);
  assert.deepEqual(parseRootOutputCursor("bad"), { invalid: true });
  assert.deepEqual(parseRootOutputCursor("generation-a:-1"), { invalid: true });
});

test("actor exit and a superseding start produce explicit turn terminals", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  const superseded = accept(projector, root("A"), 1, 2, { type: "agent_start" });
  assert.deepEqual(superseded.map((frame) => [frame.event.type, frame.event.status]), [["turn_terminal", "superseded"], ["turn_start", undefined]]);
  const exited = projector.failSession("A", 1, "unexpected_exit");
  assert.equal(exited.event.status, "actor_exit"); assert.equal(exited.event.reason, "unexpected_exit");
});


test("inactive session failure clears tracked state without publishing a stale terminal", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: {
    type: "text_delta", contentIndex: 0, delta: "Before exit." } });
  assert.equal(projector.failSession("A", 1, "unexpected_exit"), undefined);
  assert.equal(projector.cursor, 0); assert.equal(projector.active, false);
  projector.subscribe();
  const replacement = accept(projector, root("A"), 2, 1, { type: "agent_start" });
  assert.deepEqual(replacement.map((frame) => [frame.event.type, frame.event.status]), [["turn_start", undefined]]);
});

test("mid-turn activation counts pre-subscription visible deltas and defers the full message to terminal", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  const marker = "<!-- taihou.presentation.v1 body=happy face=smile -->\n";
  assert.deepEqual(accept(projector, root("A"), 1, 1, { type: "agent_start" }), []);
  accept(projector, root("A"), 1, 2, { type: "message_start", message: { role: "assistant" } });
  accept(projector, root("A"), 1, 3, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0,
    delta: `${marker}Before subscription. ` } });
  assert.equal(projector.cursor, 0); assert.equal(projector.active, false);
  projector.subscribe();
  const live = accept(projector, root("A"), 1, 4, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "After." } });
  assert.equal(projector.cursor, 1); assert.equal(projector.active, true);
  assert.equal(live[0].event.delta, "After."); assert.equal(live[0].event.deltaSeq, 2);
  assert.equal("presentation" in live[0].event, false);
  const terminal = accept(projector, root("A"), 1, 5, { type: "message_end", message: { role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: `${marker}Before subscription. After.` }] } });
  assert.equal(terminal[0].event.text, "Before subscription. After.");
  assert.deepEqual(terminal[0].event.presentation, { schema: "taihou.presentation.v1", body: "happy", face: "smile" });
});

test("marker-only pre-subscription parsing keeps the first visible live delta cue-bearing", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" });
  const marker = "<!-- taihou.presentation.v1 body=happy face=smile -->\n";
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  accept(projector, root("A"), 1, 2, { type: "message_start", message: { role: "assistant" } });
  for (let index = 0; index < marker.length; index += 1) {
    assert.deepEqual(accept(projector, root("A"), 1, 3 + index, { type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: marker[index] } }), []);
  }
  projector.subscribe();
  const live = accept(projector, root("A"), 1, 100, { type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Visible." } });
  assert.equal(live[0].event.deltaSeq, 1); assert.equal(live[0].event.delta, "Visible.");
  assert.deepEqual(live[0].event.presentation, { schema: "taihou.presentation.v1", body: "happy", face: "smile" });
});

test("stale lower actor generation cannot supersede a newer active turn", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" }); projector.subscribe();
  accept(projector, root("A"), 9, 1, { type: "agent_start" });
  assert.deepEqual(accept(projector, root("A"), 8, 99, { type: "agent_start" }), []);
  const delta = accept(projector, root("A"), 9, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Current." } });
  assert.equal(delta[0].event.turnId, "A:g9:t1");
});

test("multi-root replay preserves global interleaving", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" }); projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  accept(projector, root("B"), 2, 1, { type: "agent_start" });
  accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A." } });
  accept(projector, root("B"), 2, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "B." } });
  assert.deepEqual(projector.subscribe({ generation: "generation-a", afterSeq: 0 }).events.map((frame) => [frame.seq, frame.event.sessionId]), [[1, "A"], [2, "B"], [3, "A"], [4, "B"]]);
});

test("cursor parser rejects adversarial generation shapes and lengths", () => {
  for (const value of [" bad:1", "bad/generation:1", `${"g".repeat(129)}:1`, "g:01", "g:9007199254740992", "g:1:2", "g:\n:1"]) {
    assert.deepEqual(parseRootOutputCursor(value), { invalid: true }, value);
  }
  assert.deepEqual(parseRootOutputCursor(`${"g".repeat(128)}:0`), { generation: "g".repeat(128), afterSeq: 0 });
});


test("presentation metadata precedes visible text, appears only on first sanitized delta, and repeats on terminal", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" }); projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  accept(projector, root("A"), 1, 2, { type: "message_start", message: { role: "assistant" } });
  const marker = "<!-- taihou.presentation.v1 body=encourage face=smile -->\n";
  let output = [];
  for (let index = 0; index < marker.length; index += 1) {
    output.push(...accept(projector, root("A"), 1, 3 + index, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: marker[index] } }));
  }
  assert.deepEqual(output, []);
  const first = accept(projector, root("A"), 1, 100, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Visible " } });
  const later = accept(projector, root("A"), 1, 101, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "text." } });
  assert.deepEqual(first[0].event.presentation, { schema: "taihou.presentation.v1", body: "encourage", face: "smile" });
  assert.equal("presentation" in later[0].event, false);
  const terminal = accept(projector, root("A"), 1, 102, { type: "message_end", message: { role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: `${marker}Visible text.` }] } });
  assert.equal(terminal[0].event.text, "Visible text.");
  assert.deepEqual(terminal[0].event.presentation, first[0].event.presentation);
  assert.doesNotMatch(JSON.stringify(projector.subscribe({ generation: "generation-a", afterSeq: 0 }).events), /taihou\.presentation\.v1 body=/);
});

test("toolUse turns carry independent per-assistant-message cues and indices", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" }); projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  const run = (start, marker, text, stopReason) => {
    accept(projector, root("A"), 1, start, { type: "message_start", message: { role: "assistant" } });
    const delta = accept(projector, root("A"), 1, start + 1, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: marker + text } });
    const terminal = accept(projector, root("A"), 1, start + 2, { type: "message_end", message: { role: "assistant", stopReason,
      content: [{ type: "text", text: marker + text }] } });
    return { delta: delta[0].event, terminal: terminal[0].event };
  };
  const first = run(2, "<!-- taihou.presentation.v1 body=enquire face=think -->\n", "Checking.", "toolUse");
  accept(projector, root("A"), 1, 5, { type: "tool_execution_start", privateToolArguments: "never" });
  const second = run(6, "<!-- taihou.presentation.v1 body=happy face=happy -->\n", "Done.", "stop");
  assert.deepEqual([first.delta.messageIndex, second.delta.messageIndex], [1, 2]);
  assert.equal(first.delta.presentation.body, "enquire"); assert.equal(second.delta.presentation.body, "happy");
  assert.deepEqual(first.delta.presentation, first.terminal.presentation); assert.deepEqual(second.delta.presentation, second.terminal.presentation);
  assert.doesNotMatch(JSON.stringify(projector.subscribe({ generation: "generation-a", afterSeq: 0 }).events), /privateToolArguments|never/);
});

test("invalid, missing, and oversized reserved markers default without leakage", () => {
  for (const [id, streamed, final, expected] of [
    ["invalid", "<!-- taihou.presentation.v1 body=IK_living01_idle01 face=smile -->\nSafe.", "<!-- taihou.presentation.v1 body=IK_living01_idle01 face=smile -->\nSafe.", "Safe."],
    ["missing", "Ordinary prose.", "Ordinary prose.", "Ordinary prose."],
    ["oversized", `<!-- taihou.presentation.v1 ${"x".repeat(300)}\nTail.`, `<!-- taihou.presentation.v1 ${"x".repeat(300)}\nTail.`, "Tail."],
  ]) {
    const projector = new RootOutputProjector({ generation: `generation-${id}` }); projector.subscribe();
    accept(projector, root(id), 1, 1, { type: "agent_start" });
    const frames = accept(projector, root(id), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: streamed } });
    assert.equal(frames[0].event.delta, expected); assert.equal(frames[0].event.presentation.body, "talk-01");
    const terminal = accept(projector, root(id), 1, 3, { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: final }] } });
    assert.equal(terminal[0].event.text, expected); assert.doesNotMatch(JSON.stringify([...frames, ...terminal]), /IK_living|taihou\.presentation\.v1 body=|x{20}/);
  }
});

test("terminal presentation mismatch fails the message and turn closed", () => {
  const projector = new RootOutputProjector({ generation: "generation-a" }); projector.subscribe();
  accept(projector, root("A"), 1, 1, { type: "agent_start" });
  accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0,
    delta: "<!-- taihou.presentation.v1 body=happy face=smile -->\nStreamed." } });
  const terminal = accept(projector, root("A"), 1, 3, { type: "message_end", message: { role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: "<!-- taihou.presentation.v1 body=sad face=shame -->\nStreamed." }] } });
  assert.deepEqual(terminal[0].event.status, "truncated"); assert.equal("text" in terminal[0].event, false);
  const settled = accept(projector, root("A"), 1, 4, { type: "agent_settled" });
  assert.equal(settled[0].event.status, "failed"); assert.equal(settled[0].event.reason, "assistant_terminal_failed");
  assert.doesNotMatch(JSON.stringify(terminal), /body=sad|body=happy|taihou\.presentation/);
});


test("root live and terminal projections scrub hostile reserved lines at every stream split", () => {
  const cue = "<!-- taihou.presentation.v1 body=happy face=smile -->\n";
  const source = `${cue}Before.\n  <!-- taihou.presentation.v1 body=sad face=shame -->\n` +
    "<!-- taihou.presentation.v1 face=think body=talk-02 -->\n" +
    "<!-- taihou.presentation.v1 body=yandere face=shy -->\n" +
    `<!-- taihou.presentation.v1 ${"q".repeat(400)}\nAfter.`;
  const expected = "Before.\nAfter.";
  for (let split = 0; split <= source.length; split += 1) {
    const projector = new RootOutputProjector({ generation: `g-${split}` }); projector.subscribe();
    accept(projector, root("A"), 1, 1, { type: "agent_start" });
    const emitted = [
      ...accept(projector, root("A"), 1, 2, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: source.slice(0, split) } }),
      ...accept(projector, root("A"), 1, 3, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: source.slice(split) } }),
    ].filter((frame) => frame.event.type === "text_delta");
    assert.equal(emitted.map((frame) => frame.event.delta).join(""), expected, `live split ${split}`);
    assert.deepEqual(emitted[0].event.presentation, { schema: "taihou.presentation.v1", body: "happy", face: "smile" });
    assert(emitted.slice(1).every((frame) => !("presentation" in frame.event)));
    const terminal = accept(projector, root("A"), 1, 4, { type: "message_end", message: { role: "assistant", stopReason: "stop",
      content: [{ type: "text", text: source }] } });
    assert.equal(terminal[0].event.text, expected, `terminal split ${split}`);
    assert.deepEqual(terminal[0].event.presentation, emitted[0].event.presentation);
    assert.doesNotMatch(JSON.stringify([...emitted, ...terminal]), /body=sad|body=yandere|q{20}|taihou\.presentation\.v1 body=/);
  }
});
