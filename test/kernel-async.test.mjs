import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const support = path.join(packageRoot, "python-runtime");
const manifest = { version: 1, skills: [{
  id: "fixture", alias: "fixture", version: "1", skillPath: import.meta.filename,
  instructions: "Local deterministic kernel fixture.",
  python: { srcPath: support, importName: "_persistent_harness", hostRequests: ["fixture.gate"] },
}] };
const deferred = () => Promise.withResolvers();
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, hostHandler, KernelClass = PythonKernel) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-kernel-async-"));
  const previousIpythonDir = process.env.IPYTHONDIR;
  process.env.IPYTHONDIR = path.join(root, "ipython");
  t.after(() => {
    if (previousIpythonDir === undefined) delete process.env.IPYTHONDIR;
    else process.env.IPYTHONDIR = previousIpythonDir;
  });
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  const options = { pythonPath: runtime.pythonPath, kernelScript: path.join(support, "kernel.py"),
    runtimeSupportDir: support, cwd: root, stateDir: path.join(root, "state"), manifest,
    hostHandlers: { "fixture.gate": hostHandler } };
  const kernel = new KernelClass(options);
  t.after(async () => {
    kernel.interrupt();
    await kernel.close({ snapshot: false });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { kernel, root, options };
}

const gateCode = (name) => `fixture.host_request("fixture.gate", {"name": "${name}"})`;

test("pre-aborted cells do not start the kernel or mutate its namespace", { timeout: 30_000 }, async (t) => {
  const { kernel } = await fixture(t, () => { throw new Error("must not execute"); });
  const controller = new AbortController(); controller.abort();
  const result = await kernel.execute("cancelled_value = 1", { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "AbortError");
  assert.equal(kernel.isRunning, false);
  assert.equal(kernel.snapshotStats.generation, 0);
  assert.equal((await kernel.execute("'cancelled_value' in globals()")).mime["text/plain"], "False");
});

test("cancellation during startup never admits a cell", { timeout: 30_000 }, async (t) => {
  const starting = deferred(); const release = deferred();
  t.after(() => release.resolve());
  class HeldStartupKernel extends PythonKernel {
    async start() {
      const ready = super.start(); starting.resolve();
      await release.promise;
      return ready;
    }
  }
  const { kernel } = await fixture(t, () => {}, HeldStartupKernel);
  const controller = new AbortController();
  const execution = kernel.execute("startup_cancelled_value = True", { signal: controller.signal });
  await starting.promise; controller.abort(); release.resolve();
  assert.equal((await execution).errorType, "AbortError");
  assert.equal(kernel.snapshotStats.generation, 0);
  assert.equal((await kernel.execute("'startup_cancelled_value' in globals()")).mime["text/plain"], "False");
});

test("queued cancellation never interrupts the active cell or enters the FIFO namespace", { timeout: 30_000 }, async (t) => {
  const started = deferred(); const release = deferred(); const calls = [];
  t.after(() => release.resolve());
  const { kernel } = await fixture(t, async ({ name }) => {
    calls.push(name); started.resolve(); await release.promise; return "released";
  });
  const first = kernel.execute(`${gateCode("A")}\nvalue_from_a = 41`);
  await started.promise;
  const controller = new AbortController();
  const second = kernel.execute("cancelled_value = True", { signal: controller.signal });
  controller.abort();
  await tick();
  assert.equal(kernel.isBusy, true);
  assert.deepEqual(calls, ["A"]);
  release.resolve();
  assert.equal((await first).ok, true, "cancelling B must not interrupt A");
  assert.equal((await second).errorType, "AbortError");
  assert.equal(kernel.snapshotStats.generation, 1, "only A was admitted");
  assert.equal((await kernel.execute("value_from_a + 1, 'cancelled_value' in globals()")).mime["text/plain"], "(42, False)");
});

test("cells execute FIFO while the host remains responsive", { timeout: 30_000 }, async (t) => {
  const started = deferred(); const release = deferred(); const calls = [];
  t.after(() => release.resolve());
  const { kernel } = await fixture(t, async ({ name }) => {
    calls.push(name);
    if (name === "A") { started.resolve(); await release.promise; }
    return name;
  });
  const first = kernel.execute(`${gateCode("A")}\nshared_value = 41`);
  await started.promise;
  const second = kernel.execute(`${gateCode("B")}\nshared_value + 1`);
  await tick();
  assert.deepEqual(calls, ["A"], "B cannot enter the namespace while A executes");
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).mime["text/plain"], "42");
  assert.deepEqual(calls, ["A", "B"]);
});

test("active abort and queued abort leave a usable ordinary kernel", { timeout: 30_000 }, async (t) => {
  const started = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const { kernel } = await fixture(t, async (_payload, { signal }) => {
    started.resolve();
    await Promise.race([release.promise, new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
    return "late";
  });
  const controller = new AbortController();
  const first = kernel.execute(`${gateCode("A")}\nafter_abort = True`, { signal: controller.signal });
  await started.promise;
  const second = kernel.execute("queued_after_abort = True", { signal: controller.signal });
  controller.abort();
  assert.equal((await first).ok, false);
  assert.equal((await second).errorType, "AbortError");
  assert.equal((await kernel.execute("'after_abort' in globals(), 'queued_after_abort' in globals()")).mime["text/plain"], "(False, False)");
});

test("late host completion and progress cannot enter a later cell", { timeout: 30_000 }, async (t) => {
  const aStarted = deferred(); const bStarted = deferred(); const releaseA = deferred(); const releaseB = deferred();
  const aFinished = deferred();
  t.after(() => { releaseA.resolve(); releaseB.resolve(); });
  const { kernel } = await fixture(t, async ({ name }, { onProgress }) => {
    if (name === "A") { aStarted.resolve(); await releaseA.promise; onProgress("stdout", "STALE"); aFinished.resolve(); }
    else { bStarted.resolve(); await releaseB.promise; }
    return name;
  });
  const controller = new AbortController();
  const first = kernel.execute(gateCode("A"), { signal: controller.signal });
  await aStarted.promise; controller.abort();
  assert.equal((await first).ok, false);
  const second = kernel.execute(gateCode("B"));
  await bStarted.promise;
  releaseA.resolve(); await aFinished.promise; await tick();
  releaseB.resolve();
  const result = await second;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mime["text/plain"], "'B'");
  assert.doesNotMatch(result.stdout, /STALE/);
});

test("kernel death invalidates already queued cells without replaying side effects", { timeout: 30_000 }, async (t) => {
  const started = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const { kernel, root, options } = await fixture(t, async () => {
    started.resolve(); await release.promise; return null;
  });
  await kernel.execute("snapshot_value = 41");
  await kernel.snapshot();
  const first = kernel.execute(`from pathlib import Path\nPath("side-effect").write_text("exactly once")\n${gateCode("A")}\nsnapshot_value = 99`);
  await started.promise;
  const second = kernel.execute('from pathlib import Path\nPath("queued-side-effect").write_text("must not run")');
  kernel.terminateForRecovery();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(await readFile(path.join(root, "side-effect"), "utf8"), "exactly once");
  await assert.rejects(readFile(path.join(root, "queued-side-effect")), /ENOENT/);
  release.resolve();
  await kernel.close({ snapshot: false });
  const replacement = new PythonKernel(options);
  try {
    await replacement.start();
    assert.equal((await replacement.execute("snapshot_value + 1")).mime["text/plain"], "42");
  } finally { await replacement.close({ snapshot: false }); }
});

const checkpointFor = (toolCallId) => ({ version: 1, sessionId: "synthetic-native-session", toolCallId, actorGeneration: 1 });

test("native results wait for a durable namespace checkpoint inside the same FIFO slot", { timeout: 30_000 }, async (t) => {
  const snapshotStarted = deferred(); const releaseSnapshot = deferred();
  t.after(() => releaseSnapshot.resolve());
  const { kernel, root, options } = await fixture(t, async () => {
    snapshotStarted.resolve(); await releaseSnapshot.promise; return null;
  });
  let firstSettled = false;
  const first = kernel.execute([
    "import os",
    "from pathlib import Path",
    "_original_fsync = os.fsync",
    "_held_once = False",
    "def _held_fsync(fd):",
    "    global _held_once",
    "    if not _held_once:",
    "        _held_once = True",
    `        ${gateCode("snapshot")}`,
    "    return _original_fsync(fd)",
    "os.fsync = _held_fsync",
    "checkpoint_value = 41",
  ].join("\n"), { namespaceCheckpoint: checkpointFor("A") }).then((result) => {
    firstSettled = true;
    const manifest = JSON.parse(readFileSync(path.join(options.stateDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.namespaceCheckpoint, result.namespaceCheckpoint);
    return result;
  });
  await snapshotStarted.promise;
  const second = kernel.execute('Path("B-started").write_text("started")\ncheckpoint_value + 1', {
    namespaceCheckpoint: checkpointFor("B"),
  });
  await tick();
  assert.equal(firstSettled, false, "the real execute promise includes snapshot durability");
  await assert.rejects(readFile(path.join(root, "B-started")), /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  releaseSnapshot.resolve();
  const resultA = await first; const resultB = await second;
  assert.equal(resultA.ok, true, JSON.stringify(resultA));
  assert(resultA.checkpointDurationMs >= 60, "checkpoint timing includes the held durability operation");
  assert(resultA.executionDurationMs >= 0);
  assert(resultA.durationMs >= resultA.executionDurationMs + resultA.checkpointDurationMs,
    "reported duration includes both execution and durability");
  assert.deepEqual(resultA.namespaceCheckpoint, { ...checkpointFor("A"), executionId: resultA.executionId });
  assert.equal(resultB.mime["text/plain"], "42");
  assert.deepEqual(resultB.namespaceCheckpoint, { ...checkpointFor("B"), executionId: resultB.executionId });
  assert.equal(kernel.snapshotStats.dirty, false);
  await kernel.close({ snapshot: false });
  const replacement = new PythonKernel(options);
  try {
    const ready = await replacement.start();
    assert.deepEqual(ready.restore.namespaceCheckpoint, resultB.namespaceCheckpoint);
    assert.equal((await replacement.execute("checkpoint_value")).mime["text/plain"], "41");
  } finally { await replacement.close({ snapshot: false }); }
});

test("failed native cells checkpoint their actual partial mutation without claiming execution success", { timeout: 30_000 }, async (t) => {
  const { kernel, options } = await fixture(t, () => {});
  const result = await kernel.execute('partial_native_value = 77\nraise RuntimeError("after mutation")', {
    namespaceCheckpoint: checkpointFor("partial"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "RuntimeError");
  assert.deepEqual(result.namespaceCheckpoint, { ...checkpointFor("partial"), executionId: result.executionId });
  await kernel.close({ snapshot: false });
  const replacement = new PythonKernel(options);
  try {
    const ready = await replacement.start();
    assert.deepEqual(ready.restore.namespaceCheckpoint, result.namespaceCheckpoint);
    assert.equal((await replacement.execute("partial_native_value")).mime["text/plain"], "77");
  } finally { await replacement.close({ snapshot: false }); }
});

test("native checkpoint failure preserves the previous snapshot and reports possible side effects", { timeout: 30_000 }, async (t) => {
  const { kernel, root, options } = await fixture(t, () => {});
  const seed = await kernel.execute("durable_value = 41", { namespaceCheckpoint: checkpointFor("seed") });
  const result = await kernel.execute([
    "import os",
    "from pathlib import Path",
    'Path("native-side-effect").write_text("once")',
    "durable_value = 99",
    "def _failed_fsync(fd):",
    '    raise OSError("fixture durability failure")',
    "os.fsync = _failed_fsync",
  ].join("\n"), { namespaceCheckpoint: checkpointFor("unknown") });
  assert.equal(result.ok, false);
  assert.equal(result.executionOk, true, "code completion differs from namespace durability");
  assert.equal(result.errorType, "NamespaceCheckpointError");
  assert.match(result.error, /fixture durability failure.*Side effects may have occurred/);
  assert.equal(result.namespaceCheckpoint, undefined);
  assert.deepEqual(result.namespaceCheckpointAttempt, { ...checkpointFor("unknown"), executionId: result.executionId });
  await kernel.close({ snapshot: false });
  const replacement = new PythonKernel(options);
  try {
    const ready = await replacement.start();
    assert.deepEqual(ready.restore.namespaceCheckpoint, seed.namespaceCheckpoint);
    assert.equal((await replacement.execute("durable_value")).mime["text/plain"], "41");
    assert.equal(await readFile(path.join(root, "native-side-effect"), "utf8"), "once");
  } finally { await replacement.close({ snapshot: false }); }
});

test("native cancellation during snapshot does not mark an unpublished namespace clean", { timeout: 30_000 }, async (t) => {
  const snapshotStarted = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const { kernel } = await fixture(t, async () => {
    snapshotStarted.resolve(); await release.promise; return null;
  });
  const controller = new AbortController();
  const execution = kernel.execute([
    "import os",
    "_original_fsync = os.fsync",
    "def _held_fsync(fd):",
    `    ${gateCode("snapshot")}`,
    "    return _original_fsync(fd)",
    "os.fsync = _held_fsync",
    "snapshot_cancel_value = 41",
  ].join("\n"), { signal: controller.signal, namespaceCheckpoint: checkpointFor("snapshot-cancel") });
  await snapshotStarted.promise; controller.abort();
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "NamespaceCheckpointError");
  assert.equal(result.namespaceCheckpoint, undefined);
  assert.equal(kernel.snapshotStats.dirty, true, "interrupted snapshot was not published");
  assert.equal(kernel.snapshotStats.snapshotGeneration, 0);
  release.resolve();
  assert.equal((await kernel.execute("snapshot_cancel_value")).mime["text/plain"], "41");
});

test("rejected snapshot manifests cannot crash startup or supply a trusted checkpoint", { timeout: 60_000 }, async (t) => {
  for (const [name, manifest] of [
    ["list", [1]], ["string", "invalid snapshot"], ["number", 7], ["boolean", true],
    ["invalid checkpoint", { version: 1, saved: [], namespaceCheckpoint: { version: 999 } }],
    ["invalid manifest version", { version: 999, saved: [], namespaceCheckpoint: { ...checkpointFor("invalid"), executionId: "invalid" } }],
  ]) {
    await t.test(name, async (t) => {
      const { kernel, options } = await fixture(t, () => {});
      await mkdir(options.stateDir, { recursive: true });
      await writeFile(path.join(options.stateDir, "manifest.json"), JSON.stringify(manifest));
      const ready = await kernel.start();
      assert.deepEqual(ready.restore.restored, []);
      assert(ready.restore.skipped.length > 0);
      assert.equal(ready.restore.namespaceCheckpoint, null);
      assert.equal((await kernel.execute("1 + 1")).mime["text/plain"], "2");
    });
  }
});
