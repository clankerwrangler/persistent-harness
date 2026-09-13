#!/usr/bin/env node
import { Console } from "node:console";
import { runSDKWorkerRpc } from "../src/sdk-worker.mjs";

// stdout is exclusively the actor protocol. All extension console methods use stderr.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
process.env.AI_AGENT = "pi";
process.env.PI_CODING_AGENT = "true";
try { await runSDKWorkerRpc(); }
catch (error) { console.error(`Actor worker failed: ${error.message}`); process.exitCode = 1; }
