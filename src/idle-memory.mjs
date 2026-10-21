import { setImmediate as deferred } from "node:timers/promises";

export const IDLE_MEMORY_DELAY_MS = 30_000;
export const IDLE_MEMORY_GAP_BYTES = 192 * 1024 * 1024;

/** Optional reducing GC; true means invoked, not that any bytes were freed. */
export async function reduceIdleMemory(eligible, { gc = globalThis.gc, memoryUsage = process.memoryUsage } = {}) {
  if (typeof gc !== "function" || !eligible()) return false;
  // Give already-arriving input/cancellation a boundary before the noncancelable call.
  await deferred();
  if (!eligible()) return false;
  const { rss, heapTotal, external } = memoryUsage();
  if (![rss, heapTotal, external].every(value => Number.isSafeInteger(value) && value >= 0)
    || rss - heapTotal - external < IDLE_MEMORY_GAP_BYTES) return false;
  // This gap is an eligibility heuristic, not a pool/native attribution.
  await gc({ type: "major", execution: "async", flavor: "last-resort" });
  return true;
}
