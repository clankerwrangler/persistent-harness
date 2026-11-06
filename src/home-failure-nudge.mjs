// Home hears about every other root's failed turn; nobody hears about Home's own.
// After its turn fails, wake it once it has stayed quiet, waiting longer the
// longer it keeps failing. The nudge only asks it to check; nothing is replayed.
export const HOME_NUDGE_DELAYS_MS = Object.freeze([5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]);
// Failures closer together than this belong to one incident and keep backing off.
export const HOME_NUDGE_INCIDENT_GAP_MS = 2 * 60 * 60_000;

export class HomeFailureNudge {
  constructor({ delaysMs = HOME_NUDGE_DELAYS_MS, incidentGapMs = HOME_NUDGE_INCIDENT_GAP_MS } = {}) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.some(delay => !Number.isSafeInteger(delay) || delay < 0)) {
      throw new Error("Home nudge delays must be non-negative integers");
    }
    this.delaysMs = [...delaysMs]; this.incidentGapMs = incidentGapMs;
    this.pending = null; this.lastFailureAt = null; this.sentInIncident = 0; this.failedSinceSettled = false;
  }

  // A later failure while one is pending keeps the earlier due time.
  failed(homeId, report, now) {
    if (this.lastFailureAt === null || now - this.lastFailureAt > this.incidentGapMs) this.sentInIncident = 0;
    this.lastFailureAt = now; this.failedSinceSettled = true;
    if (this.pending?.homeId === homeId) return;
    const delay = this.delaysMs[Math.min(this.sentInIncident, this.delaysMs.length - 1)];
    this.pending = { homeId, report, failedAt: now, dueAt: now + delay };
  }

  // A run reports its failure and waits for the receipt before it settles, so a
  // settle with no failure since the previous one is a run that succeeded. A
  // report delayed past its settle by a lost connection only re-arms the nudge.
  settled() {
    if (!this.failedSinceSettled) this.pending = null;
    this.failedSinceSettled = false;
  }

  due(now) { return this.pending && now >= this.pending.dueAt ? this.pending : null; }

  sent() { this.pending = null; this.sentInIncident++; }

  dropped() { this.pending = null; }
}
