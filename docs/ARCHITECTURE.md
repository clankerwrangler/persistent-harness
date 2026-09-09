# Architecture and protocol

## Owners

- `HarnessSupervisor` owns admission, actor generations, durable queues, family scope, schedules, process completion, and local client routing.
- Each `sdk-worker` has one active extension runtime and one quiescent SDK service runtime sharing the same literal Pi `SessionManager`. The coordinator is the sole inference and tool-execution owner. It does not run a competing stock agent loop.
- `ActorCoordinator` owns request snapshots, steering/follow-up queues, calls, results, cancellation, usage events, and service leases for compaction and navigation.
- `PythonKernel` owns the real interpreter, FIFO execution, and namespace checkpoint tail. A result can be delivered before its background save completes; the next Python operation and graceful shutdown still drain that tail.
- Pi owns canonical JSONL session identities and public SDK data formats. The harness appends standard messages and versioned metadata through the one manager.

These are same-user local processes, not a multi-tenant security boundary. The Python and shell capabilities execute with the service account's privileges.

## Canonical history

A complete, provider-confirmed native tool prefix is committed before an effect starts. Original call IDs bind results. Partial or unconfirmed calls are not native admission proof. After process loss, recovery records a truthful interrupted/unknown outcome instead of replaying an uncheckpointed operation.

Late reasoning-signature metadata amends a selected prior assistant entry without rewriting its bytes. Read-only context projection applies selected-branch amendments and places a known deferred native result exactly once where stock provider serialization requires it. It does not invent successful or missing-tool output. Effective compaction uses a valid selected `firstKeptEntryId`; unused extra fields and superseded checkpoints do not create new materialized history.

Compaction and navigation use one owner lease, active extension hooks, public SDK helpers, drained provider streams, and one canonical writer. Default compaction and public extension hooks receive current namespace diagnostics; unresolved real tool results remain a compaction boundary.

## Clients

The Unix-socket framing and validation contract is in `src/framing.mjs` and `src/protocol.mjs`. `src/client.mjs` provides `HarnessClient`; terminal commands use the same supervisor requests as other clients.

The protocol retains session creation, subscription, input admission, stop/revive/delete/rename, kernel reload, model selection, compaction, family messages, schedules, background process notifications, canonical history, telemetry, dialogs, and output streams. Client-neutral conversation projections remain in this repository even though no browser client or HTTP adapter is included.

Input acceptance, canonical delivery, tool execution, result persistence, namespace save, and settlement are distinct events. In particular, `tool_execution_end` is an execution event, not proof of a completed namespace save; use canonical result and checkpoint evidence for their respective boundaries.

## Capability catalog

A skill's `SKILL.md` supplies procedure text. Optional `pyproject.toml` metadata binds its import name, alias, dependencies, entry point, and allowed host requests. The Python bridge loads the selected catalog; it does not require unpublished personal helpers. Children receive scoped grants rather than ambient access to every catalog item.

Retained-child context forking copies a read-only selected conversation projection into a new canonical child session. It does not share a Python namespace or replay tools. Normal children and family messages remain separately retained by the supervisor.
