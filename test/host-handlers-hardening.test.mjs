import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostHandlers, hostLimits } from "../src/host-handlers.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "host-hardening-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, handlers: createHostHandlers({ cwd, getClient: () => null }) };
}

function context({ signal = new AbortController().signal, progress = [] } = {}) {
  return { signal, onProgress: (stream, text) => progress.push({ stream, text }) };
}

test("files.grep isolates catastrophic regex work behind an enforced deadline", { timeout: 10_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  await writeFile(path.join(cwd, "hostile.txt"), `${"a".repeat(50_000)}!\n`);

  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  const startedAt = Date.now();
  await assert.rejects(
    handlers["files.grep"]({ path: ".", pattern: "^(a+)+$", limit: 10 }, context()),
    /exceeded 2000 ms deadline/,
  );
  clearInterval(ticker);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= hostLimits.maxGrepRuntimeMs - 100, `deadline fired too early: ${elapsed} ms`);
  assert.ok(elapsed < hostLimits.maxGrepRuntimeMs + 2_000, `worker was not terminated promptly: ${elapsed} ms`);
  assert.ok(ticks >= 20, `host event loop stopped while regex ran (ticks=${ticks})`);

  await writeFile(path.join(cwd, "healthy.txt"), "alpha\nhealthy follow-up\nomega\n");
  const healthy = await handlers["files.grep"](
    { path: "healthy.txt", pattern: "healthy", limit: 10 },
    context(),
  );
  assert.equal(healthy.matches.length, 1);
  assert.equal(healthy.matches[0].text, "healthy follow-up");
  assert.equal(healthy.truncated, false);
});

test("files.grep bounds lines and aggregate matches and skips binary and oversized files", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const longLines = Array.from({ length: 20 }, (_, index) =>
    `MATCH-${index}-${"x".repeat(10_000)}`);
  await writeFile(path.join(cwd, "bundle.js"), longLines.join("\n"));
  await writeFile(path.join(cwd, "nul.bin"), Buffer.from("MATCH\0binary", "utf8"));
  await writeFile(path.join(cwd, "invalid.bin"), Buffer.from([0x4d, 0x41, 0x54, 0x43, 0x48, 0xff]));
  await writeFile(
    path.join(cwd, "oversized.txt"),
    Buffer.concat([Buffer.from("MATCH"), Buffer.alloc(hostLimits.maxGrepFileBytes, 0x78)]),
  );

  const result = await handlers["files.grep"](
    { path: ".", pattern: "MATCH", limit: 1000 },
    context(),
  );
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length > 0 && result.matches.length < longLines.length);
  assert.ok(result.matches.every((match) => Buffer.byteLength(match.text) <= hostLimits.maxGrepLineBytes));
  assert.ok(result.matches.every((match) => match.path.endsWith("bundle.js")));
  assert.match(result.matches[0].text, /\.\.\. line truncated \.\.\.$/);
  assert.ok(result.stats.outputBytes <= hostLimits.maxGrepOutputBytes);
  assert.ok(result.stats.inspectedBytes <= hostLimits.maxGrepTotalBytes);
  assert.ok(result.stats.inspectedFiles <= hostLimits.maxGrepFiles);

  for (const binaryPath of ["nul.bin", "invalid.bin"]) {
    const binary = await handlers["files.grep"](
      { path: binaryPath, pattern: "MATCH", limit: 10 },
      context(),
    );
    assert.equal(binary.matches.length, 0);
    assert.equal(binary.stats.skippedBinary, 1);
  }
  const oversized = await handlers["files.grep"](
    { path: "oversized.txt", pattern: "MATCH", limit: 10 },
    context(),
  );
  assert.equal(oversized.matches.length, 0);
  assert.equal(oversized.stats.skippedOversized, 1);
});

test("files.grep skips source maps during directory walks and streams session JSONL", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const mapNeedle = `MAP-NEEDLE-${"x".repeat(200)}`;
  await writeFile(path.join(cwd, "bundle.js.map"), `${mapNeedle}\n`);
  await writeFile(path.join(cwd, "keep.txt"), "visible-needle\n");
  const jsonlPath = path.join(cwd, "session.jsonl");
  const jsonl = Buffer.concat([
    Buffer.alloc(hostLimits.maxGrepFileBytes + 16, 0x20),
    Buffer.from('\n{"type":"message","id":"entry-1","message":{"role":"user","content":[{"type":"text","text":"session-jsonl-needle"}]}}\n'),
  ]);
  await writeFile(jsonlPath, jsonl);

  const walked = await handlers["files.grep"](
    { path: ".", pattern: "MAP-NEEDLE|visible-needle|session-jsonl-needle", limit: 20 },
    context(),
  );
  assert.equal(walked.matches.some((match) => match.path.endsWith("bundle.js.map")), false);
  assert.ok(walked.stats.skippedOversized >= 1);
  assert.ok(walked.matches.some((match) => match.text.includes("visible-needle")));
  assert.ok(walked.matches.some((match) => match.text.includes("session-jsonl-needle")));
  assert.equal(walked.stats.skippedOversized >= 1, true);
  assert.ok(walked.stats.inspectedBytes > hostLimits.maxGrepFileBytes);

  const explicitMap = await handlers["files.grep"](
    { path: "bundle.js.map", pattern: "MAP-NEEDLE", limit: 10 },
    context(),
  );
  assert.equal(explicitMap.matches.length, 1);
  assert.match(explicitMap.matches[0].text, /MAP-NEEDLE/);

  const explicitJsonl = await handlers["files.grep"](
    { path: "session.jsonl", pattern: "session-jsonl-needle", limit: 10 },
    context(),
  );
  assert.equal(explicitJsonl.matches.length, 1);
  assert.equal(explicitJsonl.stats.skippedOversized, 0);
});


test("files.grep enforces its aggregate source-byte cap", { timeout: 10_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  const source = path.join(cwd, "source.txt");
  await writeFile(source, Buffer.alloc(hostLimits.maxGrepFileBytes, 0x78));
  for (let index = 0; index < 33; index += 1) {
    await link(source, path.join(cwd, `linked-${String(index).padStart(2, "0")}.txt`));
  }

  const result = await handlers["files.grep"](
    { path: ".", pattern: "not-present", limit: 10 },
    context(),
  );
  assert.equal(result.matches.length, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.stats.inspectedBytes, hostLimits.maxGrepTotalBytes);
  assert.ok(result.stats.visitedEntries <= hostLimits.maxSearchFiles);
  assert.ok(result.stats.inspectedFiles <= hostLimits.maxGrepFiles);
});

test("shell.run shares one bounded budget between progress and final capture", { timeout: 10_000 }, async (t) => {
  const { handlers } = await fixture(t);
  const progress = [];
  const bytesPerStream = 3 * 1024 * 1024;
  const command = `head -c ${bytesPerStream} /dev/zero | tr '\\0' O; head -c ${bytesPerStream} /dev/zero | tr '\\0' E >&2`;
  const result = await handlers["shell.run"](
    { command, timeout: 5 },
    context({ progress }),
  );

  const progressBytes = progress.reduce((total, entry) => total + Buffer.byteLength(entry.text), 0);
  const progressStdout = progress.filter((entry) => entry.stream === "stdout").map((entry) => entry.text).join("");
  const progressStderr = progress.filter((entry) => entry.stream === "stderr").map((entry) => entry.text).join("");
  const allProgress = progress.map((entry) => entry.text).join("");
  const allCapture = result.stdout + result.stderr;
  assert.equal(result.exitCode, 0);
  assert.equal(result.totalBytes, bytesPerStream * 2);
  assert.equal(result.truncated, true);
  assert.equal(result.progressBytes, progressBytes);
  assert.equal(result.capturedBytes, progressBytes);
  assert.equal(progressStdout, result.stdout);
  assert.equal(progressStderr, result.stderr);
  assert.ok(progressBytes <= hostLimits.maxShellCaptureBytes);
  assert.ok(progressBytes + result.capturedBytes <= 2 * hostLimits.maxShellCaptureBytes);
  assert.equal((allProgress.match(/output truncated at/g) ?? []).length, 1);
  assert.equal((allCapture.match(/output truncated at/g) ?? []).length, 1);

  const followUpProgress = [];
  const followUp = await handlers["shell.run"](
    { command: "printf healthy", timeout: 2 },
    context({ progress: followUpProgress }),
  );
  assert.equal(followUp.stdout, "healthy");
  assert.equal(followUp.truncated, false);
  assert.equal(followUp.progressBytes, 7);
});

test("shell.run timeout and cancellation races terminate the process group with one cause", { timeout: 10_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);

  const timeoutMarker = path.join(cwd, "timeout-should-not-exist");
  const timedOut = await handlers["shell.run"](
    { command: `sleep 0.3; touch ${JSON.stringify(timeoutMarker)}`, timeout: 0.05 },
    context(),
  );
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.cancelled, false);

  const cancelMarker = path.join(cwd, "cancel-should-not-exist");
  const cancelController = new AbortController();
  const cancelledPromise = handlers["shell.run"](
    { command: `sleep 0.3; touch ${JSON.stringify(cancelMarker)}`, timeout: 2 },
    context({ signal: cancelController.signal }),
  );
  setTimeout(() => cancelController.abort(), 30);
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);

  const raceController = new AbortController();
  const racedPromise = handlers["shell.run"](
    { command: "sleep 5", timeout: 0.05 },
    context({ signal: raceController.signal }),
  );
  setTimeout(() => raceController.abort(), 50);
  const raced = await racedPromise;
  assert.equal(Number(raced.cancelled) + Number(raced.timedOut), 1);

  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(access(timeoutMarker));
  await assert.rejects(access(cancelMarker));

  const healthy = await handlers["shell.run"](
    { command: "printf after-race", timeout: 2 },
    context(),
  );
  assert.equal(healthy.stdout, "after-race");
});


test("files.grep never follows root or descriptor-relative directory symlink swaps", { timeout: 15_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  const root = path.join(cwd, "root");
  const outside = path.join(cwd, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "RACE_NEEDLE\n");
  for (let index = 0; index < 1_000; index += 1) {
    await writeFile(path.join(root, `prefix-${String(index).padStart(4, "0")}.txt`), "ordinary\n");
  }
  const candidate = path.join(root, "zzz");
  const held = path.join(root, "zzz-held");
  await mkdir(candidate);
  await writeFile(path.join(candidate, "safe.txt"), "ordinary\n");

  let swapping = true;
  const swapper = (async () => {
    while (swapping) {
      try {
        await rename(candidate, held);
        await symlink(outside, candidate);
        await new Promise((resolve) => setImmediate(resolve));
        await unlink(candidate);
        await rename(held, candidate);
      } catch {}
    }
  })();
  let result;
  try {
    result = await handlers["files.grep"]({ path: "root", pattern: "RACE_NEEDLE", limit: 10 }, context());
  } finally {
    swapping = false;
    await swapper;
  }
  assert.deepEqual(result.matches, []);

  const rootLink = path.join(cwd, "root-link");
  await symlink(outside, rootLink);
  await assert.rejects(
    handlers["files.grep"]({ path: "root-link", pattern: "RACE_NEEDLE", limit: 10 }, context()),
    /must not be a symlink/,
  );
});

test("shell.run subreaper kills setsid descendants and bounds timeout settlement", { timeout: 10_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  const marker = path.join(cwd, "escaped-marker");
  const perl = `if (fork() == 0) { POSIX::setsid(); select(undef,undef,undef,0.35); open(my $fh, ">", q{${marker}}); print $fh "escaped"; print "escaped-output"; exit 0; } sleep 5;`;
  const started = Date.now();
  const result = await handlers["shell.run"](
    { command: `/usr/bin/perl -MPOSIX -e '${perl}'`, timeout: 0.05 },
    context(),
  );
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 800, `setsid descendant extended timeout settlement: ${elapsed} ms`);
  assert.doesNotMatch(result.stdout, /escaped-output/);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(access(marker));
});

test("shell.run incrementally decodes split UTF-8 and handles invalid bytes deterministically", async (t) => {
  const { handlers } = await fixture(t);
  const split = await handlers["shell.run"](
    { command: `/usr/bin/perl -e 'for my $b (0xE2,0x82,0xAC) { syswrite(STDOUT, pack("C",$b)); select(undef,undef,undef,0.03); }'`, timeout: 2 },
    context(),
  );
  assert.equal(split.stdout, "€");
  assert.equal(split.totalBytes, 3);
  assert.equal(split.capturedBytes, 3);

  const invalid = await handlers["shell.run"](
    { command: `/usr/bin/perl -e 'syswrite(STDOUT, pack("C",0xFF))'`, timeout: 2 },
    context(),
  );
  assert.equal(invalid.stdout, "�");
  assert.equal(invalid.totalBytes, 1);
  assert.equal(invalid.capturedBytes, 3);
});
