import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostHandlers } from "../src/host-handlers.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-event-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "events.jsonl");
  const handlers = createHostHandlers({ cwd: directory, getClient: () => ({ isConnected: true,
    request: async type => { assert.equal(type, "get_status"); return { daemon: { logPath } }; } }) });
  return { logPath, read: limit => handlers["operations.events"]({ limit }) };
}

async function oracle(logPath, limit) {
  const lines = [];
  for (const file of [`${logPath}.1`, logPath]) {
    const content = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    lines.push(...content.split("\n").filter(Boolean));
  }
  const events = [];
  for (const line of lines.slice(-limit)) { try { events.push(JSON.parse(line)); } catch {} }
  return { events, truncated: lines.length > limit, logPath };
}

test("event tail preserves rotated order, malformed-line quota, missing segments, and exact truncation", async t => {
  const { logPath, read } = await fixture(t);
  assert.deepEqual(await read(100), { events: [], truncated: false, logPath });
  const cases = [
    [undefined, ""], ["1\n2", undefined], ["1\n2", "3\n4\n"],
    ["\n1\n\n2\n", "\n3\n\n4"], ["1\n2", "bad\n4\nunfinished"],
    ["1\n{", "}\n4"], ["null\nfalse\n{}", "[]\n0\n\"text\""],
  ];
  for (const [previous, current] of cases) {
    for (const [file, content] of [[`${logPath}.1`, previous], [logPath, current]]) {
      if (content === undefined) await rm(file, { force: true }); else await writeFile(file, content);
    }
    for (const limit of [1, 2, 3, 5, 100, 500]) assert.deepEqual(await read(limit), await oracle(logPath, limit));
  }
});

test("event tail decodes complete UTF-8 lines across chunks, including large and invalid lines", async t => {
  const { logPath, read } = await fixture(t);
  const long = JSON.stringify({ text: "🧭漢字".repeat(20_000) });
  await writeFile(`${logPath}.1`, `0\n${long}\n`);
  await writeFile(logPath, Buffer.concat([Buffer.from(`1\n${long}\n`), Buffer.from([0xff, 0xc3]), Buffer.from('\n{"last":"終"}') ]));
  for (const limit of [1, 2, 3, 4, 500]) assert.deepEqual(await read(limit), await oracle(logPath, limit));
});

test("event tail reads only the needed suffix, tolerates short reads, and closes descriptors", async t => {
  const { logPath, read } = await fixture(t);
  const line = JSON.stringify({ event: "actor_started", sessionId: "synthetic" }) + "\n";
  await writeFile(logPath, line.repeat(50_000));
  await writeFile(`${logPath}.1`, line.repeat(50_000));
  const probe = await open(logPath, "r"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read, originalStat = prototype.stat;
  const handles = [];
  let bytes = 0, shortReads = false;
  t.mock.method(prototype, "read", async function(buffer, offset, length, position) {
    const result = await originalRead.call(this, buffer, offset, shortReads ? Math.min(length, 7) : length, position);
    bytes += result.bytesRead; return result;
  });
  t.mock.method(prototype, "stat", async function(...args) { handles.push(this); return originalStat.apply(this, args); });
  const result = await read(100);
  assert.equal(result.events.length, 100); assert.equal(result.truncated, true);
  assert.equal(bytes, 64 * 1024, "do not read the older segment or unused current prefix");
  assert.equal(handles.length, 2);
  for (const handle of handles) await assert.rejects(originalStat.call(handle), /closed/);
  await writeFile(logPath, '1\n{"text":"🧭漢字"}\n3');
  shortReads = true;
  assert.deepEqual(await read(2), { events: [{ text: "🧭漢字" }, 3], truncated: true, logPath });
  assert.equal(handles.length, 4);
  for (const handle of handles) await assert.rejects(originalStat.call(handle), /closed/);
});

test("event tail reports concurrent truncation and closes files before a later retry", async t => {
  const { logPath, read } = await fixture(t);
  await writeFile(logPath, "1\n2\n3\n");
  const probe = await open(logPath, "r"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let readingFile;
  const mock = t.mock.method(prototype, "read", async function(...args) {
    readingFile = this;
    await writeFile(logPath, "");
    return original.apply(this, args);
  });
  await assert.rejects(read(2), /Event log changed while reading; retry operations.events/);
  await assert.rejects(readingFile.stat(), /closed/);
  mock.mock.restore();
  await writeFile(logPath, "4\n5\n");
  assert.deepEqual(await read(2), { events: [4, 5], truncated: false, logPath });
});


test("event tail keeps opened segment identity during rotation and sees new segments on retry", async t => {
  const { logPath, read } = await fixture(t);
  await writeFile(`${logPath}.1`, "1\n2\n"); await writeFile(logPath, "3\n4\n");
  const probe = await open(logPath, "r"), prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.read;
  let rotated = false;
  t.mock.method(prototype, "read", async function(...args) {
    if (!rotated) {
      rotated = true;
      await rename(logPath, `${logPath}.1`); await writeFile(logPath, "5\n");
    }
    return original.apply(this, args);
  });
  assert.deepEqual(await read(5), { events: [1, 2, 3, 4], truncated: false, logPath });
  assert.deepEqual(await read(5), { events: [3, 4, 5], truncated: false, logPath });
});
