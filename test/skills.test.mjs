import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverSkills, discoverSkillsFromDirectory, manifestForSkills, parsePythonBacking, parseSkillMarkdown, skillCatalogForSkills, skillDirectoryFingerprint, verifyManifest, writeManifestAtomic } from "../src/skills.mjs";

async function createSkill(root, directory, markdown, pyproject, moduleSource) {
  const skillDir = path.join(root, directory);
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await writeFile(skillPath, markdown);
  if (pyproject) await writeFile(path.join(skillDir, "pyproject.toml"), pyproject);
  if (moduleSource) {
    const moduleDir = path.join(skillDir, "src", "backed_skill");
    await mkdir(moduleDir, { recursive: true });
    await writeFile(path.join(moduleDir, "__init__.py"), moduleSource);
  }
  return { source: "skill", path: skillPath };
}

test("parses the unified SKILL.md contract with optional Python backing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guidance = await createSkill(
    root,
    "workflow",
    "---\nname: workflow\ndescription: Follow a careful workflow.\n---\n\n# Workflow\n\nAlways verify the result.\n",
    "[project]\nname = \"unrelated-helper-project\"\nversion = \"1.0.0\"\n",
  );
  const backed = await createSkill(
    root,
    "backed",
    "---\nname: backed\ndescription: Execute a backed operation.\n---\n\n# Backed\n\nCall `backed.run()`.\n",
    "[project]\nname = \"backed-package\"\nversion = \"1.2.3\"\nrequires-python = \">=3.11\"\ndependencies = []\n\n[tool.persistent-harness]\nid = \"backed\"\nimport-name = \"backed_skill\"\nalias = \"backed\"\nentry-point = \"run\"\nhost-requests = [\"demo.echo\"]\n",
    "def run(value='ok'):\n    return value\n",
  );

  const catalog = await discoverSkills([guidance, backed]);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.skills.map((skill) => [skill.id, skill.alias, Boolean(skill.python)]), [
    ["backed", "backed", true],
    ["workflow", "workflow", false],
  ]);
  const originalHash = catalog.skills[0].contentHash;
  await mkdir(path.join(root, "backed", "src", "backed_skill", "__pycache__"));
  await writeFile(path.join(root, "backed", "src", "backed_skill", "__pycache__", "generated.pyc"), "generated");
  await writeFile(path.join(root, "backed", "temporary.tmp"), "generated");
  assert.equal((await discoverSkills([backed])).skills[0].contentHash, originalHash);

  const manifest = manifestForSkills(catalog.skills);
  assert.equal(manifest.skills[0].python.entryPoint, "run");
  assert.deepEqual(manifest.skills[0].python.hostRequests, ["demo.echo"]);
  assert.equal(manifest.skills[1].python, null);
  assert.match(manifest.skills[1].instructions, /Always verify/);

  const manifestPath = path.join(root, "artifacts", "skill-manifest.json");
  assert.equal(await writeManifestAtomic(manifestPath, manifest), true);
  const firstIdentity = await lstat(manifestPath);
  await chmod(manifestPath, 0o644);
  assert.equal(await writeManifestAtomic(manifestPath, manifest), false);
  const secondIdentity = await lstat(manifestPath);
  assert.equal(secondIdentity.ino, firstIdentity.ino, "unchanged prompt sidecars must not be replaced");
  assert.equal(secondIdentity.mode & 0o777, 0o600, "an unchanged sidecar must retain private permissions");
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
  assert.deepEqual(await verifyManifest(manifest), manifest);
  await writeFile(path.join(root, "backed", "SKILL.md"), "---\nname: backed\ndescription: Changed.\n---\n");
  await assert.rejects(verifyManifest(manifest), /persisted skill changed/);
});

test("reports malformed backing instead of silently degrading it to guidance-only", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-bad-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await createSkill(
    root,
    "bad",
    "---\nname: bad\ndescription: Invalid backing fixture.\n---\n\n# Bad\n",
    "[project]\nname = \"bad\"\nversion = \"1.0.0\"\n\n[tool.persistent-harness]\nid = \"other\"\nimport-name = \"bad\"\nalias = \"bad\"\nhost-requests = []\n",
    "",
  );
  const catalog = await discoverSkills([command]);
  assert.equal(catalog.skills.length, 0);
  assert.equal(catalog.diagnostics.length, 1);
  assert.match(catalog.diagnostics[0].error, /id must equal/);
});

test("rejects invalid markdown, TOML, duplicate aliases, and duplicate IDs", async (t) => {
  assert.throws(() => parseSkillMarkdown("# no frontmatter", "/bad/SKILL.md"), /frontmatter/);
  assert.throws(() => parsePythonBacking("[project]\nname = \"x\"", "/bad/pyproject.toml"), /requires/);

  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = await createSkill(root, "one", "---\nname: one-two\ndescription: First.\n---\n", null, null);
  const aliasCollision = await createSkill(
    root,
    "alias",
    "---\nname: other\ndescription: Alias collision.\n---\n",
    "[project]\nname = \"other\"\nversion = \"1.0.0\"\ndependencies = []\n\n[tool.persistent-harness]\nid = \"other\"\nimport-name = \"backed_skill\"\nalias = \"one_two\"\nhost-requests = []\n",
    "VALUE = 1\n",
  );
  await assert.rejects(discoverSkills([one, aliasCollision]), /duplicate skill Python alias/);

  const duplicate = await createSkill(root, "duplicate", "---\nname: one-two\ndescription: Duplicate.\n---\n", null, null);
  await assert.rejects(discoverSkills([one, duplicate]), /duplicate skill ID/);
});


test("discovers an intentional local skill directory as a deterministic grant catalog", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-directory-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createSkill(root, "z-last", "---\nname: z-last\ndescription: Last skill.\n---\n", null, null);
  await createSkill(root, "a-first", "---\nname: a-first\ndescription: First skill.\n---\n", null, null);
  await mkdir(path.join(root, "not-a-skill"));
  const catalog = await discoverSkillsFromDirectory(root);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.skills.map((skill) => skill.id), ["a-first", "z-last"]);
  assert.deepEqual(skillCatalogForSkills(catalog.skills).map((skill) => Object.keys(skill)), [
    ["id", "version", "contentHash", "skillPath", "pythonBacked"],
    ["id", "version", "contentHash", "skillPath", "pythonBacked"],
  ]);
});


test("directory discovery cache uses metadata invalidation without missing same-size skill changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-skill-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = "---\nname: exact\ndescription: Alpha text.\n---\n\nAAAA\n";
  const changed = "---\nname: exact\ndescription: Bravo text.\n---\n\nBBBB\n";
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(changed));
  const command = await createSkill(root, "exact", original, null, null);
  const skillPath = command.path;

  const firstFingerprint = await skillDirectoryFingerprint(root);
  const first = await discoverSkillsFromDirectory(root);
  first.skills[0].description = "caller mutation";
  await writeFile(path.join(root, "exact", "ignored.tmp"), "generated");
  assert.equal(await skillDirectoryFingerprint(root), firstFingerprint,
    "ignored build artifacts must not invalidate the discovery cache");
  assert.equal((await discoverSkillsFromDirectory(root)).skills[0].description, "Alpha text.",
    "cached catalogs must be isolated from caller mutation");

  const before = await lstat(skillPath);
  await writeFile(skillPath, changed);
  await utimes(skillPath, before.atime, before.mtime);
  const secondFingerprint = await skillDirectoryFingerprint(root);
  assert.notEqual(secondFingerprint, firstFingerprint,
    "ctime must invalidate a same-size rewrite even when mtime is restored");
  const second = await discoverSkillsFromDirectory(root);
  assert.equal(second.skills[0].description, "Bravo text.");
  assert.notEqual(second.skills[0].contentHash, first.skills[0].contentHash);
});

async function withReadCounts(operation) {
  const original = fs.readFile;
  const reads = new Map();
  fs.readFile = async function (file, ...args) {
    const key = String(file);
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try {
    return await operation(reads);
  } finally {
    fs.readFile = original;
    syncBuiltinESMExports();
  }
}

function backedFixtureHash(markdown, pyproject, moduleSource, nested) {
  const digest = createHash("sha256");
  if (nested) digest.update("d:nested\0f:nested/SKILL.md\0").update(nested).update("\0\0");
  return digest.update("f:pyproject.toml\0").update(pyproject).update("\0")
    .update("f:SKILL.md\0").update(markdown).update("\0")
    .update("d:src\0d:src/backed_skill\0f:src/backed_skill/__init__.py\0")
    .update(moduleSource).update("\0\0\0").digest("hex");
}

const rawMarkdown = Buffer.concat([
  Buffer.from("---\r\nname: raw\r\ndescription: Public é🙂 fixture.\r\n---\r\n\r\nRaw bytes "),
  Buffer.from([255]), Buffer.from("\r\n"),
]);
const rawPyproject = Buffer.concat([
  Buffer.from('[project]\nname = "raw"\nversion = "1"\ndependencies = []\n'
    + '[tool.persistent-harness]\nid = "raw"\nimport-name = "backed_skill"\nalias = "raw"\nhost-requests = ["demo.echo"]\n'),
  Buffer.from("# Preserve raw backing bytes "), Buffer.from([255]), Buffer.from("\r\n"),
]);
const rawModule = "VALUE = 1\n";

test("skill loads reuse exact raw metadata bytes only at their full traversal paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-raw-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await createSkill(root, "raw", rawMarkdown, rawPyproject, rawModule);
  const dir = path.dirname(command.path);
  const backing = path.join(dir, "pyproject.toml");
  const source = path.join(dir, "src", "backed_skill", "__init__.py");
  const nested = Buffer.from("Nested metadata is a different file.\r\n");
  await mkdir(path.join(dir, "nested"));
  await writeFile(path.join(dir, "nested", "SKILL.md"), nested);
  const ignored = ["generated.pyc", "generated.pyo", "scratch.tmp"];
  for (const name of ignored) await writeFile(path.join(dir, name), "ignored");
  for (const name of ["__pycache__", ".git", "build", "dist"]) {
    await mkdir(path.join(dir, name));
    await writeFile(path.join(dir, name, "ignored.py"), "ignored");
  }

  await withReadCounts(async (reads) => {
    const catalog = await discoverSkills([command]);
    assert.deepEqual(catalog.diagnostics, []);
    const skill = catalog.skills[0];
    assert.equal(skill.instructions, rawMarkdown.toString("utf8"));
    assert.equal(skill.description, "Public é🙂 fixture.");
    assert.deepEqual(skill.python.hostRequests, ["demo.echo"]);
    assert.equal(skill.contentHash, backedFixtureHash(rawMarkdown, rawPyproject, rawModule, nested));
    for (const file of [command.path, backing, source, path.join(dir, "nested", "SKILL.md")]) {
      assert.equal(reads.get(file), 1, `${file} must be read once per load`);
    }
    assert.equal(reads.size, 4, "ignored entries must not be read");
  });
});

test("independent discovery and manifest verification reread metadata, including concurrent calls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-fresh-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await createSkill(root, "raw", rawMarkdown, rawPyproject, rawModule);
  const backing = path.join(path.dirname(command.path), "pyproject.toml");
  const first = (await discoverSkills([command])).skills[0];
  const oldManifest = manifestForSkills([first]);
  const changedMarkdown = Buffer.from(rawMarkdown);
  changedMarkdown[changedMarkdown.indexOf(255)] = 254;
  assert.equal(changedMarkdown.toString("utf8"), rawMarkdown.toString("utf8"));
  await writeFile(command.path, changedMarkdown);
  const changedPyproject = Buffer.from(rawPyproject);
  changedPyproject[changedPyproject.indexOf('version = "1"') + 'version = "'.length] = "2".charCodeAt(0);
  await writeFile(backing, changedPyproject);

  await withReadCounts(async (reads) => {
    const [left, right] = await Promise.all([discoverSkills([command]), discoverSkills([command])]);
    assert.deepEqual(left.diagnostics, []);
    assert.deepEqual(right, left);
    assert.notStrictEqual(left.skills[0], right.skills[0]);
    assert.equal(left.skills[0].version, "2");
    assert.equal(left.skills[0].contentHash, backedFixtureHash(changedMarkdown, changedPyproject, rawModule));
    assert.notEqual(left.skills[0].contentHash, first.contentHash);
    assert.equal(reads.get(command.path), 2, "each concurrent load owns a fresh markdown read");
    assert.equal(reads.get(backing), 2, "each concurrent load owns a fresh backing read");

    const currentManifest = manifestForSkills(left.skills);
    assert.deepEqual(await verifyManifest(currentManifest), currentManifest);
    assert.equal(reads.get(command.path), 3, "manifest verification must independently reload markdown");
    assert.equal(reads.get(backing), 3, "manifest verification must independently reload backing");
    await assert.rejects(verifyManifest(oldManifest), /persisted skill changed/);
    assert.equal(reads.get(command.path), 4);
    assert.equal(reads.get(backing), 4);
  });
});

test("metadata symlinks retain link-text hashes rather than followed parse bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-link-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await createSkill(root, "raw", rawMarkdown, rawPyproject, rawModule);
  const dir = path.dirname(command.path);
  const backing = path.join(dir, "pyproject.toml");
  await mkdir(path.join(root, "targets"));
  await rename(command.path, path.join(root, "targets", "skill.md"));
  await rename(backing, path.join(root, "targets", "backing.toml"));
  await symlink("../targets/skill.md", command.path);
  await symlink("../targets/backing.toml", backing);
  const expectedHash = createHash("sha256")
    .update("l:pyproject.toml\0../targets/backing.toml\0")
    .update("l:SKILL.md\0../targets/skill.md\0")
    .update("d:src\0d:src/backed_skill\0f:src/backed_skill/__init__.py\0")
    .update(rawModule).update("\0\0\0").digest("hex");
  await withReadCounts(async (reads) => {
    const catalog = await discoverSkills([command]);
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(catalog.skills[0].instructions, rawMarkdown.toString("utf8"));
    assert.equal(catalog.skills[0].contentHash, expectedHash);
    assert.equal(reads.get(command.path), 1);
    assert.equal(reads.get(backing), 1);
    await writeFile(path.join(root, "targets", "skill.md"), rawMarkdown.toString("utf8").replace("Public", "Edited"));
    const changed = await discoverSkills([command]);
    assert.deepEqual(changed.diagnostics, []);
    assert.match(changed.skills[0].description, /^Edited/);
    assert.equal(changed.skills[0].contentHash, expectedHash, "link payloads remain the hash owner");
    assert.equal(reads.get(command.path), 2);
    assert.equal(reads.get(backing), 2);
  });
});

test("standalone markdown preserves decoded-string hashing and does not load adjacent backing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-standalone-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markdownPath = path.join(root, "guide.md");
  await writeFile(markdownPath, rawMarkdown);
  await writeFile(path.join(root, "pyproject.toml"), "malformed backing must not be read");
  await withReadCounts(async (reads) => {
    const catalog = await discoverSkills([{ source: "skill", path: markdownPath }]);
    assert.deepEqual(catalog.diagnostics, []);
    assert.equal(catalog.skills[0].python, null);
    assert.equal(catalog.skills[0].instructions, rawMarkdown.toString("utf8"));
    assert.equal(catalog.skills[0].contentHash, createHash("sha256").update(rawMarkdown.toString("utf8")).digest("hex"));
    assert.equal(reads.get(markdownPath), 1);
    assert.equal(reads.size, 1);
  });
});
