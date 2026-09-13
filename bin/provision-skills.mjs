#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkillsFromDirectory } from "../src/skills.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
let skillsPath = process.env.PI_HARNESS_SKILLS_PATH || path.resolve(packageRoot, "skills");
let runtimeDir = path.join(agentDir, "harness", "kernel-runtime");
let approved = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--yes") approved = true;
  else if (["--skills", "--runtime"].includes(argument)) {
    const value = process.argv[++index];
    if (!value) throw new Error(`${argument} requires a path`);
    if (argument === "--skills") skillsPath = path.resolve(value);
    else runtimeDir = path.resolve(value);
  } else throw new Error("usage: provision-skills.mjs [--yes] [--skills PATH] [--runtime PATH]");
}

const catalog = await discoverSkillsFromDirectory(skillsPath);
if (catalog.diagnostics.length) throw new Error(`Invalid skill package:
${catalog.diagnostics.map((item) => item.error).join("\n")}`);
const dependencies = [...new Set(catalog.skills.flatMap((skill) => skill.python?.dependencies ?? []))].sort();
const manager = new PythonRuntimeManager({ runtimeDir });
try {
  const runtime = await manager.ensure({
    skills: catalog.skills,
    consent: async ({ pythonVersion, packages }) => {
      if (!approved) return false;
      process.stderr.write(`Provisioning CPython ${pythonVersion} with ${packages.join(", ")}\n`);
      return true;
    },
    onProgress: (message) => { if (message) process.stderr.write(`${message}\n`); },
  });
  console.log(JSON.stringify({ ready: true, skillsPath, runtimeDir, skillCount: catalog.skills.length, dependencies, ...runtime }, null, 2));
} catch (error) {
  if (!approved && /installation was not approved/.test(error instanceof Error ? error.message : String(error))) {
    throw new Error("The current skill catalog needs a managed Python environment. Review the skill dependencies, then rerun with --yes before assigning work to agents.");
  }
  throw error;
}
