import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager, runtimeVersions } from "../src/python-runtime.mjs";
import { PythonRuntimeRejection } from "../src/python-runtime-errors.mjs";
import { discoverSkillsFromDirectory, manifestForSkills, skillCatalogForSkills } from "../src/skills.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const versions = { python: runtimeVersions.python, ipython: runtimeVersions.ipython, dill: runtimeVersions.dill };
const exists = async (file) => readFile(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-launch-"));
  const pythonPath = process.env.PI_HARNESS_PYTHON || (await new PythonRuntimeManager({ runtimeDir: path.join(root, "prerequisite") })
    .ensure({ skills: [], consent: async () => true })).pythonPath;
  const source = path.join(root, "catalog", "witness", "src");
  await mkdir(source, { recursive: true });
  const eventsPath = path.join(root, "imports.jsonl");
  const dependencyPath = path.join(root, "external.py");
  await writeFile(dependencyPath, 'VALUE = "valid"\n');
  await writeFile(path.join(source, "launch_witness.py"), `import json, os, sys\nwith open(${JSON.stringify(eventsPath)}, "a") as f:\n    f.write(json.dumps({"pid": os.getpid(), "argv": sys.argv}) + "\\n")\nif os.environ.get("SYNTHETIC_BAD_VERSION"):\n    import dill\n    dill.__version__ = "wrong"\nfrom external import VALUE\n`);
  await writeFile(path.join(source, "..", "SKILL.md"), "---\nname: witness\ndescription: Synthetic launch witness.\n---\n\n# Witness\n");
  await writeFile(path.join(source, "..", "pyproject.toml"), '[project]\nname = "launch-witness"\nversion = "1.0.0"\ndependencies = []\n[tool.persistent-harness]\nid = "witness"\nimport-name = "launch_witness"\nalias = "witness"\nhost-requests = []\n');
  const saved = process.env.PYTHONPATH;
  process.env.PYTHONPATH = root;
  const catalog = await discoverSkillsFromDirectory(path.join(root, "catalog"));
  assert.deepEqual(catalog.diagnostics, []);
  const manifest = manifestForSkills(catalog.skills);
  const kernels = [];
  const createKernel = (runtime, options = {}) => {
    const kernel = new PythonKernel({ ...runtime, kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
      runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: root, stateDir: path.join(root, "state"),
      manifest, hostHandlers: {}, shutdownTimeoutMs: 50, killTimeoutMs: 50, ...options });
    kernels.push(kernel);
    return kernel;
  };
  t.after(async () => {
    await Promise.all(kernels.map(kernel => kernel.close({ snapshot: false })));
    if (saved === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = saved;
    await rm(root, { recursive: true, force: true });
  });
  return { root, pythonPath, manifest, createKernel, kernels, dependencyPath,
    events: async () => (await readFile(eventsPath, "utf8")).trim().split("\n").map(JSON.parse),
    manager: new PythonRuntimeManager({ runtimeDir: path.join(root, "unused"), pythonOverride: pythonPath }) };
}

async function snapshot(stateDir, expression) {
  await mkdir(stateDir, { recursive: true });
  const payload = Buffer.from(`cbuiltins\neval\n(V${expression}\ntR.`);
  await writeFile(path.join(stateDir, "witness.dill"), payload);
  await writeFile(path.join(stateDir, "manifest.json"), JSON.stringify({ version: 1, saved: [{ name: "restored_witness",
    file: "witness.dill", bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }], skipped: [], totalBytes: payload.length }));
}

async function completed(f, name, bad = false) {
  const environment = path.join(f.root, "runtime", "environments", name);
  await mkdir(path.join(environment, "bin"), { recursive: true });
  const python = path.join(environment, "bin", "python");
  await writeFile(python, `#!/bin/sh\n${bad ? "export SYNTHETIC_BAD_VERSION=1\n" : ""}exec ${JSON.stringify(f.pythonPath)} "$@"\n`, { mode: 0o700 });
  await writeFile(path.join(environment, "runtime.json"), JSON.stringify({ version: 1, environmentId: name,
    versions, environmentSpec: { dependencies: [] } }));
  return environment;
}

test("launch owns one real import per generation; standalone checks and unchanged-catalog invalidation remain", async t => {
  const f = await fixture(t);
  const first = await f.manager.launch({ skills: f.manifest.skills, createKernel: f.createKernel });
  assert.deepEqual(first.versions, versions);
  assert.equal((await f.events()).length, 1, "launch has no disposable skill import");
  assert.notEqual((await f.events())[0].argv[0], "-c");
  const standalone = await f.manager.ensure({ skills: f.manifest.skills, consent: async () => false });
  assert.equal((await f.events()).length, 2, "standalone validation remains independent");
  const fingerprint = JSON.stringify(skillCatalogForSkills(f.manifest.skills));
  await writeFile(f.dependencyPath, 'raise RuntimeError("external dependency changed")\n');
  const unchanged = await discoverSkillsFromDirectory(path.join(f.root, "catalog"));
  assert.equal(JSON.stringify(skillCatalogForSkills(unchanged.skills)), fingerprint);
  assert.deepEqual(await f.manager.ensure({ skills: unchanged.skills }), standalone, "default successful ensure memo remains");
  assert.equal((await first.kernel.execute("witness.VALUE")).mime["text/plain"], "'valid'");
  await first.kernel.close({ snapshot: false });
  await assert.rejects(f.manager.launch({ skills: unchanged.skills, createKernel: f.createKernel }), PythonRuntimeRejection);
  assert.equal((await f.events()).length, 3, "replacement performs a fresh import despite ensure memo");
  await assert.rejects(new PythonRuntimeManager({ runtimeDir: path.join(f.root, "unused"), pythonOverride: f.pythonPath })
    .ensure({ skills: unchanged.skills }), /external dependency changed/);
  assert(f.kernels.every(kernel => !kernel.isRunning));
});

test("start coalesces one process and each replacement checks managed pins before restore or cells", async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, "restored");
  const cell = path.join(f.root, "cell");
  await snapshot(path.join(f.root, "state"), `__import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('restored')`);
  const kernel = f.createKernel({ pythonPath: f.pythonPath, expectedVersions: { ...versions, dill: "wrong" } });
  const starting = kernel.start();
  assert.equal(kernel.start(), starting);
  await assert.rejects(starting, PythonRuntimeRejection);
  assert.equal(await exists(sentinel), false);
  assert.equal(await exists(cell), false);
  kernel.expectedVersions = versions;
  const ready = await kernel.start();
  assert.deepEqual(ready.versions, versions);
  assert.deepEqual(ready.restore.restored, ["restored_witness"]);
  assert.equal(await readFile(sentinel, "utf8"), "restored");
  await rm(sentinel);
  kernel.terminateForRecovery();
  while (kernel.isRunning) await new Promise(resolve => setTimeout(resolve, 5));
  for (const key of ["python", "ipython"]) {
    kernel.expectedVersions = { ...versions, [key]: "wrong" };
    await assert.rejects(kernel.execute(`from pathlib import Path; Path(${JSON.stringify(cell)}).write_text('ran')`), PythonRuntimeRejection);
    assert.equal(await exists(sentinel), false);
    assert.equal(await exists(cell), false);
  }
  assert.equal((await f.events()).length, 4);
});

test("managed compatible fallback retires a version-rejected real candidate before retaining its successor", async t => {
  const f = await fixture(t);
  await completed(f, "a-bad", true); await completed(f, "b-good");
  const manager = new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
  const launched = await manager.launch({ skills: f.manifest.skills, consent: async () => { throw new Error("no repair needed"); },
    createKernel: runtime => { assert(f.kernels.every(kernel => !kernel.isRunning)); return f.createKernel(runtime); } });
  assert.equal(launched.environmentId, "b-good");
  assert.equal(launched.compatible, true);
  assert.equal((await f.events()).length, 2);
  assert.equal(f.kernels[0].isRunning, false);
  assert.equal(launched.kernel.isRunning, true);
});

test("a real restore failure does not try a compatible successor or ask to repair", async t => {
  const f = await fixture(t);
  await completed(f, "a-valid"); await completed(f, "b-unused");
  const restored = path.join(f.root, "restore-entered");
  await snapshot(path.join(f.root, "state"), `(__import__('pathlib').Path(${JSON.stringify(restored)}).write_text('entered'), __import__('os')._exit(37))`);
  const manager = new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
  await assert.rejects(manager.launch({ skills: f.manifest.skills, createKernel: f.createKernel,
    consent: async () => { throw new Error("restore must not repair"); } }), /Python kernel exited code=37/);
  assert.equal(await readFile(restored, "utf8"), "entered");
  assert.equal((await f.events()).length, 1);
  assert(f.kernels.every(kernel => !kernel.isRunning));
});

async function syntheticInstaller(f) {
  const runtimeDir = path.join(f.root, "runtime");
  const bin = path.join(runtimeDir, "bin");
  const managed = path.join(runtimeDir, "python", `cpython-${versions.python}-linux-x86_64-gnu`, "bin");
  await mkdir(bin, { recursive: true }); await mkdir(managed, { recursive: true });
  await symlink(f.pythonPath, path.join(managed, "python3"));
  const log = path.join(f.root, "uv.jsonl");
  const uv = path.join(bin, `uv-${runtimeVersions.uv}`);
  await writeFile(uv, `#!/usr/bin/env node\nconst fs = require('node:fs'); const path = require('node:path');\nconst args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (args[0] === 'venv') { const root = args[1]; fs.mkdirSync(path.join(root, 'bin'), {recursive:true}); const site = path.join(root,'fixture-site'); fs.mkdirSync(site); fs.writeFileSync(path.join(root,'bin/python'), '#!/bin/sh\\nif [ "$1" = "-c" ] && [ "$2" = "import site; print(site.getsitepackages()[0])" ]; then printf "%s\\\\n" '+JSON.stringify(site)+'; else exec '+JSON.stringify(${JSON.stringify(f.pythonPath)})+' "$@"; fi\\n', {mode:0o700}); }\n`, { mode: 0o700 });
  return { manager: new PythonRuntimeManager({ runtimeDir, pythonOverride: null }),
    commands: async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) };
}

test("a built environment completes from the real process before restore; later restore failure keeps completion", async t => {
  const f = await fixture(t); const installer = await syntheticInstaller(f);
  const restored = path.join(f.root, "restore-entered");
  await snapshot(path.join(f.root, "state"), `(__import__('pathlib').Path(${JSON.stringify(restored)}).write_text('entered'), __import__('os')._exit(38))`);
  let candidate;
  await assert.rejects(installer.manager.launch({ skills: f.manifest.skills, consent: async () => true,
    createKernel: runtime => { candidate = runtime; return f.createKernel(runtime); } }), /Python kernel exited code=38/);
  const record = JSON.parse(await readFile(path.join(path.dirname(path.dirname(candidate.pythonPath)), "runtime.json"), "utf8"));
  assert.deepEqual(record.versions, versions);
  assert.equal(await readFile(restored, "utf8"), "entered");
  assert.equal((await f.events()).length, 1);
  assert.deepEqual((await installer.commands()).map(args => args.slice(0, 2)), [["python", "install"], ["venv", path.dirname(path.dirname(candidate.pythonPath))], ["pip", "install"]]);
  assert.equal(await exists(path.join(f.root, "runtime", "install.lock")), false);
});

test("completion publication failure closes its real candidate before restore or exposure", async t => {
  const f = await fixture(t); const installer = await syntheticInstaller(f);
  const restored = path.join(f.root, "restored");
  await snapshot(path.join(f.root, "state"), `__import__('pathlib').Path(${JSON.stringify(restored)}).write_text('restored')`);
  await assert.rejects(installer.manager.launch({ skills: f.manifest.skills, consent: async () => true,
    createKernel: async runtime => {
      await mkdir(path.join(path.dirname(path.dirname(runtime.pythonPath)), "runtime.json"));
      return f.createKernel(runtime);
    } }), error => !(error instanceof PythonRuntimeRejection) && error.code === "EISDIR");
  assert.equal((await f.events()).length, 1);
  assert.equal(await exists(restored), false);
  assert(f.kernels.every(kernel => !kernel.isRunning));
  assert.equal(await exists(path.join(f.root, "runtime", "install.lock")), false);
});

test("missing executable is a runtime rejection, but missing script and configuration are startup failures", async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.launch({ skills: f.manifest.skills,
    createKernel: runtime => f.createKernel(runtime, { pythonPath: path.join(f.root, "missing-python") }) }), PythonRuntimeRejection);
  await assert.rejects(f.manager.launch({ skills: f.manifest.skills,
    createKernel: runtime => f.createKernel(runtime, { kernelScript: path.join(f.root, "missing-script") }) }),
    error => !(error instanceof PythonRuntimeRejection));
  const file = path.join(f.root, "not-directory"); await writeFile(file, "fixture");
  await assert.rejects(f.manager.launch({ skills: f.manifest.skills,
    createKernel: runtime => f.createKernel(runtime, { stateDir: file }) }),
    error => !(error instanceof PythonRuntimeRejection));
  await assert.rejects(f.manager.launch({ skills: f.manifest.skills,
    createKernel: runtime => f.createKernel(runtime, { cwd: path.join(f.root, "missing-cwd") }) }),
    error => !(error instanceof PythonRuntimeRejection));
  assert(f.kernels.every(kernel => !kernel.isRunning));
});

test("concurrent managed launches recheck completion under the existing lock without caching a process", async t => {
  const f = await fixture(t); const installer = await syntheticInstaller(f);
  let ordinal = 0;
  const createKernel = runtime => f.createKernel(runtime, { stateDir: path.join(f.root, `state-${++ordinal}`) });
  const [first, second] = await Promise.all([1, 2].map(() => installer.manager.launch({
    skills: f.manifest.skills, consent: async () => true, createKernel,
  })));
  assert.equal(first.environmentId, second.environmentId);
  assert.notEqual(first.kernel, second.kernel);
  assert.deepEqual(first.versions, versions); assert.deepEqual(second.versions, versions);
  assert.equal((await f.events()).length, 2);
  assert.equal(new Set((await f.events()).map(event => event.pid)).size, 2);
  assert.equal((await installer.commands()).length, 3, "only the lock winner builds");
  assert.equal(await exists(path.join(f.root, "runtime", "install.lock")), false);
  assert.equal((await first.kernel.execute("generation_value = 17")).ok, true);
  assert.equal((await second.kernel.execute("'generation_value' in globals()")).mime["text/plain"], "False");
});

test("an explicit interpreter retains its unpinned observed-version policy", async t => {
  const f = await fixture(t);
  const wrapper = path.join(f.root, "override-python");
  await writeFile(wrapper, `#!/bin/sh\nexport SYNTHETIC_BAD_VERSION=1\nexec ${JSON.stringify(f.pythonPath)} "$@"\n`, { mode: 0o700 });
  const launched = await new PythonRuntimeManager({ runtimeDir: path.join(f.root, "unused"), pythonOverride: wrapper })
    .launch({ skills: f.manifest.skills, createKernel: f.createKernel });
  assert.equal(launched.managed, false);
  assert.equal(launched.versions.dill, "wrong");
  assert.equal((await launched.kernel.execute("witness.VALUE")).mime["text/plain"], "'valid'");
});

test("managed launch does not repair cwd, ambiguous executable, or post-import metadata failures", async t => {
  for (const mode of ["cwd", "ambiguous", "metadata"]) await t.test(mode, async t => {
    const f = await fixture(t);
    const first = await completed(f, "a-valid"); await completed(f, "b-unused");
    if (mode === "ambiguous") await writeFile(path.join(first, "bin", "python"), "#!/missing-synthetic-loader\n", { mode: 0o700 });
    let attempts = 0; let consent = 0;
    const malformed = structuredClone(f.manifest);
    delete malformed.skills[0].instructions;
    const manager = new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
    await assert.rejects(manager.launch({ skills: f.manifest.skills,
      consent: async () => { consent++; return true; },
      createKernel: runtime => {
        attempts++;
        return f.createKernel(runtime, mode === "cwd" ? { cwd: path.join(f.root, "missing-cwd") }
          : mode === "metadata" ? { manifest: malformed } : {});
      } }), error => !(error instanceof PythonRuntimeRejection));
    assert.equal(attempts, 1, "a host/configuration failure must not try the compatible successor");
    assert.equal(consent, 0);
    assert.equal(await exists(path.join(f.root, "runtime", "install.lock")), false);
    assert(f.kernels.every(kernel => !kernel.isRunning));
    if (mode === "metadata") assert.equal((await f.events()).length, 1, "the genuine import succeeds before metadata fails");
  });
});

test("a proven missing managed interpreter permits compatible fallback", async t => {
  const f = await fixture(t);
  const missing = await completed(f, "a-missing"); await completed(f, "b-good");
  await rm(path.join(missing, "bin", "python"));
  const manager = new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
  const launched = await manager.launch({ skills: f.manifest.skills, createKernel: f.createKernel,
    consent: async () => { throw new Error("the compatible interpreter is already ready"); } });
  assert.equal(launched.environmentId, "b-good");
  assert.equal(f.kernels.length, 2);
  assert.equal(f.kernels[0].isRunning, false);
  assert.equal((await f.events()).length, 1);
});

test("standalone managed ensure preserves memo, completed reuse, compatible reuse, rebuild, and lock rechecks", async t => {
  const f = await fixture(t); const installer = await syntheticInstaller(f);
  const args = { skills: f.manifest.skills, consent: async () => true };
  const first = await installer.manager.ensure(args);
  assert.deepEqual(first.versions, versions);
  assert.deepEqual(await installer.manager.ensure(args), first);
  assert.equal((await f.events()).length, 1, "same-manager successful ensure stays memoized");
  const manager = () => new PythonRuntimeManager({ runtimeDir: path.join(f.root, "runtime"), pythonOverride: null });
  assert.equal((await manager().ensure({ ...args, consent: async () => { throw new Error("completed reuse must not install"); } })).environmentId, first.environmentId);
  const changed = structuredClone(f.manifest.skills); changed[0].contentHash = "source-only";
  const compatible = await manager().ensure({ skills: changed, consent: async () => { throw new Error("compatible reuse must not install"); } });
  assert.equal(compatible.environmentId, first.environmentId); assert.equal(compatible.compatible, true);
  changed[0].python.dependencies = ["synthetic-dependency==1.0.0"];
  const [rebuilt, concurrent] = await Promise.all([1, 2].map(() => manager().ensure({ skills: changed, consent: async () => true })));
  assert.notEqual(rebuilt.environmentId, first.environmentId);
  assert.equal(rebuilt.environmentId, concurrent.environmentId);
  assert.equal((await installer.commands()).length, 6, "two synthetic builds; no real package installation");
});
