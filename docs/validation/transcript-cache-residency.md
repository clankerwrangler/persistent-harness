# Supervisor transcript cache verification

Verified on 2026-10-26 against base `09d8c883a1bf98291860a14009c9c36525d9eb35`.

## Ownership and behavior

`HarnessSupervisor` constructs one `VisibleTranscriptReader` and shares it with
`SessionHistoryIndex`. The old reader retained projected text, assistant parts,
and source objects for up to 64 sessions without an aggregate byte bound.
Operation-scoped receipt verification did not bound that retained graph.

The reader now uses the same owner with automatic 64 MiB accounted LRU admission
and the existing 64-session ceiling. Entry tuples retain branch/source facts,
block-packed SHA-256 digests, render metadata, and text fields of at most 256
UTF-16 units. Longer fields retain exact escaped-byte/nonempty facts, not their
payloads. Ordinary traversal and ordering use compact descriptors. Only selected
rows expand and hydrate their canonical spans. Explicit full-index, family,
title, image, retry, and branch operations preserve complete requested results.
Their materialized values belong to the operation, not the cache.

Entry charges are incremental: strings use `32 + 2 * length`, arrays use
`64 + 16 * slots` plus their values, objects include keys/edges/values, and each
entry has a 64-byte Map charge. Admission also charges the small record envelope,
digest blocks, full pending Buffer backing allocations, and 1,024 bytes for a
known SHA-256 owner. Unsupported, deep, or oversized graphs bypass admission.
The estimator is logical accounted ownership, not a precise V8 allocation or
process-memory cap. Active operations and explicit full results can exceed it.

Reads detach cache ownership before work and admit only successful, eligible
snapshots. Append copies the small mutable envelope, entry Map, and last digest
block; immutable entry tuples remain shared. Eviction drops only cache ownership.
Clear fences late admission without cancelling a leased operation. Branch/image/
retry use their operation snapshot even when no record was admitted. Canonical
digests, identity, fingerprint, cursor, receipt, and owner-watermark fences remain.
Canonical JSONL, SQLite index contents, grants, and settings are unchanged.

## Checked models

Java 21 ran TLC 2.19 from `/opt/tla/tla2tools-1.7.4.jar`, one worker,
`-Xmx256m`, before the corresponding implementation:

| Model | Generated | Distinct | Depth | Result |
| --- | ---: | ---: | ---: | --- |
| `TranscriptCacheResidency` | 4,134,046 | 723,451 | 22 | No error |
| `TranscriptPayloadHydration` | 67,720 | 22,426 | 12 | No error |

All five residency faults and seven hydration faults exit 12 with their intended
invariant violation. The hydration model abstracts views and selected row sets;
it does not prove concrete JavaScript Unicode, ordering, filesystem atomicity,
or SHA-256 collision resistance.

From `specification/`, run each positive configuration with:

```sh
java -Xmx256m -cp /opt/tla/tla2tools-1.7.4.jar tlc2.TLC \
  -workers 1 -metadir /tmp/transcript-cache-tlc \
  -config TranscriptCacheResidency.cfg TranscriptCacheResidency.tla
java -Xmx256m -cp /opt/tla/tla2tools-1.7.4.jar tlc2.TLC \
  -workers 1 -metadir /tmp/transcript-hydration-tlc \
  -config TranscriptPayloadHydration.cfg TranscriptPayloadHydration.tla
```

Matching fault configurations use the same module and their own `.cfg` name and
fresh metadata directory. They must report an invariant violation, not a pass.

## Focused integration

Nine files pass **115 tests, zero failures, zero skips** with private `HOME` and
`PI_CODING_AGENT_DIR`, normal `/tmp`, presentation namespace `harness`, the
unchanged official 0.99.1 public SDK, offline prerequisites, and the existing
256 MiB test CLI heap cap:

```sh
node --max-old-space-size=256 --test --test-concurrency=1 \
  test/visible-transcript-reader.test.mjs test/visible-transcript-cache.test.mjs \
  test/session-history-index.test.mjs test/session-history-supervisor.test.mjs \
  test/owned-append-history.test.mjs test/visible-image-supervisor.test.mjs \
  test/receipt-reader-supervisor.test.mjs \
  test/supervisor-input-association.test.mjs test/supervisor-text-identity.test.mjs
```

Distinct new controls cover aggregate LRU/session limits, oversized bypass,
pending backing stores, disabled-admission branch/image/retry, clear fences,
independent cancellation, hydration leases, selected-span rewrite rejection, and
exact differential rendering/cursors across inline lengths 255/256/257, escaped
controls, lone surrogates, astral text, sanitization, multiple parts, and births.
The real shared supervisor API checks UI messages, indexed citations, full open,
and refresh with default admission and with forced test-only bypass, without
starting transcript actors. Existing gates retain receipt/family/title/image,
source replacement, branch/owner watermark, cancellation, and index recovery.

## Synthetic measurements

Private fixtures contain public synthetic messages only. Each run is a separate
Node process with the existing 256 MiB test cap; no explicit GC, inspector, or
live cache observation is used. Counters measure canonical FileHandle bytes and
actual `JSON.parse` calls. Pages request 32 messages / 24 KiB, with page-scoped
input proofs. Owned appends use valid source watermarks.

| 70,000 initial entries | Baseline | Compact final |
| --- | ---: | ---: |
| All visible: independent graph estimate | 199,249,920 B | 52,186,178 B |
| All visible: cold read | 1,348 ms | 1,585 ms |
| All visible: three warm pages | 92–110 ms | 42–71 ms |
| All visible: three owned appends | 126–143 ms | 50–99 ms |
| 20% visible / 80% tool: graph estimate | 112,508,008 B | 31,930,868 B |
| Mixed: cold read | 1,149 ms | 1,112 ms |
| Mixed: three warm pages | 44–128 ms | 32–37 ms |
| Mixed: three owned appends | 76–92 ms | 44–65 ms |

Both versions read/parse the complete cold fixture. Warm pages read **0 bytes**
and parse **0 entries**. Each owned append reads only its 257–263-byte suffix and
parses one entry. The compact cache remains admitted under 64 MiB; it does not
reread the whole file or serialize/deserialize a whole graph on ordinary pages.
Long selected fields hydrate their requested spans instead of retaining payloads.

Additional axes:

- Twelve sessions × eight 65,536-unit texts: graph estimate **19,148,328 →
  495,240 bytes**. The compact owner retains no large text payload.
- Four sessions × 15,000 short entries: **168,915,816 → 43,565,608 bytes**.
- Twelve sessions × 15,000 short entries: default admission stabilizes at six
  sessions / 90,000 entries. Internal accounted bytes end at **65,347,868**,
  below **67,108,864**; the independent graph estimate is 65,348,388 bytes.
  Sessions seven through twelve evict old owners rather than grow the cache.

Natural RSS for final hot visible/mixed runs is 175–220 / 148–195 MB. Under the
12-session pressure run, natural RSS grows to 281 MB at the last sample and
297 MB after the independent estimator's temporary work. Clear removes cache
ownership but leaves that immediate RSS unchanged. These observations include
live temporary allocations, allocator/GC high water, and runtime pools. They are
not exact cache allocation, universal live savings, or an OOM guarantee. The
visible cold-read increase is an accepted one-time compact-index construction
tradeoff. Full requested archive materialization remains an operation cost.

Small reproduction scripts, exact JSON samples, model logs, and private test
receipts are retained at
`/workspace/handoffs/supervisor-transcript-cache-20261026/`.


## Session-open projection scope

The session-open correction follows the cache change at `6b144a24`. Compact
payload retention exposed an unbounded operation: every page hydrated every
historical incoming family body to populate `familyMessages`, although UI
reconciliation consumes only delivery state. Long histories could spend seconds
reading those spans on every open and could exhaust the 256 MiB fixture heap.

`get_visible_messages` now requests internal delivery-only family evidence from
active-branch compact metadata. Its bounded page still hydrates selected payloads.
The existing `familyMessageId` admission read physically validates matching source
entries and returns only that family's complete canonical row, reusing the verified
payload when hydration needs it. Default reads without an ID retain complete
family bodies. Internal title, input delivery, index, branch, image, and retry
consumers that discard the family map also request delivery-only evidence. This
option is not exposed through the protocol or settings.

Incoming context metadata derives `entryId` from its canonical source ID and
`delivery.deliveredAt` from its render time instead of retaining duplicate strings.
Expanded rows are structurally equal to the original projection. The 64 MiB
aggregate admission bound and every source, receipt, cursor, and watermark guard
remain unchanged. Out-of-page metadata evidence is for rendering; selected spans
and explicit admission keep physical verification.

Before implementation, `SessionOpenProjection` checked delivery-only, full, and
single-family requests, compact-field reconstruction, page hydration scope,
source/cursor fences, and cache ownership. TLC generated **251 states**, found
**187 distinct states**, and reached depth **7**, with no error. Eight fault
controls fail their intended invariants with exit 12. This scoped model abstracts
payloads and filesystem operations; the existing cache/hydration models remain.

The focused gate passes **116 tests**, zero failures or skips, across the same
nine files listed in [Focused integration](#focused-integration). The new
ownership regression fails on `6b144a24` with **1,010,422 historical bytes** read
for an assistant-only warm page; the correction reads **0 bytes**. It also checks
complete default output, selected older-page hydration, single-family physical
scope, rewritten-span rejection, and in-flight isolation between result scopes.
The supervisor check requires delivery-only UI reads.

### Actual open-call measurements

`test/benchmarks/session-open.mjs` drives real `HarnessClient` requests through an
isolated supervisor, without starting actors. It performs an initial read, a
passive subscription and second read, then the reopened pair. Its 360,000 ms
client deadline matches the existing WebUI launcher; no runtime deadline changes.
Each comparison uses separate processes with a 256 MiB fixture heap and synthetic
public data. Both fixtures have **70,050 entries / 14,010 incoming family rows**,
long ordinary/family text, and hidden tool results. The larger fixture includes
210-character peer labels and 23,500-unit tool payloads.

| Fixture | `09d8c883` | Corrected |
| --- | ---: | ---: |
| 157,153,705 B: initial RPC | 7,544 ms | 3,534 ms |
| Same: second/reopened RPCs | 147–157 ms | 123–197 ms |
| Same: warm canonical reads | 0 B / 0 entries | 83,799 B / 9 entries |
| Same: admitted accounted bytes | Unbounded legacy owner | 59,632,976 B |
| 809,484,949 B: initial RPC | 7,780 ms | 6,195 ms |
| Same: second/reopened RPCs | 203–218 ms | 96–146 ms |
| Same: warm canonical reads | 0 B / 0 entries | 76,048 B / 8 entries |
| Same: admitted accounted bytes | Unbounded legacy owner | 65,096,876 B |

Unmodified `6b144a24` exhausts the 256 MiB fixture heap on the smaller long-family
fixture. Corrected warm reads hydrate only selected spans, not the complete
history. Both fixtures remain admitted below 67,108,864 accounted bytes. Natural
corrected RSS samples span 181–265 MB, including transient work; no explicit GC
or live process collection is used. Cold file scanning remains proportional to
canonical source bytes. Timing samples are not universal latency guarantees.

Complete public pages are independently `deepStrictEqual` across the baseline
and correction. Stable recursive-key digests match for every initial, subscribed,
and reopened result. Raw JSON property insertion order differs after metadata
reconstruction; row order, text, delivery fields, and pagination are unchanged.

To run the benchmark against a source checkout, use private fixture directories:

```sh
PRIVATE=$(mktemp -d)
mkdir "$PRIVATE/home" "$PRIVATE/agent"
HOME="$PRIVATE/home" PI_CODING_AGENT_DIR="$PRIVATE/agent" \
  PI_HARNESS_PRESENTATION_NAMESPACE=harness \
  node --max-old-space-size=256 test/benchmarks/session-open.mjs \
  "$PWD" family-long "$PRIVATE/public-page.json"
rm -rf "$PRIVATE"
```

Use `family-representative` for the larger tool/label axis. Model logs, complete
public-page comparisons, benchmark samples, and test receipts are retained at
`/workspace/handoffs/session-open-latency-20261026/source/`. No production source,
settings, limits, service, or activation changes are part of this correction.

## Activation boundary

The observed live cache owner is the main supervisor Node isolate (PID 7,
start ticks 213495134), not a separately restartable history worker. A changed
checkout does not replace its already imported module. Supported activation
requires a supervisor restart, which drains actors and Python kernels and uses
normal startup reconciliation. Arbitrary opaque actor state cannot silently
survive that boundary. No activation, process restart, settings change, history
materialization, or live collection was performed for this correction.
