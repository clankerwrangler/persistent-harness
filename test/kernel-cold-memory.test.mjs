import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
const rootSource=path.resolve(import.meta.dirname,"..");
const realTimeout=globalThis.setTimeout;
const pause=ms=>new Promise(resolve=>realTimeout(resolve,ms));
async function until(probe,ms=10000){const end=performance.now()+ms;while(performance.now()<end){if(await probe())return;await pause(5);}throw new Error("private fixture deadline");}
async function memory(pid){const values={};for(const line of (await readFile(`/proc/${pid}/smaps_rollup`,"utf8")).split("\n")){const pair=line.match(/^(Rss|Anonymous|Swap):\s+(\d+) kB$/);if(pair)values[pair[1]]=Number(pair[2])*1024;}return values;}

test("ordinary existing kernel automatically cold-tiers while actor may be thinking; opaque state remains exact",{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"kernel-cold-normal-"));
 const runtime=await new PythonRuntimeManager({runtimeDir:path.join(root,"runtime")}).ensure({skills:[],consent:async()=>true});
 t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
 let kernel;
 const manifest={version:1,skills:[{id:"kernel",alias:"kernel",version:"1",instructions:"Private status fixture",skillPath:path.join(rootSource,"skills/kernel/SKILL.md"),python:{srcPath:path.join(rootSource,"skills/kernel/src"),importName:"harness_kernel",hostRequests:["kernel.status"]}}]};
 kernel=new PythonKernel({pythonPath:runtime.pythonPath,kernelScript:path.join(rootSource,"python-runtime/kernel.py"),runtimeSupportDir:path.join(rootSource,"python-runtime"),cwd:root,stateDir:path.join(root,"state"),manifest,hostHandlers:createHostHandlers({cwd:root,getKernel:()=>kernel})});
 t.after(async()=>{await kernel.close({snapshot:false});t.mock.timers.reset();await rm(root,{recursive:true,force:true});});
 async function run(code){const result=await kernel.execute(code);assert.equal(result.ok,true,result.error);return JSON.parse(result.stdout.trim());}
 const initial=await run(`exec(Path(${JSON.stringify(path.join(rootSource,"test/fixtures/kernel-cold-state.py"))}).read_text())` .replace("exec(Path(","from pathlib import Path\nexec(Path(")+"\nimport _cold_residency\n_cold_residency.pressure_budget=lambda:('eligible',_cold_residency.MAX_PASS_BYTES)\nprint(json.dumps({'pid':os.getpid(),'baselineReadNs':baseline_read_ns,'environment':fixture_environment_memory()}))");
 await kernel.snapshot();
 const checkpoint=kernel.snapshotStats;
 const before=await memory(initial.pid);
 // The test advances only the owning Node timer; real Linux paging is unchanged.
 t.mock.timers.tick(30000);
 await until(async()=>{t.mock.timers.tick(kernel.coldMemoryStats.state==="waiting"?1000:0);return ["complete","hot","unavailable","unsupported","unreclaimable"].includes(kernel.coldMemoryStats.state);});
 const stats=kernel.coldMemoryStats;
 const after=await memory(initial.pid);
 assert.equal(stats.state,"complete",JSON.stringify(stats));
 assert.ok(stats.pageoutBytes>=32*1024*1024,JSON.stringify(stats));
 assert.ok(before.Rss-after.Rss>=24*1024*1024,JSON.stringify({before,after,stats}));
 assert.ok(after.Swap-before.Swap>=32*1024*1024,JSON.stringify({before,after,stats}));
 assert.deepEqual(kernel.snapshotStats,checkpoint,"cold advice does not advance namespace/checkpoint generation");
 const status=await run("print(json.dumps(kernel.status()))");
 assert.equal(status.running,true);assert.equal(status.busy,true);
 assert.equal(status.coldMemory.version,1);assert.equal(status.coldMemory.state,"complete");
 assert.ok(status.coldMemory.pageoutBytes>=32*1024*1024);
 const afterEnvironment=await run("print(json.dumps(fixture_environment_memory()))");
 await pause(1000);
 const delayedEnvironment=await run("print(json.dumps(fixture_environment_memory()))");
 const restored=await run("started=time.perf_counter_ns()\nvalid=(connection.execute('select value+1 from state').fetchone()[0]==42 and connection.in_transaction and sentinel=={'token':'persistent-state','values':[1,2,3]} and hashlib.sha256(native_buffer).hexdigest()==original_digest)\nidentical=(id(connection),id(sentinel),id(native_buffer),ctypes.addressof(ctypes.c_char.from_buffer(native_buffer)),os.getpid())==original_identity\naliases=(connection_alias is connection and sentinel_alias is sentinel and buffer_alias is native_buffer)\nprint(json.dumps({'valid':valid,'identical':identical,'aliases':aliases,'readNs':time.perf_counter_ns()-started}))");
 assert.deepEqual({valid:restored.valid,identical:restored.identical,aliases:restored.aliases},{valid:true,identical:true,aliases:true});
 const warmLatencies=[];
 for(let i=0;i<5;i++){
   const began=performance.now();const warm=await kernel.execute("print('warm')");
   assert.equal(warm.ok,true,warm.error);warmLatencies.push(performance.now()-began);
 }
 const completedStats=kernel.coldMemoryStats;
 const nativeCall=kernel.execute("ctypes.CDLL(None).usleep(200000)\nprint('native-finished')");
 t.mock.timers.tick(30000);
 const nativeResult=await nativeCall;
 assert.equal(nativeResult.ok,true,nativeResult.error);
 assert.deepEqual(kernel.coldMemoryStats,completedStats,"queued/active native execution refuses cold advice");
 console.log(JSON.stringify({before,after,advice:stats,baselineReadNs:initial.baselineReadNs,nextUseNs:restored.readNs,afterUse:await memory(initial.pid),environment:{before:initial.environment,after:afterEnvironment,delayed:delayedEnvironment},warmExecuteMs:warmLatencies}));
});


import { spawnSync } from "node:child_process";
test("cold residency numeric policy, hot/locked ranges, unsupported and fixed work bounds",()=>{
 const result=spawnSync(process.env.PI_HARNESS_PYTHON||"python3",["-B",path.join(import.meta.dirname,"kernel-cold-memory.py")],{encoding:"utf8",timeout:10000,maxBuffer:65536});
 assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
});


async function protocolFixture(t,capability=1){
 const root=await mkdtemp(path.join(os.tmpdir(),"kernel-cold-fifo-"));
 const script=path.join(root,"kernel.py");
 if(capability!==null)await writeFile(path.join(root,"capability"),String(capability));
 await writeFile(script,String.raw`
import json,os,time
from pathlib import Path
root=Path(__file__).parent
control=os.fdopen(3,"r+b",buffering=0)
def emit(value):control.write((json.dumps(value)+"\n").encode())
def mark(name):(root/name).write_text("ready")
def wait(name):
 while not (root/name).exists():time.sleep(.005)
emit({"type":"runtime_validated","versions":{"python":"fixture","ipython":"fixture","dill":"fixture"}})
assert json.loads(control.readline())["type"]=="runtime_continue"
ready={"type":"ready"}
if (root/"capability").exists():ready["coldResidencyVersion"]=int((root/"capability").read_text())
emit(ready)
counter=0
for line in control:
 c=json.loads(line);kind,identity=c["type"],c["id"]
 with (root/"commands").open("a") as log:log.write(kind+"\n")
 if kind=="execute":
  if c["code"]=="host":
   emit({"type":"host_request","id":"host","requestType":"fixture.host","payload":{}})
   reply=json.loads(control.readline())
   assert reply["type"]=="host_response" and reply["id"]=="host"
  counter+=1
  emit({"type":"result","id":identity,"stream":"stdout","mime":{"text/plain":json.dumps({"counter":counter,"pid":os.getpid()})+"\n"}})
  emit({"type":"done","id":identity,"ok":True})
 elif kind=="snapshot":
  if (root/"hold-snapshot").exists():mark("snapshot");wait("snapshot-release")
  emit({"type":"snapshot_done","id":identity,"ok":True,"snapshot":{"stats":{},"saved":[],"skipped":[]}})
 elif kind=="memory_diagnostics":
  mark("diagnostic")
  if (root/"hold-diagnostic").exists():wait("diagnostic-release")
  emit({"type":"memory_diagnostics_done","id":identity,"diagnostics":{"version":1,"state":"complete","outEntries":0,"reprEntries":0,"mimeEntries":0,"visited":0,"unknown":0,"containers":3,"containerBytes":192,"strings":0,"stringBytes":0,"bytes":0,"bytesBytes":0}})
 elif kind=="cold_memory":
  assert ready.get("coldResidencyVersion")==1,"legacy command loop received an unknown optional request"
  mark("cold")
  if (root/"hold-cold").exists():wait("cold-release")
  emit({"type":"cold_memory_done","id":identity,"result":{"state":(root/"cold-state").read_text() if (root/"cold-state").exists() else "mark","markedBytes":4096,"pageoutBytes":0,"durationNs":1}})
 elif kind=="shutdown":emit({"type":"shutdown_done","id":identity});break
`);
 const hostEntered=Promise.withResolvers(),hostRelease=Promise.withResolvers();
 t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
 const kernel=new PythonKernel({pythonPath:process.env.PI_HARNESS_PYTHON||"python3",kernelScript:script,runtimeSupportDir:path.join(rootSource,"python-runtime"),cwd:root,stateDir:path.join(root,"state"),manifest:{version:1,skills:[{python:{srcPath:root,hostRequests:["fixture.host"]}}]},hostHandlers:{"fixture.host":async()=>{hostEntered.resolve();await hostRelease.promise;return {ok:true};}}});
 const has=file=>access(path.join(root,file)).then(()=>true,()=>false);
 const release=file=>writeFile(path.join(root,file),"ready");
 const commands=()=>readFile(path.join(root,"commands"),"utf8").catch(()=>"");
 t.after(async()=>{hostRelease.resolve();await release("snapshot-release");await release("cold-release");await release("diagnostic-release");await kernel.close({snapshot:false});t.mock.timers.reset();await rm(root,{recursive:true,force:true});});
 return {root,kernel,has,release,commands,hostEntered,hostRelease};
}

test("kernel-only timer refuses queued, snapshot and host work; new cells/close wait at most the owned batch",{timeout:15000},async t=>{
 const {root,kernel,has,release,commands,hostEntered,hostRelease}=await protocolFixture(t);
 assert.deepEqual(await kernel.memoryDiagnostics(),{state:"unavailable-not-running"});t.mock.timers.tick(30000);
 assert.equal(await has("state"),false,"optional cold path cannot start a kernel");
 await kernel.start();
 const queued=kernel.execute("noop");t.mock.timers.tick(30000);assert.equal((await queued).ok,true);
 assert.equal((await commands()).includes("cold_memory"),false);
 await release("hold-snapshot");const snapshot=kernel.snapshot();
 await until(()=>has("snapshot"));t.mock.timers.tick(30000);
 assert.equal((await commands()).includes("cold_memory"),false);
 await release("snapshot-release");await snapshot;await rm(path.join(root,"hold-snapshot"));
 const host=kernel.execute("host");await hostEntered.promise;t.mock.timers.tick(30000);
 assert.equal((await commands()).includes("cold_memory"),false,"advice never steals nested host-response ownership");
 hostRelease.resolve();assert.equal((await host).ok,true);await kernel.snapshot();
 await release("hold-cold");t.mock.timers.tick(30000);await until(()=>has("cold"));
 const later=kernel.execute("later");
 await pause(20);assert.equal((await commands()).split("\n").filter(kind=>kind==="execute").length,2);
 await release("cold-release");assert.equal((await later).ok,true);
 t.mock.timers.tick(0);
 assert.equal((await commands()).split("\n").filter(kind=>kind==="cold_memory").length,1,"wake cancels the remaining sweep before another batch");
 await kernel.snapshot();await rm(path.join(root,"cold-release"));await rm(path.join(root,"cold"));
 t.mock.timers.tick(30000);await until(()=>has("cold"));
 let closed=false;const close=kernel.close({snapshot:false}).then(()=>{closed=true;});
 await pause(20);assert.equal(closed,false,"close drains the one in-flight command");
 await release("cold-release");await close;t.mock.timers.tick(30000);
 assert.equal((await commands()).split("\n").filter(kind=>kind==="cold_memory").length,2);
 assert.equal((await commands()).trim().split("\n").at(-1),"shutdown");
});


test("snapshot-demand and diagnostic owner release rearm automatic work without another cell",{timeout:15000},async t=>{
 const {root,kernel,has,release,commands}=await protocolFixture(t);
 await kernel.start();await release("hold-cold");await writeFile(path.join(root,"cold-state"),"complete");
 t.mock.timers.tick(30000);await until(()=>has("cold"));
 const demand=kernel.snapshot();await release("cold-release");await demand;
 await until(async()=>{t.mock.timers.tick(30000);return (await commands()).split("\n").filter(kind=>kind==="cold_memory").length>=2 && kernel.coldMemoryStats.state==="complete";});
 assert.equal((await commands()).includes("execute"),false,"snapshot-demand retry needs no ordinary cell");
 const beforeDiagnostic=(await commands()).split("\n").filter(kind=>kind==="cold_memory").length;
 await release("hold-diagnostic");
 const diagnostic=kernel.memoryDiagnostics();await until(()=>has("diagnostic"));
 t.mock.timers.tick(30000);
 assert.equal((await commands()).split("\n").filter(kind=>kind==="cold_memory").length,beforeDiagnostic);
 await release("diagnostic-release");await diagnostic;
 await until(async()=>{t.mock.timers.tick(30000);return (await commands()).split("\n").filter(kind=>kind==="cold_memory").length>beforeDiagnostic && kernel.coldMemoryStats.state==="complete";});
 assert.equal((await commands()).includes("execute"),false,"diagnostic release itself rearms quiescence");
});

test("legacy or unknown ready capability receives no optional command and keeps ordinary state",{timeout:15000},async t=>{
 for(const capability of [null,2])await t.test(String(capability),async child=>{
 const {kernel,commands}=await protocolFixture(child,capability);
 const first=await kernel.execute("counter");assert.equal(first.ok,true);
 await kernel.snapshot();child.mock.timers.tick(30000);child.mock.timers.tick(30000);
 assert.equal((await commands()).includes("cold_memory"),false);
 assert.deepEqual(kernel.coldMemoryStats,{state:"unsupported"});
 const second=await kernel.execute("counter");assert.equal(second.ok,true);
 const a=JSON.parse(first.stdout),b=JSON.parse(second.stdout);
 assert.equal(a.pid,b.pid);assert.equal(b.counter,a.counter+1);
 });
});

test("advertised but unsupported advisory outcome disables optional work and preserves ordinary state",{timeout:15000},async t=>{
 const {root,kernel,commands}=await protocolFixture(t);
 const first=await kernel.execute("counter");await kernel.snapshot();
 await writeFile(path.join(root,"cold-state"),"unsupported");t.mock.timers.tick(30000);
 await until(()=>kernel.coldMemoryStats.state==="unsupported");
 t.mock.timers.tick(30000);
 assert.equal((await commands()).split("\n").filter(kind=>kind==="cold_memory").length,1);
 const second=await kernel.execute("counter");assert.equal(second.ok,true);
 const a=JSON.parse(first.stdout),b=JSON.parse(second.stdout);
 assert.equal(a.pid,b.pid);assert.equal(b.counter,a.counter+1);
});


test("frequent ordinary light cells do not starve cold bound data maintenance",{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"kernel-cold-mixed-"));
 const runtime=await new PythonRuntimeManager({runtimeDir:path.join(root,"runtime")}).ensure({skills:[],consent:async()=>true});
 t.mock.timers.enable({apis:["setTimeout","Date"],now:Date.now()});
 const kernel=new PythonKernel({pythonPath:runtime.pythonPath,kernelScript:path.join(rootSource,"python-runtime/kernel.py"),runtimeSupportDir:path.join(rootSource,"python-runtime"),cwd:root,stateDir:path.join(root,"state"),manifest:{version:1,skills:[]},hostHandlers:{}});
 t.after(async()=>{await kernel.close({snapshot:false});t.mock.timers.reset();await rm(root,{recursive:true,force:true});});
 async function run(code){const result=await kernel.execute(code);assert.equal(result.ok,true,result.error);return JSON.parse(result.stdout.trim());}
 const pid=await run(`from pathlib import Path\nexec(Path(${JSON.stringify(path.join(rootSource,"test/fixtures/kernel-cold-state.py"))}).read_text())\nimport _cold_residency\n_cold_residency.pressure_budget=lambda:('eligible',_cold_residency.MAX_PASS_BYTES)\ncontrol_count=0\nprint(json.dumps(os.getpid()))`);
 await kernel.snapshot();const before=await memory(pid);
 let lightCells=0,after=before;
 for(;lightCells<80;){
   lightCells++;
   assert.equal(await run("control_count+=1\nprint(json.dumps(control_count))"),lightCells);
   // Every gap is one second, including the real debounced checkpoint path.
   for(let elapsed=0;elapsed<1000;elapsed+=100){t.mock.timers.tick(100);await pause(2);}
   after=await memory(pid);
   if(before.Rss-after.Rss>=24*1024*1024 && after.Swap-before.Swap>=24*1024*1024)break;
 }
 assert.ok(lightCells<80,JSON.stringify({before,after,stats:kernel.coldMemoryStats}));
 const verified=await run("print(json.dumps({'control':control_count,'state':connection.execute('select value+1 from state').fetchone()[0]==42 and connection.in_transaction,'aliases':connection_alias is connection and sentinel_alias is sentinel and buffer_alias is native_buffer,'identity':(id(connection),id(sentinel),id(native_buffer),ctypes.addressof(ctypes.c_char.from_buffer(native_buffer)),os.getpid())==original_identity,'digest':hashlib.sha256(native_buffer).hexdigest()==original_digest}))");
 assert.deepEqual(verified,{control:lightCells,state:true,aliases:true,identity:true,digest:true});
 console.log(JSON.stringify({mixedWork:{lightCells,gapMs:1000,before,after,stats:kernel.coldMemoryStats}}));
});


test("existing actor-scoped kernel.status adds only fixed cold metadata and preserves legacy responses",()=>{
 const restore={found:true};let owned;
 const handlers=createHostHandlers({cwd:rootSource,getKernel:()=>owned,getKernelRestore:()=>restore});
 assert.deepEqual(handlers["kernel.status"](),{running:false,busy:false,restore});
 for(const stats of [undefined,{state:"unsupported"},{version:2,state:"complete"}]){
   owned={isRunning:true,isBusy:false,coldMemoryStats:stats};
   assert.deepEqual(handlers["kernel.status"](),{running:true,busy:false,restore});
 }
 let reads=0;
 const stats={version:1,state:"complete",calls:2,markedBytes:4096,pageoutBytes:2048,
   durationNs:-1,rssBefore:NaN,swapAfter:Infinity,totalDurationNs:"secret",address:"private",
   names:["private"],values:{private:"payload"},get maxStepDurationNs(){reads++;throw new Error("getter");}};
 owned={isRunning:true,isBusy:false,coldMemoryStats:stats};
 const result=handlers["kernel.status"]();
 assert.deepEqual(result,{running:true,busy:false,restore,coldMemory:{version:1,state:"complete",calls:2,markedBytes:4096,pageoutBytes:2048}});
 assert.equal(reads,0);result.coldMemory.calls=99;assert.equal(stats.calls,2);
 stats.state="private-error-text";assert.equal(handlers["kernel.status"]().coldMemory.state,"unavailable");
 stats.state="unsupported";assert.equal(handlers["kernel.status"]().coldMemory.state,"unsupported");
 owned.isRunning=false;assert.deepEqual(handlers["kernel.status"](),{running:false,busy:false,restore});
});
