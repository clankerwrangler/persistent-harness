import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PYTHON_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IGNORED_SKILL_ENTRIES = new Set(["__pycache__", ".git", ".hg", ".svn", "build", "dist"]);
const IGNORED_SKILL_SUFFIXES = [".pyc", ".pyo", ".tmp"];
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashDirectory(directory) {
  const digest = createHash("sha256");
  async function visit(current, relativeBase = "") {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_SKILL_ENTRIES.has(entry.name) || IGNORED_SKILL_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.join(relativeBase, entry.name).split(path.sep).join("/");
      digest.update(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}\0`);
      if (entry.isDirectory()) await visit(fullPath, relative);
      else if (entry.isSymbolicLink()) digest.update(await readlink(fullPath));
      else digest.update(await readFile(fullPath));
      digest.update("\0");
    }
  }
  await visit(directory);
  return digest.digest("hex");
}

const DIRECTORY_DISCOVERY_CACHE_LIMIT = 32;
const directoryDiscoveryCache = new Map();

function updateStatFingerprint(digest, stat, { directory = false } = {}) {
  const values = directory
    ? [stat.dev, stat.ino, stat.mode]
    : [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size,
      stat.mtimeNs ?? stat.mtimeMs, stat.ctimeNs ?? stat.ctimeMs, stat.birthtimeNs ?? stat.birthtimeMs];
  for (const value of values) {
    digest.update(String(value));
    digest.update("\0");
  }
}

// A content write on the local POSIX filesystems supported by the harness changes
// ctime even when its byte length and mtime are restored. Traversing the same
// ignored-entry boundary as hashDirectory therefore gives a cheap, exact cache
// invalidator without rereading every skill source file.
export async function skillDirectoryFingerprint(directory) {
  const root = path.resolve(directory);
  const digest = createHash("sha256");
  const rootStat = await lstat(root, { bigint: true });
  digest.update(`root:${root}\0`);
  updateStatFingerprint(digest, rootStat, { directory: rootStat.isDirectory() });
  if (rootStat.isSymbolicLink()) {
    digest.update(await readlink(root));
    digest.update("\0");
  }

  async function visit(current, relativeBase = "") {
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_SKILL_ENTRIES.has(entry.name) || IGNORED_SKILL_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      const fullPath = path.join(current, entry.name);
      const relative = path.join(relativeBase, entry.name).split(path.sep).join("/");
      const kind = entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f";
      digest.update(`${kind}:${relative}\0`);
      updateStatFingerprint(digest, await lstat(fullPath, { bigint: true }), { directory: entry.isDirectory() });
      if (entry.isDirectory()) await visit(fullPath, relative);
      else if (entry.isSymbolicLink()) {
        digest.update(await readlink(fullPath));
        digest.update("\0");
      }
    }
  }
  await visit(root);
  return digest.digest("hex");
}

function cloneSkill(skill) {
  return {
    ...skill,
    python: skill.python ? {
      ...skill.python,
      dependencies: [...skill.python.dependencies],
      hostRequests: [...skill.python.hostRequests],
    } : null,
  };
}

function cloneCatalog(catalog) {
  return {
    skills: catalog.skills.map(cloneSkill),
    diagnostics: catalog.diagnostics.map((item) => ({ ...item })),
  };
}

function parseScalar(raw, context) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${context} must be a one-line array of quoted strings`);
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${context} must be a quoted string, boolean, or one-line string array`);
}

export function parsePythonBacking(content, filePath) {
  const sections = new Map();
  let section;
  for (const [index, originalLine] of content.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (!sections.has(section)) sections.set(section, {});
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment || !section) throw new Error(`${filePath}:${index + 1}: unsupported TOML syntax`);
    sections.get(section)[assignment[1]] = parseScalar(assignment[2], `${filePath}:${index + 1}`);
  }

  const project = sections.get("project");
  const harness = sections.get("tool.persistent-harness");
  if (!project || !harness) throw new Error(`${filePath} requires [project] and [tool.persistent-harness]`);
  for (const key of ["name", "version"]) {
    if (typeof project[key] !== "string" || !project[key]) throw new Error(`${filePath}: project.${key} is required`);
  }
  for (const key of ["id", "import-name", "alias"]) {
    if (typeof harness[key] !== "string" || !harness[key]) throw new Error(`${filePath}: tool.persistent-harness.${key} is required`);
  }
  const hostRequests = harness["host-requests"] ?? [];
  const dependencies = project.dependencies ?? [];
  if (!Array.isArray(hostRequests) || !Array.isArray(dependencies)) throw new Error(`${filePath}: dependencies and host-requests must be arrays`);
  const entryPoint = harness["entry-point"];
  if (entryPoint !== undefined && typeof entryPoint !== "string") throw new Error(`${filePath}: entry-point must be a string`);
  return {
    packageName: project.name,
    version: project.version,
    requiresPython: project["requires-python"] ?? null,
    dependencies,
    id: harness.id,
    importName: harness["import-name"],
    alias: harness.alias,
    entryPoint: entryPoint ?? null,
    hostRequests,
  };
}

export function parseSkillMarkdown(content, filePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${filePath}: missing YAML frontmatter`);
  const frontmatter = {};
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) throw new Error(`${filePath}:${index + 2}: unsupported frontmatter syntax`);
    let value = pair[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[pair[1]] = value;
  }
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64) {
    throw new Error(`${filePath}: name must match ${SKILL_NAME} and be at most 64 characters`);
  }
  if (typeof description !== "string" || !description || description.length > 1024) {
    throw new Error(`${filePath}: description is required and must be at most 1024 characters`);
  }
  return { name, description, instructions: content };
}

function defaultAlias(name) {
  return name.replaceAll("-", "_");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadSkill(command) {
  const commandPath = command.path ?? command.sourceInfo?.path;
  const skillPath = path.resolve(commandPath);
  const content = await readFile(skillPath, "utf8");
  const markdown = parseSkillMarkdown(content, skillPath);
  const skillDir = path.dirname(skillPath);
  const pyprojectPath = path.join(skillDir, "pyproject.toml");
  let python = null;
  let pyprojectContent = "";
  if (path.basename(skillPath) === "SKILL.md" && await exists(pyprojectPath)) {
    pyprojectContent = await readFile(pyprojectPath, "utf8");
  }
  if (pyprojectContent.includes("[tool.persistent-harness]")) {
    const parsed = parsePythonBacking(pyprojectContent, pyprojectPath);
    if (parsed.id !== markdown.name) throw new Error(`${pyprojectPath}: id must equal SKILL.md name ${markdown.name}`);
    if (!PYTHON_IDENTIFIER.test(parsed.alias) || PYTHON_KEYWORDS.has(parsed.alias)) {
      throw new Error(`${pyprojectPath}: alias is not a valid non-keyword Python identifier`);
    }
    if (!parsed.importName.split(".").every((part) => PYTHON_IDENTIFIER.test(part) && !PYTHON_KEYWORDS.has(part))) {
      throw new Error(`${pyprojectPath}: import-name is invalid`);
    }
    const srcPath = path.join(skillDir, "src");
    if (!await exists(srcPath)) throw new Error(`${pyprojectPath}: Python-backed skill requires src/`);
    python = { ...parsed, srcPath, pyprojectPath };
  }
  const alias = python?.alias ?? defaultAlias(markdown.name);
  if (!PYTHON_IDENTIFIER.test(alias) || PYTHON_KEYWORDS.has(alias)) {
    throw new Error(`${skillPath}: derived alias ${alias} is not a valid Python identifier`);
  }
  const contentHash = path.basename(skillPath) === "SKILL.md"
    ? await hashDirectory(skillDir)
    : sha256(content);
  return {
    id: markdown.name,
    description: markdown.description,
    alias,
    skillPath,
    skillDir,
    instructions: markdown.instructions,
    contentHash,
    version: python?.version ?? `sha256:${contentHash}`,
    python,
  };
}

export async function verifyManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.skills)) throw new Error("persisted skill manifest is invalid");
  const verified = [];
  for (const expected of manifest.skills) {
    const current = await loadSkill({ source: "skill", path: expected.skillPath });
    if (current.id !== expected.id || current.alias !== expected.alias || current.version !== expected.version
      || current.contentHash !== expected.contentHash || Boolean(current.python) !== Boolean(expected.python)) {
      throw new Error(`persisted skill changed or disappeared: ${expected.id}`);
    }
    if (current.python && (current.python.importName !== expected.python.importName
      || current.python.entryPoint !== expected.python.entryPoint
      || JSON.stringify(current.python.hostRequests) !== JSON.stringify(expected.python.hostRequests))) {
      throw new Error(`persisted skill backing changed: ${expected.id}`);
    }
    verified.push(current);
  }
  return manifestForSkills(verified, { generatedAt: manifest.generatedAt });
}

export async function discoverSkills(commands) {
  const diagnostics = [];
  const skills = [];
  const seenPaths = new Set();
  for (const command of commands) {
    const commandPath = command?.path ?? command?.sourceInfo?.path;
    if (command?.source !== "skill" || typeof commandPath !== "string") continue;
    const resolved = path.resolve(commandPath);
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    try {
      skills.push(await loadSkill(command));
    } catch (error) {
      diagnostics.push({ path: resolved, error: error instanceof Error ? error.message : String(error) });
    }
  }
  skills.sort((left, right) => left.id.localeCompare(right.id) || left.skillPath.localeCompare(right.skillPath));
  const names = new Set();
  const aliases = new Set();
  for (const skill of skills) {
    if (names.has(skill.id)) throw new Error(`duplicate skill ID: ${skill.id}`);
    if (aliases.has(skill.alias)) throw new Error(`duplicate skill Python alias: ${skill.alias}`);
    names.add(skill.id);
    aliases.add(skill.alias);
  }
  return { skills, diagnostics };
}

export async function discoverSkillsFromDirectory(directory) {
  const root = path.resolve(directory);
  const fingerprint = await skillDirectoryFingerprint(root);
  const cached = directoryDiscoveryCache.get(root);
  if (cached?.fingerprint === fingerprint) return cloneCatalog(await cached.catalog);

  const operation = (async () => {
    const commands = [];
    const rootSkillPath = path.join(root, "SKILL.md");
    if (await exists(rootSkillPath)) commands.push({ source: "skill", path: rootSkillPath });
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = path.join(root, entry.name, "SKILL.md");
      if (await exists(skillPath)) commands.push({ source: "skill", path: skillPath });
    }
    return discoverSkills(commands);
  })();
  const entry = { fingerprint, catalog: operation };
  directoryDiscoveryCache.set(root, entry);
  while (directoryDiscoveryCache.size > DIRECTORY_DISCOVERY_CACHE_LIMIT) {
    directoryDiscoveryCache.delete(directoryDiscoveryCache.keys().next().value);
  }
  try {
    return cloneCatalog(await operation);
  } catch (error) {
    if (directoryDiscoveryCache.get(root) === entry) directoryDiscoveryCache.delete(root);
    throw error;
  }
}

export function skillCatalogForSkills(skills) {
  return skills.map((skill) => ({
    id: skill.id,
    version: skill.version,
    contentHash: skill.contentHash,
    skillPath: skill.skillPath,
    pythonBacked: Boolean(skill.python),
  }));
}

export function manifestForSkills(skills, { generatedAt = new Date().toISOString() } = {}) {
  return {
    version: 1,
    generatedAt,
    skills: skills.map((skill) => ({
      id: skill.id,
      description: skill.description,
      alias: skill.alias,
      skillPath: skill.skillPath,
      instructions: skill.instructions,
      contentHash: skill.contentHash,
      version: skill.version,
      python: skill.python ? {
        packageName: skill.python.packageName,
        importName: skill.python.importName,
        entryPoint: skill.python.entryPoint,
        dependencies: skill.python.dependencies,
        hostRequests: skill.python.hostRequests,
        srcPath: skill.python.srcPath,
      } : null,
    })),
  };
}

export async function writeManifestAtomic(filePath, manifest) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  let current;
  try {
    current = await lstat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current?.isFile()) {
    let unchanged = false;
    try { unchanged = await readFile(filePath, "utf8") === content; } catch {}
    if (unchanged) {
      if ((current.mode & 0o777) !== 0o600) await chmod(filePath, 0o600);
      return false;
    }
  }
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, filePath);
  return true;
}

export async function replaceDirectoryAtomic(targetPath, build) {
  const temporary = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const previous = `${targetPath}.${process.pid}.${Date.now()}.old`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    await build(temporary);
    if (await exists(targetPath)) await rename(targetPath, previous);
    await rename(temporary, targetPath);
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (!await exists(targetPath) && await exists(previous)) await rename(previous, targetPath);
    throw error;
  }
}
