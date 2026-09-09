# Operations and recovery

## Start, inspect, and stop

Use the dependency environment from [Installation](DEPENDENCIES.md). These commands address only the selected local supervisor:

```sh
node bin/harness-supervisor.mjs ensure
node bin/harness-supervisor.mjs status
node bin/persistent-pi.mjs --list
node bin/harness-supervisor.mjs shutdown
```

`start` runs in the foreground; `ensure` starts a detached supervisor if needed. `:quit` detaches a terminal. Stopping a session or shutting down the supervisor is separate from detaching, and graceful shutdown drains pending kernel work/save ownership.

The wrappers installed under the agent's `bin/` directory load its optional `harness/launch-env.sh`. A service must receive the same Pi, Python, and catalog paths. Do not rely on a previous interactive shell's environment.

## State locations

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`. The normal supervisor paths beneath it are:

- `harness/supervisor.sock`: local control socket.
- `harness/harness.sqlite`: durable supervision, inputs, schedules, and telemetry.
- `harness/supervisor.pid`: supervised process ownership metadata.
- `harness/kernel-runtime/`: managed interpreter and dependency environments.
- Pi's cwd-scoped `sessions/` tree: canonical JSONL transcripts.

Session sidecars derive from the exact canonical filename: `.skill-manifest.json`, `.skill-grant.json`, `.capabilities.json`, and `.kernel-state/`. Do not move a transcript independently of its associated state. Derived indexes do not replace the canonical transcript.

The supervisor CLI accepts explicit `--socket`, `--db`, and `--pid` paths for isolated instances. Back up the complete selected agent state under a controlled stop, including database sidecars and transcript/kernel files. Do not treat a partial copy of active files as a consistent recovery point.

## Recovery boundaries

Input acceptance is durable admission, not proof that inference consumed it. An original tool result and its namespace save are also separate. On kernel loss or snapshot mismatch, inspect the explicit diagnostics before making assumptions about Python variables. Uncertain effects are not replayed automatically.

Upgrade and rollback require a compatible reader for canonical assistant metadata, input receipts, and compaction details. Old implementations that do not understand the harness's versioned signature or projection metadata are not an automatically safe rollback after new histories have been written. Keep the tested source, dependency pins, and recovery-compatible state together.

## Configuration notes

The default cron timezone remains `Europe/Berlin` for compatibility. Set `PI_HARNESS_CRON_TIMEZONE` explicitly for another intended timezone. Model and provider selection remain Pi configuration; credentials are not stored in this checkout.

`PI_HARNESS_SKILLS_PATH` changes the complete catalog, not merely one prompt. Provision and validate its dependencies before starting workers. An explicit `PI_HARNESS_PYTHON` bypasses managed provisioning and must already contain compatible IPython, dill, and skill dependencies.

## Uninstall

`node bin/install.mjs uninstall` removes repository-owned thin wrappers, not durable state or external dependencies. It leaves independently installed extensions unchanged. Stop the selected supervisor before deleting or relocating its source. Review and back up state separately rather than deleting it as part of code uninstall.
