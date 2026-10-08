import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createActorCompileCache } from "../src/actor-compile-cache.mjs";

const exec = promisify(execFile);
const helper = pathToFileURL(path.join(import.meta.dirname, "../src/actor-compile-cache.mjs")).href;
const posix = typeof process.geteuid === "function";
async function probe(directory, extra = {}, modulePath) {
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, ...extra };
  const script = `import { enableActorCompileCache } from ${JSON.stringify(helper)};
    import { getCompileCacheDir } from 'node:module';
    enableActorCompileCache();
    const value = ${modulePath ? `await import(${JSON.stringify(pathToFileURL(modulePath).href)})` : '{}'};
    console.log(JSON.stringify({cache:getCompileCacheDir() ?? null, value:value.default ?? null,
      identity:value.identity ?? null, inherited:process.env.NODE_COMPILE_CACHE ?? null}));`;
  const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", script], { env, timeout: 10000 });
  assert.equal(stderr, ""); return JSON.parse(stdout);
}
async function privateRoot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actor-compile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}

test("compile cache creates a private owner per supervisor and disposes only its original directory", { skip: !posix }, async t => {
  const previous = { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE, NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE };
  delete process.env.NODE_COMPILE_CACHE; delete process.env.NODE_DISABLE_COMPILE_CACHE;
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const first = await createActorCompileCache(), second = await createActorCompileCache();
  assert(first); assert(second); assert.notEqual(first.directory, second.directory);
  t.after(() => Promise.all([first.dispose(), second.dispose()]));
  const info = await lstat(first.directory);
  assert.equal(info.uid, process.geteuid()); assert.equal(info.mode & 0o7777, 0o700);
  const root = await privateRoot(t), moved = path.join(root, "original");
  await rename(first.directory, moved); await mkdir(first.directory, { mode: 0o700 });
  t.after(() => rm(first.directory, { recursive: true, force: true }));
  await writeFile(path.join(first.directory, "unowned"), "keep"); await first.dispose();
  assert.equal(await readFile(path.join(first.directory, "unowned"), "utf8"), "keep");
  await second.dispose(); await assert.rejects(lstat(second.directory), { code: "ENOENT" });
  process.env.NODE_DISABLE_COMPILE_CACHE = "1"; assert.equal(await createActorCompileCache(), undefined);
  delete process.env.NODE_DISABLE_COMPILE_CACHE; process.env.NODE_COMPILE_CACHE = path.join(root, "operator");
  assert.equal(await createActorCompileCache(), undefined);
});

test("cache storage failure leaves creation unavailable without creating canonical state", async t => {
  const root = await privateRoot(t), file = path.join(root, "file"); await writeFile(file, "not a directory");
  const script = `import { createActorCompileCache } from ${JSON.stringify(helper)};
    console.log((await createActorCompileCache()) === undefined);`;
  const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: file }, timeout: 10000 });
  assert.equal(stdout.trim(), "true"); assert.equal(stderr, "");
});

test("cache entry rejects unsafe paths and honors operator disable and explicit directory", { skip: !posix }, async t => {
  const root = await privateRoot(t), cache = path.join(root, "cache"); await mkdir(cache, { mode: 0o700 });
  const unsafe = path.join(root, "unsafe"), link = path.join(root, "link"), file = path.join(root, "file");
  await mkdir(unsafe, { mode: 0o755 }); await symlink(cache, link); await writeFile(file, "not a directory");
  for (const candidate of [unsafe, link, file, path.join(root, "missing")]) {
    assert.equal((await probe(root, { PI_HARNESS_ACTOR_COMPILE_CACHE: candidate })).cache, null);
  }
  assert.equal((await probe(root, { PI_HARNESS_ACTOR_COMPILE_CACHE: cache, NODE_DISABLE_COMPILE_CACHE: "1" })).cache, null);
  assert.equal((await probe(root, { PI_HARNESS_ACTOR_COMPILE_CACHE: cache, NODE_COMPILE_CACHE: "" })).cache, null);
  const explicit = path.join(root, "operator");
  const operator = await probe(root, { PI_HARNESS_ACTOR_COMPILE_CACHE: cache, NODE_COMPILE_CACHE: explicit });
  assert(operator.cache.startsWith(explicit + path.sep)); assert.equal(operator.inherited, explicit);
  assert.deepEqual(await readdir(cache), [], "The unused owned path is not repaired or populated");
});

test("normal Node cache invalidates changed source and evaluates fresh state in concurrent workers", { skip: !posix }, async t => {
  const root = await privateRoot(t), cache = path.join(root, "cache"), source = path.join(root, "module.mjs");
  await mkdir(cache, { mode: 0o700 });
  const code = value => `import { randomUUID } from 'node:crypto'; export const identity=randomUUID(); export default ${value};\n`;
  const env = { PI_HARNESS_ACTOR_COMPILE_CACHE: cache };
  await writeFile(source, code(11)); const first = await probe(root, env, source);
  assert(first.cache.startsWith(cache + path.sep)); assert.equal(first.value, 11); assert.equal(first.inherited, null);
  assert((await readdir(first.cache)).length > 0, "Normal process exit flushes the compile cache");
  await writeFile(source, code(22)); // Same length, different source content.
  const peers = await Promise.all(Array.from({ length: 4 }, () => probe(root, env, source)));
  assert(peers.every(peer => peer.value === 22 && peer.cache === first.cache && peer.inherited === null));
  assert.equal(new Set([first.identity, ...peers.map(peer => peer.identity)]).size, 5);
  await rm(cache, { recursive: true });
  const absent = await probe(root, env, source); assert.equal(absent.cache, null); assert.equal(absent.value, 22);
});
