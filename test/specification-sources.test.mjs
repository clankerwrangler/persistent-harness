import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSpecificationSources } from "./specification-sources.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = "export const value = 1;\n";
const pin = (source = "src/example.mjs", hash = digest(original)) => `\\*   ${source} sha256:${hash}`;
const moduleText = (...pins) => `---- MODULE Example ----\n\\* Sources:\n${pins.length ? `${pins.join("\n")}\n` : ""}EXTENDS Naturals\n====\n`;

function fixture(t) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "harness-spec-sources-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  mkdirSync(path.join(root, "specification"), { recursive: true });
  function write(relative, contents) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return file;
  }
  write("src/example.mjs", original);
  return { root, temporary, write, check: () => checkSpecificationSources(root) };
}

function expectFailure(result, ...patterns) {
  assert.ok(result.errors.length > 0, "invalid source metadata must fail");
  const detail = result.errors.join("\n");
  for (const pattern of patterns) assert.match(detail, pattern);
}

test("specification sources: every repository module pins reviewed source bytes", () => {
  const result = checkSpecificationSources(path.resolve(import.meta.dirname, ".."));
  assert.equal(result.errors.length, 0, `Source/model baseline validation failed:\n${result.errors.join("\n")}\nSee specification/README.md before updating pins.`);
});

test("synthetic: unchanged bytes pass for nested modules and real test/helper sources", (t) => {
  const f = fixture(t);
  const bytes = Buffer.from([0x00, 0x0d, 0x0a, 0x80, 0xff]);
  f.write("test/helpers/example source.mjs", bytes);
  f.write("specification/Example.tla", moduleText(pin(), pin("test/helpers/example source.mjs", digest(bytes))));
  f.write("specification/nested/deeper/Generated_TTrace_123.tla", moduleText(pin()));
  const result = f.check();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.modules, ["specification/Example.tla", "specification/nested/deeper/Generated_TTrace_123.tla"]);
  assert.equal(result.sourceCount, 2, "shared sources use the scan-local hash cache");
});

for (const [name, contents, pattern] of [
  ["missing Sources", "---- MODULE Example ----\nEXTENDS Naturals\n====\n", /missing Sources block/],
  ["misplaced Sources", `---- MODULE Example ----\nEXTENDS Naturals\n\\* Sources:\n${pin()}\n====\n`, /missing Sources block immediately after MODULE/],
  ["empty Sources", moduleText(), /empty Sources block/],
  ["missing MODULE", `\\* Sources:\n${pin()}\n====\n`, /missing MODULE declaration/],
]) {
  test(`synthetic: rejects ${name}`, (t) => {
    const f = fixture(t);
    f.write("specification/Example.tla", contents);
    expectFailure(f.check(), /specification\/Example\.tla/, pattern);
  });
}

test("synthetic: does not skip nested or generated modules without metadata", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin()));
  const nested = "specification/.generated/deep/Example_TTrace_123.tla";
  f.write(nested, "---- MODULE Example_TTrace_123 ----\nEXTENDS Naturals\n====\n");
  const result = f.check();
  assert.ok(result.modules.includes(nested));
  expectFailure(result, /\.generated\/deep\/Example_TTrace_123\.tla: missing Sources/);
});

test("synthetic: rejects missing source files", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin("src/missing.mjs")));
  expectFailure(f.check(), /specification\/Example\.tla: source src\/missing\.mjs/, /missing or unreadable \(ENOENT\)/);
});

test("synthetic: rejects non-file sources", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin("src")));
  expectFailure(f.check(), /source src is not a regular file/);
});

for (const [name, entry] of [
  ["absent digest", "\\*   src/example.mjs"],
  ["short digest", pin("src/example.mjs", "abc")],
  ["uppercase digest", pin("src/example.mjs", "A".repeat(64))],
  ["non-hex digest", pin("src/example.mjs", "g".repeat(64))],
  ["wrong algorithm", pin().replace("sha256:", "sha512:")],
  ["trailing annotation", `${pin()} reviewed`],
  ["wrong indentation", pin().replace("\\*   ", "\\* ")],
  ["empty entry", "\\*   "],
]) {
  test(`synthetic: rejects malformed pin with ${name}`, (t) => {
    const f = fixture(t);
    // A valid first entry must not conceal a malformed second entry.
    f.write("specification/Example.tla", moduleText(pin(), entry));
    expectFailure(f.check(), /specification\/Example\.tla:4: malformed source pin/, /64 lowercase hex digits/);
  });
}

for (const source of ["../outside.mjs", "src/../example.mjs", "./src/example.mjs", "/outside.mjs",
  "C:/outside.mjs", "C:outside.mjs", "src\\example.mjs", "src//example.mjs", "src/"]) {
  test(`synthetic: rejects noncanonical or escaping source path ${JSON.stringify(source)}`, (t) => {
    const f = fixture(t);
    f.write("specification/Example.tla", moduleText(pin(source)));
    expectFailure(f.check(), /source path .* must be canonical, repo-relative, and contained/);
  });
}

test("synthetic: rejects source symlinks that escape the repository", (t) => {
  const f = fixture(t);
  const outside = path.join(f.temporary, "outside.mjs");
  writeFileSync(outside, original);
  symlinkSync(outside, path.join(f.root, "src/alias.mjs"));
  f.write("specification/Example.tla", moduleText(pin("src/alias.mjs")));
  expectFailure(f.check(), /source src\/alias\.mjs resolves outside the repository/);
});

test("synthetic: contained source aliases share the hash cache without hiding wrong pins", (t) => {
  const f = fixture(t);
  symlinkSync("example.mjs", path.join(f.root, "src/alias.mjs"));
  f.write("specification/Example.tla", moduleText(pin()));
  f.write("specification/Nested.tla", moduleText(pin("src/alias.mjs")));
  assert.deepEqual(f.check().errors, []);
  assert.equal(f.check().sourceCount, 1);
  f.write("specification/Nested.tla", moduleText(pin("src/alias.mjs", "0".repeat(64))));
  expectFailure(f.check(), /specification\/Nested\.tla: source src\/alias\.mjs changed bytes/);
});

test("synthetic: rejects symbolic links in the specification inventory instead of skipping them", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin()));
  const target = path.join(f.temporary, "external-specification");
  mkdirSync(target);
  writeFileSync(path.join(target, "Unpinned.tla"), "---- MODULE Unpinned ----\n====\n");
  symlinkSync(target, path.join(f.root, "specification/linked"), "dir");
  expectFailure(f.check(), /specification\/linked: symbolic links/);
});

test("synthetic: rejects a symbolic specification root", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, "specification"), { recursive: true });
  symlinkSync(f.temporary, path.join(f.root, "specification"), "dir");
  expectFailure(f.check(), /specification: specification directory must be a regular directory/);
});

test("synthetic: rejects duplicate source pins", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin(), pin()));
  expectFailure(f.check(), /duplicate source pin for src\/example\.mjs/);
});

test("synthetic: empty or missing specification inventories fail instead of passing vacuously", (t) => {
  const f = fixture(t);
  expectFailure(f.check(), /no \.tla modules found/);
  rmSync(path.join(f.root, "specification"), { recursive: true });
  expectFailure(f.check(), /specification: cannot inspect \(ENOENT\)/, /no \.tla modules found/);
});

test("synthetic: changed source bytes fail even when file size and mtime are unchanged", (t) => {
  const f = fixture(t);
  f.write("specification/Example.tla", moduleText(pin()));
  const source = path.join(f.root, "src/example.mjs");
  const time = new Date("2020-01-01T00:00:00Z");
  utimesSync(source, time, time);
  const before = statSync(source);
  assert.deepEqual(f.check().errors, []);
  writeFileSync(source, original.replace("= 1", "= 2"));
  utimesSync(source, before.atime, before.mtime);
  assert.equal(statSync(source).mtimeMs, before.mtimeMs);
  assert.equal(statSync(source).size, before.size);
  expectFailure(f.check(), /specification\/Example\.tla: source src\/example\.mjs changed bytes/, /pinned sha256:[0-9a-f]{64}, current sha256:[0-9a-f]{64}/);
});
