import { ConversationOrder } from "./conversation-birth.mjs";
const MAX_SNAPSHOT_BYTES = 256 * 1024;

// Read-only public event state. Pi remains the only transcript writer.
export class LiveConversation {
  #rows = new Map();
  #order = new ConversationOrder();
  #bytes = 0;
  #truncated = false;
  get truncated() { return this.#truncated || [...this.#rows.values()].some((row) => row.truncated); }

  accept(event) {
    if (event.type === "progress_entry") {
      const ordered = this.#order.keep({ id: event.entryId, createdAt: event.createdAt, timelineSequence: event.timelineSequence });
      const { id, ...fields } = ordered; event = { ...event, ...fields };
      if (!ordered.timelineSequence) delete event.timelineSequence;
    }
    if (event.type === "agent_start") this.#truncated = false;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!["text_start", "text_delta", "text_end"].includes(update?.type)
        || typeof event.messageId !== "string" || !Number.isFinite(Date.parse(event.createdAt))) return event;
      const ordered = this.#order.keep({ id: event.messageId, createdAt: event.createdAt, timelineSequence: event.timelineSequence },
        update.type !== "text_start" && Boolean((update.delta ?? update.text ?? "").trim()));
      const { id, ...fields } = ordered; event = { ...event, ...fields };
      if (!ordered.timelineSequence) delete event.timelineSequence;
      const row = this.#row(ordered);
      if (update.type === "text_delta") this.#append(row, update.delta);
      if (update.type === "text_end") {
        if (typeof update.text === "string" && !event.truncated) this.#replace(row, update.text);
        row.status = "complete";
      }
      this.#trim();
      return event;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const content = (event.message.content ?? []).map(part => {
        if (part.type !== "text" || typeof part.id !== "string" || !Number.isFinite(Date.parse(part.createdAt))) return part;
        const ordered = this.#order.keep(part, Boolean(part.text?.trim()));
        const row = this.#row(ordered);
        if (!event.truncated) this.#replace(row, part.text);
        row.status = "complete";
        return ordered;
      });
      event = { ...event, message: { ...event.message, content } };
      this.#trim();
    }
    if (event.type === "agent_settled") for (const row of this.#rows.values()) row.status = "complete";
    return event;
  }

  remove(id) { const row = this.#rows.get(id); if (row) { this.#bytes -= row.bytes; this.#rows.delete(id); } }

  upsert(message) {
    const row = this.#row(["assistant", "progress"].includes(message.role)
      ? this.#order.keep(message, Boolean(message.text?.trim())) : message);
    const { text, createdAt, timelineSequence, ...fields } = message;
    row.fields = fields; row.status = message.status;
    this.#replace(row, text); this.#trim();
  }

  snapshot() {
    return [...this.#rows.values()].filter((row) => row.bytes || row.truncated).map((row) => ({ id: row.id, role: "assistant", ...(row.fields ?? {}),
      text: row.chunks.join("") + (row.truncated ? "…" : ""), createdAt: row.createdAt, ...(row.timelineSequence ? { timelineSequence: row.timelineSequence } : {}), status: row.status,
      ...(row.truncated ? { truncated: true } : {}) }));
  }

  reconcile(canonicalIds) {
    for (const [id, row] of this.#rows) if (row.status === "complete" && canonicalIds.has(id)) { this.#bytes -= row.bytes; this.#rows.delete(id); }
  }

  #row({ id, createdAt, timelineSequence }) {
    let row = this.#rows.get(id);
    if (!row) { row = { id, status: "streaming", chunks: [], bytes: 0, truncated: false }; this.#rows.set(id, row); }
    row.createdAt = createdAt; row.timelineSequence = timelineSequence;
    return row;
  }
  #replace(row, text) { this.#bytes -= row.bytes; row.chunks = []; row.bytes = 0; row.truncated = false; this.#append(row, text); }
  #append(row, text) {
    if (typeof text !== "string" || !text || row.truncated) return;
    const bytes = Buffer.from(text, "utf8");
    const available = MAX_SNAPSHOT_BYTES - this.#bytes;
    if (bytes.length <= available) { row.chunks.push(text); row.bytes += bytes.length; this.#bytes += bytes.length; return; }
    let length = Math.max(0, available); let prefix = "";
    while (length > 0) {
      try { prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); break; }
      catch { length -= 1; }
    }
    row.chunks.push(prefix); row.bytes += length; this.#bytes += length; row.truncated = true;
  }
  #trim() {
    let bytes = [...this.#rows.values()].reduce((sum, row) => sum + row.bytes, 0);
    for (const [id, row] of this.#rows) {
      if (bytes <= MAX_SNAPSHOT_BYTES && this.#rows.size <= 512) break;
      if (row.status !== "complete" && this.#rows.size <= 512) continue;
      if (row.status !== "complete") this.#truncated = true;
      bytes -= row.bytes; this.#bytes -= row.bytes; this.#rows.delete(id);
    }
  }
}
