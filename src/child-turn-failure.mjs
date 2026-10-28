import { types } from "node:util";
import { normalizeTurnFailure } from "./protocol.mjs";
export { normalizeTurnFailure } from "./protocol.mjs";
export const TURN_FAILURE_ENTRY_TYPE = "persistent-harness.turn-failure-v1";
export const TURN_FAILURE_ACCEPTED_TYPE = "persistent-harness.turn-failure-accepted-v1";
// This companion remains local canonical metadata; the v1 notice/receipt is unchanged.
export const TURN_FAILURE_DIAGNOSTIC_TYPE = "persistent-harness.turn-failure-diagnostic-v1";
const errorKinds = new Map([[Error.prototype, "error"], [TypeError.prototype, "type_error"],
  [RangeError.prototype, "range_error"], [SyntaxError.prototype, "syntax_error"],
  [ReferenceError.prototype, "reference_error"], [AggregateError.prototype, "aggregate_error"]]);
const errorCodes = new Set(["ERR_LOCAL_PREPARATION", "ERR_CONTEXT_DATA_LIMIT", "ERR_CONTEXT_DATA_TYPE",
  "ERR_CONTEXT_SOURCE_PROJECTION", "ERR_CONTEXT_HELPER_FAILED", "ERR_STREAM_DATA_LIMIT", "ERR_STREAM_FAILED",
  "ERR_COMPACTION_STALE_SNAPSHOT", "ERR_COMPACTION_COMMITTED"]);

const origins = new Set(["drive_rejection", "tool_tail_rejection", "async_callback"]);
const operations = new Set(["drive", "tool_tail", "callback", "extension_message", "extension_user_input", "compaction_callback",
  "tool_update", "message_commit", "message_hook", "context_refresh", "message_publish", "after_commit", "run_start", "recovery",
  "threshold_preflight", "queued_delivery", "inference", "settlement"]);
export function turnFailureSiteTokens(origin, operation) {
  return { origin: origins.has(origin) ? origin : "unknown", operation: operations.has(operation) ? operation : "unknown" };
}

// Reject proxies before reflection, including revoked proxies. Never read name,
// message, stack, cause, inherited properties, or invoke user formatting hooks.
export function turnFailureErrorTokens(error) {
  if (types.isProxy(error) || !types.isNativeError(error)) return { errorKind: "unknown", errorCode: "unknown" };
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return { errorKind: errorKinds.get(Object.getPrototypeOf(error)) ?? "native_error",
    errorCode: code && Object.hasOwn(code, "value") && errorCodes.has(code.value) ? code.value : "unknown" };
}

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
