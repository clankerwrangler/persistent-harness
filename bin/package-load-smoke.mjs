#!/usr/bin/env node
import path from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "..");
await Promise.all([
  ...["kernel.py", "_persistent_harness.py", "_mime_history.py", "_linux_memory.py", "_cold_residency.py"]
    .map(file => access(path.join(packageRoot, "python-runtime", file))),
  import(pathToFileURL(path.join(packageRoot, "src", "supervisor.mjs"))),
  import(pathToFileURL(path.join(packageRoot, "src", "extension.mjs"))),
]);
console.log("Persistent Harness core modules load.");
