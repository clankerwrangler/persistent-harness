import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveExternalPi } from "../../src/external-pi.mjs";

const officialEntries = {
  "dist/index.js": "5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30",
  "dist/cli.js": "8189b66abc4f9f431dbb70941dcba690d76d040de1fbfff212886be35a53639d",
  "dist/bundle/index.js": "df1f4c36758e3d339d42c6caebb2fca1d9f415de658d56b7b1fa6a9a808f0aa5",
  "dist/bundle/cli.js": "e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774"
};

export async function acceptedNativeRuntime() {
  const command = process.env.PI_HARNESS_PI_COMMAND, module = process.env.PI_HARNESS_PI_MODULE;
  assert(command && module, "Use explicit stock 0.99.1 CLI/SDK test seams");
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
