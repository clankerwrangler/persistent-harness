import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ORDINARY_NON_ADMISSION_CUSTOM_TYPE, createOrdinaryNonAdmissionWitness, projectCanonicalContext, projectCanonicalSource, refreshCanonicalSessionContext, planUnknownRecovery, registerCanonicalSessionManager, sessionContextInput,
  sessionEntryHeaders, sessionEntriesMatching, sessionBranchHeaders, sessionCallIssuer, sessionNamespaceHistory } from "../src/canonical-context.mjs";
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
function fixture(rows, { entrySource = false } = {}) {
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
  if (entrySource) {
    reads.sources = [];
    manager.buildSessionEntrySource = () => {
      const captured = entries.slice(), sourceGeneration = generation;
      const validate = () => { if (sourceGeneration !== generation) throw new Error("source expired"); };
      return { revision: { revision, generation }, leafId: leaf, validate,
        entries: captured.map((row, i) => ({ id: row.id, type: row.type, parentId: row.parentId,
          role: row.message?.role, customType: row.customType, key: `${generation}:${i}:${row.id}` })),
        read: i => { validate(); reads.sources.push(captured[i].id); return structuredClone(captured[i]); } };
    };
  }
  registerCanonicalSessionManager(manager); return manager;
}
const project = manager => projectCanonicalContext({ sessionManager: manager, mode: "native" });

test("entry-source metadata keeps unrelated opaque values unread through headers, birth and recovery", () => {
  let deep = { marker: "unconsumed opaque value" };
  for (let i = 0; i < 100; i++) deep = { nested: deep };
  const rows = [entry("call", null, assistant()),
    { id: "clm", parentId: "call", type: "custom", customType: "live-context-state", data: deep },
    { id: "other", parentId: "clm", type: "custom", customType: "other-extension", data: { value: "complete" } },
    { id: "progress", parentId: "other", type: "custom", customType: "persistent-harness.progress-v1",
      data: { harnessBirth: { version: 1, sequence: 7, createdAt: "2026-01-01T00:00:00.000Z" } } },
    entry("active", "progress", user("active"))];
  const manager = fixture(rows, { entrySource: true });
  assert.equal(sessionEntryHeaders(manager).length, rows.length);
  assert.deepEqual(manager.reads.ranges, []);
  assert.deepEqual(manager.reads.sources, ["call", "progress", "active"]);
  assert.equal(Math.max(...sessionBranchHeaders(manager).map(header => header.birthSequence)), 7);
  assert.equal(planUnknownRecovery({ sessionManager: manager, mode: "native", timestamp: 1 })[0].toolCallId, "native");
  assert(!manager.reads.sources.some(id => ["clm", "other"].includes(id)));
  const owned = sessionEntriesMatching(manager, header => header.id === "other");
  assert.deepEqual(owned, [rows[2]]);
  owned[0].data.value = "independent mutable capture";
  assert.equal(sessionEntriesMatching(manager, header => header.id === "other")[0].data.value, "complete");
  assert.throws(() => sessionEntriesMatching(manager, header => header.id === "clm"), { code: "ERR_CONTEXT_DATA_LIMIT" });
  assert.equal(sessionBranchHeaders(manager).at(-1).id, "active", "failed explicit validation does not erase selected facts");
});

test("opaque metadata still enforces duplicate IDs, parent shape, branch integrity and source publication fences", () => {
  const opaque = { id: "opaque", parentId: null, type: "custom", customType: "live-context-state", data: { opaque: true } };
  const duplicate = fixture([opaque, { ...opaque }], { entrySource: true });
  assert.throws(() => sessionEntryHeaders(duplicate), { code: "ERR_CONTEXT_DUPLICATE_ENTRY_ID" });
  assert.deepEqual(duplicate.reads.sources, []);
  for (const [row, code] of [[{ ...opaque, parentId: {} }, "ERR_CONTEXT_ENTRY"],
    [{ ...opaque, parentId: "absent" }, "ERR_CONTEXT_BRANCH_MISSING"],
    [{ ...opaque, parentId: "opaque" }, "ERR_CONTEXT_BRANCH_CYCLE"]]) {
    assert.throws(() => sessionBranchHeaders(fixture([row], { entrySource: true })), { code });
  }
  const manager = fixture([opaque, entry("active", "opaque", user("active"))], { entrySource: true });
  const original = manager.buildSessionEntrySource;
  manager.buildSessionEntrySource = () => {
    const source = original();
    return { ...source, read(i) { const value = source.read(i); manager.reload([entry("replacement", null, user("new"))]); return value; } };
  };
  assert.throws(() => sessionBranchHeaders(manager), /source expired/);
  manager.buildSessionEntrySource = original;
  assert.equal(sessionBranchHeaders(manager).at(-1).id, "replacement", "failed ingestion cannot publish a partial prior generation");
  manager.append({ ...opaque, id: "suffix", parentId: "replacement" });
  assert.equal(sessionBranchHeaders(manager).at(-1).id, "suffix");
  assert(!manager.reads.sources.includes("suffix"), "opaque suffix stays metadata-only");
  manager.branch("replacement"); assert.equal(sessionBranchHeaders(manager).at(-1).id, "replacement");
});






test("entry-source header consumers retain input, usage, family and child receipt selectors", () => {
  const custom = (id, customType, data) => ({ id, parentId: null, type: "custom", customType, data });
  const rows = [custom("usage", "persistent-harness-usage", { entryId: "assistant-entry" }),
    custom("family", "persistent-harness.agent-message-v1", { messageId: "family-message", direction: "to" }),
    custom("child", "persistent-harness.child-creation-v1", { childId: "child-session" }),
    { id: "input", parentId: null, type: "custom_message", customType: "persistent-harness-input", content: "input",
      details: { inputId: "input-receipt" } },
    { id: "incoming", parentId: null, type: "custom_message", customType: "persistent-harness-incoming-message", content: "message",
      details: { messageId: "incoming-message" } }];
  const manager = fixture(rows, { entrySource: true });
  const headers = new Map(sessionEntryHeaders(manager).map(header => [header.id, header]));
  assert.equal(headers.get("usage").entryId, "assistant-entry");
  assert.equal(headers.get("family").messageId, "family-message"); assert.equal(headers.get("family").direction, "to");
  assert.equal(headers.get("child").childId, "child-session");
  assert.equal(headers.get("input").inputId, "input-receipt");
  assert.equal(headers.get("incoming").messageId, "incoming-message");
  assert.deepEqual(manager.reads.sources, rows.map(row => row.id));
});

test("inactive selected-only custom proofs stay unread until their branch is validated", () => {
  const rows = [entry("active", null, user("valid")),
    { id: "bad-signature", parentId: "active", type: "custom", customType: "persistent-harness:assistant-thinking-signature:v1",
      data: { version: 2, opaque: "inactive amendment" } }];
  const manager = fixture(rows, { entrySource: true }); manager.branch("active");
  assert.equal(sessionBranchHeaders(manager).at(-1).id, "active");
  assert(!manager.reads.sources.includes("bad-signature"));
  manager.branch("bad-signature");
  assert.throws(() => sessionBranchHeaders(manager), { code: "ERR_SIGNATURE_VERSION" });
  assert(manager.reads.sources.includes("bad-signature"));
  manager.branch("active"); assert.equal(sessionBranchHeaders(manager).at(-1).id, "active");
});



test("raw cursor history remains readable when SDK entry-source branch validation rejects a cycle", async t => {
  if (typeof candidate.SessionManager.prototype.buildSessionEntrySource !== "function") return t.skip("requires public entry-source SDK");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-cycle-cursor-"));
  try {
    const file = path.join(directory, "synthetic.jsonl");
    const rows = [{ id: "a", parentId: "b", type: "custom", customType: "unrelated", data: { value: "a" } },
      { id: "b", parentId: "a", type: "custom", customType: "unrelated", data: { value: "b" } }];
    writeFileSync(file, [{ type: "session", version: 3, id: "synthetic", cwd: directory }, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n");
    const manager = candidate.SessionManager.open(file, directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    registerCanonicalSessionManager(manager);
    assert.throws(() => sessionBranchHeaders(manager), { code: "ERR_CONTEXT_HELPER_FAILED" });
    const worker = new SDKWorker({ session: { sessionManager: manager, subscribe: () => () => {} } });
    assert.deepEqual(await worker.handle({ type: "get_entries", since: "a" }), { entries: rows.slice(1), leafId: "b" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real SDK opaque bodies remain complete on explicit reads and retain committed digest fences", t => {
  if (typeof candidate.SessionManager.prototype.buildSessionEntrySource !== "function") return t.skip("requires public entry-source SDK");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-opaque-source-"));
  try {
    const manager = candidate.SessionManager.create(directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    manager.appendMessage(assistant([]));
    const opaque = manager.appendCustomEntry("other-extension", { marker: "OPAQUE_ONE", payload: "old body".repeat(32768) });
    const active = manager.appendMessage(user("active"));
    const file = manager.getSessionFile(); manager.setSessionFile(file);
    registerCanonicalSessionManager(manager);
    const readIds = [], build = manager.buildSessionEntrySource.bind(manager);
    manager.buildSessionEntrySource = () => {
      const source = build(); return { ...source, read(i) { readIds.push(source.entries[i].id); return source.read(i); } };
    };
    sessionBranchHeaders(manager); assert(!readIds.includes(opaque));
    const borrowed = manager.buildSessionEntrySource(), position = borrowed.entries.findIndex(row => row.id === opaque);
    const tail = manager.appendMessage(user("appended after source capture"));
    manager.branch(active);
    assert.equal(borrowed.read(position).data.marker, "OPAQUE_ONE", "borrowed original-value source survives append and leaf movement");
    manager.branch(tail);
    const captured = sessionEntriesMatching(manager, header => header.id === opaque)[0];
    assert.equal(captured.data.marker, "OPAQUE_ONE"); assert(readIds.includes(opaque));
    captured.data.marker = "private captured mutation";
    assert.equal(manager.getEntry(opaque).data.marker, "OPAQUE_ONE");
    const raw = readFileSync(file, "utf8");
    writeFileSync(file, raw.replace("OPAQUE_ONE", "OPAQUE_TWO"));
    assert.throws(() => sessionEntriesMatching(manager, header => header.id === opaque), /changed outside the append-only session manager/);
    manager.setSessionFile(file);
    assert.equal(sessionBranchHeaders(manager).at(-1).id, tail);
    assert.throws(() => borrowed.read(position), /source expired/);
    assert.equal(sessionEntriesMatching(manager, header => header.id === opaque)[0].data.marker, "OPAQUE_TWO");
    assert.equal(captured.data.marker, "private captured mutation", "generation changes do not revoke full-value captures");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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

test("owned non-admission compact facts survive real SDK append/branch/edit/reload without cold hydration", t => {
  if (typeof candidate.SessionManager.prototype.enableBoundedEntryRetention !== "function") return t.skip("requires the bounded SDK seam");
  const directory = mkdtempSync(path.join(os.tmpdir(), "canonical-owned-retention-"));
  try {
    const manager = candidate.SessionManager.create(directory, directory, { entryRetention: { maxCachedBytes: 1024 } });
    const cold = manager.appendMessage(user("cold private body".repeat(8192)));
    const call = { type: "toolCall", id: "call_owned|fc_owned", name: "ipython", arguments: { code: "synthetic" } };
    const failed = manager.appendMessage({ ...assistant([{ type: "text", text: "partial" }, call]), stopReason: "error", errorMessage: "unclassified" });
    const witness = manager.appendCustomEntry(ORDINARY_NON_ADMISSION_CUSTOM_TYPE,
      createOrdinaryNonAdmissionWitness(manager.getEntry(failed), { requestId: "owned-request", attemptId: "owned-attempt" }));
    manager.appendCompaction("summary", failed, 1);
    registerCanonicalSessionManager(manager, { estimateContextTokens: core.estimateContextTokens });
    const full = () => projectCanonicalContext({ entries: manager.getEntries(), leafId: manager.getLeafId(), mode: "ordinary", buildSessionProjection: stock.buildSessionProjection });
    const view = () => projectCanonicalContext({ sessionManager: manager, mode: "ordinary" });
    const file = manager.getSessionFile(), prefix = readFileSync(file);
    assert.deepEqual(view(), full());
    assert.deepEqual(view().diagnostics.map(d => d.code), ["UNADMITTED_CALL_OMITTED"]);
    const read = manager._readStored, reads = [];
    manager._readStored = function(stored) { reads.push(stored.id); return read.call(this, stored); };
    let source = projectCanonicalSource({ sessionManager: manager, mode: "ordinary" }).source;
    source.estimateContextTokens(); reads.length = 0;
    source = projectCanonicalSource({ sessionManager: manager, mode: "ordinary" }).source;
    source.estimateContextTokens();
    assert.deepEqual(reads, [], "warm policy and token reads retain no cold message or proof body");
    source.readAll(); assert(!reads.includes(cold)); assert(!reads.includes(witness));
    reads.length = 0;
    manager.appendMessage(user("suffix")); view(); assert(!reads.includes(cold)); assert(!reads.includes(witness));
    assert(!JSON.stringify(sessionEntryHeaders(manager)).includes("cold private body"));
    manager.branch(failed);
    assert(view().diagnostics.some(d => d.code === "ORDINARY_ASSISTANT_NOT_REPLAYABLE"), "witness on another branch is not proof");
    manager.branch(witness);
    manager.appendContextEdit(failed, { content: [{ type: "text", text: "edited text" }, call] });
    assert.deepEqual(view(), full()); assert(!view().diagnostics.some(d => d.severity === "blocking"));
    manager.setSessionFile(file); assert.deepEqual(view(), full());
    assert.deepEqual(readFileSync(file).subarray(0, prefix.length), prefix);
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
    rows.find(e => e.id === failed).message.content[1].arguments.code = "changed synthetic call";
    // Remove the edit in this synthetic rewritten generation so the stale call
    // is checked as raw history, not rejected earlier as a forged content edit.
    const changed = rows.filter(e => e.type !== "context_edit");
    writeFileSync(file, changed.map(row => JSON.stringify(row)).join("\n") + "\n");
    manager.setSessionFile(file);
    assert.deepEqual(view(), full());
    assert(view().diagnostics.some(d => d.code === "ORDINARY_ASSISTANT_NOT_REPLAYABLE"), "old fingerprint cannot survive a changed source generation");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("cold ingestion folds compact facts once without retaining source payloads", () => {
  const rows = [entry("call", null, assistant([{ ...call("native"), arguments: { code: "cold-argument-marker" } }])),
    entry("result", "call", { role: "toolResult", toolCallId: "native", toolName: "ipython", isError: false,
      content: [{ type: "text", text: "cold-result-marker" }], timestamp: 1 }),
    { id: "metadata", parentId: "result", type: "custom", customType: "live-context-state",
      data: { projectedMessages: [{ content: "cold-checkpoint-marker".repeat(16384) }] } },
    { id: "progress", parentId: "metadata", type: "custom", customType: "persistent-harness.progress-v1",
      data: { harnessBirth: { version: 1, sequence: 3, createdAt: "2026-01-01T00:00:00.000Z" } } },
    entry("active", "progress", user("active")),
    { id: "sibling", parentId: null, type: "custom", customType: "persistent-harness.progress-v1",
      data: { harnessBirth: { version: 1, sequence: 99, createdAt: "2026-01-01T00:00:00.000Z" } } }];
  const manager = fixture(rows); manager.branch("active");
  registerCanonicalSessionManager(manager, { estimateContextTokens: core.estimateContextTokens });
  const headers = sessionBranchHeaders(manager);
  assert.deepEqual(manager.reads.ranges, rows.map((_, i) => [i, 1]));
  assert.deepEqual(manager.reads.ids, [], "eager selected validation must reuse the first committed read");
  assert.equal(Math.max(...headers.map(header => header.birthSequence)), 3, "birth recovery is branch-local");
  const retained = JSON.stringify(sessionEntryHeaders(manager), (_, value) =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
  for (const marker of ["cold-argument-marker", "cold-result-marker", "cold-checkpoint-marker"]) assert(!retained.includes(marker));
  manager.resetReads(); sessionBranchHeaders(manager);
  assert.deepEqual(manager.reads, { ranges: [], ids: [] });
  manager.append(entry("suffix", "active", user("suffix"))); sessionEntryHeaders(manager); manager.resetReads();
  assert.equal(sessionBranchHeaders(manager).at(-1).id, "suffix");
  assert.deepEqual(manager.reads, { ranges: [], ids: [] }, "header-first suffix ingestion must not trigger another payload pass");
});

test("compact selected folding follows ancestry, defers inactive rejection, and recovers after failure", () => {
  const result = entry("result", "call", { role: "toolResult", toolCallId: "ordered", toolName: "ipython",
    isError: false, content: [], timestamp: 1 });
  const parent = entry("call", null, assistant([call("ordered")]));
  for (const [name, message, code] of [
    ["invalid result", { ...result.message, isError: "false" }, "ERR_CONTEXT_RESULT"],
    ["invalid role", { role: "", content: [] }, "ERR_CONTEXT_MESSAGE"],
    ["invalid call", assistant([{ ...call("bad"), arguments: [] }]), "ERR_CONTEXT_CALL"],
    ["duplicate call", assistant([call("same"), call("same")]), "ERR_CONTEXT_DUPLICATE_CALL_ID"],
  ]) {
    const rows = [result, parent, entry("inactive", null, message)];
    const manager = fixture(rows); manager.branch("result");
    assert.deepEqual(sessionBranchHeaders(manager).map(header => header.id), ["call", "result"], name);
    assert.deepEqual(manager.reads.ids, [], name);
    assert.deepEqual(project(manager), projectCanonicalContext({ entries: rows, leafId: "result", mode: "native", buildSessionProjection: stock.buildSessionProjection }));
    manager.branch("inactive"); assert.throws(() => sessionBranchHeaders(manager), { code }, name);
    manager.branch("result"); assert.equal(sessionBranchHeaders(manager).at(-1).id, "result", "failed folds publish no stale selected state");
  }
  const profiled = fixture([entry("profile-bad", null, user("profile payload")), entry("profile-good", null, user("good"))]);
  registerCanonicalSessionManager(profiled, { estimateContextTokens: messages => {
    if (messages[0].content === "profile payload") throw new Error("private estimator failure");
    return core.estimateContextTokens(messages);
  } });
  assert.equal(sessionBranchHeaders(profiled).at(-1).id, "profile-good");
  assert.deepEqual(profiled.reads.ids, []);
  assert(!JSON.stringify(sessionEntryHeaders(profiled)).includes("private estimator failure"));
  profiled.branch("profile-bad");
  assert.throws(() => sessionBranchHeaders(profiled), /private estimator failure/);
  assert.deepEqual(profiled.reads.ids, ["profile-bad"], "only an exceptional selected estimator may reread its source");
  const reversed = [result, { ...parent, parentId: "result" }];
  assert.throws(() => sessionBranchHeaders(fixture(reversed)), { code: "ERR_CONTEXT_BRANCH_CYCLE" });
  assert.throws(() => sessionBranchHeaders(fixture([{ ...parent, parentId: "missing" }])), { code: "ERR_CONTEXT_BRANCH_MISSING" });
});

test("single-ingest aliases preserve explicit provider fields, orphan results, and all transport observation vetoes", () => {
  const failedCall = call("owned|multi|call", false);
  const failed = entry("failed", null, { ...assistant([failedCall]), stopReason: "error", errorMessage: "terminated" });
  const witness = { type: "custom", id: "witness", parentId: "failed", customType: ORDINARY_NON_ADMISSION_CUSTOM_TYPE,
    data: createOrdinaryNonAdmissionWitness(failed, { requestId: "request", attemptId: "attempt" }) };
  assert(witness.data);
  const projectRows = rows => projectCanonicalContext({ entries: rows, leafId: rows.at(-1).id, mode: "ordinary", buildSessionProjection: stock.buildSessionProjection });
  const baseline = [failed, witness];
  assert(projectRows(baseline).diagnostics.some(item => item.code === "UNADMITTED_CALL_OMITTED"));
  const observations = report => entry("extra", "witness", { ...assistant([]), stopReason: "error", nativeTransport: report });
  const variants = [
    entry("extra", "witness", assistant([{ ...call("other|item", false), providerCallId: "owned" }])),
    entry("extra", "witness", { role: "toolResult", toolCallId: "owned", toolName: "ipython", isError: true, content: [], timestamp: 1 }),
    observations({ observedCalls: [{ callId: "owned", itemId: "other", complete: true, native: false }] }),
    observations({ observedCalls: [{ callId: "owned", itemId: "other" }] }),
    observations({ attempts: [{ observedCalls: [{ callId: "owned", itemId: "other", complete: false, native: true }] }] }),
    observations({ observedCalls: [{ callId: "owned", itemId: "one", complete: false, native: false }],
      attempts: [{ observedCalls: [{ callId: "owned", itemId: "two", complete: false, native: false }] }] }),
  ];
  for (const extra of variants) {
    const rows = [...baseline, extra], manager = fixture(rows);
    const actual = projectCanonicalContext({ sessionManager: manager, mode: "ordinary" });
    assert.deepEqual(actual, projectRows(rows));
    assert(!actual.diagnostics.some(item => item.code === "UNADMITTED_CALL_OMITTED" && item.toolCallId === failedCall.id));
  }
});
