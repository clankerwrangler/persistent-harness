import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashOf, importLock, partsOf, recheck, recordedSources, setScope, staleModels } from "../bin/model-sources.mjs";

const source = "import x from 'x';\nfunction blink(){return 1}\n\nexport async function pillow(){\n  return 2;\n}\n";

function project(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-sources-"));
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });
  mkdirSync("web"); mkdirSync("models");
  writeFileSync("web/room.mjs", source);
  const hash = hashOf("web/room.mjs", "*");
  writeFileSync("models/Blink.tla", `---- MODULE Blink ----\n\\* Source files: ["web/room.mjs"]\n\\* Last checked source SHA-256: {"web/room.mjs": "${hash}"}\n====\n`);
  writeFileSync("models/Blink.cfg", "");
  importLock("models");
  return hash;
}
const lock = () => JSON.parse(readFileSync("models/sources.lock.json", "utf8"));

test("splits a file at top-level definitions", () => {
  const parts = partsOf("a.mjs", source);
  assert.deepEqual([...parts.keys()], ["(top)", "blink", "pillow"]);
  assert.match(parts.get("pillow"), /return 2/);
  assert.throws(() => partsOf("a.mjs", "function a(){}\nfunction a(){}\n"), /defined twice/);
  assert.deepEqual([...partsOf("a.py", "import x\ndef a():\n  pass\nclass B:\n  pass\n").keys()], ["(top)", "a", "B"]);
  assert.throws(() => partsOf("a.tla", ""), /not supported/);
});

test("reads all three recorded forms", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = "a".repeat(64);
  const listed = path.join(root, "Listed.tla");
  writeFileSync(listed, `---- MODULE Listed ----\n\\* Sources:\n\\*   src/a.mjs sha256:${hash}\n====\n`);
  assert.deepEqual(recordedSources(listed), { "src/a.mjs": hash });
  const paired = path.join(root, "Paired.tla");
  writeFileSync(paired, "---- MODULE Paired ----\n====\n");
  writeFileSync(path.join(root, "Paired.sources.json"), JSON.stringify({ sources: { "src/b.ts": hash }, modelFiles: { "specs/Paired.tla": hash } }));
  assert.deepEqual(recordedSources(paired), { "src/b.ts": hash, "specs/Paired.tla": hash });
});

test("whole-file coverage goes stale on any change", (t) => {
  project(t);
  assert.deepEqual(staleModels(lock(), "models"), {});
  writeFileSync("web/room.mjs", source.replace("return 2", "return 3"));
  assert.deepEqual(staleModels(lock(), "models"), { Blink: ["web/room.mjs"] });
});

test("scoped coverage ignores changes elsewhere and catches its own", (t) => {
  project(t);
  setScope("models", "Blink", "web/room.mjs", ["blink"]);
  writeFileSync("web/room.mjs", source.replace("return 2", "return 3"));
  assert.deepEqual(staleModels(lock(), "models"), {});
  writeFileSync("web/room.mjs", source.replace("return 1", "return 9"));
  assert.deepEqual(staleModels(lock(), "models"), { Blink: ["web/room.mjs"] });
});

test("a part that no longer exists is an error, not a pass", (t) => {
  project(t);
  setScope("models", "Blink", "web/room.mjs", ["blink"]);
  writeFileSync("web/room.mjs", source.replace("function blink", "function wink"));
  assert.throws(() => staleModels(lock(), "models"), /no part named blink/);
});

test("a changed file cannot be narrowed before it is rechecked", (t) => {
  project(t);
  writeFileSync("web/room.mjs", source.replace("return 2", "return 3"));
  assert.throws(() => setScope("models", "Blink", "web/room.mjs", ["blink"]), /recheck it/);
});

test("recheck updates a model only when its configurations hold", async (t) => {
  project(t);
  writeFileSync("web/room.mjs", source.replace("return 2", "return 3"));
  assert.deepEqual(await recheck("models", [], async () => "violation"), { Blink: ["Blink.cfg: violation"] });
  assert.deepEqual(Object.keys(staleModels(lock(), "models")), ["Blink"]);
  writeFileSync("models/expected-results.json", JSON.stringify({ "Blink.cfg": "violation" }));
  assert.deepEqual(await recheck("models", [], async () => "violation"), { Blink: [] });
  assert.deepEqual(staleModels(lock(), "models"), {});
});

test("recheck does not update a model with no configuration", async (t) => {
  project(t);
  rmSync("models/Blink.cfg");
  writeFileSync("web/room.mjs", source.replace("return 2", "return 3"));
  assert.deepEqual(await recheck("models", [], async () => "pass"), { Blink: ["no configuration"] });
  assert.deepEqual(Object.keys(staleModels(lock(), "models")), ["Blink"]);
});

test("editing a model or adding a configuration needs a recheck", async (t) => {
  project(t);
  writeFileSync("models/Blink.tla", `${readFileSync("models/Blink.tla", "utf8")}\n`);
  assert.deepEqual(staleModels(lock(), "models"), { Blink: ["models/Blink.tla"] });
  writeFileSync("models/BlinkExtra.cfg", "");
  assert.deepEqual(staleModels(lock(), "models"), { Blink: ["models/Blink.tla", "models/BlinkExtra.cfg"] });
  assert.deepEqual(await recheck("models", [], async () => "pass"), { Blink: [] });
  assert.deepEqual(staleModels(lock(), "models"), {});
});