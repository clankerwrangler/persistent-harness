
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { JsonLineDecoder, encodeFrame } from "../src/framing.mjs";
import { PROTOCOL_VERSION } from "../src/protocol.mjs";
import { RootOutputProjector } from "../src/root-output-projector.mjs";
import { KERNEL_RELOAD_COMMAND, retryBranchMessage } from "../src/session-actions.mjs";
import { defaultRootName } from "../src/root-title.mjs";
import { actorInputCustomPayload, ACTOR_INPUT_COMMAND } from "../src/protocol.mjs";
import { createRootTitleGenerator } from "../src/root-title-generator.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class InjectedRootOutputProjector extends EventEmitter {
  active = true;
  cursor = 0;
  generation = "injected-root-output";
  accept() { return []; }
  failSession() {}
  subscribe() { return { generation: this.generation, cursor: this.cursor, oldestSeq: null, gap: false, events: [] }; }
  publish(frame) { this.cursor = Math.max(this.cursor, frame.seq ?? 0); this.emit("event", frame); }
}

test("root-output protocol backpressure disconnects only a slow subscriber and stays serialization-inert without one", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-output-backpressure-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const projector = new InjectedRootOutputProjector();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0, rootOutputProjector: projector });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });

  const healthy = new HarnessClient({ socketPath, heartbeatMs: 0 });
  const healthyEvents = [];
  healthy.on("event", (frame) => { if (frame.event === "root_output_event") healthyEvents.push(frame.data); });
  const registered = await healthy.start({ registrationType: "register_client", clientInstanceId: "root-output-healthy" });
  assert.equal(registered.limits.rootOutputSseVersion, 1);
  assert.equal(registered.limits.rootOutputPresentationVersion, 1);
  t.after(() => healthy.stop());

  let serializations = 0;
  const countedFrame = (seq, delta) => {
    const frame = { type: "root_output", generation: projector.generation, seq, event: { type: "text_delta",
      sessionId: "root-session", turnId: "root-session:g1:t1", actorGeneration: 1,
      messageIndex: 1, deltaSeq: seq, contentIndex: 0, delta } };
    return { ...frame, toJSON() { serializations += 1; return frame; } };
  };

  projector.publish(countedFrame(1, "not serialized"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serializations, 0, "a root frame must not be encoded when nobody is subscribed");
  assert.equal(healthyEvents.length, 0, "an unsubscribed client must not receive root output");

  const slow = net.createConnection(socketPath);
  t.after(() => slow.destroy());
  await new Promise((resolve, reject) => { slow.once("connect", resolve); slow.once("error", reject); });
  const decoder = new JsonLineDecoder(); const slowFrames = [];
  slow.on("data", (chunk) => slowFrames.push(...decoder.push(chunk)));
  const request = (id, type, params) => slow.write(encodeFrame({ version: PROTOCOL_VERSION, id, type, params }));
  request("register-slow", "register_client", { clientInstanceId: "root-output-slow" });
  await eventually(() => slowFrames.find((frame) => frame.id === "register-slow" && frame.ok));
  request("subscribe-slow", "subscribe_root_output", {});
  await eventually(() => slowFrames.find((frame) => frame.id === "subscribe-slow" && frame.ok));

  let slowClosed = false; slow.once("close", () => { slowClosed = true; }); slow.pause();
  const largeDelta = "x".repeat(32 * 1024);
  let nextSeq = 2;
  for (let batch = 0; batch < 512 && !slowClosed; batch += 1) {
    for (let index = 0; index < 8; index += 1) projector.publish(countedFrame(nextSeq, largeDelta)), nextSeq += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!slowClosed) slow.resume();
  await eventually(() => slowClosed, 5000);
  assert(serializations > 0, "the subscribed slow client must receive encoded root frames before backpressure");

  const afterSlowClose = serializations;
  projector.publish(countedFrame(nextSeq++, "still inert"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serializations, afterSlowClose, "destroying the slow subscriber must clear its root subscription");
  assert.equal((await healthy.request("get_status")).running, true, "the supervisor and unrelated clients must remain healthy");

  const peer = new HarnessClient({ socketPath, heartbeatMs: 0 }); const peerEvents = [];
  peer.on("event", (frame) => { if (frame.event === "root_output_event") peerEvents.push(frame.data); });
  await peer.start({ registrationType: "register_client", clientInstanceId: "root-output-peer" });
  t.after(() => peer.stop());
  await Promise.all([healthy.request("subscribe_root_output", {}), peer.request("subscribe_root_output", {})]);
  const beforeSharedFrame = serializations; const sharedSeq = nextSeq++;
  projector.publish(countedFrame(sharedSeq, "shared healthy frame"));
  await eventually(() => healthyEvents.some((frame) => frame.seq === sharedSeq) && peerEvents.some((frame) => frame.seq === sharedSeq));
  assert.equal(serializations, beforeSharedFrame + 1, "one encoded root frame must be shared by all subscribed clients");
  assert.equal((await peer.request("get_status")).pid, (await healthy.request("get_status")).pid);
});

test("request-id replay protection stays bounded across long-lived protocol connections", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-request-id-longevity-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });

  supervisor.store.createRoot({ sessionId: "request-id-root", sessionFile: path.join(root, "request-id-root.jsonl"), cwd: root,
    repositoryRoot: null, name: "Before", actorToken: "request-id-token", launch: {} }, 1);
  const originalSetSessionName = supervisor.store.setSessionName.bind(supervisor.store); let renameCalls = 0;
  supervisor.store.setSessionName = (...args) => { renameCalls += 1; return originalSetSessionName(...args); };

  const healthy = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await healthy.start({ registrationType: "register_client", clientInstanceId: "request-id-healthy-peer" });
  t.after(() => healthy.stop());

  const raw = net.createConnection(socketPath); const decoder = new JsonLineDecoder(); const frames = []; let rawClosed = false;
  raw.on("data", (chunk) => frames.push(...decoder.push(chunk))); raw.once("close", () => { rawClosed = true; });
  t.after(() => raw.destroy()); await once(raw, "connect");
  const frame = (id, type, params) => ({ version: PROTOCOL_VERSION, id, type, params });
  const send = async (value) => { if (!raw.write(encodeFrame(value))) await once(raw, "drain"); };

  await send(frame("old-registration-id", "register_client", { clientInstanceId: "request-id-long-lived" }));
  await eventually(() => frames.some((item) => item.id === "old-registration-id" && item.ok));
  for (let index = 0; index < 4097; index += 1) await send(frame(`heartbeat-${index}`, "heartbeat", {}));
  await eventually(() => frames.some((item) => item.id === "heartbeat-4096" && item.ok), 10_000);
  assert.equal(rawClosed, false, "more than 4096 completed requests must not close a healthy connection");
  assert.equal(frames.filter((item) => item.type === "response" && item.requestType === "heartbeat" && item.ok).length, 4097);

  await send(frame("old-registration-id", "heartbeat", {}));
  await eventually(() => frames.filter((item) => item.id === "old-registration-id" && item.ok).length === 2);
  assert.equal(frames.filter((item) => item.id === "old-registration-id")[1].data.alive, true,
    "an ID older than the bounded completed cache may be reused as a new request");

  await send(frame("recent-mutation", "rename_session", { sessionId: "request-id-root", name: "Renamed once" }));
  await eventually(() => frames.some((item) => item.id === "recent-mutation" && item.ok));
  raw.write(Buffer.concat([
    encodeFrame(frame("recent-mutation", "rename_session", { sessionId: "request-id-root", name: "Must not replay" })),
    encodeFrame(frame("cancelled-after-replay", "rename_session", { sessionId: "request-id-root", name: "Must be cancelled" })),
  ]));
  await eventually(() => frames.some((item) => item.type === "protocol_error" && item.code === "duplicate_request_id") && rawClosed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renameCalls, 1, "a recent duplicate mutation and queued work after its disconnect must not replay");
  assert.equal(supervisor.store.getSession("request-id-root").name, "Renamed once");
  assert.equal(frames.filter((item) => item.id === "recent-mutation").length, 1, "the prior response must not be replayed");
  assert.equal(frames.some((item) => item.id === "cancelled-after-replay"), false);

  const inFlight = net.createConnection(socketPath); const inFlightDecoder = new JsonLineDecoder(); const inFlightFrames = []; let inFlightClosed = false;
  inFlight.on("data", (chunk) => inFlightFrames.push(...inFlightDecoder.push(chunk))); inFlight.once("close", () => { inFlightClosed = true; });
  t.after(() => inFlight.destroy()); await once(inFlight, "connect");
  inFlight.write(encodeFrame(frame("register-in-flight", "register_client", { clientInstanceId: "request-id-in-flight" })));
  await eventually(() => inFlightFrames.some((item) => item.id === "register-in-flight" && item.ok));
  const duplicateInFlight = frame("in-flight-id", "respond_extension_ui", { sessionId: "request-id-root", uiRequestId: "dialog", cancelled: true });
  inFlight.write(Buffer.concat([encodeFrame(duplicateInFlight), encodeFrame(duplicateInFlight),
    encodeFrame(frame("cancelled-after-in-flight", "heartbeat", {}))]));
  await eventually(() => inFlightFrames.some((item) => item.type === "protocol_error" && item.code === "duplicate_request_id") && inFlightClosed);
  assert.equal(inFlightFrames.some((item) => item.id === "cancelled-after-in-flight"), false,
    "disconnect cleanup must cancel frames queued behind an exact in-flight duplicate");
  assert.equal((await healthy.request("heartbeat")).alive, true, "a replaying connection must not affect a healthy peer");
});

test("multiple detachable clients share navigator access without owning actor lifecycle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-supervisor-actor-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const clients = await Promise.all(["a", "b"].map(async (id) => { const client = new HarnessClient({ socketPath, heartbeatMs: 0 }); const registered = await client.start({ registrationType: "register_client", clientInstanceId: id }); assert(registered); return client; }));
  t.after(() => Promise.all(clients.map((client) => client.stop())));
  assert.deepEqual((await clients[0].request("list_sessions")).sessions, []);
  assert.deepEqual((await clients[1].request("list_sessions")).sessions, []);
  supervisor.store.createRoot({ sessionId: "shared-root", sessionFile: path.join(root, "shared-root.jsonl"), cwd: root,
    repositoryRoot: null, name: "Shared", actorToken: "shared-token", launch: {} }, 1);
  const originalListNavigatorSessions = supervisor.store.listNavigatorSessions.bind(supervisor.store);
  let broadcastListCalls = 0;
  supervisor.store.listNavigatorSessions = (...args) => { broadcastListCalls += 1; return originalListNavigatorSessions(...args); };
  await clients[0].request("rename_session", { sessionId: "shared-root", name: "Renamed" });
  assert.equal(broadcastListCalls, 1, "one navigator snapshot must be shared by every broadcast recipient");
  await clients[0].stop();
  assert.equal((await clients[1].request("get_status")).running, true);
});


test("navigator keeps newest sessions and accurate metadata beyond 512", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-navigator-capacity-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 520; index += 1) supervisor.store.createRoot({
    sessionId: `root-${String(index).padStart(3, "0")}`, sessionFile: path.join(root, `root-${index}.jsonl`), cwd: root,
    repositoryRoot: null, name: `Root ${index}`, actorToken: `token-${index}`, launch: {},
  }, index + 1);
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 }); const navigatorEvents = [];
  client.on("event", (frame) => { if (frame.event === "navigator_changed") navigatorEvents.push(frame.data); });
  const registered = await client.start({ registrationType: "register_client", clientInstanceId: "navigator-capacity" });
  t.after(() => client.stop());
  assert.equal(registered.sessions.length, 512); assert.equal(registered.navigatorTotal, 520); assert.equal(registered.navigatorTruncated, true);
  assert(registered.sessions.some((session) => session.sessionId === "root-519"));
  const listed = await client.request("list_sessions");
  assert.equal(listed.sessions.length, 512); assert.equal(listed.navigatorTotal, 520); assert.equal(listed.navigatorTruncated, true);
  assert.deepEqual(listed.sessions.map((session) => session.sessionId), registered.sessions.map((session) => session.sessionId));
  const status = await client.request("get_status");
  assert.equal(status.sessions.length, 512); assert.equal(status.navigatorTotal, 520); assert.equal(status.navigatorTruncated, true);
  await client.request("rename_session", { sessionId: "root-519", name: "Newest renamed" });
  await eventually(() => navigatorEvents.length > 0);
  const changed = navigatorEvents.at(-1);
  assert.equal(changed.sessions.length, 512); assert.equal(changed.navigatorTotal, 520); assert.equal(changed.navigatorTruncated, true);
  assert(changed.sessions.some((session) => session.sessionId === "root-519" && session.name === "Newest renamed"));
  assert.equal(supervisor.store.listSessions().length, 520, "navigator truncation must not archive sessions");
});


test("concurrent root image and visible-message APIs preserve root presentation sanitization while child text stays unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-visible-presentation-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const rootFile = path.join(root, "root.jsonl"); const childFile = path.join(root, "child.jsonl");
  const source = "<!-- taihou.presentation.v1 body=happy face=smile -->\nVisible.\n  <!-- taihou.presentation malformed -->\nTail.";
  const header = (id) => ({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: root });
  const assistant = (id, parentId) => ({ type: "message", id: `${id}-assistant`, parentId,
    timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: source }] } });
  const rootEntries = [header("root-session"), { type: "message", id: "root-user", parentId: null,
    timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: [
      { type: "image", data: PNG_1X1, mimeType: "image/png" }, { type: "text", text: "look" }] } },
    { type: "custom", customType: "padding", id: "root-pad", parentId: "root-user",
      timestamp: "2026-01-01T00:00:00Z", data: "x".repeat(2 * 1024 * 1024) }, assistant("root-session", "root-pad")];
  const childEntries = [header("child-session"), assistant("child-session", null)];
  await Promise.all([writeFile(rootFile, `${rootEntries.map(JSON.stringify).join("\n")}\n`),
    writeFile(childFile, `${childEntries.map(JSON.stringify).join("\n")}\n`)]);
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  supervisor.store.createRoot({ sessionId: "root-session", sessionFile: rootFile, cwd: root,
    repositoryRoot: null, name: "Root", actorToken: "root-token", launch: {} }, 1);
  supervisor.store.createChild("root-session", { sessionId: "child-session", sessionFile: childFile, actorToken: "child-token",
    policy: { name: "Child", prompt: "task", cwd: root, repositoryRoot: null, depth: 1 }, now: 2 });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  const imageClient = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await Promise.all([client.start({ registrationType: "register_client", clientInstanceId: "visible-presentation" }),
    imageClient.start({ registrationType: "register_client", clientInstanceId: "visible-presentation-image" })]);
  t.after(() => Promise.all([client.stop(), imageClient.stop()]));
  const [image, rootVisible] = await Promise.all([
    imageClient.request("get_visible_image", { sessionId: "root-session", entryId: "root-user", index: 0 }),
    client.request("get_visible_messages", { sessionId: "root-session" }),
  ]);
  assert.equal(image.image.data, PNG_1X1);
  assert.deepEqual(rootVisible.messages.map((message) => message.text), ["look", "Visible.\nTail."]);
  assert.doesNotMatch(JSON.stringify(rootVisible), /taihou\.presentation|body=happy/);
  const childVisible = await client.request("get_visible_messages", { sessionId: "child-session" });
  assert.equal(childVisible.messages[0].text, source, "child transcript prose must remain byte-for-byte unchanged");
});

test("outgoing delivery waits for a canonical sender entry and reconnect requests repair", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-message-history-gate-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  for (const [id, token] of [["sender", "sender-token"], ["target", "target-token"]]) {
    supervisor.store.createRoot({ sessionId: id, sessionFile: path.join(root, `${id}.jsonl`), cwd: root,
      repositoryRoot: null, name: id, actorToken: token, launch: {} }, 1);
  }
  const registration = (client, id, token) => client.start({ registrationType: "register_actor", sessionId: id,
    sessionFile: path.join(root, `${id}.jsonl`), cwd: root, repositoryRoot: null, actorToken: token, actorGeneration: 1 });
  const sender = new HarnessClient({ socketPath, heartbeatMs: 0 }); await registration(sender, "sender", "sender-token");
  const accepted = (await sender.request("send_message", { target: "target", body: "durable body", deliveryMode: "auto" })).message;
  assert.equal(accepted.state, "accepted"); assert.deepEqual(supervisor.store.listPendingMessages("target"), []);
  await sender.stop();
  const replacement = new HarnessClient({ socketPath, heartbeatMs: 0 }); const events = [];
  replacement.on("event", (frame) => events.push(frame)); await registration(replacement, "sender", "sender-token"); t.after(() => replacement.stop());
  const repair = await eventually(() => events.find((frame) => frame.event === "message_history_required"));
  assert.equal(repair.data.message.messageId, accepted.messageId); assert.equal(repair.data.message.targetName, "target");
  const recorded = supervisor.store.recordMessageSenderEntry("sender", { messageId: accepted.messageId, entryId: "entry-1",
    peerId: "target", relationship: "sibling", body: "durable body" }, 2);
  assert.equal(recorded.newlyQueued, true); assert.equal(supervisor.store.listPendingMessages("target")[0].senderEntryId, "entry-1");
});


test("family messages reach a working actor while a skill refresh is pending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-message-skill-refresh-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const skillsPath = path.join(root, "skills");
  const skillPath = path.join(skillsPath, "example", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "---\nname: example\ndescription: Initial skill\n---\n\nInitial guidance.\n");
  const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0, skillsPath,
    runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const browser = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await browser.start({ registrationType: "register_client", clientInstanceId: "message-skill-refresh" }); t.after(() => browser.stop());
  const senderAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "sender",
    provider: null, model: null, thinkingLevel: null })).admission;
  const targetAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "target",
    provider: null, model: null, thinkingLevel: null })).admission;
  const senderActor = await eventually(() => actors.get(senderAdmission.sessionId));
  const targetActor = await eventually(() => actors.get(targetAdmission.sessionId));
  await eventually(() => senderActor.isRunning && targetActor.isRunning);
  const connectActor = async (admission) => {
    const launch = supervisor.store.getActorLaunch(admission.sessionId);
    const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
    await client.start({ registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile,
      cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
    return client;
  };
  const sender = await connectActor(senderAdmission); const target = await connectActor(targetAdmission);
  t.after(() => Promise.all([sender.stop(), target.stop()]));
  const targetEvents = []; target.on("event", (frame) => targetEvents.push(frame));
  targetActor.emit("event", { type: "agent_start" });
  await eventually(() => supervisor.store.getSession(targetAdmission.sessionId).activity === "working");
  await writeFile(skillPath, "---\nname: example\ndescription: Updated skill\n---\n\nUpdated guidance.\n");
  const message = (await sender.request("send_message", { target: targetAdmission.sessionId, body: "pause now", deliveryMode: "auto" })).message;
  await sender.request("record_agent_message_entry", { messageId: message.messageId, entryId: "sender-entry",
    direction: "to", peerId: targetAdmission.sessionId, peerName: "target", relationship: "sibling", body: "pause now",
    createdAt: "2026-01-01T00:00:00.000Z" });
  const available = await eventually(() => targetEvents.find((frame) => frame.event === "message_available"), 1000);
  assert.equal(available.data.message.messageId, message.messageId);
  assert.equal(available.data.deliverAs, "steer");
  assert.equal(supervisor.store.getMessage(message.messageId).state, "delivered");
  assert.equal(actors.get(targetAdmission.sessionId), targetActor);
  assert.equal(supervisor.store.getSession(targetAdmission.sessionId).actorGeneration, targetAdmission.actorGeneration);
});


test("incoming family messages emit a live actor event during an in-flight turn before agent_settled", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-incoming-live-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0, skillsPath,
    runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const browser = new HarnessClient({ socketPath, heartbeatMs: 0 });
  const browserEvents = [];
  browser.on("event", (frame) => browserEvents.push(frame));
  await browser.start({ registrationType: "register_client", clientInstanceId: "incoming-live" }); t.after(() => browser.stop());
  const senderAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "sender",
    provider: null, model: null, thinkingLevel: null })).admission;
  const targetAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "target",
    provider: null, model: null, thinkingLevel: null })).admission;
  const senderActor = await eventually(() => actors.get(senderAdmission.sessionId));
  const targetActor = await eventually(() => actors.get(targetAdmission.sessionId));
  await eventually(() => senderActor.isRunning && targetActor.isRunning);
  const connectActor = async (admission) => {
    const launch = supervisor.store.getActorLaunch(admission.sessionId);
    const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
    await client.start({ registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile,
      cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
    return client;
  };
  const sender = await connectActor(senderAdmission); const target = await connectActor(targetAdmission);
  t.after(() => Promise.all([sender.stop(), target.stop()]));
  await browser.request("subscribe_session", { selector: targetAdmission.sessionId, passive: true });
  targetActor.emit("event", { type: "agent_start" });
  await eventually(() => supervisor.store.getSession(targetAdmission.sessionId).activity === "working");
  const message = (await sender.request("send_message", { target: targetAdmission.sessionId, body: "result while busy", deliveryMode: "auto" })).message;
  await sender.request("record_agent_message_entry", { messageId: message.messageId, entryId: "sender-entry",
    direction: "to", peerId: targetAdmission.sessionId, peerName: "target", relationship: "sibling", body: "result while busy",
    createdAt: "2026-01-01T00:00:00.000Z" });
  await eventually(() => supervisor.store.getMessage(message.messageId).state === "delivered");
  await target.request("record_agent_message_entry", { messageId: message.messageId, entryId: "incoming-live-1",
    direction: "from", peerId: senderAdmission.sessionId, peerName: "sender", relationship: "sibling", body: "result while busy",
    createdAt: "2026-01-01T00:00:00.100Z" });
  const live = await eventually(() => browserEvents.find((frame) => frame.event === "actor_event"
    && frame.data?.event?.type === "agent_message_entry" && frame.data.event.direction === "from"));
  assert.equal(live.data.sessionId, targetAdmission.sessionId);
  assert.equal(live.data.event.entryId, "incoming-live-1");
  assert.equal(live.data.event.body, "result while busy");
  assert.equal(browserEvents.some((frame) => frame.event === "actor_event" && frame.data?.event?.type === "agent_settled"), false,
    "Fleet Desk must see the incoming family message before the current turn settles");
  assert.equal(supervisor.store.getMessage(message.messageId).state, "delivered");
});


test("queued family messages repair an idle Pi worker whose actor transport is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-message-transport-repair-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0, skillsPath,
    runtimeProvisioner: async () => ({}),
    actorFactory: (options) => {
      const actor = new FakePiActor(options); const family = actors.get(options.session.sessionId) ?? [];
      family.push(actor); actors.set(options.session.sessionId, family); return actor;
    },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const browser = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await browser.start({ registrationType: "register_client", clientInstanceId: "message-transport-repair" });
  t.after(() => browser.stop());
  const senderAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "sender",
    provider: null, model: null, thinkingLevel: null })).admission;
  const targetAdmission = (await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "target",
    provider: null, model: null, thinkingLevel: null })).admission;
  await eventually(() => actors.get(senderAdmission.sessionId)?.[0]?.isRunning && actors.get(targetAdmission.sessionId)?.[0]?.isRunning);

  const connectActor = async (sessionId, events = []) => {
    const launch = supervisor.store.getActorLaunch(sessionId); const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
    client.on("event", (frame) => events.push(frame));
    await client.start({ registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile,
      cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
    return client;
  };
  const sender = await connectActor(senderAdmission.sessionId); t.after(() => sender.stop());
  const originalTarget = actors.get(targetAdmission.sessionId)[0];
  originalTarget.emit("event", { type: "agent_start" });
  await eventually(() => supervisor.store.getSession(targetAdmission.sessionId).activity === "working");
  const message = (await sender.request("send_message", { target: targetAdmission.sessionId, body: "repair transport",
    deliveryMode: "auto" })).message;
  await sender.request("record_agent_message_entry", { messageId: message.messageId, entryId: "transport-sender-entry",
    direction: "to", peerId: targetAdmission.sessionId, peerName: "target", relationship: "sibling", body: "repair transport",
    createdAt: "2026-01-01T00:00:00.000Z" });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(actors.get(targetAdmission.sessionId).length, 1,
    "a working actor must never be restarted merely because its extension transport is absent");
  assert.equal(originalTarget.isRunning, true);
  assert.equal(supervisor.store.getMessage(message.messageId).state, "queued");
  originalTarget.emit("event", { type: "agent_settled" });
  await eventually(() => actors.get(targetAdmission.sessionId)?.length === 2);
  assert.equal(originalTarget.isRunning, false,
    "the now-idle worker without its actor extension transport must be replaced once");
  assert.equal(supervisor.store.getMessage(message.messageId).state, "queued");
  const targetEvents = []; const target = await connectActor(targetAdmission.sessionId, targetEvents); t.after(() => target.stop());
  const available = await eventually(() => targetEvents.find((frame) => frame.event === "message_available"));
  assert.equal(available.data.message.messageId, message.messageId);
  assert.equal(supervisor.store.getMessage(message.messageId).state, "delivered");
  assert.equal(supervisor.store.getMessage(message.messageId).attemptCount, 1);

  await browser.request("stop_session", { sessionId: targetAdmission.sessionId });
  assert.equal(supervisor.store.getSession(targetAdmission.sessionId).lifecycle, "stopped");
  const staleMessage = (await sender.request("send_message", { target: targetAdmission.sessionId, body: "reject stale transport",
    deliveryMode: "auto" })).message;
  await sender.request("record_agent_message_entry", { messageId: staleMessage.messageId, entryId: "stale-transport-entry",
    direction: "to", peerId: targetAdmission.sessionId, peerName: "target", relationship: "sibling",
    body: "reject stale transport", createdAt: "2026-01-01T00:00:01.000Z" });
  await eventually(() => actors.get(targetAdmission.sessionId)?.length === 4, 5000);
  assert.equal(targetEvents.some((frame) => frame.event === "message_available"
    && frame.data.message.messageId === staleMessage.messageId), false,
  "the old registered generation must not receive or transition a newly queued message after stop");
  assert.equal(supervisor.store.getMessage(staleMessage.messageId).state, "queued");
  const replacementEvents = []; const replacementTarget = await connectActor(targetAdmission.sessionId, replacementEvents);
  t.after(() => replacementTarget.stop());
  const replacementAvailable = await eventually(() => replacementEvents.find((frame) => frame.event === "message_available"));
  assert.equal(replacementAvailable.data.message.messageId, staleMessage.messageId);
  assert.equal(supervisor.store.getMessage(staleMessage.messageId).state, "delivered");
  assert.equal(actors.get(targetAdmission.sessionId)[2].isRunning, false,
    "a newly started idle worker that never registers transport must receive one bounded replacement");
});


test("parent actor reconnect requests pending child creation history without touching message delivery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-child-history-supervisor-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  supervisor.store.createRoot({ sessionId: "parent", sessionFile: path.join(root, "parent.jsonl"), cwd: root,
    repositoryRoot: null, name: "parent", actorToken: "parent-token", launch: {} }, 1);
  const child = supervisor.store.createChild("parent", { sessionId: "child", sessionFile: path.join(root, "child.jsonl"),
    actorToken: "child-token", policy: { name: "reviewer", prompt: "exact child task", cwd: root, repositoryRoot: null, depth: 1 }, now: 2 });
  const second = supervisor.store.createChild("parent", { sessionId: "child-2", sessionFile: path.join(root, "child-2.jsonl"),
    actorToken: "child-token-2", policy: { name: "second", prompt: "second task", cwd: root, repositoryRoot: null, depth: 1 }, now: 3 });
  const parent = new HarnessClient({ socketPath, heartbeatMs: 0 }); const events = [];
  parent.on("event", (frame) => events.push(frame));
  await parent.start({ registrationType: "register_actor", sessionId: "parent", sessionFile: path.join(root, "parent.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "parent-token", actorGeneration: 1 }); t.after(() => parent.stop());
  const repair = await eventually(() => events.find((frame) => frame.event === "child_creation_history_required"));
  assert.deepEqual(repair.data.child, { taskId: child.task.taskId, childId: "child", childName: "reviewer", relationship: "child",
    body: "exact child task", createdAt: 2 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(events.filter((frame) => frame.event === "child_creation_history_required").length, 1);
  supervisor.store.recordChildCreationEntry("parent", { ...repair.data.child, entryId: "entry-1" });
  const replacement = new HarnessClient({ socketPath, heartbeatMs: 0 }); const replacementEvents = [];
  replacement.on("event", (frame) => replacementEvents.push(frame));
  await replacement.start({ registrationType: "register_actor", sessionId: "parent", sessionFile: path.join(root, "parent.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "parent-token", actorGeneration: 1 }); t.after(() => replacement.stop());
  const next = await eventually(() => replacementEvents.find((frame) => frame.event === "child_creation_history_required"));
  assert.deepEqual(next.data.child, { taskId: second.task.taskId, childId: "child-2", childName: "second", relationship: "child",
    body: "second task", createdAt: 3 });
  assert.equal(supervisor.store.listMessages().length, 0);
});

class FakePiActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.streaming = false; this.submits = []; this.requests = []; this.submitHold = null; this.submitEntered = 0; }
  async start() { this.isRunning = true; return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null, thinkingLevel: "off" }; }
  emit(name, value) { if (name === "event" && value?.type === "agent_start") this.streaming = true; if (name === "event" && value?.type === "agent_settled") this.streaming = false; return super.emit(name, value); }
  async request(type, fields = {}) {
    this.requests.push(type);
    if (type === "get_state") return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming, model: null, thinkingLevel: "off" };
    if (type === "get_entries") return { entries: [], leafId: this.leafId ?? null };
    throw new Error(`unexpected fake actor request ${type}${fields?.message ? `: ${fields.message}` : ""}`);
  }
  async submit(message, behavior, images = []) {
    this.submitEntered += 1;
    if (this.submitHold) await this.submitHold;
    this.submits.push({ message, behavior, images }); return {};
  }
  send() {}
  async close() { if (!this.isRunning) return; this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}

class RetryPiActor extends FakePiActor {
  prompts = [];
  async request(type, fields = {}, timeoutMs) {
    if (type === "prompt") {
      this.requests.push(type); this.prompts.push({ ...fields, timeoutMs });
      const message = fields.message ?? "";
      const prefix = "/persistent-harness-branch ";
      if (message === "/persistent-harness-branch" || message.startsWith(prefix)) {
        const target = message.slice("/persistent-harness-branch".length).trim();
        const entries = (await readFile(this.session.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
        const input = entries.find((entry) => entry.id === target);
        assert(input?.type === "custom_message" || input?.type === "message" && input.message?.role === "user",
          "Retry navigates through the original canonical input, not its parent");
        this.leafId = input.parentId ?? null;
        return {};
      }
      throw new Error(`unexpected prompt ${message}`);
    }
    return super.request(type, fields, timeoutMs);
  }
}

test("inactive root actor exit clears projector state before a first subscription and replacement start", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-output-inactive-exit-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const projector = new RootOutputProjector({ generation: "inactive-exit-generation" });
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0,
    runtimeProvisioner: async () => ({}), rootOutputProjector: projector,
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "inactive-exit" }); t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Inactive exit",
    provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId; const actor = await eventually(() => actors.get(id)); await eventually(() => actor.isRunning);
  actor.emit("event", { type: "agent_start" });
  actor.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Before exit." } });
  assert.equal(projector.active, false); assert.equal(projector.cursor, 0);
  actor.isRunning = false; actor.emit("exit", { code: 1, signal: null, expected: false, error: "unexpected test exit" });
  projector.subscribe();
  const replacement = projector.accept({ session: { sessionId: id, kind: "root", depth: 0 }, actorGeneration: 2,
    actorEventSeq: 1, event: { type: "agent_start" } });
  assert.deepEqual(replacement.map((frame) => [frame.event.type, frame.event.status]), [["turn_start", undefined]],
    "the replacement must not supersede a stale turn from the already-dead inactive actor");
});

for (const withExtras of [false, true]) test(withExtras
  ? "actors preserve explicit user extension ordering and deduplication"
  : "actors load only the harness by default", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-actor-extension-paths-"));
  const skillsPath = path.join(root, "skills");
  await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock");
  const extraExtension = path.join(root, "user-extra.ts"), secondExtension = path.join(root, "second-extra.ts");
  const packageRoot = path.resolve(import.meta.dirname, ".."), harnessExtension = path.join(packageRoot, "index.ts");
  await Promise.all([extraExtension, secondExtension].map(file => writeFile(file, "export default () => {};\n")));
  let launched;
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    skillsPath, ...(withExtras ? { actorExtensionPaths: [secondExtension, extraExtension, secondExtension, harnessExtension] } : {}), actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { launched = options; return new FakePiActor(options); },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "actor-extension-paths" });
  t.after(() => client.stop());
  await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Extensions",
    provider: null, model: null, thinkingLevel: null });
  await eventually(() => launched);
  const extensionPaths = launched.args.flatMap((value, index, args) => args[index - 1] === "--extension" ? [value] : []);
  assert.deepEqual(extensionPaths, [harnessExtension, ...(withExtras ? [secondExtension, extraExtension] : [])]);
});

class InferencePiActor extends FakePiActor {
  constructor(options, family) { super(options); this.family = family; this.busy = false; family.push(this); }
  async start() {
    this.isRunning = true;
    return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false,
      model: this.session.launch.model.resolved, thinkingLevel: this.session.launch.thinking.resolved };
  }
  async request(type) {
    this.requests.push(type);
    if (type === "get_available_models") return { models: [
      { provider: "fake", id: "alpha", name: "Alpha", reasoning: true, contextWindow: 200000,
        thinkingLevelMap: { xhigh: "xhigh", max: null }, apiKey: "must-not-leak", baseUrl: "https://secret" },
      { provider: "fake", id: "beta", name: "Beta", reasoning: false, contextWindow: 100000, headers: { authorization: "secret" } },
    ] };
    if (type === "get_state") return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      isStreaming: this.busy, isCompacting: false, pendingMessageCount: 0,
      model: this.session.launch.model.resolved, thinkingLevel: this.session.launch.thinking.resolved };
    return super.request(type);
  }
}

async function eventually(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition did not become true");
}

test("supervisor projects native Pi progress globally and clears it on settle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-supervisor-progress-"));
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0,
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 }); await client.start({ registrationType: "register_client", clientInstanceId: "progress-test" }); t.after(() => client.stop());
  const navigatorEvents = []; const actorEvents = []; const rootOutputEvents = [];
  client.on("event", (frame) => { if (frame.event === "navigator_changed") navigatorEvents.push(frame); if (frame.event === "actor_event") actorEvents.push(frame.data?.event); if (frame.event === "root_output_event") rootOutputEvents.push(frame.data); });
  const rootOutputStart = await client.request("subscribe_root_output", {});
  assert.equal(rootOutputStart.gap, false); assert.deepEqual(rootOutputStart.events, []);
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Progress", provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId; const actor = await eventually(() => actors.get(id)); await eventually(() => actor.isRunning);
  const stateReadsBeforePassive = actor.requests.filter((type) => type === "get_state").length;
  const passive = await client.request("subscribe_session", { selector: id, passive: true });
  assert.deepEqual(passive.events, []); assert.equal(actor.requests.filter((type) => type === "get_state").length, stateReadsBeforePassive);
  await client.request("subscribe_session", { selector: id });
  const launch = supervisor.store.getActorLaunch(id);
  const actorClient = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await actorClient.start({ registrationType: "register_actor", sessionId: id, sessionFile: launch.sessionFile, cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
  t.after(() => actorClient.stop());
  await assert.rejects(actorClient.request("unsubscribe_root_output", {}), /not available to actors/);
  const firstInput = await client.request("submit_input", { sessionId: id, message: "retry-safe", behavior: "auto", clientRequestId: "browser-retry-1" });
  const repeatedInput = await client.request("submit_input", { sessionId: id, message: "retry-safe", behavior: "auto", clientRequestId: "browser-retry-1" });
  assert.equal(firstInput.inputId, repeatedInput.inputId);
  await eventually(() => actor.submits.filter((item) => item.message.includes("retry-safe")).length === 1);
  await client.request("submit_input", { sessionId: id, message: "", images: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }], behavior: "auto", clientRequestId: "browser-image-1" });
  await eventually(() => actor.submits.find((item) => item.images.length)?.images);
  assert.deepEqual(actor.submits.find((item) => item.images.length)?.images, [{ type: "image", mimeType: "image/png", data: PNG_1X1 }]);
  actor.emit("event", { type: "agent_start" });
  await actorClient.request("update_progress_heading", { phase: "start", turnId: "turn-1" });
  await actorClient.request("update_progress_heading", { phase: "heading", turnId: "turn-1", summary: "Inspecting the global progress path" });
  const working = await eventually(async () => { const session = (await client.request("list_sessions")).sessions.find((item) => item.sessionId === id); return session?.agentStatus ? session : undefined; });
  assert.deepEqual(working.agentStatus, { summary: "Inspecting the global progress path" });
  assert.doesNotMatch(JSON.stringify(working), /private body|private tail/);
  await actorClient.request("record_progress_entry", { entryId: "progress-entry-1", summary: "Inspecting the global progress path", createdAt: "2026-01-01T00:00:00Z" });
  await eventually(() => actorEvents.some((event) => event?.type === "progress_entry"));
  assert.deepEqual(actorEvents.find((event) => event?.type === "progress_entry"), { type: "progress_entry", entryId: "progress-entry-1", summary: "Inspecting the global progress path", createdAt: "2026-01-01T00:00:00.000Z" });
  const progressEvents = () => navigatorEvents.filter((frame) => frame.data?.reason === "assistant_progress").length;
  await eventually(() => progressEvents() === 1); const beforeDuplicate = progressEvents();
  await actorClient.request("update_progress_heading", { phase: "start", turnId: "turn-1" });
  await actorClient.request("update_progress_heading", { phase: "heading", turnId: "turn-1", summary: "Inspecting the global progress path" });
  await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(progressEvents(), beforeDuplicate);
  assert.deepEqual((await client.request("list_sessions")).sessions.find((item) => item.sessionId === id).agentStatus, { summary: "Inspecting the global progress path" });

  actor.emit("event", { type: "agent_start" });
  await eventually(async () => !(await client.request("list_sessions")).sessions.find((item) => item.sessionId === id).agentStatus);
  await actorClient.request("update_progress_heading", { phase: "start", turnId: "turn-1" });
  await actorClient.request("update_progress_heading", { phase: "heading", turnId: "turn-1", summary: "Inspecting the global progress path" });
  await actorClient.request("record_progress_entry", { entryId: "progress-entry-2", summary: "Testing durable progress replay", createdAt: "2026-01-01T00:00:01Z" });

  const partial = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "private reasoning body" }, { type: "text", text: "" }] };
  actor.emit("event", { type: "message_start", message: partial });
  actor.emit("event", { type: "message_update", message: partial, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private reasoning body" } });
  actor.emit("event", { type: "tool_execution_start", toolCallId: "tool-1", toolName: "ipython", args: { secret: "private tool arguments" } });
  const presentationMarker = "<!-- taihou.presentation.v1 body=happy face=smile -->\n";
  actor.emit("event", { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: presentationMarker } });
  actor.emit("event", { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "public delta" } });
  const hostilePresentationLines = "\n  <!-- taihou.presentation.v1 face=shame body=sad -->\n```html\n\t<!-- taihou.presentation.v1 body=yandere face=shy -->\n```\n<!-- taihou.presentation.v1 body=talk-02 face=think -->\n";
  actor.emit("event", { type: "message_update", message: partial, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: hostilePresentationLines } });
  actor.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "stop", timestamp: 1, content: [{ type: "thinking", thinking: "private complete thinking" }, { type: "text", text: `${presentationMarker}public answer${hostilePresentationLines}` }, { type: "toolCall", arguments: { secret: true } }] } });
  await eventually(() => actorEvents.some((event) => event?.assistantMessageEvent?.delta === "public delta"));
  assert.doesNotMatch(JSON.stringify(actorEvents), /private reasoning body|private tool arguments|private complete thinking|secret|taihou\.presentation|body=happy/);
  assert.match(JSON.stringify(actorEvents), /public delta|public answer/);
  await eventually(() => rootOutputEvents.some((frame) => frame.event?.type === "assistant_terminal"));
  assert.match(JSON.stringify(rootOutputEvents), /public delta|public answer/);
  assert.doesNotMatch(JSON.stringify(rootOutputEvents), /private reasoning body|private tool arguments|private complete thinking|secret|Testing durable progress replay|taihou\.presentation\.v1 body=/);
  assert(rootOutputEvents.some((frame) => frame.event?.presentation?.body === "happy" && frame.event?.presentation?.face === "smile"));
  const replayClient = new HarnessClient({ socketPath, heartbeatMs: 0 }); await replayClient.start({ registrationType: "register_client", clientInstanceId: "progress-replay" });
  const replay = await replayClient.request("subscribe_session", { selector: id }); await replayClient.stop();
  assert.doesNotMatch(JSON.stringify(replay.events), /private reasoning body|private tool arguments|private complete thinking|secret|taihou\.presentation|body=happy/);
  assert.match(JSON.stringify(replay.events), /progress-entry-2|Testing durable progress replay/);
  await assert.rejects(actorClient.request("update_progress_heading", { phase: "heading", turnId: "turn-1", summary: "`private`" }), /normalized safe heading/);
  await assert.rejects(actorClient.request("record_progress_entry", { entryId: "bad", summary: "`private`", createdAt: "2026-01-01T00:00:00Z" }), /normalized safe heading/);
  await actorClient.request("update_progress_heading", { phase: "settled", turnId: "turn-1" });
  actor.emit("event", { type: "agent_settled" });
  const settled = await eventually(async () => { const session = (await client.request("list_sessions")).sessions.find((item) => item.sessionId === id); return session?.activity === "idle" ? session : undefined; });
  assert.equal(settled.agentStatus, undefined);
  assert(rootOutputEvents.some((frame) => frame.event?.type === "assistant_terminal" && frame.event.stopReason === "stop"));

  const beforeOversized = rootOutputEvents.length;
  actor.emit("event", { type: "agent_start" });
  actor.emit("event", { type: "message_start", message: { role: "assistant" } });
  actor.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(40 * 1024) }] } });
  actor.emit("event", { type: "agent_settled" });
  await eventually(() => rootOutputEvents.slice(beforeOversized).some((frame) => frame.event?.type === "turn_terminal"));
  const oversizedEvents = rootOutputEvents.slice(beforeOversized);
  assert(oversizedEvents.some((frame) => frame.event?.type === "assistant_terminal" && frame.event.status === "truncated" && !("text" in frame.event)));
  assert(oversizedEvents.some((frame) => frame.event?.type === "turn_terminal" && frame.event.status === "failed"));

  const beforeOversizedDelta = rootOutputEvents.length;
  actor.emit("event", { type: "agent_start" });
  actor.emit("event", { type: "message_start", message: { role: "assistant", id: "oversized-delta", timestamp: 2, content: [] } });
  actor.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "d".repeat(40 * 1024) } });
  actor.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "bounded terminal" }] } });
  actor.emit("event", { type: "agent_settled" });
  await eventually(() => rootOutputEvents.slice(beforeOversizedDelta).some((frame) => frame.event?.type === "turn_terminal"));
  const oversizedDeltaEvents = rootOutputEvents.slice(beforeOversizedDelta);
  assert(!oversizedDeltaEvents.some((frame) => frame.event?.type === "text_delta"));
  assert(oversizedDeltaEvents.some((frame) => frame.event?.type === "turn_terminal" && frame.event.status === "failed"));

  await client.request("unsubscribe_root_output", {});
  const beforeUnsubscribed = rootOutputEvents.length;
  actor.emit("event", { type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(rootOutputEvents.length, beforeUnsubscribed);
  const retainedAfterUnsubscribe = await client.request("subscribe_root_output", { generation: rootOutputStart.generation, afterSeq: oversizedDeltaEvents.at(-1).seq });
  assert(retainedAfterUnsubscribe.events.some((frame) => frame.event?.type === "turn_start"));

  await client.request("stop_session", { sessionId: id });
  const stopped = supervisor.store.getSession(id); const stoppedGeneration = stopped.actorGeneration;
  const visible = await client.request("get_visible_messages", { sessionId: id });
  assert.deepEqual(visible.messages.map((message) => message.text), ["retry-safe", ""]);
  assert(visible.messages.every((message) => message.delivery.state === "accepted"));
  const pendingImage = visible.messages.find((message) => message.images);
  assert.equal((await client.request("get_visible_image", { sessionId: id, entryId: pendingImage.id, index: 0 })).image.data, PNG_1X1); assert.equal("inputIds" in visible, false);
  const watched = await client.request("subscribe_session", { selector: id, passive: true });
  assert.equal(watched.passive, true); assert.equal(watched.state.isStreaming, false);
  assert.equal(supervisor.store.getSession(id).lifecycle, "stopped");
  assert.equal(supervisor.store.getSession(id).actorGeneration, stoppedGeneration);
});


test("selected-session inference changes replace only an idle actor and serialize new input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-inference-control-"));
  const socketPath = path.join(root, "run", "supervisor.sock"); const family = []; let failNextStart = false;
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0,
    actorFactory: (options) => {
      const actor = new InferencePiActor(options, family);
      if (failNextStart) { failNextStart = false; actor.start = async () => { actor.isRunning = false; throw new Error("injected replacement failure"); }; }
      return actor;
    },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 10_000 });
  await client.start({ registrationType: "register_client", clientInstanceId: "inference-control" }); t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Inference",
    provider: "fake", model: "alpha", thinkingLevel: "off" });
  const id = created.admission.sessionId; await eventually(() => family[0]?.isRunning);
  const targetFamily = () => family.filter((actor) => actor.session.sessionId === id);
  const initialGeneration = supervisor.store.getSession(id).actorGeneration;
  const first = await client.request("get_session_inference", { sessionId: id });
  assert.deepEqual(first.selection, { provider: "fake", model: "alpha", thinkingLevel: "off" });
  assert.deepEqual(first.models[0], { provider: "fake", id: "alpha", name: "Alpha", reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"], contextWindow: 200000 });
  assert.doesNotMatch(JSON.stringify(first), /must-not-leak|authorization|baseUrl|apiKey/);
  targetFamily()[0].busy = true;
  await assert.rejects(client.request("set_session_inference", { sessionId: id, provider: "fake", model: "beta", thinkingLevel: "off",
    expected: first.selection }), (error) => error.code === "session_busy");
  assert.equal(supervisor.store.getSession(id).actorGeneration, initialGeneration); targetFamily()[0].busy = false;
  await assert.rejects(client.request("set_session_inference", { sessionId: id, provider: "fake", model: "beta", thinkingLevel: "off",
    expected: { ...first.selection, model: "stale" } }), (error) => error.code === "stale_inference");
  await assert.rejects(client.request("set_session_inference", { sessionId: id, provider: "fake", model: "beta", thinkingLevel: "high",
    expected: first.selection }), (error) => error.code === "unsupported_inference");
  supervisor.store.createRoot({ sessionId: "message-sender", sessionFile: path.join(root, "message-sender.jsonl"), cwd: root,
    repositoryRoot: null, name: "message-sender", actorToken: "message-token", launch: { ...created.admission.launch } }, 1);
  const pendingMessage = supervisor.store.createMessage("message-sender", { target: id, body: "do not interrupt replacement", deliveryMode: "auto" });
  supervisor.store.recordMessageSenderEntry("message-sender", { messageId: pendingMessage.messageId, entryId: "pending-entry",
    peerId: id, relationship: "sibling", body: "do not interrupt replacement" });
  await assert.rejects(client.request("set_session_inference", { sessionId: id, provider: "fake", model: "beta", thinkingLevel: "off",
    expected: first.selection }), (error) => error.code === "session_busy");
  supervisor.store.markMessageDelivered(pendingMessage.messageId, id); supervisor.store.acknowledgeMessage(pendingMessage.messageId, id);
  const changed = await client.request("set_session_inference", { sessionId: id, provider: "fake", model: "beta", thinkingLevel: "off",
    expected: first.selection });
  assert.equal(changed.changed, true); assert.deepEqual(changed.selection, { provider: "fake", model: "beta", thinkingLevel: "off" });
  assert.equal(supervisor.store.getSession(id).actorGeneration, initialGeneration + 1); assert.equal(targetFamily()[0].isRunning, false);
  failNextStart = true;
  await assert.rejects(client.request("set_session_inference", { sessionId: id, provider: "fake", model: "alpha", thinkingLevel: "high",
    expected: changed.selection }), (error) => error.code === "actor_replacement_failed");
  await eventually(() => targetFamily().length === 4 && targetFamily()[3].isRunning);
  const rolledBack = await client.request("get_session_inference", { sessionId: id });
  assert.deepEqual(rolledBack.selection, changed.selection); assert.equal(supervisor.store.getSession(id).lifecycle, "resident");
  const rollbackInput = await client.request("submit_input", { sessionId: id, message: "rollback remains usable", behavior: "auto",
    clientRequestId: "after-failed-model-change" });
  assert(rollbackInput.accepted);
  await eventually(() => targetFamily()[3].submits.some((item) => item.message.includes("rollback remains usable")));
  supervisor.store.completeActorInput(rollbackInput.inputId, id);
  const rollbackSubmitCount = targetFamily()[3].submits.length;
  const beforeConcurrent = changed.selection;
  const [changedAgain, input] = await Promise.all([
    client.request("set_session_inference", { sessionId: id, provider: "fake", model: "alpha", thinkingLevel: "high", expected: beforeConcurrent }),
    client.request("submit_input", { sessionId: id, message: "new generation only", behavior: "auto", clientRequestId: "after-model-change" }),
  ]);
  assert.equal(changedAgain.changed, true); assert(input.accepted); assert.equal(targetFamily().length, 5);
  assert.equal(targetFamily()[3].submits.length, rollbackSubmitCount);
  await eventually(() => targetFamily()[4].submits.some((item) => item.message.includes("new generation only")));
  const same = await client.request("set_session_inference", { sessionId: id, provider: "fake", model: "alpha", thinkingLevel: "high",
    expected: changedAgain.selection });
  assert.equal(same.changed, false); assert.equal(targetFamily().length, 5);
});


async function writeGuidanceSkill(root, name, description) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

test("existing root actors reconcile additions, hashes, removals, and invalid packages before new input", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-live-skills-"));
  const skillsPath = path.join(root, "skills");
  await mkdir(skillsPath);
  await writeGuidanceSkill(skillsPath, "alpha", "Alpha skill.");
  const socketPath = path.join(root, "run", "supervisor.sock");
  const actors = new Map();
  let runtimeReady = true;
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    skillsPath, actorInactivityMs: 0, runtimeProvisioner: async () => {
      if (!runtimeReady) throw new Error("Python runtime installation was not approved; provision the skill catalog first");
      return { ready: true };
    },
    actorFactory: (options) => {
      const actor = new FakePiActor(options);
      const family = actors.get(options.session.sessionId) ?? [];
      family.push({ actor, options }); actors.set(options.session.sessionId, family);
      return actor;
    },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "live-skills" });
  t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Skills", provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId;
  await eventually(() => actors.get(id)?.[0]?.actor.isRunning);
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha"]);
  const first = actors.get(id)[0];
  assert.equal(first.options.env.PI_HARNESS_ACTOR_SKILL_GRANT.endsWith(".skill-grant.json"), true);
  assert.deepEqual(JSON.parse(await readFile(first.options.env.PI_HARNESS_ACTOR_SKILL_GRANT, "utf8")).skills.map((skill) => skill.id), ["alpha"]);

  await writeGuidanceSkill(skillsPath, "beta", "Beta skill.");
  await client.request("submit_input", { sessionId: id, message: "use beta", behavior: "auto", clientRequestId: "skills-1" });
  await eventually(() => actors.get(id)?.length === 2 && actors.get(id)[1].actor.submits.some((item) => item.message.includes("use beta")));
  assert.equal(first.actor.isRunning, false);
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha", "beta"]);

  const oldAlphaHash = supervisor.store.getSessionSkillGrant(id).skills.find((skill) => skill.id === "alpha").contentHash;
  await writeGuidanceSkill(skillsPath, "alpha", "Alpha skill changed.");
  await client.request("submit_input", { sessionId: id, message: "use changed alpha", behavior: "auto", clientRequestId: "skills-2" });
  await eventually(() => actors.get(id)?.length === 3);
  assert.notEqual(supervisor.store.getSessionSkillGrant(id).skills.find((skill) => skill.id === "alpha").contentHash, oldAlphaHash);

  await rm(path.join(skillsPath, "beta"), { recursive: true, force: true });
  await client.request("submit_input", { sessionId: id, message: "beta removed", behavior: "auto", clientRequestId: "skills-3" });
  await eventually(() => actors.get(id)?.length === 4);
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha"]);

  await mkdir(path.join(skillsPath, "invalid"));
  await writeFile(path.join(skillsPath, "invalid", "SKILL.md"), "# missing frontmatter\n");
  const resident = actors.get(id)[3].actor;
  await client.request("submit_input", { sessionId: id, message: "retain valid snapshot", behavior: "auto", clientRequestId: "skills-4" });
  await eventually(() => resident.submits.some((item) => item.message.includes("retain valid snapshot")));
  assert.equal(actors.get(id).length, 4, "a malformed new package must not replace the last valid grant");
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha"]);

  await rm(path.join(skillsPath, "invalid"), { recursive: true, force: true });
  resident.emit("event", { type: "agent_start" });
  await writeGuidanceSkill(skillsPath, "gamma", "Gamma skill.");
  await client.request("submit_input", { sessionId: id, message: "refresh after active work", behavior: "follow_up", clientRequestId: "skills-5" });
  assert.equal(actors.get(id).length, 4, "an active actor must not be interrupted for refresh");
  await eventually(() => resident.submits.filter((item) => item.message.includes("refresh after active work")).length === 1);
  const acceptedSteer = await eventually(() => {
    const item = supervisor.store.listPendingActorInputs(id).find((entry) => entry.message === "refresh after active work");
    return item?.state === "accepted" ? item : undefined;
  });
  supervisor.store.completeActorInput(acceptedSteer.inputId, id);
  resident.emit("event", { type: "agent_settled" });
  await eventually(() => actors.get(id)?.length === 5);
  assert.equal(actors.get(id)[4].actor.submits.some((item) => item.message.includes("refresh after active work")), false,
    "the refreshed actor must not replay an input already accepted by the prior generation");
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha", "gamma"]);

  runtimeReady = false;
  await writeGuidanceSkill(skillsPath, "delta", "Requires a provisioned runtime.");
  const beforeProvision = actors.get(id)[4].actor;
  await client.request("submit_input", { sessionId: id, message: "before provisioning", behavior: "auto", clientRequestId: "skills-6" });
  await eventually(() => beforeProvision.submits.some((item) => item.message.includes("before provisioning")));
  assert.equal(actors.get(id).length, 5, "an unprovisioned catalog must not replace a working grant");
  assert((await client.request("get_status")).diagnostics.some((item) => item.code === "skill_catalog_not_ready"));

  runtimeReady = true;
  await client.request("submit_input", { sessionId: id, message: "after provisioning", behavior: "auto", clientRequestId: "skills-7" });
  await eventually(() => actors.get(id)?.length === 6 && actors.get(id)[5].actor.submits.some((item) => item.message.includes("after provisioning")));
  assert.deepEqual(supervisor.store.getSessionSkillGrant(id).skills.map((skill) => skill.id), ["alpha", "delta", "gamma"]);
  assert.equal((await client.request("get_status")).diagnostics.some((item) => item.code === "skill_catalog_not_ready"), false);
});


class OperatorActionPiActor extends FakePiActor {
  prompts = [];
  interactiveReload = false;
  pendingReload = null;
  async request(type, fields = {}, timeoutMs) {
    if (type === "compact") { this.requests.push(type); return { summary: "compacted", timeoutMs }; }
    if (type === "prompt") {
      this.requests.push(type); this.prompts.push({ ...fields, timeoutMs });
      if (!this.interactiveReload) return {};
      this.emit("event", { type: "extension_ui_request", id: "kernel-runtime-approval", method: "confirm",
        title: "Install managed Python runtime?", message: "ipython==9.10.0", timeout: 60_000 });
      return new Promise((resolve) => { this.pendingReload = resolve; });
    }
    return super.request(type, fields, timeoutMs);
  }
  send(frame) {
    if (frame?.type === "extension_ui_response" && frame.id === "kernel-runtime-approval" && frame.confirmed === true) {
      const resolve = this.pendingReload; this.pendingReload = null; resolve?.({});
    }
  }
}

test("session operator actions require idle state and invoke exact Pi operations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-actions-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new OperatorActionPiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "session-actions" }); t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Actions", provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId; const actor = await eventually(() => actors.get(id)); await eventually(() => actor.isRunning);

  const compacted = await client.request("compact_session", { sessionId: id });
  assert.equal(compacted.result.summary, "compacted"); assert(actor.requests.includes("compact"));
  await client.request("subscribe_session", { selector: id, passive: true });
  actor.interactiveReload = true; let approvalResponse;
  client.on("event", (frame) => {
    if (frame.event === "actor_event" && frame.data?.event?.id === "kernel-runtime-approval") {
      approvalResponse = client.request("respond_extension_ui", { sessionId: id, uiRequestId: "kernel-runtime-approval", confirmed: true });
    }
  });
  const restarted = await client.request("restart_kernel", { sessionId: id });
  assert.deepEqual(restarted, { restarted: true }); await approvalResponse;
  assert.equal(actor.prompts.at(-1).message, KERNEL_RELOAD_COMMAND); assert.equal(actor.prompts.at(-1).timeoutMs, 330_000);
  await assert.rejects(client.request("respond_extension_ui", { sessionId: id, uiRequestId: "kernel-runtime-approval", confirmed: true }),
    (error) => error.code === "stale_ui_request");

  actor.streaming = true;
  await assert.rejects(client.request("compact_session", { sessionId: id }), (error) => error.code === "session_busy" && /idle/.test(error.message));
  await assert.rejects(client.request("restart_kernel", { sessionId: id }), (error) => error.code === "session_busy" && /idle/.test(error.message));
  assert.equal(actor.prompts.length, 1, "a busy rejection must not dispatch the kernel command");
});

test("skill runtime provisioning approves only the exact freshly verified catalog", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runtime-approval-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath); await writeGuidanceSkill(skillsPath, "alpha", "Alpha skill.");
  const socketPath = path.join(root, "run", "supervisor.sock"); const calls = [];
  const runtimeProvisioner = async (skills, options = {}) => {
    calls.push({ ids: skills.map((skill) => skill.id), approved: options.approved === true });
    if (!options.approved) throw new Error("Python runtime installation was not approved");
    return { managed: true, environmentId: "approved-env", versions: { python: "3.12.12", ipython: "9.10.0", dill: "0.3.8" }, pythonPath: "/private/python" };
  };
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0, runtimeProvisioner,
    actorFactory: (options) => new FakePiActor(options),
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "runtime-approval" }); t.after(() => client.stop());

  const first = await client.request("get_skill_runtime_plan", {});
  assert.equal(first.status, "approval_required"); assert.deepEqual(first.packages, ["ipython==9.10.0", "dill==0.3.8"]);
  assert.deepEqual(first.skills.map((skill) => skill.id), ["alpha"]); assert.equal(calls.at(-1).approved, false);
  await assert.rejects(client.request("provision_skill_runtime", { fingerprint: "0".repeat(64) }), (error) => error.code === "stale_skill_runtime_plan");
  assert.equal(calls.filter((call) => call.approved).length, 0);

  await writeGuidanceSkill(skillsPath, "beta", "Beta skill.");
  await assert.rejects(client.request("provision_skill_runtime", { fingerprint: first.fingerprint }), (error) => error.code === "stale_skill_runtime_plan");
  const changed = await client.request("get_skill_runtime_plan", {}); assert.notEqual(changed.fingerprint, first.fingerprint);
  const approved = await client.request("provision_skill_runtime", { fingerprint: changed.fingerprint });
  assert.equal(approved.status, "ready"); assert.equal(approved.environment.environmentId, "approved-env");
  assert.deepEqual(calls.at(-1), { ids: ["alpha", "beta"], approved: true });
  assert.doesNotMatch(JSON.stringify(approved), /private|pythonPath|skillPath/);
});

test("first assistant message starts a title while tool work stays active and leaves explicit names alone", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-auto-root-name-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const actors = new Map();
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const userText = "I want depth 0 sessions to be renamed automatically.";
  const assistantText = "I will trace the session-title path before running the long checks.";
  async function appendTitleTurn(sessionId, long = false) {
    const entries = [];
    let parentId = null;
    const message = (id, role, text) => {
      entries.push({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z",
        message: { role, content: [{ type: "text", text }] } });
      parentId = id;
    };
    message("u", "user", userText);
    message("first-reply", "assistant", assistantText);
    if (long) for (let index = 0; index < 40; index += 1) message(`progress-${index}`, "assistant", `Progress update ${index}.`);
    message("final", "assistant", `Final title verification completed.${long ? " Result details.".repeat(8000) : ""}`);
    await appendFile(supervisor.store.getSession(sessionId).sessionFile, `${entries.map(JSON.stringify).join("\n")}\n`);
  }
  const generatedTurns = [];
  const generatedModels = [];
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0,
    backgroundJobsDirectory: path.join(root, "background-jobs"), skillsPath,
    runtimeDir: path.join(root, "runtime"), runtimeProvisioner: async () => ({}),
    titleGenerator: createRootTitleGenerator({
      modelRuntimeFactory: async () => ({
        getModel(provider, id) { return { provider, id }; },
        async completeSimple(model, context) {
          generatedModels.push(model); generatedTurns.push(context.messages[0].content);
          return { stopReason: "stop", content: [{ type: "text", text: "Smarter Session Titles" }] };
        },
      }),
      fetchImpl: async () => { assert.fail("title test must not access a live provider"); },
    }),
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  const navigatorEvents = [];
  client.on("event", (frame) => { if (frame.event === "navigator_changed") navigatorEvents.push(frame.data); });
  await client.start({ registrationType: "register_client", clientInstanceId: "auto-root-name" });
  t.after(() => client.stop());

  const untitled = await client.request("create_root", {
    cwd: root, repositoryRoot: null, name: null, provider: null, model: null, thinkingLevel: null,
  });
  assert.equal(untitled.admission.name, defaultRootName(root, untitled.admission.sessionId));
  await eventually(() => actors.get(untitled.admission.sessionId)?.isRunning);
  await client.request("submit_input", {
    sessionId: untitled.admission.sessionId,
    message: "I want depth 0 sessions to be renamed automatically.",
    behavior: "auto",
  });
  assert.equal(supervisor.store.getSession(untitled.admission.sessionId).name, defaultRootName(root, untitled.admission.sessionId));
  supervisor.store.updateSessionInference(untitled.admission.sessionId, {
    provider: "openai-codex", model: "session-selected-model", thinkingLevel: "high",
  });
  await appendTitleTurn(untitled.admission.sessionId, true);
  const preview = await supervisor.transcriptReader.read({
    sessionFile: supervisor.store.getSession(untitled.admission.sessionId).sessionFile,
    sessionId: untitled.admission.sessionId, maxMessages: 32, maxBytes: 24 * 1024, sanitizePresentation: true,
  });
  assert.equal(preview.truncated, true);
  assert.equal(preview.messages.some((item) => item.role === "user"), false);
  assert.equal(Object.hasOwn(preview, "titleTurn"), false);
  const active = actors.get(untitled.admission.sessionId);
  active.emit("event", { type: "agent_start" });
  active.emit("event", { type: "message_end", message: { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: assistantText }] } });
  active.emit("event", { type: "tool_execution_start", toolName: "ipython", toolCallId: "held-title-check" });
  await eventually(() => supervisor.store.getSession(untitled.admission.sessionId).name === "Smarter Session Titles");
  assert.equal(supervisor.store.getSession(untitled.admission.sessionId).activity, "working", "title generation must not wait for the held tool or agent_settled");
  assert.match(generatedTurns[0], /I want depth 0 sessions to be renamed automatically/);
  assert.match(generatedTurns[0], /I will trace the session-title path before running the long checks/);
  assert.doesNotMatch(generatedTurns[0], /Progress update/);
  assert(generatedTurns[0].length < 1700, "the long-turn title prompt stays bounded");
  assert.deepEqual(generatedModels, [{ provider: "openai-codex", id: "session-selected-model" }]);
  await eventually(() => navigatorEvents.some((event) => event.reason === "name_changed"
    && event.sessions.some((session) => session.sessionId === untitled.admission.sessionId
      && session.name === "Smarter Session Titles")));

  const named = await client.request("create_root", {
    cwd: root, repositoryRoot: null, name: "Taihou 3D Avatar", provider: null, model: null, thinkingLevel: null,
  });
  await eventually(() => actors.get(named.admission.sessionId)?.isRunning);
  await client.request("submit_input", {
    sessionId: named.admission.sessionId,
    message: "I want this Commander title to stay put.",
    behavior: "auto",
  });
  actors.get(named.admission.sessionId).emit("event", { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.store.getSession(named.admission.sessionId).name, "Taihou 3D Avatar");
  assert.equal(generatedModels.length, 1);

  const pending = await client.request("create_root", {
    cwd: root, repositoryRoot: null, name: null, provider: null, model: null, thinkingLevel: null,
  });
  await eventually(() => actors.get(pending.admission.sessionId)?.isRunning);
  await appendTitleTurn(pending.admission.sessionId);
  let releaseTitle; let pendingCalls = 0;
  supervisor.titleGenerator = () => { pendingCalls += 1; return new Promise((resolve) => { releaseTitle = resolve; }); };
  actors.get(pending.admission.sessionId).emit("event", { type: "agent_settled" });
  await eventually(() => releaseTitle);
  actors.get(pending.admission.sessionId).emit("event", { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingCalls, 1, "duplicate settled events share the in-flight title request");
  await client.request("rename_session", { sessionId: pending.admission.sessionId, name: "Commander Chosen Name" });
  releaseTitle("Generated But Superseded");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.store.getSession(pending.admission.sessionId).name, "Commander Chosen Name");

  const retry = await client.request("create_root", {
    cwd: root, repositoryRoot: null, name: null, provider: null, model: null, thinkingLevel: null,
  });
  await eventually(() => actors.get(retry.admission.sessionId)?.isRunning);
  await appendTitleTurn(retry.admission.sessionId);
  const errors = [];
  supervisor.logger = { error: (message) => errors.push(message) };
  supervisor.titleGenerator = async () => { throw new Error("synthetic provider unavailable"); };
  actors.get(retry.admission.sessionId).emit("event", { type: "agent_settled" });
  await eventually(() => errors.length === 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.store.getSession(retry.admission.sessionId).name, defaultRootName(root, retry.admission.sessionId),
    "a provider failure must not permanently save a long clipped fallback");
  supervisor.titleGenerator = async () => "Title Provider Recovery";
  actors.get(retry.admission.sessionId).emit("event", { type: "agent_settled" });
  await eventually(() => supervisor.store.getSession(retry.admission.sessionId).name === "Title Provider Recovery");
});

test("retrying an assistant turn branches the leaf then resubmits the user prompt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-retry-turn-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new RetryPiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "retry-turn" }); t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Retry", provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId; const actor = await eventually(() => actors.get(id)); await eventually(() => actor.isRunning);
  const session = supervisor.store.getSession(id);
  await appendFile(session.sessionFile, `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n${JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } })}\n`);
  const retried = await client.request("submit_input", { sessionId: id, message: "hello", behavior: "auto", retryOf: "a1", clientRequestId: "retry-1" });
  assert.equal(retried.accepted, true);
  assert.equal(actor.prompts[0].message, retryBranchMessage("u1"));
  assert.equal(actor.leafId, null);
  await eventually(() => actor.submits.filter((item) => item.message.includes("hello")).length === 1);
  actor.streaming = true;
  await assert.rejects(client.request("submit_input", { sessionId: id, message: "hello", behavior: "auto", retryOf: "a1", clientRequestId: "retry-busy" }),
    (error) => error.code === "session_busy");
  actor.streaming = false;
  await assert.rejects(client.request("submit_input", { sessionId: id, message: "hello", behavior: "auto", retryOf: "missing", clientRequestId: "retry-missing" }),
    (error) => error.code === "invalid_request");
});

test("submit_input returns accepted while worker.submit is held and drains a second auto steer", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-steer-queue-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), skillsPath, actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 3_000 });
  await client.start({ registrationType: "register_client", clientInstanceId: "steer-queue" }); t.after(() => client.stop());
  const created = await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Steer queue",
    provider: null, model: null, thinkingLevel: null });
  const id = created.admission.sessionId; const actor = await eventually(() => actors.get(id)); await eventually(() => actor.isRunning);
  actor.emit("event", { type: "agent_start" });
  assert.equal(actor.streaming, true);
  let releaseSubmit; actor.submitHold = new Promise((resolve) => { releaseSubmit = resolve; });

  const firstStarted = Date.now();
  const first = await client.request("submit_input", { sessionId: id, message: "steer-one", behavior: "auto" });
  assert.equal(first.accepted, true);
  assert(Date.now() - firstStarted < 1_000, "first submit_input must return before Pi consumes the steer");
  await eventually(() => actor.submitEntered >= 1);
  assert.equal(actor.submits.length, 0);

  const secondStarted = Date.now();
  const second = await client.request("submit_input", { sessionId: id, message: "steer-two", behavior: "auto" });
  assert.equal(second.accepted, true);
  assert(Date.now() - secondStarted < 1_000, "second submit_input must not wait for the first worker.submit");
  assert.notEqual(second.inputId, first.inputId);
  const pending = supervisor.store.listPendingActorInputs(id);
  assert.deepEqual(pending.map((item) => item.message), ["steer-one", "steer-two"]);
  assert.equal(actor.submits.length, 0);
  assert.equal(actor.streaming, true);

  releaseSubmit();
  await eventually(() => actor.submits.filter((item) => item.message.includes("steer-one")).length === 1
    && actor.submits.filter((item) => item.message.includes("steer-two")).length === 1);
  assert.deepEqual(actor.submits.map((item) => item.behavior), ["auto", "auto"]);
});


async function activityEventFixture(t, actorInactivityMs) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-activity-event-cost-"));
  const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    skillsPath, actorInactivityMs, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new FakePiActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }),
  });
  await supervisor.start();
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "activity-event-cost" });
  t.after(async () => { await client.stop(); await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const admission = (await client.request("create_root", { cwd: root, repositoryRoot: null, name: "Activity fixture",
    provider: null, model: null, thinkingLevel: null })).admission;
  await eventually(() => actors.get(admission.sessionId)?.isRunning
    && supervisor.store.getSession(admission.sessionId)?.lifecycle === "resident");
  return { supervisor, client, actor: actors.get(admission.sessionId), sessionId: admission.sessionId };
}

test("stream updates do not rescan resident session maintenance state", async (t) => {
  const { supervisor, client, actor, sessionId } = await activityEventFixture(t, 0);
  actor.emit("event", { type: "agent_start" });
  const getSession = supervisor.store.getSession.bind(supervisor.store); let reads = 0;
  supervisor.store.getSession = (...args) => { reads += 1; return getSession(...args); };
  for (let index = 0; index < 300; index += 1) {
    actor.emit("event", { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "synthetic" } });
  }
  assert.equal(reads, 0, "streaming does not change activity or idle deadlines");
  assert.equal((await client.request("get_status")).running, true);
  assert.equal(getSession(sessionId).activity, "working");
});

test("working actors remain resident and settled actors still passivate after stream updates", async (t) => {
  const { supervisor, actor, sessionId } = await activityEventFixture(t, 30);
  actor.emit("event", { type: "agent_start" });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(supervisor.store.getSession(sessionId).lifecycle, "resident");
  actor.emit("event", { type: "agent_settled" });
  await eventually(() => supervisor.store.getSession(sessionId).lifecycle === "passivated");
  assert.equal(actor.isRunning, false);
});

class OriginalRetryActor extends RetryPiActor {
  constructor(options) { super(options); this.env = options.env; this.args = options.args; this.internal = []; }
  async start() {
    this.control = new HarnessClient({ socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.control.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    return super.start();
  }
  async request(type, fields = {}, timeout) {
    if (type === "get_commands") return { commands: [{ name: ACTOR_INPUT_COMMAND, source: "extension",
      sourceInfo: { path: this.args[this.args.indexOf("--extension") + 1] } }] };
    if (type === "prompt" && fields.message?.startsWith(`/${ACTOR_INPUT_COMMAND} `)) {
      const inputId = decodeURIComponent(fields.message.slice(ACTOR_INPUT_COMMAND.length + 2));
      const { input } = await this.control.request("get_actor_input", { inputId });
      this.internal.push({ input, payload: actorInputCustomPayload(input) });
      await this.control.request("accept_actor_input", { inputId }); return {};
    }
    return super.request(type, fields, timeout);
  }
  async close() { await this.control?.stop(); return super.close(); }
}

test("original internal Retry derives an unloaded source and dedupes before any later branch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-original-retry-")); const skillsPath = path.join(root, "skills"); await mkdir(skillsPath);
  const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "harness.sqlite"), pidPath: path.join(root, "supervisor.pid"),
    skillsPath, backgroundJobsDirectory: path.join(root, "background"), actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new OriginalRetryActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }) });
  await supervisor.start(); t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const browser = new HarnessClient({ socketPath, heartbeatMs: 0 }); await browser.start({ registrationType: "register_client", clientInstanceId: "original-retry" }); t.after(() => browser.stop());
  const { admission } = await browser.request("create_root", { cwd: root, repositoryRoot: null, name: "Original retry", provider: null, model: null, thinkingLevel: null });
  const actor = await eventually(() => actors.get(admission.sessionId)); await eventually(() => actor.isRunning);
  const input = supervisor.store.createActorInput(admission.sessionId, { inputId: "original-background", message: "Exact original context",
    images: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }], source: "background", origin: { jobId: "job-proof" }, behavior: "auto" }, 1);
  const file = supervisor.store.getSession(admission.sessionId).sessionFile;
  const inputEntry = { type: "custom_message", id: "original-input", parentId: null, timestamp: new Date(2).toISOString(), ...actorInputCustomPayload(input) };
  const answer = { type: "message", id: "original-answer", parentId: "original-input", timestamp: new Date(3).toISOString(),
    message: { role: "assistant", timestamp: 3, content: Array.from({ length: 105 }, (_, index) => ({ type: "text", text: `Visible item ${index}`,
      textSignature: JSON.stringify({ v: 1, id: `retry-part-${index}` }) })) } };
  await appendFile(file, [inputEntry, answer].map(JSON.stringify).join("\n") + "\n");
  supervisor.store.completeActorInput(input.inputId, admission.sessionId, 2, inputEntry.id);
  const page = await browser.request("get_visible_messages", { sessionId: admission.sessionId });
  assert.equal(page.messages.some((message) => message.id === input.inputId), false, "the browser tail does not contain the source");
  const target = page.messages.at(-1).id;
  const params = { sessionId: admission.sessionId, retryOriginal: true, retryOf: target, clientRequestId: "retry-correlation" };
  const accepted = await browser.request("submit_input", params);
  assert.notEqual(accepted.inputId, input.inputId); assert.equal(accepted.clientMessageId, "retry-correlation");
  assert.equal(accepted.source, "background"); assert.equal(accepted.message.role, "background_notification");
  assert.equal(accepted.message.text, "Exact original context"); assert.equal(accepted.message.delivery.state, "accepted");
  await eventually(() => actor.internal.length === 1);
  assert.equal(actor.internal[0].input.images[0].data, PNG_1X1);
  const delivered = { type: "custom_message", id: "retried-input", parentId: null, timestamp: new Date().toISOString(), ...actor.internal[0].payload };
  await appendFile(file, JSON.stringify(delivered) + "\n");
  await actor.control.request("record_input_delivery", { inputId: accepted.inputId, entryId: delivered.id, deliveredAt: delivered.timestamp });
  const branches = actor.prompts.length; actor.streaming = true;
  const repeated = await browser.request("submit_input", params);
  assert.equal(repeated.inputId, accepted.inputId); assert.equal(repeated.delivery.state, "delivered");
  assert.equal(actor.prompts.length, branches); assert.equal(actor.internal.length, 1);
  await assert.rejects(browser.request("submit_input", { ...params, retryOf: "different-target" }), /reused with different input/);
  actor.streaming = false;
  const image = await browser.request("get_visible_image", { sessionId: admission.sessionId, entryId: accepted.inputId, index: 0 });
  assert.equal(image.image.data, PNG_1X1);

  // An origin cron cannot enter the actor while Retry owns descriptor capture/branching.
  await appendFile(file, JSON.stringify({ type: "message", id: "race-answer", parentId: delivered.id, timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "Race answer" }] } }) + "\n");
  const nextPage = await browser.request("get_visible_messages", { sessionId: admission.sessionId });
  const raceTarget = nextPage.messages.find((message) => message.text === "Race answer").id;
  const job = (await actor.control.request("cron_job", { action: "create", name: "Concurrent origin", prompt: "Wait for Retry ownership",
    schedule: { kind: "at", at: "2030-01-01T00:00:00Z" }, executionMode: "origin", repeat: 1 })).job;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const originalResolver = supervisor.transcriptReader.resolveRetryInput.bind(supervisor.transcriptReader);
  supervisor.transcriptReader.resolveRetryInput = async (options) => { const value = await originalResolver(options); entered.resolve(); await release.promise; return value; };
  const racingRetry = browser.request("submit_input", { sessionId: admission.sessionId, retryOriginal: true, retryOf: raceTarget, clientRequestId: "race-correlation" });
  let retried;
  try {
    await entered.promise;
    await actor.control.request("cron_job", { action: "run", selector: job.jobId });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(supervisor.store.listActorInputReceipts(admission.sessionId).some((item) => item.source === "cron"), false,
      "cron source admission must wait behind the existing Retry mutation owner");
  } finally { release.resolve(); retried = await racingRetry; supervisor.transcriptReader.resolveRetryInput = originalResolver; }
  await eventually(() => supervisor.store.listActorInputReceipts(admission.sessionId).some((item) => item.source === "cron"));
  const records = supervisor.store.listActorInputReceipts(admission.sessionId);
  assert(records.find((item) => item.inputId === retried.inputId).sequence < records.find((item) => item.source === "cron").sequence);
});
