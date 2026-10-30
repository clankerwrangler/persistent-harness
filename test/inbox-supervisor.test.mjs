import { loadExternalPiSdk } from "../src/external-pi.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { InboxStore } from "../src/inbox.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { ACTOR_INPUT_COMMAND, actorInputCustomPayload } from "../src/protocol.mjs";

async function eventually(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("condition not reached");
}

class InboxFakeActor extends EventEmitter {
  constructor(options) { super(); this.session = options.session; this.pid = process.pid; this.isRunning = false; this.streaming = false; this.submits = []; this.args = options.args; this.env = options.env; this.connection = null; }
  #state() {
    return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming,
      model: this.session.launch?.model?.resolved ?? null, thinkingLevel: this.session.launch?.thinking?.resolved ?? "off" };
  }
  async start() {
    this.connection = new HarnessClient({ socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.connection.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    this.isRunning = true; return this.#state();
  }
  emit(name, value) { if (name === "event" && value?.type === "agent_start") this.streaming = true;
    if (name === "event" && value?.type === "agent_settled") this.streaming = false; return super.emit(name, value); }
  async request(type, params = {}) {
    if (type === "get_commands") return { commands: [{ name: ACTOR_INPUT_COMMAND, source: "extension", sourceInfo: { path: this.args[this.args.indexOf("--extension") + 1] } }] };
    if (type === "prompt") {
      assert(params.message.startsWith(`/${ACTOR_INPUT_COMMAND} `));
      const inputId = decodeURIComponent(params.message.slice(ACTOR_INPUT_COMMAND.length + 2));
      const { input } = await this.connection.request("get_actor_input", { inputId });
      const payload = actorInputCustomPayload(input);
      this.submits.push({ message: payload.content, behavior: input.behavior, images: input.images, payload });
      await this.connection.request("accept_actor_input", { inputId }); return {};
    }
    if (type === "get_state") return this.#state(); if (type === "get_entries") return { entries: [] };
    throw new Error(`unexpected fake request ${type}`); }
  async submit(message, behavior, images = []) { this.submits.push({ message, behavior, images }); return {}; }
  send() {}
  async close() { if (!this.isRunning) return; this.isRunning = false; await this.connection?.stop();
    this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}

test("an inbox message from a registered sender reaches the routed session as a labelled background input", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-inbox-supervisor-")); const skillsPath = path.join(root, "skills");
  await mkdir(skillsPath); const socketPath = path.join(root, "run", "supervisor.sock"); const actors = new Map();
  const databasePath = path.join(root, "state", "harness.sqlite");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath, pidPath: path.join(root, "run", "supervisor.pid"), skillsPath,
    actorInactivityMs: 0, inboxPort: 0, inboxHost: "127.0.0.1", runtimeProvisioner: async () => ({}),
    actorFactory: (options) => { const actor = new InboxFakeActor(options); actors.set(options.session.sessionId, actor); return actor; },
    processIdentityFactory: async (pid) => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }), logger: { error() {}, log() {} } });
  let browser;
  await supervisor.start();
  t.after(async () => { await browser?.stop(); await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  browser = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await browser.start({ registrationType: "register_client", clientInstanceId: "inbox-browser" });
  await loadExternalPiSdk(); // This fixture measures warm inbox/idle behavior, not cold SDK bootstrap.
  const { sessionId } = (await browser.request("create_root", { cwd: root, repositoryRoot: root, name: "Mail",
    provider: null, model: null, thinkingLevel: null })).admission;
  const actor = await eventually(() => actors.get(sessionId)); await eventually(() => actor.isRunning);

  const admin = new InboxStore(databasePath); t.after(() => admin.close());
  const key = admin.addSender("mail-helper", { kind: "news" }); admin.setRoute("mail", { sessionId });
  const url = `http://127.0.0.1:${supervisor.inboxAddress.port}/v1/messages`;
  const post = (body) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const response = await post({ route: "mail", id: "note-7", text: "DHL: parcel arrives tomorrow 10-14." });
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { deliveredTo: [sessionId] });
  await eventually(() => actor.submits.length === 1);
  assert.match(actor.submits[0].message, /^Message from mail-helper through the harness inbox \(news, id note-7\)\. This is an internal harness event/);
  assert.match(actor.submits[0].message, /DHL: parcel arrives tomorrow 10-14\.$/);
  assert.equal((await post({ route: "mail", id: "note-7", text: "DHL: parcel arrives tomorrow 10-14." })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(actor.submits.length, 1, "a retried message is delivered once");
  admin.setRoute("mail", { sessionId: "01aaaaaa-0000-7000-8000-000000000000" });
  assert.equal((await post({ route: "mail", id: "note-8", text: "Another" })).status, 409);
});
