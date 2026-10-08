import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { assistantMessageParts } from "../src/conversation-projection.mjs";
import { slimFixture, until } from "./fixtures/slim-stream.mjs";

test("real slim RPC joins interleaved text deltas, item completion, and canonical history by start identity", { timeout: 90_000 }, async (t) => {
  const { client, sessionId, rawEvents, events, responses, requests, visible, send, item, done } = await slimFixture(t, "slim-rpc", ({ response, send, item }) => {
    for (const [index, value] of [[0, "A"], [1, "B"]]) {
      send(response, { type: "response.output_item.added", output_index: index, item: { ...item(index, ""), status: "in_progress", content: [] } });
      send(response, { type: "response.output_text.delta", output_index: index, content_index: 0, delta: value });
    }
    send(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "2" });
  });
  const finalIds = [];
  for (let turn = 0; turn < 2; turn += 1) {
    const rawOffset = rawEvents.length; const offset = events.length;
    await client.request("submit_input", { sessionId, message: `Turn ${turn + 1}`, behavior: "auto" });
    await until(() => events.slice(offset).filter((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta").length === 3, "all interleaved deltas");
    const start = rawEvents.slice(rawOffset).find((event) => event.type === "message_start" && event.message.role === "assistant");
    assert(start?.message.id, "The paired core supplies a stable assistant identity before deltas");
    const updates = rawEvents.slice(rawOffset).filter((event) => event.type === "message_update");
    assert(updates.length > 0); assert(updates.every((event) => !("message" in event) && !("partial" in event.assistantMessageEvent)), "Use actual slim RPC events, not cumulative test snapshots");
    const textStarts = updates.filter((event) => event.assistantMessageEvent.type === "text_start").map((event) => event.assistantMessageEvent);
    assert.deepEqual(textStarts.map((event) => event.contentIndex), [0, 1]);
    assert(textStarts.every((event) => typeof event.id === "string" && event.id.length > 0), "The successor supplies each real text item's identity on slim text_start");
    assert.equal(new Set(textStarts.map((event) => event.id)).size, 2, "Separate items have separate core-owned identities");
    const expected = assistantMessageParts({ type: "message", id: "prospective-entry", message: { ...start.message,
      content: [item(0, "A2"), item(1, "B")].map((part, index) => ({ type: "text", id: textStarts[index].id, text: part.content[0].text,
        textSignature: JSON.stringify({ v: 1, id: part.id, phase: part.phase }) })) } });
    const live = (await visible()).slice(-2);
    assert.deepEqual(live.map((row) => row.text), ["A2", "B"], "Updating the earlier item preserves the later open item");
    assert.deepEqual(live.map((row) => row.id), expected.map((row) => row.id), "Start, slim deltas, and final signatures use one canonical identity");
    const births = updates.filter(event => event.assistantMessageEvent.type === "text_delta").slice(0, 2).map(event => event.assistantMessageEvent.harnessBirth);
    assert(births.every(birth => birth?.version === 1));
    assert.deepEqual(live.map(row => row.createdAt), births.map(birth => birth.createdAt));
    assert.deepEqual(live.map(row => row.timelineSequence), births.map(birth => birth.sequence));
    const response = responses[turn]; done(response, 1, "B");
    await until(() => events.slice(offset).some((event) => event.assistantMessageEvent?.type === "text_end"), "second text item completion before response completion");
    assert.deepEqual((await visible()).slice(-2).map((row) => row.text), ["A2", "B"], "Slim text_end.content does not erase the completed item");
    done(response, 0, "A2");
    send(response, { type: "response.completed", response: { id: `response-${turn + 1}`, status: "completed", output: [item(0, "A2"), item(1, "B")],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    await until(() => events.slice(offset).some((event) => event.type === "agent_settled"), "settled response");
    const end = rawEvents.slice(rawOffset).find((event) => event.type === "message_end" && event.message.role === "assistant");
    assert.equal(end.message.id, start.message.id);
    const canonical = await client.request("get_actor_entries", { sessionId });
    const entry = canonical.entries.find((entry) => entry.type === "message" && entry.message?.id === start.message.id);
    assert(entry); const canonicalParts = assistantMessageParts(entry);
    assert.deepEqual(canonicalParts.map((row) => row.id), live.map((row) => row.id));
    finalIds.push(...canonicalParts.map((row) => row.id));
    const history = await visible();
    assert.deepEqual(history.map((row) => row.id), finalIds, "No provisional duplicate remains after canonical completion");
    assert.deepEqual((await visible()).map((row) => row.id), finalIds, "Repeated reload is idempotent");
    assert.equal(new Set(finalIds).size, finalIds.length, "Separate assistant messages stay distinct even if a provider reuses item IDs");
  }
  assert.equal(requests.length, 2);
});

test("real slim RPC keeps one text identity when an early native prefix rebases its open remainder", { timeout: 90_000 }, async (t) => {
  const callId = "rebase|fc_rebase";
  const code = 'from pathlib import Path\ncounter = Path("native-execute-count")\ncounter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else "1")\nprint("EARLY_PREFIX_TOOL_RESULT")';
  const call = { type: "function_call", id: "fc_rebase", call_id: "rebase", name: "ipython", arguments: JSON.stringify({ code }), async: true };
  const f = await slimFixture(t, "slim-rpc-rebase", ({ response, body, index, send, item, done }) => {
    assert.deepEqual(body.tools.map((tool) => tool.name), ["ipython", "wait_for_ipython"]); assert.equal(body.tools[0].async, true); assert.notEqual(body.tools[1].async, true);
    if (index === 2) {
      const results = body.input.filter((part) => part.type === "function_call_output");
      assert.equal(results.length, 1); assert.equal(results[0].call_id, "rebase");
      assert.match(JSON.stringify(results[0]), /EARLY_PREFIX_TOOL_RESULT/);
      done(response, 3, "RESULT_CONTINUATION");
      send(response, { type: "response.completed", response: { id: "response-2", status: "completed", output: [item(3, "RESULT_CONTINUATION")],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }); response.end(); return;
    }
    send(response, { type: "response.output_item.added", output_index: 0, item: { ...item(0, ""), status: "in_progress", content: [] } });
    send(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "A" });
    done(response, 0, "A");
    send(response, { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } });
    send(response, { type: "response.output_item.added", output_index: 2, item: { ...item(2, ""), status: "in_progress", content: [] } });
    send(response, { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "B" });
  });
  await f.client.request("submit_input", { sessionId: f.sessionId, message: "EARLY_PREFIX_REBASE", behavior: "auto" });
  const beforeDelta = await until(() => f.rawEvents.find((event) => event.assistantMessageEvent?.type === "text_delta"
    && event.assistantMessageEvent.contentIndex === 2 && event.assistantMessageEvent.delta === "B"), "B at original index two");
  const originalStart = f.rawEvents.find((event) => event.type === "message_start" && event.message.role === "assistant");
  assert(originalStart?.message.id);
  assert(f.rawEvents.some((event) => event.assistantMessageEvent?.type === "text_start" && event.assistantMessageEvent.contentIndex === 2));
  const before = await f.visible(); f.proof.before = before;
  assert.equal(f.rawEvents.filter((event) => event.type === "tool_execution_start").length, 0, "An incomplete native item cannot execute");
  const response = f.responses[0];
  f.send(response, { type: "response.output_item.done", output_index: 1, item: call });
  const remainderStart = await until(() => f.rawEvents.find((event) => event.type === "message_start" && event.message.role === "assistant"
    && event.message.id !== originalStart.message.id && event.message.content[0]?.text === "B"), "open B moved to a new segment");
  const resultEvent = await until(() => f.rawEvents.find((event) => event.type === "tool_execution_end" && event.toolCallId === callId), "real native Python execution before provider completion");
  assert.equal(resultEvent.isError, false); assert.match(JSON.stringify(resultEvent.result), /EARLY_PREFIX_TOOL_RESULT/);
  const prefixEntries = await f.entries();
  assert(prefixEntries.some((entry) => entry.message?.role === "assistant" && entry.message.id === originalStart.message.id
    && entry.message.content.some((part) => part.type === "toolCall" && part.id === callId && part.async === true)), "Early execution has its actual canonical prefix");
  assert(prefixEntries.some((entry) => entry.message?.role === "toolResult" && entry.message.toolCallId === callId), "The real result is canonical while the provider remains open");
  const rebased = await f.visible(); f.proof.rebased = rebased;
  f.send(response, { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "2" });
  f.done(response, 2, "B2");
  const afterDelta = await until(() => f.rawEvents.find((event) => event.assistantMessageEvent?.type === "text_delta"
    && event.assistantMessageEvent.contentIndex === 0 && event.assistantMessageEvent.delta === "2"), "B remainder delta remapped to index zero");
  await until(() => f.rawEvents.some((event) => event.assistantMessageEvent?.type === "text_end"
    && event.assistantMessageEvent.contentIndex === 0 && event.assistantMessageEvent.content === "B2"), "rebased text completion");
  const completed = await f.visible(); f.proof.completed = completed;
  f.send(response, { type: "response.completed", response: { id: "response-1", status: "completed", output: [f.item(0, "A"), call, f.item(2, "B2")],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
  await until(() => f.events.some((event) => event.type === "agent_settled"), "native result continuation settles");
  const entries = await f.entries(); const canonical = entries.flatMap((entry) => assistantMessageParts(entry));
  const history = await f.visible(); const reload = await f.visible();
  const starts = f.rawEvents.filter((event) => event.type === "tool_execution_start");
  const ends = f.rawEvents.filter((event) => event.type === "tool_execution_end");
  const resultMessages = entries.filter((entry) => entry.message?.role === "toolResult").map((entry) => entry.message);
  const usage = entries.filter((entry) => entry.message?.role === "assistant").map((entry) => entry.message.usage.totalTokens);
  const terminalIndex = f.timeline.findIndex((event) => event.kind === "provider" && event.request === 1 && event.type === "response.completed");
  const executeIndex = f.timeline.findIndex((event) => event.kind === "actor" && event.type === "tool_execution_start");
  const resultIndex = f.timeline.findIndex((event) => event.kind === "actor" && event.type === "tool_execution_end");
  Object.assign(f.proof, { originalSegmentId: originalStart.message.id, remainderSegmentId: remainderStart.message.id,
    originalContentIndex: beforeDelta.assistantMessageEvent.contentIndex, remainderContentIndex: afterDelta.assistantMessageEvent.contentIndex,
    canonical, history, reload, nativeExecuteCount: starts.length, actualExecuteCount: await readFile(path.join(f.cwd, "native-execute-count"), "utf8"),
    usage, modelRequests: f.requests.length, executeIndex, resultIndex, terminalIndex });
  assert(starts.length === 1 && ends.length === 1 && resultMessages.length === 1, "Execute and persist the original native call once");
  assert.equal(f.proof.actualExecuteCount, "1"); assert.equal(resultMessages[0].toolCallId, callId); assert.equal(resultMessages[0].isError, false);
  assert(executeIndex >= 0 && resultIndex > executeIndex && resultIndex < terminalIndex, "Native execution and its result precede the provider terminal event");
  assert.deepEqual(usage.filter((total) => total > 0), f.requests.length === 2 ? [12, 4] : [12], "Charge each provider response once, never its early prefix");
  assert.equal(usage.reduce((sum, total) => sum + total, 0), 12 + 4 * (f.requests.length - 1));
  const updates = f.rawEvents.filter((event) => event.type === "message_update");
  assert(updates.every((event) => !("message" in event) && !("partial" in event.assistantMessageEvent)), "Exercise actual slim RPC, not cumulative snapshots");
  assert.deepEqual(before.map((row) => row.text), ["A", "B"]);
  assert.deepEqual(rebased.map((row) => row.text), ["A", "B"]);
  assert.deepEqual(completed.map((row) => row.text), ["A", "B2"]);
  const expectedText = f.requests.length === 2 ? ["A", "B2", "RESULT_CONTINUATION"] : ["A", "B2"];
  for (const rows of [canonical, history, reload]) assert.deepEqual(rows.map((row) => row.text), expectedText, "Preserve completed text without provisional duplicates");
  const bBefore = before.find((row) => row.text === "B");
  for (const rows of [rebased, completed, canonical, history, reload]) {
    const bRows = rows.filter((row) => row.text === "B" || row.text === "B2");
    assert.equal(bRows.length, 1, "The rebased provider item has one public row");
    assert.equal(bRows[0].id, bBefore.id, "B keeps its first public identity across segment/index rebase and canonical reload");
    assert.equal(bRows[0].createdAt, bBefore.createdAt); assert.equal(bRows[0].timelineSequence, bBefore.timelineSequence);
  }
  const publicBEvents = f.events.filter((event) => event.assistantMessageEvent?.type === "text_delta"
    && ((event.assistantMessageEvent.contentIndex === 2 && event.assistantMessageEvent.delta === "B")
      || (event.assistantMessageEvent.contentIndex === 0 && event.assistantMessageEvent.delta === "2")));
  assert.equal(publicBEvents.length, 2);
  assert(publicBEvents.every((event) => event.messageId === bBefore.id), "Subscriber deltas and reload use the same B identity");
});


test("actual progress producer and slim text preserve per-part births through commit, cold history and restart", { timeout: 90_000 }, async t => {
  const { conversationOrderFixture } = await import("./fixtures/conversation-order.mjs");
  const f = await conversationOrderFixture(t);
  const progress = await f.start(); assert.equal(progress.history.at(-1).kind, "progress");
  await f.reply(); const multipart = await f.interleave();
  assert.deepEqual(multipart.history.map(row => row.kind), ["message", "progress", "message", "progress", "message"]);
  const order = multipart.history.map(row => row.kind === "message" ? multipart.messages.find(message => message.id === row.id) : row);
  assert.deepEqual(order.slice(1).map(row => row.timelineSequence), [1, 2, 3, 4]);
  const final = await f.finish(); assert.deepEqual(final.history.map(row => row.id), multipart.history.map(row => row.id));
  const entries = await f.entries();
  const stamps = entries.flatMap(entry => entry.type === "custom" && entry.customType === "persistent-harness.progress-v1" ? [entry.data.harnessBirth]
    : entry.message?.role === "assistant" ? entry.message.content.filter(part => part.type === "text").map(part => part.harnessBirth) : []);
  assert.deepEqual(stamps.map(stamp => stamp.sequence).sort(), [1, 2, 3, 4]);
  await f.client.request("stop_session", { sessionId: f.sessionId });
  const cold = await f.read(); assert.deepEqual(cold.history, final.history);
  assert.deepEqual(cold.messages.map(row => [row.id, row.createdAt, row.timelineSequence]), final.messages.map(row => [row.id, row.createdAt, row.timelineSequence]));
  await f.start(); const restarted = f.events.filter(event => event.type === "progress_entry").at(-1);
  assert.equal(restarted.timelineSequence, 5, "new actor seeds from committed active ancestry");
});
