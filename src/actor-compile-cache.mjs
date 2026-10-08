import { lstatSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { enableCompileCache } from "node:module";
import os from "node:os";
import path from "node:path";

const operatorConfigured = () => process.env.NODE_DISABLE_COMPILE_CACHE === "1"
  || process.env.NODE_COMPILE_CACHE !== undefined;
const privateDirectory = (info) => info.isDirectory() && typeof process.geteuid === "function"
  && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o700;

/** One disposable code cache per supervisor; never canonical or session state. */
export async function createActorCompileCache() {
  if (operatorConfigured() || typeof process.geteuid !== "function") return;
  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), "persistent-harness-compile-"));
    const identity = await lstat(directory);
    if (!privateDirectory(identity)) return;
    return { directory, async dispose() {
      try {
        const current = await lstat(directory);
        if (privateDirectory(current) && current.dev === identity.dev && current.ino === identity.ino) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch { /* Disposable cache cleanup must not fail supervisor shutdown. */ }
    } };
  } catch { /* Unavailable cache storage leaves ordinary startup intact. */ }
}

/** Called before the actor's dynamic imports; does not enable caching in tool children. */
export function enableActorCompileCache() {
  if (operatorConfigured()) return;
  const directory = process.env.PI_HARNESS_ACTOR_COMPILE_CACHE;
  if (!directory) return;
  try {
    if (privateDirectory(lstatSync(directory))) enableCompileCache(directory);
  } catch { /* Unsafe or unavailable paths are cache misses, not startup failures. */ }
}
