// Transpile only the changed preparation owners for offline cross-repository tests.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
const [sdkRoot, clmRoot, piModule, outfile] = process.argv.slice(2);
if (!outfile) throw new Error("Usage: sdk-source-root clm-source-root installed-programmatic-module test-output.mjs");
const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [sdkRoot] }));
const scope = path.dirname(path.dirname(path.dirname(piModule)));
await build({ stdin: { contents: `export { prepareCompactionFromSource } from ${JSON.stringify(path.join(sdkRoot, "packages/coding-agent/src/core/compaction/compaction.ts"))};
export { ExtensionRunner } from ${JSON.stringify(path.join(sdkRoot, "packages/coding-agent/src/core/extensions/runner.ts"))};
export { default as liveContextExtension } from ${JSON.stringify(path.join(clmRoot, "src/index.ts"))};
export { compactionSource } from ${JSON.stringify(path.join(clmRoot, "src/compaction-source.ts"))};
export { readLiveContextState } from ${JSON.stringify(path.join(clmRoot, "src/state.ts"))};
export { resolveObservationCap } from ${JSON.stringify(path.join(clmRoot, "src/observation.ts"))};`, loader: "ts", resolveDir: sdkRoot },
  outfile, bundle: true, platform: "node", format: "esm", target: "node24", plugins: [{ name: "existing-dependencies", setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path.startsWith("node:")) return { path: args.path, external: true };
      if (args.path.startsWith("@earendil-works/")) {
        const [, name, ...parts] = args.path.split("/"), directory = path.join(scope, name);
        const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
        const key = parts.length ? "./" + parts.join("/") : ".";
        let entry = manifest.exports?.[key];
        if (entry && typeof entry !== "string") entry = entry.import ?? entry.default;
        if (!entry && key === ".") entry = manifest.main;
        if (entry) return { path: path.resolve(directory, entry), external: true };
      }
      return { path: require.resolve(args.path, { paths: [path.dirname(scope), sdkRoot, clmRoot] }), external: true };
    });
  } }] });
