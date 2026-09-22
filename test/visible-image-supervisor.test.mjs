import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { fixture } from "./fixtures/notification-supervisor.mjs";

const image = { type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };

test("image RPC admits root tool images without exposing child results or changing input delivery", async t => {
  const f = await fixture(t), root = await f.actor(), child = await f.actor(root.session.sessionId);
  const add = async actor => appendFile(actor.session.sessionFile, [
    { type: "message", id: "input", parentId: null, message: { role: "user", content: [image] } },
    { type: "message", id: "output", parentId: "input", message: { role: "toolResult", content: [image] } },
  ].map(JSON.stringify).join("\n") + "\n");
  await add(root); await add(child);
  const get = (sessionId, entryId) => f.client.request("get_visible_image", { sessionId, entryId, index: 0 });
  assert.deepEqual((await get(root.session.sessionId, "output")).image, image);
  await assert.rejects(get(child.session.sessionId, "output"), /does not exist/);
  for (const actor of [root, child]) assert.deepEqual((await get(actor.session.sessionId, "input")).image, image);
  const pending = f.supervisor.store.createActorInput(root.session.sessionId,
    { inputId: "pending-image", message: "", images: [image] });
  assert.deepEqual((await get(root.session.sessionId, pending.inputId)).image, image);
  await assert.rejects(get("missing-session", "output"), /canonical Pi transcript/);
  await assert.rejects(root.connection.request("get_visible_image", { sessionId: root.session.sessionId, entryId: "output", index: 0 }), /not available/);
  f.supervisor.store.deleteSession(child.session.sessionId);
  await assert.rejects(get(child.session.sessionId, "input"), /canonical Pi transcript/);
});
