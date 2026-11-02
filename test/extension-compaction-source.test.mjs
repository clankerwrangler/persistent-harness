import assert from "node:assert/strict";
import { test } from "node:test";

test("compaction-purpose context source does not scan or flush pending actor inputs", async () => {
  const saved = { id: process.env.PI_HARNESS_ACTOR_ID, token: process.env.PI_HARNESS_ACTOR_TOKEN, generation: process.env.PI_HARNESS_ACTOR_GENERATION };
  Object.assign(process.env, { PI_HARNESS_ACTOR_ID: "offline-fixture", PI_HARNESS_ACTOR_TOKEN: "offline-token", PI_HARNESS_ACTOR_GENERATION: "1" });
  try {
    const { default: factory } = await import("../src/extension.mjs?compaction-purpose-fixture");
    const handlers = new Map(), commands = new Map();
    const pi = new Proxy({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command), events: { on() {}, emit() {} } }, { get: (object, key) => object[key] ?? (() => {}) });
    factory(pi);
    let scans = 0;
    const ctx = { sessionManager: { getSessionId: () => "offline-fixture", getEntries() { scans++; throw new Error("PENDING_INPUT_SCAN"); } } };
    // Set the command context without creating a client or accepting a command.
    const delivery = [...commands.values()].find(command => command.description === "Deliver a supervisor-reserved internal input to this actor");
    await assert.rejects(delivery.handler("%", ctx));
    assert.equal(await handlers.get("context_source")({ purpose: "compaction" }), undefined);
    assert.equal(scans, 0);
    await assert.rejects(handlers.get("context_source")({}), /PENDING_INPUT_SCAN/);
    assert.equal(scans, 1, "ordinary inference keeps its input flush");
  } finally {
    for (const [key, value] of [["PI_HARNESS_ACTOR_ID", saved.id], ["PI_HARNESS_ACTOR_TOKEN", saved.token], ["PI_HARNESS_ACTOR_GENERATION", saved.generation]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
