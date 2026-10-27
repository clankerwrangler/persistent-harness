import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";

const rootSource = path.resolve(import.meta.dirname, "..");
async function anonymousBytes(pid) {
  const line = (await readFile(`/proc/${pid}/smaps_rollup`, "utf8")).split("\n").find(entry => entry.startsWith("Anonymous:"));
  return Number(line.match(/(\d+) kB/)[1]) * 1024;
}

test("memory a finished cell freed is returned to the OS while its result stays", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kernel-heap-release-"));
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: [], consent: async () => true });
  let kernel;
  kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(rootSource, "python-runtime/kernel.py"),
    runtimeSupportDir: path.join(rootSource, "python-runtime"), cwd: root, stateDir: path.join(root, "state"),
    manifest: { version: 1, skills: [] }, hostHandlers: createHostHandlers({ cwd: root, getKernel: () => kernel }) });
  t.after(async () => { await kernel.close({ snapshot: false }); await rm(root, { recursive: true, force: true }); });

  const start = await kernel.execute("import json, os\nprint(os.getpid())");
  assert.equal(start.ok, true, start.error);
  const pid = Number(start.stdout.trim());
  const before = await anonymousBytes(pid);
  // ~80 MB of medium strings (glibc malloc, not pymalloc) that the cell drops before finishing.
  const cell = await kernel.execute([
    "rows = [{'i': i, 'text': 'w' * (600 + i % 3000)} for i in range(40000)]",
    "summary = [row['text'][:20] for row in json.loads(json.dumps(rows))[::1000]]",
    "del rows",
    "print(len(summary))",
  ].join("\n"));
  assert.equal(cell.ok, true, cell.error);
  assert.equal(cell.stdout.trim(), "40");
  // The release runs after "done" is sent; the next command is queued behind it.
  const kept = await kernel.execute("print(len(summary), summary[0][:3])");
  assert.equal(kept.stdout.trim(), "40 www");
  const after = await anonymousBytes(pid);
  assert.ok(after - before < 24 * 1024 * 1024, JSON.stringify({ before, after }));
});
