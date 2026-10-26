# Automatic kernel cold-residency verification

Clean automatic-only integration based on public `9d463b39258718b00b685233125438e8e0e07dc3`.
No publication, deployment, live actor paging, restart, forced GC, OS limit change
or global reclaim was performed. Tests use private synthetic owners only.

## Owner and interface

One timer belongs to each already-existing `PythonKernel`; no actor-idle condition,
new service or model-selected tool/script/budget is involved. A maintenance deadline
survives ordinary small cells. Work pauses for active/queued execution, scheduled
or active checkpoint, host reply, startup and close. Only bounded mapping
metadata resumes; process identity and request epochs fence replies, and mapping
ownership/hotness/locks are freshly checked before bounded COLD/PAGEOUT batches.
Old/custom loops must advertise the additive private `coldResidencyVersion=1` field;
otherwise ordinary execution continues with no optional command.

The runtime owner changes are limited to `src/kernel.mjs`, its existing status
handler in `src/host-handlers.mjs`, `python-runtime/kernel.py`, and the private
`_cold_residency.py` helper. Node reclamation is unchanged. The pure Linux observer
is shared as `python-runtime/_linux_memory.py`, with its bytes unchanged from the
public base's operations observer and an operations compatibility entry. Source,
accounting and copied-package tests preserve its existing API. No extra execution
API, process service or caller choice is introduced.

## Model before implementation

Checker: `/opt/tla/tla2tools-1.7.4.jar`, TLC 2.19, Java 21, one worker.

```sh
java -Xmx256m -XX:+UseParallelGC -cp /opt/tla/tla2tools-1.7.4.jar tlc2.TLC -workers 1 -config specification/KernelColdResidency.cfg specification/KernelColdResidency.tla
```

Final positive result: 2,095,266 generated states, 257,296 distinct states, depth
31, no errors. The ownership/cadence/capability refinements were modeled and checked
before their corresponding owner changes. Matching fault configurations all return
TLC exit 12:

| Fault | Violation | Depth |
| --- | --- | --- |
| `busy` | `Guarded` | 2 |
| `reserve` | `Fifo` | 4 |
| `cancel` | `Guarded` | 5 |
| `unsupported` | `Guarded` | 11 |
| `budget` | `BoundedWork` | 12 |
| `state` | `StateAndIdentity` | 10 |
| `await` | `AdmissionIndependent` | 4 |
| `launch` | `NoStartup` | 3 |
| `late` | `GenerationOwned` | 7 |
| `stage` | `Guarded` | 5 |
| `hot` | `Guarded` | 11 |
| `latehot` | `Guarded` | 12 |
| `rearm` | `TimerCoverage` | 5 |
| `diagrearm` | `TimerCoverage` | 3 |
| `legacy` | `Guarded` | 2 |
| `starve` | `CadenceSurvivesCells` | 3 |
| `ownership` | `Guarded` | 6 |

## Actual ordinary boundary

```sh
PI_HARNESS_PYTHON=MANAGED_PYTHON PI_HARNESS_AUTO_INSTALL=0 node --test test/kernel-cold-memory.test.mjs
```

Compatible interpreter used here:
`/home/node/.pi/agent/harness/kernel-runtime/environments/00fbfe15252a3e987366/bin/python`.
The nine Node cases include eight pure policy/metadata helper cases. The actual
kernel fixture injects only pressure eligibility and advances its owning Node
clock; Linux paging and real CPython/IPython state are unchanged.

A representative full pass reduced process RSS from 90,030,080 to 56,303,616 B,
with process Swap rising by 33,726,464 B. The next ordinary cell retained PID,
buffer address, identities, aliases, exact SHA-256 and the opaque SQLite :memory:
uncommitted transaction. Namespace/checkpoint generations did not advance for
advice. Full helper time was 103.6 ms; largest advice syscall 24.4 ms. Baseline bulk
hash was 78.1 ms; next use was 115.9 ms; five subsequent warm cells took 0.8–7.1 ms.
These are observations, not latency guarantees.

The mixed-work fixture issued 47 ordinary small control cells at one virtual second
per gap, including real debounced checkpoints. There was no 30-second quiet gap.
The bound mapping stayed untouched by those cells. RSS fell from 90,075,136 to
59,707,392 B and process Swap rose by 30,408,704 B before the loop ended. Counter,
SQLite state, aliases, buffer address, PID and complete digest remained exact.

The test uses a one-byte ctypes address observation rather than a large ctypes
array root; observer instrumentation therefore does not itself serialize/read the
bulk mapping during each checkpoint. The mapping and aliases remain ordinary
bound opaque Python values throughout.

## Swap cache and physical-memory precision

The standalone primitive fixture retained all 8,192 mincore-present pages after
PAGEOUT despite its 32 MiB RSS reduction: swap cache remained resident. The actual
kernel fixture records bounded before/after/delayed cgroup `anon`, `inactive_anon`,
`swapcached`, `memory.current`, `swap.current`, host `MemAvailable`, `SwapCached`,
`SwapFree`, `AnonPages`, `Writeback`, and `pswpin/pswpout` counters.

In the representative full-pass run, shared cgroup swap cache increased from
87,040,000 to 120,631,296 B while `memory.current` increased from 11,355,656,192 to
11,357,118,464 B. Host `pswpout` increased by 8,201 pages. At the delayed sample,
swap cache remained, host Writeback was zero, and `memory.current` had changed
again. Those shared counters are confounded by unrelated workloads. They support
cold swap-cache/reclaimability evidence, not an equal measured physical RAM release
or a causal capacity gain. No unsafe allocation pressure or forced reclaim was used
to manufacture a physical-release result.

## Limits and adjacent qualification

Each advice call is at most 1 MiB; batches target 4 MiB/10 ms with cooperative checks,
and each phase has a 1 GiB cap. One syscall cannot be preempted. Under heavier shared
pressure an observed 1 MiB PAGEOUT call took **484.6 ms**; a new cell can wait for
that current call/batch. There is no hard wall-clock bound, OOM guarantee, full heap
coverage or durable recovery promise. Hot, locked, changed, oversized, unavailable,
no-swap and unsupported conditions retain ordinary state and execution.

Clean-tree qualification commands and outcomes are recorded after the focused
run below. Runtime paths must be real and short enough for nested Unix sockets;
use a private `env -i`, not inherited deployment configuration.

## Existing status observation

A follow-up adds no command or setting: the existing actor-scoped `kernel.status`
response optionally includes `coldMemory:{version:1,state,...}` for a kernel that
advertised the private capability. Only fixed nonnegative safe-integer counters
and allowlisted state tokens are copied. Names, values, addresses, arbitrary error
text, foreign fields and accessor-derived counters are omitted. Legacy/unknown
kernels retain their exact prior response shape. A stopped owner omits the field;
readiness resets capability metadata per process. The route reads the existing
small owner record only, without collection, startup, execution or checkpoint work.

Before that implementation, `KernelColdStatus` passed 12 generated/distinct states
at depth 2. Its `legacy`, `payload`, `bounds` and `mutation` controls each returned
TLC exit 12 at depth 2. The normal actual-kernel fixture invokes Python's existing
`kernel.status()` via the real host bridge after paging, and fixed-projection tests
cover supported/unsupported/legacy metadata, invalid numbers and non-observed
accessor/foreign payload fields. The automatic gate now has 10 passing Node cases.

Cumulative
helper timing counters are owned by the helper, so resumed passes include bounded
steps whose old controller replies were correctly fenced after intervening demand.


## Clean-tree focused qualification

The clean automatic-only tree passed **80/80**, with no failures, cancellation or
skips, in 79.7 seconds. This includes the 10-case automatic/status gate, native and
ordinary FIFO/cancellation, execution completion, deferred checkpoints, restore
lifetime, rich output, scratch, read-only diagnostics, operations accounting and
snapshot durability/failure. Standalone operations accounting passed 12/12,
including copied-package loading with only shipped runtime support. Package-load
smoke and `git diff --check` passed.

The environment was `env -i`, with real short private runtime directories under
`/tmp/ac-*` (HOME, agent directory and TMPDIR). Native opt-in was absent. The matched
source SDK/CLI, explicit compatible interpreter, official SDK fixture, project
skills, empty extra extensions, `harness` presentation namespace and existing
`201326592` context budget were supplied. No credentials or completed environments
were copied, no dependency installation occurred, and no full suite ran.

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin \
  HOME="$RUNTIME/home" PI_CODING_AGENT_DIR="$RUNTIME/home/agent" TMPDIR="$RUNTIME/tmp" \
  PI_HARNESS_PI_COMMAND="$SOURCE_PI/dist/cli.js" \
  PI_HARNESS_PI_MODULE="$SOURCE_PI/dist/programmatic.js" \
  PI_HARNESS_TEST_OFFICIAL_PI_MODULE="$OFFICIAL_PI/dist/index.js" \
  PI_HARNESS_SKILLS_PATH="$HARNESS/skills" PI_HARNESS_ACTOR_EXTENSIONS='[]' \
  PI_HARNESS_PYTHON="$MANAGED_PYTHON" PI_HARNESS_AUTO_INSTALL=0 \
  PI_HARNESS_PRESENTATION_NAMESPACE=harness \
  PI_HARNESS_CONTEXT_STRING_CODE_UNITS=201326592 UV_OFFLINE=1 \
  node --test --test-concurrency=1 \
  test/kernel-cold-memory.test.mjs test/extension-native-async.test.mjs \
  test/kernel-async.test.mjs test/kernel-completion.test.mjs \
  test/kernel-deferred-checkpoint.test.mjs test/kernel-recovery-lifetime.test.mjs \
  test/kernel-rich-output.test.mjs test/kernel-scratch.test.mjs \
  test/memory-diagnostics.test.mjs test/snapshot-durability.test.mjs \
  test/snapshot-failure.test.mjs test/operations-memory.test.mjs
```

Separately run `npm run test:package-load` in that sanitized environment and
`MANAGED_PYTHON -B test/operations-memory.py`. The shared observer bytes were
verified equal to the public base's old operations observer. Background, kernel
skill, SDK worker, extension and Node reclamation sources were verified unchanged
from the public base. No additional process/API dependency is required.
