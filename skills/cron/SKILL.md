---
name: cron
description: Create and manage durable scheduled agent jobs through the persistent harness.
---

# Scheduled jobs

Use `await cron(...)` to manage durable jobs owned by the harness supervisor. The scheduler continues independently of the current Pi actor and records every claimed occurrence in durable history.

Only a depth-zero root session may manage jobs. Isolated fresh scheduled sessions cannot manage the scheduler recursively. Origin-mode delivery into a live root does not turn that root into a scheduled session: it remains a Commander conversation, may manage jobs, and may spawn children.

## Actions

The `action` argument accepts `create`, `list`, `update`, `pause`, `resume`, `run`, `remove`, and `history`.

Create a recurring origin-session job:

```python
await cron(
    action="create",
    name="Morning review",
    prompt="Review the workspace status and report concrete blockers.",
    schedule={"kind": "cron", "expression": "0 9 * * *"},
    execution_mode="origin",
)
```

Create an isolated interval job:

```python
await cron(
    action="create",
    name="Periodic audit",
    prompt="Run the bounded audit and summarize the result.",
    schedule={"kind": "every", "intervalSeconds": 7200},
    execution_mode="fresh",
    repeat=6,
)
```

Create a one-shot job:

```python
await cron(
    action="create",
    name="Reminder",
    prompt="Remind the Commander to review the release.",
    schedule={"kind": "at", "at": "2026-09-01T14:00:00"},
)
```

Pin a model for every fire. Omit `provider` and `model` to use the global default at fire time:

```python
await cron(
    action="create",
    name="Pinned audit",
    prompt="Run the bounded audit and summarize the result.",
    schedule={"kind": "every", "intervalSeconds": 7200},
    provider="grok-cli",
    model="grok-4.6",
)
```

Clear a pin with `provider=None, model=None` on `update`. `thinking_level` pins or clears the same way.

Naive ISO timestamps and cron expressions use `Europe/Berlin` unless `timezone` is supplied in the schedule. Explicit ISO offsets remain absolute. Cron expressions must contain exactly five fields. Recurring intervals must be at least 300 seconds.

Unpinned jobs use the global default model at the moment they fire, not the model that was current when the job was created. An explicit `provider` and `model` pin that model for later fires. `provider` and `model` must be supplied together.

`execution_mode="fresh"` creates an isolated root session for every fire. `execution_mode="origin"` sends the job to the root session that created it, using automatic input behavior: it steers active work and starts a normal turn when idle. If that origin has been deleted, execution falls back to a fresh root and the run records the reason.

Recurring jobs run forever when `repeat` is omitted or `None`; finite positive repeats are supported. One-shot jobs require exactly one run. A manual `run` does not consume the scheduled repeat count.

Mutating actions identify a job by exact ID or case-insensitive live name. Use `selector` for `update`, `pause`, `resume`, `run`, `remove`, and `history`. `history` returns bounded run records and visible output. `list` excludes removed jobs unless `include_removed=True`.

Missed recurring occurrences collapse into one catch-up attempt. The same job never overlaps; an occurrence encountered while its prior run remains active is recorded as skipped. The default global limit is two concurrent runs. If the supervisor restarts during a run, that attempt becomes `unknown` and is never automatically replayed.

Prompts must be self-contained and safe for unattended execution. Do not schedule credential disclosure, unbounded side effects, or ambiguous destructive work.
