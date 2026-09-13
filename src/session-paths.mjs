import path from "node:path";

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
