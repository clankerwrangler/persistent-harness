// Fast is a session preference, not a model alias or a reasoning level.
export function supportsFastMode(model) {
  return ["gpt-6-astra", "gpt-6.1-sol"].includes(model?.id)
    && ((model.provider === "openai-codex" && model.api === "openai-codex-responses")
      || (model.provider === "openai" && model.api === "openai-responses"));
}
export function fastModeOptions(model, enabled) {
  return enabled === true && supportsFastMode(model) ? { serviceTier: "priority" } : {};
}

// Pi 0.99.1 streamSimple drops serviceTier. Keep the ordinary route unchanged;
// Fast uses the public detailed stream with the same public simple-option helpers.
export function streamSessionRequest(models, model, context, options, { api, simpleOptions }) {
  if (options.serviceTier !== "priority" || !supportsFastMode(model)) return models.streamSimple(model, context, options);
  const transcript = api.normalizeContext(context);
  const clamped = options.reasoning ? api.clampThinkingLevel(model, options.reasoning) : undefined;
  return models.stream(model, transcript, {
    ...simpleOptions.buildBaseOptions(model, transcript, options, options.apiKey),
    toolChoice: options.toolChoice,
    reasoningEffort: clamped === "off" ? undefined : clamped,
    serviceTier: "priority",
    // ModelRuntime applies this before the provider receives detailed options.
    transformHeaders: options.transformHeaders,
  });
}
