import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
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

async function storeFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fast-store-"));
  const databasePath = path.join(dir, "state.sqlite");
  const store = new HarnessStore(databasePath);
  const raw = new DatabaseSync(databasePath);
  raw.exec("PRAGMA foreign_keys = OFF");
  t.after(async () => { raw.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const root = sessionId => ({ sessionId, sessionFile: path.join(dir, `${sessionId}.jsonl`), cwd: dir, actorToken: sessionId,
    launch: { model: { resolved: { provider: "openai-codex", id: "gpt-6-astra" } }, thinking: { resolved: "off" } } });
  store.createRoot(root("root")); store.createRoot(root("other"));
  const child = (parentId, sessionId) => store.createChild(parentId, { sessionId, actorToken: sessionId,
    sessionFile: path.join(dir, `${sessionId}.jsonl`), policy: { ...store.getActorLaunch(parentId).launch, depth: store.getSession(parentId).depth + 1, name: sessionId } });
  child("root", "child"); child("child", "grandchild"); child("other", "other-child");
  return { store, raw, root, child, databasePath };
}

test("Fast is live root-owned state across independent shared-label families, retention, revival, and new descendants", async t => {
  const { store, raw, root, child, databasePath } = await storeFixture(t);
  assert.equal(store.getSession("root").familyId, store.getSession("other").familyId);
  assert.equal(store.getSession("root").launch.fastModeSupported, null, "labels cannot establish model support");
  raw.prepare("UPDATE sessions SET launch_json = json_set(launch_json, '$.fastMode', json('true')) WHERE id = 'child'").run();
  assert.equal(store.getActorLaunch("child").launch.fastMode, true, "legacy child-local flag is retained");
  assert.equal(store.getSessionFastMode("child"), false, "legacy child-local flag is ignored");
  store.markActorStarted("child", 1);
  const sampledOff = store.getSessionFastMode("grandchild");
  store.updateSessionFastMode("root", true, false);
  assert.throws(() => store.updateSessionFastMode("root", false, false), /concurrently/);
  assert.throws(() => store.updateSessionFastMode("root", "true", true), /boolean/);
  for (const id of ["root", "child", "grandchild"]) {
    assert.equal(store.getSessionFastMode(id), true);
    assert.equal(store.getSession(id).launch.fastMode, true);
    assert.equal(store.getSession(id).launch.fastModeRootSessionId, "root");
  }
  assert.equal(sampledOff, false, "a previous request sample is immutable");
  assert.equal(store.getSessionFastMode("other-child"), false);
  assert.equal(store.getSession("other-child").launch.fastModeRootSessionId, "other");
  for (const id of ["child", "grandchild"]) {
    assert.throws(() => store.updateSessionFastMode(id, false, true), /only the root/);
    assert.throws(() => store.updateSessionFastMode(id, true, true), /only the root/, "child no-op is also rejected");
  }
  store.admitRoot(root("root"));
  store.updateSessionInference("root", { provider: "other", model: "other", thinkingLevel: "off" });
  assert.equal(store.getSession("root").launch.fastMode, true);
  assert.equal(store.getSession("root").launch.fastModeSupported, false);
  store.markActorLifecycle("child", 1, "passivated");
  store.updateSessionFastMode("root", false, true);
  store.prepareActorRevival("child", "revived"); store.markActorStarted("child", 2);
  assert.equal(store.getSessionFastMode("child"), false);
  assert.equal(store.getActorLaunch("child").launch.fastMode, true);
  store.updateSessionFastMode("root", true, false);
  child("child", "new-grandchild");
  assert.equal(store.getActorLaunch("new-grandchild").launch.fastMode, false);
  assert.equal(store.getSessionFastMode("new-grandchild"), true);
  const reopened = new HarnessStore(databasePath);
  try { assert.equal(reopened.getSessionFastMode("grandchild"), true); } finally { reopened.close(); }
  for (const sessions of [store.listNavigatorSessions().sessions, store.listSessions(), store.listSearchableSessions("root", { includeSelf: true })]) {
    for (const session of sessions) {
      const related = !session.sessionId.startsWith("other");
      assert.equal(session.launch.fastMode, related);
      assert.equal(session.launch.fastModeRootSessionId, related ? "root" : "other");
    }
  }
  assert.throws(() => store.getSessionFastMode("missing"), /unavailable/);
});

for (const [name, mutation] of [
  ["missing parent", "UPDATE sessions SET parent_session_id = 'missing' WHERE id = 'child'"],
  ["deleted parent", "UPDATE sessions SET lifecycle = 'deleted' WHERE id = 'child'"],
  ["deleted root", "UPDATE sessions SET lifecycle = 'deleted' WHERE id = 'root'"],
  ["cycle", "UPDATE sessions SET parent_session_id = 'child' WHERE id = 'root'"],
  ["wrong depth", "UPDATE sessions SET depth = 12 WHERE id = 'child'"],
  ["wrong kind", "UPDATE sessions SET kind = 'root' WHERE id = 'child'"],
  ["root with parent", "UPDATE sessions SET parent_session_id = 'other' WHERE id = 'root'"],
  ["overlong ancestry", "UPDATE sessions SET depth = 65 WHERE id = 'grandchild'"],
]) test(`Fast fails closed for ${name}, without a shared-family fallback`, async t => {
  const { store, raw } = await storeFixture(t);
  store.updateSessionFastMode("root", true, false); store.updateSessionFastMode("other", true, false);
  raw.exec(mutation);
  assert.deepEqual(store.getSessionFastModePreference("grandchild"), { fastMode: null, fastModeRootSessionId: null });
  assert.throws(() => store.getSessionFastMode("grandchild"), /unavailable/);
  assert.throws(() => store.updateSessionFastMode("grandchild", false, true), /only the root/);
  const projected = store.getSession("grandchild").launch;
  assert.equal(projected.fastMode, null); assert.equal(projected.fastModeRootSessionId, null);
  const navigated = store.listNavigatorSessions().sessions.find(session => session.sessionId === "grandchild");
  assert.equal(navigated.launch.fastMode, null); assert.equal(navigated.launch.fastModeRootSessionId, null);
  assert.equal(store.getSessionFastMode("other-child"), true);
});

test("legacy absent Fast preference defaults off through root/child revival and only explicit toggles persist it", async t => {
  const { store, raw, root, databasePath } = await storeFixture(t);
  raw.exec("UPDATE sessions SET launch_json = json_remove(launch_json, '$.fastMode') WHERE id IN ('root', 'child')");
  const storedLaunch = id => raw.prepare("SELECT launch_json FROM sessions WHERE id = ?").get(id).launch_json;
  const original = Object.fromEntries(["root", "child"].map(id => [id, storedLaunch(id)]));
  const assertOff = () => {
    for (const id of ["root", "child", "grandchild"]) {
      assert.deepEqual(store.getSessionFastModePreference(id), { fastMode: false, fastModeRootSessionId: "root" });
      assert.equal(store.getSession(id).launch.fastMode, false);
      assert.equal(store.getSessionFastMode(id), false, "legacy request preparation remains dispatchable");
    }
    for (const sessions of [store.listNavigatorSessions().sessions, store.listSessions(), store.listSearchableSessions("root", { includeSelf: true })]) {
      for (const session of sessions.filter(session => ["root", "child", "grandchild"].includes(session.sessionId))) {
        assert.equal(session.launch.fastMode, false);
        assert.equal(session.launch.fastModeRootSessionId, "root");
      }
    }
  };
  assertOff();
  store.admitRoot({ ...root("root"), launch: undefined });
  for (const id of ["root", "child"]) {
    store.markActorStarted(id, 1);
    store.markActorLifecycle(id, 1, "passivated");
    assert.equal(store.prepareActorRevival(id, `${id}-revived`).launch.fastMode, false);
    store.markActorStarted(id, 2);
  }
  assertOff();
  const reopened = new HarnessStore(databasePath);
  try {
    for (const id of ["root", "child"]) assert.equal(reopened.getSessionFastMode(id), false);
  } finally { reopened.close(); }
  for (const id of ["root", "child"]) assert.equal(storedLaunch(id), original[id], "sampling/revival never backfill legacy launch state");
  store.updateSessionFastMode("root", true, false);
  for (const id of ["root", "child", "grandchild"]) assert.equal(store.getSessionFastMode(id), true);
  assert.equal(JSON.parse(storedLaunch("root")).fastMode, true);
  assert.equal(storedLaunch("child"), original.child, "root toggles do not rewrite child-local state");
  store.updateSessionFastMode("root", false, true);
  assertOff();
});

test("malformed root preferences and launch values stay unknown and cannot dispatch", async t => {
  const { store, raw } = await storeFixture(t);
  const launch = store.getActorLaunch("root").launch;
  const malformed = [null, "true", 1, {}, []].map(fastMode => JSON.stringify({ ...launch, fastMode }));
  malformed.push("null", "[]", '"legacy"', "1", "true", "{");
  for (const value of malformed) {
    raw.prepare("UPDATE sessions SET launch_json = ? WHERE id = 'root'").run(value);
    for (const id of ["root", "child"]) {
      assert.deepEqual(store.getSessionFastModePreference(id), { fastMode: null, fastModeRootSessionId: "root" });
      assert.throws(() => store.getSessionFastMode(id), /unavailable/);
    }
    assert.equal(store.getSession("child").launch.fastMode, null);
    assert.throws(() => store.updateSessionFastMode("root", true, false), /unavailable/);
  }
});


test("Fast resolves the supported 64-edge boundary and rejects deeper ancestry", async t => {
  const { store, child } = await storeFixture(t);
  store.updateSessionFastMode("root", true, false);
  let parent = "grandchild";
  for (let depth = 3; depth <= 65; depth += 1) {
    const id = `depth-${depth}`; child(parent, id); parent = id;
  }
  assert.deepEqual(store.getSessionFastModePreference("depth-64"), { fastMode: true, fastModeRootSessionId: "root" });
  assert.deepEqual(store.getSessionFastModePreference("depth-65"), { fastMode: null, fastModeRootSessionId: null });
  assert.throws(() => store.getSessionFastMode("depth-65"), /unavailable/);
});


test("cycle-member session projection terminates and preserves acyclic/deleted descendant counts", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fast-cycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A synchronous SQLite loop cannot be interrupted by node:test's in-process timeout.
  // Bound this regression in a disposable process instead.
  const script = `
    import assert from "node:assert/strict";
    import { DatabaseSync } from "node:sqlite";
    import { HarnessStore } from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};
    const dir = process.argv[1], database = dir + "/state.sqlite";
    const store = new HarnessStore(database), raw = new DatabaseSync(database);
    try {
      store.createRoot({ sessionId: "root", cwd: dir, actorToken: "root", launch: {} });
      store.createRoot({ sessionId: "other", cwd: dir, actorToken: "other", launch: {} });
      store.createChild("root", { sessionId: "child", actorToken: "child", policy: { name: "child" } });
      store.createChild("child", { sessionId: "grandchild", actorToken: "grandchild", policy: { name: "grandchild" } });
      raw.exec("UPDATE sessions SET activity = 'working'");
      assert.equal(store.getSession("root").workingDescendantCount, 2);
      assert.equal(store.getSession("child").workingDescendantCount, 1);
      assert.equal(store.getSession("grandchild").workingDescendantCount, 0);
      assert.equal(store.getSession("other").workingDescendantCount, 0);
      raw.exec("UPDATE sessions SET lifecycle = 'deleted' WHERE id = 'child'");
      assert.equal(store.getSession("root").workingDescendantCount, 0, "deleted intermediate cuts the subtree");
      raw.exec("UPDATE sessions SET lifecycle = 'resident' WHERE id = 'child'");
      assert.equal(store.getSession("root").workingDescendantCount, 2);
      raw.exec("UPDATE sessions SET parent_session_id = 'child' WHERE id = 'root'");
      for (const id of ["root", "child"]) {
        const session = store.getSession(id);
        assert.equal(session.workingDescendantCount, 2, "cycle repeats neither duplicate nor count the queried session");
        assert.equal(session.launch.fastMode, null);
        assert.equal(session.launch.fastModeRootSessionId, null);
      }
      raw.exec("UPDATE sessions SET parent_session_id = NULL WHERE id = 'root'; UPDATE sessions SET parent_session_id = 'child' WHERE id = 'child'");
      assert.equal(store.getSession("child").workingDescendantCount, 1, "self-loop excludes itself");
      assert.equal(store.getSession("child").launch.fastModeRootSessionId, null);
      console.log("bounded descendant projections passed");
    } finally { raw.close(); store.close(); }
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, dir], {
    timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8",
    env: { ...process.env, HOME: dir, PI_CODING_AGENT_DIR: path.join(dir, "agent") },
  });
  assert.equal(output.trim(), "bounded descendant projections passed");
});
