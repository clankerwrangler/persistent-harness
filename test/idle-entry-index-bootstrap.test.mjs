import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadExternalPi } from "../src/external-pi.mjs";
import { bootstrapSDKWorker } from "../src/sdk-worker.mjs";

// The selected complete public graph supplies every SDK owner; no source-owner override.
class Coordinator {
  constructor(options) { Object.assign(this, options); }
  get isBusy() { return false; }
  get pendingMessageCount() { return 0; }
  async start() {
    const noop = () => {};
    this.runner.bindCore(Object.fromEntries(["sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "getSessionName", "setLabel",
      "getActiveTools", "getAllTools", "setActiveTools", "refreshTools", "getCommands", "setModel", "getThinkingLevel", "setThinkingLevel"].map(name => [name, noop])), {
      getModel: () => this.session.model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false,
      getSignal: noop, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop,
      getSystemPrompt: () => this.session.systemPrompt, getSystemPromptOptions: this.basePromptOptions,
    });
    this.runner.bindCommandContext({ waitForIdle: async () => {}, newSession: noop, fork: noop, navigateTree: noop, switchSession: noop, reload: noop });
  }
  async close() { await this.runner.emit({ type: "session_shutdown", reason: "quit" }); }
}
function extension(pi) {
  pi.registerProvider("index-fixture", { api: "index-fixture", apiKey: "public-synthetic", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Index fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() { throw new Error("index bootstrap must not dispatch inference"); } });
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-entry-index-")); const agentDir = path.join(root, "agent"); await mkdir(agentDir, { mode: 0o700 });
  const workers = []; const external = await loadExternalPi();
  t.after(async () => { for (const worker of workers) await worker.close(); await rm(root, { recursive: true, force: true }); });
  return { root, agentDir, external, async open(sessionArgs) {
    const worker = await bootstrapSDKWorker({ external, cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      argv: ["--mode", "rpc", "--provider", "index-fixture", "--model", "model", "--no-extensions", "--no-skills", "--no-context-files", ...sessionArgs],
      Coordinator, extensionFactory: extension, publish() {} });
    assert.equal(worker.session.sessionManager.constructor, external.sdk.SessionManager);
    workers.push(worker); return worker;
  } };
}

test("entry-index bootstrap uses a stable explicit absolute source key and no cold cache mkdir", async t => {
  const f = await fixture(t), sessionFile = path.join(f.root, "session.jsonl");
  await writeFile(sessionFile, [
    { type: "session", version: 3, id: "public-index-fixture", timestamp: new Date(0).toISOString(), cwd: f.root },
    { type: "custom", id: "opaque", parentId: null, timestamp: new Date(1).toISOString(), customType: "synthetic", data: { value: "retained" } },
  ].map(value => JSON.stringify(value) + "\n").join(""), { mode: 0o600 });
  const worker = await f.open(["--session", "./nested/../session.jsonl"]);
  const supported = typeof f.external.sdk.SessionManager.prototype.prepareEntryIndex === "function"
    && typeof f.external.sdk.SessionManager.prototype.enableBoundedEntryRetention === "function";
  const parent = path.join(f.agentDir, "harness", "entry-index-cache");
  await assert.rejects(stat(parent), { code: "ENOENT" });
  if (!supported) {
    assert.equal(worker.entryIndexCachePath, undefined);
    assert.equal(await worker.handle({ type: "prepare_entry_index", token: "unsupported" }), false);
    return;
  }
  const expected = path.join(parent, createHash("sha256").update(sessionFile).digest("hex") + ".index");
  assert.equal(worker.entryIndexCachePath, expected);
  const before = await readFile(sessionFile); const values = worker.session.sessionManager.getEntries();
  assert.equal(await worker.handle({ type: "prepare_entry_index", token: "first-idle" }), true);
  assert.deepEqual(await readFile(sessionFile), before, "preparation does not flush or mutate canonical bytes");
  assert.equal((await stat(parent)).mode & 0o777, 0o700);
  assert.equal((await stat(expected)).mode & 0o777, 0o600);
  await worker.close();
  const reopened = await f.open(["--session", sessionFile]);
  assert.equal(reopened.entryIndexCachePath, expected);
  const warm = reopened.session.sessionManager.getEntries();
  assert.deepEqual(warm.slice(0, values.length), values);
  assert(warm.slice(values.length).every(entry => ["model_change", "thinking_level_change"].includes(entry.type)),
    "stock bootstrap may append ordinary model metadata after the prepared prefix");
  assert.deepEqual((await readFile(sessionFile)).subarray(0, before.length), before);
});

for (const args of [["--no-session"], [], ["--continue"]]) {
  test(`entry-index bootstrap leaves non-explicit session mode ${JSON.stringify(args)} unconfigured`, async t => {
    const f = await fixture(t), worker = await f.open(args);
    assert.equal(worker.entryIndexCachePath, undefined);
    assert.equal(await worker.handle({ type: "prepare_entry_index", token: "non-explicit" }), false);
    await assert.rejects(stat(path.join(f.agentDir, "harness", "entry-index-cache")), { code: "ENOENT" });
  });
}
