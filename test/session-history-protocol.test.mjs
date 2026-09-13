import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolError, PROTOCOL_VERSION, validateRequest } from "../src/protocol.mjs";

function request(params) {
  return validateRequest({ version: PROTOCOL_VERSION, id: "history-test", type: "session_history", params }).params;
}

function invalid(params, pattern) {
  assert.throws(() => request(params), (error) => error instanceof ProtocolError && pattern.test(error.message));
}

test("session history protocol is exact, bounded, and operation-specific", () => {
  assert.deepEqual(request({ operation: "list" }), {
    operation: "list", sessionId: null, kind: "any", includeDeleted: false, includeCurrent: false, limit: 20,
  });
  assert.deepEqual(request({ operation: "search", query: "auth refactor", roles: ["assistant"], limit: 3,
    sort: "newest", snippetChars: 240, kind: "root", includeDeleted: true, includeCurrent: true }), {
    operation: "search", query: "auth refactor", sessionId: null, kind: "root", includeDeleted: true,
    includeCurrent: true, roles: ["assistant"], limit: 3, sort: "newest", snippetChars: 240,
  });
  assert.deepEqual(request({ operation: "open", sessionId: "session", entryId: "entry", before: 0, after: 8,
    maxChars: 4096, includeDeleted: true }), {
    operation: "open", sessionId: "session", entryId: "entry", includeDeleted: true, includeCurrent: false,
    before: 0, after: 8, maxChars: 4096,
  });

  invalid({ operation: "search", query: "x", extra: true }, /extra is not supported/);
  invalid({ operation: "list", query: "x" }, /query is not supported/);
  invalid({ operation: "open", sessionId: "s", entryId: "e", roles: ["user"] }, /roles is not supported/);
  invalid({ operation: "search", query: "x", roles: [] }, /must contain unique/);
  invalid({ operation: "search", query: "x", roles: ["user", "user"] }, /must contain unique/);
  invalid({ operation: "search", query: "x", roles: ["tool"] }, /must contain unique/);
  invalid({ operation: "search", query: "x".repeat(513) }, /query/);
  invalid({ operation: "search", query: "é".repeat(300) }, /UTF-8/);
  invalid({ operation: "search", query: "alpha\u0000beta" }, /control characters/);
  invalid({ operation: "open", sessionId: "s", entryId: "e", before: 9 }, /before/);
  invalid({ operation: "list", includeDeleted: 1 }, /includeDeleted must be boolean/);
});
