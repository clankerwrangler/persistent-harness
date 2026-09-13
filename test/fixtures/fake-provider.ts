export default function fakeProvider(pi: any) {
  pi.registerProvider("harness-fake", {
    name: "Harness E2E fake",
    baseUrl: process.env.HARNESS_FAKE_BASE_URL || "http://127.0.0.1:1/v1",
    apiKey: "not-used",
    api: "openai-completions",
    models: [
      {
        id: "fake-model",
        name: "Harness Fake Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 1024,
      },
    ],
  });
}
