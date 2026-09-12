# Dependencies and installation

## Unmodified Pi

Supported version: `@earendil-works/pi-coding-agent@0.85.1`, upstream repository `https://github.com/earendil-works/pi`, revision `d981de1229ef899957bbe968bc8dcda02a21f477`.

Install it outside the harness checkout. For example:

```sh
export PI_PREFIX="$HOME/.local/share/persistent-harness/pi"
npm install --prefix "$PI_PREFIX" --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.85.1
export PI_HARNESS_PI_COMMAND="$PI_PREFIX/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
export PI_HARNESS_PI_MODULE="$PI_PREFIX/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js"
```

Use one matching installed graph, not an SDK from another Pi installation. Use absolute file paths for both variables. The harness's session helper expects an SDK file, not a package directory or file URL.

The optional explicit bundled SDK is an upstream-shipped alternate root artifact, not an npm export-map subpath. It exposes the same public named SDK APIs in this version. The resolver pins its entry SHA-256 to `ef91447930bcf6a6e9b51ae28f859755c7eaa573607c5a75ee86526084d3d67c`. This entry check is not a whole-install integrity guarantee. `dist/index.js` is also supported; set both command and SDK to their adjacent `dist/cli.js` and `dist/index.js` paths for that graph. A command-only or package-directory resolver chooses the normal public main entry, not the bundle implicitly.

No Pi patch, replaced module, private engine method, or custom Pi build is required. The worker hosts the public `ExtensionRunner`, `SessionManager`, and `ModelRuntime` APIs. Pin 0.85.1 rather than assuming later SDK versions preserve these seams.

## Python and skills

`node bin/provision-skills.mjs --yes` provisions checksum-pinned uv 0.12.3, CPython 3.12.12, IPython 9.10.0, and dill 0.3.8 on Linux x64. Managed environments are selected by dependencies and skill manifests. A compatible completed environment can be reused after a source-only skill change; dependency changes require provisioning.

For an existing interpreter:

```sh
export PI_HARNESS_PYTHON=/absolute/path/to/python
node bin/provision-skills.mjs
```

The bundled catalog provides `agent-message`, `rlm`, `kernel`, `operations`, `cron`, `session-history`, `files`, `shell`, and `background`. No host inventory, SSH wrappers, mail, vault, persona, or standing policy is installed. Use `PI_HARNESS_SKILLS_PATH` for a different complete catalog and provision its declared dependencies before admitting work.

## Persistent configuration

Installation writes thin wrappers under the selected agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Each launcher reads the optional `harness/launch-env.sh` there. Put the absolute Pi command, SDK, and optional Python/catalog exports in that file or your service environment. The installer does not create, replace, or populate it with credentials.

Use the same environment for the supervisor and its workers. Configure credentials through Pi, never in source, examples, or committed environment files. Both Node and the external files must remain accessible after restarting your terminal or service.

## External extensions and clients

`PI_HARNESS_ACTOR_EXTENSIONS` selects additional extension entry paths as a JSON array or a platform-delimited list. For example:

```sh
export PI_HARNESS_ACTOR_EXTENSIONS='["/absolute/path/to/extension/index.ts"]'
```

The supervisor loads its harness first, then explicit extensions in order, removing duplicate paths. Automatic extension discovery is disabled for actors. A configured extension runs in the active coordinator runner; the separate SDK service runtime remains extension-empty so it cannot start competing work. Compaction and navigation use the active runner's hooks under the coordinator's service lease.

No external extension is bundled, downloaded, or installed by this setting. Maintain its source and dependencies separately and verify compatibility with the pinned Pi and canonical history formats before activation. Custom compaction handlers receive composed caller and namespace instructions in `event.customInstructions` and must include them in their own summary request.

A browser or HTTP frontend is a separate client process. Configure its entry point in your service setup and connect it through `HarnessClient` and the selected supervisor socket. Shared protocol and projection modules come from the same published harness checkout; the core does not import or launch the frontend.
