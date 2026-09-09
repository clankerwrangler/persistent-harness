import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assembleActorSystemPrompt,
  depthPromptPaths,
  loadDepthPrompt,
  MAX_DEPTH_PROMPT_FILE_BYTES,
  PI_DEFAULT_BE_CONCISE_GUIDELINE,
  PI_DEFAULT_CODING_ASSISTANT_OPENING,
} from "../src/depth-prompt.mjs";

test("depth-scoped instructions follow loaded AGENTS context order and exact depth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-depth-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  await Promise.all([mkdir(globalDir), mkdir(projectDir)]);
  const globalContext = path.join(globalDir, "AGENTS.md");
  const projectContext = path.join(projectDir, "CLAUDE.MD");
  await writeFile(globalContext, "universal global");
  await writeFile(projectContext, "universal project");
  await writeFile(path.join(globalDir, "AGENTS.depth-0.md"), "ROOT PERSONA");
  await writeFile(path.join(globalDir, "AGENTS.depth-1.md"), "CHILD ROLE");
  await writeFile(path.join(projectDir, "CLAUDE.depth-1.MD"), "CHILD PROJECT RULE");
  const contextFiles = [{ path: globalContext }, { path: projectContext }, { path: globalContext }];

  assert.deepEqual(depthPromptPaths(contextFiles, 1), [
    path.join(globalDir, "AGENTS.depth-1.md"),
    path.join(projectDir, "CLAUDE.depth-1.MD"),
  ]);
  const rootPrompt = await loadDepthPrompt(contextFiles, 0);
  assert.match(rootPrompt.prompt, /ROOT PERSONA/);
  assert.doesNotMatch(rootPrompt.prompt, /CHILD ROLE|universal/);
  const childPrompt = await loadDepthPrompt(contextFiles, 1);
  assert.match(childPrompt.prompt, /CHILD ROLE/);
  assert.match(childPrompt.prompt, /CHILD PROJECT RULE/);
  assert.doesNotMatch(childPrompt.prompt, /ROOT PERSONA|universal/);
  assert(childPrompt.prompt.indexOf("CHILD ROLE") < childPrompt.prompt.indexOf("CHILD PROJECT RULE"));
  assert.equal((await loadDepthPrompt(contextFiles, 2)).prompt, "");
});

test("depth-scoped instruction loading is bounded and rejects invalid depth", async () => {
  const contextFiles = [{ path: "/trusted/AGENTS.md" }];
  await assert.rejects(
    loadDepthPrompt(contextFiles, 0, { read: async () => "x".repeat(MAX_DEPTH_PROMPT_FILE_BYTES + 1) }),
    /exceed/,
  );
  await assert.rejects(loadDepthPrompt(contextFiles, -1), /non-negative bounded integer/);
  assert.throws(() => depthPromptPaths(contextFiles, 1.5), /non-negative bounded integer/);
});

const defaultBasePrompt = [
  PI_DEFAULT_CODING_ASSISTANT_OPENING,
  "",
  "Available tools:",
  "- ipython: Execute Python",
  "",
  "Guidelines:",
  "- Use Python for all execution; ordinary Pi tools are unavailable.",
  PI_DEFAULT_BE_CONCISE_GUIDELINE,
  "- Show file paths clearly when working with files",
  "",
  "<project_instructions path=\"/home/example/.pi/agent/AGENTS.md\">",
  "# Problem-Solving Principles",
  "</project_instructions>",
].join("\n");

test("depth 0 puts the depth file first and removes the coding-assistant prime", () => {
  const assembled = assembleActorSystemPrompt({
    depth: 0,
    basePrompt: defaultBasePrompt,
    depthPrompt: "# Depth-scoped instructions\n\nYou are Taihou.",
    skillPrompt: "# Persistent Python skill interface",
  });
  assert.equal(assembled.startsWith("# Depth-scoped instructions"), true);
  assert.ok(assembled.includes("Available tools:"));
  assert.ok(assembled.includes("Problem-Solving Principles"));
  assert.ok(assembled.includes("# Persistent Python skill interface"));
  assert.ok(assembled.indexOf("You are Taihou.") < assembled.indexOf("Available tools:"));
  assert.ok(assembled.indexOf("Available tools:") < assembled.indexOf("# Persistent Python skill interface"));
  assert.equal(assembled.includes(PI_DEFAULT_CODING_ASSISTANT_OPENING), false);
  assert.equal(assembled.includes("Be concise in your responses"), false);
});

test("deeper actors keep Pi default identity and append depth after the base prompt", () => {
  const assembled = assembleActorSystemPrompt({
    depth: 1,
    basePrompt: defaultBasePrompt,
    depthPrompt: "CHILD ROLE",
    skillPrompt: "skills",
  });
  assert.equal(assembled.startsWith(PI_DEFAULT_CODING_ASSISTANT_OPENING), true);
  assert.ok(assembled.includes(PI_DEFAULT_BE_CONCISE_GUIDELINE));
  assert.ok(assembled.indexOf(PI_DEFAULT_CODING_ASSISTANT_OPENING) < assembled.indexOf("CHILD ROLE"));
  assert.ok(assembled.indexOf("CHILD ROLE") < assembled.indexOf("skills"));
});

test("depth 0 leaves a custom base prompt intact except the concise guideline line", () => {
  const assembled = assembleActorSystemPrompt({
    depth: 0,
    basePrompt: "Custom identity.\n\nGuidelines:\n- Be concise in your responses\n- Keep tools.",
    depthPrompt: "PERSONA",
  });
  assert.match(assembled, /^PERSONA\n\nCustom identity\./);
  assert.ok(assembled.includes("- Keep tools."));
  assert.equal(assembled.includes("Be concise in your responses"), false);
});

test("depth 0 puts the commander prefix first verbatim", () => {
  const assembled = assembleActorSystemPrompt({
    depth: 0,
    basePrompt: defaultBasePrompt,
    depthPrompt: "# Depth-scoped instructions\n\nYou are Taihou.",
    skillPrompt: "# Persistent Python skill interface",
    prefixPrompt: "  Stand by.  ",
  });
  assert.equal(assembled.startsWith("  Stand by.  \n\n# Depth-scoped instructions"), true);
  assert.equal(assembled.includes("# Commander prefix"), false);
  assert.ok(assembled.indexOf("  Stand by.  ") < assembled.indexOf("# Depth-scoped instructions"));
  assert.ok(assembled.indexOf("# Depth-scoped instructions") < assembled.indexOf("Available tools:"));
});

test("depth 0 omits empty commander prefixes and keeps whitespace-only text verbatim", () => {
  for (const prefixPrompt of ["", null, undefined]) {
    const assembled = assembleActorSystemPrompt({
      depth: 0,
      basePrompt: defaultBasePrompt,
      depthPrompt: "# Depth-scoped instructions\n\nYou are Taihou.",
      prefixPrompt,
    });
    assert.equal(assembled.startsWith("# Depth-scoped instructions"), true);
  }
  const blank = assembleActorSystemPrompt({
    depth: 0,
    basePrompt: defaultBasePrompt,
    depthPrompt: "# Depth-scoped instructions\n\nYou are Taihou.",
    prefixPrompt: " \n\t ",
  });
  assert.equal(blank.startsWith(" \n\t \n\n# Depth-scoped instructions"), true);
});

test("deeper actors ignore commander prefix even when one is supplied", () => {
  const assembled = assembleActorSystemPrompt({
    depth: 1,
    basePrompt: defaultBasePrompt,
    depthPrompt: "CHILD ROLE",
    skillPrompt: "skills",
    prefixPrompt: "Do not leak this to children.",
  });
  assert.equal(assembled.startsWith(PI_DEFAULT_CODING_ASSISTANT_OPENING), true);
  assert.equal(assembled.includes("Do not leak this to children."), false);
  assert.ok(assembled.indexOf(PI_DEFAULT_CODING_ASSISTANT_OPENING) < assembled.indexOf("CHILD ROLE"));
});
