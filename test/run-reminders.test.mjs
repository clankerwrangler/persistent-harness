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


test("live multi-repository owners claim additional worktrees and retained branches", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reminders-multi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "working-state.json");
  const repo = name => path.join(dir, name);
  const states = {
    [repo("harness")]: { worktrees: [{ path: repo("harness"), branch: "main" }], branches: ["main", "load-proof"] },
    [repo("sdk")]: { worktrees: [{ path: repo("sdk"), branch: "main" }, { path: repo("sdk-work"), branch: "repair" }], branches: ["main", "repair", "port-tests"] },
    [repo("clm")]: { worktrees: [{ path: repo("clm"), branch: "main" }, { path: repo("clm-work"), branch: "repair" }, { path: repo("old-work"), branch: "orphan" }], branches: ["main", "repair", "orphan"] },
  };
  await writeFile(registryPath, JSON.stringify({
    root: { repos: Object.keys(states), worktree: repo("harness"),
      worktrees: [{ worktree: repo("sdk") }, { worktree: repo("clm") }], branches: ["load-proof", "port-tests", null] },
    child: { worktrees: [{ worktree: repo("sdk-work"), branch: "repair" }, { worktree: repo("clm-work"), branch: "repair" }, null] },
    finished: { worktrees: [{ worktree: repo("old-work"), branch: "orphan" }] },
  }));
  const args = { rootId: "root", registryPath, git: async name => states[name] };
  const notes = await rootReminders({ ...args, liveSessionIds: ["root", "child"] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /clm: 1 worktree, 1 branch/);
  assert.match(notes[0], /old-work, orphan/);
  assert.deepEqual(await rootReminders({ ...args, liveSessionIds: ["root", "child", "finished"] }), []);
});
