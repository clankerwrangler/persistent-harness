"""Bounded host-backed filesystem operations."""
from _persistent_harness import SkillResult, host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def read(path: str, offset: int = 1, limit: int = 2000) -> SkillResult:
    return SkillResult(host_request("files.read", {"path": path, "offset": offset, "limit": limit}))


def write(path: str, content: str) -> SkillResult:
    return SkillResult(host_request("files.write", {"path": path, "content": content}))


def edit(path: str, old_text: str, new_text: str, replace_all: bool = False) -> SkillResult:
    result = host_request("files.edit", {
        "path": path,
        "oldText": old_text,
        "newText": new_text,
        "replaceAll": replace_all,
    })
    return SkillResult(result, {"text/x-diff": result.get("diff", "")})


def grep(pattern: str, path: str = ".", limit: int = 200) -> SkillResult:
    return SkillResult(host_request("files.grep", {"pattern": pattern, "path": path, "limit": limit}))


def find(path: str = ".", pattern: str = "*", limit: int = 500) -> SkillResult:
    return SkillResult(host_request("files.find", {"path": path, "pattern": pattern, "limit": limit}))


def list(path: str = ".", limit: int = 500) -> SkillResult:
    return SkillResult(host_request("files.list", {"path": path, "limit": limit}))


def attachment(path: str) -> SkillResult:
    result = host_request("files.attachment", {"path": path})
    data = result.pop("data")
    return SkillResult(result, {result["mimeType"]: data})
