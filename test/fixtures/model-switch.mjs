import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { slimFixture, until } from "./slim-stream.mjs";

/** Real stock worker, loopback transport, and a held persistent Python call. */
export async function modelSwitchFixture(t, { maxRequests = 3, readNamespaceOnContinuation = true, holdContinuationResponse = false } = {}) {
  let releasePath, readyPath, countPath, continuationReleased = false;
  const heldCallId = "held-python|fc_held-python";
  const call = (id, code, native) => ({ type: "function_call", id: `fc_${id}`, call_id: id,
    name: "ipython", arguments: JSON.stringify({ code }), ...(native ? { async: true } : {}) });
  const complete = (f, response, output) => {
    f.send(response, { type: "response.completed", response: { id: `response-${f.responses.indexOf(response) + 1}`, status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
  };
  const f = await slimFixture(t, "model-switch", ({ response, index, send, item }) => {
    if (index === 1) {
      const code = `import os, time
from pathlib import Path
counter = Path(${JSON.stringify(countPath)})
counter.write_text(str(int(counter.read_text()) + 1) if counter.exists() else "1")
persistent_probe = 41
Path(${JSON.stringify(readyPath)}).write_text("HOLD_STARTED " + str(persistent_probe))
print("HOLD_STARTED", flush=True)
while not os.path.exists(${JSON.stringify(releasePath)}): time.sleep(0.05)
print("HOLD_DONE", persistent_probe)`;
      const tool = call("held-python", code, true);
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } });
      send(response, { type: "response.output_item.done", output_index: 0, item: tool });
    } else if (index === 2 && readNamespaceOnContinuation) {
      const tool = call("read-python", 'print("KEPT_NAMESPACE", persistent_probe + 1)', false);
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } });
      send(response, { type: "response.output_item.done", output_index: 0, item: tool });
      send(response, { type: "response.completed", response: { id: "response-2", status: "completed", output: [tool],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    } else {
      if (holdContinuationResponse && !continuationReleased) return;
      const answer = item(0, "SWITCH_DONE");
      send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
      send(response, { type: "response.output_item.done", output_index: 0, item: answer });
      send(response, { type: "response.completed", response: { id: `response-${index}`, status: "completed", output: [answer],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    }
  }, { models: ["gpt-6-astra", "gpt-6.1-sol"], maxRequests });
  releasePath = path.join(f.cwd, "release-tool");
  readyPath = path.join(f.cwd, "held-tool-ready"); countPath = path.join(f.cwd, "held-execute-count");
  t.after(() => writeFile(releasePath, "release").catch(() => {}));
  const inference = () => f.client.request("get_session_inference", { sessionId: f.sessionId });
  return { ...f, inference,
    async start() {
      await f.client.request("submit_input", { sessionId: f.sessionId, message: "Test model switching with retained Python", behavior: "auto", clientRequestId: "model-switch-input" });
      // The tool owns readiness; tool_start precedes execution, and compact RPC
      // deliberately carries no partial-result body.
      const ready = await until(() => readFile(readyPath, "utf8").catch(error => {
        if (error.code === "ENOENT") return false;
        throw error;
      }), "Python reaches its held execution");
      assert.equal(ready, "HOLD_STARTED 41");
      assert.equal(await readFile(countPath, "utf8"), "1");
      await until(() => f.rawEvents.some(e => e.type === "tool_execution_start" && e.toolCallId === heldCallId), "matching compact tool start reaches RPC");
      assert.equal(f.rawEvents.filter(e => e.type === "tool_execution_start" && e.toolCallId === heldCallId).length, 1);
      assert.equal(f.rawEvents.some(e => e.type === "tool_execution_end" && e.toolCallId === heldCallId), false);
      assert.equal((await f.entries()).some(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === heldCallId), false);
    },
    finishStream() {
      const response = f.responses[0];
      complete(f, response, []);
    },
    finishContinuation() {
      continuationReleased = true;
      for (const response of f.responses.slice(1)) {
        if (response.writableEnded || response.destroyed) continue;
        const answer = f.item(0, "SWITCH_DONE");
        f.send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
        f.send(response, { type: "response.output_item.done", output_index: 0, item: answer });
        complete(f, response, [answer]);
      }
    },
    async releaseTool() { await writeFile(releasePath, "release"); },
    async toolFinished() {
      await until(() => f.rawEvents.some(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolCallId === heldCallId), "held tool finishes");
      const results = (await f.entries()).filter(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === heldCallId);
      assert.equal(results.length, 1); assert.equal(results[0].message.isError, false);
      assert.match(JSON.stringify(results[0].message.content), /HOLD_DONE 41/);
      assert.equal(await readFile(countPath, "utf8"), "1", "The real held Python effect runs once");
      const ends = f.rawEvents.filter(e => e.type === "tool_execution_end" && e.toolCallId === heldCallId);
      assert.equal(ends.length, 1); assert.equal(ends[0].isError, false);
      assert.equal("result" in ends[0], false, "Canonical history owns the result body");
    },
    async settled() { await until(() => f.events.some(e => e.type === "agent_settled"), "model-switch settlement"); },
  };
}

/** No-task answer boundary with both explicit follow-up and auto input waiting. */
export async function followUpBoundaryFixture(t) {
  const f = await slimFixture(t, "follow-up-boundary", () => {}, { maxRequests: 2 });
  return { ...f,
    async start() {
      const receipt = await f.client.request("submit_input", { sessionId: f.sessionId, message: "An admitted message before the queued reports.",
        behavior: "auto", clientRequestId: "boundary-original" });
      await until(() => f.requests.length === 1, "first answer is in flight");
      return receipt;
    },
    async queue(message, behavior, clientRequestId) {
      const receipt = await f.client.request("submit_input", { sessionId: f.sessionId, message, behavior, clientRequestId });
      await until(() => f.supervisor.store.getActorInput(receipt.inputId, f.sessionId)?.state === "accepted", "input reaches the native queue");
      return receipt;
    },
    finishAnswer(index) {
      const response = f.responses[index], answer = f.item(index, index ? "Both queued reports are admitted." : "The original answer is complete.");
      f.send(response, { type: "response.output_item.added", output_index: 0, item: { ...answer, content: [] } });
      f.send(response, { type: "response.output_item.done", output_index: 0, item: answer });
      f.send(response, { type: "response.completed", response: { id: `response-${index + 1}`, status: "completed", output: [answer],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    },
    async settled() { await until(() => f.events.some(event => event.type === "agent_settled"), "boundary settlement"); },
  };
}
