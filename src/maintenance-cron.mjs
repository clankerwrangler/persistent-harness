import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { HarnessStore } from "./store.mjs";
import { CronStore } from "./cron-store.mjs";
import { CronScheduler } from "./cron-scheduler.mjs";
import { PROTOCOL_VERSION, validateRequest } from "./protocol.mjs";

const RUN_STATUSES = new Set(["claimed", "running", "completed", "failed", "unknown", "skipped_overlap"]);
const ARMED_DISPOSITIONS = new Set(["armed", "claimed", "running", "completed"]);
function safeStatus(value) { return value == null ? null : RUN_STATUSES.has(value) ? value : "unknown"; }

function disposition(job, runStatus) {
  if (!job) return "missing";
  if (job.state === "removed") return "removed";
  // A completed job can still have a claimed run. Inspect the run outcome, not its label.
  if (job.lastStatus != null || runStatus != null) return runStatus ?? "unknown";
  if (job.state === "paused" && !job.enabled && job.fireCount === 0) return "paused";
  if (job.state === "scheduled" && job.enabled && job.fireCount === 0) return "armed";
  return "unknown";
}

// The controller owns authorization, stopped-writer staging, and process lifetime.
// It calls ensure-armed only after its durable no-more-service-stops phase.
// These operations use the canonical writer connection but never start a scheduler.
export function maintenanceCron({ databasePath, intent, operation = "inspect", now = Date.now() }) {
  let phase = "validation";
  let metadata; let cron; let receipt;
  try {
    if (!path.isAbsolute(databasePath ?? "") || !lstatSync(databasePath).isFile()) throw new Error("existing canonical database is required");
    if (!["admit", "inspect", "ensure-armed"].includes(operation) || !Number.isSafeInteger(now)) throw new Error("maintenance operation is invalid");
    if (!intent || typeof intent !== "object" || Array.isArray(intent)
      || Object.keys(intent).some((key) => !["version", "jobId", "originSessionId", "request"].includes(key))
      || intent.version !== 1 || typeof intent.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(intent.jobId)
      || typeof intent.originSessionId !== "string" || !intent.originSessionId || intent.originSessionId.length > 128) throw new Error("maintenance intent is invalid");
    if (!intent.request || typeof intent.request !== "object" || Array.isArray(intent.request) || Object.hasOwn(intent.request, "action")) throw new Error("maintenance request is invalid");
    const { params } = validateRequest({ version: PROTOCOL_VERSION, id: "maintenance-validation", type: "cron_job",
      params: { ...intent.request, action: "create" } });
    if (params.executionMode !== "origin" || params.schedule.kind !== "at" || !(params.repeat == null || params.repeat === 1)) {
      throw new Error("maintenance continuation must be one finite origin job");
    }
    const intentSha256 = createHash("sha256").update(JSON.stringify({ jobId: intent.jobId, originSessionId: intent.originSessionId, params })).digest("hex");
    phase = "store-open";
    metadata = new HarnessStore(databasePath, { readOnly: true });
    // Both connections use this one canonical database and its durable WAL/SHM directory.
    cron = new CronStore(databasePath);
    const scheduler = new CronScheduler({ cronStore: cron, sessionStore: metadata,
      dispatchRun() { throw new Error("maintenance must not dispatch runs"); } });
    const inspect = () => {
      const { job, runStatus } = scheduler.inspectCreation(intent.originSessionId, params, { jobId: intent.jobId });
      return { job, runStatus: safeStatus(runStatus) };
    };
    phase = operation === "ensure-armed" ? "arming" : "admission";
    let { job, runStatus } = inspect();
    const reused = Boolean(job);
    let armingAction = operation === "ensure-armed" ? "observed" : null;
    if (operation === "admit" && !job) {
      scheduler.create(intent.originSessionId, params, now, { jobId: intent.jobId, initiallyPaused: true });
      ({ job, runStatus } = inspect());
    } else if (operation === "ensure-armed" && disposition(job, runStatus) === "paused") {
      try {
        scheduler.resume(job.jobId, now, { expectedJob: job });
        armingAction = "transitioned";
        ({ job, runStatus } = inspect());
      } catch (error) {
        // Another canonical writer, or a lost post-commit ACK, can win the resume.
        const current = inspect();
        if (!current.job || disposition(current.job, current.runStatus) === "paused") throw error;
        ({ job, runStatus } = current);
      }
    }
    const currentDisposition = disposition(job, runStatus);
    receipt = { version: 1, operation, found: Boolean(job), jobId: intent.jobId, originSessionId: intent.originSessionId,
      intentSha256, disposition: currentDisposition, armed: ARMED_DISPOSITIONS.has(currentDisposition), armingAction,
      executionMode: job?.executionMode ?? null, state: job?.state ?? null, enabled: job?.enabled ?? null,
      repeat: job?.repeat ?? null, fireCount: job?.fireCount ?? null, lastStatus: safeStatus(job?.lastStatus), runStatus,
      createdAt: job?.createdAt ?? null, nextRunAt: job?.nextRunAt ?? null, reused, mutationPossible: true };
    if (operation === "ensure-armed" && !receipt.armed) throw new Error("maintenance continuation is not armable");
    return receipt;
  } catch (cause) {
    const error = new Error("canonical maintenance admission failed", { cause });
    error.phase = phase; error.mutationPossible = phase !== "validation";
    if (receipt) error.receipt = receipt;
    throw error;
  } finally {
    // Leave the writer last so its normal close can checkpoint after the reader releases.
    let closeFailure;
    try { metadata?.close(); } catch (error) { closeFailure = error; }
    try { cron?.close(); } catch (error) { closeFailure ??= error; }
    if (closeFailure) {
      const error = new Error("canonical maintenance close failed", { cause: closeFailure });
      error.phase = phase; error.mutationPossible = phase !== "validation";
      if (receipt) error.receipt = receipt;
      throw error;
    }
  }
}
