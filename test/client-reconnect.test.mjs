import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessClient } from "../src/client.mjs";
import { JsonLineDecoder, encodeFrame } from "../src/framing.mjs";
import { errorResponse, event, ProtocolError, protocolErrorFrame, response, validateRequest } from "../src/protocol.mjs";

const actorRegistration = {
  registrationType: "register_actor", sessionId: "fixture-actor", sessionFile: "/tmp/fixture-actor.jsonl",
  cwd: "/tmp", repositoryRoot: null, actorToken: "fixture-token", actorGeneration: 7,
};
const clientRegistration = { registrationType: "register_client", clientInstanceId: "fixture-ui" };

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), message);
}

async function fixture(t, onRegistration, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harness-client-"));
  const socketPath = path.join(directory, "test.sock");
  const sockets = [];
  const registrations = [];
  const requests = [];
  const states = [];
  const events = [];
  const registered = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const decoder = new JsonLineDecoder();
    socket.on("data", (chunk) => {
      for (const raw of decoder.push(chunk)) {
        // Use the real admission-frame validator, but never start a supervisor or provider.
        let request;
        try { request = validateRequest(raw); }
        catch (error) { socket.end(encodeFrame(protocolErrorFrame(error))); continue; }
        if (request.type.startsWith("register_")) {
          registrations.push(request);
          onRegistration(socket, request, registrations.length);
        } else {
          requests.push(request);
          socket.write(encodeFrame(response(request.id, request.type, request.params)));
        }
      }
    });
  });
  const client = new HarnessClient({ socketPath, heartbeatMs: 0, requestTimeoutMs: 100, reconnectBaseMs: 15, reconnectMaxMs: 30, ...options });
  client.on("status", (status) => states.push(status));
  client.on("event", (frame) => events.push(frame));
  client.on("registered", (data) => registered.push(data));
  t.after(async () => {
    await client.stop();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return { client, sockets, registrations, requests, states, events, registered };
}

function admit(socket, request) {
  socket.write(encodeFrame(response(request.id, request.type, {
    session: { sessionId: request.params.sessionId, actorGeneration: request.params.actorGeneration }, limits: {},
  })));
}

for (const registration of [actorRegistration, clientRegistration]) {
  for (const phase of ["initial", "reconnect"]) {
    for (const failure of ["timeout", "close-before-response"]) {
      test(`${registration.registrationType}: ${phase} ${failure} retries and restores delivery`, { timeout: 5000 }, async (t) => {
        const firstFailure = phase === "initial" ? 1 : 2;
        const recoveredAttempt = firstFailure + 2;
        const f = await fixture(t, (socket, request, attempt) => {
          if (attempt >= firstFailure && attempt < recoveredAttempt) {
            if (failure === "close-before-response") socket.destroy();
            return;
          }
          admit(socket, request);
          if (attempt === recoveredAttempt) socket.write(encodeFrame(event("message", { messageId: "queued-1", body: "restored delivery" })));
        });
        const initial = await f.client.start(registration);
        if (phase === "initial") assert.equal(initial, undefined);
        else { assert.ok(initial); f.sockets[0].destroy(); }
        await waitFor(() => f.events.length === 1, "queued delivery resumes on the same client");
        assert.equal(f.registrations.length, recoveredAttempt);
        assert.equal(f.registered.length, phase === "initial" ? 1 : 2);
        assert.equal(f.client.isConnected, true);
        assert.ok(!f.states.some(({ state }) => state === "rejected"));
        assert.equal(f.states.at(-1).state, "connected");
        const { registrationType, ...params } = registration;
        for (const request of f.registrations) {
          assert.equal(request.type, registrationType);
          assert.deepEqual(request.params, params, "retries preserve identity, token, and generation");
        }
        assert.equal(new Set(f.registrations.map(({ id }) => id)).size, recoveredAttempt);
        assert.deepEqual(f.events[0].data, { messageId: "queued-1", body: "restored delivery" });
        assert.deepEqual(await f.client.request("ack_message", { messageId: "queued-1" }), { messageId: "queued-1" });
        assert.equal(f.requests.at(-1).type, "ack_message");
        const attempts = f.registrations.length;
        await sleep(120);
        assert.equal(f.registrations.length, attempts, "successful registration stops retries");
      });
    }
  }
}

for (const phase of ["initial", "reconnect"]) {
  for (const rejection of ["admission", "protocol"]) {
    test(`${phase} explicit ${rejection} rejection stops retries`, { timeout: 5000 }, async (t) => {
      const rejectedAttempt = phase === "initial" ? 1 : 2;
      const f = await fixture(t, (socket, request, attempt) => {
        if (attempt < rejectedAttempt) { admit(socket, request); return; }
        // Actor-store errors use request_failed, not a dedicated authentication code.
        socket.end(encodeFrame(rejection === "admission"
          ? errorResponse(request.id, request.type, "actor generation or token is stale")
          : protocolErrorFrame(new ProtocolError("invalid_request", "registration is invalid"))));
      });
      const initial = await f.client.start(actorRegistration);
      if (phase === "initial") assert.equal(initial, undefined);
      else { assert.ok(initial); f.sockets[0].destroy(); }
      await waitFor(() => f.states.some(({ state }) => state === "rejected"), "explicit rejection is terminal");
      await sleep(180);
      assert.equal(f.registrations.length, rejectedAttempt, "invalid admission must not retry");
      assert.equal(f.sockets.length, rejectedAttempt);
      assert.equal(f.registered.length, phase === "initial" ? 0 : 1);
      assert.equal(f.client.isConnected, false);
      assert.equal(f.states.at(-1).state, "rejected", "retry error handling must not overwrite rejection");
      assert.match(f.states.at(-1).error, rejection === "admission" ? /token is stale/ : /registration is invalid/);
    });
  }
}

test("malformed registration receives a terminal protocol rejection", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, () => assert.fail("invalid registration cannot be admitted"));
  assert.equal(await f.client.start({ ...actorRegistration, actorGeneration: 0 }), undefined);
  await sleep(180);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.registrations.length, 0);
  assert.equal(f.states.at(-1).state, "rejected");
});

test("stop cancels registration without rejection and permits an explicit same-client start", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (socket, request, attempt) => { if (attempt > 1) admit(socket, request); });
  const starting = f.client.start(actorRegistration);
  await waitFor(() => f.registrations.length === 1, "registration starts");
  await f.client.stop();
  assert.equal(await starting, undefined);
  await sleep(180);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.states.at(-1).state, "stopped");
  assert.ok(!f.states.some(({ state }) => state === "rejected"));
  assert.equal(f.registered.length, 0);
  assert.ok(await f.client.start(actorRegistration));
  assert.deepEqual(f.registrations[1].params, f.registrations[0].params);
  assert.deepEqual(await f.client.request("heartbeat"), {});
});

test("stop cancels a scheduled reconnect", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, () => {}, { reconnectBaseMs: 200, reconnectMaxMs: 200 });
  assert.equal(await f.client.start(actorRegistration), undefined);
  await f.client.stop();
  await sleep(300);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.states.at(-1).state, "stopped");
  assert.ok(!f.states.some(({ state }) => state === "rejected"));
});

test("registration response received during stop cannot restore connected state", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (socket, request) => { socket.on("end", () => admit(socket, request)); });
  const starting = f.client.start(actorRegistration);
  await waitFor(() => f.registrations.length === 1, "registration starts");
  await f.client.stop();
  assert.equal(await starting, undefined);
  assert.equal(f.registered.length, 0);
  assert.equal(f.client.connectedSession, undefined);
  assert.equal(f.client.limits, undefined);
  assert.equal(f.states.at(-1).state, "stopped");
});
