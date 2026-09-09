import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { access, chmod, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostHandlers } from "../src/host-handlers.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "files-atomic-cas-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, handlers: createHostHandlers({ cwd, getClient: () => null }) };
}

function context(signal = new AbortController().signal) {
  return { signal, onProgress() {} };
}

function armTempAction(directory, action) {
  let settled = false;
  let watcher;
  let timer;
  const triggered = new Promise((resolve, reject) => {
    watcher = watch(directory, (eventType, fileName) => {
      if (settled || !String(fileName).startsWith(".pi-atomic-")) return;
      settled = true;
      try {
        action(String(fileName));
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        watcher.close();
        clearTimeout(timer);
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      watcher.close();
      reject(new Error("atomic temp file was not observed"));
    }, 2_000);
  });
  return { triggered, close: () => { settled = true; clearTimeout(timer); watcher?.close(); } };
}

async function assertNoTemps(...directories) {
  for (const directory of directories) {
    const names = await readdir(directory);
    assert.deepEqual(names.filter((name) => name.startsWith(".pi-atomic-")), []);
  }
}

const INOTIFY_RACER = String.raw`
use strict;
use warnings;
require "syscall.ph";
my ($watched, $mode, $a, $b) = @ARGV;
my $fd = syscall(&SYS_inotify_init1, 0);
die "inotify_init1: $!\n" if $fd < 0;
my $wd = syscall(&SYS_inotify_add_watch, $fd, $watched, 0x00000010); # IN_CLOSE_NOWRITE
die "inotify_add_watch: $!\n" if $wd < 0;
$| = 1;
print "READY\n";
open(my $inotify, "<&=$fd") or die "open inotify fd: $!\n";
my $events = "";
sysread($inotify, $events, 4096) > 0 or die "inotify read: $!\n";
if ($mode eq "leaf") {
  rename($a, $b) or die "rename leaf: $!\n";
} elsif ($mode eq "parent") {
  rename($a, $b) or die "rename parent: $!\n";
  mkdir($a) or die "mkdir parent: $!\n";
} else { die "bad mode\n"; }
print "RACED\n";
`;

async function startInotifyRacer(args) {
  const child = spawn("/usr/bin/perl", ["-e", INOTIFY_RACER, "--", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("inotify racer did not arm")), 2_000);
    const ready = (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      child.stdout.off("data", ready);
      resolve();
    };
    child.stdout.on("data", ready);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !output.includes("READY")) reject(new Error(`inotify racer exited ${code}: ${errors}`));
    });
  });
  return {
    child,
    async done() {
      const code = child.exitCode ?? await new Promise((resolve) => child.once("close", resolve));
      assert.equal(code, 0, errors);
      assert.match(output, /RACED/);
    },
  };
}

const IN_CREATE_DETACH_RACER = String.raw`
use strict;
use warnings;
require "syscall.ph";
my ($parent, $target, $moved) = @ARGV;
my $fd = syscall(&SYS_inotify_init1, 0);
die "inotify_init1: $!\n" if $fd < 0;
my $wd = syscall(&SYS_inotify_add_watch, $fd, $parent, 0x00000100); # IN_CREATE
die "inotify_add_watch: $!\n" if $wd < 0;
$| = 1;
print "READY\n";
open(my $inotify, "<&=$fd") or die "open inotify fd: $!\n";
my $events = "";
while (1) {
  sysread($inotify, my $chunk, 4096) > 0 or die "inotify read: $!\n";
  $events .= $chunk;
  while (length($events) >= 16) {
    my ($event_wd, $mask, $cookie, $length) = unpack("iIII", substr($events, 0, 16));
    last if length($events) < 16 + $length;
    my $name = substr($events, 16, $length);
    substr($events, 0, 16 + $length, "");
    $name =~ s/\0.*//s;
    next unless ($mask & 0x00000100) && $name eq $target;
    rename($parent, $moved) or die "detach parent: $!\n";
    print "RACED\n";
    exit 0;
  }
}
`;

async function startCreateDetachRacer(parent, target, moved) {
  const child = spawn(
    "/usr/bin/perl",
    ["-e", IN_CREATE_DETACH_RACER, "--", parent, target, moved],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IN_CREATE detach racer did not arm")), 2_000);
    const ready = (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      child.stdout.off("data", ready);
      resolve();
    };
    child.stdout.on("data", ready);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !output.includes("READY")) reject(new Error(`IN_CREATE detach racer exited ${code}: ${errors}`));
    });
  });
  return {
    async done() {
      const code = child.exitCode ?? await new Promise((resolve) => child.once("close", resolve));
      assert.equal(code, 0, errors);
      assert.match(output, /RACED/);
    },
  };
}

const IN_MOVED_TO_DETACH_RACER = String.raw`
use strict;
use warnings;
require "syscall.ph";
my ($parent, $target, $moved) = @ARGV;
my $fd = syscall(&SYS_inotify_init1, 0);
die "inotify_init1: $!\n" if $fd < 0;
my $wd = syscall(&SYS_inotify_add_watch, $fd, $parent, 0x00000080); # IN_MOVED_TO
die "inotify_add_watch: $!\n" if $wd < 0;
$| = 1;
print "READY\n";
open(my $inotify, "<&=$fd") or die "open inotify fd: $!\n";
my $events = "";
while (1) {
  sysread($inotify, my $chunk, 4096) > 0 or die "inotify read: $!\n";
  $events .= $chunk;
  while (length($events) >= 16) {
    my ($event_wd, $mask, $cookie, $length) = unpack("iIII", substr($events, 0, 16));
    last if length($events) < 16 + $length;
    my $name = substr($events, 16, $length);
    substr($events, 0, 16 + $length, "");
    $name =~ s/\0.*//s;
    next unless ($mask & 0x00000080) && $name eq $target;
    rename($parent, $moved) or die "detach parent: $!\n";
    print "RACED\n";
    exit 0;
  }
}
`;

async function startEditDetachRacer(parent, target, moved) {
  const child = spawn(
    "/usr/bin/perl",
    ["-e", IN_MOVED_TO_DETACH_RACER, "--", parent, target, moved],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IN_MOVED_TO detach racer did not arm")), 2_000);
    const ready = (chunk) => {
      if (!String(chunk).includes("READY")) return;
      clearTimeout(timer);
      child.stdout.off("data", ready);
      resolve();
    };
    child.stdout.on("data", ready);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && !output.includes("READY")) reject(new Error(`IN_MOVED_TO detach racer exited ${code}: ${errors}`));
    });
  });
  return {
    async done() {
      const code = child.exitCode ?? await new Promise((resolve) => child.once("close", resolve));
      assert.equal(code, 0, errors);
      assert.match(output, /RACED/);
    },
  };
}

test("files.write creates atomically and remains create-only/no-replace", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const filePath = path.join(cwd, "nested", "sample.txt");
  const created = await handlers["files.write"]({ path: "nested/sample.txt", content: "alpha beta" }, context());
  assert.equal(created.created, true);
  assert.equal(created.committed, undefined); // public handler keeps its stable compact schema
  assert.equal(await readFile(filePath, "utf8"), "alpha beta");

  await chmod(filePath, 0o640);
  await assert.rejects(
    handlers["files.write"]({ path: "nested/sample.txt", content: "gamma" }, context()),
    /file already exists; write was not committed/,
  );
  assert.equal(await readFile(filePath, "utf8"), "alpha beta");
  assert.equal((await stat(filePath)).mode & 0o777, 0o640);
  await assertNoTemps(path.dirname(filePath));
});

test("files.edit performs exact single and replace-all edits while preserving ordinary metadata", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const filePath = path.join(cwd, "editable.txt");
  await writeFile(filePath, "alpha beta\nbeta gamma\nunique\n");
  await chmod(filePath, 0o640);
  const before = await stat(filePath);

  const single = await handlers["files.edit"](
    { path: "editable.txt", oldText: "unique", newText: "single", replaceAll: false },
    context(),
  );
  assert.equal(single.replacements, 1);
  assert.equal(await readFile(filePath, "utf8"), "alpha beta\nbeta gamma\nsingle\n");

  await assert.rejects(
    handlers["files.edit"](
      { path: "editable.txt", oldText: "beta", newText: "ambiguous", replaceAll: false },
      context(),
    ),
    /oldText matched 2 times; use replace_all=True explicitly/,
  );
  const all = await handlers["files.edit"](
    { path: "editable.txt", oldText: "beta", newText: "delta", replaceAll: true },
    context(),
  );
  assert.equal(all.replacements, 2);
  assert.equal(all.bytes, Buffer.byteLength("alpha delta\ndelta gamma\nsingle\n"));
  assert.equal(await readFile(filePath, "utf8"), "alpha delta\ndelta gamma\nsingle\n");

  const after = await stat(filePath);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  await assertNoTemps(cwd);
});

test("post-link parent detach is always a structurally committed failure", { timeout: 30_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  const committedParents = Array.from({ length: 30 }, (_, index) => `committed-parent-${index}`);
  const parentNames = [...committedParents, "published-parent", "durability-parent", "ordinary-parent"];

  for (const [index, parentName] of parentNames.entries()) {
    const parent = path.join(cwd, parentName);
    const moved = path.join(cwd, `detached-${index}`);
    const targetName = "target.txt";
    mkdirSync(parent);
    const racer = await startCreateDetachRacer(parent, targetName, moved);

    let error;
    try {
      await handlers["files.write"](
        { path: `${parentName}/${targetName}`, content: "ours" },
        context(),
      );
    } catch (caught) {
      error = caught;
    }
    await racer.done();

    assert.ok(error instanceof Error, `${parentName}: write unexpectedly succeeded`);
    assert.equal(error.name, "CommittedAtomicFileError");
    assert.equal(error.code, "ERR_ATOMIC_FILE_COMMITTED");
    assert.equal(error.committed, true);
    assert.equal(error.phase, "post-publication");
    assert.equal(
      error.message,
      "atomic file publication committed, but post-publication verification, durability, or cleanup failed",
    );
    assert.equal(error.cause, undefined);
    assert.equal(await readFile(path.join(moved, targetName), "utf8"), "ours");
    await assert.rejects(access(path.join(parent, targetName)));
    await assertNoTemps(moved);
    await rm(moved, { recursive: true, force: true });
  }
});

test("files.edit reports a fixed committed error after adversarial post-rename parent detach", { timeout: 10_000 }, async (t) => {
  const { cwd, handlers } = await fixture(t);
  for (const [index, parentName] of ["edit-committed-parent", "edit-ordinary-parent"].entries()) {
    const parent = path.join(cwd, parentName);
    const moved = path.join(cwd, `edit-detached-${index}`);
    const targetName = "target.txt";
    mkdirSync(parent);
    await writeFile(path.join(parent, targetName), "old value");
    const racer = await startEditDetachRacer(parent, targetName, moved);

    let error;
    try {
      await handlers["files.edit"](
        { path: `${parentName}/${targetName}`, oldText: "old", newText: "new", replaceAll: false },
        context(),
      );
    } catch (caught) {
      error = caught;
    }
    await racer.done();

    assert.ok(error instanceof Error, `${parentName}: edit unexpectedly returned ordinary success`);
    assert.equal(error.name, "CommittedAtomicFileError");
    assert.equal(error.code, "ERR_ATOMIC_FILE_COMMITTED");
    assert.equal(error.committed, true);
    assert.equal(error.phase, "post-publication");
    assert.equal(
      error.message,
      "atomic file publication committed, but post-publication verification, durability, or cleanup failed",
    );
    assert.equal(error.cause, undefined);
    assert.equal(await readFile(path.join(moved, targetName), "utf8"), "new value");
    await assert.rejects(access(path.join(parent, targetName)));
    await assertNoTemps(moved);
    await rm(moved, { recursive: true, force: true });
  }
});

test("text edit rejects invalid UTF-8 without changing any bytes", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const target = path.join(cwd, "invalid.bin");
  const original = Buffer.from([0x41, 0xff, 0x20, 0x6f, 0x6c, 0x64]);
  await writeFile(target, original);
  await assert.rejects(
    handlers["files.edit"]({ path: "invalid.bin", oldText: "old", newText: "new", replaceAll: false }, context()),
    /not valid UTF-8; edit was not committed/,
  );
  assert.deepEqual(await readFile(target), original);
});

test("text edit rejects existing sources over 1 MiB without changing them", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const target = path.join(cwd, "oversized.txt");
  const original = Buffer.concat([Buffer.from("old"), Buffer.alloc(1024 * 1024, 0x78)]);
  await writeFile(target, original);
  await assert.rejects(
    handlers["files.edit"]({ path: "oversized.txt", oldText: "old", newText: "new", replaceAll: false }, context()),
    /existing file exceeds 1048576 byte atomic-source limit/,
  );
  assert.deepEqual(await readFile(target), original);
  await assertNoTemps(cwd);
});

test("existing special mode bits are explicitly rejected and preserved", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const target = path.join(cwd, "special.sh");
  await writeFile(target, "#!/bin/sh\n");
  await chmod(target, 0o4755);
  await assert.rejects(
    handlers["files.write"]({ path: "special.sh", content: "replacement" }, context()),
    /unsupported special mode bits; write was not committed/,
  );
  await assert.rejects(
    handlers["files.edit"]({ path: "special.sh", oldText: "bin", newText: "usr/bin", replaceAll: false }, context()),
    /unsupported special mode bits; edit was not committed/,
  );
  assert.equal((await stat(target)).mode & 0o7777, 0o4755);
  assert.equal(await readFile(target, "utf8"), "#!/bin/sh\n");
});

test("file mutations reject symlink/non-regular leaves and symlink parents", async (t) => {
  const { cwd, handlers } = await fixture(t);
  await writeFile(path.join(cwd, "victim.txt"), "victim");
  symlinkSync("victim.txt", path.join(cwd, "leaf-link"));
  mkdirSync(path.join(cwd, "directory-leaf"));
  symlinkSync(cwd, path.join(cwd, "parent-link"));
  await assert.rejects(handlers["files.write"]({ path: "leaf-link", content: "bad" }, context()), /must not be a symlink/);
  await assert.rejects(handlers["files.edit"]({ path: "leaf-link", oldText: "victim", newText: "bad", replaceAll: false }, context()), /must not be a symlink/);
  await assert.rejects(handlers["files.edit"]({ path: "directory-leaf", oldText: "x", newText: "y", replaceAll: false }, context()), /regular file/);
  await assert.rejects(handlers["files.write"]({ path: "parent-link/new.txt", content: "bad" }, context()), /parent path component is a symlink or non-directory/);
  assert.equal(await readFile(path.join(cwd, "victim.txt"), "utf8"), "victim");
  await assertNoTemps(cwd);
});

test("files.edit detects adversarial leaf/parent changes and cancellation before replacement", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const target = path.join(cwd, "target.txt");
  const racer = path.join(cwd, "racer.txt");
  await writeFile(target, "old original");
  await writeFile(racer, "old concurrent-racer");

  let gate = armTempAction(cwd, () => renameSync(racer, target));
  let operation = handlers["files.edit"](
    { path: "target.txt", oldText: "old", newText: "new", replaceAll: false },
    context(),
  );
  await gate.triggered;
  await assert.rejects(operation, /file changed concurrently; edit was not committed/);
  gate.close();
  assert.equal(await readFile(target, "utf8"), "old concurrent-racer");
  await assertNoTemps(cwd);

  const parent = path.join(cwd, "parent");
  const moved = path.join(cwd, "parent-moved");
  mkdirSync(parent);
  await writeFile(path.join(parent, "target.txt"), "old parent");
  gate = armTempAction(parent, () => { renameSync(parent, moved); mkdirSync(parent); });
  operation = handlers["files.edit"](
    { path: "parent/target.txt", oldText: "old", newText: "new", replaceAll: false },
    context(),
  );
  await gate.triggered;
  await assert.rejects(operation, /parent directory changed concurrently; edit was not committed/);
  gate.close();
  await assert.rejects(access(path.join(parent, "target.txt")));
  assert.equal(await readFile(path.join(moved, "target.txt"), "utf8"), "old parent");
  await assertNoTemps(parent, moved);

  const cancelledTarget = path.join(cwd, "cancelled-edit.txt");
  await writeFile(cancelledTarget, "old cancellation");
  const controller = new AbortController();
  gate = armTempAction(cwd, () => controller.abort());
  operation = handlers["files.edit"](
    { path: "cancelled-edit.txt", oldText: "old", newText: "new", replaceAll: false },
    context(controller.signal),
  );
  await gate.triggered;
  await assert.rejects(operation, /file operation cancelled/);
  gate.close();
  assert.equal(await readFile(cancelledTarget, "utf8"), "old cancellation");
  await assertNoTemps(cwd);
});

test("files.write never overwrites existing leaf and parent race winners", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const target = path.join(cwd, "target.txt");
  const replacement = path.join(cwd, "replacement.txt");
  await writeFile(target, "original");
  await writeFile(replacement, "concurrent-racer");
  let racer = await startInotifyRacer([target, "leaf", replacement, target]);
  await assert.rejects(handlers["files.write"]({ path: "target.txt", content: "ours" }, context()), /file already exists; write was not committed/);
  await racer.done();
  assert.equal(await readFile(target, "utf8"), "concurrent-racer");

  const parent = path.join(cwd, "parent");
  const moved = path.join(cwd, "moved");
  mkdirSync(parent);
  const parentTarget = path.join(parent, "target.txt");
  await writeFile(parentTarget, "original-parent");
  racer = await startInotifyRacer([parentTarget, "parent", parent, moved]);
  await assert.rejects(handlers["files.write"]({ path: "parent/target.txt", content: "ours" }, context()), /file already exists; write was not committed/);
  await racer.done();
  await assert.rejects(access(path.join(parent, "target.txt")));
  assert.equal(await readFile(path.join(moved, "target.txt"), "utf8"), "original-parent");
  await assertNoTemps(cwd, parent, moved);
});

test("create races, parent races, temp swaps, and cancellation fail without hidden publication", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const victim = path.join(cwd, "victim.txt");
  await writeFile(victim, "victim");

  let gate = armTempAction(cwd, (tempName) => {
    const tempPath = path.join(cwd, tempName);
    unlinkSync(tempPath);
    symlinkSync("victim.txt", tempPath);
  });
  let operation = handlers["files.write"]({ path: "new.txt", content: "replacement" }, context());
  await gate.triggered;
  await assert.rejects(operation, /atomic temp (?:path is not a private regular file|changed concurrently)/);
  gate.close();
  await assert.rejects(access(path.join(cwd, "new.txt")));
  assert.equal(await readFile(victim, "utf8"), "victim");

  gate = armTempAction(cwd, () => writeFileSync(path.join(cwd, "create-race.txt"), "racer"));
  operation = handlers["files.write"]({ path: "create-race.txt", content: "ours" }, context());
  await gate.triggered;
  await assert.rejects(operation, /write create was not committed/);
  gate.close();
  assert.equal(await readFile(path.join(cwd, "create-race.txt"), "utf8"), "racer");

  const parent = path.join(cwd, "parent");
  const moved = path.join(cwd, "parent-moved");
  mkdirSync(parent);
  gate = armTempAction(parent, () => { renameSync(parent, moved); mkdirSync(parent); });
  operation = handlers["files.write"]({ path: "parent/new.txt", content: "ours" }, context());
  await gate.triggered;
  await assert.rejects(operation, /parent directory changed concurrently; write was not committed/);
  gate.close();
  await assert.rejects(access(path.join(parent, "new.txt")));
  await assert.rejects(access(path.join(moved, "new.txt")));

  const controller = new AbortController();
  gate = armTempAction(cwd, () => controller.abort());
  operation = handlers["files.write"]({ path: "cancelled.txt", content: "after" }, context(controller.signal));
  await gate.triggered;
  await assert.rejects(operation, /file operation cancelled/);
  gate.close();
  await assert.rejects(access(path.join(cwd, "cancelled.txt")));

  const healthy = await handlers["files.write"]({ path: "healthy.txt", content: "alpha" }, context());
  assert.equal(healthy.created, true);
  assert.equal(await readFile(path.join(cwd, "healthy.txt"), "utf8"), "alpha");
  await assertNoTemps(cwd, parent, moved);
});


test("files.edit preserves literal replacement text in exact single and replace-all edits", async (t) => {
  const cases = [
    ["dollar-apostrophe", "$'"],
    ["dollar-backtick", "$`"],
    ["dollar-ampersand", "$&"],
    ["double-dollar", "$$"],
    ["capture-like tokens", "$0 $1 $99 $<name>"],
    ["multiline Unicode and backslashes", "雪🙂\\path\n$' $` $& $$\r\n"],
    ["empty replacement", ""],
  ];
  for (const [label, newText] of cases) {
    for (const replaceAll of [false, true]) {
      await t.test(`${label}, replaceAll=${replaceAll}`, async (t) => {
        const { cwd, handlers } = await fixture(t);
        const filePath = path.join(cwd, "literal.txt");
        const content = replaceAll ? "prefix<OLD>middle<OLD>suffix" : "prefix<OLD>suffix";
        const expected = replaceAll ? `prefix${newText}middle${newText}suffix` : `prefix${newText}suffix`;
        await writeFile(filePath, content);
        const result = await handlers["files.edit"]({ path: "literal.txt", oldText: "<OLD>", newText, replaceAll }, context());
        assert.deepEqual(await readFile(filePath), Buffer.from(expected));
        assert.equal(result.bytes, Buffer.byteLength(expected));
        assert.equal(result.replacements, replaceAll ? 2 : 1);
        await assertNoTemps(cwd);
      });
    }
  }
});

test("files.edit preserves a literal whole-file Docker-name filter", async (t) => {
  const { cwd, handlers } = await fixture(t);
  const filePath = path.join(cwd, "filter.py");
  const original = "filters = []\n";
  const intended = "filters = ['name=^taihou$']\n";
  await writeFile(filePath, original);
  const result = await handlers["files.edit"]({ path: "filter.py", oldText: original, newText: intended, replaceAll: false }, context());
  assert.deepEqual(await readFile(filePath), Buffer.from(intended));
  assert.equal(result.bytes, Buffer.byteLength(intended));
  assert.equal(result.replacements, 1);
  await assertNoTemps(cwd);
});
