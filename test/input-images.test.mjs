import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INPUT_IMAGE_BYTES, normalizeInputImages } from "../src/input-images.mjs";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(26); Buffer.from("89504e470d0a1a0a", "hex").copy(bytes); bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = 8; bytes[25] = 6; return bytes.toString("base64");
}

test("input images are canonical, typed, dimension-bounded, and metadata-normalized", () => {
  assert.deepEqual(normalizeInputImages([{ type: "image", mimeType: "image/png", data: PNG_1X1, name: "shot.png", size: 1 }], { allowMetadata: true }),
    [{ type: "image", mimeType: "image/png", data: PNG_1X1, name: "shot.png", size: Buffer.from(PNG_1X1, "base64").length }]);
  assert.deepEqual(normalizeInputImages([{ type: "image", mimeType: "image/png", data: PNG_1X1 }]),
    [{ type: "image", mimeType: "image/png", data: PNG_1X1 }]);
  assert.throws(() => normalizeInputImages([{ type: "image", mimeType: "IMAGE/PNG", data: PNG_1X1 }]), /mimeType/);
  assert.throws(() => normalizeInputImages([{ type: "image", mimeType: "image/gif", data: "R0lGODlh" }]), /mimeType/);
  assert.throws(() => normalizeInputImages([{ type: "image", mimeType: "image/png", data: "AA==" }]), /container/);
  assert.throws(() => normalizeInputImages([{ type: "image", mimeType: "image/png", data: pngHeader(9000, 1) }]), /oversized/);
  assert.throws(() => normalizeInputImages(Array.from({ length: 5 }, () => ({ type: "image", mimeType: "image/png", data: PNG_1X1 }))), /at most 4/);
  assert(MAX_INPUT_IMAGE_BYTES >= Buffer.from(PNG_1X1, "base64").length);
});
