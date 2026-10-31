# Specification source baselines

Every `.tla` module under `specification/`, including nested and generated modules,
names the repository files whose behavior it models. Put a `Sources` block
immediately after its `MODULE` declaration, with one pin per modeled file:

```tla
---- MODULE Example ----
\* Sources:
\*   src/example.mjs sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
EXTENDS Naturals
```

Replace the example path and digest with the modeled file and the SHA-256 digest
of its exact bytes. Use canonical repository-relative paths with forward slashes:
no absolute paths, `.` or `..` segments, repeated separators, or backslashes.
Real test and helper source files are valid bindings. Source paths must resolve
to regular files inside the repository. Specification directories and modules
must be regular directories and files, not symbolic links.

Pins are contiguous `\*   path sha256:digest` lines, with exactly 64 lowercase
hexadecimal digest characters. Separate any following line-comment prose with a
blank line. A module needs at least one pin; duplicate paths and malformed entries
fail validation.

## Check and update a baseline

`npm test` automatically runs `test/specification-sources.test.mjs`. It recursively
checks every `.tla` module for required metadata, existing file bindings, and
unchanged source bytes. It has no Git or modification-time dependency and runs
without TLC. To run just this check and its synthetic regressions:

```sh
node bin/run-tests.mjs unit test/specification-sources.test.mjs
```

A pin records a reviewed source/model baseline, not proof that TLC ran today.
When source bytes change:

1. Review the source change against each affected model and its configurations.
   Update the model when its behavior no longer matches. Delete or merge the
   model if its modeled implementation was removed or replaced.
2. Recheck the affected behavior with the relevant implementation tests and model
   checks. The existing TLC runner accepts model-name prefixes, for example:
   `node bin/check-specs.mjs Example`. Compare the outcome with the recorded
   expectation in `specification/expected-results.json`.
3. After that review and recheck, compute the digest of each reviewed source file,
   for example `sha256sum src/example.mjs`, and deliberately update only its
   affected pins. Rerun the source-baseline test.

A byte-only change can leave model behavior unchanged, but still requires that
review before replacing its digest. The validator does not rewrite pins or offer
a blanket accept/rebaseline flag. TLC's `--record` option records expected model
outcomes; it does not update source pins.

## Model ownership boundaries

`MessageLocation` models the harness pipeline for an already-frozen optional
attachment: durable admission, idempotent replay, canonical commit, original
retry, and private versus public projection. Browser opt-in, acquisition clocks,
send deadlines, and cancellation are not harness guarantees.

`HarnessDependencies` separates standalone package-import smoke from runtime
startup validation. Package smoke does not resolve or validate an external SDK
graph; startup retains that check. Source pins describe the modeled owner, not
stronger guarantees from an external component or an environment assumption.
