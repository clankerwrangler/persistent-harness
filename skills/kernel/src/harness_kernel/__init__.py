"""Session-local persistent IPython kernel lifecycle."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def status() -> SkillResult:
    return SkillResult(host_request("kernel.status", {}))


def restart() -> SkillResult:
    return SkillResult(host_request("kernel.restart", {}))
