import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("operations.memory bounded Linux accounting fixtures", { timeout: 15_000 }, () => {
  const result = spawnSync(process.env.PI_HARNESS_PYTHON || "python3", ["-B", fileURLToPath(new URL("./operations-memory.py", import.meta.url))], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
