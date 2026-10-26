"""Bounded, advisory cold residency inside an existing Linux kernel process.

Only private anonymous mapping metadata is inspected. No namespace values are
visited, serialized, relocated, discarded, or returned to the controller.
"""
from __future__ import annotations

import ctypes
import errno
import re
import time

CHUNK_BYTES = 1024 * 1024
STEP_BYTES = 4 * CHUNK_BYTES
STEP_NS = 10_000_000
MAX_PASS_BYTES = 1024 * 1024 * 1024
MAX_REGIONS = 256
MAX_MAP_BYTES = 512 * 1024
SWAP_RESERVE = 256 * 1024 * 1024
PRESSURE_HEADROOM = 2 * 1024 * 1024 * 1024
MIN_ANON_RSS = 64 * 1024 * 1024
MADV_COLD = 20
MADV_PAGEOUT = 21
_HEADER = re.compile(r"^([0-9a-f]+)-([0-9a-f]+) ([rwxps-]{4}) [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ ([0-9]+)(?:\s+(.*))?$")


def process_memory():
    result = {}
    with open("/proc/self/smaps_rollup", "rb") as stream:
        data = stream.read(8193)
    if len(data) > 8192:
        raise ValueError("oversized rollup")
    for line in data.decode("ascii").splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[0] in {"Rss:", "Anonymous:", "Swap:"} and parts[2] == "kB":
            result[parts[0][:-1]] = int(parts[1]) * 1024
    if set(result) != {"Rss", "Anonymous", "Swap"}:
        raise ValueError("incomplete rollup")
    return result


def regions():
    """Capture at most 256 eligible VMAs from bounded numeric self metadata."""
    found = []
    current = None
    total = 0
    def finish():
        if current is not None and all(key in current for key in ("rss", "referenced", "locked")):
            found.append(current)
    with open("/proc/self/smaps", "rb") as stream:
        while True:
            raw = stream.readline(4097)
            if not raw:
                finish()
                break
            total += len(raw)
            if len(raw) > 4096 or total > MAX_MAP_BYTES:
                raise ValueError("incomplete mapping metadata")
            line = raw.decode("utf-8", errors="replace").strip()
            match = _HEADER.fullmatch(line)
            if match:
                finish()
                if len(found) >= MAX_REGIONS:
                    break
                start, end, permissions, inode, name = match.groups()
                name = name or ""
                eligible = permissions == "rw-p" and inode == "0" and (
                    not name or name == "[heap]" or name.startswith("[anon:"))
                current = {"start": int(start, 16), "end": int(end, 16)} if eligible else None
            elif current is not None:
                parts = line.split()
                if len(parts) == 3 and parts[0] in {"Rss:", "Referenced:", "Locked:"} and parts[2] == "kB":
                    current[{"Rss:": "rss", "Referenced:": "referenced", "Locked:": "locked"}[parts[0]]] = int(parts[1]) * 1024
    return found


def pressure_budget():
    from _linux_memory import collect
    sample = collect()
    available = sample["estimated_available_bytes"]
    before_high = sample["estimated_before_high_bytes"]
    host_free = sample["host"]["swap_free_bytes"]
    group = sample["cgroup"]
    if available is None or before_high is None or host_free is None or group["swap_current_bytes"] is None:
        return "unavailable", 0
    if group["swap_max_unlimited"] is True:
        room = host_free
    elif group["swap_max_unlimited"] is False and group["swap_max_bytes"] is not None:
        room = min(host_free, max(0, group["swap_max_bytes"] - group["swap_current_bytes"]))
    else:
        return "unavailable", 0
    if room <= SWAP_RESERVE:
        return "no-swap", 0
    available = min(available, before_high)
    pressure_data = sample["host"].get("pressure")
    full = pressure_data.get("full") if isinstance(pressure_data, dict) else None
    pressure = full.get("avg10") if isinstance(full, dict) else None
    if type(pressure) not in {int, float} or not 0 <= pressure <= 100:
        pressure = None
    if available > PRESSURE_HEADROOM and not (pressure is not None and pressure >= 0.1):
        return "no-pressure", 0
    return "eligible", min(MAX_PASS_BYTES, room - SWAP_RESERVE)


class ColdResidency:
    def __init__(self):
        self.token = None
        self.phase = "none"
        self.plan = []
        self.marked_plan = []
        self.index = 0
        self.offset = 0
        self.marked = 0
        self.paged = 0
        self.before = None
        self.libc = None
        self.advice_ns = 0
        self.max_advice_ns = 0
        self.total_ns = 0
        self.max_step_ns = 0

    def _start(self, token):
        self.__init__()
        self.token = token
        reason, budget = pressure_budget()
        self.before = process_memory()
        if reason != "eligible":
            self.phase = reason
            return
        if self.before["Anonymous"] < MIN_ANON_RSS:
            self.phase = "small"
            return
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.madvise.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        total = 0
        for region in regions():
            size = region["end"] - region["start"]
            # Mark complete VMAs so later Referenced=0 actually covers the range.
            if region["locked"] or region["rss"] == 0 or size <= 0 or size > budget - total:
                continue
            self.plan.append((region["start"], region["end"]))
            total += size
        self.phase = "mark" if self.plan else "unreclaimable"

    def _pageout(self):
        reason, budget = pressure_budget()
        if reason != "eligible":
            self.phase = reason
            return
        fresh = {(r["start"], r["end"]): r for r in regions()}
        selected = []
        total = 0
        for pair in self.plan:
            region = fresh.get(pair)
            size = pair[1] - pair[0]
            if region and not region["locked"] and not region["referenced"] and region["rss"] and size <= budget - total:
                selected.append(pair)
                total += size
        self.plan, self.index, self.offset = selected, 0, 0
        self.phase = "pageout" if selected else "hot"

    def step(self, token, phase):
        started = time.monotonic_ns()
        try:
            if phase == "mark" and self.token != token:
                self._start(token)
            elif self.token != token:
                return {"state": "cancelled", "markedBytes": 0, "pageoutBytes": 0, "durationNs": 0}
            if phase == "pageout" and self.phase == "waiting":
                self._pageout()
            if self.phase == "pageout":
                reason, _budget = pressure_budget()
                if reason != "eligible" or _budget < CHUNK_BYTES:
                    self.phase = reason if reason != "eligible" else "no-swap"
            current_regions = {(r["start"], r["end"]): r for r in regions()} if self.phase in {"mark", "pageout"} else None
            done = 0
            while self.phase in {"mark", "pageout"} and self.index < len(self.plan):
                start, end = self.plan[self.index]
                if current_regions is not None:
                    current = current_regions.get((start, end))
                    if not current or current["locked"] or not current["rss"] or (self.phase == "pageout" and current["referenced"]):
                        self.index += 1
                        self.offset = 0
                        continue
                count = min(CHUNK_BYTES, end - start - self.offset)
                advice = MADV_COLD if self.phase == "mark" else MADV_PAGEOUT
                advice_started = time.monotonic_ns()
                result = self.libc.madvise(start + self.offset, count, advice)
                elapsed = time.monotonic_ns() - advice_started
                self.advice_ns += elapsed
                self.max_advice_ns = max(self.max_advice_ns, elapsed)
                if result != 0:
                    number = ctypes.get_errno()
                    self.phase = "unsupported" if number in {errno.EINVAL, errno.ENOSYS, errno.EPERM, errno.EACCES} else "unreclaimable"
                    break
                if advice == MADV_COLD:
                    self.marked += count
                else:
                    self.paged += count
                self.offset += count
                done += count
                if start + self.offset == end:
                    if self.phase == "mark":
                        self.marked_plan.append((start, end))
                    self.index += 1
                    self.offset = 0
                if done >= STEP_BYTES or time.monotonic_ns() - started >= STEP_NS:
                    break
            if self.phase in {"mark", "pageout"} and self.index == len(self.plan):
                if self.phase == "mark":
                    self.plan, self.index, self.offset = self.marked_plan, 0, 0
                    self.phase = "waiting" if self.plan else "unreclaimable"
                else:
                    self.phase = "complete"
            result = {"state": self.phase, "markedBytes": self.marked, "pageoutBytes": self.paged,
                      "durationNs": time.monotonic_ns() - started,
                      "adviceDurationNs": self.advice_ns, "maxAdviceDurationNs": self.max_advice_ns}
            if self.phase not in {"mark", "waiting", "pageout"}:
                after = process_memory()
                result.update(rssBefore=self.before["Rss"], rssAfter=after["Rss"],
                              swapBefore=self.before["Swap"], swapAfter=after["Swap"])
                self.plan, self.marked_plan = [], []
            elapsed = time.monotonic_ns() - started
            self.total_ns += elapsed
            self.max_step_ns = max(self.max_step_ns, elapsed)
            result.update(durationNs=elapsed, totalDurationNs=self.total_ns, maxStepDurationNs=self.max_step_ns)
            return result
        except (OSError, ValueError, AttributeError, KeyError, TypeError):
            self.phase, self.plan, self.marked_plan = "unavailable", [], []
            return {"state": "unavailable", "markedBytes": self.marked, "pageoutBytes": self.paged,
                    "durationNs": time.monotonic_ns() - started}
