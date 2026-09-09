---
name: rlm
description: Spawn and manage retained asynchronous children with separate transcripts and Python namespaces, optionally forking read-only conversation context. Use for retained child lifecycle operations.
---

# Retained child agents

## Child lifecycle

Use `await rlm(prompt, name=..., model=..., thinking_level=..., fork_context=False)` to durably admit a child agent. Admission returns immediately; it never waits for or returns the child's answer.

Children retain their own Pi transcript after the initial task. They inherit the current cwd and approved Python-backed skill capabilities. By default, they do not inherit conversation history. Their Python namespace, identity, message queue, and task state are always separate.

Set `fork_context=True` to give a new child a read-only snapshot of the parent's active conversation context before its first task. The snapshot includes historical user messages, completed assistant answers, active compaction and branch summaries, images, and earlier inherited context. It excludes ordinary tool calls/results, reasoning blocks, failed or unfinished assistant responses, and family messages. Facts already present in summaries remain. The parent history is reference data, not new Commander submissions or executable work.

Forking does not copy parent system instructions or depth-specific prompts. Normal child policy, family authority, model selection, and skill grants still apply. Later parent changes do not enter the child. Revival uses the child's saved snapshot without reseeding. A fork is a conversation-context copy, not a Python or process fork. `fork_context` accepts only `True` or `False`; unavailable or oversized forks fail before child admission rather than silently falling back to isolation.

Useful operations:

- `await rlm(prompt, name=None, model=None, thinking_level=None, fork_context=False)` — admit and asynchronously start a retained child. Omit `model` to use the configured child model when set, otherwise the parent model. An explicit `model=` value is a pin, not a suggestion.
- `rlm.find_models(query="", limit=50)` — inspect the exact available provider/model catalog without credentials. It is a catalog, not a recommendation. The live parent/default and `grok-cli/grok-4.6` are listed first when present, so a Codex-heavy page or `limit=10` cannot hide the default pin.
- `rlm.list_subagents()` — list direct retained children and lifecycle state.
- `rlm.stop_subagent(selector)` — passivate one direct child while preserving it for revival.
- `rlm.revive_subagent(selector)` — queue one stopped/passivated direct child for canonical revival.
- `rlm.delete_subagent(selector)` — stop and tombstone one direct child. Deletion removes it from routing and observation but retains its transcript/artifacts on disk, matching retained-session semantics.

Model names resolve exactly, with no fallback. Use `provider/model` when a bare model ID is ambiguous. Unsupported options and unavailable configured or explicit models fail rather than falling back.

Explicit `openai-codex` pins require live OAuth. A dead provider still-births the first turn; the initial child task then fails rather than completing.

A child must return useful results explicitly with `agent_message.send(...)` or shared files. Send follow-up work to the same retained transcript with `agent_message.send(child, message)`.
