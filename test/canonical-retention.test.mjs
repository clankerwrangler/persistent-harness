import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { projectCanonicalContext, projectCanonicalSource, refreshCanonicalSessionContext, planUnknownRecovery, registerCanonicalSessionManager, sessionContextInput,
  sessionEntryHeaders, sessionBranchHeaders, sessionCallIssuer, sessionNamespaceHistory } from "../src/canonical-context.mjs";
import { extensionInternals } from "../src/extension.mjs";
import { SDKWorker } from "../src/sdk-worker.mjs";

const stock = await import(pathToFileURL(process.env.PI_HARNESS_PI_MODULE));
const { core } = await (await import("../src/external-pi.mjs")).loadExternalPi();
const candidate = process.env.PI_HARNESS_RETENTION_SDK_MODULE
  ? await import(pathToFileURL(process.env.PI_HARNESS_RETENTION_SDK_MODULE)) : stock;
const user = text => ({ role: "user", content: text, timestamp: 1 });
const call = (id, native = true) => ({ type: "toolCall", id, name: "ipython", arguments: { code: "synthetic" }, async: native });
const assistant = (parts = [call("native")]) => ({ role: "assistant", id: "assistant", content: parts,
  api: "fixture", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function entry(id, parentId, message) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message }; }
function fixture(rows) {
  let entries = structuredClone(rows), leaf = entries.at(-1)?.id ?? null, revision = 0, generation = 0;
  const reads = { ranges: [], ids: [] };
  const manager = { getRevision: () => ({ revision, generation }), getEntryCount: () => entries.length, getLeafId: () => leaf,
    getEntries: () => { throw new Error("ordinary full archive materialization"); },
    getEntriesRange: (start, limit) => { reads.ranges.push([start, limit]); return structuredClone(entries.slice(start, start + limit)); },
    getEntry: id => { reads.ids.push(id); return structuredClone(entries.findLast(row => row.id === id)); },
    buildSessionProjection: () => {
      const context = stock.buildSessionProjection(entries, leaf);
      return { ...context, contextEntryIds: context.entries.map(group => group.sourceEntry.id),
        entries: context.entries.filter(group => group.messages.length > 0) };
    },
    append(row) { entries.push(structuredClone(row)); leaf = row.id; revision++; },
    branch(id) { leaf = id; revision++; },
    reload(rows) { entries = structuredClone(rows); leaf = rows.at(-1)?.id ?? null; generation++; revision++; },
    resetReads() { reads.ranges.length = 0; reads.ids.length = 0; }, reads };
  registerCanonicalSessionManager(manager); return manager;
}
const project = manager => projectCanonicalContext({ sessionManager: manager, mode: "native" });

test("registered snapshot owner reuses facts, hydrates only active payloads, and preserves full cold safety facts", () => {
  const rows = [entry("call", null, assistant()), entry("cold", "call", user("cold payload marker ".repeat(2048))),
    entry("active", "cold", user("active")), { id: "checkpoint", parentId: "active", type: "compaction",
      timestamp: "2026-01-01T00:00:00Z", summary: "summary", firstKeptEntryId: "active", tokensBefore: 1 }];
  const manager = fixture(rows);
  assert.deepEqual(project(manager), projectCanonicalContext({ entries: rows, leafId: "checkpoint", mode: "native", buildSessionProjection: stock.buildSessionProjection }));
  assert.equal(project(manager).outstanding[0].toolCallId, "native");
  assert(!JSON.stringify(sessionEntryHeaders(manager)).includes("cold payload marker"));
  manager.resetReads(); project(manager);
  assert.deepEqual(manager.reads.ranges, []);
  assert(manager.reads.ids.every(id => ["active", "checkpoint"].includes(id)));
  manager.append(entry("suffix", "checkpoint", user("suffix"))); manager.resetReads(); project(manager);
  assert.deepEqual(manager.reads.ranges, [[4, 1]]);
  assert(!manager.reads.ids.includes("cold")); assert(!manager.reads.ids.includes("call"));
  manager.append(entry("header-first", "suffix", user("header first")));
  sessionEntryHeaders(manager); manager.resetReads(); project(manager);
  assert.deepEqual(manager.reads.ranges, []);
  assert(!manager.reads.ids.includes("cold")); assert(!manager.reads.ids.includes("call"));
  assert.equal(sessionCallIssuer(manager, "native").id, "assistant");
  assert.equal(planUnknownRecovery({ sessionManager: manager, mode: "native", timestamp: 1 })[0].toolCallId, "native");
  manager.branch("call"); assert.equal(project(manager).messages.length, 1);
  manager.branch(null); assert.deepEqual(project(manager).outstanding, []);
  assert.deepEqual(sessionBranchHeaders(manager), []);
});

test("edited-prefix plus suffix reload invalidates native facts even with stable old identities", () => {
  const first = entry("same", null, assistant());
  const manager = fixture([first]); assert.equal(project(manager).outstanding.length, 1);
  const changed = entry("same", null, assistant([call("native", false)]));
  manager.reload([changed, entry("suffix", "same", user("new"))]);
  assert.deepEqual(project(manager).outstanding, []);
  manager.resetReads(); project(manager); assert.deepEqual(manager.reads.ranges, []);
});

test("revision-like default/custom managers retain stateless reference and rejection behavior", () => {
  const rows = [entry("user", null, user("initial"))];
  const manager = { getEntries: () => rows, getLeafId: () => "user", getRevision: () => { throw new Error("must not infer snapshots"); } };
  let input = sessionContextInput(manager, stock.buildSessionProjection, "ordinary");
  assert.equal(input.entries, rows); assert.equal(projectCanonicalContext(input).messages[0].content, "initial");
  rows[0].message.content = "mutated alias";
  assert.equal(projectCanonicalContext(sessionContextInput(manager, stock.buildSessionProjection, "ordinary")).messages[0].content, "mutated alias");
  Object.defineProperty(rows[0], "getter", { enumerable: true, get() { throw new Error("invoked getter"); } });
  assert.throws(() => projectCanonicalContext(input), { code: "ERR_CONTEXT_DATA_TYPE" });
});

test("header and cursor reads do not require a replayable native context", () => {
  const manager = fixture([entry("bad-call", null, assistant([{ type: "toolCall", id: "bad", name: "ipython", arguments: [] }]))]);
  assert.equal(sessionEntryHeaders(manager).length, 1);
  assert.throws(() => project(manager), { code: "ERR_CONTEXT_CALL" });
  assert.equal(sessionEntryHeaders(manager).length, 1);
});

test("namespace consumers preserve attempt-only history and known successful pending execution", () => {
  const checkpoint = { version: 1, sessionId: "synthetic", toolCallId: "cell", actorGeneration: 1, executionId: "execution" };
  for (const details of [
    { namespaceCheckpointAttempt: { ...checkpoint, opaque: "historical checkpoint body".repeat(1024) } },
    { executionId: "execution", ok: true, namespaceCheckpointState: "pending", namespaceCheckpointAttempt: checkpoint },
  ]) {
    const rows = [entry("result", null, { role: "toolResult", toolName: "ipython", toolCallId: "cell", isError: false,
      content: [{ type: "text", text: "cold result payload".repeat(1024) }], details, timestamp: 1 })];
    for (const manager of [fixture(rows), { getBranch: () => structuredClone(rows), getEntry: id => structuredClone(rows.find(row => row.id === id)) }]) {
      const compact = sessionNamespaceHistory(manager);
      assert.equal(extensionInternals.hasNativeNamespaceHistory(compact), extensionInternals.hasNativeNamespaceHistory(rows));
      assert.deepEqual(extensionInternals.projectNamespaceRecovery(compact, { found: false }),
        extensionInternals.projectNamespaceRecovery(rows, { found: false }));
      assert(!JSON.stringify(compact).includes("cold result payload"));
      if (!details.namespaceCheckpointState) assert(!JSON.stringify(compact).includes("historical checkpoint body"));
    }
  }
});

test("native namespace diagnostics use metadata and the original latest checkpoint without cold result bodies", () => {
  const checkpoint = { version: 1, sessionId: "s", toolCallId: "native", actorGeneration: 1, executionId: "e" };
  const rows = [entry("old-result", null, { role: "toolResult", toolCallId: "old", toolName: "ipython",
    content: [{ type: "text", text: "older checkpoint body" }], isError: true, timestamp: 0,
    details: { namespaceCheckpoint: { ...checkpoint, executionId: "old" }, executionId: "old", ok: false } }),
    entry("call", "old-result", assistant()), entry("result", "call", { role: "toolResult", toolCallId: "native", toolName: "ipython",
    content: [{ type: "text", text: "cold result body".repeat(2048) }], isError: false, timestamp: 1,
    details: { namespaceCheckpoint: checkpoint, ok: true } })];
  const manager = fixture(rows), expected = extensionInternals.projectNamespaceRecovery(rows, { found: true, namespaceCheckpoint: checkpoint });
  project(manager); manager.resetReads();
  const source = sessionNamespaceHistory(manager);
  assert.equal(extensionInternals.hasNativeNamespaceHistory(source), true);
  assert.deepEqual(extensionInternals.projectNamespaceRecovery(source, { found: true, namespaceCheckpoint: checkpoint }), expected);
  assert(!JSON.stringify(source).includes("cold result body"));
  assert.deepEqual(manager.reads.ids, ["result"]);
});

test("real bounded SDK exposes duplicate tail positions to the canonical rejection guard", async t => {
  if (typeof candidate.SessionManager.prototype.enableBoundedEntryRetention !== "function") return t.skip("stock compatibility run; bounded SDK integration requires PI_HARNESS_RETENTION_SDK_MODULE");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-duplicate-retention-"));
  try {
    const file = path.join(directory, "synthetic.jsonl");
    const header = { type: "session", version: 3, id: "synthetic", timestamp: "2026-01-01T00:00:00Z", cwd: directory };
    const rows = [entry("a", null, user("first")), entry("b", "a", user("second")), entry("a", null, user("replacement"))];
    writeFileSync(file, [header, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n");
    const manager = candidate.SessionManager.open(file, directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    assert.equal(manager.getEntryCount(), rows.length);
    assert.deepEqual(manager.getEntriesRange(0, manager.getEntryCount()), rows);
    assert.deepEqual(manager.getEntry("a"), rows[2]);
    assert.throws(() => projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
      buildSessionProjection: stock.buildSessionProjection, mode: "native" }), { code: "ERR_CONTEXT_DUPLICATE_ENTRY_ID" });
    const defaultManager = candidate.SessionManager.open(file, directory, directory);
    const defaultWorker = new SDKWorker({ session: { sessionManager: defaultManager, subscribe: () => () => {} } });
    assert.deepEqual(await defaultWorker.handle({ type: "get_entries", since: "a" }), { entries: rows.slice(1), leafId: "a" });
    assert.deepEqual(await defaultWorker.handle({ type: "get_entries", since: "b" }), { entries: rows.slice(2), leafId: "a" });
    registerCanonicalSessionManager(manager);
    assert.throws(() => project(manager), { code: "ERR_CONTEXT_DUPLICATE_ENTRY_ID" });
    const worker = new SDKWorker({ session: { sessionManager: manager, subscribe: () => () => {} } });
    assert.deepEqual(await worker.handle({ type: "get_entries", since: "a" }), { entries: rows.slice(1), leafId: "a" });
    assert.deepEqual(await worker.handle({ type: "get_entries", since: "b" }), { entries: rows.slice(2), leafId: "a" });
    await assert.rejects(worker.handle({ type: "get_entries", since: "missing" }), /Unknown session entry cursor/);
    assert.throws(() => project(manager), { code: "ERR_CONTEXT_DUPLICATE_ENTRY_ID" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real bounded SDK preserves revisioned projection, append cursors, reloads and failure recovery", t => {
  if (typeof candidate.SessionManager.prototype.enableBoundedEntryRetention !== "function") return t.skip("stock compatibility run; bounded SDK integration requires PI_HARNESS_RETENTION_SDK_MODULE");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-retention-"));
  try {
    const manager = candidate.SessionManager.create(directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    manager.appendMessage(assistant());
    manager.appendMessage(user("cold".repeat(4096)));
    const kept = manager.appendMessage(user("kept")); manager.appendCompaction("summary", kept, 1);
    registerCanonicalSessionManager(manager);
    const file = manager.getSessionFile(), before = readFileSync(file, "utf8");
    assert.equal(project(manager).outstanding.length, 1);
    assert.equal(readFileSync(file, "utf8"), before);
    let scan = extensionInternals.appendedSessionEntries(manager);
    manager.appendMessage(user("suffix"));
    const appended = extensionInternals.appendedSessionEntries(manager, scan.cursor);
    assert.equal([...appended.entries].length, 1);
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    rows[1].message.content[0].async = false;
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    manager.setSessionFile(file);
    assert.deepEqual(project(manager).outstanding, []);
    assert.equal([...extensionInternals.appendedSessionEntries(manager, appended.cursor).entries].length, manager.getEntryCount());
    assert.deepEqual(manager.getEntries().map(row => row.id), sessionEntryHeaders(manager).map(row => row.id));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("real SDK omission/nonproducer selection avoids warm cold hydration and binds complete active edit order", async t => {
  if (typeof candidate.SessionManager.prototype.enableBoundedEntryRetention !== "function") return t.skip("stock compatibility run; bounded SDK integration requires PI_HARNESS_RETENTION_SDK_MODULE");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-omission-retention-"));
  try {
    const manager = candidate.SessionManager.create(directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    const omitted = manager.appendMessage(user("old body".repeat(16384)));
    manager.appendCustomEntry("nonproducing", { value: "cold metadata".repeat(16384) });
    manager.appendContextEdit(omitted, { content: "superseded edit".repeat(16384) });
    manager.appendContextEdit(omitted, null);
    const active = manager.appendMessage(user("active"));
    registerCanonicalSessionManager(manager, { estimateContextTokens: core.estimateContextTokens });
    const expected = projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
      buildSessionProjection: stock.buildSessionProjection, mode: "ordinary" });
    assert.deepEqual(projectCanonicalContext({ sessionManager: manager, mode: "ordinary" }), expected);
    const read = manager._readStored, reads = [];
    manager._readStored = function(stored) { reads.push(stored.id); return read.call(this, stored); };
    assert.deepEqual(projectCanonicalContext({ sessionManager: manager, mode: "ordinary" }), expected);
    assert.deepEqual(reads, [active]);
    reads.length = 0;
    const lazy = projectCanonicalSource({ sessionManager: manager, mode: "ordinary" });
    assert.deepEqual(reads, []);
    assert.equal(lazy.source.length, 1);
    assert.deepEqual(lazy.source.readAll(), expected.messages);
    assert.deepEqual(reads, [active]);
    reads.length = 0;
    assert.deepEqual(lazy.source.estimateContextTokens(), core.estimateContextTokens(expected.messages));
    assert.deepEqual(reads, [], "usage metadata does not hydrate an unchanged raw prefix");
    const session = { sessionManager: manager, agent: new core.Agent({ streamFn() { throw new Error("must not infer"); } }) };
    refreshCanonicalSessionContext(session, stock.buildSessionProjection);
    assert.deepEqual(reads, [], "canonical public-state refresh must not hydrate active or cold messages");
    const owned = session.agent.state.messages;
    assert.deepEqual(owned, expected.messages);
    owned.push(user("explicit mutable public value"));
    assert.equal(session.agent.state.messages, owned);
    manager.setSessionFile(manager.getSessionFile());
    refreshCanonicalSessionContext(session, stock.buildSessionProjection);
    assert(session.agent.getMessageSource());
    assert.deepEqual(session.agent.state.messages, expected.messages);
    assert.equal(owned.at(-1).content, "explicit mutable public value", "refresh/reload cannot revoke an already exposed array");
    const build = manager.buildSessionSource.bind(manager);
    manager.buildSessionSource = () => { const value = build(); return { ...value, contextEntryIds: [...value.contextEntryIds].reverse() }; };
    assert.throws(() => projectCanonicalContext({ sessionManager: manager, mode: "ordinary" }), { code: "ERR_CONTEXT_SOURCE_PROJECTION" });
    manager.buildSessionSource = build;
    manager.appendContextEdit(omitted, { content: "small replacement" });
    assert.deepEqual(projectCanonicalContext({ sessionManager: manager, mode: "ordinary" }),
      projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(),
        buildSessionProjection: stock.buildSessionProjection, mode: "ordinary" }));

    for (const stopReason of ["stop", "error"]) {
      const message = assistant([{ type: "text", text: "provider usage" }]);
      message.stopReason = stopReason;
      message.usage = { ...message.usage, input: 123, output: 4, totalTokens: 127 };
      manager.appendMessage(message); manager.appendMessage(user("trailing suffix"));
      const full = projectCanonicalContext({ sessionManager: manager, mode: "ordinary" });
      const value = projectCanonicalSource({ sessionManager: manager, mode: "ordinary" }).source;
      assert.deepEqual(value.estimateContextTokens(), core.estimateContextTokens(full.messages));
      reads.length = 0;
      assert.deepEqual(projectCanonicalSource({ sessionManager: manager, mode: "ordinary" }).source.estimateContextTokens(),
        core.estimateContextTokens(full.messages));
      assert.deepEqual(reads, []);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
