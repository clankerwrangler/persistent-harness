// Explicit SDK source/package fixture; no model/provider requests, live histories or credentials.
import assert from "node:assert/strict";
import fs, { mkdtemp, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { SessionHistoryIndex } from "../../src/session-history-index.mjs";
import { SDKWorker } from "../../src/sdk-worker.mjs";

if (!process.argv[2]) throw new Error("supply the explicit SDK module exporting SessionManager");
const { SessionManager } = await import(pathToFileURL(path.resolve(process.argv[2])));
const root = await mkdtemp(path.join(os.tmpdir(), "owned-append-sdk-integration-"));
let index, worker;
const originalOpen = fs.open;
try {
  const manager = SessionManager.create(root, root, { entryRetention: { maxCachedBytes: 0, indexCachePath: path.join(root, "entry.index") } });
  manager.appendCustomEntry("public padding", { text: "x".repeat(256 * 1024) });
  const first = manager.appendMessage({ role: "user", content: "public seed", timestamp: 1 });
  const source = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() };
  const frames = [];
  const session = { sessionManager: manager, subscribe: () => () => {}, dispose() {}, settingsManager: { flush: async () => {} } };
  worker = new SDKWorker({ session, coordinator: { close: async () => {} }, runner: { invalidate() {} }, broker: { close() {} },
    publish() {}, publishSourceWatermark: watermark => { frames.push({ type: "source_watermark", watermark }); } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick(); assert.equal(frames.length, 1);
  index = new SessionHistoryIndex({ databasePath: path.join(root, "history.sqlite") });
  const refresh = () => index.refresh([source], { automatic: true, sourceWatermark: frames.at(-1).watermark });
  await refresh();
  let bytesRead = 0;
  fs.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file === source.sessionFile) { const read = handle.read.bind(handle);
      handle.read = async (...args) => { const result = await read(...args); bytesRead += result.bytesRead; return result; }; }
    return handle;
  };
  syncBuiltinESMExports();
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const beforeBytes = (await stat(source.sessionFile)).size, beforeReads = bytesRead, beforeFrames = frames.length;
    manager.appendCustomEntry("public custom", { i });
    manager.appendSessionInfo("public name"); manager.appendLabelChange(first, "public label");
    manager.appendModelChange("public provider", "public model"); manager.appendThinkingLevelChange("high");
    manager.appendMessage({ role: "user", content: "public owned suffix", timestamp: i + 2 });
    await tick(); assert.equal(frames.length, beforeFrames + 1, "six persistence appends coalesce to one source frame");
    assert.deepEqual((await refresh()).errors, []);
    const archiveBytes = (await stat(source.sessionFile)).size, suffixBytes = archiveBytes - beforeBytes;
    assert.equal(bytesRead - beforeReads, suffixBytes);
    samples.push({ archiveBytes, suffixBytes, refreshBytes: bytesRead - beforeReads });
  }
  const snapshot = await index.search({ sessions: [source], query: "owned suffix", snapshot: true });
  assert.equal(snapshot.matches.length, 3); assert.equal(snapshot.freshness.unverifiedPrefixSources, 1);
  const beforeStrict = bytesRead; await index.refresh([source]);
  assert.equal(bytesRead - beforeStrict, (await stat(source.sessionFile)).size);
  const beforeBranch = frames.at(-1).watermark.epoch;
  manager.branch(first); manager.appendMessage({ role: "user", content: "public selected branch", timestamp: 10 });
  await tick(); assert.ok(frames.at(-1).watermark.epoch > beforeBranch);
  const beforeRecovery = bytesRead; await refresh(); assert.ok(bytesRead - beforeRecovery > 256 * 1024);
  assert.equal((await index.search({ sessions: [source], query: "owned suffix", snapshot: true })).matches.length, 0);
  await worker.close(); worker = null;
  const beforeClose = frames.length; manager.appendCustomEntry("public after close", {}); await tick(); assert.equal(frames.length, beforeClose);
  console.log(JSON.stringify({ status: "passed", samples, strictAndBranchRecovery: true, unsubscribe: true }));
} finally {
  fs.open = originalOpen; syncBuiltinESMExports();
  await worker?.close(); index?.close(); await rm(root, { recursive: true, force: true });
}
