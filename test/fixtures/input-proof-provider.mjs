import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { AssistantMessageEventStream } = await import(pathToFileURL(process.env.INPUT_PROOF_AI_MODULE).href);
const record = (value) => appendFileSync(process.env.INPUT_PROOF_PROVIDER_LOG, `${JSON.stringify(value)}\n`);

export default function inputProofFixture(pi) {
  pi.registerCommand("input-proof-handled", { description: "Fixture-only handled control",
    handler: async (args) => record({ type: "handled", args }) });
  pi.on("input", (event) => {
    record({ type: "input", text: event.text, images: event.images });
    if (event.text === "TRANSFORM_ME") return { action: "transform",
      text: "Actual transformed input\n\n<!-- persistent-harness-input:literal-user-text -->", images: event.images };
  });
  pi.registerProvider("input-proof-fixture", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fixture-only",
    models: [{ id: "proof", name: "Input proof fixture", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 64 }],
    streamSimple(model, context) {
      record({ type: "provider", messages: context.messages });
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "INPUT_PROOF_RESPONSE" }],
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
