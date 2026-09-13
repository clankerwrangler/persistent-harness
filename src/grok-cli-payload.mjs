import { GROK_CLI_PROVIDER } from "./grok-cli-remaining.mjs";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function grokCliToolsSpecified(payload) {
  return record(payload) && Array.isArray(payload.tools) && payload.tools.length > 0;
}

/** Drop tool_choice when grok-cli has no tools. Pi summarization always sets toolChoice "none".
 * Compact calls streamSimple without onPayload, so before_provider_request does not run;
 * grok-cli streamSimple must sanitize the payload itself. */
export function sanitizeGrokCliToolChoice(payload) {
  if (!record(payload) || grokCliToolsSpecified(payload)) return payload;
  delete payload.tool_choice;
  delete payload.toolChoice;
  return payload;
}

export function sanitizeGrokCliProviderPayload(payload, provider) {
  if (provider !== GROK_CLI_PROVIDER) return payload;
  return sanitizeGrokCliToolChoice(payload);
}
