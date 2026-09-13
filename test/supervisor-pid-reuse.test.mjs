import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireStartLock } from "../bin/harness-supervisor.mjs";
import { controlRequest } from "../src/control.mjs";
import { HarnessSupervisor, supervisorInternals } from "../src/supervisor.mjs";

const supervisorBin = path.resolve(import.meta.dirname, "..", "bin", "harness-supervisor.mjs");
const LIVE_HARNESS_DIR = path.resolve(os.homedir(), ".pi", "agent", "harness");
const STALE_OWNER = "01234567-89ab-4cde-8f01-23456789abcd";
const OLD_STARTED_AT = Date.now() - 86_400_000;

function assertTempHarnessPath(filePath) {
  const resolved = path.resolve(filePath);
  assert.equal(resolved.startsWith(`${LIVE_HARNESS_DIR}${path.sep}`), false, `test must not touch live harness path ${resolved}`);
}

async function makeHarnessDirs(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const runDir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  await Promise.all([
    mkdir(runDir, { recursive: true, mode: 0o700 }),
    mkdir(stateDir, { recursive: true, mode: 0o700 }),
  ]);
  const paths = {
    root,
    socketPath: path.join(runDir, "supervisor.sock"),
    pidPath: path.join(runDir, "supervisor.pid"),
    databasePath: path.join(stateDir, "harness.sqlite"),
  };
  assertTempHarnessPath(paths.pidPath);
  assertTempHarnessPath(paths.socketPath);
  return paths;
}

function stalePidRecord({ pid, socketPath, startedAt = OLD_STARTED_AT, ownerToken = STALE_OWNER }) {
  return { pid, ownerToken, socketPath, startedAt };
}

function waitLine(stream, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => cleanup(new Error("timed out waiting for daemon startup")), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        try { cleanup(null, JSON.parse(buffer.slice(0, newline))); }
        catch (error) { cleanup(error); }
      }
    };
    const cleanup = (error, value) => {
      clearTimeout(timer);
      stream.off("data", onData);
      if (error) reject(error);
      else resolve(value);
    };
    stream.on("data", onData);
  });
}

async function spawnSupervisor(t, paths, { beforeStart } = {}) {
  const script = `
    import { writeFile } from "node:fs/promises";
    const pidPath = ${JSON.stringify(paths.pidPath)};
    const socketPath = ${JSON.stringify(paths.socketPath)};
    const databasePath = ${JSON.stringify(paths.databasePath)};
    const supervisorBin = ${JSON.stringify(supervisorBin)};
    ${beforeStart || ""}
    process.argv = [process.execPath, supervisorBin, "start", "--socket", socketPath, "--db", databasePath, "--pid", pidPath];
    await import(supervisorBin);
  `;
  const daemon = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  daemon.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  daemon.once("exit", () => { daemon.failureText = stderr; });
  t.after(async () => {
    try { await controlRequest(paths.socketPath, "shutdown_daemon", {}, { timeoutMs: 1000 }); } catch {}
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  });
  return daemon;
}

test("pid=7 self-reuse is stale even if that pid is alive", async () => {
  const record = stalePidRecord({ pid: 7, socketPath: path.join(os.tmpdir(), "unused-supervisor.sock") });
  assert.equal(await supervisorInternals.pidRecordIsLiveSupervisor(record, { currentPid: 7 }), false);
});

test("bind-mounted pid file with self pid and old startedAt lets harness-supervisor start succeed", { timeout: 20_000 }, async (t) => {
  const paths = await makeHarnessDirs(t, "harness-pid-reuse-self-");
  const daemon = await spawnSupervisor(t, paths, {
    beforeStart: `
      await writeFile(pidPath, JSON.stringify({
        pid: process.pid,
        ownerToken: ${JSON.stringify(STALE_OWNER)},
        socketPath,
        startedAt: Date.now() - 86_400_000,
      }) + "\\n");
    `,
  });
  let status;
  try {
    status = await waitLine(daemon.stdout);
  } catch (error) {
    throw new Error(`${error.message}${daemon.failureText ? `: ${daemon.failureText}` : ""}`);
  }
  assert.equal(status.running, true);
  assert.equal(status.pid, daemon.pid);
  const record = JSON.parse(await readFile(paths.pidPath, "utf8"));
  assert.equal(record.pid, daemon.pid);
  assert.notEqual(record.ownerToken, STALE_OWNER);
  assert.ok(record.startedAt > OLD_STARTED_AT);
});

test("HarnessSupervisor.start unlinks a bind-mounted self-pid record (Docker recreate / pid=7 class)", { timeout: 20_000 }, async (t) => {
  const paths = await makeHarnessDirs(t, "harness-pid-reuse-start-");
  await writeFile(paths.pidPath, `${JSON.stringify(stalePidRecord({ pid: process.pid, socketPath: paths.socketPath }))}\n`, { mode: 0o600 });
  await writeFile(paths.socketPath, "stale-socket", { mode: 0o600 });
  const supervisor = new HarnessSupervisor({ ...paths, actorInactivityMs: 0 });
  const status = await supervisor.start();
  t.after(() => supervisor.stop());
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  const record = JSON.parse(await readFile(paths.pidPath, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.notEqual(record.ownerToken, STALE_OWNER);
});

test("true live supervisor with matching identity and listening socket still refuses to start", { timeout: 20_000 }, async (t) => {
  const paths = await makeHarnessDirs(t, "harness-pid-reuse-live-");
  const daemon = await spawnSupervisor(t, paths);
  let first;
  try {
    first = await waitLine(daemon.stdout);
  } catch (error) {
    throw new Error(`${error.message}${daemon.failureText ? `: ${daemon.failureText}` : ""}`);
  }
  assert.equal(first.running, true);
  const before = JSON.parse(await readFile(paths.pidPath, "utf8"));
  assert.equal(before.pid, daemon.pid);
  const second = new HarnessSupervisor({ ...paths, actorInactivityMs: 0 });
  await assert.rejects(() => second.start(), /live process|already listening/);
  const after = JSON.parse(await readFile(paths.pidPath, "utf8"));
  assert.equal(after.pid, daemon.pid);
  assert.equal(after.ownerToken, before.ownerToken);
  assert.equal(daemon.exitCode, null);
});

test("dead stale pid and leftover socket still start", { timeout: 20_000 }, async (t) => {
  const paths = await makeHarnessDirs(t, "harness-pid-reuse-stale-");
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(dead, "exit");
  await writeFile(paths.pidPath, `${JSON.stringify(stalePidRecord({ pid: dead.pid, socketPath: paths.socketPath }))}\n`, { mode: 0o600 });
  await writeFile(paths.socketPath, "stale-socket", { mode: 0o600 });
  const supervisor = new HarnessSupervisor({ ...paths, actorInactivityMs: 0 });
  const status = await supervisor.start();
  t.after(() => supervisor.stop());
  assert.equal(status.running, true);
  const record = JSON.parse(await readFile(paths.pidPath, "utf8"));
  assert.equal(record.pid, process.pid);
  assert.notEqual(record.pid, dead.pid);
});

test("supervisor start lock treats self-pid as stale Docker reuse", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-start-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "supervisor.start.lock");
  assertTempHarnessPath(lockPath);
  await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: OLD_STARTED_AT })}\n`);
  const release = await acquireStartLock(lockPath, 1000);
  t.after(release);
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.ok(owner.startedAt > OLD_STARTED_AT);
});
