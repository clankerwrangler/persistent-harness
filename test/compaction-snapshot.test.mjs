import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCanonicalContextSource, captureCanonicalCompactionSnapshot, registerCanonicalSessionManager } from "../src/canonical-context.mjs";

function fixture(count = 8, width = 2) {
  let reads = 0;
  const entries = Array.from({ length: count }, (_, i) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : null,
    type: "custom", customType: "opaque", data: { nested: Array.from({ length: width }, () => ({ text: "archive" })) } }));
  const stamp = { revision: count, generation: 1 }, identity = { session: "session", leaf: entries.at(-1).id, count };
  const manager = {
    getSessionId: () => identity.session, getLeafId: () => identity.leaf, getRevision: () => ({ ...stamp }),
    getEntryCount: () => identity.count, getEntriesRange: () => { throw new Error("archive range materialized"); },
    getEntries: () => { throw new Error("archive materialized"); },
    buildSessionEntryReader: () => ({ revision: { ...stamp }, leafId: identity.leaf, length: count, validate() {},
      getEntryHeader: i => ({ id: entries[i].id, parentId: entries[i].parentId, type: "custom", customType: "opaque", key: `key${i}` }),
      read: i => { reads++; return entries[i]; },
    }),
  };
  return { entries, manager, stamp, identity, reads: () => reads };
}

test("trusted compaction snapshot reads only requested bodies and owns detached hook views", () => {
  const f = fixture(6000, 180); // More than the unchanged two-million-node full-view budget.
  registerCanonicalSessionManager(f.manager);
  const snapshot = captureCanonicalCompactionSnapshot(f.manager);
  assert.equal(snapshot.managed, true);
  assert.equal(snapshot.branchEntries.length, 6000);
  assert.equal(f.reads(), 0);
  const entry = snapshot.branchEntries[5999];
  assert.equal(f.reads(), 1);
  entry.data.nested[0].text = "hook local";
  assert.equal(snapshot.branchEntries[5999], entry);
  assert.equal(f.entries[5999].data.nested[0].text, "archive");
  const second = snapshot.branch();
  assert.equal(second[5999].data.nested[0].text, "archive");
  assert.equal(f.reads(), 2);
  assert.throws(() => [...second], { code: "ERR_CONTEXT_DATA_LIMIT" });
  assert.throws(() => second[5999], { code: "ERR_CONTEXT_DATA_LIMIT" }); // Sticky aggregate failure.
  assert.throws(() => JSON.stringify(snapshot.branch()), { code: "ERR_CONTEXT_DATA_LIMIT" });
});

test("trusted compaction fence rejects revision, generation, identity, leaf and count movement", () => {
  for (const key of ["revision", "generation", "session", "leaf", "count"]) {
    const f = fixture(); registerCanonicalSessionManager(f.manager);
    const snapshot = captureCanonicalCompactionSnapshot(f.manager);
    const cached = snapshot.branchEntries[1];
    assert.equal(cached.id, "e1");
    if (key in f.stamp) f.stamp[key]++;
    else f.identity[key] = typeof f.identity[key] === "number" ? f.identity[key] + 1 : "moved";
    assert.equal(snapshot.isCurrent(), false, key);
    assert.throws(() => snapshot.branchEntries[0], { code: "ERR_CONTEXT_SOURCE_PROJECTION" }, key);
    assert.throws(() => snapshot.branchEntries[1], { code: "ERR_CONTEXT_SOURCE_PROJECTION" }, `${key} cached`);
    assert.equal(f.reads(), 1);
  }
});

test("unregistered lookalike managers retain nested active and inactive archive comparison", () => {
  for (const selected of [0, 1]) {
    const f = fixture(2);
    f.manager.getEntries = () => f.entries;
    f.manager.getLeafId = () => "e0";
    const snapshot = captureCanonicalCompactionSnapshot(f.manager);
    assert.equal(snapshot.managed, false);
    f.entries[selected].data.nested[0].text = "changed";
    assert.equal(snapshot.isCurrent(), false);
    assert.equal(snapshot.branchEntries[0].data.nested[0].text, "archive");
  }
});


test("lazy hook archive preserves aggregate string and per-record depth limits", t => {
  const previous = process.env.PI_HARNESS_CONTEXT_STRING_CODE_UNITS;
  delete process.env.PI_HARNESS_CONTEXT_STRING_CODE_UNITS;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_HARNESS_CONTEXT_STRING_CODE_UNITS;
    else process.env.PI_HARNESS_CONTEXT_STRING_CODE_UNITS = previous;
  });
  const f = fixture(2, 1);
  const text = "x".repeat(34 * 1024 * 1024);
  f.entries[0].data = { text }; f.entries[1].data = { text };
  registerCanonicalSessionManager(f.manager);
  const snapshot = captureCanonicalCompactionSnapshot(f.manager);
  assert.equal(snapshot.branchEntries[0].data.text, text);
  assert.throws(() => snapshot.branchEntries.map(entry => entry), { code: "ERR_CONTEXT_DATA_LIMIT" });
  const deep = fixture(1, 1);
  let value = {};
  for (let i = 0; i < 65; i++) value = { nested: value };
  deep.entries[0].data = value;
  registerCanonicalSessionManager(deep.manager);
  const invalid = captureCanonicalCompactionSnapshot(deep.manager);
  assert.throws(() => invalid.branchEntries[0], { code: "ERR_CONTEXT_DATA_LIMIT" });
});


test("bounded source rejects invalid or oversized advertised views before body allocation", () => {
  let reads = 0;
  for (const length of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2_000_000, "3"]) {
    const source = { length, contributions: [], validate() {}, read() { reads++; throw new Error("unexpected read"); } };
    assert.throws(() => boundedCanonicalContextSource(source));
  }
  assert.throws(() => boundedCanonicalContextSource({ length: 2, contributions: [{}], validate() {} }), { code: "ERR_CONTEXT_SOURCE_PROJECTION" });
  const source = { length: 1, contributions: [{ key: "one" }], validate() {}, read() { reads++; return { role: "user", content: "one" }; } };
  const bounded = boundedCanonicalContextSource(source);
  assert.equal(bounded.readAll().length, 1);
  source.length = 1000000000;
  assert.throws(() => bounded.readAll(), { code: "ERR_CONTEXT_SOURCE_PROJECTION" });
  assert.equal(reads, 1);
});
