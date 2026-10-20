import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

const SESSION_EXTENSION = ".jsonl";

/**
 * Derive every harness-owned session-local path from Pi's canonical transcript.
 * No directory is created by this helper.
 */
export function sessionSidecarPaths(sessionFile) {
  if (typeof sessionFile !== "string" || !sessionFile.trim()) {
    throw new TypeError("sessionFile must be a non-empty path");
  }

  const resolvedSessionFile = path.resolve(sessionFile);
  const parsed = path.parse(resolvedSessionFile);
  if (parsed.ext !== SESSION_EXTENSION || !parsed.name) {
    throw new Error("sessionFile must name a .jsonl Pi transcript");
  }

  const basePath = path.join(parsed.dir, parsed.name);
  return Object.freeze({
    sessionFile: resolvedSessionFile,
    basePath,
    skillManifestPath: `${basePath}.skill-manifest.json`,
    capabilitiesPath: `${basePath}.capabilities.json`,
    skillGrantPath: `${basePath}.skill-grant.json`,
    kernelStatePath: `${basePath}.kernel-state`,
  });
}


export function actorGenerationSkillGrantPath(sessionFile, generation, digest) {
  if (!Number.isSafeInteger(generation) || generation < 1 || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError("invalid actor generation grant identity");
  }
  return `${sessionSidecarPaths(sessionFile).basePath}.generation-${generation}-${digest}.skill-grant.json`;
}

export function actorGenerationGrantIdentity(filePath) {
  const match = path.basename(filePath).match(/\.generation-([1-9][0-9]*)-([a-f0-9]{64})\.skill-grant\.json$/);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("invalid actor generation grant path");
  return { generation: Number(match[1]), digest: match[2] };
}

export async function publishActorGenerationSkillGrant(session, grant) {
  const content = `${JSON.stringify({ version: 1, sessionId: session.sessionId, actorGeneration: session.actorGeneration,
    skills: grant.skills, capabilities: grant.capabilities }, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const filePath = actorGenerationSkillGrantPath(session.sessionFile, session.actorGeneration, digest);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { await writeFile(filePath, content, { flag: "wx", mode: 0o400 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o277) || await readFile(filePath, "utf8") !== content) {
    throw new Error("actor generation skill grant differs from expected immutable bytes");
  }
  return filePath;
}
