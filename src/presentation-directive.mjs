export const PRESENTATION_SCHEMA = "taihou.presentation.v1";
export const PRESENTATION_DIRECTIVE_MAX_BYTES = 256;
export const PRESENTATION_BODY_VALUES = Object.freeze([
  "amazed", "doubt", "emotion", "encourage", "enquire", "excited", "happy", "hello",
  "invite", "refuse", "sad", "satisfied", "shy", "talk-01", "talk-02", "yandere",
]);
export const PRESENTATION_FACE_VALUES = Object.freeze([
  "common", "amazed", "happy", "helpless", "shame", "shy", "smile", "think",
]);
export const DEFAULT_PRESENTATION = Object.freeze({ schema: PRESENTATION_SCHEMA, body: "talk-01", face: "common" });

const BODY = new Set(PRESENTATION_BODY_VALUES);
const FACE = new Set(PRESENTATION_FACE_VALUES);
const RESERVED_PREFIX = "<!-- taihou.presentation";
const EXACT_DIRECTIVE = /^<!-- taihou\.presentation\.v1 body=([^ ]+) face=([^ ]+) -->\n$/;
const ASCII_INDENT = /^[ \t]*$/;

function cue(body, face) { return Object.freeze({ schema: PRESENTATION_SCHEMA, body, face }); }

/**
 * Exact bounded streaming filter. Only an exact unindented first LF line selects a cue.
 * Any reserved presentation line (including indented, malformed, duplicate, or later) is scrubbed.
 */
export class PresentationDirectiveFilter {
  #state = "candidate";
  #buffer = "";
  #reservedOverlong = false;
  #firstLine = true;
  #resolved = false;
  #recognized = false;
  #presentation = DEFAULT_PRESENTATION;

  constructor({ maxBytes = PRESENTATION_DIRECTIVE_MAX_BYTES } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 4096) throw new Error("presentation directive maxBytes is invalid");
    this.maxBytes = maxBytes;
  }

  get resolved() { return this.#resolved; }
  get recognized() { return this.#recognized; }
  get presentation() { return this.#presentation; }
  get bufferedBytes() { return Buffer.byteLength(this.#buffer, "utf8"); }

  push(value) {
    const delta = typeof value === "string" ? value : ""; if (!delta) return "";
    let output = ""; let offset = 0;
    while (offset < delta.length) {
      if (this.#state === "ordinary") {
        const newline = delta.indexOf("\n", offset);
        if (newline < 0) { output += delta.slice(offset); break; }
        output += delta.slice(offset, newline + 1); offset = newline + 1;
        this.#firstLine = false; this.#state = "candidate"; this.#buffer = ""; continue;
      }
      if (this.#state === "reserved") {
        const newline = delta.indexOf("\n", offset);
        if (newline < 0) { this.#appendReserved(delta.slice(offset)); break; }
        this.#appendReserved(delta.slice(offset, newline + 1)); offset = newline + 1;
        this.#finishReservedLine(); continue;
      }

      const character = delta[offset++]; this.#buffer += character;
      const indentLength = this.#buffer.search(/[^ \t]/);
      const indent = indentLength < 0 ? this.#buffer.length : indentLength;
      const remainder = this.#buffer.slice(indent);
      if (remainder && (RESERVED_PREFIX.startsWith(remainder) || remainder.startsWith(RESERVED_PREFIX))) {
        if (remainder.startsWith(RESERVED_PREFIX)) this.#state = "reserved";
        continue;
      }
      if (!remainder && ASCII_INDENT.test(this.#buffer) && this.bufferedBytes <= this.maxBytes) continue;

      if (this.#firstLine) this.#resolveDefault();
      output += this.#buffer; const ended = character === "\n"; this.#buffer = "";
      if (ended) { this.#firstLine = false; this.#state = "candidate"; }
      else this.#state = "ordinary";
    }
    return output;
  }

  finish() {
    if (this.#state === "ordinary") { if (!this.#resolved) this.#resolveDefault(); return ""; }
    if (this.#state === "reserved") { this.#buffer = ""; this.#reservedOverlong = false; if (this.#firstLine) this.#resolveDefault(); return ""; }
    const indentLength = this.#buffer.search(/[^ \t]/); const indent = indentLength < 0 ? this.#buffer.length : indentLength;
    const remainder = this.#buffer.slice(indent);
    if (remainder && RESERVED_PREFIX.startsWith(remainder)) { this.#buffer = ""; if (this.#firstLine) this.#resolveDefault(); return ""; }
    const text = this.#buffer; this.#buffer = ""; if (!this.#resolved) this.#resolveDefault(); return text;
  }

  #appendReserved(text) {
    if (this.#reservedOverlong) return;
    this.#buffer += text;
    if (this.bufferedBytes > this.maxBytes) { this.#buffer = ""; this.#reservedOverlong = true; }
  }
  #finishReservedLine() {
    if (this.#firstLine) {
      if (!this.#reservedOverlong) {
        const match = EXACT_DIRECTIVE.exec(this.#buffer);
        if (match && BODY.has(match[1]) && FACE.has(match[2])) {
          this.#presentation = cue(match[1], match[2]); this.#recognized = true; this.#resolved = true;
        } else this.#resolveDefault();
      } else this.#resolveDefault();
    }
    this.#buffer = ""; this.#reservedOverlong = false; this.#firstLine = false; this.#state = "candidate";
  }
  #resolveDefault() { if (!this.#resolved) { this.#presentation = DEFAULT_PRESENTATION; this.#recognized = false; this.#resolved = true; } }
}

export function sanitizePresentationText(value, options) {
  const filter = new PresentationDirectiveFilter(options);
  const text = filter.push(typeof value === "string" ? value : "") + filter.finish();
  return { text, presentation: filter.presentation, recognized: filter.recognized };
}
export function presentationEquals(left, right) {
  return left?.schema === PRESENTATION_SCHEMA && right?.schema === PRESENTATION_SCHEMA
    && left.body === right.body && left.face === right.face;
}
export function isPresentation(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.schema === PRESENTATION_SCHEMA
    && BODY.has(value.body) && FACE.has(value.face);
}
