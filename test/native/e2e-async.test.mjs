import { projectAssistantUsageEntry } from "../../src/session-telemetry.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor } from "../../src/supervisor.mjs";
import { verifyOwnedProcessIdentity } from "../../src/process-ownership.mjs";
import { sessionSidecarPaths } from "../../src/session-paths.mjs";

const providerPath = path.resolve(import.meta.dirname, "../fixtures/fake-native-codex-provider.ts");
const deferred = () => Promise.withResolvers();
const text = (value) => JSON.stringify(value ?? null);
const toolOutputs = (body) => body.input.filter((item) => item.type === "function_call_output");

function bounded(promise, description, timeoutMs = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function eventLog(client) {
  const events = []; const frames = []; const listeners = new Set();
  client.on("event", (frame) => {
    frames.push(frame);
    if (frame.event === "actor_event") events.push(frame.data.event);
    for (const listener of listeners) listener();
  });
  const waitIn = (source, predicate, description, since = 0) => {
    const find = () => source.slice(since).find(predicate);
    const existing = find();
    if (existing) return Promise.resolve(existing);
    let listener;
    return bounded(new Promise((resolve) => {
      listener = () => { const found = find(); if (found) resolve(found); };
      listeners.add(listener);
    }), description).finally(() => listeners.delete(listener));
  };
  return { events, frames,
    wait: (predicate, description, since) => waitIn(events, predicate, description, since),
    waitFrame: (predicate, description, since) => waitIn(frames, predicate, description, since),
  };
}

function respond(response, id, { calls = [], answer = id } = {}) {
  const events = [{ type: "response.created", response: { id, status: "in_progress" } }];
  for (const [index, { id: callId, code, name = "ipython", args = { code }, async = true }] of calls.entries()) {
    const item = { type: "function_call", id: `fc_${callId}`, call_id: callId,
      name, arguments: JSON.stringify(args), ...(async ? { async: true } : {}) };
    events.push({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } });
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.output_item.done", output_index: calls.length, item: {
    type: "message", id: `msg_${id}`, role: "assistant", status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  } });
  events.push({ type: "response.completed", response: { id, status: "completed", output: [],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

async function fixture(t, script, { customCompaction = false } = {}) {
  const buildRoot = process.env.PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT;
  const artifacts = process.env.PI_HARNESS_NATIVE_TEST_ARTIFACTS;
  assert(buildRoot, "Set PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT to the explicit immutable stock install root");
  const command = await realpath(process.env.PI_HARNESS_PI_COMMAND || "");
  const module = await realpath(process.env.PI_HARNESS_PI_MODULE || command);
  const prefix = `${await realpath(buildRoot)}${path.sep}`;
  assert(command.startsWith(prefix) && module.startsWith(prefix), "Use the explicit same-install stock CLI and SDK seam");
  await access(path.join(path.dirname(module), "index.js"));
  const python = process.env.PI_HARNESS_PYTHON;
  assert(python, "Use a preprovisioned read-only Python runtime; this fixture must not install packages");
  const skills = process.env.PI_HARNESS_SKILLS_PATH;
  assert(skills, "Set the existing read-only skills path");

  const root = await mkdtemp(path.join(os.tmpdir(), "harness-native-async-"));
  const cwd = path.join(root, "project"); const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(path.join(root, "home"))]);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ transport: "sse" }));
  const customCompactionFile = path.join(root, "custom-compaction.jsonl");
  const customExtensionPath = path.join(root, "custom-compaction.ts");
  await writeFile(customCompactionFile, "");
  const customCompactions = async () => (await readFile(customCompactionFile, "utf8"))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (customCompaction) {
    // Original generic public hook fixture: plaintext result, no provider request.
    await writeFile(customExtensionPath, `import { appendFile } from "node:fs/promises";
export default function customCompactionFixture(pi) {
  pi.on("session_before_compact", async event => {
    const customInstructions = event.customInstructions ?? "";
    const compaction = {
      summary: "CUSTOM_HOOK_SUMMARY\\n" + customInstructions,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details: { fixture: "generic-custom-compaction" },
    };
    await appendFile(${JSON.stringify(customCompactionFile)},
      JSON.stringify({ reason: event.reason, customInstructions, ...compaction }) + "\\n");
    return { compaction };
  });
}
`);
  }
  const originalEnv = { ...process.env };
  const requests = []; const receipts = []; const errors = []; const gates = new Map();
  let server; let supervisor; let client; let log; let sessionId;
  t.after(async () => {
    if (artifacts) {
      await mkdir(artifacts, { recursive: true });
      const sessionFile = sessionId && supervisor?.store.getSession(sessionId)?.sessionFile;
      await writeFile(path.join(artifacts, `${crypto.randomUUID()}.json`), JSON.stringify({
        test: t.name, requests, receipts, customCompactions: await customCompactions(),
        errors: errors.map((error) => error.message), events: log?.events,
        transcript: sessionFile ? await readFile(sessionFile, "utf8").catch(() => null) : null,
      }, null, 2));
    }
    for (const held of gates.values()) held.release.resolve();
    await client?.stop(); await supervisor?.stop();
    if (server?.listening) {
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    }
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    assert.deepEqual(errors, [], "The local provider must satisfy every wire assertion");
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(root, "home"),
    IPYTHONDIR: path.join(root, "ipython"), PI_CODING_AGENT_DIR: agentDir,
    PI_HARNESS_PI_COMMAND: command, PI_HARNESS_PI_MODULE: module,
    PI_HARNESS_NATIVE_ASYNC: "1", PI_HARNESS_PYTHON: python, PI_HARNESS_AUTO_INSTALL: "0",
    PI_HARNESS_SKILLS_PATH: skills, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0", PYTHONDONTWRITEBYTECODE: "1", UV_OFFLINE: "1",
  });

  const gate = (name) => {
    if (!gates.has(name)) gates.set(name, { started: deferred(), release: deferred() });
    return gates.get(name);
  };
  server = http.createServer(async (request, response) => {
    try {
      receipts.push({ method: request.method, url: request.url, host: request.headers.host,
        upgrade: request.headers.upgrade ?? null,
        contentEncoding: request.headers["content-encoding"] ?? null,
        betaFeatures: request.headers["x-codex-beta-features"] ?? null });
      if (request.method === "GET" && request.url.startsWith("/gate/")) {
        const held = gate(request.url.slice("/gate/".length)); held.started.resolve();
        await held.release.promise; response.writeHead(200); response.end("released"); return;
      }
      if (request.method === "GET" && request.headers.upgrade === "websocket") {
        assert.equal(request.url, "/codex/responses");
        // This local provider offers SSE. Preserve the real adapter's documented
        // auto-transport fallback instead of patching or disabling its transport.
        response.writeHead(426, { connection: "close", "content-type": "text/plain" });
        response.end("The synthetic provider supports SSE only.");
        return;
      }
      assert.equal(request.method, "POST");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const encoding = request.headers["content-encoding"];
      assert(encoding === undefined || encoding === "zstd", `Unsupported fixture encoding: ${encoding}`);
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((encoding === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"));
      requests.push(body);
      assert.equal(body.model, "gpt-6-astra");
      if (body.tools?.length) {
        const native = process.env.PI_HARNESS_NATIVE_ASYNC === "1";
        assert.deepEqual(body.tools.map((tool) => tool.name), native ? ["ipython", "wait_for_ipython"] : ["ipython"]);
        assert.equal(body.tools[0].async, native ? true : undefined);
        assert.deepEqual(Object.keys(body.tools[0].parameters.properties), ["code"]);
        if (native) assert.notEqual(body.tools[1].async, true);
      }
      assert.doesNotMatch(text(body), /No result provided|job_handle|task_handle/);
      const reply = await script(body, requests.length, baseUrl);
      if (reply?.writeResponse) await reply.writeResponse(response, `R${requests.length}`);
      else respond(response, `R${requests.length}`, reply);
    } catch (error) {
      errors.push(error); response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.HARNESS_FAKE_NATIVE_BASE_URL = baseUrl;
  const socketPath = path.join(root, "run", "supervisor.sock");
  supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorExtensionPaths: [providerPath, ...(customCompaction ? [customExtensionPath] : [])], actorInactivityMs: 0 });
  client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 30_000 });
  await supervisor.start();
  assert(await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() }));
  log = eventLog(client);
  const { admission } = await client.request("create_root", { cwd, repositoryRoot: null,
    name: "synthetic-native-fixture", provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "off" });
  sessionId = admission.sessionId;
  await client.request("subscribe_session", { selector: sessionId });
  return { root, cwd, client, supervisor, sessionId, requests, gate, log, customCompactions,
    submit: (message, behavior = "auto") => client.request("submit_input", { sessionId, message, behavior }),
    entries: async () => (await client.request("get_actor_entries", { sessionId, since: null })).entries,
    state: async () => (await client.request("get_actor_state", { sessionId })).state,
    sidecars: () => sessionSidecarPaths(supervisor.store.getSession(sessionId).sessionFile),
  };
}

function heldCode(baseUrl, name, after) {
  return `from urllib.request import urlopen\nfrom pathlib import Path\nPath("${name}-started").write_text("started")\nwith urlopen("${baseUrl}/gate/${name}") as response:\n    response.read()\n${after}`;
}
const messageWith = (marker) => (event) => event.type === "message_end" && text(event.message).includes(marker);
const settled = (event) => event.type === "agent_settled";
const resultsIn = (entries) => entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult").map((entry) => entry.message);
async function waitForCheckpoint(f, toolCallId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
      const manifest = await readFile(path.join(f.sidecars().kernelStatePath, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
      if (manifest?.namespaceCheckpoint?.toolCallId === toolCallId) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: published checkpoint for ${toolCallId}`);
}

function snapshotGateCode(baseUrl, name, before = "") {
  return `${before}\nclass HeldSnapshot:\n    def __reduce__(self):\n        from urllib.request import urlopen\n        with urlopen("${baseUrl}/gate/${name}") as response:\n            response.read()\n        return (str, ("restored snapshot fixture",))\nheld_snapshot = HeldSnapshot()\nprint("EXECUTION_BEFORE_SAVE")`;
}

test("Python results and dependent inference arrive while checkpointing; later cells retain the existing FIFO", { timeout: 120_000 }, async (t) => {
  const continuation = deferred();
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [
      { id: "early", code: snapshotGateCode(baseUrl, "save") },
      { id: "wait", name: "wait_for_ipython", args: {}, async: false },
    ] };
    if (index === 2) {
      assert.match(toolOutputs(body).find((output) => output.call_id === "early").output, /EXECUTION_BEFORE_SAVE/);
      continuation.resolve();
      return { calls: [{ id: "later", code: 'from pathlib import Path\nPath("later-cell-started").write_text("once")' }] };
    }
    return { answer: "EARLY_RESULT_FINISHED" };
  });
  await f.submit("SYNTHETIC_EARLY_RESULT");
  await bounded(f.gate("save").started.promise, "checkpoint serialization held");
  await bounded(continuation.promise, "model consumed result before checkpoint completion");
  await assert.rejects(access(path.join(f.cwd, "later-cell-started")), /ENOENT/);
  const original = resultsIn(await f.entries()).find((result) => result.toolCallId === "early|fc_early");
  assert.equal(original.details.namespaceCheckpointState, "pending");
  assert.equal(original.details.namespaceCheckpoint, undefined);
  f.gate("save").release.resolve();
  await f.log.wait(settled, "later cell executes after the save");
  await waitForCheckpoint(f, "later|fc_later");
  assert.equal(await readFile(path.join(f.cwd, "later-cell-started"), "utf8"), "once");
  assert.deepEqual(resultsIn(await f.entries()).find((result) => result.toolCallId === "early|fc_early"), original);
});

test("checkpoint failure produces a separate diagnostic after a successful early execution result", { timeout: 120_000 }, async (t) => {
  const failureSeen = deferred();
  const f = await fixture(t, (body, index) => {
    if (index === 1) return { calls: [{ id: "save-failure", code: 'import os\ndef fail_sync(fd):\n    raise OSError("SYNTHETIC_SAVE_FAILURE")\nos.fsync = fail_sync\nprint("EXECUTION_SUCCEEDED")' }] };
    if (text(body).includes("namespace save failed after execution")) failureSeen.resolve(body);
    return { answer: "SAVE_DIAGNOSTIC_RECEIVED" };
  });
  await f.submit("SYNTHETIC_SAVE_FAILURE");
  const body = await bounded(failureSeen.promise, "save failure reaches model without replacing the tool result");
  assert.match(text(body), /do not replay the cell automatically/);
  const entries = await f.entries();
  const result = resultsIn(entries).filter((item) => item.toolCallId === "save-failure|fc_save-failure");
  assert.equal(result.length, 1);
  assert.equal(result[0].isError, false);
  assert.match(text(result[0].content), /EXECUTION_SUCCEEDED/);
  assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === "persistent-harness-checkpoint-failure").length, 1);
});

test("graceful actor shutdown drains a pending save after the Python result and model have settled", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (_body, index, baseUrl) => index === 1
    ? { calls: [{ id: "closing", code: snapshotGateCode(baseUrl, "close-save") }] }
    : { answer: "RESULT_RECEIVED_BEFORE_SHUTDOWN" });
  await f.submit("SYNTHETIC_SHUTDOWN_SAVE");
  await bounded(f.gate("close-save").started.promise, "save held while execution is complete");
  await f.log.wait(settled, "model finishes while save remains pending");
  let stopped = false;
  const stop = f.client.request("stop_session", { sessionId: f.sessionId }).then((result) => { stopped = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stopped, false, "graceful shutdown waits for the existing kernel FIFO");
  f.gate("close-save").release.resolve();
  await bounded(stop, "shutdown completes after save");
  await waitForCheckpoint(f, "closing|fc_closing");
});

test("synchronous wait publishes original Python results before dependent inference without another execution", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [
      { id: "dispatch", code: heldCode(baseUrl, "dispatch", 'print("DISPATCH_CONFIRMED")') },
      { id: "wait", name: "wait_for_ipython", args: {}, async: false },
    ], answer: "Waiting for the actual dispatch result." };
    assert.equal(index, 2, "one continuation consumes both original results");
    assert.deepEqual(toolOutputs(body).map((output) => output.call_id), ["dispatch", "wait"]);
    assert.match(toolOutputs(body)[0].output, /DISPATCH_CONFIRMED/);
    assert.match(toolOutputs(body)[1].output, /original results/);
    return { answer: "DISPATCH_RESULT_CONSUMED" };
  });
  await f.submit("WAIT_FOR_SYNTHETIC_DISPATCH");
  await bounded(f.gate("dispatch").started.promise, "Python started before the wait barrier");
  await f.log.wait(messageWith("Waiting for the actual dispatch result."), "provider finished the first response");
  assert.equal(f.requests.length, 1);
  assert.equal(resultsIn(await f.entries()).length, 0, "wait cannot acknowledge unfinished Python");
  f.gate("dispatch").release.resolve();
  await f.log.wait(settled, "dependent inference after original result publication");
  const results = resultsIn(await f.entries());
  assert.deepEqual(results.map((result) => result.toolCallId), ["dispatch|fc_dispatch", "wait|fc_wait"]);
  assert(results.every((result) => !result.isError));
  assert.equal(results.filter((result) => result.details?.executionId).length, 1, "wait does not execute or checkpoint Python");
  assert.equal(f.requests.length, 2);
});

test("abort during synchronous wait settles the original Python call without acknowledging success", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (_body, index, baseUrl) => {
    assert.equal(index, 1, "aborting the barrier must not start dependent inference");
    return { calls: [
      { id: "pending", code: heldCode(baseUrl, "pending", 'Path("after-wait-abort").write_text("must not run")') },
      { id: "wait", name: "wait_for_ipython", args: {}, async: false },
    ] };
  });
  await f.submit("ABORT_SYNTHETIC_WAIT");
  await bounded(f.gate("pending").started.promise, "Python started before abort");
  await f.client.request("abort_session", { sessionId: f.sessionId });
  await f.log.wait(settled, "abort settles wait and Python");
  f.gate("pending").release.resolve();
  const results = resultsIn(await f.entries());
  assert.equal(results.find((result) => result.toolCallId === "pending|fc_pending")?.isError, true);
  const wait = results.find((result) => result.toolCallId === "wait|fc_wait");
  if (wait) assert.equal(wait.isError, true);
  await assert.rejects(access(path.join(f.cwd, "after-wait-abort")), /ENOENT/);
  assert.equal(f.requests.length, 1);
});

test("native prompt and steer continue while the actual kernel stays FIFO and pending", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [{ id: "A", code: heldCode(baseUrl, "A", 'shared_value = 41\nprint("A_ACTUAL_RESULT")') }] };
    if (index === 2) {
      assert.match(text(body), /INDEPENDENT_PROMPT/); assert.equal(toolOutputs(body).length, 0);
      return { answer: "INDEPENDENT_REPLY", calls: [{ id: "B", code: 'Path("B-started").write_text("started")\nprint(shared_value + 1)' }] };
    }
    if (index === 3) {
      assert.match(text(body), /INDEPENDENT_STEER/); assert.equal(toolOutputs(body).length, 0);
      return { answer: "STEER_REPLY" };
    }
    return { answer: "RESULT_CONTINUATION" };
  });
  await f.submit("START_SYNTHETIC_A");
  await bounded(f.gate("A").started.promise, "actual Python A admission");
  await f.submit("INDEPENDENT_PROMPT");
  await f.log.wait(messageWith("INDEPENDENT_REPLY"), "later inference before A completes");
  await f.submit("INDEPENDENT_STEER", "steer");
  await f.log.wait(messageWith("STEER_REPLY"), "explicit steer before A completes");
  await f.submit("AFTER_WORK_FOLLOWUP", "follow_up");
  assert.equal((await f.state()).isStreaming, true);
  assert.equal(f.supervisor.store.getSession(f.sessionId).activity, "working");
  assert.equal(f.log.events.filter(settled).length, 0);
  assert.equal(f.requests.length, 3, "no empty continuation loop or early follow-up");
  await assert.rejects(access(path.join(f.cwd, "B-started")), /ENOENT/);
  assert.equal(resultsIn(await f.entries()).length, 0, "pending calls have no substitute result");
  await assert.rejects(f.client.request("restart_kernel", { sessionId: f.sessionId }), /must be idle/);

  f.gate("A").release.resolve();
  await f.log.wait(settled, "native results and follow-up settlement");
  assert.equal((await f.state()).isStreaming, false);
  const results = resultsIn(await f.entries());
  assert.deepEqual(results.map((result) => result.toolCallId), ["A|fc_A", "B|fc_B"]);
  assert(results.every((result) => !result.isError));
  assert.match(text(results[0].content), /A_ACTUAL_RESULT/); assert.match(text(results[1].content), /42/);
  assert.notEqual(results[0].details.executionId, results[1].details.executionId);
  for (const result of results) {
    assert.equal(result.details.namespaceCheckpointState, "pending");
    assert.deepEqual(result.details.namespaceCheckpointAttempt, { version: 1, sessionId: f.sessionId,
      toolCallId: result.toolCallId, actorGeneration: 1, executionId: result.details.executionId });
  }
  assert(f.requests.slice(3).some((body) => text(body).includes("AFTER_WORK_FOLLOWUP")));
  const latestOutputs = toolOutputs(f.requests.at(-1));
  assert.deepEqual(latestOutputs.map((output) => output.call_id), ["A", "B"]);
  assert.equal(await readFile(path.join(f.cwd, "B-started"), "utf8"), "started");
  assert.equal((await f.client.request("restart_kernel", { sessionId: f.sessionId })).restarted, true);
});

test("native abort cancels active and queued cells and preserves ordinary execution", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [
      { id: "A", code: heldCode(baseUrl, "A", 'Path("A-after-abort").write_text("must not run")') },
      { id: "B", code: 'Path("B-started").write_text("must not run")' },
    ] };
    if (body.input.at(-1)?.role === "user" && text(body.input.at(-1)).includes("ORDINARY_AFTER_ABORT")) {
      return { calls: [{ id: "C", async: false, code: 'print("ORDINARY_KERNEL_OK")' }] };
    }
    return { answer: "AFTER_ABORT_REPLY" };
  });
  await f.submit("CANCEL_SYNTHETIC_BATCH");
  await bounded(f.gate("A").started.promise, "active Python before native abort");
  await f.client.request("abort_session", { sessionId: f.sessionId });
  await f.log.wait(settled, "cancelled native settlement");
  f.gate("A").release.resolve();
  const results = resultsIn(await f.entries());
  assert.deepEqual(results.map((result) => result.toolCallId), ["A|fc_A", "B|fc_B"]);
  assert(results.every((result) => result.isError), text(results));
  await assert.rejects(access(path.join(f.cwd, "A-after-abort")), /ENOENT/);
  await assert.rejects(access(path.join(f.cwd, "B-started")), /ENOENT/);
  await f.submit("ORDINARY_AFTER_ABORT");
  await f.log.wait(messageWith("AFTER_ABORT_REPLY"), "ordinary continuation after cancellation");
  const after = resultsIn(await f.entries());
  assert.equal(after.filter((result) => result.toolCallId === "A|fc_A").length, 1);
  assert.equal(after.filter((result) => result.toolCallId === "B|fc_B").length, 1);
  assert.match(text(after.find((result) => result.toolCallId === "C|fc_C")?.content), /ORDINARY_KERNEL_OK/);
});

async function submitAndSettle(f, message) {
  const since = f.log.frames.length;
  await f.submit(message);
  await f.log.waitFrame((frame) => frame.event === "actor_event" && frame.data.sessionId === f.sessionId
    && frame.data.event.type === "agent_settled", `settle ${message}`, since);
  const latest = resultsIn(await f.entries()).at(-1);
  if (latest?.details.namespaceCheckpointState === "pending") await waitForCheckpoint(f, latest.toolCallId);
}

async function crashActor(f) {
  const identity = f.supervisor.store.getSession(f.sessionId).actorIdentity;
  assert(await verifyOwnedProcessIdentity(identity), "crash only the synthetic actor's verified process group");
  const since = f.log.frames.length;
  process.kill(-identity.processGroup, "SIGKILL");
  await f.log.waitFrame((frame) => frame.event === "navigator_changed"
    && f.supervisor.store.getSession(f.sessionId).lifecycle === "error", "owned actor exit", since);
  assert.equal(await verifyOwnedProcessIdentity(identity), false);
}

test("actor loss after an early result diagnoses the unsaved namespace without replaying execution", { timeout: 120_000 }, async (t) => {
  const earlySeen = deferred();
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [{ id: "seed", code: "checkpoint_value = 7" }] };
    if (index === 2) return { answer: "SEED_SETTLED" };
    if (index === 3) return { calls: [{ id: "early", code: snapshotGateCode(baseUrl, "unsaved",
      'checkpoint_value = 41\nwith open("effect", "a") as effect: effect.write("x")') }] };
    if (index === 4) { earlySeen.resolve(); return { answer: "EXECUTION_KNOWN_SAVE_PENDING" }; }
    if (index === 5) {
      assert.match(body.instructions, /Checkpoint identities match: false/);
      assert.match(body.instructions, /execution-ended-without-checkpoint/);
      assert.match(body.instructions, /early\|fc_early/);
      assert.equal(toolOutputs(body).filter((output) => output.call_id === "early").length, 1);
      return { calls: [{ id: "verify", code: 'print("RESTORED_BEFORE_UNSAVED", checkpoint_value)' }] };
    }
    return { answer: "UNSAVED_RECOVERY_VERIFIED" };
  });
  await submitAndSettle(f, "SEED_NAMESPACE");
  await f.submit("EXECUTE_BEFORE_UNSAVED_CRASH");
  await bounded(f.gate("unsaved").started.promise, "snapshot held before publication");
  await bounded(earlySeen.promise, "execution result consumed while snapshot held");
  const before = resultsIn(await f.entries()).find((result) => result.toolCallId === "early|fc_early");
  assert.equal(before.isError, false);
  await crashActor(f);
  f.gate("unsaved").release.resolve();
  await f.client.request("subscribe_session", { selector: f.sessionId });
  await submitAndSettle(f, "VERIFY_UNSAVED_RECOVERY");
  const after = resultsIn(await f.entries());
  assert.deepEqual(after.filter((result) => result.toolCallId === "early|fc_early"), [before]);
  assert.match(text(after.find((result) => result.toolCallId === "verify|fc_verify").content), /RESTORED_BEFORE_UNSAVED 7/);
  assert.equal(await readFile(path.join(f.cwd, "effect"), "utf8"), "x");
});

for (const { mismatch, nativeOff } of [
  { mismatch: false, nativeOff: false }, { mismatch: true, nativeOff: false }, { mismatch: false, nativeOff: true },
]) {
  test(`native durable result survives actor loss before provider acknowledgment${mismatch ? " with snapshot mismatch" : ""}${nativeOff ? " with native mode off on the compatible prefix" : ""}`, { timeout: 120_000 }, async (t) => {
    const continuationSeen = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const f = await fixture(t, async (body, index) => {
      if (index === 1) return { calls: [{ id: "seed", code: "checkpoint_value = 7" }] };
      if (index === 2) return { answer: "SEED_SETTLED" };
      if (index === 3) return { calls: [{ id: "A", code: [
        "checkpoint_value = 41", 'with open("effect", "a") as _effect: _effect.write("x")', 'print("ACTUAL_A")',
      ].join("\n") }] };
      if (index === 4) {
        assert.equal(toolOutputs(body).filter((output) => output.call_id === "A").length, 1);
        continuationSeen.resolve(); await release.promise;
        return { answer: "UNACKNOWLEDGED_RESPONSE" };
      }
      if (index === 5) {
        assert.match(body.instructions, /Python namespace recovery diagnostic/);
        assert.match(body.instructions, /Expected canonical checkpoint/);
        assert.match(body.instructions, /Restored checkpoint/);
        assert.match(body.instructions, mismatch ? /Checkpoint identities match: false/ : /Checkpoint identities match: true/);
        assert.match(body.instructions, /Skipped values/);
        assert.equal(toolOutputs(body).filter((output) => output.call_id === "A").length, 1);
        return { calls: [{ id: "verify", code: 'print("RESTORED_VALUE", checkpoint_value)\ncheckpoint_value = 41' }] };
      }
      return { answer: "RECOVERY_VERIFIED" };
    });
    await submitAndSettle(f, "SEED_NAMESPACE");
    const seedCopy = path.join(f.root, "seed-snapshot");
    await cp(f.sidecars().kernelStatePath, seedCopy, { recursive: true });
    await f.submit("EXECUTE_A_ONCE");
    await bounded(continuationSeen.promise, "durable result before provider acknowledgment");
    const before = resultsIn(await f.entries()).find((result) => result.toolCallId === "A|fc_A");
    assert.equal(before?.details.namespaceCheckpointState, "pending", "the canonical result describes execution, not a durability promise");
    await waitForCheckpoint(f, "A|fc_A");
    const beforeAccounting = (await f.entries()).map(projectAssistantUsageEntry).filter(Boolean);
    assert(f.supervisor.store.getUsageSummary().entries < beforeAccounting.length,
      "this crash cut must leave durable canonical usage not yet accounted at settlement");
    await crashActor(f); release.resolve();
    if (nativeOff) process.env.PI_HARNESS_NATIVE_ASYNC = "0";
    if (mismatch) {
      await rm(f.sidecars().kernelStatePath, { recursive: true, force: true });
      await cp(seedCopy, f.sidecars().kernelStatePath, { recursive: true });
    }
    await f.client.request("subscribe_session", { selector: f.sessionId });
    await submitAndSettle(f, "VERIFY_RECOVERY_WITHOUT_REPLAY");
    const results = resultsIn(await f.entries());
    const after = results.filter((result) => result.toolCallId === "A|fc_A");
    assert.equal(after.length, 1); assert.deepEqual(after[0], before, "known canonical result is unchanged");
    assert.match(text(results.find((result) => result.toolCallId === "verify|fc_verify")?.content),
      new RegExp(`RESTORED_VALUE ${mismatch ? 7 : 41}`));
    assert.equal(await readFile(path.join(f.cwd, "effect"), "utf8"), "x", "arbitrary side effect was not replayed");
    assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, 2);
    const journalUsage = (await f.entries()).map(projectAssistantUsageEntry).filter(Boolean);
    const accounting = f.supervisor.store.getUsageSummary();
    assert.equal(accounting.entries, journalUsage.length, "reconnect accounts each durable journal entry exactly once");
    assert.equal(accounting.totalTokens, journalUsage.reduce((sum, entry) => sum + entry.totalTokens, 0));
    assert.equal(accounting.costTotal, journalUsage.reduce((sum, entry) => sum + entry.costTotal, 0));
  });
}

test("in-run kernel death diagnoses the original call before further inference and rejects precomputed dependent cells", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t, (body, index) => {
    if (index === 1) return { calls: [{ id: "seed", code: "checkpoint_value = 7" }] };
    if (index === 2) return { answer: "SEED_SETTLED" };
    if (index === 3) return { calls: [
      { id: "A", code: 'import os\nwith open("effect", "a") as _effect: _effect.write("x")\nos._exit(17)' },
      { id: "B", code: 'with open("B-started", "w") as _effect: _effect.write("must not run")' },
    ] };
    if (index === 4) {
      const outputs = toolOutputs(body);
      assert.match(outputs.find((output) => output.call_id === "A")?.output, /Python namespace recovery diagnostic/);
      assert.match(outputs.find((output) => output.call_id === "A")?.output, /Restored checkpoint/);
      assert.match(outputs.find((output) => output.call_id === "B")?.output, /It did not run/);
      return { calls: [{ id: "verify", code: 'print("RECOVERED_LIVE_VALUE", checkpoint_value)' }] };
    }
    return { answer: "IN_RUN_RECOVERY_FINISHED" };
  });
  await submitAndSettle(f, "SEED_NAMESPACE");
  await submitAndSettle(f, "LOSE_KERNEL_WITH_QUEUED_DEPENDENCY");
  const results = resultsIn(await f.entries());
  assert.equal(results.filter((result) => result.toolCallId === "A|fc_A").length, 1);
  assert.equal(results.find((result) => result.toolCallId === "A|fc_A").isError, true);
  assert.equal(results.find((result) => result.toolCallId === "B|fc_B").isError, true);
  assert.match(text(results.find((result) => result.toolCallId === "verify|fc_verify")?.content), /RECOVERED_LIVE_VALUE 7/);
  await assert.rejects(access(path.join(f.cwd, "B-started")), /ENOENT/);
  assert.equal(await readFile(path.join(f.cwd, "effect"), "utf8"), "x");
  assert.equal(f.supervisor.store.getSession(f.sessionId).actorGeneration, 1, "only the kernel was replaced");
});

test("idle authenticated family wake exposes unknown recovery before its first inference with native mode off", { timeout: 120_000 }, async (t) => {
  const familyRequest = deferred(); let receiverId;
  const f = await fixture(t, (body, index, baseUrl) => {
    if (index === 1) return { calls: [{ id: "seed", code: "checkpoint_value = 7" }] };
    if (index === 2) return { answer: "SEED_SETTLED" };
    if (index === 3) return { calls: [{ id: "A", code: [
      'with open("effect", "a") as _effect: _effect.write("x")', heldCode(baseUrl, "A", "checkpoint_value = 99"),
    ].join("\n") }] };
    const last = body.input.at(-1);
    if (last?.role === "user" && text(last).includes("TRIGGER_SYNTHETIC_SENDER")) {
      return { calls: [{ id: "send", code: `await agent_message.send(${JSON.stringify(receiverId)}, "FAMILY_RECOVERY_NOTICE")` }] };
    }
    if (last?.role === "user" && text(last).includes("FAMILY_RECOVERY_NOTICE")) {
      familyRequest.resolve(body); return { answer: "FAMILY_RECOVERY_REPLY" };
    }
    if (last?.role === "user" && text(last).includes("VERIFY_RECEIVER_ORDINARY")) {
      return { calls: [{ id: "receiver-verify", async: false, code: 'print("ROLLBACK_NAMESPACE", checkpoint_value)' }] };
    }
    return { answer: "SENDER_FINISHED" };
  });
  receiverId = f.sessionId;
  await submitAndSettle(f, "SEED_NAMESPACE");
  await f.submit("EXECUTE_UNKNOWN_A");
  await bounded(f.gate("A").started.promise, "A side effect before actor crash");
  await crashActor(f); f.gate("A").release.resolve();
  process.env.PI_HARNESS_NATIVE_ASYNC = "0";
  const senderCwd = path.join(f.root, "sender"); await mkdir(senderCwd);
  const { admission: sender } = await f.client.request("create_root", { cwd: senderCwd, repositoryRoot: null,
    name: "synthetic-family-sender", provider: "openai-codex", model: "gpt-6-astra", thinkingLevel: "off" });
  const since = f.log.frames.length;
  await f.client.request("submit_input", { sessionId: sender.sessionId, message: "TRIGGER_SYNTHETIC_SENDER", behavior: "auto" });
  const body = await bounded(familyRequest.promise, "first reopened family inference");
  assert.match(body.instructions, /Python namespace recovery diagnostic/);
  assert.match(body.instructions, /Expected canonical checkpoint/);
  assert.match(body.instructions, /Restored checkpoint/);
  assert.match(body.instructions, /interrupted-unknown/);
  assert.match(body.instructions, /A\|fc_A/);
  assert.equal(body.tools[0].async, undefined, "rollback stops new native admissions but not recovery");
  await f.log.waitFrame((frame) => frame.event === "actor_event" && frame.data.sessionId === f.sessionId
    && frame.data.event.type === "agent_settled", "family recovery settles", since);
  const entries = await f.entries(); const results = resultsIn(entries);
  const recovered = results.filter((result) => result.toolCallId === "A|fc_A");
  assert.equal(recovered.length, 1); assert.equal(recovered[0].isError, true);
  assert.equal(recovered[0].details.nativeAsyncRecovery, "interrupted-unknown");
  assert.equal(entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 2,
    "the family wake does not fabricate a new user prompt or replacement result");
  assert.equal(entries.filter((entry) => entry.type === "custom_message" && text(entry).includes("FAMILY_RECOVERY_NOTICE")).length, 1);
  await submitAndSettle(f, "VERIFY_RECEIVER_ORDINARY");
  const after = resultsIn(await f.entries());
  assert.match(text(after.find((result) => result.toolCallId === "receiver-verify|fc_receiver-verify")?.content), /ROLLBACK_NAMESPACE 7/);
  assert.equal(after.filter((result) => result.toolCallId === "A|fc_A").length, 1);
  assert.equal(await readFile(path.join(f.cwd, "effect"), "utf8"), "x");
});

for (const { automatic, custom, kernelLoss } of [
  { automatic: false, custom: false }, { automatic: true, custom: false },
  { automatic: false, custom: true }, { automatic: true, custom: true },
  { automatic: false, custom: true, kernelLoss: true },
]) {
  test(`${automatic ? "automatic" : "manual"} ${custom ? "custom-hook" : "default"} compaction after ${kernelLoss ? "in-run kernel loss" : "reopen"} receives namespace recovery before inference`, { timeout: 120_000 }, async (t) => {
    const compactionRequest = deferred();
    const f = await fixture(t, (body, index) => {
      if (!body.tools?.length) {
        assert.equal(custom, false, "a custom hook returns its own result without a summary-provider request");
        assert.match(text(body), /Python namespace recovery diagnostic/, "every summary request receives recovery context");
        compactionRequest.resolve(body);
        return { answer: "Summary: preserve namespace recovery diagnostics and verify needed Python values." };
      }
      if (index === 1) return { calls: [{ id: "seed", code: "checkpoint_value = 7" }] };
      const last = body.input.at(-1);
      if (last?.role === "user" && text(last).includes("LOSE_KERNEL_BEFORE_COMPACTION")) {
        return { calls: [{ id: "lost", code: "import os\nos._exit(17)" }] };
      }
      if (last?.role === "user" && text(last).includes("LONG_SYNTHETIC_CONTEXT")) return { answer: "L".repeat(60_000) };
      if (last?.role === "user" && text(last).includes("VERIFY_AFTER_COMPACTION")) {
        return { calls: [{ id: "verify", code: 'print("COMPACTED_NAMESPACE", checkpoint_value)' }] };
      }
      return { answer: "COMPACTION_FIXTURE_SETTLED" };
    }, { customCompaction: custom });
    await submitAndSettle(f, "SEED_NAMESPACE");
    await submitAndSettle(f, "LONG_SYNTHETIC_CONTEXT_ONE");
    await submitAndSettle(f, "LONG_SYNTHETIC_CONTEXT_TWO");
    if (kernelLoss) await submitAndSettle(f, "LOSE_KERNEL_BEFORE_COMPACTION");
    else await crashActor(f);
    if (automatic) {
      // Seed only synthetic token accounting through Pi's public session owner.
      // This models a crash before an already-needed automatic compaction.
      const sdk = await import(pathToFileURL(path.join(path.dirname(process.env.PI_HARNESS_PI_MODULE), "index.js")).href);
      const session = f.supervisor.store.getSession(f.sessionId);
      const manager = sdk.SessionManager.open(session.sessionFile);
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "SYNTHETIC_COMPACTION_BOUNDARY" }],
        api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra", stopReason: "stop", timestamp: Date.now(),
        usage: { input: 30_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 30_001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      await f.client.request("subscribe_session", { selector: f.sessionId });
      await submitAndSettle(f, "VERIFY_AFTER_COMPACTION");
    } else {
      await f.client.request("compact_session", { sessionId: f.sessionId });
      await submitAndSettle(f, "VERIFY_AFTER_COMPACTION");
    }
    const observations = await f.customCompactions();
    assert.equal(observations.length, custom ? 1 : 0);
    const input = custom ? observations[0].customInstructions
      : text(await bounded(compactionRequest.promise, "default compaction provider request"));
    assert.match(input, /Python namespace recovery diagnostic/);
    assert.match(input, /Expected canonical checkpoint/);
    assert.match(input, /Restored checkpoint/);
    assert.match(input, /Skipped values/);
    const entries = await f.entries();
    const checkpoints = entries.filter(entry => entry.type === "compaction");
    assert.equal(checkpoints.length, 1, "the existing canonical owner commits one compaction");
    assert.equal(checkpoints[0].fromHook, custom);
    if (custom) {
      assert.equal(f.requests.filter(body => !body.tools?.length).length, 0);
      assert.equal(input.split("# Python namespace recovery diagnostic").length - 1, 1,
        "the hook receives the current diagnostic exactly once");
      assert.equal(observations[0].reason, automatic ? "threshold" : "manual");
      assert.equal(checkpoints[0].summary, observations[0].summary);
      assert.equal(checkpoints[0].firstKeptEntryId, observations[0].firstKeptEntryId);
      assert.equal(checkpoints[0].tokensBefore, observations[0].tokensBefore);
      assert.deepEqual(checkpoints[0].details, { fixture: "generic-custom-compaction" });
    }
    assert.match(text(resultsIn(entries).find((result) => result.toolCallId === "verify|fc_verify")?.content), /COMPACTED_NAMESPACE 7/);
  });
}


test("owner commits source-order native prefix before effects and appends late reasoning metadata without rewriting it", { timeout: 120_000 }, async t => {
  let f; const rawFinished = deferred();
  const cipher = "synthetic-owner-late-cipher";
  f = await fixture(t, (body, index, baseUrl) => {
    if (index > 1) {
      assert(body.input.some(item => item.type === "reasoning" && item.id === "rs_owner" && item.encrypted_content === cipher));
      return { answer: "SOURCE_ORDER_AND_CIPHER_REPLAYED" };
    }
    return { writeResponse: async (response, responseId) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const reasoning = { type: "reasoning", id: "rs_owner", status: "completed", summary: [{ type: "summary_text", text: "Plan before calls." }] };
      const call = (id, code) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name: "ipython", arguments: JSON.stringify({ code }), async: true, status: "completed" });
      const a = call("prefix-A", heldCode(baseUrl, "stream-A", 'stream_value = 40\nwith open("stream-order", "a") as output: output.write("A")\nprint("STREAM_A_REAL")'));
      const b = call("prefix-B", 'Path("stream-B-started").write_text("started")\nwith open("stream-order", "a") as output: output.write("B")\nprint("STREAM_B_REAL", stream_value + 2)');
      send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
      send({ type: "response.output_item.added", output_index: 0, item: { ...reasoning, status: "in_progress", summary: [] } });
      send({ type: "response.reasoning_summary_part.added", item_id: reasoning.id, summary_index: 0, part: { type: "summary_text", text: "" } });
      send({ type: "response.reasoning_summary_text.delta", item_id: reasoning.id, summary_index: 0, delta: "Plan before calls." });
      send({ type: "response.reasoning_summary_text.done", item_id: reasoning.id, summary_index: 0, text: "Plan before calls." });
      send({ type: "response.output_item.done", output_index: 0, item: reasoning });
      send({ type: "response.output_item.added", output_index: 1, item: { ...a, status: "in_progress", arguments: "" } });
      send({ type: "response.output_item.added", output_index: 2, item: { ...b, status: "in_progress", arguments: "" } });
      send({ type: "response.output_item.done", output_index: 2, item: b });
      await new Promise(resolve => setTimeout(resolve, 100));
      await assert.rejects(access(path.join(f.cwd, "stream-A-started")), /ENOENT/);
      await assert.rejects(access(path.join(f.cwd, "stream-B-started")), /ENOENT/);
      send({ type: "response.output_item.done", output_index: 1, item: a });
      await bounded(f.gate("stream-A").started.promise, "source A starts before provider terminal");
      await assert.rejects(access(path.join(f.cwd, "stream-B-started")), /ENOENT/);
      send({ type: "response.completed", response: { id: responseId, status: "completed", output: [{ ...reasoning, encrypted_content: cipher }],
        usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } });
      response.end(); rawFinished.resolve();
    } };
  });
  await f.submit("NATIVE_SOURCE_ORDER_PROOF");
  await bounded(rawFinished.promise, "provider terminal follows actual A start");
  f.gate("stream-A").release.resolve();
  await f.log.wait(settled, "source-order native work settles");
  assert.equal(await readFile(path.join(f.cwd, "stream-order"), "utf8"), "AB");
  const entries = await f.entries();
  const prefix = entries.find(entry => entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content) && entry.message.content.some(part => part.type === "toolCall" && part.id === "prefix-A|fc_prefix-A"));
  assert.deepEqual(prefix.message.content.filter(part => part.type === "toolCall").map(part => part.id), ["prefix-A|fc_prefix-A", "prefix-B|fc_prefix-B"]);
  assert.notEqual(JSON.parse(prefix.message.content[0].thinkingSignature).encrypted_content, cipher);
  const amendment = entries.find(entry => entry.type === "custom" && entry.customType === "persistent-harness:assistant-thinking-signature:v1");
  assert.deepEqual({ entry: amendment.data.messageEntryId, message: amendment.data.messageId, index: amendment.data.contentIndex,
    item: amendment.data.itemId, encrypted: amendment.data.encryptedContent },
    { entry: prefix.id, message: prefix.message.id, index: 0, item: "rs_owner", encrypted: cipher });
  const results = resultsIn(entries); assert.deepEqual(results.map(result => result.toolCallId), ["prefix-A|fc_prefix-A", "prefix-B|fc_prefix-B"]);
  assert(results.every(result => !result.isError)); assert.match(text(results[1].content), /STREAM_B_REAL 42/);
});


test("unknown inference-only EOF records uncertainty then retries a fresh steering snapshot", { timeout: 120_000 }, async t => {
  const f = await fixture(t, (body, index) => index === 1 ? { writeResponse: async (response, id) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}\n\n`);
  } } : (() => {
    assert.match(text(body), /NEW_INPUT_DURING_RETRY/); assert.equal(toolOutputs(body).length, 0);
    return { answer: "UNKNOWN_INFERENCE_RECOVERED" };
  })());
  await f.submit("INFERENCE_ONLY_EOF");
  await f.log.wait(event => event.type === "auto_retry_start", "eligible unknown retry is scheduled");
  await f.submit("NEW_INPUT_DURING_RETRY", "steer");
  await f.log.wait(settled, "unknown inference recovery completes");
  assert.equal(f.requests.length, 2); assert.equal(resultsIn(await f.entries()).length, 0);
  const decisions = (await f.entries()).filter(entry => entry.type === "custom" && entry.customType === "persistent-harness.inference-retry-v1");
  assert.equal(decisions.length, 2);
  for (const entry of decisions) {
    assert.equal(entry.data.classification, "retry_unknown");
    assert.equal(entry.data.observations.admittedCount, 0); assert.equal(entry.data.observations.dispatchedCount, 0);
    assert.equal(entry.data.priorAttempt.outcome, "unknown");
    assert.equal(entry.data.priorAttempt.possibleProcessing, true); assert.equal(entry.data.priorAttempt.possibleUsage, true);
  }
  assert(decisions[1].data.snapshotVersion > decisions[0].data.snapshotVersion);
});

for (const afterResult of [false, true]) test(`post-send unknown after ${afterResult ? "real result" : "Python start"} never replays admitted execution`, { timeout: 120_000 }, async t => {
  let f;
  f = await fixture(t, (_body, index, baseUrl) => {
    assert.equal(index, 1, "an admitted/effectful unknown must not automatically invoke provider again");
    return { writeResponse: async (response, responseId) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const code = afterResult ? 'with open("unknown-effect", "a") as output: output.write("x")\nprint("KNOWN_REAL_RESULT")'
        : heldCode(baseUrl, "unknown-start", 'Path("must-not-finish").write_text("bad")');
      const item = { type: "function_call", id: "fc_unknown", call_id: "unknown", name: "ipython", arguments: JSON.stringify({ code }), async: true, status: "completed" };
      send({ type: "response.created", response: { id: responseId, status: "in_progress" } });
      send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } });
      send({ type: "response.output_item.done", output_index: 0, item });
      if (afterResult) {
        const deadline = Date.now() + 30000;
        while (!(resultsIn(await f.entries()).some(result => result.toolCallId === "unknown|fc_unknown"))) {
          if (Date.now() >= deadline) throw new Error("real result did not become canonical");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      } else await bounded(f.gate("unknown-start").started.promise, "actual Python starts before unknown close");
      response.end();
    } };
  });
  await f.submit("EFFECTFUL_UNKNOWN");
  await f.log.wait(settled, "effectful unknown settles without retry");
  assert.equal(f.requests.length, 1);
  const entries = await f.entries(), results = resultsIn(entries);
  assert.equal(results.length, 1); assert.equal(results[0].toolCallId, "unknown|fc_unknown");
  assert.equal(results[0].isError, !afterResult);
  if (afterResult) { assert.match(text(results[0].content), /KNOWN_REAL_RESULT/); assert.equal(await readFile(path.join(f.cwd, "unknown-effect"), "utf8"), "x"); }
  else await assert.rejects(access(path.join(f.cwd, "must-not-finish")), /ENOENT/);
  const decisions = entries.filter(entry => entry.type === "custom" && entry.customType === "persistent-harness.inference-retry-v1");
  assert(decisions.length >= 1);
  assert(decisions.every(entry => !entry.data.decision.retry && entry.data.observations.admittedCount === 1 && entry.data.observations.dispatchedCount === 1));
});
