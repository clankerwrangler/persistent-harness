import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InboxStore, createInboxServer, inboxOriginJobId, parseInboxOriginJobId } from "../src/inbox.mjs";
import { actorInputCustomPayload } from "../src/protocol.mjs";

async function fixture(t, { deliver } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-inbox-"));
  const store = new InboxStore(path.join(root, "harness.sqlite"));
  const deliveries = [];
  const server = createInboxServer({ store, logger: { error() {} },
    deliver: deliver ?? (async (message) => { deliveries.push(message); return ["session-a"]; }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (key, body) => {
    const res = await fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  return { store, url, post, deliveries };
}

test("a registered sender's message reaches its route once, even when retried", async (t) => {
  const { store, post, deliveries } = await fixture(t);
  const key = store.addSender("mail-helper", { kind: "news" });
  store.setRoute("mail", { sessionId: "session-a" });
  assert.deepEqual(await post(key, { route: "mail", id: "note-41", text: "New mail from DHL" }), [202, { deliveredTo: ["session-a"] }]);
  assert.deepEqual(deliveries, [{ sender: "mail-helper", kind: "news", route: "mail", target: { sessionId: "session-a" }, messageId: "note-41", text: "New mail from DHL" }]);
  assert.deepEqual(await post(key, { route: "mail", id: "note-41", text: "New mail from DHL" }), [200, { duplicate: true, deliveredTo: ["session-a"] }]);
  assert.equal(deliveries.length, 1);
  assert.equal(store.list().senders[0].lastMessageAt !== null, true);
});

test("unknown keys, unknown routes, bad bodies, and floods are refused without delivery", async (t) => {
  const { store, post, url, deliveries } = await fixture(t);
  const key = store.addSender("noisy", { kind: "news", ratePerHour: 2 });
  store.setRoute("mail", { sessionId: "session-a" });
  assert.equal((await post("not-a-real-key-at-all", { route: "mail", id: "1", text: "hi" }))[0], 401);
  assert.equal((await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post(key, { route: "nowhere", id: "1", text: "hi" }))[0], 404);
  for (const body of [{ route: "mail", id: "bad id!", text: "hi" }, { route: "mail", id: "1", text: " " }, { route: "mail", id: "1", text: "a\u0007b" },
    { route: "mail", id: "1", text: "hi", extra: true }, { route: "mail", id: "1", text: "x".repeat(9000) }]) {
    assert.equal((await post(key, body))[0], 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await post(key, { route: "mail", id: "1", text: "x".repeat(20_000) }))[0], 413);
  assert.equal((await post(key, { route: "mail", id: "a", text: "one" }))[0], 202);
  assert.equal((await post(key, { route: "mail", id: "b", text: "two" }))[0], 202);
  assert.equal((await post(key, { route: "mail", id: "c", text: "three" }))[0], 429);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(await (await fetch(`${url}/v1/health`)).json(), { ok: true });
});

test("a failed delivery is not recorded, so the sender's retry is delivered", async (t) => {
  let fail = true; const delivered = [];
  const { store, post } = await fixture(t, { deliver: async (message) => {
    if (fail) throw Object.assign(new Error("the route's session no longer exists"), { status: 409 });
    delivered.push(message.messageId); return ["session-b"];
  } });
  const key = store.addSender("mail-helper");
  store.setRoute("mail", { sessionId: "gone" });
  assert.deepEqual(await post(key, { route: "mail", id: "n1", text: "hello" }), [409, { error: "the route's session no longer exists" }]);
  fail = false;
  assert.deepEqual(await post(key, { route: "mail", id: "n1", text: "hello" }), [202, { deliveredTo: ["session-b"] }]);
  assert.deepEqual(delivered, ["n1"]);
});

test("senders and routes are validated, keys are replaced on re-registration, and removal works", async (t) => {
  const { store } = await fixture(t);
  for (const name of ["", "Mail", "1mail", "a".repeat(33), "mail_helper"]) assert.throws(() => store.addSender(name), /sender/);
  assert.throws(() => store.addSender("x", { kind: "chat" }), /kind/);
  assert.throws(() => store.setRoute("mail", { sessionId: "a", workingRoots: true }), /target/);
  assert.throws(() => store.setRoute("mail", {}), /target/);
  const first = store.addSender("maint", { kind: "maintenance" });
  const second = store.addSender("maint", { kind: "maintenance" });
  assert.equal(store.authenticate(first), null); assert.equal(store.authenticate(second).kind, "maintenance");
  store.setRoute("maintenance", { workingRoots: true });
  assert.deepEqual(store.list().routes, [{ route: "maintenance", target: { workingRoots: true } }]);
  store.removeSender("maint"); store.removeRoute("maintenance");
  assert.equal(store.authenticate(second), null); assert.deepEqual(store.list(), { senders: [], routes: [] });
});

test("inbox origins round-trip and head the agent's input as a program message, not a user one", () => {
  const jobId = inboxOriginJobId("news", "mail-helper", "note-41");
  assert.deepEqual(parseInboxOriginJobId(jobId), { kind: "news", sender: "mail-helper", messageId: "note-41" });
  assert.equal(parseInboxOriginJobId("bg-123456789abc"), null);
  const payload = actorInputCustomPayload({ source: "background", origin: { jobId }, message: "New mail", inputId: "inbox-1", acceptedAt: 1 });
  assert.match(payload.content, /^Message from mail-helper through the harness inbox \(news, id note-41\)\. This is an internal harness event, not a new user submission\.\n\nNew mail$/);
  const background = actorInputCustomPayload({ source: "background", origin: { jobId: "bg-123456789abc" }, message: "done", inputId: "b", acceptedAt: 1 });
  assert.match(background.content, /^Harness background completion \(job bg-123456789abc\)/);
});
