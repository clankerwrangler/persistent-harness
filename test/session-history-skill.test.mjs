import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    { operation: "search", query: "rollback", kind: "child", includeDeleted: true,
      includeCurrent: true, roles: ["assistant"], limit: 3, sort: "newest", snippetChars: 240,
      sessionId: "session-1" },
    { operation: "open", includeDeleted: true, includeCurrent: true, sessionId: "session-1",
      entryId: "entry-1", before: 1, after: 2, maxChars: 4096 },
  ]);
});
