"""Python-backed skill for launching and tracking detached OS processes.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

INSTRUCTIONS_PATH = __harness_instructions_path__ if "__harness_instructions_path__" in globals() else None

_AGENT_ROOT = Path(os.environ.get("PI_CODING_AGENT_DIR") or (Path.home() / ".pi" / "agent"))
STORE_ROOT = _AGENT_ROOT / "state" / "background-jobs"
SUPERVISOR_PATH = Path(__file__).resolve().parent / "supervisor.py"
SCHEMA = "background.job.v1"
JOB_ID_RE = re.compile(r"^bg-[0-9a-f]{12}$")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_RUNNING_JOBS = 32
MAX_LISTED_JOBS = 128
MAX_COMMAND_BYTES = 64 * 1024
MAX_NAME_LEN = 64
MAX_SELECTOR_LEN = 80
MAX_PATH_LEN = 4096
MAX_SESSION_ID_LEN = 128
DEFAULT_TAIL_BYTES = 8192
MAX_TAIL_BYTES = 65536
DEFAULT_WAIT_TIMEOUT = 5.0
MAX_WAIT_TIMEOUT = 30.0
STOP_GRACE_SECONDS = 0.8
IDENTITY_WAIT_SECONDS = 3.0
LOCK_NAME = ".lock"
META_NAME = "meta.json"
LOG_NAME = "output.log"
EXIT_NAME = "exit.json"

_ERROR_CODES = {
    "INVALID_OPERATION",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "NOT_RUNNING",
    "STILL_RUNNING",
    "LIMIT_EXCEEDED",
    "SPAWN_FAILED",
    "STOP_FAILED",
    "LOG_UNAVAILABLE",
}
_OPERATIONS = {
    "launch",
    "adopt",
    "status",
    "logs",
    "wait",
    "stop",
    "list",
    "remove",
}
_ALLOWED_KWARGS = {
    "command",
    "name",
    "cwd",
    "pid",
    "log_path",
    "selector",
    "tail_bytes",
    "timeout",
    "include_exited",
    "force",
}
_OP_KWARGS = {
    "launch": {"command", "name", "cwd"},
    "adopt": {"pid", "name", "log_path"},
    "status": {"selector"},
    "logs": {"selector", "tail_bytes"},
    "wait": {"selector", "timeout"},
    "stop": {"selector"},
    "list": {"include_exited"},
    "remove": {"selector", "force"},
}
_ENV_ALLOWLIST = (
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "DISPLAY",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
)


class _CodedError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code if code in _ERROR_CODES else "INVALID_ARGUMENT"
        super().__init__(self.code)


def _failure(code: str) -> dict[str, Any]:
    return {"ok": False, "error": code if code in _ERROR_CODES else "INVALID_ARGUMENT"}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return value == value and value not in (float("inf"), float("-inf"))
    return False


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_iso(value: str) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _elapsed_ms(created_at: str, ended_at: str | None) -> int:
    start = _parse_iso(created_at)
    if start is None:
        return 0
    end = _parse_iso(ended_at) if ended_at else datetime.now(timezone.utc)
    if end is None:
        end = datetime.now(timezone.utc)
    delta = int((end - start).total_seconds() * 1000)
    return max(0, delta)


def _atomic_write(path: Path, payload: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(path))
    dir_fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    _atomic_write(path, json.dumps(value, separators=(",", ":")).encode("utf-8"))


def _ensure_store() -> None:
    STORE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(STORE_ROOT, 0o700)
    except OSError:
        pass


@contextmanager
def _store_lock() -> Iterator[None]:
    _ensure_store()
    lock_path = STORE_ROOT / LOCK_NAME
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


def _new_job_id() -> str:
    for _ in range(8):
        job_id = "bg-" + secrets.token_hex(6)
        if not (STORE_ROOT / job_id).exists():
            return job_id
    raise _CodedError("SPAWN_FAILED")


def _validate_name(value: Any, *, default: str) -> str:
    if value is None:
        return default
    if not isinstance(value, str) or not value or len(value) > MAX_NAME_LEN or not NAME_RE.fullmatch(value):
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_command(value: Any) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise _CodedError("INVALID_ARGUMENT")
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_COMMAND_BYTES:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_cwd(value: Any) -> str:
    if value is None:
        value = os.getcwd()
    if not isinstance(value, str) or not value or "\x00" in value or len(value) > MAX_PATH_LEN:
        raise _CodedError("INVALID_ARGUMENT")
    path = Path(value)
    try:
        if not path.is_dir():
            raise _CodedError("INVALID_ARGUMENT")
        resolved = path.resolve()
    except (OSError, _CodedError):
        raise _CodedError("INVALID_ARGUMENT") from None
    if not resolved.is_dir():
        raise _CodedError("INVALID_ARGUMENT")
    return str(resolved)


def _validate_selector(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_SELECTOR_LEN or "\x00" in value:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_pid(value: Any) -> int:
    if not _is_int(value) or value <= 0:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if type(value) is not bool:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_tail_bytes(value: Any) -> int:
    if value is None:
        return DEFAULT_TAIL_BYTES
    if not _is_int(value) or not 1 <= value <= MAX_TAIL_BYTES:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _validate_timeout(value: Any) -> float:
    if value is None:
        return DEFAULT_WAIT_TIMEOUT
    if not _is_number(value) or not 0 < float(value) <= MAX_WAIT_TIMEOUT:
        raise _CodedError("INVALID_ARGUMENT")
    return float(value)


def _validate_log_path(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or "\x00" in value or len(value) > MAX_PATH_LEN:
        raise _CodedError("INVALID_ARGUMENT")
    return value


def _notification_context() -> dict[str, str]:
    session_id = os.environ.get("PI_HARNESS_ACTOR_ID")
    if (not isinstance(session_id, str) or not session_id or len(session_id) > MAX_SESSION_ID_LEN
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", session_id)):
        return {}
    return {"session_id": session_id}


def _allowlist_env(cwd: str, job_id: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for key in _ENV_ALLOWLIST:
        item = os.environ.get(key)
        if item is not None:
            env[key] = item
    env["PWD"] = cwd
    env["PI_BACKGROUND_JOB_ID"] = job_id
    env.setdefault("PATH", "/usr/bin:/bin")
    return env


def _read_proc_stat(pid: int) -> tuple[int, int, str, str]:
    text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
    close = text.rfind(")")
    if close < 0:
        raise OSError("invalid stat")
    fields = text[close + 2 :].strip().split()
    state = fields[0]
    pgid = int(fields[2])
    session = int(fields[3])
    starttime = fields[19]
    if not starttime:
        raise OSError("invalid starttime")
    return pgid, session, starttime, state


def _reap(pid: int) -> None:
    if not _is_int(pid) or pid <= 0:
        return
    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):
        pass


def _has_job_token(pid: int, job_id: str) -> bool:
    data = Path(f"/proc/{pid}/environ").read_bytes()
    needle = b"PI_BACKGROUND_JOB_ID=" + job_id.encode("ascii", "strict")
    return any(entry == needle for entry in data.split(b"\0"))


def _pid_exists(pid: int) -> bool:
    if not _is_int(pid) or pid <= 0:
        return False
    try:
        _pgid, _session, _start, state = _read_proc_stat(pid)
    except (OSError, ValueError, IndexError):
        return False
    if state == "Z":
        _reap(pid)
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        _reap(pid)
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _identity_matches(meta: dict[str, Any]) -> bool:
    pid = meta.get("pid")
    starttime = meta.get("starttime")
    job_id = meta.get("id")
    if not _is_int(pid) or pid <= 0 or not isinstance(starttime, str) or not starttime:
        return False
    try:
        _pgid, _session, current, state = _read_proc_stat(pid)
    except (OSError, ValueError, IndexError):
        _reap(pid if _is_int(pid) else -1)
        return False
    if state == "Z":
        _reap(pid)
        return False
    if current != starttime:
        return False
    if meta.get("kind") == "launched":
        if not isinstance(job_id, str) or not job_id:
            return False
        try:
            if not _has_job_token(pid, job_id):
                return False
        except OSError:
            # Same pid+starttime cannot be a reuse; environ may vanish while exiting.
            pass
    return True


def _capture_identity(pid: int, job_id: str, kind: str) -> dict[str, Any] | None:
    deadline = time.monotonic() + IDENTITY_WAIT_SECONDS
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        try:
            pgid, session, starttime, state = _read_proc_stat(pid)
            if state == "Z":
                _reap(pid)
                break
            last = {"pid": pid, "process_group": pgid, "session": session, "starttime": starttime}
            if kind != "launched" or _has_job_token(pid, job_id):
                return last
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(0.02)
    return last if kind != "launched" else None


def _log_bytes(log_path: str | None) -> int:
    if not isinstance(log_path, str) or not log_path:
        return 0
    try:
        st = os.stat(log_path, follow_symlinks=True)
    except OSError:
        return 0
    if not stat.S_ISREG(st.st_mode):
        return 0
    return max(0, int(st.st_size))


def _read_exit(job_dir: Path) -> dict[str, Any] | None:
    path = job_dir / EXIT_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    exit_code = data.get("exit_code")
    sig_name = data.get("signal")
    ended_at = data.get("ended_at")
    if exit_code is not None and not _is_int(exit_code):
        exit_code = None
    if sig_name is not None and not isinstance(sig_name, str):
        sig_name = None
    if ended_at is not None and not isinstance(ended_at, str):
        ended_at = None
    return {"exit_code": exit_code, "signal": sig_name, "ended_at": ended_at}


def _load_meta(job_dir: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((job_dir / META_NAME).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        return None
    job_id = data.get("id")
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        return None
    return data


def _iter_job_dirs() -> list[Path]:
    if not STORE_ROOT.is_dir():
        return []
    found: list[Path] = []
    try:
        names = sorted(os.listdir(STORE_ROOT))
    except OSError:
        return []
    for name in names:
        if not JOB_ID_RE.fullmatch(name):
            continue
        path = STORE_ROOT / name
        if path.is_dir():
            found.append(path)
    return found


def _observe(meta: dict[str, Any], job_dir: Path) -> dict[str, Any]:
    exit_info = _read_exit(job_dir)
    matches = _identity_matches(meta)
    pid = meta.get("pid")
    kind = meta.get("kind")
    if not matches and _is_int(pid):
        _reap(pid)
    if exit_info is not None:
        state = "exited"
    elif matches:
        state = "running"
    elif kind == "adopted" and not _pid_exists(pid if _is_int(pid) else -1):
        state = "exited"
    else:
        state = "vanished"
    ended_at = None
    exit_code = None
    sig_name = None
    if state != "running":
        if exit_info is not None:
            ended_at = exit_info.get("ended_at")
            exit_code = exit_info.get("exit_code")
            sig_name = exit_info.get("signal")
        if ended_at is None and state in {"exited", "vanished"}:
            ended_at = meta.get("ended_at")
    log_path = meta.get("log_path") if isinstance(meta.get("log_path"), str) else None
    created_at = meta.get("created_at") if isinstance(meta.get("created_at"), str) else _now_iso()
    return {
        "id": meta.get("id"),
        "name": meta.get("name") if isinstance(meta.get("name"), str) else meta.get("id"),
        "kind": kind if kind in {"launched", "adopted"} else "launched",
        "command": meta.get("command") if isinstance(meta.get("command"), str) else "",
        "cwd": meta.get("cwd") if isinstance(meta.get("cwd"), str) else None,
        "pid": pid if _is_int(pid) else None,
        "state": state,
        "created_at": created_at,
        "ended_at": ended_at,
        "exit_code": exit_code,
        "signal": sig_name,
        "log_path": log_path,
        "log_bytes": _log_bytes(log_path),
        "elapsed_ms": _elapsed_ms(created_at, ended_at if state != "running" else None),
        "running": state == "running",
    }


def _success(operation: str, job: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {"ok": True, "operation": operation, **job}
    if extra:
        result.update(extra)
    return result


def _all_jobs() -> list[tuple[Path, dict[str, Any], dict[str, Any]]]:
    items: list[tuple[Path, dict[str, Any], dict[str, Any]]] = []
    for job_dir in _iter_job_dirs():
        meta = _load_meta(job_dir)
        if meta is None:
            continue
        items.append((job_dir, meta, _observe(meta, job_dir)))
    return items


def _count_running(jobs: list[tuple[Path, dict[str, Any], dict[str, Any]]]) -> int:
    return sum(1 for _dir, _meta, job in jobs if job["state"] == "running")


def _live_name_taken(jobs: list[tuple[Path, dict[str, Any], dict[str, Any]]], name: str) -> bool:
    target = name.casefold()
    for _dir, _meta, job in jobs:
        if job["state"] == "running" and isinstance(job.get("name"), str) and job["name"].casefold() == target:
            return True
    return False


def _resolve(selector: str, jobs: list[tuple[Path, dict[str, Any], dict[str, Any]]]) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    for job_dir, meta, job in jobs:
        if job["id"] == selector:
            return job_dir, meta, job
    target = selector.casefold()
    live = [
        item
        for item in jobs
        if item[2]["state"] == "running"
        and isinstance(item[2].get("name"), str)
        and item[2]["name"].casefold() == target
    ]
    if len(live) == 1:
        return live[0]
    named = [
        item
        for item in jobs
        if isinstance(item[2].get("name"), str) and item[2]["name"].casefold() == target
    ]
    if len(named) == 1:
        return named[0]
    if len(named) > 1:
        named.sort(key=lambda item: str(item[2].get("created_at") or ""), reverse=True)
        return named[0]
    raise _CodedError("NOT_FOUND")


def _read_cmdline(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    parts = [part.decode("utf-8", "replace") for part in raw.split(b"\0") if part]
    command = " ".join(parts)
    if len(command.encode("utf-8")) > MAX_COMMAND_BYTES:
        command = command.encode("utf-8")[:MAX_COMMAND_BYTES].decode("utf-8", "ignore")
    return command


def _read_cwd(pid: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def _best_effort_kill(pid: int, job_id: str) -> None:
    if not _is_int(pid) or pid <= 0:
        return
    try:
        if _has_job_token(pid, job_id):
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                os.kill(pid, signal.SIGKILL)
            return
    except OSError:
        pass


def _spawn_adoption_watcher(job_dir: Path, job_id: str) -> None:
    env = _allowlist_env(os.environ.get("PWD") or ".", job_id)
    try:
        proc = subprocess.Popen(
            [sys.executable, str(SUPERVISOR_PATH), "--job-dir", str(job_dir), "--adopt"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        proc.returncode = 0
    except OSError as exc:
        raise _CodedError("SPAWN_FAILED") from exc


def _spawn_supervisor(job_dir: Path, job_id: str, cwd: str) -> dict[str, Any]:
    env = _allowlist_env(cwd, job_id)
    try:
        proc = subprocess.Popen(
            [sys.executable, str(SUPERVISOR_PATH), "--job-dir", str(job_dir)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as exc:
        raise _CodedError("SPAWN_FAILED") from exc
    pid = proc.pid
    proc.returncode = 0
    identity = _capture_identity(pid, job_id, "launched")
    if identity is None:
        try:
            if (job_dir / EXIT_NAME).is_file():
                try:
                    pgid, session, starttime, _state = _read_proc_stat(pid)
                    identity = {
                        "pid": pid,
                        "process_group": pgid,
                        "session": session,
                        "starttime": starttime,
                    }
                except (OSError, ValueError, IndexError):
                    identity = {
                        "pid": pid,
                        "process_group": pid,
                        "session": pid,
                        "starttime": "",
                    }
        except OSError:
            identity = None
    if identity is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        raise _CodedError("SPAWN_FAILED")
    return identity


def _op_launch(kwargs: dict[str, Any]) -> dict[str, Any]:
    command = _validate_command(kwargs.get("command"))
    cwd = _validate_cwd(kwargs.get("cwd"))
    jobs = _all_jobs()
    if _count_running(jobs) >= MAX_RUNNING_JOBS:
        raise _CodedError("LIMIT_EXCEEDED")
    job_id = _new_job_id()
    name = _validate_name(kwargs.get("name"), default=job_id)
    if _live_name_taken(jobs, name):
        raise _CodedError("INVALID_ARGUMENT")
    job_dir = STORE_ROOT / job_id
    try:
        job_dir.mkdir(mode=0o700)
    except OSError as exc:
        raise _CodedError("SPAWN_FAILED") from exc
    log_path = str((job_dir / LOG_NAME).resolve())
    created_at = _now_iso()
    meta: dict[str, Any] = {
        "schema": SCHEMA,
        "id": job_id,
        "name": name,
        "kind": "launched",
        "command": command,
        "cwd": cwd,
        "pid": None,
        "process_group": None,
        "starttime": None,
        "created_at": created_at,
        "log_path": log_path,
        **_notification_context(),
    }
    try:
        (job_dir / LOG_NAME).touch(mode=0o600, exist_ok=True)
        _write_json(job_dir / META_NAME, meta)
        identity = _spawn_supervisor(job_dir, job_id, cwd)
        meta["pid"] = identity["pid"]
        meta["process_group"] = identity["process_group"]
        meta["starttime"] = identity["starttime"]
        _write_json(job_dir / META_NAME, meta)
    except Exception:
        pid = meta.get("pid")
        if _is_int(pid) and pid > 0:
            _best_effort_kill(pid, job_id)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    return _success("launch", _observe(meta, job_dir))


def _op_adopt(kwargs: dict[str, Any]) -> dict[str, Any]:
    pid = _validate_pid(kwargs.get("pid"))
    log_path = _validate_log_path(kwargs.get("log_path"))
    jobs = _all_jobs()
    if _count_running(jobs) >= MAX_RUNNING_JOBS:
        raise _CodedError("LIMIT_EXCEEDED")
    if not _pid_exists(pid):
        raise _CodedError("NOT_RUNNING")
    identity = _capture_identity(pid, "", "adopted")
    if identity is None:
        raise _CodedError("NOT_RUNNING")
    for _dir, meta, job in jobs:
        if job["state"] == "running" and meta.get("pid") == pid and meta.get("starttime") == identity["starttime"]:
            raise _CodedError("INVALID_ARGUMENT")
    job_id = _new_job_id()
    name = _validate_name(kwargs.get("name"), default=job_id)
    if _live_name_taken(jobs, name):
        raise _CodedError("INVALID_ARGUMENT")
    job_dir = STORE_ROOT / job_id
    try:
        job_dir.mkdir(mode=0o700)
    except OSError as exc:
        raise _CodedError("SPAWN_FAILED") from exc
    command = _read_cmdline(pid)
    cwd = _read_cwd(pid)
    created_at = _now_iso()
    meta = {
        "schema": SCHEMA,
        "id": job_id,
        "name": name,
        "kind": "adopted",
        "command": command,
        "cwd": cwd,
        "pid": identity["pid"],
        "process_group": identity["process_group"],
        "starttime": identity["starttime"],
        "created_at": created_at,
        "log_path": log_path,
        **_notification_context(),
    }
    try:
        _write_json(job_dir / META_NAME, meta)
        _spawn_adoption_watcher(job_dir, job_id)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    return _success("adopt", _observe(meta, job_dir))


def _op_status(kwargs: dict[str, Any]) -> dict[str, Any]:
    selector = _validate_selector(kwargs.get("selector"))
    job_dir, meta, job = _resolve(selector, _all_jobs())
    return _success("status", _observe(meta, job_dir))


def _tail_file(path: str, tail_bytes: int) -> tuple[str, int, bool]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise _CodedError("LOG_UNAVAILABLE") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise _CodedError("LOG_UNAVAILABLE")
        size = max(0, int(st.st_size))
        if size <= tail_bytes:
            data = b""
            while True:
                chunk = os.read(fd, 8192)
                if not chunk:
                    break
                data += chunk
                if len(data) > tail_bytes:
                    data = data[-tail_bytes:]
            return data.decode("utf-8", "replace"), size, False
        os.lseek(fd, size - tail_bytes, os.SEEK_SET)
        data = os.read(fd, tail_bytes)
        return data.decode("utf-8", "replace"), size, True
    except _CodedError:
        raise
    except OSError as exc:
        raise _CodedError("LOG_UNAVAILABLE") from exc
    finally:
        os.close(fd)


def _op_logs(kwargs: dict[str, Any]) -> dict[str, Any]:
    selector = _validate_selector(kwargs.get("selector"))
    tail_bytes = _validate_tail_bytes(kwargs.get("tail_bytes"))
    job_dir, meta, job = _resolve(selector, _all_jobs())
    job = _observe(meta, job_dir)
    log_path = job.get("log_path")
    if not isinstance(log_path, str) or not log_path:
        raise _CodedError("LOG_UNAVAILABLE")
    text, size, truncated = _tail_file(log_path, tail_bytes)
    job["log_bytes"] = size
    return _success("logs", job, {"log": text, "truncated": truncated})


def _op_wait(kwargs: dict[str, Any]) -> dict[str, Any]:
    selector = _validate_selector(kwargs.get("selector"))
    timeout = _validate_timeout(kwargs.get("timeout"))
    deadline = time.monotonic() + timeout
    while True:
        jobs = _all_jobs()
        job_dir, meta, job = _resolve(selector, jobs)
        job = _observe(meta, job_dir)
        if job["state"] != "running":
            return _success("wait", job)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _success("wait", job)
        time.sleep(min(0.1, remaining))


def _session_pids(session: int) -> list[int]:
    found: list[int] = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return found
    for name in names:
        if not name.isdigit():
            continue
        other = int(name)
        try:
            _pgid, sid, _start, state = _read_proc_stat(other)
        except (OSError, ValueError, IndexError):
            continue
        if sid == session and state != "Z":
            found.append(other)
    return found


def _pid_is_live_identity(meta: dict[str, Any]) -> bool:
    pid = meta.get("pid")
    starttime = meta.get("starttime")
    if not _is_int(pid) or pid <= 0 or not isinstance(starttime, str) or not starttime:
        return False
    try:
        _pgid, _session, current, state = _read_proc_stat(pid)
    except (OSError, ValueError, IndexError):
        _reap(pid if _is_int(pid) else -1)
        return False
    if state == "Z":
        _reap(pid)
        return False
    return current == starttime


def _stop_process(meta: dict[str, Any]) -> str:
    if not _identity_matches(meta):
        raise _CodedError("NOT_RUNNING")
    pid = meta["pid"]

    def send(sig: int) -> None:
        if not _pid_is_live_identity(meta):
            return
        try:
            pgid, session, _start, state = _read_proc_stat(pid)
        except (OSError, ValueError, IndexError):
            _reap(pid)
            return
        if state == "Z":
            _reap(pid)
            return
        use_group = meta.get("kind") == "launched" or pgid == pid
        try:
            if use_group and pgid == pid:
                os.killpg(pgid, sig)
            else:
                os.kill(pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        if meta.get("kind") == "launched":
            for other in _session_pids(session):
                if other == pid:
                    continue
                try:
                    os.kill(other, sig)
                except OSError:
                    pass

    send(signal.SIGTERM)
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not _pid_is_live_identity(meta):
            _reap(pid)
            return "SIGTERM"
        time.sleep(0.05)
    send(signal.SIGKILL)
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not _pid_is_live_identity(meta):
            _reap(pid)
            return "SIGKILL"
        time.sleep(0.05)
    if _pid_is_live_identity(meta):
        raise _CodedError("STOP_FAILED")
    _reap(pid)
    return "SIGKILL"


def _write_stop_exit_if_missing(job_dir: Path, sig_name: str) -> None:
    if _read_exit(job_dir) is None:
        _write_json(job_dir / EXIT_NAME, {"exit_code": None, "signal": sig_name, "ended_at": _now_iso()})


def _op_stop(kwargs: dict[str, Any]) -> dict[str, Any]:
    selector = _validate_selector(kwargs.get("selector"))
    job_dir, meta, job = _resolve(selector, _all_jobs())
    if job["state"] != "running":
        raise _CodedError("NOT_RUNNING")
    sig_name = _stop_process(meta)
    _write_stop_exit_if_missing(job_dir, sig_name)
    return _success("stop", _observe(meta, job_dir))


def _op_list(kwargs: dict[str, Any]) -> dict[str, Any]:
    include_exited = _validate_bool(kwargs.get("include_exited"), False)
    jobs = _all_jobs()
    observed = [job for _dir, _meta, job in jobs]
    if not include_exited:
        observed = [job for job in observed if job["state"] == "running"]
    observed.sort(key=lambda job: str(job.get("created_at") or ""), reverse=True)
    truncated = len(observed) > MAX_LISTED_JOBS
    return {
        "ok": True,
        "operation": "list",
        "jobs": observed[:MAX_LISTED_JOBS],
        "truncated": truncated,
    }


def _op_remove(kwargs: dict[str, Any]) -> dict[str, Any]:
    selector = _validate_selector(kwargs.get("selector"))
    force = _validate_bool(kwargs.get("force"), False)
    job_dir, meta, job = _resolve(selector, _all_jobs())
    job = _observe(meta, job_dir)
    if job["state"] == "running":
        if not force:
            raise _CodedError("STILL_RUNNING")
        _stop_process(meta)
        job = _observe(meta, job_dir)
        if job["state"] == "running":
            raise _CodedError("STOP_FAILED")
    snapshot = dict(job)
    try:
        shutil.rmtree(job_dir)
    except OSError as exc:
        raise _CodedError("INVALID_ARGUMENT") from exc
    return _success("remove", snapshot)


_HANDLERS = {
    "launch": _op_launch,
    "adopt": _op_adopt,
    "status": _op_status,
    "logs": _op_logs,
    "wait": _op_wait,
    "stop": _op_stop,
    "list": _op_list,
    "remove": _op_remove,
}


def _execute_operation(*, operation: str, **kwargs: Any) -> dict[str, Any]:
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        return _failure("INVALID_OPERATION")
    extra = set(kwargs) - _OP_KWARGS[operation]
    if extra:
        return _failure("INVALID_ARGUMENT")
    try:
        if operation == "wait":
            selector = _validate_selector(kwargs.get("selector"))
            timeout = _validate_timeout(kwargs.get("timeout"))
            deadline = time.monotonic() + timeout
            last: dict[str, Any] | None = None
            while True:
                with _store_lock():
                    jobs = _all_jobs()
                    job_dir, meta, job = _resolve(selector, jobs)
                    last = _observe(meta, job_dir)
                if last["state"] != "running":
                    return _success("wait", last)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return _success("wait", last)
                time.sleep(min(0.1, remaining))
        with _store_lock():
            return _HANDLERS[operation](kwargs)
    except _CodedError as exc:
        return _failure(exc.code)
    except Exception:
        if operation == "launch":
            return _failure("SPAWN_FAILED")
        if operation == "stop":
            return _failure("STOP_FAILED")
        if operation == "logs":
            return _failure("LOG_UNAVAILABLE")
        if operation == "adopt":
            return _failure("SPAWN_FAILED")
        return _failure("INVALID_ARGUMENT")


async def run(*, operation: str, **kwargs: Any) -> dict[str, Any]:
    if not isinstance(operation, str):
        return _failure("INVALID_OPERATION")
    if set(kwargs) - _ALLOWED_KWARGS:
        return _failure("INVALID_ARGUMENT")
    return await asyncio.to_thread(_execute_operation, operation=operation, **kwargs)


__all__ = ["run", "_execute_operation", "STORE_ROOT", "MAX_RUNNING_JOBS"]
