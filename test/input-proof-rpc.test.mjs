import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessStore } from "../src/store.mjs";
import { PiSessionActor } from "../src/session-actor.mjs";
import { VisibleTranscriptReader } from "../src/visible-transcript-reader.mjs";
import { normalizeInputImages } from "../src/input-images.mjs";
import { acceptedNativeRuntime, writeWorkerFixture } from "./fixtures/accepted-native-runtime.mjs";

const image = normalizeInputImages([{ type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }])[0];
const textOf = (content) => typeof content === "string" ? content
  : content.filter(part => part.type === "text").map(part => part.text).join("");

for (const [name, prompt, expected] of [
  ["template", "/input-proof-template ALPHA", "Template expanded: ALPHA\n\n<!-- persistent-harness-input:literal-template-text -->"],
  ["input hook", "TRANSFORM_ME", "Actual transformed input\n\n<!-- persistent-harness-input:literal-user-text -->"],
]) test(`actual stock-worker ${name} preserves authoritative input identity without raw-body digest equality`, {
  timeout: 30000,
}, async (t) => {
  const manifest = await acceptedNativeRuntime();
  const dir = await mkdtemp(path.join(os.tmpdir(), "input-proof-rpc-"));
  const agentDir = path.join(dir, "agent"), sessionFile = path.join(dir, "session.jsonl"),
    log = path.join(dir, "provider.jsonl"), sessionId = randomUUID();
  await mkdir(path.join(agentDir, "prompts"), { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
  await writeFile(path.join(agentDir, "prompts", "input-proof-template.md"),
    "---\ndescription: Input proof fixture\n---\nTemplate expanded: $1\n\n<!-- persistent-harness-input:literal-template-text -->");
  await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId,
    timestamp: new Date().toISOString(), cwd: dir }) + "\n");
  await writeFile(log, "");
  const store = new HarnessStore(path.join(dir, "harness.sqlite"));
  store.createRoot({ sessionId, sessionFile, cwd: dir, name: "Input proof", actorToken: "fixture-only" });
  const events = []; let actor;
  t.after(async () => {
    if (process.env.PI_HARNESS_INPUT_PROOF_ARTIFACTS) {
      await mkdir(process.env.PI_HARNESS_INPUT_PROOF_ARTIFACTS, { recursive: true });
      await writeFile(path.join(process.env.PI_HARNESS_INPUT_PROOF_ARTIFACTS, `${name.replaceAll(" ", "-")}.json`),
        JSON.stringify({ sessionId, events, provider: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
          canonical: (await readFile(sessionFile, "utf8")).trim().split("\n").map(JSON.parse), stderr: actor?.stderr }, null, 2));
    }
    await actor?.close(); store.close(); await rm(dir, { recursive: true, force: true });
  });
  const input = store.createActorInput(sessionId, { inputId: `actual-${name.replaceAll(" ", "-")}`,
    message: prompt, images: [image], clientMessageId: "optimistic-control" });
  const env = { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0", PI_HARNESS_AUTO_INSTALL: "0", PI_HARNESS_PI_COMMAND: manifest.cli, PI_HARNESS_PI_MODULE: manifest.sdk,
    INPUT_PROOF_AI_MODULE: manifest.api, INPUT_PROOF_PROVIDER_LOG: log };
  const launch = await writeWorkerFixture(dir, path.join(import.meta.dirname, "fixtures/input-proof-provider.mjs"));
  actor = new PiSessionActor({ command: launch.command, args: [...launch.args,"--mode", "rpc", "--no-extensions", "--no-skills", "--no-themes", "--no-tools",
    "--provider", "input-proof-fixture", "--model", "proof", "--session", sessionFile],
    cwd: dir, env, requestTimeoutMs: 15000, shutdownTimeoutMs: 1000 });
  actor.on("event", event => events.push(event)); await actor.start();
  assert((await actor.request("get_commands")).commands.some(command => command.name === "input-proof-template"), actor.stderr);
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { actor.off("event", listener); reject(new Error(`input did not settle: ${actor.stderr}`)); }, 15000);
    const listener = event => { if (event.type === "agent_settled") { clearTimeout(timer); actor.off("event", listener); resolve(); } };
    actor.on("event", listener);
  });
  assert.equal((await actor.submit(prompt, "auto", [image], input.inputId)).outcome, "accepted");
  await settled;
  const entries = (await actor.request("get_entries")).entries;
  const admitted = entries.find(entry => entry.message?.id === input.inputId);
  assert(admitted, actor.stderr); assert.equal(admitted.message.role, "user");
  assert.equal(textOf(admitted.message.content), expected); assert.notEqual(expected, prompt);
  assert.deepEqual(admitted.message.content.filter(part => part.type === "image"), [image]);
  const reader = new VisibleTranscriptReader({ inputReceiptReader: (id, target) => store.getActorInput(id, target) });
  const before = await readFile(sessionFile), inode = (await stat(sessionFile)).ino;
  for (const completed of [false, true]) {
    if (completed) store.completeActorInput(input.inputId, sessionId, Date.parse(admitted.timestamp), admitted.id);
    reader.clear(sessionFile);
    const visible = await reader.read({ sessionFile, sessionId, publicView: true });
    const row = visible.messages.find(message => message.id === input.inputId);
    assert.equal(row?.entryId, admitted.id); assert.equal(row?.text, expected);
    assert.equal(row.delivery.state, "delivered"); assert.equal(row.clientMessageId, "optimistic-control");
    assert.deepEqual(visible.inputIds, [input.inputId]);
    assert.deepEqual(visible.inputEntries, { [input.inputId]: admitted.id });
    assert.deepEqual(visible.inputDeliveries, { [input.inputId]: { entryId: admitted.id, deliveredAt: admitted.timestamp } });
    assert.deepEqual((await reader.readImage({ sessionFile, sessionId, entryId: admitted.id, index: 0 })), image);
  }
  assert((await readFile(sessionFile)).equals(before)); assert.equal((await stat(sessionFile)).ino, inode);
  assert.throws(() => store.createActorInput(sessionId, { inputId: input.inputId, message: expected, images: [image] }), /different input/,
    "The accepted raw digest differs even though the authenticated application ID is delivered");
  const control = store.createActorInput(sessionId, { inputId: "handled-control", message: "/input-proof-handled exact args" });
  assert.equal((await actor.submit(control.message, "auto", [], control.inputId)).outcome, "handled");
  store.markActorInputHandled(control.inputId, sessionId);
  const afterControl = await reader.read({ sessionFile, sessionId });
  assert.equal(afterControl.inputIds.includes(control.inputId), false);
  assert.equal(store.getActorInput(control.inputId, sessionId).delivery.state, "accepted");
  assert.equal(store.getActorInput(control.inputId, sessionId).deliveredAt, null);
  assert.equal((await actor.request("get_entries")).entries.some(entry => entry.message?.id === control.inputId), false);
  const records = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.filter(record => record.type === "provider").length, 1);
  assert.deepEqual(records.filter(record => record.type === "handled"), [{ type: "handled", args: "exact args" }]);
});
