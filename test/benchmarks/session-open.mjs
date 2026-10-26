// Synthetic actual supervisor RPC benchmark; no actors, providers, or private histories.
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, readFile } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
const [repo, axis = "family-long", pageFile] = process.argv.slice(2);
assert(repo && ["visible", "family-short", "family-long", "family-labels", "family-representative"].includes(axis));
const load = name => import(pathToFileURL(path.join(repo, "src", name)).href);
const source = (await readFile(path.join(repo, "src/visible-transcript-reader.mjs"), "utf8"))
  .replaceAll('from "./', 'from "' + pathToFileURL(path.join(repo, "src") + path.sep).href)
  .replace('  #evict() {', '  __probe() { return [...this.#records.values()].map(r => ({ entries: r.entries.size, cacheBytes: r.cacheBytes })); }\n  #evict() {');
const { VisibleTranscriptReader } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const { HarnessSupervisor } = await load("supervisor.mjs");
const { HarnessClient } = await load("client.mjs");
const root = await mkdtemp(path.join(tmpdir(), "open-bench-")), file = path.join(root, "public.jsonl");
const sessionId = "synthetic-open", entries = 70_050;
let readBytes = 0, readCalls = 0, parseEntries = 0, sourceBytes = 0, familyCount = 0, actorStarts = 0;
const originalOpen = fs.open, originalParse = JSON.parse;
const label = ["family-labels", "family-representative"].includes(axis) ? "Synthetic analytical reviewer ".repeat(7) : "Public reviewer";
const text = axis === "family-long" || ["family-labels", "family-representative"].includes(axis) ? "Public synthetic body 😀\\\"\n".repeat(140) : "Public synthetic body";
let supervisor, client;
try {
  const fd = openSync(file, "wx", 0o600);
  try {
    const put = value => { const line = JSON.stringify(value) + "\n"; writeSync(fd, line); sourceBytes += Buffer.byteLength(line); };
    put({ type: "session", version: 3, id: sessionId });
    for (let i = 0; i < entries; i++) {
      const frame = { id: `e${i}`, parentId: i ? `e${i-1}` : null, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() };
      if (axis !== "visible" && i % 5 === 1) {
        familyCount++;
        put({ ...frame, type: "custom_message", customType: "persistent-harness-incoming-message",
          content: "Direct agent message from public reviewer:\n" + text, display: true,
          details: { messageId: `family-${i}`, senderId: "public-peer", senderName: label, relationship: "sibling", body: text } });
      } else put({ ...frame, type: "message", message: { role: axis === "visible" ? i%2 ? "assistant" : "user" : i%5 < 3 ? "toolResult" : i%2 ? "assistant" : "user",
        content: [{ type: "text", text: axis === "family-representative" && i%5 < 3 ? "t".repeat(23_500) : i%23 === 0 ? "Public long ordinary reply 😀\n".repeat(150) : `Public ordinary row ${i} ` + "x".repeat(80) }] } });
    }
  } finally { closeSync(fd); }
  fs.open = async function(name, ...args) {
    const handle = await originalOpen.call(this, name, ...args);
    if (name === file) { const read = handle.read.bind(handle); handle.read = async (...args) => { const value = await read(...args); readCalls++; readBytes += value.bytesRead; return value; }; }
    return handle;
  };
  syncBuiltinESMExports();
  JSON.parse = function(...args) { const value = originalParse.apply(this, args); if (value?.id && ["session", "message", "custom", "custom_message"].includes(value.type)) parseEntries++; return value; };
  const reader = new VisibleTranscriptReader(), stages = [];
  const read = reader.read.bind(reader);
  reader.read = async options => {
    const started = performance.now();
    const value = await read(options);
    stages.push({ elapsedMs: performance.now() - started, readBytes, readCalls, parseEntries, familyResults: Object.keys(value.familyMessages).length, options: { publicView: options.publicView, inputProofIds: options.inputProofIds, familyDeliveryOnly: options.familyDeliveryOnly }, memory: process.memoryUsage() });
    return value;
  };
  const launch = { model: null, thinking: { requested: null, resolved: null, source: "settings" }, capabilities: [] };
  supervisor = new HarnessSupervisor({ socketPath: path.join(root,"s.sock"), databasePath: path.join(root, "state/h.sqlite"), pidPath: path.join(root,"s.pid"),
    scratchDirectory: path.join(root,"scratch"), backgroundJobsDirectory: path.join(root,"background"), transcriptReader: reader,
    actorFactory() { actorStarts++; throw new Error("must not start actors"); }, actorInactivityMs: 0 });
  await supervisor.start();
  supervisor.store.createRoot({ sessionId, sessionFile: file, cwd: root, repositoryRoot: null, name: "Public synthetic session", actorToken: "synthetic-only", launch }, 1);
  client = new HarnessClient({ socketPath: supervisor.socketPath, heartbeatMs: 0, requestTimeoutMs: 360_000 });
  await client.start({ registrationType: "register_client", clientInstanceId: "synthetic-open-benchmark" });
  const samples = [];
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  let previous;
  for (let i = 0; i < 4; i++) {
    readBytes = 0; readCalls = 0; parseEntries = 0;
    if (i === 2) await client.request("unsubscribe_session", { sessionId });
    if (i % 2) await client.request("subscribe_session", { selector: sessionId, passive: true });
    const started = performance.now();
    const value = await client.request("get_visible_messages", { sessionId });
    const page = { messages: value.messages, history: value.history, truncated: value.truncated };
    if (previous) assert.deepEqual(page, previous, "initial, post-subscribe and reopened pages must match");
    previous = page;
    if (pageFile && i === 0) await fs.writeFile(pageFile, JSON.stringify(page, null, 2) + "\n");
    assert(Buffer.byteLength(JSON.stringify({ messages: value.messages, history: value.history })) <= 48 * 1024);
    samples.push({ phase: ["cold-initial", "cold-after-subscribe", "warm-reopen", "warm-after-subscribe"][i], rpcMs: performance.now()-started, readBytes, readCalls, parseEntries,
      outputHash: createHash("sha256").update(JSON.stringify(canonical(page))).digest("hex"), history: value.history.length, messages: value.messages.length, memory: process.memoryUsage() });
  }
  assert.equal(actorStarts, 0);
  console.log(JSON.stringify({ axis, entries, familyCount, sourceBytes, actorStarts, samples, stages, cache: reader.__probe(), noExplicitGc: true, requestTimeoutMs: client.requestTimeoutMs }));
} finally {
  await client?.stop(); await supervisor?.stop(); fs.open=originalOpen; syncBuiltinESMExports(); JSON.parse=originalParse;
  await rm(root, { recursive: true, force: true });
}
