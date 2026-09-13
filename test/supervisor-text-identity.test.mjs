import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { assistantMessageParts } from "../src/conversation-projection.mjs";
import { PiRpcLineDecoder } from "../src/session-actor.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

class Actor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; }
  async start() { this.isRunning = true; return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: false, model: null }; }
  async request(type) {
    if (type === "get_state") return { isStreaming: false, sessionId: this.session.sessionId };
    if (type === "get_entries") return { entries: [], leafId: null };
    throw new Error(`Unexpected fixture request ${type}`);
  }
  async close() { this.isRunning = false; this.emit("exit", { expected: true, code: 0 }); }
}

test("supervisor joins slim core text IDs through prefix rebasing and repeated canonical reads", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "supervisor-text-id-")); const skillDir = path.join(directory, "skills");
  const agentDir = path.join(directory, "agent"); await Promise.all([mkdir(skillDir), mkdir(agentDir)]);
  const previousAgent = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionId = "text-id-fixture"; const sessionFile = path.join(directory, "session.jsonl");
  const socketPath = path.join(directory, "run", "supervisor.sock"); const workers = []; const events = [];
  const legacy = { type: "message", id: "legacy-entry", parentId: null, timestamp: new Date(0).toISOString(),
    message: { role: "assistant", provider: "fixture", timestamp: 0,
      content: [{ type: "text", text: "LEGACY", textSignature: JSON.stringify({ v: 1, id: "msg-legacy" }) }], stopReason: "stop" } };
  await writeFile(sessionFile, [ { type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: directory }, legacy ].map(JSON.stringify).join("\n") + "\n");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "harness.sqlite"), pidPath: path.join(directory, "supervisor.pid"),
    skillsPath: skillDir, backgroundJobsDirectory: path.join(directory, "jobs"), actorInactivityMs: 0, runtimeProvisioner: async () => ({}),
    actorFactory(options) { const actor = new Actor(options); workers.push(actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "synthetic", ownerToken: "synthetic" }),
    processTerminator: async () => ({ terminated: true }) });
  let client;
  t.after(async () => { await client?.stop(); await supervisor.stop();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    await rm(directory, { recursive: true, force: true }); });
  await supervisor.start(); supervisor.store.createRoot({ sessionId, sessionFile, cwd: directory, repositoryRoot: null,
    name: "Core text identity fixture", actorToken: "synthetic", launch: {} }, 1);
  client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "text-id-client" });
  client.on("event", (frame) => { if (frame.event === "actor_event") events.push(frame.data.event); });
  await client.request("subscribe_session", { selector: sessionId });
  const decoder = new PiRpcLineDecoder(); const actor = workers[0]; let leaf = legacy.id; let entryIndex = 0;
  const entries = [legacy]; const ids = [];
  const emit = async (event) => {
    if (event.type === "message_end") {
      const entry = { type: "message", id: `entry-${++entryIndex}`, parentId: leaf, timestamp: new Date(1).toISOString(), message: event.message };
      leaf = entry.id; entries.push(entry); await appendFile(sessionFile, JSON.stringify(entry) + "\n");
    }
    const bytes = Buffer.from(JSON.stringify(event) + "\n");
    for (const chunk of [bytes.subarray(0, 7), bytes.subarray(7)]) for (const frame of decoder.push(chunk)) actor.emit("event", frame);
  };
  const text = (id, value, providerId) => ({ type: "text", id, text: value, textSignature: JSON.stringify({ v: 1, id: providerId, phase: "commentary" }) });
  const message = (id, content, stopReason = "stop") => ({ role: "assistant", id, provider: "fixture", timestamp: 1, content, stopReason });
  const update = (type, contentIndex, fields = {}) => emit({ type: "message_update", usage: { totalTokens: 0 }, assistantMessageEvent: { type, contentIndex, ...fields } });
  const visible = async () => (await client.request("get_visible_messages", { sessionId })).messages;
  const firstLegacy = (await visible())[0]; assert.equal(firstLegacy.id, assistantMessageParts(legacy)[0].id);
  await emit({ type: "agent_start" }); await emit({ type: "message_start", message: message("segment-1", []) });
  await update("text_start", 0, { id: "core-A" }); await update("text_delta", 0, { delta: "A" }); await update("text_end", 0, { content: "A" });
  await update("text_start", 2, { id: "core-B" }); await update("text_delta", 2, { delta: "B" });
  const before = (await visible()).slice(1); assert.deepEqual(before.map((row) => row.text), ["A", "B"]); ids.push(...before.map((row) => row.id));
  const call = { type: "toolCall", id: "original-call", name: "ipython", arguments: { code: "synthetic" } };
  await emit({ type: "message_end", message: message("segment-1", [text("core-A", "A", "msg-A"), call], "toolUse") });
  await emit({ type: "message_start", message: message("segment-2", [text("core-B", "B", "msg-B")]) });
  await update("text_delta", 0, { delta: "2" });
  assert.deepEqual((await visible()).slice(1).map((row) => [row.id, row.text]), [[ids[0], "A"], [ids[1], "B2"]]);
  await update("text_end", 0, { content: "B2" });
  await emit({ type: "message_end", message: message("segment-2", [text("core-B", "B2", "msg-B")]) });
  await emit({ type: "agent_settled" });
  for (let index = 0; index < 2; index += 1) assert.deepEqual((await visible()).map((row) => row.id), [firstLegacy.id, ...ids]);

  await emit({ type: "agent_start" }); await emit({ type: "message_start", message: message("segment-3", []) });
  for (const [index, id, value] of [[0, "core-next-A", "A"], [1, "core-next-B", "B2"]]) {
    await update("text_start", index, { id }); await update("text_delta", index, { delta: value }); await update("text_end", index, { content: value });
  }
  await emit({ type: "message_end", message: message("segment-3", [text("core-next-A", "A", "msg-A"), text("core-next-B", "B2", "msg-B")]) });
  await emit({ type: "agent_settled" });
  const final = await visible(); assert.deepEqual(final.map((row) => row.text), ["LEGACY", "A", "B2", "A", "B2"]);
  assert.equal(new Set(final.map((row) => row.id)).size, 5);
  assert.deepEqual(final.map((row) => row.id), entries.flatMap((entry) => assistantMessageParts(entry)).map((row) => row.id));
  assert.deepEqual((await visible()).map((row) => row.id), final.map((row) => row.id));
  assert.doesNotMatch(JSON.stringify(events), /textSignature|core-next|msg-A|msg-B/);
  assert(events.filter((event) => event.type === "message_update").every((event) => !("message" in event) && !("partial" in event.assistantMessageEvent)));
});
