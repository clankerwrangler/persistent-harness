import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  CANONICAL_CONTEXT_LIMITS, CanonicalContextError, THINKING_SIGNATURE_CUSTOM_TYPE,
  THINKING_SIGNATURE_VERSION, projectCanonicalContext, projectCanonicalBranch, planUnknownRecovery,
} from "../src/canonical-context.mjs";

const sdkEntry = process.env.PI_HARNESS_PI_MODULE;
assert(sdkEntry && path.isAbsolute(sdkEntry), "Set PI_HARNESS_PI_MODULE to the exact STOCK dist/index.js");
const { buildSessionContext, convertToLlm, SessionManager } = await import(pathToFileURL(sdkEntry));
const aiPackage = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdkEntry));
const { transformMessages } = await import(pathToFileURL(path.join(path.dirname(aiPackage), "dist/api/transform-messages.js")));
const model = { api: "openai-responses", provider: "fixture", id: "fixture", name: "fixture",
  reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const image = { type: "image", data: "c3ludGhldGlj", mimeType: "image/png", provenance: { source: "fixture" } };
const timestamp = "2026-09-08T12:00:00.000Z";
const call = (id, async = true) => ({ type: "toolCall", id, name: "python", arguments: { code: `${id}=1` },
  async, providerCallId: id, providerItemId: `item_${id}`, nativeProvenance: { responseId: `resp_${id}`, itemId: `item_${id}`, callId: id } });
const assistant = (id, content) => ({ role: "assistant", id, content, timestamp: 1, api: model.api,
  model: model.id, provider: model.provider, stopReason: "toolUse", usage: structuredClone(usage),
  provenance: { response: id } });
const result = (id) => ({ role: "toolResult", toolCallId: id, toolName: "python", timestamp: 2,
  content: [{ type: "text", text: `REAL_${id}` }, structuredClone(image)], isError: false,
  details: { checkpoint: `checkpoint_${id}`, nested: [1, { ok: true }] }, usage: structuredClone(usage) });
const user = (text = "user") => ({ role: "user", content: [{ type: "text", text }, structuredClone(image)], timestamp: 0 });
const messageEntry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message });
function chain(messages) {
  return messages.map((message, i) => messageEntry(`e${i}`, i ? `e${i - 1}` : null, message));
}
const input = (entries, mode = "native", leafId = entries.at(-1)?.id ?? null) => ({ entries, leafId, mode, buildSessionContext });
const project = (entries, mode, leafId) => projectCanonicalContext(input(entries, mode, leafId));
function rejects(entries, code, mode = "native", leafId) {
  assert.throws(() => project(entries, mode, leafId), error => error instanceof CanonicalContextError && error.code === code);
}
const synthetic = (messages) => transformMessages(convertToLlm(messages), model)
  .filter(message => message.role === "toolResult" && message.content[0]?.text === "No result provided");
function thinkingEntry(id = "target", parentId = null, signature = JSON.stringify({ type: "reasoning", id: "rs", summary: [] })) {
  return messageEntry(id, parentId, assistant(`message_${id}`, [
    { type: "thinking", thinking: "fixture reasoning", thinkingSignature: signature },
    call(`call_${id}`),
  ]));
}
function amendment(target, id = "metadata", parentId = target.id, changes = {}, legacy = false) {
  const data = { version: THINKING_SIGNATURE_VERSION, messageEntryId: target.id, messageId: target.message.id,
    contentIndex: 0, itemId: "rs", encryptedContent: "fixture-encryption", ...changes };
  return legacy ? { type: "assistant_thinking_signature", id, parentId, timestamp, ...data }
    : { type: "custom", id, parentId, timestamp, customType: THINKING_SIGNATURE_CUSTOM_TYPE, data };
}


test("raw summary and extension-defined message roles are preserved without being mistaken for generated entries", () => {
  const entries = chain([
    { role: "branchSummary", summary: "raw branch", fromId: "source", timestamp: 3, usage },
    { role: "compactionSummary", summary: "raw compact", tokensBefore: 10, timestamp: 4, details: { raw: true } },
    { role: "providerSpecific", content: [image], provenance: { opaque: true }, timestamp: 5 },
  ]);
  assert.deepEqual(project(entries).messages, entries.map(entry => entry.message));
  const compact = { type: "compaction", id: "compact", parentId: entries.at(-1).id, timestamp,
    summary: "latest", tokensBefore: 20, firstKeptEntryId: "e0", details: { generated: true } };
  const projection = project([...entries, compact]);
  assert.deepEqual(projection.messages.slice(1), entries.map(entry => entry.message));
  assert.deepEqual(projection.messages[0].details, { generated: true });
});


test("ordinary diagnostics follow public STOCK omission of display-only bash and unrecognized roles", () => {
  const display = { role: "bashExecution", command: "fixture", output: "display only", timestamp: 3,
    excludeFromContext: true, cancelled: false, truncated: false, exitCode: 0 };
  const unknown = { role: "providerSpecific", content: "opaque", timestamp: 4 };
  const entries = chain([assistant("a", [call("ordinary", false)]), display, unknown, result("ordinary")]);
  assert.deepEqual(convertToLlm(entries.map(e => e.message)), [entries[0].message, entries[3].message]);
  const projection = project(entries, "ordinary");
  assert.deepEqual(projection.messages, entries.map(e => e.message));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(synthetic(projection.messages).length, 0);
  entries[1].message.excludeFromContext = false;
  assert.equal(convertToLlm([entries[1].message])[0].role, "user");
  assert(project(entries, "ordinary").diagnostics.some(d => d.code === "ORDINARY_REPLAY_BLOCKED"));
});

test("ordinary failed-assistant compatibility gate preserves real calls/results without relabeling", () => {
  for (const stopReason of ["error", "aborted"]) {
    const failed = { ...assistant("a", [call("native"), call("ordinary", false)]), stopReason, errorMessage: "fixture failure" };
    const entries = chain([failed, result("native"), result("ordinary")]);
    const before = JSON.stringify(entries);
    assert.deepEqual(project(entries).messages, entries.map(e => e.message));
    const ordinary = project(entries, "ordinary");
    assert.deepEqual(ordinary.messages, entries.map(e => e.message));
    assert.deepEqual(ordinary.diagnostics, ["native", "ordinary"].map(toolCallId => ({
      code: "ORDINARY_ASSISTANT_NOT_REPLAYABLE", severity: "blocking", toolCallId, toolName: "python", stopReason,
    })));
    assert.equal(transformMessages(convertToLlm(ordinary.messages), model).some(m => m.role === "assistant"), false);
    assert.deepEqual(planUnknownRecovery({ ...input(entries), timestamp: 1 }), []);
    assert.equal(JSON.stringify(entries), before);
  }
  // An errored remainder after a separately committed native prefix is normal.
  const entries = chain([assistant("prefix", [call("native")]),
    { ...assistant("remainder", [{ type: "text", text: "partial" }]), stopReason: "error" }, result("native")]);
  assert.deepEqual(project(entries, "ordinary").diagnostics, []);
  assert.equal(synthetic(project(entries, "ordinary").messages).length, 0);
});

// No provider, model runtime, credentials, SDK inference, or tool executor is used.
test("ordinary replay moves each known native result once and preserves mixed ordinary order and bytes", () => {
  const entries = chain([user(), assistant("a", [call("n"), call("o", false)]), result("o"),
    assistant("b", [call("m")]), result("n"), user("steering"), result("m"), assistant("done", [{ type: "text", text: "done" }])]);
  const before = JSON.stringify(entries);
  const native = project(entries);
  assert.deepEqual(native.messages, entries.map(entry => entry.message));
  assert.equal(synthetic(native.messages).length, 2);
  const ordinary = project(entries, "ordinary");
  assert.deepEqual(ordinary.messages, [entries[0].message, entries[1].message, entries[4].message,
    entries[2].message, entries[3].message, entries[6].message, entries[5].message, entries[7].message]);
  assert.equal(synthetic(ordinary.messages).length, 0);
  assert.deepEqual(ordinary.outstanding, []);
  assert.deepEqual(ordinary.diagnostics, []);
  assert.equal(JSON.stringify(entries), before);
  ordinary.messages[2].content[0].text = "caller changed projection";
  ordinary.messages[1].usage.cost.total = 100;
  assert.equal(JSON.stringify(entries), before);
});

test("selected native recovery is deterministic, original-ID, no-replay, and does not replace real errors", () => {
  const realError = { ...result("answered"), isError: true };
  const entries = chain([assistant("a", [call("answered"), call("missing"), call("ordinary", false)]), realError]);
  const before = JSON.stringify(entries);
  const ordinary = project(entries, "ordinary");
  assert.deepEqual(ordinary.outstanding, [{ toolCallId: "missing", toolName: "python", messageEntryId: "e0",
    contentIndex: 1, retainedInContext: true }]);
  assert.deepEqual(ordinary.diagnostics.filter(d => d.severity === "blocking").map(d => d.toolCallId), ["missing", "ordinary"]);
  const recoveryInput = { ...input(entries), timestamp: 100 };
  const plans = planUnknownRecovery(recoveryInput);
  assert.deepEqual(plans, [{ role: "toolResult", toolCallId: "missing", toolName: "python", timestamp: 100,
    content: [{ type: "text", text: "Tool execution was interrupted; its outcome is unknown. The original call was not re-executed." }],
    details: { nativeAsyncRecovery: "interrupted-unknown" }, isError: true }]);
  assert.deepEqual(planUnknownRecovery(recoveryInput), plans);
  assert.equal(JSON.stringify(entries), before);
  // Simulate the sole writer's committed append, not a module-owned append.
  const committed = [...entries, messageEntry("repair", "e1", plans[0])];
  assert.deepEqual(planUnknownRecovery({ ...input(committed), timestamp: 101 }), []);
  assert.deepEqual(project(committed).messages[1], realError);
});

test("ordinary unanswered calls are barriers but never native recovery plans", () => {
  const entries = chain([assistant("a", [call("ordinary", false)]), user()]);
  assert.deepEqual(project(entries).outstanding, []);
  assert.deepEqual(planUnknownRecovery({ ...input(entries), timestamp: 1 }), []);
  assert(project(entries, "ordinary").diagnostics.some(d => d.code === "ORDINARY_REPLAY_BLOCKED"));
});

test("ordinary out-of-order real results stay in place and report a blocking diagnostic", () => {
  const entries = chain([assistant("a", [call("ordinary", false)]), user(), result("ordinary")]);
  const projection = project(entries, "ordinary");
  assert.deepEqual(projection.messages, entries.map(entry => entry.message));
  assert.deepEqual(projection.diagnostics.map(d => d.code), ["ORDINARY_REPLAY_BLOCKED"]);
});

test("raw and custom thinking amendments overlay only selected copied messages", () => {
  for (const legacy of [false, true]) {
    const target = thinkingEntry();
    const meta = amendment(target, "meta", target.id, {}, legacy);
    const sibling = amendment(target, "sibling", target.id, { encryptedContent: "excluded-sibling" }, legacy);
    const entries = [target, meta, sibling];
    const before = JSON.stringify(entries);
    const projected = project(entries, "native", meta.id);
    const item = JSON.parse(projected.messages[0].content[0].thinkingSignature);
    assert.equal(item.encrypted_content, "fixture-encryption");
    assert.equal(JSON.stringify(entries), before);
    assert(!JSON.stringify(projected).includes("excluded-sibling"));
    assert.deepEqual(project(entries, "native", target.id).messages, [target.message]);
    assert.equal(projected.messages[0].content[0].thinking, target.message.content[0].thinking);
    assert.deepEqual(projected.messages[0].usage, usage);
  }
});

test("identical thinking amendments are idempotent and keep already-complete signature bytes", () => {
  const signature = '{ "id" : "rs", "type":"reasoning", "encrypted_content":"fixture-encryption", "summary": [] }';
  const target = thinkingEntry("target", null, signature);
  const one = amendment(target, "one"), two = amendment(target, "two", one.id, {}, true);
  assert.equal(project([target, one, two]).messages[0].content[0].thinkingSignature, signature);
});

test("thinking amendment rejects wrong target, branch, index, item, or encryption", () => {
  const target = thinkingEntry();
  const cases = [
    [{ messageEntryId: "absent" }, "ERR_SIGNATURE_TARGET"],
    [{ messageId: "wrong" }, "ERR_SIGNATURE_TARGET"],
    [{ contentIndex: -1 }, "ERR_SIGNATURE_DATA"],
    [{ contentIndex: 1.5 }, "ERR_SIGNATURE_DATA"],
    [{ contentIndex: 1 }, "ERR_SIGNATURE_CONTENT_INDEX"],
    [{ contentIndex: 8 }, "ERR_SIGNATURE_CONTENT_INDEX"],
    [{ itemId: "wrong" }, "ERR_SIGNATURE_ITEM"],
    [{ encryptedContent: "" }, "ERR_SIGNATURE_DATA"],
  ];
  for (const [changes, code] of cases) rejects([target, amendment(target, "meta", target.id, changes)], code);
  const first = amendment(target, "first");
  rejects([target, first, amendment(target, "conflict", first.id, { encryptedContent: "different" })], "ERR_SIGNATURE_ENCRYPTION_CONFLICT");
  const other = thinkingEntry("other", target.id);
  rejects([target, other, amendment(other, "meta", target.id)], "ERR_SIGNATURE_TARGET");
  const wrongRole = { ...target, message: { ...target.message, role: "user" } };
  rejects([wrongRole, amendment(target)], "ERR_SIGNATURE_TARGET");
});

test("reasoning signatures reject malformed JSON, wrong type, duplicate keys, and conflicting encryption", () => {
  for (const [signature, code] of [
    ["{", "ERR_SIGNATURE_JSON"],
    ["[]", "ERR_SIGNATURE_DATA"],
    ['{"type":"message","id":"rs"}', "ERR_SIGNATURE_ITEM"],
    ['{"type":"reasoning","id":"rs","id":"rs"}', "ERR_SIGNATURE_DUPLICATE_KEY"],
    ['{"type":"reasoning","id":"rs","summary":[{"x":1,"x":2}]}', "ERR_SIGNATURE_DUPLICATE_KEY"],
    ['{"type":"reasoning","id":"rs","encrypted_content":"different"}', "ERR_SIGNATURE_ENCRYPTION_CONFLICT"],
  ]) {
    const target = thinkingEntry("target", null, signature);
    rejects([target, amendment(target)], code);
  }
  const target = thinkingEntry();
  const invalid = amendment(target); invalid.data.version = 2;
  rejects([target, invalid], "ERR_SIGNATURE_VERSION");
});

test("escaped signature keys are validated and unrelated fields survive overlay", () => {
  const signature = '{"type":"reasoning","id":"rs","summary":[{"text":"a \\\"quoted\\\" value","type":"summary_text"}],"status":"completed"}';
  const target = thinkingEntry("target", null, signature);
  const output = JSON.parse(project([target, amendment(target)]).messages[0].content[0].thinkingSignature);
  assert.deepEqual(output, { ...JSON.parse(signature), encrypted_content: "fixture-encryption" });
  target.message.content[0].thinkingSignature = '{"type":"reasoning","id":"rs","i\\u0064":"rs"}';
  rejects([target, amendment(target)], "ERR_SIGNATURE_DUPLICATE_KEY");
});

test("selected summary metadata, rich roles, images, and kept compaction remain intact", () => {
  const entries = chain([user("pruned"), user("kept"),
    { role: "bashExecution", command: "fixture", output: "output", exitCode: 0, cancelled: false,
      truncated: false, fullOutputPath: "fixture-path", excludeFromContext: true, timestamp: 2 }]);
  entries.push({ type: "branch_summary", id: "branch", parentId: "e2", timestamp, summary: "branch bytes", fromId: "excluded",
    usage, details: { files: ["one"] }, provenance: { branch: "source" }, fromHook: true });
  entries.push({ type: "custom_message", id: "custom", parentId: "branch", timestamp, customType: "family",
    content: [image, { type: "text", text: "custom bytes" }], display: true, details: { family: true } });
  entries.push({ type: "compaction", id: "compact", parentId: "custom", timestamp, summary: "compaction bytes",
    firstKeptEntryId: "e1", tokensBefore: 99, usage, details: { cumulative: ["two"] }, fromHook: true,
    provenance: { summary: "source" } });
  const before = JSON.stringify(entries), plain = buildSessionContext(entries, "compact").messages;
  const projected = project(entries).messages;
  assert.deepEqual(projected.map(m => m.role), plain.map(m => m.role));
  assert.deepEqual(projected.slice(1, 3), plain.slice(1, 3));
  assert.deepEqual(projected.at(-1), plain.at(-1));
  assert.equal(projected[0].summary, "compaction bytes");
  assert.deepEqual(projected[0].usage, usage);
  assert.deepEqual(projected[0].provenance, { summary: "source" });
  assert.deepEqual(projected[3], { ...plain[3], usage, details: { files: ["one"] },
    provenance: { branch: "source" }, fromHook: true });
  assert.equal(JSON.stringify(entries), before);
});

test("repeated compactions preserve the latest summary and older kept summaries with metadata", () => {
  const entries = chain([user(), user("kept")]);
  entries.push({ type: "compaction", id: "c1", parentId: "e1", timestamp, summary: "same",
    tokensBefore: 1, firstKeptEntryId: "e1", details: { generation: 1 } });
  entries.push({ type: "compaction", id: "c2", parentId: "c1", timestamp, summary: "same",
    tokensBefore: 1, firstKeptEntryId: "e1", details: { generation: 2 } });
  assert.deepEqual(project(entries).messages.filter(m => m.role === "compactionSummary").map(m => m.details),
    [{ generation: 2 }, { generation: 1 }]);
});

test("signature amendments validate and overlay selected history before compaction pruning", () => {
  const target = thinkingEntry();
  const meta = amendment(target);
  const later = thinkingEntry("later", meta.id);
  const update = amendment(later, "update", later.id);
  const compact = { type: "compaction", id: "compact", parentId: "update", timestamp, summary: "summary",
    tokensBefore: 20, firstKeptEntryId: later.id };
  const entries = [target, meta, later, update, compact];
  const projection = project(entries);
  assert.equal(projection.messages.length, 2);
  assert.equal(JSON.parse(projection.messages[1].content[0].thinkingSignature).encrypted_content, "fixture-encryption");
  assert.deepEqual(projection.outstanding.map(o => [o.toolCallId, o.retainedInContext]), [["call_target", false], ["call_later", true]]);
});

test("pruning never creates an unknown result for a known call or resurrects a pruned call", () => {
  const entries = chain([assistant("a", [call("known"), call("missing")]), user(), result("known")]);
  entries.push({ type: "compaction", id: "compact", parentId: "e2", timestamp, summary: "summary",
    tokensBefore: 20, firstKeptEntryId: "e1" });
  const projection = project(entries, "ordinary");
  assert.deepEqual(projection.messages.at(-1), entries[2].message);
  assert.equal(projection.messages.some(m => m.role === "assistant"), false);
  assert.deepEqual(projection.outstanding.map(o => [o.toolCallId, o.retainedInContext]), [["missing", false]]);
  assert(projection.diagnostics.some(d => d.code === "CALL_PRUNED" && d.toolCallId === "known"));
  assert.deepEqual(planUnknownRecovery({ ...input(entries), timestamp: 8 }).map(r => r.toolCallId), ["missing"]);
  entries.at(-1).firstKeptEntryId = "compact";
  assert.equal(project(entries).messages.length, 1);
  assert.deepEqual(planUnknownRecovery({ ...input(entries), timestamp: 8 }).map(r => r.toolCallId), ["missing"]);
});

test("only selected-branch calls and results count; sibling-only ID reuse does not answer a call", () => {
  const common = messageEntry("common", null, user());
  const selected = messageEntry("selected", common.id, assistant("a", [call("same")]));
  const sibling = messageEntry("sibling", common.id, assistant("b", [call("same")]));
  const answer = messageEntry("answer", sibling.id, result("same"));
  const entries = [common, selected, sibling, answer];
  assert.equal(project(entries, "native", selected.id).outstanding.length, 1);
  assert.equal(project(entries, "native", answer.id).outstanding.length, 0);
  assert.deepEqual(project(entries, "native", null).messages, []);
});

test("selected orphan results remain unchanged, including IDs used only on excluded branches", () => {
  const common = messageEntry("common", null, user());
  const sibling = messageEntry("sibling", common.id, assistant("a", [call("orphan")]));
  const orphan = messageEntry("orphan", common.id, result("orphan"));
  const projection = project([common, sibling, orphan], "ordinary", orphan.id);
  assert.deepEqual(projection.messages, [common.message, orphan.message]);
  assert.deepEqual(projection.outstanding, []);
  assert.deepEqual(projection.diagnostics, [{ code: "ORPHAN_RESULT", severity: "info", toolCallId: "orphan", messageEntryId: "orphan" }]);
});

test("duplicate/reused native, mixed, ordinary, and pruned IDs reject rather than guessing", () => {
  for (const flags of [[true, true], [true, false], [false, false]]) {
    rejects(chain([assistant("a", flags.map(flag => call("same", flag)))]), "ERR_CONTEXT_DUPLICATE_CALL_ID");
  }
  const entries = chain([assistant("a", [call("same")]), result("same"), assistant("b", [call("same")])]);
  entries.push({ type: "compaction", id: "compact", parentId: "e2", timestamp, summary: "summary",
    tokensBefore: 20, firstKeptEntryId: "e2" });
  rejects(entries, "ERR_CONTEXT_DUPLICATE_CALL_ID");
  rejects(chain([result("orphan"), result("orphan")]), "ERR_CONTEXT_DUPLICATE_RESULT_ID");
  rejects(chain([assistant("a", [call("same")]), result("same"), result("same")]), "ERR_CONTEXT_DUPLICATE_RESULT_ID");
});

test("result identity rejects wrong name and a result preceding its only selected call", () => {
  rejects(chain([assistant("a", [call("x")]), { ...result("x"), toolName: "other" }]), "ERR_CONTEXT_RESULT_NAME");
  rejects(chain([result("x"), assistant("a", [call("x")])]), "ERR_CONTEXT_RESULT_BEFORE_CALL");
});

test("effective firstKept ignores unused retainedTail extras with exact public helper parity", () => {
  const entries = chain([user("kept"), assistant("a", [call("pending")])]);
  const tails = [[], [user("unused-tail"), result("pending"), assistant("fake", [call("never-admitted")])],
    { unsupportedPayload: true }, null, false];
  for (const retainedTail of tails) for (const firstKeptEntryId of ["e0", "e1", "compact"]) {
    const compact = { type: "compaction", id: "compact", parentId: "e1", timestamp,
      summary: "summary", firstKeptEntryId, tokensBefore: 10, retainedTail };
    const selected = [...entries, compact], before = JSON.stringify(selected);
    const projection = project(selected);
    assert.deepEqual(projection.messages, buildSessionContext(selected, "compact").messages);
    assert(!projection.messages.some(message => Object.hasOwn(message, "retainedTail")));
    assert.equal(projection.outstanding.length, 1);
    assert.equal(projection.outstanding[0].toolCallId, "pending");
    assert.equal(projection.outstanding[0].retainedInContext, firstKeptEntryId !== "compact");
    assert.deepEqual(planUnknownRecovery({ ...input(selected), timestamp: 10 }).map(message => message.toolCallId), ["pending"]);
    assert.equal(JSON.stringify(selected), before);
  }
});

test("effective retained-only or invalid firstKept fails visibly instead of dropping history", () => {
  const entries = chain([user()]);
  for (const retainedTail of [undefined, [], [user("tail")]]) for (const firstKeptEntryId of [undefined, null, "", "missing", "sibling", "later"]) {
    const compact = { type: "compaction", id: "compact", parentId: "e0", timestamp,
      summary: "summary", tokensBefore: 10,
      ...(retainedTail === undefined ? {} : { retainedTail }),
      ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }) };
    const sibling = messageEntry("sibling", "e0", user("sibling"));
    const later = messageEntry("later", "compact", user("later"));
    const all = [...entries, sibling, compact, later];
    rejects(all, "ERR_CONTEXT_COMPACTION", "native", "compact");
    rejects(all, "ERR_CONTEXT_COMPACTION", "native", "later");
    assert.deepEqual(project(all, "native", "e0").messages, [entries[0].message]);
    // The SDK silently omits an unsupported kept range; the adapter never does.
    assert.equal(buildSessionContext(all, "compact").messages.length, 1);
  }
});

test("superseded pruned checkpoint semantics never block a valid effective firstKept", () => {
  for (const summary of ["old", null, { obsolete: true }]) for (const oldAnchor of [undefined, "missing", "sibling"]) {
    const original = messageEntry("original", null, user("original"));
    const old = { type: "compaction", id: "old", parentId: original.id, timestamp, summary,
      tokensBefore: "obsolete", firstKeptEntryId: oldAnchor, retainedTail: [assistant("fake", [call("fake")])] };
    const kept = messageEntry("kept", old.id, user("kept"));
    const latest = { type: "compaction", id: "latest", parentId: kept.id, timestamp,
      summary: "latest", tokensBefore: 40, firstKeptEntryId: kept.id };
    const later = messageEntry("later", latest.id, user("later"));
    const all = [original, old, kept, latest, later], before = JSON.stringify(all);
    const projection = project(all);
    assert.deepEqual(projection.messages, buildSessionContext(all, later.id).messages);
    assert.deepEqual(projection.outstanding, []);
    assert.deepEqual(projectCanonicalBranch({ entries: all, leafId: later.id }).entries, all);
    assert.equal(JSON.stringify(all), before);
  }
});

test("older kept checkpoints retain summaries but their anchors and tails are not effective", () => {
  for (const oldAnchor of [undefined, "missing", "sibling"]) {
    const original = messageEntry("original", null, user("original"));
    const old = { type: "compaction", id: "old", parentId: original.id, timestamp, summary: "old summary",
      tokensBefore: 20, firstKeptEntryId: oldAnchor, retainedTail: [user("unused")], usage };
    const kept = messageEntry("kept", old.id, user("kept"));
    const latest = { type: "compaction", id: "latest", parentId: kept.id, timestamp,
      summary: "latest summary", tokensBefore: 40, firstKeptEntryId: old.id };
    const all = [original, old, kept, latest], before = JSON.stringify(all);
    const projection = project(all);
    const oracle = buildSessionContext(all, latest.id).messages;
    assert.deepEqual(projection.messages, oracle.map(message => message.summary === old.summary ? { ...message, usage } : message));
    assert.deepEqual(projection.messages.map(message => message.role), ["compactionSummary", "compactionSummary", "user"]);
    assert.equal(JSON.stringify(all), before);
    old.summary = null;
    rejects(all, "ERR_CONTEXT_COMPACTION");
  }
});

test("unused and obsolete tail extras cannot alter selected late signature or native recovery", () => {
  const target = thinkingEntry();
  const old = { type: "compaction", id: "old", parentId: target.id, timestamp, summary: "old", tokensBefore: 10,
    retainedTail: [result("call_target"), result("call_target")] };
  const signature = amendment(target, "meta", old.id);
  const latest = { type: "compaction", id: "latest", parentId: signature.id, timestamp, summary: "latest",
    tokensBefore: 20, firstKeptEntryId: target.id, retainedTail: [result("call_target")] };
  const sibling = { type: "compaction", id: "sibling", parentId: target.id, timestamp, retainedTail: [result("call_target")] };
  const entries = [target, old, signature, sibling, latest], before = JSON.stringify(entries);
  const projection = project(entries, "native", latest.id);
  assert.equal(JSON.parse(projection.messages[1].content[0].thinkingSignature).encrypted_content, "fixture-encryption");
  assert.equal(projection.outstanding.length, 1);
  assert.equal(projection.outstanding[0].messageEntryId, target.id);
  assert.deepEqual(planUnknownRecovery({ ...input(entries, "native", latest.id), timestamp: 5 }).map(message => message.toolCallId), ["call_target"]);
  const answered = [...entries, messageEntry("real-result", latest.id, result("call_target"))];
  const ordinary = project(answered, "ordinary");
  assert.deepEqual(ordinary.outstanding, []);
  assert.equal(ordinary.messages.filter(message => message.role === "toolResult").length, 1);
  assert.equal(synthetic(ordinary.messages).length, 0);
  assert.equal(JSON.stringify(entries), before);
  rejects(entries, "ERR_CONTEXT_COMPACTION", "native", sibling.id);
});

test("canonical branch validation never defaults to another leaf or repairs malformed ancestry", () => {
  const entries = chain([user(), user()]);
  rejects(entries, "ERR_CONTEXT_BRANCH_MISSING", "native", "absent");
  rejects([...entries, { ...entries[0] }], "ERR_CONTEXT_DUPLICATE_ENTRY_ID");
  const cycle = structuredClone(entries); cycle[0].parentId = "e1";
  rejects(cycle, "ERR_CONTEXT_BRANCH_CYCLE");
  const missing = structuredClone(entries); missing[0].parentId = "missing";
  rejects(missing, "ERR_CONTEXT_BRANCH_MISSING");
  assert.throws(() => projectCanonicalContext({ entries, mode: "native", buildSessionContext }), { code: "ERR_CONTEXT_LEAF" });
  rejects(entries, "ERR_CONTEXT_MODE", "other");
});

test("bounded data rejects cycles, accessors, custom prototypes, nonfinite values, and deep structures", () => {
  const entries = chain([user()]);
  entries[0].loop = entries;
  rejects(entries, "ERR_CONTEXT_DATA_CYCLE");
  delete entries[0].loop;
  let getterCalls = 0;
  Object.defineProperty(entries[0], "get", { enumerable: true, configurable: true, get() { getterCalls++; } });
  rejects(entries, "ERR_CONTEXT_DATA_TYPE");
  assert.equal(getterCalls, 0);
  delete entries[0].get;
  entries[0].extra = new Date(); rejects(entries, "ERR_CONTEXT_DATA_TYPE");
  entries[0].extra = NaN; rejects(entries, "ERR_CONTEXT_DATA_TYPE");
  entries[0].extra = Array(1); rejects(entries, "ERR_CONTEXT_DATA_TYPE");
  entries[0].extra = {};
  let deep = entries[0].extra;
  for (let i = 0; i <= CANONICAL_CONTEXT_LIMITS.depth; i++) deep = deep.next = {};
  rejects(entries, "ERR_CONTEXT_DATA_LIMIT");
  const target = thinkingEntry(); target.message.content[0].thinkingSignature = " ".repeat(CANONICAL_CONTEXT_LIMITS.signatureCodeUnits + 1);
  rejects([target, amendment(target)], "ERR_SIGNATURE_DATA");
});

test("injected helper failures and invalid results never fall back to raw or another context", () => {
  const entries = chain([assistant("a", [call("x")]), result("x")]);
  for (const [helper, code] of [
    [() => { throw new Error("private helper error"); }, "ERR_CONTEXT_HELPER_FAILED"],
    [() => Promise.resolve({ messages: [] }), "ERR_CONTEXT_HELPER_RESULT"],
    [() => ({ messages: "wrong" }), "ERR_CONTEXT_HELPER_RESULT"],
    [() => ({ messages: [assistant("wrong", [call("other")])] }), "ERR_CONTEXT_CALL_PROJECTION"],
    [() => ({ messages: [{ ...result("x"), isError: true }] }), "ERR_CONTEXT_RESULT_PROJECTION"],
  ]) assert.throws(() => projectCanonicalContext({ ...input(entries), buildSessionContext: helper }), { code });
  const snapshot = JSON.stringify(entries);
  projectCanonicalContext({ ...input(entries), buildSessionContext: copied => {
    copied[0].message.content[0].arguments.code = "mutated clone";
    return { messages: [] };
  } });
  assert.equal(JSON.stringify(entries), snapshot);
});

test("recovery timestamp must be explicit, finite, nonnegative, and integral", () => {
  for (const timestamp of [undefined, -1, Infinity, 1.5, "1"]) {
    assert.throws(() => planUnknownRecovery({ ...input([]), timestamp }), { code: "ERR_RECOVERY_TIMESTAMP" });
  }
});

test("STOCK SessionManager reopen preserves canonical file bytes through projection and recovery planning", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canonical-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const legacy of [false, true]) {
    const target = thinkingEntry();
    const entries = [target, amendment(target, "metadata", target.id, {}, legacy)];
    const header = { type: "session", version: 3, id: "12345678-1234-4321-8123-123456789abc", timestamp, cwd: root };
    const bytes = Buffer.from([header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
    const file = path.join(root, `session-${legacy}.jsonl`);
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    const manager = SessionManager.open(file, root);
    const arguments_ = { entries: manager.getEntries(), leafId: manager.getLeafId(), buildSessionContext, mode: "native" };
    const projection = projectCanonicalContext(arguments_);
    assert.equal(projection.outstanding[0].toolCallId, "call_target");
    assert.equal(JSON.parse(projection.messages[0].content[0].thinkingSignature).encrypted_content, "fixture-encryption");
    assert.equal(planUnknownRecovery({ ...arguments_, timestamp: 1 }).length, 1);
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(SessionManager.open(file, root).getEntries(), manager.getEntries());
  }
});

test("exhaustive bounded STOCK compaction/missing-result matrix preserves known results without replay", () => {
  let scenarios = 0;
  for (let answerMask = 0; answerMask < 4; answerMask++) {
    const messages = [user(), assistant("a", [call("a")]), assistant("b", [call("b")])];
    if (answerMask & 1) messages.push(result("a"));
    messages.push(user("interleaved"));
    if (answerMask & 2) messages.push(result("b"));
    for (let cut = 0; cut <= messages.length; cut++) {
      const entries = chain(messages);
      entries.push({ type: "compaction", id: "compact", parentId: entries.at(-1).id, timestamp,
        summary: "summary", tokensBefore: 20, firstKeptEntryId: cut === messages.length ? "compact" : `e${cut}` });
      const before = JSON.stringify(entries);
      for (const mode of ["native", "ordinary"]) {
        scenarios++;
        const projection = project(entries, mode);
        const expectedMissing = ["a", "b"].filter((id, i) => !(answerMask & (1 << i)));
        assert.deepEqual(projection.outstanding.map(o => o.toolCallId), expectedMissing);
        assert.deepEqual(planUnknownRecovery({ ...input(entries, mode), timestamp: 0 }).map(r => r.toolCallId), expectedMissing);
        const expected = buildSessionContext(entries, "compact").messages;
        assert.equal(projection.messages.length, expected.length);
        for (const id of ["a", "b"]) {
          const actual = projection.messages.filter(m => m.role === "toolResult" && m.toolCallId === id);
          const real = expected.filter(m => m.role === "toolResult" && m.toolCallId === id);
          assert.deepEqual(actual, real);
        }
        if (mode === "native") assert.deepEqual(projection.messages, expected);
        if (mode === "ordinary" && !projection.diagnostics.some(d => d.severity === "blocking")) assert.equal(synthetic(projection.messages).length, 0);
        assert.equal(JSON.stringify(entries), before);
      }
    }
  }
  assert.equal(scenarios, 48);
});


test("shared canonical branch export validates, overlays, detaches and does not prune compaction history", () => {
  const target = thinkingEntry();
  const metadata = amendment(target);
  const entries = [target, metadata, messageEntry("result", metadata.id, result("call_target")),
    { type: "compaction", id: "compact", parentId: "result", timestamp, summary: "summary", firstKeptEntryId: "result", tokensBefore: 10 },
    messageEntry("sibling", target.id, assistant("other", [call("call_target")]))];
  const original = JSON.stringify(entries);
  const branch = projectCanonicalBranch({ entries, leafId: "compact" });
  assert.deepEqual(branch.entries.map(entry => entry.id), ["target", "metadata", "result", "compact"]);
  assert.match(branch.entries[0].message.content[0].thinkingSignature, /fixture-encryption/);
  assert.equal(branch.diagnostics[0].code, "SIGNATURE_OVERLAY");
  branch.entries[0].message.content[1].arguments.code = "changed projection only";
  assert.equal(JSON.stringify(entries), original);
  assert.throws(() => projectCanonicalBranch({ entries: [...entries,
    messageEntry("duplicate", "compact", result("call_target"))], leafId: "duplicate" }), { code: "ERR_CONTEXT_DUPLICATE_RESULT_ID" });
});
