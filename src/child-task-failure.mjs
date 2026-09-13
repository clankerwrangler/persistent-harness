export function extractProviderError(message) {
  if (!message || typeof message !== "object") return undefined;
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) return message.errorMessage.trim();
  if (typeof message.error === "string" && message.error.trim()) return message.error.trim();
  if (message.error && typeof message.error.message === "string" && message.error.message.trim()) {
    return message.error.message.trim();
  }
  if (Array.isArray(message.diagnostics)) {
    for (const item of message.diagnostics) {
      const nested = item?.error?.message ?? item?.message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}

function isEmptyAssistantContent(message) {
  return !Array.isArray(message?.content)
    || !message.content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text);
}

function isZeroTokens(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return true;
  return ["input", "output", "totalTokens", "cacheRead", "cacheWrite"].every((key) => !usage[key]);
}

export function boundErrorMessage(value, maxBytes = 1024) {
  if (typeof value !== "string" || !value) return value ?? null;
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let used = 0;
  let result = "";
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > budget) break;
    result += character;
    used += bytes;
  }
  return result + suffix;
}

export function assistantTurnFailureFromMessage(message) {
  if (!message || message.role !== "assistant") return null;
  const providerError = extractProviderError(message);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return boundErrorMessage(providerError || `assistant stopReason ${message.stopReason}`);
  }
  if (isEmptyAssistantContent(message) && isZeroTokens(message)) {
    return boundErrorMessage(providerError || "assistant turn produced empty content and 0 tokens");
  }
  return null;
}

export function assistantTurnFailureFromEvents(record) {
  if (!record?.lastAssistantMessageSeen) {
    return boundErrorMessage(record?.lastAssistantErrorMessage || "assistant turn settled without a message");
  }
  if (record.lastAssistantStopReason === "error" || record.lastAssistantStopReason === "aborted") {
    return boundErrorMessage(record.lastAssistantErrorMessage || `assistant stopReason ${record.lastAssistantStopReason}`);
  }
  if (record.lastAssistantEmpty && record.lastAssistantZeroTokens) {
    return boundErrorMessage(record.lastAssistantErrorMessage || "assistant turn produced empty content and 0 tokens");
  }
  return null;
}

export function captureAssistantTurn(record, message) {
  record.lastAssistantMessageSeen = true;
  record.lastAssistantStopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
  record.lastAssistantErrorMessage = extractProviderError(message);
  record.lastAssistantEmpty = isEmptyAssistantContent(message);
  record.lastAssistantZeroTokens = isZeroTokens(message);
}

export function resetAssistantTurn(record) {
  record.lastAssistantMessageSeen = false;
  record.lastAssistantStopReason = undefined;
  record.lastAssistantErrorMessage = undefined;
  record.lastAssistantEmpty = undefined;
  record.lastAssistantZeroTokens = undefined;
}
