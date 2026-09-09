"""Durable scheduled jobs in the persistent harness."""
from __future__ import annotations

from typing import Any

from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None
_UNSET = object()


async def run(
    action: str = "list",
    *,
    selector: str | None = None,
    name: str | None = None,
    prompt: str | None = None,
    schedule: dict[str, Any] | None = None,
    execution_mode: str | None = None,
    provider: str | None | object = _UNSET,
    model: str | None | object = _UNSET,
    thinking_level: str | None | object = _UNSET,
    repeat: int | None | object = _UNSET,
    include_removed: bool = False,
    limit: int = 20,
) -> SkillResult:
    """Perform one bounded scheduler operation through the canonical host."""
    payload: dict[str, Any] = {"action": action}
    if action == "list":
        payload["includeRemoved"] = include_removed
    elif action == "create":
        payload.update({
            "name": name,
            "prompt": prompt,
            "schedule": schedule,
            "executionMode": execution_mode or "fresh",
        })
        payload["repeat"] = None if repeat is _UNSET else repeat
        if provider is not _UNSET:
            payload["provider"] = provider
        if model is not _UNSET:
            payload["model"] = model
        if thinking_level is not _UNSET:
            payload["thinkingLevel"] = thinking_level
    elif action == "update":
        payload["selector"] = selector
        if name is not None:
            payload["name"] = name
        if prompt is not None:
            payload["prompt"] = prompt
        if schedule is not None:
            payload["schedule"] = schedule
        if execution_mode is not None:
            payload["executionMode"] = execution_mode
        if repeat is not _UNSET:
            payload["repeat"] = repeat
        if provider is not _UNSET:
            payload["provider"] = provider
        if model is not _UNSET:
            payload["model"] = model
        if thinking_level is not _UNSET:
            payload["thinkingLevel"] = thinking_level
    else:
        payload["selector"] = selector
        if action == "history":
            payload["limit"] = limit
    return SkillResult(host_request("cron.manage", payload))


__all__ = ["run"]
