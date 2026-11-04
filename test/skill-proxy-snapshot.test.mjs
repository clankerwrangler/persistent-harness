import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("namespace values holding skills restore as references to the live skills", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-skill-proxy-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = await discoverSkills([{
    source: "skill",
    path: path.join(process.env.PI_HARNESS_SKILLS_PATH || path.join(packageRoot, "skills"), "files", "SKILL.md"),
  }]);
  const manifest = manifestForSkills(catalog.skills);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: manifest.skills, consent: async () => true,
  });
  const common = { pythonPath: runtime.pythonPath, kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: root,
    stateDir: path.join(root, "state"), manifest, hostHandlers: {} };
  let kernel = new PythonKernel(common);
  t.after(() => kernel.close({ snapshot: false }));
  await kernel.start();
  const result = await kernel.execute([
    "import copy as _copy",
    "holder = {'files': files, 'items': [files]}",
    "assert _copy.copy(files) is files and _copy.deepcopy(holder)['files'] is files",
  ].join("\n"));
  assert.equal(result.ok, true, result.stderr);
  await kernel.snapshot();
  await kernel.close({ snapshot: false });

  kernel = new PythonKernel(common);
  const ready = await kernel.start();
  assert.deepEqual(ready.restore.skipped, []);
  const restored = await kernel.execute("assert holder['files'] is files and holder['items'][0] is files");
  assert.equal(restored.ok, true, restored.stderr);
  await kernel.close({ snapshot: false });

  // A kernel without that skill reports the value as skipped instead of recursing.
  kernel = new PythonKernel({ ...common, manifest: { skills: [] } });
  const missing = await kernel.start();
  assert.equal(missing.restore.skipped.length, 1);
  assert.equal(missing.restore.skipped[0].name, "holder");
  assert.match(missing.restore.skipped[0].reason, /^LookupError: "?skill 'files' is not loaded in this kernel/);
  await kernel.close({ snapshot: false });
});
