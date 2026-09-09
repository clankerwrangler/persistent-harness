import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

test("grouped checkpoint sync preserves every payload, mutation, and publication boundary", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-checkpoint-durability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  const script = path.join(root, "checkpoint-durability.py");
  await writeFile(script, String.raw`
import ast
import json
import os
import stat
import sys
from pathlib import Path

source, root = map(Path, sys.argv[1:])
tree = ast.parse(source.read_text("utf-8"))
nodes = [
    node for node in tree.body
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))
    or isinstance(node, ast.Assign)
    and all(isinstance(target, ast.Name) and target.id.isupper() for target in node.targets)
]
namespace = {"__name__": "snapshot_fixture"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), namespace)
values = {"alpha": {"items": [1]}, "beta": b"stable" * 1000, "gamma": [2, 3]}
checkpoint = {"version": 1, "sessionId": "fixture", "toolCallId": "fixture",
              "actorGeneration": 1, "executionId": "fixture"}
target = root / "state"
real_fsync = os.fsync
real_publish_manifest = namespace["atomic_write_json"]
synced_inodes = set()
sync_order = []
fail_payload = False
manifest_attempted = False

def observe_sync(fd):
    info = os.fstat(fd)
    descriptor_path = Path(os.readlink(f"/proc/self/fd/{fd}"))
    if stat.S_ISREG(info.st_mode) and descriptor_path.suffix == ".dill":
        # All writes and hardlinks precede the first fsync. Syncing any one of
        # them must not publish the snapshot before the others become durable.
        assert len(list(descriptor_path.parent.glob("*.dill"))) == len(values)
        if fail_payload:
            raise OSError("fixture payload sync failure")
        synced_inodes.add((info.st_dev, info.st_ino))
        sync_order.append("payload")
    elif stat.S_ISREG(info.st_mode):
        sync_order.append("manifest")
    else:
        sync_order.append("directory")
    return real_fsync(fd)

def observe_manifest(file_path, manifest, *, durable=False):
    global manifest_attempted
    manifest_attempted = True
    if durable:
        expected = {
            (p.stat().st_dev, p.stat().st_ino)
            for p in Path(file_path).parent.glob("*.dill")
        }
        assert expected <= synced_inodes, "manifest written before every payload fsync"
    return real_publish_manifest(file_path, manifest, durable=durable)

def save(execution, durable=True):
    synced_inodes.clear()
    sync_order.clear()
    checkpoint["executionId"] = execution
    result = namespace["save_snapshot"](
        target, values, set(),
        namespace_checkpoint=dict(checkpoint) if durable else None,
    )
    if durable:
        assert sync_order.count("payload") == len(result["saved"])
        assert sync_order[:len(result["saved"])] == ["payload"] * len(result["saved"])
        assert sync_order[len(result["saved"])] == "manifest"
        assert sync_order.count("directory") == 3
    restored = {}
    report = namespace["restore_snapshot"](target, restored, set())
    assert not report["skipped"]
    assert restored == values
    return result

os.fsync = observe_sync
namespace["atomic_write_json"] = observe_manifest
try:
    first = save("first")
    assert first["stats"]["writtenBlobs"] == 3
    unchanged = save("unchanged")
    assert unchanged["stats"]["reusedBlobs"] == 3
    values["alpha"]["items"].append(2)
    mutated = save("mutated")
    assert mutated["stats"]["writtenBlobs"] == 1
    assert mutated["stats"]["reusedBlobs"] == 2

    # An ordinary checkpoint does not imply durability; promotion still syncs
    # every linked payload before its first durable manifest.
    save("ordinary", durable=False)
    promoted = save("promoted")
    assert promoted["stats"]["reusedBlobs"] == 3

    # Corrupt prior data cannot become an unchecked reused blob.
    beta = next(item for item in promoted["saved"] if item["name"] == "beta")
    (target / beta["file"]).write_bytes(b"corrupt")
    repaired = save("repaired")
    assert repaired["stats"]["writtenBlobs"] == 1

    previous_manifest = (target / "manifest.json").read_bytes()
    values["alpha"]["items"].append(3)
    fail_payload = True
    manifest_attempted = False
    try:
        save("failed")
        raise AssertionError("payload sync failure was ignored")
    except OSError as error:
        assert "fixture payload sync failure" in str(error)
    assert not manifest_attempted
    assert (target / "manifest.json").read_bytes() == previous_manifest
    restored = {}
    namespace["restore_snapshot"](target, restored, set())
    assert restored["alpha"]["items"] == [1, 2]
    assert not list(root.glob("state.snapshot-tmp-*"))
finally:
    os.fsync = real_fsync
print(json.dumps({"passed": True, "cases": 7}))
`);
  const result = await run(runtime.pythonPath, [script, path.join(packageRoot, "python-runtime", "kernel.py"), root], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: path.join(packageRoot, "python-runtime"), IPYTHONDIR: path.join(root, "ipython") },
    timeout: 25_000,
  });
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, cases: 7 });
});
