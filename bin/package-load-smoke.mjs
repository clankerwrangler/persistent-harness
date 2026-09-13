#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "..");
await Promise.all([
  import(pathToFileURL(path.join(packageRoot, "src", "supervisor.mjs"))),
  import(pathToFileURL(path.join(packageRoot, "src", "extension.mjs"))),
]);
console.log("Persistent Harness core modules load.");
