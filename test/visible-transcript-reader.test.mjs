import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROGRESS_ENTRY_TYPE } from "../src/progress-projection.mjs";
import { AGENT_MESSAGE_ENTRY_TYPE, CHILD_CREATION_ENTRY_TYPE, INCOMING_AGENT_MESSAGE_TYPE } from "../src/agent-message-projection.mjs";
import { VisibleTranscriptReader, boundVisibleHistory, boundVisibleMessages } from "../src/visible-transcript-reader.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function header(id) { return { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" }; }
function message(id, parentId, role, text) { return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content: [{ type: "text", text }] } }; }

async function fixture(t, id = "session-a") {
  const root = await mkdtemp(path.join(os.tmpdir(), "visible-transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, `${id}.jsonl`);
  return { root, file, id };
}

test("visible transcript reader follows the active branch and excludes private blocks", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [
    header(id),
    message("u1", null, "user", "hello\n\n<!-- persistent-harness-input:input-proof -->"),
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", api: "openai-codex-responses", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", name: "ipython", arguments: { secret: true } }, { type: "text", text: "public answer" }] } },
    message("branch-old", "a1", "user", "abandoned"),
    message("branch-new", "a1", "user", "selected"),
    message("a2", "branch-new", "assistant", "done"),
  ];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader({ inputReceiptReader: (inputId, sessionId) => ({ inputId, sessionId, message: "hello", images: [], source: "user", origin: null, acceptedAt: 1767225600000 }) }).read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.messages.map((item) => item.text), ["hello", "public answer", "selected", "done"]);
  assert.deepEqual(result.inputIds, ["input-proof"]);
  assert.doesNotMatch(JSON.stringify({ messages: result.messages, leafId: result.leafId }), /private reasoning|secret|abandoned|toolCall|ipython/);
  assert.equal(result.leafId, "a2");
});


test("visible transcript keeps scheduled receipts while projecting non-Commander authorship", async (t) => {
  const { file, id } = await fixture(t);
  const inputId = "cron-input-cron-0123456789abcdef01234567";
  const marker = `\n\n<!-- persistent-harness-input:${inputId} -->`;
  const entries = [header(id), message("scheduled", null, "user", `Run the scheduled check.${marker}`),
    message("answer", "scheduled", "assistant", "Scheduled check complete."),
  ];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader({ inputReceiptReader: (inputId, sessionId) => ({ inputId, sessionId, message: "Run the scheduled check.", images: [], source: "cron", origin: { jobId: "job", runId: "run" }, acceptedAt: 1767225600000 }) }).read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
    { role: "scheduled_job", text: "Run the scheduled check." },
    { role: "assistant", text: "Scheduled check complete." },
  ]);
  assert.deepEqual(result.inputIds, [inputId]);
  assert.equal(result.inputEntries[inputId], "scheduled");
});

test("visible transcript root sanitization scrubs directives while the same cached child projection stays unchanged", async (t) => {
  const { file, id } = await fixture(t);
  const source = "<!-- taihou.presentation.v1 body=happy face=smile -->\nVisible.\n  <!-- taihou.presentation malformed -->\nTail.";
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(message("a1", null, "assistant", source))}\n`);
  const reader = new VisibleTranscriptReader();
  const rootVisible = await reader.read({ sessionFile: file, sessionId: id, sanitizePresentation: true });
  assert.deepEqual(rootVisible.messages.map((item) => item.text), ["Visible.\nTail."]);
  assert.doesNotMatch(JSON.stringify(rootVisible), /taihou\.presentation|body=happy/);
  const childVisible = await reader.read({ sessionFile: file, sessionId: id, sanitizePresentation: false });
  assert.equal(childVisible.messages[0].text, source, "root-only sanitization must not mutate the cached canonical child projection");
  const rootAgain = await reader.read({ sessionFile: file, sessionId: id, sanitizePresentation: true });
  assert.equal(rootAgain.messages[0].text, "Visible.\nTail.", "cache reuse must preserve the read-specific privacy option");
});

test("concurrent reads never share projections across presentation privacy options", async (t) => {
  const { file, id } = await fixture(t);
  const source = "<!-- taihou.presentation.v1 body=happy face=smile -->\nVisible.";
  const padding = { type: "custom", customType: "padding", id: "pad", parentId: null,
    timestamp: "2026-01-01T00:00:00Z", data: "x".repeat(2 * 1024 * 1024) };
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(padding)}\n${JSON.stringify(message("a1", "pad", "assistant", source))}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id };
  const firstSafe = reader.read({ ...args, sanitizePresentation: true });
  const overlappingRaw = reader.read({ ...args, sanitizePresentation: false });
  const overlappingSafe = reader.read({ ...args, sanitizePresentation: true });
  assert.equal((await firstSafe).messages[0].text, "Visible.");
  assert.equal((await overlappingRaw).messages[0].text, source);
  const safe = await overlappingSafe;
  assert.equal(safe.messages[0].text, "Visible.");
  assert.doesNotMatch(JSON.stringify(safe), /taihou\.presentation|body=happy/);
});

test("visible transcript reader incrementally accepts only complete appended lines", async (t) => {
  const { file, id } = await fixture(t);
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "one"))}\n`);
  const reader = new VisibleTranscriptReader();
  assert.deepEqual((await reader.read({ sessionFile: file, sessionId: id })).messages.map((item) => item.text), ["one"]);
  const encoded = JSON.stringify(message("a1", "u1", "assistant", "two"));
  await appendFile(file, encoded.slice(0, 20));
  assert.deepEqual((await reader.read({ sessionFile: file, sessionId: id })).messages.map((item) => item.text), ["one"]);
  await appendFile(file, `${encoded.slice(20)}\n`);
  assert.deepEqual((await reader.read({ sessionFile: file, sessionId: id })).messages.map((item) => item.text), ["one", "two"]);
});

test("a concurrent transcript read performs one trailing refresh", async (t) => {
  const { file, id } = await fixture(t);
  const padding = { type: "custom", customType: "padding", id: "pad", parentId: null, timestamp: "2026-01-01T00:00:00Z", data: "x".repeat(2 * 1024 * 1024) };
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(padding)}\n`);
  const reader = new VisibleTranscriptReader();
  const first = reader.read({ sessionFile: file, sessionId: id });
  await appendFile(file, `${JSON.stringify(message("u1", "pad", "user", "arrived"))}\n`);
  const second = reader.read({ sessionFile: file, sessionId: id });
  await first;
  assert.deepEqual((await second).messages.map((item) => item.text), ["arrived"]);
});

test("visible transcript reader rebuilds after canonical file replacement", async (t) => {
  const { root, file, id } = await fixture(t);
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u1", null, "user", "old"))}\n`);
  const reader = new VisibleTranscriptReader();
  assert.equal((await reader.read({ sessionFile: file, sessionId: id })).messages[0].text, "old");
  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, `${JSON.stringify(header(id))}\n${JSON.stringify(message("u2", null, "user", "new"))}\n`);
  await rename(replacement, file);
  assert.equal((await reader.read({ sessionFile: file, sessionId: id })).messages[0].text, "new");
});

test("visible transcript reader validates canonical session identity", async (t) => {
  const { file, id } = await fixture(t);
  await writeFile(file, `${JSON.stringify(header("other"))}\n`);
  await assert.rejects(new VisibleTranscriptReader().read({ sessionFile: file, sessionId: id }), /does not match/);
});

test("visible message bounding uses one newest suffix and caps an oversized message", () => {
  const values = Array.from({ length: 20 }, (_, index) => ({ id: String(index), role: "assistant", text: index === 19 ? "x".repeat(100_000) : `m${index}`, createdAt: "2026-01-01T00:00:00Z", status: "complete" }));
  const result = boundVisibleMessages(values, { maxMessages: 5, maxBytes: 4096 });
  assert.equal(result.truncated, true);
  assert(result.messages.length <= 5);
  assert(Buffer.byteLength(JSON.stringify(result.messages)) <= 4096);
  assert.match(result.messages.at(-1).text, /…$/);
});

test("visible transcript reader interleaves only allowlisted durable progress entries", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [
    header(id),
    message("u1", null, "user", "start"),
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p1", parentId: "u1", timestamp: "2026-01-01T00:00:01Z", data: { summary: "Inspecting the history path", secret: "never projected" } },
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p2", parentId: "p1", timestamp: "2026-01-01T00:00:02Z", data: { summary: "Testing timeline order" } },
    { type: "custom", customType: "private-extension", id: "private", parentId: "p2", timestamp: "2026-01-01T00:00:03Z", data: { summary: "Private custom data", token: "hidden" } },
    message("a1", "private", "assistant", "done"),
  ];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader().read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.messages.map((item) => item.text), ["start", "done"]);
  assert.deepEqual(result.history, [
    { kind: "message", id: "u1" },
    { kind: "progress", id: "p1", summary: "Inspecting the history path", createdAt: "2026-01-01T00:00:01.000Z" },
    { kind: "progress", id: "p2", summary: "Testing timeline order", createdAt: "2026-01-01T00:00:02.000Z" },
    { kind: "message", id: "a1" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /never projected|Private custom data|token|hidden/);
});

test("visible history bounding includes progress in one newest bounded suffix", () => {
  const history = [
    { kind: "message", message: { id: "m1", role: "user", text: "old", createdAt: "2026-01-01T00:00:00Z", status: "complete" } },
    ...Array.from({ length: 20 }, (_, index) => ({ kind: "progress", id: `p${index}`, summary: `Progress ${index}`, createdAt: "2026-01-01T00:00:00Z" })),
  ];
  const result = boundVisibleHistory(history, { maxMessages: 5, maxBytes: 2048 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.history.map((item) => item.id), ["p15", "p16", "p17", "p18", "p19"]);
  assert(Buffer.byteLength(JSON.stringify({ messages: result.messages, history: result.history })) <= 2048);
});


test("visible transcript image history keeps only bounded references and reads active user bytes on demand", async (t) => {
  const { file, id } = await fixture(t);
  const imageMessage = { type: "message", id: "image-user", parentId: null, timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" },
      { type: "text", text: "look\n\n<!-- persistent-harness-input:image-input -->" }] } };
  const abandonedImage = { ...imageMessage, id: "abandoned-image", parentId: "image-user" };
  const entries = [header(id), imageMessage, abandonedImage, message("answer", "image-user", "assistant", "seen")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader(); const result = await reader.read({ sessionFile: file, sessionId: id });
  assert.equal(result.messages[0].images[0].data, undefined);
  assert.deepEqual(result.messages[0].images[0].ref, { entryId: "image-user", index: 0 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(PNG_1X1.slice(0, 24)));
  assert.deepEqual(await reader.readImage({ sessionFile: file, sessionId: id, entryId: "image-user", index: 0 }),
    { type: "image", data: PNG_1X1, mimeType: "image/png" });
  await assert.rejects(reader.readImage({ sessionFile: file, sessionId: id, entryId: "image-user", index: 1 }), /does not exist/);
  await assert.rejects(reader.readImage({ sessionFile: file, sessionId: id, entryId: "abandoned-image", index: 0 }), /active transcript branch/);
});


test("visible transcript interleaves durable family messages and splits progress sequences", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("u", null, "user", "start"),
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p1", parentId: "u", timestamp: "2026-01-01T00:00:01Z", data: { summary: "Before sending" } },
    { type: "custom", customType: CHILD_CREATION_ENTRY_TYPE, id: "created", parentId: "p1", timestamp: "2026-01-01T00:00:02Z",
      data: { taskId: "task-1", childId: "child-1", childName: "builder", relationship: "child", body: "Build this" } },
    { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "sent", parentId: "created", timestamp: "2026-01-01T00:00:03Z",
      data: { messageId: "m1", direction: "to", peerId: "child", peerName: "reviewer", relationship: "child", body: "Please review" } },
    { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: "p2", parentId: "sent", timestamp: "2026-01-01T00:00:04Z", data: { summary: "After sending" } },
    { type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE, id: "received", parentId: "p2", timestamp: "2026-01-01T00:00:05Z",
      content: "Direct agent message from sibling:\nLooks good", display: true,
      details: { messageId: "m2", senderId: "sister", senderName: "auditor", relationship: "sibling", body: "Looks good" } },
    message("a", "received", "assistant", "done")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader().read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.history.map((item) => [item.kind, item.id]), [
    ["message", "u"], ["progress", "p1"], ["child_creation", "created"], ["agent_message", "sent"],
    ["progress", "p2"], ["agent_message", "received"], ["message", "a"],
  ]);
  assert.equal(result.history[2].childName, "builder");
  assert.equal(result.history[3].body, "Please review");
  assert.equal(result.history[5].relationship, "sister");
  assert.doesNotMatch(JSON.stringify(result), /senderId|messageId/);
});


test("visible transcript keeps the durable incoming entry and drops the later Pi custom_message", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("u", null, "user", "start"),
    { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "live-from", parentId: "u", timestamp: "2026-01-01T00:00:01Z",
      data: { messageId: "m2", direction: "from", peerId: "sister", peerName: "auditor", relationship: "sibling", body: "Looks good" } },
    { type: "custom_message", customType: INCOMING_AGENT_MESSAGE_TYPE, id: "injected", parentId: "live-from", timestamp: "2026-01-01T00:00:02Z",
      content: "Direct agent message from sibling:\nLooks good", display: true,
      details: { messageId: "m2", senderId: "sister", senderName: "auditor", relationship: "sibling", body: "Looks good" } },
    message("a", "injected", "assistant", "done")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader().read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.history.map((item) => [item.kind, item.id]), [
    ["message", "u"], ["agent_message", "live-from"], ["message", "a"],
  ]);
  assert.equal(result.history[1].direction, "from");
  assert.equal(result.history[1].body, "Looks good");
  assert.doesNotMatch(JSON.stringify(result), /injected|senderId|messageId/);
});


test("visible transcript still shows a durable incoming from-entry when Pi never wrote the custom_message", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("u", null, "user", "start"),
    { type: "custom", customType: AGENT_MESSAGE_ENTRY_TYPE, id: "live-from", parentId: "u", timestamp: "2026-01-01T00:00:01Z",
      data: { messageId: "m2", direction: "from", peerId: "sister", peerName: "auditor", relationship: "sibling", body: "Looks good" } }];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const result = await new VisibleTranscriptReader().read({ sessionFile: file, sessionId: id });
  assert.deepEqual(result.history.map((item) => [item.kind, item.id]), [
    ["message", "u"], ["agent_message", "live-from"],
  ]);
  assert.equal(result.history[1].direction, "from");
  assert.equal(result.history[1].body, "Looks good");
});

test("resolveRetryTurn finds the preceding user on the active branch", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [
    header(id),
    message("u1", null, "user", "first"),
    message("a1", "u1", "assistant", "one"),
    message("abandoned", "a1", "user", "nope"),
    message("u2", "a1", "user", "second"),
    message("a2", "u2", "assistant", "two"),
  ];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader();
  const latest = await reader.resolveRetryTurn({ sessionFile: file, sessionId: id, assistantId: "a2" });
  assert.deepEqual(latest, { assistantId: "a2", userId: "u2", branchFromId: "a1" });
  const earlier = await reader.resolveRetryTurn({ sessionFile: file, sessionId: id, assistantId: "a1" });
  assert.deepEqual(earlier, { assistantId: "a1", userId: "u1", branchFromId: null });
  await assert.rejects(reader.resolveRetryTurn({ sessionFile: file, sessionId: id, assistantId: "abandoned" }), /not on the active transcript branch/);
  await assert.rejects(reader.resolveRetryTurn({ sessionFile: file, sessionId: id, assistantId: "u2" }), /not an assistant message/);
});


for (const [name, { replyCount, oversized }] of [
  ["more than 32 history items", { replyCount: 40, oversized: false }],
  ["an oversized final reply", { replyCount: 0, oversized: true }],
]) {
  test(`opt-in title turn survives ${name} without changing the normal preview`, async (t) => {
    const { file, id } = await fixture(t);
    const userText = "Repair semantic session titles without changing manual names.";
    const assistantText = "Completed semantic title repair through the session provider.";
    const entries = [header(id), message("u", null, "user", userText)];
    let parentId = "u";
    for (let index = 0; index < replyCount; index += 1) {
      const id = `progress-${index}`;
      entries.push(index % 2 === 0
        ? message(id, parentId, "assistant", index === 0 ? "I will repair the title pipeline before the long checks." : `Progress update ${index}.`)
        : { type: "custom", customType: PROGRESS_ENTRY_TYPE, id, parentId,
          timestamp: "2026-01-01T00:00:01Z", data: { summary: `Progress update ${index}.` } });
      parentId = id;
    }
    entries.push(message("final", parentId, "assistant",
      `<!-- taihou.presentation.v1 body=happy face=smile -->\n${assistantText}${oversized ? " Result details.".repeat(8000) : ""}`));
    await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
    const reader = new VisibleTranscriptReader();
    const args = { sessionFile: file, sessionId: id, maxMessages: 32, maxBytes: 24 * 1024, sanitizePresentation: true };
    const plain = await reader.read(args);
    assert.equal(plain.truncated, true);
    assert.equal(plain.messages.some((item) => item.role === "user"), false, "the old suffix-only title call loses the initial user");
    const titled = await reader.read({ ...args, includeTitleTurn: true });
    const { titleTurn, titleUser, ...ordinary } = titled;
    assert.equal(titleUser, userText);
    assert.deepEqual(ordinary, plain, "title extraction must not change canonical preview fields");
    assert.equal(titleTurn.userText, userText);
    assert(titleTurn.assistantText.startsWith(replyCount ? "I will repair the title pipeline before the long checks." : assistantText));
    assert(titleTurn.assistantText.length <= 801);
    if (oversized) assert.match(titleTurn.assistantText, /…$/);
    assert.doesNotMatch(JSON.stringify(titleTurn), /taihou\.presentation|Progress update/);
    assert.equal(Object.hasOwn(plain, "titleTurn"), false);
  });
}

test("concurrent title and ordinary reads keep separate optional projections", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("u", null, "user", "Repair semantic session titles."),
    message("a", "u", "assistant", "The session provider now generates semantic titles.")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader();
  const args = { sessionFile: file, sessionId: id, maxMessages: 1, sanitizePresentation: true };
  const first = reader.read(args);
  const overlappingTitle = reader.read({ ...args, includeTitleTurn: true });
  const overlappingPlain = reader.read(args);
  const [initial, titled, plain] = await Promise.all([first, overlappingTitle, overlappingPlain]);
  const { titleTurn, titleUser, ...ordinary } = titled;
  assert.equal(titleUser, "Repair semantic session titles.");
  assert.deepEqual(titleTurn, { userText: "Repair semantic session titles.", assistantText: "The session provider now generates semantic titles." });
  assert.equal(Object.hasOwn(initial, "titleTurn"), false);
  assert.equal(Object.hasOwn(plain, "titleTurn"), false);
  assert.deepEqual(ordinary, plain);
});

test("title extraction uses only the sanitized active branch and excludes private blocks", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("old-u", null, "user", "An abandoned unrelated topic"),
    message("old-a", "old-u", "assistant", "Abandoned answer."),
    message("u", null, "user", "Repair session titles.\n\n<!-- persistent-harness-input:title-input -->"),
    { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant",
      content: [{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", name: "ipython", arguments: { secret: true } },
        { type: "text", text: "<!-- taihou.presentation.v1 body=happy face=smile -->\nSemantic titles now use the session provider." }] } }];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (inputId, sessionId) => ({ inputId, sessionId, message: "Repair session titles.", images: [], source: "user", origin: null, acceptedAt: 1767225600000 }) });
  const args = { sessionFile: file, sessionId: id, includeTitleTurn: true, sanitizePresentation: true };
  const titled = await reader.read(args);
  assert.deepEqual(titled.titleTurn, { userText: "Repair session titles.", assistantText: "Semantic titles now use the session provider." });
  assert.doesNotMatch(JSON.stringify(titled.titleTurn), /private|secret|ipython|presentation|title-input|abandoned/i);
  await writeFile(file, `${JSON.stringify(header(id))}\n${JSON.stringify(message("new-u", null, "user", "No completed answer yet."))}\n`);
  assert.equal((await reader.read(args)).titleTurn, null, "an incomplete replacement must not reuse a cached title pair");
});


test("cursor pages reach the full visible branch without duplicates across live appends", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id)]; const expected = [];
  let parentId = null;
  for (let index = 0; index < 1350; index += 1) {
    const entryId = `entry-${index}`;
    const entry = index % 9 === 0
      ? { type: "custom", customType: PROGRESS_ENTRY_TYPE, id: entryId, parentId,
        timestamp: "2026-01-01T00:00:01Z", data: { summary: `History step ${index}` } }
      : message(entryId, parentId, index % 2 ? "user" : "assistant", `row ${index} ${"text ".repeat(150)}`);
    entries.push(entry); expected.push(entryId); parentId = entryId;
    const hiddenId = `private-${index}`;
    entries.push({ type: "message", id: hiddenId, parentId, timestamp: "2026-01-01T00:00:01Z",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THINKING" },
        { type: "toolCall", name: "PRIVATE_TOOL", arguments: { key: "PRIVATE_ARGUMENT" } }] } });
    parentId = hiddenId;
  }
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id, maxMessages: 100 };
  let page = await reader.read(args);
  assert(page.history.length < 100, "the byte bound must also limit the first page");
  assert.equal(page.historyPage.hasMore, true);
  const branchId = page.historyPage.branchId;
  const collected = page.history.map((item) => item.id);
  await appendFile(file, `${JSON.stringify(message("live-new", parentId, "assistant", "live append"))}\n`);
  let pages = 1;
  while (page.historyPage.hasMore) {
    const previousCursor = page.historyPage.nextCursor;
    page = await reader.read({ ...args, before: previousCursor });
    pages += 1;
    assert(page.history.length > 0 && page.history.length <= 100);
    assert.equal(page.historyPage.branchId, branchId);
    assert.notEqual(page.historyPage.nextCursor, previousCursor);
    assert(Buffer.byteLength(JSON.stringify({ messages: page.messages, history: page.history })) <= 48 * 1024);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_THINKING|PRIVATE_TOOL|PRIVATE_ARGUMENT/);
    collected.unshift(...page.history.map((item) => item.id));
    assert(pages < 100, "pagination must make progress");
  }
  assert(pages > 10);
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected).size, collected.length);
  assert.equal(page.historyPage.nextCursor, null);
  const recent = await reader.read(args);
  assert.equal(recent.history.at(-1).id, "live-new");
  assert.equal(recent.historyPage.branchId, branchId);
});

test("history cursors survive cache rebuilds but reject branch switches, replacement, and foreign or private anchors", async (t) => {
  const { file, root, id } = await fixture(t);
  const entries = [header(id), message("u1", null, "user", "one"),
    { type: "custom", customType: "PRIVATE_CUSTOM", id: "hidden", parentId: "u1", data: { private: "PRIVATE_BODY" } },
    message("a1", "hidden", "assistant", "two"), message("u2", "a1", "user", "three")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const args = { sessionFile: file, sessionId: id, maxMessages: 1 };
  const reader = new VisibleTranscriptReader();
  const recent = await reader.read(args); const before = recent.historyPage.nextCursor;
  const restarted = new VisibleTranscriptReader();
  assert.equal((await restarted.read(args)).historyPage.branchId, recent.historyPage.branchId);
  assert.deepEqual((await restarted.read({ ...args, before })).history.map((item) => item.id), ["a1"]);
  const parts = JSON.parse(Buffer.from(before, "base64url").toString());
  for (const [index, value] of [[1, "other-session"], [2, "0".repeat(64)], [3, "hidden"], [3, "missing"]]) {
    const forged = [...parts]; forged[index] = value;
    await assert.rejects(reader.read({ ...args, before: Buffer.from(JSON.stringify(forged)).toString("base64url") }),
      (error) => error.code === "history_cursor_stale");
  }
  for (const invalid of ["", "not-json", "=", "x".repeat(2049), Buffer.from("[1]").toString("base64url")]) {
    await assert.rejects(reader.read({ ...args, before: invalid }), (error) => error.code === "invalid_history_cursor");
  }
  await appendFile(file, `${JSON.stringify(message("retry", "u1", "assistant", "new active answer"))}\n`);
  await assert.rejects(reader.read({ ...args, before }), (error) => error.code === "history_cursor_stale");
  const changed = await reader.read(args);
  assert.notEqual(changed.historyPage.branchId, recent.historyPage.branchId);
  assert.equal((await new VisibleTranscriptReader().read(args)).historyPage.branchId, changed.historyPage.branchId);
  const older = await reader.read({ ...args, before: changed.historyPage.nextCursor });
  assert.deepEqual(older.history.map((item) => item.id), ["u1"]);
  assert.equal(older.historyPage.hasMore, false);
  const replacement = path.join(root, "replacement.jsonl");
  await writeFile(replacement, `${entries.map(JSON.stringify).join("\n")}\n`);
  await rename(replacement, file);
  assert.notEqual((await reader.read(args)).historyPage.branchId, recent.historyPage.branchId);
  await assert.rejects(reader.read({ ...args, before }), (error) => error.code === "history_cursor_stale");
});

test("concurrent cursor reads retain separate boundaries and privacy projections", async (t) => {
  const { file, id } = await fixture(t);
  await writeFile(file, `${[header(id), message("one", null, "user", "one"),
    message("two", "one", "assistant", "<!-- taihou.presentation.v1 body=happy face=smile -->\nTwo."),
    message("three", "two", "assistant", "three")].map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id, maxMessages: 1 };
  const recent = await reader.read(args);
  const middle = await reader.read({ ...args, before: recent.historyPage.nextCursor });
  const [root, child, oldest] = await Promise.all([
    reader.read({ ...args, before: recent.historyPage.nextCursor, sanitizePresentation: true }),
    reader.read({ ...args, before: recent.historyPage.nextCursor }),
    reader.read({ ...args, before: middle.historyPage.nextCursor }),
  ]);
  assert.equal(root.messages[0].text, "Two.");
  assert.match(child.messages[0].text, /taihou\.presentation/);
  assert.equal(oldest.messages[0].id, "one");
});

test("oversized escaped communication rows remain traversable within the page byte bound", async (t) => {
  const { file, id } = await fixture(t);
  const entries = [header(id), message("oldest", null, "user", "oldest"),
    { type: "custom", customType: CHILD_CREATION_ENTRY_TYPE, id: "creation", parentId: "oldest",
      timestamp: "2026-01-01T00:00:00Z", data: { taskId: "task", childId: "child", childName: "child", relationship: "child", body: "\"".repeat(32 * 1024) } },
    message("large", "creation", "assistant", "😀".repeat(40 * 1024)),
    message("newest", "large", "user", "newest")];
  await writeFile(file, `${entries.map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id, maxMessages: 1 };
  const ids = []; let before;
  do {
    const page = await reader.read({ ...args, ...(before ? { before } : {}) });
    assert.equal(page.history.length, 1);
    assert(Buffer.byteLength(JSON.stringify({ messages: page.messages, history: page.history })) <= 48 * 1024);
    ids.unshift(page.history[0].id); before = page.historyPage.nextCursor;
  } while (before);
  assert.deepEqual(ids, ["oldest", "creation", "large", "newest"]);
});


test("a stale cursor cannot reject concurrent valid latest, title, image, or branch reads", async (t) => {
  const { file, id } = await fixture(t);
  const user = message("u1", null, "user", "Review the canonical history path.");
  user.message.content.push({ type: "image", data: PNG_1X1, mimeType: "image/png" });
  await writeFile(file, `${[header(id), user, message("a1", "u1", "assistant", "Earlier answer."),
    message("u2", "a1", "user", "Continue.")].map(JSON.stringify).join("\n")}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id, maxMessages: 1, sanitizePresentation: true };
  const recent = await reader.read(args);
  await appendFile(file, `${JSON.stringify(message("a2", "u1", "assistant",
    "<!-- taihou.presentation.v1 body=happy face=smile -->\nCurrent answer."))}\n`);
  const results = await Promise.allSettled([
    reader.read({ ...args, before: recent.historyPage.nextCursor }),
    reader.read(args),
    reader.read(args),
    reader.read({ ...args, includeTitleTurn: true }),
    reader.readImage({ sessionFile: file, sessionId: id, entryId: "u1", index: 0, sanitizePresentation: true }),
    reader.readBranch({ sessionFile: file, sessionId: id, leafId: "a2" }),
  ]);
  assert.deepEqual(results.map((result) => result.status === "rejected" ? result.reason.code : "fulfilled"),
    ["history_cursor_stale", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"],
    "each queued reader must evaluate its own cursor and projection after the previous read settles");
  for (const index of [1, 2, 3]) {
    assert.deepEqual(results[index].value.messages.map((item) => item.text), ["Current answer."]);
    assert.notEqual(results[index].value.historyPage.branchId, recent.historyPage.branchId);
  }
  assert.deepEqual(results[3].value.titleTurn, { userText: "Review the canonical history path.", assistantText: "Current answer." });
  assert.equal(results[4].value.data, PNG_1X1);
  assert.deepEqual(results[5].value.entries.map((entry) => entry.id), ["u1", "a2"]);
  await assert.rejects(reader.read({ ...args, before: recent.historyPage.nextCursor }), (error) => error.code === "history_cursor_stale");
});


test("queued reads still reject canonical source failures after independent scheduling", async (t) => {
  const { file, id } = await fixture(t);
  await writeFile(file, `${JSON.stringify(header("wrong-session"))}\n`);
  const reader = new VisibleTranscriptReader(); const args = { sessionFile: file, sessionId: id };
  const results = await Promise.allSettled([reader.read(args), reader.read({ ...args, includeTitleTurn: true })]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /session header does not match registry identity/);
  }
});
