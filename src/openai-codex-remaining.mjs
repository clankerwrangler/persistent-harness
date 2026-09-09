import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MIN_LIVE_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable() {
  return { provider: OPENAI_CODEX_PROVIDER, model: null, status: "unavailable", remaining: null };
}

function usageWindow(value, id) {
  if (!record(value) || typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)
    || value.used_percent < 0 || value.used_percent > 100
    || !Number.isSafeInteger(value.limit_window_seconds) || value.limit_window_seconds <= 0
    || !Number.isSafeInteger(value.reset_at) || value.reset_at <= 0) return null;
  const reset = new Date(value.reset_at * 1000);
  if (!Number.isFinite(reset.valueOf())) return null;
  return {
    id,
    windowSeconds: value.limit_window_seconds,
    percentUsed: value.used_percent,
    percentRemaining: 100 - value.used_percent,
    resetsAt: reset.toISOString(),
  };
}

export function parseOpenaiCodexUsage(payload, now = Date.now()) {
  if (!record(payload) || !record(payload.rate_limit)) return unavailable();
  const windows = [];
  for (const id of ["primary", "secondary"]) {
    const raw = payload.rate_limit[`${id}_window`];
    if (raw === null || raw === undefined) continue;
    const value = usageWindow(raw, id);
    if (!value) return unavailable();
    windows.push(value);
  }
  if (!windows.length) return unavailable();
  // Display the most-used main allowance window, not a fabricated request count.
  const limiting = windows.reduce((current, value) => value.percentUsed > current.percentUsed ? value : current);
  return {
    provider: OPENAI_CODEX_PROVIDER,
    model: null,
    status: "ready",
    remaining: {
      kind: "rate_limits",
      percentUsed: limiting.percentUsed,
      percentRemaining: limiting.percentRemaining,
      resetsAt: limiting.resetsAt,
      limitingWindow: limiting.id,
      windows,
      updatedAt: new Date(now).toISOString(),
      fresh: true,
      source: "live",
    },
  };
}

function defaultAuthPath(env) {
  const home = env.HOME || os.homedir();
  const configured = env.PI_CODING_AGENT_DIR;
  const directory = configured === "~" ? home
    : configured?.startsWith("~/") ? path.join(home, configured.slice(2))
      : configured || path.join(home, ".pi", "agent");
  return path.join(directory, "auth.json");
}

function readCredential(authPath, now) {
  const info = statSync(authPath);
  if (!info.isFile() || info.size < 2 || info.size > MAX_AUTH_BYTES) throw new Error("usage credential unavailable");
  const root = JSON.parse(readFileSync(authPath, "utf8"));
  const credential = record(root) ? root[OPENAI_CODEX_PROVIDER] : null;
  if (!record(credential) || credential.type !== "oauth" || typeof credential.access !== "string"
    || credential.access.length > 16 * 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential.access)
    || !Number.isFinite(credential.expires) || credential.expires <= now) throw new Error("usage credential unavailable");
  // Match the Codex transport: use the access token's ChatGPT account claim.
  const claims = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString("utf8"));
  const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(accountId)) throw new Error("usage credential unavailable");
  return { token: credential.access, accountId, key: createHash("sha256").update(credential.access).digest("hex") };
}

async function responseJson(response) {
  if (!response.ok) throw new Error("usage endpoint unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("usage response too large");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createOpenaiCodexRemainingReader({
  env = process.env,
  authPath = defaultAuthPath(env),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  minLiveIntervalMs = MIN_LIVE_INTERVAL_MS,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  let memo = null;
  let inflight = null;
  return {
    async get() {
      let credential;
      const observedAt = now();
      try { credential = readCredential(authPath, observedAt); }
      catch { memo = null; return unavailable(); }
      if (memo?.key === credential.key && observedAt - memo.observedAt < minLiveIntervalMs) return memo.value;
      if (inflight?.key === credential.key) return inflight.operation;
      const operation = (async () => {
        try {
          const response = await fetchImpl(USAGE_URL, {
            method: "GET",
            redirect: "error",
            headers: { authorization: `Bearer ${credential.token}`, "chatgpt-account-id": credential.accountId, accept: "application/json" },
            signal: AbortSignal.timeout(fetchTimeoutMs),
          });
          return parseOpenaiCodexUsage(await responseJson(response), observedAt);
        } catch { return unavailable(); }
      })();
      inflight = { key: credential.key, operation };
      try {
        const value = await operation;
        if (inflight?.operation === operation) memo = { key: credential.key, observedAt, value };
        return value;
      } finally {
        if (inflight?.operation === operation) inflight = null;
      }
    },
  };
}
