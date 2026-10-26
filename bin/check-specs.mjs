#!/usr/bin/env node
// Model-check every specification/*.cfg with TLC and compare each outcome with
// specification/expected-results.json. Negative-control configurations are
// expected to report a violation; every other recorded outcome must also hold.
//
//   node bin/check-specs.mjs              check all configurations
//   node bin/check-specs.mjs Name ...     check configurations whose file name starts with Name
//   node bin/check-specs.mjs --record     run all and rewrite expected-results.json
//
// TLA2TOOLS (default /opt/tla/tla2tools-1.7.4.jar) and JAVA (default java) select the tools.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "specification");
const expectedPath = path.join(root, "expected-results.json");
const jar = process.env.TLA2TOOLS ?? "/opt/tla/tla2tools-1.7.4.jar";
const java = process.env.JAVA ?? "java";
const timeoutMs = Number(process.env.SPEC_TIMEOUT_MS ?? 15 * 60 * 1000);
const args = process.argv.slice(2);
const record = args.includes("--record");
const prefixes = args.filter((arg) => !arg.startsWith("--"));

if (!existsSync(jar)) {
  console.log(`skipped: TLA+ tools not found at ${jar} (set TLA2TOOLS)`);
  process.exit(0);
}

function outcomeOf(output, code, timedOut) {
  if (timedOut) return "timeout";
  if (/Model checking completed\. No error has been found\./.test(output)) return "pass";
  if (/is violated|Deadlock reached|Temporal properties were violated|Assumption .* is false/.test(output)) return "violation";
  return code === 0 ? "pass" : "error";
}

// Configurations are named Model.cfg, Model.variant.cfg, ModelVariant.cfg or Model-variant.cfg;
// each belongs to the longest model name it starts with.
const models = readdirSync(root).filter((name) => name.endsWith(".tla")).map((name) => name.slice(0, -4))
  .sort((a, b) => b.length - a.length);
const moduleOf = (cfg) => models.find((model) => cfg.startsWith(model));

function check(cfg) {
  const module = `${moduleOf(cfg)}.tla`;
  const metadir = mkdtempSync(path.join(os.tmpdir(), "tlc-"));
  return new Promise((resolve) => {
    const started = Date.now(); let output = ""; let timedOut = false;
    const child = spawn(java, ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "1",
      "-metadir", metadir, "-config", cfg, module], { cwd: root });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer); rmSync(metadir, { recursive: true, force: true });
      const outcome = outcomeOf(output, code, timedOut);
      const detail = outcome === "pass" ? "" : (output.match(/Error: .*|.* is violated.*|Deadlock reached.*/)?.[0] ?? output.trim().split("\n").at(-1) ?? "").slice(0, 200);
      resolve({ cfg, outcome, seconds: Math.round((Date.now() - started) / 1000), detail });
    });
  });
}

const configs = readdirSync(root).filter((name) => name.endsWith(".cfg") && moduleOf(name)
  && (prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix)))).sort();
const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : {};
const results = {}; let mismatches = 0;
for (const cfg of configs) {
  const result = await check(cfg); results[cfg] = result.outcome;
  const want = expected[cfg];
  const ok = record || want === undefined ? true : want === result.outcome;
  if (!ok) mismatches++;
  console.log(`${ok ? "ok  " : "FAIL"} ${cfg.padEnd(56)} ${result.outcome}${want && want !== result.outcome ? ` (expected ${want})` : ""} ${result.seconds}s ${result.detail}`);
}
if (record) {
  writeFileSync(expectedPath, `${JSON.stringify({ ...(prefixes.length ? expected : {}), ...results }, null, 2)}\n`);
  console.log(`recorded ${configs.length} outcomes in ${path.relative(process.cwd(), expectedPath)}`);
}
const unknown = configs.filter((cfg) => !record && expected[cfg] === undefined);
if (unknown.length) console.log(`${unknown.length} configuration(s) have no recorded outcome; run with --record to add them`);
console.log(`${configs.length} checked, ${mismatches} mismatch(es)`);
process.exit(mismatches ? 1 : 0);
