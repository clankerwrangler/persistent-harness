---
name: files
description: Bounded filesystem reading, writing, exact editing, search, discovery, and listing.
---

# Files

## API

Import with `import harness_files as files` (the kernel also preloads `files`).

Use `files.read(path, offset=1, limit=2000)` for text, `files.list(path)` for directory entries, `files.find(path, pattern)` for names, and `files.grep(pattern, path)` for matching lines. `grep` keeps JavaScript regular-expression compatibility but evaluates the complete search in a disposable worker with a 2-second hard deadline. It opens the root and every traversed child descriptor-relative with `O_NOFOLLOW`, never trusts cached directory-entry types after a swap, and visits at most 10,000 entries/files, streams line-bounded matches (8 KiB per displayed line) instead of loading a file as one blob, skips `*.map` during directory walks while still searching an explicit `.map` path, streams `.jsonl` even when larger than 1 MiB, skips other files over 1 MiB and stops at 32 MiB total, returns at most 64 KiB of match records, and deterministically skips NUL-containing or invalid-UTF-8 content. Symlink, binary, and 2-second deadline bounds are unchanged. Its `stats` field reports inspected and skipped content. Use `files.attachment(path)` to emit a bounded image or binary attachment MIME bundle.

Mutations use `files.write(path, content)` and `files.edit(path, old_text, new_text, replace_all=False)`. `files.write` is atomic create-only/no-replace: a flushed private same-directory inode is published with `link(2)` only while the destination is absent, so an existing file or concurrent creator wins and is never overwritten. `files.edit` requires an existing ordinary regular UTF-8 file and an exact unique `old_text` match unless `replace_all=True` is explicit. It rejects invalid UTF-8, missing/ambiguous matches, symlink or non-regular leaves, sources over 1 MiB, and setuid/setgid/sticky mode bits without changing the source.

A successful edit opens and snapshots the source without following the leaf, builds the bounded replacement, writes and fsyncs a private same-directory temp, preserves ordinary permission bits and UID/GID (or fails before publication when ownership cannot be preserved), then immediately revalidates the canonical parent plus source identity, metadata, and bytes before atomic `rename(2)` replacement. It fsyncs the publication directory where supported and verifies the published inode, content, and metadata. Cancellation and pre-publication failure clean private temps.

The edit precondition is deliberately **not** described as kernel compare-and-swap. POSIX/Node cannot couple an expected source inode with replace-existing `rename(2)` in one commit, so an arbitrary external writer that does not coordinate can still change the pathname after the final validation and before rename and may be replaced. The supported guarantee is an atomic whole-file replacement with immediate best-effort race detection, not expected-inode CAS. Parent/leaf changes observed before publication fail without mutation; failures observed after publication are reported as committed.

After either create or edit publication, any verification, durability, or cleanup failure raises the fixed path-independent committed error `code="ERR_ATOMIC_FILE_COMMITTED"`, `committed=true`, `phase="post-publication"`. Its message never includes the underlying OS error or a request-controlled pathname.

All operations are bounded and return a `SkillResult` containing structured metadata. Filesystem access is not sandboxed beyond the kernel process's OS permissions.
