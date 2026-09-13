import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_RESTART_TIMEOUT_MS,
  parseRestartArgs,
  POST_RESTART_NUDGE,
  sanitizedRestartEnvironment,
  schedulePostRestart,
} from "../src/post-restart.mjs";

test("restart arguments bind an actor to its own initiating session", () => {
  const env = { PI_CODING_AGENT_DIR: "/tmp/agent", PI_HARNESS_ACTOR_ID: "session-a" };
  const parsed = parseRestartArgs([], env);
  assert.equal(parsed.resumeSessionId, "session-a");
  assert.equal(parsed.timeoutMs, DEFAULT_RESTART_TIMEOUT_MS);
  assert.throws(() => parseRestartArgs(["--resume", "session-b"], env), /only its own session/);
  assert.throws(() => parseRestartArgs([], { PI_CODING_AGENT_DIR: "/tmp/agent" }), /resume session id/);
  assert.throws(() => parseRestartArgs(["--timeout-ms", "1"], env), /timeout/);
  assert.throws(() => parseRestartArgs(["--worker", "/tmp/job.json"], env), /scheduled restart process/);
  assert.deepEqual(parseRestartArgs(["--worker", "/tmp/job.json"], { ...env, PI_HARNESS_RESTART_WORKER: "1" }), { workerJobPath: "/tmp/job.json" });
  assert.match(POST_RESTART_NUDGE, /local harness nudge/);
});

test("restart worker environment drops actor authority but retains ordinary configuration", () => {
  const sanitized = sanitizedRestartEnvironment({
    PATH: "/bin", PI_HARNESS_ACTOR_ID: "s", PI_HARNESS_ACTOR_TOKEN: "secret",
    PI_HARNESS_ACTOR_GENERATION: "2", PI_HARNESS_ACTOR_SKILL_GRANT: "/grant",
    PI_SESSION_ID: "pi", PI_SESSION_FILE: "/session", PI_HARNESS_ACTOR_EXTENSIONS: "[]",
  });
  assert.equal(sanitized.PATH, "/bin");
  assert.equal(sanitized.PI_HARNESS_ACTOR_EXTENSIONS, "[]");
  for (const key of ["PI_HARNESS_ACTOR_ID", "PI_HARNESS_ACTOR_TOKEN", "PI_HARNESS_ACTOR_GENERATION", "PI_HARNESS_ACTOR_SKILL_GRANT", "PI_SESSION_ID", "PI_SESSION_FILE"]) {
    assert.equal(sanitized[key], undefined);
  }
});

test("restart scheduling persists a bounded job before spawning a detached worker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-post-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    socketPath: path.join(root, "supervisor.sock"), databasePath: path.join(root, "harness.sqlite"),
    pidPath: path.join(root, "supervisor.pid"), resumeSessionId: "session-a", timeoutMs: DEFAULT_RESTART_TIMEOUT_MS,
  };
  const jobsDir = path.join(path.dirname(options.databasePath), "restart-jobs");
  await mkdir(jobsDir, { recursive: true });
  for (let index = 0; index < 70; index += 1) await writeFile(path.join(jobsDir, `old-${index}.json`), JSON.stringify({ state: "complete" }));
  let spawned;
  const result = await schedulePostRestart(options, {
    scriptPath: "/workspace/harness-restart.mjs",
    request: async (_socket, type) => {
      assert.equal(type, "get_status");
      return { sessions: [{ sessionId: "session-a", lifecycle: "resident" }] };
    },
    spawnImpl: (command, args, spawnOptions) => {
      spawned = { command, args, spawnOptions, unref: false };
      return { pid: 42, unref: () => { spawned.unref = true; } };
    },
  });
  assert.equal(result.scheduled, true); assert.equal(result.workerPid, 42); assert.equal(spawned.unref, true);
  assert.equal(spawned.spawnOptions.detached, true); assert.equal(spawned.spawnOptions.stdio, "ignore");
  assert.equal(spawned.spawnOptions.env.PI_HARNESS_RESTART_WORKER, "1");
  assert.equal(spawned.args[1], "--worker"); assert.equal(spawned.args[2], result.jobPath);
  const job = JSON.parse(await readFile(result.jobPath, "utf8"));
  assert.equal(job.resumeSessionId, "session-a"); assert.equal(job.state, "scheduled"); assert.equal(job.message, undefined);
  assert.equal((await stat(result.jobPath)).mode & 0o777, 0o600);
  const retained = await readdir(jobsDir); assert.equal(retained.filter((name) => name.startsWith("old-")).length, 64);
});
