import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveExternalPi } from "../../src/external-pi.mjs";

const officialEntries = {
  "dist/index.js": "82cb4ea864f3d8816c06bc8f2f2d9a8d82d883297af179dc69d287d042834844",
  "dist/cli.js": "8189b66abc4f9f431dbb70941dcba690d76d040de1fbfff212886be35a53639d",
  "dist/bundle/index.js": "ef91447930bcf6a6e9b51ae28f859755c7eaa573607c5a75ee86526084d3d67c",
  "dist/bundle/cli.js": "e6d7fcf36a239cf3746e67ddf4222081ac01a601b85a3ee688bdfe9c161d754c"
};

export async function acceptedNativeRuntime() {
  const command = process.env.PI_HARNESS_PI_COMMAND, module = process.env.PI_HARNESS_PI_MODULE;
  assert(command && module, "Use explicit stock 0.85.1 CLI/SDK test seams");
  const paths = await resolveExternalPi();
  const [cli, sdk] = await Promise.all([realpath(command), realpath(module)]);
  assert.equal(sdk, paths.sdk, "Use the selected public SDK entry, not another module");
  assert.equal(path.dirname(cli), path.dirname(sdk), "Use one matched CLI/SDK distribution");
  for (const entry of [cli, sdk]) {
    const relative = path.relative(paths.packageRoot, entry);
    assert(officialEntries[relative], "Use an official stock CLI/SDK entry from the selected package");
    assert.equal(createHash("sha256").update(await readFile(entry)).digest("hex"), officialEntries[relative]);
  }
  const prefix = path.resolve(paths.packageRoot, "../../..");
  if (process.env.PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT) {
    assert.equal(await realpath(process.env.PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT), await realpath(prefix),
      "The optional native root must identify this exact installed stock graph");
  }
  return { ...paths, cli, sdk, prefix };
}

/** Private test wrapper: real worker RPC and coordinator, injected fixture factory only. */
export async function writeWorkerFixture(directory, factoryPath) {
  const workerUrl = new URL("../../src/sdk-worker.mjs", import.meta.url).href;
  const wrapper = path.join(directory, "stock-worker-fixture.mjs");
  await writeFile(wrapper, `import net from "node:net"; import http from "node:http"; import https from "node:https";
const denied = () => { throw new Error("RPC fixture network denied"); };
globalThis.fetch = denied; net.Socket.prototype.connect = denied; http.request = denied; https.request = denied;
const { runSDKWorkerRpc, bootstrapSDKWorker } = await import(${JSON.stringify(workerUrl)});
const { default: extensionFactory } = await import(${JSON.stringify(pathToFileURL(factoryPath).href)});
await runSDKWorkerRpc({ bootstrap: options => bootstrapSDKWorker({ ...options, extensionFactory }) });
`);
  return { command: process.execPath, args: [wrapper] };
}
