import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRegistry, rootReminders, workingStateNote } from "../src/run-reminders.mjs";

test("working-state note appears only for a registered absolute file over the limit", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reminders-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "CURRENT.json");
  assert.equal(workingStateNote({ state: file }, 1024), null, "missing file");
  await writeFile(file, "x".repeat(1024)); assert.equal(workingStateNote({ state: file }, 1024), null, "at the limit");
  await writeFile(file, "x".repeat(3000));
  assert.equal(workingStateNote({ state: file }, 1024), `Working state ${file} is 3 KB (limit 1 KB). Before new work, cut it to the current picture and move history out.`);
  assert.equal(workingStateNote({ state: "CURRENT.json" }, 1024), null, "relative paths are ignored");
  const registry = path.join(dir, "working-state.json");
  await writeFile(registry, JSON.stringify({ old: file, room: { state: file } }));
  assert.deepEqual(readRegistry(registry), { old: { state: file }, room: { state: file } }, "a bare string is the state file");
  await writeFile(registry, "{not json"); assert.deepEqual(readRegistry(registry), {});
});

test("only worktrees and branches without a live claimant are reported", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reminders-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"), git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("worktree", "add", "-q", "-b", "live-work", path.join(dir, "live"));
  git("worktree", "add", "-q", "-b", "done-work", path.join(dir, "done"));
  git("branch", "leftover");
  const registryPath = path.join(dir, "working-state.json");
  await writeFile(registryPath, JSON.stringify({
    root: { repos: [repo], worktree: repo }, child: { worktree: path.join(dir, "live") }, finished: { worktree: path.join(dir, "done") } }));
  const notes = await rootReminders({ rootId: "root", registryPath, liveSessionIds: ["root", "child"] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Unassigned in .*repo: 1 worktree, 2 branches \(for example: done, done-work, leftover\)\./,
    "a finished session's worktree and an orphan branch are reported; the live child's branch is claimed through its worktree");
  git("worktree", "remove", path.join(dir, "done")); git("branch", "-D", "done-work", "leftover");
  assert.deepEqual(await rootReminders({ rootId: "root", registryPath, liveSessionIds: ["root", "child"] }), []);
  assert.deepEqual(await rootReminders({ rootId: "unregistered", registryPath, liveSessionIds: [] }), []);
});
