import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { explicitHeapCap } from "./node-heap-cap.mjs";
import { resolveExternalPi } from "../../src/external-pi.mjs";

// Accept the package's public CLI/SDK entries by name and version, not by file hash,
// so a rebuilt or patched install of the same stock release still runs the tests.
const officialEntries = new Set(["dist/index.js", "dist/cli.js", "dist/bundle/index.js", "dist/bundle/cli.js"]);
const acceptedVersion = "0.99.1";

export async function acceptedNativeRuntime() {
  const command = process.env.PI_HARNESS_PI_COMMAND, module = process.env.PI_HARNESS_PI_MODULE;
  assert(command && module, "Use explicit stock 0.99.1 CLI/SDK test seams");
  const paths = await resolveExternalPi();
  const [cli, sdk] = await Promise.all([realpath(command), realpath(module)]);
  assert.equal(sdk, paths.sdk, "Use the selected public SDK entry, not another module");
  assert.equal(path.dirname(cli), path.dirname(sdk), "Use one matched CLI/SDK distribution");
  for (const entry of [cli, sdk]) {
    const relative = path.relative(paths.packageRoot, entry);
    assert(officialEntries.has(relative), "Use an official stock CLI/SDK entry from the selected package");
  }
  const { version } = JSON.parse(await readFile(path.join(paths.packageRoot, "package.json"), "utf8"));
  assert.equal(version, acceptedVersion, `Use stock Pi ${acceptedVersion}`);
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
  const heapCap = explicitHeapCap();
  const heapCapProof = heapCap ? { file: path.join(directory, "worker-heap-cap.json"),
    flag: heapCap, heapSizeLimit: getHeapStatistics().heap_size_limit } : null;
  const proof = heapCapProof ? `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import { explicitHeapCap } from ${JSON.stringify(new URL("./node-heap-cap.mjs", import.meta.url).href)};
const configuredFlag = explicitHeapCap();
const heapSizeLimit = getHeapStatistics().heap_size_limit;
assert.equal(configuredFlag, ${JSON.stringify(heapCap)}, "RPC worker must retain the explicit parent CLI cap");
assert.equal(heapSizeLimit, ${heapCapProof.heapSizeLimit}, "RPC worker must match the parent V8 total limit");
writeFileSync(${JSON.stringify(heapCapProof.file)}, JSON.stringify({
  pid: process.pid, configuredFlag, execArgv: process.execArgv, heapSizeLimit, phase: "pre-sdk-bootstrap",
}) + "\\n");
` : "";
  await writeFile(wrapper, `import net from "node:net"; import http from "node:http"; import https from "node:https";
const denied = () => { throw new Error("RPC fixture network denied"); };
globalThis.fetch = denied; net.Socket.prototype.connect = denied; http.request = denied; https.request = denied;
${proof}const { runSDKWorkerRpc, bootstrapSDKWorker } = await import(${JSON.stringify(workerUrl)});
const { default: extensionFactory } = await import(${JSON.stringify(pathToFileURL(factoryPath).href)});
await runSDKWorkerRpc({ bootstrap: options => bootstrapSDKWorker({ ...options, extensionFactory }) });
`);
  return { command: process.execPath, args: [...(heapCap ? [heapCap] : []), wrapper], heapCapProof };
}
