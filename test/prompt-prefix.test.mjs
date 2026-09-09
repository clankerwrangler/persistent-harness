import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PROMPT_PREFIX,
  MAX_PREFIX_TEXT_BYTES,
  PromptPrefixError,
  formatPrefixPrompt,
  loadPromptPrefix,
  projectPromptPrefix,
  promptPrefixPath,
  savePromptPrefix,
  validatePromptPrefix,
} from "../src/prompt-prefix.mjs";

async function tempPrefix(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-prompt-prefix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "state", "prompt-prefix.json");
  return { root, filePath };
}

function assertPrefixError(error, code, status) {
  assert.equal(error instanceof PromptPrefixError, true);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
}

test("prompt prefix path uses PI_CODING_AGENT_DIR then the default agent dir", () => {
  assert.equal(
    promptPrefixPath({ PI_CODING_AGENT_DIR: "/tmp/agent-home" }),
    path.join("/tmp/agent-home", "state", "prompt-prefix.json"),
  );
  assert.equal(promptPrefixPath({}), path.join(os.homedir(), ".pi", "agent", "state", "prompt-prefix.json"));
});

test("missing prompt prefix file is a disabled empty record", async (t) => {
  const { filePath } = await tempPrefix(t);
  const loaded = await loadPromptPrefix({ filePath });
  assert.deepEqual(loaded, { enabled: false, text: "" });
  assert.deepEqual(loaded, { ...DEFAULT_PROMPT_PREFIX });
  assert.deepEqual(projectPromptPrefix(loaded), { enabled: false, text: "", applied: false });
  assert.equal(formatPrefixPrompt(loaded), "");
});

test("valid prompt prefix loads and emits stored text verbatim", async (t) => {
  const { filePath } = await tempPrefix(t);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify({ enabled: true, text: "  Stand by.  " }, null, 2)}\n`, { mode: 0o600 });
  const loaded = await loadPromptPrefix({ filePath });
  assert.deepEqual(loaded, { enabled: true, text: "  Stand by.  " });
  assert.deepEqual(projectPromptPrefix(loaded), { enabled: true, text: "  Stand by.  ", applied: true });
  assert.equal(formatPrefixPrompt(loaded), "  Stand by.  ");
});

test("empty text is not applied; whitespace-only text is applied verbatim when enabled", () => {
  const disabled = projectPromptPrefix({ enabled: false, text: "keep me" });
  assert.deepEqual(disabled, { enabled: false, text: "keep me", applied: false });
  assert.equal(formatPrefixPrompt({ enabled: false, text: "keep me" }), "");
  const empty = projectPromptPrefix({ enabled: true, text: "" });
  assert.deepEqual(empty, { enabled: true, text: "", applied: false });
  assert.equal(formatPrefixPrompt({ enabled: true, text: "" }), "");
  const blank = projectPromptPrefix({ enabled: true, text: "  \n\t  " });
  assert.deepEqual(blank, { enabled: true, text: "  \n\t  ", applied: true });
  assert.equal(formatPrefixPrompt({ enabled: true, text: "  \n\t  " }), "  \n\t  ");
});

test("validatePromptPrefix rejects extra keys, non-objects, arrays, NUL, and oversize text", () => {
  for (const value of [null, [], "x", 1, true]) {
    assert.throws(() => validatePromptPrefix(value), (error) => {
      assertPrefixError(error, "invalid_prompt_prefix", 400);
      return true;
    });
  }
  assert.throws(() => validatePromptPrefix({ enabled: false, text: "", extra: 1 }), /only enabled and text/);
  assert.throws(() => validatePromptPrefix({ enabled: "false", text: "" }), /boolean/);
  assert.throws(() => validatePromptPrefix({ enabled: false, text: 1 }), /string/);
  assert.throws(() => validatePromptPrefix({ enabled: true, text: "a\u0000b" }), /NUL/);
  assert.throws(() => validatePromptPrefix({ enabled: true, text: "x".repeat(MAX_PREFIX_TEXT_BYTES + 1) }), /32768/);
  assert.deepEqual(validatePromptPrefix({ enabled: false, text: "" }), { enabled: false, text: "" });
});

test("load rejects extra keys, oversize files, invalid JSON, and non-UTF-8", async (t) => {
  const { filePath } = await tempPrefix(t);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify({ enabled: false, text: "", extra: true })}\n`);
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
  await writeFile(filePath, "not-json");
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
  await writeFile(filePath, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
  await writeFile(filePath, "x".repeat(64 * 1024 + 1));
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
});

test("load rejects symlink and non-file destinations", async (t) => {
  const { root, filePath } = await tempPrefix(t);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const target = path.join(root, "secret.txt");
  await writeFile(target, `${JSON.stringify({ enabled: true, text: "nope" })}\n`);
  await symlink(target, filePath);
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
  await rm(filePath);
  await mkdir(filePath);
  await assert.rejects(loadPromptPrefix({ filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
});

test("atomic save writes exact keys, owner-only modes, and replaces without leftover temps", async (t) => {
  const { root, filePath } = await tempPrefix(t);
  const saved = await savePromptPrefix({ enabled: true, text: "Hold the line." }, { filePath });
  assert.deepEqual(saved, { enabled: true, text: "Hold the line." });
  const raw = await readFile(filePath, "utf8");
  assert.equal(raw, `${JSON.stringify({ enabled: true, text: "Hold the line." }, null, 2)}\n`);
  const fileInfo = await stat(filePath);
  assert.equal(fileInfo.isFile(), true);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  const dirInfo = await stat(path.dirname(filePath));
  assert.equal(dirInfo.isDirectory(), true);
  assert.equal(dirInfo.mode & 0o777, 0o700);
  const names = await readdir(path.dirname(filePath));
  assert.deepEqual(names, ["prompt-prefix.json"]);
  await savePromptPrefix({ enabled: false, text: "Hold the line." }, { filePath });
  const disabled = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(disabled, { enabled: false, text: "Hold the line." });
  assert.deepEqual(projectPromptPrefix(disabled), { enabled: false, text: "Hold the line.", applied: false });
  assert.equal((await lstat(filePath)).isSymbolicLink(), false);
  assert.equal((await readdir(path.dirname(filePath))).includes("prompt-prefix.json"), true);
  assert.equal((await readdir(root)).includes("state"), true);
  await chmod(filePath, 0o600);
});

test("save refuses to replace a symlink or non-file and does not follow it", async (t) => {
  const { root, filePath } = await tempPrefix(t);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const target = path.join(root, "secret.txt");
  await writeFile(target, "secret-bytes\n", { mode: 0o600 });
  await symlink(target, filePath);
  await assert.rejects(savePromptPrefix({ enabled: true, text: "overwrite" }, { filePath }), (error) => {
    assertPrefixError(error, "corrupt_prompt_prefix", 422);
    return true;
  });
  assert.equal((await lstat(filePath)).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), "secret-bytes\n");
});
