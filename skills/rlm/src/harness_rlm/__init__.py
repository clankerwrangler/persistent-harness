"""Retained asynchronous child-agent admission and management."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


async def spawn(
    prompt: str,
    *,
    name: str | None = None,
    model: str | None = None,
    thinking_level: str | None = None,
    fork_context: bool = False,
) -> SkillResult:
    if type(fork_context) is not bool:
        raise TypeError("fork_context must be boolean")
    result = host_request("rlm.spawn", {
        "prompt": prompt,
        "name": name,
        "model": model,
        "thinkingLevel": thinking_level,
        **({"forkContext": True} if fork_context else {}),
    })
    return SkillResult(result, {"application/vnd.persistent-harness.child-admission+json": result})


def find_models(query: str = "", limit: int = 50) -> SkillResult:
    return SkillResult(host_request("rlm.find_models", {"query": query, "limit": limit}))


def list_subagents() -> SkillResult:
    return SkillResult(host_request("rlm.list_subagents", {}))


def stop_subagent(selector: str) -> SkillResult:
    result = host_request("rlm.stop_subagent", {"selector": selector})
    return SkillResult(result, {"application/vnd.persistent-harness.child-lifecycle+json": result})


def revive_subagent(selector: str) -> SkillResult:
    result = host_request("rlm.revive_subagent", {"selector": selector})
    return SkillResult(result, {"application/vnd.persistent-harness.child-lifecycle+json": result})


def delete_subagent(selector: str) -> SkillResult:
    result = host_request("rlm.delete_subagent", {"selector": selector})
    return SkillResult(result, {"application/vnd.persistent-harness.child-lifecycle+json": result})
