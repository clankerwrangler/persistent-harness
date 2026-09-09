---
name: shell
description: Execute bounded shell commands with cwd, timeout at most 600s, cancellation, streamed output, and a dict-like SkillResult (result["stdout"]/result["exitCode"]).
---

# Shell

Import with `import harness_shell as shell` (the kernel also preloads `shell`).

Call `shell.run(command, cwd=None, timeout=120)` to execute through `/bin/bash -lc` inside a Linux Perl subreaper boundary. The call returns a dict-like `SkillResult`; use `result["stdout"]` and `result["exitCode"]` rather than attribute access. It completes before returning, so the result cannot be passed to `asyncio.create_task` — use a supported parallel tool for concurrency. `timeout` must be greater than 0 and at most 600 seconds. Captured output is streamed as progress and also returned in the result; reprinting `stdout` duplicates what was already shown.

On completion, timeout, cancellation, or progress failure, the boundary terminates and reaps all descendants, including processes that call `setsid`; a `/proc` process-tree kill is the bounded last resort. The host requires Linux procfs and `/usr/bin/perl`, and fails rather than silently weakening containment if setup is unavailable.

Progress and final stdout/stderr mirror the same capture, bounded to 64 KiB across both streams; output text is therefore bounded to 64 KiB per channel and 128 KiB across progress plus the final result. Each pipe has an incremental UTF-8 decoder, so valid code points split across chunks survive. Invalid byte sequences are deterministically represented with U+FFFD; `totalBytes` counts raw pipe bytes while captured/progress counters count returned UTF-8 bytes. On overflow, one truncation marker is streamed and captured, further output is drained but not forwarded, and `truncated=True`; `totalBytes`, `progressBytes`, and `capturedBytes` expose accounting. The result also includes exit code, cancellation, timeout, and duration metadata. Shell execution is not sandboxed beyond the kernel process's OS permissions. The command string is returned in the result, so never put secrets directly in it.
