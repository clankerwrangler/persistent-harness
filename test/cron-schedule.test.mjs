import assert from "node:assert/strict";
import test from "node:test";
import { MIN_CRON_INTERVAL_SECONDS, nextCronRunAfter, normalizeCronSchedule } from "../src/cron-schedule.mjs";

test("unspecified schedules use UTC while deployment defaults remain configurable", () => {
  const schedule = { kind: "at", at: "2026-03-29T09:00:00" };
  const now = Date.parse("2026-03-28T10:00:00Z");
  const generic = normalizeCronSchedule(schedule, { now });
  assert.equal(generic.schedule.timezone, "UTC");
  assert.equal(generic.schedule.at, "2026-03-29T09:00:00.000Z");
  const configured = normalizeCronSchedule(schedule, { now, defaultTimezone: "Europe/Paris" });
  assert.equal(configured.schedule.at, "2026-03-29T07:00:00.000Z");
});

test("cron schedules preserve Europe/Paris wall time across daylight-saving changes", () => {
  const beforeDst = Date.parse("2026-03-28T10:00:00Z");
  const normalized = normalizeCronSchedule({ kind: "cron", expression: "0 9 * * *", timezone: "Europe/Paris" }, { now: beforeDst });
  assert.equal(new Date(normalized.nextRunAt).toISOString(), "2026-03-29T07:00:00.000Z");
  const following = nextCronRunAfter(normalized.schedule, normalized.nextRunAt, normalized.nextRunAt);
  assert.equal(new Date(following).toISOString(), "2026-03-30T07:00:00.000Z");
});

test("naive one-shot timestamps use the selected timezone while offset timestamps remain absolute", () => {
  const now = Date.parse("2026-03-28T10:00:00Z");
  const local = normalizeCronSchedule({ kind: "at", at: "2026-03-29T09:00:00", timezone: "Europe/Paris" }, { now });
  assert.equal(new Date(local.nextRunAt).toISOString(), "2026-03-29T07:00:00.000Z");
  const absolute = normalizeCronSchedule({ kind: "at", at: "2026-03-29T09:00:00+02:00", timezone: "UTC" }, { now });
  assert.equal(absolute.nextRunAt, local.nextRunAt);
});

test("interval advancement collapses overdue occurrences into one future fire", () => {
  const schedule = { kind: "every", intervalSeconds: 300, timezone: "Europe/Paris" };
  assert.equal(nextCronRunAfter(schedule, 1_000, 901_000), 1_201_000);
});

test("schedule validation rejects sub-five-minute intervals and nonstandard cron field counts", () => {
  assert.throws(() => normalizeCronSchedule({ kind: "every", intervalSeconds: MIN_CRON_INTERVAL_SECONDS - 1 }), /intervalSeconds/);
  assert.throws(() => normalizeCronSchedule({ kind: "cron", expression: "0 0 9 * * *" }), /exactly five/);
  assert.throws(() => normalizeCronSchedule({ kind: "at", at: "2020-01-01T00:00:00Z" }, { now: Date.now() }), /future/);
});


test("explicit paused admission can normalize due at-times without changing ordinary future validation", () => {
  const now = Date.parse("2026-03-30T10:00:00Z");
  for (const [at, expected] of [
    ["2026-03-29T09:00:00", "2026-03-29T07:00:00.000Z"],
    ["2026-03-29T09:00:00+02:00", "2026-03-29T07:00:00.000Z"],
    ["2026-03-30T10:00:00Z", "2026-03-30T10:00:00.000Z"],
  ]) {
    const schedule = { kind: "at", at, timezone: "Europe/Paris" };
    assert.throws(() => normalizeCronSchedule(schedule, { now }), /future|valid date-time/);
    const staged = normalizeCronSchedule(schedule, { now, allowPastAt: true });
    assert.equal(staged.schedule.at, expected); assert.equal(staged.nextRunAt, Date.parse(expected));
    assert.equal(staged.recurring, false);
  }
  const future = { kind: "at", at: "2026-04-01T09:00:00.123", timezone: "Europe/Paris" };
  assert.deepEqual(normalizeCronSchedule(future, { now, allowPastAt: true }), normalizeCronSchedule(future, { now }));
  for (const allowPastAt of [null, 1, "true"]) assert.throws(() => normalizeCronSchedule(future, { now, allowPastAt }), /allowPastAt/);
  assert.throws(() => normalizeCronSchedule({ kind: "at", at: "not-an-at-time" }, { now, allowPastAt: true }), /ISO/);
});
