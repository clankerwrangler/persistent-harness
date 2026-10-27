import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionInternals } from "../src/extension.mjs";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

const support = path.resolve(import.meta.dirname, "../python-runtime");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

test("a real kernel delivers a show-only image to the display part and only a note to the model", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-files-show-"));
  const previousIpythonDir = process.env.IPYTHONDIR; process.env.IPYTHONDIR = path.join(root, "ipython");
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({ skills: [], consent: async () => true });
  const kernel = new PythonKernel({ pythonPath: runtime.pythonPath, kernelScript: path.join(support, "kernel.py"), runtimeSupportDir: support,
    cwd: root, stateDir: path.join(root, "state"), manifest: { version: 1, skills: [] }, hostHandlers: {} });
  t.after(async () => {
    kernel.interrupt(); await kernel.close({ snapshot: false });
    if (previousIpythonDir === undefined) delete process.env.IPYTHONDIR; else process.env.IPYTHONDIR = previousIpythonDir;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  // The same bundle files.show() returns, without a host round trip.
  const result = await kernel.execute(`from _persistent_harness import SkillResult
from IPython.display import display
display(SkillResult({"fileName": "card.png", "shownTo": "user only"},
  {"application/x-harness-shown-image": {"mimeType": "image/png", "data": "${PNG}", "fileName": "card.png"}}))`);
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  const { content, details } = extensionInternals.pythonToolResult(result);
  assert.equal(content.some((part) => part.type === "image"), false);
  assert.match(content.map((part) => part.text ?? "").join("\n"), /Image shown to Commander: card\.png/);
  assert.equal(details.shownImages?.[0]?.data, PNG);
  // The bundle files.attachment() returns: the image reaches the model and is marked for the user.
  const attached = extensionInternals.pythonToolResult(await kernel.execute(`from _persistent_harness import SkillResult
from IPython.display import display
display(SkillResult({"fileName": "card.png"}, {"image/png": "${PNG}", "application/x-harness-for-user": True}))`));
  assert.equal(attached.content.filter((part) => part.type === "image").length, 1);
  assert.equal(attached.details.imagesForUser, true);
});
