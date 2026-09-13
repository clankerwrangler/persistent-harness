import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
