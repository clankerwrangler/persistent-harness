import { constants as fsConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const {
  root,
  pattern,
  limit,
  maxVisitedEntries,
  maxFiles,
  maxFileBytes,
  maxTotalBytes,
  maxLineBytes,
  maxOutputBytes,
} = workerData;

const LINE_TRUNCATION_MARKER = "... line truncated ...";
const READ_CHUNK_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const truncatedDecoder = new TextDecoder("utf-8", { fatal: false });
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
const FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

function fdChild(handle, name) {
  if (!name || name === "." || name === ".." || name.includes(path.sep)) throw new Error("invalid directory entry");
  return `/proc/self/fd/${handle.fd}/${name}`;
}

function truncateUtf8(text, maxBytes, marker = "") {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker);
  const budget = Math.max(0, maxBytes - markerBytes);
  let used = 0;
  let result = "";
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes > budget) break;
    result += character;
    used += bytes;
  }
  return result + (markerBytes <= maxBytes ? marker : "");
}

function hasSuffix(displayPath, suffix) {
  return displayPath.toLowerCase().endsWith(suffix);
}

function decodeLine(bytes, truncatedLine) {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (!truncatedLine) throw error;
    return truncatedDecoder.decode(bytes);
  }
}

async function grep() {
  let expression;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }

  const matches = [];
  const stats = {
    visitedEntries: 0,
    inspectedFiles: 0,
    inspectedBytes: 0,
    outputBytes: 2,
    skippedBinary: 0,
    skippedOversized: 0,
    skippedUnreadable: 0,
  };
  let truncated = false;
  let stop = false;

  const pushMatch = (displayPath, line, text) => {
    if (matches.length >= limit) {
      truncated = true;
      stop = true;
      return false;
    }
    const match = { path: displayPath, line, text };
    const matchBytes = Buffer.byteLength(JSON.stringify(match)) + (matches.length === 0 ? 0 : 1);
    if (stats.outputBytes + matchBytes > maxOutputBytes) {
      truncated = true;
      stop = true;
      return false;
    }
    matches.push(match);
    stats.outputBytes += matchBytes;
    return true;
  };

  const inspectStream = async (handle, displayPath, byteBudget, lineCap) => {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let fileOffset = 0;
    let lineParts = [];
    let lineBytes = 0;
    let lineNumber = 1;
    let skippingRestOfLine = false;
    let consumed = 0;

    const emitLine = (raw, truncatedLine) => {
      if (raw.includes(0)) return "binary";
      let content;
      try {
        content = decodeLine(raw, truncatedLine);
      } catch {
        return "binary";
      }
      if (content.endsWith("\r")) content = content.slice(0, -1);
      expression.lastIndex = 0;
      if (expression.test(content)) {
        const text = truncateUtf8(
          content,
          maxLineBytes,
          LINE_TRUNCATION_MARKER,
        );
        if (!pushMatch(displayPath, lineNumber, text)) return "stop";
      }
      lineNumber += 1;
      return "ok";
    };

    const takeLine = (piece) => {
      let raw;
      if (lineParts.length === 0) raw = Buffer.from(piece);
      else {
        lineParts.push(Buffer.from(piece));
        raw = Buffer.concat(lineParts, lineBytes + piece.length);
        lineParts = [];
        lineBytes = 0;
      }
      const truncatedLine = raw.length > lineCap;
      if (truncatedLine) raw = raw.subarray(0, lineCap);
      return emitLine(raw, truncatedLine);
    };

    while (!stop && consumed < byteBudget) {
      const toRead = Math.min(chunk.length, byteBudget - consumed);
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, toRead, fileOffset));
      } catch {
        stats.skippedUnreadable += 1;
        return;
      }
      if (bytesRead === 0) break;
      fileOffset += bytesRead;
      consumed += bytesRead;
      stats.inspectedBytes += bytesRead;

      let start = 0;
      while (start < bytesRead) {
        if (skippingRestOfLine) {
          const relative = chunk.subarray(start, bytesRead).indexOf(0x0a);
          if (relative < 0) {
            start = bytesRead;
            break;
          }
          skippingRestOfLine = false;
          start += relative + 1;
          continue;
        }
        const relative = chunk.subarray(start, bytesRead).indexOf(0x0a);
        if (relative < 0) {
          const piece = chunk.subarray(start, bytesRead);
          if (lineBytes + piece.length > lineCap) {
            const keep = Math.max(0, lineCap - lineBytes);
            if (keep > 0) lineParts.push(Buffer.from(piece.subarray(0, keep)));
            const raw = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, Math.min(lineBytes + keep, lineCap));
            const status = emitLine(raw, true);
            lineParts = [];
            lineBytes = 0;
            skippingRestOfLine = true;
            if (status === "binary") {
              stats.skippedBinary += 1;
              return;
            }
            if (status === "stop") return;
            start = bytesRead;
            break;
          }
          lineParts.push(Buffer.from(piece));
          lineBytes += piece.length;
          start = bytesRead;
          break;
        }
        const status = takeLine(chunk.subarray(start, start + relative));
        if (status === "binary") {
          stats.skippedBinary += 1;
          return;
        }
        if (status === "stop") return;
        start += relative + 1;
      }
    }

    if (stop) return;
    if (skippingRestOfLine) return;
    if (lineParts.length || lineBytes > 0) {
      const raw = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
      const status = emitLine(raw.length > lineCap ? raw.subarray(0, lineCap) : raw, raw.length > lineCap);
      if (status === "binary") stats.skippedBinary += 1;
    }
    if (consumed >= byteBudget) {
      try {
        const current = await handle.stat();
        if (current.size > consumed) {
          truncated = true;
          stop = true;
        }
      } catch {
        // The inspected prefix is still valid if a late stat fails.
      }
    }
  };

  const inspectHandle = async (handle, displayPath, { explicitFile = false } = {}) => {
    if (stop) return;
    if (stats.inspectedFiles >= maxFiles) {
      truncated = true;
      stop = true;
      return;
    }
    let before;
    try {
      before = await handle.stat();
    } catch {
      stats.skippedUnreadable += 1;
      return;
    }
    if (!before.isFile()) return;

    const mapFile = hasSuffix(displayPath, ".map");
    const jsonlFile = hasSuffix(displayPath, ".jsonl");
    if (mapFile && !explicitFile) {
      stats.skippedOversized += 1;
      return;
    }

    stats.inspectedFiles += 1;
    const remainingBytes = maxTotalBytes - stats.inspectedBytes;
    if (remainingBytes <= 0) {
      truncated = true;
      stop = true;
      return;
    }

    const streamable = jsonlFile || (explicitFile && mapFile);
    if (before.size > maxFileBytes && !streamable) {
      stats.skippedOversized += 1;
      return;
    }
    if (!streamable && before.size > remainingBytes) {
      truncated = true;
      stop = true;
      return;
    }

    const lineCap = mapFile ? maxLineBytes : maxFileBytes;
    await inspectStream(handle, displayPath, streamable ? remainingBytes : Math.min(maxFileBytes, remainingBytes), lineCap);
  };

  const recurseHandle = async (directoryHandle, displayPath) => {
    if (stop) return;
    let names;
    try {
      // Enumeration is anchored to the already-open directory. Names are only
      // hints: every child is opened again with O_NOFOLLOW before its type is used.
      names = await readdir(`/proc/self/fd/${directoryHandle.fd}`);
    } catch {
      stats.skippedUnreadable += 1;
      return;
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (stop) return;
      if (stats.visitedEntries >= maxVisitedEntries) {
        truncated = true;
        stop = true;
        return;
      }
      stats.visitedEntries += 1;
      const childPath = fdChild(directoryHandle, name);
      const childDisplayPath = path.join(displayPath, name);
      let childDirectory;
      try {
        childDirectory = await open(childPath, DIRECTORY_FLAGS);
      } catch (error) {
        if (!["ENOTDIR", "ELOOP", "ENOENT"].includes(error?.code)) {
          stats.skippedUnreadable += 1;
          continue;
        }
      }
      if (childDirectory) {
        try {
          await recurseHandle(childDirectory, childDisplayPath);
        } finally {
          await childDirectory.close().catch(() => {});
        }
        continue;
      }
      let childFile;
      try {
        childFile = await open(childPath, FILE_FLAGS);
        await inspectHandle(childFile, childDisplayPath);
      } catch (error) {
        // ELOOP is an intentional symlink skip; all other races/unreadable
        // entries are also skipped rather than retried through a pathname.
        if (error?.code !== "ELOOP") stats.skippedUnreadable += 1;
      } finally {
        await childFile?.close().catch(() => {});
      }
    }
  };

  let rootDirectory;
  try {
    rootDirectory = await open(root, DIRECTORY_FLAGS);
  } catch (error) {
    if (!["ENOTDIR", "ELOOP"].includes(error?.code)) throw error;
    if (error?.code === "ELOOP") throw new Error("grep path must not be a symlink");
  }
  if (rootDirectory) {
    try {
      await recurseHandle(rootDirectory, root);
    } finally {
      await rootDirectory.close();
    }
  } else {
    let rootFile;
    try {
      rootFile = await open(root, FILE_FLAGS);
      const rootStat = await rootFile.stat();
      if (!rootStat.isFile()) throw new Error("grep path must be a file or directory");
      await inspectHandle(rootFile, root, { explicitFile: true });
    } catch (error) {
      if (error?.code === "ELOOP") throw new Error("grep path must not be a symlink");
      throw error;
    } finally {
      await rootFile?.close().catch(() => {});
    }
  }

  return { path: root, pattern, matches, truncated, stats };
}

grep().then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (error) => parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
  }),
);
