"""Bounded read-only harness operations and diagnostics."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def status() -> SkillResult:
    return SkillResult(host_request("operations.status", {}))


def diagnose() -> SkillResult:
    return SkillResult(host_request("operations.diagnose", {}))


def usage(window_minutes: int = 60) -> SkillResult:
    return SkillResult(host_request("operations.usage", {"windowMinutes": window_minutes}))


def events(limit: int = 100) -> SkillResult:
    return SkillResult(host_request("operations.events", {"limit": limit}))
