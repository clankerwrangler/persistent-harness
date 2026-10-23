import path from "node:path";

const INTEGER_FIELDS = ["epoch", "revision", "generation", "sequence", "bytes"];
const FINGERPRINT_FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];

/** Internal numeric metadata from the authenticated worker channel, never an archive completeness claim. */
export function normalizeSourceWatermark(value, source) {
  if (!value || typeof value !== "object" || value.version !== 1
    || typeof value.owner !== "string" || !/^[a-f0-9-]{36}$/.test(value.owner)
    || INTEGER_FIELDS.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 128
    || typeof value.sessionFile !== "string" || !value.sessionFile || Buffer.byteLength(value.sessionFile) > 4096
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
    || !value.fingerprint || typeof value.fingerprint !== "object") return null;
  const sessionFile = path.resolve(value.sessionFile);
  if (source && (source.sessionId !== value.sessionId || path.resolve(source.sessionFile) !== sessionFile)) return null;
  const fingerprint = {};
  for (const key of FINGERPRINT_FIELDS) {
    const part = String(value.fingerprint[key]);
    if (!/^\d{1,30}$/.test(part)) return null;
    fingerprint[key] = part;
  }
  if (fingerprint.size !== String(value.bytes)) return null;
  return Object.freeze({ version: 1, owner: value.owner, epoch: value.epoch, revision: value.revision,
    generation: value.generation, sequence: value.sequence, sessionId: value.sessionId, sessionFile,
    bytes: value.bytes, digest: value.digest, fingerprint: Object.freeze(fingerprint) });
}

export function sameSourceWatermark(left, right) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

/** Coalescing may skip hints, never the contiguous byte range that the reader hashes. */
export function followsSourceWatermark(base, next) {
  return Boolean(base && next && base.owner === next.owner && base.epoch === next.epoch
    && base.generation === next.generation && base.sessionId === next.sessionId && base.sessionFile === next.sessionFile
    && base.fingerprint.dev === next.fingerprint.dev && base.fingerprint.ino === next.fingerprint.ino
    && next.bytes > base.bytes && next.sequence > base.sequence && next.revision >= base.revision);
}
