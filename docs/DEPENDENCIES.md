# Dependencies and installation

## Unmodified Pi

Supported version: `@earendil-works/pi-coding-agent@0.99.1`, upstream repository `https://github.com/earendil-works/pi`, revision `d86654abb8862e201933517d6f1fce9f88dd117f`.

Install it outside the harness checkout. For example:

```sh
export PI_PREFIX="$HOME/.local/share/persistent-harness/pi"
npm install --prefix "$PI_PREFIX" --save-exact --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.99.1
export PI_HARNESS_PI_COMMAND="$PI_PREFIX/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
export PI_HARNESS_PI_MODULE="$PI_PREFIX/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js"
```

Pi requires Node 22.19 or later; this harness requires Node 24 or later.

Use one matching installed graph, not an SDK from another Pi installation.
`PI_HARNESS_PI_MODULE` accepts a package-directory path or a declared public SDK
file path, including `file:` URLs. `PI_HARNESS_PI_COMMAND` accepts a command
path or a name on `PATH`. Set both to matching artifacts when selecting an
explicit SDK file.

Dependency lookup includes packages directly under the selected outer
`node_modules` directory as well as nested dependencies inside that graph.
Resolved real paths cannot escape it. Declared dependencies, exact versions,
public exports, and one shared `pi-ai` instance remain required.

The optional explicit bundled SDK is an upstream-shipped alternate root artifact, not an npm export-map subpath. It exposes the same public named SDK APIs in this version. The resolver pins its entry SHA-256 to `df1f4c36758e3d339d42c6caebb2fca1d9f415de658d56b7b1fa6a9a808f0aa5`. This entry check is not a whole-install integrity guarantee. `dist/index.js` is also supported; set both command and SDK to their adjacent `dist/cli.js` and `dist/index.js` paths for that graph. An explicitly selected declared root wins, including when that root resolves to
the bundle pathname. Other selections at that pathname retain the official-byte
check, including a `./programmatic` alias to it.

A command-only or package-directory selection prefers the declared public
`./programmatic` entry when present; otherwise it selects the public root. An
advertised but invalid programmatic export fails instead of falling back to the
root or a less-specific pattern. The bounded export resolver supports `node`,
`import`, and `default` conditions, not the full Node export-map algorithm. An
explicit declared root file keeps that root; an explicit valid programmatic file
selects that entry. Private files and package-escaping targets are rejected.

`external-pi.mjs` owns graph resolution, SDK selection, imports, and required SDK
API checks. Session helpers use its SDK-only loader without resolving or importing
unused auxiliary exports, retaining package, dependency, version, and shared-AI
gates. Their first load promise caches success or rejection. Only the session
helper defaults to `pi` on `PATH` when both explicit settings are absent; the
worker resolver still requires an explicit selection.

Unmodified Pi remains supported through the stateless projection path. The worker
hosts the public `ExtensionRunner`, `SessionManager`, and `ModelRuntime` APIs.
Pin 0.99.1 rather than assuming later SDK versions preserve these seams.

Bounded persistent-history retention additionally requires the SDK's supported
`SessionManagerOptions.entryRetention`, ordered `getEntriesRange`, and independent
`getRevision()` `{revision, generation}` stamps. Avoiding automatic raw-context
materialization also requires `buildSessionSource()`, source-mode session/Agent
state, source-aware `ExtensionRunner` context/end dispatch, and source-aware SDK
status estimation. These extend Pi's existing public owners; they are not a
replacement manager or an installed-runtime patch. Stock 0.99.1 remains compatible
but does not provide these payload bounds.

Suffix-only automatic history maintenance additionally uses the optional
`SessionManager.getSourceWatermark()` / `subscribeSourceWatermark()` capability
and the existing bounded-retention source hash. Its coalesced non-secret owner
cursor is metadata, not archive completeness evidence; observer failure cannot
turn a committed append into a failed write. Older SDKs, cold/unknown sources and
strict reconciliation use canonical verification. No new setting, editing
restriction or replacement owner is introduced; see [Session-history retrieval](ARCHITECTURE.md#session-history-retrieval).

The harness selects the source path only when the required supported surfaces
exist. Extensions must opt into source handlers to avoid their own eager array
boundary; default hooks and explicit full-value APIs remain complete. Packaging,
installation and activation of a matching corrected SDK are separate from source
verification. See [Canonical history](ARCHITECTURE.md#canonical-history) and the
[source integration fixtures](VALIDATION.md).

## Python and skills

`node bin/provision-skills.mjs --yes` provisions checksum-pinned uv 0.12.3, CPython 3.12.12, IPython 9.10.0, and dill 0.3.8 on Linux x64. Managed environments are selected by dependencies and skill manifests. A compatible completed environment can be reused after a source-only skill change; dependency changes require provisioning.

Kernel launch validates imports and all three versions in the process that runs
cells, before snapshot recovery or deserialization. Each replacement validates
again. Managed launches require the exact pins; an explicit interpreter reports
its observed versions without pinning them. Standalone provisioning and
changed-catalog admission retain their disposable import checks. A catalog
fingerprint or an earlier provision result does not validate a new process.

An import, version, or executable rejection can select another compatible
completed environment or enter the approved provisioning path. Configuration,
control, and restore failures do not trigger runtime repair. A newly built
runtime publishes its completion record after import/version validation, even
if later namespace restoration fails.

For an existing interpreter:

```sh
export PI_HARNESS_PYTHON=/absolute/path/to/python
node bin/provision-skills.mjs
```

The bundled catalog provides `agent-message`, `rlm`, `kernel`, `operations`, `cron`, `session-history`, `files`, `shell`, and `background`. No host inventory, SSH wrappers, mail, vault, persona, or standing policy is installed. Use `PI_HARNESS_SKILLS_PATH` for a different complete catalog and provision its declared dependencies before admitting work.

## Persistent configuration

Installation writes thin wrappers under the selected agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Each launcher reads the optional `harness/launch-env.sh` there. Put the absolute Pi command, SDK, and optional Python/catalog exports in that file or your service environment. The installer does not create, replace, or populate it with credentials.

Use the same environment for the supervisor and its workers. Configure credentials through Pi, never in source, examples, or committed environment files. Both Node and the external files must remain accessible after restarting your terminal or service.

`PI_HARNESS_CONTEXT_STRING_CODE_UNITS` optionally selects the aggregate materialized-view string/key budget. Unset means `67108864` (64 Mi UTF-16 code units). Acceptable values are plain decimal integers from `67108864` through `268435456`, without signs, whitespace, leading zeros, fractions, or exponents. Empty or invalid values fail with the value-free `ERR_CONTEXT_BUDGET_CONFIG`; they are not clamped or replaced by the default. For example:

```sh
export PI_HARNESS_CONTEXT_STRING_CODE_UNITS=134217728
```

The setting applies to helper-output messages and the complete returned projection, including summary metadata, outstanding calls, and diagnostics. Archive-record, signature, node, and depth limits remain unchanged; see [Canonical history](ARCHITECTURE.md#canonical-history). This is an admission ceiling, not a heap reservation, wire-byte bound, token allowance, or concurrent-actor capacity guarantee. Select it using retained-context and host-resource measurements.

The zero-argument `getCanonicalContextStringCodeUnits()` export in `src/canonical-context.mjs` reports the effective process value. Configure the process environment, not only an in-process SDK loader's `env` object. Offline validators must receive the same explicit value; containers do not inherit it automatically. Seal that selection with the source/configuration receipt. Existing workers retain their environment until recreated through the [controlled update workflow](OPERATIONS.md#develop-and-promote-one-source-revision).

### Node compile cache

Actors use a supervisor-owned temporary Node compile cache by default; its
[lifetime and fallback](ARCHITECTURE.md#owners) do not change session ownership.
`NODE_DISABLE_COMPILE_CACHE=1` disables it. Use that setting when collecting precise
V8 coverage: Node warns that cached functions can produce less precise coverage.
An explicitly configured `NODE_COMPILE_CACHE` (including an empty value) takes
precedence over the harness default. Node handles that setting normally; the
harness neither repairs nor removes an operator-managed cache. The harness does
not set `NODE_COMPILE_CACHE` for the supervisor or tool subprocesses.

## External extensions and clients

`PI_HARNESS_ACTOR_EXTENSIONS` selects additional extension entry paths as a JSON array or a platform-delimited list. For example:

```sh
export PI_HARNESS_ACTOR_EXTENSIONS='["/absolute/path/to/extension/index.ts"]'
```

The supervisor loads its harness first, then explicit extensions in order, removing duplicate paths. Automatic extension discovery is disabled for actors. A configured extension runs in the active coordinator runner; the separate SDK service runtime loads only the harness's preparation-only compaction hook, which always cancels before inference or a write. Compaction and navigation use the active runner's hooks under the coordinator's service lease.

No external extension is bundled, downloaded, or installed by this setting. Maintain its source and dependencies separately and verify compatibility with the pinned Pi and canonical history formats before activation. Custom compaction handlers receive composed caller and namespace instructions in `event.customInstructions` and must include them in their own summary request.

A browser or HTTP frontend is a separate client process. Configure its entry point in your service setup and connect it through `HarnessClient` and the selected supervisor socket. Shared protocol and projection modules come from the same published harness checkout; the core does not import or launch the frontend.
