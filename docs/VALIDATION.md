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

For bounded-history SDK integration, set `PI_HARNESS_RETENTION_SDK_MODULE` to a
source-test artifact or SDK entry exporting the corrected literal `SessionManager`.
For the complete source-mode path, also set `PI_HARNESS_TEST_SOURCE_SDK=1` and
`PI_HARNESS_TEST_SDK_PACKAGE_DIR` to that coding-agent package's asset directory;
the artifact must export its matching `createAgentSession` and `ExtensionRunner`.
Worker/native fixtures use those three corrected public owners while keeping the
verified stock public providers/helpers. Installed files remain unchanged. With
no override the fixtures exercise the selected public package directly. A complete
source-built package is recognized through its source-hook capabilities; it does
not need the source-owner override. Select its adjacent public `dist/index.js`
and `dist/cli.js`, and set the native root to the actual consumer prefix (including
any containing `node_modules` wrapper). Set `PI_HARNESS_TEST_OFFICIAL_PI_MODULE`
to a separate official 0.99.1 public entry when testing that package: the dedicated
bundle test still accepts only official bundled bytes and rejects a custom bundle.
Direct fixture writes must refresh a borrowed public session source before taking
a no-effects snapshot, just as the coordinator refreshes after a canonical commit.

`canonical-retention.test.mjs` checks source-generation invalidation, producing
selection, append cursors, compact namespace/native facts, complete ordered range
validation and explicit history. Canonical differential fixtures retain native,
signature, alias, edit, getter/rejection and failure assertions. Navigation,
compaction and later commits share the canonical public-state refresh, preserving
selected signature amendments without eager message hydration. Actual source-mode
worker checks cover mutable public Agent arrays, source/legacy hooks, direct/full
versus supervised/type-only end events, and SDK status plus automatic threshold
checks without a veto after append/edit/reload. Tool fixtures cover unread source
lifetime through nested drain and independent exposed-array ownership.

A separately selected source-aware context editor is tested through the actual
SDK/H/extension request path with accepted shortening and no stock compaction:
warm requests do not read the archived omitted entry, while full history and
all 16 captured drafts remain available. Its own tests cover exact captured values
after same-path overwrite, source expiration, checkpoint recovery, file ownership,
exclusive-create collisions, failed capture and final-owner cleanup. Legacy eager
array hooks remain explicit compatibility boundaries, not evidence of a source-only
bound. Optional cross-project fixtures do not install that dependency.

The isolated synthetic comparison measures both entry-count and payload-size
axes for stock compaction, context-edit omission/nonproduction/small replacement,
and source-aware extension shortening with 16 retained views. Record retained heap,
external/array-buffer bytes, RSS, payload hydration and compact metadata separately;
endpoint heap deltas are not total allocated bytes. Supplementary SDK system-replay
fixtures keep the effective prompt fixed while superseded system sections or an
unrelated compaction summary grow. Cold payload bounds do not imply total RAM is
independent of entry count, pending work, explicit full APIs, or legacy consumers.

This suite uses synthetic loopback Responses transport and real Python. It covers early results and save ordering, FIFO, cancellation, wait barriers, actor/kernel loss, no-replay recovery, family wake, default compaction and public compaction hooks, source-order admission, encrypted reasoning amendments, and safe inference-only retry.

Compaction regressions hold a summary while an authenticated family message arrives, require the canonical snapshot to remain unchanged, and then verify one summary, one delivery, acknowledgement, and resumed inference. Coordinator checks cover queued bookkeeping after success, failure, and cancellation, plus a durable automatic-compaction error and recovery on later input. Cancellation checks distinguish manual callback rejection, threshold continuation without a loop, and overflow termination with the original provider failure and no retry. Public stock-runner tests cover structured and forced prompt chains, final observer ordering, first and subsequent requests, fresh resources, idle tool metadata, and input delivered during owner preparation.

Filesystem race fixtures order the adversarial operation at the actual syscall
boundary: parent detachment completes after link/rename and before publication
verification; the real grep worker enumerates a directory before that child is
replaced by a symlink. They retain real filesystem operations and worker resource
limits without relying on inotify delivery or a busy rename loop. The transport
callback regression retains all 511 queued compactions and verifies their
correlated order and completion. Callback responsiveness keeps its existing
bounds; batch completion uses the existing request and outer-test deadlines.

The broader private integration checkpoint also exercised a browser client. Browser assets, its HTTP adapter, and browser-only tests are intentionally not part of this harness-only repository. Client-neutral protocol/history tests remain.

## Models

`IdleEntryIndexHost` checks deferred versus actual idle dispatch, readiness-wake
cancellation, token/generation ownership, late sealed-prefix publication, and
nonblocking admission/close. It separately retains normal RPC shutdown drain;
its ten negative configurations must fail their intended invariants. SDK cache
bytes and filesystem trust remain the SDK's model/test boundary. Worker and
supervisor fixtures hold preparation through prompt, family/background input,
retirement, transport close, and extension shutdown. The public bootstrap fixture
uses the selected literal SDK manager and complete package graph, checking stable
paths, no cold cache-directory creation, private idle publication, preserved
canonical prefixes, and unconfigured in-memory/new/recent modes.

`DependencyLookup` checks the final graph-root candidate without ancestor escape,
retaining declaration, identity, version, shared-instance and public-export gates.
Its `SkipRoot`, `AllowEscape`, and `AllowMismatch` controls must fail. Synthetic
flat/nested installed layouts exercise the real resolver without executing their
package bodies. Integrated qualification uses the actual public SDK and CLI from
one bound package graph, not replacement SDK owners.


TLA+ sources in `specification/` cover bounded scheduler, stream, provider, retry, history, service ownership, and export-dependency assumptions. Obtain Java and `tla2tools.jar` separately. For example:

```sh
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/StockCoordinator.cfg specification/StockCoordinator.tla
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/FirstInputSnapshot.after.cfg specification/FirstInputSnapshot.tla
```

Use each model's matching configuration. Model checks prove only their finite abstraction, not arbitrary provider behavior, filesystem crash atomicity, or remote exactly-once execution. Keep test and model results tied to the source bytes under test.

`ConcurrencyFixtures` checks publication/detach/verification ordering, a child
symlink replacement after enumeration, and independent callback admission followed
by exactly-once backlog drain under fair scheduling. Its configured backlog is
511. The `NoRendezvous`, `FollowLink`, and `BlockCallback` configurations must fail
their corresponding safety or completion checks. The model abstracts OS timing;
filesystem, worker, and socket tests exercise the actual boundaries.

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

`FailedCallProjection` checks immutable canonical evidence, per-identity positive exclusion, admission/result/conflict vetoes, selected-branch and compaction cuts, unchanged outstanding calls, and no fabricated effects. Its owned-commit evidence requires matching message/attempt identity and cannot certify admitted calls. `NoWitness`, `BadOwnedIdentity` and `BadOwnedAdmission` are separate negative controls and must violate their intended invariants. The abstraction does not authenticate correlation strings or prove a two-append filesystem transaction. Canonical differential tests exercise exact direct-child schemas, all call fingerprints, unchanged missing-proof/native guards, full-branch vetoes, edits and late signatures. Real packaged SDK coordinator/retention tests cover failed partial and complete ordinary calls, source and array contexts, cold resume, genuine subsequent inference, no tool replay or fabricated result, and failed append/acknowledgement/hook/ownership boundaries. Adapter and external-compaction-hook tests retain actual transport and serializer assertions.

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

`InputAdmission` checks durable admission/publication, independent acknowledgment/readiness,
coalesced wake ownership, overlapping sends, failure visibility, and drained
shutdown/restart. It also checks one finite post-spawn state/steering
handshake deadline, a separate warm RPC deadline, and termination under fair timer
steps. The `CoupleStartup`, `ResetSteering`, and `ExtendWarm` configurations must
violate their corresponding deadline invariants. Queue waiting is distinct from
the handshake clock; ticks abstract time, not archive size or actual latency. It abstracts skill reconciliation, SQLite atomicity, transport,
and worker consumption; it does not prove exactly-once execution. Supervisor
regressions hold startup and close, reject registration/factory/start/submit,
retry the same receipt after reconnect or failure, verify the correlated accepted
error and its clearing on retry, and verify stop/delete/restart. Session-actor
checks use the real worker RPC boot barrier with a synthetic bootstrap to verify
cold and steering work beyond the warm deadline, unchanged warm timeout, one
shared startup budget, late acknowledgement rejection, legacy direct callers,
finite hung-start failure, explicit bootstrap errors, and close during startup.
They do not open private sessions or establish live startup success.

`StockWorkerSetup` checks cleanup ownership before asynchronous setup, the
cancellation fence before worker startup, and cleanup after the owned copy drains.
The stock-worker fixture has a controlled delayed-copy cancellation regression;
normal provisioning/consent and kernel reuse/rebuild assertions remain unchanged.

`BackgroundCompletions` checks bounded dispatch ownership, acceptance independent
of cold owners, durable publication, sent-after-readiness, retry/idempotence,
owner ordering, safe-checkpoint admission independent of run end, and stop after
dispatch drain. It abstracts
filesystem polling and process startup latency. Background notifier/supervisor
regressions hold startup across later scans, verify same-owner and unrelated-owner
progress, reject startup then recover without duplicate canonical entries, and
check bounded dispatch and stop drain. The paired WebUI real-worker browser case
checks live queued rows without reload, model-request receipt before an older
held Python call finishes, exact promotion, and retained-state completion without
replay. Legacy pending/completed receipts keep their original identity/digest.

`SettledWakeOrdering` checks both mutation orderings: a wake registered before Stop
is joined, and a later settled callback cannot reenter readiness after Stop.
Registration leaves the mutation queue before readiness waits. Automatic empty
exited-child intent is revalidated at the actual start boundary after asynchronous
skill reconciliation; a fresh pending input still wakes it. Both stop_session and
the family stop_child route cancel and join earlier readiness ownership. The existing
`supervisor-settled-stop.test.mjs` cases also verify that a real stopped writer
cannot append and that only explicit later activation revives it.

`ActorInputReconciliation` models startup without a historical actor receipt
sweep, retained supervisor reconciliation, receipt loss across actor generations,
ambiguous evidence, and an unchanged compaction barrier. Disabling historical
supervisor reconciliation fails its recovery invariant. Reporter tests cover
appends during registration, complete-history ambiguity, and offline reporting;
a real stock-worker test requires native, legacy, and custom historical pending
receipts to complete through supervisor reconciliation without reinjection.

`PendingInputReads` checks ordered receipt/payload snapshots, one-query pending
reads, payload-free existence and no-op clear, and current queue selection after
an asynchronous boundary. Its `NPlusOne`, `EagerClear`, and `StaleQueue` controls
must fail their corresponding invariants. It abstracts SQLite execution and JSON
hydration. `pending-input-reads.test.mjs` counts actual prepared queries, synthetic
payload parsing, and row updates while checking per-ID value parity, timestamps,
provenance, attachments, repeated failure publication, and affected-only clearing.
The existing input-location and supervisor reconciliation tests retain legacy
read-only, post-await evidence, stop, and no-replay coverage.

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

`CanonicalOpaqueIngestion` checks global metadata and selected native-fact gates,
atomic publication, source expiry, and validation when an opaque value is
explicitly consumed. Startup, ordinary inference, and bookkeeping do not read
unrelated custom-entry bodies. Its `BadEagerOpaque`, `BadMetadata`, `BadValue`,
and `BadFence` controls must fail their corresponding invariants. The model
abstracts SDK byte framing and content fingerprints; public entry-source tests
check duplicate/parent metadata, deferred malformed values, selected signatures,
committed-read digests, and independent full-value captures. A real source-mode
SDK/coordinator fixture checks cold resume, the first ordinary request, recovery,
and bookkeeping with public-read counters. Default/array managers and explicit
history, tree, edit, and branch operations retain complete values.

`CanonicalFactStorage` checks omission of empty per-message fact containers,
exact nonempty native/alias/observation evidence, selected rejection and reload.
Its empty-retention and dropped-fact controls must fail. The retention regression
also checks the sparse representation without weakening its existing projection,
branch, signature and no-replay assertions.

`RecoveryValueLifetime` checks descriptor-bound bytes through restore and release
before readiness, including a reported decode failure. Its early-release and
retained-ready controls must fail. `kernel-recovery-lifetime.test.mjs` executes the
actual startup/restore source with public synthetic serialized values, checking
success, truthful decode errors and final temporary-owner release; it does not
start or inspect a live kernel.

`MemoryDiagnostics` checks operator-only scope, forwarding across drain races,
immediate busy rejection, synchronous pipe reservation before later work, no
process startup and no conversation/checkpoint mutation. Its five controls
(`IgnoreBusy`, `StartMissing`, `SkipReserve`, `MutateRead`, `BypassAuth`) must fail.
The finite model abstracts numeric collection and OS scheduling. Focused
`memory-diagnostics.test.mjs` fixtures exercise real isolated kernel history,
queued tools/snapshots, a nested host-response wait, close after an admitted read,
fixed peer-field projection, exact-type/subclass/metaclass hook rejection,
deduplicated sizes, count/time truncation, client-only auth, the connect-only CLI,
and a held unrelated supervisor mutation without actor start or state changes.

`CanonicalContextRetention` complements `CanonicalContext` and
`CanonicalContextBudget`: revision/generation ownership, leaf changes,
compaction-pruned native/alias/signature facts, and working-payload scope.
`BadLeaf`, `BadColdFacts`, `BadGeneration`, `BadSourceHydration` and stale-profile
controls must fail their distinct invariants. Source materialization also retains
the captured effective process-wide budget. The SDK's `SessionEntryRetention` separately checks cache ownership,
committed snapshots, pending sole copies, source reload and ordered range extent
(including duplicate-ID tails); its alias and range-extent controls must fail. These finite models abstract JSONL byte decoding, JavaScript aliases
and actual allocations. SDK UTF-8/value tests, differential projections and
synthetic retained-memory measurements cover those boundaries.
