import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HarnessStore } from "../src/store.mjs";
import { HarnessSupervisor } from "./fixtures/isolated-supervisor.mjs";
import { HarnessClient } from "../src/client.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";

function seed(databasePath) {
  const db = new DatabaseSync(databasePath);
  // Retained missing/cyclic/cross-family edges must not change roster semantics.
  db.exec("PRAGMA foreign_keys = OFF");
  const insert = db.prepare(`INSERT INTO sessions
    (id, short_id, cwd, repository_root, display_name, kind, family_id, parent_session_id,
     depth, activity, lifecycle, actor_token, actor_generation, launch_json, actor_identity_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, 1)`);
  const launch = JSON.stringify({ capabilities: [{ id: "fixture", grant: "L".repeat(32768) }] });
  const identity = JSON.stringify({ fixture: "I".repeat(16384) });
  const add = (id, parent = null, { kind = "child", family = "f", activity = "idle", lifecycle = "passivated", cwd = "/fixture" } = {}) =>
    insert.run(id, id, cwd, id, kind, family, parent, parent ? 1 : 0, activity, lifecycle, `fixture-${id}`, launch, identity);
  add("root", null, { kind: "root" });
  add("other-root", null, { kind: "root", activity: "working", cwd: "/other" });
  add("child", "root", { activity: "delegating" });
  add("sibling", "root", { activity: "working" });
  add("grandchild", "child", { activity: "working" });
  add("leaf", "grandchild", { activity: "working" });
  add("deleted-bridge", "root", { lifecycle: "deleted" });
  add("below-deleted", "deleted-bridge", { activity: "working" });
  add("foreign", null, { kind: "root", family: "outside" });
  add("cross", "foreign");
  add("cycle-a", "cycle-b"); add("cycle-b", "cycle-a", { activity: "working" });
  add("orphan", "missing");
  return db;
}

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "roster-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("roster projects only consumed registry data while preserving reach, lineage, fresh counts and errors", async (t) => {
  const databasePath = path.join(await directory(t), "db");
  const store = new HarnessStore(databasePath); const db = seed(databasePath);
  t.after(() => { db.close(); store.close(); });
  const originalPrepare = DatabaseSync.prototype.prepare;
  const reads = [];
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => { const result = value.apply(target, args);
        if (key === "all" || key === "get") reads.push({ args, result });
        return result;
      };
    } });
  };
  let roster;
  try { roster = store.getRoster("root"); }
  finally { DatabaseSync.prototype.prepare = originalPrepare; }
  assert.deepEqual(roster.map(row => row.sessionId), ["root", "other-root", "sibling", "child"]);
  assert.deepEqual(roster[0], { sessionId: "root", shortId: "root", name: "root", kind: "root", depth: 0,
    lineage: "root", relationship: "self", activity: "idle", lifecycle: "passivated", cwd: "/fixture",
    repositoryRoot: null, workingDescendantCount: 3 });
  const selected = reads[0].result;
  assert.equal(selected.length, 12, "all live rows remain available for ancestry, including invisible families");
  assert(selected.every(row => !Object.hasOwn(row, "launch_json") && !Object.hasOwn(row, "actor_identity_json")
    && !Object.hasOwn(row, "actor_token") && !Object.hasOwn(row, "session_file")), "unused payload and control columns must not be materialized");
  assert.deepEqual(reads.slice(1).map(read => read.args), [["root", "root"], ["other-root", "other-root"], ["child", "child"], ["sibling", "sibling"]]);
  assert.deepEqual(reads.slice(1).map(read => read.result.count), [3, 0, 2, 0]);
  const child = store.getRoster("child");
  assert.deepEqual(Object.fromEntries(child.map(row => [row.sessionId, row.relationship])),
    { child: "self", grandchild: "child", sibling: "sibling", root: "parent" });
  assert.equal(store.getRoster("cross")[0].lineage, "foreign/cross", "global ancestry must survive a different family label");
  assert.equal(store.getRoster("cycle-a")[0].lineage, "cycle-b/cycle-a");
  assert.equal(store.getRoster("cycle-a")[0].workingDescendantCount, 1);
  assert.equal(store.getRoster("orphan")[0].lineage, "orphan");
  db.prepare("UPDATE sessions SET display_name='renamed', activity='idle' WHERE id='sibling'").run();
  assert.deepEqual(store.getRoster("root").map(row => row.name), ["root", "other-root", "child", "renamed"]);
  db.prepare("UPDATE sessions SET parent_session_id='root' WHERE id='grandchild'").run();
  assert(store.getRoster("root").some(row => row.sessionId === "grandchild" && row.lineage === "root/grandchild"));
  db.prepare("UPDATE sessions SET lifecycle='deleted' WHERE id='grandchild'").run();
  assert.equal(store.getRoster("root")[0].workingDescendantCount, 0, "deletion cuts descendants through that bridge");
  db.prepare("UPDATE sessions SET launch_json='{broken', actor_identity_json='{broken' WHERE id='child'").run();
  assert.equal(store.getRoster("child")[0].sessionId, "child", "unused malformed JSON is not parsed");
  db.prepare("UPDATE sessions SET lifecycle='deleted' WHERE id='root'").run();
  assert.equal(store.getRoster("child")[0].lineage, "child");
  for (const id of ["missing", "root"]) assert.throws(() => store.getRoster(id), /^Error: caller session does not exist$/);
});

test("authenticated roster RPC and real host consumer preserve fields, freshness and authority without workers", async (t) => {
  const dir = await directory(t); const clients = [];
  let starts = 0, provisions = 0, terminations = 0;
  const supervisor = new HarnessSupervisor({ socketPath: path.join(dir, "s"), pidPath: path.join(dir, "p"),
    databasePath: path.join(dir, "db"), skillsPath: path.join(dir, "skills"), runtimeDir: path.join(dir, "runtime"),
    backgroundJobsDirectory: path.join(dir, "bg"), actorInactivityMs: 0, titleGenerator: null,
    actorFactory() { starts++; throw new Error("unexpected worker start"); },
    runtimeProvisioner() { provisions++; throw new Error("unexpected provisioning"); },
    processTerminator() { terminations++; throw new Error("unexpected process termination"); },
    sessionHistoryIndex: { close() {} }, cronSchedulerFactory: () => ({ start() {}, async stop() {} }),
    backgroundCompletionIntervalMs: 3600000 });
  await supervisor.start(); const db = seed(supervisor.databasePath);
  t.after(async () => { for (const client of clients) client.stop(); db.close(); await supervisor.stop(); });
  const actor = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 }); clients.push(actor);
  await actor.start({ registrationType: "register_actor", sessionId: "child", sessionFile: path.join(dir, "child.jsonl"),
    cwd: "/fixture", repositoryRoot: null, actorToken: "fixture-child", actorGeneration: 1 });
  assert(actor.isConnected);
  const handlers = createHostHandlers({ cwd: "/fixture", getClient: () => actor });
  const wire = await actor.request("get_roster", {});
  assert.deepEqual(await handlers["agent_message.list_agents"](), wire);
  assert.deepEqual(wire.agents.map(row => row.sessionId), ["child", "grandchild", "sibling", "root"]);
  assert.equal(wire.agents[0].workingDescendantCount, 2);
  assert.doesNotMatch(JSON.stringify(wire), /fixture-child|launch_json|actor_token|actorIdentity|actorPid/);
  db.prepare("UPDATE sessions SET activity='idle', display_name='new name' WHERE id='grandchild'").run();
  const fresh = await handlers["agent_message.list_agents"]();
  assert.equal(fresh.agents[0].workingDescendantCount, 1);
  assert(fresh.agents.some(row => row.name === "new name" && row.lineage === "root/child/new name"));
  db.prepare("UPDATE sessions SET lifecycle='deleted' WHERE id='child'").run();
  await assert.rejects(handlers["agent_message.list_agents"](), /caller session does not exist/);
  const browser = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0 }); clients.push(browser);
  await browser.start({ registrationType: "register_client", clientInstanceId: "fixture" });
  await assert.rejects(browser.request("get_roster", {}), /not available to clients/);
  // An invalid packet closes its connection; make it the final actor request.
  await assert.rejects(actor.request("get_roster", { callerId: "foreign" }), /not supported/);
  assert.deepEqual({ starts, provisions, terminations }, { starts: 0, provisions: 0, terminations: 0 });
});
