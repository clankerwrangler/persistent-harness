import assert from "node:assert/strict";
import test from "node:test";
import { applyRetryBranch, parseRetryBranchTarget, retryBranchMessage } from "../src/session-actions.mjs";

test("retry commands identify the original input entry rather than a root or parent sentinel", () => {
  assert.deepEqual(parseRetryBranchTarget("input-1"), { entryId: "input-1" });
  assert.equal(retryBranchMessage("input-1"), "/persistent-harness-branch input-1");
  for (const target of [null, undefined, "", "bad id"]) {
    assert.throws(() => retryBranchMessage(target), /invalid retry input entry target/);
  }
});

function context(parentId, type = "message") {
  let leaf = "answer";
  const input = { id: "input", parentId, type, message: { role: "user" } };
  const entries = [...(parentId ? [{ id: parentId, parentId: null, type: "message", message: { role: "user" } }] : []),
    input, { id: "answer", parentId: input.id, type: "message", message: { role: "assistant" } }];
  const calls = [];
  return { entries, calls, sessionManager: { getBranch: () => entries, getLeafId: () => leaf,
    resetLeaf() { assert.fail("only canonical AgentSession navigation may mutate the leaf"); },
    branch() { assert.fail("only canonical AgentSession navigation may mutate the leaf"); } },
    async navigateTree(id, options) { calls.push({ id, options }); leaf = parentId; return { cancelled: false }; } };
}

for (const type of ["message", "custom_message"]) for (const parentId of [null, "prior-user"]) {
  test(`retry delegates ${type} at ${parentId ?? "root"} to canonical context navigation`, async () => {
    const ctx = context(parentId, type);
    assert.deepEqual(await applyRetryBranch(ctx, "input"), { entryId: "input", branchFromId: parentId });
    assert.deepEqual(ctx.calls, [{ id: "input", options: { summarize: false } }]);
  });
}

test("retry respects cancellation and rejects navigation that does not move to the intended boundary", async () => {
  const ctx = context(null);
  ctx.navigateTree = async () => ({ cancelled: true });
  await assert.rejects(applyRetryBranch(ctx, "input"), /cancelled/);
  assert.equal(ctx.sessionManager.getLeafId(), "answer");
  ctx.navigateTree = async () => ({ cancelled: false });
  await assert.rejects(applyRetryBranch(ctx, "input"), /did not reach the input parent/);
});

test("retry rejects missing, non-input, abandoned, and input-only targets before navigation", async () => {
  const ctx = context(null);
  for (const id of ["missing", "answer"]) await assert.rejects(applyRetryBranch(ctx, id), /active canonical input/);
  ctx.entries.pop();
  await assert.rejects(applyRetryBranch(ctx, "input"), /no assistant response/);
  assert.deepEqual(ctx.calls, []);
});
