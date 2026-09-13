---
name: agent-message
description: Inspect the permitted family roster, send durable direct family messages, or create and resolve root-owned human attention requests.
---

# Agent Message

Import with `import harness_agent_message as agent_message` (the kernel also preloads `agent_message`).

Use `agent_message.list_agents()` to inspect reachable agents. Reach is strictly local: an agent may address only its parent, direct children, and same-parent siblings. Grandparents, grandchildren, cousins, and other transitive relationships are rejected even when an exact stable ID is supplied.

Use `agent_message.send(target, body, delivery_mode="auto")` for direct delivery. `delivery_mode="follow_up"` waits behind current work. The operation commits synchronously and returns an awaitable `SkillResult`, so both `agent_message.send(...)` and `await agent_message.send(...)` are safe and perform exactly one host call. There is no broadcast operation, and sender identity always comes from the harness connection.

Messages never produce an automatic reply. Send only an intentional, useful result or request; do not echo acknowledgements or respond solely because another agent sent a message.

## Human attention (root only)

When the human must supply a decision, approval, or missing information, the root can use
`agent_message.request_attention(key, title, body, expires_in=86400)` alongside its normal
conversation explanation. Use explicit, concise plain text (title ≤120 characters,
body ≤1000) and a stable key (≤128 letters, digits, `.`, `_`, `:`, `-`). The expiry is
1–604800 seconds. Children send the need to their parent; they cannot address the human
through this API, and ordinary family messaging rules are unchanged.

Reuse the same key when retrying the same request. Creation is durable and idempotent:
retries do not reopen resolved/expired requests or extend deadlines. A genuinely new
request needs a new key. Call `agent_message.resolve_attention(key)` when that specific
need no longer requires human action. Read acknowledgement is not resolution; expiry
means expired, not approved or completed. Notifications never grant permission, and
creating one does not substitute for an interactive approval's live response mechanism.

Routine progress and every-message alerts do not belong here. Family-idle status and
explicitly intended cron deliveries are tracked separately by the supervisor.
