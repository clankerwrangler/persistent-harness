const SETTINGS_MODEL = Object.freeze({ requested: null, resolved: null, source: "settings" });
const SETTINGS_THINKING = Object.freeze({ requested: null, resolved: null, source: "settings" });

function isPinnedModel(model) {
  return model?.source === "explicit"
    && model?.resolved
    && typeof model.resolved.provider === "string"
    && model.resolved.provider.length > 0
    && typeof model.resolved.id === "string"
    && model.resolved.id.length > 0;
}

function isPinnedThinking(thinking) {
  return thinking?.source === "explicit"
    && typeof thinking.resolved === "string"
    && thinking.resolved.length > 0;
}

/** Persist and expose only an explicit pin, or the live settings default. */
export function normalizeCronLaunch(launch = {}) {
  const model = isPinnedModel(launch?.model)
    ? {
        requested: typeof launch.model.requested === "string" && launch.model.requested
          ? launch.model.requested
          : `${launch.model.resolved.provider}/${launch.model.resolved.id}`,
        resolved: { provider: launch.model.resolved.provider, id: launch.model.resolved.id },
        source: "explicit",
      }
    : { ...SETTINGS_MODEL };
  const thinking = isPinnedThinking(launch?.thinking)
    ? {
        requested: typeof launch.thinking.requested === "string" && launch.thinking.requested
          ? launch.thinking.requested
          : launch.thinking.resolved,
        resolved: launch.thinking.resolved,
        source: "explicit",
      }
    : { ...SETTINGS_THINKING };
  return { model, thinking, capabilityIds: [] };
}

/** Build a job launch policy from an optional create or update pin. */
export function cronLaunchFromRequest({ provider = null, model = null, thinkingLevel = null } = {}) {
  return normalizeCronLaunch({
    model: provider && model
      ? { requested: `${provider}/${model}`, resolved: { provider, id: model }, source: "explicit" }
      : SETTINGS_MODEL,
    thinking: thinkingLevel
      ? { requested: thinkingLevel, resolved: thinkingLevel, source: "explicit" }
      : SETTINGS_THINKING,
  });
}

/** Apply an optional pin or clear onto the current job launch policy. */
export function mergeCronLaunch(current, patch = {}) {
  const hasModel = patch.provider !== undefined || patch.model !== undefined;
  const hasThinking = patch.thinkingLevel !== undefined;
  if (!hasModel && !hasThinking) return normalizeCronLaunch(current);
  const next = normalizeCronLaunch(current);
  if (hasModel) {
    next.model = patch.provider && patch.model
      ? { requested: `${patch.provider}/${patch.model}`, resolved: { provider: patch.provider, id: patch.model }, source: "explicit" }
      : { ...SETTINGS_MODEL };
  }
  if (hasThinking) {
    next.thinking = patch.thinkingLevel
      ? { requested: patch.thinkingLevel, resolved: patch.thinkingLevel, source: "explicit" }
      : { ...SETTINGS_THINKING };
  }
  return normalizeCronLaunch(next);
}
