import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";

test("discoverable attention and exact-run cron Python APIs preserve narrow host payloads", { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notification-skills-")), packageRoot = path.resolve(import.meta.dirname, "..");
  let kernel; t.after(async () => { await kernel?.close(); await rm(root, { recursive: true, force: true }); });
  const catalog = await discoverSkills(["agent-message", "cron"].map(name => ({ source: "skill", path: path.join(packageRoot, "skills", name, "SKILL.md") })));
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.skills.find(s => s.id === "agent-message").python.hostRequests.sort(), ["agent_message.list_agents", "agent_message.request_attention", "agent_message.resolve_attention", "agent_message.send"].sort());
  assert.deepEqual(catalog.skills.find(s => s.id === "cron").python.hostRequests, ["cron.manage"]);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: catalog.skills, consent: async () => true });
  const calls = [], handlers = Object.fromEntries(["agent_message.request_attention", "agent_message.resolve_attention", "cron.manage"].map(name => [name, async payload => { calls.push({ name, payload }); return { accepted: true }; }]));
  kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(packageRoot, "python-runtime/kernel.py"), runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: root, stateDir: path.join(root, "state"), manifest: manifestForSkills(catalog.skills), hostHandlers: handlers });
  await kernel.start(); const result = await kernel.execute(`
assert agent_message.request_attention("choice", "Exact title", "Exact request")["accepted"]
assert (await agent_message.resolve_attention("choice"))["accepted"]
await cron(action="create", name="Check", prompt="Task", schedule={"kind":"every", "intervalSeconds":60}, notification_intent="conditional")
await cron(action="report", run_id="exact-run", disposition="deliver", body="Exact finding")
await cron(action="report", run_id="other-run", disposition="no_finding")
await cron(action="create", name="Legacy", prompt="Original", schedule={"kind":"every", "intervalSeconds":60})
print("notification-skill-contract-ok")
`);
  assert.equal(result.ok, true, result.error || result.stderr); assert.match(result.stdout, /notification-skill-contract-ok/);
  assert.deepEqual(calls, [
    { name: "agent_message.request_attention", payload: { key: "choice", title: "Exact title", body: "Exact request", expiresIn: 86400 } },
    { name: "agent_message.resolve_attention", payload: { key: "choice" } },
    { name: "cron.manage", payload: { action: "create", name: "Check", prompt: "Task", schedule: { kind: "every", intervalSeconds: 60 }, executionMode: "fresh", repeat: null, notificationIntent: "conditional" } },
    { name: "cron.manage", payload: { action: "report", runId: "exact-run", disposition: "deliver", body: "Exact finding" } },
    { name: "cron.manage", payload: { action: "report", runId: "other-run", disposition: "no_finding" } },
    { name: "cron.manage", payload: { action: "create", name: "Legacy", prompt: "Original", schedule: { kind: "every", intervalSeconds: 60 }, executionMode: "fresh", repeat: null } },
  ]);
});
