# Architecture and protocol

## Pi integration

Reuse stock Pi capabilities through public APIs and supported extension points before adding harness implementations. Add minimal integration code only for demonstrated gaps; do not maintain a parallel system for behavior Pi already owns.

## Owners

- `HarnessSupervisor` owns admission, actor generations, durable queues, family scope, schedules, process completion, and local client routing.
- Each `sdk-worker` has one active extension runtime and one quiescent SDK service runtime sharing the same literal Pi `SessionManager`. The coordinator is the sole inference and tool-execution owner. It does not run a competing stock agent loop.
- `ActorCoordinator` owns request snapshots, steering/follow-up queues, calls, results, cancellation, usage events, and service leases for compaction and navigation.
- `PythonKernel` owns the real interpreter, FIFO execution, and namespace checkpoint tail. A result can be delivered before its background save completes; the next Python operation and graceful shutdown still drain that tail.
- Pi owns canonical JSONL session identities and public SDK data formats. The harness appends standard messages and versioned metadata through the one manager.

Actor residency follows the worker's own settled interval, not its family display.
A resident parent can show `delegating` while its `quietSince` timestamp remains
stable across descendant activity. With no own pending input, task, family message,
tool/compaction work, readiness wake, or session mutation, that worker is eligible
for the existing inactivity timeout and capacity eviction. Retirement rechecks the
actor generation and idle interval under the existing mutation owner. Completion
of blocked work reconsiders retirement and optional index preparation. A working
child remains independent; later input or a family message uses normal revival,
canonical history, and kernel snapshot recovery. Family activity and notification
settlement still include descendants.

The supervisor lazily owns one disposable Node compile-cache directory shared by
its actors. The actor enables it before importing the SDK worker; tools and the
supervisor do not enable it through this path. Node owns code/source/version
invalidation, while each generation still creates fresh runtime objects and runs
normal resource, model, credential, skill, session, and recovery validation. No
session data or live runtime objects are cached. The first actor populates an empty
cache, normally written at process exit; later actors can reuse compiled code.

The directory is a real, effective-user-owned `0700` temporary directory. Setup,
validation, or cleanup failures leave ordinary startup/shutdown intact. Shutdown
removes only the original owned directory after actors and pending launches drain;
uncertain writer exit leaves it in place. Abrupt supervisor loss can leave an
orphan; there is no orphan sweep, eviction policy, or hard disk quota. A new
supervisor starts with a new directory. Platforms without effective-UID validation
skip this optimization. See [Node cache controls](DEPENDENCIES.md#node-compile-cache).

These are same-user local processes, not a multi-tenant security boundary. The Python and shell capabilities execute with the service account's privileges.

## Python namespace checkpoints

Each eligible top-level binding keeps its own dill serialization, payload file,
SHA-256 digest, and admission check. Payload limits remain 4 MiB per value and
16 MiB per snapshot; the manifest reader accepts at most 1 MiB.

Snapshot format version 2 preserves repeated exact top-level source roots,
including function and class roots. Its fixed-width blob filename is
`SSSSSS-GGGGGGGGGGGG.dill`: the six-digit decimal saved-entry ordinal and the
12-digit hexadecimal ordinal of that root's first successfully admitted entry.
Equal-valued distinct roots are not grouped. Version 1 remains readable with its
original independent restore semantics.

Restore checks every entry's own descriptor-bound regular-file bytes, size, and
hash before alias reuse. A group uses its earliest eligible successfully decoded
entry; a missing, corrupt, protected, or unloadable owner cannot seed it. Invalid
group metadata reports an error and prevents checkpoint attribution, but safe,
healthy payloads still restore independently. Every binding retains an independent
physical payload copy. Sharing within a root remains dill-owned; sharing through
descendants of different roots or private scopes is still unresolved.

## Extension prompt preparation

The active runner receives fresh structured `systemPromptOptions` for each user input. Extension handlers can edit those options or return a forced prompt using Pi's public `before_agent_start` contract. A final, read-only observer renders `event.systemPrompt` during its callback. The public resource-loader override places that observer last, following Pi's documented extension load order; it does not retain an event getter or import a private renderer.

The coordinator carries the resolved text and options into owner request preparation on the first request and subsequent requests. Owner preparation still adds current depth, skill, and namespace information. If preparation flushes another user input, the coordinator prepares its changed prompt before taking the matching message snapshot. Run-local additions do not become the next input's base options; idle commands still read current resource and tool metadata.

## Canonical history

A complete, provider-confirmed native tool prefix is committed before an effect starts. Original call IDs bind results. Partial or unconfirmed calls are not native admission proof. After process loss, recovery records a truthful interrupted/unknown outcome instead of replaying an uncheckpointed operation.

For registered source-mode managers, native recovery planning uses the current validated selected call/result facts, including calls outside the model context. It keeps timestamp, configuration, selected canonical validation, and source-generation/revision/leaf fences without building a discarded model view. Default/custom managers and other modes retain full-projection planning. Model projection remains strict: an unknown-result append can precede a projection-only edit or SDK-contribution error at the existing post-commit refresh or next inference preparation. Invalid projected context cannot pass that projection gate. Recovery does not populate or clear token profiles; the existing projection owner prunes stale keys and validates current keys before use. The prior bounded profile set can survive until that projection or generation retirement.

Late reasoning-signature metadata amends a selected prior assistant entry without rewriting its bytes. Read-only context projection applies selected-branch amendments and places a known deferred native result exactly once where stock provider serialization requires it. It does not invent successful or missing-tool output. Effective compaction uses a valid selected `firstKeptEntryId`; unused extra fields and superseded checkpoints do not create new materialized history. Stock `buildSessionProjection` owns context edits and system checkpoints. The harness verifies each projected source entry against the selected branch; edits can change content, not call identity or native provenance. Raw canonical calls and results still own admission and recovery, including results omitted from model context.

Effective native and ordinary contexts omit an error/aborted assistant tool-call block only with positive non-admission evidence. The native path requires its own fenced v1 transport report identifying an incomplete, nonnative item. Existing STOCK Codex evidence requires the exact API/provider and a typed `provider_transport_failure` diagnostic with `eventsEmitted: true` and phase `after_message_stream_start`: either stock's `auto`/`websocket` diagnostic or the harness's exact `persistent-harness-sse-body-read-v1` producer and `sse` transport. The latter witnesses an actual response-body read rejection, not EOF, parsing, API, hook or cancellation errors. These ordinary producers dispatch no calls on a failed terminal, including complete calls. Own native transport/error metadata or call `async: true`/provenance/provider-ID fields veto ordinary classification.

For new failed ordinary commits, the coordinator also records `persistent-harness:ordinary-non-admission:v1` immediately after the assistant entry, inside the same serialized commit operation and before context refresh. It must still own the current flight, have acknowledged that exact final planner commit, and have admitted and dispatched zero calls. The record binds its direct parent entry, message ID, request/attempt correlation, and the complete ordered list of call indexes, IDs, names and SHA-256 value fingerprints. It contains no arguments or result bodies. Request/attempt strings are source-owned correlation, not independent authentication. The projector validates the exact v1 schema and target using the same compact facts as full-value projection. Unknown, malformed, mismatched, cross-target or missing records grant no omission; a crash between message and witness deliberately remains blocked. No witness is backfilled from later counters or error text, so unproven historical failures still require explicit maintainer recovery.

All paths retain full selected-branch result, admission, identity-alias, and conflicting-observation vetoes, including evidence pruned by compaction. Canonical entries and signature indexes remain unchanged; the failed assistant envelope and all other blocks survive. `UNADMITTED_CALL_OMITTED` is an informational projection diagnostic, not a tool result, execution, or recovery admission.

Provider error frames may add `nativeProviderError` with version 1 and fixed allowlisted code/category tokens. Unknown values map to `unknown`; raw messages, parameters, and payloads are not retained. This optional assistant metadata does not change retry classification or `errorMessage` and is reset between transport attempts.

Compaction and navigation use one owner lease, active extension hooks, public SDK helpers, drained provider streams, and one canonical writer. The existing dormant SDK service captures stock preparation through an always-cancel `session_before_compact` hook, before provider dispatch or append. Stock owns edited content, cut selection, token accounting, and file tracking; the harness moves a cut earlier when a native async call/result span crosses it. If stock has no newly discardable span, manual compaction can refresh an existing summary while retaining its entire selected tail. This uses a real projected source anchor, the previous summary, unchanged settings, projected token estimates, and existing standard file-operation facts. It does not create history to make a cut possible. Threshold and overflow compaction still require stock preparation; an uncheckpointed small history or missing retained anchor remains ineligible. The active driver alone emits user hooks, summarizes, and writes. Default compaction and public extension hooks receive current namespace diagnostics; unresolved real tool results remain a compaction boundary.

Before automatic compaction work, the coordinator queries its active runtime's actor-local public event bus on `persistent-harness:automatic-compaction-check`. The frozen request is `{ version: 1, reason, contextWindow, veto }`, with `reason` equal to `threshold` or `overflow` and the current model's numeric context window (or `undefined`). Subscribers must call `veto()` synchronously; any veto denies the query, and callbacks after `emit` returns have no effect. With no subscribers, the query permits the existing stock path. Manual compaction bypasses this query. A denied threshold skips stock history/usage reads and preparation, allowing queued input to proceed. A denied overflow terminates with the original provider error before recovery markers, compaction events, or retry. The later `session_before_compact` hook remains available on permitted attempts.

The bus belongs to the active loader, not the dormant preparation runtime. SDK runtime invalidation removes tracked extension subscriptions. Worker close and bootstrap-failure cleanup invalidate the active runner; actor reload uses a new supervisor-owned generation. Raw `DefaultResourceLoader.reload()` alone does not invalidate old subscriptions: owners that reuse a loader must invalidate the old runtime first, as stock `AgentSession.reload()` does.

Harness bookkeeping appends await the coordinator's active compaction barrier. Incoming family history, usage receipts, progress, and child-creation records therefore cannot invalidate an in-flight summary. The barrier releases on success, failure, or cancellation; existing message delivery and acknowledgement ordering remains intact. The strict snapshot validation remains in place. Actual automatic compaction failures use the normal canonical assistant-error commit path so a failed turn remains visible after detachment or restart. An extension's `{ cancel: true }` is a distinct outcome: threshold cancellation skips that compaction opportunity and continues; manual callers receive `ERR_COMPACTION_CANCELLED`; overflow cancellation stops recovery, retaining the original provider failure without another request. Cancellation does not append a summary or a synthetic summary-failure message. The driver's terminal event still reports `aborted: true`; a planned `willRetry` is not evidence that a retry occurred.

When the selected SDK supports `SessionManagerOptions.entryRetention`, persistent
actors opt into a 1 MiB private serialized-byte cache before opening the file.
The same SDK manager retains compact byte-location/header indexes and hydrates
complete entries on demand. Default SDK aliases remain unchanged; the opt-in
mode returns independent committed-value snapshots, including pending values.
Unflushed or failed-write values keep their sole owned copy until persistence.
Explicit history, tree, branch, edit and compaction APIs remain complete.

The canonical projector registers only these opted-in managers. It validates
archive data and selected native/signature/alias facts once per committed source
generation, then validates appended records incrementally. A fresh independent
`{revision, generation}` stamp invalidates facts after reload/rewrite/file changes;
leaf-only changes rebuild selected-branch facts. Cold indexes retain identities,
positions and nonempty validation facts, not message bodies, arguments, result
payloads or encrypted signatures. Empty per-message fact Maps are transient;
ordinary messages do not retain four empty containers. `buildSessionSource()` selects producing contributions before hydration, including
context-edit omissions and replacements; genuine pending calls remain recovery
facts even outside the model view. Input receipts,
settlement cursors, issuer lookup and family bookkeeping use that same index.
Default/custom managers keep the stateless projector and its descriptor guards.
Index/native metadata still grows with entry count; this bounds cold **payload**
retention and normal-turn hydration, not total resident RAM independently of
history. Explicit full-history results belong to their callers, not a permanent
cache. Extensions that request full archives can still materialize them.

When the selected SDK also exposes `prepareEntryIndex`, an explicit `--session`
uses a stable SHA-256 key of its normalized absolute path under the private
`<agentDir>/harness/entry-index-cache/` directory. Bootstrap supplies that path
before opening the same manager, without creating the cache directory. Default,
in-memory, and implicit new/recent sessions do not opt into this preparation.

The supervisor defers one request at the first actual own-idle dispatch of each
settled interval, including a parent displaying `delegating`, outside session
mutation. Readiness wakes cancel a deferred candidate without consuming the
interval; their existing completion boundary can reconsider
it after removing the wake owner. Actor record, generation, token, own-idle, and
pending-work checks fence dispatch and late completion. Human, family, scheduled,
and background wakes cancel preparation; worker prompts, run start, and close do
the same. Directory creation and the existing manager's bounded metadata writer
run only after worker idle/busy/queue checks. No new manager or service lease is
created. Admission, ordinary close, and the existing three-second shutdown grace
do not join preparation. Extension-requested shutdown excludes only optional
preparation promises from its drain; all requests retain admission and active-ID
accounting, and normal requests still drain.

The derived file can survive actor generations. The SDK owns private-path,
original-byte, header, digest, and generation validation, the 32 MiB per-file bound,
and native fallback. Its checksum detects accidental corruption; same-user private
metadata is trusted host state, not an imported project cache. Once rename is
queued, a late cancellation or canonical append can still publish a complete
immutable prefix. A true result is publication, not freshness; the harness does
not use it as admission or recovery proof. Shutdown-hook appends remain an ordinary
suffix. Preparation adds idle metadata serialization and I/O; warm open still
reads and hashes the full prefix but avoids decoding indexed historical bodies.
No retained-memory or total-disk bound is implied.

With the supported source-mode SDK, the dormant service session initializes with
`createAgentSession({contextMode: "source"})` and rebinds its Agent source after
canonical changes. Ordinary model, thinking, tool, prompt and status reads do not
seed a raw messages array. SDK status/automatic-threshold checks and the harness's
turn-end estimator reuse numeric contribution profiles under their original usage,
compaction and edit rules. Explicit public messages access pins a genuine mutable
array until replacement or canonical refresh; existing mutations remain visible.

The active runner dispatches `context_source` and `context_with_system_source`
before materializing provider input. A source-aware extension can shorten a
borrowed generation-fenced plan or return an owned effective source. The configured
flush hook is source-aware. Each extension's source handler replaces only its
paired array handler on this dispatch. Any real legacy array consumer receives
its complete input at that boundary and can require eager payload materialization.
Capturing extension views across reload requires extension-owned immutable values,
not retained SDK byte locations. A source-aware context editor can keep exact raw,
draft and historical checkpoint payloads in its own disposable private snapshot
files while retaining compact prefix/eligibility facts; canonical history remains
exclusively Pi-owned.

Tool contexts retain the SDK-raw projection, not an extension's model view. They
borrow a plan through the complete task and nested-call drain. Explicit messages
access creates an owned array that stays valid after task completion and reload;
finishing releases only the unread borrowed plan. Supervisor-created workers
explicitly select `supervised-source` end events: source handlers receive the plan,
legacy in-process listeners still receive full values, and the worker sends the
same type-only `agent_end` already exposed by supervisor live/history/replay
surfaces. Direct worker RPC retains full `agent_end.messages` by default.

Archive snapshots retain complete detached records, including opaque extension data and superseded compaction fields. Compaction uses this same copier for full-history guards and extension branch snapshots: object and array containers are detached, while immutable strings are shared instead of reallocated. Preparation snapshots retain structured-clone semantics for file-operation Sets. Their limits are 100,000 entries, 2,000,000 aggregate visited values, and depth 64 from the archive-array root. The 64 Mi UTF-16 code-unit string/key budget applies separately to each record, including its array-slot key, and remains enforced through signature overlays. Both the initial archive copy and the isolated SDK-helper copy use this scope. Type, accessor, cycle, ancestry, signature, and selected historical call/result checks still run before context pruning.

The complete returned `{messages, outstanding, diagnostics}` view defaults to an aggregate 64 Mi UTF-16 string/key code-unit budget, with 2,000,000 visited values and depth 64 measured from that view's root, after summary metadata and ordinary-mode result ordering. The [process configuration](DEPENDENCIES.md#persistent-configuration) can select a materialized string budget from 64 Mi through 256 Mi code units. One value is captured before each projection and governs both the initial helper-output copy and the final complete view; archive-record and signature limits do not change. An archive's lifetime strings are not one model context, and these limits are not total-archive or heap-memory bounds. Oversized data is rejected, not truncated, skipped, or repaired.

## Explicit memory diagnostics

Registered operators can request v1 `get_memory_diagnostics({sessionId})`; actors
cannot request another diagnostics scope. This separate path bypasses actor
readiness and session-mutation queues and is never part of status polling. It
returns fixed Node numeric memory/V8 counters and bounded Python output-history
counts/sizes only. There is no GC, heap snapshot, conversation write, namespace
enumeration or diagnostic-driven process start. Unknown peer fields are dropped.

The existing Python FIFO counts queued work as busy before its microtask starts.
An idle diagnostic synchronously reserves that FIFO and control request; a later
tool, snapshot or close drains it. Busy tools, nested host-response waits and
snapshot/drain ownership reject observation immediately rather than enqueueing it.
The collector accepts only exact builtin containers and exact IPython history
owners, deduplicates immutable strings/bytes and containers by identity, and
checks a fixed reference/time budget while walking values without visiting keys.
See [numeric observation limits](OPERATIONS.md#explicit-numeric-memory-observation).

## Session-history retrieval

Actor-authenticated `session_history` list, search, and open requests use the
caller's existing family scope without starting transcript actors. List reads
registry metadata. Search and open share one supervisor-owned history queue;
each caller has an independent 25-second budget, including queue time, and a
28-second client deadline. Disconnect, deadline, and shutdown abort further
history work. Shutdown drains that work before closing the index and store.
Other RPCs keep their existing deadlines and do not join this queue.

`SessionHistoryIndex` is a disposable, contentless FTS5 index of active-branch
user and assistant projections. Schema 3 stores canonical byte spans, entry and
projected-text hashes, and hashed rendering dependencies for input receipts.
It stores no raw transcript, image, tool, or receipt payloads. The directory is
private (`0700`); database, WAL, and shared-memory files are `0600`.

Changed sources verify the cached prefix with a bounded-buffer SHA-256 pass
before parsing complete appended frames. This still reads O(archive bytes), but
avoids reparsing unchanged historical JSON and rewriting unchanged FTS rows.
Replacement, truncation, or a prefix mismatch rebuilds the projection. Partial
lines, branch changes, and receipt-only changes remain part of the verified
version. Ordinary shared-reader observations cannot certify new fingerprints.
The existing reader cache remains session-bounded; complete index projections
retain the eight-session/4 MiB cap.

Cache misses and restarts hydrate only matched entries or open's bounded ordinal
window. Source fingerprints, entry hashes, identity, role, receipt dependency
hashes, and projected-text hashes must agree before a citation is returned.
Receipt association still requires the existing complete canonical inventory;
rendering metadata never establishes input delivery. Aborted or unstable work
cannot publish partial rows. Cancelled requests fail rather than returning an
empty successful search.

## Current-session projection service

Explicit extensions that serialize canonical history can use the synchronous `pi.events` channel `persistent-harness:project-canonical-context:v1`. Emit a mutable request with `entries`, `leafId`, and `mode` (`"native"` or `"ordinary"`). The active actor returns `request.result` containing detached `messages`, `outstanding`, and `diagnostics`, or `request.error` with code `canonical_context_unavailable`. Missing service is not a successful projection.

Requests must match the current canonical branch: either its raw entries or the detached, signature-overlaid entries passed to compaction hooks. Foreign, stale, or altered entries and stopping or closed owners are rejected. The service always uses its own canonical manager and pinned SDK helper. It does not write history, resolve credentials, send requests, or execute tools. Ordinary-mode callers must reject outstanding calls and blocking diagnostics before handing history to a serializer; a known deferred result appears once at its required call boundary.

This is an in-process extension contract, not an additional tool, Pi patch, or permission boundary. Loaded extensions already execute with the actor's privileges.

## Clients

The Unix-socket framing and validation contract is in `src/framing.mjs` and `src/protocol.mjs`. `src/client.mjs` provides `HarnessClient`; terminal commands use the same supervisor requests as other clients.

The protocol retains session creation, subscription, input admission, stop/revive/delete/rename, kernel reload, model selection, compaction, family messages, schedules, background process notifications, canonical history, telemetry, dialogs, and output streams. Client-neutral conversation projections remain in this repository even though no browser client or HTTP adapter is included.

### Conversation order

Each public assistant text part and progress row has a host-owned birth stamp.
`ActorCoordinator` allocates `{version: 1, createdAt, sequence}` from one actor
clock. Text receives its stamp on the first observed non-whitespace public text,
after root presentation filtering, or after a supported terminal hook first
produces visible text. Empty starts, inference start, reasoning, and unobserved
provider partials do not start a text row's clock.

The stamp is embedded as `harnessBirth` in the existing canonical text block or
progress entry's `data`. It survives deltas, prefix commits, rebases, and final
replacement without changing the core text ID. Provider metadata is discarded;
hook omission restores the host stamp and explicit conflicts fail validation.
There is no separate metadata append. Text and stamp become durable together in
the existing message commit; already-streamed text can still be lost before a
successful commit. Existing append/publication failures remain observable.

Public rows expose the stamp as `createdAt` and optional `timelineSequence`,
including slim deltas and cold history pages. Order is timestamp, then sequence.
At an equal millisecond, unstamped legacy rows and input receipts use sequence
zero before stamped actor rows; unstamped ties retain authoritative history and
neighbor order. Input acceptance and delivery timestamps are unchanged. Existing
live IDs retain their first visible ordering metadata; conflicting later stamps
are reported and ignored without discarding text.

Restart and fork seed the allocator from valid stamps on active canonical
ancestry; idle branch navigation resets that boundary. The allocator performs no
I/O. Missing or malformed stamps use the legacy projection. There is no inferred
historical birth, archive rewrite, or new cross-clock synchronization guarantee.

### Input admission

`submit_input` acknowledges a durable receipt after registering supervisor-owned
wake/delivery work. Normal sends do not await actor startup, skill reconciliation,
or worker consumption, and release the session mutation lock at admission. Pending
same-ID retries reuse the receipt and request delivery without repeating admission.
Response Retry still waits for its idle branch operation before admitting input.

The actor scheduler and readiness path retain skill and generation checks. Wake
failures after acceptance publish the session's error state and a correlated
`delivery.retryableError` on each affected pending input. The fixed
`actor_wake_failed` code and actor generation preserve accepted status without
exposing raw worker errors. A successfully registered new wake clears the annotation;
canonical delivery removes it with the pending payload. Same-ID retries retain the
original receipt and immutable content, images, and location. Stop, deletion, and
supervisor shutdown drain or cancel owned wakes before releasing their state. Restart recovers pending inputs
from gracefully passivated sessions; explicitly stopped sessions remain stopped.
Canonical delivery evidence and ambiguous-input replay guards remain authoritative.

Before submitting pending input, the supervisor reconciles its receipt against
complete canonical history, including inactive branches. Proven incorporation
completes the receipt without replay; ambiguous incorporation remains pending.
Actor startup takes an append cursor instead of querying every historical input
receipt again. Subsequent actor appends still use full historical evidence for
identity resolution and the supervisor verifies the exact entry before delivery.
This avoids duplicate startup work without changing compaction, delivery, or
provider-request boundaries.

Pending queue snapshots use one joined read in receipt sequence order. Existence
checks do not load payloads. Clearing wake errors reads only inputs whose stored
error changed; an already-clear queue does not hydrate payloads or rewrite rows.
Repeated nonnull wake errors still publish the complete pending queue. Delivery
resamples the queue after asynchronous transcript reconciliation; no queue snapshot
or canonical incorporation decision is cached across that boundary.

Background completions publish accepted input state when their durable receipt is
created. The monitor owns at most 128 concurrent dispatch promises and continues
its existing bounded discovery scans while an owner starts. Actor readiness waits
outside session mutation, so later same-owner inputs can also persist. A completion
marker is written only after dispatch succeeds; failed startup remains retryable.
Stopping the monitor drains its owned dispatches. Background inputs use the existing steering queue while active and an ordinary
turn while idle. They enter canonical context at the next safe checkpoint rather
than waiting for the whole run. Delivery does not itself abort or replay tools.
Legacy receipt behavior/digests remain immutable while pending background inputs
resolve through the current automatic route; already-injected old queues are not
manipulated.

### User location attachment

`submit_input` accepts optional `location` on a genuine user message. It contains
exactly `latitude` (−90 to 90), `longitude` (−180 to 180), nonnegative `accuracy`
in metres, and a nonnegative integer `timestamp` in Unix milliseconds within the
JavaScript Date range. All numbers must be finite. The client owns permission,
freshness and opt-in; the harness treats the attachment as unverified user context.

Validation copies the record and includes it in the existing queue byte limits,
digest and duplicate-request equality. Absence preserves the previous digest.
The additive nullable queue column is removed with the payload on delivery;
the canonical `role: "user"` message retains the structured attachment. Original
Retry requires message, images and location to be omitted from the request and
resolves all three from its exact canonical source. Internal cron/background input
cannot acquire a location attachment.

At ordinary/native inference and default compaction serialization, a copy-only
renderer appends an ordinary text block to that same user message. Stored user
text remains unchanged; there is no extra submission, role elevation or text marker
parsing. Retained source entries keep their own location through context edits;
omitted/reclassified entries do not transfer it to another input. Explicit extension
history APIs still expose canonical metadata to trusted in-process extensions.

Visible/pending messages, event projections and title inputs omit coordinates.
Context forks and family messages do not gain raw structured location propagation.
Previously shared locations can recur in model replay, original Retry and summaries,
and model output can quote them. Disabling client sharing affects future acquisition,
not the conversation's existing history.

### Session inference controls

`get_session_inference` returns `selection` (`provider`, `model`, `thinkingLevel`,
`fastMode`), `fastModeRootSessionId`, `fastModeSupported`, available models, busy
state, and telemetry. `selection.fastMode` is the effective root preference;
`fastModeSupported` describes only the selected session's model. Public session
metadata exposes the same values as `launch.fastMode`,
`launch.fastModeRootSessionId`, and `launch.fastModeSupported`. Unknown metadata
stays null; a model label does not establish support.

`set_session_inference` accepts a validated model and reasoning selection during
active work. It saves a revisioned `launch.pendingInference` before acknowledging
it. `selection` and the ordinary launch model/thinking fields remain the last
acknowledged active selection while a change is pending; `pending` reports the desired selection and any
application error. Later accepted choices replace pending intent. Choosing the
active selection also queues a revision, so cancellation remains valid during an
older asynchronous apply.

The existing coordinator applies pending intent with public Pi session setters
when no provider flight, tool task, compaction, or service mutation owns the
actor. It checks before another inference and at settlement, without replacing
the actor, clearing input, or recreating Python. Native inference can continue on
the active model while asynchronous tools still run. Already-started requests
retain their model. Selection changes do not alter saved defaults for new sessions.

Generation-bound applied receipts update active launch policy and clear only the
matching pending revision. The public picker and its expected-selection check use
that acknowledged policy even during awaited model observers. Without pending
intent, settings reads retain the existing live worker model/effort behavior.
Explicit picker admission captures that live baseline; merely reading or using
idle service setters does not change their existing persistence behavior. Pending intent
survives reconnect and supervisor restart; normal actor revival starts the last
active policy and queues pending intent before input delivery. Existing uncertain
work is not replayed. Failed application retains visible intent and the current
run; a new choice, a settings read after failure, or actor revival retries it.
Revival still requires the last active launch model to be available. Model-only
writes use the current catalog snapshot; opening settings retains catalog refresh.

`set_session_fast_mode` is an authenticated client-only mutation with
`{sessionId, fastMode, expected}`. Its expected selection must include all four
selection fields. Stale selections are rejected. Existing model/thinking mutations
still accept expectations without `fastMode`.

Fast is a durable root-owned family preference, defaulting to false for a new
root. A retained root's valid launch object with no `fastMode` property also
resolves to false, without a migration or backfill. A malformed launch or a
present nonboolean preference remains unknown. Only the root session can change
it, including when its own model does not support Fast. Child-target writes
return `invalid_request`, including no-ops.
Existing child-local flags remain stored but are not used. Fast does not change
model/reasoning identity; automatic and manual compaction retain their independent
existing provider behavior.

Conversation requests apply Fast only to exact `gpt-6-astra` or `gpt-6.1-sol`
identity with `openai-codex` / `openai-codex-responses` or
`openai` / `openai-responses`. Unsupported descendants keep ordinary inference
while supported descendants use the root preference. Fast requests priority
service, which can use more allowance or incur higher cost; it does not guarantee
latency.

One bounded ancestry resolver follows validated parent edges to the depth-0 root
for controls, session/navigator metadata, and authenticated request preparation.
It never selects a root by `familyId`: independent roots can share that label.
Missing, deleted, cyclic, malformed, or over-64-edge ancestry projects unknown
metadata and blocks preference sampling rather than selecting another root.

The existing authenticated actor queue flush returns one canonical root preference
sample during request preparation. Root changes affect the next request of every
existing, new, retained, or revived descendant, including already resident actors.
Already sampled requests remain immutable. Preference-read failure blocks that
request rather than silently using a cached value. Native requests receive
`options.serviceTier = "priority"`. Pi 0.99.1's
stock `streamSimple` discards that option, so supported Fast stock requests use
public simple-option/reasoning helpers and `ModelRuntime.stream`; ordinary requests
keep `streamSimple`. Provider serialization and cost accounting both receive the
chosen tier. No payload-only hook, provider alias, or Pi patch is involved.

`get_visible_image` reads existing input images and explicit image blocks from root-session `toolResult` messages on the active canonical branch. Tool images are unavailable for child sessions. The reader retains only image availability, rereads hash-checked canonical bytes on demand, and applies the existing PNG/JPEG limits: at most four images, 3 MiB total encoded bytes, bounded dimensions and decoded size, and a 5 MiB tool-result source line. Tool text, details, arguments, reasoning, and filesystem paths are not image sources. Tool results remain absent from visible message history; a frontend can use its existing image URL in an assistant Markdown response.

Input acceptance, canonical delivery, tool execution, result persistence, namespace save, and settlement are distinct events. In particular, `tool_execution_end` is an execution event, not proof of a completed namespace save; use canonical result and checkpoint evidence for their respective boundaries.

## Capability catalog

A skill's `SKILL.md` supplies procedure text. Optional `pyproject.toml` metadata binds its import name, alias, dependencies, entry point, and allowed host requests. The Python bridge loads the selected catalog; it does not require unpublished personal helpers. Children receive scoped grants rather than ambient access to every catalog item.

Authored companion skills can grant exact `extension_tool.<registered-name>` host requests. The kernel checks those existing manifest grants before resolving a name and uses only the originating cell's public `ctx.executeTool`, never a current-session fallback. Requests also pass Pi's callable exposure gate: active direct tools and codemode/deferred tools are callable; inactive direct, model-only, and hidden tools are not. Python orchestration tools are model-only to prevent nested recursion. These routes do not activate tools, discover the registry, create skills, or inject schemas into prompts.

Tool-owned context uses the public selected-branch session projection, which can contain its pending parent. It does not require provider replay readiness to produce that parent's result; the provider-request readiness guard remains unchanged.

The coordinator supplies public tool-owned contexts and dispatches nested calls through public registered-tool wrappers and `runToolCall`, retaining validation, extension hooks, cancellation, updates, and native outcomes. Nested calls have parent-qualified IDs; bounded `nestedCalls` metadata and all nested usage attach to the outer canonical result, not separate transcript messages. The record limits are 256 calls, 8 KiB arguments per call, 32 KiB aggregate arguments, and 500 error characters; omitted metadata marks the record incomplete. Cell replies cannot cross completion or cancellation into a later cell. Python receives the full JSON outcome up to 512 KiB; an unreturnable outcome fails explicitly after execution, without retry. This is a deliberate skill surface, not a sandbox against same-user Python or loaded extension code.

Retained-child context forking copies a read-only selected conversation projection into a new canonical child session. It does not share a Python namespace or replay tools. Normal children and family messages remain separately retained by the supervisor.
