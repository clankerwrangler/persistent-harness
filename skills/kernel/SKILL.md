---
name: kernel
description: Inspect or restart this session's persistent IPython kernel through its canonical lifecycle.
---

# Kernel

Use `kernel.status()` to inspect whether the current session kernel is running or busy.

Use `kernel.restart()` to admit a snapshot-and-restart operation. The call returns before the current kernel shuts down; the next `ipython` execution waits for shutdown and lazily restores the last valid snapshot in a fresh kernel.
