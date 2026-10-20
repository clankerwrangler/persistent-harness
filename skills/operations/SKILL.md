---
name: operations
description: Inspect bounded local Linux memory, harness health, capacity, usage, diagnostics, and retained-session metadata without expanding family authority. operations.events() returns at most 500 newest lifecycle events.
---

# Harness Operations

Use `operations.status()` for a bounded supervisor summary: protocol/schema versions, canonical artifact locations, child capacity `{resident, starting, queued, maxResident, maxConcurrentStarts}`, aggregate queue/lifecycle counts, model-reported usage, diagnostics, and sanitized session metadata. The host handler forwards those five capacity fields from supervisor `get_status` rather than dropping them.

Use `operations.memory()` for an on-demand, read-only local Linux/cgroup v2 memory sample. It uses Python's standard library, reads no process arguments or environments, and makes no supervisor request. It accepts no arguments and returns a `SkillResult` with these fixed fields:

- `host`: `/proc/meminfo` total, `available_bytes` (`MemAvailable`), swap total/free, and host memory PSI.
- `cgroup`: the current cgroup's raw `anon_bytes`, `file_bytes`, `inactive_file_bytes`, `kernel_bytes`, `shmem_bytes`, `file_dirty_bytes`, `file_writeback_bytes`, swap charge/limit, and `clean_inactive_file_estimate_bytes`. Anonymous memory is the aggregate cgroup charge, not a sum of process RSS.
- `hierarchy`: current cgroup first, then each visible ancestor. Each row has `current_bytes`, `max_bytes`, `high_bytes`, corresponding `*_unlimited` flags, signed `raw_max_headroom_bytes` and `raw_high_headroom_bytes`, memory PSI, and cumulative `memory.events` counters (`low`, `high`, `max`, `oom`, `oom_kill`, `oom_group_kill`). PSI has `some`/`full` rows with `avg10`, `avg60`, `avg300` percentages and `total_us`.
- `estimated_available_bytes`: estimated RAM headroom, bounded by host `MemAvailable` and every visible `memory.max` ceiling after cache credit.
- `estimated_before_high_bytes`: the same estimate additionally bounded by visible `memory.high` thresholds. High is a reclaim/throttling threshold, not a hard RAM ceiling.
- `schema_version`, `sampled_unix_ns`, `duration_ns`, `scope`, and `hierarchy_complete` describe the sample.

`memory.max - memory.current` is raw headroom, not available RAM. The clean inactive-file estimate is `max(0, min(file, inactive_file) - shmem - file_dirty - file_writeback)`. Subtracting all three contaminants can undercount clean cache because they can overlap. It excludes active file cache, anonymous memory, swap, and reusable application heap pools. Only the current cgroup's cache receives credit; sibling cache does not.

For each finite ancestor ceiling, estimated headroom is `max(0, ceiling - current + min(clean_estimate, current))`. The result is the minimum of these quantities and host `MemAvailable`. Over-limit debt is subtracted before cache credit. Reclaim is an estimate, not a promise of immediately allocatable RAM; retain existing caller reserves and pressure checks. Swap is reported separately and never added to free RAM.

Numeric fields are `None` when missing, malformed, unreadable, or outside the collector's bounds. A literal `max` limit has a `None` byte value and `*_unlimited=True`; an unknown limit has both fields `None`. Required unknown host/cache/ceiling inputs make the corresponding estimate `None`. Missing PSI or event counters remain `None`, not zero, even if arithmetic headroom can be estimated.

The collector resolves `/proc/self/cgroup` against cgroup v2 mounts in `/proc/self/mountinfo` and walks at most 32 visible levels. `scope` is `visible_cgroup_v2_hierarchy`; cgroup namespaces and mounted subtrees can hide outer limits. `hierarchy_complete=True` means that the visible mount root was reached and placement metadata stayed unchanged, not that outer limits are known. Truncated, unresolved, or changed placement makes both estimates unavailable. Reads are bounded to 512 KiB total, with per-file limits of 128 KiB for mount metadata, 16 KiB for memory stats/meminfo, 4 KiB for membership/PSI/events, and 128 bytes for scalar files. Samples are sequential observations, not atomic reservations.

Use `operations.diagnose()` for deterministic read-only invariant checks. It reports diagnosed inconsistencies but performs no generic repair.

Use `operations.usage(window_minutes=60)` for sanitized model-reported usage recorded in a recent inclusive time window. The window is fixed to 1 through 10,080 minutes (seven days). Results contain only window boundaries, aggregate and per-model entry/session counts, token categories, and model-estimated cost; per-model output is capped at 64 models and reports truncation. Numeric totals are finite and saturate at `9,007,199,254,740,991`; every aggregate/model row reports the fixed safe maximum and per-field saturation booleans under `precision`. Unsaturated count/token totals are exact, while estimated cost retains SQLite REAL arithmetic. This is a direct windowed aggregate, unlike the lifetime-only usage in `status()`.

Use `operations.events(limit=100)` for the newest bounded structured lifecycle events. `limit` is an integer from 1 through 500 (default 100); the result is truncated when the log is larger than that bound. Events carry correlation IDs and states, never prompts, message bodies, credentials, ownership tokens, or process environments. The daemon owns one size-rotated JSONL log plus its single previous segment.

This skill does not expose credentials, prompts, message bodies, ownership tokens, process environment, unrestricted SQL, or a new messaging route. Lifecycle mutations remain explicit `rlm.stop_subagent()`, `rlm.revive_subagent()`, and `rlm.delete_subagent()` operations on direct children.
