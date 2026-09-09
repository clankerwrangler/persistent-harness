"""Detached job supervisor for the background skill. Internal executable, not a public API.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _write_exit(job_dir: Path, exit_code: int | None, sig_name: str | None) -> None:
    body = json.dumps(
        {"exit_code": exit_code, "signal": sig_name, "ended_at": _now_iso()},
        separators=(",", ":"),
    ).encode("utf-8")
    path = job_dir / "exit.json"
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(str(tmp), str(path))
    except FileExistsError:
        pass
    finally:
        try:
            os.unlink(str(tmp))
        except FileNotFoundError:
            pass


def _decode(returncode: int) -> tuple[int | None, str | None]:
    if returncode < 0:
        number = -returncode
        try:
            name = signal.Signals(number).name
        except ValueError:
            name = "SIG" + str(number)
        return None, name
    return returncode, None


def _env_for(cwd: str, job_id: str) -> dict[str, str]:
    env: dict[str, str] = {}
    for key in _ENV_ALLOWLIST:
        value = os.environ.get(key)
        if value is not None:
            env[key] = value
    env["PWD"] = cwd
    env["PI_BACKGROUND_JOB_ID"] = job_id
    env.setdefault("PATH", "/usr/bin:/bin")
    return env


def _noop_signal(_signum: int, _frame: object) -> None:
    return


def _read_identity(meta: dict[str, object]) -> tuple[int, str] | None:
    pid = meta.get("pid")
    starttime = meta.get("starttime")
    if not isinstance(pid, int) or pid <= 0 or not isinstance(starttime, str) or not starttime:
        return None
    return pid, starttime


def _adopted_process_running(meta: dict[str, object]) -> bool:
    identity = _read_identity(meta)
    if identity is None:
        return False
    pid, expected_starttime = identity
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
        close = text.rfind(")")
        if close < 0:
            return False
        fields = text[close + 2 :].strip().split()
        return fields[0] != "Z" and fields[19] == expected_starttime
    except (OSError, IndexError):
        return False


def _watch_adopted(job_dir: Path, meta: dict[str, object]) -> int:
    while _adopted_process_running(meta):
        time.sleep(0.2)
    _write_exit(job_dir, None, None)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4) or argv[1] != "--job-dir" or len(argv) == 4 and argv[3] != "--adopt":
        return 2
    job_dir = Path(argv[2])
    try:
        meta = json.loads((job_dir / "meta.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        return 2
    job_id = meta.get("id") if isinstance(meta, dict) else None
    command = meta.get("command") if isinstance(meta, dict) else None
    cwd = meta.get("cwd") if isinstance(meta, dict) else None
    if not isinstance(job_id, str) or not job_id:
        return 2
    if len(argv) == 4:
        return _watch_adopted(job_dir, meta)
    if not isinstance(command, str) or not command or "\x00" in command:
        _write_exit(job_dir, 127, None)
        return 127
    if not isinstance(cwd, str) or not cwd or "\x00" in cwd:
        cwd = os.getcwd()
    try:
        os.chdir(cwd)
    except OSError:
        _write_exit(job_dir, 127, None)
        return 127
    os.environ["PI_BACKGROUND_JOB_ID"] = job_id
    try:
        os.setsid()
    except OSError:
        pass
    # Handler (not SIG_IGN) so exec'd bash resets SIGTERM to default.
    signal.signal(signal.SIGTERM, _noop_signal)
    signal.signal(signal.SIGINT, _noop_signal)
    log_path = job_dir / "output.log"
    try:
        log_fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    except OSError:
        _write_exit(job_dir, 127, None)
        return 127
    try:
        child = subprocess.Popen(
            ["/bin/bash", "-lc", command],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            env=_env_for(cwd, job_id),
            start_new_session=False,
            close_fds=True,
        )
        returncode = child.wait()
        exit_code, sig_name = _decode(returncode)
        _write_exit(job_dir, exit_code, sig_name)
        return 0
    except Exception:
        _write_exit(job_dir, 127, None)
        return 127
    finally:
        os.close(log_fd)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
