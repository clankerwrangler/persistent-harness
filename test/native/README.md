# Native execution tests

Run this suite against the explicitly configured unmodified Pi 0.85.1 CLI/SDK. Use a compatible existing Python interpreter, the bundled generic skills, private temporary state, and synthetic loopback provider fixtures.

See [Validation](../../docs/VALIDATION.md) for the complete environment and command. `PI_HARNESS_NATIVE_ASYNC_BUILD_ROOT` identifies the same external installation; it does not select a patched Pi build. No live credentials or provider traffic are required.

The suite covers FIFO execution, real early results, deferred checkpoint ownership, wait barriers, cancellation, actor/kernel-loss recovery without replay, family wakes, default compaction and public compaction hooks, source-order call admission, late reasoning metadata, and safe inference-only retry.
