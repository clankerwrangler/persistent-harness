"""Runtime support for persistent-harness skills."""
from __future__ import annotations

import importlib
import json
import os
import sys
import threading
import uuid
from collections.abc import Mapping
from typing import Any

_control = None
_control_lock = threading.Lock()


def configure_control(control) -> None:
    global _control
    _control = control


def _send(frame: dict[str, Any]) -> None:
    if _control is None:
        raise RuntimeError("persistent harness control channel is unavailable")
    payload = (json.dumps(frame, separators=(",", ":")) + "\n").encode("utf-8")
    _control.write(payload)
    _control.flush()


def _receive() -> dict[str, Any]:
    line = _control.readline()
    if not line:
        raise RuntimeError("persistent harness host disconnected")
    return json.loads(line)


def host_request(request_type: str, payload: dict[str, Any]) -> Any:
    request_id = str(uuid.uuid4())
    with _control_lock:
        _send({"type": "host_request", "id": request_id, "requestType": request_type, "payload": payload})
        while True:
            response = _receive()
            if response.get("id") != request_id:
                raise RuntimeError(f"unexpected host response: {response!r}")
            if response.get("type") == "host_progress":
                stream = sys.stderr if response.get("stream") == "stderr" else sys.stdout
                stream.write(str(response.get("text", "")))
                stream.flush()
                continue
            if response.get("type") != "host_response":
                raise RuntimeError(f"unexpected host response type: {response!r}")
            if not response.get("ok"):
                raise RuntimeError(str(response.get("error", "host request failed")))
            return response.get("result")


class SkillResult(dict):
    """Mapping result with optional rich IPython MIME representations."""

    def __init__(self, value: Any = None, mime: dict[str, Any] | None = None):
        if isinstance(value, Mapping):
            super().__init__(value)
        else:
            super().__init__({"value": value})
        self._mime = mime or {}

    def __await__(self):
        async def resolved():
            return self
        return resolved().__await__()

    def _repr_mimebundle_(self, include=None, exclude=None):
        bundle = {"text/plain": repr(dict(self)), **self._mime}
        if include is not None:
            bundle = {key: value for key, value in bundle.items() if key in include}
        if exclude is not None:
            bundle = {key: value for key, value in bundle.items() if key not in exclude}
        return bundle


class SkillProxy:
    """One SKILL.md object with optional Python backing."""

    def __init__(self, manifest: dict[str, Any], module=None):
        self.id = manifest["id"]
        self.alias = manifest["alias"]
        self.skill_path = manifest["skillPath"]
        self.version = manifest["version"]
        self._module = module
        self._entry_point = manifest.get("python", {}).get("entryPoint") if manifest.get("python") else None
        self.__doc__ = manifest["instructions"]

    @property
    def python_backed(self) -> bool:
        return self._module is not None

    def __getattr__(self, name: str):
        if self._module is None:
            raise AttributeError(
                f"Skill {self.id!r} is guidance-only. Use {self.alias}? to read its SKILL.md."
            )
        return getattr(self._module, name)

    def __call__(self, *args, **kwargs):
        if self._module is None:
            raise TypeError(
                f"Skill {self.id!r} is guidance-only. Use {self.alias}? to read its SKILL.md."
            )
        if not self._entry_point:
            raise TypeError(
                f"Skill {self.id!r} has no single entry point. Use {self.alias}? for instructions "
                f"or call one of its operations."
            )
        return getattr(self._module, self._entry_point)(*args, **kwargs)

    def __dir__(self):
        module_names = dir(self._module) if self._module is not None else []
        return sorted(set(super().__dir__()) | set(module_names))

    def __repr__(self) -> str:
        backing = "Python-backed" if self.python_backed else "guidance-only"
        return f"<Skill {self.id!r} ({backing}); use {self.alias}? for SKILL.md>"


def bootstrap_skills(manifest: dict[str, Any], namespace: dict[str, Any]) -> dict[str, SkillProxy]:
    proxies = {}
    for skill in manifest.get("skills", []):
        python = skill.get("python")
        module = None
        if python:
            src_path = python["srcPath"]
            if src_path not in sys.path:
                sys.path.insert(0, src_path)
            module = importlib.import_module(python["importName"])
            module.__doc__ = skill["instructions"]
            module.__harness_instructions_path__ = skill["skillPath"]
        proxy = SkillProxy(skill, module)
        namespace[skill["alias"]] = proxy
        proxies[skill["alias"]] = proxy
    return proxies
