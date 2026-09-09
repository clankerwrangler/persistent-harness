
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonLineDecoder } from "../src/framing.mjs";
import { DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS, PiRpcLineDecoder, PiSessionActor } from "../src/session-actor.mjs";

test("session actor spawn failure terminates once without hanging cleanup", async () => {
  const actor = new PiSessionActor({ command: `/definitely-missing-pi-${crypto.randomUUID()}`, args: [], cwd: "/tmp", env: process.env, requestTimeoutMs: 100, shutdownTimeoutMs: 100 });
  const exited = new Promise((resolve) => actor.once("exit", resolve));
  await assert.rejects(actor.start(), /ENOENT/);
  const details = await exited;
  assert.match(details.error, /ENOENT/);
  await actor.close();
  assert.equal(actor.isRunning, false);
});


test("prompt preflight can outlive the actor startup and control timeout", { timeout: 5000 }, async (t) => {
  assert(DEFAULT_PROMPT_PREFLIGHT_TIMEOUT_MS > 300_000);
  const rpcFixture = String.raw`
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    const reply = (request, data) => process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data }) + "\n");
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.type === "get_state") reply(request, { sessionId: "delayed-preflight", isStreaming: false });
      else if (request.type === "prompt") setTimeout(() => reply(request, { accepted: true }), 750);
      else if (request.type === "slow_control") setTimeout(() => reply(request, { completed: true }), 750);
      else reply(request, {});
    });
  `;
  const actor = new PiSessionActor({
    command: process.execPath, args: ["--input-type=module", "--eval", rpcFixture], cwd: "/tmp", env: process.env,
    requestTimeoutMs: 500, promptPreflightTimeoutMs: 2000, shutdownTimeoutMs: 100,
  });
  t.after(() => actor.close());
  await actor.start();
  await assert.rejects(actor.request("slow_control"), /Pi RPC slow_control timed out/);
  assert.deepEqual(await actor.prompt("wait for preflight"), { accepted: true });
});

async function shutdownFixture(t, { hang = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-actor-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rpcFixture = String.raw`
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { writeFile } from "node:fs/promises";
    import readline from "node:readline";
    const child = spawn(process.execPath, ["--eval", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await once(child.stdout, "data");
    await writeFile("child-pid", String(child.pid));
    process.on("SIGTERM", async () => {
      if (process.env.FIXTURE_HANG === "1") return;
      // Represent extension cleanup that needs its child to finish a save.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const survived = child.exitCode === null && child.signalCode === null;
      await writeFile("cleanup", survived ? "drained" : "child interrupted before cleanup");
      if (survived) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      process.exit(0);
    });
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true,
        data: request.type === "get_state" ? { sessionId: "shutdown", isStreaming: false } : {} }) + "\n");
    });
  `;
  const actor = new PiSessionActor({
    command: process.execPath, args: ["--input-type=module", "--eval", rpcFixture], cwd: root,
    env: { ...process.env, FIXTURE_HANG: hang ? "1" : "0" },
    requestTimeoutMs: 2000, shutdownTimeoutMs: hang ? 150 : 2000,
  });
  t.after(() => actor.close());
  await actor.start();
  return { root, actor, childPid: Number(await readFile(path.join(root, "child-pid"), "utf8")) };
}

test("actor shutdown gives extension children time to finish before Pi exits", {
  timeout: 5000, skip: process.platform !== "linux",
}, async (t) => {
  const { root, actor } = await shutdownFixture(t);
  const exited = new Promise((resolve) => actor.once("exit", resolve));
  await actor.close();
  assert.equal((await exited).code, 0);
  assert.equal(await readFile(path.join(root, "cleanup"), "utf8"), "drained");
});

test("an unresponsive actor still receives bounded forced shutdown with its child", {
  timeout: 5000, skip: process.platform !== "linux",
}, async (t) => {
  const { actor, childPid } = await shutdownFixture(t, { hang: true });
  const exited = new Promise((resolve) => actor.once("exit", resolve));
  await actor.close();
  assert.equal((await exited).signal, "SIGKILL");
  // A container's PID 1 can reap an exited child later; a zombie has terminated.
  let childStopped = false;
  for (let i = 0; i < 100 && !childStopped; i++) {
    try {
      const stat = await readFile(`/proc/${childPid}/stat`, "utf8");
      childStopped = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
      childStopped = true;
    }
    if (!childStopped) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(childStopped, true);
});


test("Pi RPC line decoder handles fragmented large responses in linear chunks", () => {
  const decoder = new PiRpcLineDecoder();
  const payload = "x".repeat(8 * 1024 * 1024);
  const encoded = Buffer.from(`${JSON.stringify({ type: "response", id: "large", success: true, data: { payload } })}\n${JSON.stringify({ type: "event", value: "next" })}\n`);
  const frames = [];
  for (let offset = 0; offset < encoded.length; offset += 4093) frames.push(...decoder.push(encoded.subarray(offset, offset + 4093)));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data.payload.length, payload.length);
  assert.equal(frames[1].value, "next");
});


test("harness JSONL decoder handles a fragmented multi-megabyte image frame linearly", () => {
  const decoder = new JsonLineDecoder(); const data = "A".repeat(4 * 1024 * 1024);
  const encoded = Buffer.from(`${JSON.stringify({ version: 2, id: "image", type: "submit_input", params: { data } })}
`);
  let frames = [];
  for (let offset = 0; offset < encoded.length; offset += 4093) frames = frames.concat(decoder.push(encoded.subarray(offset, offset + 4093)));
  assert.equal(frames.length, 1); assert.equal(frames[0].params.data.length, data.length); decoder.finish();
});
