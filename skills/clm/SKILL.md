---
name: clm
description: Create, list, resolve, and recall branch-local context annotations through the optional live-context extension.
---

# Context annotations

Use `clm.annotate` and `clm.recall` from Python. This optional companion requires
the corresponding extension tools to be loaded and callable. It neither loads
nor activates the extension. Its two exact host grants do not expose other tools.

```python
outcome = clm.annotate("create", source="SOURCE_ID", title="Follow-up",
                       reason="Keep the requirement available",
                       future_action="Check before implementation",
                       retention="continuity")
clm.annotate("list")
clm.recall("ANNOTATION_ID", max_tokens=512)
clm.annotate("resolve", id="ANNOTATION_ID", resolution="Completed")
```

`source` is a current mirror block ID or an active branch entry ID. Retention is
`pin` (bounded exact text remains visible), `continuity` (visible obligation and
recall pointer), or `archive` (recall only). Listing returns annotations, not a
tool registry. Recall validates its source against the durable entry.

Each operation returns the native `{toolCall, result, isError}` outcome in a
`SkillResult`. Check `outcome["isError"]`; successful Python execution alone does
not mean the nested tool succeeded. The result contains `content`, `details`, and
any `structuredContent` or `usage` retained after extension hooks. Partial text
updates use ordinary Python output capture. Cancellation follows the current
cell. No session or parent-call identity can be supplied by the skill.

Outcomes larger than 512 KiB or not JSON-serializable raise an explicit transport
error after execution. Side effects may already have occurred; do not retry
such a call automatically. This skill has no general tool invocation or discovery
operation and does not inject other tool names or schemas into the prompt.
