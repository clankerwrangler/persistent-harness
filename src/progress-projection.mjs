const MAX_HEADING_CHARACTERS = 160;
const MAX_HEADING_BYTES = 512;
const MAX_PENDING_LINE_CHARACTERS = 512;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const UNSAFE_MARKUP = /[`<>{}\[\]\p{Cf}]/u;
const STANDALONE_HEADING = /^\s*\*\*([^*\r\n]{1,160})\*\*\s*$/u;

export const PROGRESS_ENTRY_TYPE = "persistent-harness.progress-v1";

export function normalizeProgressHeading(value) {
  if (typeof value !== "string" || CONTROL.test(value)) return undefined;
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized || [...normalized].length > MAX_HEADING_CHARACTERS || Buffer.byteLength(normalized, "utf8") > MAX_HEADING_BYTES) return undefined;
  if (UNSAFE_MARKUP.test(normalized)) return undefined;
  return normalized;
}

export function projectProgressEntry(entry) {
  if (entry?.type !== "custom" || entry.customType !== PROGRESS_ENTRY_TYPE
    || typeof entry.id !== "string" || !entry.id || entry.id.length > 128
    || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
  const summary = normalizeProgressHeading(entry.data.summary);
  const createdAt = new Date(entry.timestamp);
  if (!summary || Number.isNaN(createdAt.valueOf())) return undefined;
  return { kind: "progress", id: entry.id, summary, createdAt: createdAt.toISOString() };
}

function headingFromLine(line) {
  const match = typeof line === "string" ? line.match(STANDALONE_HEADING) : null;
  return normalizeProgressHeading(match?.[1]);
}

/**
 * Pi merges provider summaries and raw reasoning into the same `thinking`
 * event type and erases provenance. The API allowlist plus strict standalone
 * formatting is conservative risk reduction, not proof that a provider line
 * originated from its summary channel. All unsupported APIs fail closed.
 */
export function isEligibleProgressMessage(message) {
  return message?.role === "assistant"
    && message.api === "openai-codex-responses"
    && message.provider === "openai-codex";
}

/**
 * Incrementally extracts only completed standalone bold lines. It never
 * returns the surrounding thinking text and bounds unfinished input.
 */
export class ProgressHeadingTracker {
  #buffers = new Map();
  #latest;

  get latest() { return this.#latest; }

  reset() {
    this.#buffers.clear();
    this.#latest = undefined;
  }

  update(message, assistantEvent) {
    if (!isEligibleProgressMessage(message) || !assistantEvent || typeof assistantEvent !== "object") return undefined;
    const index = Number.isInteger(assistantEvent.contentIndex) ? assistantEvent.contentIndex : null;
    if (assistantEvent.type === "thinking_start" && index !== null) {
      this.#buffers.set(index, { text: "", overflowed: false });
      return undefined;
    }
    if (assistantEvent.type === "thinking_delta" && index !== null && typeof assistantEvent.delta === "string") {
      const state = this.#buffers.get(index) ?? { text: "", overflowed: false };
      this.#buffers.set(index, state);
      this.#consume(state, assistantEvent.delta, false);
      return this.#latest;
    }
    if (assistantEvent.type === "thinking_end" && index !== null) {
      const state = this.#buffers.get(index);
      if (state) this.#consume(state, "", true);
      this.#buffers.delete(index);
      return this.#latest;
    }
    return undefined;
  }

  #consume(state, delta, finish) {
    let remaining = String(delta);
    while (true) {
      const newline = remaining.search(/[\r\n]/);
      if (newline < 0) break;
      const segment = remaining.slice(0, newline);
      if (!state.overflowed) {
        const summary = headingFromLine(`${state.text}${segment}`);
        if (summary) this.#latest = summary;
      }
      state.text = "";
      state.overflowed = false;
      const separatorLength = remaining[newline] === "\r" && remaining[newline + 1] === "\n" ? 2 : 1;
      remaining = remaining.slice(newline + separatorLength);
    }
    if (!state.overflowed) {
      if (state.text.length + remaining.length <= MAX_PENDING_LINE_CHARACTERS) state.text += remaining;
      else { state.text = ""; state.overflowed = true; }
    }
    if (finish) {
      if (!state.overflowed) {
        const summary = headingFromLine(state.text);
        if (summary) this.#latest = summary;
      }
      state.text = "";
      state.overflowed = false;
    }
  }
}
