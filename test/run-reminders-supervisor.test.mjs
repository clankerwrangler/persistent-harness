import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixtures/notification-supervisor.mjs";

test("run reminders go only to a root session", async t => {
  const f = await fixture(t); const root = await f.actor(); const child = await f.actor(root.session.sessionId);
  const state = path.join(f.dir, "CURRENT.json");
  await writeFile(state, "x".repeat(30 * 1024));
  await writeFile(path.join(f.dir, "state", "working-state.json"), JSON.stringify({
    [root.session.sessionId]: { state }, [child.session.sessionId]: { state } }));
  const rootNotes = (await root.connection.request("run_reminders", {})).notes;
  assert.equal(rootNotes.length, 1); assert.match(rootNotes[0], /is 30 KB \(limit 20 KB\)/);
  assert.deepEqual((await child.connection.request("run_reminders", {})).notes, [], "children never receive reminders");
  await assert.rejects(f.client.request("run_reminders", {}), /not available to clients/);
});

test("another root's live session can claim a worktree in this root's repository", async t => {
  const f = await fixture(t); const repoRoot = await f.actor(); const otherRoot = await f.actor(); const publisher = await f.actor(otherRoot.session.sessionId);
  const repo = path.join(f.dir, "repo"), tree = path.join(f.dir, "feature-work");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "init"); git("worktree", "add", "-q", "-b", "feature", tree);
  const register = async owner => writeFile(path.join(f.dir, "state", "working-state.json"), JSON.stringify({
    [repoRoot.session.sessionId]: { repos: [repo], worktree: repo, branch: "main" }, ...owner }));
  await register({ [publisher.session.sessionId]: { worktree: tree, branch: "feature" } });
  assert.deepEqual((await repoRoot.connection.request("run_reminders", {})).notes, []);
  await register({});
  const notes = (await repoRoot.connection.request("run_reminders", {})).notes;
  assert.equal(notes.length, 1); assert.match(notes[0], /1 worktree, 1 branch \(for example: feature-work, feature\)/);
});
