import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");

async function commandsForBuiltins(extra = []) {
  const names = ["files", "shell", "agent-message", "kernel", "operations"]; 
  return [
    ...names.map((name) => ({
      source: "skill",
      path: path.join(process.env.PI_HARNESS_SKILLS_PATH || path.join(packageRoot, "skills"), name, "SKILL.md"),
    })),
    ...extra,
  ];
}

function text(result) {
  return [result.stdout, result.stderr, result.mime?.["text/plain"], result.error].filter(Boolean).join("\n");
}

test("persistent kernel exposes unified skill help, host-backed calls, interruption, isolation, and restore", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-kernel-"));
  const kernels = [];
  // Keep managed reuse/rebuild checks separate from the external-interpreter override.
  // An explicit offline seed supplies only cached tool/interpreter/package prerequisites.
  if (process.env.PI_HARNESS_TEST_MANAGED_SEED) {
    await cp(process.env.PI_HARNESS_TEST_MANAGED_SEED, path.join(root, "runtime"), { recursive: true });
    process.env.UV_OFFLINE = "1";
    t.mock.method(globalThis, "fetch", () => { throw new Error("managed runtime fixture forbids network downloads"); });
  }
  t.after(async () => {
    await Promise.all(kernels.map((activeKernel) => activeKernel.close().catch(() => {})));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const workflowDir = path.join(root, "workflow");
  await mkdir(workflowDir, { recursive: true });
  const workflowPath = path.join(workflowDir, "SKILL.md");
  const workflowLines = Array.from({ length: 80 }, (_, i) => `Always verify the observable result line ${i}.`);
  await writeFile(
    workflowPath,
    "---\nname: workflow\ndescription: A guidance-only verification workflow.\n---\n\n# Verification Workflow\n\n"
      + workflowLines.join("\n")
      + "\n",
  );

  const catalog = await discoverSkills(await commandsForBuiltins([{ source: "skill", path: workflowPath }]));
  assert.deepEqual(catalog.diagnostics, []);
  const manifest = manifestForSkills(catalog.skills);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime"), pythonOverride: null }).ensure({
    skills: manifest.skills,
    consent: async () => true,
  });
  assert.equal(runtime.versions.python, "3.12.12");
  assert.equal(runtime.versions.ipython, "9.10.0");
  const reused = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime"), pythonOverride: null }).ensure({
    skills: manifest.skills,
    consent: async () => { throw new Error("completed runtime must not ask for consent again"); },
  });
  assert.equal(reused.environmentId, runtime.environmentId);
  const overridden = await new PythonRuntimeManager({
    runtimeDir: path.join(root, "unused-runtime"),
    pythonOverride: runtime.pythonPath,
  }).ensure({ skills: manifest.skills, consent: async () => false });
  assert.equal(overridden.managed, false);
  assert.equal(overridden.versions.ipython, "9.10.0");

  const sourceOnlyChange = structuredClone(manifest.skills);
  sourceOnlyChange[0].contentHash = "changed-local-source";
  const compatible = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime"), pythonOverride: null }).ensure({
    skills: sourceOnlyChange,
    consent: async () => { throw new Error("local skill source changes must reuse a dependency-compatible runtime"); },
  });
  assert.equal(compatible.environmentId, runtime.environmentId);
  assert.equal(compatible.compatible, true);

  const changedSkills = structuredClone(sourceOnlyChange);
  changedSkills[0].python.dependencies = ["six==1.17.0"];
  const [rebuilt, concurrentRebuild] = await Promise.all([
    new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime"), pythonOverride: null }).ensure({
      skills: changedSkills,
      consent: async () => true,
    }),
    new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime"), pythonOverride: null }).ensure({
      skills: changedSkills,
      consent: async () => true,
    }),
  ]);
  assert.notEqual(rebuilt.environmentId, runtime.environmentId);
  assert.equal(concurrentRebuild.environmentId, rebuilt.environmentId);

  const fakeRequests = [];
  const fakeClient = {
    isConnected: true,
    async request(type, payload) {
      fakeRequests.push({ type, payload });
      if (type === "get_roster") return { agents: [{ name: "root-a" }] };
      if (type === "send_message") return { message: { messageId: "message-1", ...payload } };
      if (type === "get_usage") return { window: { minutes: payload.windowMinutes, since: 1, observedAt: 2, boundaries: "inclusive" },
        aggregate: { entries: 1, sessions: 1, inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
          reasoningTokens: 1, totalTokens: 3, estimatedCost: 0.01 },
        byModel: [{ provider: "fake", model: "test-model", entries: 1, sessions: 1, inputTokens: 2, outputTokens: 1,
          cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1, totalTokens: 3, estimatedCost: 0.01 }], byModelTruncated: false };
      if (type === "get_status") return {
        daemon: { protocolVersion: 1, schemaVersion: 1, logPath: path.join(root, "events.jsonl") },
        capacity: { resident: 1, starting: 0, queued: 0, maxResident: 8, maxConcurrentStarts: 2 },
        counts: { sessions: { "root:idle": 1 }, children: {}, messages: {}, tasks: {} },
        usage: { entries: 0, totalTokens: 0, costTotal: 0, byModel: [] },
        diagnostics: [],
        sessions: [{ sessionId: "root", shortId: "root", name: "root-a", kind: "root", depth: 0, activity: "idle", lifecycle: "connected" }],
      };
      throw new Error(`unexpected request ${type}`);
    },
  };
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const recordedAgentMessages = [];
  const handlers = createHostHandlers({ cwd: workspace, getClient: () => fakeClient,
    recordAgentMessage: (message) => recordedAgentMessages.push(message) });
  const common = {
    pythonPath: runtime.pythonPath,
    kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"),
    cwd: workspace,
    manifest,
    hostHandlers: handlers,
    maxOutputBytes: 512,
  };
  const startupRecovery = new PythonKernel({
    ...common,
    kernelScript: path.join(root, "missing-kernel.py"),
    stateDir: path.join(root, "artifacts", "startup-recovery"),
  });
  kernels.push(startupRecovery);
  await assert.rejects(startupRecovery.start(), /Python kernel exited/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  startupRecovery.kernelScript = common.kernelScript;
  assert.equal((await startupRecovery.start()).type, "ready", "a startup rejection must not be cached permanently");
  await startupRecovery.close();

  let kernel = new PythonKernel({ ...common, stateDir: path.join(root, "artifacts", "one") });
  kernels.push(kernel);
  const ready = await kernel.start();
  assert.deepEqual(ready.skills, ["agent_message", "files", "kernel", "operations", "shell", "workflow"]);

  const workflowHelp = await kernel.execute("workflow?");
  assert.equal(workflowHelp.ok, true);
  assert.notEqual(workflowHelp.errorType, "EOFError");
  assert.equal(workflowHelp.truncated, true, "long skill?/pinfo output must be produced rather than aborting at the pager");
  assert.match(text(workflowHelp), /Always verify the observable result line 0/);
  assert.match(text(workflowHelp), /output truncated at 512 bytes/);
  const literalPayload = await kernel.execute(
    "name = 'EXPANDED'\npayload = \"\"\"keep $name and `echo hijacked` literal\"\"\"\npayload",
  );
  assert.equal(literalPayload.ok, true);
  assert.match(text(literalPayload), /keep \$name and `echo hijacked` literal/);
  assert.doesNotMatch(text(literalPayload), /EXPANDED/);
  const guidanceCall = await kernel.execute("workflow()");
  assert.equal(guidanceCall.ok, false);
  assert.match(text(guidanceCall), /guidance-only/);
  const filesHelp = await kernel.execute("files?");
  assert.match(text(filesHelp), /Bounded filesystem reading/);

  assert.equal((await kernel.execute("persistent_value = 40\npersistent_value + 2")).mime["text/plain"], "42");
  const fileCalls = await kernel.execute(
    "files.write('sample.txt', 'alpha\\ngamma\\n')\n"
      + "files.read('sample.txt')",
  );
  assert.equal(fileCalls.ok, true);
  assert.match(text(fileCalls), /gamma/);
  assert.equal(await readFile(path.join(workspace, "sample.txt"), "utf8"), "alpha\ngamma\n");
  const successfulEdit = await kernel.execute("files.edit('sample.txt', 'gamma', 'delta')");
  assert.equal(successfulEdit.ok, true);
  assert.match(text(successfulEdit), /replacements.*1/s);
  assert.equal(await readFile(path.join(workspace, "sample.txt"), "utf8"), "alpha\ndelta\n");
  await writeFile(path.join(workspace, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const attachment = await kernel.execute("files.attachment('pixel.png')");
  assert.equal(attachment.ok, true);
  assert.equal(attachment.mime["image/png"], "iVBORw==");

  const shellCall = await kernel.execute("shell.run(\"printf 'shell-ok'\")");
  assert.equal(shellCall.ok, true);
  assert.match(text(shellCall), /shell-ok/);
  let sawShellStart = false;
  const shellInterrupt = kernel.execute(
    "shell.run(\"printf 'shell-before\\n'; sleep 30; touch shell-should-not-exist\")",
    { onUpdate: ({ text: update }) => { if (update.includes("shell-before")) sawShellStart = true; } },
  );
  const shellDeadline = Date.now() + 5000;
  while (!sawShellStart && Date.now() < shellDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sawShellStart, true);
  kernel.interrupt();
  assert.equal((await shellInterrupt).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await assert.rejects(readFile(path.join(workspace, "shell-should-not-exist")), /ENOENT/);
  assert.equal((await kernel.execute("1 + 1")).mime["text/plain"], "2");
  const agentCall = await kernel.execute("agent_message.list_agents()\nagent_message.send('root-a', 'hello')");
  assert.equal(agentCall.ok, true);
  const awaitedAgentCall = await kernel.execute("await agent_message.send('root-a', 'awaited hello')");
  assert.equal(awaitedAgentCall.ok, true);
  assert.deepEqual(recordedAgentMessages, [
    { messageId: "message-1", target: "root-a", body: "hello", deliveryMode: "auto" },
    { messageId: "message-1", target: "root-a", body: "awaited hello", deliveryMode: "auto" },
  ]);
  await writeFile(path.join(root, "events.jsonl"), `${JSON.stringify({ event: "test", sessionId: "root" })}\n`);
  const operationsCall = await kernel.execute("operations.status()\noperations.diagnose()\noperations.usage(window_minutes=15)\noperations.events(limit=5)");
  assert.equal(operationsCall.ok, true);
  assert.match(text(operationsCall), /test/);
  assert.deepEqual(fakeRequests.map((item) => item.type), ["get_roster", "send_message", "send_message", "get_status", "get_status", "get_usage", "get_status"]);
  assert.deepEqual(fakeRequests.find((item) => item.type === "get_usage").payload, { windowMinutes: 15 });

  const ungranted = await kernel.execute("from _persistent_harness import host_request\nhost_request('not.granted', {})");
  assert.equal(ungranted.ok, false);
  assert.match(text(ungranted), /not granted/);

  let sawBeforeInterrupt = false;
  const interruptedPromise = kernel.execute(
    "import time\nprint('before-interrupt', flush=True)\ntime.sleep(30)\nafter_interrupt = True",
    { onUpdate: ({ text: update }) => { if (update.includes("before-interrupt")) sawBeforeInterrupt = true; } },
  );
  const deadline = Date.now() + 5000;
  while (!sawBeforeInterrupt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sawBeforeInterrupt, true);
  assert.equal(kernel.interrupt(), true);
  const interrupted = await interruptedPromise;
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.errorType, "KeyboardInterrupt");
  const afterInterrupt = await kernel.execute("persistent_value + 1, 'after_interrupt' in globals()");
  assert.equal(afterInterrupt.mime["text/plain"], "(41, False)");

  const oversized = await kernel.execute("print('x' * 2000); import sys; print('y' * 2000, file=sys.stderr)");
  assert.equal(oversized.truncated, true);
  assert.equal("fullOutputPath" in oversized, false);
  assert.match(oversized.stdout, /output truncated at 512 bytes/);
  assert.match(oversized.stderr, /output truncated at 512 bytes/);
  assert(Buffer.byteLength(oversized.stdout) < 600);
  assert(Buffer.byteLength(oversized.stderr) < 600);

  await kernel.execute("unsnapshotable = (item for item in range(3))");
  const snapshot = await kernel.snapshot();
  assert(snapshot.saved.some((item) => item.name === "persistent_value"));
  assert(snapshot.skipped.some((item) => item.name === "unsnapshotable"));
  await kernel.close();

  const addedDir = path.join(root, "added-live");
  await mkdir(addedDir);
  const addedPath = path.join(addedDir, "SKILL.md");
  await writeFile(addedPath, "---\nname: added-live\ndescription: Added after this session started.\n---\n\n# Added live\n");
  const refreshedCatalog = await discoverSkills(await commandsForBuiltins([
    { source: "skill", path: workflowPath },
    { source: "skill", path: addedPath },
  ]));
  common.manifest = manifestForSkills(refreshedCatalog.skills);
  kernel = new PythonKernel({ ...common, stateDir: path.join(root, "artifacts", "one") });
  kernels.push(kernel);
  const restored = await kernel.start();
  assert(restored.restore.restored.includes("persistent_value"));
  assert(restored.restore.skipped.some((item) => item.name === "unsnapshotable"));
  assert(restored.skills.includes("added_live"), "a clean replacement kernel must load the refreshed executable manifest");
  assert.equal((await kernel.execute("persistent_value + 2")).mime["text/plain"], "42");
  assert.match(text(await kernel.execute("files?")), /Bounded filesystem reading/);

  await kernel.execute("recovery_value = 73");
  await kernel.snapshot();
  assert.equal(kernel.terminateForRecovery(), true);
  const crashed = await kernel.execute("recovery_value + 1");
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /Python kernel exited|control channel is closed|ECONNRESET/);
  await kernel.close({ snapshot: false });
  kernel = new PythonKernel({ ...common, stateDir: path.join(root, "artifacts", "one") });
  kernels.push(kernel);
  const crashRestored = await kernel.start();
  assert(crashRestored.restore.restored.includes("recovery_value"));
  assert.equal((await kernel.execute("recovery_value + 1")).mime["text/plain"], "74");

  const stubborn = new PythonKernel({
    ...common,
    stateDir: path.join(root, "artifacts", "stubborn"),
    interruptTimeoutMs: 100,
  });
  kernels.push(stubborn);
  await stubborn.start();
  const stubbornExecution = stubborn.execute(
    "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint('stubborn', flush=True)\ntime.sleep(30)",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stubborn.interrupt(), true);
  const escalated = await stubbornExecution;
  assert.equal(escalated.ok, false);
  assert.match(escalated.error, /Python kernel exited|ECONNRESET/);
  await stubborn.close({ snapshot: false });

  const isolated = new PythonKernel({ ...common, stateDir: path.join(root, "artifacts", "two") });
  kernels.push(isolated);
  await isolated.start();
  assert.equal((await isolated.execute("'persistent_value' in globals()")).mime["text/plain"], "False");
});
