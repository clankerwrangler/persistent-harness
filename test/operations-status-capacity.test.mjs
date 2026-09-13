import assert from "node:assert/strict";
import test from "node:test";
import { createHostHandlers } from "../src/host-handlers.mjs";

test("operations.status forwards supervisor child capacity", async () => {
  const handlers = createHostHandlers({
    cwd: "/workspace",
    getClient: () => ({
      isConnected: true,
      request: async (type) => {
        assert.equal(type, "get_status");
        return {
          daemon: { protocolVersion: 2, schemaVersion: 2, logPath: "/tmp/events.jsonl" },
          capacity: { resident: 3, starting: 1, queued: 2, maxResident: 8, maxConcurrentStarts: 4 },
          counts: { sessions: {} },
          usage: { entries: 0 },
          diagnostics: [],
          sessions: [],
        };
      },
    }),
  });
  const status = await handlers["operations.status"]();
  assert.deepEqual(status.capacity, {
    resident: 3,
    starting: 1,
    queued: 2,
    maxResident: 8,
    maxConcurrentStarts: 4,
  });
});
