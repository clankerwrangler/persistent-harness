import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateUniqueRootName,
  defaultRootName,
  isDefaultRootName,
  shortSessionId,
  titleFromUserPrompt,
  titleFromFirstTurn,
  firstCompletedTitleTurn,
  normalizeGeneratedTitle,
  resolveRootTitle,
  rootTitleExcerpt,
  rootTitlePrompt,
} from "../src/root-title.mjs";

test("default root names stay cwd-basename plus short id", () => {
  const sessionId = "01a04cc6-3a4e-7d90-9435-d27bda1a12f0";
  assert.equal(shortSessionId(sessionId), "a004a2dd");
  assert.equal(defaultRootName("/workspace", sessionId), "workspace-a004a2dd");
  assert.equal(isDefaultRootName("workspace-a004a2dd", "/workspace", sessionId), true);
  assert.equal(isDefaultRootName("Auto-Rename", "/workspace", sessionId), false);
});

test("first Commander prompt becomes a short title", () => {
  assert.equal(
    titleFromUserPrompt("I want depth 0 sessions to be renamed automatically. Right now they're all called workspace- until I rename them."),
    "Depth 0 Sessions to Be Renamed Automatically",
  );
  assert.equal(titleFromUserPrompt("please review the avatar renderer PR"), "Review the Avatar Renderer PR");
  assert.equal(titleFromUserPrompt("Can you fix the login bug?"), "Fix the Login Bug");
  assert.equal(titleFromUserPrompt("SSH into prodesk and check disk"), "SSH Into Prodesk and Check Disk");
  assert.equal(titleFromUserPrompt("hi\nRename depth 0 sessions automatically"), "Rename Depth 0 Sessions Automatically");
  assert.equal(titleFromUserPrompt("```js\nsecret()\n```\nCompact the session list"), "Compact the Session List");
  assert.equal(titleFromUserPrompt("hello"), null);
  assert.equal(titleFromUserPrompt("Automated post-restart continuation: verify that the requested persistent-harness restart completed"), null);
  assert.equal(titleFromUserPrompt("   "), null);
  assert.equal(titleFromUserPrompt(""), null);
});

test("unique root titles append the short id only when needed", () => {
  const taken = new Set(["Fix the Login Bug"]);
  assert.equal(allocateUniqueRootName("Fix the Login Bug", "a004a2dd", (name) => taken.has(name)), "Fix the Login Bug a004a2dd");
  assert.equal(allocateUniqueRootName("Fresh Title", "a004a2dd", (name) => taken.has(name)), "Fresh Title");
});

test("first completed turn titles from the task, not a later check-in", () => {
  assert.equal(
    titleFromFirstTurn(
      "I want depth 0 sessions to be renamed automatically.",
      "The harness now waits for the first full turn and uses both sides.",
    ),
    "Depth 0 Sessions to Be Renamed Automatically",
  );
  assert.equal(
    titleFromFirstTurn("Did it work", "Yes. Fresh supervisor, and this chat just titled itself."),
    "Fresh Supervisor, and This Chat Just Titled Itself",
  );
  const turn = firstCompletedTitleTurn([
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello, Commander." },
    { role: "user", text: "I want depth 0 sessions to be renamed automatically." },
    { role: "assistant", text: "I will title after this turn settles." },
  ]);
  assert.equal(turn.userText, "I want depth 0 sessions to be renamed automatically.");
  assert.equal(titleFromFirstTurn(turn.userText, turn.assistantText), "Depth 0 Sessions to Be Renamed Automatically");
  assert.equal(firstCompletedTitleTurn([
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello." },
  ]), null);
});

test("generated titles are cleaned and beat a heuristic fallback", () => {
  assert.equal(normalizeGeneratedTitle('Title: "Smarter Session Titles"'), "Smarter Session Titles");
  assert.equal(normalizeGeneratedTitle("hello"), null);
  assert.equal(
    resolveRootTitle(
      { userText: "Did it work", assistantText: "Yes. Fresh supervisor, and this chat just titled itself." },
      "Smarter Session Titles",
    ),
    "Smarter Session Titles",
  );
  assert.equal(
    resolveRootTitle(
      { userText: "I want depth 0 sessions to be renamed automatically.", assistantText: "Done." },
      null,
    ),
    null,
  );
});

test("generated titles stay five words and reject sentences", () => {
  assert.equal(
    normalizeGeneratedTitle('YouTube Revanced Keeps Breaking on My Phone It Just "pauses"'),
    null,
  );
  assert.equal(normalizeGeneratedTitle("Is the Desktop to Linux Migration Session Dead"), null);
  assert.equal(normalizeGeneratedTitle("I Can't Message the Desktop to Linux Migration Session"), null);
  assert.equal(
    resolveRootTitle(
      { userText: "I can't message the desktop to linux migration session", assistantText: "I'll check." },
      null,
    ),
    null,
  );
});

test("fallback titles obey the same word and sentence rules instead of freezing clipped prompts", () => {
  for (const userText of [
    "Look at the data transfers in the status session and explain their purpose",
    "See if you can trace these agents back to somewhere else",
    "Whats the status here",
    "Would that make sense to enable it",
    "Isn't the calendar hosted on Prodesk",
    "Commander, you say it broke then it broke",
  ]) {
    assert.equal(resolveRootTitle({ userText, assistantText: "The session needs further investigation." }, null), null, userText);
  }
  assert.equal(resolveRootTitle({ userText: "Session title repair", assistantText: "The title provider is unavailable." }, null), "Session Title Repair");
  assert.equal(normalizeGeneratedTitle("Commander Interaction Rules"), "Commander Interaction Rules");
  assert.equal(normalizeGeneratedTitle("Order"), null);
  assert.equal(normalizeGeneratedTitle("A Very Long Clipped Title With Missing Context"), null);
});

test("the first completed title turn uses its first reply and never pairs across a user boundary", () => {
  assert.deepEqual(firstCompletedTitleTurn([
    { role: "user", text: "It's broken again." },
    { role: "assistant", text: "I will investigate." },
    { role: "assistant", text: "The title generator used the wrong provider. It now uses the session's provider." },
    { role: "user", text: "What is the next task?" },
    { role: "assistant", text: "A separate task follows." },
  ]), {
    userText: "It's broken again.",
    assistantText: "I will investigate.",
  });
  assert.deepEqual(firstCompletedTitleTurn([
    { role: "user", text: "An abandoned unrelated prompt" },
    { role: "user", text: "Repair session titles" },
    { role: "assistant", text: "The provider selection is repaired." },
  ]), { userText: "Repair session titles", assistantText: "The provider selection is repaired." });
});


test("title excerpts are bounded without flattening short fallback title lines", () => {
  const userText = "Session title repair\nKeep manual names and use the same session provider.\n" + "More context. ".repeat(100);
  const assistantText = "Completed title repair.\n" + "Result details. ".repeat(100);
  const excerpt = rootTitleExcerpt({ userText, assistantText });
  assert(excerpt.userText.length <= 801);
  assert(excerpt.assistantText.length <= 801);
  assert.match(excerpt.userText, /^Session title repair\n/);
  assert.match(excerpt.userText, /…$/);
  assert.equal(resolveRootTitle(excerpt, null), "Session Title Repair");
  assert.equal(rootTitleExcerpt(null), null);
  assert.equal(rootTitlePrompt("  Session title\nrepair  ", "  Completed\nrepair.  "),
    "Commander:\nSession title repair\n\nTaihou:\nCompleted repair.\n\nTitle:");
});
