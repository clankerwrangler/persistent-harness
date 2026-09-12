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

## Delete a session tree

Client `delete_session` and retained-child `delete_child` stop and tombstone the selected session and all descendants, including descendants beneath an older tombstone. Child callers can select only their direct children. Deletion fences new admission, input delivery, revival, and family routing while outstanding starts and mutations drain. A failed actor stop prevents the tombstone transaction; retry after resolving the stop failure.

Deletion retains canonical transcripts, kernel state, and artifacts. Successful responses include `deletedSessionIds`; clients also receive `sessions_deleted` with `sessionIds`. Remove every listed session from subscriptions and cached navigation, not just the selected row. Repeating client deletion is idempotent.

## Recovery boundaries

Input acceptance is durable admission, not proof that inference consumed it. An original tool result and its namespace save are also separate. On kernel loss or snapshot mismatch, inspect the explicit diagnostics before making assumptions about Python variables. Uncertain effects are not replayed automatically.

Upgrade and rollback require a compatible reader for canonical assistant metadata, input receipts, and compaction details. Old implementations that do not understand the harness's versioned signature or projection metadata are not an automatically safe rollback after new histories have been written. Keep the tested source, dependency pins, and recovery-compatible state together.

## Configuration notes

The default cron timezone remains `Europe/Berlin` for compatibility. Set `PI_HARNESS_CRON_TIMEZONE` explicitly for another intended timezone. Model and provider selection remain Pi configuration; credentials are not stored in this checkout.

`PI_HARNESS_SKILLS_PATH` changes the complete catalog, not merely one prompt. Provision and validate its dependencies before starting workers. An explicit `PI_HARNESS_PYTHON` bypasses managed provisioning and must already contain compatible IPython, dill, and skill dependencies.

## Develop and promote one source revision

Keep development and production as separate checkouts of the same repository. Put production configuration, external extensions and clients, credentials, and durable state outside the tracked source. Do not maintain production-only harness edits.

1. Develop the change in the development checkout. Update and check the relevant models before implementation, then run the required tests with isolated state and the pinned dependencies. Include configured external integrations in acceptance.
2. Review the exact outgoing files, commit, and push the tested revision to the release branch. Record its commit ID and dependency pins.
3. Fetch the published release into a separate candidate checkout. This can happen while production runs. Require the fetched branch tip to equal the reviewed commit ID; stop for review if the branch advanced unexpectedly. Test and prepare that exact remote-fetched candidate, not a private development copy.
4. Stop production writers before changing any source files they use; lazy imports can otherwise mix revisions. Create a consistent state checkpoint and test the successor reader on a separate copy. Verify the production checkout is clean and its remote is the intended repository, then fast-forward to the exact fetched commit, for example with `git merge --ff-only "$REVIEWED_COMMIT"`, or install the prepared clean checkout. Do not reset over unexplained local changes or run an unpinned pull that can fetch a newer revision. Verify `git rev-parse HEAD` equals the reviewed commit and that the tracked worktree remains clean.
5. Activate separately with the recorded external configuration and dependencies. Verify supervisor and client readiness, session recovery, required integrations, and the loaded revision. Updating checkout files alone does not replace already-running code.

Record a durable boundary before attempting successor startup. Before that boundary, a stopped deployment can restore the exact previous source, configuration, and dependencies. After the successor might have written state, recovery must preserve current canonical state and a reader compatible with those writes. Do not downgrade to an older reader merely because its process used to start. A checkpoint is not permission to rewind completed effects or replay uncertain calls. Keep deployment outcomes and a host-access recovery path outside the processes being replaced.

## Uninstall

`node bin/install.mjs uninstall` removes repository-owned thin wrappers, not durable state or external dependencies. It leaves independently installed extensions unchanged. Stop the selected supervisor before deleting or relocating its source. Review and back up state separately rather than deleting it as part of code uninstall.
