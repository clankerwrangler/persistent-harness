import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getHeapStatistics } from "node:v8";
import { explicitHeapCap } from "./fixtures/node-heap-cap.mjs";
import { writeWorkerFixture } from "./fixtures/accepted-native-runtime.mjs";

test("fixture heap-cap selector preserves the native numeric-only last-valid policy", () => {
  const cases = [
    [[], undefined],
    [["--require=foreign", "--max-old-space-size=256"], "--max-old-space-size=256"],
    [["--max-old-space-size=64", "--trace-gc", "--max-old-space-size=256", "--max-old-space-size=0"], "--max-old-space-size=256"],
    [["--max-old-space-size=1"], "--max-old-space-size=1"],
    [["--max-old-space-size=0", "--max-old-space-size=-1", "--max-old-space-size=0256",
      "--max-old-space-size=1.5", "--max_old_space_size=256", "--max-old-space-size", "256",
      "--max-old-space-size=256 ", "NODE_OPTIONS=--max-old-space-size=512"], undefined],
  ];
  for (const [args, expected] of cases) {
    assert.equal(explicitHeapCap(args), expected);
    assert.equal(explicitHeapCap(args), args.findLast(argument => /^--max-old-space-size=[1-9][0-9]*$/.test(argument)));
  }
});

test("RPC launcher leaves absent explicit CLI cap policy unchanged without spawning an uncapped child", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heap-cap-absent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = [...process.execArgv];
  try {
    process.execArgv.splice(0);
    const launch = await writeWorkerFixture(dir, path.join(dir, "unused.mjs"));
    assert.deepEqual(launch.args, [path.join(dir, "stock-worker-fixture.mjs")]);
    assert.equal(launch.heapCapProof, null);
    assert.equal((await readFile(launch.args[0], "utf8")).includes("const configuredFlag"), false);
  } finally { process.execArgv.splice(0, process.execArgv.length, ...saved); }
});

test("RPC generated pre-SDK guard proves cap/parity and stops bootstrap on either mismatch", async (t) => {
  const cap = explicitHeapCap();
  if (!cap) {
    // Ordinary uncapped test runs delegate only this check to an explicitly capped parent.
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", "--test", "--test-isolation=none",
      "--test-name-pattern=^RPC generated pre-SDK guard", import.meta.filename], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir() }, encoding: "utf8", timeout: 30000,
    });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout); return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "heap-cap-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const launch = await writeWorkerFixture(dir, path.join(dir, "unused.mjs"));
  const wrapper = launch.args.at(-1), source = await readFile(wrapper, "utf8");
  assert.deepEqual(launch.args, [cap, wrapper], "No unrelated parent flags are forwarded");
  assert.equal(launch.heapCapProof.flag, cap);
  assert.equal(launch.heapCapProof.heapSizeLimit, getHeapStatistics().heap_size_limit);
  const boundary = source.indexOf("const { runSDKWorkerRpc, bootstrapSDKWorker }");
  assert(boundary > source.indexOf('phase: "pre-sdk-bootstrap"'));
  const marker = path.join(dir, "bootstrap-reached");
  // Execute the exact generated prefix, with a local sentinel replacing SDK bootstrap.
  const prefix = source.slice(0, boundary) + `writeFileSync(${JSON.stringify(marker)}, "reached");\n`;
  for (const kind of ["good", "configured-mismatch", "total-mismatch"]) {
    await rm(launch.heapCapProof.file, { force: true }); await rm(marker, { force: true });
    const script = path.join(dir, `${kind}.mjs`);
    const code = kind === "configured-mismatch"
      ? prefix.replace(`assert.equal(configuredFlag, ${JSON.stringify(cap)}`, 'assert.equal(configuredFlag, "wrong-expected-cap"')
      : kind === "total-mismatch"
        ? prefix.replace(`assert.equal(heapSizeLimit, ${launch.heapCapProof.heapSizeLimit}`, `assert.equal(heapSizeLimit, ${launch.heapCapProof.heapSizeLimit + 1}`)
        : prefix;
    await writeFile(script, code);
    const result = spawnSync(launch.command, [cap, script], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    if (kind === "good") {
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(await readFile(launch.heapCapProof.file, "utf8"));
      assert.equal(receipt.pid, result.pid); assert.equal(receipt.configuredFlag, cap);
      assert.deepEqual(receipt.execArgv, [cap]);
      assert.equal(receipt.heapSizeLimit, launch.heapCapProof.heapSizeLimit);
      assert.equal(receipt.phase, "pre-sdk-bootstrap");
      assert.equal(await readFile(marker, "utf8"), "reached");
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, kind === "configured-mismatch" ? /retain the explicit parent CLI cap/ : /match the parent V8 total limit/);
      await assert.rejects(readFile(launch.heapCapProof.file), { code: "ENOENT" });
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  }
});
