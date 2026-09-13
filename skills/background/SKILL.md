---
name: background
description: Launch and track detached OS processes that outlive the current turn, notifying the owning agent when they finish. Use launch or adopt (local PID only), then poll status/logs/wait/stop/list/remove. Survives the caller; shell.run cannot detach because it waits and reaps descendants. Do not spawn a watcher agent to babysit a PID. Remote work must stay in an SSH foreground so the tracked PID is the local session.
compatibility: Python 3.11 or newer; Linux /proc; standard library only.
---

# Background processes

This skill tracks **OS processes**, not `rlm` children and not `cron` jobs. Use it when work must outlive `shell.run` (max 600s, Perl subreaper kills descendants including `setsid` when the call ends). You cannot nohup through `shell`. Poll with `status`/`logs`; do not spawn a watcher agent just to babysit a PID.

Never put secrets in `command` (it is stored and returned).

## Operations

```python
await background(operation="launch", command="...", name="long-task", cwd=None)
await background(operation="adopt", pid=9268, name="long-task", log_path="/tmp/long-task.log")
await background(operation="status", selector="long-task")
await background(operation="logs", selector="long-task", tail_bytes=8192)
await background(operation="wait", selector="long-task", timeout=5)
await background(operation="stop", selector="long-task")
await background(operation="list", include_exited=False)
await background(operation="remove", selector="long-task", force=False)
```

Selector is exact job id (`bg-` plus 12 hex) or case-insensitive live name.

- `launch`: `/bin/bash -lc` under a durable supervisor. Returns immediately (`state="running"`).
- `adopt`: register an already-running **local** pid plus optional log file. PID reuse is detected via `/proc` starttime.
- `status`: `running` / `exited` / `vanished` (optional `stopping`). Includes pid, elapsed, `exit_code` when known, `log_bytes`.
- `logs`: bounded tail (default 8192 bytes, max 65536). Never slurps a huge file.
- `wait`: poll until not running or `timeout` in `(0, 30]` seconds (default 5). Do not block for minutes.
- `stop`: SIGTERM the owned process group, then SIGKILL after a short grace. Adopted non-leaders: kill that pid only. Never kill a mismatched/reused pid. A successful stop records a terminal outcome for the owner notification path.
- `list`: running jobs; `include_exited=True` adds finished ones.
- `remove`: drop tracking. Refuses if still running unless `force=True` (stop then remove).

## Completion notification

When the skill is called by a Persistent Harness actor, each launched or adopted job records that actor's session identity. The long-lived harness supervisor watches the durable `exit.json` marker and submits one durable `follow_up` input to that session, including the job name, outcome, and idempotent job identifier. The actor can resume after a long command, a passivation, or a temporary disconnect; the completion outbox is retried on supervisor restart and the store receipt prevents duplicate inputs. If the skill is used outside an actor, tracking still works but no agent notification is possible.

## Remote work

Keep a remote command in the SSH foreground so the tracked local PID remains that session. Adoption accepts local PIDs only. `wait` is a short poll; at most 32 live jobs are retained.
