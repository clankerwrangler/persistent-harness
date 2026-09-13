import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const checkpoint = { version: 1, sessionId: "deferred-fixture", toolCallId: "first", actorGeneration: 1 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (true) {
    try { await access(file); return; }
    catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
    await pause(10);
  }
}

async function fixture(t, { fail = false, real = false, interruptTimeoutMs = 2000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-deferred-checkpoint-"));
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  const synthetic = path.join(root, "kernel-fixture.py");
  await writeFile(synthetic, String.raw`
import json, os, signal, time
from pathlib import Path
root = Path(__file__).parent
control = os.fdopen(3, "r+b", buffering=0)
def emit(frame):
    control.write((json.dumps(frame) + "\n").encode())
emit({"type": "ready", "restore": {"found": False}})
checkpoint = None
interrupted = False
def on_interrupt(_signal, _frame):
    global interrupted
    interrupted = True
signal.signal(signal.SIGINT, on_interrupt)
for line in control:
    command = json.loads(line)
    kind, identity = command["type"], command["id"]
    if kind == "execute":
        checkpoint = command.get("namespaceCheckpoint")
        if command["code"] == "second":
            (root / "second-started").write_text("started")
        if command["code"] == "interrupted":
            (root / "execution-started").write_text("started")
            while not interrupted:
                time.sleep(0.005)
            emit({"type": "done", "id": identity, "ok": False,
                  "errorType": "KeyboardInterrupt", "error": "fixture execution interrupted"})
        else:
            emit({"type": "done", "id": identity, "ok": True})
    elif kind == "snapshot":
        (root / "snapshot-started").write_text("started")
        while not (root / "release").exists():
            time.sleep(0.01)
        if (root / "fail").exists():
            emit({"type": "snapshot_done", "id": identity, "ok": False, "error": "fixture checkpoint failure"})
        else:
            emit({"type": "snapshot_done", "id": identity, "ok": True, "snapshot": {
                "namespaceCheckpoint": checkpoint, "skipped": [], "saved": [], "stats": {}}})
    elif kind == "shutdown":
        emit({"type": "shutdown_done", "id": identity, "ok": True})
        break
`);
  if (fail) await writeFile(path.join(root, "fail"), "");
  const kernel = new PythonKernel({
    pythonPath: runtime.pythonPath,
    kernelScript: real ? path.join(packageRoot, "python-runtime", "kernel.py") : synthetic,
    runtimeSupportDir: path.join(packageRoot, "python-runtime"),
    cwd: root, stateDir: path.join(root, "state"), manifest: { version: 1, skills: [] }, hostHandlers: {}, interruptTimeoutMs,
  });
  t.after(async () => {
    await writeFile(path.join(root, "release"), "").catch(() => {});
    kernel.terminateForRecovery();
    await kernel.close({ snapshot: false });
    await rm(root, { recursive: true, force: true });
  });
  return { root, kernel, release: () => writeFile(path.join(root, "release"), "") };
}

test("deferred results finish before checkpointing while FIFO and callback retain ownership", { timeout: 15_000 }, async (t) => {
  const { root, kernel, release } = await fixture(t);
  const callbackStarted = Promise.withResolvers();
  const finishCallback = Promise.withResolvers();
  t.after(() => finishCallback.resolve());
  const controller = new AbortController();
  const result = await kernel.execute("first", {
    namespaceCheckpoint: checkpoint, checkpointInBackground: true, signal: controller.signal,
    onCheckpoint: async (outcome) => { callbackStarted.resolve(outcome); await finishCallback.promise; },
  });
  const original = structuredClone(result);
  assert.equal(result.ok, true);
  assert.equal(result.namespaceCheckpointState, "pending");
  assert.equal(result.namespaceCheckpoint, undefined);
  assert.equal(result.checkpointDurationMs, null);
  assert.equal(result.durationMs, result.executionDurationMs);
  await waitForFile(path.join(root, "snapshot-started"));
  assert.equal(kernel.isBusy, true);
  assert.equal(kernel.snapshotStats.dirty, true);
  // A completed Agent run aborts its old tool signal. That no longer owns the
  // checkpoint after the Python result has been delivered.
  controller.abort();
  const next = kernel.execute("second");
  await pause(60);
  await assert.rejects(readFile(path.join(root, "second-started")), /ENOENT/);
  await release();
  const outcome = await callbackStarted.promise;
  assert.equal(outcome.ok, true);
  assert(Object.isFrozen(outcome));
  assert(Object.isFrozen(outcome.namespaceCheckpointAttempt));
  assert(Object.isFrozen(outcome.namespaceCheckpoint));
  assert(outcome.checkpointDurationMs >= 60);
  assert.deepEqual(outcome.namespaceCheckpoint, result.namespaceCheckpointAttempt);
  await assert.rejects(readFile(path.join(root, "second-started")), /ENOENT/);
  finishCallback.resolve();
  assert.equal((await next).ok, true);
  assert.deepEqual(result, original, "late completion must not mutate an already published result");
  await kernel.close({ snapshot: false });
});

test("close waits for a failed deferred checkpoint and surfaces notification errors", { timeout: 15_000 }, async (t) => {
  const { root, kernel, release } = await fixture(t, { fail: true });
  const callback = Promise.withResolvers();
  const result = await kernel.execute("first", {
    namespaceCheckpoint: checkpoint, checkpointInBackground: true,
    onCheckpoint: async (outcome) => { callback.resolve(outcome); throw new Error("fixture notification failed"); },
  });
  const original = structuredClone(result);
  await waitForFile(path.join(root, "snapshot-started"));
  let closed = false;
  const closing = kernel.close({ snapshot: false }).then(() => { closed = true; });
  await pause(60);
  assert.equal(closed, false);
  await release();
  const outcome = await callback.promise;
  await closing;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /fixture checkpoint failure/);
  assert.equal(outcome.namespaceCheckpoint, undefined);
  assert.deepEqual(outcome.namespaceCheckpointAttempt, result.namespaceCheckpointAttempt);
  assert.equal(kernel.snapshotStats.dirty, true);
  assert.match(kernel.snapshotStats.checkpointError.error, /fixture notification failed/);
  assert.deepEqual(result, original);
  assert.equal(result.ok, true, "known execution success differs from checkpoint failure");
});

test("real deferred checkpoints preserve in-place mutations and recover their original identity", { timeout: 15_000 }, async (t) => {
  const { kernel } = await fixture(t, { real: true });
  const firstCheckpoint = Promise.withResolvers();
  const first = await kernel.execute("mutable = {'items': [1]}", {
    namespaceCheckpoint: checkpoint, checkpointInBackground: true,
    onCheckpoint: firstCheckpoint.resolve,
  });
  const secondCheckpoint = Promise.withResolvers();
  const second = await kernel.execute("mutable['items'].append(2)", {
    namespaceCheckpoint: { ...checkpoint, toolCallId: "second" }, checkpointInBackground: true,
    onCheckpoint: secondCheckpoint.resolve,
  });
  assert.equal(first.namespaceCheckpointState, "pending");
  assert.equal(second.namespaceCheckpointState, "pending");
  assert.equal((await firstCheckpoint.promise).ok, true);
  const saved = await secondCheckpoint.promise;
  assert.equal(saved.ok, true);
  await kernel.close({ snapshot: false });
  const restored = new PythonKernel({
    pythonPath: kernel.pythonPath, kernelScript: kernel.kernelScript, runtimeSupportDir: kernel.runtimeSupportDir,
    cwd: kernel.cwd, stateDir: kernel.stateDir, manifest: kernel.manifest, hostHandlers: {},
  });
  try {
    const ready = await restored.start();
    assert.deepEqual(ready.restore.namespaceCheckpoint, saved.namespaceCheckpoint);
    assert.equal((await restored.execute("mutable")).mime["text/plain"], "{'items': [1, 2]}");
  } finally { await restored.close({ snapshot: false }); }
});

test("interrupted execution cannot leave a kill timer attached to its deferred checkpoint", { timeout: 15_000 }, async (t) => {
  const { root, kernel, release } = await fixture(t, { interruptTimeoutMs: 50 });
  const checkpointDone = Promise.withResolvers();
  const controller = new AbortController();
  const execution = kernel.execute("interrupted", {
    namespaceCheckpoint: checkpoint, checkpointInBackground: true, signal: controller.signal,
    onCheckpoint: checkpointDone.resolve,
  });
  await waitForFile(path.join(root, "execution-started"));
  controller.abort();
  const result = await execution;
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "KeyboardInterrupt");
  assert.equal(result.namespaceCheckpointState, "pending");
  await waitForFile(path.join(root, "snapshot-started"));
  await pause(150);
  assert.equal(kernel.isRunning, true, "the old execution timer must not kill checkpoint work");
  assert.equal(kernel.snapshotStats.dirty, true);
  await release();
  const outcome = await checkpointDone.promise;
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.namespaceCheckpoint, result.namespaceCheckpointAttempt);
  await kernel.close({ snapshot: false });
});
