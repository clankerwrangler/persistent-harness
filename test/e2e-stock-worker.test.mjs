import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";

async function settled(client, id, text) {
  let cleanup;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`settlement timeout for ${text}`)); }, 30000);
    const listener = frame => { if (frame.event === "actor_event" && frame.data?.sessionId === id && frame.data?.event?.type === "agent_settled") { cleanup(); resolve(); } };
    cleanup = () => { clearTimeout(timer); client.off("event", listener); }; client.on("event", listener);
  });
  await client.request("submit_input", { sessionId: id, message: text, behavior: "auto" }); await done;
}

test("stock worker: real supervisor, external stock SDK, canonical input and persistent Python", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sw-")); const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HARNESS_FAKE_BASE_URL: process.env.HARNESS_FAKE_BASE_URL };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const bodies = []; let supervisor, client;
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk; const body = JSON.parse(text); bodies.push(body);
    const last = body.messages.at(-1); const n = bodies.length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `stock-${n}`, object: "chat.completion.chunk", created: 1, model: "fake-model" };
    const send = delta => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (last.role === "user") {
      const code = JSON.stringify(last.content).includes("READ_STATE") ? 'print("ACTUAL_PYTHON", persistent_probe + 1)' : 'persistent_probe = 41; print("ACTUAL_PYTHON", persistent_probe)';
      send({ role: "assistant", content: "" }); send({ tool_calls: [{ index: 0, id: `stock-call-${n}`, type: "function", function: { name: "ipython", arguments: JSON.stringify({ code }) } }] });
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    } else {
      send({ role: "assistant", content: "" }); send({ content: "STOCK_WORKER_DONE" });
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.HARNESS_FAKE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(async () => {
    await client?.stop(); await supervisor?.stop(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  supervisor = new HarnessSupervisor({ socketPath: path.join(root, "s.sock"), databasePath: path.join(root, "harness.sqlite"), pidPath: path.join(root, "s.pid"),
    skillsPath: path.resolve("skills"), actorInactivityMs: 0, actorExtensionPaths: [path.resolve("test/fixtures/fake-provider.ts")] });
  await supervisor.start();
  client = new HarnessClient({ socketPath: path.join(root, "s.sock"), heartbeatMs: 0, requestTimeoutMs: 40000 });
  await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  const { admission } = await client.request("create_root", { cwd, repositoryRoot: null, name: "stock-worker-smoke", provider: "harness-fake", model: "fake-model", thinkingLevel: null });
  await client.request("subscribe_session", { selector: admission.sessionId });
  await settled(client, admission.sessionId, "SET_STATE");
  const pid = supervisor.store.getSession(admission.sessionId).actorPid; assert(pid);
  await settled(client, admission.sessionId, "READ_STATE");
  assert.equal(supervisor.store.getSession(admission.sessionId).actorPid, pid);
  const { entries } = await client.request("get_actor_entries", { sessionId: admission.sessionId, since: null });
  const users = entries.filter(e => e.type === "message" && e.message.role === "user");
  const results = entries.filter(e => e.type === "message" && e.message.role === "toolResult");
  assert.equal(users.length, 2); assert.equal(results.length, 2); assert(results.every(e => !e.message.isError));
  assert.match(JSON.stringify(results[0]), /ACTUAL_PYTHON 41/); assert.match(JSON.stringify(results[1]), /ACTUAL_PYTHON 42/);
  assert.equal(bodies.length, 4);
  const { messages } = await client.request("get_visible_messages", { sessionId: admission.sessionId });
  assert(messages.some(m => m.text === "STOCK_WORKER_DONE"));
  assert.doesNotMatch(JSON.stringify(messages), /toolResult|thinkingSignature/);
});
