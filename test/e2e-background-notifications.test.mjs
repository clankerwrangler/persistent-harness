import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

async function waitUntil(probe, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

// Use real Pi actors and Python tools with a deterministic local provider.
test("background completion during supervisor downtime revives its real owner exactly once", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-background-e2e-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const jobsDirectory = path.join(agentDir, "state", "background-jobs");
  const releasePath = path.join(cwd, "release-job");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_HARNESS_AUTO_INSTALL", "HARNESS_FAKE_BASE_URL"].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HARNESS_AUTO_INSTALL ??= "1";
  let supervisor;
  let client;
  let jobDirectory;
  let calls = 0;
  let completionCalls = 0;
  let initialSettled = false;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const last = body.messages?.at(-1);
    const text = JSON.stringify(last?.content ?? "");
    const launch = last?.role === "user" && text.includes("LAUNCH_BACKGROUND_PROOF");
    const completion = last?.role === "user" && text.includes("Background process") && text.includes("completion-e2e");
    if (completion) completionCalls += 1;
    const base = { id: `background-e2e-${++calls}`, object: "chat.completion.chunk", created: 1, model: "fake-model" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: "assistant", content: "" });
    if (launch) {
      const code = `print(await background(operation="launch", name="completion-e2e", command="for i in {1..300}; do if test -f release-job; then printf completion-proof; exit 0; fi; sleep 0.1; done; exit 124"))`;
      send({ tool_calls: [{ index: 0, id: "launch-proof", type: "function", function: { name: "ipython", arguments: JSON.stringify({ code }) } }] });
      send({}, "tool_calls");
    } else {
      send({ content: completion ? "AUTO_COMPLETION_RECEIVED" : "WAITING_FOR_COMPLETION" });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    await writeFile(releasePath, "release").catch(() => {});
    await client?.stop();
    await supervisor?.stop();
    if (jobDirectory) {
      await waitUntil(async () => {
        try { await readFile(path.join(jobDirectory, "exit.json")); return true; } catch { return false; }
      }, "test background cleanup", 3000).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.HARNESS_FAKE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  const options = {
    socketPath: path.join(root, "run", "supervisor.sock"),
    databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"),
    backgroundJobsDirectory: jobsDirectory,
    backgroundCompletionIntervalMs: 100,
    actorInactivityMs: 0,
    actorExtensionPaths: [path.join(import.meta.dirname, "fixtures", "fake-provider.ts")],
  };
  const start = async () => {
    supervisor = new HarnessSupervisor(options);
    await supervisor.start();
    client = new HarnessClient({ socketPath: options.socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 });
    await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() });
  };
  await start();
  const owner = (await client.request("create_root", {
    cwd, repositoryRoot: null, name: "background-proof", provider: "harness-fake", model: "fake-model", thinkingLevel: null,
  })).admission;
  await client.request("subscribe_session", { selector: owner.sessionId });
  client.on("event", (frame) => {
    if (frame.event === "actor_event" && frame.data?.sessionId === owner.sessionId && frame.data.event?.type === "agent_settled") initialSettled = true;
  });
  await client.request("submit_input", { sessionId: owner.sessionId, message: "LAUNCH_BACKGROUND_PROOF", behavior: "auto" });
  await waitUntil(() => initialSettled, "initial owner settlement");
  const jobIds = await readdir(jobsDirectory);
  const jobId = jobIds.find((id) => /^bg-[0-9a-f]{12}$/.test(id));
  assert(jobId, "the real Python tool launched the background job");
  jobDirectory = path.join(jobsDirectory, jobId);
  const meta = JSON.parse(await readFile(path.join(jobDirectory, "meta.json"), "utf8"));
  assert.equal(meta.session_id, owner.sessionId);
  const generation = supervisor.store.getSession(owner.sessionId).actorGeneration;
  await client.stop();
  await supervisor.stop();
  await writeFile(releasePath, "release");
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(path.join(jobDirectory, "exit.json"), "utf8")).exit_code === 0; } catch { return false; }
  }, "background exit while the supervisor is stopped");
  await assert.rejects(readFile(path.join(jobDirectory, "notification.json")));

  await start();
  await waitUntil(() => completionCalls === 1, "automatic completion turn without a new user submission");
  await waitUntil(() => supervisor.store.listPendingActorInputs(owner.sessionId).length === 0, "completion input receipt");
  assert(supervisor.store.getSession(owner.sessionId).actorGeneration > generation);
  await waitUntil(async () => {
    const visible = await client.request("get_visible_messages", { sessionId: owner.sessionId });
    return visible.messages.some((message) => message.text?.includes("AUTO_COMPLETION_RECEIVED"));
  }, "visible automatic completion reply");
  assert.equal(JSON.parse(await readFile(path.join(jobDirectory, "notification.json"), "utf8")).state, "sent");
  assert.equal(await readFile(path.join(jobDirectory, "output.log"), "utf8"), "completion-proof");
  await client.stop();
  await supervisor.stop();
  await start();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(completionCalls, 1, "a later supervisor restart does not duplicate the completion turn");
});
