import { open } from "node:fs/promises";

const CHUNK_BYTES = 64 * 1024;

async function* reverseLines(file, size) {
  let position = size;
  let parts = [];
  while (position > 0) {
    const length = Math.min(position, CHUNK_BYTES);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) throw new Error("Event log changed while reading; retry operations.events().");
      filled += bytesRead;
    }
    let end = length;
    while (end > 0) {
      const newline = buffer.lastIndexOf(0x0a, end - 1);
      if (newline < 0) break;
      if (newline + 1 < end) parts.push(buffer.subarray(newline + 1, end));
      if (parts.length) {
        // Decode only complete lines so chunk boundaries cannot split UTF-8.
        yield Buffer.concat(parts.reverse()).toString("utf8");
        parts = [];
      }
      end = newline;
    }
    if (end > 0) parts.push(buffer.subarray(0, end));
  }
  if (parts.length) yield Buffer.concat(parts.reverse()).toString("utf8");
}

/** Read the newest nonempty lines, then apply the existing malformed-JSON filter. */
export async function readRecentEvents(logPath, limit) {
  const files = [];
  try {
    // Keep previous/current sampling order and pin opened inodes across rotation.
    // These two observations are not an atomic snapshot of the rotating log.
    for (const name of [`${logPath}.1`, logPath]) {
      let file;
      try { file = await open(name, "r"); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      const entry = { file };
      files.push(entry);
      entry.size = (await file.stat()).size;
    }
    const lines = [];
    for (const { file, size } of files.reverse()) {
      for await (const line of reverseLines(file, size)) {
        lines.push(line);
        if (lines.length > limit) break;
      }
      if (lines.length > limit) break;
    }
    const events = [];
    for (const line of lines.slice(0, limit).reverse()) {
      try { events.push(JSON.parse(line)); } catch {}
    }
    return { events, truncated: lines.length > limit, logPath };
  } finally {
    await Promise.all(files.map(({ file }) => file.close()));
  }
}
