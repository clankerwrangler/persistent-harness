import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadExternalPiSdk, resolveExternalPi } from "../src/external-pi.mjs";
const names = { agent: "@earendil-works/pi-coding-agent", ai: "@earendil-works/pi-ai", core: "@earendil-works/pi-agent-core" };
async function pkg(directory, name, dependencies = {}, overrides = {}) {
  await mkdir(path.join(directory, "dist/api"), { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.99.1", dependencies,
    exports: { ".": "./dist/index.js", "./api/*": "./dist/api/*.js" }, ...overrides }));
  for (const file of ["index.js", "api/openai-responses-shared.js", "api/simple-options.js"]) await writeFile(path.join(directory, "dist", file), "export {};\n");
}
async function fixture(t, nested = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "external-pi-graph-")), graph = path.join(root, "runtime/node_modules");
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = nested ? path.join(graph, "wrapper/node_modules") : graph;
  const agent = path.join(modules, names.agent), ai = path.join(modules, names.ai), core = path.join(modules, names.core);
  await pkg(agent, names.agent, { [names.ai]: "0.99.1", [names.core]: "0.99.1" });
  await pkg(ai, names.ai); await pkg(core, names.core, { [names.ai]: "0.99.1" });
  return { root, graph, modules, agent, ai, core, resolve: () => resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(agent, "dist/index.js") } }) };
}
for (const nested of [false, true]) test(`resolver accepts the complete ${nested ? "nested" : "top-level"} installed public graph`, async t => {
  const f = await fixture(t, nested), result = await f.resolve();
  assert.equal(result.packageRoot, f.agent); assert.equal(result.api, path.join(f.ai, "dist/index.js"));
  assert.equal(result.core, path.join(f.core, "dist/index.js")); assert.equal(result.responsesApi, path.join(f.ai, "dist/api/openai-responses-shared.js"));
});

test("resolver rejects dependency realpaths outside the selected graph", async t => {
  const f = await fixture(t), outside = path.join(f.root, "outside-ai");
  await pkg(outside, names.ai); await rm(f.ai, { recursive: true }); await symlink(outside, f.ai);
  await assert.rejects(f.resolve(), /dependency escapes the selected package graph/);
});
for (const [label, overrides, error] of [["version", { version: "0.99.0" }, /Expected stock Pi/],
  ["identity", { name: "wrong-package" }, /identity mismatch/], ["exports", { exports: {} }, /Missing public export/]]) {
  test(`resolver retains exact dependency ${label} validation`, async t => {
    const f = await fixture(t); await pkg(f.ai, names.ai, {}, overrides); await assert.rejects(f.resolve(), error);
  });
}
test("resolver rejects undeclared dependencies and different core-AI instances", async t => {
  const f = await fixture(t); await pkg(f.agent, names.agent, { [names.core]: "0.99.1" });
  await assert.rejects(f.resolve(), /does not declare/);
  await pkg(f.agent, names.agent, { [names.ai]: "0.99.1", [names.core]: "0.99.1" });
  await pkg(path.join(f.core, "node_modules", names.ai), names.ai);
  await assert.rejects(f.resolve(), /different pi-ai instances/);
});

async function programmaticFixture(t, declaration = { types: "./dist/programmatic.d.ts", import: "./dist/programmatic.js" }, extraExports = {}) {
  const f = await fixture(t);
  await pkg(f.agent, names.agent, { [names.ai]: "0.99.1", [names.core]: "0.99.1" }, {
    exports: { ".": "./dist/index.js", "./programmatic": declaration, ...extraExports },
  });
  f.programmatic = path.join(f.agent, "dist/programmatic.js");
  await writeFile(f.programmatic, "export class SessionManager {}\n");
  return f;
}

test("declared programmatic entry is selected by directory, command and exact public file; explicit root stays root", async t => {
  const f = await programmaticFixture(t);
  const command = path.join(f.agent, "dist/cli.js");
  await writeFile(command, "// fixture command\n");
  for (const env of [{ PI_HARNESS_PI_MODULE: f.agent }, { PI_HARNESS_PI_COMMAND: command }, { PI_HARNESS_PI_MODULE: f.programmatic }]) {
    assert.equal((await resolveExternalPi({ env })).sdk, f.programmatic);
    assert.equal(typeof (await loadExternalPiSdk({ env })).SessionManager, "function");
  }
  assert.equal((await f.resolve()).sdk, path.join(f.agent, "dist/index.js"));
  await assert.rejects(resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: path.join(f.agent, "dist/api/simple-options.js") } }), /Unsupported explicit/);
  await assert.rejects(resolveExternalPi({ env: {} }), /explicitly/);
});

for (const [label, declaration, extra, error] of [
  ["null", null, { "./*": "./dist/*.js" }, /Missing public export/],
  ["types-only", { types: "./dist/programmatic.d.ts" }, {}, /Missing public export/],
  ["unsupported conditional", { browser: "./dist/programmatic.js" }, {}, /Missing public export/],
  ["blocked active conditional", { import: null, default: "./dist/programmatic.js" }, {}, /Missing public export/],
  ["missing", "./dist/absent.js", {}, /ENOENT/],
  ["non-file", "./dist", {}, /not a regular file/],
  ["escape", "./../../outside.js", {}, /escapes its package/],
]) test(`invalid advertised ${label} does not fall back to root or a pattern`, async t => {
  const f = await programmaticFixture(t, declaration, extra);
  if (label === "escape") await writeFile(path.resolve(f.agent, "../../outside.js"), "export {};\n");
  await assert.rejects(resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: f.agent } }), error);
  // An explicit root does not evaluate the unused optional declaration.
  assert.equal((await f.resolve()).sdk, path.join(f.agent, "dist/index.js"));
});

for (const [label, declaration] of [["pattern", { "./*": "./dist/*.js" }],
  ["conditional", { "./programmatic": { node: { import: "./dist/programmatic.js" } } }]]) {
  test(`supported ${label} advertisement selects programmatic without guessing a path`, async t => {
    const f = await fixture(t);
    await pkg(f.agent, names.agent, { [names.ai]: "0.99.1", [names.core]: "0.99.1" }, { exports: { ".": "./dist/index.js", ...declaration } });
    await writeFile(path.join(f.agent, "dist/programmatic.js"), "export class SessionManager {}\n");
    assert.equal((await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: f.agent } })).sdk, path.join(f.agent, "dist/programmatic.js"));
  });
}

test("SDK-only helper keeps graph fences but does not resolve or import unused auxiliary exports", async t => {
  const f = await programmaticFixture(t);
  await pkg(f.ai, names.ai, {}, { exports: {} });
  await pkg(f.core, names.core, { [names.ai]: "0.99.1" }, { exports: {} });
  const options = { env: { PI_HARNESS_PI_MODULE: f.agent } };
  assert.equal(typeof (await loadExternalPiSdk(options)).SessionManager, "function");
  await assert.rejects(resolveExternalPi(options), /Missing public export/);
  await pkg(f.ai, names.ai, {}, { version: "0.99.0", exports: {} });
  await assert.rejects(loadExternalPiSdk(options), /Expected stock Pi/);
});

test("programmatic symlink escape and import errors reject without root import fallback", async t => {
  const f = await programmaticFixture(t);
  const outside = path.join(f.root, "outside.js");
  await writeFile(outside, "export class SessionManager {}\n");
  await rm(f.programmatic); await symlink(outside, f.programmatic);
  await assert.rejects(loadExternalPiSdk({ env: { PI_HARNESS_PI_MODULE: f.agent } }), /escapes its package/);
  await rm(f.programmatic); await writeFile(f.programmatic, 'throw new Error("programmatic import rejected");\n');
  await assert.rejects(loadExternalPiSdk({ env: { PI_HARNESS_PI_MODULE: f.agent } }), /programmatic import rejected/);
});

for (const rootAlias of [false, true]) test(`declared root ${rootAlias ? "symlink" : "target"} takes precedence over reserved alternate-bundle pathname`, async t => {
  const f = await fixture(t); const bundled = path.join(f.agent, "dist/bundle/index.js");
  await mkdir(path.dirname(bundled)); await writeFile(bundled, "export class SessionManager {}\n");
  if (rootAlias) { await rm(path.join(f.agent, "dist/index.js")); await symlink(bundled, path.join(f.agent, "dist/index.js")); }
  else await pkg(f.agent, names.agent, { [names.ai]: "0.99.1", [names.core]: "0.99.1" }, {
    exports: { ".": "./dist/bundle/index.js", "./programmatic": null },
  });
  for (const entry of [bundled, path.join(f.agent, rootAlias ? "dist/index.js" : "dist/bundle/index.js")]) {
    assert.equal((await resolveExternalPi({ env: { PI_HARNESS_PI_MODULE: entry } })).sdk, bundled);
    assert.equal(typeof (await loadExternalPiSdk({ env: { PI_HARNESS_PI_MODULE: entry } })).SessionManager, "function");
  }
});

test("programmatic advertisement cannot alias around the alternate-bundle official-byte guard", async t => {
  const f = await programmaticFixture(t, "./dist/bundle/index.js");
  const bundled = path.join(f.agent, "dist/bundle/index.js"); await mkdir(path.dirname(bundled));
  await writeFile(bundled, "export class SessionManager {}\n");
  for (const entry of [bundled, f.agent]) await assert.rejects(loadExternalPiSdk({ env: { PI_HARNESS_PI_MODULE: entry } }), /official stock bytes/);
});
