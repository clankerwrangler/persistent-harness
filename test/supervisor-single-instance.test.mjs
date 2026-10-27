import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { controlRequest } from "../src/control.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";

const supervisorBin = path.resolve(import.meta.dirname, "..", "bin", "harness-supervisor.mjs");

async function harnessPaths(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-single-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return {
    root,
    socketPath: path.join(root, "supervisor.sock"),
    pidPath: path.join(root, "supervisor.pid"),
    databasePath: path.join(root, "harness.sqlite"),
  };
}

function startDaemon(paths) {
  const child = spawn(process.execPath, [supervisorBin, "start",
    "--socket", paths.socketPath, "--db", paths.databasePath, "--pid", paths.pidPath],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: paths.root } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(([code]) => ({ code, stdout, stderr }));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

function daemonPaths({ socketPath, pidPath, databasePath }) {
  return { socketPath, pidPath, databasePath };
}

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

test("two supervisors started at the same moment leave exactly one running", async (t) => {
  const paths = await harnessPaths(t);
  const daemons = [startDaemon(paths), startDaemon(paths)];
  t.after(() => { for (const { child } of daemons) child.kill("SIGKILL"); });

  const refused = await Promise.race([
    ...daemons.map((daemon, index) => daemon.exited.then((outcome) => ({ ...outcome, index }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("neither supervisor refused to start")), 15_000).unref()),
  ]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /already starting or running/);

  const survivor = daemons[1 - refused.index];
  const deadline = Date.now() + 15_000;
  while (!await exists(paths.pidPath)) {
    assert.ok(Date.now() < deadline, `surviving supervisor did not start: ${survivor.output().stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(await controlRequest(paths.socketPath, "get_liveness", {}), { alive: true });
  await controlRequest(paths.socketPath, "shutdown_daemon");
  assert.equal((await survivor.exited).code, 0);
  assert.equal(await exists(`${paths.pidPath}.lock`), false, "a clean stop releases the lock");
});

test("a supervisor refuses to start while another in this process holds the same paths", async (t) => {
  const paths = await harnessPaths(t);
  const running = new HarnessSupervisor(daemonPaths(paths));
  await running.start();
  t.after(() => running.stop());

  const second = new HarnessSupervisor(daemonPaths(paths));
  await assert.rejects(second.start(), /already starting or running/);
  assert.deepEqual(await controlRequest(paths.socketPath, "get_liveness", {}), { alive: true });
});

test("a lock left by a crashed supervisor does not block the next start", async (t) => {
  const paths = await harnessPaths(t);
  const crashed = startDaemon(paths);
  const deadline = Date.now() + 15_000;
  while (!await exists(paths.pidPath)) {
    assert.ok(Date.now() < deadline, `supervisor did not start: ${crashed.output().stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  crashed.child.kill("SIGKILL");
  await crashed.exited;
  assert.equal(await exists(`${paths.pidPath}.lock`), true);

  const next = new HarnessSupervisor(daemonPaths(paths));
  await next.start();
  t.after(() => next.stop());
  assert.deepEqual(await controlRequest(paths.socketPath, "get_liveness", {}), { alive: true });
});

