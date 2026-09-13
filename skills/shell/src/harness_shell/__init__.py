"""Bounded host-backed shell execution."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def run(command: str, cwd: str | None = None, timeout: float = 120) -> SkillResult:
    return SkillResult(host_request("shell.run", {"command": command, "cwd": cwd, "timeout": timeout}))
