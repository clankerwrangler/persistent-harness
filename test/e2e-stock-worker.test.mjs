import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";
import { CronStore } from "../src/cron-store.mjs";
import { runtimeVersions } from "../src/python-runtime.mjs";
import { discoverSkillsFromDirectory } from "../src/skills.mjs";
const { python: PYTHON_VERSION, ipython: IPYTHON_VERSION, dill: DILL_VERSION } = runtimeVersions;

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
  const catalog = await discoverSkillsFromDirectory(path.resolve("skills")); assert.deepEqual(catalog.diagnostics, []);
  const dependencies = [...new Set(catalog.skills.flatMap(skill => skill.python?.dependencies ?? []))].sort();
  const expectedRuntimeMessage = `Persistent Harness needs CPython ${PYTHON_VERSION} and:\n${[`ipython==${IPYTHON_VERSION}`, `dill==${DILL_VERSION}`, ...dependencies].join("\n")}`;
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HARNESS_FAKE_BASE_URL: process.env.HARNESS_FAKE_BASE_URL };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const bodies = []; let supervisor, client, cronStore, admission;
  let provisioningAnswered = false, provisioningError = null;
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk; const body = JSON.parse(text); bodies.push(body);
    const last = body.messages.at(-1); const n = bodies.length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `stock-${n}`, object: "chat.completion.chunk", created: 1, model: "fake-model" };
    const send = delta => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (last.role === "user") {
      const content = JSON.stringify(last.content);
      let code;
      if (content.includes("NOTIFICATION_SCHEDULED_CHECK")) {
        const run = cronStore.listActiveRunsForSession(admission.sessionId)[0]; assert(run);
        code = `await cron(action="report", run_id=${JSON.stringify(run.runId)}, disposition="deliver", body="Official runtime exact finding"); print("CRON_REPORTED")`;
      } else if (content.includes("RUN_CRON")) {
        code = 'await cron(action="run", selector=notification_job["job"]["jobId"]); print("CRON_STARTED")';
      } else if (content.includes("READ_STATE")) {
        code = 'agent_message.resolve_attention("official-choice"); print("ACTUAL_PYTHON", persistent_probe + 1)';
      } else {
        code = 'persistent_probe = 41; agent_message.request_attention("official-choice", "Official runtime choice", "Choose this exact target"); notification_job = await cron(action="create", name="Official check", prompt="NOTIFICATION_SCHEDULED_CHECK", schedule={"kind":"every","intervalSeconds":300}, execution_mode="origin", notification_intent="conditional"); print("ACTUAL_PYTHON", persistent_probe)';
      }
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
    cronStore?.close(); await client?.stop(); await supervisor?.stop(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  supervisor = new HarnessSupervisor({ socketPath: path.join(root, "s.sock"), databasePath: path.join(root, "harness.sqlite"), pidPath: path.join(root, "s.pid"),
    skillsPath: path.resolve("skills"), actorInactivityMs: 0, actorExtensionPaths: [path.resolve("test/fixtures/fake-provider.ts")] });
  await supervisor.start();
  client = new HarnessClient({ socketPath: path.join(root, "s.sock"), heartbeatMs: 0, requestTimeoutMs: 40000 });
  await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  // This fixture alone consents to its expected disposable runtime installation.
  // Unexpected human requests fail the test; production approval remains untouched.
  client.on("event", frame => {
    const e = frame.data?.event;
    if (frame.event !== "actor_event" || e?.type !== "extension_ui_request" || !["confirm", "select", "input", "editor"].includes(e.method)) return;
    void (async () => {
      assert(admission && frame.data.sessionId === admission.sessionId);
      assert.equal(e.method, "confirm"); assert.equal(e.title, "Install managed Python runtime?");
      assert.equal(provisioningAnswered, false); assert.equal(typeof e.id, "string"); assert(e.id.length > 0);
      assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir); assert.equal(path.dirname(agentDir), root);
      assert.equal(process.env.PI_HARNESS_PYTHON, undefined, "fixture must install inside its own agent directory");
      assert.equal(e.message, expectedRuntimeMessage);
      const current = supervisor.store.getSession(admission.sessionId);
      assert(current.actorGeneration > 0 && current.lifecycle === "resident");
      assert.equal(frame.data.actorGeneration, current.actorGeneration);
      const snapshot = await client.request("subscribe_session", { selector: admission.sessionId, passive: true });
      assert(snapshot.pendingUiRequests.some(request => request.id === e.id));
      const notice = (await client.request("list_notifications")).notifications.find(n => n.source.requestId === e.id);
      assert(notice); assert.equal(notice.state, "pending"); assert.equal(notice.kind, "attention");
      assert.equal(notice.source.actorGeneration, current.actorGeneration);
      // No conversation SSE clients exist; the first Python tool is still waiting.
      assert.equal(current.activity, "working");
      provisioningAnswered = true;
      await client.request("respond_extension_ui", { sessionId: admission.sessionId, uiRequestId: e.id, confirmed: true });
    })().catch(error => { provisioningError = error; });
  });
  ({ admission } = await client.request("create_root", { cwd, repositoryRoot: null, name: "stock-worker-smoke", provider: "harness-fake", model: "fake-model", thinkingLevel: null }));
  cronStore = new CronStore(path.join(root, "harness.sqlite"));
  await client.request("subscribe_session", { selector: admission.sessionId });
  try { await settled(client, admission.sessionId, "SET_STATE"); } catch(error) { throw provisioningError ?? error; }
  assert.equal(provisioningError, null); assert.equal(provisioningAnswered, true);
  assert((await stat(path.join(agentDir, "harness/kernel-runtime/environments"))).isDirectory());
  const attention = (await client.request("list_notifications")).notifications.find(n => n.source.key === "official-choice");
  assert(attention); assert.equal(attention.body, "Choose this exact target");
  assert.equal((await client.request("read_notification", { id: attention.id })).notification.state, "pending");
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
  assert.equal((await client.request("get_notification", { id: attention.id })).notification.state, "resolved");
  await settled(client, admission.sessionId, "RUN_CRON");
  let delivered; const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    delivered = (await client.request("list_notifications")).notifications.find(n => n.kind === "cron");
    if (delivered) break; await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(delivered, "official cron report reaches the zero-SSE durable feed");
  assert.equal(delivered.body, "Official runtime exact finding"); assert.equal(delivered.source.failed, false);
  const run = cronStore.getRun(delivered.source.runId);
  assert.equal(run.status, "completed"); assert.equal(run.notificationDisposition, "deliver");
  assert.equal(cronStore.listRuns(run.jobId).length, 1);
  assert.equal(provisioningError, null);
});
