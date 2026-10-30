import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { controlRequest } from "../src/control.mjs";
import { PROTOCOL_VERSION } from "../src/protocol.mjs";

const packageRoot = path.resolve(import.meta.dirname, ".."), bin = path.join(packageRoot, "bin/harness-supervisor.mjs");
function procIdentity(content) {
  const fields = content.slice(content.lastIndexOf(")") + 2).trim().split(/\s+/);
  assert(fields.length >= 20, "complete process identity required");
  return { state: fields[0], startTime: fields[19] };
}
async function ownedAlive(identity) {
  try {
    const current = procIdentity(await readFile(`/proc/${identity.pid}/stat`, "utf8"));
    return current.startTime === identity.startTime && !["Z", "X", "x"].includes(current.state);
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; throw error; }
}
async function signalOwned(identity, signal) {
  if (await ownedAlive(identity)) {
    try { process.kill(identity.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
async function waitForExit(identity, onWaiting) {
  const deadline = Date.now() + 3000;
  while (await ownedAlive(identity)) {
    onWaiting();
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}
async function fixture(t, { holdExit = false, onExitWait = () => {}, beforeRemove = async () => {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-module-loading-"));
  const agent = path.join(root, "agent"), trace = path.join(root, "evaluations.jsonl"), observer = path.join(root, "observe.mjs");
  const harness = path.join(agent, "harness"), socketPath = path.join(harness, "supervisor.sock"), skills = path.join(root, "skills");
  await mkdir(harness, { recursive: true, mode: 0o700 }); await mkdir(skills);
  // Observe evaluation, not only resolution/loading: each genuine source gets a
  // first-statement witness after its original ESM dependencies have evaluated.
  await writeFile(observer, `import { registerHooks, syncBuiltinESMExports } from "node:module";
import cp from "node:child_process";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
const originalSpawn = cp.spawn;
cp.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (process.argv[2] === "ensure" && args[1]?.[1] === "start") {
    const fields = readFileSync("/proc/"+child.pid+"/stat", "utf8").split(") ").at(-1).trim().split(/\\s+/);
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({kind:"owned-start",pid:child.pid,startTime:fields[19]})+"\\n");
  }
  return child;
};
syncBuiltinESMExports();
if (${holdExit} && process.argv[2] === "start") process.once("beforeExit", () => {
  const hold = setInterval(() => {}, 2 ** 30);
  process.once("SIGUSR2", () => {
    mkdirSync(${JSON.stringify(harness)}, {recursive:true});
    writeFileSync(${JSON.stringify(path.join(harness, "late-writer"))}, "drained");
    clearInterval(hold);
  });
  writeFileSync(${JSON.stringify(path.join(root, "held-exit"))}, "ready");
});
globalThis.__harnessCliEvaluation = url => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,command:process.argv[2]??"import",url})+"\\n");
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(result.format==="module"&&url.startsWith(${JSON.stringify(pathToFileURL(path.join(packageRoot, "src") + path.sep).href)})){const source=typeof result.source==="string"?result.source:Buffer.from(result.source).toString("utf8");return {...result,source:"globalThis.__harnessCliEvaluation("+JSON.stringify(url)+");\\n"+source};}return result;}});
`);
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_HARNESS_SKILLS_PATH: skills,
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_HARNESS_AUTO_INSTALL: "0", UV_OFFLINE: "1",
    NODE_OPTIONS: `--max-old-space-size=256 --import=${pathToFileURL(observer).href}` };
  const children = new Map(), sockets = new Set(); let server, closing;
  const held = Promise.withResolvers();
  const watcher = holdExit ? watch(root, (_event, name) => { if (name === "held-exit") held.resolve(); }) : undefined;
  const allRecords = async () => {
    let lines; try { lines = await readFile(trace, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return lines.trim().split("\n").filter(Boolean).map(JSON.parse);
  };
  const ownedStarts = async () => (await allRecords()).filter(record => record.kind === "owned-start");
  function close() {
    return closing ??= (async () => {
      try { await controlRequest(socketPath, "shutdown_daemon", {}, { timeoutMs: 500 }); } catch {}
      for (const { identity } of children.values()) await signalOwned(identity, "SIGKILL");
      await Promise.all([...children.values()].map(owner => owner.closed));
      // An ACK schedules stop; only the captured start PID's actual exit fences its final writes.
      for (const identity of await ownedStarts()) {
        if (!await waitForExit(identity, onExitWait)) {
          await signalOwned(identity, "SIGKILL");
          assert(await waitForExit(identity, onExitWait), "test-owned detached start did not exit");
        }
      }
      for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve));
      watcher?.close();
      await beforeRemove();
      await rm(root, { recursive: true, force: true });
    })();
  }
  t.after(close);
  const records = async pid => (await allRecords()).filter(record => record.pid === pid && record.url);
  function launch(args, importOnly = false) {
    const child = spawn(process.execPath, importOnly ? ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(bin).href)})`] : [bin, ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close"); closed.catch(() => {});
    const identity = { pid: child.pid, ...procIdentity(readFileSync(`/proc/${child.pid}/stat`, "utf8")) };
    children.set(child, { identity, closed }); return child;
  }
  async function run(args, importOnly = false) {
    const child = launch(args, importOnly); let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await children.get(child).closed; return { pid: child.pid, code, stdout, stderr, records: await records(child.pid) };
  }
  return { root, agent, harness, socketPath, records, ownedStarts, held: held.promise, close, run, launch, async peer(reply) {
    const requests = [];
    server = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let buffer = "";
      socket.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end+1); requests.push(request);
        socket.write(JSON.stringify({ version: PROTOCOL_VERSION, type: "response", id: request.id,
          requestType: request.type, ok: true, data: reply(request) }) + "\n");
      } });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); return requests;
  } };
}
async function assertEvaluation(t, observed, { supervisor = false, client = false } = {}) {
  const paths = [...new Set(observed.records.map(record => path.relative(packageRoot, fileURLToPath(record.url))))].sort();
  const bytes = (await stat(bin)).size + (await Promise.all(paths.map(file => stat(path.join(packageRoot,file))))).reduce((sum,s)=>sum+s.size,0);
  t.diagnostic(JSON.stringify({ command: observed.records[0]?.command, modules: paths.length+1, sourceBytes: bytes, paths }));
  assert.equal(paths.includes("src/supervisor.mjs"), supervisor, "supervisor evaluation belongs only to the real start process");
  assert.equal(paths.includes("src/client.mjs"), client, "client evaluation belongs only to explicit memory observation");
  if (!supervisor) {
    const permitted = new Set(["src/control.mjs","src/framing.mjs","src/protocol.mjs","src/conversation-birth.mjs","src/message-time.mjs","src/input-images.mjs","src/input-location.mjs",...(client?["src/client.mjs"]:[])]);
    assert(paths.every(file => permitted.has(file)), "unused local service graph must not evaluate indirectly");
  }
}
for (const command of ["ensure", "status", "shutdown", "memory"]) {
  test(`CLI helper ${command} evaluates only its required control graph`, { timeout: 10000 }, async t => {
    const f = await fixture(t); const payload = command === "status" ? { running: true, diagnostics: [{ code: "synthetic_audit" }] }
      : command === "memory" ? { version: 1, worker: { state: "unavailable-not-running" } } : { stopping: true };
    const requests = await f.peer(request => request.type === "get_liveness" ? { alive: true }
      : request.type === "register_client" ? { limits: {} } : payload);
    const observed = await f.run(command === "memory" ? [command,"--session","public-fixture"] : [command]);
    assert.equal(observed.code,0,observed.stderr); await assertEvaluation(t,observed,{client:command==="memory"});
    assert.deepEqual(JSON.parse(observed.stdout),command==="ensure"?{alreadyRunning:true}:payload);
    assert.deepEqual(requests.map(request=>request.type),command==="memory"?["register_client","get_memory_diagnostics"]
      : [command==="ensure"?"get_liveness":command==="status"?"get_status":"shutdown_daemon"]);
    if(command==="memory")assert.deepEqual(requests[1].params,{sessionId:"public-fixture"});
    for(const file of ["supervisor.pid","supervisor.start.lock","harness.sqlite"])await assert.rejects(stat(path.join(f.harness,file)),{code:"ENOENT"});
  });
}
for (const importOnly of [true,false]) test(`CLI ${importOnly?"import-only":"invalid-command"} avoids unused service evaluation`, async t => {
  const f=await fixture(t), observed=await f.run(["invalid-command"],importOnly);
  assert.equal(observed.code,importOnly?0:1); if(!importOnly)assert.match(observed.stderr,/usage: harness-supervisor/);
  await assertEvaluation(t,observed);
});

test("CLI explicit start still evaluates and runs the real supervisor", {timeout:15000}, async t => {
  const f=await fixture(t), child=f.launch(["start"]); let buffer="";
  const ready=new Promise((resolve,reject)=>{child.stdout.on("data",chunk=>{buffer+=chunk;if(buffer.includes("\n"))resolve(JSON.parse(buffer.slice(0,buffer.indexOf("\n"))));});child.once("error",reject);});
  const status=await ready;assert.equal(status.running,true);assert.equal(status.pid,child.pid);
  await assertEvaluation(t,{records:await f.records(child.pid)},{supervisor:true});
  const exited=once(child,"exit");await controlRequest(f.socketPath,"shutdown_daemon");assert.equal((await exited)[0],0);
});

test("CLI ensure removes only helper loading while its start child keeps the normal service graph", {timeout:15000}, async t => {
  const waiting = Promise.withResolvers(), removing = Promise.withResolvers();
  const f=await fixture(t, { holdExit: true, onExitWait: () => waiting.resolve(), beforeRemove: async () => {
    removing.resolve();
    assert.equal(await readFile(path.join(f.harness, "late-writer"), "utf8"), "drained");
  } }), observed=await f.run(["ensure"]);assert.equal(observed.code,0,observed.stderr);
  const admitted=JSON.parse(observed.stdout);assert.equal(admitted.alreadyRunning,false);assert(Number.isInteger(admitted.pid));
  await assertEvaluation(t,observed);
  const status=await controlRequest(f.socketPath,"get_status");assert.equal(status.pid,admitted.pid);
  await assertEvaluation(t,{records:await f.records(admitted.pid)},{supervisor:true});
  const starts = await f.ownedStarts(); assert.equal(starts.length, 1);
  const [identity] = starts; assert.equal(identity.pid, admitted.pid);
  t.diagnostic(JSON.stringify({ fixtureRoot: f.root, ownedStartPid: identity.pid, startTime: identity.startTime }));
  await signalOwned({ ...identity, startTime: identity.startTime + "-stale" }, "SIGKILL");
  assert.equal(await ownedAlive(identity), true, "a different birth must not authorize termination");
  await controlRequest(f.socketPath,"shutdown_daemon");
  await f.held;
  const closing = f.close();
  try {
    assert.equal(await Promise.race([waiting.promise.then(() => "waiting"), removing.promise.then(() => "removed"), closing.then(() => "removed")]), "waiting",
      "cleanup must join the detached start, not only its shutdown acknowledgement");
    assert.equal(await ownedAlive(identity), true);
    assert((await stat(f.harness)).isDirectory());
  } finally {
    await signalOwned(identity, "SIGUSR2");
  }
  await closing;
  assert.equal(await ownedAlive(identity), false);
  await assert.rejects(stat(f.root), { code: "ENOENT" });
});
