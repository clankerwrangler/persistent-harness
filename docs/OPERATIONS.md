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

`ensure` checks protocol responsiveness with the read-only `get_liveness` request, not a database audit. An older daemon's exact same-version `unknown_request` rejection for that request also proves responsiveness; no full-status fallback runs. Only a missing or refused socket permits startup. A timeout, incompatible protocol, or invalid response fails the command rather than starting another daemon. Use `status` for full retained-state diagnostics.

The CLI loads the supervisor implementation only for `start`, and the registering
client only for `memory`. Control helpers keep their single-request path. If
`ensure` needs a new daemon, its separate `start` process still loads the normal
supervisor. Importing the CLI's lock helper or rejecting invalid arguments does
not evaluate those unused graphs.

The wrappers installed under the agent's `bin/` directory load its optional `harness/launch-env.sh`. A service must receive the same Pi, Python, and catalog paths. Do not rely on a previous interactive shell's environment.

Before restarting, identify what owns the supervisor lifetime. `harness-restart` and a detached local observer can survive a standalone supervisor exit, but not termination of their container. If `harness-supervisor start` is the container's main workload, use the host-owned service/container lifecycle and a continuation observer outside that container. A background job inside the container is not an independent recovery path.

Bind recovery to the service/container generation as well as PID and process start time; replacement containers can reuse the same numeric PID. Record the target session and idempotent continuation receipt before interruption, then verify both service readiness and actual session return. A healthy replacement alone does not prove continuation. Preserve interrupted restart-job evidence rather than replaying shutdown or fabricating a completed receipt.

## Explicit numeric memory observation

```sh
node bin/harness-supervisor.mjs memory --session FULL_SESSION_ID
```

This connect-only operator command uses registered-client `get_memory_diagnostics`
with exactly `{sessionId}`. It does not ensure a daemon, subscribe, start or revive
an actor/kernel, or change conversation/checkpoint state. Actor connections cannot
use it. Normal `status` and liveness polling do not collect these counters.

The v1 result contains supervisor and, when resident, worker numeric
`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`, `v8HeapTotal` and
`v8HeapUsed` bytes. It requests no GC or heap snapshot. Worker transport has a
one-second deadline; failures return a fixed unavailable state, not raw errors.

Python observes only Out, text-repr history and MIME-output history. Its result
contains root entry counts and combined deduplicated counts/shallow byte sizes
for exact `str`, `bytes` and builtin containers (`stringBytes`, `bytesBytes`,
`containerBytes`). Dictionary keys, MIME names and payload text are not returned.
The walk stops after 10,000 visited references or 25 ms; `state` is `complete`,
`truncated` or `unknown` (unsupported values/owners). `unknown` also counts
unmeasured objects. Root counts are null when their owner type is unknown.
These are partial ownership estimates, not a full Python heap census, retained
size, allocator overhead, RSS attribution or a regression baseline.

A queued/active Python tool, host callback, snapshot, startup or close returns
`unavailable-busy` without joining its queue or writing into its response pipe.
An absent process returns `unavailable-not-running`. An admitted idle observation
briefly reserves the existing FIFO; later tools and shutdown drain that read.
No namespace enumeration, arbitrary evaluation, user sizing/iteration hooks,
file access or runtime imports occur in the collector. Observations are best
effort; other Python threads can mutate history independently.

## State locations

`PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`. The normal supervisor paths beneath it are:

- `harness/supervisor.sock`: local control socket.
- `harness/harness.sqlite`: durable supervision, inputs, schedules, and telemetry.
- `harness/supervisor.pid`: supervised process ownership metadata.
- `harness/kernel-runtime/`: managed interpreter and dependency environments.
- `harness/entry-index-cache/`: optional private derived entry indexes for supported SDKs and explicit sessions; canonical transcripts remain authoritative.
- Pi's cwd-scoped `sessions/` tree: canonical JSONL transcripts.

Session sidecars derive from the exact canonical filename: `.skill-manifest.json`, `.skill-grant.json`, `.capabilities.json`, and `.kernel-state/`. Do not move a transcript independently of its associated state. Derived indexes do not replace the canonical transcript.

The supervisor CLI accepts explicit `--socket`, `--db`, and `--pid` paths for isolated instances. Back up the complete selected agent state under a controlled stop, including database sidecars and transcript/kernel files. Do not treat a partial copy of active files as a consistent recovery point.

## Delete a session tree

Client `delete_session` and retained-child `delete_child` stop and tombstone the selected session and all descendants, including descendants beneath an older tombstone. Child callers can select only their direct children. Deletion fences new admission, input delivery, revival, and family routing while outstanding starts and mutations drain. A failed actor stop prevents the tombstone transaction; retry after resolving the stop failure.

Deletion retains canonical transcripts, kernel state, and artifacts. Successful responses include `deletedSessionIds`; clients also receive `sessions_deleted` with `sessionIds`. Remove every listed session from subscriptions and cached navigation, not just the selected row. Repeating client deletion is idempotent.

## Recovery boundaries

Input acceptance is durable admission, not proof that inference consumed it. An original tool result and its namespace save are also separate. On kernel loss or snapshot mismatch, inspect the explicit diagnostics before making assumptions about Python variables. Uncertain effects are not replayed automatically.

An unexpected child actor exit atomically records its lifecycle error and queues one supervisor-generated message for its direct parent per actor generation. The message contains a bounded child ID, generation, fixed failure class (`heap_exhausted` or `actor_exit`), and an unknown-completion outcome. It contains no display names, raw stderr, prompt, or transcript content. This is a lifecycle report, not a message authored by the failed child.

The existing durable family-message path wakes a passivated parent and retries the same message ID after a disconnect or supervisor restart. Recipient history deduplicates logical incorporation; acknowledgement is not proof that inference completed recovery. Stopped or errored parents retain pending messages until explicitly recovered. Parent deletion rejects pending delivery. Intentional stop, delete, passivation, and supervisor shutdown do not generate failure reports. The failed child is not restarted and work is not replayed. No historical error backfill, busy-work timeout, or new human-notification source is added. Inspect the retained child state and verified saved artifacts before deciding how to continue.

Upgrade and rollback require a compatible reader for canonical assistant metadata, input receipts, and compaction details. Old implementations that do not understand the harness's versioned signature or projection metadata are not an automatically safe rollback after new histories have been written. Keep the tested source, dependency pins, and recovery-compatible state together.

Pi 0.99.1 reads and continues retained 0.85.1 sessions without rewriting their prior entries. The reverse is not generally safe: 0.85.1 ignores new `context_edit` entries and does not reconstruct 0.99.1 compaction system checkpoints. Before the successor writes these forms, source/runtime rollback can retain the unchanged state. After those writes, preserve current state and use the accepted 0.99.1 reader or a forward repair; do not downgrade or rewind transcripts.

## Model catalog freshness

Actor startup loads Pi's cached catalog without network access. Opening the model picker or calling `rlm.find_models` calls the public Pi catalog refresh before returning the list. Pi owns configured-provider scope, cache persistence, refresh intervals, offline policy, and concurrent-refresh supersession. These operations do not change the selected model or provider.

The one-shot catalog request waits for refresh with a 15-second abort deadline. Unlike Pi's interactive cached-first picker, this API returns one list after refresh. On failure, the existing snapshot remains available with a warning. Child model admission reloads the local catalog without network access so exact pins can use metadata refreshed by another actor.

## Configuration notes

`PI_HARNESS_ACTOR_STARTUP_TIMEOUT_MS` defaults to `120000` (accepted range
`100`–`300000`). Each spawned worker has one finite startup deadline shared by
initial `get_state` (including SDK open and extension startup) and the
`set_steering_mode` acknowledgement. It is not renewed between those requests.
Ordinary actor RPCs retain their `30000` ms deadline; prompt preflight retains
`330000` ms, and ordinary `HarnessClient` requests retain `3000` ms.

The supervisor's existing readiness observer uses the same configured duration
starting when it requests a queued start, so its wait includes start-capacity
queueing. That observer clock is separate from the worker's post-spawn handshake
clock; expiration does not cancel a durably accepted input or reset either clock.
A failed handshake still closes/drains its owned worker before releasing the
start slot. Readiness does not certify input consumption or recovery completion.
Direct `PiSessionActor` callers that omit `startupTimeoutMs` inherit their
`requestTimeoutMs` as the **total handshake budget**, not a fresh budget per step.

Prompts use the generic roles `user` and `assistant`. Keep deployment identities and personal instructions in external Pi configuration.

Presentation directives default to `harness.presentation.v1`. `PI_HARNESS_PRESENTATION_NAMESPACE` selects a deployment-specific namespace (lowercase letter followed by up to 31 lowercase letters, digits, or hyphens). Set it to the existing marker's prefix before upgrading an installation with a different marker. Use the same value in the supervisor and any client importing its presentation helpers, and keep the model's directive instructions consistent. This preserves existing transcript markers and client schemas without embedding an identity in the repository.

The default cron timezone is `UTC`. Set `PI_HARNESS_CRON_TIMEZONE` to the deployment's intended timezone before upgrading if it previously relied on a local default. Existing jobs keep their stored timezone. Model and provider selection remain Pi configuration; credentials are not stored in this checkout.

`PI_HARNESS_SKILLS_PATH` changes the complete catalog, not merely one prompt. Provision and validate its dependencies before starting workers. An explicit `PI_HARNESS_PYTHON` bypasses managed provisioning and must already contain compatible IPython, dill, and skill dependencies.

## Develop and promote one source revision

Keep development and production as separate checkouts of the same repository. Put production configuration, external extensions and clients, credentials, and durable state outside the tracked source. Do not maintain production-only harness edits.

1. Develop the change in the development checkout. Update and check the relevant models before implementation, then run the required tests with isolated state and the pinned dependencies. Include configured external integrations in acceptance.
2. Review the exact outgoing files, commit, and push the tested revision to the release branch. Record its commit ID and dependency pins.
3. Fetch the published release into a separate candidate checkout. This can happen while production runs. Require the fetched branch tip to equal the reviewed commit ID; stop for review if the branch advanced unexpectedly. Test and prepare that exact remote-fetched candidate, not a private development copy.
4. Stop production writers before changing any source files they use; lazy imports can otherwise mix revisions. Create a consistent state checkpoint and test the successor reader on a separate copy. Verify the production checkout is clean and its remote is the intended repository, then fast-forward to the exact fetched commit, for example with `git merge --ff-only "$REVIEWED_COMMIT"`, or install the prepared clean checkout. Do not reset over unexplained local changes or run an unpinned pull that can fetch a newer revision. Verify `git rev-parse HEAD` equals the reviewed commit and that the tracked worktree remains clean.
5. Activate separately with the recorded external configuration and dependencies. Verify supervisor and client readiness, session recovery, required integrations, and the loaded revision. Updating checkout files alone does not replace already-running code.

Record a durable boundary before attempting successor startup. Before that boundary, a stopped deployment can restore the exact previous source, configuration, and dependencies. After the successor might have written state, recovery must preserve current canonical state and a reader compatible with those writes. Do not downgrade to an older reader merely because its process used to start. A checkpoint is not permission to rewind completed effects or replay uncertain calls. Keep deployment outcomes and the control/continuation path outside the entire failure domain being replaced, including its container. Test container loss when that is the actual deployment boundary; standalone process-restart tests do not establish container-level recovery.

## Uninstall

`node bin/install.mjs uninstall` removes repository-owned thin wrappers, not durable state or external dependencies. It leaves independently installed extensions unchanged. Stop the selected supervisor before deleting or relocating its source. Review and back up state separately rather than deleting it as part of code uninstall.
