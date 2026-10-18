import { getHeapStatistics } from "node:v8";

/** Explicit numeric observation only: no collection, snapshots or retained state. */
export function nodeMemoryDiagnostics() {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  return { rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed,
    external: memory.external, arrayBuffers: memory.arrayBuffers,
    v8HeapTotal: heap.total_heap_size, v8HeapUsed: heap.used_heap_size };
}

export function workerMemoryDiagnostics(value) {
  const keys = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers", "v8HeapTotal", "v8HeapUsed"];
  if (value?.version !== 1 || !value.node || keys.some(key => !Number.isSafeInteger(value.node[key]) || value.node[key] < 0)) return { state: "unavailable-error" };
  const python = value.python && ["unavailable-busy", "unavailable-not-running", "unavailable-error"].includes(value.python.state)
    ? { state: value.python.state } : historyMemoryDiagnostics(value.python);
  return { version: 1, node: Object.fromEntries(keys.map(key => [key, value.node[key]])), python };
}

export function historyMemoryDiagnostics(value) {
  const counts = ["outEntries", "reprEntries", "mimeEntries", "visited", "unknown",
    "containers", "containerBytes", "strings", "stringBytes", "bytes", "bytesBytes"];
  if (!value || value.version !== 1 || !["complete", "truncated", "unknown"].includes(value.state)
    || Object.keys(value).length !== counts.length + 2
    || counts.some(key => !(value[key] === null && counts.indexOf(key) < 3)
      && (!Number.isSafeInteger(value[key]) || value[key] < 0))) return { state: "unavailable-error" };
  // Return fixed fields only, even if a peer sends an unexpected property.
  return { version: 1, state: value.state, ...Object.fromEntries(counts.map(key => [key, value[key]])) };
}
