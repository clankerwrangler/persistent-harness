import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRESENTATION, PRESENTATION_BODY_VALUES, PRESENTATION_FACE_VALUES,
  PresentationDirectiveFilter, sanitizePresentationText,
} from "../src/presentation-directive.mjs";

const line = (body = "happy", face = "smile") => `<!-- taihou.presentation.v1 body=${body} face=${face} -->\n`;

function through(parts, options) {
  const filter = new PresentationDirectiveFilter(options); let text = "";
  for (const part of parts) { text += filter.push(part); assert(filter.bufferedBytes <= (options?.maxBytes ?? 256)); }
  text += filter.finish(); return { text, presentation: filter.presentation, recognized: filter.recognized };
}

test("exact directive accepts every allowlisted logical body and face value", () => {
  assert.deepEqual(PRESENTATION_BODY_VALUES, ["amazed", "doubt", "emotion", "encourage", "enquire", "excited", "happy", "hello", "invite", "refuse", "sad", "satisfied", "shy", "talk-01", "talk-02", "yandere"]);
  assert.deepEqual(PRESENTATION_FACE_VALUES, ["common", "amazed", "happy", "helpless", "shame", "shy", "smile", "think"]);
  for (const body of PRESENTATION_BODY_VALUES) for (const face of PRESENTATION_FACE_VALUES) {
    assert.deepEqual(sanitizePresentationText(`${line(body, face)}Visible.`), {
      text: "Visible.", presentation: { schema: "taihou.presentation.v1", body, face }, recognized: true,
    });
  }
});

test("canonical marker is withheld and scrubbed at every possible binary split", () => {
  const source = `${line()}Hello, Commander.`;
  for (let split = 0; split <= source.length; split += 1) {
    assert.deepEqual(through([source.slice(0, split), source.slice(split)]), {
      text: "Hello, Commander.", presentation: { schema: "taihou.presentation.v1", body: "happy", face: "smile" }, recognized: true,
    }, `split ${split}`);
  }
});

test("missing marker preserves ordinary prose and defaults", () => {
  for (const parts of [["Ordinary prose."], ["<", "!", " ordinary prose"], ["", "Hello"]]) {
    assert.deepEqual(through(parts), { text: parts.join(""), presentation: DEFAULT_PRESENTATION, recognized: false });
  }
});

test("malformed or invalid reserved first lines are scrubbed without deleting following prose", () => {
  for (const marker of [
    "<!-- taihou.presentation.v1 body=unknown face=smile -->\n",
    "<!-- taihou.presentation.v1 body=happy face=unknown -->\n",
    "<!-- taihou.presentation.v1 face=smile body=happy -->\n",
    "<!-- taihou.presentation.v1  body=happy face=smile -->\n",
    "<!-- TAIHOU.presentation.v1 body=happy face=smile -->\n",
    "<!-- taihou.presentation.v2 body=happy face=smile -->\n",
    "<!-- taihou.presentation.v1 body=happy face=smile -->\r\n",
  ]) {
    const expected = marker.startsWith("<!-- taihou.presentation") ? "Following prose." : `${marker}Following prose.`;
    assert.deepEqual(sanitizePresentationText(`${marker}Following prose.`), {
      text: expected, presentation: DEFAULT_PRESENTATION, recognized: false,
    }, marker);
  }
});

test("oversized and unterminated reserved prefixes never leak and remain bounded", () => {
  const oversized = `<!-- taihou.presentation.v1 ${"x".repeat(200)}\nSafe tail.`;
  const chunks = [...oversized];
  assert.deepEqual(through(chunks, { maxBytes: 64 }), { text: "Safe tail.", presentation: DEFAULT_PRESENTATION, recognized: false });
  assert.deepEqual(through(["<!-- taihou.presentation.v1 body=happy"]), { text: "", presentation: DEFAULT_PRESENTATION, recognized: false });
  assert.deepEqual(through(["<!-- taihou.pre"]), { text: "", presentation: DEFAULT_PRESENTATION, recognized: false });
});


test("indented, later, duplicate, malformed, and overlong reserved lines are scrubbed at every split", () => {
  const first = line("happy", "smile");
  const hostile = [
    "  <!-- taihou.presentation.v1 body=sad face=shame -->\n",
    "\t<!-- taihou.presentation.v1 face=smile body=happy -->\n",
    "<!-- taihou.presentation.v1 body=talk-02 face=think -->\n",
    `<!-- taihou.presentation.v1 ${"z".repeat(400)}\n`,
  ].join("");
  const source = `${first}Before.\n\`\`\`html\n${hostile}\`\`\`\nAfter.`;
  const expected = "Before.\n```html\n```\nAfter.";
  for (let split = 0; split <= source.length; split += 1) {
    assert.deepEqual(through([source.slice(0, split), source.slice(split)]), {
      text: expected, presentation: { schema: "taihou.presentation.v1", body: "happy", face: "smile" }, recognized: true,
    }, `split ${split}`);
  }
});
