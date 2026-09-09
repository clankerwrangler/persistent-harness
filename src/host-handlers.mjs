import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { StringDecoder } from "node:string_decoder";
import { constants as fsConstants, readFileSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { findModels, supportedThinkingLevels } from "./child-policy.mjs";

const MAX_READ_BYTES = 50 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_SOURCE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_SHELL_CAPTURE_BYTES = 64 * 1024;
const SHELL_TRUNCATION_MARKER = `
... output truncated at ${MAX_SHELL_CAPTURE_BYTES}-byte capture limit ...
`;
const MAX_GREP_FILES = 10_000;
const MAX_GREP_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_GREP_LINE_BYTES = 8 * 1024;
const MAX_GREP_OUTPUT_BYTES = 64 * 1024;
const MAX_GREP_RUNTIME_MS = 2_000;

const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
]);

function requireRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value;
}

function requireString(value, context, { allowEmpty = false, maxBytes = 1024 * 1024 } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value) || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${context} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  }
  return value;
}

function boundedInteger(value, context, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${context} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function resolvePath(cwd, requested) {
  const value = requireString(requested, "path", { maxBytes: 4096 });
  return path.resolve(cwd, value);
}

const DIRECTORY_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const REGULAR_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const TEMP_OPEN_FLAGS = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const UNSUPPORTED_DIRECTORY_SYNC_ERRORS = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"]);
const COMMITTED_ATOMIC_FILE_ERROR_CODE = "ERR_ATOMIC_FILE_COMMITTED";
const COMMITTED_ATOMIC_FILE_ERROR_MESSAGE = "atomic file publication committed, but post-publication verification, durability, or cleanup failed";

class CommittedAtomicFileError extends Error {
  constructor() {
    super(COMMITTED_ATOMIC_FILE_ERROR_MESSAGE);
    this.name = "CommittedAtomicFileError";
    this.code = COMMITTED_ATOMIC_FILE_ERROR_CODE;
    this.committed = true;
    this.phase = "post-publication";
  }
}

function procFdChild(directoryHandle, name) {
  if (!name || name === "." || name === ".." || name.includes(path.sep)) {
    throw new Error("invalid anchored path component");
  }
  return `/proc/self/fd/${directoryHandle.fd}/${name}`;
}

async function syncDirectory(directoryHandle) {
  try {
    await directoryHandle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_ERRORS.has(error?.code)) throw error;
  }
}

async function openAnchoredDirectory(directoryPath, { create = false } = {}) {
  const absolute = path.resolve(directoryPath);
  if (path.parse(absolute).root !== path.sep) throw new Error("atomic file operations require an absolute POSIX path");
  let current = await open(path.sep, DIRECTORY_OPEN_FLAGS);
  try {
    const components = absolute.slice(path.sep.length).split(path.sep).filter(Boolean);
    for (const component of components) {
      const childPath = procFdChild(current, component);
      let child;
      try {
        child = await open(childPath, DIRECTORY_OPEN_FLAGS);
      } catch (error) {
        if (!create || error?.code !== "ENOENT") {
          if (["ELOOP", "ENOTDIR"].includes(error?.code)) {
            throw new Error(`parent path component is a symlink or non-directory: ${component}`);
          }
          throw error;
        }
        try {
          await mkdir(childPath);
          await syncDirectory(current);
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
        try {
          child = await open(childPath, DIRECTORY_OPEN_FLAGS);
        } catch (openError) {
          if (["ELOOP", "ENOTDIR"].includes(openError?.code)) {
            throw new Error(`parent path component changed during creation: ${component}`);
          }
          throw openError;
        }
      }
      try {
        await current.close();
      } catch (error) {
        await child.close().catch(() => {});
        throw error;
      }
      current = child;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("file operation cancelled");
  error.name = "AbortError";
  throw error;
}

function sameStableStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readBoundedHandle(handle, maximumBytes) {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maximumBytes) throw new Error(`existing file exceeds ${maximumBytes} byte atomic-source limit`);
  return buffer.subarray(0, offset);
}

async function readRegularSnapshot(leafPath) {
  let leafStat;
  try {
    leafStat = await lstat(leafPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (leafStat.isSymbolicLink()) throw new Error("file path must not be a symlink");
  if (!leafStat.isFile()) throw new Error("file path must be a regular file");

  let handle;
  try {
    handle = await open(leafPath, REGULAR_READ_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("file path must not be a symlink");
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("file path must be a regular file");
    if (before.dev !== leafStat.dev || before.ino !== leafStat.ino) {
      throw new Error("file changed concurrently while opening");
    }
    if (before.size > BigInt(MAX_WRITE_BYTES)) {
      throw new Error(`existing file exceeds ${MAX_WRITE_BYTES} byte atomic-source limit`);
    }
    const content = await readBoundedHandle(handle, MAX_WRITE_BYTES);
    const after = await handle.stat({ bigint: true });
    if (!sameStableStat(before, after) || BigInt(content.length) !== after.size) {
      throw new Error("file changed concurrently while being read");
    }
    return { stat: after, content };
  } finally {
    await handle.close();
  }
}


async function createOwnedTemp(parentHandle, content, { mode, owner = null }) {
  const tempName = `.pi-atomic-${process.pid}-${randomUUID()}.tmp`;
  const tempPath = procFdChild(parentHandle, tempName);
  let handle;
  let prepared = false;
  try {
    handle = await open(tempPath, TEMP_OPEN_FLAGS, 0o600);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error("atomic temp path is not a private regular file");
    await handle.writeFile(content);
    if (owner && (opened.uid !== owner.uid || opened.gid !== owner.gid)) {
      // Replacement must not silently change ownership. If the process cannot
      // reproduce the source owner/group, fail before publication.
      await handle.chown(Number(owner.uid), Number(owner.gid));
    }
    await handle.chmod(mode);
    await handle.sync();
    const expected = await handle.stat({ bigint: true });
    prepared = true;
    return { tempPath, handle, expected, content: Buffer.from(content) };
  } finally {
    if (!prepared) {
      let cleanupError = null;
      if (handle) await handle.close().catch((error) => { cleanupError = error; });
      await unlink(tempPath).catch((error) => {
        if (error?.code !== "ENOENT") cleanupError ??= error;
      });
      if (cleanupError) throw cleanupError;
    }
  }
}

async function assertTempUnchanged(temp, operation) {
  let pathStat;
  try {
    pathStat = await lstat(temp.tempPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
    throw error;
  }
  const before = await temp.handle.stat({ bigint: true });
  if (!pathStat.isFile()
      || pathStat.dev !== before.dev
      || pathStat.ino !== before.ino
      || !sameStableStat(temp.expected, before)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
  const content = await readBoundedHandle(temp.handle, MAX_WRITE_BYTES);
  const after = await temp.handle.stat({ bigint: true });
  if (!sameStableStat(before, after) || !content.equals(temp.content)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
}

async function assertTempPathIdentity(temp, operation) {
  let pathStat;
  try {
    pathStat = await lstat(temp.tempPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
    throw error;
  }
  const current = await temp.handle.stat({ bigint: true });
  if (!pathStat.isFile()
      || pathStat.dev !== current.dev
      || pathStat.ino !== current.ino
      || !sameStableStat(temp.expected, current)) {
    throw new Error(`atomic temp changed concurrently; ${operation} was not committed`);
  }
}

async function assertReplacementSourceUnchanged(parentHandle, parentPath, leafName, source, operation) {
  let canonicalParent;
  try {
    canonicalParent = await openAnchoredDirectory(parentPath);
    const [expectedParent, currentParent] = await Promise.all([
      parentHandle.stat({ bigint: true }),
      canonicalParent.stat({ bigint: true }),
    ]);
    if (expectedParent.dev !== currentParent.dev || expectedParent.ino !== currentParent.ino) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }

    let current;
    try {
      current = await readRegularSnapshot(procFdChild(canonicalParent, leafName));
    } catch (error) {
      if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
          || /file path must (?:not be a symlink|be a regular file)/.test(error?.message ?? "")) {
        throw new Error(`file changed concurrently; ${operation} was not committed`);
      }
      throw error;
    }
    if (!current
        || !sameStableStat(source.stat, current.stat)
        || !source.content.equals(current.content)) {
      throw new Error(`file changed concurrently; ${operation} was not committed`);
    }
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
        || /parent path component/.test(error?.message ?? "")) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
    throw error;
  } finally {
    await canonicalParent?.close().catch(() => {});
  }
}

async function assertPublishedFile(canonicalParent, leafName, temp, operation) {
  const leafPath = procFdChild(canonicalParent, leafName);
  const [published, before] = await Promise.all([
    lstat(leafPath, { bigint: true }),
    temp.handle.stat({ bigint: true }),
  ]);
  if (!published.isFile()
      || published.dev !== before.dev
      || published.ino !== before.ino
      || !sameStableStat(published, before)) {
    throw new Error(`${operation} committed, but the destination changed before verification`);
  }
  const content = await readBoundedHandle(temp.handle, MAX_WRITE_BYTES);
  const after = await temp.handle.stat({ bigint: true });
  if (!sameStableStat(before, after) || !content.equals(temp.content)) {
    throw new Error(`${operation} committed, but the published file changed before verification`);
  }
}

async function assertParentPathUnchanged(parentHandle, parentPath, operation) {
  let checkHandle;
  try {
    checkHandle = await openAnchoredDirectory(parentPath);
    const [expected, current] = await Promise.all([
      parentHandle.stat({ bigint: true }),
      checkHandle.stat({ bigint: true }),
    ]);
    if (expected.dev !== current.dev || expected.ino !== current.ino) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error?.code)
        || /parent path component/.test(error?.message ?? "")) {
      throw new Error(`parent directory changed concurrently; ${operation} was not committed`);
    }
    throw error;
  } finally {
    await checkHandle?.close().catch(() => {});
  }
}

async function commitAtomicFile({ filePath, content, buildContent, createParents, replaceExisting = false, signal, operation }) {
  throwIfAborted(signal);
  const leafName = path.basename(filePath);
  const parentPath = path.dirname(filePath);
  const parentHandle = await openAnchoredDirectory(parentPath, { create: createParents });
  const leafPath = procFdChild(parentHandle, leafName);
  let temp = null;
  let committed = false;
  let primaryError = null;
  let result;
  try {
    const source = await readRegularSnapshot(leafPath);
    if (replaceExisting && !source) throw new Error("file does not exist");
    if (source && (source.stat.mode & 0o7000n) !== 0n) {
      throw new Error(`existing file has unsupported special mode bits; ${operation} was not committed`);
    }
    if (!replaceExisting && source) {
      throw new Error(`file already exists; ${operation} was not committed`);
    }

    const built = buildContent ? buildContent(source) : { content };
    const finalContent = built.content;
    if (typeof finalContent !== "string" || Buffer.byteLength(finalContent) > MAX_WRITE_BYTES) {
      throw new Error("atomic file content exceeds write limit");
    }

    const mode = source ? Number(source.stat.mode & 0o777n) : 0o666 & ~process.umask();
    const owner = source ? { uid: source.stat.uid, gid: source.stat.gid } : null;
    temp = await createOwnedTemp(parentHandle, finalContent, { mode, owner });
    await new Promise((resolve) => setImmediate(resolve));
    throwIfAborted(signal);
    await assertTempUnchanged(temp, operation);
    if (source) {
      // This is an immediate best-effort precondition check, not kernel CAS:
      // an external writer can still change the pathname after this check and
      // before rename(2). The atomic rename itself never exposes partial bytes.
      await assertReplacementSourceUnchanged(parentHandle, parentPath, leafName, source, operation);
    } else {
      await assertParentPathUnchanged(parentHandle, parentPath, operation);
    }
    await assertTempPathIdentity(temp, operation);
    throwIfAborted(signal);

    if (source) {
      // Rename to the canonical requested pathname rather than a potentially
      // detached preparation-directory descriptor.
      await rename(temp.tempPath, filePath);
      committed = true;
      temp.tempPath = null;
    } else {
      try {
        // link(2) is the kernel no-replace commit primitive. Use the canonical
        // destination pathname at commit time, not the possibly detached parent
        // descriptor used to hold the private source inode.
        await link(temp.tempPath, filePath);
        committed = true;
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error(`file changed concurrently; ${operation} create was not committed`);
        }
        throw error;
      }
      await unlink(temp.tempPath);
      temp.tempPath = null;
    }

    const canonicalParent = await openAnchoredDirectory(parentPath);
    try {
      const [expectedParent, currentParent] = await Promise.all([
        parentHandle.stat({ bigint: true }),
        canonicalParent.stat({ bigint: true }),
      ]);
      await syncDirectory(canonicalParent);
      const parentChanged = expectedParent.dev !== currentParent.dev || expectedParent.ino !== currentParent.ino;
      if (parentChanged) await syncDirectory(parentHandle);
      if (source && parentChanged) {
        throw new Error(`${operation} committed, but the parent directory changed before verification`);
      }
      await assertPublishedFile(canonicalParent, leafName, temp, operation);
    } finally {
      await canonicalParent.close();
    }
    const { content: _content, ...metadata } = built;
    result = { created: !source, committed: true, durability: "confirmed", ...metadata };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  if (temp?.handle) await temp.handle.close().catch((error) => { cleanupError = error; });
  if (temp?.tempPath) await unlink(temp.tempPath).catch((error) => {
    if (error?.code !== "ENOENT") cleanupError ??= error;
  });
  await parentHandle.close().catch((error) => { cleanupError ??= error; });

  if (primaryError) {
    if (committed) throw new CommittedAtomicFileError();
    throw primaryError;
  }
  if (cleanupError) {
    if (committed) throw new CommittedAtomicFileError();
    throw cleanupError;
  }
  return result;
}

async function walk(root, visit, { limit = MAX_SEARCH_FILES } = {}) {
  let visited = 0;
  async function recurse(current) {
    if (visited >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= limit) return;
      const fullPath = path.join(current, entry.name);
      visited += 1;
      await visit(fullPath, entry);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await recurse(fullPath);
    }
  }
  await recurse(root);
  return visited;
}

function simpleDiff(filePath, oldText, newText) {
  const oldLines = oldText.split("\n").map((line) => `-${line}`);
  const newLines = newText.split("\n").map((line) => `+${line}`);
  const diff = [`--- ${filePath}`, `+++ ${filePath}`, ...oldLines, ...newLines].join("\n");
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return diff;
  return `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8")}\n... diff truncated ...`;
}

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let result = "";
  let used = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

async function runGrep(payload, { cwd, signal } = {}) {
  const value = requireRecord(payload, "files.grep payload");
  const root = resolvePath(cwd, value.path);
  const pattern = requireString(value.pattern, "pattern", { maxBytes: 4096 });
  const limit = boundedInteger(value.limit, "limit", 1, 1000, 200);
  const worker = new Worker(new URL("./grep-worker.mjs", import.meta.url), {
    workerData: {
      root,
      pattern,
      limit,
      maxVisitedEntries: MAX_SEARCH_FILES,
      maxFiles: MAX_GREP_FILES,
      maxFileBytes: MAX_SEARCH_SOURCE_BYTES,
      maxTotalBytes: MAX_GREP_TOTAL_BYTES,
      maxLineBytes: MAX_GREP_LINE_BYTES,
      maxOutputBytes: MAX_GREP_OUTPUT_BYTES,
    },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const failAfterTermination = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      Promise.resolve(worker.terminate()).then(
        () => reject(error),
        () => reject(error),
      );
    };
    const abort = () => {
      const error = new Error("grep cancelled");
      error.name = "AbortError";
      failAfterTermination(error);
    };
    const timer = setTimeout(() => {
      failAfterTermination(new Error(`regular expression search exceeded ${MAX_GREP_RUNTIME_MS} ms deadline`));
    }, MAX_GREP_RUNTIME_MS);

    worker.once("message", (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate();
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error ?? "grep worker failed"));
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`grep worker exited before returning a result (code ${code})`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const SHELL_SUBREAPER = String.raw`
use strict;
use warnings;
require "syscall.ph";
use POSIX qw(:sys_wait_h);

# Linux PR_SET_CHILD_SUBREAPER. Orphaned grandchildren (including setsid
# escapees) are reparented here instead of escaping to PID 1.
syscall(&SYS_prctl, 36, 1, 0, 0, 0) == 0 or die "prctl(PR_SET_CHILD_SUBREAPER): $!\n";
my $terminate = 0;
$SIG{TERM} = sub { $terminate = 1; };
$SIG{INT} = sub { $terminate = 1; };
my $main = fork();
defined $main or die "fork: $!\n";
if ($main == 0) {
  exec @ARGV;
  die "exec: $!\n";
}

sub descendants {
  my @queue = ($$);
  my @found;
  my %seen;
  while (@queue) {
    my $pid = shift @queue;
    next if $seen{$pid}++;
    my $file = "/proc/$pid/task/$pid/children";
    next unless open(my $fh, "<", $file);
    local $/;
    my $line = <$fh> // "";
    close($fh);
    for my $child (grep { /^\d+$/ } split(/\s+/, $line)) {
      push @found, 0 + $child;
      push @queue, 0 + $child;
    }
  }
  return @found;
}

sub signal_descendants {
  my ($signal) = @_;
  my @pids = descendants();
  kill $signal, reverse @pids if @pids;
}

my $main_status;
my $terminating = 0;
while (!defined($main_status)) {
  my $pid = waitpid(-1, WNOHANG);
  if ($pid > 0) {
    $main_status = $? if $pid == $main;
    next;
  }
  if ($terminate && !$terminating) {
    $terminating = 1;
    signal_descendants("TERM");
  }
  select(undef, undef, undef, 0.01);
  if ($terminating) {
    signal_descendants("KILL");
  }
}

# A shell may exit while a detached/background descendant remains. As the
# subreaper we retain ancestry and kill/reap everything before returning.
for (1 .. 30) {
  my @remaining = descendants();
  last unless @remaining;
  kill "TERM", reverse @remaining if $_ == 1;
  kill "KILL", reverse @remaining if $_ > 1;
  while (waitpid(-1, WNOHANG) > 0) {}
  select(undef, undef, undef, 0.01);
}
signal_descendants("KILL");
while (waitpid(-1, WNOHANG) > 0) {}
if (WIFEXITED($main_status)) { exit WEXITSTATUS($main_status); }
exit(128 + WTERMSIG($main_status));
`;

function processDescendants(rootPid) {
  const queue = [rootPid];
  const seen = new Set();
  const descendants = [];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    let content;
    try {
      content = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      continue;
    }
    for (const value of content.trim().split(/\s+/)) {
      if (!/^\d+$/.test(value)) continue;
      const child = Number(value);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function killProcessTree(rootPid) {
  const descendants = processDescendants(rootPid);
  for (const pid of descendants.reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  try { process.kill(rootPid, "SIGKILL"); } catch {}
}

async function runShell(payload, { cwd, signal, onProgress = () => {} }) {
  const value = requireRecord(payload, "shell.run payload");
  const command = requireString(value.command, "command", { maxBytes: 64 * 1024 });
  const commandCwd = value.cwd === null || value.cwd === undefined ? cwd : resolvePath(cwd, value.cwd);
  const timeoutSeconds = typeof value.timeout === "number" ? value.timeout : 120;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
    throw new Error("timeout must be greater than 0 and at most 600 seconds");
  }
  if (signal?.aborted) {
    const error = new Error("shell command cancelled before spawn");
    error.name = "AbortError";
    throw error;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/perl", ["-e", SHELL_SUBREAPER, "--", "/bin/bash", "-lc", command], {
      cwd: commandCwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const startedAt = Date.now();
    const markerBytes = Buffer.byteLength(SHELL_TRUNCATION_MARKER);
    const dataBudget = MAX_SHELL_CAPTURE_BYTES - markerBytes;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let progressBytes = 0;
    let emittedDataBytes = 0;
    let truncated = false;
    let markerEmitted = false;
    let terminationReason = null;
    let forceTimer;
    let settled = false;
    let progressError = null;

    const terminate = () => {
      try { child.kill("SIGTERM"); } catch {}
      if (!forceTimer) {
        forceTimer = setTimeout(() => killProcessTree(child.pid), 1_500);
        forceTimer.unref();
      }
    };
    const emit = (stream, text) => {
      if (!text || progressError) return;
      if (stream === "stderr") stderr += text;
      else stdout += text;
      progressBytes += Buffer.byteLength(text);
      try {
        onProgress(stream, text);
      } catch (error) {
        progressError = error instanceof Error ? error : new Error(String(error));
        terminationReason ??= "progress";
        terminate();
      }
    };
    const emitMarker = (stream) => {
      if (markerEmitted || progressError) return;
      markerEmitted = true;
      truncated = true;
      emit(stream, SHELL_TRUNCATION_MARKER);
    };
    const captureText = (stream, text) => {
      if (!text || markerEmitted || progressError) return;
      const available = dataBudget - emittedDataBytes;
      const bounded = truncateUtf8(text, available);
      const boundedBytes = Buffer.byteLength(bounded);
      if (boundedBytes > 0) {
        emittedDataBytes += boundedBytes;
        emit(stream, bounded);
      }
      if (boundedBytes < Buffer.byteLength(text)) emitMarker(stream);
    };
    const capture = (stream, chunk) => {
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + chunk.length);
      captureText(stream, decoders[stream].write(chunk));
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.stdout.once("end", () => captureText("stdout", decoders.stdout.end()));
    child.stderr.once("end", () => captureText("stderr", decoders.stderr.end()));

    const chooseTermination = (reason) => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      terminate();
    };
    const abort = () => chooseTermination("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => chooseTermination("timeout"), timeoutSeconds * 1000);

    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (progressError) {
        reject(progressError);
        return;
      }
      resolve({
        command,
        cwd: commandCwd,
        stdout,
        stderr,
        exitCode: code,
        signal: exitSignal,
        cancelled: terminationReason === "cancelled",
        timedOut: terminationReason === "timeout",
        truncated,
        totalBytes,
        capturedBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
        progressBytes,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

// The Python capability boundary exposes management selectors, not process ownership.
export function projectManagedSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid managed session response");
  const fields = ["sessionId", "shortId", "sessionFile", "cwd", "repositoryRoot", "name", "kind", "familyId",
    "parentSessionId", "depth", "lineage", "relationship", "activity", "lifecycle", "quietSince", "lastError",
    "createdAt", "updatedAt", "lastActivityAt", "startedAt", "stoppedAt", "workingDescendantCount"];
  const result = Object.fromEntries(fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
  if (value.launch && typeof value.launch === "object") {
    const scalarFields = (item, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(item, key)
      && (item[key] === null || ["string", "number", "boolean"].includes(typeof item[key]))).map((key) => [key, item[key]]));
    const launch = value.launch; result.launch = {};
    if (launch.model && typeof launch.model === "object") {
      result.launch.model = scalarFields(launch.model, ["requested", "source", "resolved"]);
      if (launch.model.resolved && typeof launch.model.resolved === "object") {
        result.launch.model.resolved = scalarFields(launch.model.resolved, ["provider", "id"]);
      }
    }
    if (launch.thinking && typeof launch.thinking === "object") result.launch.thinking = scalarFields(launch.thinking, ["requested", "resolved", "source"]);
    if (launch.contextFork && typeof launch.contextFork === "object") {
      result.launch.contextFork = scalarFields(launch.contextFork, ["version", "readOnly", "sourceSessionId", "sourceLeafId", "snapshotHash", "messageCount"]);
    }
    if (Array.isArray(launch.capabilityIds)) result.launch.capabilityIds = launch.capabilityIds.filter((id) => typeof id === "string");
  }
  return result;
}

export function createHostHandlers({ cwd, getClient, getContext = () => undefined, getManifest = () => undefined, getKernel = () => undefined, getKernelRestore = () => undefined, recordAgentMessage = () => {}, recordChildCreation = () => {}, restartKernel = () => { throw new Error("kernel restart is unavailable"); } }) {
  return {
    async "files.read"(payload) {
      const value = requireRecord(payload, "files.read payload");
      const filePath = resolvePath(cwd, value.path);
      const offset = boundedInteger(value.offset, "offset", 1, 10_000_000, 1);
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 2000);
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_SOURCE_BYTES) throw new Error(`file exceeds ${MAX_SOURCE_BYTES} byte read-source limit`);
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      const bytes = Buffer.byteLength(selected);
      const bounded = bytes > MAX_READ_BYTES ? Buffer.from(selected).subarray(0, MAX_READ_BYTES).toString("utf8") : selected;
      return {
        path: filePath,
        content: bounded,
        offset,
        returnedLines: bounded.split(/\r?\n/).length,
        totalLines: lines.length,
        truncated: bytes > MAX_READ_BYTES || offset - 1 + limit < lines.length,
      };
    },

    async "files.write"(payload, context = {}) {
      const value = requireRecord(payload, "files.write payload");
      const filePath = resolvePath(cwd, value.path);
      const content = requireString(value.content, "content", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES });
      const result = await commitAtomicFile({
        filePath,
        content,
        createParents: true,
        signal: context.signal,
        operation: "write",
      });
      return { path: filePath, bytes: Buffer.byteLength(content), created: result.created };
    },

    async "files.edit"(payload, context = {}) {
      const value = requireRecord(payload, "files.edit payload");
      const filePath = resolvePath(cwd, value.path);
      const oldText = requireString(value.oldText, "oldText", { maxBytes: MAX_WRITE_BYTES });
      const newText = requireString(value.newText, "newText", { allowEmpty: true, maxBytes: MAX_WRITE_BYTES });
      if (typeof value.replaceAll !== "boolean") throw new Error("replaceAll must be boolean");
      const result = await commitAtomicFile({
        filePath,
        createParents: false,
        replaceExisting: true,
        signal: context.signal,
        operation: "edit",
        buildContent(source) {
          let content;
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(source.content);
          } catch {
            throw new Error("existing file is not valid UTF-8; edit was not committed");
          }
          const occurrences = content.split(oldText).length - 1;
          if (occurrences === 0) throw new Error("oldText was not found exactly");
          if (!value.replaceAll && occurrences !== 1) {
            throw new Error(`oldText matched ${occurrences} times; use replace_all=True explicitly`);
          }
          const updated = content.split(oldText).join(newText);
          if (Buffer.byteLength(updated) > MAX_WRITE_BYTES) throw new Error("edited file exceeds write limit");
          return {
            content: updated,
            replacements: value.replaceAll ? occurrences : 1,
            bytes: Buffer.byteLength(updated),
          };
        },
      });
      return {
        path: filePath,
        replacements: result.replacements,
        bytes: result.bytes,
        diff: simpleDiff(filePath, oldText, newText),
      };
    },

    "files.grep": (payload, context) => runGrep(payload, { cwd, ...context }),

    async "files.find"(payload) {
      const value = requireRecord(payload, "files.find payload");
      const root = resolvePath(cwd, value.path);
      const pattern = requireString(value.pattern, "pattern", { maxBytes: 4096 });
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 500);
      const matches = [];
      await walk(root, async (filePath) => {
        const relative = path.relative(root, filePath) || path.basename(filePath);
        if (matches.length < limit && (path.matchesGlob(relative, pattern) || path.matchesGlob(path.basename(filePath), pattern))) {
          matches.push(filePath);
        }
      });
      return { path: root, pattern, matches, truncated: matches.length >= limit };
    },

    async "files.list"(payload) {
      const value = requireRecord(payload, "files.list payload");
      const directory = resolvePath(cwd, value.path);
      const limit = boundedInteger(value.limit, "limit", 1, 2000, 500);
      const allEntries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const entries = allEntries.slice(0, limit)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
      return { path: directory, entries, truncated: allEntries.length > limit };
    },

    async "files.attachment"(payload) {
      const value = requireRecord(payload, "files.attachment payload");
      const filePath = resolvePath(cwd, value.path);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error("attachment path must be a file");
      if (fileStat.size > MAX_ATTACHMENT_BYTES) throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
      const data = await readFile(filePath);
      return {
        path: filePath,
        fileName: path.basename(filePath),
        mimeType: MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
        bytes: data.length,
        data: data.toString("base64"),
      };
    },

    "shell.run": (payload, context) => runShell(payload, { cwd, ...context }),

    "kernel.status"() {
      const kernel = getKernel();
      return { running: Boolean(kernel?.isRunning), busy: Boolean(kernel?.isBusy), restore: getKernelRestore() ?? null };
    },

    "kernel.restart"() {
      restartKernel();
      return { admitted: true, message: "kernel restart admitted; the next ipython call will restore the latest valid snapshot" };
    },

    async "operations.status"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const status = await client.request("get_status", {});
      const capacity = requireRecord(status.capacity, "status.capacity");
      const allowedCapacity = new Set(["resident", "starting", "queued", "maxResident", "maxConcurrentStarts"]);
      for (const key of Object.keys(capacity)) {
        if (!allowedCapacity.has(key)) throw new Error(`unsupported capacity field: ${key}`);
      }
      for (const key of allowedCapacity) {
        if (capacity[key] === undefined) throw new Error(`capacity.${key} is required`);
      }
      return {
        daemon: status.daemon,
        capacity: {
          resident: boundedInteger(capacity.resident, "capacity.resident", 0, 10_000),
          starting: boundedInteger(capacity.starting, "capacity.starting", 0, 10_000),
          queued: boundedInteger(capacity.queued, "capacity.queued", 0, 10_000),
          maxResident: boundedInteger(capacity.maxResident, "capacity.maxResident", 1, 128),
          maxConcurrentStarts: boundedInteger(capacity.maxConcurrentStarts, "capacity.maxConcurrentStarts", 1, 32),
        },
        counts: status.counts,
        usage: status.usage,
        diagnostics: status.diagnostics,
        sessions: status.sessions.map((session) => ({
          sessionId: session.sessionId,
          shortId: session.shortId,
          name: session.name,
          kind: session.kind,
          depth: session.depth,
          lineage: session.lineage,
          activity: session.activity,
          lifecycle: session.lifecycle,
          workingDescendantCount: session.workingDescendantCount,
          model: session.launch?.model ?? null,
          thinking: session.launch?.thinking ?? null,
          capabilityIds: session.launch?.capabilityIds ?? [],
        })),
      };
    },

    async "operations.diagnose"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const status = await client.request("get_status", {});
      return { healthy: status.diagnostics.length === 0, issues: status.diagnostics };
    },

    async "operations.usage"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "operations.usage payload");
      for (const key of Object.keys(value)) if (key !== "windowMinutes") throw new Error(`unsupported usage option: ${key}`);
      const windowMinutes = boundedInteger(value.windowMinutes, "windowMinutes", 1, 10_080, 60);
      return client.request("get_usage", { windowMinutes });
    },

    async "operations.events"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "operations.events payload");
      const limit = boundedInteger(value.limit, "limit", 1, 500, 100);
      const status = await client.request("get_status", {});
      const lines = [];
      for (const filePath of [`${status.daemon.logPath}.1`, status.daemon.logPath]) {
        try {
          const content = await readFile(filePath, "utf8");
          for (const line of content.split("\n")) if (line) lines.push(line);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const events = [];
      for (const line of lines.slice(-limit)) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      return { events, truncated: lines.length > limit, logPath: status.daemon.logPath };
    },

    async "session_history.query"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "session_history.query payload");
      const supported = new Set(["operation", "query", "sessionId", "entryId", "kind", "includeDeleted",
        "includeCurrent", "roles", "limit", "sort", "snippetChars", "before", "after", "maxChars"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported session history option: ${key}`);
      return client.request("session_history", value);
    },

    async "cron.manage"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      return client.request("cron_job", requireRecord(payload, "cron.manage payload"));
    },

    async "agent_message.list_agents"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const result = await client.request("get_roster", {});
      return { agents: result.agents.map(projectManagedSession) };
    },

    async "agent_message.send"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "agent_message.send payload");
      const result = await client.request("send_message", {
        target: requireString(value.target, "target", { maxBytes: 256 }),
        body: requireString(value.body, "body", { maxBytes: 16 * 1024 }),
        deliveryMode: value.deliveryMode ?? "auto",
      });
      await recordAgentMessage(result.message);
      return result;
    },

    async "rlm.spawn"(payload) {
      const client = getClient();
      const context = getContext();
      const manifest = getManifest();
      if (!client?.isConnected) throw new Error("harness is offline");
      if (client.connectedSession.depth >= client.limits.maxDepth) {
        throw new Error(`maximum child depth ${client.limits.maxDepth} would be exceeded`);
      }
      if (!context?.model) throw new Error("the parent session has no resolved model");
      if (!manifest) throw new Error("the parent skill manifest is unavailable");
      const value = requireRecord(payload, "rlm.spawn payload");
      const supported = new Set(["prompt", "name", "model", "thinkingLevel", "forkContext"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported rlm option: ${key}`);
      const forkContext = value.forkContext === undefined ? false : value.forkContext;
      if (typeof forkContext !== "boolean") throw new Error("fork_context must be boolean");
      // Capture the active branch before admission awaits. The pending ipython
      // call is present in Pi's synchronized transcript, but is never replayed.
      let forkLeafId;
      if (forkContext) {
        if (typeof context.sessionManager?.getLeafId !== "function") throw new Error("parent context fork is unavailable");
        forkLeafId = context.sessionManager.getLeafId();
        if (forkLeafId !== null && (typeof forkLeafId !== "string" || !forkLeafId)) {
          throw new Error("parent context fork boundary is unavailable");
        }
      }
      const models = context.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning === true,
        thinkingLevels: supportedThinkingLevels(model),
      }));
      const skillCatalog = manifest.skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        contentHash: skill.contentHash,
        skillPath: skill.skillPath,
        pythonBacked: Boolean(skill.python),
      }));
      await client.request("set_skill_manifest", { skills: skillCatalog });
      const prompt = requireString(value.prompt, "prompt", { maxBytes: 32 * 1024 });
      const result = await client.request("spawn_child", {
        prompt,
        ...(forkContext ? { forkContext: true, forkLeafId } : {}),
        name: value.name === null || value.name === undefined ? null : requireString(value.name, "name", { maxBytes: 64 }),
        model: value.model === null || value.model === undefined ? null : requireString(value.model, "model", { maxBytes: 384 }),
        thinkingLevel: value.thinkingLevel === null || value.thinkingLevel === undefined
          ? null
          : requireString(value.thinkingLevel, "thinking_level", { maxBytes: 16 }),
        parentModel: {
          provider: context.model.provider,
          id: context.model.id,
          name: context.model.name ?? context.model.id,
          reasoning: context.model.reasoning === true,
          thinkingLevels: supportedThinkingLevels(context.model),
        },
        parentThinkingLevel: context.thinkingLevel ?? "off",
        availableModels: models,
      });
      await recordChildCreation(result?.childCreation);
      const { childCreation: _childCreation, ...publicResult } = result;
      return publicResult;
    },

    async "rlm.find_models"(payload) {
      const context = getContext();
      if (!context) throw new Error("session context is unavailable");
      const value = requireRecord(payload, "rlm.find_models payload");
      const supported = new Set(["query", "limit"]);
      for (const key of Object.keys(value)) if (!supported.has(key)) throw new Error(`unsupported find_models option: ${key}`);
      const models = context.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name ?? model.id,
        reasoning: model.reasoning === true,
        thinkingLevels: supportedThinkingLevels(model),
      }));
      const preferred = [];
      if (context.model?.provider && context.model?.id) {
        preferred.push({ provider: context.model.provider, id: context.model.id });
      }
      if (models.some((model) => model.provider === "grok-cli" && model.id === "grok-4.6")) {
        preferred.push({ provider: "grok-cli", id: "grok-4.6" });
      }
      return {
        models: findModels(models, value.query ?? "", value.limit ?? 50, preferred),
      };
    },

    async "rlm.list_subagents"() {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const result = await client.request("list_children", {});
      return { children: result.children.map(projectManagedSession) };
    },

    async "rlm.stop_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.stop_subagent payload");
      const result = await client.request("stop_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },

    async "rlm.revive_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.revive_subagent payload");
      const result = await client.request("revive_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },

    async "rlm.delete_subagent"(payload) {
      const client = getClient();
      if (!client?.isConnected) throw new Error("harness is offline");
      const value = requireRecord(payload, "rlm.delete_subagent payload");
      const result = await client.request("delete_child", { selector: requireString(value.selector, "selector", { maxBytes: 256 }) });
      return { child: projectManagedSession(result.child) };
    },
  };
}

export const hostLimits = {
  maxReadBytes: MAX_READ_BYTES,
  maxWriteBytes: MAX_WRITE_BYTES,
  maxSearchFiles: MAX_SEARCH_FILES,
  maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
  maxShellCaptureBytes: MAX_SHELL_CAPTURE_BYTES,
  maxGrepFiles: MAX_GREP_FILES,
  maxGrepFileBytes: MAX_SEARCH_SOURCE_BYTES,
  maxGrepTotalBytes: MAX_GREP_TOTAL_BYTES,
  maxGrepLineBytes: MAX_GREP_LINE_BYTES,
  maxGrepOutputBytes: MAX_GREP_OUTPUT_BYTES,
  maxGrepRuntimeMs: MAX_GREP_RUNTIME_MS,
};
