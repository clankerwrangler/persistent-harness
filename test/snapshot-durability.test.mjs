import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
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
    node for node in [child for parent in tree.body for child in (parent.body if isinstance(parent, ast.Try) else [parent])]
    if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))
    or isinstance(node, ast.Assign)
    and all(isinstance(target, ast.Name) and target.id.isupper() for target in node.targets)
]
namespace = {"__name__": "snapshot_fixture"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), "exec"), namespace)
values = {"alpha": {"items": [1]}, "beta": b"stable" * 1000, "gamma": [2, 3]}
values["alias"] = values["alpha"]
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
    assert restored["alias"] is restored["alpha"]
    blobs = [target / item["file"] for item in result["saved"]]
    assert len({p.stat().st_ino for p in blobs}) == len(blobs)
    return result

os.fsync = observe_sync
namespace["atomic_write_json"] = observe_manifest
try:
    first = save("first")
    assert first["stats"]["writtenBlobs"] == 4
    unchanged = save("unchanged")
    assert unchanged["stats"]["reusedBlobs"] == 4
    values["alpha"]["items"].append(2)
    mutated = save("mutated")
    assert mutated["stats"]["writtenBlobs"] == 2
    assert mutated["stats"]["reusedBlobs"] == 2

    # An ordinary checkpoint does not imply durability; promotion still syncs
    # every linked payload before its first durable manifest.
    save("ordinary", durable=False)
    promoted = save("promoted")
    assert promoted["stats"]["reusedBlobs"] == 4

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
    namespace["atomic_write_json"] = real_publish_manifest

# Root groups change restore ownership, not independent source serialization.
import gc
import hashlib
import weakref
save_root = namespace["save_snapshot"]
restore_root = namespace["restore_snapshot"]
fixture = root / "root-alias"

def save_values(values, protected=set()):
    return save_root(fixture, values, protected)

def publish(manifest):
    manifest.pop("stats", None)
    manifest["totalBytes"] = sum(item["bytes"] for item in manifest["saved"])
    (fixture / "manifest.json").write_text(json.dumps(manifest))

def load_values(protected=set(), existing=None):
    restored = {} if existing is None else existing
    report = restore_root(fixture, restored, protected)
    return restored, report

shared = []
for fault in ("corrupt", "missing", "unloadable", "malformed", "protected", "private", "legacy"):
    manifest = save_values(dict(a=shared, b=shared, c=shared, d=[]))
    owner = manifest["saved"][0]
    protected = set()
    sentinel = object()
    existing = {"a": sentinel, "_private": sentinel}
    if fault == "corrupt":
        (fixture / owner["file"]).write_bytes(b"bad")
    elif fault == "missing":
        (fixture / owner["file"]).unlink()
    elif fault == "unloadable":
        payload = b"not a pickle"
        (fixture / owner["file"]).write_bytes(payload)
        owner.update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        publish(manifest)
    elif fault == "malformed":
        owner["name"] = None
        publish(manifest)
    elif fault == "protected":
        protected.add("a")
    elif fault == "private":
        owner["name"] = "_private"
        publish(manifest)
    else:
        manifest["version"] = 1
        publish(manifest)
    restored, report = load_values(protected, existing)
    assert restored["b"] is not restored["d"]
    if fault == "legacy":
        assert restored["a"] is not restored["b"] and restored["b"] is not restored["c"]
    else:
        assert restored["a"] is sentinel and restored["_private"] is sentinel
        assert restored["b"] is restored["c"], fault
        assert report["skipped"], fault

# Even when the owner decoded, every alias must pass its own descriptor/hash check.
for fault in ("corrupt", "symlink"):
    manifest = save_values(dict(a=shared, b=shared, c=shared))
    backup = fixture / manifest["saved"][1]["file"]
    backup.unlink()
    if fault == "corrupt":
        backup.write_bytes(b"bad")
    else:
        backup.symlink_to(manifest["saved"][0]["file"])
    restored, report = load_values()
    assert "b" not in restored and restored["a"] is restored["c"]
    assert any(item["name"] == "b" for item in report["skipped"])

# Invalid group shape/order/owner cannot merge a distinct healthy root.
for fault in ("token", "forward", "reorder", "wrong-owner"):
    manifest = save_root(fixture, dict(a=shared, b=shared, c=[], d=[]), set(), namespace_checkpoint=dict(checkpoint))
    if fault == "reorder":
        manifest["saved"][0], manifest["saved"][1] = manifest["saved"][1], manifest["saved"][0]
    else:
        item = manifest["saved"][2]
        old_file = fixture / item["file"]
        item["file"] = {"token":"bad.dill", "forward":"000002-000000000003.dill",
                        "wrong-owner":"000002-000000000001.dill"}[fault]
        old_file.rename(fixture / item["file"])
    publish(manifest)
    restored, report = load_values()
    assert report["skipped"]
    assert set(restored) == {"a", "b", "c", "d"}
    assert report["namespaceCheckpoint"] is None
    assert restored["c"] is not restored["d"] and restored["a"] is not restored["c"]
    if fault == "reorder":
        assert restored["a"] is not restored["b"]
    else:
        assert restored["a"] is restored["b"]

class Counted:
    def __init__(self, failure=None):
        self.calls = 0
        self.failure = failure
    def __reduce__(self):
        self.calls += 1
        if self.calls == 1 and self.failure == "error":
            raise ValueError("first source dump fails")
        if self.calls == 1 and self.failure == "size":
            return list, ([b"x" * (namespace["PER_VARIABLE_LIMIT"] + 1)],)
        return list, ([self.calls],)

for failure in (None, "error", "size"):
    counted = Counted(failure)
    manifest = save_values(dict(a=counted, b=counted, c=counted))
    assert counted.calls == 3
    expected_names = ["a", "b", "c"] if failure is None else ["b", "c"]
    assert [item["name"] for item in manifest["saved"]] == expected_names
    assert [namespace["dill"].loads((fixture / item["file"]).read_bytes())
            for item in manifest["saved"]] == ([[1], [2], [3]] if failure is None else [[2], [3]])
    assert all(item["file"].endswith("-000000000000.dill") for item in manifest["saved"])
    restored, report = load_values()
    assert restored["b"] is restored["c"]
    assert restored["b"] == ([1] if failure is None else [2])

manifest = save_values(dict(a=shared, b=shared, c=shared, _private=shared), {"a"})
assert [item["name"] for item in manifest["saved"]] == ["b", "c"]
restored, report = load_values()
assert restored["b"] is restored["c"]

# Simulate a reused address to exercise the strong identity guard deterministically.
namespace["id"] = lambda value: 1
try:
    distinct = []
    save_values(dict(a=[], b=distinct, c=distinct))
    restored, report = load_values()
    assert restored["a"] is not restored["b"] and restored["b"] is restored["c"]
finally:
    del namespace["id"]

class Ephemeral(list):
    pass
values = {"a": Ephemeral(), "c": None}
reference = weakref.ref(values["a"])
class Mutating:
    def __reduce__(self):
        values["a"] = []
        values["c"] = []
        gc.collect()
        assert reference() is not None, "admitted source identity lost during later reducer"
        return list, ([],)
values["b"] = Mutating()
manifest = save_values(values)
assert not manifest["skipped"]
restored, report = load_values()
assert not report["skipped"] and "b" in restored
assert restored["a"] is not restored["c"]

# All original independent payload budgets remain available, including aliases.
limit = namespace["PER_VARIABLE_LIMIT"]
overhead = len(namespace["dill"].dumps(b"x" * 100_000)) - 100_000
large = b"x" * (limit - overhead)
assert len(namespace["dill"].dumps(large)) == limit
manifest = save_values(dict(a=large, b=large, c=large, d=large, e=None))
assert manifest["totalBytes"] == namespace["TOTAL_SNAPSHOT_LIMIT"] == 16 * 1024 * 1024
assert len(manifest["saved"]) == 4
assert manifest["skipped"] == [{"name":"e", "reason":"total snapshot size limit"}]
restored, report = load_values()
assert restored["a"] is restored["b"] is restored["c"] is restored["d"]
del large, restored

# Fixed-width group tokens cost no manifest bytes, even at the original 1 MiB edge.
real_clock = namespace["time"].perf_counter
namespace["time"].perf_counter = lambda: 0.0
try:
    # Use fresh targets for both width witnesses so write/reuse stats match.
    import shutil
    shutil.rmtree(fixture)
    manifest = save_values(dict(a=shared, b=shared))
    size = len((fixture / "manifest.json").read_bytes())
    shutil.rmtree(fixture)
    long_name = "b" * (1 + namespace["MANIFEST_LIMIT"] - size)
    manifest = save_values({"a": shared, long_name: shared})
    assert (fixture / "manifest.json").stat().st_size == namespace["MANIFEST_LIMIT"] == 1024 * 1024
    legacy = json.loads(json.dumps(manifest))
    legacy["version"] = 1
    for index, item in enumerate(legacy["saved"]):
        item["file"] = f"{index:06d}-{hashlib.sha256(item['name'].encode()).hexdigest()[:12]}.dill"
    assert len(json.dumps(legacy, indent=2, sort_keys=True) + "\n") == namespace["MANIFEST_LIMIT"]
    restored, report = load_values()
    assert not report["skipped"] and restored["a"] is restored[long_name]
finally:
    namespace["time"].perf_counter = real_clock

print(json.dumps({"passed": True, "cases": 7, "rootAliases": True}))
`);
  const result = await run(runtime.pythonPath, [script, path.join(packageRoot, "python-runtime", "kernel.py"), root], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: path.join(packageRoot, "python-runtime"), IPYTHONDIR: path.join(root, "ipython") },
    timeout: 25_000,
  });
  assert.deepEqual(JSON.parse(result.stdout), { passed: true, cases: 7, rootAliases: true });
});


test("fresh workers restore top-level aliases in ordinary and durable checkpoints", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-root-alias-workers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: [], consent: async () => true,
  });
  for (const durable of [false, true]) {
    const common = { pythonPath: runtime.pythonPath, kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
      runtimeSupportDir: path.join(packageRoot, "python-runtime"), cwd: root,
      stateDir: path.join(root, String(durable)), manifest: { skills: [] }, hostHandlers: {} };
    let kernel = new PythonKernel(common);
    t.after(() => kernel.close({ snapshot: false }));
    await kernel.start();
    const result = await kernel.execute([
      "a = []; b = a; c = a; distinct = []",
      "nested = [[], []]; nested[1] = nested[0]; nested_alias = nested",
      "def f(x): return x + 1", "g = f", "class C: pass", "D = C",
    ].join("\n"), durable ? { namespaceCheckpoint: {
      version: 1, sessionId: "fixture", toolCallId: "fixture", actorGeneration: 1,
    } } : {});
    assert.equal(result.ok, true);
    await kernel.snapshot();
    await kernel.close({ snapshot: false });
    kernel = new PythonKernel(common);
    const ready = await kernel.start();
    assert.deepEqual(ready.restore.skipped, []);
    assert.equal(Boolean(ready.restore.namespaceCheckpoint), durable);
    const restored = await kernel.execute([
      "assert a is b is c and a is not distinct", "b.append(7)", "assert a == c == [7] and distinct == []",
      "assert nested is nested_alias and nested[0] is nested[1]", "nested_alias[0].append(8)",
      "assert nested[1] == [8]", "assert f is g and C is D", "assert f(1) == 2",
    ].join("\n"));
    assert.equal(restored.ok, true, restored.stderr);
    await kernel.close({ snapshot: false });
  }
});
