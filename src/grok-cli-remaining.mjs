import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const GROK_CLI_PROVIDER = "grok-cli";
const DEFAULT_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const MAX_JSON_BYTES = 1024 * 1024;
const MIN_LIVE_INTERVAL_MS = 60_000;
const CACHE_FRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PRODUCTS = 8;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function percent(value) {
  const clamped = clampPercent(value);
  return clamped === undefined ? undefined : Math.round(clamped);
}

function isoDate(value) {
  if (typeof value !== "string" || !value || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : undefined;
}

function boundedText(value, max, pattern) {
  if (typeof value !== "string" || !value || value.length > max || CONTROL.test(value)) return undefined;
  if (pattern && !pattern.test(value)) return undefined;
  return value;
}

export function configuredGrokCliBaseUrl(env = process.env) {
  const raw = env.PI_GROK_CLI_BASE_URL || env.GROK_CLI_BASE_URL || DEFAULT_BASE_URL;
  if (typeof raw !== "string" || !raw || raw.length > 512) return DEFAULT_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return DEFAULT_BASE_URL;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

export function grokCliPaths(env = process.env) {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : os.homedir();
  const directory = path.join(home, ".pi", "agent", "grok-cli");
  return {
    directory,
    vaultPath: path.join(directory, "accounts.json"),
    cachePath: path.join(directory, "quota-cache.json"),
    settingsPath: path.join(home, ".pi", "agent", "settings.json"),
  };
}

export function readGrokCliAccessCredential({ env = process.env, vaultPath } = {}) {
  const paths = grokCliPaths(env);
  return readActiveCredential(vaultPath ?? paths.vaultPath, env);
}

export function readGrokCliDefaultModel({ env = process.env, settingsPath } = {}) {
  const paths = grokCliPaths(env);
  return readDefaultGrokModel(settingsPath ?? paths.settingsPath);
}

function readJsonFile(file, maxBytes = MAX_JSON_BYTES) {
  const info = statSync(file);
  if (!info.isFile() || info.size < 2 || info.size > maxBytes) throw new Error("invalid remaining-usage file");
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!record(value)) throw new Error("invalid remaining-usage file");
  return value;
}

export function parseGrokCliCredits(payload) {
  if (!record(payload) || !record(payload.config)) return undefined;
  const config = payload.config;
  const resetsAt = isoDate(config.billingPeriodEnd);
  if (!resetsAt) return undefined;
  let percentUsed;
  if (config.creditUsagePercent !== undefined) percentUsed = percent(config.creditUsagePercent);
  else {
    const cap = record(config.onDemandCap) ? config.onDemandCap.val : undefined;
    const used = record(config.onDemandUsed) ? config.onDemandUsed.val : undefined;
    percentUsed = typeof cap === "number" && cap > 0 ? percent((used / cap) * 100) : 0;
  }
  if (percentUsed === undefined) return undefined;
  const products = [];
  if (Array.isArray(config.productUsage)) {
    for (const item of config.productUsage) {
      if (products.length >= MAX_PRODUCTS || !record(item)) continue;
      const id = boundedText(item.product, 64, PRODUCT_ID);
      const percentUsedProduct = percent(item.usagePercent);
      if (!id || percentUsedProduct === undefined) continue;
      products.push({
        id,
        percentUsed: percentUsedProduct,
        percentRemaining: Math.max(0, 100 - percentUsedProduct),
      });
    }
  }
  return {
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    resetsAt,
    products,
  };
}

export function parseGrokCliMonthly(payload) {
  if (!record(payload) || !record(payload.config)) return undefined;
  const config = payload.config;
  const monthlyLimit = record(config.monthlyLimit) ? config.monthlyLimit.val : undefined;
  const used = record(config.used) ? config.used.val : undefined;
  const billingPeriodEnd = isoDate(config.billingPeriodEnd);
  if (typeof monthlyLimit !== "number" || !Number.isFinite(monthlyLimit)
    || typeof used !== "number" || !Number.isFinite(used) || !billingPeriodEnd) return undefined;
  return { monthlyLimit, used, billingPeriodEnd };
}

export function parseGrokCliTier(payload) {
  if (!record(payload)) return undefined;
  return boundedText(payload.subscription_tier_display, 64);
}

export function projectGrokCliRemaining({
  provider = GROK_CLI_PROVIDER,
  model = null,
  status,
  weekly,
  tier = null,
  updatedAt,
  source,
  now = Date.now(),
} = {}) {
  const safeProvider = boundedText(provider, 128, PROVIDER_ID);
  const safeModel = model === null || model === undefined ? null : (boundedText(model, 256, PROVIDER_ID) ?? null);
  if (!safeProvider) return { provider: GROK_CLI_PROVIDER, model: null, status: "unavailable", remaining: null };
  if (status === "unsupported") return { provider: safeProvider, model: safeModel, status: "unsupported", remaining: null };
  if (status !== "ready" || !weekly) return { provider: safeProvider, model: safeModel, status: "unavailable", remaining: null };
  const percentUsed = percent(weekly.percentUsed);
  const percentRemaining = percent(weekly.percentRemaining ?? (percentUsed === undefined ? undefined : 100 - percentUsed));
  const resetsAt = isoDate(weekly.resetsAt);
  const observedAt = isoDate(updatedAt) ?? new Date(now).toISOString();
  if (percentUsed === undefined || percentRemaining === undefined || !resetsAt) {
    return { provider: safeProvider, model: safeModel, status: "unavailable", remaining: null };
  }
  const products = [];
  if (Array.isArray(weekly.products)) {
    for (const item of weekly.products) {
      if (products.length >= MAX_PRODUCTS || !record(item)) continue;
      const id = boundedText(item.id, 64, PRODUCT_ID);
      const used = percent(item.percentUsed);
      const remaining = percent(item.percentRemaining ?? (used === undefined ? undefined : 100 - used));
      if (!id || used === undefined || remaining === undefined) continue;
      products.push({ id, percentUsed: used, percentRemaining: remaining });
    }
  }
  const age = Math.max(0, now - new Date(observedAt).getTime());
  return {
    provider: safeProvider,
    model: safeModel,
    status: "ready",
    remaining: {
      kind: "weekly_allowance",
      percentRemaining,
      percentUsed,
      resetsAt,
      updatedAt: observedAt,
      fresh: source === "live" || age < CACHE_FRESH_MS,
      source: source === "cache" ? "cache" : "live",
      tier: parseGrokCliTier({ subscription_tier_display: tier }) ?? null,
      products,
    },
  };
}

export function parseGrokCliQuotaCache(value, accountId) {
  if (!record(value) || value.version !== 1 || !record(value.accounts)) return undefined;
  const entry = value.accounts[accountId];
  if (!record(entry)) return undefined;
  const weekly = record(entry.weekly) ? parseGrokCliCredits({
    config: {
      creditUsagePercent: entry.weekly.creditUsagePercent,
      billingPeriodEnd: entry.weekly.billingPeriodEnd,
    },
  }) : undefined;
  if (!weekly) return undefined;
  return {
    weekly,
    tier: parseGrokCliTier(entry) ?? null,
    updatedAt: isoDate(entry.updatedAt),
    monthly: record(entry.monthly) ? parseGrokCliMonthly({
      config: {
        monthlyLimit: { val: entry.monthly.monthlyLimit },
        used: { val: entry.monthly.used },
        billingPeriodEnd: entry.monthly.billingPeriodEnd,
      },
    }) : undefined,
  };
}

function readDefaultGrokModel(settingsPath) {
  try {
    const settings = readJsonFile(settingsPath, 64 * 1024);
    if (settings.defaultProvider !== GROK_CLI_PROVIDER) return null;
    return boundedText(settings.defaultModel, 256, PROVIDER_ID) ?? null;
  } catch {
    return null;
  }
}

function readActiveCredential(vaultPath, env) {
  const token = typeof env.GROK_CLI_OAUTH_TOKEN === "string" && env.GROK_CLI_OAUTH_TOKEN
    ? env.GROK_CLI_OAUTH_TOKEN : null;
  if (token) return { accountId: "account-1", token, source: "environment" };
  const vault = readJsonFile(vaultPath);
  if (vault.version !== 1 || !Array.isArray(vault.accounts)) throw new Error("invalid vault");
  const selected = vault.accounts.find((account) => record(account) && account.id === vault.activeAccountId && record(account.credential))
    ?? vault.accounts.find((account) => record(account) && record(account.credential));
  const access = selected?.credential?.access;
  const accountId = boundedText(selected?.id, 128, PROVIDER_ID);
  if (typeof access !== "string" || !access || access.length > 16 * 1024 || !accountId) throw new Error("missing grok-cli credential");
  return { accountId, token: access, source: "vault" };
}

async function fetchJson(fetchImpl, url, headers, signal) {
  const response = await fetchImpl(url, { method: "GET", headers, signal });
  if (!response.ok) throw new Error(`billing endpoint returned ${response.status}`);
  const value = await response.json();
  if (!record(value)) throw new Error("billing endpoint returned a non-object");
  return value;
}

function parseGrokCliQuotaCacheRoot(value) {
  if (!record(value) || value.version !== 1 || !record(value.accounts)) return { version: 1, accounts: {} };
  return { version: 1, accounts: { ...value.accounts } };
}

function writeQuotaCache(cachePath, accountId, { weekly, monthly, tier, updatedAt }) {
  if (!weekly) return;
  mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  let cache = { version: 1, accounts: {} };
  try { cache = parseGrokCliQuotaCacheRoot(readJsonFile(cachePath)); }
  catch { cache = { version: 1, accounts: {} }; }
  cache.accounts[accountId] = {
    updatedAt,
    ...(tier ? { tier } : {}),
    monthly: monthly ?? { monthlyLimit: 0, used: 0, billingPeriodEnd: weekly.resetsAt },
    weekly: { creditUsagePercent: weekly.percentUsed, billingPeriodEnd: weekly.resetsAt },
  };
  const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, cachePath); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function cachedProjection({ cache, accountId, model, now }) {
  const parsed = parseGrokCliQuotaCache(cache, accountId);
  if (!parsed?.weekly || !parsed.updatedAt) return undefined;
  return projectGrokCliRemaining({
    provider: GROK_CLI_PROVIDER,
    model,
    status: "ready",
    weekly: parsed.weekly,
    tier: parsed.tier,
    updatedAt: parsed.updatedAt,
    source: "cache",
    now,
  });
}

function unavailable(provider = GROK_CLI_PROVIDER, model = null) {
  return projectGrokCliRemaining({ provider, model, status: provider === GROK_CLI_PROVIDER ? "unavailable" : "unsupported" });
}

export function createGrokCliRemainingReader({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  vaultPath,
  cachePath,
  settingsPath,
  minLiveIntervalMs = MIN_LIVE_INTERVAL_MS,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  const paths = grokCliPaths(env);
  const resolvedVaultPath = vaultPath ?? paths.vaultPath;
  const resolvedCachePath = cachePath ?? paths.cachePath;
  const resolvedSettingsPath = settingsPath ?? paths.settingsPath;
  let memo;
  let inflight = null;

  async function live(accountId, token, model, observedAt) {
    const baseUrl = configuredGrokCliBaseUrl(env);
    const headers = {
      authorization: `Bearer ${token}`,
      "x-xai-token-auth": "xai-grok-cli",
      accept: "application/json",
    };
    const signal = AbortSignal.timeout(fetchTimeoutMs);
    const [creditsResult, monthlyResult, settingsResult] = await Promise.allSettled([
      fetchJson(fetchImpl, `${baseUrl}/billing?format=credits`, headers, signal),
      fetchJson(fetchImpl, `${baseUrl}/billing`, headers, signal),
      fetchJson(fetchImpl, `${baseUrl}/settings`, headers, signal),
    ]);
    if (creditsResult.status !== "fulfilled") throw creditsResult.reason;
    const weekly = parseGrokCliCredits(creditsResult.value);
    if (!weekly) throw new Error("billing credits payload was invalid");
    const monthly = monthlyResult.status === "fulfilled" ? parseGrokCliMonthly(monthlyResult.value) : undefined;
    const tier = settingsResult.status === "fulfilled" ? parseGrokCliTier(settingsResult.value) : null;
    const updatedAt = new Date(observedAt).toISOString();
    try { writeQuotaCache(resolvedCachePath, accountId, { weekly, monthly, tier, updatedAt }); }
    catch {}
    return projectGrokCliRemaining({
      provider: GROK_CLI_PROVIDER,
      model,
      status: "ready",
      weekly,
      tier,
      updatedAt,
      source: "live",
      now: observedAt,
    });
  }

  async function refresh(provider) {
    const observedAt = now();
    const model = readDefaultGrokModel(resolvedSettingsPath);
    if (provider !== GROK_CLI_PROVIDER) return unavailable(provider, null);
    if (memo?.value?.provider === GROK_CLI_PROVIDER && memo.value.status === "ready"
      && observedAt - memo.liveAt < minLiveIntervalMs) return memo.value;

    let accountId = "account-1";
    let cache;
    try { cache = readJsonFile(resolvedCachePath); }
    catch { cache = undefined; }
    const cached = cache ? cachedProjection({ cache, accountId, model, now: observedAt }) : undefined;
    if (cached?.status === "ready" && cached.remaining?.fresh && observedAt - new Date(cached.remaining.updatedAt).getTime() < minLiveIntervalMs) {
      memo = { value: cached, liveAt: new Date(cached.remaining.updatedAt).getTime() };
      return cached;
    }

    try {
      const credential = readActiveCredential(resolvedVaultPath, env);
      accountId = credential.accountId;
      const value = await live(accountId, credential.token, model, observedAt);
      memo = { value, liveAt: observedAt };
      return value;
    } catch {
      const fallback = cache ? cachedProjection({ cache, accountId, model, now: observedAt }) : undefined;
      if (fallback?.status === "ready") {
        memo = { value: fallback, liveAt: memo?.liveAt ?? 0 };
        return fallback;
      }
      return unavailable(GROK_CLI_PROVIDER, model);
    }
  }

  return {
    async get(provider = GROK_CLI_PROVIDER) {
      try {
        const requested = boundedText(provider, 128, PROVIDER_ID);
        if (!requested) return unavailable();
        if (inflight) {
          const value = await inflight;
          return requested === GROK_CLI_PROVIDER ? value : unavailable(requested, null);
        }
        const operation = refresh(requested).finally(() => { if (inflight === operation) inflight = null; });
        inflight = operation;
        return await operation;
      } catch {
        return unavailable(typeof provider === "string" ? provider : GROK_CLI_PROVIDER);
      }
    },
  };
}
