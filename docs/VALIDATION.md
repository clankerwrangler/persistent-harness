# Validation

Install the declared Node dependencies and configure the exact external stock Pi paths from [Dependencies](DEPENDENCIES.md). Tests do not establish live provider compatibility.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:package-load
npm test
```

The tests use isolated temporary state, fake providers, and local processes. For offline real-worker checks, set `PI_HARNESS_PYTHON` to an existing compatible interpreter and `PI_HARNESS_AUTO_INSTALL=0`. Use a private `HOME` and `PI_CODING_AGENT_DIR`; never point a test at running service state or live credentials.

The managed-runtime test explicitly exercises actual managed reuse and dependency rebuild, not the interpreter override. An optional `PI_HARNESS_TEST_MANAGED_SEED` can contain only cached `bin/uv-0.12.3`, `python/cpython-3.12.12-linux-x86_64-gnu`, and package `cache/` prerequisites. The test copies that seed into its temporary runtime, denies Node fetch, and uses `UV_OFFLINE=1`. Do not supply completed environments, sessions, credentials, or kernel state as the seed. Without cached prerequisites, managed provisioning needs its documented downloads.

Native integration additionally requires `PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT` to identify the same external Pi install prefix:

```sh
export PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT="$PI_PREFIX"
npm run test:native
```

This suite uses synthetic loopback Responses transport and real Python. It covers early results and save ordering, FIFO, cancellation, wait barriers, actor/kernel loss, no-replay recovery, family wake, default compaction and public compaction hooks, source-order admission, encrypted reasoning amendments, and safe inference-only retry.

The broader private integration checkpoint also exercised a browser client. Browser assets, its HTTP adapter, and browser-only tests are intentionally not part of this harness-only repository. Client-neutral protocol/history tests remain.

## Models

TLA+ sources in `specification/` cover bounded scheduler, stream, provider, retry, history, service ownership, and export-dependency assumptions. Obtain Java and `tla2tools.jar` separately. For example:

```sh
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/StockCoordinator.cfg specification/StockCoordinator.tla
java -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -config specification/FirstInputSnapshot.after.cfg specification/FirstInputSnapshot.tla
```

Use each model's matching configuration. Model checks prove only their finite abstraction, not arbitrary provider behavior, filesystem crash atomicity, or remote exactly-once execution. Keep test and model results tied to the source bytes under test.

The `RecursiveSessionDeletion-*.cfg` configurations cover root and direct-child deletion with and without a legacy deleted intermediate. They check subtree completeness, shutdown fencing, retained artifacts, and unrelated actors. `HarnessDependencies` covers explicit extension ordering and read-only, current-session projection. The models abstract external stop completion and projector internals; worker, socket, and canonical-history tests verify the implementation boundaries.
