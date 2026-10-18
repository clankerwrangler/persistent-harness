import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { controlRequest } from "../src/control.mjs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { SDKWorker } from "../src/sdk-worker.mjs";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { validateRequest, PROTOCOL_VERSION } from "../src/protocol.mjs";

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_,reject) => { timer=setTimeout(() => reject(new Error("diagnostic waited behind work")),500); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(probe) { const end=Date.now()+3000; while (Date.now()<end) { if (await probe()) return; await pause(5); } throw new Error("fixture boundary not reached"); }
function nodeCounters(value) {
  assert.deepEqual(Object.keys(value).sort(), ["arrayBuffers","external","heapTotal","heapUsed","rss","v8HeapTotal","v8HeapUsed"].sort());
  for (const count of Object.values(value)) assert(Number.isSafeInteger(count) && count >= 0);
}

test("memory diagnostics are a separate exact request, not status options", () => {
  const frame={version:PROTOCOL_VERSION,id:"memory",type:"get_memory_diagnostics",params:{sessionId:"fixture"}};
  assert.equal(validateRequest(frame).params.sessionId,"fixture");
  assert.throws(() => validateRequest({...frame,params:{sessionId:"fixture",code:"private"}}),/not supported/);
  assert.throws(() => validateRequest({...frame,type:"get_status",params:{memory:true}}),/not supported/);
});

test("worker diagnostic does not read state/history or invoke mutation leases", async () => {
  const forbidden=()=>{throw new Error("unrelated session read or mutation");};
  const session={sessionManager:{},subscribe:()=>()=>{}};
  const worker=new SDKWorker({session,coordinator:{getState:forbidden,withServiceMutation:forbidden},
    lifecycle:{memoryDiagnostics:()=>({state:"unavailable-busy"})},publish:forbidden});
  const result=await worker.handle({type:"get_memory_diagnostics"});
  assert.equal(result.version,1); nodeCounters(result.node);
  assert.deepEqual(result.python,{state:"unavailable-busy"});
});

async function kernelFixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),"memory-diagnostic-kernel-"));
  const script=path.join(root,"fixture.py");
  await writeFile(script,String.raw`
import json,os,time
from pathlib import Path
root=Path(__file__).parent
control=os.fdopen(3,"r+b",buffering=0)
def emit(frame): control.write((json.dumps(frame)+"\n").encode())
def mark(name): (root/name).write_text("ready")
def wait(name):
    while not (root/name).exists(): time.sleep(.005)
emit({"type":"ready"})
for line in control:
    c=json.loads(line); kind,identity=c["type"],c["id"]
    with (root/"commands").open("a") as log: log.write(kind+"\n")
    if kind=="execute":
        if c["code"]=="host":
            emit({"type":"host_request","id":"nested","requestType":"fixture.host","payload":{}})
            reply=json.loads(control.readline())
            assert reply["type"]=="host_response" and reply["id"]=="nested", "diagnostic stole host-response ownership"
        emit({"type":"done","id":identity,"ok":True})
    elif kind=="snapshot":
        mark("snapshot"); wait("snapshot-release")
        emit({"type":"snapshot_done","id":identity,"ok":True,"snapshot":{"stats":{},"saved":[],"skipped":[]}})
    elif kind=="memory_diagnostics":
        mark("diagnostic"); wait("diagnostic-release")
        emit({"type":"memory_diagnostics_done","id":identity,"diagnostics":{"version":1,"state":"complete",
          "outEntries":0,"reprEntries":0,"mimeEntries":0,"visited":0,"unknown":0,
          "containers":3,"containerBytes":192,"strings":0,"stringBytes":0,"bytes":0,"bytesBytes":0}})
    elif kind=="shutdown":
        emit({"type":"shutdown_done","id":identity}); break
`);
  const hostEntered=Promise.withResolvers(),hostRelease=Promise.withResolvers();
  const kernel=new PythonKernel({pythonPath:process.env.PI_HARNESS_PYTHON || "python3",kernelScript:script,
    runtimeSupportDir:path.resolve(import.meta.dirname,"../python-runtime"),cwd:root,stateDir:path.join(root,"state"),
    manifest:{skills:[{python:{srcPath:root,hostRequests:["fixture.host"]}}]},
    hostHandlers:{"fixture.host":async()=>{hostEntered.resolve();await hostRelease.promise;return {ok:true};}}});
  const release=name=>writeFile(path.join(root,name+"-release"),"");
  const marked=name=>access(path.join(root,name)).then(()=>true,()=>false);
  t.after(async()=>{hostRelease.resolve();await release("snapshot");await release("diagnostic");await kernel.close({snapshot:false});await rm(root,{recursive:true,force:true});});
  return {kernel,root,release,marked,hostEntered,hostRelease,commands:()=>readFile(path.join(root,"commands"),"utf8")};
}

test("diagnosis never starts a kernel and skips queued/host work immediately",async t=>{
  const f=await kernelFixture(t);
  assert.deepEqual(await f.kernel.memoryDiagnostics(),{state:"unavailable-not-running"});
  await assert.rejects(access(path.join(f.root,"state")),/ENOENT/);
  await f.kernel.start();
  const execution=f.kernel.execute("host");
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"},"queued execution owns its slot before its microtask");
  await f.hostEntered.promise;
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"});
  f.hostRelease.resolve(); assert.equal((await execution).ok,true);
  assert.equal((await f.commands()).includes("memory_diagnostics"),false);
});

test("queued snapshot and close/drain cannot accept a diagnostic",async t=>{
  const f=await kernelFixture(t);await f.kernel.start();
  const snapshot=f.kernel.snapshot();
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"});
  await eventually(()=>f.marked("snapshot"));
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"});
  const closing=f.kernel.close({snapshot:false});
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"});
  await f.release("snapshot");await snapshot;await closing;
  assert.equal((await f.commands()).includes("memory_diagnostics"),false);
});

test("an admitted diagnostic reserves the pipe before later work and close drains it",async t=>{
  const f=await kernelFixture(t);await f.kernel.start();
  const before=f.kernel.snapshotStats;
  const diagnostic=f.kernel.memoryDiagnostics();
  const execution=f.kernel.execute("later");
  await eventually(()=>f.marked("diagnostic"));
  assert.deepEqual(await bounded(f.kernel.memoryDiagnostics()),{state:"unavailable-busy"});
  assert.equal(await f.commands(),"memory_diagnostics\n");
  assert.deepEqual(f.kernel.snapshotStats,before,"read did not change checkpoint generation");
  let closed=false;const closing=f.kernel.close({snapshot:false}).then(()=>{closed=true;});
  await pause(20);assert.equal(closed,false);
  await f.release("diagnostic");assert.equal((await diagnostic).state,"complete");
  assert.equal((await execution).ok,true);await closing;
  assert.equal(await f.commands(),"memory_diagnostics\nexecute\nshutdown\n");
});

test("Python counters are deduplicated, bounded, fixed-owner and invoke no user hooks",()=>{
  const source=path.resolve(import.meta.dirname,"../python-runtime/_memory_diagnostics.py");
  const script=String.raw`
import importlib.util,sys
from collections import defaultdict
from IPython.core.history import HistoryManager,HistoryOutput
spec=importlib.util.spec_from_file_location("fixture_memory",sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def history(out,reprs,outputs):
    h=object.__new__(HistoryManager)
    object.__setattr__(h,"_trait_values",{"output_hist":out,"output_hist_reprs":reprs})
    object.__setattr__(h,"outputs",outputs)
    return h
payload="public fixture "+"x"*100
blob=b"public fixture"*10
bundle={"text/plain":payload,"image/png":blob}
record=HistoryOutput("execute_result",bundle)
cyclic=[];cyclic.append(cyclic)
out={1:payload,2:[blob,cyclic]};reprs={1:payload};outputs=defaultdict(list,{1:[record]})
h=history(out,reprs,outputs)
before=(list(out),list(reprs),list(outputs),id(bundle),id(cyclic[0]))
r=m.collect_history_memory(h)
assert r["state"]=="complete",r
assert r["strings"]==1 and r["stringBytes"]==sys.getsizeof(payload),r
assert r["bytes"]==1 and r["bytesBytes"]==sys.getsizeof(blob),r
assert r["outEntries"]==2 and r["reprEntries"]==1 and r["mimeEntries"]==1,r
assert before==(list(out),list(reprs),list(outputs),id(bundle),id(cyclic[0]))
assert not any(x in str(r) for x in (payload,"image/png","text/plain","public fixture"))
class Evil:
    def __sizeof__(self): raise AssertionError("user sizeof")
    def __iter__(self): raise AssertionError("user iterator")
    def __getattribute__(self,name): raise AssertionError("user getter")
class HostileMeta(type):
    def __eq__(self,other): raise AssertionError("user metaclass equality")
class MetaValue(metaclass=HostileMeta): pass
class EvilDict(dict):
    def values(self): raise AssertionError("subclass iterator")
class EvilRecord(HistoryOutput):
    def __getattribute__(self,name): raise AssertionError("history subclass getter")
for value in (Evil(),MetaValue(),EvilDict(a=1),EvilRecord("execute_result",{})):
    r=m.collect_history_memory(history({1:value},{},defaultdict(list)))
    assert r["state"]=="unknown" and r["unknown"]==1,r
record.bundle=EvilDict(a=1)
assert m.collect_history_memory(h)["state"]=="unknown"
assert m.collect_history_memory(Evil())["state"]=="unknown"
r=m.collect_history_memory(history({1:list(range(20000))},{},defaultdict(list)))
assert r["state"]=="truncated" and r["visited"]<=10000,r
m.time.monotonic=lambda: 0
clock=iter((0,1,1,1));m.time.monotonic=lambda:next(clock)
assert m.collect_history_memory(h)["state"]=="truncated"
`;
  const result=spawnSync(process.env.PI_HARNESS_PYTHON || "python3",["-I","-c",script,source],{encoding:"utf8",timeout:15000,maxBuffer:16384});
  assert.equal(result.status,0,result.stderr || result.error?.message);
});

class MemoryActor extends EventEmitter {
  constructor(options){super();this.session=options.session;this.isRunning=false;this.pid=process.pid;this.requests=[];}
  state(){return {sessionId:this.session.sessionId,sessionFile:this.session.sessionFile,isStreaming:false,model:null,thinkingLevel:"off"};}
  async start(){this.isRunning=true;return this.state();}
  async request(type){this.requests.push(type);if(type==="get_state")return this.state();if(type==="get_memory_diagnostics")return {version:1,node:{rss:1,heapTotal:1,heapUsed:1,external:1,arrayBuffers:1,v8HeapTotal:1,v8HeapUsed:1},python:{state:"unavailable-busy"}};throw new Error("unexpected request "+type);}
  async close(){this.isRunning=false;this.emit("exit",{code:0,signal:"SIGTERM"});}
}

test("operator diagnostics skip absent actors, preserve state and bypass held mutations",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"memory-diagnostic-supervisor-"));
  const file=path.join(root,"fixture.jsonl");await writeFile(file,JSON.stringify({type:"session",version:3,id:"memory-root",cwd:root})+"\n");
  const actors=[];let held;
  const supervisor=new HarnessSupervisor({socketPath:path.join(root,"s.sock"),databasePath:path.join(root,"db.sqlite"),pidPath:path.join(root,"p.pid"),
    backgroundJobsDirectory:path.join(root,"background"),actorInactivityMs:0,runtimeProvisioner:async()=>({}),
    actorFactory:o=>{const a=new MemoryActor(o);actors.push(a);return a;},
    processIdentityFactory:async pid=>({version:1,pid,processGroup:pid,startTime:"fake",ownerToken:"fake"}),processTerminator:async()=>({}),logger:{error(){}}});
  await supervisor.start();
  const client=new HarnessClient({socketPath:supervisor.socketPath,heartbeatMs:0});
  t.after(async()=>{held?.resolve();await client.stop();await supervisor.stop();await rm(root,{recursive:true,force:true});});
  supervisor.store.createRoot({sessionId:"memory-root",sessionFile:file,cwd:root,repositoryRoot:null,name:"Memory",actorToken:"fixture",launch:{}});
  await client.start({registrationType:"register_client",clientInstanceId:"memory-test"});
  await assert.rejects(controlRequest(supervisor.socketPath,"get_memory_diagnostics",{sessionId:"memory-root"}),/register/);
  const before=supervisor.store.getSession("memory-root");
  let result=await client.request("get_memory_diagnostics",{sessionId:"memory-root"});
  assert.equal(result.version,1);nodeCounters(result.supervisor);
  assert.deepEqual(result.worker,{state:"unavailable-not-running"});assert.equal(actors.length,0);
  assert.deepEqual(supervisor.store.getSession("memory-root"),before);
  const cli=await promisify(execFile)(process.execPath,["--max-old-space-size=128",path.resolve(import.meta.dirname,"../bin/harness-supervisor.mjs"),"memory","--socket",supervisor.socketPath,"--session","memory-root"],{timeout:5000});
  assert.equal(JSON.parse(cli.stdout).worker.state,"unavailable-not-running");assert.equal(actors.length,0);
  assert.deepEqual(supervisor.store.getSession("memory-root"),before);
  await client.request("subscribe_session",{selector:"memory-root"});
  const actor=actors[0];
  const actorClient=new HarnessClient({socketPath:supervisor.socketPath,heartbeatMs:0});
  try {
    const current=supervisor.store.getSession("memory-root");
    await actorClient.start({registrationType:"register_actor",sessionId:"memory-root",sessionFile:file,cwd:root,repositoryRoot:null,actorToken:"fixture",actorGeneration:current.actorGeneration});
    await assert.rejects(actorClient.request("get_memory_diagnostics",{sessionId:"memory-root"}),/not available to actors/);
  } finally {await actorClient.stop();}
  held=Promise.withResolvers();const entered=Promise.withResolvers();
  const original=actor.request.bind(actor);
  actor.request=async type=>{if(type==="compact"){entered.resolve();await held.promise;return {};}return original(type);};
  const compact=client.request("compact_session",{sessionId:"memory-root"});await entered.promise;
  const resident=supervisor.store.getSession("memory-root");const bytes=await readFile(file,"utf8");
  result=await bounded(client.request("get_memory_diagnostics",{sessionId:"memory-root"}));
  nodeCounters(result.worker.node);assert.deepEqual(result.worker.python,{state:"unavailable-busy"});
  assert.deepEqual(supervisor.store.getSession("memory-root"),resident);assert.equal(await readFile(file,"utf8"),bytes);
  held.resolve();await compact;
});


test("numeric transport projection drops unexpected peer bodies",async()=>{
  const {workerMemoryDiagnostics,historyMemoryDiagnostics}=await import("../src/memory-diagnostics.mjs");
  assert.deepEqual(workerMemoryDiagnostics({version:1,node:{rss:"private"},body:"private"}),{state:"unavailable-error"});
  const raw={version:1,node:{rss:1,heapTotal:1,heapUsed:1,external:1,arrayBuffers:1,v8HeapTotal:1,v8HeapUsed:1,body:"private"},
    python:{state:"unavailable-busy",body:"private"},body:"private"};
  assert.equal(JSON.stringify(workerMemoryDiagnostics(raw)).includes("private"),false);
  assert.deepEqual(historyMemoryDiagnostics({version:1,state:"complete",body:"private"}),{state:"unavailable-error"});
});

test("real fixture kernel diagnoses existing history without adding an execution or checkpoint",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"memory-diagnostic-real-"));
  const kernel=new PythonKernel({pythonPath:process.env.PI_HARNESS_PYTHON || "python3",kernelScript:path.resolve(import.meta.dirname,"../python-runtime/kernel.py"),
    runtimeSupportDir:path.resolve(import.meta.dirname,"../python-runtime"),cwd:root,stateDir:path.join(root,"state"),manifest:{version:1,skills:[]},hostHandlers:{}});
  t.after(async()=>{await kernel.close({snapshot:false});await rm(root,{recursive:true,force:true});});
  await kernel.start();
  const empty=await kernel.memoryDiagnostics();assert.equal(empty.state,"complete",JSON.stringify(empty));
  const execution=await kernel.execute("'public diagnostic fixture'");assert.equal(execution.ok,true);
  const before=kernel.snapshotStats;
  const first=await kernel.memoryDiagnostics(),second=await kernel.memoryDiagnostics();
  assert.equal(first.state,"complete",JSON.stringify(first));assert.equal(first.outEntries,1);assert.equal(first.mimeEntries,1);
  assert.deepEqual(first,second);assert.deepEqual(kernel.snapshotStats,before);
  assert.equal(JSON.stringify(first).includes("public diagnostic fixture"),false);
});
