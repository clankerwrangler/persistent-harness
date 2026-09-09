export default function contextForkProvider(pi: any) {
  pi.registerProvider("harness-fork-fake", {
    name: "Context fork E2E provider",
    baseUrl: process.env.HARNESS_FORK_BASE_URL || "http://127.0.0.1:1/v1",
    apiKey: "not-used",
    api: "openai-completions",
    models: ["parent-model", "pinned-child-model"].map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    })),
  });
}
