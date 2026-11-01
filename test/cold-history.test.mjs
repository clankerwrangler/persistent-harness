import assert from "node:assert/strict";
import test from "node:test";
import { projectCanonicalSource, registerCanonicalSessionManager, releaseColdHeaders } from "../src/canonical-context.mjs";

const user = content => ({ role: "user", content, timestamp: 1 });

function fixture(messages) {
  const entries = messages.map((message, index) => ({ type: "message", id: `e${index}`,
    parentId: index ? `e${index - 1}` : null, message }));
  const session = { reads: [], revision: 0 };
  const messageEntries = () => entries.filter(entry => entry.type === "message");
  const manager = {
    getRevision: () => ({ revision: session.revision, generation: 0 }), getEntryCount: () => entries.length,
    getLeafId: () => entries.at(-1)?.id ?? null,
    getEntriesRange: (start, count) => structuredClone(entries.slice(start, start + count)),
    getEntry: id => structuredClone(entries.find(entry => entry.id === id)),
    buildSessionSource: () => ({ contextEntryIds: entries.map(entry => entry.id),
      contributions: messageEntries().map(entry => ({ key: entry.id, sourceEntryId: entry.id, messageIndex: 0, role: entry.message.role })),
      read: index => { session.reads.push(index); return messageEntries()[index].message; },
      validate: () => {}, currentSystemMessage: () => undefined }),
  };
  session.bookmark = (entryId, count, enabled = true) => {
    entries.push({ type: "custom", customType: "live-context-state", id: `s${entries.length}`, parentId: entries.at(-1).id,
      data: { enabled, checkpoint: { sourceEntryId: entryId, sourceMessageCount: count } } });
    session.revision++;
  };
  session.append = message => {
    entries.push({ type: "message", id: `e${entries.length}`, parentId: entries.at(-1).id, message });
    session.revision++;
  };
  registerCanonicalSessionManager(manager, { estimateContextTokens: () =>
    ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }) });
  return { manager, session, project: (mode = "native") => projectCanonicalSource({ sessionManager: manager, mode }).source };
}

test("messages after the bookmark are read without touching older ones", () => {
  const { session, project } = fixture(["a", "b", "c"].map(user));
  session.bookmark("e1", 2); session.append(user("d"));
  const source = project();
  assert.equal(source.length, 4);
  assert.equal(source.contributions.length, 4);
  session.reads.length = 0;
  assert.deepEqual([source.read(2), source.read(3)], [user("c"), user("d")]);
  assert.deepEqual(session.reads, [2, 3]);
});

test("the result matches a session with no bookmark", () => {
  const messages = ["a", "b", "c", "d"].map(user);
  const plain = fixture(messages).project().readAll();
  const { session, manager, project } = fixture(messages);
  session.bookmark("e2", 3);
  releaseColdHeaders(manager);
  assert.deepEqual(project().readAll(), plain);
  assert.equal(project().read(0).content, "a", "an older message is still readable");
});

test("cards before the bookmark shrink, and new messages still project", () => {
  const { session, manager, project } = fixture(["a", "b", "c"].map(user));
  project();
  session.bookmark("e1", 2);
  assert.equal(releaseColdHeaders(manager), 2);
  assert.equal(releaseColdHeaders(manager), 0);
  session.append(user("d"));
  assert.deepEqual(project().read(3), user("d"));
});

test("anything that doesn't line up takes the full path", () => {
  for (const [entryId, count, enabled] of [["e1", 5, true], ["missing", 2, true], ["e1", 2, false]]) {
    const { session, project } = fixture(["a", "b", "c"].map(user));
    session.bookmark(entryId, count, enabled);
    const source = project();
    session.reads.length = 0;
    assert.deepEqual(source.readAll(), ["a", "b", "c"].map(user));
  }
});

test("ordinary mode never stays cold", () => {
  const { session, project } = fixture(["a", "b", "c"].map(user));
  session.bookmark("e1", 2);
  const source = project("ordinary");
  session.reads.length = 0;
  source.read(0);
  assert.deepEqual(session.reads, [0]);
});
