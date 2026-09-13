import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGrokCliRemainingReader,
  parseGrokCliCredits,
  projectGrokCliRemaining,
} from "../src/grok-cli-remaining.mjs";

const TOKEN = "grok-cli-test-token-value-do-not-leak";
const RESETS = "2026-08-28T22:48:09.980905+00:00";
const RESETS_ISO = "2026-08-28T22:48:09.980Z";

function creditsPayload({ percent = 48, onDemandCap = 0, onDemandUsed = 0, products = true } = {}) {
  return {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-21T22:48:09.980905+00:00", end: RESETS },
      creditUsagePercent: percent,
      onDemandCap: { val: onDemandCap },
      onDemandUsed: { val: onDemandUsed },
      productUsage: products ? [
        { product: "GrokBuild", usagePercent: 36 },
        { product: "GrokImagine", usagePercent: 10 },
        { product: "GrokTasks", usagePercent: 2 },
      ] : [],
      billingPeriodStart: "2026-08-21T22:48:09.980905+00:00",
      billingPeriodEnd: RESETS,
    },
  };
}

async function fixture(t, { cache, now = 1_788_000_000_000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-remaining-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const vaultPath = path.join(root, "accounts.json");
  const cachePath = path.join(root, "quota-cache.json");
  const settingsPath = path.join(root, "settings.json");
  await writeFile(vaultPath, `${JSON.stringify({
    version: 1,
    migration: { legacyCredentialCopyComplete: true, markerInstallPending: false },
    nextSlot: 2,
    activeAccountId: "account-1",
    accounts: [{ id: "account-1", slot: 1, label: "Account 1", revision: 1, credential: {
      access: TOKEN, refresh: "refresh-token", expires: now + 3_600_000, baseUrl: "https://cli-chat-proxy.grok.com/v1",
    } }],
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(settingsPath, `${JSON.stringify({ defaultProvider: "grok-cli", defaultModel: "grok-4.6" })}\n`);
  if (cache) await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  return { root, vaultPath, cachePath, settingsPath, now };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const route = routes[String(url)];
    if (!route) return { ok: false, status: 404, json: async () => ({ error: "missing" }) };
    return { ok: true, status: 200, json: async () => route };
  };
  return { fetchImpl, calls };
}

test("Grok credits parser prefers weekly creditUsagePercent over a zero on-demand cap", () => {
  const weekly = parseGrokCliCredits(creditsPayload());
  assert.equal(weekly.percentUsed, 48);
  assert.equal(weekly.percentRemaining, 52);
  assert.equal(weekly.products[0].id, "GrokBuild");
});

test("Grok credits parser falls back to on-demand used over cap", () => {
  const weekly = parseGrokCliCredits({
    config: { billingPeriodEnd: RESETS, onDemandCap: { val: 200 }, onDemandUsed: { val: 50 } },
  });
  assert.equal(weekly.percentUsed, 25);
  assert.equal(weekly.percentRemaining, 75);
});

test("remaining projection is secret-free and exact", () => {
  const value = projectGrokCliRemaining({
    provider: "grok-cli", model: "grok-4.6", status: "ready",
    weekly: parseGrokCliCredits(creditsPayload()), tier: "SuperGrok",
    updatedAt: "2026-08-28T13:00:00.000Z", source: "live", now: Date.parse("2026-08-28T13:00:00.000Z"),
  });
  assert.equal(value.status, "ready");
  assert.equal(value.remaining.percentRemaining, 52);
  assert.deepEqual(Object.keys(value.remaining), [
    "kind", "percentRemaining", "percentUsed", "resetsAt", "updatedAt", "fresh", "source", "tier", "products",
  ]);
});

test("Grok remaining reader fetches live billing and never returns the vault token", async (t) => {
  const { vaultPath, cachePath, settingsPath, now } = await fixture(t);
  const { fetchImpl, calls } = mockFetch({
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits": creditsPayload(),
    "https://cli-chat-proxy.grok.com/v1/billing": {
      config: { monthlyLimit: { val: 0 }, used: { val: 5 }, billingPeriodEnd: "2026-09-01T00:00:00+00:00" },
    },
    "https://cli-chat-proxy.grok.com/v1/settings": { subscription_tier_display: "SuperGrok" },
  });
  const reader = createGrokCliRemainingReader({
    vaultPath, cachePath, settingsPath, fetchImpl, now: () => now, minLiveIntervalMs: 60_000,
  });
  const value = await reader.get();
  assert.equal(value.status, "ready");
  assert.equal(value.model, "grok-4.6");
  assert.equal(value.remaining.percentRemaining, 52);
  const encoded = JSON.stringify(value);
  assert.doesNotMatch(encoded, /grok-cli-test-token-value-do-not-leak/);
  assert.doesNotMatch(encoded, /refresh-token/);
  assert.equal(calls.length, 3);
  const again = await reader.get();
  assert.equal(again.remaining.source, "live");
  assert.equal(calls.length, 3);
});

test("Grok remaining reader uses cache when live billing fails", async (t) => {
  const now = 1_788_000_000_000;
  const { vaultPath, cachePath, settingsPath } = await fixture(t, {
    now,
    cache: {
      version: 1,
      accounts: {
        "account-1": {
          updatedAt: new Date(now - 5 * 60_000).toISOString(),
          tier: "SuperGrok",
          monthly: { monthlyLimit: 0, used: 5, billingPeriodEnd: "2026-09-01T00:00:00.000Z" },
          weekly: { creditUsagePercent: 71, billingPeriodEnd: RESETS_ISO },
        },
      },
    },
  });
  const { fetchImpl } = mockFetch({});
  const reader = createGrokCliRemainingReader({
    vaultPath, cachePath, settingsPath, fetchImpl, now: () => now, minLiveIntervalMs: 1_000,
  });
  const value = await reader.get("grok-cli");
  assert.equal(value.status, "ready");
  assert.equal(value.remaining.percentRemaining, 29);
  assert.equal(value.remaining.source, "cache");
});

test("Grok remaining reader reports unsupported for any other provider", async (t) => {
  const { vaultPath, cachePath, settingsPath, now } = await fixture(t);
  const { fetchImpl, calls } = mockFetch({});
  const reader = createGrokCliRemainingReader({ vaultPath, cachePath, settingsPath, fetchImpl, now: () => now });
  const value = await reader.get("openai-codex");
  assert.deepEqual(value, { provider: "openai-codex", model: null, status: "unsupported", remaining: null });
  assert.equal(calls.length, 0);
});

test("Grok remaining reader never throws when the vault is missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-remaining-missing-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const reader = createGrokCliRemainingReader({
    vaultPath: path.join(root, "missing-accounts.json"),
    cachePath: path.join(root, "missing-cache.json"),
    settingsPath: path.join(root, "missing-settings.json"),
    fetchImpl: async () => { throw new Error("network"); },
    now: () => 1,
  });
  const value = await reader.get();
  assert.equal(value.status, "unavailable");
  assert.equal(value.remaining, null);
});
