import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { controlRequest } from "../src/control.mjs";
import { PROTOCOL_VERSION } from "../src/protocol.mjs";

const packageRoot = path.resolve(import.meta.dirname, ".."), bin = path.join(packageRoot, "bin/harness-supervisor.mjs");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-module-loading-"));
  const agent = path.join(root, "agent"), trace = path.join(root, "evaluations.jsonl"), observer = path.join(root, "observe.mjs");
  const harness = path.join(agent, "harness"), socketPath = path.join(harness, "supervisor.sock"), skills = path.join(root, "skills");
  await mkdir(harness, { recursive: true, mode: 0o700 }); await mkdir(skills);
  // Observe evaluation, not only resolution/loading: each genuine source gets a
  // first-statement witness after its original ESM dependencies have evaluated.
  await writeFile(observer, `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
globalThis.__harnessCliEvaluation = url => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,command:process.argv[2]??"import",url})+"\\n");
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(result.format==="module"&&url.startsWith(${JSON.stringify(pathToFileURL(path.join(packageRoot, "src") + path.sep).href)})){const source=typeof result.source==="string"?result.source:Buffer.from(result.source).toString("utf8");return {...result,source:"globalThis.__harnessCliEvaluation("+JSON.stringify(url)+");\\n"+source};}return result;}});
`);
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_HARNESS_SKILLS_PATH: skills,
    PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_HARNESS_AUTO_INSTALL: "0", UV_OFFLINE: "1",
    NODE_OPTIONS: `--max-old-space-size=256 --import=${pathToFileURL(observer).href}` };
  const children = [], sockets = new Set(); let server;
  t.after(async () => {
    try { await controlRequest(socketPath, "shutdown_daemon", {}, { timeoutMs: 500 }); } catch {}
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of sockets) socket.destroy(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const records = async pid => {
    let lines; try { lines = await readFile(trace, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return lines.trim().split("\n").filter(Boolean).map(JSON.parse).filter(record => record.pid === pid);
  };
  function launch(args, importOnly = false) {
    const child = spawn(process.execPath, importOnly ? ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(bin).href)})`] : [bin, ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(child); return child;
  }
  async function run(args, importOnly = false) {
    const child = launch(args, importOnly); let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const [code] = await once(child, "exit"); return { pid: child.pid, code, stdout, stderr, records: await records(child.pid) };
  }
  return { root, agent, harness, socketPath, records, run, launch, async peer(reply) {
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
    const permitted = new Set(["src/control.mjs","src/framing.mjs","src/protocol.mjs","src/conversation-birth.mjs","src/input-images.mjs","src/input-location.mjs",...(client?["src/client.mjs"]:[])]);
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
  const f=await fixture(t), observed=await f.run(["ensure"]);assert.equal(observed.code,0,observed.stderr);
  const admitted=JSON.parse(observed.stdout);assert.equal(admitted.alreadyRunning,false);assert(Number.isInteger(admitted.pid));
  await assertEvaluation(t,observed);
  const status=await controlRequest(f.socketPath,"get_status");assert.equal(status.pid,admitted.pid);
  await assertEvaluation(t,{records:await f.records(admitted.pid)},{supervisor:true});
  await controlRequest(f.socketPath,"shutdown_daemon");
});
