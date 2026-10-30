// Run-start reminders for root sessions. Sessions register in working-state.json, beside
// the harness database: { "<sessionId>": { state, repos, worktree, branch } }.
//   state    the file the session rereads to resume work (budgeted to 20 KB)
//   repos    the Git repositories a root owns
//   worktree the checkout a session works in (a root names its main checkout)
//   branch   that session's branch
// A worktree or branch no live session in the root's family claims is reported unassigned.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const REMINDER_NOTE_TYPE = "persistent-harness-reminder";
export const WORKING_STATE_LIMIT_BYTES = 20 * 1024;
const run = promisify(execFile);

export function readRegistry(registryPath) {
  let value;
  try { value = JSON.parse(readFileSync(registryPath, "utf8")); } catch { return {}; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // A bare string is the state file alone.
  return Object.fromEntries(Object.entries(value).map(([id, entry]) => [id, typeof entry === "string" ? { state: entry } : entry ?? {}]));
}

export function workingStateNote(entry, limit = WORKING_STATE_LIMIT_BYTES) {
  const file = entry?.state;
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  let size;
  try { size = statSync(file).size; } catch { return null; }
  if (size <= limit) return null;
  const kb = bytes => `${Math.ceil(bytes / 1024)} KB`;
  return `Working state ${file} is ${kb(size)} (limit ${kb(limit)}). Before new work, cut it to the current picture and move history out.`;
}

const resolved = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };

async function gitTrees(repo) {
  const opts = { cwd: repo, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 };
  const [{ stdout: trees }, { stdout: refs }] = await Promise.all([
    run("git", ["worktree", "list", "--porcelain"], opts),
    run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], opts)]);
  const worktrees = [];
  for (const block of trees.split("\n\n")) {
    const tree = block.match(/^worktree (.+)$/m)?.[1];
    if (tree) worktrees.push({ path: resolved(tree), branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return { worktrees, branches: refs.split("\n").filter(Boolean) };
}

export async function worktreeNotes({ repos, claims, git = gitTrees }) {
  const claimedTrees = new Set(claims.map(c => c.worktree).filter(p => typeof p === "string").map(resolved));
  const claimedBranches = new Set(claims.map(c => c.branch).filter(b => typeof b === "string"));
  const notes = [];
  for (const repo of repos.filter(r => typeof r === "string" && path.isAbsolute(r))) {
    let state;
    try { state = await git(repo); } catch { continue; }
    for (const tree of state.worktrees) if (claimedTrees.has(tree.path) && tree.branch) claimedBranches.add(tree.branch);
    const trees = state.worktrees.filter(t => !claimedTrees.has(t.path));
    const branches = state.branches.filter(b => !claimedBranches.has(b));
    if (!trees.length && !branches.length) continue;
    const examples = [...trees.map(t => path.basename(t.path)), ...branches].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
    notes.push(`Unassigned in ${repo}: ${trees.length} worktree${trees.length === 1 ? "" : "s"}, ${branches.length} branch${branches.length === 1 ? "" : "es"} (for example: ${examples.join(", ")}). Merge or remove them, or register the live session that owns them.`);
  }
  return notes;
}

// liveSessionIds: the root and its descendants that are starting, resident or passivated.
export async function rootReminders({ rootId, registryPath, liveSessionIds, git }) {
  const registry = readRegistry(registryPath), entry = registry[rootId];
  if (!entry) return [];
  const notes = [workingStateNote(entry)];
  const claims = liveSessionIds.map(id => registry[id]).filter(Boolean);
  notes.push(...await worktreeNotes({ repos: Array.isArray(entry.repos) ? entry.repos : [], claims, git }));
  return notes.filter(Boolean);
}
