export default function fakeNativeCodexProvider(pi: any) {
  const baseUrl = process.env.HARNESS_FAKE_NATIVE_BASE_URL;
  if (!baseUrl || new URL(baseUrl).hostname !== "127.0.0.1") {
    throw new Error("Native Codex fixture requires an explicit loopback URL");
  }
  pi.on("before_provider_request", (_event: any, ctx: any) => {
    if (new URL(ctx.model.baseUrl).origin !== new URL(baseUrl).origin) {
      throw new Error("Native fixture refuses a non-loopback provider route");
    }
  });
  // The production adapter reads this non-secret synthetic account claim.
  const claim = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "harness-native-fixture" },
  })).toString("base64url");
  pi.registerProvider("openai-codex", {
    name: "Harness local native fixture",
    baseUrl,
    apiKey: `fixture.${claim}.fixture`,
    api: "openai-codex-responses",
    models: [{
      id: "gpt-6-astra", name: "Harness Astra fixture", reasoning: false,
      input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1024,
      compat: { supportsAsyncTools: true },
    }],
  });
}
