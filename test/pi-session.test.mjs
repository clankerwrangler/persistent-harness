import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadExternalPiSdk } from "../src/external-pi.mjs";
import { createPiSession, initializePiSession } from "../src/pi-session.mjs";

async function SessionManager() {
  const selected = process.env.PI_HARNESS_PI_MODULE ?? process.env.PI_HARNESS_PI_COMMAND;
  assert(selected && path.isAbsolute(selected), "Set the explicit matched PI_HARNESS_PI_MODULE or PI_HARNESS_PI_COMMAND SDK seam for session tests");
  return (await loadExternalPiSdk()).SessionManager;
}

test("creates root and child transcripts in Pi's normal store and discovery ignores colocated sidecars", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-pi-normal-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  await mkdir(project, { recursive: true });

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const created = [
    await createPiSession({ cwd: project, name: "root-a" }),
    await createPiSession({ cwd: project, name: "child-c" }),
  ];

  for (const session of created) {
    assert.equal(path.dirname(session.sessionFile), session.sessionDir);
    assert.equal(session.sessionDir.startsWith(path.join(agentDir, "sessions") + path.sep), true);
    assert.equal(path.basename(session.sessionFile).endsWith(`_${session.sessionId}.jsonl`), true);

    const header = JSON.parse((await readFile(session.sessionFile, "utf8")).split("\n", 1)[0]);
    assert.equal(header.id, session.sessionId);
    assert.equal(header.cwd, project);

    const sidecars = session.sidecars;
    assert.equal(sidecars.sessionFile, session.sessionFile);
    for (const filePath of [sidecars.skillManifestPath, sidecars.capabilitiesPath, sidecars.skillGrantPath]) {
      assert.equal(path.dirname(filePath), session.sessionDir);
      await writeFile(filePath, "{}\n");
    }
    assert.equal(path.dirname(sidecars.kernelStatePath), session.sessionDir);
    await mkdir(sidecars.kernelStatePath);
    await writeFile(path.join(sidecars.kernelStatePath, "manifest.json"), "{}\n");
  }

  const Manager = await SessionManager();
  assert.equal(Manager.open(created[0].sessionFile).getSessionName(), "root-a");
  assert.equal(Manager.open(created[1].sessionFile).getSessionName(), "child-c");
  const expectedIds = created.map((session) => session.sessionId).sort();
  const projectSessions = await Manager.list(project);
  assert.deepEqual(projectSessions.map((session) => session.id).sort(), expectedIds);
  const globalSessions = await Manager.listAll();
  assert.deepEqual(globalSessions.map((session) => session.id).sort(), expectedIds);

  const entries = await readdir(created[0].sessionDir);
  assert.deepEqual(entries.filter((name) => name.endsWith(".jsonl")).sort(), created.map((session) => path.basename(session.sessionFile)).sort());
  assert.equal(entries.includes("pi-sessions"), false);
});

test("public Pi session initialization creates an immediate durable canonical identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-pi-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, "child.jsonl");
  await (await import("node:fs/promises")).mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, "");
  const initialized = await initializePiSession({ sessionFile, sessionDir, cwd: root });
  const header = JSON.parse((await readFile(sessionFile, "utf8")).trim());
  assert.equal(header.id, initialized.sessionId);
  assert.equal(header.cwd, root);
  assert.equal(initialized.sessionFile, sessionFile);
});

test("Pi identity survives reopen, move, and compaction while fork creates a new identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-pi-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const Manager = await SessionManager();
  const source = path.join(root, "source.jsonl");
  await writeFile(source, "");
  let manager = Manager.open(source, root, root);
  const sessionId = manager.getSessionId();
  manager.appendCustomEntry("proof", { value: true });
  manager.appendCompaction("proof summary", manager.getLeafId(), 1);
  manager = Manager.open(source, root);
  assert.equal(manager.getSessionId(), sessionId);
  const moved = path.join(root, "moved.jsonl");
  await rename(source, moved);
  manager = Manager.open(moved, root);
  assert.equal(manager.getSessionId(), sessionId);
  const fork = Manager.forkFrom(moved, root, root);
  assert.notEqual(fork.getSessionId(), sessionId);
  assert.equal(Manager.open(fork.getSessionFile(), root).getSessionId(), fork.getSessionId());
});


async function helperFixture(t, valid = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-session-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = path.join(root, "node_modules");
  const agent = path.join(modules, "@earendil-works/pi-coding-agent");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core"]) {
    const directory = path.join(modules, "@earendil-works", name);
    await mkdir(path.join(directory, "dist"), { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version: "0.99.1", type: "module",
      dependencies: name === "pi-coding-agent" ? { "@earendil-works/pi-ai": "0.99.1", "@earendil-works/pi-agent-core": "0.99.1" }
        : name === "pi-agent-core" ? { "@earendil-works/pi-ai": "0.99.1" } : {},
      exports: name === "pi-coding-agent" ? { ".": "./dist/index.js", "./programmatic": "./dist/programmatic.js" } : {},
    }));
  }
  await writeFile(path.join(agent, "dist/index.js"), 'throw new Error("root must stay unused");\n');
  await writeFile(path.join(agent, "dist/programmatic.js"), valid
    ? 'export class SessionManager {}\nexport const ModelRuntime = {create: options => options};\nexport const buildSessionContext = entries => entries;\n'
    : 'export {};\n');
  const previous = Object.fromEntries(["PI_HARNESS_PI_MODULE", "PI_HARNESS_PI_COMMAND", "PATH"].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.PI_HARNESS_PI_MODULE = agent;
  delete process.env.PI_HARNESS_PI_COMMAND;
  return { root, agent };
}

test("session helper shares first use and retains the chosen SDK after configuration changes", async t => {
  await helperFixture(t);
  const helper = await import(`../src/pi-session.mjs?first-use=${Date.now()}`);
  const entries = [{ id: "same-reference" }], options = { marker: "runtime" };
  const [context, runtime] = await Promise.all([helper.buildPiSessionContext(entries), helper.createPiModelRuntime(options)]);
  assert.equal(context, entries); assert.equal(runtime, options);
  process.env.PI_HARNESS_PI_MODULE = "/missing/changed/entry.js";
  assert.equal(await helper.buildPiSessionContext(entries), entries);
});

test("session helper retains one rejection across concurrent and later calls", async t => {
  await helperFixture(t, false);
  const helper = await import(`../src/pi-session.mjs?rejection=${Date.now()}`);
  const results = await Promise.allSettled([helper.buildPiSessionContext([]), helper.createPiModelRuntime()]);
  assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "rejected");
  assert.equal(results[0].reason, results[1].reason);
  assert.match(results[0].reason.message, /SessionManager public API/);
  process.env.PI_HARNESS_PI_MODULE = "/another/entry.js";
  await assert.rejects(helper.createPiModelRuntime(), error => error === results[0].reason);
});

test("PATH pi default belongs only to the session helper when both explicit seams are absent", async t => {
  const { root, agent } = await helperFixture(t);
  const bin = path.join(root, "bin"); await mkdir(bin);
  const { symlink } = await import("node:fs/promises");
  const command = path.join(agent, "dist/cli.js"); await writeFile(command, "// fixture\n", { mode: 0o700 });
  await symlink(command, path.join(bin, "pi"));
  delete process.env.PI_HARNESS_PI_MODULE; delete process.env.PI_HARNESS_PI_COMMAND;
  process.env.PATH = bin;
  const helper = await import(`../src/pi-session.mjs?path-default=${Date.now()}`);
  const entries = []; assert.equal(await helper.buildPiSessionContext(entries), entries);
  await assert.rejects(loadExternalPiSdk({ env: {} }), /explicitly/);
});
