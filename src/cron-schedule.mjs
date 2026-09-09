import { Cron } from "croner";

export const DEFAULT_CRON_TIMEZONE = "Europe/Berlin";
export const MIN_CRON_INTERVAL_SECONDS = 5 * 60;
export const MAX_CRON_INTERVAL_SECONDS = 366 * 24 * 60 * 60;

function object(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${context} must be an object`);
  return value;
}

export function validateCronTimezone(value = DEFAULT_CRON_TIMEZONE) {
  if (typeof value !== "string" || !value || value.length > 128) throw new TypeError("timezone must be a non-empty IANA timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0)); }
  catch { throw new TypeError(`invalid IANA timezone: ${value}`); }
  return value;
}

function cronDate(pattern, timezone, after, allowPastAt = false) {
  let evaluator;
  try {
    evaluator = new Cron(pattern, { timezone, paused: true });
    const value = allowPastAt ? evaluator.getOnce() : evaluator.nextRun(new Date(after));
    return value ? value.getTime() : null;
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : String(error));
  } finally { evaluator?.stop(); }
}

function isoAt(value, timezone, now, allowPastAt) {
  if (typeof value !== "string" || value.length > 128
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    throw new TypeError("at schedule must be an ISO date-time, with an optional UTC offset");
  }
  const explicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const timestamp = explicitOffset ? Date.parse(value) : cronDate(value, timezone, now - 1, allowPastAt);
  if (!Number.isFinite(timestamp)) throw new TypeError("at schedule is not a valid date-time");
  if (!allowPastAt && timestamp <= now) throw new TypeError("at schedule must be in the future");
  return timestamp;
}

export function normalizeCronSchedule(input, { now = Date.now(), defaultTimezone = DEFAULT_CRON_TIMEZONE, allowPastAt = false } = {}) {
  if (typeof allowPastAt !== "boolean") throw new TypeError("allowPastAt must be a boolean");
  const value = object(input, "schedule");
  const kind = value.kind;
  const timezone = validateCronTimezone(value.timezone ?? defaultTimezone);
  if (kind === "at") {
    const at = isoAt(value.at, timezone, now, allowPastAt);
    return { schedule: { kind, at: new Date(at).toISOString(), timezone }, display: `${new Date(at).toISOString()} (${timezone})`, nextRunAt: at, recurring: false };
  }
  if (kind === "every") {
    const intervalSeconds = value.intervalSeconds;
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < MIN_CRON_INTERVAL_SECONDS || intervalSeconds > MAX_CRON_INTERVAL_SECONDS) {
      throw new TypeError(`intervalSeconds must be an integer from ${MIN_CRON_INTERVAL_SECONDS} through ${MAX_CRON_INTERVAL_SECONDS}`);
    }
    return { schedule: { kind, intervalSeconds, timezone }, display: `every ${intervalSeconds} seconds`,
      nextRunAt: now + intervalSeconds * 1000, recurring: true };
  }
  if (kind === "cron") {
    if (typeof value.expression !== "string" || value.expression.length > 256
      || value.expression.trim().split(/\s+/).length !== 5) {
      throw new TypeError("cron expression must contain exactly five fields");
    }
    const expression = value.expression.trim();
    const nextRunAt = cronDate(expression, timezone, now);
    if (nextRunAt === null) throw new TypeError("cron expression has no future occurrence");
    return { schedule: { kind, expression, timezone }, display: `${expression} (${timezone})`, nextRunAt, recurring: true };
  }
  throw new TypeError("schedule.kind must be at, every, or cron");
}

export function nextCronRunAfter(scheduleInput, scheduledAt, now = Date.now()) {
  const schedule = object(scheduleInput, "schedule");
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(now)) throw new TypeError("scheduled timestamps must be finite");
  if (schedule.kind === "at") return null;
  if (schedule.kind === "every") {
    const intervalMs = schedule.intervalSeconds * 1000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError("stored interval schedule is invalid");
    const elapsed = Math.max(0, now - scheduledAt);
    return scheduledAt + (Math.floor(elapsed / intervalMs) + 1) * intervalMs;
  }
  if (schedule.kind === "cron") {
    return cronDate(schedule.expression, validateCronTimezone(schedule.timezone), Math.max(scheduledAt, now));
  }
  throw new TypeError("stored schedule kind is invalid");
}
