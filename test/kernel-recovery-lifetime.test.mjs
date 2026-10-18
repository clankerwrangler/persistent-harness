import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("startup releases descriptor-bound recovery bytes only after actual restore finishes", () => {
  const source = fileURLToPath(new URL("../python-runtime/kernel.py", import.meta.url));
  const script = String.raw`
import ast, gc, pickle, sys, types, weakref
source = open(sys.argv[1], encoding="utf-8").read()
module = ast.parse(source)
restore = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "restore_validated_snapshot")
start = source.index('snapshot_recovery_report = recover_previous_snapshot(')
end = source.index('\nemit({', start)
startup = source[start:end]
class Validation(dict):
    pass
for fail in (False, True):
    observed = []
    def recover(_):
        validation = Validation(complete=True, manifest={"namespaceCheckpoint": {"version": 1}},
            skipped=[], errors=[], entries=[{"item": {"name": "public_value"}, "payload": pickle.dumps({"public": "captured bytes"})}])
        observed.append(weakref.ref(validation))
        return {"recovered": True, "_validation": validation}
    def load(payload):
        assert observed[0]() is not None, "descriptor-bound bytes released before restore"
        if fail:
            raise ValueError("synthetic decode failure")
        return pickle.loads(payload)
    context = {"config": {"snapshotPath": "public-unused"}, "shell": types.SimpleNamespace(user_ns={}),
        "protected_names": set(), "recover_previous_snapshot": recover,
        "cleanup_stale_snapshot_temps": lambda _: {}, "dill": types.SimpleNamespace(loads=load)}
    exec(compile(ast.Module(body=[restore], type_ignores=[]), source, "exec"), context)
    exec(compile(startup, source, "exec"), context)
    gc.collect()
    assert context["recovery_validation"] is None
    assert observed[0]() is None, "validated serialized payloads leaked into ready runtime"
    report = context["restore_report"]
    assert report["found"] is True
    assert report["namespaceCheckpoint"] == {"version": 1}
    if fail:
        assert report["restored"] == [] and report["skipped"][0]["name"] == "public_value"
    else:
        assert context["shell"].user_ns["public_value"] == {"public": "captured bytes"}
        assert report["restored"] == ["public_value"]
`;
  const result = spawnSync("python3", ["-I", "-c", script, source], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
