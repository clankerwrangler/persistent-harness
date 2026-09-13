import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PythonKernel } from "../src/kernel.mjs";
import { PythonRuntimeManager } from "../src/python-runtime.mjs";
import { discoverSkills, manifestForSkills } from "../src/skills.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("snapshots stay bounded, reuse verified blobs, swap atomically, and reject unsafe restores", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-snapshot-failure-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const catalog = await discoverSkills([{
    source: "skill",
    path: path.join(process.env.PI_HARNESS_SKILLS_PATH || path.join(packageRoot, "skills"), "files", "SKILL.md"),
  }]);
  const manifest = manifestForSkills(catalog.skills);
  const runtime = await new PythonRuntimeManager({ runtimeDir: path.join(root, "runtime") }).ensure({
    skills: manifest.skills,
    consent: async () => true,
  });
  const stateDir = path.join(root, "artifacts");
  const common = {
    pythonPath: runtime.pythonPath,
    kernelScript: path.join(packageRoot, "python-runtime", "kernel.py"),
    runtimeSupportDir: path.join(packageRoot, "python-runtime"),
    cwd: root,
    stateDir,
    manifest,
    hostHandlers: {},
  };
  const staleCurrent = `${stateDir}.snapshot-tmp-abandoned`;
  const staleLegacy = `${stateDir}.deadbeef`;
  const unrelatedSibling = `${stateDir}.notes`;
  await Promise.all([mkdir(staleCurrent), mkdir(staleLegacy), mkdir(unrelatedSibling)]);

  let kernel = new PythonKernel(common);
  const firstReady = await kernel.start();
  assert.equal(firstReady.snapshotCleanup.removed, 2);
  await assert.rejects(stat(staleCurrent), /ENOENT/);
  await assert.rejects(stat(staleLegacy), /ENOENT/);
  assert.equal((await stat(unrelatedSibling)).isDirectory(), true);

  await kernel.execute([
    "survivor = 91",
    "unchanged_value = ('stable', 17)",
    "corrupted_value = b'safe-copy'",
    "oversized_value = b'x' * (5 * 1024 * 1024)",
  ].join("\n"));
  const firstSnapshot = await kernel.snapshot();
  assert(firstSnapshot.skipped.some((item) => item.name === "oversized_value" && item.reason === "per-variable size limit"));
  assert.equal(firstSnapshot.stats.boundedVariables, 1);
  assert(firstSnapshot.stats.durationMs >= 0);
  assert.equal(firstSnapshot.stats.reusedBlobs, 0);
  assert.equal(firstSnapshot.stats.writtenBlobs, firstSnapshot.saved.length);
  assert.deepEqual(kernel.snapshotStats, {
    generation: 1,
    snapshotGeneration: 1,
    dirty: false,
    last: firstSnapshot.stats,
  });

  const firstByName = new Map(firstSnapshot.saved.map((item) => [item.name, item]));
  const unchangedFirst = firstByName.get("unchanged_value");
  const corruptedFirst = firstByName.get("corrupted_value");
  const unchangedInode = (await stat(path.join(stateDir, unchangedFirst.file))).ino;
  const corruptedInode = (await stat(path.join(stateDir, corruptedFirst.file))).ino;
  await writeFile(path.join(stateDir, corruptedFirst.file), Buffer.alloc(corruptedFirst.bytes, 0x78));

  await kernel.execute("changed_marker = 1");
  const reusedSnapshot = await kernel.snapshot();
  const reusedByName = new Map(reusedSnapshot.saved.map((item) => [item.name, item]));
  assert(reusedSnapshot.stats.reusedBlobs >= 2, "verified unchanged values should be hardlinked");
  assert(reusedSnapshot.stats.reusedBytes > 0);
  assert(reusedSnapshot.stats.writtenBlobs >= 2, "changed and corrupt prior blobs should be rewritten");
  assert.equal((await stat(path.join(stateDir, reusedByName.get("unchanged_value").file))).ino, unchangedInode);
  assert.notEqual(
    (await stat(path.join(stateDir, reusedByName.get("corrupted_value").file))).ino,
    corruptedInode,
    "a corrupt prior blob must be rewritten instead of reused",
  );

  const manifestBeforeClose = await stat(path.join(stateDir, "manifest.json"));
  const validManifest = await readFile(path.join(stateDir, "manifest.json"), "utf8");
  await kernel.close();
  const manifestAfterClose = await stat(path.join(stateDir, "manifest.json"));
  assert.equal(manifestAfterClose.ino, manifestBeforeClose.ino, "a clean close must not write a redundant snapshot");

  await rename(stateDir, `${stateDir}.previous`);
  kernel = new PythonKernel(common);
  const recoveredReady = await kernel.start();
  assert.equal(recoveredReady.snapshotRecovery.recovered, true);
  assert(recoveredReady.restore.restored.includes("survivor"));
  assert.equal((await kernel.execute("survivor, corrupted_value")).mime["text/plain"], "(91, b'safe-copy')");
  await kernel.execute("failed_value = 92");
  const target = stateDir;
  const previous = `${stateDir}.previous`;
  const patch = await kernel.execute([
    "import os",
    "_snapshot_original_replace = os.replace",
    "_snapshot_failed_once = False",
    "def _snapshot_fault(source, destination):",
    "    global _snapshot_failed_once",
    `    if not _snapshot_failed_once and str(destination) == ${JSON.stringify(target)} and str(source) != ${JSON.stringify(previous)}:`,
    "        _snapshot_failed_once = True",
    "        raise OSError('deliberate snapshot swap failure')",
    "    return _snapshot_original_replace(source, destination)",
    "os.replace = _snapshot_fault",
  ].join("\n"));
  assert.equal(patch.ok, true);
  await assert.rejects(kernel.snapshot(), /deliberate snapshot swap failure/);
  await kernel.execute("os.replace = _snapshot_original_replace");
  await kernel.close({ snapshot: false });
  assert.equal(
    await readFile(path.join(`${stateDir}.previous`, "manifest.json"), "utf8"),
    validManifest,
    "failed publication after direct recovery must leave .previous unpromoted",
  );

  kernel = new PythonKernel(common);
  const restored = await kernel.start();
  assert(restored.restore.restored.includes("survivor"));
  assert(!restored.restore.restored.includes("failed_value"));
  assert(restored.restore.restored.includes("unchanged_value"));
  assert(restored.restore.restored.includes("corrupted_value"));
  assert(restored.restore.skipped.some((item) => item.name === "oversized_value" && item.reason === "per-variable size limit"));
  assert.equal((await kernel.execute("survivor, corrupted_value")).mime["text/plain"], "(91, b'safe-copy')");
  await kernel.close({ snapshot: false });

  const autoState = path.join(root, "auto-snapshot");
  kernel = new PythonKernel({ ...common, stateDir: autoState });
  await kernel.start();
  await kernel.execute("auto_value = 64");
  assert.equal(kernel.snapshotStats.dirty, true);
  const autoDeadline = Date.now() + 5_000;
  while (kernel.snapshotStats.dirty && Date.now() < autoDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(kernel.snapshotStats.dirty, false, "a successful call must retain the 500ms auto-snapshot behavior");
  const autoManifestBeforeClose = await stat(path.join(autoState, "manifest.json"));
  await kernel.close();
  assert.equal(
    (await stat(path.join(autoState, "manifest.json"))).ino,
    autoManifestBeforeClose.ino,
    "close must not duplicate a completed automatic snapshot",
  );

  kernel = new PythonKernel({ ...common, stateDir: autoState });
  const autoRestore = await kernel.start();
  assert(autoRestore.restore.restored.includes("auto_value"));
  await kernel.close({ snapshot: false });

  const failedCloseState = path.join(root, "failed-close");
  kernel = new PythonKernel({ ...common, stateDir: failedCloseState });
  await kernel.start();
  const partialFailure = await kernel.execute("partial_value = 77\nraise RuntimeError('after mutation')");
  assert.equal(partialFailure.ok, false);
  assert.equal(kernel.snapshotStats.dirty, true);
  await kernel.close();

  kernel = new PythonKernel({ ...common, stateDir: failedCloseState });
  const partialRestore = await kernel.start();
  assert(partialRestore.restore.restored.includes("partial_value"));
  assert.equal((await kernel.execute("partial_value")).mime["text/plain"], "77");
  await kernel.close({ snapshot: false });

  const adversarialState = path.join(root, "adversarial-restore");
  kernel = new PythonKernel({ ...common, stateDir: adversarialState });
  await kernel.start();
  await kernel.execute("good_value = ('restored', 123)");
  const seedSnapshot = await kernel.snapshot();
  const goodSeed = seedSnapshot.saved.find((item) => item.name === "good_value");
  const goodPayload = await readFile(path.join(adversarialState, goodSeed.file));
  await kernel.close({ snapshot: false });

  await rm(adversarialState, { recursive: true, force: true });
  await mkdir(adversarialState);
  const outsideBlob = path.join(root, "outside-valid.dill");
  await writeFile(outsideBlob, goodPayload);
  const digest = (payload) => createHash("sha256").update(payload).digest("hex");
  const validItem = (name, file, overrides = {}) => ({
    name,
    file,
    bytes: goodPayload.length,
    sha256: digest(goodPayload),
    ...overrides,
  });
  const blobs = [
    "good.dill",
    "symlink.dill",
    "declared-oversize.dill",
    "duplicate-name-a.dill",
    "duplicate-name-b.dill",
    "shared.dill",
    "digest-mismatch.dill",
    "total-1.dill",
    "total-2.dill",
    "total-3.dill",
    "total-4.dill",
    "total-5.dill",
  ];
  const totalPayload = Buffer.alloc(4 * 1024 * 1024, 0x78);
  await Promise.all(blobs.filter((name) => name !== "symlink.dill").map((name) => (
    writeFile(path.join(adversarialState, name), name.startsWith("total-") ? totalPayload : goodPayload)
  )));
  await symlink("good.dill", path.join(adversarialState, "symlink.dill"));
  await mkdir(path.join(adversarialState, "directory.dill"));
  await writeFile(path.join(adversarialState, "actual-oversize.dill"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));
  await new Promise((resolve, reject) => {
    execFile(runtime.pythonPath, [
      "-c",
      "import os, sys; os.mkfifo(sys.argv[1])",
      path.join(adversarialState, "fifo.dill"),
    ], (error) => error ? reject(error) : resolve());
  });

  const emptyDigest = digest(Buffer.alloc(0));
  const fourMiB = 4 * 1024 * 1024;
  const adversarialManifest = {
    version: 1,
    saved: [
      validItem("traversal_value", "../outside-valid.dill"),
      validItem("absolute_value", outsideBlob),
      validItem("symlink_value", "symlink.dill"),
      { name: "fifo_value", file: "fifo.dill", bytes: 0, sha256: emptyDigest },
      { name: "directory_value", file: "directory.dill", bytes: 0, sha256: emptyDigest },
      validItem("declared_oversize", "declared-oversize.dill", { bytes: fourMiB + 1 }),
      validItem("actual_oversize", "actual-oversize.dill"),
      validItem("duplicate_name", "duplicate-name-a.dill"),
      validItem("duplicate_name", "duplicate-name-b.dill"),
      validItem("duplicate_file_a", "shared.dill"),
      validItem("duplicate_file_b", "shared.dill"),
      validItem("digest_mismatch", "digest-mismatch.dill", { sha256: "0".repeat(64) }),
      validItem("good_value", "good.dill"),
      ...Array.from({ length: 5 }, (_, index) => validItem(
        `total_${index + 1}`,
        `total-${index + 1}.dill`,
        { bytes: fourMiB, sha256: digest(totalPayload) },
      )),
    ],
    skipped: [],
  };
  await writeFile(
    path.join(adversarialState, "manifest.json"),
    `${JSON.stringify(adversarialManifest, null, 2)}\n`,
  );

  kernel = new PythonKernel({ ...common, stateDir: adversarialState });
  const adversarialReady = await kernel.start();
  assert.deepEqual(adversarialReady.restore.restored, ["good_value"], "one bad entry must not block an unrelated valid v1 entry");
  assert.equal((await kernel.execute("good_value")).mime["text/plain"], "('restored', 123)");
  const reasons = (name) => adversarialReady.restore.skipped
    .filter((item) => item.name === name)
    .map((item) => item.reason)
    .join("; ");
  assert.match(reasons("traversal_value"), /safe basename/);
  assert.match(reasons("absolute_value"), /safe basename/);
  assert.match(reasons("symlink_value"), /non-symlink regular file/);
  assert.match(reasons("fifo_value"), /non-symlink regular file/);
  assert.match(reasons("directory_value"), /non-symlink regular file/);
  assert.match(reasons("declared_oversize"), /declared size exceeds per-variable limit/);
  assert.match(reasons("actual_oversize"), /file exceeds 4194304 byte limit/);
  assert.equal(adversarialReady.restore.skipped.filter((item) => item.name === "duplicate_name").length, 2);
  assert.match(reasons("duplicate_name"), /duplicate snapshot name/);
  assert.match(reasons("duplicate_file_a"), /duplicate snapshot file/);
  assert.match(reasons("duplicate_file_b"), /duplicate snapshot file/);
  assert.match(reasons("digest_mismatch"), /checksum mismatch/);
  assert(
    adversarialReady.restore.skipped.some((item) => /declared total exceeds snapshot limit/.test(item.reason)),
    "declared totals beyond 16 MiB must be rejected before deserialization",
  );
  await kernel.close({ snapshot: false });

  await writeFile(path.join(adversarialState, "manifest.json"), '{"version":1,"saved":{},"skipped":[]}\n');
  kernel = new PythonKernel({ ...common, stateDir: adversarialState });
  const malformedReady = await kernel.start();
  assert.deepEqual(malformedReady.restore.restored, []);
  assert(malformedReady.restore.skipped.some((item) => item.name === "*" && /saved must be an array/.test(item.reason)));
  await kernel.close({ snapshot: false });

  const strictState = path.join(root, "strict-schema");
  const strictItem = validItem("strict_value", "good.dill");
  const strictManifest = {
    version: 1,
    saved: [strictItem],
    skipped: [],
    totalBytes: goodPayload.length,
  };
  const restoreRawManifest = async (manifestText) => {
    await rm(strictState, { recursive: true, force: true });
    await mkdir(strictState);
    await writeFile(path.join(strictState, "good.dill"), goodPayload);
    await writeFile(path.join(strictState, "manifest.json"), manifestText);
    const strictKernel = new PythonKernel({ ...common, stateDir: strictState });
    const ready = await strictKernel.start();
    await strictKernel.close({ snapshot: false });
    return ready;
  };
  const assertRejected = async (manifestText, reasonPattern, expectedRestored = []) => {
    const ready = await restoreRawManifest(manifestText);
    assert.deepEqual(ready.restore.restored, expectedRestored);
    assert(ready.restore.skipped.some((item) => reasonPattern.test(item.reason)), ready.restore.skipped);
  };

  const strictTail = `"saved":[${JSON.stringify(strictItem)}],"skipped":[],"totalBytes":${goodPayload.length}}`;
  await assertRejected(`{"version":999,"version":1,${strictTail}`, /duplicate JSON member: version/);
  await assertRejected(
    `{"version":1,"saved":[{"name":"evil","name":"strict_value","file":"good.dill","bytes":${goodPayload.length},"sha256":"${digest(goodPayload)}"}],"skipped":[],"totalBytes":${goodPayload.length}}`,
    /duplicate JSON member: name/,
  );
  await assertRejected(
    `{"version":1,"saved":[{"name":"strict_value","file":"evil.dill","file":"good.dill","bytes":${goodPayload.length},"sha256":"${digest(goodPayload)}"}],"skipped":[],"totalBytes":${goodPayload.length}}`,
    /duplicate JSON member: file/,
  );
  await assertRejected(JSON.stringify({ ...strictManifest, extra: true }), /manifest has unknown keys: extra/);
  await assertRejected(
    JSON.stringify({ ...strictManifest, totalBytes: undefined, saved: [{ ...strictItem, extra: true }] }),
    /saved entry has unknown keys: extra/,
  );
  await assertRejected(
    JSON.stringify({ version: 1, saved: [strictItem], skipped: [{ name: "old", reason: "test", extra: true }] }),
    /invalid manifest skipped entry: unknown keys: extra/,
    ["strict_value"],
  );
  await assertRejected(
    JSON.stringify({
      ...strictManifest,
      stats: {
        attemptedVariables: 1,
        serializedVariables: 1,
        boundedVariables: 0,
        reusedBlobs: 0,
        reusedBytes: 0,
        writtenBlobs: 1,
        writtenBytes: goodPayload.length,
        durationMs: 1,
        extra: true,
      },
    }),
    /manifest stats has unknown keys: extra/,
  );
  await assertRejected(JSON.stringify({ ...strictManifest, totalBytes: 0 }), /totalBytes mismatch/);
  await assertRejected(
    JSON.stringify({
      ...strictManifest,
      stats: {
        attemptedVariables: 1,
        serializedVariables: 1,
        boundedVariables: 0,
        reusedBlobs: 0,
        reusedBytes: 0,
        writtenBlobs: 1,
        writtenBytes: 0,
        durationMs: 1,
      },
    }),
    /stats byte total mismatch/,
  );

  const canonicalStats = {
    attemptedVariables: 1,
    serializedVariables: 1,
    boundedVariables: 0,
    reusedBlobs: 0,
    reusedBytes: 0,
    writtenBlobs: 1,
    writtenBytes: goodPayload.length,
    durationMs: 1,
  };
  for (const nonfinite of ["NaN", "Infinity", "-Infinity"]) {
    await assertRejected(
      JSON.stringify({ ...strictManifest, stats: canonicalStats }).replace('"durationMs":1', `"durationMs":${nonfinite}`),
      new RegExp(`non-finite JSON number: ${nonfinite.replace("-", "\\-")}`),
    );
  }
  await assertRejected(
    JSON.stringify({
      ...strictManifest,
      stats: {
        ...canonicalStats,
        reusedBytes: goodPayload.length,
        writtenBytes: 0,
      },
    }),
    /reused\/written attribution is impossible/,
  );
  await assertRejected(
    JSON.stringify({
      version: 1,
      saved: [
        { name: "subset_a", file: "a.dill", bytes: 2, sha256: "0".repeat(64) },
        { name: "subset_b", file: "b.dill", bytes: 4, sha256: "1".repeat(64) },
      ],
      skipped: [],
      totalBytes: 6,
      stats: {
        attemptedVariables: 2,
        serializedVariables: 2,
        boundedVariables: 0,
        reusedBlobs: 1,
        reusedBytes: 3,
        writtenBlobs: 1,
        writtenBytes: 3,
        durationMs: 1,
      },
    }),
    /reused\/written attribution is impossible/,
  );
  await assertRejected(
    JSON.stringify({
      version: 1,
      saved: [strictItem],
      skipped: [
        { name: "duplicate_skip", reason: "first" },
        { name: "duplicate_skip", reason: "second" },
      ],
    }),
    /duplicate snapshot name/,
    ["strict_value"],
  );
  await assertRejected(
    JSON.stringify({
      version: 1,
      saved: [strictItem],
      skipped: [{ name: "strict_value", reason: "overlap" }],
    }),
    /also appears in (saved|skipped)/,
  );
  const overlapItem = validItem("x", "good.dill");
  for (const skippedEntry of [
    '{"name":"x","reason":7}',
    '{"reason":7,"name":"x"}',
  ]) {
    await assertRejected(
      `{"version":1,"saved":[${JSON.stringify(overlapItem)}],"skipped":[${skippedEntry}],"totalBytes":${goodPayload.length}}`,
      /name and reason must be strings.*also appears in saved/,
    );
  }
  await assertRejected(
    JSON.stringify({
      version: 1,
      saved: [overlapItem],
      skipped: [
        { name: "x", reason: 7 },
        { name: "x", reason: "second" },
      ],
      totalBytes: goodPayload.length,
    }),
    /name and reason must be strings.*duplicate snapshot name.*also appears in saved/,
  );

  const raceScript = path.join(root, "snapshot-recovery-race.py");
  await writeFile(raceScript, String.raw`
import ast
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

kernel_path, fixture_root = map(Path, sys.argv[1:])
tree = ast.parse(kernel_path.read_text("utf-8"), filename=str(kernel_path))
constant_names = {"SNAPSHOT_VERSION", "PER_VARIABLE_LIMIT", "TOTAL_SNAPSHOT_LIMIT", "MANIFEST_LIMIT"}
nodes = []
for node in tree.body:
    if isinstance(node, ast.ImportFrom) and node.module == "__future__":
        nodes.append(node)
    elif isinstance(node, ast.Import) and all(alias.name != "dill" for alias in node.names):
        nodes.append(node)
    elif isinstance(node, ast.ImportFrom) and node.module not in {"IPython.core.interactiveshell", "_persistent_harness"}:
        nodes.append(node)
    elif isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        nodes.append(node)
    elif isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in constant_names for target in node.targets):
        nodes.append(node)
namespace = {}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(kernel_path), "exec"), namespace)

fixture_root.mkdir()
previous = fixture_root / "state.previous"
target = fixture_root / "state"
replacement = fixture_root / "replacement"
validated_hold = fixture_root / "validated-hold"
for directory in (previous, target, replacement):
    directory.mkdir()
payload = b"validated snapshot bytes"
item = {
    "name": "race_value",
    "file": "good.dill",
    "bytes": len(payload),
    "sha256": hashlib.sha256(payload).hexdigest(),
}
(previous / "good.dill").write_bytes(payload)
(previous / "manifest.json").write_text(json.dumps({
    "version": 1,
    "saved": [item],
    "skipped": [],
    "totalBytes": len(payload),
}), "utf-8")
(replacement / "manifest.json").write_text('{"version":999,"saved":[]}', "utf-8")
config_payload = b"config target must survive"
(target / "kernel-config.json").write_bytes(config_payload)

original_validate = namespace["validate_snapshot_directory"]
swapped = False
def swapping_validate(snapshot_path, **kwargs):
    global swapped
    result = original_validate(snapshot_path, **kwargs)
    if not swapped and Path(snapshot_path) == previous and result["complete"]:
        swapped = True
        os.replace(previous, validated_hold)
        os.replace(replacement, previous)
    return result
namespace["validate_snapshot_directory"] = swapping_validate

def forbidden_mutation(*args, **kwargs):
    raise AssertionError(f"recovery attempted filesystem mutation: {args!r}")
namespace["tempfile"].mkdtemp = forbidden_mutation
namespace["shutil"].rmtree = forbidden_mutation
namespace["os"].link = forbidden_mutation
namespace["os"].unlink = forbidden_mutation
namespace["os"].fsync = forbidden_mutation

report = namespace["recover_previous_snapshot"](target)
assert swapped
assert report["recovered"], report
assert "without publication" in report["reason"]
validation = report["_validation"]
assert validation["complete"]
assert validation["entries"][0]["payload"] == payload
assert validation["entries"][0]["item"] == item
assert (target / "kernel-config.json").read_bytes() == config_payload
assert set(path.name for path in target.iterdir()) == {"kernel-config.json"}
assert not original_validate(previous)["complete"]
assert original_validate(validated_hold)["complete"]
`);
  await new Promise((resolve, reject) => {
    execFile(runtime.pythonPath, [raceScript, common.kernelScript, path.join(root, "recovery-race")], (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve();
    });
  });
});
