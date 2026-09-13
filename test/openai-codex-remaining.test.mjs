import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenaiCodexRemainingReader, parseOpenaiCodexUsage } from "../src/openai-codex-remaining.mjs";

const NOW = Date.parse("2026-09-04T12:00:00Z");
const ACCOUNT = "private-account-do-not-leak";
const REFRESH = "private-refresh-do-not-leak";
const token = (account = ACCOUNT) => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, email: "private-email-do-not-leak" })).toString("base64url")}.signature`;
const credential = (account = ACCOUNT) => ({ type: "oauth", access: token(account), refresh: REFRESH, expires: NOW + 3600_000 });
const window = (used, seconds) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: NOW / 1000 + seconds, reset_after_seconds: seconds });
const payload = (primary = window(21, 18000), secondary = window(70, 604800)) => ({
  account_id: ACCOUNT, email: "private-email-do-not-leak", access_token: token(),
  rate_limit: { allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary },
  additional_rate_limits: [{ limit_name: "unrelated-model", rate_limit: { primary_window: window(99, 18000) } }],
});

async function fixture(t, auth = credential()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remaining-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": auth }), { mode: 0o600 });
  return { directory, authPath };
}

function assertUnavailable(value) {
  assert.deepEqual(value, { provider: "openai-codex", model: null, status: "unavailable", remaining: null });
}

test("Codex projects both main windows and selects the most-used one without exposing account fields", () => {
  const value = parseOpenaiCodexUsage(payload(), NOW);
  assert.equal(value.status, "ready");
  assert.deepEqual(Object.keys(value), ["provider", "model", "status", "remaining"]);
  assert.deepEqual(Object.keys(value.remaining), ["kind", "percentUsed", "percentRemaining", "resetsAt", "limitingWindow", "windows", "updatedAt", "fresh", "source"]);
  assert.equal(value.remaining.kind, "rate_limits");
  assert.equal(value.remaining.percentUsed, 70);
  assert.equal(value.remaining.percentRemaining, 30);
  assert.equal(value.remaining.limitingWindow, "secondary");
  assert.deepEqual(value.remaining.windows.map((item) => item.windowSeconds), [18000, 604800]);
  assert.deepEqual(Object.keys(value.remaining.windows[0]), ["id", "windowSeconds", "percentUsed", "percentRemaining", "resetsAt"]);
  assert.doesNotMatch(JSON.stringify(value), /private-|account|email|token|unrelated-model/);
  assert.equal(parseOpenaiCodexUsage(payload(window(91.5, 18000), window(12, 604800)), NOW).remaining.limitingWindow, "primary");
});

test("Codex handles a single weekly primary window and zero or exhausted quotas", () => {
  for (const percent of [0, 21, 100]) {
    const value = parseOpenaiCodexUsage(payload(window(percent, 604800), null), NOW);
    assert.equal(value.remaining.percentRemaining, 100 - percent);
    assert.equal(value.remaining.windows.length, 1);
    assert.equal(value.remaining.windows[0].windowSeconds, 604800);
  }
});

test("Codex never invents quota from absent, malformed, or unrelated windows", () => {
  for (const raw of [null, {}, [], { rate_limit: {} }, payload(null, null), { additional_rate_limits: payload().additional_rate_limits }]) {
    assertUnavailable(parseOpenaiCodexUsage(raw, NOW));
  }
  for (const invalid of [null, "21", NaN, Infinity, -1, 101]) {
    assertUnavailable(parseOpenaiCodexUsage(payload({ ...window(21, 18000), used_percent: invalid }), NOW));
  }
  for (const field of ["reset_at", "limit_window_seconds"]) {
    for (const invalid of [null, "18000", -1, 0, Infinity, 1.5]) {
      assertUnavailable(parseOpenaiCodexUsage(payload({ ...window(21, 18000), [field]: invalid }), NOW));
    }
  }
  assertUnavailable(parseOpenaiCodexUsage(payload(window(21, 18000), { used_percent: 99 }), NOW));
});

test("Codex reader uses only the fixed read-only endpoint and existing OAuth account claim", async (t) => {
  const { directory, authPath } = await fixture(t);
  const before = await readFile(authPath, "utf8");
  const calls = [];
  const reader = createOpenaiCodexRemainingReader({
    env: { PI_CODING_AGENT_DIR: directory }, now: () => NOW,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(payload()); },
  });
  const value = await reader.get();
  assert.equal(value.status, "ready");
  assert.equal(value.remaining.percentRemaining, 30);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token()}`);
  assert.equal(calls[0].init.headers["chatgpt-account-id"], ACCOUNT);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  assert.equal(await readFile(authPath, "utf8"), before, "usage reads must not refresh or change auth");
  assert.doesNotMatch(JSON.stringify(value), /private-|account|email|token|auth.json/);
  await reader.get();
  assert.equal(calls.length, 1, "refreshes within one minute reuse the current account's quota");
});

test("Codex unavailable states do not refresh auth or return stale quota after expiry or a failed refresh", async (t) => {
  const { authPath } = await fixture(t);
  let time = NOW;
  let fail = false;
  const reader = createOpenaiCodexRemainingReader({ authPath, now: () => time, fetchImpl: async () => {
    if (fail) throw new Error(`${token()} ${ACCOUNT} ${authPath}`);
    return Response.json(payload());
  } });
  assert.equal((await reader.get()).status, "ready");
  time += 60_001;
  fail = true;
  assertUnavailable(await reader.get());
  time = NOW + 3600_001;
  assertUnavailable(await reader.get());
  for (const auth of [{ ...credential(), expires: NOW }, { type: "api_key", key: "private-key" }, { ...credential(), access: "invalid" }, { ...credential(), access: token("") }]) {
    await writeFile(authPath, JSON.stringify({ "openai-codex": auth }));
    const invalidReader = createOpenaiCodexRemainingReader({ authPath, now: () => NOW, fetchImpl: () => { assert.fail("invalid credentials must not make requests"); } });
    assertUnavailable(await invalidReader.get());
  }
  await rm(authPath);
  assertUnavailable(await reader.get());
});

test("Codex reader isolates memoized and in-flight results when the OAuth account changes", async (t) => {
  const { authPath } = await fixture(t);
  let resolveOld;
  let calls = 0;
  const reader = createOpenaiCodexRemainingReader({ authPath, now: () => NOW, fetchImpl: async (_url, init) => {
    calls += 1;
    if (init.headers["chatgpt-account-id"] === ACCOUNT) return new Promise((resolve) => { resolveOld = resolve; });
    return Response.json(payload(window(10, 604800), null));
  } });
  const old = reader.get();
  const same = reader.get();
  assert.equal(calls, 1);
  await writeFile(authPath, JSON.stringify({ "openai-codex": credential("other-private-account") }));
  assert.equal((await reader.get()).remaining.percentUsed, 10);
  resolveOld(Response.json(payload()));
  await Promise.all([old, same]);
  assert.equal((await reader.get()).remaining.percentUsed, 10);
  assert.equal(calls, 2);
});

test("Codex endpoint failures and oversized or malformed bodies return only unavailable", async (t) => {
  const { authPath } = await fixture(t);
  for (const result of [new Response(token(), { status: 401 }), new Response("x".repeat(256 * 1024 + 1)), new Response("invalid"), Response.json({ error: token() })]) {
    const reader = createOpenaiCodexRemainingReader({ authPath, now: () => NOW, fetchImpl: async () => result });
    assertUnavailable(await reader.get());
  }
  const reader = createOpenaiCodexRemainingReader({ authPath, now: () => NOW, fetchTimeoutMs: 1,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assertUnavailable(await reader.get()); } finally { clearTimeout(keepAlive); }
});
