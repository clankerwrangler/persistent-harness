import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_ROOT_TITLE_CHARS = 64;
const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "nor", "of", "to", "for", "in", "on", "at", "by", "as", "vs"]);
const FILLERS = [
  /^(please)\b[\s,!.:-]*/i,
  /^(hey|hi|hello|yo)\b[\s,!.:-]*/i,
  /^(ok(?:ay)?|so|well|um+|uh+)\b[\s,!.:-]*/i,
  /^(can|could|would|will)\s+you(?:\s+please)?\s+/i,
  /^(help me(?:\s+to)?)\s+/i,
  /^i(?:'d|\s+would|\s+will)?\s+(?:like|want|need)(?:\s+you)?(?:\s+to)?\s+/i,
];

export function shortSessionId(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
}

export function defaultRootName(cwd, sessionId) {
  return `${path.basename(cwd || "") || "root"}-${shortSessionId(sessionId)}`;
}

export function isDefaultRootName(name, cwd, sessionId) {
  return name === defaultRootName(cwd, sessionId);
}

export function allocateUniqueRootName(base, shortId, taken) {
  const name = typeof base === "string" ? base.trim() : "";
  const suffix = typeof shortId === "string" ? shortId.trim() : "";
  if (!name) throw new Error("root title must be a non-empty string");
  if (typeof taken !== "function") throw new Error("taken must be a function");
  if (!taken(name)) return clipTitle(name, 256);
  if (!suffix) throw new Error("shortId is required when the title is taken");
  for (const candidate of uniqueRootNameCandidates(name, suffix)) {
    if (!taken(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique root title");
}

export function titleFromUserPrompt(message) {
  if (typeof message !== "string") return null;
  if (message.startsWith("Automated post-restart continuation:")) return null;
  const normalized = message.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const withoutFences = normalized.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
  const lines = withoutFences.split("\n").map(cleanTitleLine).filter(Boolean);
  if (lines.length === 0) return null;
  let candidate = lines[0];
  if (isGreetingOnly(candidate) && lines[1]) candidate = lines[1];
  if (candidate.length > MAX_ROOT_TITLE_CHARS) {
    const sentence = candidate.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (sentence) candidate = sentence;
  }
  candidate = stripFiller(candidate).replace(/\s+/g, " ").trim().replace(/[.?!,:;]+$/g, "");
  if (candidate.length < 2) return null;
  return titleCase(clipTitle(candidate, MAX_ROOT_TITLE_CHARS));
}

function uniqueRootNameCandidates(base, suffix) {
  const clipped = clipTitle(base, Math.max(8, 256 - suffix.length - 1));
  const candidates = [`${clipped} ${suffix}`];
  for (let index = 2; index <= 32; index += 1) candidates.push(`${clipped} ${suffix}-${index}`);
  return candidates;
}

function cleanTitleLine(line) {
  return String(line ?? "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]+/g, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFiller(text) {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = FILLERS.reduce((value, pattern) => value.replace(pattern, ""), current).trim();
    if (next === current) break;
    current = next;
  }
  return current;
}

function isGreetingOnly(text) {
  return /^(?:please|hey|hi|hello|yo|ok(?:ay)?|thanks|thank you)[.!?]*$/i.test(text);
}

function clipTitle(text, max) {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  const clipped = lastSpace >= Math.min(24, max) ? sliced.slice(0, lastSpace) : sliced;
  return clipped.replace(/[-–—,;:]+$/g, "").trim() || sliced.trim();
}

function titleCase(text) {
  const words = text.split(" ");
  return words.map((word, index) => {
    if (/^[A-Z0-9]{2,6}$/.test(word) || /[A-Z].*[a-z]/.test(word) || (/\d/.test(word) && word !== word.toLowerCase())) {
      return word;
    }
    const lower = word.toLowerCase();
    const hyphenated = lower.split("-").map((part) => titleCaseWord(part, index, words.length)).join("-");
    if (index !== 0 && index !== words.length - 1 && SMALL_WORDS.has(lower)) return lower;
    return hyphenated;
  }).join(" ");
}

function titleCaseWord(part, index, count) {
  if (!part) return part;
  if (/^[A-Z0-9]{2,6}$/.test(part)) return part;
  const lower = part.toLowerCase();
  if (index !== 0 && index !== count - 1 && SMALL_WORDS.has(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function titleFromFirstTurn(userText, assistantText) {
  const assistantTitle = titleFromUserPrompt(assistantTitleSource(assistantText));
  if (isThinPrompt(userText)) return assistantTitle;
  return titleFromUserPrompt(userText) || assistantTitle;
}

export function firstCompletedTitleTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const user = list[index];
    if (user?.role !== "user") continue;
    const userText = String(user.text ?? "");
    if (userText.startsWith("Automated post-restart continuation:")) continue;
    let assistant;
    for (let reply = index + 1; reply < list.length && list[reply]?.role !== "user"; reply += 1) {
      const item = list[reply];
      if (item?.role === "assistant" && String(item.text ?? "").trim()) { assistant = item; break; }
    }
    if (!assistant) continue;
    if (isThinPrompt(userText) && isThinPrompt(assistantTitleSource(assistant.text))) continue;
    return { userText, assistantText: String(assistant.text ?? "") };
  }
  return null;
}

function assistantTitleSource(text) {
  return String(text ?? "")
    .replace(/^(?:yes|no)[.!]+\s+/i, "")
    .replace(/^(?:yes[,.]?\s+)?commander[,.]?\s+/i, "")
    .trim();
}

function isThinPrompt(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return true;
  if (raw.startsWith("Automated post-restart continuation:")) return true;
  const firstLine = cleanTitleLine(raw.split("\n")[0] || "");
  if (isGreetingOnly(firstLine) && !raw.split("\n").slice(1).some((line) => cleanTitleLine(line))) return true;
  const compact = stripFiller(raw.replace(/\s+/g, " ")).toLowerCase();
  if (compact.length < 16) return true;
  if (/^(did|does|is|are|can|will|has|have) (it|this|that)\b/.test(compact)) return true;
  if (/^(ok|okay|thanks|thank you|cool|nice|great|sure|got it|makes sense)[.!?]*$/.test(compact)) return true;
  return false;
}

export function rootTitleExcerpt(turn) {
  if (!turn) return null;
  return { userText: clipExcerpt(turn.userText), assistantText: clipExcerpt(turn.assistantText) };
}

export function rootTitlePrompt(userText, assistantText) {
  const user = clipForPrompt(userText);
  const assistant = clipForPrompt(assistantText);
  if (!user && !assistant) return null;
  return `Commander:\n${user || "(empty)"}\n\nTaihou:\n${assistant || "(empty)"}\n\nTitle:`;
}

export function isSentenceLikeTitle(text) {
  const compact = String(text ?? "").trim();
  if (!compact) return false;
  return /^(i|we|you|it['’]s|let['’]?s|(?:is|are|was|were|could|would|should|do|does|did)(?:n['’]?t)?|can(?:not|['’]?t)?|will|won['’]?t|what(?:['’]?s)?|why|how|please)\b/i.test(compact);
}

export function normalizeGeneratedTitle(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).find(Boolean) || "";
  text = text.replace(/^(?:title|session(?: name)?|name)\s*[:\-–—]\s*/i, "");
  text = cleanTitleLine(text).replace(/[.?!,:;]+$/g, "").replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  if (isGreetingOnly(text)) return null;
  if (/^workspace-[0-9a-f]{8}$/i.test(text)) return null;
  const words = text.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (isSentenceLikeTitle(text)) return null;
  return titleCase(clipTitle(text, MAX_ROOT_TITLE_CHARS));
}

export function resolveRootTitle(turn, generated) {
  const generatedTitle = normalizeGeneratedTitle(generated);
  if (generatedTitle) return generatedTitle;
  return normalizeGeneratedTitle(titleFromFirstTurn(turn?.userText, turn?.assistantText));
}

function clipForPrompt(text) {
  return clipExcerpt(String(text ?? "").replace(/\s+/g, " "));
}

function clipExcerpt(text, max = 800) {
  const value = String(text ?? "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max).trim()}…`;
}

