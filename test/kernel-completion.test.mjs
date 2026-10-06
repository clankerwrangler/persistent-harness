import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, mode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kernel-completion-"));
  const script = path.join(root, "kernel.py");
  await writeFile(script, String.raw`
import json, os, signal, socket, time
from pathlib import Path
root = Path(__file__).parent
mode = ${JSON.stringify(mode)}
control = socket.socket(fileno=3)
(root / "pid").write_text(str(os.getpid()))
def emit(frame):
    control.sendall((json.dumps(frame) + "\n").encode())
def keep_writing():
    while True:
        with (root / "writes").open("a") as f:
            f.write("x")
        time.sleep(0.001)
emit({"type": "ready", "restore": {"found": False}})
if mode == "control":
    control.shutdown(socket.SHUT_RD)
    (root / "closed-read").write_text("ready")
    keep_writing()
for line in control.makefile("rb"):
    command = json.loads(line)
    if command["type"] == "execute":
        if mode == "decode":
            control.sendall(b"not-json\n")
            keep_writing()
        emit({"type": "done", "id": command["id"], "ok": True})
    elif command["type"] == "shutdown":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        keep_writing()
`);
  const kernel = new PythonKernel({ pythonPath: process.env.PI_HARNESS_PYTHON || "python3",
    kernelScript: script, runtimeSupportDir: root, cwd: root, stateDir: path.join(root, "state"),
    manifest: { version: 1, skills: [] }, hostHandlers: {}, shutdownTimeoutMs: 30, killTimeoutMs: 30 });
  t.after(async () => { kernel.terminateForRecovery(); await kernel.close({ snapshot: false }); await rm(root, { recursive: true, force: true }); });
  await kernel.start();
  return { kernel, root, pid: Number(await readFile(path.join(root, "pid"), "utf8")) };
}
function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "terminal completion must follow owned process exit");
}
for (const mode of ["decode", "control"]) test(`${mode} failure cannot complete while the Python writer survives`, { timeout: 5000 }, async (t) => {
  const { kernel, root, pid } = await fixture(t, mode);
  if (mode === "control") {
    for (let count = 0; ; count++) {
      try { await readFile(path.join(root, "closed-read")); break; }
      catch (error) { if (count > 100 || error.code !== "ENOENT") throw error; await pause(5); }
    }
  }
  const first = kernel.execute("x".repeat(65536), { namespaceCheckpoint: {
    version: 1, sessionId: "completion", toolCallId: "first", actorGeneration: 1,
  }, checkpointInBackground: true });
  const queued = kernel.execute("must not replay");
  const result = await first;
  assert.equal(result.ok, false);
  assertExited(pid);
  assert.equal((await queued).errorType, "KernelReplacedError");
});

test("close escalation keeps process ownership until SIGKILL exit", { timeout: 5000 }, async (t) => {
  const { kernel, pid } = await fixture(t, "close");
  await kernel.close({ snapshot: false });
  assertExited(pid);
});
