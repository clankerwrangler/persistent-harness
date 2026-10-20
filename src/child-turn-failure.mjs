import { normalizeTurnFailure } from "./protocol.mjs";
export { normalizeTurnFailure } from "./protocol.mjs";
export const TURN_FAILURE_ENTRY_TYPE = "persistent-harness.turn-failure-v1";
export const TURN_FAILURE_ACCEPTED_TYPE = "persistent-harness.turn-failure-accepted-v1";
// The latest ordered acceptance witness is a frontier, not a list of all old
// receipts. Restore reads one witness body and only the pending marker suffix.
export function pendingTurnFailureJournal(headers, read) {
  let acceptedThrough = -1;
  const witness = headers.findLast(header => header.type === "custom" && header.customType === TURN_FAILURE_ACCEPTED_TYPE);
  if (witness) {
    const data = read(witness.id)?.data, target = headers[data?.position];
    if (data?.version === 1 && Number.isSafeInteger(data.position) && data.position >= 0
      && data.position < witness.position && target?.id === data.entryId
      && target.type === "custom" && target.customType === TURN_FAILURE_ENTRY_TYPE) acceptedThrough = data.position;
  }
  const pending = [];
  for (let position = acceptedThrough + 1; position < headers.length; position++) {
    const header = headers[position];
    if (header.type !== "custom" || header.customType !== TURN_FAILURE_ENTRY_TYPE) continue;
    try { pending.push({ report: normalizeTurnFailure(read(header.id)?.data), journal: { entryId: header.id, position } }); } catch {}
  }
  return { acceptedThrough, pending };
}

// The canonical journal owns pending reports. Retries admit only their fixed
// receipts; the existing supervisor lifecycle-message queue owns parent delivery.
export class TurnFailureReporter {
  constructor({ client, onRecorded = async () => {}, acceptedThrough = -1, retryMs = 1000 }) {
    this.client = client; this.onRecorded = onRecorded; this.acceptedThrough = acceptedThrough; this.retryMs = retryMs; this.pending = new Map(); this.closed = false;
  }
  remember(value, journal) {
    const report = normalizeTurnFailure(value);
    if (journal && journal.position <= this.acceptedThrough) return;
    if (!this.pending.has(report.turnId)) this.pending.set(report.turnId, { report, journal });
  }
  async flush() {
    if (this.closed) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
      if (!this.closed && this.pending.size && !this.timer && this.client()?.isConnected) void this.flush();
    });
    return this.flushing;
  }
  async drain() {
    const client = this.client();
    if (!client?.isConnected) return;
    try {
      for (const [id, { report, journal }] of this.pending) {
        if (this.closed || client !== this.client()) return;
        const receipt = await client.request("record_actor_turn_failure", report);
        if (receipt?.recorded !== true) throw new Error("turn failure receipt was not recorded");
        await this.onRecorded(report, journal);
        if (journal) this.acceptedThrough = journal.position;
        this.pending.delete(id);
      }
    } catch {
      if (!this.closed && !this.timer) {
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.retryMs);
        this.timer.unref?.();
      }
    }
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
