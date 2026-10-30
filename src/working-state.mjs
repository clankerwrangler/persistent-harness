// Working-state budget. A session registers the file it rereads to resume work in
// ~/.pi/agent/harness/working-state.json ({ "<sessionId>": "/absolute/path" }).
// When that file grows past the limit, each run starts with a short note saying so.
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WORKING_STATE_NOTE_TYPE = "persistent-harness-working-state";
export const WORKING_STATE_LIMIT_BYTES = 20 * 1024;
export const WORKING_STATE_REGISTRY = path.join(os.homedir(), ".pi", "agent", "harness", "working-state.json");

export function workingStateNote(sessionId, { registryPath = process.env.PI_HARNESS_WORKING_STATE_REGISTRY || WORKING_STATE_REGISTRY,
  limit = Number(process.env.PI_HARNESS_WORKING_STATE_LIMIT_BYTES) || WORKING_STATE_LIMIT_BYTES } = {}) {
  let file;
  try { file = JSON.parse(readFileSync(registryPath, "utf8"))?.[sessionId]; } catch { return null; }
  if (typeof file !== "string" || !path.isAbsolute(file)) return null;
  let size;
  try { size = statSync(file).size; } catch { return null; }
  if (size <= limit) return null;
  const kb = bytes => `${Math.ceil(bytes / 1024)} KB`;
  return `Working state ${file} is ${kb(size)} (limit ${kb(limit)}). Before new work, cut it to the current picture and move history out.`;
}
