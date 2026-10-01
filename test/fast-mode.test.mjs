import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HarnessStore } from "../src/store.mjs";
import { supportsFastMode, fastModeOptions } from "../src/fast-mode.mjs";
import { projectAvailableModels } from "../src/inference-options.mjs";

test("Fast gate uses exact canonical provider/API/model identities, not names or sampling aliases", () => {
  for (const [provider, api] of [["openai-codex", "openai-codex-responses"], ["openai", "openai-responses"]]) {
    for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
      const model = { provider, api, id, name: "Fixture", reasoning: true, contextWindow: 32000 };
      assert.equal(supportsFastMode(model), true);
      assert.deepEqual(fastModeOptions(model, true), { serviceTier: "priority" });
      assert.deepEqual(fastModeOptions(model, false), {});
      assert.deepEqual(fastModeOptions(model, "true"), {});
      assert.equal(projectAvailableModels([model])[0].fastModeSupported, true);
      for (const invalid of [{ ...model, api: "openai-completions" }, { ...model, provider: "alias" },
        { ...model, id: "gpt-5.5" }, { ...model, id: "gpt-6-astra-fast" }, { ...model, api: undefined }]) {
        assert.equal(supportsFastMode(invalid), false); assert.deepEqual(fastModeOptions(invalid, true), {});
        assert.equal(projectAvailableModels([invalid])[0].fastModeSupported, false);
      }
    }
  }
  assert.deepEqual(fastModeOptions(null, true), {});
});

test("Fast is durable, defaults off independently, survives reattach and model changes, and uses compare-and-set", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fast-store-"));
  let store = new HarnessStore(path.join(dir, "state.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const root = { sessionId: "root", cwd: dir, actorToken: "fixture", launch: { model: { resolved: { provider: "openai-codex", id: "gpt-6-astra" } }, thinking: { resolved: "off" } } };
  store.createRoot(root);
  assert.equal(store.getActorLaunch("root").launch.fastMode, false);
  store.updateSessionFastMode("root", true, false);
  assert.throws(() => store.updateSessionFastMode("root", false, false), /concurrently/);
  assert.throws(() => store.updateSessionFastMode("root", "true", true), /boolean/);
  store.createChild("root", { sessionId: "child", actorToken: "child-fixture", policy: { ...store.getActorLaunch("root").launch, name: "child" } });
  assert.equal(store.getActorLaunch("child").launch.fastMode, false);
  store.admitRoot(root); assert.equal(store.getSessionFastMode("root"), true);
  store.updateSessionInference("root", { provider: "other", model: "other", thinkingLevel: "off" });
  assert.equal(store.getSession("root").launch.fastMode, true);
  assert.equal(store.getSession("root").launch.fastModeSupported, false);
  store.close(); store = new HarnessStore(path.join(dir, "state.sqlite"));
  assert.equal(store.getSessionFastMode("root"), true);
  assert.equal(store.getSessionFastMode("child"), false);
  store.updateSessionFastMode("root", false, true);
  assert.equal(store.getSessionFastMode("root"), false);
  assert.throws(() => store.getSessionFastMode("missing"), /does not exist/);
});
