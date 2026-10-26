"""Private ordinary-cell state used by paging qualification."""
import ctypes
import hashlib
import json
import mmap
import os
import sqlite3
import time
from pathlib import Path

connection = sqlite3.connect(":memory:")
connection.execute("create table state(value integer)")
connection.execute("insert into state values (41)")
connection_alias = connection
sentinel = {"token":"persistent-state","values":[1,2,3]}
sentinel_alias = sentinel
native_buffer = mmap.mmap(-1, 32*1024*1024, flags=mmap.MAP_PRIVATE|mmap.MAP_ANONYMOUS,
                          prot=mmap.PROT_READ|mmap.PROT_WRITE)
buffer_alias = native_buffer
for offset in range(0, len(native_buffer), 4096):
    native_buffer[offset:offset+4096] = bytes([offset//4096 % 251])*4096
native_address = ctypes.addressof(ctypes.c_char.from_buffer(native_buffer))
original_identity = (id(connection),id(sentinel),id(native_buffer),native_address,os.getpid())
started=time.perf_counter_ns()
original_digest=hashlib.sha256(native_buffer).hexdigest()
baseline_read_ns=time.perf_counter_ns()-started


def fixture_environment_memory():
    # Numeric evidence only; all cgroup/host deltas include unrelated workloads.
    from _linux_memory import _placement
    def read(path, limit):
        with open(path, "rb") as stream:
            data=stream.read(limit+1)
        if len(data)>limit: raise ValueError("fixture read bound")
        return data.decode("ascii")
    place=_placement(read("/proc/self/cgroup",4096),read("/proc/self/mountinfo",128*1024))
    result={"sharedWorkloadConfounds":True}
    if place:
        leaf=place[1]
        stats={line.split()[0]:int(line.split()[1]) for line in read(str(leaf/"memory.stat"),16384).splitlines()}
        result["cgroup"]={key:stats.get(key) for key in ("anon","inactive_anon","swapcached")}
        result["cgroup"].update(current=int(read(str(leaf/"memory.current"),128)),swap_current=int(read(str(leaf/"memory.swap.current"),128)))
    info={line.split()[0][:-1]:int(line.split()[1])*1024 for line in read("/proc/meminfo",16384).splitlines() if line.split()[0] in {"MemAvailable:","AnonPages:","SwapCached:","SwapFree:","Writeback:"}}
    vm={line.split()[0]:int(line.split()[1]) for line in read("/proc/vmstat",128*1024).splitlines() if line.split()[0] in {"pswpin","pswpout"}}
    result.update(host=info,vmstat=vm)
    return result
