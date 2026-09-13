#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlRequest } from "../src/control.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

function parseArgs(argv) {
  const command = argv[0];
  if (!["start", "ensure", "status", "shutdown"].includes(command)) {
    throw new Error("usage: harness-supervisor <start|ensure|status|shutdown> [--socket PATH] [--db PATH] [--pid PATH]");
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const harnessDir = path.join(agentDir, "harness");
  const options = {
    command,
    socketPath: path.join(harnessDir, "supervisor.sock"),
    databasePath: path.join(harnessDir, "harness.sqlite"),
    pidPath: path.join(harnessDir, "supervisor.pid"),
    startLockPath: path.join(harnessDir, "supervisor.start.lock"),
  };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === "--socket") options.socketPath = path.resolve(value);
    else if (flag === "--db") options.databasePath = path.resolve(value);
    else if (flag === "--pid") {
      options.pidPath = path.resolve(value);
      options.startLockPath = `${options.pidPath}.start.lock`;
    }
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

async function socketAvailable(socketPath) {
  try {
    await controlRequest(socketPath, "get_status", {}, { timeoutMs: 500 });
    return true;
  } catch {
    return false;
  }
}

function startLockOwnerIsLive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (killError) {
    return killError?.code !== "ESRCH";
  }
}

export async function acquireStartLock(lockPath, timeoutMs = 10_000) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
      await handle.close();
      return async () => {
        try { await unlink(lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8"));
        stale = !startLockOwnerIsLive(owner);
      } catch { stale = true; }
      if (stale) {
        try { await unlink(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for supervisor startup lock ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function ensureSupervisor(options) {
  if (await socketAvailable(options.socketPath)) return { alreadyRunning: true };
  const release = await acquireStartLock(options.startLockPath);
  try {
    if (await socketAvailable(options.socketPath)) return { alreadyRunning: true };
    const child = spawn(process.execPath, [
      process.argv[1], "start", "--socket", options.socketPath, "--db", options.databasePath, "--pid", options.pidPath,
    ], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await socketAvailable(options.socketPath)) return { alreadyRunning: false, pid: child.pid };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for harness supervisor startup");
  } finally {
    await release();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "ensure") {
    console.log(JSON.stringify(await ensureSupervisor(options)));
    return;
  }
  if (options.command === "status") {
    console.log(JSON.stringify(await controlRequest(options.socketPath, "get_status"), null, 2));
    return;
  }
  if (options.command === "shutdown") {
    console.log(JSON.stringify(await controlRequest(options.socketPath, "shutdown_daemon"), null, 2));
    return;
  }

  const supervisor = new HarnessSupervisor(options);
  const status = await supervisor.start();
  console.log(JSON.stringify(status));
  const stop = () => supervisor.stop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await supervisor.whenStopped;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
