import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessClient, HarnessRequestError } from "../src/client.mjs";
import { SessionHistoryIndex } from "../src/session-history-index.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";

const launch = { model: null, thinking: { requested: null, resolved: null, source: "settings" }, capabilities: [] };

test("session history is actor-only, family-scoped, and never starts a transcript actor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-history-supervisor-"));
  const calls = [];
  const index = {
    async refresh(sessions) { calls.push({ type: "refresh", sessions }); return { indexed: [], unchanged: [], errors: [] }; },
    async search(options) { calls.push({ type: "search", options }); return { matches: [{ sessionId: "root-b", entryId: "entry-b",
      role: "assistant", createdAt: "2026-01-01T00:00:00.000Z", snippet: "bounded result", citation: { sessionId: "root-b", entryId: "entry-b" }, score: -1 }], truncated: false }; },
    async open(options) { calls.push({ type: "open", options }); return { sessionId: "root-b", entryId: "entry-b",
      messages: [{ entryId: "entry-b", role: "assistant", text: "bounded result", createdAt: "2026-01-01T00:00:00.000Z",
        citation: { sessionId: "root-b", entryId: "entry-b" } }], truncated: false,
      citation: { sessionId: "root-b", entryId: "entry-b" } }; },
    close() { calls.push({ type: "close" }); },
  };
  let actorStarts = 0;
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run", "supervisor.sock"),
    databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    sessionHistoryIndex: index, actorFactory: () => { actorStarts += 1; throw new Error("must not start"); }, actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  for (const [sessionId, token, now] of [["root-a", "token-a", 1], ["root-b", "token-b", 2]]) {
    supervisor.store.createRoot({ sessionId, sessionFile: path.join(root, `${sessionId}.jsonl`), cwd: root,
      repositoryRoot: null, name: sessionId, actorToken: token, launch }, now);
  }
  const actor = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await actor.start({ registrationType: "register_actor", sessionId: "root-a", sessionFile: path.join(root, "root-a.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "token-a", actorGeneration: 1 });
  t.after(() => actor.stop());

  const originalFast = supervisor.store.getSessionFastModePreference;
  let fastReads = 0;
  supervisor.store.getSessionFastModePreference = function (...args) { fastReads += 1; return originalFast.apply(this, args); };
  const listed = await actor.request("session_history", { operation: "list", kind: "any",
    includeDeleted: false, includeCurrent: false, limit: 20 });
  supervisor.store.getSessionFastModePreference = originalFast;
  assert.equal(fastReads, 0, "the public metadata path must omit unused Fast ancestry reads");
  assert.deepEqual(listed.results.map((session) => session.sessionId), ["root-b"]);
  const searched = await actor.request("session_history", { operation: "search", refresh: true, query: "bounded",
    kind: "any", includeDeleted: false, includeCurrent: false, roles: ["user", "assistant"], limit: 8,
    sort: "relevance", snippetChars: 320 });
  assert.equal(searched.results.length, 1); assert.equal(searched.results[0].session.name, "root-b");
  assert.equal(searched.results[0].score, undefined); assert.equal(searched.dataOnly, true);
  assert.match(searched.warning, /untrusted reference data/); assert.equal(actorStarts, 0);
  assert.deepEqual(calls.find((call) => call.type === "refresh").sessions.map((session) => session.sessionId), ["root-b"]);

  const opened = await actor.request("session_history", { operation: "open", refresh: true, sessionId: "root-b", entryId: "entry-b",
    includeDeleted: false, includeCurrent: false, before: 2, after: 2, maxChars: 8000 });
  assert.equal(opened.messages[0].citation.entryId, "entry-b"); assert.equal(actorStarts, 0);

  supervisor.store.createChild("root-a", {
    sessionId: "child-a", sessionFile: path.join(root, "child-a.jsonl"), actorToken: "token-c",
    policy: { ...launch, name: "child-a", prompt: "task", cwd: root, repositoryRoot: null, depth: 1 }, now: 25,
  });
  const child = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await child.start({ registrationType: "register_actor", sessionId: "child-a", sessionFile: path.join(root, "child-a.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "token-c", actorGeneration: 1 });
  t.after(() => child.stop());
  const childListed = await child.request("session_history", { operation: "list", kind: "any",
    includeDeleted: false, includeCurrent: false, limit: 20 });
  assert.ok(childListed.results.some((session) => session.sessionId === "root-b"),
    "a child must be able to list a sibling currently-working root in the same workspace family");
  const childOpened = await child.request("session_history", { operation: "open", refresh: true, sessionId: "root-b", entryId: "entry-b",
    includeDeleted: false, includeCurrent: false, before: 2, after: 2, maxChars: 8000 });
  assert.equal(childOpened.messages[0].citation.entryId, "entry-b");

  supervisor.store.deleteSession("root-b", 3);
  await assert.rejects(actor.request("session_history", { operation: "open", refresh: true, sessionId: "root-b", entryId: "entry-b",
    includeDeleted: false, includeCurrent: false, before: 2, after: 2, maxChars: 8000 }),
  (error) => error instanceof HarnessRequestError && error.code === "session_history_forbidden");
  const deleted = await actor.request("session_history", { operation: "list", sessionId: "root-b", kind: "any",
    includeDeleted: true, includeCurrent: false, limit: 20 });
  assert.equal(deleted.results[0].deleted, true); assert.equal(deleted.results[0].name, "root-b");

  const browser = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await browser.start({ registrationType: "register_client", clientInstanceId: "browser" }); t.after(() => browser.stop());
  await assert.rejects(browser.request("session_history", { operation: "list", kind: "any",
    includeDeleted: false, includeCurrent: false, limit: 20 }), /not available to clients/);
});


test("real actor history search finds and opens retained canonical JSONL without revival", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-history-real-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  let actorStarts = 0;
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorFactory: () => { actorStarts += 1; throw new Error("must not start"); },
    actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const fileA = path.join(root, "root-a.jsonl"); const fileB = path.join(root, "root-b.jsonl");
  const frames = [
    { type: "session", version: 3, id: "root-b", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    { type: "message", id: "entry-user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "The cobalt narwhal rollback decision is canonical." }] } },
    { type: "message", id: "entry-assistant", parentId: "entry-user", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Rollback completed without reviving another actor." }] } },
  ];
  await writeFile(fileA, `${JSON.stringify({ type: "session", version: 3, id: "root-a", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}
`);
  await writeFile(fileB, `${frames.map((frame) => JSON.stringify(frame)).join("\n")}
`);
  supervisor.store.createRoot({ sessionId: "root-a", sessionFile: fileA, cwd: root, repositoryRoot: null,
    name: "root-a", actorToken: "token-a", launch }, 1);
  supervisor.store.createRoot({ sessionId: "root-b", sessionFile: fileB, cwd: root, repositoryRoot: null,
    name: "Past rollback", actorToken: "token-b", launch }, 2);
  const actor = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await actor.start({ registrationType: "register_actor", sessionId: "root-a", sessionFile: fileA, cwd: root,
    repositoryRoot: null, actorToken: "token-a", actorGeneration: 1 }); t.after(() => actor.stop());

  const search = await actor.request("session_history", { operation: "search", refresh: true, query: '"cobalt narwhal"',
    kind: "any", includeDeleted: false, includeCurrent: false, roles: ["user", "assistant"], limit: 8,
    sort: "relevance", snippetChars: 320 });
  assert.equal(search.complete, true); assert.equal(search.results.length, 1);
  assert.deepEqual(search.results[0].citation, { sessionId: "root-b", entryId: "entry-user" });
  assert.equal(search.results[0].session.name, "Past rollback"); assert.equal(actorStarts, 0);
  const opened = await actor.request("session_history", { operation: "open", refresh: true, sessionId: "root-b", entryId: "entry-user",
    includeDeleted: false, includeCurrent: false, before: 0, after: 1, maxChars: 8000 });
  assert.deepEqual(opened.messages.map((message) => message.entryId), ["entry-user", "entry-assistant"]);
  assert.equal(actorStarts, 0);

  supervisor.store.deleteSession("root-b", 3);
  const hidden = await actor.request("session_history", { operation: "search", refresh: true, query: "narwhal", kind: "any",
    includeDeleted: false, includeCurrent: false, roles: ["user", "assistant"], limit: 8,
    sort: "relevance", snippetChars: 320 });
  assert.deepEqual(hidden.results, []);
  const retained = await actor.request("session_history", { operation: "search", refresh: true, query: "narwhal", kind: "any",
    includeDeleted: true, includeCurrent: false, roles: ["user", "assistant"], limit: 8,
    sort: "relevance", snippetChars: 320 });
  assert.equal(retained.results[0].session.deleted, true); assert.equal(retained.results[0].session.name, "Past rollback");
  assert.equal(actorStarts, 0);
});


test("a derived search-index startup failure degrades only session history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-history-degraded-"));
  const errors = [];
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run", "supervisor.sock"),
    databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    sessionHistoryIndexFactory: () => { throw new Error("injected derived failure"); },
    logger: { error: (message) => errors.push(message) }, actorInactivityMs: 0 });
  const started = await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  assert.equal(started.running, true);
  assert(started.diagnostics.some((item) => item.code === "session_history_unavailable"));
  assert.match(errors[0], /injected derived failure/);
  const client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "healthy" }); t.after(() => client.stop());
  assert.equal((await client.request("get_status")).running, true);
});


test("derived runtime and close failures are generic to agents and never mask core shutdown", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-session-history-runtime-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const errors = [];
  const sessionHistoryIndex = {
    async refresh() { throw new Error(`sqlite failure at ${path.join(root, "private-transcript.jsonl")}`); },
    close() { throw new Error("injected close failure"); },
  };
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "run", "supervisor.sock"),
    databasePath: path.join(root, "state", "harness.sqlite"), pidPath: path.join(root, "run", "supervisor.pid"),
    sessionHistoryIndex, logger: { error: (message) => errors.push(String(message)) }, actorInactivityMs: 0 });
  await supervisor.start();
  for (const [sessionId, token, now] of [["root-a", "token-a", 1], ["root-b", "token-b", 2]]) {
    supervisor.store.createRoot({ sessionId, sessionFile: path.join(root, `${sessionId}.jsonl`), cwd: root,
      repositoryRoot: null, name: sessionId, actorToken: token, launch }, now);
  }
  const actor = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 });
  await actor.start({ registrationType: "register_actor", sessionId: "root-a", sessionFile: path.join(root, "root-a.jsonl"),
    cwd: root, repositoryRoot: null, actorToken: "token-a", actorGeneration: 1 }); t.after(() => actor.stop());
  await assert.rejects(actor.request("session_history", { operation: "search", refresh: true, query: "anything", kind: "any",
    includeDeleted: false, includeCurrent: false, roles: ["user", "assistant"], limit: 8,
    sort: "relevance", snippetChars: 320 }), (error) => {
    assert(error instanceof HarnessRequestError); assert.equal(error.code, "session_history_unavailable");
    assert.equal(error.message.includes(root), false); return true;
  });
  assert(errors.some((message) => message.includes("private-transcript.jsonl")), "internal details belong only in server logs");
  await supervisor.stop();
  assert(errors.some((message) => message.includes("injected close failure")));
});


const historySearch = { operation: "search", refresh: true, sessionId: "target", query: "needle", kind: "any", includeDeleted: false,
  includeCurrent: false, roles: ["user", "assistant"], limit: 1, sort: "newest", snippetChars: 80 };
async function ownedHistoryFixture(t, index, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hist-owner-"));
  const supervisor = new HarnessSupervisor({ socketPath: path.join(root, "s.sock"), databasePath: path.join(root, "state", "h.sqlite"),
    pidPath: path.join(root, "s.pid"), sessionHistoryIndex: index, actorInactivityMs: 0, logger: { error() {} },
    actorFactory() { throw new Error("history must not start an actor"); }, ...options });
  await supervisor.start(); const clients = [];
  t.after(async () => { for (const client of clients) await client.stop(); await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  for (const id of ["caller-a", "caller-b", "target"]) supervisor.store.createRoot({ sessionId: id, sessionFile: path.join(root, `${id}.jsonl`),
    cwd: root, repositoryRoot: null, name: id, actorToken: `token-${id}`, launch }, 1);
  for (const id of ["caller-a", "caller-b"]) {
    const client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 }); clients.push(client);
    await client.start({ registrationType: "register_actor", sessionId: id, sessionFile: path.join(root, `${id}.jsonl`),
      cwd: root, repositoryRoot: null, actorToken: `token-${id}`, actorGeneration: 1 });
  }
  return { supervisor, clients };
}

test("history disconnect aborts and drains only its caller while queued callers and metadata remain usable", async (t) => {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers();
  let refreshes = 0, searches = 0, settled = false, active = 0;
  const index = {
    async refresh(sessions, { signal }) {
      assert.equal(active++, 0, "one owner spans refresh and hydration");
      const call = ++refreshes;
      try {
        if (call === 1) {
          entered.resolve(); signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          await release.promise; signal.throwIfAborted();
        }
        return { errors: [] };
      } finally { if (call === 1) { settled = true; active--; } }
    },
    async search({ signal }) { signal.throwIfAborted(); searches++; active--; return { matches: [], truncated: false }; },
    close() { assert.equal(active, 0); },
  };
  const { clients: [a, b] } = await ownedHistoryFixture(t, index);
  t.after(() => release.resolve());
  const first = a.request("session_history", historySearch).catch(error => error);
  await entered.promise;
  const second = b.request("session_history", historySearch);
  const start = performance.now();
  const listed = await b.request("session_history", { operation: "list", kind: "any", includeDeleted: false, includeCurrent: false, limit: 10 });
  assert.equal(listed.results.length, 2); assert(performance.now() - start < 1000, "metadata does not queue behind history I/O");
  await a.stop(); await aborted.promise; assert.equal(settled, false); assert.equal(refreshes, 1);
  release.resolve(); assert(await first instanceof Error);
  assert.equal((await second).complete, true); assert.equal(refreshes, 2); assert.equal(searches, 1); assert.equal(settled, true);
});

for (const cause of ["deadline", "stop"]) test(`history ${cause} cancels work and drains before index close`, async (t) => {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers();
  let settled = false, closed = false, searches = 0;
  const index = {
    async refresh(sessions, { signal }) {
      entered.resolve(); signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      try { await release.promise; signal.throwIfAborted(); return { errors: [] }; }
      finally { settled = true; }
    },
    async search() { searches++; return { matches: [], truncated: false }; },
    close() { assert.equal(settled, true); closed = true; },
  };
  const { supervisor, clients: [client] } = await ownedHistoryFixture(t, index, { sessionHistoryTimeoutMs: cause === "deadline" ? 40 : 25000 });
  t.after(() => release.resolve());
  const response = client.request("session_history", historySearch).catch(error => error);
  await entered.promise;
  const stop = cause === "stop" ? supervisor.stop() : null;
  await aborted.promise; assert.equal(closed, false); assert.equal(settled, false);
  release.resolve(); const result = await response;
  assert(result instanceof Error, "cancellation is never a complete or partial empty success");
  if (cause === "deadline") assert.equal(result.code, "session_history_unavailable");
  await (stop ?? supervisor.stop()); assert.equal(closed, true); assert.equal(searches, 0);
});


test("concurrent callers cannot mix a changed source with an earlier query's citations", async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let refreshes = 0;
  class HeldIndex extends SessionHistoryIndex {
    async refresh(sources, options) {
      const result = await super.refresh(sources, options);
      if (++refreshes === 1) { entered.resolve(); await release.promise; }
      return result;
    }
  }
  const { supervisor, clients: [a, b] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new HeldIndex(options) });
  t.after(() => release.resolve());
  const sessionFile = supervisor.store.getSession("target").sessionFile;
  const header = { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: path.dirname(sessionFile) };
  const entry = id => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "needle" } });
  await writeFile(sessionFile, [header, entry("old")].map(JSON.stringify).join("\n") + "\n");
  const old = a.request("session_history", historySearch).catch(error => error); await entered.promise;
  const next = b.request("session_history", historySearch);
  await writeFile(sessionFile, [header, entry("new")].map(JSON.stringify).join("\n") + "\n");
  release.resolve(); assert.equal((await old).code, "session_history_unavailable");
  const result = await next; assert.equal(result.complete, true); assert.deepEqual(result.results.map(row => row.citation), [{ sessionId: "target", entryId: "new" }]);
});


test("ordinary RPC queries an indexed snapshot without waiting for strict archive refresh", async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let hold = false;
  class HeldIndex extends SessionHistoryIndex {
    async refresh(sources, options) {
      if (hold) { entered.resolve(); await release.promise; options.signal?.throwIfAborted(); }
      return super.refresh(sources, options);
    }
  }
  const { supervisor, clients: [a, b] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new HeldIndex(options) });
  t.after(() => release.resolve());
  const sessionFile = supervisor.store.getSession("target").sessionFile;
  await writeFile(sessionFile, [
    { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "needle" } },
  ].map(JSON.stringify).join("\n") + "\n");
  assert.equal((await a.request("session_history", historySearch)).complete, true);
  hold = true;
  const strict = a.request("session_history", historySearch); await entered.promise;
  const snapshot = await b.request("session_history", { ...historySearch, refresh: false });
  assert.equal(snapshot.results[0].entryId, "old"); assert.equal(snapshot.complete, false);
  assert.equal(snapshot.freshness.mode, "indexed"); assert.equal(snapshot.freshness.current, false);
  const opened = await b.request("session_history", { operation: "open", sessionId: "target", entryId: "old" });
  assert.equal(opened.messages[0].text, "needle"); assert.equal(opened.freshness.branch, "indexed");
  release.resolve(); assert.equal((await strict).complete, true);
});


test("settlement maintenance coalesces without blocking snapshot queries or waking actors", async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let hold = false, refreshes = 0;
  class HeldIndex extends SessionHistoryIndex {
    async refresh(sources, options) {
      refreshes++;
      if (hold) { entered.resolve(); await release.promise; options.signal?.throwIfAborted(); }
      return super.refresh(sources, options);
    }
  }
  const { supervisor, clients: [a, b] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new HeldIndex(options) });
  t.after(() => release.resolve());
  const sessionFile = supervisor.store.getSession("caller-a").sessionFile;
  const frames = [
    { type: "session", version: 3, id: "caller-a", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "needle" } },
  ];
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  await b.request("session_history", { ...historySearch, sessionId: "caller-a" });
  frames.push({ type: "message", id: "new", parentId: "old", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "newneedle" } });
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  hold = true;
  supervisor.store.markActorStarted("caller-a", 1);
  await a.request("update_activity", { streaming: false }); await entered.promise;
  await a.request("update_activity", { streaming: false });
  const pending = await b.request("session_history", { ...historySearch, refresh: false, sessionId: "caller-a" });
  assert.equal(pending.results[0].entryId, "old"); assert.equal(pending.freshness.changedSources, 1);
  assert.equal(pending.freshness.maintenancePendingSources, 1);
  release.resolve();
  let found;
  for (let i = 0; i < 100; i++) {
    found = await b.request("session_history", { ...historySearch, refresh: false, sessionId: "caller-a", query: "newneedle" });
    if (!found.freshness.maintenancePendingSources) break;
    await sleep(5);
  }
  assert.equal(found.results[0].entryId, "new"); assert.equal(found.freshness.changedSources, 0);
  assert.equal(refreshes, 3, "one active and one coalesced trailing refresh follow the explicit seed");
});


test("shutdown cancels and drains maintenance and independent snapshot hydration before closing index", async (t) => {
  const maintenanceEntered = Promise.withResolvers(), snapshotEntered = Promise.withResolvers();
  const releaseMaintenance = Promise.withResolvers(), releaseSnapshot = Promise.withResolvers();
  let hold = false, maintenanceDone = false, snapshotDone = false, closed = false;
  class HeldIndex extends SessionHistoryIndex {
    async refresh(sources, options) {
      if (!hold) return super.refresh(sources, options);
      maintenanceEntered.resolve();
      try { await releaseMaintenance.promise; options.signal.throwIfAborted(); }
      finally { maintenanceDone = true; }
    }
    async search(options) {
      if (!hold || !options.snapshot) return super.search(options);
      snapshotEntered.resolve();
      try { await releaseSnapshot.promise; options.signal.throwIfAborted(); }
      finally { snapshotDone = true; }
    }
    close() { assert.ok(maintenanceDone && snapshotDone); closed = true; super.close(); }
  }
  const { supervisor, clients: [a, b] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new HeldIndex(options) });
  supervisor.store.markActorStarted("caller-a", 1);
  hold = true; await a.request("update_activity", { streaming: false }); await maintenanceEntered.promise;
  const response = b.request("session_history", { ...historySearch, refresh: false }).catch(error => error);
  await snapshotEntered.promise;
  const stop = supervisor.stop(); await sleep(5); assert.equal(closed, false);
  releaseMaintenance.resolve(); await sleep(5); assert.equal(closed, false);
  releaseSnapshot.resolve(); await stop;
  assert.equal(closed, true); assert(await response instanceof Error);
});


test("empty and inactive changed coverage schedules separate maintenance without actor activation", async (t) => {
  const { supervisor, clients: [client] } = await ownedHistoryFixture(t, null);
  const sessionFile = supervisor.store.getSession("target").sessionFile;
  const frames = [
    { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
    { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "needle" } },
  ];
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  const empty = await client.request("session_history", { ...historySearch, refresh: false });
  assert.equal(empty.results.length, 0); assert.equal(empty.freshness.missingSources, 1);
  assert.equal(empty.freshness.maintenancePendingSources, 1);
  async function indexed(query) {
    for (let i = 0; i < 100; i++) {
      const result = await client.request("session_history", { ...historySearch, refresh: false, query });
      if (result.results.length) return result;
      await sleep(5);
    }
    assert.fail("separate maintenance did not publish");
  }
  assert.equal((await indexed("needle")).results[0].entryId, "old");
  frames.push({ type: "message", id: "new", parentId: "old", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "externalword" } });
  await writeFile(sessionFile, frames.map(JSON.stringify).join("\n") + "\n");
  const changed = await client.request("session_history", { ...historySearch, refresh: false, query: "externalword" });
  assert.equal(changed.results.length, 0); assert.equal(changed.freshness.changedSources, 1);
  assert.equal((await indexed("externalword")).results[0].entryId, "new");
  assert.equal(supervisor.store.getSession("target").lifecycle, "starting", "indexing never starts a target actor");
});

test("maintenance result errors are secret-free diagnostics and do not hot-loop", async (t) => {
  let calls = 0;
  class FailedIndex extends SessionHistoryIndex {
    async refresh() { calls++; return { errors: [{ sessionId: "target", error: "private-path-and-payload" }] }; }
  }
  const { supervisor, clients: [client] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new FailedIndex(options) });
  const result = await client.request("session_history", { ...historySearch, refresh: false });
  assert.equal(result.freshness.missingSources, 1);
  let status;
  for (let i = 0; i < 100; i++) {
    status = supervisor.status();
    if (status.diagnostics.some(item => item.code === "session_history_maintenance_failed")) break;
    await sleep(5);
  }
  assert.ok(status.diagnostics.some(item => item.code === "session_history_maintenance_failed"));
  assert.equal(JSON.stringify(status.diagnostics).includes("private-path"), false);
  await sleep(20); assert.equal(calls, 1);
});


test("unsafe snapshot open queues selected-source recovery and tombstones remain authoritative", async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let hold = false;
  class HeldIndex extends SessionHistoryIndex {
    async search(options) {
      const result = await super.search(options);
      if (hold) { entered.resolve(); await release.promise; }
      return result;
    }
  }
  const { supervisor, clients: [a, b] } = await ownedHistoryFixture(t, null, { sessionHistoryIndexFactory: options => new HeldIndex(options) });
  t.after(() => release.resolve());
  const sessionFile = supervisor.store.getSession("target").sessionFile;
  const encoded = text => [
    { type: "session", version: 3, id: "target", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
    { type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } },
  ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(sessionFile, encoded("needle")); await a.request("session_history", historySearch);
  await writeFile(sessionFile, encoded("edited"));
  await assert.rejects(a.request("session_history", { operation: "open", sessionId: "target", entryId: "entry" }), /indexed citation cannot be read safely/);
  let found;
  for (let i = 0; i < 100; i++) {
    found = await a.request("session_history", { ...historySearch, refresh: false, query: "edited" });
    if (found.results.length) break;
    await sleep(5);
  }
  assert.equal(found.results[0].entryId, "entry");
  hold = true;
  const pending = b.request("session_history", { ...historySearch, refresh: false, query: "edited" }).catch(error => error);
  await entered.promise; supervisor.store.deleteSession("target"); release.resolve();
  assert.equal((await pending).code, "session_history_forbidden");
});
