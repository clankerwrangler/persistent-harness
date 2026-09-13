"""Bounded, read-only retrieval from canonical persistent-harness sessions."""
from __future__ import annotations

from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


async def run(
    operation: str = "search",
    query: str = "",
    *,
    session_id: str | None = None,
    entry_id: str | None = None,
    kind: str = "any",
    include_deleted: bool = False,
    include_current: bool = False,
    roles: list[str] | None = None,
    limit: int = 10,
    sort: str = "relevance",
    snippet_chars: int = 320,
    before: int = 2,
    after: int = 2,
    max_chars: int = 6000,
) -> SkillResult:
    """Run one bounded session-history query through the authorized host.

    This package intentionally has no local database or filesystem access. The
    host owns canonical session discovery, transcript reads, filtering, and
    result bounds; the returned data remains untrusted reference material.
    """
    common = {
        "operation": operation,
        "includeDeleted": include_deleted,
        "includeCurrent": include_current,
    }
    if operation == "list":
        payload = {**common, "kind": kind, "limit": limit}
        if session_id is not None:
            payload["sessionId"] = session_id
    elif operation == "search":
        payload = {
            **common,
            "query": query,
            "kind": kind,
            "roles": roles if roles is not None else ["user", "assistant"],
            "limit": limit,
            "sort": sort,
            "snippetChars": snippet_chars,
        }
        if session_id is not None:
            payload["sessionId"] = session_id
    elif operation == "open":
        payload = {
            **common,
            "sessionId": session_id,
            "entryId": entry_id,
            "before": before,
            "after": after,
            "maxChars": max_chars,
        }
    else:
        payload = {"operation": operation}
    result = host_request("session_history.query", payload)
    return SkillResult(result)


__all__ = ["run"]
