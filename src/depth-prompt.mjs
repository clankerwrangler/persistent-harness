import { readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_DEPTH_PROMPT_FILE_BYTES = 64 * 1024;
export const MAX_DEPTH_PROMPT_TOTAL_BYTES = 256 * 1024;

function requireDepth(depth) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 64) {
    throw new Error("actor RLM depth must be a non-negative bounded integer");
  }
  return depth;
}

export function depthPromptPaths(contextFiles, depth) {
  requireDepth(depth);
  const candidates = [];
  const seen = new Set();
  for (const contextFile of contextFiles ?? []) {
    if (typeof contextFile?.path !== "string" || !contextFile.path) continue;
    const parsed = path.parse(path.resolve(contextFile.path));
    if (!/^(AGENTS|CLAUDE)$/i.test(parsed.name) || !/^\.md$/i.test(parsed.ext)) continue;
    const candidate = path.join(parsed.dir, `${parsed.name}.depth-${depth}${parsed.ext}`);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

export async function loadDepthPrompt(contextFiles, depth, { read = readFile } = {}) {
  requireDepth(depth);
  const files = [];
  let totalBytes = 0;
  for (const filePath of depthPromptPaths(contextFiles, depth)) {
    let content;
    try {
      content = await read(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`could not read depth-scoped instructions ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_DEPTH_PROMPT_FILE_BYTES) {
      throw new Error(`depth-scoped instructions exceed ${MAX_DEPTH_PROMPT_FILE_BYTES} bytes: ${filePath}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_DEPTH_PROMPT_TOTAL_BYTES) {
      throw new Error(`depth-scoped instructions exceed ${MAX_DEPTH_PROMPT_TOTAL_BYTES} total bytes`);
    }
    if (content.trim()) files.push({ path: filePath, content });
  }
  if (files.length === 0) return { depth, files, prompt: "" };
  const sections = [
    "# Depth-scoped instructions",
    `The following context applies specifically at RLM depth ${depth}.`,
    ...files.flatMap((file) => [`## ${file.path}`, file.content.trim()]),
  ];
  return { depth, files, prompt: sections.join("\n\n") };
}

/** Exact opening paragraph from pi's default `buildSystemPrompt`. */
export const PI_DEFAULT_CODING_ASSISTANT_OPENING =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export const PI_DEFAULT_BE_CONCISE_GUIDELINE = "- Be concise in your responses";

export function stripDepth0CodingAssistantPrime(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return "";
  const withoutBom = prompt.replace(/^\uFEFF/, "");
  const leading = withoutBom.match(/^\s*/)?.[0] ?? "";
  let next = withoutBom.slice(leading.length);
  if (next.startsWith(PI_DEFAULT_CODING_ASSISTANT_OPENING)) {
    next = next.slice(PI_DEFAULT_CODING_ASSISTANT_OPENING.length).replace(/^\s*\n/, "");
  } else {
    next = withoutBom;
  }
  return next
    .split("\n")
    .filter((line) => line !== PI_DEFAULT_BE_CONCISE_GUIDELINE)
    .join("\n")
    .replace(/^\n+/, "");
}

export function assembleActorSystemPrompt({ depth, basePrompt = "", depthPrompt = "", skillPrompt = "", prefixPrompt = "" }) {
  requireDepth(depth);
  const base = typeof basePrompt === "string" ? basePrompt : "";
  const depthText = typeof depthPrompt === "string" ? depthPrompt : "";
  const skill = typeof skillPrompt === "string" ? skillPrompt : "";
  const prefix = typeof prefixPrompt === "string" ? prefixPrompt : "";
  if (depth === 0) {
    return [prefix, depthText, stripDepth0CodingAssistantPrime(base), skill].filter(Boolean).join("\n\n");
  }
  return [base, depthText, skill].filter(Boolean).join("\n\n");
}
