import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HarnessClient } from "../../src/client.mjs";
import { HarnessSupervisor } from "../../src/supervisor.mjs";

export async function until(probe, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("recursive deletion fixture timed out");
}
class Actor extends EventEmitter {
  constructor(options, fixture) { super(); this.session = options.session; this.fixture = fixture; this.pid = process.pid; this.isRunning = false; this.submits = []; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile, model: null, thinkingLevel: "off", isStreaming: false }; }
  async start() { this.isRunning = true; await this.fixture.startGate?.(this); return this.state(); }
  async request(type) { if (type === "get_state") return this.state(); if (type === "get_entries") return { entries: [], leafId: null }; throw new Error(`unexpected ${type}`); }
  async submit(...args) { this.submits.push(args); return {}; }
  async close() {
    if (!this.isRunning) return;
    this.fixture.closeOrder.push(this.session.name);
    await this.fixture.closeGate?.(this);
    if (this.failClose) throw new Error("synthetic close failure");
    this.isRunning = false; this.emit("exit", { code: 0, signal: "SIGTERM" });
  }
}
export async function deletionFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recursive-session-delete-"));
  await mkdir(path.join(dir, "skills")); await mkdir(path.join(dir, "agent"));
  const oldAgent = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  const fixture = { dir, actors: new Map(), clients: [], closeOrder: [], errors: [] };
  const socketPath = path.join(dir, "run", "supervisor.sock");
  fixture.supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(dir, "state", "harness.sqlite"),
    pidPath: path.join(dir, "run", "supervisor.pid"), skillsPath: path.join(dir, "skills"), backgroundJobsDirectory: path.join(dir, "jobs"),
    actorInactivityMs: 0, maxResidentActors: 20, maxConcurrentStarts: 5, titleGenerator: async () => null,
    actorFactory: options => { const actor = new Actor(options, fixture); fixture.actors.set(options.session.sessionId, actor); return actor; },
    runtimeProvisioner: async () => ({}),
    processIdentityFactory: async pid => { await fixture.identityGate?.(); return { version: 1, pid, processGroup: pid, startTime: "fixture", ownerToken: "fixture" }; },
    processTerminator: async () => ({ terminated: true }), logger: { error: error => fixture.errors.push(String(error)) } });
  t.after(async () => {
    fixture.closeGate = null; fixture.startGate = null; fixture.identityGate = null;
    for (const actor of fixture.actors.values()) actor.failClose = false;
    await Promise.all(fixture.clients.map(client => client.stop())); await fixture.supervisor.stop();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(dir, { recursive: true, force: true });
  });
  await fixture.supervisor.start();
  fixture.client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 20_000 }); fixture.clients.push(fixture.client);
  await fixture.client.start({ registrationType: "register_client", clientInstanceId: randomUUID() });
  fixture.admit = async (name, parent = null, { start = true } = {}) => {
    const sessionId = randomUUID(), sessionFile = path.join(dir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
    const policy = { name, prompt: "Disposable deletion fixture", cwd: dir, repositoryRoot: null, capabilities: [], skillCatalog: [] };
    const store = fixture.supervisor.store;
    const session = parent ? store.createChild(parent.sessionId, { sessionId, sessionFile, policy, actorToken: randomUUID() }).session
      : store.createRoot({ sessionId, sessionFile, cwd: dir, repositoryRoot: null, name, launch: policy, actorToken: randomUUID() }).session;
    store.setSessionSkillGrant(sessionId, []);
    if (start) await fixture.client.request("subscribe_session", { selector: sessionId });
    return session;
  };
  fixture.actorClient = async session => {
    const launch = fixture.supervisor.store.getActorLaunch(session.sessionId);
    const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 20_000 }); fixture.clients.push(client);
    await client.start({ registrationType: "register_actor", sessionId: launch.sessionId, sessionFile: launch.sessionFile,
      cwd: launch.cwd, repositoryRoot: launch.repositoryRoot, actorToken: launch.actorToken, actorGeneration: launch.actorGeneration });
    return client;
  };
  fixture.tree = async () => {
    const root = await fixture.admit("Root"), child = await fixture.admit("Child", root), grandchild = await fixture.admit("Grandchild", child),
      sibling = await fixture.admit("Sibling", root), other = await fixture.admit("Other");
    return { root, child, grandchild, sibling, other };
  };
  return fixture;
}
