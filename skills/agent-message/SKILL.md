---
name: agent-message
description: Inspect the permitted family roster and send durable direct parent, child, or sibling messages.
---

# Agent Message

Import with `import harness_agent_message as agent_message` (the kernel also preloads `agent_message`).

Use `agent_message.list_agents()` to inspect reachable agents. Reach is strictly local: an agent may address only its parent, direct children, and same-parent siblings. Grandparents, grandchildren, cousins, and other transitive relationships are rejected even when an exact stable ID is supplied.

Use `agent_message.send(target, body, delivery_mode="auto")` for direct delivery. `delivery_mode="follow_up"` waits behind current work. The operation commits synchronously and returns an awaitable `SkillResult`, so both `agent_message.send(...)` and `await agent_message.send(...)` are safe and perform exactly one host call. There is no broadcast operation, and sender identity always comes from the harness connection.

Messages never produce an automatic reply. Send only an intentional, useful result or request; do not echo acknowledgements or respond solely because another agent sent a message.
