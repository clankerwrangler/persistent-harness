import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { closestThinkingLevel, readDefaultModel, resolveDefaultTarget, writeDefaultModel } from "../src/default-inference.mjs";
import { HarnessStore } from "../src/store.mjs";

const SOL = { provider: "openai-codex", model: "gpt-6.1-sol" };
const TERRA = { provider: "openai-codex", id: "gpt-6.1-terra", fastModeSupported: true };
const models = [
  { provider: "openai-codex", id: "gpt-5.6-terra" }, { provider: "openai-codex", id: "gpt-6.1-terra" },
  { provider: "openai-codex", id: "gpt-6.1-sol" }, { provider: "openrouter", id: "openai/gpt-9-terra" },
];

function launch(source, id = SOL.model, level = "xhigh") {
  return { model: { requested: null, resolved: { provider: "openai-codex", id }, source }, thinking: { requested: null, resolved: level, source }, fastMode: false };
}

function fixture(t, sessions) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "default-inference-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = path.join(directory, "harness.sqlite");
  const store = new HarnessStore(database);
  t.after(() => store.close());
  const raw = new DatabaseSync(database);
  t.after(() => raw.close());
  const insert = raw.prepare(`INSERT INTO sessions(id, short_id, session_file, cwd, display_name, kind, family_id, parent_session_id, depth, activity, lifecycle, actor_token, actor_generation, launch_json, created_at, updated_at)
    VALUES(?, ?, ?, '/', ?, ?, ?, ?, ?, 'inactive', ?, ?, 1, ?, 1, 1)`);
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const [id, parent, value, lifecycle = "passivated"] of sessions) {
    insert.run(id, id, `/${id}.jsonl`, id, parent ? "child" : "root", "family", parent, parent ? 1 : 0, lifecycle, `token-${id}`, JSON.stringify(value));
  }
  const launchOf = (id) => JSON.parse(raw.prepare("SELECT launch_json FROM sessions WHERE id = ?").get(id).launch_json);
  return { store, launchOf, directory };
}

test("a short name picks the newest match from the default provider", () => {
  assert.equal(resolveDefaultTarget("terra", models, "openai-codex").id, "gpt-6.1-terra");
  assert.equal(resolveDefaultTarget("gpt-5.6-terra", models, "openai-codex").id, "gpt-5.6-terra");
  assert.equal(resolveDefaultTarget("openrouter/openai/gpt-9-terra", models, "openai-codex").provider, "openrouter");
  assert.throws(() => resolveDefaultTarget("nothing", models, "openai-codex"), /no openai-codex model/);
  assert.throws(() => resolveDefaultTarget("gpt", [{ provider: "p", id: "gpt-1-a" }, { provider: "p", id: "gpt-1-b" }], "p"), /ambiguous/);
});

test("the thinking level is kept, or moves to the nearest lower supported level", () => {
  const model = { reasoning: true, thinkingLevels: ["low", "medium", "high"], thinkingLevelMap: { xhigh: null, max: null, off: null, minimal: null } };
  assert.equal(closestThinkingLevel("high", model), "high");
  assert.equal(closestThinkingLevel("max", model), "high");
  assert.equal(closestThinkingLevel("minimal", model), "low");
});

test("default-following sessions move without waking; deliberate picks and their children stay", (t) => {
  const { store, launchOf } = fixture(t, [
    ["root", null, launch("settings")], ["child", "root", launch("parent")],
    ["stopped", null, launch("settings"), "stopped"], ["pinned", null, launch("explicit")],
    ["pinned-child", "pinned", launch("parent")], ["astra", null, launch("settings", "gpt-6-astra")],
  ]);
  const preview = store.retargetDefaultInference({ from: SOL, to: TERRA });
  assert.deepEqual(preview.moved.map((item) => item.sessionId).sort(), ["child", "root", "stopped"]);
  assert.deepEqual(preview.pinned.map((item) => item.sessionId).sort(), ["pinned", "pinned-child"]);
  assert.deepEqual(preview.otherModels.map((item) => item.sessionId), ["astra"]);
  assert.equal(launchOf("root").model.resolved.id, SOL.model, "a preview changes nothing");
  store.retargetDefaultInference({ from: SOL, to: TERRA, apply: true });
  for (const id of ["root", "child", "stopped"]) assert.equal(launchOf(id).model.resolved.id, TERRA.id);
  assert.equal(launchOf("root").model.source, "settings");
  assert.equal(launchOf("child").model.source, "parent");
  assert.equal(launchOf("pinned").model.resolved.id, SOL.model);
  assert.equal(launchOf("pinned-child").model.resolved.id, SOL.model);
  assert.equal(launchOf("astra").model.resolved.id, "gpt-6-astra");
});

test("switching back reverses the move, because moved sessions still follow the default", (t) => {
  const { store, launchOf } = fixture(t, [["root", null, launch("settings")]]);
  store.retargetDefaultInference({ from: SOL, to: TERRA, apply: true });
  store.retargetDefaultInference({ from: { provider: TERRA.provider, model: TERRA.id }, to: { provider: SOL.provider, id: SOL.model }, apply: true });
  assert.equal(launchOf("root").model.resolved.id, SOL.model);
});

test("live sessions queue the move, stay default-following once applied, and keep a user's pending pick", (t) => {
  const { store, launchOf } = fixture(t, [["live", null, launch("settings")], ["picking", null, { ...launch("settings"), pendingInference: { requestId: "r", provider: "x", model: "y", thinkingLevel: "low" } }]]);
  const result = store.retargetDefaultInference({ from: SOL, to: TERRA, liveSessionIds: new Set(["live"]), apply: true });
  assert.deepEqual(result.pending.map((item) => item.sessionId), ["picking"]);
  const queued = launchOf("live");
  assert.equal(queued.model.resolved.id, SOL.model);
  assert.equal(queued.pendingInference.followDefault, true);
  store.updateSessionInference("live", { provider: TERRA.provider, model: TERRA.id, thinkingLevel: "xhigh", fastModeSupported: true }, undefined, 2, queued.pendingInference.requestId);
  assert.equal(launchOf("live").model.resolved.id, TERRA.id);
  assert.equal(launchOf("live").model.source, "settings");
  assert.equal(launchOf("live").pendingInference, undefined);
});

test("a failed default move leaves the session following the default", (t) => {
  const { store, launchOf } = fixture(t, [["live", null, launch("settings")]]);
  store.retargetDefaultInference({ from: SOL, to: TERRA, liveSessionIds: new Set(["live"]), apply: true });
  const { requestId } = launchOf("live").pendingInference;
  store.recordSessionInferenceResult("live", 1, { requestId, error: true, selection: { provider: SOL.provider, model: SOL.model, thinkingLevel: "xhigh" } });
  assert.equal(launchOf("live").model.source, "settings");
  assert.ok(launchOf("live").pendingInference.error);
});

test("settings change only the default and keep their file mode", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "default-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  writeFileSync(file, JSON.stringify({ defaultProvider: "a", defaultModel: "b", theme: "dark" }), { mode: 0o600 });
  writeDefaultModel(file, "c", "d");
  assert.deepEqual(readDefaultModel(file), { provider: "c", model: "d" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "dark");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
