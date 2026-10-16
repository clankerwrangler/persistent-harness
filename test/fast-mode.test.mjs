import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { HarnessStore } from "../src/store.mjs";
import { supportsFastMode, fastModeOptions, streamSessionRequest } from "../src/fast-mode.mjs";
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


test("ordinary SSE observation preserves custom fetch, Response metadata, lazy pulls and cancellation", async () => {
  let forwarded, fetchCalls = 0, pulls = 0, canceled, hookArguments;
  const terminal = { role: "assistant", content: [], stopReason: "stop" };
  const source = { result: async () => terminal, async *[Symbol.asyncIterator]() { yield { type: "done", message: terminal }; } };
  const customFetch = async (...args) => {
    fetchCalls++; assert.deepEqual(args, ["synthetic-url", { method: "POST" }]);
    let sent = false;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; if (sent) controller.close(); else { sent = true; controller.enqueue(new TextEncoder().encode("synthetic")); } },
      cancel(reason) { canceled = reason; },
    }, { highWaterMark: 0 }), { status: 201, statusText: "Synthetic", headers: { "content-type": "text/event-stream; charset=utf-8", "x-test": "retained" } });
    for (const [key, value] of Object.entries({ url: "https://example.invalid/final", type: "cors", redirected: true })) Object.defineProperty(response, key, { value });
    return response;
  };
  const wrapped = streamSessionRequest({ streamSimple(_model, _context, options) { forwarded = options; return source; } },
    { provider: "openai-codex", api: "openai-codex-responses" }, {},
    { fetch: customFetch, onProviderStreamEvent(...args) { hookArguments = args; } }, {});
  assert.equal(pulls, 0); const response = await forwarded.fetch("synthetic-url", { method: "POST" });
  assert.equal(pulls, 0); assert.equal(response.bodyUsed, false);
  assert.equal(response.status, 201); assert.equal(response.statusText, "Synthetic"); assert.equal(response.headers.get("x-test"), "retained");
  assert.equal(response.url, "https://example.invalid/final"); assert.equal(response.type, "cors"); assert.equal(response.redirected, true);
  const reader = response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), "synthetic");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(pulls, 1, "observer must not read ahead"); assert.equal(response.bodyUsed, true);
  const reason = { synthetic: "cancel" }; await reader.cancel(reason); reader.releaseLock(); assert.equal(canceled, reason);
  const untouched = await forwarded.fetch("synthetic-url", { method: "POST" });
  const clone = untouched.clone(); assert.equal(clone.url, untouched.url); assert.equal(clone.type, untouched.type); assert.equal(clone.redirected, untouched.redirected);
  assert.equal(await clone.text(), "synthetic"); assert.equal(await untouched.text(), "synthetic");
  await forwarded.onProviderStreamEvent("event", "model"); assert.deepEqual(hookArguments, ["event", "model"]);
  assert.equal(fetchCalls, 2); assert.equal(await wrapped.result(), terminal);
  assert.deepEqual(await Array.fromAsync(wrapped), [{ type: "done", message: terminal }]);
  assert.equal(terminal.diagnostics, undefined);
});


for (const structuredAbort of [false, true]) test(`ordinary SSE excludes response-local cancellation without the request signal: structured=${structuredAbort}`, async () => {
  const optionsAbort = new AbortController(), fetchAbort = new AbortController();
  const reason = structuredAbort ? Object.assign(new Error("synthetic cancellation"), { name: "AbortError" }) : { synthetic: "custom abort reason" };
  let forwarded, resolveTerminal;
  const terminalPromise = new Promise(resolve => { resolveTerminal = resolve; });
  const source = { result: () => terminalPromise, async *[Symbol.asyncIterator]() {} };
  const wrapped = streamSessionRequest({ streamSimple(_model, _context, options) { forwarded = options; return source; } },
    { provider: "openai-codex", api: "openai-codex-responses" }, {}, {
      signal: optionsAbort.signal, fetch: async () => new Response(new ReadableStream({ pull(controller) {
        if (!structuredAbort) fetchAbort.abort(reason);
        controller.error(reason);
      } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }),
    }, {});
  const response = await forwarded.fetch("synthetic", { signal: fetchAbort.signal });
  await forwarded.onProviderStreamEvent({ type: "response.created" });
  await assert.rejects(response.text(), error => error === reason);
  assert.equal(optionsAbort.signal.aborted, false);
  assert.equal(fetchAbort.signal.aborted, !structuredAbort);
  const terminal = { role: "assistant", content: [], stopReason: "error", errorMessage: "unchanged original failure" };
  resolveTerminal(terminal);
  assert.equal(await wrapped.result(), terminal); assert.equal(terminal.errorMessage, "unchanged original failure");
  assert.equal(terminal.diagnostics, undefined);
});
