import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { actorInputCustomPayload, actorInputPrompt, PROTOCOL_VERSION, validateRequest } from "../src/protocol.mjs";
import { retryBranchMessage, retryIntentForRequest } from "../src/session-actions.mjs";
import { PiSessionActor } from "../src/session-actor.mjs";
import { HarnessStore } from "../src/store.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { acceptedNativeRuntime, writeWorkerFixture } from "./fixtures/accepted-native-runtime.mjs";

const gate = (name, body) => test(name, { timeout: 30000 }, body);
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
const textOf = (messages) => messages.flatMap(message => typeof message.content === "string" ? [message.content]
  : (message.content ?? []).filter(part => part.type === "text").map(part => part.text)).join("\n");
const parseLines = (data) => data.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const assistant = (text) => ({ role: "assistant", id: `app-${text}`, content: [{ type: "text", text }],
  api: "openai-completions", provider: "retry-context-fixture", model: "replay", stopReason: "stop", timestamp: 20,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

async function fixture(t, { source = "user", prior = false, cancel = false, replied = true } = {}) {
  const manifest = await acceptedNativeRuntime();
  const { SessionManager } = await import(pathToFileURL(manifest.sdk).href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "retry-context-rpc-"));
  const agentDir = path.join(dir, "agent"), file = path.join(dir, "session.jsonl"), database = path.join(dir, "harness.sqlite"), log = path.join(dir, "provider.jsonl");
  await mkdir(agentDir); await writeFile(file, ""); await writeFile(log, "");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  const manager = SessionManager.open(file, dir, dir), sessionId = manager.getSessionId();
  const store = new HarnessStore(database); let actor; const events = [];
  t.after(async () => {
    if (process.env.PI_HARNESS_RETRY_CONTEXT_ARTIFACTS) {
      await mkdir(process.env.PI_HARNESS_RETRY_CONTEXT_ARTIFACTS, { recursive: true });
      await writeFile(path.join(process.env.PI_HARNESS_RETRY_CONTEXT_ARTIFACTS, `${t.name.replace(/[^a-z0-9]/gi, "-")}.json`),
        JSON.stringify({ sessionId, records: parseLines(await readFile(log, "utf8")), events, stderr: actor?.stderr }, null, 2));
    }
    await actor?.close(); store.close(); await rm(dir, { recursive: true, force: true });
  });
  store.createRoot({ sessionId, sessionFile: file, cwd: dir, name: "Retry fixture", actorToken: "fixture-owner" }, 1);
  let priorId = null;
  if (!replied) manager.appendMessage(assistant("PRIOR_COMPLETED_RESPONSE"));
  if (prior) priorId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "PRIOR_USER_CONTEXT" }], timestamp: 5 });
  const origin = source === "cron" ? { jobId: "job", runId: "run" } : source === "background" ? { jobId: "job" } : null;
  const input = store.createActorInput(sessionId, { inputId: "original-input", message: "  EXACT_ORIGINAL_INPUT\nlast line ", images: [image], source, origin }, 10);
  let inputEntryId;
  if (source === "user") inputEntryId = manager.appendMessage({ role: "user", id: input.inputId,
    content: [{ type: "text", text: input.message }, image], timestamp: 10 });
  else {
    const payload = actorInputCustomPayload(input);
    inputEntryId = manager.appendCustomMessageEntry(payload.customType, payload.content, payload.display, payload.details);
  }
  store.completeActorInput(input.inputId, sessionId, 20, inputEntryId);
  let answerId;
  if (replied) { manager.appendMessage(assistant("ORIGINAL_FIRST_ITEM")); answerId = manager.appendMessage(assistant("ORIGINAL_LAST_ITEM")); }
  const env = { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_HARNESS_ACTOR_ID: sessionId, PI_HARNESS_ACTOR_TOKEN: "fixture-owner", PI_HARNESS_ACTOR_GENERATION: "1",
    PI_HARNESS_AUTO_INSTALL: "0", PI_HARNESS_PI_COMMAND: manifest.cli, PI_HARNESS_PI_MODULE: manifest.sdk,
    RETRY_FIXTURE_AI_MODULE: manifest.api,
    RETRY_FIXTURE_DATABASE: database, RETRY_FIXTURE_LOG: log, RETRY_FIXTURE_CANCEL_TREE: cancel ? "1" : "0" };
  const launch = await writeWorkerFixture(dir, path.join(import.meta.dirname, "fixtures/retry-context-provider.mjs"));
  actor = new PiSessionActor({ command: launch.command, args: [...launch.args,"--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "ipython",
    "--provider", "retry-context-fixture", "--model", "replay", "--session", file],
    cwd: dir, env, requestTimeoutMs: 15000, shutdownTimeoutMs: 1000 });
  actor.on("event", event => events.push(event));
  await actor.start();
  assert((await actor.request("get_commands")).commands.some(command => command.name === "persistent-harness-branch"), actor.stderr);
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (id, target) => store.getActorInput(id, target) });
  return { actor, store, reader, file, sessionId, input, inputEntryId, answerId, priorId, events,
    records: async () => parseLines(await readFile(log, "utf8")) };
}

async function submitAndSettle(f, input) {
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { f.actor.off("event", listener); reject(new Error(`Retry did not settle: ${f.actor.stderr}`)); }, 15000);
    const listener = event => { if (event.type === "agent_settled") { clearTimeout(timer); f.actor.off("event", listener); resolve(); } };
    f.actor.on("event", listener);
  });
  if (input.source === "user") await f.actor.submit(input.message, "auto", input.images, input.inputId);
  else await f.actor.request("prompt", { message: actorInputPrompt(input.inputId) });
  await settled;
}

for (const source of ["user", "cron", "background"]) for (const prior of [false, true]) {
  gate(`stock-worker Retry rebuilds ${source} context at ${prior ? "a preceding user" : "root"} without the abandoned response`, async t => {
    const f = await fixture(t, { source, prior });
    const params = validateRequest({ version: PROTOCOL_VERSION, id: "request", type: "submit_input", params: {
      sessionId: f.sessionId, retryOriginal: true, retryOf: f.answerId, clientRequestId: "attempt" } }).params;
    const resolved = await f.reader.resolveRetryInput({ sessionFile: f.file, sessionId: f.sessionId, assistantId: params.retryOf });
    assert.equal(resolved.userId, f.inputEntryId); assert.equal(resolved.branchFromId, f.priorId);
    const bytes = await readFile(f.file), inode = (await stat(f.file)).ino;
    assert.match(textOf((await f.actor.request("get_messages")).messages), /ORIGINAL_FIRST_ITEM/);
    await f.actor.request("prompt", { message: retryBranchMessage(resolved.userId) });
    const afterNavigation = (await f.actor.request("get_messages")).messages;
    const navigationLeaf = (await f.actor.request("get_entries")).leafId;
    const retryIntent = retryIntentForRequest(params);
    const input = f.store.createActorInput(f.sessionId, { inputId: "fresh-input", ...resolved.input,
      retryIntent, clientMessageId: params.clientRequestId }, 30);
    await submitAndSettle(f, input);
    const records = await f.records(), requests = records.filter(record => record.type === "provider");
    assert.equal(requests.length, 1, `Expected one next provider context, without summary inference: ${JSON.stringify(f.events.filter(event => event.type === "extension_error" || event.type === "message_end"))}`);
    assert.doesNotMatch(textOf(requests[0].messages), /ORIGINAL_FIRST_ITEM|ORIGINAL_LAST_ITEM/);
    assert.equal(textOf(requests[0].messages).split("EXACT_ORIGINAL_INPUT").length - 1, 1);
    assert.equal(requests[0].messages.flatMap(message => message.content).filter(part => part.type === "image").length, 1);
    assert.equal(textOf(requests[0].messages).includes("PRIOR_USER_CONTEXT"), prior);
    assert.doesNotMatch(textOf(afterNavigation), /ORIGINAL_FIRST_ITEM|ORIGINAL_LAST_ITEM|EXACT_ORIGINAL_INPUT/);
    assert.equal(navigationLeaf, resolved.branchFromId);
    assert.equal(records.filter(record => record.type === "tree").length, 1);
    assert.equal(records.find(record => record.type === "before_tree").preparation.targetId, resolved.userId);
    assert.equal(records.find(record => record.type === "before_tree").preparation.userWantsSummary, false);
    const entries = (await f.actor.request("get_entries")).entries;
    const admitted = entries.find(entry => entry.message?.id === input.inputId || entry.details?.inputId === input.inputId);
    assert(admitted);
    assert.equal(admitted.type, source === "user" ? "message" : "custom_message");
    if (source !== "user") { assert.equal(admitted.details.source, source); assert.deepEqual(admitted.details.origin, f.input.origin); }
    assert.equal((await stat(f.file)).ino, inode);
    assert.deepEqual((await readFile(f.file)).subarray(0, bytes.length), bytes, "Retry only appends; it never rewrites old JSONL bytes");
    const priorReceipt = f.store.matchActorInputRequest(f.sessionId, { inputId: input.inputId, retryIntent, clientMessageId: params.clientRequestId });
    assert.equal(priorReceipt.inputId, input.inputId); assert.equal(priorReceipt.source, source);
    assert.equal((await f.records()).filter(record => record.type === "provider").length, 1);
  });
}

gate("stock-worker Retry cancellation leaves actual model messages unchanged without dispatch", async t => {
  const f = await fixture(t, { source: "background", cancel: true });
  const before = await f.actor.request("get_messages"), leaf = (await f.actor.request("get_entries")).leafId;
  await f.actor.request("prompt", { message: retryBranchMessage(f.inputEntryId) });
  assert.deepEqual(await f.actor.request("get_messages"), before);
  assert.equal((await f.actor.request("get_entries")).leafId, leaf);
  assert.equal((await f.records()).filter(record => record.type === "provider" || record.type === "tree").length, 0);
  assert(f.events.some(event => event.type === "extension_error" && /cancelled/.test(event.error)));
});

gate("stock-worker input-only Retry is rejected rather than treating navigation no-op as a rewind", async t => {
  const f = await fixture(t, { source: "user", replied: false });
  const before = await f.actor.request("get_messages"), leaf = (await f.actor.request("get_entries")).leafId;
  await f.actor.request("prompt", { message: retryBranchMessage(f.inputEntryId) });
  assert.deepEqual(await f.actor.request("get_messages"), before);
  assert.equal((await f.actor.request("get_entries")).leafId, leaf);
  assert.equal((await f.records()).length, 0);
  assert(f.events.some(event => event.type === "extension_error" && /assistant response/.test(event.error)));
});

for (const source of ["user", "cron", "background"]) gate(`stock-worker explicit edit of ${source} Retry retains genuine-user text and images`, async t => {
  const f = await fixture(t, { source, prior: true });
  const params = validateRequest({ version: PROTOCOL_VERSION, id: "request", type: "submit_input", params: {
    sessionId: f.sessionId, retryOf: f.answerId, clientRequestId: "edited-attempt", message: "  EXPLICIT_USER_EDIT\nexact end ", images: [image] } }).params;
  const turn = await f.reader.resolveRetryTurn({ sessionFile: f.file, sessionId: f.sessionId, assistantId: params.retryOf });
  await f.actor.request("prompt", { message: retryBranchMessage(turn.userId) });
  const retryIntent = retryIntentForRequest(params);
  const input = f.store.createActorInput(f.sessionId, { inputId: "edited-input", message: params.message, images: params.images,
    source: "user", origin: null, retryIntent, clientMessageId: params.clientRequestId }, 30);
  await submitAndSettle(f, input);
  const requests = (await f.records()).filter(record => record.type === "provider");
  assert.equal(requests.length, 1); assert.doesNotMatch(textOf(requests[0].messages), /ORIGINAL_FIRST_ITEM|ORIGINAL_LAST_ITEM|EXACT_ORIGINAL_INPUT/);
  assert.equal(textOf(requests[0].messages).split("EXPLICIT_USER_EDIT").length - 1, 1);
  assert.match(textOf(requests[0].messages), /PRIOR_USER_CONTEXT/);
  const messages = (await f.actor.request("get_messages")).messages;
  const user = messages.find(message => message.id === input.inputId);
  assert.equal(user.role, "user"); assert.deepEqual(user.content, [{ type: "text", text: params.message }, image]);
  const prior = f.store.matchActorInputRequest(f.sessionId, { inputId: input.inputId, message: params.message, images: params.images,
    retryIntent, clientMessageId: params.clientRequestId });
  assert.equal(prior.source, "user"); assert.equal(prior.origin, null);
});
