import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveExternalPi } from "../src/external-pi.mjs";
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
