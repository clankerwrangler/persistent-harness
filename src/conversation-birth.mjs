// Host-owned metadata travels with the existing canonical text/custom entry.
// Legacy and malformed values have no inferred birth.
export function conversationBirth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || value.version !== 1
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || typeof value.createdAt !== "string" || value.createdAt.length > 32) return undefined;
  const date = new Date(value.createdAt);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value.createdAt) return undefined;
  return { version: 1, createdAt: value.createdAt, sequence: value.sequence };
}
export function birthOrder(value) {
  const birth = conversationBirth(value);
  return birth ? { createdAt: birth.createdAt, timelineSequence: birth.sequence } : {};
}
export function timelineSequence(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }

// The owner supplies active ancestry, never the whole session file. Allocation
// performs no I/O and creates no independent write/failure boundary.
export class ConversationBirthClock {
  constructor(entries = [], { now = () => new Date().toISOString() } = {}) { this.now = now; this.reset(entries); }
  reset(entries) {
    this.sequence = 0;
    for (const entry of entries) {
      const values = entry.type === "message" && entry.message?.role === "assistant"
        ? (Array.isArray(entry.message.content) ? entry.message.content : []).filter(part => part.type === "text").map(part => part.harnessBirth)
        : entry.type === "custom" && entry.customType === "persistent-harness.progress-v1" ? [entry.data?.harnessBirth] : [];
      for (const value of values) this.sequence = Math.max(this.sequence, conversationBirth(value)?.sequence ?? 0);
    }
  }
  next() {
    const value = conversationBirth({ version: 1, createdAt: this.now(), sequence: this.sequence + 1 });
    if (!value) { console.warn("Conversation birth metadata unavailable"); return undefined; }
    this.sequence = value.sequence; return value;
  }
}

// Keep the first public identity even across a canonical/live reconciliation.
// Empty placeholders may acquire their first birth; published text may not move.
export class ConversationOrder {
  #rows = new Map();
  keep(incoming, visible = true) {
    const sequence = timelineSequence(incoming.timelineSequence);
    let row = this.#rows.get(incoming.id);
    if (!row) {
      row = { createdAt: incoming.createdAt, sequence, visible: false }; this.#rows.set(incoming.id, row);
      while (this.#rows.size > 512) this.#rows.delete(this.#rows.keys().next().value);
    } else if (sequence && !row.sequence && !row.visible) {
      row.createdAt = incoming.createdAt; row.sequence = sequence;
    } else if (sequence && (sequence !== row.sequence || incoming.createdAt !== row.createdAt) && !row.reported) {
      row.reported = true; console.warn("Conflicting conversation birth metadata ignored");
    }
    row.visible ||= visible;
    const result = { ...incoming, createdAt: row.createdAt }; delete result.timelineSequence;
    if (row.sequence) result.timelineSequence = row.sequence;
    return result;
  }
}
