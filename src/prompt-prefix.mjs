import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_PREFIX_TEXT_BYTES = 32 * 1024;
export const MAX_PREFIX_JSON_BYTES = 64 * 1024;
export const DEFAULT_PROMPT_PREFIX = Object.freeze({ enabled: false, text: "" });

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const TEMP_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class PromptPrefixError extends Error {
  constructor(message, { code = "invalid_prompt_prefix", status = 400, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PromptPrefixError";
    this.code = code;
    this.status = status;
  }
}

function prefixError(message, options) {
  return new PromptPrefixError(message, options);
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

export function promptPrefixPath(env = process.env) {
  const root = typeof env?.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR
    ? env.PI_CODING_AGENT_DIR
    : path.join(os.homedir(), ".pi", "agent");
  return path.join(root, "state", "prompt-prefix.json");
}

export function projectPromptPrefix(record) {
  const enabled = record?.enabled === true;
  const text = typeof record?.text === "string" ? record.text : "";
  return { enabled, text, applied: enabled && text.length > 0 };
}

export function formatPrefixPrompt(record) {
  const projection = projectPromptPrefix(record);
  if (!projection.applied) return "";
  return projection.text;
}

export function validatePromptPrefix(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw prefixError("prompt prefix must be a JSON object");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "enabled") || !Object.hasOwn(value, "text")) {
    throw prefixError("prompt prefix must contain only enabled and text");
  }
  if (typeof value.enabled !== "boolean") {
    throw prefixError("prompt prefix enabled must be a boolean");
  }
  if (typeof value.text !== "string") {
    throw prefixError("prompt prefix text must be a string");
  }
  if (value.text.includes("\u0000")) {
    throw prefixError("prompt prefix text must not contain NUL");
  }
  if (Buffer.byteLength(value.text, "utf8") > MAX_PREFIX_TEXT_BYTES) {
    throw prefixError("prompt prefix text exceeds 32768 UTF-8 bytes");
  }
  return { enabled: value.enabled, text: value.text };
}

function decodeUtf8(buffer) {
  try {
    return UTF8.decode(buffer);
  } catch {
    throw prefixError("prompt prefix file is not valid UTF-8", { code: "corrupt_prompt_prefix", status: 422 });
  }
}

function parseStoredPrefix(buffer) {
  if (buffer.includes(0)) {
    throw prefixError("prompt prefix file is invalid", { code: "corrupt_prompt_prefix", status: 422 });
  }
  if (buffer.byteLength > MAX_PREFIX_JSON_BYTES) {
    throw prefixError("prompt prefix file is too large", { code: "corrupt_prompt_prefix", status: 422 });
  }
  const text = decodeUtf8(buffer);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw prefixError("prompt prefix file is invalid", { code: "corrupt_prompt_prefix", status: 422 });
  }
  try {
    return validatePromptPrefix(parsed);
  } catch (error) {
    throw prefixError("prompt prefix file is invalid", { code: "corrupt_prompt_prefix", status: 422, cause: error });
  }
}

function encodedRecord(record) {
  return `${JSON.stringify({ enabled: record.enabled, text: record.text }, null, 2)}\n`;
}

async function readRegularFile(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw prefixError("prompt prefix file could not be read", { code: "corrupt_prompt_prefix", status: 422, cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw prefixError("prompt prefix file is not a regular file", { code: "corrupt_prompt_prefix", status: 422 });
  }
  if (info.size > MAX_PREFIX_JSON_BYTES) {
    throw prefixError("prompt prefix file is too large", { code: "corrupt_prompt_prefix", status: 422 });
  }
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
  } catch (error) {
    if (isMissing(error)) return null;
    throw prefixError("prompt prefix file could not be read", { code: "corrupt_prompt_prefix", status: 422, cause: error });
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw prefixError("prompt prefix file is not a regular file", { code: "corrupt_prompt_prefix", status: 422 });
    }
    if (opened.size > MAX_PREFIX_JSON_BYTES) {
      throw prefixError("prompt prefix file is too large", { code: "corrupt_prompt_prefix", status: 422 });
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertWritableDestination(filePath) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw prefixError("prompt prefix file could not be replaced", { code: "corrupt_prompt_prefix", status: 422, cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw prefixError("prompt prefix file is not a regular file", { code: "corrupt_prompt_prefix", status: 422 });
  }
}

async function writeAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await chmod(directory, 0o700); } catch {}
  await assertWritableDestination(filePath);
  const temporary = path.join(directory, `.prompt-prefix-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  let published = false;
  try {
    handle = await open(temporary, TEMP_FLAGS, 0o600);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw prefixError("prompt prefix temp path is not a private regular file", { code: "corrupt_prompt_prefix", status: 500 });
    }
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    published = true;
    try { await chmod(filePath, 0o600); } catch {}
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (!published) await unlink(temporary).catch(() => {});
    if (error instanceof PromptPrefixError) throw error;
    throw prefixError("prompt prefix file could not be saved", { code: "corrupt_prompt_prefix", status: 500, cause: error });
  }
}

export async function loadPromptPrefix({ filePath, env } = {}) {
  const resolved = filePath ?? promptPrefixPath(env);
  const buffer = await readRegularFile(resolved);
  if (buffer === null) return { ...DEFAULT_PROMPT_PREFIX };
  return parseStoredPrefix(buffer);
}

export async function savePromptPrefix(value, { filePath, env } = {}) {
  const record = validatePromptPrefix(value);
  const resolved = filePath ?? promptPrefixPath(env);
  await writeAtomic(resolved, encodedRecord(record));
  return record;
}

export function createPromptPrefixAccessor(filePath) {
  return {
    load: () => loadPromptPrefix({ filePath }),
    save: (record) => savePromptPrefix(record, { filePath }),
  };
}

export function defaultPromptPrefixAccessor(env = process.env) {
  return createPromptPrefixAccessor(promptPrefixPath(env));
}
