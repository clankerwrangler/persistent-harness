import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { sessionSidecarPaths } from "../src/session-paths.mjs";

test("derives every session-local sidecar from the canonical Pi transcript basename", () => {
  const sessionFile = path.resolve("/tmp/pi-sessions/2026-08-13T00-00-00-000Z_session-id.jsonl");
  const basePath = sessionFile.slice(0, -".jsonl".length);
  const paths = sessionSidecarPaths(sessionFile);

  assert.deepEqual(paths, {
    sessionFile,
    basePath,
    skillManifestPath: `${basePath}.skill-manifest.json`,
    capabilitiesPath: `${basePath}.capabilities.json`,
    skillGrantPath: `${basePath}.skill-grant.json`,
    kernelStatePath: `${basePath}.kernel-state`,
  });
  assert(Object.isFrozen(paths));
});

test("rejects paths that cannot identify a Pi JSONL transcript", () => {
  assert.throws(() => sessionSidecarPaths(""), /non-empty/);
  assert.throws(() => sessionSidecarPaths("/tmp/session.json"), /\.jsonl/);
  assert.throws(() => sessionSidecarPaths("/tmp/.jsonl"), /\.jsonl/);
});
