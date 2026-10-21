import path from "node:path";
import { HarnessSupervisor as Supervisor } from "../../src/supervisor.mjs";
export * from "../../src/supervisor.mjs";

// Lifecycle fixtures must not create workspace scratch or inspect live background owners.
export class HarnessSupervisor extends Supervisor {
  constructor(options) {
    const state = path.dirname(options.databasePath);
    super({ scratchDirectory: path.join(state, "scratch"), backgroundJobsDirectory: path.join(state, "background-jobs"), ...options });
  }
}
