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

## Automatic kernel cold residency

Ordinary Python execution automatically schedules bounded pressure maintenance
through its existing kernel owner. No caller setting or alternate execution tool
is required. A maintenance deadline is not reset by every small cell, so untouched
bulk state can become cold while ordinary work continues. Active/queued Python,
checkpoint, host-call and shutdown ownership take priority. Main/opaque namespace
state, identities and aliases remain intact; needed pages fault back naturally.

The helper advises only currently private anonymous mappings, checks cold/hot
and locked/changed ranges between bounded batches, and skips unknown capacity,
no-swap, unsupported and unreclaimable cases. It does not start another kernel,
serialize user state, clear history, collect garbage, change OS limits or replay
cells. Existing Node reclamation and checkpoint/restart recovery remain separate.
The optional wire capability is private and additive; older custom kernels keep
ordinary execution without receiving unrecognized cold commands.

The existing actor-scoped `kernel.status()` response adds optional `coldMemory`
metadata for an advertised version-1 kernel. It contains only `version`, a fixed
state token, and bounded numeric advice/residency/timing counters from the last
pass. It performs no new collection or execution and accepts no other-session
selector. Legacy or unknown-capability kernels omit the field; a new kernel with
unsupported advice reports that fixed state. This is the canary observation path.

An advice pass can reduce a process's resident set while leaving pages in
reclaimable swap cache. Do not report RSS differences as equal physical cgroup
savings. Paging can add next-use latency, and one kernel syscall cannot be
preempted by a new cell. See [measurement and qualification limits](validation/kernel-cold-residency.md).

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
- `harness/supervisor.pid.lock`: claimed by a starting supervisor before it opens the database and held until it stops; a second `start` exits while the owner is alive. A lock left by a killed supervisor is reclaimed.
- `harness/kernel-runtime/`: managed interpreter and dependency environments.
- `harness/skill-artifacts/`: private verified skill trees shared by content-addressed version; an explicit database path places this directory beside that database.
- `harness/entry-index-cache/`: optional private derived entry indexes for supported SDKs and explicit sessions; canonical transcripts remain authoritative.
- Pi's cwd-scoped `sessions/` tree: canonical JSONL transcripts.

Session sidecars derive from the exact canonical filename: `.skill-manifest.json`, `.skill-grant.json`, `.capabilities.json`, `.generation-<generation>-<sha256>.skill-grant.json`, and `.kernel-state/`. Do not move a transcript independently of its associated state. Derived indexes do not replace the canonical transcript.

The desired `.skill-grant.json` follows catalog reconciliation. Each worker reads a separate private, create-only generation snapshot with an exact-byte digest. Its skill paths select verified immutable copies, so source edits do not change an admitted generation's lazy imports. Existing idle refresh and revocation boundaries still determine when a replacement generation takes the current catalog. The source `contentHash` keeps its original meaning; the artifact path has a distinct verified materialized identity covering skill-owned runtime bytes, including `build/` and `dist/`.

Active generations and saved kernel manifests retain their artifact versions. There is no automatic artifact garbage collection. Artifact directories are private, not a same-user isolation boundary; content verification and no-overwrite publication own continuity. Managed environments use manifest source paths rather than the retired harness-owned `persistent-harness-skills.pth`; unrelated `.pth` customization remains unchanged.

The supervisor CLI accepts explicit `--socket`, `--db`, and `--pid` paths for isolated instances. Back up the complete selected agent state under a controlled stop, including database sidecars and transcript/kernel files. Do not treat a partial copy of active files as a consistent recovery point.

## Delete a session tree

Client `delete_session` and retained-child `delete_child` stop and tombstone the selected session and all descendants, including descendants beneath an older tombstone. Child callers can select only their direct children. Deletion fences new admission, input delivery, revival, and family routing while outstanding starts and mutations drain. A failed actor stop prevents the tombstone transaction; retry after resolving the stop failure.

Deletion retains canonical transcripts, kernel state, and artifacts. Successful responses include `deletedSessionIds`; clients also receive `sessions_deleted` with `sessionIds`. Remove every listed session from subscriptions and cached navigation, not just the selected row. Repeating client deletion is idempotent.

### Root session scratch

Each supervised root owns `/workspace/.scratch/<root-session-id>/`. The supervisor derives the owner from canonical parent ancestry and supplies the same path to every descendant, the system prompt, Python's `scratch_dir` (`pathlib.Path`), and managed actor/kernel/host-shell environments. The path is independent of cwd, family labels, actor generation, and caller parameters. The trusted supervisor environment can set `PI_HARNESS_SCRATCH_ROOT`, and embedders can set its `scratchDirectory` option; tests use private temporary directories.

Stop, passivation, supervisor shutdown, and child deletion preserve this directory. Startup recreates a missing owned root directory under its unchanged witnessed base, but rejects an existing replacement. Explicit root deletion atomically tombstones the family and records pending scratch reclamation on the existing root row. It does not wait for or kill detached jobs. Root deletion responses include `scratchCleanup`: `unowned`, `deleting`, `removed`, or `unknown` (invalid ownership metadata).

The existing background completion monitor retries pending reclamation, including after restart. It first proves that no marked managed process or family-owned background job remains active. Unknown ownership defers reclamation without reviving actors or replaying input. Background ownership discovery samples the union of pending families once, then checks matching or unresolved job IDs rather than rereading unrelated history on every tick. An incomplete directory-level sample needs an explicit root-delete retry or restart for a fresh proof; repairing an individual job's metadata can complete the existing proof. Established owner associations remain fixed; process identity is pinned only after kind, PID, and birth are all valid.

Only harness-created trees with persisted namespace/root device and inode witnesses are reclaimed. Preexisting root directories and legacy scratch are never adopted or removed. Boundary symlinks, changed identities, and mount crossings fail closed; interior symlinks are unlinked without following their targets. Each cleanup attempt uses a 10,000-entry/50 ms cooperative work budget, with a depth limit of 128; individual filesystem calls are not preempted. Interrupted attempts keep their durable intent and retry; a missing witnessed tree completes an already-removed attempt. A crash between directory creation and ownership recording can leave an unowned or mismatched directory that requires operator inspection.

The process proof reads only same-UID process ownership markers with PID birth revalidation, excluding only its own executing supervisor PID. Restart sanitization removes actor leaf/runtime markers but preserves the trusted namespace configuration. It is bounded to 4,096 processes, 8 MiB of reads, 64 KiB per environment, and 500 ms per sample; incomplete samples defer reclamation. A process that deliberately removes all ownership metadata is not attributable through this guard. These are same-user safety checks, not isolation: POSIX does not provide an expected-inode unlink, so an uncoordinated same-UID rename in the final validation/syscall gap cannot be excluded. No trash directory, age sweep, or new cleanup service is used.

## Recovery boundaries

Input acceptance is durable admission, not proof that inference consumed it. An original tool result and its namespace save are also separate. On kernel loss or snapshot mismatch, inspect the explicit diagnostics before making assumptions about Python variables. Uncertain effects are not replayed automatically.

An unexpected child actor exit atomically records its lifecycle error and queues one supervisor-generated message for its direct parent per actor generation. A turn that stops abnormally while its worker remains resident also produces a parent report. The coordinator journals a fixed failure descriptor, then admits its receipt through the same durable lifecycle queue. A canonical acceptance frontier limits startup recovery to pending reports. Receipt retries do not retry the failed turn.

Reports contain a bounded child ID, generation or turn ID, and a fixed failure class. Resident-turn reports distinguish failure before provider dispatch, attempted provider dispatch, and possible admitted or started tool effects. They contain no display names, raw errors, prompts, or transcript content. These are supervisor-generated lifecycle reports, not messages authored by the failed child.

Outer coordinator failures can also append one local canonical
`persistent-harness.turn-failure-diagnostic-v1` companion for the same turn. It
records the first escaping failure's fixed origin/operation, allowlisted error
kind/internal code, and result/flight/work state booleans. The v1 notice and
receipt are unchanged. Per-operation scopes preserve provenance across overlap;
new input cannot replace a frozen cause or carry it to the next logical run.
Unknown exceptions yield fixed `unknown` tokens without invoking their getters,
formatters, or proxy traps. The companion contains no exception text, stack,
cause, paths, payloads, or private-string hashes and stays off the provider wire.
A failed companion append preserves the original failure and v1 receipt; it is
not retried or used to replay work. A missing diagnostic does not identify a cause.

The existing durable family-message path wakes a passivated parent and retries the same message ID after a disconnect or supervisor restart. Recipient history deduplicates logical incorporation; acknowledgement is not proof that inference completed recovery. Stopped or errored parents retain pending messages until explicitly recovered. Parent deletion rejects pending delivery. Intentional cancellation, stop, delete, passivation, and supervisor shutdown do not generate failure reports. The failed child is not restarted and work is not replayed. No historical error backfill, busy-work timeout, or new human-notification source is added. Inspect the retained child state and verified saved artifacts before deciding how to continue.

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
