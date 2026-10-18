import { link, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadExternalPiSdk } from "./external-pi.mjs";
import { sessionSidecarPaths } from "./session-paths.mjs";

let sessionApiPromise;

async function sessionApi() {
  sessionApiPromise ??= loadExternalPiSdk({
    env: process.env.PI_HARNESS_PI_MODULE || process.env.PI_HARNESS_PI_COMMAND
      ? process.env : { ...process.env, PI_HARNESS_PI_COMMAND: "pi" },
  });
  return sessionApiPromise;
}

// Reuse the installed Pi SDK without creating a session or loading agent tools.
export async function createPiModelRuntime(options = {}) {
  const api = await sessionApi();
  if (typeof api.ModelRuntime?.create !== "function") throw new Error("Pi ModelRuntime public API is unavailable");
  return api.ModelRuntime.create(options);
}

export async function buildPiSessionContext(entries, leafId) {
  const api = await sessionApi();
  if (typeof api.buildSessionContext !== "function") throw new Error("Pi session context projection is unavailable");
  return api.buildSessionContext(entries, leafId);
}

/**
 * Create an eagerly initialized Pi transcript in Pi's normal cwd-scoped session
 * directory. SessionManager.create() chooses that directory, while opening an
 * empty file through the public API provides the immediate durable header that
 * admission needs before the first model turn.
 */
export async function createPiSession({ cwd, name, contextFork = null } = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) throw new TypeError("cwd must be a non-empty path");
  if (name !== undefined && name !== null && typeof name !== "string") {
    throw new TypeError("name must be a string when provided");
  }

  const { SessionManager } = await sessionApi();
  const seed = SessionManager.create(cwd);
  const sessionDir = seed.getSessionDir();
  const seedFile = seed.getSessionFile();
  if (!sessionDir || !seedFile) throw new Error("Pi did not provide a persistent session path");

  let canonicalFile;
  let ownsSeed = false;
  let ownsCanonical = false;
  try {
    await writeFile(seedFile, "", { flag: "wx", mode: 0o600 });
    ownsSeed = true;
    const initialized = SessionManager.open(seedFile, sessionDir, seed.getCwd());
    const header = initialized.getHeader();
    const sessionId = initialized.getSessionId();
    if (!header?.timestamp || !sessionId) throw new Error("Pi did not initialize a canonical session header");
    if (name !== undefined && name !== null) initialized.appendSessionInfo(name);
    if (contextFork) {
      initialized.appendCustomMessageEntry(contextFork.customType, contextFork.content, true, contextFork.details);
    }

    const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
    canonicalFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
    if (canonicalFile === seedFile) {
      ownsCanonical = true;
      ownsSeed = false;
    } else {
      await link(seedFile, canonicalFile);
      ownsCanonical = true;
      await unlink(seedFile);
      ownsSeed = false;
    }

    const manager = SessionManager.open(canonicalFile, sessionDir);
    if (manager.getSessionId() !== sessionId) throw new Error("Pi session identity changed during initialization");

    return {
      sessionId,
      sessionFile: manager.getSessionFile(),
      sessionDir: manager.getSessionDir(),
      sidecars: sessionSidecarPaths(manager.getSessionFile()),
    };
  } catch (error) {
    if (ownsSeed) await rm(seedFile, { force: true }).catch(() => {});
    if (ownsCanonical && canonicalFile) await rm(canonicalFile, { force: true }).catch(() => {});
    throw error;
  }
}

export async function initializePiSession({ sessionFile, sessionDir, cwd }) {
  const { SessionManager } = await sessionApi();
  const manager = SessionManager.open(sessionFile, sessionDir, cwd);
  return {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
  };
}
