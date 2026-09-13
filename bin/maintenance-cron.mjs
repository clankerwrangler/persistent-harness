#!/usr/bin/env node
import { readFileSync, lstatSync } from "node:fs";
import { maintenanceCron } from "../src/maintenance-cron.mjs";

// One-shot helper for admit, inspect, and post-commit ensure-armed.
// A successful ensure-armed proves admission; inspection alone is not arming.
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--database" || args[2] !== "--intent" || args[4] !== "--operation") throw new Error("invalid invocation");
  const stat = lstatSync(args[3]);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("invalid intent file");
  const intent = JSON.parse(readFileSync(args[3], "utf8"));
  const receipt = maintenanceCron({ databasePath: args[1], intent, operation: args[5] });
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ...error.receipt, ok: false, phase: error.phase ?? "validation", mutationPossible: error.mutationPossible === true,
    error: "canonical maintenance admission failed" })}\n`);
  process.exitCode = 1;
}
