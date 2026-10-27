#!/usr/bin/env node
// Run the test suite with private, offline state and auto-discovered Pi/Python.
//
//   node bin/run-tests.mjs [unit|integration|native|all] [test files...]
//
// unit:        tests that need neither Pi nor Python (everything not listed in test/integration-files.txt)
// integration: tests listed in test/integration-files.txt; they need stock Pi 0.99.1 and the managed Python
// native:      test/native/*.test.mjs
// Missing Pi or Python skips the groups that need them, with the reason, instead of failing.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const checkout = path.resolve(import.meta.dirname, "..");
const [group = "all", ...explicit] = process.argv.slice(2);
if (!["unit", "integration", "native", "all"].includes(group)) {
  console.error("usage: node bin/run-tests.mjs [unit|integration|native|all] [test files...]");
  process.exit(2);
}
const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

function discoverPi() {
  if (process.env.PI_HARNESS_PI_COMMAND && process.env.PI_HARNESS_PI_MODULE) {
    return { command: process.env.PI_HARNESS_PI_COMMAND, module: process.env.PI_HARNESS_PI_MODULE };
  }
  const runtimes = path.join(agentDir, "runtimes");
  if (!existsSync(runtimes)) return null;
  for (const name of readdirSync(runtimes).filter((entry) => entry.startsWith("pi-0.99.1-")).sort().reverse()) {
    const dist = path.join(runtimes, name, "node_modules/pi-sdk-runtime/node_modules/@earendil-works/pi-coding-agent/dist");
    if (existsSync(path.join(dist, "cli.js")) && existsSync(path.join(dist, "index.js"))) {
      return { command: path.join(dist, "cli.js"), module: path.join(dist, "index.js") };
    }
  }
  return null;
}

function discoverPython() {
  if (process.env.PI_HARNESS_PYTHON) return process.env.PI_HARNESS_PYTHON;
  const environments = path.join(agentDir, "harness/kernel-runtime/environments");
  if (!existsSync(environments)) return null;
  for (const name of readdirSync(environments).sort()) {
    const python = path.join(environments, name, "bin/python");
    if (existsSync(python)) return python;
  }
  return null;
}

// The official (not source-built) Pi package, for the tests that check its pinned bundle.
function discoverOfficialPi() {
  if (process.env.PI_HARNESS_TEST_OFFICIAL_PI_MODULE) return process.env.PI_HARNESS_TEST_OFFICIAL_PI_MODULE;
  const official = path.join(agentDir, "runtimes/pi-0.99.1/node_modules/@earendil-works/pi-coding-agent");
  return existsSync(path.join(official, "dist/bundle/index.js")) ? official : null;
}

// Managed-runtime tests provision Python from scratch; offline they need the uv binary,
// its cache and the installed interpreter. Copy them (never the live environments) so
// the tests cannot write into the live runtime.
function prepareManagedSeed(seedDir) {
  if (process.env.PI_HARNESS_TEST_MANAGED_SEED) return process.env.PI_HARNESS_TEST_MANAGED_SEED;
  const runtime = path.join(agentDir, "harness/kernel-runtime");
  const parts = ["bin", "cache", "python"];
  if (!parts.every((part) => existsSync(path.join(runtime, part)))) return null;
  for (const part of parts) cpSync(path.join(runtime, part), path.join(seedDir, part), { recursive: true, verbatimSymlinks: true });
  return seedDir;
}

const integration = new Set(readFileSync(path.join(checkout, "test/integration-files.txt"), "utf8")
  .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
const all = readdirSync(path.join(checkout, "test")).filter((name) => name.endsWith(".test.mjs")).sort();
const native = existsSync(path.join(checkout, "test/native"))
  ? readdirSync(path.join(checkout, "test/native")).filter((name) => name.endsWith(".test.mjs")).map((name) => `native/${name}`)
  : [];
const pi = discoverPi(), python = discoverPython();
const missing = [!pi && "stock Pi 0.99.1 (set PI_HARNESS_PI_COMMAND and PI_HARNESS_PI_MODULE)", !python && "Python runtime (set PI_HARNESS_PYTHON)"].filter(Boolean);

let files;
if (explicit.length) files = explicit.map((file) => path.relative(path.join(checkout, "test"), path.resolve(file)));
else {
  files = [];
  if (group === "unit" || group === "all") files.push(...all.filter((name) => !integration.has(name)));
  if (group === "integration" || group === "all") files.push(...all.filter((name) => integration.has(name)));
  if (group === "native") files.push(...native);
}
const needsSetup = (name) => integration.has(name) || name.startsWith("native/");
if (missing.length) {
  const skipped = files.filter(needsSetup);
  if (skipped.length) console.log(`skipped ${skipped.length} test file(s) that need ${missing.join(" and ")}`);
  files = files.filter((name) => !needsSetup(name));
}
if (!files.length) { console.log("no test files to run"); process.exit(0); }

const home = mkdtempSync(path.join(os.tmpdir(), "harness-tests-"));
const officialPi = discoverOfficialPi();
const seedUsers = files.filter((name) => readFileSync(path.join(checkout, "test", name), "utf8").includes("PI_HARNESS_TEST_MANAGED_SEED"));
const managedSeed = seedUsers.length ? prepareManagedSeed(path.join(home, "managed-seed")) : null;
const env = {
  ...process.env,
  HOME: path.join(home, "home"),
  PI_CODING_AGENT_DIR: path.join(home, "agent"),
  // Tests must never download a runtime as a side effect.
  PI_HARNESS_AUTO_INSTALL: "0", UV_OFFLINE: "1",
  PI_HARNESS_SKILLS_PATH: process.env.PI_HARNESS_SKILLS_PATH ?? path.join(checkout, "skills"),
  PI_HARNESS_PRESENTATION_NAMESPACE: process.env.PI_HARNESS_PRESENTATION_NAMESPACE ?? "harness",
  ...(pi ? { PI_HARNESS_PI_COMMAND: pi.command, PI_HARNESS_PI_MODULE: pi.module } : {}),
  ...(python ? { PI_HARNESS_PYTHON: python } : {}),
  ...(officialPi ? { PI_HARNESS_TEST_OFFICIAL_PI_MODULE: officialPi } : {}),
  ...(managedSeed ? { PI_HARNESS_TEST_MANAGED_SEED: managedSeed } : {}),
};
try {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map((name) => path.join("test", name))],
    { cwd: checkout, env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
