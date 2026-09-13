import assert from "node:assert/strict";
import test from "node:test";
import { loadExternalPi } from "../src/external-pi.mjs";
import { createActorStreamPlanner, ACTOR_STREAM_LIMITS } from "../src/actor-stream.mjs";
import { projectCanonicalContext, THINKING_SIGNATURE_CUSTOM_TYPE } from "../src/canonical-context.mjs";
import { createNativeProviderAdapter } from "../src/native-provider.mjs";

// Tests require an explicitly selected stock 0.85.1 public SDK/API graph.
const { sdk, api, responsesApi } = await loadExternalPi();
const clone = structuredClone;
const usage = () => ({ input: 10, output: 20, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 37,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } });
const message = (content = [], stopReason = "pending") => ({ role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", content,
  timestamp: 12, usage: usage(), stopReason, responseId: "resp", responseModel: "actual-model", providerThinkingLevel: "high", rawStopReason: "in_progress" });
const call = (letter, native = true) => ({ type: "toolCall", id: `call${letter}|item${letter}`, name: "fixture", arguments: { letter, nested: [1, "x"] },
  providerCallId: `call${letter}`, providerItemId: `item${letter}`, ...(native ? { async: true } : {}), thoughtSignature: "opaque-call", namespace: "fixture" });
const receipt = c => ({ native: true, complete: true, responseId: "resp", callId: c.providerCallId, itemId: c.providerItemId, call: clone(c) });
const reason = encrypted => ({ type: "thinking", thinking: "body", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs", summary: [{ type: "summary_text", text: "body" }],
  ...(encrypted === undefined ? {} : { encrypted_content: encrypted }) }) });
const text = value => ({ type: "text", text: value, textSignature: '{"v":1,"id":"provider-text","phase":"commentary"}' });
function fixture(content = []) {
  const raw = message(content), base = { ...message(), id: "core0", timestamp: 99 };
  const p = createActorStreamPlanner({ message: base, createMessageId: ({ segmentIndex }) => `core${segmentIndex}`, createTextId: ({ sourceIndex }) => `text${sourceIndex}` });
  const entries = [], plans = [];
  function emit(type, index, proof = null, extra = {}) {
    return p.consume({ type, partial: raw, ...(index === undefined ? {} : { contentIndex: index }),
      ...(type === "toolcall_end" ? { toolCall: raw.content[index] } : {}),
      ...(["text_end", "thinking_end"].includes(type) ? { content: raw.content[index][type.split("_")[0]] } : {}), ...extra }, proof);
  }
  function commit(plan) {
    plans.push(plan); const entryId = `entry${entries.length}`;
    entries.push({ type: "message", id: entryId, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(0).toISOString(), message: clone(plan.message) });
    return p.acknowledge({ planId: plan.planId, entryId, message: clone(plan.message) });
  }
  function terminal(stopReason = "toolUse") {
    raw.stopReason = stopReason;
    return p.consume(["error", "aborted"].includes(stopReason) ? { type: "error", reason: stopReason, error: raw } : { type: "done", reason: stopReason, message: raw });
  }
  return { p, raw, emit, commit, terminal, entries, plans };
}
function starts(f) {
  f.emit("start"); f.raw.content.forEach((b, i) => f.emit(`${b.type === "toolCall" ? "toolcall" : b.type}_start`, i));
}
function fault(fn, code) { assert.throws(fn, error => error.code === code); }

test("out-of-order B completion cannot commit partial A; acknowledgement releases A,B once in source order", () => {
  const a = call("A"), b = call("B"), f = fixture([a, b]); starts(f);
  assert.equal(f.emit("toolcall_end", 1, receipt(b)).prefix, undefined);
  const r = f.emit("toolcall_end", 0, receipt(a));
  assert.deepEqual(r.prefix.message.content, [a, b]);
  assert.deepEqual(f.commit(r.prefix).calls.map(c => c.call.id), [a.id, b.id]);
  const done = f.terminal(); assert.deepEqual(done.final.message.content, []);
  assert.deepEqual(f.commit(done.final).calls, []);
  assert.equal(f.plans[0].message.usage.totalTokens, 0);
  assert.deepEqual(f.plans[1].message.usage, usage());
  assert.equal(f.plans[1].message.responseModel, "actual-model");
  assert.equal(f.plans[1].message.providerThinkingLevel, "high");
});

test("closed preceding text/thinking required; shared live partial cannot close blocks", () => {
  for (const preceding of [text("complete"), reason()]) {
    const c = call("A"), f = fixture([preceding, c]); starts(f);
    const body = preceding.type;
    const delta = f.emit(`${body}_delta`, 0, null, { delta: body === "text" ? "com" : "bo" });
    assert.equal(delta.update.message.content[0][body], body === "text" ? "com" : "bo");
    assert.equal(f.emit("toolcall_end", 1, receipt(c)).prefix, undefined);
    const end = f.emit(`${body}_end`, 0);
    assert.equal(end.prefix.message.content[0][body], preceding[body]);
    assert.deepEqual(f.commit(end.prefix).calls.map(v => v.call.id), [c.id]);
  }
});

test("ordinary/native mixed barrier pairs preserve source order and normalize unproved markers", () => {
  for (const native of [[false, true], [true, false], [false, false], [true, true]]) {
    const values = [call("A"), call("B")], f = fixture(values); starts(f);
    const admitted = [];
    for (const i of [1, 0]) {
      const r = f.emit("toolcall_end", i, native[i] ? receipt(values[i]) : null);
      if (r.prefix) admitted.push(...f.commit(r.prefix).calls);
    }
    const end = f.terminal(); admitted.push(...f.commit(end.final).calls);
    assert.deepEqual(admitted.map(c => c.call.id), values.map(c => c.id));
    assert.deepEqual(admitted.map(c => c.native), native);
    assert.deepEqual(admitted.map(c => c.call.async === true), native);
    assert.deepEqual(values.map(c => c.async), [true, true], "input remains untouched");
  }
});

test("terminal-only ordinary calls accepted; serialized markers never create native receipt", () => {
  const f = fixture([call("A")]); f.emit("start");
  const end = f.terminal(); const [c] = f.commit(end.final).calls;
  assert.equal(c.native, false); assert.equal(c.disposition, "execute"); assert.equal(c.call.async, undefined);
  assert.equal(c.call.providerCallId, "callA"); assert.deepEqual(c.call.arguments, call("A").arguments);
});

test("length retains blocked intents but no native admission; failure retains partial remainder without calls", () => {
  for (const stop of ["length", "error", "aborted"]) {
    const values = [call("A", false), call("B")], f = fixture(values); starts(f);
    f.emit("toolcall_end", 1, receipt(values[1]));
    const end = f.terminal(stop), ack = f.commit(end.final);
    assert.deepEqual(end.final.message.content.map(c => c.async), [undefined, undefined]);
    assert.deepEqual(end.final.message.content.map(c => c.arguments), values.map(c => c.arguments));
    if (stop === "length") assert.deepEqual(ack.calls.map(c => [c.native, c.disposition]), [[false, "blocked_truncated"], [false, "blocked_truncated"]]);
    else assert.deepEqual(ack.calls, []);
  }
});

test("failed remainder never erases acknowledged call prefix; text and message IDs stay stable", () => {
  for (const stop of ["error", "aborted"]) {
    const c = call("A"), f = fixture([text("before"), c, text("after")]); starts(f);
    f.emit("text_end", 0);
    const first = f.emit("toolcall_end", 1, receipt(c));
    assert.equal(first.update.message.id, "core0"); assert.equal(first.prefix.message.content[0].id, "text0");
    f.commit(first.prefix); const bytes = JSON.stringify(f.entries);
    const tail = f.emit("text_delta", 2, null, { delta: "af" });
    assert.equal(tail.update.message.id, "core1"); assert.equal(tail.update.message.content[0].id, "text2");
    assert.equal(tail.update.assistantMessageEvent.contentIndex, 0);
    const final = f.terminal(stop); assert.equal(final.final.message.id, "core1");
    assert.equal(final.final.message.content[0].id, "text2");
    assert.equal(final.final.message.content[0].textSignature, text("").textSignature);
    assert.equal(JSON.stringify(f.entries), bytes); assert.deepEqual(f.commit(final.final).calls, []);
  }
});

test("late encryption emits canonical custom metadata bound to exact entry and LOCAL thinking index", () => {
  const a = call("A"), b = call("B"), f = fixture([a, reason(), b]); starts(f);
  f.commit(f.emit("toolcall_end", 0, receipt(a)).prefix);
  f.emit("thinking_end", 1); const second = f.emit("toolcall_end", 2, receipt(b)); f.commit(second.prefix);
  const bytes = JSON.stringify(f.entries); f.raw.content[1] = reason("encrypted");
  const end = f.terminal();
  assert.deepEqual(end.amendments, [{ customType: THINKING_SIGNATURE_CUSTOM_TYPE, data: { version: 1,
    messageEntryId: "entry1", messageId: "core1", contentIndex: 0, itemId: "rs", encryptedContent: "encrypted" } }]);
  assert.equal(JSON.stringify(f.entries), bytes);
  const metadata = { type: "custom", id: "sig", parentId: "entry1", timestamp: new Date(0).toISOString(), ...end.amendments[0] };
  const projected = projectCanonicalContext({ entries: [...f.entries, metadata], leafId: "sig", buildSessionContext: sdk.buildSessionContext, mode: "native" });
  assert.equal(JSON.parse(projected.messages[1].content[0].thinkingSignature).encrypted_content, "encrypted");
  assert.equal(JSON.stringify(f.entries), bytes);
});

test("same signature is not amended; uncommitted late encryption remains in final message", () => {
  for (const initial of [undefined, "already"]) {
    const f = fixture([reason(initial)]); starts(f); f.emit("thinking_end", 0);
    f.raw.content[0] = reason(initial ?? "late"); const end = f.terminal("stop");
    assert.deepEqual(end.amendments, []);
    assert.equal(JSON.parse(end.final.message.content[0].thinkingSignature).encrypted_content, initial ?? "late");
  }
});

test("late reasoning conflicts reject item/body/other fields/encryption/duplicate JSON keys", () => {
  const mutations = [
    b => ({ ...b, thinking: "other body" }),
    b => ({ ...b, redacted: true }),
    b => ({ ...b, thinkingSignature: JSON.stringify({ ...JSON.parse(b.thinkingSignature), id: "wrong", encrypted_content: "x" }) }),
    b => ({ ...b, thinkingSignature: JSON.stringify({ ...JSON.parse(b.thinkingSignature), status: "new", encrypted_content: "x" }) }),
    b => ({ ...b, thinkingSignature: '{"type":"reasoning","id":"rs","id":"rs","encrypted_content":"x"}' }),
    b => ({ ...b, thinkingSignature: "opaque non-JSON" }),
  ];
  for (const mutate of mutations) {
    const c = call("A"), f = fixture([reason(), c]); starts(f); f.emit("thinking_end", 0); f.commit(f.emit("toolcall_end", 1, receipt(c)).prefix);
    const bytes = JSON.stringify(f.entries); f.raw.content[0] = mutate(reason()); assert.throws(() => f.terminal()); assert.equal(JSON.stringify(f.entries), bytes);
  }
  const f = fixture([reason("first"), call("A")]); starts(f); f.emit("thinking_end", 0); f.commit(f.emit("toolcall_end", 1, receipt(call("A"))).prefix);
  f.raw.content[0] = reason("second"); fault(() => f.terminal(), "ERR_STREAM_REASONING_ENCRYPTION_CONFLICT");
});

test("receipt immutable and exact; changed terminal calls and mismatched proof rejected", () => {
  const c = call("A"), f = fixture([c]); starts(f);
  const proof = receipt(c), r = f.emit("toolcall_end", 0, proof); f.commit(r.prefix);
  proof.call.arguments.nested.push("changed"); assert.deepEqual(r.prefix.message.content[0].arguments.nested, [1, "x"]);
  f.raw.content[0].arguments.nested.push("changed"); fault(() => f.terminal(), "ERR_STREAM_PROVED_CALL_CHANGED");
  const g = fixture([call("A")]); starts(g);
  fault(() => g.emit("toolcall_end", 0, receipt(call("B"))), "ERR_STREAM_PROOF_MISMATCH");
});

test("commit acknowledgement required; canceled epochs cannot release admission; exact ack rejects changed canonical data", () => {
  for (const mode of ["cancel", "change", "skipAck"]) {
    const f = fixture([call("A")]); starts(f); const r = f.emit("toolcall_end", 0, receipt(call("A")));
    if (mode === "cancel") { f.p.cancel(); fault(() => f.commit(r.prefix), "ERR_STREAM_CANCELED"); }
    if (mode === "change") fault(() => f.p.acknowledge({ planId: r.prefix.planId, entryId: "entry", message: { ...r.prefix.message, id: "changed" } }), "ERR_STREAM_COMMIT_MISMATCH");
    if (mode === "skipAck") fault(() => f.terminal(), "ERR_STREAM_ACK_REQUIRED");
  }
});

test("duplicate start/end/terminal, reused source call identity and invalid index reject", () => {
  const a = fixture(); a.emit("start"); fault(() => a.emit("start"), "ERR_STREAM_DUPLICATE_START");
  const b = fixture([text("x")]); starts(b); b.emit("text_end", 0); fault(() => b.emit("text_end", 0), "ERR_STREAM_DUPLICATE_END");
  const c = fixture(); c.emit("start"); c.commit(c.terminal("stop").final); fault(() => c.terminal("stop"), "ERR_STREAM_TERMINAL");
  const d = fixture([call("A"), call("A")]); starts(d); assert.throws(() => {
    for (let i = 0; i < 2; i++) { const r = d.emit("toolcall_end", i, receipt(call("A"))); if (r.prefix) d.commit(r.prefix); }
  }, "reuse must fail before another admission");
  const e = fixture([text("x")]); e.emit("start"); fault(() => e.emit("text_start", -1), "ERR_STREAM_CONTENT_INDEX");
});

test("bounded plain data rejects accessors/cycles/sparse arrays without invoking user code", () => {
  const f = fixture(); let invoked = false;
  const event = { type: "start", get partial() { invoked = true; return message(); } };
  fault(() => f.p.consume(event), "ERR_STREAM_DATA_TYPE"); assert.equal(invoked, false);
  const g = fixture(); const cyclic = message(); cyclic.extra = cyclic;
  fault(() => g.p.consume({ type: "start", partial: cyclic }), "ERR_STREAM_DATA_TYPE");
  const h = fixture(); const sparse = message(new Array(3)); fault(() => h.p.consume({ type: "start", partial: sparse }), "ERR_STREAM_DATA_TYPE");
  const i = fixture(Array.from({ length: ACTOR_STREAM_LIMITS.contentBlocks + 1 }, () => text("")));
  fault(() => i.emit("start"), "ERR_STREAM_MESSAGE");
});

test("pre-start setup error is retained without admissions; done before start rejects", () => {
  const f = fixture(); f.raw.errorMessage = "setup failure";
  const r = f.terminal("error"); assert.equal(r.final.message.errorMessage, "setup failure"); assert.deepEqual(f.commit(r.final).calls, []);
  const g = fixture(); fault(() => g.terminal("stop"), "ERR_STREAM_START_REQUIRED");
});


test("48 completion/native-mode permutations emit every source call exactly once", () => {
  const orders = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  for (const order of orders) for (let mask = 0; mask < 8; mask++) {
    const values = [call("A"),call("B"),call("C")], f = fixture(values); starts(f); const calls = [];
    for (const i of order) {
      const r = f.emit("toolcall_end", i, mask & (1 << i) ? receipt(values[i]) : null);
      if (r.prefix) calls.push(...f.commit(r.prefix).calls);
    }
    calls.push(...f.commit(f.terminal().final).calls);
    assert.deepEqual(calls.map(c => c.call.id), values.map(c => c.id));
    assert.deepEqual(calls.map(c => c.native), values.map((_,i) => Boolean(mask & (1<<i))));
    assert.equal(new Set(calls.map(c => c.call.id)).size, 3);
  }
});

test("real public Responses parser + native adapter: B before A, committed reasoning, late terminal encryption", async (t) => {
  let controller, requestCount = 0, fallbackCount = 0;
  const encoder = new TextEncoder();
  const send = frames => controller.enqueue(encoder.encode(frames.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")));
  const model = { id: "fixture", provider: "fixture", api: "openai-responses", baseUrl: "http://127.0.0.1:1", reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 4096, compat: { supportsAsyncTools: true } };
  const adapter = createNativeProviderAdapter({ api, responsesApi, modelRuntime: { getAuth: async () => ({auth:{}}), streamSimple(){fallbackCount++; throw new Error("unexpected fallback");} },
    transportOptions: { fetch: async (url, init) => {
      assert.equal(new URL(url).hostname, "127.0.0.1"); requestCount++;
      assert.equal(JSON.parse(init.body).tools[0].async, true);
      return new Response(new ReadableStream({ start(c){ controller = c; } }), {headers:{"content-type":"text/event-stream"}});
    } } });
  t.after(() => adapter.close());
  const rawReason = {type:"reasoning",id:"rs",summary:[{type:"summary_text",text:"body"}]};
  const rawText = {type:"message",id:"provider-text",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"body text",annotations:[]}]};
  const rawCall = x => ({type:"function_call",id:`item${x}`,call_id:`call${x}`,name:"fixture",arguments:JSON.stringify({x}),async:true});
  const a = rawCall("A"), b = rawCall("B");
  const stream = adapter.stream(model,{messages:[{role:"user",content:"fixture",timestamp:1}],tools:[{name:"fixture",description:"fixture",async:true,parameters:{type:"object",properties:{x:{type:"string"}},required:["x"]}}]},{transport:"sse"});
  const f = fixture(); const completionOrder = [], admitted = []; let amendments;
  // Wait only for our injected stream to exist, not a provider or external socket.
  while (!controller) await new Promise(resolve => setImmediate(resolve));
  send([{type:"response.created",response:{id:"resp",status:"in_progress"}},
    ...[rawReason,rawText,a,b].map((item,output_index)=>({type:"response.output_item.added",output_index,item})),
    {type:"response.output_item.done",output_index:3,item:b},
    {type:"response.output_item.done",output_index:0,item:rawReason},
    {type:"response.output_item.done",output_index:1,item:rawText},
    {type:"response.output_item.done",output_index:2,item:a}]);
  for await (const event of stream) {
    const proof = adapter.nativeCompletion(event);
    if (event.type === "toolcall_end") {
      completionOrder.push(event.contentIndex); assert.ok(proof);
      assert.equal(adapter.nativeCompletion(clone(event)), null, "private event identity is not serializable");
    }
    const planned = f.p.consume(event, proof);
    if (planned.prefix) {
      admitted.push(...f.commit(planned.prefix).calls);
      assert.equal(JSON.parse(planned.prefix.message.content[0].thinkingSignature).encrypted_content,undefined);
      send([{type:"response.completed",response:{id:"resp",status:"completed",output:[{...rawReason,encrypted_content:"late-cipher"},rawText,a,b],
        usage:{input_tokens:10,output_tokens:5,total_tokens:15}}}]); controller.close();
    }
    if (planned.final) { amendments = planned.amendments; f.commit(planned.final); }
  }
  assert.deepEqual(completionOrder,[3,2]); assert.deepEqual(admitted.map(c=>c.call.id),["callA|itemA","callB|itemB"]);
  assert.deepEqual(admitted.map(c=>c.native),[true,true]);
  assert.deepEqual(amendments,[{customType:THINKING_SIGNATURE_CUSTOM_TYPE,data:{version:1,messageEntryId:"entry0",messageId:"core0",contentIndex:0,itemId:"rs",encryptedContent:"late-cipher"}}]);
  assert.equal(f.plans[1].message.nativeTransport.version,1); assert.equal(f.plans[1].message.usage.totalTokens,15);
  assert.equal(requestCount,1); assert.equal(fallbackCount,0);
});

test("real public native adapter synthesizes standard completion events for terminal-only raw calls", async (t) => {
  const model = { id:"fixture",provider:"fixture",api:"openai-responses",baseUrl:"http://127.0.0.1:1",reasoning:false,input:["text"],
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:1024,compat:{supportsAsyncTools:true} };
  const rawCall={type:"function_call",id:"itemA",call_id:"callA",name:"fixture",arguments:'{"x":1}',async:true};
  const frames=[{type:"response.created",response:{id:"resp",status:"in_progress"}},
    {type:"response.completed",response:{id:"resp",status:"completed",output:[rawCall]}}];
  const adapter=createNativeProviderAdapter({api,responsesApi,modelRuntime:{getAuth:async()=>({auth:{}})},transportOptions:{fetch:async()=>new Response(frames.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(""))}});
  t.after(()=>adapter.close()); const f=fixture(), calls=[];
  for await(const event of adapter.stream(model,{messages:[],tools:[{name:"fixture",description:"fixture",async:true,parameters:{type:"object",properties:{}}}]},{transport:"sse"})) {
    const r=f.p.consume(event,adapter.nativeCompletion(event));
    if(r.prefix) calls.push(...f.commit(r.prefix).calls);
    if(r.final) calls.push(...f.commit(r.final).calls);
  }
  assert.equal(calls.length,1); assert.equal(calls[0].native,true); assert.equal(calls[0].call.id,"callA|itemA");
});

test("public faux ordinary streaming preserves authoritative text/thinking and terminal-only execution barrier", async () => {
  const faux = api.fauxProvider();
  faux.setResponses([api.fauxAssistantMessage([api.fauxText("text"),api.fauxThinking("reason"),api.fauxToolCall("fixture",{arg:"value"})],{stopReason:"toolUse"})]);
  const model=faux.getModel();
  const p=createActorStreamPlanner({message:{...message(),id:"core",api:model.api,provider:model.provider,model:model.id},createMessageId:()=>"next",createTextId:()=>"text"});
  const models=api.createModels(); models.setProvider(faux.provider); let prefixCount=0, final;
  for await(const event of models.streamSimple(model,{messages:[{role:"user",content:"fixture",timestamp:0}]})) {
    const r=p.consume(event); if(r.prefix) prefixCount++;
    if(r.final) { final=r.final; assert.equal(p.acknowledge({planId:final.planId,entryId:"entry",message:final.message}).calls[0].native,false); }
  }
  assert.equal(prefixCount,0); assert.deepEqual(final.message.content.slice(0,2).map(b=>b.text??b.thinking),["text","reason"]);
});


test("source/response/usage validation fails before further prefix admission", () => {
  const f = fixture([call("A"),call("B")]); starts(f); f.commit(f.emit("toolcall_end",0,receipt(call("A"))).prefix);
  f.raw.content[0].arguments.changed=true; fault(()=>f.emit("toolcall_end",1,receipt(call("B"))),"ERR_STREAM_PROVED_CALL_CHANGED");
  const g = fixture([call("A")]); starts(g); g.raw.responseId="other";
  fault(()=>g.emit("toolcall_end",0,receipt(call("A"))),"ERR_STREAM_RESPONSE_CHANGED");
  const h=fixture(); h.emit("start"); delete h.raw.usage.cost;
  fault(()=>h.terminal("stop"),"ERR_STREAM_USAGE");
  const i=fixture([reason(),reason()]); i.emit("start");
  fault(()=>i.terminal("stop"),"ERR_STREAM_DUPLICATE_REASONING_ID");
});

test("queued shared partial updates use authoritative ends; no duplicated text/deltas", () => {
  const f=fixture([text("abcd"),call("A")]); starts(f);
  const body=[];
  for(const delta of ["a","b","c","d"]) body.push(f.emit("text_delta",0,null,{delta}).update.message.content[0].text);
  assert.deepEqual(body,["a","ab","abc","abcd"]);
  f.emit("text_end",0); const r=f.emit("toolcall_end",1,receipt(call("A")));
  assert.equal(r.prefix.message.content[0].text,"abcd");
  assert.equal(r.prefix.message.content[0].textSignature,text("").textSignature);
});

test("cancel before events and after acknowledgement preserves commits and blocks stale events", () => {
  const first=fixture(); first.p.cancel(); fault(()=>first.emit("start"),"ERR_STREAM_CANCELED");
  const f=fixture([call("A")]); starts(f); f.commit(f.emit("toolcall_end",0,receipt(call("A"))).prefix);
  const bytes=JSON.stringify(f.entries); f.p.cancel(); fault(()=>f.terminal(),"ERR_STREAM_CANCELED"); assert.equal(JSON.stringify(f.entries),bytes);
});

test("signature/data bounds, ordinary opaque signatures, images, and factory IDs preserve explicit contracts", () => {
  const f=fixture([reason()]); f.raw.content[0].thinkingSignature="x".repeat(ACTOR_STREAM_LIMITS.signatureCodeUnits+1); f.emit("start");
  fault(()=>f.emit("thinking_start",0),"ERR_STREAM_SIGNATURE_LIMIT");
  const g=fixture([{type:"image",data:"AA==",mimeType:"image/png",provenance:{fixture:true}}]); g.emit("start");
  assert.deepEqual(g.terminal("stop").final.message.content,g.raw.content);
  const p=createActorStreamPlanner({message:{...message(),api:"anthropic-messages",id:"core"},createMessageId:()=>"next",createTextId:()=>"text"});
  const raw={...message([{type:"thinking",thinking:"",redacted:true,thinkingSignature:"opaque"}]),api:"anthropic-messages"};
  p.consume({type:"start",partial:raw}); p.consume({type:"thinking_start",contentIndex:0,partial:raw});
  p.consume({type:"thinking_end",contentIndex:0,content:"",partial:raw}); raw.stopReason="stop";
  assert.equal(p.consume({type:"done",reason:"stop",message:raw}).final.message.content[0].thinkingSignature,"opaque");
  const q=createActorStreamPlanner({message:{...message(),id:"core"},createMessageId:()=>"core",createTextId:()=>"text"});
  const r=message([call("A")]); q.consume({type:"start",partial:r}); q.consume({type:"toolcall_start",contentIndex:0,partial:r});
  fault(()=>q.consume({type:"toolcall_end",contentIndex:0,partial:r,toolCall:r.content[0]},receipt(r.content[0])),"ERR_STREAM_DUPLICATE_CORE_ID");
});


test("prepareCommit accepts text/usage/error normalization before prefix append; late anchors stay exact", () => {
  const f=fixture([text("raw"),reason(),call("A")]); starts(f); f.emit("text_end",0); f.emit("thinking_end",1);
  const plan=f.emit("toolcall_end",2,receipt(call("A"))).prefix;
  const replacement=clone(plan.message); replacement.content[0]={type:"text",text:"normalized"};
  replacement.usage=usage(); replacement.errorMessage="normalized diagnostic";
  assert.equal(f.entries.length,0);
  const prepared=f.p.prepareCommit({planId:plan.planId,message:replacement});
  assert.equal(f.entries.length,0,"pure validation does not append");
  assert.equal(prepared.message.content[0].id,"text0");
  assert.equal(prepared.message.content[0].textSignature,text("").textSignature);
  assert.equal(replacement.content[0].id,undefined,"caller hook output is not mutated");
  assert.equal(plan.message.content[0].text,"raw","original plan is not rewritten");
  assert.deepEqual(f.commit(prepared).calls.map(c=>c.native),[true]);
  assert.equal(f.entries[0].message.content[0].text,"normalized");
  f.raw.content[1]=reason("cipher"); const done=f.terminal();
  assert.equal(done.amendments[0].data.messageEntryId,"entry0");
  assert.equal(done.amendments[0].data.contentIndex,1);
  assert.equal(f.entries[0].message.content[0].text,"normalized");
});

test("unsafe prefix hook changes reject BEFORE append", () => {
  const changes=[
    m=>{m.id="different";}, m=>{m.responseId="different";}, m=>{m.timestamp++;},
    m=>{m.content[2].arguments.changed=true;}, m=>{m.content[2].providerCallId="different";},
    m=>{m.content[1].thinking="different";}, m=>{m.content[1].thinkingSignature=reason("cipher").thinkingSignature;},
    m=>{m.content[0].id="different";}, m=>{m.content[0].textSignature="different";},
    m=>{m.content.reverse();}, m=>{m.content.pop();}, m=>{m.stopReason="error";}, m=>{m.usage.input=-1;},
  ];
  for(const change of changes) {
    const f=fixture([text("raw"),reason(),call("A")]); starts(f); f.emit("text_end",0); f.emit("thinking_end",1);
    const plan=f.emit("toolcall_end",2,receipt(call("A"))).prefix, replacement=clone(plan.message); change(replacement);
    let appends=0;
    assert.throws(()=>{const accepted=f.p.prepareCommit({planId:plan.planId,message:replacement}); appends++; f.commit(accepted);});
    assert.equal(appends,0); assert.equal(f.entries.length,0);
  }
});

test("ordinary final hook additions/removals/edits recompute exact native admission", () => {
  for(const changeNative of [false,true]) {
    const f=fixture([text("raw"),call("A",false),call("B")]); starts(f); f.emit("text_end",0);
    f.emit("toolcall_end",2,receipt(call("B"))); const plan=f.terminal().final;
    const replacement=clone(plan.message);
    replacement.content[0].text="clean";
    replacement.content[1]={...call("C"),async:true};
    if(changeNative) replacement.content[2].arguments.changed=true;
    const accepted=f.p.prepareCommit({planId:plan.planId,message:replacement});
    assert.deepEqual(accepted.calls.map(c=>[c.call.id,c.native,c.sourceIndex,c.contentIndex]),[
      ["callC|itemC",false,null,1],["callB|itemB",!changeNative,2,2],
    ]);
    assert.equal(accepted.message.content[1].async,undefined);
    assert.equal(accepted.message.content[2].async,changeNative?undefined:true);
    assert.deepEqual(f.commit(accepted).calls,accepted.calls);
  }
  const f=fixture([text("raw"),call("A",false)]); f.emit("start"); const plan=f.terminal().final;
  const replacement=clone(plan.message); replacement.content.splice(1); replacement.stopReason="stop";
  const accepted=f.p.prepareCommit({planId:plan.planId,message:replacement}); assert.deepEqual(f.commit(accepted).calls,[]);
});

test("final hook stop normalization blocks calls and cannot upgrade unsuccessful source outcomes", () => {
  for(const stop of ["error","aborted","length"]) {
    const f=fixture([call("A")]); f.emit("start"); const plan=f.terminal().final;
    const accepted=f.p.prepareCommit({planId:plan.planId,message:{...plan.message,stopReason:stop,errorMessage:"normalized"}});
    assert.equal(accepted.message.content[0].async,undefined);
    assert.deepEqual(f.commit(accepted).calls.map(c=>c.disposition),stop==="length"?["blocked_truncated"]:[]);
  }
  for(const stop of ["error","aborted","length","deferred"]) {
    const f=fixture([call("A")]); f.emit("start"); const plan=f.terminal(stop).final;
    fault(()=>f.p.prepareCommit({planId:plan.planId,message:{...plan.message,stopReason:"toolUse"}}),"ERR_STREAM_UNSAFE_STOP_UPGRADE");
    assert.equal(f.entries.length,0);
  }
});

test("hook duplicate/native-order/committed-ID conflicts and unsupported non-call layouts reject before append", () => {
  const f=fixture([call("A",false),call("B"),call("C")]); starts(f);
  f.emit("toolcall_end",1,receipt(call("B"))); f.emit("toolcall_end",2,receipt(call("C")));
  const plan=f.terminal().final, changed=clone(plan.message); changed.content.reverse();
  fault(()=>f.p.prepareCommit({planId:plan.planId,message:changed}),"ERR_STREAM_NATIVE_SOURCE_ORDER"); assert.equal(f.entries.length,0);
  const g=fixture([call("A",false)]); g.emit("start"); const final=g.terminal().final;
  const dup=clone(final.message); dup.content.push(clone(dup.content[0]));
  fault(()=>g.p.prepareCommit({planId:final.planId,message:dup}),"ERR_STREAM_DUPLICATE_CALL_ID");
  const h=fixture([call("A")]); starts(h); h.commit(h.emit("toolcall_end",0,receipt(call("A"))).prefix); const tail=h.terminal().final;
  fault(()=>h.p.prepareCommit({planId:tail.planId,message:{...tail.message,content:[call("A")]}}),"ERR_STREAM_DUPLICATE_CALL_ID");
  const i=fixture([text("original")]); i.emit("start"); const textPlan=i.terminal("stop").final;
  fault(()=>i.p.prepareCommit({planId:textPlan.planId,message:{...textPlan.message,content:[]}}),"ERR_STREAM_UNSUPPORTED_NONCALL_LAYOUT");
});

test("prepared-plan acknowledgment stays exact; repeat prepare/canceled prepare/accessor inputs reject", () => {
  for(const mode of ["changedAck","repeat","cancel","getter"]) {
    const f=fixture([text("raw")]); f.emit("start"); const plan=f.terminal("stop").final;
    if(mode==="cancel") {f.p.cancel(); fault(()=>f.p.prepareCommit({planId:plan.planId,message:plan.message}),"ERR_STREAM_CANCELED");continue;}
    if(mode==="getter") {let read=false;fault(()=>f.p.prepareCommit({planId:plan.planId,get message(){read=true;return plan.message;}}),"ERR_STREAM_DATA_TYPE");assert.equal(read,false);continue;}
    const replacement=clone(plan.message); replacement.content[0].text="changed";
    const accepted=f.p.prepareCommit({planId:plan.planId,message:replacement});
    if(mode==="repeat") fault(()=>f.p.prepareCommit({planId:plan.planId,message:accepted.message}),"ERR_STREAM_PREPARE_PLAN");
    else fault(()=>f.p.acknowledge({planId:plan.planId,entryId:"entry",message:plan.message}),"ERR_STREAM_COMMIT_MISMATCH");
  }
});

test("public STOCK message_end replacement/in-place hooks each run once before prepareCommit and sole append", async (t) => {
  const {mkdtemp,rm}=await import("node:fs/promises"); const {tmpdir}=await import("node:os"); const {join}=await import("node:path");
  const root=await mkdtemp(join(tmpdir(),"actor-stream-hook-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const models=await sdk.ModelRuntime.create({credentials:new api.InMemoryCredentialStore(),modelsStore:new api.InMemoryModelsStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  for(const replacement of [true,false]) {
    const manager=sdk.SessionManager.inMemory(root), settings=sdk.SettingsManager.inMemory(); let hooks=0;
    const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:join(root,"agent"),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
      extensionFactories:[pi=>pi.on("message_end",event=>{
        hooks++; assert.equal(manager.getEntries().length,0);
        const message={...event.message,usage:usage(),errorMessage:"normalized",content:[{type:"text",text:"hook text"}]};
        if(replacement) return {message};
        Object.assign(event.message,message);
      })]});
    await loader.reload(); const loaded=loader.getExtensions();
    const runner=new sdk.ExtensionRunner(loaded.extensions,loaded.runtime,root,manager,new sdk.ModelRegistry(models));
    const f=fixture([text("source")]); f.emit("start"); const plan=f.terminal("stop").final;
    const candidate=clone(plan.message), hookResult=await runner.emitMessageEnd({type:"message_end",message:candidate});
    assert.equal(hookResult===undefined,!replacement);
    const accepted=f.p.prepareCommit({planId:plan.planId,message:hookResult??candidate});
    assert.equal(manager.getEntries().length,0); assert.equal(hooks,1);
    const entryId=manager.appendMessage(accepted.message);
    assert.deepEqual(f.p.acknowledge({planId:accepted.planId,entryId,message:manager.getEntry(entryId).message}).calls,[]);
    assert.equal(manager.getEntries().length,1); assert.equal(manager.getEntry(entryId).message.content[0].text,"hook text");
    assert.equal(manager.getEntry(entryId).message.content[0].id,"text0"); assert.equal(hooks,1);
    assert.equal(plan.message.content[0].text,"source");
  }
});


test("ack immediately rebases observed open text without a future provider event or duplicated delta", () => {
  for (const outcome of ["stop", "toolUse", "error", "aborted", "length", "deferred"]) {
    const c = call("A"), f = fixture([text("A"), c, text("B")]); starts(f);
    f.emit("text_delta", 0, null, { delta: "A" }); f.emit("text_end", 0);
    const firstB = f.emit("text_delta", 2, null, { delta: "B" });
    const bId = firstB.update.message.content[2].id;
    // A shared partial has advanced further than delivered B deltas. Do not
    // leak B2 or an unobserved future block into the immediate rebase snapshot.
    f.raw.content[2] = text("B2"); f.raw.content.push(text("not observed yet"));
    const step = f.emit("toolcall_end", 1, receipt(c));
    assert.equal(step.remainder, undefined, "not published before actual canonical commit");
    const ack = f.commit(step.prefix), before = JSON.stringify(f.entries);
    assert.deepEqual(ack.calls.map(item => item.call.id), [c.id]);
    assert.equal(ack.remainder.id, "core1"); assert.equal(ack.remainder.timestamp, 99);
    assert.equal(ack.remainder.stopReason, "pending"); assert.equal(ack.remainder.usage.totalTokens, 0);
    assert.deepEqual(ack.remainder.content, [{ ...text("B"), id: bId }]);
    assert.equal(ack.remainder.responseId, "resp");
    assert(Object.isFrozen(ack.remainder.content[0]));
    // This is display state only, never a second prefix or tool admission.
    assert.equal(f.entries.length, 1); assert.equal(ack.remainder.content.some(block => block.type === "toolCall"), false);
    f.raw.content.pop();
    const next = f.emit("text_delta", 2, null, { delta: "2" });
    assert.equal(next.update.message.id, ack.remainder.id);
    assert.equal(next.update.assistantMessageEvent.contentIndex, 0);
    assert.equal(next.update.message.content[0].id, bId);
    assert.equal(next.update.message.content[0].text, "B2");
    assert.equal(ack.remainder.content[0].text, "B", "detached from later slot updates");
    f.emit("text_end", 2);
    const end = f.terminal(outcome);
    assert.equal(end.final.message.id, ack.remainder.id);
    assert.equal(end.final.message.content[0].id, bId);
    assert.equal(end.final.message.content[0].text, "B2");
    assert.equal(JSON.stringify(f.entries), before, "all terminal outcomes retain original prefix");
    const finalAck = f.commit(end.final);
    assert.deepEqual(finalAck.calls, []); assert.equal(finalAck.remainder, undefined);
  }
});

test("rebase snapshot stays behind exact ack, hook validation and cancellation; no unobserved phantom start", () => {
  for (const operation of ["cancel", "wrongAck", "badHook"]) {
    const c = call("A"), f = fixture([c, text("B")]); starts(f);
    f.emit("text_delta", 1, null, { delta: "B" });
    const plan = f.emit("toolcall_end", 0, receipt(c)).prefix;
    const acknowledgment = () => f.p.acknowledge({ planId: plan.planId, entryId: "entry", message: clone(plan.message) });
    if (operation === "cancel") { f.p.cancel(); fault(acknowledgment, "ERR_STREAM_CANCELED"); }
    if (operation === "wrongAck") fault(() => f.p.acknowledge({ planId: plan.planId, entryId: "entry", message: { ...clone(plan.message), id: "wrong" } }), "ERR_STREAM_COMMIT_MISMATCH");
    if (operation === "badHook") {
      fault(() => f.p.prepareCommit({ planId: plan.planId, message: { ...clone(plan.message), id: "wrong" } }), "ERR_STREAM_PROTECTED_ENVELOPE");
      fault(acknowledgment, "ERR_STREAM_FAILED");
    }
    assert.equal(f.entries.length, 0);
  }
  const c = call("A"), f = fixture([c]); starts(f);
  f.raw.content.push(text("parser ahead, no text_start delivered"));
  const ack = f.commit(f.emit("toolcall_end", 0, receipt(c)).prefix);
  assert.equal(ack.remainder, undefined);
});

test("successive prefix rebases preserve source text IDs and do not execute an ordinary barrier", () => {
  const a = call("A"), b = call("B"), barrier = call("ordinary", false), later = call("later");
  const f = fixture([a, text("B"), b, text("C"), barrier, later]); starts(f);
  f.emit("text_delta", 1, null, { delta: "B" }); f.emit("text_delta", 3, null, { delta: "C" });
  const first = f.commit(f.emit("toolcall_end", 0, receipt(a)).prefix);
  assert.equal(first.remainder.id, "core1"); assert.equal(first.remainder.content[0].id, "text1");
  assert.equal(first.remainder.content[2].id, "text3");
  f.emit("text_end", 1);
  const second = f.commit(f.emit("toolcall_end", 2, receipt(b)).prefix);
  assert.equal(second.remainder.id, "core2"); assert.equal(second.remainder.content[0].id, "text3");
  assert.equal(second.remainder.content[0].text, "C");
  assert.deepEqual([...first.calls, ...second.calls].map(item => item.call.id), [a.id, b.id]);
  f.emit("text_end", 3); f.emit("toolcall_end", 4);
  assert.equal(f.emit("toolcall_end", 5, receipt(later)).prefix, undefined, "snapshot cannot skip the ordinary barrier");
  const final = f.terminal("aborted");
  assert.deepEqual(f.commit(final.final).calls, []);
});
