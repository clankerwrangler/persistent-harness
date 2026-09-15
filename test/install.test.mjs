import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { controlRequest } from "../src/control.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { PROTOCOL_VERSION } from "../src/protocol.mjs";

const packageRoot = path.resolve(import.meta.dirname, ".."), installBin = path.join(packageRoot, "bin", "install.mjs");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function runNode(bin, args, agentDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const javascript = path.extname(bin) === ".mjs";
    const child = spawn(javascript ? process.execPath : bin, javascript ? [bin, ...args] : args, {
      env: { PATH: process.env.PATH, HOME: path.dirname(agentDir), PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_HARNESS_AUTO_INSTALL: "0", UV_OFFLINE: "1",
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("install fixture command timed out")); }, 15_000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Object.assign(new Error(stderr), { exitCode: code, stdout })); });
  });
}
const run = (command, agentDir) => runNode(installBin, [command], agentDir);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, agentDir: path.join(root, "agent") };
}

test("installs and uninstalls standalone harness entrypoints without companion setup", async t => {
  const { agentDir } = await fixture(t);
  await run("install", agentDir);
  const entrypoint = path.join(agentDir, "extensions", "persistent-harness", "index.ts");
  assert.equal(await readFile(entrypoint, "utf8"), `export { default } from ${JSON.stringify(path.join(packageRoot, "index.ts"))};\n`);
  await assert.rejects(lstat(path.join(agentDir, "extensions", "pi-codex-compaction")), { code: "ENOENT" });
  const launchers = ["persistent-pi", "harness-supervisor", "harness-restart", "harness-provision-skills"];
  for (const name of launchers) assert.match(await readFile(path.join(agentDir, "bin", name), "utf8"), /launch-env\.sh/);
  assert.match(await readFile(path.join(agentDir, "bin", "persistent-pi"), "utf8"), /persistent-pi\.mjs/);
  assert.match(await readFile(path.join(agentDir, "bin", "harness-restart"), "utf8"), /harness-restart\.mjs/);
  assert.match(await readFile(path.join(agentDir, "bin", "harness-provision-skills"), "utf8"), /provision-skills\.mjs/);
  await assert.rejects(lstat(path.join(agentDir, "bin", "persistent-webui")), { code: "ENOENT" });
  const state = path.join(agentDir, "harness", "retain-state"); await mkdir(path.dirname(state), { recursive: true }); await writeFile(state, "durable");
  await run("uninstall", agentDir);
  for (const file of [entrypoint, ...launchers.map(name => path.join(agentDir, "bin", name))]) await assert.rejects(lstat(file), { code: "ENOENT" });
  assert.equal(await readFile(state, "utf8"), "durable");
});

for (const linked of [false, true]) test(`install and uninstall preserve a preinstalled local companion (${linked ? "symlink" : "regular file"})`, async t => {
  const { root, agentDir } = await fixture(t);
  const source = path.join(root, "external.ts"), directory = path.join(agentDir, "extensions", "pi-codex-compaction");
  const companion = path.join(directory, "index.ts"), settings = path.join(directory, "local-settings.json");
  const implementation = "throw new Error('local extension must not be evaluated by install or uninstall');\n";
  await writeFile(source, implementation, { mode: 0o600 }); await mkdir(directory, { recursive: true, mode: 0o750 });
  if (linked) await symlink(source, companion);
  else await writeFile(companion, `export { default } from ${JSON.stringify(source)};\n`, { mode: 0o640 });
  await writeFile(settings, '{"preserve":true}\n', { mode: 0o600 });
  const identities = async () => Promise.all([directory, companion, settings, source].map(async file => {
    const { dev, ino, mode, mtimeMs, size } = await lstat(file); return { dev, ino, mode, mtimeMs, size };
  }));
  const original = await identities(), companionBytes = await readFile(companion);
  for (const command of ["install", "uninstall"]) {
    await run(command, agentDir);
    assert.deepEqual(await identities(), original, `${command} must not change local or external extension identities or metadata`);
    assert.deepEqual(await readFile(companion), companionBytes);
    assert.equal(await readFile(source, "utf8"), implementation);
    assert.equal(await readFile(settings, "utf8"), '{"preserve":true}\n');
    if (linked) assert.equal(await readlink(companion), source);
  }
});

test("launchers source and preserve launch-env.sh with literal shell-special paths", async t => {
  const { root } = await fixture(t), agentDir = path.join(root, "agent $UNSET 'literal'");
  const environment = path.join(agentDir, "harness", "launch-env.sh"), marker = path.join(root, "sourced");
  const contents = `printf '%s\\n' sourced > ${shellQuote(marker)}\nexport HARNESS_INSTALL_FIXTURE=1\n`;
  await mkdir(path.dirname(environment), { recursive: true }); await writeFile(environment, contents);
  await run("install", agentDir);
  const launcher = path.join(agentDir, "bin", "harness-supervisor");
  await assert.rejects(runNode(launcher, ["invalid-command"], agentDir), /usage: harness-supervisor/);
  assert.equal(await readFile(marker, "utf8"), "sourced\n"); assert.equal(await readFile(environment, "utf8"), contents);
  const foreign = path.join(agentDir, "bin", "harness-provision-skills"); await writeFile(foreign, "foreign launcher\n");
  await run("uninstall", agentDir);
  assert.equal(await readFile(foreign, "utf8"), "foreign launcher\n"); assert.equal(await readFile(environment, "utf8"), contents);
});

test("package smoke loads the standalone harness without creating agent state", async t => {
  const { agentDir } = await fixture(t), smoke = path.join(packageRoot, "bin", "package-load-smoke.mjs");
  assert.match(await runNode(smoke, [], agentDir), /Persistent Harness core modules load/);
  await assert.rejects(lstat(agentDir), { code: "ENOENT" });
});

test("supervisor ensure, status, and shutdown need no companion setup", { timeout: 30_000 }, async t => {
  const { root, agentDir } = await fixture(t), supervisor = path.join(packageRoot, "bin", "harness-supervisor.mjs");
  const skills = path.join(root, "skills"); await mkdir(skills);
  const command = name => runNode(supervisor, [name], agentDir, { PI_HARNESS_SKILLS_PATH: skills });
  try {
    const first = JSON.parse(await command("ensure")); assert.equal(first.alreadyRunning, false); assert(Number.isInteger(first.pid));
    const status = JSON.parse(await command("status")); assert.equal(status.running, true); assert.equal(status.pid, first.pid);
    assert.equal(JSON.parse(await command("ensure")).alreadyRunning, true);
  } finally {
    await command("shutdown");
  }
});


test("ensure liveness does not run diagnostics or relax heartbeat registration", { timeout: 15_000 }, async t => {
  const { root, agentDir } = await fixture(t);
  const directory = path.join(agentDir, "harness");
  const socketPath = path.join(directory, "supervisor.sock"), pidPath = path.join(directory, "supervisor.pid");
  const supervisor = new HarnessSupervisor({ socketPath, pidPath, databasePath: path.join(directory, "harness.sqlite"),
    backgroundJobsDirectory: path.join(root, "background"), skillsPath: path.join(root, "skills"),
    logger: { error() {} } });
  await supervisor.start();
  const pidRecord = await readFile(pidPath, "utf8");
  let audits = 0;
  try {
    for (const slow of [false, true]) {
      supervisor.store.diagnose = () => {
        audits += 1;
        if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
        throw new Error("deliberate diagnostic failure");
      };
      assert.deepEqual(JSON.parse(await runNode(path.join(packageRoot, "bin", "harness-supervisor.mjs"),
        ["ensure"], agentDir)), { alreadyRunning: true });
      assert.equal(audits, 0, "liveness must not enter the diagnostic workflow");
    }
    assert.equal(await readFile(pidPath, "utf8"), pidRecord, "ensure must not replace the running daemon");
    assert.deepEqual(await controlRequest(socketPath, "get_liveness"), { alive: true });
    await assert.rejects(controlRequest(socketPath, "heartbeat"), /connection is not registered/);
    await assert.rejects(controlRequest(socketPath, "get_status"), /deliberate diagnostic failure/);
    assert.equal(audits, 1, "explicit status must still run diagnostics");
  } finally { await supervisor.stop(); }
});

test("ensure accepts only current or explicit same-version legacy liveness evidence", { timeout: 20_000 }, async t => {
  const legacy = { version: PROTOCOL_VERSION, type: "protocol_error", code: "unknown_request",
    message: "unknown request type: get_liveness" };
  const cases = [
    ["legacy", () => legacy, true],
    ["wrong-version", () => ({ ...legacy, version: PROTOCOL_VERSION - 1 }), false],
    ["other-rejection", () => ({ ...legacy, message: "unknown request type: other" }), false],
    ["remote-enoent", () => ({ ...legacy, code: "ENOENT", message: "remote file missing" }), false],
    ["remote-refused", () => ({ ...legacy, code: "ECONNREFUSED", message: "remote refusal" }), false],
    ["invalid-json", () => "not JSON", false],
    ["wrong-request", request => ({ version: PROTOCOL_VERSION, type: "response", id: request.id,
      requestType: "get_status", ok: true, data: { alive: true } }), false],
    ["invalid-data", request => ({ version: PROTOCOL_VERSION, type: "response", id: request.id,
      requestType: request.type, ok: true, data: { alive: false } }), false],
    ["timeout", () => null, false],
  ];
  for (const [name, reply, live] of cases) await t.test(name, async t => {
    const { agentDir } = await fixture(t), directory = path.join(agentDir, "harness");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const socketPath = path.join(directory, "supervisor.sock"), requests = [], sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
      let buffered = "";
      socket.on("data", chunk => {
        buffered += chunk;
        if (!buffered.includes("\n")) return;
        const request = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))); requests.push(request.type);
        const value = reply(request);
        if (value !== null) socket.end(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      const ensure = runNode(path.join(packageRoot, "bin", "harness-supervisor.mjs"), ["ensure"], agentDir);
      if (live) assert.deepEqual(JSON.parse(await ensure), { alreadyRunning: true });
      else await assert.rejects(ensure);
      assert.deepEqual(requests, ["get_liveness"], "no status fallback or second daemon attempt");
      for (const file of ["supervisor.start.lock", "supervisor.pid", "harness.sqlite"]) {
        await assert.rejects(lstat(path.join(directory, file)), { code: "ENOENT" });
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
