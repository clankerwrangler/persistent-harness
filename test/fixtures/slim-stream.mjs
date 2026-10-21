import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor } from "./isolated-supervisor.mjs";
import { PiSessionActor } from "../../src/session-actor.mjs";
import { assistantMessageParts } from "../../src/conversation-projection.mjs";
import { PythonRuntimeManager } from "../../src/python-runtime.mjs";
import { acceptedNativeRuntime } from "./accepted-native-runtime.mjs";

export async function until(probe, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${description}`);
}

export async function slimFixture(t, name, script, { models = ["gpt-6-astra"], maxRequests = 2 } = {}) {
  const { cli: command, sdk: module } = await acceptedNativeRuntime();
  const skills = process.env.PI_HARNESS_SKILLS_PATH;
  assert(skills, "Use the explicit read-only skills test seam");
  const directory = await mkdtemp(path.join(os.tmpdir(), "slim-rpc-identity-"));
  const agentDir = path.join(directory, "agent"); const cwd = path.join(directory, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(path.join(directory, "home"))]);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ transport: "sse", retry: { enabled: false } }));
  const previousEnv = { ...process.env }; const rawEvents = []; const events = []; const snapshots = []; const errors = []; const responses = []; const requests = []; const timeline = []; const proof = {};
  const artifacts = process.env.PI_HARNESS_SLIM_TEST_ARTIFACTS;
  let supervisor; let client; let server; let sessionId; let modelRequests = 0;
  t.after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const sessionFile = sessionId && supervisor?.store.getSession(sessionId)?.sessionFile;
      await writeFile(path.join(artifacts, `${name}-receipt.json`), JSON.stringify({ test: t.name, rawEvents, events, snapshots, modelRequests, requests, timeline, proof,
        errors: errors.map((error) => error.message), transcript: sessionFile ? await readFile(sessionFile, "utf8").catch(() => null) : null }, null, 2));
    }
    for (const response of responses) response.end();
    await client?.stop(); await supervisor?.stop();
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previousEnv);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(errors, []);
  });
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(directory, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(directory, "home"),
    IPYTHONDIR: path.join(directory, "ipython"), PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_PI_COMMAND: command, PI_HARNESS_PI_MODULE: module,
    PI_HARNESS_PYTHON: runtime.pythonPath, PI_HARNESS_SKILLS_PATH: skills, PI_HARNESS_AUTO_INSTALL: "0", PI_HARNESS_NATIVE_ASYNC: "1",
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PYTHONDONTWRITEBYTECODE: "1", UV_OFFLINE: "1" });
  const send = (response, event) => {
    timeline.push({ kind: "provider", request: responses.indexOf(response) + 1, type: event.type, outputIndex: event.output_index });
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const item = (index, value) => ({ type: "message", id: `msg_${index}`, role: "assistant", status: "completed", phase: "commentary",
    content: [{ type: "output_text", text: value, annotations: [] }] });
  const done = (response, index, value) => send(response, { type: "response.output_item.done", output_index: index, item: item(index, value) });
  server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/codex/responses");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks); const encoding = request.headers["content-encoding"];
      assert(encoding === undefined || encoding === "zstd");
      const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"));
      assert(models.includes(body.model), "The fixture refuses an unexpected model"); modelRequests += 1; responses.push(response); requests.push(body);
      assert(modelRequests <= maxRequests, "The fixture provider request bound was exceeded");
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(response, { type: "response.created", response: { id: `response-${modelRequests}`, status: "in_progress" } });
      await script({ response, body, index: modelRequests, send, item, done });
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.HARNESS_FAKE_NATIVE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const socketPath = path.join(directory, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({ socketPath, backgroundJobsDirectory: path.join(agentDir, "state", "background-jobs"), databasePath: path.join(directory, "state", "harness.sqlite"),
    pidPath: path.join(directory, "run", "supervisor.pid"), actorInactivityMs: 0,
    actorExtensionPaths: [path.join(import.meta.dirname, "fake-native-codex-provider.ts")],
    actorFactory(options) { const actor = new PiSessionActor(options); actor.on("event", (event) => {
      rawEvents.push(event); timeline.push({ kind: "actor", type: event.type, role: event.message?.role,
        toolCallId: event.toolCallId, update: event.assistantMessageEvent?.type, contentIndex: event.assistantMessageEvent?.contentIndex });
    }); return actor; } });
  await supervisor.start(); client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 30_000 });
  await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  client.on("event", (frame) => { if (frame.event === "actor_event") events.push(frame.data.event); });
  sessionId = (await client.request("create_root", { cwd, repositoryRoot: null, name, provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "off" })).admission.sessionId;
  await client.request("subscribe_session", { selector: sessionId });
  const visible = async () => { const result = await client.request("get_visible_messages", { sessionId }); snapshots.push(result); return result.messages.filter((row) => row.role === "assistant"); };
  return { cwd, client, supervisor, sessionId, rawEvents, events, snapshots, responses, requests, timeline, proof, visible, send, item, done,
    entries: async () => (await client.request("get_actor_entries", { sessionId })).entries };
}
