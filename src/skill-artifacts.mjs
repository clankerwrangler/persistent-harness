// Immutable skill-owned trees. Filesystem artifacts are shared across actors;
// desired grants and actual worker-generation pins remain supervisor-owned.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const HEX = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 10_000;
const prepared = new Map(), verified = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
function fail(code) { throw new Error(code); }
function cacheSet(cache, key, value) {
  cache.set(key, value);
  while (cache.size > 256) cache.delete(cache.keys().next().value);
}
function identity(record) {
  return hash(JSON.stringify([1, record.sourceContentHash, record.skillFile, record.materializedHash]));
}
function witness(stat, directory = false) {
  return (directory ? [stat.dev, stat.ino, stat.mode]
    : [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs]).map(String).join(":");
}
async function regularBytes(file, expected) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (expected && witness(before) !== witness(expected))) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
    if (before.size > BigInt(MAX_BYTES)) fail("SKILL_ARTIFACT_LIMIT");
    const bytes = await handle.readFile();
    if (witness(await handle.stat({ bigint: true })) !== witness(before)) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
    return bytes;
  } finally { await handle.close(); }
}

// Only conventional bytecode with a corresponding regular .py source is
// disposable. Unrecognized cache contents, build/dist, .tmp and VCS are kept.
async function disposableCache(anchor, name, stat) {
  if (!stat.isDirectory() || name !== "__pycache__") return false;
  const handle = await open(path.join(anchor, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const cache = `/proc/self/fd/${handle.fd}`;
    for (const file of await readdir(cache)) {
      const match = file.match(/^(.+)\.(?:cpython-\d+|pypy\d+)(?:\.opt-\d+)?\.py[co]$/);
      if (!match || !(await lstat(path.join(cache, file))).isFile()) return false;
      try { if (!(await lstat(path.join(anchor, `${match[1]}.py`))).isFile()) return false; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    return true;
  } finally { await handle.close(); }
}

// Directory descriptors keep child traversal anchored across source renames.
// No symlink or special entry is opened or copied. This is a Linux owner.
async function walk(directory, { source = false, onlyFile, onDirectory, onFile } = {}) {
  const fingerprint = createHash("sha256");
  let count = 0, bytes = 0;
  async function visit(handle, relative = "") {
    const anchor = `/proc/self/fd/${handle.fd}`;
    const stat = await handle.stat({ bigint: true });
    fingerprint.update(`d:${relative}\0${witness(stat, true)}\0`);
    const names = (await readdir(anchor)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (onlyFile && !relative && name !== onlyFile) continue;
      const file = path.join(anchor, name), rel = relative ? `${relative}/${name}` : name;
      const entry = await lstat(file, { bigint: true });
      if (source && await disposableCache(anchor, name, entry)) continue;
      if (++count > MAX_ENTRIES) fail("SKILL_ARTIFACT_LIMIT");
      if (entry.isDirectory()) {
        await onDirectory?.(rel);
        const child = await open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          if (witness(await child.stat({ bigint: true }), true) !== witness(entry, true)) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
          await visit(child, rel);
        } finally { await child.close(); }
      } else if (entry.isFile()) {
        bytes += Number(entry.size);
        if (bytes > MAX_BYTES) fail("SKILL_ARTIFACT_LIMIT");
        fingerprint.update(`f:${rel}\0${witness(entry)}\0`);
        await onFile?.(file, rel, entry);
      } else fail("SKILL_ARTIFACT_UNSUPPORTED_ENTRY");
    }
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await visit(handle); } finally { await handle.close(); }
  return fingerprint.digest("hex");
}
function digestTree() {
  const digest = createHash("sha256");
  return {
    directory: relative => digest.update(`d:${relative}\0`),
    file: (relative, stat, bytes) => digest.update(`f:${relative}\0${Number(stat.mode & 0o111n)}\0`).update(bytes).update("\0"),
    finish: () => digest.digest("hex"),
  };
}
async function treeDigest(directory) {
  const digest = digestTree();
  await walk(directory, { onDirectory: digest.directory,
    onFile: async (file, rel, stat) => digest.file(rel, stat, await regularBytes(file, stat)) });
  return digest.finish();
}
async function seal(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name), stat = await lstat(file);
    if (stat.isDirectory()) await seal(file);
    else if (stat.isFile()) await chmod(file, 0o400 | (stat.mode & 0o111));
    else fail("SKILL_ARTIFACT_UNSUPPORTED_ENTRY");
  }
  await chmod(directory, 0o700);
}
async function removeStaging(directory) {
  await rm(directory, { recursive: true, force: true });
}

export function skillArtifactLocation(skillPath) {
  const tree = path.dirname(path.resolve(skillPath)), object = path.dirname(tree), id = path.basename(object);
  return path.basename(tree) === "tree" && HEX.test(id) ? { id, object, tree } : null;
}

export async function verifySkillArtifact(skillPath) {
  const location = skillArtifactLocation(skillPath);
  if (!location) return null;
  const objectStat = await lstat(location.object);
  if (!objectStat.isDirectory() || objectStat.uid !== process.getuid() || (objectStat.mode & 0o077)) fail("SKILL_ARTIFACT_ROOT_INVALID");
  const metadata = path.join(location.object, "artifact.json");
  const stat = await lstat(metadata, { bigint: true });
  if (!stat.isFile() || stat.size > 16384n) fail("SKILL_ARTIFACT_METADATA_INVALID");
  const fingerprint = await walk(location.tree);
  const cached = verified.get(location.object);
  if (cached?.fingerprint === fingerprint && cached.metadataWitness === witness(stat)) return { ...cached.record, fingerprint };
  const record = JSON.parse((await regularBytes(metadata, stat)).toString("utf8"));
  if (record?.version !== 1 || !HEX.test(record.sourceContentHash) || !HEX.test(record.materializedHash)
    || record.skillFile !== path.basename(skillPath) || identity(record) !== location.id) fail("SKILL_ARTIFACT_IDENTITY_INVALID");
  if (await treeDigest(location.tree) !== record.materializedHash) fail("SKILL_ARTIFACT_CONTENT_CHANGED");
  if (await walk(location.tree) !== fingerprint) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
  cacheSet(verified, location.object, { fingerprint, metadataWitness: witness(stat), record });
  return { ...record, fingerprint };
}

export async function prepareSkillArtifact(skill, { artifactRoot, verifyTree }) {
  if (!artifactRoot || typeof verifyTree !== "function") fail("SKILL_ARTIFACT_CONFIGURATION_REQUIRED");
  const sourceDirectory = path.dirname(skill.skillPath), skillFile = path.basename(skill.skillPath);
  const options = { source: true, ...(skillFile === "SKILL.md" ? {} : { onlyFile: skillFile }) };
  const fingerprint = await walk(sourceDirectory, options);
  const key = `${path.resolve(artifactRoot)}\0${skill.skillPath}\0${skill.contentHash}`;
  const cached = prepared.get(key);
  if (cached?.fingerprint === fingerprint) return { ...await cached.promise };
  const promise = (async () => {
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(artifactRoot);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o077) || rootStat.uid !== process.getuid()) fail("SKILL_ARTIFACT_ROOT_INVALID");
    const temporary = path.join(artifactRoot, `.staging-${randomUUID()}`), tree = path.join(temporary, "tree");
    await mkdir(tree, { recursive: true, mode: 0o700 });
    let published = false;
    try {
      const digest = digestTree();
      const captured = await walk(sourceDirectory, { ...options,
        onDirectory: async rel => { digest.directory(rel); await mkdir(path.join(tree, rel), { mode: 0o700 }); },
        onFile: async (file, rel, stat) => {
          const bytes = await regularBytes(file, stat); digest.file(rel, stat, bytes);
          await writeFile(path.join(tree, rel), bytes, { mode: 0o600 | Number(stat.mode & 0o111n), flag: "wx" });
        },
      });
      if (captured !== fingerprint || await walk(sourceDirectory, options) !== fingerprint) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
      await verifyTree(path.join(tree, skillFile));
      if (await walk(sourceDirectory, options) !== fingerprint) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
      const record = { version: 1, sourceContentHash: skill.contentHash, skillFile, materializedHash: digest.finish() };
      const id = identity(record), object = path.join(artifactRoot, id);
      await writeFile(path.join(temporary, "artifact.json"), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      await seal(temporary);
      if (await treeDigest(tree) !== record.materializedHash) fail("SKILL_ARTIFACT_CONTENT_CHANGED");
      const sealedFingerprint = await walk(tree);
      const metadataWitness = witness(await lstat(path.join(temporary, "artifact.json"), { bigint: true }));
      if (await walk(sourceDirectory, options) !== fingerprint) fail("SKILL_ARTIFACT_SOURCE_CHANGED");
      let exists = false;
      try { await lstat(object); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!exists) {
        try { await rename(temporary, object); published = true; }
        catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
      }
      const result = { skillPath: path.join(object, "tree", skillFile), tree: path.join(object, "tree"), artifactId: id };
      if (published) cacheSet(verified, object, { fingerprint: sealedFingerprint, metadataWitness, record });
      await verifySkillArtifact(result.skillPath);
      return result;
    } finally { if (!published) await removeStaging(temporary); }
  })();
  cacheSet(prepared, key, { fingerprint, promise });
  try { return { ...await promise }; }
  catch (error) { if (prepared.get(key)?.promise === promise) prepared.delete(key); throw error; }
}
