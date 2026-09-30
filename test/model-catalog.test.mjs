import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { loadExternalPi, resolveExternalPi } from "../src/external-pi.mjs";
import { SDKWorker } from "../src/sdk-worker.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { resolveChildLaunchPolicy } from "../src/child-policy.mjs";
import { projectAvailableModels } from "../src/inference-options.mjs";

const selected = await resolveExternalPi();
const temporary = await mkdtemp(path.join(os.tmpdir(), "catalog-integration-"));
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: savedEnv.PATH, HOME: temporary,
  PI_CODING_AGENT_DIR: path.join(temporary, "agent"), PI_HARNESS_PI_MODULE: selected.sdk,
  PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" });
const denied = () => { throw new Error("Unexpected network access"); };
mock.method(globalThis, "fetch", denied);
mock.method(net.Socket.prototype, "connect", denied);
mock.method(http, "request", denied); mock.method(https, "request", denied);
after(async () => {
  mock.restoreAll();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(temporary, { recursive: true, force: true });
});
const { sdk, api } = await loadExternalPi();
const prior = { provider: "openai-codex", id: "gpt-6-astra", name: "Prior catalog fixture", api: "openai-codex-responses",
  baseUrl: "https://fixture.invalid", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const target = { ...prior, id: "gpt-6.1-sol", name: "Refreshed catalog fixture" };
const notify = (warnings) => (message, type) => warnings.push({ message, type });
function worker(models, warnings = []) {
  return new SDKWorker({ models, session: { model: prior, sessionManager: {}, subscribe: () => () => {} },
    publish() {}, broker: { ui: { notify: notify(warnings) } } });
}
function handlers(registry, warnings = [], admit = () => ({})) {
  return createHostHandlers({ cwd: temporary, getManifest: () => ({ skills: [] }),
    getContext: () => ({ model: prior, thinkingLevel: "high", modelRegistry: registry, ui: { notify: notify(warnings) } }),
    getClient: () => ({ isConnected: true, connectedSession: { depth: 0 }, limits: { maxDepth: 1 },
      request: async (type, params) => type === "spawn_child" ? admit(params) : {} }) });
}

test("public Pi refresh connects picker, search, and stale exact-pin admission without inference or selection changes", async () => {
  const credentials = new api.InMemoryCredentialStore();
  await credentials.modify("openai-codex", () => ({ type: "oauth", access: "synthetic-unused", refresh: "synthetic-unused", expires: Date.now() + 3600000 }));
  const modelsPath = path.join(temporary, "models.json");
  const modelsStorePath = path.join(temporary, "models-store.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "openai-codex": { modelOverrides: { "gpt-6-astra": { contextWindow: 200000 } } } } }));
  await writeFile(modelsStorePath, JSON.stringify({ "openai-codex": { models: [prior], checkedAt: 1, lastModified: Date.now() - 1000 } }));
  const makeRuntime = () => sdk.ModelRuntime.create({ credentials, modelsPath, modelsStorePath, allowModelNetwork: false });
  const pickerRuntime = await makeRuntime(), searchRuntime = await makeRuntime(), pinRuntime = await makeRuntime();
  for (const runtime of [pickerRuntime, searchRuntime, pinRuntime]) assert.equal(runtime.getModel(target.provider, target.id), undefined);
  const oldIds = pickerRuntime.getModels("openai-codex").map((model) => model.id);
  let requests = 0;
  globalThis.fetch = async (input, options) => {
    assert.equal(String(input), "https://pi.dev/api/models/providers/openai-codex");
    assert.equal(new Headers(options.headers).has("authorization"), false);
    requests++;
    return new Response(JSON.stringify([prior, target]), { headers: { "last-modified": new Date().toUTCString(), etag: '"fixture"' } });
  };
  const picker = worker(pickerRuntime);
  const listed = await picker.handle({ type: "get_available_models" });
  assert.equal(requests, 1);
  assert.equal(listed.warning, undefined);
  assert(projectAvailableModels(listed.models).some((model) => model.provider === target.provider && model.id === target.id), "the picker projection includes the refreshed target");
  for (const id of oldIds) assert(listed.models.some((model) => model.id === id));
  assert.equal(picker.session.model, prior, "catalog browsing does not select a model");
  assert.equal(pickerRuntime.getModel(prior.provider, prior.id).contextWindow, 200000, "models.json overrides survive refresh");

  const found = await handlers(new sdk.ModelRegistry(searchRuntime))["rlm.find_models"]({ query: "gpt-6.1-sol" });
  assert.deepEqual(found.models.map((model) => `${model.provider}/${model.id}`), ["openai-codex/gpt-6.1-sol"]);
  assert.equal(found.warning, undefined);

  globalThis.fetch = denied;
  let policy;
  await handlers(new sdk.ModelRegistry(pinRuntime), [], (params) => {
    policy = resolveChildLaunchPolicy({ request: { ...params, skillCatalog: [] }, parent: { kind: "root", depth: 0 } });
    return { accepted: true };
  })["rlm.spawn"]({ prompt: "Synthetic admission only", model: "openai-codex/gpt-6.1-sol", thinkingLevel: "high" });
  assert.deepEqual(policy.model.resolved, { provider: "openai-codex", id: "gpt-6.1-sol" });
  assert.equal(policy.model.source, "explicit");

  process.env.PI_OFFLINE = "1";
  try {
    const offline = await makeRuntime();
    const available = await worker(offline).handle({ type: "get_available_models" });
    assert(available.models.some((model) => model.id === target.id));
    assert.equal(available.warning, undefined);
  } finally { delete process.env.PI_OFFLINE; }
});

test("catalog call sites pass the stock deadline and surface safe cached warnings on failure, timeout, and config errors", async () => {
  const deadlines = [];
  const timeoutMock = mock.method(AbortSignal, "timeout", (ms) => { deadlines.push(ms); return new AbortController().signal; });
  try {
    for (const outcome of ["errors", "aborted", "config", "throw"]) {
      const calls = [], warnings = [];
      const runtime = {
        getAvailableSnapshot: () => [prior], getAvailable: () => [prior],
        getError: () => outcome === "config" ? "PRIVATE_AUTH_ERROR" : undefined,
        refresh: async (options) => {
          calls.push(options);
          if (outcome === "throw") throw new Error("PRIVATE_AUTH_ERROR");
          return { aborted: outcome === "aborted", errors: outcome === "errors" ? new Map([["fixture", new Error("PRIVATE_AUTH_ERROR")]]) : new Map() };
        },
      };
      const listed = await worker(runtime, warnings).handle({ type: "get_available_models" });
      const host = handlers(runtime, warnings);
      const found = await host["rlm.find_models"]({ query: "astra" });
      await host["rlm.spawn"]({ prompt: "Synthetic admission only", model: "openai-codex/gpt-6-astra" });
      assert.equal(listed.models[0].id, prior.id); assert.equal(found.models[0].id, prior.id);
      assert.match(listed.warning, /cached models/); assert.match(found.warning, /cached models/);
      assert.equal(warnings.length, 3); assert(warnings.every((entry) => entry.type === "warning"));
      assert.doesNotMatch(JSON.stringify({ listed, found, warnings }), /PRIVATE_AUTH_ERROR/);
      assert.deepEqual(calls.map((options) => Object.keys(options).sort()), [["signal"], ["signal"], ["allowNetwork", "signal"]]);
      assert.equal(calls[2].allowNetwork, false);
      assert(calls.every((options) => options.signal instanceof AbortSignal));
    }
    assert.equal(deadlines.length, 12); assert(deadlines.every((ms) => ms === 15_000));
  } finally { timeoutMock.mock.restore(); }
});
