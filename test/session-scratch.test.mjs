import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HarnessStore } from "../src/store.mjs";
import { controlRequest } from "../src/control.mjs";
import test from "node:test";
import { ensureSessionScratch, reclaimSessionScratch } from "../src/session-scratch.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { deletionFixture, until } from "./fixtures/recursive-delete-fixture.mjs";

const absent = async file => { try { await lstat(file); return false; } catch (e) { if (e.code === "ENOENT") return true; throw e; } };
const scratchOf = (f, session) => path.join(f.supervisor.scratchDirectory, session.sessionId);

async function heldProcess(t, env = {}) {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready')"],
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  await once(child.stdout, "data");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
  const starttime = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  return { child, starttime, finish: async () => { const exited = once(child, "exit"); child.stdin.end(); await exited; } };
}

async function orphanedWriter(t, rootId, file) {
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)")},${JSON.stringify(file)}],
      {detached:true,env:process.env,stdio:'ignore'});child.unref();console.log(child.pid);`;
  const leader = spawn(process.execPath, ["-e", source], { env: { ...process.env, PI_HARNESS_ROOT_SESSION_ID: rootId }, stdio: ["ignore", "pipe", "ignore"] });
  const leaderExited = once(leader, "exit");
  const [data] = await once(leader.stdout, "data"), pid = Number(data.toString().trim());
  await leaderExited;
  const first = await readFile(`/proc/${pid}/stat`, "utf8"), birth = first.slice(first.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  const running = async () => {
    try { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const f = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
      return f[19] === birth && !["Z", "X", "x"].includes(f[0]); } catch { return false; }
  };
  const finish = async () => { if (await running()) process.kill(pid, "SIGTERM"); await until(async () => !await running()); };
  t.after(finish);
  await until(async () => !await absent(file));
  return { finish };
}

async function backgroundJob(f, session, id, held) {
  const directory = path.join(f.supervisor.backgroundJobsDirectory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "meta.json"), JSON.stringify({ schema: "background.job.v1", id, kind: "adopted",
    session_id: session.sessionId, pid: held.child.pid, starttime: held.starttime }));
  return directory;
}

test("canonical root path is shared through grandchildren and survives stop, revival, and child deletion", async t => {
  const f = await deletionFixture(t), tree = await f.tree();
  const rootPath = scratchOf(f, tree.root), otherPath = scratchOf(f, tree.other);
  const initial = await lstat(rootPath);
  await writeFile(path.join(rootPath, "family.txt"), "preserve");
  for (const session of [tree.root, tree.child, tree.grandchild]) {
    const context = ensureSessionScratch(f.supervisor.store, session.sessionId, f.supervisor.scratchDirectory);
    assert.deepEqual(context, { rootSessionId: tree.root.sessionId, directory: rootPath });
    assert.equal(f.actors.get(session.sessionId).env.PI_HARNESS_SCRATCH_DIRECTORY, rootPath);
    assert.equal(f.actors.get(session.sessionId).env.PI_HARNESS_ROOT_SESSION_ID, tree.root.sessionId);
  }
  assert.notEqual(rootPath, otherPath);
  const actorClient = await f.actorClient(tree.root);
  assert.equal(actorClient.connectedSession.sessionId, tree.root.sessionId);
  await f.client.request("stop_session", { sessionId: tree.root.sessionId });
  assert.equal((await lstat(rootPath)).ino, initial.ino);
  await f.client.request("revive_session", { sessionId: tree.root.sessionId });
  await until(() => f.actors.get(tree.root.sessionId)?.isRunning);
  assert.equal((await lstat(rootPath)).ino, initial.ino);
  await f.client.request("delete_session", { sessionId: tree.child.sessionId });
  assert.equal(await readFile(path.join(rootPath, "family.txt"), "utf8"), "preserve");
  assert.equal(f.supervisor.store.getRootScratch(tree.root.sessionId).state, "ready");
});

test("missing owned scratch is recreated for the family and reused on revival", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), child = await f.admit("Child", root);
  const store = f.supervisor.store, rootPath = scratchOf(f, root), base = f.supervisor.scratchDirectory;
  const before = store.getRootScratch(root.sessionId);
  await f.client.request("stop_session", { sessionId: root.sessionId });
  await writeFile(path.join(rootPath, "keep"), "detached original");
  await rename(rootPath, rootPath + "-original");
  const context = ensureSessionScratch(store, child.sessionId, base);
  const stat = await lstat(rootPath), after = store.getRootScratch(root.sessionId);
  assert.deepEqual(context, { rootSessionId: root.sessionId, directory: rootPath });
  assert.equal(stat.mode & 0o777, 0o700);
  assert.notDeepEqual(after.root, before.root);
  assert.deepEqual(after, { ...before, root: { dev: String(stat.dev), ino: String(stat.ino) } });
  assert.equal(await readFile(path.join(rootPath + "-original", "keep"), "utf8"), "detached original");
  assert.deepEqual(ensureSessionScratch(store, root.sessionId, base), context);
  assert.deepEqual(store.getRootScratch(root.sessionId), after);
  await f.client.request("revive_session", { sessionId: root.sessionId });
  await until(() => f.actors.get(root.sessionId)?.isRunning);
  assert.deepEqual(store.getRootScratch(root.sessionId), after);
  assert.equal(f.actors.get(root.sessionId).env.PI_HARNESS_SCRATCH_DIRECTORY, rootPath);
});

test("missing scratch recovery rejects unavailable sessions and invalid ownership", async t => {
  for (const mode of ["deleting", "removed", "fenced", "deleted", "missing-witness", "invalid-inode", "foreign-device"]) await t.test(mode, async t => {
    const f = await deletionFixture(t), root = await f.admit("Root"), store = f.supervisor.store;
    const rootPath = scratchOf(f, root), before = store.getRootScratch(root.sessionId);
    await rm(rootPath, { recursive: true });
    if (["deleting", "removed"].includes(mode)) store.setRootScratch(root.sessionId, { ...before, state: mode });
    else if (mode === "fenced") {
      const sessions = store.beginSessionDeletion(root.sessionId);
      t.after(() => store.endSessionDeletion(sessions));
    } else if (mode === "deleted") store.deleteSession(root.sessionId);
    else {
      const witness = mode === "missing-witness" ? undefined
        : { ...before.root, ...(mode === "invalid-inode" ? { ino: "0" } : { dev: "-1" }) };
      store.setRootScratch(root.sessionId, { ...before, root: witness });
    }
    const record = store.getRootScratch(root.sessionId);
    assert.throws(() => ensureSessionScratch(store, root.sessionId, f.supervisor.scratchDirectory));
    assert.equal(await absent(rootPath), true);
    assert.deepEqual(store.getRootScratch(root.sessionId), record);
  });
});

test("missing scratch recovery fails closed on creation and validation races", async t => {
  for (const mode of ["mkdir-directory", "mkdir-symlink", "opened-directory", "opened-symlink", "base", "session", "record"]) await t.test(mode, async t => {
    const f = await deletionFixture(t), root = await f.admit("Root"), store = f.supervisor.store;
    const base = f.supervisor.scratchDirectory, rootPath = scratchOf(f, root);
    const before = store.getRootScratch(root.sessionId);
    await rm(rootPath, { recursive: true });
    const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
    let raced = false, opens = 0;
    const replaceLeaf = symlink => {
      if (fs.existsSync(rootPath)) fs.renameSync(rootPath, rootPath + "-created");
      if (symlink) fs.symlinkSync(f.dir, rootPath); else fs.mkdirSync(rootPath);
    };
    fs.openSync = (...args) => {
      if (String(args[0]).endsWith("/" + root.sessionId)) {
        opens++;
        if (opens === 1 && mode.startsWith("mkdir-")) {
          try { return original.openSync(...args); }
          catch (error) {
            assert.equal(error.code, "ENOENT");
            replaceLeaf(mode.endsWith("symlink")); raced = true; throw error;
          }
        }
        if (opens === 2 && mode.startsWith("opened-")) {
          replaceLeaf(mode.endsWith("symlink")); raced = true;
        }
      }
      return original.openSync(...args);
    };
    fs.fsyncSync = (...args) => {
      if (!raced && fs.existsSync(rootPath)) {
        if (mode === "base") { fs.renameSync(base, base + "-moved"); fs.mkdirSync(base); raced = true; }
        if (mode === "session") { store.deleteSession(root.sessionId); raced = true; }
        if (mode === "record") { store.setRootScratch(root.sessionId, { ...before, state: "deleting" }); raced = true; }
      }
      return original.fsyncSync(...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => ensureSessionScratch(store, root.sessionId, base));
    } finally {
      Object.assign(fs, original); syncBuiltinESMExports();
    }
    assert.equal(raced, true, "the actual filesystem boundary was reached");
    const expected = ["session", "record"].includes(mode) ? { ...before, state: "deleting" } : before;
    assert.deepEqual(store.getRootScratch(root.sessionId), expected, "failed recovery never replaces ownership");
  });
});

test("root tombstone waits for actor retirement; cleanup preserves other roots and link targets", async t => {
  const f = await deletionFixture(t), tree = await f.tree();
  const rootPath = scratchOf(f, tree.root), otherPath = scratchOf(f, tree.other);
  const outside = path.join(f.dir, "outside"); await mkdir(outside);
  await writeFile(path.join(outside, "keep"), "outside");
  await mkdir(path.join(rootPath, "nested")); await writeFile(path.join(rootPath, "nested", "temp"), "owned");
  await symlink(outside, path.join(rootPath, "link"));
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  f.closeGate = async actor => { if (actor.session.sessionId === tree.grandchild.sessionId) { entered = true; await gate; } };
  const deleting = f.client.request("delete_session", { sessionId: tree.root.sessionId });
  await until(() => entered);
  assert.equal(f.supervisor.store.getSession(tree.root.sessionId).lifecycle, "resident");
  assert.equal(await absent(path.join(rootPath, "nested", "temp")), false);
  release(); const result = await deleting;
  assert.equal(result.session.lifecycle, "deleted");
  await until(() => absent(rootPath));
  assert.equal(f.supervisor.store.getRootScratch(tree.root.sessionId).state, "removed");
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "outside");
  assert.equal(await absent(otherPath), false);
});

test("detached work owned by a deleted grandchild defers only root reclamation, and monitor retries after exit", async t => {
  const f = await deletionFixture(t), tree = await f.tree();
  const rootPath = scratchOf(f, tree.root);
  const held = await heldProcess(t);
  await backgroundJob(f, tree.grandchild, "bg-000000000001", held);
  await f.client.request("delete_session", { sessionId: tree.child.sessionId });
  const result = await f.client.request("delete_session", { sessionId: tree.root.sessionId });
  assert.equal(result.session.lifecycle, "deleted");
  assert.equal(f.supervisor.store.getRootScratch(tree.root.sessionId).state, "deleting");
  assert.equal(await absent(rootPath), false);
  assert.equal(held.child.exitCode, null, "root deletion must not kill detached work");
  await held.finish(); await until(() => absent(rootPath));
  await assert.rejects(f.client.request("revive_session", { sessionId: tree.root.sessionId }));
});

test("restart resumes pending scratch cleanup without actor resurrection or input replay", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root");
  const rootPath = scratchOf(f, root), held = await heldProcess(t);
  await backgroundJob(f, root, "bg-000000000002", held);
  await f.client.request("delete_session", { sessionId: root.sessionId });
  await f.supervisor.stop();
  assert.equal(await absent(rootPath), false);
  await held.finish();
  const old = f.supervisor;
  f.supervisor = new HarnessSupervisor({ socketPath: old.socketPath, databasePath: old.databasePath, pidPath: old.pidPath,
    skillsPath: old.skillsPath, backgroundJobsDirectory: old.backgroundJobsDirectory,
    actorFactory: () => { throw new Error("deleted actor must never start"); }, actorInactivityMs: 0 });
  await f.supervisor.start(); await until(() => absent(rootPath));
  assert.equal(f.supervisor.store.getSession(root.sessionId).lifecycle, "deleted");
  assert.equal(f.supervisor.store.getRootScratch(root.sessionId).state, "removed");
});

test("unowned paths, traversal IDs, symlink boundaries, and substituted roots fail closed", async t => {
  const f = await deletionFixture(t), store = f.supervisor.store, base = f.supervisor.scratchDirectory;
  const root = await f.admit("Unowned", null, { start: false });
  await mkdir(path.join(base, root.sessionId), { recursive: true });
  await writeFile(path.join(base, root.sessionId, "keep"), "legacy");
  assert.throws(() => ensureSessionScratch(store, root.sessionId, base), /EEXIST/);
  assert.equal(store.getRootScratch(root.sessionId), null);
  await f.client.request("delete_session", { sessionId: root.sessionId });
  assert.equal(await readFile(path.join(base, root.sessionId, "keep"), "utf8"), "legacy");
  const unsafe = store.createRoot({ sessionId: "../escape", name: "Unsafe", cwd: f.dir, actorToken: "token", launch: {} }).session;
  assert.throws(() => ensureSessionScratch(store, unsafe.sessionId, base), /refusing/);
  const owned = await f.admit("Owned"), rootPath = scratchOf(f, owned), moved = rootPath + "-moved";
  await rename(rootPath, moved); await mkdir(rootPath);
  await writeFile(path.join(rootPath, "keep"), "replacement");
  assert.throws(() => ensureSessionScratch(store, owned.sessionId, base), /refusing/);
  await f.client.request("delete_session", { sessionId: owned.sessionId });
  assert.equal(store.getSession(owned.sessionId).lifecycle, "deleted");
  assert.equal(store.getRootScratch(owned.sessionId).state, "deleting");
  assert.equal(await readFile(path.join(rootPath, "keep"), "utf8"), "replacement");
  await rm(rootPath, { recursive: true }); await symlink(moved, rootPath);
  assert.throws(() => reclaimSessionScratch(store, owned.sessionId, base));
  await rm(rootPath); await rename(moved, rootPath);
  await f.client.request("delete_session", { sessionId: owned.sessionId });
  await until(() => absent(rootPath));
  const next = await f.admit("Namespace", null, { start: false });
  const shifted = base + "-shifted";
  await rename(base, shifted); await symlink(shifted, base);
  assert.throws(() => ensureSessionScratch(store, next.sessionId, base));
});


test("leader exit and a surviving marked tool defer reclamation across restart", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root");
  const rootPath = scratchOf(f, root);
  const file = path.join(rootPath, "draining-tool.txt");
  const held = await orphanedWriter(t, root.sessionId, file);
  await f.client.request("delete_session", { sessionId: root.sessionId });
  assert.equal(f.supervisor.store.getSession(root.sessionId).lifecycle, "deleted");
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await absent(rootPath), false);
  await f.supervisor.stop();
  const old = f.supervisor;
  f.supervisor = new HarnessSupervisor({ socketPath: old.socketPath, databasePath: old.databasePath, pidPath: old.pidPath,
    skillsPath: old.skillsPath, actorFactory: () => { throw new Error("no actor revival"); }, actorInactivityMs: 0 });
  await f.supervisor.start();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await absent(rootPath), false);
  await held.finish(); await until(() => absent(rootPath));
});


test("retirement proof reaches beyond presentation cache and does not reaudit unrelated history on ticks", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), held = await heldProcess(t);
  for (let n = 0; n < 132; n++) {
    const id = `bg-${n.toString(16).padStart(12, "0")}`, directory = path.join(f.supervisor.backgroundJobsDirectory, id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "meta.json"), JSON.stringify({ schema: "background.job.v1", id, kind: "adopted", session_id: "unrelated-root", pid: 1, starttime: "0" }));
  }
  await backgroundJob(f, root, "bg-ffffffffffff", held);
  await f.client.request("delete_session", { sessionId: root.sessionId });
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal(await absent(scratchOf(f, root)), false);
  await writeFile(path.join(f.supervisor.backgroundJobsDirectory, "bg-000000000000", "meta.json"), "unrelated malformed history");
  await held.finish();
  await until(() => absent(scratchOf(f, root)));
});

// Several 100 ms background scans (recursive-delete-fixture), enough to observe that nothing changed.
const SCAN_SETTLE_MS = 400;

test("unknown and partial background identities repair without losing owner or freezing incomplete facts", async t => {
  for (const mode of ["unknown", "missing-birth", "invalid-kind", "invalid-pid"]) await t.test(mode, async t => {
    const f = await deletionFixture(t), root = await f.admit("Root"), held = await heldProcess(t);
    const id = "bg-000000000003", directory = path.join(f.supervisor.backgroundJobsDirectory, id);
    await mkdir(directory, { recursive: true });
    const valid = { schema: "background.job.v1", id, kind: "adopted", session_id: root.sessionId,
      pid: held.child.pid, starttime: held.starttime };
    const writeMeta = meta => writeFile(path.join(directory, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
    const incomplete = mode === "unknown" ? "partial publication"
      : { ...valid, pid: mode === "invalid-pid" ? 2 ** 31 : 2 ** 30, starttime: mode === "missing-birth" ? null : "1", kind: mode === "invalid-kind" ? "incomplete" : "adopted" };
    await writeMeta(incomplete);
    const result = await f.client.request("delete_session", { sessionId: root.sessionId });
    assert.equal(result.scratchCleanup, "deleting");
    await new Promise(resolve => setTimeout(resolve, SCAN_SETTLE_MS));
    assert.equal(await absent(scratchOf(f, root)), false);
    if (mode !== "unknown") {
      await writeMeta({ ...valid, session_id: "unrelated-owner" });
      await new Promise(resolve => setTimeout(resolve, SCAN_SETTLE_MS));
      assert.equal(await absent(scratchOf(f, root)), false, "a known association cannot be erased by metadata retargeting");
    }
    await writeMeta(valid);
    await new Promise(resolve => setTimeout(resolve, SCAN_SETTLE_MS));
    assert.equal(await absent(scratchOf(f, root)), false, "repair must observe the active replacement PID/birth, not freeze the earlier partial PID");
    await writeMeta({ ...valid, pid: 2 ** 30, starttime: "1" });
    await new Promise(resolve => setTimeout(resolve, SCAN_SETTLE_MS));
    assert.equal(await absent(scratchOf(f, root)), false, "a complete established process identity remains pinned");
    assert.equal(held.child.exitCode, null);
    await held.finish(); await until(() => absent(scratchOf(f, root)));
    assert.equal(f.supervisor.store.getSession(root.sessionId).lifecycle, "deleted");
  });
});


test("invalid scratch metadata never blocks root tombstoning and missing-tree receipt recovery is idempotent", async t => {
  const f = await deletionFixture(t), root = await f.admit("Root"), store = f.supervisor.store;
  const record = store.getRootScratch(root.sessionId), rootPath = scratchOf(f, root);
  store.setRootScratch(root.sessionId, { ...record, version: 0 });
  const result = await f.client.request("delete_session", { sessionId: root.sessionId });
  assert.equal(result.session.lifecycle, "deleted");
  assert.equal(result.scratchCleanup, "unknown");
  assert.equal(await absent(rootPath), false);
  store.setRootScratch(root.sessionId, { ...record, state: "deleting" });
  await rm(rootPath, { recursive: true }); // Synthetic crash after final unlink, before receipt.
  await until(() => store.getRootScratch(root.sessionId).state === "removed");
  await f.client.request("delete_session", { sessionId: root.sessionId });
  assert.equal(store.getRootScratch(root.sessionId).state, "removed");
});


test("inherited service marker does not hold cleanup, but a matching external writer still does", { timeout: 15_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scratch-service-marker-"));
  const databasePath = path.join(dir, "harness.sqlite"), base = path.join(dir, "scratch"), rootId = "inherited-service-root";
  const socketPath = path.join(dir, "supervisor.sock"), pidPath = path.join(dir, "supervisor.pid");
  await mkdir(path.join(dir, "home")); await mkdir(path.join(dir, "agent"));
  const store = new HarnessStore(databasePath);
  store.createRoot({ sessionId: rootId, cwd: dir, name: "Disposable service marker", actorToken: "fixture-only", launch: {} });
  const scratch = ensureSessionScratch(store, rootId, base);
  store.deleteSession(rootId); store.close();
  const writer = await heldProcess(t, { PI_HARNESS_ROOT_SESSION_ID: rootId });
  const env = { ...process.env, HOME: path.join(dir, "home"), PI_CODING_AGENT_DIR: path.join(dir, "agent"),
    PI_HARNESS_ROOT_SESSION_ID: rootId, PI_HARNESS_SCRATCH_ROOT: base, PI_HARNESS_ACTOR_EXTENSIONS: "[]",
    PI_HARNESS_SKILLS_PATH: path.resolve(import.meta.dirname, "../skills"), PI_HARNESS_BACKGROUND_COMPLETION_TICK_MS: "100" };
  for (const key of ["PI_HARNESS_ACTOR_ID", "PI_HARNESS_ACTOR_TOKEN", "PI_HARNESS_ACTOR_GENERATION", "PI_HARNESS_ACTOR_SKILL_GRANT", "PI_HARNESS_SCRATCH_DIRECTORY"]) delete env[key];
  const daemon = spawn(process.execPath, [path.resolve(import.meta.dirname, "../bin/harness-supervisor.mjs"), "start", "--socket", socketPath,
    "--db", databasePath, "--pid", pidPath], { env, stdio: "ignore" });
  const exited = once(daemon, "exit");
  t.after(async () => {
    await controlRequest(socketPath, "shutdown_daemon", {}, { timeoutMs: 1000 }).catch(() => daemon.kill("SIGKILL"));
    await exited; await rm(dir, { recursive: true, force: true });
  });
  await until(async () => { try { return (await controlRequest(socketPath, "get_liveness", {}, { timeoutMs: 500 })).alive; } catch { return false; } });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await absent(scratch.directory), false, "the marked external writer still owns work");
  await writer.finish(); await until(() => absent(scratch.directory));
  assert.equal((await controlRequest(socketPath, "get_liveness")).alive, true, "the inherited-marked service remains alive after cleanup");
});
