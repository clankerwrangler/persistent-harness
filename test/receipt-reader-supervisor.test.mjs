import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessClient } from "../src/client.mjs";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";
import { normalizeInputImages } from "../src/input-images.mjs";

const image = normalizeInputImages([{ type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }])[0];
class ReceiptActor extends EventEmitter {
  constructor(options, ready) { super(); this.session = options.session; this.ready = ready;
    this.pid = process.pid; this.isRunning = false; this.submits = []; this.closes = 0; }
  state() { return { sessionId: this.session.sessionId, sessionFile: this.session.sessionFile,
    isStreaming: false, model: null, thinkingLevel: "off" }; }
  async start() { await this.ready; this.isRunning = true; return this.state(); }
  async request(type) { assert.equal(type, "get_state", "Proven historical internal input must not reach command submission"); return this.state(); }
  async submit(message, behavior, images, inputId) { this.submits.push({ message, behavior, images, inputId }); return { outcome: "accepted" }; }
  send() {}
  async close() { if (!this.isRunning) return; this.closes += 1; this.isRunning = false;
    this.emit("exit", { code: 0, signal: "SIGTERM", expected: true, error: null }); }
}
async function eventually(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("Receipt reconciliation did not complete within the fixture bound");
}

test("real reader and supervisor recover historical inputs, skip only ambiguity, and recheck without replay", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "receipt-reader-supervisor-"));
  const skillsPath = path.join(directory, "skills"); await mkdir(skillsPath);
  const ready = Promise.withResolvers(), actors = [], socketPath = path.join(directory, "supervisor.sock");
  let client, sessionFile;
  const supervisor = new HarnessSupervisor({ socketPath, databasePath: path.join(directory, "harness.sqlite"),
    pidPath: path.join(directory, "supervisor.pid"), logPath: path.join(directory, "supervisor.jsonl"), skillsPath,
    actorInactivityMs: 0, backgroundJobsDirectory: path.join(directory, "background"), runtimeProvisioner: async () => ({}),
    actorFactory: options => { const actor = new ReceiptActor(options, ready.promise); actors.push(actor); return actor; },
    processIdentityFactory: async pid => ({ version: 1, pid, processGroup: pid, startTime: "fixture", ownerToken: "fixture" }),
    processTerminator: async () => ({ terminated: true }) });
  t.after(async () => { ready.resolve(); await client?.stop(); await supervisor.stop();
    if (sessionFile) await rm(sessionFile, { force: true }); await rm(directory, { recursive: true, force: true }); });
  await supervisor.start(); client = new HarnessClient({ socketPath, heartbeatMs: 0 });
  await client.start({ registrationType: "register_client", clientInstanceId: "receipt-reader-integration" });
  const { admission } = await client.request("create_root", { cwd: directory, repositoryRoot: null, name: "Receipt reader integration",
    provider: null, model: null, thinkingLevel: null });
  const sessionId = admission.sessionId;
  const inputEvents = []; let inputEventOverflow = false;
  client.on("event", frame => {
    if (frame.event !== "actor_event" || frame.data?.sessionId !== sessionId || frame.data.event?.type !== "input_state") return;
    if (inputEvents.length < 16) inputEvents.push(frame.data.event.message); else inputEventOverflow = true;
  });
  await client.request("subscribe_session", { selector: sessionId, passive: true });
  const deliveredEvents = inputId => inputEvents.filter(message => message.id === inputId && message.delivery?.state === "delivered");
  const canonicalImages = entryId => [{ type: "image", mimeType: image.mimeType, name: "Pasted image 1",
    size: Buffer.from(image.data, "base64").length, ref: { entryId, index: 0 } }];
  const selectedFile = supervisor.store.getSession(sessionId).sessionFile;
  const allowed = [directory, process.env.HOME, process.env.PI_CODING_AGENT_DIR].filter(Boolean).map(root => path.resolve(root) + path.sep);
  assert(allowed.some(root => path.resolve(selectedFile).startsWith(root)), "The fixture must not write outside its private roots");
  sessionFile = selectedFile; await mkdir(path.dirname(sessionFile), { recursive: true });
  let existing = "";
  try { existing = await readFile(sessionFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const initial = existing.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert(initial.length === 0 || (initial[0].type === "session" && initial[0].id === sessionId
    && initial.slice(1).every(entry => entry.type === "session_info")), "Only the SDK header/name metadata may precede fixture history");
  const initialLeaf = initial.length > 1 ? initial.at(-1).id : null;
  const now = Date.now(), timestamp = new Date(now + 1).toISOString(), suffix = inputId => `\n\n<!-- persistent-harness-input:${inputId} -->`;
  const reserve = (inputId, message, extra = {}) => supervisor.store.createActorInput(sessionId, { inputId, message, images: [image], ...extra }, now);
  const native = reserve("historical-native", "/template raw input");
  const legacy = reserve("historical-cron", "Scheduled original work", { source: "cron", origin: { jobId: "job", runId: "run" } });
  const custom = reserve("historical-background", "Completed original work", { source: "background", origin: { jobId: "job" } });
  const activeInput = reserve("active-canonical", "Raw ordinary active body");
  const ambiguous = reserve("ambiguous", "Ambiguous exact body", { behavior: "follow_up" });
  const absent = reserve("absent", "An actually absent user input");
  const user = (id, parentId, text, inputId) => ({ type: "message", id, parentId, timestamp,
    message: { role: "user", ...(inputId ? { id: inputId } : {}), content: [{ type: "text", text }, image] } });
  const entries = [user("native-original", initialLeaf, "Expanded original body" + suffix("literal-expansion"), native.inputId),
    user("legacy-original", "native-original", legacy.message + suffix(legacy.inputId)),
    { type: "custom_message", id: "custom-original", parentId: "legacy-original", timestamp, ...actorInputCustomPayload(custom) },
    user("active-root", initialLeaf, "Separate active branch"),
    user("active-original", "active-root", "Expanded ordinary active body", activeInput.inputId),
    user("weak-a", "active-original", ambiguous.message + suffix(ambiguous.inputId)),
    user("weak-b", "weak-a", ambiguous.message + suffix(ambiguous.inputId)),
    user("native-quotation", "weak-b", native.message + suffix(native.inputId))];
  if (!initial.length) await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: directory }) + "\n");
  else if (!existing.endsWith("\n")) await appendFile(sessionFile, "\n");
  await appendFile(sessionFile, entries.map(JSON.stringify).join("\n") + "\n");
  const historyBefore = await readFile(sessionFile), pendingBefore = supervisor.store.getActorInput(ambiguous.inputId, sessionId);
  ready.resolve(); await client.request("get_actor_state", { sessionId });
  const actor = actors[0];
  await eventually(() => (actor.submits.length === 1 && deliveredEvents(activeInput.inputId).length > 0) || actor.closes > 0);
  assert.deepEqual(actor.submits.map(input => input.inputId), [absent.inputId]); assert.equal(actor.closes, 0); assert(actor.isRunning);
  for (const [input, entryId] of [[native, "native-original"], [legacy, "legacy-original"], [custom, "custom-original"]]) {
    const receipt = supervisor.store.getActorInput(input.inputId, sessionId);
    assert.equal(receipt.state, "completed"); assert.equal(receipt.entryId, entryId); assert.equal(receipt.delivery.state, "delivered");
  }
  assert.equal(deliveredEvents(activeInput.inputId).length, 1, "Normal active delivery publishes once");
  assert.equal(deliveredEvents(activeInput.inputId)[0].text, "Expanded ordinary active body");
  assert.deepEqual(deliveredEvents(activeInput.inputId)[0].images, canonicalImages("active-original"));
  for (const input of [native, legacy, custom]) assert.equal(deliveredEvents(input.inputId).length, 0, "Inactive completion must not publish an input upsert");
  assert.deepEqual(supervisor.store.getActorInput(ambiguous.inputId, sessionId), pendingBefore);
  assert.deepEqual(await readFile(sessionFile), historyBefore, "Reconciliation never rewrites canonical history");
  const view = await client.request("get_visible_messages", { sessionId });
  for (const field of ["inputAssociationStates", "inputIds", "inputEntries", "inputDeliveries"]) assert.equal(Object.hasOwn(view, field), false);
  const rawBoundary = await supervisor.transcriptReader.read({ sessionFile, sessionId, publicView: true });
  assert(!view.messages.some(row => [native.inputId, legacy.inputId, custom.inputId].includes(row.id)),
    "Inactive/public boundary: " + JSON.stringify({ publicRows: view.messages.map(({ id, entryId, role }) => ({ id, entryId, role })),
      rawRows: rawBoundary.messages.map(({ id, entryId, role }) => ({ id, entryId, role })), leafId: rawBoundary.leafId,
      inputEntries: rawBoundary.inputEntries, states: rawBoundary.inputAssociationStates,
      pending: supervisor.store.listPendingActorInputs(sessionId).map(({ inputId, state }) => ({ inputId, state })) }));
  const quotation = view.messages.find(row => row.id === "native-quotation");
  assert.equal(quotation.text, native.message + suffix(native.inputId)); assert.equal(quotation.delivery, undefined);
  assert.equal(view.messages.find(row => row.id === ambiguous.inputId).delivery.state, "accepted");
  const strong = user("resolved-native", "native-quotation", "Actual transformed ambiguity resolution", ambiguous.inputId);
  await appendFile(sessionFile, JSON.stringify(strong) + "\n");
  await client.request("submit_input", { sessionId, message: "Continue unrelated work", behavior: "auto", clientRequestId: "valid-next" });
  await eventually(() => supervisor.store.getActorInput(ambiguous.inputId, sessionId).state === "completed"
    && actor.submits.length === 2 && deliveredEvents(ambiguous.inputId).length > 0);
  assert.equal(supervisor.store.getActorInput(ambiguous.inputId, sessionId).entryId, strong.id);
  assert.equal(actor.submits[0].inputId, absent.inputId);
  assert.equal(actor.submits[1].message, "Continue unrelated work");
  assert(![native.inputId, legacy.inputId, custom.inputId, ambiguous.inputId].includes(actor.submits[1].inputId));
  await client.request("get_visible_messages", { sessionId });
  assert.equal(deliveredEvents(ambiguous.inputId).length, 1, "Resolved active incorporation publishes once");
  const resolvedEvent = deliveredEvents(ambiguous.inputId)[0];
  assert.equal(resolvedEvent.entryId, strong.id); assert.equal(resolvedEvent.text, "Actual transformed ambiguity resolution");
  assert.deepEqual(resolvedEvent.images, canonicalImages(strong.id));
  assert.equal(resolvedEvent.createdAt, new Date(ambiguous.acceptedAt).toISOString());
  assert.equal(deliveredEvents(activeInput.inputId).length, 1);
  for (const input of [native, legacy, custom]) assert.equal(deliveredEvents(input.inputId).length, 0);
  assert.equal(inputEventOverflow, false, "The fixture records a bounded set of input updates");
  assert.equal(actor.closes, 0); assert.equal(actors.length, 1); assert.equal(supervisor.store.getSession(sessionId).lifecycle, "resident");
  const log = await readFile(path.join(directory, "supervisor.jsonl"), "utf8");
  assert.match(log, /actor_input_unresolved/); assert.doesNotMatch(log, /Ambiguous exact body|Scheduled original work|Completed original work|"digest"/);
});
