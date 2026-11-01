import { writeFileSync } from "node:fs";

// Out of memory, the operating system should give up work a session started, never a session actor.
// The process's children inherit this.
export function preferAsOomVictim(pid) {
  try { writeFileSync(`/proc/${pid}/oom_score_adj`, "500"); } catch {}
}
