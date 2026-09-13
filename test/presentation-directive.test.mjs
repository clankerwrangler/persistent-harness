import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEFAULT_PRESENTATION, PRESENTATION_BODY_VALUES, PRESENTATION_FACE_VALUES,
  PresentationDirectiveFilter, sanitizePresentationText,
} from "../src/presentation-directive.mjs";

const line = (body = "happy", face = "smile") => `<!-- harness.presentation.v1 body=${body} face=${face} -->\n`;

test("a configured namespace preserves streaming, validation, and history marker compatibility", () => {
  const moduleUrl = new URL("../src/presentation-directive.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { PresentationDirectiveFilter, PRESENTATION_SCHEMA, PRESENTATION_HISTORY_PREFIX, isPresentation } from ${JSON.stringify(moduleUrl)};
    assert.equal(PRESENTATION_SCHEMA, "example-agent.presentation.v1");
    const marker = "<!-- example-agent.presentation.v1 body=happy face=smile -->\\n";
    const source = marker + "Visible.\\n  " + marker + "Tail.";
    for (let split = 0; split <= source.length; split++) {
      const filter = new PresentationDirectiveFilter();
      const text = filter.push(source.slice(0, split)) + filter.push(source.slice(split)) + filter.finish();
      assert.equal(text, "Visible.\\nTail.");
      assert.equal(filter.recognized, true);
      assert.deepEqual(filter.presentation, { schema: PRESENTATION_SCHEMA, body: "happy", face: "smile" });
      assert(isPresentation(filter.presentation));
    }
    assert.equal((marker + "History.").replace(PRESENTATION_HISTORY_PREFIX, ""), "History.");
    assert(!isPresentation({ schema: "unrelated.presentation.v1", body: "happy", face: "smile" }));
  `], { env: { ...process.env, PI_HARNESS_PRESENTATION_NAMESPACE: "example-agent" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("configured namespaces reject markup and regular-expression syntax", () => {
  const moduleUrl = new URL("../src/presentation-directive.mjs", import.meta.url).href;
  for (const namespace of ["bad.*", "bad -->", "a".repeat(33)]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(moduleUrl)};`], {
      env: { ...process.env, PI_HARNESS_PRESENTATION_NAMESPACE: namespace }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PI_HARNESS_PRESENTATION_NAMESPACE must be/);
  }
});

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
      text: "Visible.", presentation: { schema: "harness.presentation.v1", body, face }, recognized: true,
    });
  }
});

test("canonical marker is withheld and scrubbed at every possible binary split", () => {
  const source = `${line()}Hello, user.`;
  for (let split = 0; split <= source.length; split += 1) {
    assert.deepEqual(through([source.slice(0, split), source.slice(split)]), {
      text: "Hello, user.", presentation: { schema: "harness.presentation.v1", body: "happy", face: "smile" }, recognized: true,
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
    "<!-- harness.presentation.v1 body=unknown face=smile -->\n",
    "<!-- harness.presentation.v1 body=happy face=unknown -->\n",
    "<!-- harness.presentation.v1 face=smile body=happy -->\n",
    "<!-- harness.presentation.v1  body=happy face=smile -->\n",
    "<!-- HARNESS.presentation.v1 body=happy face=smile -->\n",
    "<!-- harness.presentation.v2 body=happy face=smile -->\n",
    "<!-- harness.presentation.v1 body=happy face=smile -->\r\n",
  ]) {
    const expected = marker.startsWith("<!-- harness.presentation") ? "Following prose." : `${marker}Following prose.`;
    assert.deepEqual(sanitizePresentationText(`${marker}Following prose.`), {
      text: expected, presentation: DEFAULT_PRESENTATION, recognized: false,
    }, marker);
  }
});

test("oversized and unterminated reserved prefixes never leak and remain bounded", () => {
  const oversized = `<!-- harness.presentation.v1 ${"x".repeat(200)}\nSafe tail.`;
  const chunks = [...oversized];
  assert.deepEqual(through(chunks, { maxBytes: 64 }), { text: "Safe tail.", presentation: DEFAULT_PRESENTATION, recognized: false });
  assert.deepEqual(through(["<!-- harness.presentation.v1 body=happy"]), { text: "", presentation: DEFAULT_PRESENTATION, recognized: false });
  assert.deepEqual(through(["<!-- harness.pre"]), { text: "", presentation: DEFAULT_PRESENTATION, recognized: false });
});


test("indented, later, duplicate, malformed, and overlong reserved lines are scrubbed at every split", () => {
  const first = line("happy", "smile");
  const hostile = [
    "  <!-- harness.presentation.v1 body=sad face=shame -->\n",
    "\t<!-- harness.presentation.v1 face=smile body=happy -->\n",
    "<!-- harness.presentation.v1 body=talk-02 face=think -->\n",
    `<!-- harness.presentation.v1 ${"z".repeat(400)}\n`,
  ].join("");
  const source = `${first}Before.\n\`\`\`html\n${hostile}\`\`\`\nAfter.`;
  const expected = "Before.\n```html\n```\nAfter.";
  for (let split = 0; split <= source.length; split += 1) {
    assert.deepEqual(through([source.slice(0, split), source.slice(split)]), {
      text: expected, presentation: { schema: "harness.presentation.v1", body: "happy", face: "smile" }, recognized: true,
    }, `split ${split}`);
  }
});
