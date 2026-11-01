import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";

const VERSION = 1;
const DIGEST_BYTES = 32;

/** A missing, damaged or older file is ignored: the session then reads everything, as it would without one. */
export function readColdCards(file) {
  try {
    const bytes = readFileSync(file), payload = bytes.subarray(DIGEST_BYTES);
    if (!createHash("sha256").update(payload).digest().equals(bytes.subarray(0, DIGEST_BYTES))) return null;
    const cards = deserialize(payload);
    return cards?.version === VERSION ? cards : null;
  } catch { return null; }
}

/** Rename makes the write all-or-nothing. A crash leaves the previous file or none. */
export async function writeColdCards(file, cards) {
  const payload = serialize(cards), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, Buffer.concat([createHash("sha256").update(payload).digest(), payload]), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
