import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessStore } from "../../src/store.mjs";
import harnessExtension from "../../src/extension.mjs";

const { AssistantMessageEventStream } = await import(pathToFileURL(process.env.RETRY_FIXTURE_AI_MODULE).href);
const record = (event) => appendFileSync(process.env.RETRY_FIXTURE_LOG, `${JSON.stringify(event)}\n`);
const store = new HarnessStore(process.env.RETRY_FIXTURE_DATABASE);
const actorId = process.env.PI_HARNESS_ACTOR_ID;
const registeredSession = { sessionId: actorId, actorGeneration: Number(process.env.PI_HARNESS_ACTOR_GENERATION), depth: 1 };
// Substitute only the fixture's actor-control peer, not Pi command dispatch or navigation.
HarnessClient.prototype.start = async () => ({ session: registeredSession });
Object.defineProperty(HarnessClient.prototype, "connectedSession", { get: () => registeredSession });
Object.defineProperty(HarnessClient.prototype, "isConnected", { get: () => true });
HarnessClient.prototype.request = async (type, params) => {
  if (type === "get_actor_input") return { input: store.getActorInput(params.inputId, actorId) };
  if (type === "accept_actor_input") return { input: store.markActorInputAccepted(params.inputId, actorId, registeredSession.actorGeneration) };
  if (type === "record_input_delivery") {
    store.completeActorInput(params.inputId, actorId, Date.parse(params.deliveredAt), params.entryId);
    return { accepted: true };
  }
  if (type === "flush_actor_inputs") return { flushed: true };
  return {};
};

export default function retryContextFixture(pi, lifecycle) {
  harnessExtension(pi, lifecycle);
  pi.on("session_before_tree", (event) => {
    record({ type: "before_tree", preparation: event.preparation });
    if (process.env.RETRY_FIXTURE_CANCEL_TREE === "1") return { cancel: true };
  });
  pi.on("session_tree", (event) => record({ type: "tree", event }));
  pi.registerProvider("retry-context-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "replay", name: "Replay fixture", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 64 }],
    streamSimple(model, context) {
      record({ type: "provider", messages: context.messages });
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "FRESH_RETRY_RESPONSE" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
}
