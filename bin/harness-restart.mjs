#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRestartArgs, runPostRestartJob, schedulePostRestart } from "../src/post-restart.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const supervisorBin = path.join(path.dirname(scriptPath), "harness-supervisor.mjs");
async function main() {
  const options = parseRestartArgs(process.argv.slice(2));
  if (options.workerJobPath) {
    await runPostRestartJob(options.workerJobPath, { supervisorBin });
    return;
  }
  console.log(JSON.stringify(await schedulePostRestart(options, { scriptPath })));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
