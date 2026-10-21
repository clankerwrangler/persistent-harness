"""One fresh public Node fixture; no SDK, session state, or live collection."""
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def run():
    memory = runpy.run_path(str(ROOT / "skills/operations/src/harness_operations/_memory.py"))["collect"]()
    assert memory["estimated_available_bytes"] is not None
    assert memory["estimated_available_bytes"] >= 805306368 + 192*1024*1024, "fixture reserve"
    for view in [memory["host"], *memory["hierarchy"]]:
        assert view["pressure"] and all(view["pressure"][k]["avg10"] == 0 for k in ["some", "full"]), "actual memory pressure"
    with tempfile.TemporaryDirectory(prefix="idle-memory-public-", dir="/tmp") as directory:
        result = subprocess.run(["/usr/local/bin/node", "--expose-gc", "--trace-gc-verbose",
            str(ROOT / "test/fixtures/idle-memory-public.mjs")], cwd=directory,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            capture_output=True, text=True, timeout=35)
    assert result.returncode == 0, result.stdout[-3000:] + result.stderr[-3000:]
    assert len(result.stdout)+len(result.stderr) < 2*1024*1024
    trace = result.stdout + result.stderr
    assert "Mark-Compact (reduce)" in trace, "actual V8 memory-reducing collection"
    payload = json.loads(next(line[7:] for line in trace.splitlines() if line.startswith("RESULT ")))
    payload["pressure_before"] = memory
    payload["trace_gc"] = [line for line in trace.splitlines() if "Mark-Compact" in line or "Pool buffering" in line]
    return payload

if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
