import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRootTitleGenerator } from "../src/root-title-generator.mjs";
import { createPiModelRuntime } from "../src/pi-session.mjs";

test("root title generator asks grok-cli for a short topic title", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-title-gen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "accounts.json");
  await writeFile(vaultPath, JSON.stringify({
    version: 1,
    activeAccountId: "account-1",
    accounts: [{ id: "account-1", credential: { access: "test-token" } }],
  }));
  const calls = [];
  const generate = createRootTitleGenerator({
    env: { HOME: root, GROK_CLI_OAUTH_TOKEN: "test-token", PI_GROK_CLI_BASE_URL: "https://cli-chat-proxy.grok.com/v1" },
    vaultPath,
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        body: JSON.parse(options.body),
        authorization: options.headers.authorization,
        userAgent: options.headers["user-agent"],
        tokenAuth: options.headers["x-xai-token-auth"],
      });
      return {
        ok: true,
        async json() {
          return { output_text: 'Title: "Smarter Session Titles"' };
        },
      };
    },
  });
  const title = await generate({
    userText: "It's still too stupid. It should actually think of a good title.",
    assistantText: "Heuristic titles are the problem. I will generate a real one.",
  }, { provider: "grok-cli", id: "grok-composer-2.5-fast" });
  assert.equal(title, "Smarter Session Titles");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cli-chat-proxy.grok.com/v1/responses");
  assert.equal(calls[0].authorization, "Bearer test-token");
  assert.match(calls[0].userAgent, /grok-pager\/0\.2\.91/);
  assert.equal(calls[0].tokenAuth, "xai-grok-cli");
  assert.equal(calls[0].body.stream, false);
  assert.match(calls[0].body.input[1].content, /think of a good title/);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /test-token/);
});

function fakeModelRuntime(calls, result = {}) {
  return {
    getModel(provider, id) { return { provider, id }; },
    async completeSimple(model, context, options) {
      calls.push({ model, context, options });
      return { stopReason: "stop", content: [{ type: "text", text: "Semantic Session Titles" }], ...result };
    },
  };
}

test("titles use the session's resolved provider and model without a Grok request", async () => {
  const calls = [];
  let runtimeOptions;
  const generate = createRootTitleGenerator({
    modelRuntimeFactory: async (options) => { runtimeOptions = options; return fakeModelRuntime(calls); },
    fetchImpl: async () => { assert.fail("must not use the Grok transport"); },
  });
  for (const selection of [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openrouter", id: "z-ai/glm-5.3" },
  ]) {
    assert.equal(await generate({ userText: "It's broken again.", assistantText: "The provider used for session titles is wrong." }, selection), "Semantic Session Titles");
    assert.deepEqual(calls.at(-1).model, selection);
  }
  assert.equal(runtimeOptions.allowModelNetwork, false);
  const { context, options } = calls[0];
  assert.match(context.systemPrompt, /metadata/i);
  assert.match(context.messages[0].content, /broken again/);
  assert.match(context.messages[0].content, /provider used for session titles/);
  assert.equal(context.tools, undefined);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.transport, "sse");
  assert(options.signal instanceof AbortSignal);
  assert.equal(options.cacheRetention, "none");
});

test("unknown selection and provider failures never fall back to another provider", async () => {
  const calls = [];
  const generate = createRootTitleGenerator({
    modelRuntimeFactory: async () => fakeModelRuntime(calls, { stopReason: "error", errorMessage: "private provider response" }),
    fetchImpl: async () => { assert.fail("must not fall back to Grok"); },
  });
  const turn = { userText: "Why did session titles break?", assistantText: "The title provider is unavailable." };
  await assert.rejects(generate(turn), /session model/);
  assert.equal(calls.length, 0);
  await assert.rejects(generate(turn, { provider: "openai-codex", id: "session-model" }), /title model.*error/);
  assert.equal(calls.length, 1);
  const unavailable = createRootTitleGenerator({ modelRuntimeFactory: async () => ({ getModel: () => undefined }) });
  await assert.rejects(unavailable(turn, { provider: "custom-provider", id: "missing" }), /session model/);
});

test("title failures and output truncation cannot become a partial generated title", async () => {
  for (const stopReason of ["length", "aborted", "error", "toolUse"]) {
    const generate = createRootTitleGenerator({
      modelRuntimeFactory: async () => fakeModelRuntime([], { stopReason }),
      fetchImpl: async () => { throw new Error("title model fixture must not use HTTP"); },
    });
    await assert.rejects(generate({ userText: "Synthetic fixture", assistantText: "Session title generation" },
      { provider: "openai-codex", id: "session-model" }), /title model/);
  }
});

test("Grok titles use the session model and reread active credentials on each call", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-title-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "accounts.json");
  const calls = [];
  const generate = createRootTitleGenerator({
    env: { HOME: root }, vaultPath,
    modelRuntimeFactory: async () => { assert.fail("Grok keeps its registered transport"); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, async json() { return { output: [{ content: [{ text: "Session Title Repair" }] }] }; } };
    },
  });
  for (const token of ["old-test-token", "refreshed-test-token"]) {
    await writeFile(vaultPath, JSON.stringify({ version: 1, activeAccountId: "account-1",
      accounts: [{ id: "account-1", credential: { access: token } }] }));
    assert.equal(await generate({ userText: "Repair titles", assistantText: "The title provider now matches the session." },
      { provider: "grok-cli", id: "grok-4.6" }), "Session Title Repair");
    assert.equal(calls.at(-1).options.headers.authorization, `Bearer ${token}`);
    assert.equal(calls.at(-1).body.model, "grok-4.6");
    assert.equal(calls.at(-1).options.headers["x-grok-model-override"], "grok-4.6");
  }
});

test("the installed Pi SDK generates through a configured provider without creating a session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-title-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authPath = path.join(root, "auth.json");
  const modelsPath = path.join(root, "models.json");
  await writeFile(authPath, "{}\n");
  await writeFile(modelsPath, JSON.stringify({ providers: { "title-fixture": {
    baseUrl: "https://title-fixture.invalid/v1", apiKey: "fixture-api-key", api: "openai-completions",
    models: [{ id: "session-model", reasoning: false }],
  } } }));
  const calls = [];
  const generate = createRootTitleGenerator({
    modelRuntimeFactory: (options) => createPiModelRuntime({ ...options, authPath, modelsPath }),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Semantic Session Titles" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(await generate({ userText: "Synthetic internal metadata fixture", assistantText: "The title provider now matches the session." },
    { provider: "title-fixture", id: "session-model" }), "Semantic Session Titles");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://title-fixture.invalid/v1/chat/completions");
  assert.equal(calls[0].body.model, "session-model");
  assert.equal(calls[0].body.tools, undefined);
  assert.equal(calls[0].body.store, false);
  assert.equal(await readFile(authPath, "utf8"), "{}\n");
  assert(!(await readdir(root)).includes("sessions"));
});
