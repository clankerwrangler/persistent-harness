import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixtures/notification-supervisor.mjs";

test("run reminders go only to a root session", async t => {
  const f = await fixture(t); const root = await f.actor(); const child = await f.actor(root.session.sessionId);
  const state = path.join(f.dir, "CURRENT.json");
  await writeFile(state, "x".repeat(30 * 1024));
  await writeFile(path.join(f.dir, "state", "working-state.json"), JSON.stringify({
    [root.session.sessionId]: { state }, [child.session.sessionId]: { state } }));
  const rootNotes = (await root.connection.request("run_reminders", {})).notes;
  assert.equal(rootNotes.length, 1); assert.match(rootNotes[0], /is 30 KB \(limit 20 KB\)/);
  assert.deepEqual((await child.connection.request("run_reminders", {})).notes, [], "children never receive reminders");
  await assert.rejects(f.client.request("run_reminders", {}), /not available to clients/);
});
