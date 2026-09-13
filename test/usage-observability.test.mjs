import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";

test("operations usage succeeds through host RPC with bounded sanitized recent aggregates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-usage-observability-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0 });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });

  supervisor.store.createRoot({ sessionId: "usage-root", sessionFile: path.join(root, "private-transcript.jsonl"), cwd: root,
    repositoryRoot: null, name: "Usage root", actorToken: "private-actor-token", launch: {} }, Date.now() - 10_000);
  const usage = (entryId, model, input, output, costTotal) => ({ entryId, provider: "safe-provider", model,
    input, output, cacheRead: 0, cacheWrite: 0, reasoning: output, totalTokens: input + output, costTotal });
  supervisor.store.recordUsage("usage-root", usage("private-old-entry", "old-model", 100, 10, 5), Date.now() - 8 * 24 * 60 * 60_000);
  supervisor.store.recordUsage("usage-root", usage("private-recent-entry", "recent-model", 12, 3, 0.25), Date.now() - 1_000);

  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "usage-observer" });
  t.after(() => client.stop());
  const handlers = createHostHandlers({ cwd: root, getClient: () => client });
  const result = await handlers["operations.usage"]({ windowMinutes: 1 });

  assert.equal(result.window.minutes, 1);
  assert.equal(result.aggregate.entries, 1);
  assert.equal(result.aggregate.sessions, 1);
  assert.equal(result.aggregate.totalTokens, 15);
  assert.equal(result.aggregate.estimatedCost, 0.25);
  const unsaturated = { entries: false, sessions: false, inputTokens: false, outputTokens: false,
    cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false, totalTokens: false, estimatedCost: false };
  assert.deepEqual(result.aggregate.precision, { safeMaximum: Number.MAX_SAFE_INTEGER, saturated: unsaturated });
  assert.deepEqual(result.byModel[0].precision, { safeMaximum: Number.MAX_SAFE_INTEGER, saturated: unsaturated });
  assert.deepEqual(result.byModel.map(({ provider, model }) => ({ provider, model })),
    [{ provider: "safe-provider", model: "recent-model" }]);
  assert.equal(result.byModelTruncated, false);
  assert.doesNotMatch(JSON.stringify(result), /private-(?:old|recent)-entry|private-actor-token|private-transcript|sessionId|prompt|body/i);
  await assert.rejects(handlers["operations.usage"]({ windowMinutes: 1, sql: "SELECT * FROM usage_entries" }), /unsupported usage option/);
});

test("operations.status exposes supervisor child capacity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-status-capacity-"));
  const socketPath = path.join(root, "run", "supervisor.sock");
  const supervisor = new HarnessSupervisor({
    socketPath, databasePath: path.join(root, "state", "harness.sqlite"),
    pidPath: path.join(root, "run", "supervisor.pid"), actorInactivityMs: 0,
    maxResidentActors: 6, maxConcurrentStarts: 3,
  });
  await supervisor.start();
  t.after(async () => { await supervisor.stop(); await rm(root, { recursive: true, force: true }); });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "capacity-observer" });
  t.after(() => client.stop());
  const handlers = createHostHandlers({ cwd: root, getClient: () => client });
  const status = await handlers["operations.status"]();
  assert.deepEqual(status.capacity, {
    resident: 0, starting: 0, queued: 0, maxResident: 6, maxConcurrentStarts: 3,
  });
  assert.equal(Object.keys(status.capacity).sort().join(","),
    "maxConcurrentStarts,maxResident,queued,resident,starting");

  const incomplete = createHostHandlers({
    cwd: root,
    getClient: () => ({
      isConnected: true,
      async request(type) {
        if (type !== "get_status") throw new Error(`unexpected ${type}`);
        return { daemon: {}, counts: {}, usage: {}, diagnostics: [], sessions: [] };
      },
    }),
  });
  await assert.rejects(incomplete["operations.status"](), /status.capacity must be an object/);
});
