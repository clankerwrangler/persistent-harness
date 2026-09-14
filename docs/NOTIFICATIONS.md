# Durable attention and notifications

The supervisor owns notification state in the canonical SQLite database, independently
of conversation subscriptions. A client can read the feed and deliver push notifications
with no conversation SSE clients. SSE remains presentation, not a trigger to scrape the
latest assistant message.

## Event sources

- **Human attention:** the current depth-zero root actor calls
  `agent_message.request_attention(key, title, body, expires_in=86400)` and later
  `agent_message.resolve_attention(key)`. Children route genuine human needs through
  their parent; notifications do not expand family reach or confer authority.
- **Interactive requests:** existing select/confirm/input/editor dialogs get durable
  root attention presentations. Only the current generation-bound, unexpired dialog
  can accept a response. A durable entry never recreates an expired approval. Passive
  subscription snapshots include current pending dialogs, even on repeated subscriptions.
- **Family idle:** an observed activity episode ends after three seconds with no live
  inference, tools, compaction, starting handoff, or working nondeleted descendant.
  Retained idle/inactive descendants do not block. Queued input is not a permanent veto:
  stable premature idle is worth reporting, not proof of successful completion. Detached
  background processes do not extend the episode; the event mentions still-running jobs.
- **Cron:** each claimed run snapshots explicit `result`, `conditional`, or `silent`
  intent separately from execution status. Conditional runs must report `deliver` or
  `no_finding` for that exact run. Missing disposition means evaluation failure, not a
  negative finding. Result runs use explicit reported text or output bound to their exact
  input, stopping at the next unrelated input. Failure to produce a promised result is
  visible. Transcript-based completion waits for stable recursive family idle, not an
  interim parent settlement while descendants work. An explicit exact-run disposition
  declares readiness immediately, even while unrelated family work continues.
  Notification retry never reruns execution.

Routine assistant messages and progress are quiet. A pending attention request in the
same episode suppresses its related idle notice. Cron-only episodes do not produce a
second generic idle notification or bypass conditional/silent intent. User input admitted
into an origin-cron episode preserves the separate user-work idle criterion. Older cron
calls/jobs with omitted intent remain unclassified; there is no historical backfill.
New classified inputs include their exact run ID, intent and reporting procedure; stored
job prompts and historical input envelopes are unchanged.

Background and queued family-message continuations keep causal notification ownership:
immutable job/message identity and creation time bind to durable ownership checkpoints.
A user-launched job still produces user-work idle after an intervening quiet cron; a
cron-launched job cannot turn a silent/no-finding outcome into a generic idle alert.
Bindings and checkpoint history survive retries/restarts and are not pruned while old
origins may still return. Timestamp order is conservative: use the latest strictly
preceding checkpoint; conflicting checkpoints in the launch millisecond, missing times,
and prehistory bind `unknown`. Once time is strictly later, checkpoint sequence breaks
ties. Unknown origins do not invent user work; actual new user admission overrides them.
This attribution affects notification selection only, never actor/approval authority.

## Identity, lifecycle and bounds

A stable source key determines each notification ID. Activity episodes have persisted
identities; reconnects do not replay settled events. Explicit request keys are scoped to
one root. Reusing a key returns the original request without reopening it or extending
its deadline. Use a new key for a genuinely new request.

Titles are bounded to 120 characters, bodies to 1000, and explicit keys to 128 plain
letters/digits/`._:-`. Explicit expiry is 1–604800 seconds. Idle alerts expire after five
minutes; cron alerts expire 24 hours after run completion; interactive deadlines retain
the existing maximum ten minutes. These bounds concern alert freshness, not permission.

State is `pending`, `resolved`, `cancelled`, `expired`, or `superseded`. `readAt` is
independent: reading suppresses further delivery but cannot resolve or approve an action.
Expired and resolved entries remain inspectable. Starting another activity episode
supersedes old idle status rather than sending stale content from a previous turn.

## Client protocol

The existing authenticated client connection advertises `limits.notificationVersion=1`.

| Request | Parameters / result |
| --- | --- |
| `list_notifications` | optional `limit` (1–100), `before` sequence, `view` (`all`, `inbox`, `history`; default `all`); returns notifications, `nextBefore`, global unread count |
| `get_notification` | `id`; returns notification and secret-free delivery receipts |
| `read_notification` | `id`; acknowledges reading, not resolution |
| `claim_notification_delivery` | `endpointIds`, at most eight SHA256 identities; returns bounded leased claims |
| `record_notification_delivery` | `id`, `endpointId`, `leaseId`, status |

The inbox contains pending unread informational events and pending `attention` requests,
including those already read. History is its complement: read information and all
resolved, cancelled, superseded, or expired records. Expiry reconciliation precedes
selection, and selection precedes sequence ordering and the page limit. Nothing is
deleted. The global unread count is independent of the view and page. Reset `before`
when changing views; use the returned `nextBefore` only for that selected view.

Actor-only requests are `request_attention` (`key`, `title`, `body`, optional `expiresIn`)
and `resolve_attention` (`key`). The supervisor derives root ownership and checks live
actor generation. Neither accepts a recipient or request-provided authority.

Clients must render text safely and derive links from the event's own `sessionId` and
`id`, not arbitrary assistant text or an untrusted destination URL. An interactive UI
should refresh the existing passive subscription snapshot on notification/open even if
already attached or already displaying the target conversation, reconcile removed dialogs,
and preserve response/expiry fencing. Another subscriber's response is authoritatively
fenced immediately; a consumer reconciles its cached presentation on refresh/expiry.

## Delivery and offline limits

Endpoint secrets stay in the delivery consumer, not in the supervisor. The store retains
only hashed endpoint identity, bounded attempt count, lease, due time and outcome. Up to
eight claims are leased at once for 60 seconds. A crashed lease can be reclaimed; an old
lease cannot overwrite its successor. Attempts stop after five. Retry delays are 5, 30,
120 and 300 seconds before the fifth attempt; terminal records are not silently retried.

`accepted` means the push provider accepted the request, **not** that a device displayed
it or a human read it. Transient provider/network errors retry the durable event.
Permanent failures remain inspectable. Provider acceptance and worker display cannot be
one distributed exactly-once transaction: consumers need stable event tags and persisted
seen identities. A crash between sending and recording acceptance can retry the same ID.

A closed-browser consumer needs an installed/registered service worker, permission,
working platform push transport and a fresh payload. Private-network availability affects
current-state checks, feed access and navigation. A fresh event can arrive while its
private API is offline; it may not yet know another device read/resolved it. Offline
reading/retraction is not instantaneous. Previously displayed OS banners cannot be
reliably retracted or expired while the worker is asleep. Reconcile on the next wake.

## Storage and recovery

`notification_meta` independently versions the additive notification tables. Cron intent
columns use `cron_meta.notification_schema_version`; existing cron execution format and
core `PRAGMA user_version=2` remain unchanged. Unknown notification format versions fail
closed. Do not weaken core format guards to make rollback pass.

A recovery proof must open the successor-written database with the **actual recovery
reader's writable constructor**, then reopen with the successor and verify notification,
cron and input receipts survive. A read-only constructor is not migration compatibility
proof. Never restore an old database/history snapshot after successor writes. Older
source can temporarily lack the new delivery features while preserving additive state.

## Verification

`NotificationLifecycle.tla` models recursive family activity, stable quiet time, queued
handoffs, attention coalescing and user/cron provenance. `NotificationDelivery.tla` models
intent/disposition, separate execution and retry, provider acceptance, offline device
state and freshness. Configurations cover result, conditional and silent runs.

Focused tests: `notification-store`, `notification-supervisor`, `notification-cron`, and
`notification-compatibility`. The compatibility test takes explicit
`PI_NOTIFICATION_BASELINE_SOURCE` and `PI_NOTIFICATION_COLD_COPY`; it mutates only its
own temporary copy. Consumer tests must cover zero-SSE delivery, truthful receipts,
stale payload rejection, restart dedupe, read vs resolved, and exact deep links.
