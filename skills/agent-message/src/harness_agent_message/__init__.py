"""Durable direct family messaging."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def list_agents() -> SkillResult:
    return SkillResult(host_request("agent_message.list_agents", {}))


def send(target: str, body: str) -> SkillResult:
    result = host_request("agent_message.send", {
        "target": target,
        "body": body,
    })
    return SkillResult(result, {"application/vnd.persistent-harness.message+json": result})


def start_session(name: str, task: str, cwd: str) -> SkillResult:
    """Home only: open a new root session and send it its task as a message from Home."""
    result = host_request("agent_message.start_session", {"name": name, "task": task, "cwd": cwd})
    return SkillResult(result, {"application/vnd.persistent-harness.message+json": result["message"]})


def request_attention(key: str, title: str, body: str, expires_in: int = 86400) -> SkillResult:
    """Root-only durable human request; reading it does not resolve it."""
    return SkillResult(host_request("agent_message.request_attention", {
        "key": key, "title": title, "body": body, "expiresIn": expires_in,
    }))


def resolve_attention(key: str) -> SkillResult:
    """Resolve this root's existing request, without granting any authority."""
    return SkillResult(host_request("agent_message.resolve_attention", {"key": key}))
