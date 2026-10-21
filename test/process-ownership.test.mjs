import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  captureOwnedProcessIdentity,
  quiescentScratchProcessRoots,
  processOwnershipInternals,
  terminateOwnedProcess,
  verifyOwnedProcessIdentity,
} from "../src/process-ownership.mjs";

test("owned process identity survives PID checks and refuses mismatched reuse identities", async (t) => {
  const token = crypto.randomUUID();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    env: { ...process.env, PI_HARNESS_ACTOR_TOKEN: token },
    stdio: "ignore",
  });
  const exited = once(child, "exit"), closed = once(child, "close");
  t.after(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await once(child, "spawn");
  const identity = await captureOwnedProcessIdentity(child.pid, token);
  assert.equal(identity.processGroup, child.pid);
  assert.equal(await verifyOwnedProcessIdentity(identity), true);
  assert.equal(await verifyOwnedProcessIdentity({ ...identity, startTime: `${identity.startTime}9` }), false);
  assert.equal(await verifyOwnedProcessIdentity({ ...identity, ownerToken: "wrong-token" }), false);
  assert.deepEqual(
    await terminateOwnedProcess({ ...identity, startTime: `${identity.startTime}9` }),
    { terminated: false, reason: "identity-mismatch-or-exited" },
  );
  assert.equal(await verifyOwnedProcessIdentity(identity), true, "mismatched identities must never kill a live process");
  const terminated = await terminateOwnedProcess(identity, { graceMs: 500 });
  assert.equal(terminated.terminated, true);
  await closed;
  assert.equal(child.exitCode, null);
  assert.notEqual(child.signalCode, null, "close proves the signal exit already occurred before the retained exit await");
  await exited;
  assert.equal(await verifyOwnedProcessIdentity(identity), false);
});

test("parses Linux proc identity fields and matches exact environment entries", () => {
  const fake = `123 (node worker) S 1 123 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 98765 0`;
  assert.deepEqual(processOwnershipInternals.parseProcStat(fake), { processGroup: 123, startTime: "98765" });
  const environment = Buffer.from("A=1\0PI_HARNESS_ACTOR_TOKEN=secret\0OTHER=2\0");
  assert.equal(processOwnershipInternals.hasEnvironmentToken(environment, "secret"), true);
  assert.equal(processOwnershipInternals.hasEnvironmentToken(environment, "sec"), false);
});

test("scratch process proof is exact, bounded, and read-only", async t => {
  const rootId = crypto.randomUUID(), unrelated = crypto.randomUUID();
  const child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], {
    env: { ...process.env, PI_HARNESS_ROOT_SESSION_ID: rootId }, stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data");
  const proof = await quiescentScratchProcessRoots([rootId, unrelated]);
  assert.equal(proof.has(rootId), false);
  assert.equal(proof.has(unrelated), true);
  assert.equal(child.exitCode, null);
  assert.equal((await quiescentScratchProcessRoots([rootId], { maxProcesses: 0 })).size, 0);
  assert.equal((await quiescentScratchProcessRoots([rootId], { maxBytes: 0 })).size, 0);
  assert.equal((await quiescentScratchProcessRoots([rootId], { timeoutMs: 0 })).size, 0);
});
