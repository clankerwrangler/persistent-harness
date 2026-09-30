"""Explicit annotation and recall operations for the optional live-context extension."""
from _persistent_harness import SkillResult as _SkillResult, host_request as _host_request

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None


def annotate(action, *, source=None, title=None, reason=None, future_action=None,
             retention=None, id=None, resolution=None) -> _SkillResult:
    """Create, list, or resolve branch-local annotations; return the native outcome."""
    arguments = {"action": action, "source": source, "title": title, "reason": reason,
                 "futureAction": future_action, "retention": retention, "id": id,
                 "resolution": resolution}
    return _SkillResult(_host_request("extension_tool.live_context_annotate",
                                   {key: value for key, value in arguments.items() if value is not None}))


def recall(id, *, max_tokens=None) -> _SkillResult:
    """Recall an annotation's bounded exact textual source; return the native outcome."""
    arguments = {"id": id}
    if max_tokens is not None:
        arguments["maxTokens"] = max_tokens
    return _SkillResult(_host_request("extension_tool.live_context_recall", arguments))
