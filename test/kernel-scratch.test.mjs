import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";

const support = path.resolve(import.meta.dirname, "../python-runtime");
test("managed kernel and host shell receive canonical scratch; restored names cannot replace its path", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kernel-scratch-")), kernels = [];
  t.after(async () => { await Promise.all(kernels.map(kernel => kernel.close({ snapshot: false }))); await rm(root, { recursive: true, force: true }); });
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: [], consent: async () => true });
  const scratch = { rootSessionId: "fixture-root-generation", directory: path.join(root, "scratch") };
  await mkdir(scratch.directory);
  const manifest = { version: 1, skills: [{ id: "fixture", alias: "fixture", version: "1", instructions: "Fixture host bridge", skillPath: import.meta.filename,
    python: { srcPath: support, importName: "_persistent_harness", hostRequests: ["shell.run"] } }] };
  const options = { pythonPath: runtime.pythonPath, kernelScript: path.join(support, "kernel.py"), runtimeSupportDir: support,
    cwd: root, stateDir: path.join(root, "state"), manifest, scratch,
    hostHandlers: createHostHandlers({ cwd: root, scratch, getClient: () => null, getManifest: () => manifest }) };
  const first = new PythonKernel(options); kernels.push(first);
  const value = await first.execute("import os\n(str(scratch_dir), os.environ.get('PI_HARNESS_ROOT_SESSION_ID'), os.environ.get('PI_HARNESS_SCRATCH_DIRECTORY'))");
  assert.equal(value.ok, true);
  assert.equal(value.mime["text/plain"], `('${scratch.directory}', '${scratch.rootSessionId}', '${scratch.directory}')`);
  const shell = await first.execute(`from _persistent_harness import host_request\nhost_request("shell.run", {"command": "printf '%s' \\\"$PI_HARNESS_ROOT_SESSION_ID\\\"", "timeout": 5})["stdout"]`);
  assert.equal(shell.ok, true);
  assert.equal(shell.mime["text/plain"], `'${scratch.rootSessionId}'`);
  await first.execute("scratch_dir = 'caller-value-must-not-restore'\nretained_value = 42");
  await first.close();
  const second = new PythonKernel(options); kernels.push(second);
  const restored = await second.execute("str(scratch_dir), retained_value");
  assert.equal(restored.mime["text/plain"], `('${scratch.directory}', 42)`);
});
