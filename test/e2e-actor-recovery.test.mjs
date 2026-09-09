
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { controlRequest } from "../src/control.mjs";
import { verifyOwnedProcessIdentity } from "../src/process-ownership.mjs";
import { HarnessStore } from "../src/store.mjs";

const supervisorBin = path.resolve(import.meta.dirname, "..", "bin", "harness-supervisor.mjs");
const fakeProviderPath = path.join(import.meta.dirname, "fixtures", "fake-provider.ts");
function privateSession(databasePath, sessionId) {
  const store = new HarnessStore(databasePath, { readOnly: true });
  try { return store.getSession(sessionId); } finally { store.close(); }
}
async function waitUntil(probe, description, timeoutMs = 60_000) { const deadline = Date.now() + timeoutMs; let last; while (Date.now() < deadline) { try { const result = await probe(); if (result) return result; } catch (error) { last = error; } await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error(`timed out waiting for ${description}${last ? `: ${last.message}` : ""}`); }
function waitLine(stream, timeoutMs = 30_000) { return new Promise((resolve, reject) => { let buffer = ""; const timer = setTimeout(() => cleanup(new Error("timed out waiting for daemon startup")), timeoutMs); const data = (chunk) => { buffer += chunk.toString("utf8"); const newline = buffer.indexOf("\n"); if (newline >= 0) { try { cleanup(null, JSON.parse(buffer.slice(0, newline))); } catch (error) { cleanup(error); } } }; const cleanup = (error, value) => { clearTimeout(timer); stream.off("data", data); if (error) reject(error); else resolve(value); }; stream.on("data", data); }); }
async function client(socketPath) { const value = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 }); assert(await value.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() })); return value; }
async function submitAndSettle(value, sessionId, message) { const done = new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error("settle timeout")); }, 60_000); const listener = (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === sessionId && frame.data?.event?.type === "agent_settled") { cleanup(); resolve(); } }; const cleanup = () => { clearTimeout(timer); value.off("event", listener); }; value.on("event", listener); }); await value.request("submit_input", { sessionId, message, behavior: "auto" }); await done; }

test("supervisor crash recovers one canonical actor without changing Pi identity or leaving the old writer", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-actor-recovery-")); const agentDir = path.join(root, "agent"); const cwd = path.join(root, "project"); await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  let releaseCrashHold; let sawCrashHold; const crashHoldSeen = new Promise((resolve) => { sawCrashHold = resolve; }); const crashHold = new Promise((resolve) => { releaseCrashHold = resolve; }); t.after(() => releaseCrashHold?.()); let held = false;
  let count = 0; const server = http.createServer(async (request, response) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); const lastText = JSON.stringify(body.messages?.at(-1)?.content ?? ""); if (lastText.includes("CRASH_HOLD") && !held) { held = true; sawCrashHold(); await crashHold; } count += 1; response.writeHead(200, { "content-type": "text/event-stream" }); const base = { id: `recovery-${count}`, object: "chat.completion.chunk", created: 1, model: "fake-model" }; const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`); send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: { content: `recovery-answer-${count}` }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); send({ ...base, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }); response.end("data: [DONE]\n\n"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve))); const address = server.address(); assert(address && typeof address === "object");
  const socketPath = path.join(root, "run", "supervisor.sock"); const databasePath = path.join(root, "state", "harness.sqlite"); const pidPath = path.join(root, "run", "supervisor.pid");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_HARNESS_SOCKET: socketPath, PI_HARNESS_DATABASE: databasePath, PI_HARNESS_PID: pidPath, PI_HARNESS_ACTOR_EXTENSIONS: JSON.stringify([fakeProviderPath]), PI_HARNESS_ACTOR_INACTIVITY_MS: "0", PI_HARNESS_AUTO_INSTALL: "1", HARNESS_FAKE_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
  const daemons = [];
  const startDaemon = async () => { const daemon = spawn(process.execPath, [supervisorBin, "start", "--socket", socketPath, "--db", databasePath, "--pid", pidPath], { env, stdio: ["ignore", "pipe", "pipe"] }); daemons.push(daemon); let stderr = ""; daemon.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); }); daemon.once("exit", () => { daemon.failureText = stderr; }); await waitLine(daemon.stdout); return daemon; };
  t.after(async () => { try { await controlRequest(socketPath, "shutdown_daemon", {}, { timeoutMs: 1000 }); } catch {} for (const daemon of daemons) if (daemon.exitCode === null) daemon.kill("SIGKILL"); });

  const daemon1 = await startDaemon(); const ui1 = await client(socketPath);
  const admitted = (await ui1.request("create_root", { cwd, repositoryRoot: null, name: "recovery-root", provider: "harness-fake", model: "fake-model", thinkingLevel: null })).admission;
  await ui1.request("subscribe_session", { selector: admitted.sessionId }); await submitAndSettle(ui1, admitted.sessionId, "before crash");
  await ui1.request("submit_input", { sessionId: admitted.sessionId, message: "CRASH_HOLD", behavior: "auto" });
  await crashHoldSeen;
  const queued = await ui1.request("submit_input", { sessionId: admitted.sessionId, message: "QUEUED-AFTER-CRASH", behavior: "follow_up" });
  assert(queued.inputId);
  const publicBefore = (await ui1.request("get_status")).sessions.find((item) => item.sessionId === admitted.sessionId);
  assert(publicBefore); assert.equal(Object.hasOwn(publicBefore, "actorIdentity"), false); assert.equal(Object.hasOwn(publicBefore, "actorToken"), false);
  const before = privateSession(databasePath, admitted.sessionId);
  assert(before?.actorIdentity, "the private fixture database must retain the actor's exact ownership identity");
  const oldIdentity = before.actorIdentity; const sessionFile = before.sessionFile;
  assert.equal(oldIdentity.pid, before.actorPid); assert.equal(publicBefore.actorPid, oldIdentity.pid);
  assert.equal(publicBefore.actorGeneration, before.actorGeneration);
  assert(await verifyOwnedProcessIdentity(oldIdentity), "the pre-crash writer must match its durable private identity");
  daemon1.kill("SIGKILL"); await once(daemon1, "exit");

  const daemon2 = await startDaemon(); assert.equal(daemon2.exitCode, null); releaseCrashHold();
  const ui2 = await client(socketPath); const attached = await ui2.request("subscribe_session", { selector: admitted.sessionId });
  assert.equal(attached.session.sessionId, admitted.sessionId); assert.equal(attached.session.sessionFile, sessionFile); assert.notEqual(attached.session.actorPid, oldIdentity.pid);
  assert.equal(Object.hasOwn(attached.session, "actorIdentity"), false); assert.equal(Object.hasOwn(attached.session, "actorToken"), false);
  const after = privateSession(databasePath, admitted.sessionId);
  assert(after?.actorIdentity, "the recovered writer must have an exact private ownership identity");
  assert.equal(after.actorIdentity.pid, after.actorPid); assert.equal(after.actorPid, attached.session.actorPid);
  assert(after.actorGeneration > before.actorGeneration); assert.equal(after.sessionFile, sessionFile);
  assert(await verifyOwnedProcessIdentity(after.actorIdentity), "the recovered writer must match its durable private identity");
  await waitUntil(async () => !await verifyOwnedProcessIdentity(oldIdentity), "old actor writer termination");
  await waitUntil(async () => JSON.stringify((await ui2.request("get_actor_entries", { sessionId: admitted.sessionId, since: null })).entries).includes("QUEUED-AFTER-CRASH"), "durable queued input replay");
  await waitUntil(async () => !(await ui2.request("get_actor_state", { sessionId: admitted.sessionId })).state.isStreaming, "replayed input settlement");
  await submitAndSettle(ui2, admitted.sessionId, "after crash"); const history = await ui2.request("get_actor_entries", { sessionId: admitted.sessionId, since: null }); const serialized = JSON.stringify(history.entries); assert.match(serialized, /before crash/); assert.match(serialized, /after crash/); assert.match(serialized, /QUEUED-AFTER-CRASH/);
  assert.equal(history.entries.filter((entry) => entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry).includes("QUEUED-AFTER-CRASH")).length, 1);
  await ui2.stop(); await controlRequest(socketPath, "shutdown_daemon", {}, { timeoutMs: 5000 }); await once(daemon2, "exit");
});
