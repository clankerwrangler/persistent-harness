import { supportedThinkingLevels } from "./child-policy.mjs";

const MAX_MODELS = 512;
const MAX_PROVIDER_LENGTH = 128;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_CONTEXT_WINDOW = 10_000_000;
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function boundedString(value, context, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || Buffer.byteLength(value, "utf8") > maxLength) {
    throw new Error(`${context} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function validateThinkingLevelMap(model, context) {
  const map = model.thinkingLevelMap;
  if (map === undefined) return;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`${context}.thinkingLevelMap must be an object when provided`);
  }
  for (const effort of EFFORTS) {
    if (!Object.hasOwn(map, effort)) continue;
    const value = map[effort];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`${context}.thinkingLevelMap.${effort} must be a string, null, or undefined`);
    }
  }
}

function projectModel(model, index) {
  const context = `availableModels[${index}]`;
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    throw new Error(`${context} must be an object`);
  }
  const provider = boundedString(model.provider, `${context}.provider`, MAX_PROVIDER_LENGTH);
  const id = boundedString(model.id, `${context}.id`, MAX_ID_LENGTH);
  const name = boundedString(model.name, `${context}.name`, MAX_NAME_LENGTH);
  if (typeof model.reasoning !== "boolean") throw new Error(`${context}.reasoning must be boolean`);
  if (!Number.isSafeInteger(model.contextWindow)
    || model.contextWindow <= 0
    || model.contextWindow > MAX_CONTEXT_WINDOW) {
    throw new Error(`${context}.contextWindow must be a positive integer of at most ${MAX_CONTEXT_WINDOW}`);
  }
  validateThinkingLevelMap(model, context);
  const thinkingLevels = supportedThinkingLevels(model);
  return { provider, id, name, reasoning: model.reasoning, thinkingLevels, contextWindow: model.contextWindow };
}

/**
 * Project Pi model objects to the complete, credential-blind inference catalog.
 * The input and its members are never mutated or retained in the result.
 */
export function projectAvailableModels(availableModels) {
  if (!Array.isArray(availableModels) || availableModels.length > MAX_MODELS) {
    throw new Error(`availableModels must be an array of at most ${MAX_MODELS} models`);
  }
  const seen = new Set();
  return availableModels.map((model, index) => {
    const projected = projectModel(model, index);
    const key = `${projected.provider}\0${projected.id}`;
    if (seen.has(key)) {
      throw new Error(`availableModels contains a duplicate provider/id: ${projected.provider}/${projected.id}`);
    }
    seen.add(key);
    return projected;
  });
}

/** Select one projected model by both exact provider and exact id. */
export function resolveModelSelection(availableModels, { provider, id } = {}) {
  boundedString(provider, "selection.provider", MAX_PROVIDER_LENGTH);
  boundedString(id, "selection.id", MAX_ID_LENGTH);
  const models = projectAvailableModels(availableModels);
  const model = models.find((candidate) => candidate.provider === provider && candidate.id === id);
  if (!model) throw new Error(`model did not resolve exactly: ${provider}/${id}`);
  return model;
}

/** Validate a Pi inference effort enum and model-specific support. */
export function validateInferenceEffort(effort, model) {
  if (typeof effort !== "string" || !EFFORTS.has(effort)) {
    throw new Error(`unsupported inference effort: ${String(effort)}`);
  }
  if (!model || !Array.isArray(model.thinkingLevels) || !model.thinkingLevels.includes(effort)) {
    const provider = typeof model?.provider === "string" ? model.provider : "unknown";
    const id = typeof model?.id === "string" ? model.id : "unknown";
    throw new Error(`inference effort ${effort} is not supported by ${provider}/${id}`);
  }
  return effort;
}
