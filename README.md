# Persistent Harness

Persistent Harness adds durable, detachable sessions and persistent Python execution to Pi. A local supervisor owns session actors, input queues, retained child agents, and kernel recovery. Closing a terminal detaches the client; it does not stop the actor.

This repository contains the harness additions and nine generic capability skills. It does not contain the base Pi distribution.

## Install

Requirements:

- Linux with `/proc`, Node.js 24 or newer, Bash, Perl, and standard Unix utilities.
- Unmodified `@earendil-works/pi-coding-agent` **0.85.1**, including its matching SDK dependencies.
- CPython 3.12.12, IPython 9.10.0, and dill 0.3.8, either provisioned by the harness or supplied explicitly.

Follow [Dependencies and installation](docs/DEPENDENCIES.md) to install Pi and configure the Python runtime. Then, from this checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node bin/install.mjs install
node bin/provision-skills.mjs --yes
node bin/persistent-pi.mjs --create
```

The provisioning command approves downloads of pinned uv, Python, IPython, and dill. Set `PI_HARNESS_PYTHON` to a compatible existing interpreter instead if provisioning is not wanted. The nine bundled skills have only standard-library Python dependencies.

Configure provider credentials through the external Pi installation, separately from this repository. Keep the checkout at its installed path: generated launchers and the harness extension wrapper reference it.

## Use

```sh
node bin/persistent-pi.mjs --list
node bin/persistent-pi.mjs --session SESSION --prompt "Continue the task" --wait
```

The terminal supports `:sessions`, `:attach NAME_OR_ID`, `:new [NAME]`, `:abort`, and `:quit`. In Python, inspect `rlm?`, `agent_message?`, `cron?`, or another bundled capability. The default catalog is this repository's `skills/`; `PI_HARNESS_SKILLS_PATH` selects another complete catalog.

The harness retains child delegation and context forking, durable family messages, scheduled jobs, detached processes, session-history search, model selection, image inputs, checkpoint diagnostics, default compaction and public extension compaction hooks, and client-neutral protocol APIs. [Native asynchronous execution](docs/ASYNC_EXECUTION.md) requires explicit provider/model support; ordinary synchronous tool execution remains available without it.

- [Operations and recovery](docs/OPERATIONS.md)
- [Architecture and protocol](docs/ARCHITECTURE.md)
- [Validation](docs/VALIDATION.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Licensed under the [MIT License](LICENSE). Third-party notices apply to their identified materials.
