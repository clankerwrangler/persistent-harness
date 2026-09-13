import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor } from "../../src/supervisor.mjs";
import { ACTOR_INPUT_COMMAND } from "../../src/protocol.mjs";
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(10); }
  throw new Error("condition not reached");
}
class Actor extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.pid = process.pid; this.isRunning = false; this.streaming = false; this.sent = []; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, isStreaming: this.streaming,
    model: this.session.launch?.model?.resolved ?? null, thinkingLevel: this.session.launch?.thinking?.resolved ?? "off" }; }
  async start() {
    this.connection = new HarnessClient({ socketPath: this.env.PI_HARNESS_SOCKET, heartbeatMs: 0 });
    await this.connection.start({ registrationType: "register_actor", sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
      cwd: this.session.cwd, repositoryRoot: this.session.repositoryRoot, actorToken: this.session.actorToken, actorGeneration: this.session.actorGeneration });
    this.isRunning = true; return this.state();
  }
  busy() { this.streaming = true; this.emit("event", { type: "agent_start" }); }
  idle() { this.streaming = false; this.emit("event", { type: "agent_settled" }); }
  async request(type, params = {}) {
    if (type === "get_commands") return { commands: [{ name: ACTOR_INPUT_COMMAND, source: "extension", sourceInfo: { path: this.args[this.args.indexOf("--extension") + 1] } }] };
    if (type === "get_state") return this.state(); if (type === "get_entries") return { entries: [] };
    if (type === "prompt") {
      const prefix = `/${ACTOR_INPUT_COMMAND} `;
      if (params.message?.startsWith(prefix)) await this.connection.request("accept_actor_input", { inputId: decodeURIComponent(params.message.slice(prefix.length)) });
      return {};
    } throw new Error(`unexpected request ${type}`);
  }
  async submit() { return {}; }
  send(frame) { this.sent.push(frame); }
  async close() { if (!this.isRunning) return; this.isRunning = false; await this.connection.stop(); this.emit("exit", { code: 0, expected: true }); }
}
export async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notification-supervisor-"));
  const skillsPath = path.join(dir, "skills"); await mkdir(skillsPath);
  const actors = new Map(), errors = [];
  const supervisor = new HarnessSupervisor({ socketPath: path.join(dir, "run", "h.sock"), databasePath: path.join(dir, "state", "h.sqlite"),
    pidPath: path.join(dir, "run", "h.pid"), skillsPath, actorInactivityMs: 0, notificationIdleMs: 70, notificationTickMs: 10,
    backgroundJobsDirectory: path.join(dir, "jobs"), titleGenerator: null,
    runtimeProvisioner: async () => ({}), actorFactory: value => { const actor = new Actor(value); actors.set(value.session.sessionId, actor); return actor; },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "fake", ownerToken: "fake" }),
    processTerminator: async () => ({ terminated: true }), logger: { error: message => errors.push(String(message)), log() {} }, ...options });
  await supervisor.start();
  const client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "notification-fixture" });
  t.after(async () => { await client.stop(); await supervisor.stop(); await rm(dir, { recursive: true, force: true }); });
  async function actor(parentId = null) {
    const sessionId = randomUUID(), sessionFile = path.join(dir, `${sessionId}.jsonl`), actorToken = randomUUID();
    await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
    const launch = { model: null, thinking: { resolved: "off" }, capabilities: [], skillCatalog: [] };
    if (parentId) supervisor.store.createChild(parentId, { sessionId, sessionFile, actorToken,
      policy: { ...launch, prompt: "child work", name: "Child", cwd: dir, repositoryRoot: dir, depth: supervisor.store.getSession(parentId).depth + 1 } });
    else supervisor.store.createRoot({ sessionId, sessionFile, actorToken, launch, cwd: dir, repositoryRoot: dir, name: `Root ${sessionId.slice(0, 8)}` });
    await client.request("revive_session", { sessionId });
    return eventually(() => supervisor.store.getSession(sessionId)?.lifecycle === "resident" && actors.get(sessionId)?.isRunning && actors.get(sessionId));
  }
  return { dir, supervisor, client, actors, actor, errors };
}
