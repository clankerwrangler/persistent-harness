// Model-boundary time stamps. The agent has no clock of its own, so each incoming
// message carries the local time it was recorded at. Tool results get one only
// after a long quiet stretch. Stamps derive from stored timestamps, never from
// "now", so earlier context renders identically on every request.
export const TOOL_RESULT_STAMP_GAP_MS = 15 * 60 * 1000;
const STAMPED_ROLES = new Set(["user", "custom"]);
const formats = new Map();

export function formatMessageTime(timestamp, timeZone) {
  const key = timeZone ?? "";
  if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }));
  return `[${formats.get(key).format(new Date(timestamp))}]`;
}

// Incoming messages lead with their time; tool output stays first and the time follows it.
function stamped(message, text, atEnd) {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const edge = atEnd ? content.at(-1) : content[0];
  if (edge?.type === "text" && edge.text === text) return message;
  return { ...message, content: atEnd ? [...content, { type: "text", text }] : [{ type: "text", text }, ...content] };
}

// timeZone defaults to the process zone (TZ or /etc/localtime).
export function renderMessageTimes(messages, { timeZone = process.env.PI_HARNESS_USER_TIMEZONE || undefined } = {}) {
  let last;
  return messages.map(message => {
    const time = message?.timestamp;
    if (!Number.isFinite(time) || time <= 0 || !Array.isArray(message.content) && typeof message.content !== "string") return message;
    const due = STAMPED_ROLES.has(message.role) || message.role === "toolResult" && last !== undefined && time - last >= TOOL_RESULT_STAMP_GAP_MS;
    if (message.role === "toolResult" && last === undefined) last = time;
    if (!due) return message;
    last = time;
    return stamped(message, formatMessageTime(time, timeZone), message.role === "toolResult");
  });
}
