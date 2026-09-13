const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CHILD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return [...THINKING_LEVELS].filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function requireModel(model, context) {
  if (!model || typeof model !== "object" || Array.isArray(model)) throw new Error(`${context} is required`);
  if (typeof model.provider !== "string" || !model.provider || model.provider.length > 128) {
    throw new Error(`${context}.provider must be a non-empty bounded string`);
  }
  if (typeof model.id !== "string" || !model.id || model.id.length > 256) {
    throw new Error(`${context}.id must be a non-empty bounded string`);
  }
  return { provider: model.provider, id: model.id };
}

function resolveExactModel(reference, availableModels, context) {
  if (typeof reference !== "string" || !reference || reference.length > 384) {
    throw new Error(`${context} must be a non-empty exact model reference`);
  }
  const canonicalMatches = availableModels.filter((model) => `${model.provider}/${model.id}` === reference);
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  const idMatches = availableModels.filter((model) => model.id === reference);
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) throw new Error(`${context} is ambiguous; use provider/model: ${reference}`);
  throw new Error(`${context} did not resolve exactly: ${reference}`);
}

function normalizeModels(models) {
  if (!Array.isArray(models) || models.length === 0 || models.length > 512) {
    throw new Error("availableModels must contain 1 through 512 models");
  }
  const seen = new Set();
  return models.map((model, index) => {
    const resolved = requireModel(model, `availableModels[${index}]`);
    const key = `${resolved.provider}\0${resolved.id}`;
    if (seen.has(key)) throw new Error(`availableModels contains a duplicate: ${resolved.provider}/${resolved.id}`);
    seen.add(key);
    const reasoning = model.reasoning === true;
    if (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.length === 0) {
      throw new Error(`availableModels[${index}].thinkingLevels must be a non-empty array`);
    }
    const thinkingLevels = [...new Set(model.thinkingLevels)];
    if (thinkingLevels.length !== model.thinkingLevels.length
      || thinkingLevels.some((level) => !THINKING_LEVELS.has(level))) {
      throw new Error(`availableModels[${index}].thinkingLevels contains an unsupported or duplicate level`);
    }
    if (!reasoning && (thinkingLevels.length !== 1 || thinkingLevels[0] !== "off")) {
      throw new Error(`availableModels[${index}] without reasoning must support only off`);
    }
    return {
      ...resolved,
      name: typeof model.name === "string" && model.name.length <= 256 ? model.name : model.id,
      reasoning,
      thinkingLevels,
    };
  });
}

function normalizeSkillCatalog(skills) {
  if (!Array.isArray(skills) || skills.length > 128) throw new Error("skillCatalog must contain at most 128 skills");
  const ids = new Set();
  return skills.map((skill, index) => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) throw new Error(`skillCatalog[${index}] must be an object`);
    for (const key of ["id", "version", "contentHash", "skillPath"]) {
      if (typeof skill[key] !== "string" || !skill[key] || skill[key].length > 4096) {
        throw new Error(`skillCatalog[${index}].${key} must be a non-empty bounded string`);
      }
    }
    if (ids.has(skill.id)) throw new Error(`skillCatalog contains duplicate ID: ${skill.id}`);
    ids.add(skill.id);
    if (typeof skill.pythonBacked !== "boolean") throw new Error(`skillCatalog[${index}].pythonBacked must be boolean`);
    return {
      id: skill.id,
      version: skill.version,
      contentHash: skill.contentHash,
      skillPath: skill.skillPath,
      pythonBacked: skill.pythonBacked,
    };
  });
}

function resolveThinking(explicit, configured, parent) {
  const candidate = explicit ?? configured ?? parent;
  const source = explicit !== null && explicit !== undefined
    ? "explicit"
    : configured !== null && configured !== undefined ? "configured" : "parent";
  if (!THINKING_LEVELS.has(candidate)) {
    throw new Error(`${source} child thinking level is unsupported: ${String(candidate)}`);
  }
  return { requested: explicit ?? null, resolved: candidate, source };
}

export function resolveChildLaunchPolicy({
  request,
  parent,
  configuredModel = null,
  configuredThinkingLevel = null,
  maxDepth = 1,
}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("child request must be an object");
  if (!parent || parent.kind === undefined) throw new Error("parent session is required");
  const forkContext = request.forkContext === undefined ? false : request.forkContext;
  if (typeof forkContext !== "boolean") throw new Error("fork_context must be boolean");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) throw new Error("maxDepth must be from 0 through 4");
  const depth = parent.depth + 1;
  if (depth > maxDepth) throw new Error(`maximum child depth ${maxDepth} would be exceeded`);
  if (typeof request.prompt !== "string" || !request.prompt.trim() || Buffer.byteLength(request.prompt, "utf8") > 64 * 1024) {
    throw new Error("child prompt must be a non-empty string of at most 65536 UTF-8 bytes");
  }
  if (request.name !== null && request.name !== undefined && !CHILD_NAME.test(request.name)) {
    throw new Error("child name must start with an alphanumeric character and contain at most 64 alphanumeric, dot, underscore, or hyphen characters");
  }

  const availableModels = normalizeModels(request.availableModels);
  const parentModel = requireModel(request.parentModel, "parentModel");
  const parentMatch = availableModels.find((model) => model.provider === parentModel.provider && model.id === parentModel.id);
  if (!parentMatch) throw new Error(`parent model is not available: ${parentModel.provider}/${parentModel.id}`);

  const requestedModel = request.model ?? null;
  const modelSource = requestedModel !== null ? "explicit" : configuredModel !== null ? "configured" : "parent";
  const model = modelSource === "parent"
    ? parentMatch
    : resolveExactModel(modelSource === "explicit" ? requestedModel : configuredModel, availableModels, `${modelSource} child model`);
  const thinking = resolveThinking(request.thinkingLevel ?? null, configuredThinkingLevel, request.parentThinkingLevel);
  if (!model.thinkingLevels.includes(thinking.resolved)) {
    throw new Error(
      `${thinking.source} child thinking level ${thinking.resolved} is not supported by ${model.provider}/${model.id}; supported levels: ${model.thinkingLevels.join(", ")}`,
    );
  }
  const skillCatalog = normalizeSkillCatalog(request.skillCatalog);
  const capabilities = skillCatalog
    .filter((skill) => skill.pythonBacked)
    .map(({ id, version, contentHash, skillPath }) => ({ id, version, contentHash, skillPath }));

  return {
    depth,
    cwd: parent.cwd,
    repositoryRoot: parent.repositoryRoot,
    prompt: request.prompt.trim(),
    forkContext,
    name: request.name ?? null,
    model: {
      requested: requestedModel,
      resolved: { provider: model.provider, id: model.id },
      source: modelSource,
    },
    thinking: {
      requested: thinking.requested,
      resolved: thinking.resolved,
      source: thinking.source,
    },
    skillCatalog,
    capabilities,
  };
}

function preferredEntries(preferred) {
  const values = Array.isArray(preferred) ? preferred : preferred == null ? [] : [preferred];
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (typeof value.provider !== "string" || typeof value.id !== "string") continue;
    const key = `${value.provider}\0${value.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ provider: value.provider, id: value.id });
  }
  return entries;
}

function preferredIndex(filtered, preferred) {
  const exact = filtered.findIndex((model) => model.provider === preferred.provider && model.id === preferred.id);
  if (exact >= 0) return exact;
  const idMatches = filtered.reduce((count, model) => count + (model.id === preferred.id ? 1 : 0), 0);
  if (idMatches === 1) return filtered.findIndex((model) => model.id === preferred.id);
  return -1;
}

export function findModels(models, query = "", limit = 50, preferred = null) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
  const needle = String(query ?? "").trim().toLowerCase();
  const filtered = normalizeModels(models)
    .filter((model) => !needle || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle));
  for (const entry of preferredEntries(preferred).reverse()) {
    const index = preferredIndex(filtered, entry);
    if (index > 0) {
      const [preferredModel] = filtered.splice(index, 1);
      filtered.unshift(preferredModel);
    }
  }
  return filtered.slice(0, limit);
}

export const childPolicyInternals = { CHILD_NAME, THINKING_LEVELS, normalizeSkillCatalog, resolveExactModel };
