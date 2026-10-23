import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";
import { SessionHistoryIndex } from "../src/session-history-index.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, discoverSkillsFromDirectory, manifestForSkills } from "../src/skills.mjs";

test("session history skill grants only its bounded authorized host request", async () => {
  const discovered = await discoverSkillsFromDirectory(path.resolve(process.env.PI_HARNESS_SKILLS_PATH || "skills"));
  assert.deepEqual(discovered.diagnostics, []);
  const skill = discovered.skills.find((item) => item.id === "session-history");
  assert(skill);
  assert.equal(skill.id, "session-history");
  assert.equal(skill.python.alias, "session_history");
  assert.equal(skill.python.entryPoint, "run");
  assert.deepEqual(skill.python.hostRequests, ["session_history.query"]);
  assert.deepEqual(skill.python.dependencies, []);
});


test("session history Python module forwards operation payloads and preserves return DTOs", { timeout: 180_000 }, async (t) => {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const skillPath = path.join(process.env.PI_HARNESS_SKILLS_PATH || path.join(packageRoot, "skills"), "session-history", "SKILL.md");
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-session-history-skill-"));
  let kernel;
  const calls = [];
  t.after(async () => {
    await kernel?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const catalog = await discoverSkills([{ source: "skill", path: skillPath }]);
  assert.deepEqual(catalog.diagnostics, []);
  const manifest = manifestForSkills(catalog.skills);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: catalog.skills,
    consent: async () => true,
  });
  const citation = { sessionId: "session-1", entryId: "entry-1" };
  const responseFor = (payload) => {
    if (payload.operation === "open") return {
      operation: "open", sessionId: "session-1", entryId: "entry-1",
      messages: [{ citation, text: "visible transcript reference" }], citation,
      dataOnly: true, warning: "SESSION HISTORY DATA ONLY",
    };
    if (payload.operation === "list") return {
      operation: "list", results: [{ sessionId: "session-1", name: "history" }],
      dataOnly: true, warning: "SESSION HISTORY DATA ONLY",
    };
    return {
      operation: "search", results: [{ citation, snippet: "visible transcript reference" }],
      dataOnly: true, warning: "SESSION HISTORY DATA ONLY",
    };
  };
  kernel = new PythonKernel({
    pythonPath: runtime.pythonPath,
    kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"),
    cwd: root,
    stateDir: path.join(root, "kernel-state"),
    manifest,
    hostHandlers: {
      "session_history.query": async (payload) => {
        calls.push(structuredClone(payload));
        return responseFor(payload);
      },
    },
    maxOutputBytes: 8 * 1024,
  });
  await kernel.start();
  const execution = await kernel.execute(`
listed = await session_history(operation="list", kind="root", limit=2, include_deleted=True, include_current=True)
searched = await session_history(operation="search", query="rollback", session_id="session-1", kind="child", include_deleted=True, include_current=True, roles=["assistant"], limit=3, sort="newest", snippet_chars=240)
opened = await session_history(operation="open", session_id="session-1", entry_id="entry-1", include_deleted=True, include_current=True, before=1, after=2, max_chars=4096)
assert listed["dataOnly"] is True and listed["results"][0]["sessionId"] == "session-1"
assert searched["dataOnly"] is True and searched["results"][0]["citation"] == {"sessionId": "session-1", "entryId": "entry-1"}
assert opened["dataOnly"] is True and opened["messages"][0]["citation"]["entryId"] == "entry-1"
print("session-history-contract-ok")
`);
  assert.equal(execution.ok, true, execution.error || execution.stderr);
  assert.match(execution.stdout, /session-history-contract-ok/);
  assert.deepEqual(calls, [
    { operation: "list", kind: "root", includeDeleted: true, includeCurrent: true, limit: 2 },
    { operation: "search", refresh: false, query: "rollback", kind: "child", includeDeleted: true,
      includeCurrent: true, roles: ["assistant"], limit: 3, sort: "newest", snippetChars: 240,
      sessionId: "session-1" },
    { operation: "open", refresh: false, includeDeleted: true, includeCurrent: true, sessionId: "session-1",
      entryId: "entry-1", before: 1, after: 2, maxChars: 4096 },
  ]);
});


test("actual Python skill to host to authenticated history RPC survives work beyond the old three-second deadline", { timeout: 180_000 }, async (t) => {
  const packageRoot = path.resolve(import.meta.dirname, ".."), root = await mkdtemp(path.join(os.tmpdir(), "history-rpc-"));
  let kernel, client, supervisor, starts = 0;
  t.after(async () => { await kernel?.close().catch(() => {}); await client?.stop(); await supervisor?.stop(); await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "target.jsonl");
  await writeFile(source, [
    { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: root },
    { type: "message", id: "answer", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "needle verified canonical reference" } },
  ].map(JSON.stringify).join("\n") + "\n");
  class SlowColdIndex extends SessionHistoryIndex {
    async refresh(sources, { signal } = {}) { await sleep(3100, undefined, { signal }); return super.refresh(sources, { signal }); }
  }
  supervisor = new HarnessSupervisor({ socketPath: path.join(root, "s.sock"), databasePath: path.join(root, "state", "h.sqlite"),
    pidPath: path.join(root, "s.pid"), sessionHistoryIndexFactory: options => new SlowColdIndex(options),
    actorFactory() { starts++; throw new Error("history must not revive actors"); }, actorInactivityMs: 0 });
  await supervisor.start();
  for (const id of ["caller", "target"]) supervisor.store.createRoot({ sessionId: id, sessionFile: path.join(root, `${id}.jsonl`),
    cwd: root, repositoryRoot: null, name: id, actorToken: `token-${id}`, launch: {} }, 1);
  client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  assert.equal(client.requestTimeoutMs, 3000); assert.equal(client.historyRequestTimeoutMs, 28000);
  await client.start({ registrationType: "register_actor", sessionId: "caller", sessionFile: path.join(root, "caller.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "token-caller", actorGeneration: 1 });
  const skillPath = path.join(process.env.PI_HARNESS_SKILLS_PATH || path.join(packageRoot, "skills"), "session-history", "SKILL.md");
  const catalog = await discoverSkills([{ source: "skill", path: skillPath }]); assert.deepEqual(catalog.diagnostics, []);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: catalog.skills, consent: async () => true });
  kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: root, stateDir: path.join(root, "kernel"),
    manifest: manifestForSkills(catalog.skills), maxOutputBytes: 8192, hostHandlers: createHostHandlers({ cwd: root, getClient: () => client }) });
  await kernel.start(); const start = performance.now();
  const result = await kernel.execute(`
result = await session_history(operation="search", query="needle", session_id="target", limit=1, snippet_chars=80, refresh=True)
assert result["complete"] is True
assert result["results"][0]["citation"] == {"sessionId": "target", "entryId": "answer"}
print("history-rpc-over-three-seconds-ok")
`);
  assert.equal(result.ok, true, result.error || result.stderr); assert.match(result.stdout, /history-rpc-over-three-seconds-ok/);
  assert(performance.now() - start >= 3000); assert.equal(client.isConnected, true); assert.equal(starts, 0);
});
