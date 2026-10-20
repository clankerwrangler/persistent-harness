"""Bounded local Linux memory accounting; no supervisor or process inspection."""
import os
import re
import time
from pathlib import PurePosixPath

_U64 = (1 << 64) - 1
_MAX_LEVELS = 32
_STAT_KEYS = ("anon", "file", "inactive_file", "kernel", "shmem", "file_dirty", "file_writeback")
_EVENT_KEYS = ("low", "high", "max", "oom", "oom_kill", "oom_group_kill")


class _Reader:
    def __init__(self):
        self.remaining = 512 * 1024

    def __call__(self, path, limit):
        if self.remaining < limit + 1:
            return None
        try:
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(limit + 1)
            self.remaining -= len(data)
            return data.decode("ascii") if len(data) <= limit else None
        except (OSError, UnicodeError):
            return None


def _uint(text):
    if text is None:
        return None
    text = text.strip()
    if not re.fullmatch(r"[0-9]{1,20}", text):
        return None
    value = int(text)
    return value if value <= _U64 else None


def _numbers(text):
    values = {}
    if text is None:
        return values
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or parts[0] in values or _uint(parts[1]) is None:
            return {}
        values[parts[0]] = _uint(parts[1])
    return values


def _pressure(text):
    result = {kind: {"avg10": None, "avg60": None, "avg300": None, "total_us": None}
              for kind in ("some", "full")}
    seen = set()
    for line in (text or "").splitlines():
        parts = line.split()
        if not parts or parts[0] not in result:
            continue
        kind = parts[0]
        if kind in seen:
            return _pressure(None)
        seen.add(kind)
        fields = {}
        for token in parts[1:]:
            pair = token.split("=")
            if len(pair) != 2 or pair[0] in fields:
                return _pressure(None)
            fields[pair[0]] = pair[1]
        row = result[kind]
        for key in ("avg10", "avg60", "avg300"):
            raw = fields.get(key, "")
            if re.fullmatch(r"[0-9]{1,3}(?:\.[0-9]{1,6})?", raw) and float(raw) <= 100:
                row[key] = float(raw)
        row["total_us"] = _uint(fields.get("total"))
    return result


def _path(text):
    if not text or not text.startswith("/") or "\x00" in text:
        return None
    if any(part in (".", "..") for part in text.split("/")):
        return None
    return PurePosixPath(text)


def _unescape(text):
    return re.sub(r"\\(040|011|012|134)", lambda m: chr(int(m[1], 8)), text)


def _placement(membership, mountinfo):
    """Choose the most inclusive visible cgroup2 mount containing this member."""
    members = [line[3:] for line in (membership or "").splitlines() if line.startswith("0::")]
    if len(members) != 1 or _path(members[0]) is None:
        return None
    member = _path(members[0])
    candidates = []
    for line in (mountinfo or "").splitlines():
        fields = line.split()
        if "-" not in fields:
            continue
        separator = fields.index("-")
        if separator < 6 or len(fields) <= separator + 1 or fields[separator + 1] != "cgroup2":
            continue
        mount_root, mount = _path(_unescape(fields[3])), _path(_unescape(fields[4]))
        if mount_root is None or mount is None or not member.is_relative_to(mount_root):
            continue
        relative = member.relative_to(mount_root)
        candidates.append((len(mount_root.parts), str(mount), mount, mount / relative))
    if not candidates:
        return None
    _, _, mount, leaf = min(candidates)
    return mount, leaf


def _limit(text):
    if text is not None and text.strip() == "max":
        return None, True
    value = _uint(text)
    return value, False if value is not None else None


def _meminfo(text):
    keys = {"MemTotal": "total_bytes", "MemAvailable": "available_bytes",
            "SwapTotal": "swap_total_bytes", "SwapFree": "swap_free_bytes"}
    result = {key: None for key in keys.values()}
    seen = set()
    for line in (text or "").splitlines():
        parts = line.split()
        key = parts[0][:-1] if parts and parts[0].endswith(":") else ""
        if key not in keys:
            continue
        if key in seen:
            result[keys[key]] = None
            continue
        seen.add(key)
        if len(parts) == 3 and parts[2] == "kB":
            value = _uint(parts[1])
            if value is not None and value <= _U64 // 1024:
                result[keys[key]] = value * 1024
    if (result["available_bytes"] is not None and result["total_bytes"] is not None
            and result["available_bytes"] > result["total_bytes"]):
        result["available_bytes"] = None
    return result


def _headroom(levels, host_available, credit, include_high):
    if host_available is None or credit is None:
        return None
    ceilings = [host_available]
    for level in levels:
        current = level["current_bytes"]
        if current is None:
            return None
        for kind in (("max", "high") if include_high else ("max",)):
            unlimited = level[kind + "_unlimited"]
            if unlimited is None:
                return None
            if not unlimited:
                # Subtract any over-limit debt before adding leaf cache credit.
                ceilings.append(max(0, level[kind + "_bytes"] - current + min(credit, current)))
    return min(ceilings)


def collect():
    return _collect(_Reader())


def _collect(read):
    started = time.monotonic_ns()
    result = {"schema_version": 1, "sampled_unix_ns": time.time_ns(),
              "scope": "visible_cgroup_v2_hierarchy", "hierarchy_complete": False,
              "host": _meminfo(read("/proc/meminfo", 16 * 1024)),
              "cgroup": {key + "_bytes": None for key in _STAT_KEYS},
              "hierarchy": [], "estimated_available_bytes": None,
              "estimated_before_high_bytes": None}
    result["host"]["pressure"] = _pressure(read("/proc/pressure/memory", 4096))
    leaf_stats = result["cgroup"]
    leaf_stats.update(swap_current_bytes=None, swap_max_bytes=None, swap_max_unlimited=None,
                      clean_inactive_file_estimate_bytes=None)
    membership = read("/proc/self/cgroup", 4096)
    mounts = read("/proc/self/mountinfo", 128 * 1024)
    placement = _placement(membership, mounts)
    if placement is not None:
        mount, leaf = placement
        stats = _numbers(read(str(leaf / "memory.stat"), 16 * 1024))
        leaf_stats.update({key + "_bytes": stats.get(key) for key in _STAT_KEYS})
        leaf_stats["swap_current_bytes"] = _uint(read(str(leaf / "memory.swap.current"), 128))
        leaf_stats["swap_max_bytes"], leaf_stats["swap_max_unlimited"] = _limit(
            read(str(leaf / "memory.swap.max"), 128))
        clean_keys = ("file", "inactive_file", "shmem", "file_dirty", "file_writeback")
        if all(stats.get(key) is not None for key in clean_keys):
            # Contaminants can overlap; subtracting all is deliberately conservative.
            leaf_stats["clean_inactive_file_estimate_bytes"] = max(
                0, min(stats["file"], stats["inactive_file"]) - stats["shmem"]
                - stats["file_dirty"] - stats["file_writeback"])
        current_path = leaf
        for _ in range(_MAX_LEVELS):
            current = _uint(read(str(current_path / "memory.current"), 128))
            level = {"current_bytes": current}
            for kind in ("max", "high"):
                limit, unlimited = _limit(read(str(current_path / ("memory." + kind)), 128))
                level[kind + "_bytes"], level[kind + "_unlimited"] = limit, unlimited
                level["raw_" + kind + "_headroom_bytes"] = (
                    limit - current if limit is not None and current is not None else None)
            events = _numbers(read(str(current_path / "memory.events"), 4096))
            level["events"] = {key: events.get(key) for key in _EVENT_KEYS}
            level["pressure"] = _pressure(read(str(current_path / "memory.pressure"), 4096))
            result["hierarchy"].append(level)
            if current_path == mount:
                result["hierarchy_complete"] = True
                break
            current_path = current_path.parent
        # Placement changes invalidate the combined observation, not just its estimate.
        if read("/proc/self/cgroup", 4096) != membership or read("/proc/self/mountinfo", 128 * 1024) != mounts:
            result["hierarchy_complete"] = False
        credit = leaf_stats["clean_inactive_file_estimate_bytes"]
        if result["hierarchy_complete"]:
            result["estimated_available_bytes"] = _headroom(
                result["hierarchy"], result["host"]["available_bytes"], credit, False)
            result["estimated_before_high_bytes"] = _headroom(
                result["hierarchy"], result["host"]["available_bytes"], credit, True)
    result["duration_ns"] = time.monotonic_ns() - started
    return result
