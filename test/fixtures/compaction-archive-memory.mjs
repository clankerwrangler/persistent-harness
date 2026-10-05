import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";
import net from "node:net";
import http from "node:http";
import https from "node:https";

const deny = () => { throw new Error("Memory fixture cannot use a provider or network"); };
mock.method(globalThis, "fetch", deny);
mock.method(net.Socket.prototype, "connect", deny);
mock.method(http, "request", deny); mock.method(https, "request", deny);
const { buildSessionProjection } = await import(pathToFileURL(process.env.PI_HARNESS_PI_MODULE));
const { createCompactionDriver } = await import(process.argv[2]
  ? pathToFileURL(process.argv[2]) : new URL("../../src/actor-compaction.mjs", import.meta.url));
const stamp = phase => console.log(JSON.stringify({ phase, ...process.memoryUsage() }));
// Distinct flattened two-byte strings model large opaque archived checkpoints.
// The current model context is only a short summary and one user message.
const entries = Array.from({ length: 51 }, (_, i) => ({ type: "custom", id: `e${i}`,
  parentId: i ? `e${i - 1}` : null, customType: "opaque-history",
  data: { nested: [JSON.parse(JSON.stringify(`${i}${"旅".repeat(1024 * 1024)}`))] } }));
entries.push({ type: "compaction", id: "checkpoint", parentId: "e50", summary: "short summary",
  firstKeptEntryId: "checkpoint", tokensBefore: 1 });
entries.push({ type: "message", id: "tail", parentId: "checkpoint",
  message: { role: "user", content: "current question", timestamp: 1 } });
for (const entry of entries) entry.timestamp = "2026-10-05T00:00:00.000Z";
const manager = { getEntries: () => entries.slice(), getLeafId: () => "tail", getSessionId: () => "synthetic" };
const session = { sessionManager: manager, isIdle: true, model: { id: "synthetic" }, extensionRunner: {} };
const preparation = { firstKeptEntryId: "tail", previousSummary: "short summary", messagesToSummarize: [],
  turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1, settings: {},
  fileOps: { read: new Set(["retained"]), written: new Set(), edited: new Set() } };
let hooks = 0, providers = 0;
const runner = { createContext: () => ({}), emit: event => {
  if (event.type !== "session_before_compact") return;
  hooks++;
  assert.deepEqual(event.branchEntries, entries);
  assert.notEqual(event.branchEntries[0].data.nested, entries[0].data.nested);
  assert(event.preparation.fileOps.read instanceof Set);
  event.branchEntries[0].data.nested[0] = "hook-local replacement";
  event.preparation.fileOps.read.add("hook-local file");
  stamp("cancel_hook");
  return { cancel: true };
} };
const driver = createCompactionDriver({ sdk: { buildSessionProjection }, session, runner,
  capture: { read: async () => preparation }, models: { streamSimple: () => { providers++; deny(); } },
  publish: event => stamp(event.type) });
stamp("baseline");
await assert.rejects(driver({ automatic: true, coordinator: { manager, session },
  signal: new AbortController().signal }), { code: "ERR_COMPACTION_CANCELLED" });
assert.equal(hooks, 1); assert.equal(providers, 0);
assert.equal(entries.length, 53); assert.equal(entries[0].data.nested[0].length, 1024 * 1024 + 1);
assert.deepEqual([...preparation.fileOps.read], ["retained"]);
stamp("verified");
mock.restoreAll();
