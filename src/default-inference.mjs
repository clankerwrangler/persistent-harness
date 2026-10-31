import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { supportedThinkingLevels } from "./child-policy.mjs";

const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function version(id) { return (id.match(/\d+/g) ?? []).map(Number); }

function newerThan(left, right) {
  const [a, b] = [version(left), version(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

// "provider/id" and exact ids are literal. A short name such as "terra" picks the
// newest matching model from the default provider, and a tie is refused.
export function resolveDefaultTarget(target, models, defaultProvider) {
  const name = target.trim().toLowerCase();
  const literal = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === name)
    ?? models.find((model) => model.provider === defaultProvider && model.id.toLowerCase() === name);
  if (literal) return literal;
  const matches = models.filter((model) => model.provider === defaultProvider && model.id.toLowerCase().includes(name));
  if (!matches.length) throw new Error(`no ${defaultProvider} model matches ${target}`);
  const newest = matches.reduce((best, model) => (newerThan(model.id, best.id) ? model : best));
  const tied = matches.filter((model) => !newerThan(newest.id, model.id));
  if (tied.length > 1) throw new Error(`${target} is ambiguous: ${tied.map((model) => model.id).join(", ")}`);
  return newest;
}

// A session keeps its thinking level unless the target lacks it, then takes the
// nearest supported level, preferring lower.
export function closestThinkingLevel(level, model) {
  const supported = supportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  const start = EFFORT_ORDER.indexOf(level);
  for (let index = start; index >= 0; index -= 1) if (supported.includes(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
  return EFFORT_ORDER.find((item) => supported.includes(item)) ?? level;
}

export function readDefaultModel(settingsPath) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") {
    throw new Error("settings name no default model");
  }
  return { provider: settings.defaultProvider, model: settings.defaultModel };
}

export function writeDefaultModel(settingsPath, provider, model) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: model }, null, 2)}\n`,
    { mode: statSync(settingsPath).mode & 0o777 });
  renameSync(temporary, settingsPath);
}
