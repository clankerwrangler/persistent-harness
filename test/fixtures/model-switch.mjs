import { writeFile } from "node:fs/promises";
import path from "node:path";
import { slimFixture, until } from "./slim-stream.mjs";

/** Real stock worker, loopback transport, and a held persistent Python call. */
export async function modelSwitchFixture(t, { maxRequests = 3, readNamespaceOnContinuation = true, holdContinuationResponse = false } = {}) {
  let releasePath, continuationReleased = false;
  const call = (id, code, native) => ({ type: "function_call", id: `fc_${id}`, call_id: id,
    name: "ipython", arguments: JSON.stringify({ code }), ...(native ? { async: true } : {}) });
  const complete = (f, response, output) => {
    f.send(response, { type: "response.completed", response: { id: `response-${f.responses.indexOf(response) + 1}`, status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
  };
  const f = await slimFixture(t, "model-switch", ({ response, index, send, item }) => {
    if (index === 1) {
      const code = `import os, time
persistent_probe = 41
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
  t.after(() => writeFile(releasePath, "release").catch(() => {}));
  const inference = () => f.client.request("get_session_inference", { sessionId: f.sessionId });
  return { ...f, inference,
    async start() {
      await f.client.request("submit_input", { sessionId: f.sessionId, message: "Test model switching with retained Python", behavior: "auto", clientRequestId: "model-switch-input" });
      await until(() => f.rawEvents.some(e => e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("HOLD_STARTED")), "Python reaches its held execution");
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
    async toolFinished() { await until(() => f.rawEvents.some(e => e.type === "message_end" && e.message?.role === "toolResult" && e.message.toolCallId.startsWith("held-python")), "held tool finishes"); },
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
