import assert from "node:assert/strict";
import http from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";

const providerPath = path.join(import.meta.dirname, "fixtures", "fake-native-codex-provider.ts");
const clmPath = process.env.PI_CLM_PATH;

function respond(response, id, { code, answer }) {
  const events = [{ type: "response.created", response: { id, status: "in_progress" } }];
  if (code) {
    const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "ipython", arguments: JSON.stringify({ code }) };
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    events.push({ type: "response.output_item.done", output_index: 0, item });
  } else {
    events.push({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_${id}`, role: "assistant",
      status: "completed", phase: "final_answer", content: [{ type: "output_text", text: answer, annotations: [] }] } });
  }
  events.push({ type: "response.completed", response: { id, status: "completed", output: [],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
async function mirrorPath(sessionId, parentDirectory = os.tmpdir()) {
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const prefix = `pi-live-context-${sessionId}-`;
  const names = (await readdir(parentDirectory)).filter(name => name.startsWith(prefix));
  assert.equal(names.length, 1, "expected exactly one mirror for the created test session");
  const directory = path.join(parentDirectory, names[0]);
  assert((await lstat(directory)).isDirectory(), "the test session mirror must be a real directory");
  const file = path.join(directory, "LIVE_CONTEXT.md");
  assert((await lstat(file)).isFile(), "the test session mirror must be a regular file");
  return file;
}

test("cold-history mirror lookup rejects other sessions, ambiguity and symlinks", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cold-mirror-lookup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = crypto.randomUUID();
  const decoy = path.join(root, `pi-live-context-${crypto.randomUUID()}-decoy1`);
  const decoyFile = path.join(decoy, "LIVE_CONTEXT.md");
  await mkdir(decoy);
  await writeFile(decoyFile, "another room must remain untouched");
  await assert.rejects(mirrorPath(sessionId, root), /exactly one mirror/);

  const directory = path.join(root, `pi-live-context-${sessionId}-owned1`);
  const file = path.join(directory, "LIVE_CONTEXT.md");
  await mkdir(directory);
  await assert.rejects(mirrorPath(sessionId, root), { code: "ENOENT" });
  await writeFile(file, "the created test session");
  assert.equal(await mirrorPath(sessionId, root), file);
  const duplicate = path.join(root, `pi-live-context-${sessionId}-owned2`);
  await mkdir(duplicate);
  await assert.rejects(mirrorPath(sessionId, root), /exactly one mirror/);
  await rm(duplicate, { recursive: true });

  await rm(file);
  await symlink(decoyFile, file);
  await assert.rejects(mirrorPath(sessionId, root), /regular file/);
  await rm(directory, { recursive: true });
  await symlink(decoy, directory);
  await assert.rejects(mirrorPath(sessionId, root), /real directory/);
  assert.equal(await readFile(decoyFile, "utf8"), "another room must remain untouched");
});
async function connect(socketPath) {
  const client = new HarnessClient({ requestTimeoutMs: 120_000, socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 });
  assert(await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() }));
  return client;
}
async function prompt(client, sessionId, message) {
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out on ${message}`)), 60_000);
    const listener = frame => {
      if (frame.event !== "actor_event" || frame.data?.sessionId !== sessionId || frame.data?.event?.type !== "agent_settled") return;
      clearTimeout(timer); client.off("event", listener); resolve();
    };
    client.on("event", listener);
  });
  await client.request("submit_input", { sessionId, message, behavior: "auto" });
  await settled;
}
const shape = input => input.filter(item => !["system", "developer"].includes(item.role))
  .map(item => `${item.type ?? item.role}:${JSON.stringify(item.content ?? item.output ?? item.arguments ?? "")}`);

test("a native session keeps its context through an edit, new messages and a restart", { timeout: 1440000, skip: !clmPath }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cold-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_HARNESS_AUTO_INSTALL ??= "0";
  t.after(() => { process.env.PI_CODING_AGENT_DIR = previous; });

  const bodies = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.headers.upgrade === "websocket") {
      response.writeHead(426, { connection: "close" }); response.end(); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString());
    bodies.push(body);
    const last = body.input.at(-1), index = bodies.length;
    if (last.role === "user" && JSON.stringify(last.content).includes("EDIT_NOW")) {
      const file = await mirrorPath(sessionId);
      respond(response, `R${index}`, { code: `from pathlib import Path\np = Path(${JSON.stringify(file)})\np.write_text(p.read_text().replace("reply 1", "EDITED_MARKER first"))\nprint("ok")` });
    } else respond(response, `R${index}`, { answer: `reply ${index}` });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  process.env.HARNESS_FAKE_NATIVE_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const socketPath = path.join(root, "run", "supervisor.sock");
  const options = { socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorExtensionPaths: [providerPath, clmPath] };
  let supervisor = new HarnessSupervisor(options);
  t.after(() => supervisor.stop());
  await supervisor.start();
  let client = await connect(socketPath);
  const { sessionId } = (await client.request("create_root", { cwd, repositoryRoot: null, name: "cold",
    provider: "openai-codex", model: "gpt-6.1-sol", thinkingLevel: null })).admission;
  await client.request("subscribe_session", { selector: sessionId });

  await prompt(client, sessionId, "OLD_MARKER first");
  await prompt(client, sessionId, "KEEP_MARKER second");
  await prompt(client, sessionId, "EDIT_NOW");
  await prompt(client, sessionId, "AFTER_EDIT");
  const seen = () => shape(bodies.at(-1).input).join("\n");
  assert.match(seen(), /EDITED_MARKER first/, "the edit reached the model");
  assert.doesNotMatch(seen(), /output_text[^\n]*reply 1/);
  assert.match(seen(), /OLD_MARKER first/, "protected messages stay");
  assert.match(seen(), /KEEP_MARKER/, "what it kept is still there");
  assert.match(seen(), /AFTER_EDIT/);

  const { entries } = await client.request("get_actor_entries", { sessionId, since: null });
  const checkpoint = entries.filter(entry => entry.customType === "live-context-state").at(-1)?.data?.checkpoint;
  assert.equal(typeof checkpoint?.sourceEntryId, "string", "the checkpoint carries its bookmark");

  await prompt(client, sessionId, "AFTER_EDIT_TWO");
  const beforeRestart = shape(bodies.at(-1).input);
  await client.stop(); await supervisor.stop();

  supervisor = new HarnessSupervisor(options);
  await supervisor.start();
  client = await connect(socketPath);
  await client.request("subscribe_session", { selector: sessionId });
  await prompt(client, sessionId, "AFTER_RESTART");
  const afterRestart = shape(bodies.at(-1).input);
  assert.deepEqual(afterRestart.slice(0, beforeRestart.length), beforeRestart, "a restart changes nothing the model sees");
  assert.match(afterRestart.at(-1), /AFTER_RESTART/);
  await client.stop();
});
