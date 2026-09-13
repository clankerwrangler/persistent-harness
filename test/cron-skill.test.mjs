import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { discoverSkillsFromDirectory } from "../src/skills.mjs";

test("cron skill grants only the bounded scheduler host request", async () => {
  const discovered = await discoverSkillsFromDirectory(path.resolve(process.env.PI_HARNESS_SKILLS_PATH || "skills"));
  assert.deepEqual(discovered.diagnostics, []);
  const skill = discovered.skills.find((item) => item.id === "cron");
  assert(skill); assert.equal(skill.python.alias, "cron"); assert.equal(skill.python.entryPoint, "run");
  assert.deepEqual(skill.python.hostRequests, ["cron.manage"]); assert.deepEqual(skill.python.dependencies, []);
});
