
import assert from "node:assert/strict";
import http from "node:http";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { AGENT_MESSAGE_ENTRY_TYPE } from "../src/agent-message-projection.mjs";
import { verifyOwnedProcessIdentity } from "../src/process-ownership.mjs";
import { sessionSidecarPaths } from "../src/session-paths.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

const fakeProviderPath = path.join(import.meta.dirname, "fixtures", "fake-provider.ts");
async function waitUntil(probe, description, timeoutMs = 60_000) { const deadline = Date.now() + timeoutMs; let last; while (Date.now() < deadline) { try { const value = await probe(); if (value) return value; } catch (error) { last = error; } await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error(`timed out waiting for ${description}${last ? `: ${last.message}` : ""}`); }
function sendTool(send, base, code, index) { send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${index}`, type: "function", function: { name: "ipython", arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }); }
function sendText(send, base, text) { send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }); send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); }
function textOf(message) { return JSON.stringify(message?.content ?? ""); }
function systemText(body) { return String(body.messages?.find((message) => message.role === "system")?.content ?? ""); }
function requestForUserText(bodies, marker) { return bodies.find((body) => body.messages?.some((message) => message.role === "user" && textOf(message).includes(marker))); }
async function connect(socketPath) { const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 120_000 }); const registered = await client.start({ registrationType: "register_client", clientInstanceId: crypto.randomUUID() }); assert(registered); return client; }
async function submitAndSettle(client, sessionId, message, timeoutMs = 120_000) { const settled = new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out settling ${message}`)); }, timeoutMs); const listener = (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === sessionId && frame.data?.event?.type === "agent_settled") { cleanup(); resolve(); } }; const cleanup = () => { clearTimeout(timer); client.off("event", listener); }; client.on("event", listener); }); await client.request("submit_input", { sessionId, message, behavior: "auto" }); await settled; }
async function entries(client, sessionId) { return (await client.request("get_actor_entries", { sessionId, since: null })).entries; }

// Corrected Gate P: actor lifetime is independent of every detachable client.
test("Gate P: unified roots and children survive detach, navigate directly, multiplex input, and colocate state", { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-gate-p-"));
  const agentDir = path.join(root, "agent"); const cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(agentDir, "AGENTS.md"), "UNIVERSAL_WORK_ETHIC"),
    writeFile(path.join(agentDir, "AGENTS.depth-0.md"), "ROOT_ONLY_PERSONA"),
    writeFile(path.join(agentDir, "AGENTS.depth-1.md"), "DEPTH_ONE_ROLE"),
    writeFile(path.join(agentDir, "AGENTS.depth-2.md"), "LEVEL_TWO_SCOPE"),
  ]);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, auto: process.env.PI_HARNESS_AUTO_INSTALL, base: process.env.HARNESS_FAKE_BASE_URL };
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_HARNESS_AUTO_INSTALL ??= "1";
  t.after(() => { for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: previous.agentDir, PI_HARNESS_AUTO_INSTALL: previous.auto, HARNESS_FAKE_BASE_URL: previous.base })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

  let releaseA; let sawHoldA; const holdASeen = new Promise((resolve) => { sawHoldA = resolve; }); const holdA = new Promise((resolve) => { releaseA = resolve; }); let heldA = false; t.after(() => releaseA?.());
  let releaseC; let sawHoldC; const holdCSeen = new Promise((resolve) => { sawHoldC = resolve; }); const holdC = new Promise((resolve) => { releaseC = resolve; }); let heldC = false; t.after(() => releaseC?.());
  const providerBodies = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); providerBodies.push(body);
    const last = body.messages?.at(-1); const lastText = textOf(last); const index = providerBodies.length;
    if (last?.role === "user" && lastText.includes("HOLD_A") && !heldA) { heldA = true; sawHoldA(); await holdA; }
    if (last?.role === "user" && lastText.includes("HOLD_C") && !heldC) { heldC = true; sawHoldC(); await holdC; }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `gate-p-${index}`, object: "chat.completion.chunk", created: 1, model: "fake-model" }; const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    let code = null;
    if (last?.role === "user" && lastText.includes("KERNEL_SET")) code = "detached_value = 41; print(detached_value)";
    else if (last?.role === "user" && lastText.includes("KERNEL_GET")) code = "print(detached_value + 1)";
    else if (last?.role === "user" && lastText.includes("SEND_TO_A")) code = "await agent_message.send('root-a', 'MESSAGE-WHILE-DETACHED')";
    else if (last?.role === "user" && lastText.includes("SPAWN_CHILD")) code = "await rlm('  CHILD_INITIAL  ', name='child-c')";
    else if (last?.role === "user" && lastText.includes("SPAWN_GRAND")) code = "await rlm('GRAND_INITIAL', name='grand-g')";
    else if (last?.role === "user" && lastText.includes("SPAWN_SIBLING")) code = "await rlm('SIBLING_INITIAL', name='child-s')";
    else if (last?.role === "user" && lastText.includes("SIBLING_TO_C")) code = "agent_message.send('child-c', 'SIBLING-CONCURRENT')";
    else if (last?.role === "user" && lastText.includes("SEND_TO_C")) code = "agent_message.send('child-c', 'PARENT-CONCURRENT')";
    // Compaction quotes earlier marker text but does not advertise tools.
    if (code && body.tools?.some((tool) => tool.function?.name === "ipython")) sendTool(send, base, code, index);
    else sendText(send, base, lastText.includes("LONG_CONTEXT") ? "X".repeat(24_000) : lastText.includes("MESSAGE-WHILE-DETACHED") ? "received-detached-message" : lastText.includes("PARENT-CONCURRENT") ? "received-parent-concurrent" : `answer-${index}`);
    send({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }); response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address(); assert(address && typeof address === "object"); process.env.HARNESS_FAKE_BASE_URL = `http://127.0.0.1:${address.port}/v1`;

  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"), actorExtensionPaths: [fakeProviderPath], actorInactivityMs: 0, maxResidentActors: 4, maxDepth: 2 });
  await supervisor.start(); t.after(() => supervisor.stop());
  const ui = await connect(socketPath); t.after(() => ui.stop());
  const rootA = (await ui.request("create_root", { cwd, repositoryRoot: null, name: "root-a", provider: "harness-fake", model: "fake-model", thinkingLevel: null })).admission;
  const rootB = (await ui.request("create_root", { cwd, repositoryRoot: null, name: "root-b", provider: "harness-fake", model: "fake-model", thinkingLevel: null })).admission;
  const renamedRootB = await ui.request("rename_session", { sessionId: rootB.sessionId, name: "root-b-web" });
  assert.equal(renamedRootB.session.name, "root-b-web");
  await ui.request("subscribe_session", { selector: rootA.sessionId });
  await submitAndSettle(ui, rootA.sessionId, "KERNEL_SET");
  const pidBeforeDetach = supervisor.store.getSession(rootA.sessionId).actorPid; assert(pidBeforeDetach);

  await ui.request("submit_input", { sessionId: rootA.sessionId, message: "HOLD_A", behavior: "auto" }); await holdASeen;
  await ui.request("unsubscribe_session", { sessionId: rootA.sessionId });
  await ui.request("submit_input", { sessionId: rootB.sessionId, message: "SEND_TO_A", behavior: "auto" });
  await ui.stop(); // zero detachable clients remain; both actors continue.
  await waitUntil(() => supervisor.store.listMessages().some((message) => message.targetId === rootA.sessionId && ["delivered", "acknowledged"].includes(message.state)), "B→A delivery while detached", 120_000);
  releaseA();
  await waitUntil(() => supervisor.store.listMessages().some((message) => message.targetId === rootA.sessionId && message.state === "acknowledged"), "B→A acknowledgement", 120_000);
  assert.equal(supervisor.store.getSession(rootA.sessionId).actorPid, pidBeforeDetach);

  const ui2 = await connect(socketPath); t.after(() => ui2.stop());
  await ui2.request("subscribe_session", { selector: rootA.sessionId });
  await submitAndSettle(ui2, rootA.sessionId, "KERNEL_GET");
  const preCompactJson = JSON.stringify(await entries(ui2, rootA.sessionId));
  assert.match(preCompactJson, /received-detached-message/); assert.match(preCompactJson, /MESSAGE-WHILE-DETACHED/); assert.match(preCompactJson, /42/);
  const visible = await ui2.request("get_visible_messages", { sessionId: rootA.sessionId });
  assert(visible.messages.length > 0); assert(visible.messages.every((message) => ["user", "assistant"].includes(message.role)));
  assert.doesNotMatch(JSON.stringify(visible.messages), /persistent-harness-input|toolResult|thinkingSignature/);
  const incomingCommunication = visible.history.find((item) => item.kind === "agent_message" && item.body === "MESSAGE-WHILE-DETACHED");
  assert.deepEqual({ direction: incomingCommunication?.direction, relationship: incomingCommunication?.relationship, peerName: incomingCommunication?.peerName },
    { direction: "from", relationship: "sister", peerName: "root-b-web" });
  const rootBEntries = await entries(ui2, rootB.sessionId);
  assert.equal(rootBEntries.filter((entry) => entry.type === "custom" && entry.customType === AGENT_MESSAGE_ENTRY_TYPE
    && entry.data?.direction === "to" && entry.data?.body === "MESSAGE-WHILE-DETACHED" && entry.data?.relationship === "sibling").length, 1);
  assert.equal(supervisor.store.listMessages().filter((message) => message.senderId === rootB.sessionId
    && message.targetId === rootA.sessionId && message.body === "MESSAGE-WHILE-DETACHED").length, 1);
  for (let index = 0; index < 4; index += 1) await submitAndSettle(ui2, rootA.sessionId, `LONG_CONTEXT_${index}`);
  await ui2.request("compact_session", { sessionId: rootA.sessionId });
  await submitAndSettle(ui2, rootA.sessionId, "KERNEL_GET");
  await ui2.request("stop_session", { sessionId: rootA.sessionId });
  assert.equal(supervisor.store.getSession(rootA.sessionId).lifecycle, "stopped");
  const revivedA = await ui2.request("subscribe_session", { selector: rootA.sessionId });
  assert.equal(revivedA.session.sessionId, rootA.sessionId);
  assert.notEqual(revivedA.session.actorPid, pidBeforeDetach);
  await submitAndSettle(ui2, rootA.sessionId, "KERNEL_GET");
  const aEntries = await entries(ui2, rootA.sessionId); const aJson = JSON.stringify(aEntries);
  assert.match(aJson, /42/); assert(aEntries.some((entry) => entry.type === "compaction"));

  await submitAndSettle(ui2, rootA.sessionId, "SPAWN_CHILD");
  const child = await waitUntil(() => supervisor.store.listChildren(rootA.sessionId).find((item) => item.name === "child-c" && item.lifecycle === "resident"), "resident child", 120_000);
  const childCreationEntries = await entries(ui2, rootA.sessionId);
  assert.equal(childCreationEntries.filter((entry) => entry.type === "custom" && entry.customType === "persistent-harness.child-creation-v1"
    && entry.data?.childId === child.sessionId && entry.data?.childName === "child-c" && entry.data?.body === "CHILD_INITIAL").length, 1);
  const childAttached = await ui2.request("subscribe_session", { selector: child.sessionId }); assert.equal(childAttached.session.kind, "child");
  await submitAndSettle(ui2, child.sessionId, "direct child conversation");
  await submitAndSettle(ui2, child.sessionId, "SPAWN_GRAND");
  const grandchild = await waitUntil(() => supervisor.store.listChildren(child.sessionId).find((item) => item.name === "grand-g" && item.lifecycle === "resident"), "resident grandchild", 120_000);
  const grandAttached = await ui2.request("subscribe_session", { selector: grandchild.sessionId });
  assert.equal(grandAttached.session.depth, 2);
  await submitAndSettle(ui2, grandchild.sessionId, "direct grandchild conversation");
  const rootSystem = systemText(await waitUntil(() => requestForUserText(providerBodies, "KERNEL_SET"), "root provider request"));
  const childSystem = systemText(await waitUntil(() => requestForUserText(providerBodies, "direct child conversation"), "child provider request"));
  const grandchildSystem = systemText(await waitUntil(() => requestForUserText(providerBodies, "direct grandchild conversation"), "grandchild provider request"));
  assert.match(rootSystem, /UNIVERSAL_WORK_ETHIC/); assert.match(rootSystem, /ROOT_ONLY_PERSONA/);
  assert.doesNotMatch(rootSystem, /DEPTH_ONE_ROLE|LEVEL_TWO_SCOPE/);
  assert.match(childSystem, /UNIVERSAL_WORK_ETHIC/); assert.match(childSystem, /DEPTH_ONE_ROLE/);
  assert.doesNotMatch(childSystem, /ROOT_ONLY_PERSONA|LEVEL_TWO_SCOPE/);
  assert.match(grandchildSystem, /UNIVERSAL_WORK_ETHIC/); assert.match(grandchildSystem, /LEVEL_TWO_SCOPE/);
  assert.doesNotMatch(grandchildSystem, /ROOT_ONLY_PERSONA|DEPTH_ONE_ROLE/);
  await submitAndSettle(ui2, rootA.sessionId, "SPAWN_SIBLING");
  const sibling = await waitUntil(() => supervisor.store.listChildren(rootA.sessionId).find((item) => item.name === "child-s" && item.lifecycle === "resident"), "resident child sibling", 120_000);
  assert(supervisor.store.listSessions().filter((session) => session.actorPid).length <= 4);

  // Two UI subscribers observe one provider turn; parent and sibling input remain available concurrently.
  let ui2Deltas = 0; let ui3Deltas = 0;
  ui2.on("event", (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === child.sessionId && frame.data?.event?.type === "message_update") ui2Deltas += 1; });
  const providerBefore = providerBodies.length;
  await ui2.request("submit_input", { sessionId: child.sessionId, message: "HOLD_C", behavior: "auto" }); await holdCSeen;
  const ui3 = await connect(socketPath); t.after(() => ui3.stop());
  const midstreamAttach = await ui3.request("subscribe_session", { selector: child.sessionId });
  assert.equal(midstreamAttach.state.isStreaming, true); assert(midstreamAttach.events.length > 0); assert(midstreamAttach.eventSeq > 0);
  ui3.on("event", (frame) => { if (frame.event === "actor_event" && frame.data?.sessionId === child.sessionId && frame.data?.event?.type === "message_update") ui3Deltas += 1; });
  await ui2.request("submit_input", { sessionId: rootA.sessionId, message: "SEND_TO_C", behavior: "auto" });
  await ui2.request("submit_input", { sessionId: sibling.sessionId, message: "SIBLING_TO_C", behavior: "auto" });
  await waitUntil(() => supervisor.store.listMessages().filter((message) => message.targetId === child.sessionId && ["delivered", "acknowledged"].includes(message.state)).length === 2, "parent and sibling messages queued into viewed child", 120_000);
  releaseC();
  await waitUntil(() => supervisor.store.listMessages().filter((message) => message.targetId === child.sessionId && message.state === "acknowledged").length === 2, "parent and sibling messages acknowledged by child", 120_000);
  await waitUntil(() => supervisor.store.getSession(child.sessionId).activity === "idle", "child settlement", 120_000);
  assert(ui2Deltas > 0 && ui3Deltas > 0); assert(providerBodies.length >= providerBefore + 2);
  const cEntries = await entries(ui2, child.sessionId); const cJson = JSON.stringify(cEntries);
  assert.match(cJson, /PARENT-CONCURRENT/);
  assert.equal(cEntries.filter((entry) => entry.type === "custom_message" && JSON.stringify(entry).includes("PARENT-CONCURRENT")).length, 1);
  assert.equal(cEntries.filter((entry) => entry.type === "custom_message" && JSON.stringify(entry).includes("SIBLING-CONCURRENT")).length, 1);

  const sessions = supervisor.store.listSessions(); assert(sessions.some((item) => item.kind === "root") && sessions.some((item) => item.kind === "child"));
  for (const session of sessions) {
    assert.equal(path.dirname(session.sessionFile).startsWith(path.join(agentDir, "sessions")), true);
    assert.equal(session.sessionFile.includes("child-artifacts"), false); assert.equal(session.sessionFile.includes("pi-sessions"), false);
  }
  const aPaths = sessionSidecarPaths(supervisor.store.getSession(rootA.sessionId).sessionFile);
  await Promise.all([access(aPaths.skillManifestPath), access(aPaths.kernelStatePath)]);
  const cPaths = sessionSidecarPaths(child.sessionFile); await Promise.all([access(cPaths.skillGrantPath), access(cPaths.capabilitiesPath)]);
  const agentEntries = await readdir(agentDir); assert.equal(agentEntries.includes("session-artifacts"), false); assert.equal(agentEntries.includes("child-artifacts"), false);
  const ownedActors = supervisor.store.listSessions().map((session) => session.actorIdentity).filter(Boolean);
  await Promise.all([ui2.stop(), ui3.stop()]);
  await supervisor.stop();
  for (const identity of ownedActors) assert.equal(await verifyOwnedProcessIdentity(identity), false);
});
