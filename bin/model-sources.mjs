#!/usr/bin/env node
// Keep each project's record of which code its TLA+ models were checked against
// in one file, <dir>/sources.lock.json, and tie a model to the parts of a file it
// covers instead of the whole file. Run from the project root.
//
//   model-sources.mjs import [--dir D]             build the lock from existing model headers or .sources.json files
//   model-sources.mjs check [--dir D]              list models whose covered code changed; exit 1 if any
//   model-sources.mjs scope Model file part... [--dir D]   cover only these parts of file; "*" covers all of it
//   model-sources.mjs recheck [Model...] [--dir D] run TLC on changed models and update those that hold
//
// Parts are top-level definitions: a part runs from its definition to the next one.
// Text before the first definition is the part "(top)". A name that is not found is an error.
// TLA2TOOLS, JAVA, and SPEC_TIMEOUT_MS select the checker as in check-specs.mjs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCRIPT = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)/;
const DEFINITIONS = {
  ".js": SCRIPT, ".mjs": SCRIPT, ".cjs": SCRIPT, ".ts": SCRIPT, ".tsx": SCRIPT,
  ".py": /^(?:async\s+)?(?:def|class)\s+(\w+)/,
  ".ps1": /^function\s+([\w-]+)/i,
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function partsOf(file, text) {
  const definition = DEFINITIONS[path.extname(file)];
  if (!definition) throw new Error(`${file}: parts are not supported for this file type`);
  const parts = new Map(); let name = "(top)"; let lines = [];
  const finish = () => {
    if (parts.has(name)) throw new Error(`${file}: ${name} is defined twice`);
    parts.set(name, lines.join("\n"));
  };
  for (const line of text.split("\n")) {
    const found = line.match(definition);
    if (found) { finish(); name = found[1]; lines = []; }
    lines.push(line);
  }
  finish();
  return parts;
}

export function hashOf(file, parts, read = (name) => readFileSync(name)) {
  if (parts === "*") return sha256(read(file));
  const found = partsOf(file, read(file).toString());
  return sha256([...parts].sort().map((part) => {
    if (!found.has(part)) throw new Error(`${file}: no part named ${part}`);
    return `${part}\0${found.get(part)}`;
  }).join("\0"));
}

// Reads the three header forms in use: Source files + Last checked source SHA-256,
// a Sources: list, and a Model.sources.json file beside the model.
export function recordedSources(modelFile) {
  const text = readFileSync(modelFile, "utf8");
  const sidecar = modelFile.replace(/\.tla$/, ".sources.json");
  if (existsSync(sidecar)) {
    const contract = JSON.parse(readFileSync(sidecar, "utf8"));
    return { ...contract.sources, ...contract.modelFiles };
  }
  const checked = text.match(/^\\\* Last checked source SHA-256: (.+)$/m);
  if (checked) return JSON.parse(checked[1]);
  const listed = [...text.matchAll(/^\\\*\s+(\S+) sha256:([a-f0-9]{64})$/gm)];
  return listed.length ? Object.fromEntries(listed.map((row) => [row[1], row[2]])) : null;
}

const lockPath = (dir) => path.join(dir, "sources.lock.json");
const readLock = (dir) => JSON.parse(readFileSync(lockPath(dir), "utf8"));
const writeLock = (dir, lock) => writeFileSync(lockPath(dir), `${JSON.stringify(lock, null, 1)}\n`);
const modelsIn = (dir) => readdirSync(dir).filter((name) => name.endsWith(".tla")).map((name) => name.slice(0, -4));

// A configuration belongs to the longest model name it starts with.
function configsOf(dir, model) {
  const models = modelsIn(dir).sort((a, b) => b.length - a.length);
  return readdirSync(dir).filter((name) => name.endsWith(".cfg")
    && models.find((candidate) => name.startsWith(candidate)) === model).sort();
}
const modelFilesOf = (dir, model) => [`${model}.tla`, ...configsOf(dir, model)].map((name) => path.join(dir, name));

export function importLock(dir) {
  const lock = {}; const missing = [];
  for (const model of modelsIn(dir).sort()) {
    const sources = recordedSources(path.join(dir, `${model}.tla`));
    if (!sources) { missing.push(model); continue; }
    lock[model] = Object.fromEntries(Object.entries(sources)
      .map(([file, hash]) => [file, { parts: "*", hash: hash.replace(/^sha256:/, "") }]));
    for (const file of modelFilesOf(dir, model)) lock[model][file] ??= { parts: "*", hash: hashOf(file, "*") };
  }
  writeLock(dir, lock);
  return { models: Object.keys(lock).length, missing };
}

// A model's own text and configurations count as recorded files, so editing one needs a recheck too.
export function staleModels(lock, dir) {
  const stale = {};
  for (const [model, sources] of Object.entries(lock)) {
    const files = Object.entries(sources).filter(([file, entry]) =>
      !existsSync(file) || hashOf(file, entry.parts) !== entry.hash).map(([file]) => file);
    files.push(...modelFilesOf(dir, model).filter((file) => !sources[file]));
    if (files.length) stale[model] = files;
  }
  return stale;
}

export function setScope(dir, model, file, parts) {
  const lock = readLock(dir); const entry = lock[model]?.[file];
  if (!entry) throw new Error(`${model} does not record ${file}`);
  if (hashOf(file, entry.parts) !== entry.hash) throw new Error(`${model}: ${file} changed; recheck it before narrowing`);
  entry.parts = parts.includes("*") ? "*" : [...new Set(parts)].sort();
  entry.hash = hashOf(file, entry.parts);
  writeLock(dir, lock);
}

export function outcomeOf(output, code, timedOut) {
  if (timedOut) return "timeout";
  if (/Model checking completed\. No error has been found\./.test(output)) return "pass";
  if (/is violated|Deadlock reached|Temporal properties were violated|Assumption .* is false/.test(output)) return "violation";
  return code === 0 ? "pass" : "error";
}

function runTlc(dir, model, cfg) {
  const jar = process.env.TLA2TOOLS ?? "/opt/tla/tla2tools-1.7.4.jar";
  const timeoutMs = Number(process.env.SPEC_TIMEOUT_MS ?? 15 * 60 * 1000);
  const metadir = mkdtempSync(path.join(os.tmpdir(), "tlc-"));
  return new Promise((resolve) => {
    let output = ""; let timedOut = false;
    const child = spawn(process.env.JAVA ?? "java", ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "1",
      "-metadir", metadir, "-config", cfg, `${model}.tla`], { cwd: dir });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer); rmSync(metadir, { recursive: true, force: true });
      resolve(outcomeOf(output, code, timedOut));
    });
  });
}

export async function recheck(dir, only = [], run = runTlc) {
  const lock = readLock(dir);
  const expectedFile = path.join(dir, "expected-results.json");
  const expected = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, "utf8")) : {};
  const results = {};
  for (const model of Object.keys(staleModels(lock, dir))) {
    if (only.length && !only.includes(model)) continue;
    const configs = configsOf(dir, model);
    const wrong = [];
    for (const cfg of configs) {
      const outcome = await run(dir, model, cfg);
      if (outcome !== (expected[cfg] ?? "pass")) wrong.push(`${cfg}: ${outcome}`);
    }
    if (!configs.length) wrong.push("no configuration");
    const removedConfigs = Object.keys(lock[model]).filter((file) => file.endsWith(".cfg") && !existsSync(file));
    const missing = Object.keys(lock[model]).filter((file) => !file.endsWith(".cfg") && !existsSync(file));
    wrong.push(...missing.map((file) => `${file}: missing`));
    if (!wrong.length) {
      for (const file of removedConfigs) delete lock[model][file];
      for (const file of modelFilesOf(dir, model)) lock[model][file] ??= { parts: "*" };
      for (const [file, entry] of Object.entries(lock[model])) entry.hash = hashOf(file, entry.parts);
      writeLock(dir, lock);
    }
    results[model] = wrong;
  }
  return results;
}

async function main(argv) {
  const at = argv.indexOf("--dir");
  const dir = at >= 0 ? argv.splice(at, 2)[1] : ["specification", "specs", "models"].find(existsSync);
  const [command, ...rest] = argv;
  if (!dir) throw new Error("no model directory found; pass --dir");
  if (command === "import") {
    const { models, missing } = importLock(dir);
    console.log(`${models} model(s) recorded in ${lockPath(dir)}`);
    if (missing.length) console.log(`no recorded sources: ${missing.join(", ")}`);
  } else if (command === "check") {
    const stale = staleModels(readLock(dir), dir);
    for (const [model, files] of Object.entries(stale)) console.log(`${model}: ${files.join(", ")}`);
    console.log(`${Object.keys(stale).length} model(s) need rechecking`);
    return Object.keys(stale).length ? 1 : 0;
  } else if (command === "scope") {
    const [model, file, ...parts] = rest;
    if (!parts.length) throw new Error("scope needs a model, a file and at least one part");
    setScope(dir, model, file, parts);
  } else if (command === "recheck") {
    const results = Object.entries(await recheck(dir, rest));
    for (const [model, wrong] of results) console.log(`${wrong.length ? "FAIL" : "ok  "} ${model} ${wrong.join("; ")}`);
    return results.some(([, wrong]) => wrong.length) ? 1 : 0;
  } else {
    throw new Error("usage: model-sources.mjs import|check|scope|recheck [--dir D]");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 2; });
}
