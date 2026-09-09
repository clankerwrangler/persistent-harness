#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
const extensionsDir = path.join(agentDir, "extensions");
const extensionDir = path.join(extensionsDir, "persistent-harness");
const entrypoint = path.join(extensionDir, "index.ts");
const binDir = path.join(agentDir, "bin");
const launchEnvPath = path.join(agentDir, "harness", "launch-env.sh");
const wrappers = new Map([
  [path.join(binDir, "persistent-pi"), path.join(packageRoot, "bin", "persistent-pi.mjs")],
  [path.join(binDir, "harness-supervisor"), path.join(packageRoot, "bin", "harness-supervisor.mjs")],
  [path.join(binDir, "harness-restart"), path.join(packageRoot, "bin", "harness-restart.mjs")],
  [path.join(binDir, "harness-provision-skills"), path.join(packageRoot, "bin", "provision-skills.mjs")],
]);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const wrapperContent = (target) => `#!/bin/sh\nif [ -r ${shellQuote(launchEnvPath)} ]; then . ${shellQuote(launchEnvPath)}; fi\nexec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`;
const command = process.argv[2] || "install";
if (!["install", "uninstall"].includes(command)) throw new Error("usage: install.mjs <install|uninstall>");
if (command === "uninstall") {
  await rm(extensionDir, { recursive: true, force: true });
  for (const [file, target] of wrappers) {
    try { if (await readFile(file, "utf8") === wrapperContent(target)) await rm(file, { force: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  console.log(`Removed ${extensionDir} and harness launchers from ${binDir}. Durable harness data was retained; see docs/OPERATIONS.md for complete removal.`);
} else {
  await Promise.all([
    mkdir(extensionDir, { recursive: true, mode: 0o700 }),
    mkdir(binDir, { recursive: true, mode: 0o700 }),
  ]);
  await chmod(extensionsDir, 0o700);
  await writeFile(entrypoint, `export { default } from ${JSON.stringify(path.join(packageRoot, "index.ts"))};\n`, { mode: 0o600 });
  for (const [file, target] of wrappers) await writeFile(file, wrapperContent(target), { mode: 0o700 });
  console.log(`Installed Persistent Harness at ${entrypoint}`);
  console.log(`Launch or navigate persistent sessions with ${path.join(binDir, "persistent-pi")}`);
  console.log(`Safely restart and resume an initiating session with ${path.join(binDir, "harness-restart")}`);
  console.log(`Verify or provision skill dependencies with ${path.join(binDir, "harness-provision-skills")}`);
}
