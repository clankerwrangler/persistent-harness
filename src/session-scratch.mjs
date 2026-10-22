import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, fsyncSync, opendirSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SCRATCH_DIRECTORY = "/workspace/.scratch";
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const ROOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = () => { throw new Error("root scratch path or ownership changed; refusing access"); };
const witness = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
const childPath = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const mountId = fd => {
  const match = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^mnt_id:\s+(\d+)$/m);
  if (!match) fail();
  return match[1];
};

// Keep the chain open so each later check is relative to the originally opened parent.
function openChain(directory, { createLeaf = false } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory !== path.normalize(directory)
    || directory.includes("\0") || directory === "/") fail();
  const fds = [], edges = [];
  try {
    let fd = openSync("/", DIRECTORY); fds.push(fd);
    for (const [index, component] of directory.slice(1).split("/").entries()) {
      if (!component || component === "." || component === "..") fail();
      const target = childPath(fd, component);
      let next;
      try { next = openSync(target, DIRECTORY); }
      catch (error) {
        if (!createLeaf || index !== directory.slice(1).split("/").length - 1 || error.code !== "ENOENT") throw error;
        try { mkdirSync(target, { mode: 0o700 }); fsyncSync(fd); }
        catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
        next = openSync(target, DIRECTORY);
      }
      edges.push({ parent: fd, name: component, stat: fstatSync(next, { bigint: true }) });
      fds.push(next); fd = next;
    }
    const check = () => {
      for (const edge of edges) {
        const current = lstatSync(childPath(edge.parent, edge.name), { bigint: true });
        if (!current.isDirectory() || !same(current, edge.stat)) fail();
      }
    };
    check();
    return { fd, check, close: () => { for (const owned of fds.reverse()) closeSync(owned); } };
  } catch (error) { for (const fd of fds.reverse()) closeSync(fd); throw error; }
}

function rootIdentity(store, sessionId) {
  const root = store.getSessionRoot(sessionId);
  if (!ROOT_ID.test(root.sessionId)) fail();
  return root;
}

export function ensureSessionScratch(store, sessionId, directory = DEFAULT_SCRATCH_DIRECTORY) {
  store.assertSessionAvailable(sessionId);
  const root = rootIdentity(store, sessionId);
  const record = store.getRootScratch(root.sessionId);
  if (record && (record.state !== "ready" || record.directory !== directory)) fail();
  const base = openChain(directory, { createLeaf: true });
  let rootFd;
  try {
    const baseStat = fstatSync(base.fd, { bigint: true });
    if (record && !same(baseStat, record.base)) fail();
    const target = childPath(base.fd, root.sessionId);
    if (!record) {
      // EEXIST is deliberately fatal: retained namespaces are not ownership evidence.
      mkdirSync(target, { mode: 0o700 }); fsyncSync(base.fd);
    }
    let recreated;
    const checkRecoveryOwner = () => {
      store.assertSessionAvailable(sessionId);
      store.assertSessionAvailable(root.sessionId);
      if (rootIdentity(store, sessionId).sessionId !== root.sessionId
        || JSON.stringify(store.getRootScratch(root.sessionId)) !== JSON.stringify(record)) fail();
    };
    try { rootFd = openSync(target, DIRECTORY); }
    catch (error) {
      if (!record || error.code !== "ENOENT") throw error;
      if (record.root?.dev !== String(baseStat.dev) || typeof record.root?.ino !== "string"
        || !/^[1-9][0-9]*$/.test(record.root.ino)) fail();
      base.check(); checkRecoveryOwner();
      // Recover only an absent leaf. A concurrent creator must fail with EEXIST.
      mkdirSync(target, { mode: 0o700 });
      recreated = lstatSync(target, { bigint: true });
      if (!recreated.isDirectory()) fail();
      fsyncSync(base.fd);
      rootFd = openSync(target, DIRECTORY);
    }
    const rootStat = fstatSync(rootFd, { bigint: true });
    const expectedRoot = recreated ?? record?.root;
    if (rootStat.dev !== baseStat.dev || mountId(rootFd) !== mountId(base.fd)
      || expectedRoot && !same(rootStat, expectedRoot)) fail();
    base.check();
    const current = lstatSync(target, { bigint: true });
    if (!current.isDirectory() || !same(current, rootStat)) fail();
    if (recreated) {
      checkRecoveryOwner();
      store.setRootScratch(root.sessionId, { ...record, root: witness(rootStat) });
    } else if (!record) store.setRootScratch(root.sessionId, { version: 1, state: "ready", directory, base: witness(baseStat), root: witness(rootStat) });
    return { rootSessionId: root.sessionId, directory: path.join(directory, root.sessionId) };
  } finally { if (rootFd !== undefined) closeSync(rootFd); base.close(); }
}

export function reclaimSessionScratch(store, rootId, directory = DEFAULT_SCRATCH_DIRECTORY) {
  const root = rootIdentity(store, rootId);
  const record = store.getRootScratch(rootId);
  if (root.sessionId !== rootId || root.lifecycle !== "deleted" || record?.state !== "deleting"
    || record.directory !== directory) fail();
  const base = openChain(directory);
  try {
    if (!same(fstatSync(base.fd, { bigint: true }), record.base)) fail();
    const target = childPath(base.fd, rootId);
    let rootFd;
    try { rootFd = openSync(target, DIRECTORY); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      base.check();
      // The previous attempt may have removed the tree before persisting its receipt.
      store.setRootScratch(rootId, { ...record, state: "removed" });
      return;
    }
    try {
      const stat = fstatSync(rootFd, { bigint: true });
      if (!same(stat, record.root) || mountId(rootFd) !== mountId(base.fd)) fail();
      const edges = [{ parent: base.fd, name: rootId, stat }];
      const check = () => {
        base.check();
        for (const edge of edges) {
          const current = lstatSync(childPath(edge.parent, edge.name), { bigint: true });
          if (!current.isDirectory() || !same(current, edge.stat)) fail();
        }
      };
      let visited = 0;
      const deadline = performance.now() + 50;
      const ownedMount = mountId(rootFd);
      const clear = (fd, depth) => {
        if (depth > 128) fail();
        // Bounded attempts make progress; the existing completion owner retries partial cleanup.
        const reader = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 32 });
        try { for (let entry; (entry = reader.readSync());) {
          const name = entry.name;
          if (++visited > 10_000 || performance.now() > deadline) throw new Error("root scratch cleanup attempt reached its work bound");
          const leaf = childPath(fd, name);
          const observed = lstatSync(leaf, { bigint: true });
          check();
          if (observed.isDirectory()) {
            const child = openSync(leaf, DIRECTORY);
            try {
              const opened = fstatSync(child, { bigint: true });
              if (!same(opened, observed) || opened.dev !== stat.dev || mountId(child) !== ownedMount) fail();
              edges.push({ parent: fd, name, stat: opened });
              try { clear(child, depth + 1); check(); rmdirSync(leaf); }
              finally { edges.pop(); }
            } finally { closeSync(child); }
          } else {
            const current = lstatSync(leaf, { bigint: true });
            if (!same(current, observed) || current.mode !== observed.mode) fail();
            // unlink removes the link itself, never its target (including dangling links).
            unlinkSync(leaf);
          }
        } } finally { reader.closeSync(); }
      };
      clear(rootFd, 0); check(); rmdirSync(target); fsyncSync(base.fd);
      store.setRootScratch(rootId, { ...record, state: "removed" });
    } finally { closeSync(rootFd); }
  } finally { base.close(); }
}
