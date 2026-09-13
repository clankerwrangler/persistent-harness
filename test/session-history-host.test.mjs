import assert from "node:assert/strict";
import test from "node:test";
import { createHostHandlers } from "../src/host-handlers.mjs";

test("session history host request stays actor-authenticated and forwards one bounded DTO", async () => {
  const requests = [];
  const handlers = createHostHandlers({ cwd: "/workspace", getClient: () => ({ isConnected: true,
    request: async (type, params) => { requests.push({ type, params }); return { results: [] }; } }) });
  const params = { operation: "search", query: "rollback", includeDeleted: true, includeCurrent: false,
    roles: ["user"], limit: 4, sort: "relevance", snippetChars: 300, kind: "any" };
  assert.deepEqual(await handlers["session_history.query"](params), { results: [] });
  assert.deepEqual(requests, [{ type: "session_history", params }]);
  assert.equal(Object.hasOwn(requests[0].params, "callerSessionId"), false);
  await assert.rejects(handlers["session_history.query"]({ ...params, callerSessionId: "forged" }), /unsupported/);

  const offline = createHostHandlers({ cwd: "/workspace", getClient: () => ({ isConnected: false }) });
  await assert.rejects(offline["session_history.query"]({ operation: "list" }), /offline/);
});
