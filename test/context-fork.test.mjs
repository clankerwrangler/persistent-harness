import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, appendFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createContextFork, CONTEXT_FORK_TYPE, MAX_CONTEXT_FORK_BYTES } from "../src/context-fork.mjs";
import { createPiSession, buildPiSessionContext } from "../src/pi-session.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { resolveChildLaunchPolicy } from "../src/child-policy.mjs";
import { validateRequest, PROTOCOL_VERSION } from "../src/protocol.mjs";

const model = { provider: "fake", id: "parent", reasoning: false, thinkingLevels: ["off"] };
const request = (overrides = {}) => ({ prompt: "task", parentModel: model, parentThinkingLevel: "off", availableModels: [model], ...overrides });
const frame = (params) => ({ version: PROTOCOL_VERSION, id: "spawn", type: "spawn_child", params });
const stamp = "2026-09-04T00:00:00.000Z";
function entry(id, parentId, message) { return { type: "message", id, parentId, timestamp: stamp, message }; }
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 2, provider: "fake", model: "parent" });
const seed = (messages) => createContextFork({ sourceSessionId: "source", sourceLeafId: "leaf", messages });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-fork-unit-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(root, { recursive: true, force: true }); });
  return root;
}
async function sourceFile(root, entries, tail = "") {
  const sessionFile = path.join(root, "source.jsonl");
  await writeFile(sessionFile, [{ type: "session", version: 3, id: "source", timestamp: stamp, cwd: root }, ...entries].map((item) => JSON.stringify(item) + "\n").join("") + tail);
  return sessionFile;
}

test("fork_context is strict at host, policy, and protocol before admission side effects", async () => {
  let leaf = "at-call"; const calls = [];
  const handlers = createHostHandlers({ cwd: "/tmp", getManifest: () => ({ skills: [] }),
    getContext: () => ({ model, modelRegistry: { getAvailable: () => [model] }, sessionManager: { getLeafId: () => leaf } }),
    getClient: () => ({ isConnected: true, connectedSession: { depth: 0 }, limits: { maxDepth: 2 },
      request: async (type, params) => { calls.push({ type, params }); leaf = "later"; return { admission: {} }; } }) });
  for (const invalid of [null, 0, 1, "true", [], {}]) {
    await assert.rejects(handlers["rlm.spawn"]({ prompt: "task", forkContext: invalid }), /boolean/);
    assert.throws(() => validateRequest(frame(request({ forkContext: invalid }))), /boolean/);
    assert.throws(() => resolveChildLaunchPolicy({ request: { ...request({ forkContext: invalid }), skillCatalog: [] }, parent: { kind: "root", depth: 0 } }), /boolean/);
  }
  assert.deepEqual(calls, []);
  await handlers["rlm.spawn"]({ prompt: "task", forkContext: true });
  assert.equal(calls[1].params.forkLeafId, "at-call", "freeze the leaf before asynchronous manifest admission");
  assert.equal(calls[1].params.forkContext, true);
  assert.equal(validateRequest(frame(request())).params.forkContext, false);
  assert.throws(() => validateRequest(frame(request({ forkContext: true }))), /forkLeafId/);
  assert.throws(() => validateRequest(frame(request({ forkLeafId: "leaf" }))), /requires forkContext/);
  assert.equal(validateRequest(frame(request({ forkContext: true, forkLeafId: null }))).params.forkLeafId, null);
  calls.length = 0;
  await handlers["rlm.spawn"]({ prompt: "isolated" });
  assert.equal("forkContext" in calls[1].params, false, "default requests remain compatible with a running older supervisor");
  assert.equal("forkLeafId" in calls[1].params, false);
});

test("semantic seed preserves text and images but has no executable history, usage, task, or input metadata", () => {
  const image = { type: "image", mimeType: "image/png", data: "AQ==" };
  const messages = [
    user([{ type: "text", text: "SOURCE_USER\n\n<!-- persistent-harness-input:source-input -->" }, image]),
    { ...assistant("FINAL"), usage: { input: 999 }, content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "FINAL" }] },
    { ...assistant("PENDING_CHATTER", "toolUse"), content: [{ type: "toolCall", id: "source-call", name: "ipython", arguments: { code: "RUN_SOURCE" } }] },
    { role: "toolResult", toolCallId: "source-call", content: [{ type: "text", text: "SOURCE_TOOL_RESULT" }] },
    assistant("FAILED", "error"), assistant("TRUNCATED", "length"),
    { role: "custom", customType: "persistent-harness.agent-message", content: "FAMILY_MESSAGE", details: { taskId: "source-task" } },
    { role: "system", content: "SOURCE_SYSTEM" }, { role: "developer", content: "SOURCE_DEVELOPER" },
    { role: "compactionSummary", summary: "SUMMARY_FACTS", tokensBefore: 100 },
  ];
  const inherited = seed(messages); const encoded = JSON.stringify(inherited);
  assert.match(encoded, /SOURCE_USER|FINAL|SUMMARY_FACTS/);
  for (const text of ["SOURCE_USER", "FINAL", "SUMMARY_FACTS"]) assert(encoded.includes(text));
  assert(inherited.content.some((block) => block.type === "image" && block.data === image.data));
  assert.doesNotMatch(encoded, /source-input|source-task|source-call|SOURCE_SYSTEM|SOURCE_DEVELOPER|PRIVATE_REASONING|SOURCE_TOOL_RESULT|PENDING_CHATTER|RUN_SOURCE|FAMILY_MESSAGE|FAILED|TRUNCATED|usage/);
  assert.equal(inherited.details.readOnly, true); assert.equal(inherited.details.messageCount, 3);
  assert.equal(seed(messages).details.snapshotHash, inherited.details.snapshotHash);
  const nested = seed([{ role: "custom", ...inherited }, user("CHILD_TASK"), assistant("CHILD_RESULT")]);
  const nestedText = JSON.stringify(nested.content);
  for (const text of ["SOURCE_USER", "FINAL", "SUMMARY_FACTS", "CHILD_TASK", "CHILD_RESULT"]) assert(nestedText.includes(text));
  assert.equal((nestedText.match(/SOURCE_USER/g) ?? []).length, 1);
  assert.throws(() => seed([user("x".repeat(MAX_CONTEXT_FORK_BYTES))]), /context limit/);
});

test("read-only active branch projection keeps the latest compaction and branch summary, not abandoned or pending tools", async (t) => {
  const root = await fixture(t);
  const entries = [entry("u0", null, user("OLD_COMPACTED")), entry("a0", "u0", assistant("OLD_ANSWER")),
    { type: "compaction", id: "c0", parentId: "a0", timestamp: stamp, summary: "OLD_SUMMARY", firstKeptEntryId: "a0", tokensBefore: 100 },
    entry("abandoned", "c0", user("ABANDONED")), entry("u1", "c0", user("KEPT_USER")), entry("a1", "u1", assistant("KEPT_ANSWER")),
    { type: "compaction", id: "c1", parentId: "a1", timestamp: stamp, summary: "LATEST_SUMMARY", firstKeptEntryId: "u1", tokensBefore: 100 },
    { type: "branch_summary", id: "b1", parentId: "c1", timestamp: stamp, fromId: "abandoned", summary: "BRANCH_FACTS" },
    entry("u2", "b1", user("CURRENT_TASK")), entry("pending", "u2", { ...assistant("PENDING", "toolUse"), content: [{ type: "toolCall", id: "pending-call", name: "ipython", arguments: { code: "RUN_ME" } }] }),
  ];
  const file = await sourceFile(root, entries, '{"type":"message","id":"partial');
  const before = await readFile(file); const reader = new VisibleTranscriptReader();
  const snapshot = await reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "pending" });
  assert.equal(snapshot.entries.some((entry) => entry.id === "abandoned"), false);
  const context = await buildPiSessionContext(snapshot.entries, snapshot.leafId);
  const inherited = seed(context.messages); const text = JSON.stringify(inherited.content);
  for (const expected of ["LATEST_SUMMARY", "BRANCH_FACTS", "KEPT_USER", "KEPT_ANSWER", "CURRENT_TASK"]) assert(text.includes(expected), expected);
  assert.doesNotMatch(text, /OLD_COMPACTED|OLD_ANSWER|OLD_SUMMARY|ABANDONED|PENDING|RUN_ME/);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "missing" }), /missing parent/);
  await assert.rejects(reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "pending", maxBytes: 1 }), /byte limit/);
  await assert.rejects(reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "pending", maxEntries: 1 }), /entry limit/);
  assert.deepEqual(await readFile(file), before, "snapshot failures never migrate or rewrite the source");
  await writeFile(file, before.subarray(0, before.indexOf(Buffer.from('{"type":"message","id":"pending"'))));
  await assert.rejects(reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "pending" }), /missing parent/);
});

test("canonical child creation persists one immutable seed and defaults to no context across reopen", async (t) => {
  const root = await fixture(t);
  const inherited = seed([user("SOURCE_USER"), assistant("SOURCE_ANSWER")]);
  const forked = await createPiSession({ cwd: root, name: "forked", contextFork: inherited });
  const isolated = await createPiSession({ cwd: root, name: "isolated" });
  const before = await readFile(forked.sessionFile, "utf8");
  assert.notEqual(forked.sessionId, "source"); assert.notEqual(forked.sessionId, isolated.sessionId);
  assert.equal(before.split("\n").filter(Boolean).map(JSON.parse).filter((entry) => entry.customType === CONTEXT_FORK_TYPE).length, 1);
  assert.doesNotMatch(await readFile(isolated.sessionFile, "utf8"), /SOURCE_USER|persistent-harness\.context-fork/);
  const reader = new VisibleTranscriptReader();
  const visible = await reader.read({ sessionFile: forked.sessionFile, sessionId: forked.sessionId });
  assert.deepEqual(visible.messages, []); assert.deepEqual(visible.inputIds, []); assert.deepEqual(visible.inputEntries, {});
  const first = await reader.readBranch({ sessionFile: forked.sessionFile, sessionId: forked.sessionId, leafId: visible.leafId });
  const projected = await buildPiSessionContext(first.entries, first.leafId);
  assert.equal(projected.messages.length, 1); assert.equal(projected.messages[0].role, "custom");
  assert.deepEqual(projected.messages[0].details, inherited.details);
  const reopened = new VisibleTranscriptReader();
  const again = await reopened.readBranch({ sessionFile: forked.sessionFile, sessionId: forked.sessionId, leafId: visible.leafId });
  assert.deepEqual(again, first); assert.equal(await readFile(forked.sessionFile, "utf8"), before);
  assert.equal((await readdir(forked.sessionDir)).length, 2, "context payload has no separate sidecar store");
});

test("a cached fork snapshot rejects changed source bytes or header without rewriting them", async (t) => {
  const root = await fixture(t); const file = await sourceFile(root, [entry("u1", null, user("ORIGINAL"))]);
  const reader = new VisibleTranscriptReader(); await reader.read({ sessionFile: file, sessionId: "source" });
  const original = await readFile(file, "utf8");
  for (const changed of [original.replace("ORIGINAL", "MODIFIED"), original.replace('"id":"source"', '"id":"forged"')]) {
    await writeFile(file, changed);
    await assert.rejects(reader.readBranch({ sessionFile: file, sessionId: "source", leafId: "u1" }), /changed during read/);
    assert.equal(await readFile(file, "utf8"), changed);
  }
});

test("Python rlm exposes a strict opt-in and leaves legacy default payloads unchanged", () => {
  const source = path.join(process.env.PI_HARNESS_SKILLS_PATH || path.resolve(import.meta.dirname, "../skills"), "rlm/src/harness_rlm/__init__.py");
  const code = `
import asyncio, runpy, sys, types
calls = []
stub = types.ModuleType("_persistent_harness")
class SkillResult(dict):
    def __init__(self, value, mime=None): super().__init__(value)
stub.SkillResult = SkillResult
stub.host_request = lambda kind, payload: calls.append((kind, payload)) or {"admission": {}}
sys.modules["_persistent_harness"] = stub
spawn = runpy.run_path(sys.argv[1])["spawn"]
for invalid in (None, 0, 1, "true", [], {}):
    try: asyncio.run(spawn("task", fork_context=invalid))
    except TypeError as error: assert str(error) == "fork_context must be boolean"
    else: raise AssertionError("invalid option accepted")
assert calls == []
asyncio.run(spawn("default"))
assert "forkContext" not in calls[-1][1]
asyncio.run(spawn("false", fork_context=False))
assert "forkContext" not in calls[-1][1]
asyncio.run(spawn("fork", fork_context=True, model="fake/pinned"))
assert calls[-1][0] == "rlm.spawn"
assert calls[-1][1]["forkContext"] is True
assert calls[-1][1]["model"] == "fake/pinned"
print("ok")
`;
  assert.equal(execFileSync("python3", ["-c", code, source], { encoding: "utf8", timeout: 30_000 }).trim(), "ok");
});
