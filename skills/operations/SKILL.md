---
name: operations
description: Inspect bounded harness health, capacity, usage, diagnostics, and retained-session metadata without expanding family authority. operations.events() returns at most 500 newest lifecycle events.
---

# Harness Operations

Use `operations.status()` for a bounded supervisor summary: protocol/schema versions, canonical artifact locations, child capacity `{resident, starting, queued, maxResident, maxConcurrentStarts}`, aggregate queue/lifecycle counts, model-reported usage, diagnostics, and sanitized session metadata. The host handler forwards those five capacity fields from supervisor `get_status` rather than dropping them.

Use `operations.diagnose()` for deterministic read-only invariant checks. It reports diagnosed inconsistencies but performs no generic repair.

Use `operations.usage(window_minutes=60)` for sanitized model-reported usage recorded in a recent inclusive time window. The window is fixed to 1 through 10,080 minutes (seven days). Results contain only window boundaries, aggregate and per-model entry/session counts, token categories, and model-estimated cost; per-model output is capped at 64 models and reports truncation. Numeric totals are finite and saturate at `9,007,199,254,740,991`; every aggregate/model row reports the fixed safe maximum and per-field saturation booleans under `precision`. Unsaturated count/token totals are exact, while estimated cost retains SQLite REAL arithmetic. This is a direct windowed aggregate, unlike the lifetime-only usage in `status()`.

Use `operations.events(limit=100)` for the newest bounded structured lifecycle events. `limit` is an integer from 1 through 500 (default 100); the result is truncated when the log is larger than that bound. Events carry correlation IDs and states, never prompts, message bodies, credentials, ownership tokens, or process environments. The daemon owns one size-rotated JSONL log plus its single previous segment.

This skill does not expose credentials, prompts, message bodies, ownership tokens, process environment, unrestricted SQL, or a new messaging route. Lifecycle mutations remain explicit `rlm.stop_subagent()`, `rlm.revive_subagent()`, and `rlm.delete_subagent()` operations on direct children.
