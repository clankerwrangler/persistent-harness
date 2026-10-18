import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STOCK_PI_VERSION = "0.99.1";
const AGENT = "@earendil-works/pi-coding-agent";
const AI = "@earendil-works/pi-ai";
const CORE = "@earendil-works/pi-agent-core";
const OFFICIAL_BUNDLE_ENTRY = "dist/bundle/index.js";
const OFFICIAL_BUNDLE_SHA256 = "df1f4c36758e3d339d42c6caebb2fca1d9f415de658d56b7b1fa6a9a808f0aa5";
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

async function commandPath(command, env, cwd) {
  if (command.includes(path.sep)) return realpath(path.resolve(cwd, command));
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(cwd, directory, command);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error("Explicit Pi command was not found");
}

async function manifestAt(directory) {
  return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
}

async function agentPackage(entry) {
  let directory = (await stat(entry)).isDirectory() ? entry : path.dirname(entry);
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = await manifestAt(directory);
      if (manifest.name === AGENT) return { directory, manifest };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Explicit Pi path is not inside the stock coding-agent package");
}

function importTarget(value, strict = false) {
  if (typeof value === "string") return value;
  if (!value || Array.isArray(value) || typeof value !== "object") return undefined;
  for (const [condition, target] of Object.entries(value)) {
    if (["node", "import", "default"].includes(condition)) {
      const found = importTarget(target, strict);
      if (found || strict) return found;
    }
  }
}

// Resolve only declared public exports. No guesses about dist/ file layout.
async function publicEntry(pkg, subpath = ".", optional = false) {
  const exports = pkg.manifest.exports;
  const exact = exports && typeof exports === "object" && Object.hasOwn(exports, subpath);
  let advertised = Boolean(exact);
  let target = subpath === "." && typeof exports === "string" ? exports : importTarget(exports?.[subpath], optional);
  if (!target && !(optional && exact) && exports && typeof exports === "object") {
    const patterns = Object.keys(exports).filter((key) => key.includes("*")).sort((a, b) => b.length - a.length);
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split("*");
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const replacement = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
      advertised = true;
      const template = importTarget(exports[pattern], optional);
      if (template) { target = template.replaceAll("*", replacement); break; }
      if (optional) break;
    }
  }
  if (optional && !advertised) return undefined;
  if (typeof target !== "string" || !target.startsWith("./")) throw new Error(`Missing public export ${pkg.manifest.name}${subpath}`);
  const resolved = await realpath(path.resolve(pkg.directory, target));
  if (!inside(pkg.directory, resolved)) throw new Error("Public Pi export escapes its package");
  if (!(await stat(resolved)).isFile()) throw new Error("Public Pi export is not a regular file");
  return resolved;
}

async function dependency(owner, name, graphRoot) {
  if (!owner.manifest.dependencies?.[name]) throw new Error(`Pi package does not declare ${name}`);
  let directory = owner.directory;
  while (inside(graphRoot, directory)) {
    const candidate = path.join(directory === graphRoot ? directory : path.join(directory, "node_modules"), name);
    try {
      const resolved = await realpath(candidate);
      if (!inside(graphRoot, resolved)) throw new Error("Pi dependency escapes the selected package graph");
      const manifest = await manifestAt(resolved);
      if (manifest.name !== name) throw new Error("Pi dependency package identity mismatch");
      return { directory: resolved, manifest };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    directory = path.dirname(directory);
  }
  throw new Error(`Pi dependency is absent from the selected package graph: ${name}`);
}

async function resolveSdkGraph({ env = process.env, cwd = process.cwd() } = {}) {
  const configured = env.PI_HARNESS_PI_MODULE;
  if (!configured && !env.PI_HARNESS_PI_COMMAND) throw new Error("Set PI_HARNESS_PI_MODULE or PI_HARNESS_PI_COMMAND explicitly");
  const entry = configured
    ? await realpath(configured.startsWith("file:") ? fileURLToPath(configured) : path.resolve(cwd, configured))
    : await commandPath(env.PI_HARNESS_PI_COMMAND, env, cwd);
  const agent = await agentPackage(entry);
  // The outer node_modules containing the selected install bounds dependency lookup.
  const segments = agent.directory.split(path.sep);
  const modulesIndex = segments.indexOf("node_modules");
  if (modulesIndex < 0) throw new Error("Stock Pi must be an explicit installed package graph");
  const graphRoot = segments.slice(0, modulesIndex + 1).join(path.sep) || path.sep;
  const ai = await dependency(agent, AI, graphRoot);
  const core = await dependency(agent, CORE, graphRoot);
  const coreAi = await dependency(core, AI, graphRoot);
  if (coreAi.directory !== ai.directory) throw new Error("Pi SDK and agent-core resolve different pi-ai instances");
  for (const pkg of [agent, ai, core]) {
    if (pkg.manifest.version !== STOCK_PI_VERSION) throw new Error(`Expected stock Pi ${STOCK_PI_VERSION}: ${pkg.manifest.name}`);
  }
  const root = await publicEntry(agent);
  let sdk = root;
  if (configured && entry !== agent.directory) {
    if (entry !== root) {
      if (entry === path.join(agent.directory, OFFICIAL_BUNDLE_ENTRY)) sdk = entry;
      else {
        const programmatic = await publicEntry(agent, "./programmatic", true);
        if (entry !== programmatic) throw new Error("Unsupported explicit Pi SDK entry");
        sdk = programmatic;
      }
    }
  } else {
    sdk = await publicEntry(agent, "./programmatic", true) ?? root;
  }
  // A declared root takes precedence. Other selections cannot alias around the alternate-bundle guard.
  if (sdk !== root && sdk === path.join(agent.directory, OFFICIAL_BUNDLE_ENTRY)) {
    const digest = createHash("sha256").update(await readFile(sdk)).digest("hex");
    if (digest !== OFFICIAL_BUNDLE_SHA256) throw new Error("Pi bundled SDK entry does not match official stock bytes");
  }
  return { version: STOCK_PI_VERSION, packageRoot: agent.directory, sdk, ai, core };
}

export async function resolveExternalPi(options) {
  const { ai, core, ...paths } = await resolveSdkGraph(options);
  return {
    ...paths,
    api: await publicEntry(ai),
    core: await publicEntry(core),
    responsesApi: await publicEntry(ai, "./api/openai-responses-shared"),
    simpleOptions: await publicEntry(ai, "./api/simple-options"),
  };
}

async function importSdk(entry, sdkOnly = false) {
  const sdk = await import(pathToFileURL(entry).href);
  const required = sdkOnly ? ["SessionManager"]
    : ["createAgentSession", "SessionManager", "ModelRuntime", "ExtensionRunner", "createExtensionRuntime"];
  for (const name of required) {
    if (typeof sdk[name] !== "function") throw new Error(sdkOnly
      ? "Pi SessionManager public API is unavailable" : `Stock Pi public API is unavailable: ${name}`);
  }
  return sdk;
}

// Session helpers need the selected SDK and graph fences, not auxiliary namespace exports.
export async function loadExternalPiSdk(options) {
  const paths = await resolveSdkGraph(options);
  return importSdk(paths.sdk, true);
}

export async function loadExternalPi(options) {
  const paths = await resolveExternalPi(options);
  const [sdk, api, core, responsesApi, simpleOptions] = await Promise.all([
    importSdk(paths.sdk),
    ...[paths.api, paths.core, paths.responsesApi, paths.simpleOptions].map((entry) => import(pathToFileURL(entry).href)),
  ]);
  return { sdk, api, core, responsesApi, simpleOptions, paths };
}
