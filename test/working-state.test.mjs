import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workingStateNote } from "../src/working-state.mjs";

test("a registered working-state file over the limit produces a note; otherwise nothing", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "working-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "working-state.json"), file = path.join(dir, "CURRENT.json");
  const note = (id = "room") => workingStateNote(id, { registryPath, limit: 1024 });
  assert.equal(note(), null, "no registry");
  await writeFile(registryPath, JSON.stringify({ room: file, relative: "CURRENT.json" }));
  assert.equal(note(), null, "registered file missing");
  await writeFile(file, "x".repeat(1024));
  assert.equal(note(), null, "at the limit");
  await writeFile(file, "x".repeat(3000));
  assert.equal(note(), `Working state ${file} is 3 KB (limit 1 KB). Before new work, cut it to the current picture and move history out.`);
  assert.equal(note("other"), null, "unregistered session");
  assert.equal(note("relative"), null, "relative paths are ignored");
  await writeFile(registryPath, "{not json");
  assert.equal(note(), null, "an unreadable registry never breaks a run");
});
