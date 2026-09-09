import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extensionInternals } from "../src/extension.mjs";
import { PythonKernel } from "../src/kernel.mjs";
import { encodeFrame } from "../src/framing.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { createHostHandlers } from "../src/host-handlers.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";

const project = (result) => extensionInternals.pythonToolResult(result).content;
const images = (result) => project(result).filter((part) => part.type === "image").map((part) => part.data);
const renderedText = (result) => project(result).filter((part) => part.type === "text").map((part) => part.text).join("\n");
const support = path.resolve(import.meta.dirname, "../python-runtime");
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-rich-output-"));
  const previousIpythonDir = process.env.IPYTHONDIR;
  process.env.IPYTHONDIR = path.join(root, "ipython");
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  const kernel = new PythonKernel({ pythonPath: runtime.pythonPath,
    kernelScript: path.join(support, "kernel.py"), runtimeSupportDir: support,
    cwd: root, stateDir: path.join(root, "state"), manifest: { version: 1, skills: [] },
    hostHandlers: {}, ...options });
  t.after(async () => {
    kernel.interrupt(); await kernel.close({ snapshot: false });
    if (previousIpythonDir === undefined) delete process.env.IPYTHONDIR;
    else process.env.IPYTHONDIR = previousIpythonDir;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return kernel;
}

const setupImages = `from IPython.display import Image, display
import base64
red_image = Image(data=base64.b64decode("${PNG_A}"))
blue_image = Image(data=base64.b64decode("${PNG_B}"))`;

test("actual kernel forwards explicit display inside a conditional", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  assert.equal((await kernel.execute(setupImages)).ok, true);
  assert.equal((await kernel.execute("red_image")).mime?.["image/png"], PNG_A,
    "The existing final-expression image path must remain available");
  const result = await kernel.execute("if True:\n    display(red_image)");
  assert.equal(result.ok, true);
  assert.equal(result.mime?.["image/png"], PNG_A,
    "Explicit IPython display must reach the actual kernel result");
});


test("actual kernel and extension preserve repeated displays and stream order exactly once", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages);
  const result = await kernel.execute(`import sys
print("BEFORE")
if True:
    display(red_image)
print("BETWEEN", file=sys.stderr)
display(blue_image)
print("AFTER")`);
  assert.equal(result.ok, true);
  assert.deepEqual(images(result), [PNG_A, PNG_B]);
  const observed = [];
  for (const part of project(result)) {
    if (part.type === "image") observed.push(part.data === PNG_A ? "red" : "blue");
    else for (const marker of ["BEFORE", "BETWEEN", "AFTER"]) if (part.text.includes(marker)) observed.push(marker);
  }
  assert.deepEqual(observed, ["BEFORE", "red", "BETWEEN", "blue", "AFTER"]);
  for (const marker of ["BEFORE", "BETWEEN", "AFTER"]) assert.equal(renderedText(result).split(marker).length - 1, 1);
  assert.match(result.stdout, /BEFORE/); assert.match(result.stdout, /AFTER/); assert.match(result.stderr, /BETWEEN/);
});

test("actual final, awaited, and assigned results retain MIME without inventing displays", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(`from _persistent_harness import SkillResult
image_result = SkillResult({"label": "SINGLE-METADATA"}, {"image/png": "${PNG_A}", "text/x-diff": "DIFF-MARKER"})`);
  for (const code of ["image_result", "await image_result"]) {
    const result = await kernel.execute(code);
    assert.equal(result.ok, true); assert.deepEqual(images(result), [PNG_A]);
    assert.equal(renderedText(result).split("SINGLE-METADATA").length - 1, 1);
    assert.match(renderedText(result), /DIFF-MARKER/);
  }
  const assigned = await kernel.execute("saved_image = image_result");
  assert.deepEqual(images(assigned), []); assert.deepEqual(assigned.outputs, []);
  assert.deepEqual(images(await kernel.execute("saved_image")), [PNG_A]);
  const printed = await kernel.execute("print(image_result)");
  assert.deepEqual(images(printed), []); assert.match(printed.stdout, /SINGLE-METADATA/);
  assert.doesNotMatch(renderedText(printed), /DIFF-MARKER/);
  assert.deepEqual(images(await kernel.execute("import json\njson.dumps(image_result)")), []);
  assert.deepEqual(images(await kernel.execute("image_result, 42")), []);
  const none = await kernel.execute("None");
  assert.deepEqual(none.outputs, []); assert.deepEqual(images(none), []);
});

test("actual display output survives errors and does not leak into the next cell", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages);
  const result = await kernel.execute('display(red_image)\nraise ValueError("planned-rich-error")');
  assert.equal(result.ok, false); assert.equal(result.errorType, "ValueError");
  assert.deepEqual(images(result), [PNG_A]); assert.match(renderedText(result), /planned-rich-error/);
  const next = await kernel.execute('print("CLEAN-NEXT")');
  assert.equal(next.ok, true); assert.deepEqual(images(next), []);
  assert.doesNotMatch(renderedText(next), /planned-rich-error|Image object/);
});

test("actual display output survives cancellation without accepting a stale host completion", { timeout: 30_000 }, async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), finished = Promise.withResolvers();
  t.after(() => release.resolve());
  const kernel = await fixture(t, {
    manifest: { version: 1, skills: [{ id: "fixture", alias: "fixture", version: "1", skillPath: import.meta.filename,
      instructions: "Local rich-output fixture.", python: { srcPath: support, importName: "_persistent_harness", hostRequests: ["rich.gate"] } }] },
    hostHandlers: { "rich.gate": async (_payload, { onProgress }) => {
      entered.resolve(); await release.promise; onProgress("stdout", "STALE-RICH-PROGRESS"); finished.resolve(); return "late";
    } },
  });
  await kernel.execute(setupImages);
  const controller = new AbortController();
  const execution = kernel.execute('display(red_image)\nfixture.host_request("rich.gate", {})', { signal: controller.signal });
  await entered.promise; controller.abort();
  const result = await execution;
  assert.equal(result.ok, false); assert.deepEqual(images(result), [PNG_A]);
  release.resolve(); await finished.promise;
  const next = await kernel.execute('print("AFTER-CANCEL")');
  assert.equal(next.ok, true); assert.deepEqual(images(next), []);
  assert.doesNotMatch(renderedText(next), /STALE-RICH-PROGRESS|Image object/);
});

test("actual rich frames and their aggregate are bounded without losing legal single images", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages);
  const large = await kernel.execute('large_image = Image(data=base64.b64decode("' + PNG_A + '") + b"x" * 400000)\nlarge_image');
  assert.equal(large.ok, true); assert.equal(images(large).length, 1); assert.equal(large.truncated, false);
  const repeated = await kernel.execute("display(large_image)\ndisplay(large_image)\ndisplay(blue_image)");
  assert.equal(repeated.ok, true); assert.equal(repeated.truncated, true);
  assert.deepEqual(images(repeated), [images(large)[0], PNG_B]);
  assert(repeated.richOutputBytes <= 1024 * 1024);
  assert.equal(renderedText(repeated).split("rich output truncated").length - 1, 1);
  const oversized = await kernel.execute('display(Image(data=base64.b64decode("' + PNG_A + '") + b"x" * 900000))');
  assert.equal(oversized.ok, true); assert.equal(oversized.truncated, true); assert.deepEqual(images(oversized), []);
  assert.match(renderedText(oversized), /rich output truncated/);
  assert.equal((await kernel.execute("40 + 2")).mime["text/plain"], "42");
});

test("actual text limits, rich text, and native streams keep their existing capabilities", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t, { maxOutputBytes: 16 });
  const limited = await kernel.execute('import sys\nprint("字" * 20)\nprint("e" * 40, file=sys.stderr)');
  assert.equal(limited.ok, true); assert.equal(limited.truncated, true);
  assert(Buffer.byteLength(limited.stdout.split("\n[...")[0]) <= 16);
  assert(Buffer.byteLength(limited.stderr.split("\n[...")[0]) <= 16);
  assert.doesNotMatch(limited.stdout, /�/);
  const displayedText = await kernel.execute('from IPython.display import display\ndisplay("x" * 2000)');
  assert.equal(displayedText.truncated, true); assert.match(displayedText.stdout, /output truncated at 16 bytes/);
  const richText = await kernel.execute('"r" * 2000');
  assert.equal(richText.ok, true); assert.equal(richText.mime["text/plain"].length, 2002);
  const native = await kernel.execute('import os\nos.write(1, b"NATIVE-OUT\\n")\nos.write(2, b"NATIVE-ERR\\n")\nNone');
  assert.equal(native.ok, true); assert.match(native.stdout, /NATIVE-OUT/); assert.match(native.stderr, /NATIVE-ERR/);
  const streams = await kernel.execute('import io, sys\nassert isinstance(sys.stdout, io.TextIOBase)\nassert sys.stdout.fileno() == 1\nassert sys.stderr.fileno() == 2\nsys.stdout.writelines(["LINES", "-OK"])');
  assert.equal(streams.ok, true); assert.equal(streams.stdout, "LINES-OK");
  const borrowed = await kernel.execute('borrowed = type(sys.stdout)(sys.__stdout__, "stdout")\ndel borrowed\nprint("BORROWED-OK")');
  assert.equal(borrowed.ok, true); assert.match(borrowed.stdout, /BORROWED-OK/);
});


test("cancelling during repeated image output keeps the control protocol usable", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages + '\nlarge_image = Image(data=base64.b64decode("' + PNG_A + '") + b"x" * 400000)');
  const controller = new AbortController(); let cancelled = false;
  const execution = kernel.execute('display(red_image)\nprint("IMAGE-READY")\nfor _ in range(100):\n    display(large_image)', {
    signal: controller.signal,
    onUpdate: (partial) => {
      assert.equal(partial.outputs, undefined, "Text progress must not repeatedly replay image payloads");
      assert.equal(partial.mime, undefined);
      if (!cancelled && partial.stdout.includes("IMAGE-READY")) {
        cancelled = true; controller.abort();
      }
    },
  });
  const result = await execution;
  assert.equal(cancelled, true); assert.equal(result.ok, false);
  assert.equal(result.errorType, "KeyboardInterrupt");
  assert.equal(images(result).filter((data) => data === PNG_A).length, 1);
  const next = await kernel.execute("40 + 2");
  assert.equal(next.ok, true); assert.equal(next.mime["text/plain"], "42");
});


test("a legal single rich frame survives JSON re-encoding expansion", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  const result = await kernel.execute('from _persistent_harness import SkillResult\nSkillResult({}, {"application/json": [1e20] * 100000})');
  assert.equal(result.ok, true); assert.equal(result.truncated, false,
    "A previously legal single control frame must not be rejected after JSON number expansion");
  assert.equal(result.mime["application/json"].length, 100000);
  assert(Buffer.byteLength(JSON.stringify(result.mime)) > 1024 * 1024);
  assert(result.richOutputBytes <= result.richOutputLimit);
});


test("actual host-backed files attachment reaches the paired formatter through explicit display", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rich-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "actual-attachment.png");
  await writeFile(imagePath, Buffer.from(PNG_A, "base64"));
  const skills = process.env.PI_HARNESS_SKILLS_PATH || path.resolve(support, "../skills");
  const catalog = await discoverSkills([{ source: "skill", path: path.join(skills, "files/SKILL.md") }]);
  assert.deepEqual(catalog.diagnostics, []);
  const kernel = await fixture(t, { manifest: manifestForSkills(catalog.skills), hostHandlers: createHostHandlers({ cwd: root }) });
  const result = await kernel.execute(`from IPython.display import display
if True:
    display(files.attachment(${JSON.stringify(imagePath)}))`);
  assert.equal(result.ok, true); assert.deepEqual(images(result), [PNG_A]);
  assert.equal(renderedText(result).split("actual-attachment.png").length - 1, 2,
    "The one metadata mapping contains the path and fileName, not repeated display output");
});


test("actual final values keep complete repr while explicit and rich formatting stay intact", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages);
  assert.deepEqual(images(await kernel.execute("red_image")), [PNG_A]);
  assert.deepEqual(images(await kernel.execute("if True:\n    display(blue_image)")), [PNG_B]);
  const custom = await kernel.execute(`class CustomDisplay:
    def __repr__(self):
        return "COMPLETE-REPR"
    def _repr_pretty_(self, printer, cycle):
        printer.text("CUSTOM-PRETTY")
custom_display = CustomDisplay()
display(custom_display)`);
  assert.match(custom.stdout, /CUSTOM-PRETTY/);
  const rich = await kernel.execute(`bundle_calls = 0
class RichFinal:
    def __repr__(self):
        return "FALLBACK-REPR"
    def _repr_mimebundle_(self, include=None, exclude=None):
        global bundle_calls
        bundle_calls += 1
        return {"text/plain": "CUSTOM-BUNDLE", "image/png": "${PNG_A}"}
RichFinal()`);
  assert.equal(rich.ok, true); assert.equal(rich.truncated, false);
  assert.deepEqual(images(rich), [PNG_A]);
  assert.equal(renderedText(rich).split("CUSTOM-BUNDLE").length - 1, 1);
  assert.doesNotMatch(renderedText(rich), /FALLBACK-REPR/);
  assert.equal((await kernel.execute("bundle_calls")).mime["text/plain"], "1");
  for (const length of [5, 1100]) {
    const result = await kernel.execute(`[0] * ${length} + ["FINAL-TAIL-SENTINEL"]`);
    assert.equal(result.ok, true); assert.equal(result.truncated, false);
    const expected = "[" + [...Array(length).fill("0"), "'FINAL-TAIL-SENTINEL'"].join(", ") + "]";
    assert(result.mime["text/plain"] === expected,
      "A previously legal final value must retain its complete representation");
    assert.equal(renderedText(result).split("FINAL-TAIL-SENTINEL").length - 1, 1);
  }
  const registered = await kernel.execute(`get_ipython().display_formatter.formatters["text/html"].for_type(CustomDisplay, lambda value: "<b>CUSTOM-HTML</b>")
custom_display`);
  assert.equal(registered.mime["text/plain"], "COMPLETE-REPR");
  assert.equal(registered.mime["text/html"], "<b>CUSTOM-HTML</b>");
  const badRepr = await kernel.execute(`class BadRepr:
    def __repr__(self):
        raise ValueError("planned-final-repr-error")
BadRepr()`);
  assert.equal(badRepr.ok, false); assert.equal(badRepr.errorType, "ValueError");
  const nextDisplay = await kernel.execute("display(custom_display)");
  assert.match(nextDisplay.stdout, /CUSTOM-PRETTY/,
    "Final-result formatting must not change the shell's explicit display formatter");
});


test("a legal final rich result survives explicit display pressure", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages + '\nnear_limit = Image(data=base64.b64decode("' + PNG_A + '") + b"x" * 786250)');
  assert.deepEqual(images(await kernel.execute("blue_image")), [PNG_B]);
  const plain = await kernel.execute('display({"text/plain": "x" * 1048000}, raw=True)\nblue_image');
  assert.equal(plain.ok, true); assert.equal(plain.truncated, true);
  assert.deepEqual(images(plain), [PNG_B], "Explicit plain text keeps its existing stream budget");
  const result = await kernel.execute('print("PRESSURE-BEFORE")\ndisplay(near_limit)\nprint("PRESSURE-BETWEEN")\nblue_image');
  assert.equal(result.ok, true); assert.equal(result.truncated, true);
  assert.equal(images(result).length, 1);
  assert(images(result)[0] === PNG_B,
    "Earlier explicit MIME must not consume the capacity of a previously legal final result");
  assert.equal(result.mime["image/png"], PNG_B);
  assert(result.richOutputBytes <= result.richOutputLimit);
  assert.equal(renderedText(result).split("rich output truncated").length - 1, 1);
  const observed = [];
  for (const part of project(result)) {
    if (part.type === "image") observed.push("final-blue");
    else for (const marker of ["PRESSURE-BEFORE", "PRESSURE-BETWEEN"]) if (part.text.includes(marker)) observed.push(marker);
  }
  assert.deepEqual(observed, ["PRESSURE-BEFORE", "PRESSURE-BETWEEN", "final-blue"]);
  const expanded = await kernel.execute('from _persistent_harness import SkillResult\ndisplay(near_limit)\nSkillResult({}, {"application/json": [1e20] * 100000})');
  assert.equal(expanded.ok, true); assert.equal(expanded.truncated, true);
  assert.equal(expanded.mime["application/json"].length, 100000);
  assert(expanded.richOutputBytes <= expanded.richOutputLimit);
  assert.equal(expanded.outputs.filter(record => record.mime).length, 1);
});

test("multiple final display events stay bounded and oversized finals keep prior output", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  await kernel.execute(setupImages + '\nnear_limit = Image(data=base64.b64decode("' + PNG_A + '") + b"x" * 786250)');
  await kernel.execute('get_ipython().ast_node_interactivity = "all"');
  const repeated = await kernel.execute("near_limit\nnear_limit\nnear_limit\nblue_image");
  assert.equal(repeated.ok, true); assert.equal(repeated.truncated, true);
  assert.equal(images(repeated).length, 1);
  assert(images(repeated)[0] === PNG_B);
  assert(repeated.richOutputBytes <= repeated.richOutputLimit);
  assert.equal(renderedText(repeated).split("rich output truncated").length - 1, 1);
  await kernel.execute('get_ipython().ast_node_interactivity = "last_expr"');
  const oversized = await kernel.execute('display(red_image)\nImage(data=base64.b64decode("' + PNG_B + '") + b"x" * 900000)');
  assert.equal(oversized.ok, true); assert.equal(oversized.truncated, true);
  assert.deepEqual(images(oversized), [PNG_A], "A rejected oversized final must not evict accepted displays");
  const next = await kernel.execute("40 + 2");
  assert.equal(next.ok, true); assert.equal(next.mime["text/plain"], "42");
  assert.deepEqual(images(next), []);
});


test("a final result retains the exact legacy control-frame allowance", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  const maxFrameBytes = 1024 * 1024;
  const id = "0".repeat(36); // Kernel execution IDs are UUIDs of this wire width.
  const overhead = encodeFrame({ type: "result", id, mime: { "text/plain": "''" } }, { maxFrameBytes }).length - 1;
  const tail = "EXACT-WIRE-TAIL";
  const prefixLength = maxFrameBytes - overhead - tail.length;
  const result = await kernel.execute(`"w" * ${prefixLength} + "${tail}"`);
  assert.equal(result.ok, true); assert.equal(result.truncated, false);
  const text = result.mime?.["text/plain"];
  assert.equal(typeof text, "string");
  assert.equal(text.length, prefixLength + tail.length + 2);
  assert(text.startsWith("'w") && text.endsWith(`${tail}'`));
  assert.equal(encodeFrame({ type: "result", id, mime: result.mime }, { maxFrameBytes }).length - 1, maxFrameBytes,
    "Measure protocol metadata as well as MIME bytes; final output must not gain wire overhead");
  const tooLarge = await kernel.execute(`"w" * ${prefixLength + 1} + "${tail}"`);
  assert.equal(tooLarge.ok, true); assert.equal(tooLarge.truncated, true);
  assert.equal(tooLarge.mime, null);
  assert.match(renderedText(tooLarge), /rich output truncated/);
  assert.equal((await kernel.execute("40 + 2")).mime["text/plain"], "42");
});


test("serialized rich details keep canonical MIME once within the existing frame limit", { timeout: 30_000 }, async (t) => {
  const kernel = await fixture(t);
  const result = await kernel.execute(`from _persistent_harness import SkillResult
import sys
print("SERIAL-OUT")
print("SERIAL-ERR", file=sys.stderr)
SkillResult({}, {"application/json": [1e20] * 170000, "image/png": "${PNG_A}", "text/x-diff": "SERIAL-DIFF"})`);
  assert.equal(result.ok, true); assert.equal(result.truncated, false);
  const tool = extensionInternals.pythonToolResult(result);
  assert.deepEqual(images(result), [PNG_A]);
  for (const marker of ["SERIAL-OUT", "SERIAL-ERR", "SERIAL-DIFF"])
    assert.equal(renderedText(result).split(marker).length - 1, 1);
  const frame = encodeFrame(tool);
  const decoded = JSON.parse(frame.toString("utf8"));
  assert.equal(Object.hasOwn(decoded.details, "mime"), false,
    "The derived MIME alias must not duplicate canonical output in serialized details");
  const retained = decoded.details.outputs.find(record => record.mime).mime;
  assert.equal(retained["application/json"].length, 170000);
  assert(retained["application/json"].every(value => value === 1e20));
  assert.equal(retained["image/png"], PNG_A); assert.equal(retained["text/x-diff"], "SERIAL-DIFF");
  assert.equal(result.mime["application/json"].length, 170000,
    "Formatting must not remove the kernel's in-memory summary API");
  for (const key of ["ok", "code", "durationMs", "stdout", "stderr", "truncated", "totalBytes", "richOutputBytes", "richOutputLimit"])
    assert.equal(tool.details[key], result[key]);
  assert.equal(extensionInternals.pythonResultText(tool.details), extensionInternals.pythonResultText(result),
    "The existing renderResult reader must consume the same canonical sequence");
  const legacy = { ...result }; delete legacy.outputs;
  const legacyTool = extensionInternals.pythonToolResult(legacy);
  assert.equal(legacyTool.details.mime["application/json"].length, 170000);
  assert.equal(encodeFrame(legacyTool).length > 0, true);
  assert.deepEqual(legacyTool.content.filter(part => part.type === "image").map(part => part.data), [PNG_A]);
});
