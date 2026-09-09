export const MAX_INPUT_IMAGE_COUNT = 4;
export const MAX_INPUT_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_INPUT_REQUEST_BYTES = 5 * 1024 * 1024;
export const INPUT_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);
export const MAX_INPUT_IMAGE_DIMENSION = 8192;
export const MAX_INPUT_IMAGE_PIXELS = 16_000_000;
export const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;

const MAX_BASE64_CHARACTERS = 4 * Math.ceil(MAX_INPUT_IMAGE_BYTES / 3);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function imageDimensions(bytes, mimeType) {
  if (mimeType === "image/png") {
    if (bytes.length < 26 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      || bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
    const colorType = bytes[25]; const samples = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]).get(colorType);
    const bitDepth = bytes[24]; const allowedDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);
    if (!samples || !allowedDepths.get(colorType)?.includes(bitDepth)) return undefined;
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    return { width, height, decodedBytes: (Math.ceil(width * samples * bitDepth / 8) + 1) * height };
  }
  if (mimeType !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (startOfFrame.has(marker) && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
  return undefined;
}

export function normalizeInputImages(value, { allowMetadata = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_INPUT_IMAGE_COUNT) {
    throw new Error(`images must be an array of at most ${MAX_INPUT_IMAGE_COUNT} items`);
  }
  let totalBytes = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`images[${index}] must be an object`);
    const supported = new Set(["type", "data", "mimeType", ...(allowMetadata ? ["name", "size"] : [])]);
    for (const key of Object.keys(raw)) if (!supported.has(key)) throw new Error(`images[${index}].${key} is not supported`);
    if (raw.type !== "image") throw new Error(`images[${index}].type must be image`);
    if (typeof raw.mimeType !== "string" || !INPUT_IMAGE_MIME_TYPES.has(raw.mimeType)) {
      throw new Error(`images[${index}].mimeType must be image/png or image/jpeg`);
    }
    if (typeof raw.data !== "string" || !raw.data || raw.data.length > MAX_BASE64_CHARACTERS || !BASE64.test(raw.data)) {
      throw new Error(`images[${index}].data must be bounded canonical base64`);
    }
    const bytes = Buffer.from(raw.data, "base64");
    if (bytes.toString("base64") !== raw.data) throw new Error(`images[${index}].data must be canonical base64`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_INPUT_IMAGE_BYTES) throw new Error(`images exceed the ${MAX_INPUT_IMAGE_BYTES} byte total limit`);
    const mimeType = raw.mimeType;
    const dimensions = imageDimensions(bytes, mimeType);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_INPUT_IMAGE_DIMENSION
      || dimensions.height > MAX_INPUT_IMAGE_DIMENSION || dimensions.width * dimensions.height > MAX_INPUT_IMAGE_PIXELS
      || (dimensions.decodedBytes ?? dimensions.width * dimensions.height * 4) > MAX_DECODED_IMAGE_BYTES) {
      throw new Error(`images[${index}] has an invalid or oversized ${mimeType} container`);
    }
    const normalized = { type: "image", data: raw.data, mimeType };
    if (allowMetadata) {
      const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 256) : `Pasted image ${index + 1}`;
      return { ...normalized, name, size: bytes.length };
    }
    return normalized;
  });
}

