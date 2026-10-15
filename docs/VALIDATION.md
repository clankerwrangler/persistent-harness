# Validation

Install the declared Node dependencies and configure the exact external stock Pi paths from [Dependencies](DEPENDENCIES.md). Tests do not establish live provider compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:package-load
npm test
```

The tests use isolated temporary state, fake providers, and local processes. All supervisor tests, including fake-worker tests, need private `HOME` and `PI_CODING_AGENT_DIR`: a temporary database alone does not isolate transcripts or background notifications. The default background directory is `$PI_CODING_AGENT_DIR/state/background-jobs` (otherwise `$HOME/.pi/agent/state/background-jobs`); any explicit `backgroundJobsDirectory` must also be test-private. Never point tests at running service state or live credentials. For offline real-worker checks, set `PI_HARNESS_PYTHON` to an existing compatible interpreter and `PI_HARNESS_AUTO_INSTALL=0`.

The managed-runtime test explicitly exercises actual managed reuse and dependency rebuild, not the interpreter override. The stock-worker provisioning fixture also clears the override locally to check the real consent path. An optional `PI_HARNESS_TEST_MANAGED_SEED` can contain only cached `bin/uv-0.12.3`, `python/cpython-3.12.12-linux-x86_64-gnu`, and package `cache/` prerequisites. Both fixtures copy only these prerequisites into their temporary runtime; neither copies completed environments. The kernel test denies Node fetch. Set `UV_OFFLINE=1` for both offline runs. Do not supply completed environments, sessions, credentials, or kernel state as the seed. Without cached prerequisites, managed provisioning needs its documented downloads.

Native integration additionally requires `PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT` to identify the same external Pi install prefix:

```sh
export PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT="$PI_PREFIX"
npm run test:native
```

Set `PI_HARNESS_TEST_CLM_EXTENSION` to a separately maintained candidate CLM `index.ts` to include the direct-mirror integration: inference during a paused Python writer, canonical acceptance, and reopen. Without that optional checkout, this one cross-project test is skipped.

This suite uses synthetic loopback Responses transport and real Python. It covers early results and save ordering, FIFO, cancellation, wait barriers, actor/kernel loss, no-replay recovery, family wake, default compaction and public compaction hooks, source-order admission, encrypted reasoning amendments, and safe inference-only retry.

Compaction regressions hold a summary while an authenticated family message arrives, require the canonical snapshot to remain unchanged, and then verify one summary, one delivery, acknowledgement, and resumed inference. Coordinator checks cover queued bookkeeping after success, failure, and cancellation, plus a durable automatic-compaction error and recovery on later input. Cancellation checks distinguish manual callback rejection, threshold continuation without a loop, and overflow termination with the original provider failure and no retry. Public stock-runner tests cover structured and forced prompt chains, final observer ordering, first and subsequent requests, fresh resources, idle tool metadata, and input delivered during owner preparation.

The broader private integration checkpoint also exercised a browser client. Browser assets, its HTTP adapter, and browser-only tests are intentionally not part of this harness-only repository. Client-neutral protocol/history tests remain.

## Models

TLA+ sources in `specification/` cover bounded scheduler, stream, provider, retry, history, service ownership, and export-dependency assumptions. Obtain Java and `tla2tools.jar` separately. For example:

```sh
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/StockCoordinator.cfg specification/StockCoordinator.tla
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/FirstInputSnapshot.after.cfg specification/FirstInputSnapshot.tla
```

Use each model's matching configuration. Model checks prove only their finite abstraction, not arbitrary provider behavior, filesystem crash atomicity, or remote exactly-once execution. Keep test and model results tied to the source bytes under test.

`MessageLocation` models one submission and one acquisition: separate acquisition
and Send deadlines (including native callbacks before delayed timer delivery),
opt-in epochs, frozen no-location sends, late fixes, durable
replay and original Retry. It abstracts the browser and provider serializers.
`input-location`, `retry-context-rpc`, `native-provider-adapter` and
`actor-compaction` tests exercise validation/digest equality, restart persistence,
real stock worker replay, same-role serialization and visible/fork omission using
synthetic coordinates. The separate frontend model and browser tests cover
successive sends and stale native callback identities; neither model represents
the entire UI or a live location service.

The `RecursiveSessionDeletion-*.cfg` configurations cover root and direct-child deletion with and without a legacy deleted intermediate. They check subtree completeness, shutdown fencing, retained artifacts, and unrelated actors. `HarnessDependencies` covers explicit extension ordering, exact stock graph selection, and read-only, current-session projection. The models abstract external stop completion and projector internals; worker, socket, and canonical-history tests verify the implementation boundaries.

`CanonicalContextBudget` separates per-record archive string limits from aggregate archive structure and final-view limits. It covers signature-overlay concentration, the second detached helper copy, metadata added to the materialized view, and a single captured configuration value despite later process-environment changes. The abstraction models counts and immutable record tokens, not heap usage or JavaScript descriptor traversal. Canonical-context and stock-worker regressions check cumulative archive growth, oversized records and combined diagnostics, metadata limits, detached copies, and preserved precompaction recovery semantics. Isolated configured-budget checks cover default and invalid settings, exact range endpoints, large retained content/details, and the same selection across worker reads, recovery, compaction, and extension projection. The model abstracts configuration syntax; tests verify the decimal parser.

`AutomaticCompactionPermission` models current policy/registration at dispatch, monotone synchronous vetoes, the closed callback fence, stock fallback, input progress after a denied threshold, and original-error termination after denied overflow. It abstracts JavaScript scheduling and extension lifetimes. Public-SDK tests exercise synchronous versus post-await callbacks, actor-local buses, worker close, and invalidation before loader reload. Coordinator tests require denial before history/usage reads or recovery markers, no compaction lifecycle/retry, and continuation through a short history with no stock discardable span. Existing manual, permitted automatic, and late-hook cancellation tests retain those paths.

`ActorCompactionSnapshots` complements the lifecycle model with nested active/inactive archive mutations, isolated hook copies, immutable string identities, complete branch/pending identities, and cancellation before provider dispatch or append. It abstracts JavaScript references and heap allocation. The bounded-heap compaction fixture exercises large opaque history with a small current context, full hook data, preparation Sets, and cancellation without provider work; regressions also mutate active and inactive records during capture and hooks to verify stale-snapshot rejection.

`FailedCallProjection` checks immutable canonical evidence, per-identity positive exclusion, admission/result/conflict vetoes, selected-branch and compaction cuts, unchanged outstanding calls, and no fabricated effects. It abstracts malformed reports and identity conflicts as contrary evidence; canonical, adapter, and external-compaction-hook tests exercise actual transport metadata, late signatures, and serializer boundaries.

`ProviderErrorMetadata` checks fixed-field redaction, unknown-value noninterference, unchanged retry/error classification, and final-attempt ownership. Adapter tests cover actual error frames, private payloads and hook exceptions, retry resets, and a produced interrupted suffix carried through the actor stream planner into offline next-request serializers.

`ChildExitDelivery` models atomic generation-bound failure receipts, silent intentional exits, parent availability/deletion, retransmission after restart, and idempotent recipient incorporation. TLC checked 967 generated states, 181 distinct states, and depth 11 with no errors. It abstracts SQLite durability, fixed payload validation, and the existing family-message transport; it does not prove exactly-once inference or explain heap growth. Store and supervisor regressions exercise actual receipt persistence, worker-exit events, privacy, direct-parent routing, restart/redelivery, and acknowledgement. The native integration kills only a verified synthetic child process group and checks automatic parent inference, one canonical receipt, acknowledgement, and no child revival.

`KernelCompletion` checks that failed execution cannot become terminal until the controlled process exits, while successful execution can complete before namespace saving. It abstracts signal delivery and transport errors. `kernel-completion.test.mjs` checks decoder corruption, control-channel failure, queued-call no-replay, and forced close against real Python process exit.

`SnapshotSaveScope` separates non-certifying prior blob candidates from current-byte reuse verification. It covers unused old state, post-lookup source substitution, rewrite fallback, and unchanged full restore validation. The snapshot regression checks actual bounded reads, malformed old metadata, symlink/corrupt candidates, and recovery. The model does not claim protection against mutation of a hardlinked inode after verification.

`LivenessScope` separates protocol responsiveness from explicit status audits. It covers current and legacy protocol evidence, rechecking under the startup lock, no launch on timeout or invalid protocol, and unchanged heartbeat registration. CLI tests exercise these boundaries against a real supervisor and bounded protocol peers.

`VisibleOutputImages` checks request-time canonical image eligibility, root-only tool output, existing origin/session/branch gates, source integrity, byte validation, and preserved input delivery. It abstracts image parsing and HTTP authorization; reader and supervisor tests exercise their actual boundaries. The separate frontend tests verify exact PNG/JPEG bytes and retained Markdown rendering in isolated Chromium.

`ModelCatalogRefresh` models the catalog call integration: a 15-second abort signal, delegated browsing policy, local-only pin admission, unchanged model selection, and visible cached fallback. Pi owns refresh concurrency, cache, TTL, and transport behavior; this model does not reimplement or prove them. The catalog integration test uses stock Pi with synthetic credentials, isolated metadata, and mocked public catalog responses to check picker/search visibility, stale-actor exact pins, offline use, and safe warnings.

`CanonicalContext.projection` covers selected-source provenance and content edits without changing raw admission or recovery. `ActorCompaction` includes the always-cancel stock preparation stage before active hooks and distinct cancellation, failure, and committed outcomes. It also checks manual-only summary refresh with the full retained tail when stock preparation is empty. Real SDK tests cover default and extension refresh, a physical leaf that is itself a checkpoint, unchanged automatic behavior, preserved file facts, and a source change after the custom hook but before the guarded append. `FirstInputSnapshot.after` also checks that request prompt preparation matches the latest delivered input; it abstracts rendering and extension ordering, which the stock-runner tests exercise. `NativeProvider.transcript` preserves native history through stock system-message normalization. Tests cover source rejection, branch-local edits, checkpoint/image retention, public preparation capture with no provider/write/UI effects, async span retention, and in-place tool declarations with native opt-in proof.

`DescendantTraversal` checks deduplicated expansion over finite parent graphs,
including cycles, deleted intermediates, and working-node subsets. It verifies
termination, at-most-once expansion, and exclusion of the queried session from
its own descendant count. It also compares indexed parent-edge traversal with
a full-scan oracle, retaining deleted edges in the index for subtree deletion.
SQLite owns index maintenance; the model does not prove its query planner or
crash behavior. Store tests verify fresh creation, idempotent migration, covering
index selection, and read-only reopening without an index. A bounded subprocess
regression checks cycle-member
session projections without risking a hung test runner and preserves acyclic and
deleted-intermediate counts.

`FamilyFastMode` covers two independent roots sharing a family label, a child and
grandchild, root-only preference writes regardless of root model support,
missing/deleted ancestors, legacy absent-field default-off versus malformed
preference failure, retained/new/resident actors, and immutable request samples.
`SessionFastMode` covers own-model eligibility and matching wire/accounting tiers; its detailed-stream invariant records the pinned stock simple-option
filtering boundary. Store/control tests also check malformed and bounded ancestry,
legacy child-local flags, unknown metadata, navigator refresh, revival, concurrent
expected-selection writes, busy actors, and precommit RPC/persistence failures.
Native and stock adapter tests use synthetic credentials and mocked transport to
check payload, reasoning/option parity, and tier-aware estimated cost; real-worker
loopback tests cover streaming toggles, subsequent requests, reattachment, and
clearing Fast. These are offline checks, not live service-tier eligibility,
latency, or billing guarantees.

`InputAdmission` checks durable admission, independent acknowledgment/readiness,
coalesced wake ownership, overlapping sends, failure visibility, and drained
shutdown/restart. It abstracts skill reconciliation, SQLite atomicity, transport,
and worker consumption; it does not prove exactly-once execution. Supervisor
regressions hold startup and close, reject registration/factory/start/submit,
retry the same receipt after reconnect or failure, verify the correlated accepted
error and its clearing on retry, and verify stop/delete/restart.

`SettledWakeOrdering` checks both mutation orderings: a wake registered before Stop
is joined, and a later settled callback cannot reenter readiness after Stop.
Registration leaves the mutation queue before readiness waits. The existing
`supervisor-settled-stop.test.mjs` cases also verify that a real stopped writer
cannot append and that only explicit later activation revives it.

`ActorInputReconciliation` models startup without a historical actor receipt
sweep, retained supervisor reconciliation, receipt loss across actor generations,
ambiguous evidence, and an unchanged compaction barrier. Disabling historical
supervisor reconciliation fails its recovery invariant. Reporter tests cover
appends during registration, complete-history ambiguity, and offline reporting;
a real stock-worker test requires native, legacy, and custom historical pending
receipts to complete through supervisor reconciliation without reinjection.

`ActorCompileCache` checks one supervisor cache owner, cleanup after pending
launches and writers drain, generation-local runtime identity, unchanged readiness
validation, source-current loads, and disabled/unavailable fallback. Node's cache
format and source/version validation are abstracted, not proved. Helper tests use
real Node processes for unsafe-path rejection, operator controls, same-length
source changes, normal exit writes, and concurrent fresh evaluation. A supervisor
regression holds both worker close and startup to verify disposal ordering; stock
worker, recovery, and Stop tests retain their existing runtime assertions.

`SessionHistory` models independently cancelled callers, serialized history
ownership, verified canonical/receipt dependency versions, atomic publication,
citation-version consistency, and shutdown after drain. Its finite abstraction
does not prove SHA-256 collision resistance, filesystem atomicity, or wall-clock
latency. Reader/index tests cover partial lines, same-inode rewrites with and
without growth, mixed ordinary/history readers, branch changes, bounded restart
hydration, receipt ambiguity and receipt-only changes, and cancellation during
prefix I/O and FTS transactions. Supervisor tests hold disconnect, deadline,
shutdown, and competing source versions; a real Python skill-to-RPC test crosses
the former three-second deadline without reviving a transcript actor.

`ConversationBirthOrder` models text/progress births, arbitrary event arrival,
equal-millisecond sequence order, prefix rebase, immutable identity, embedded
commit metadata, restart/fork recovery, and visible text after commit failure.
Run its matching `.cfg`; the eight `ConversationBirthOrder.<flag>.cfg` controls
each disable one required property and must produce an invariant violation.
The model abstracts wall clocks, filtering, hooks, canonical I/O, and transport.
`conversation-birth`, `actor-coordinator`, `visible-transcript-reader`, and
`e2e-slim-stream-identity` tests cover those boundaries with synthetic data,
including genuine stock-worker slim events, restart, branch navigation,
pagination, protected metadata, and injected append failure. The separate WebUI
browser regression checks keyed progress nodes during live text arrival and
completion, then independently checks reload reconstruction.

`EventLogTail` compares a reverse nonempty-line scan with the complete forward
log oracle, including malformed-line quota and exact truncation detection. It
checks 6,441 distinct states for the bounded configuration. The model abstracts
segment sampling and byte decoding; `event-log-reader.test.mjs` checks rotated
order, pinned inodes, missing segments, UTF-8 boundaries, large records, short
reads, concurrent truncation, descriptor cleanup, and suffix-only I/O. A log read
remains a best-effort observation of two segments, not an atomic rotation snapshot.
