import { MAX_FRAME_BYTES, ProtocolError } from "./protocol.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export class JsonLineDecoder {
  #parts = [];
  #bytes = 0;
  #maxFrameBytes;

  constructor({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("frame chunk must be bytes");
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const values = [];
    let start = 0;
    while (start < source.length) {
      const newline = source.indexOf(0x0a, start);
      if (newline < 0) { this.#append(source.subarray(start)); break; }
      this.#append(source.subarray(start, newline));
      if (this.#bytes === 0) throw new ProtocolError("malformed_frame", "empty JSONL frame");
      let line = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts, this.#bytes);
      this.#parts = []; this.#bytes = 0;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) throw new ProtocolError("malformed_frame", "empty JSONL frame");
      let text;
      try { text = utf8.decode(line); }
      catch { throw new ProtocolError("malformed_frame", "frame is not valid UTF-8"); }
      try { values.push(JSON.parse(text)); }
      catch (error) { throw new ProtocolError("malformed_frame", `invalid JSON: ${error.message}`); }
      start = newline + 1;
    }
    return values;
  }

  #append(part) {
    if (part.length === 0) return;
    this.#bytes += part.length;
    if (this.#bytes > this.#maxFrameBytes) throw new ProtocolError("frame_too_large", `frame exceeds ${this.#maxFrameBytes} bytes`);
    this.#parts.push(part);
  }

  finish() {
    if (this.#bytes !== 0) throw new ProtocolError("malformed_frame", "connection ended with a partial frame");
  }
}

export function encodeFrame(frame, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  const payload = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (payload.length - 1 > maxFrameBytes) {
    throw new ProtocolError("frame_too_large", `frame exceeds ${maxFrameBytes} bytes`);
  }
  return payload;
}
