import assert from "node:assert/strict";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ATOMIC_WRITE_TEMPORARY_KIND, atomicWriteFile } from "../src/filesystem/atomic-write.ts";
import { ownedTemporaryOwnerOf } from "../src/filesystem/private-state.ts";
import { SecurityError } from "../src/kernel/errors.ts";
import { createTempDir } from "./support/temp-dir.ts";
import { requireHost } from "./support/host-requirement.ts";


function makeDir(): string {
  return createTempDir("atomic-write-test-");
}

function cleanup(dir: string): void {
  try {
    // restore perms before removing in case a test left it read-only
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

function listTempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => ownedTemporaryOwnerOf(name)?.kind === ATOMIC_WRITE_TEMPORARY_KIND);
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test("atomicWriteFile: writes a new file and returns success", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    const result = atomicWriteFile(target, "hello world");
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8"), "hello world");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: overwrites an existing file atomically", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    writeFileSync(target, "original");
    const result = atomicWriteFile(target, "replaced");
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8"), "replaced");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: leaves no temp file behind after success", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    atomicWriteFile(target, "content");
    assert.equal(listTempFiles(dir).length, 0, "no temp file should remain after a successful write");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: writes into a nested directory that does not yet exist", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "nested", "deep", "out.txt");
    const result = atomicWriteFile(target, "nested content");
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8"), "nested content");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: directories it creates keep the ordinary umask mode — only state is private", () => {
  // The generic writer serves the editor's create path inside a USER'S
  // project: a directory it makes there must look like one git would check
  // out. Private state directories are made by ensurePrivateStateDirectory.
  const dir = makeDir();
  const previousUmask = process.umask(0o002);
  try {
    assert.equal(atomicWriteFile(join(dir, "project", "src", "new.ts"), "export {};\n").success, true);
    assert.equal(statSync(join(dir, "project")).mode & 0o7777, 0o775);
    assert.equal(statSync(join(dir, "project", "src")).mode & 0o7777, 0o775);
  } finally {
    process.umask(previousUmask);
    cleanup(dir);
  }
});

test("atomicWriteFile: writes binary-safe UTF-8 content (multi-byte)", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "unicode.txt");
    const content = "café — 😀 — 日本語";
    const result = atomicWriteFile(target, content);
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8"), content);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: writes empty file", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "empty.txt");
    const result = atomicWriteFile(target, "");
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8"), "");
    assert.equal(statSync(target).size, 0);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: writes large content (> 64 KiB) in one atomic operation", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "large.txt");
    const content = "x".repeat(128 * 1024);
    const result = atomicWriteFile(target, content);
    assert.equal(result.success, true);
    assert.equal(readFileSync(target, "utf8").length, content.length);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: created file mode is 0600 (no temp leak of permissions)", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "mode.txt");
    atomicWriteFile(target, "x");
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Failure paths: original must remain unchanged (crash-mid-write safety)
// ---------------------------------------------------------------------------

test("atomicWriteFile: returns success:false (never throws) when parent is a file, not a directory", () => {
  const dir = makeDir();
  try {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file");
    const target = join(blocker, "sub", "out.txt");
    const result = atomicWriteFile(target, "should fail");
    assert.equal(result.success, false);
    assert.ok(result.reason !== undefined);
    assert.equal(existsSync(target), false);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: leaves the original file unchanged when the write fails (read-only directory)", () => {
  // A HOST REQUIREMENT: chmod restrictions bind only a non-root user.
  requireHost(process.getuid?.() !== 0, "a non-root test user (chmod restrictions are bypassed for root)");
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    writeFileSync(target, "original");
    // Make the directory read-only so temp-file creation (O_EXCL) fails.
    chmodSync(dir, 0o500);
    const result = atomicWriteFile(target, "new content that must not land");
    assert.equal(result.success, false, "write to a read-only directory must fail");
    // Restore perms so we can read/cleanup.
    chmodSync(dir, 0o700);
    assert.equal(readFileSync(target, "utf8"), "original", "original content must survive a failed atomic write");
    assert.equal(listTempFiles(dir).length, 0, "no temp file should remain after a failed write");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: cleans up its temp file when the directory becomes unwritable mid-write", () => {
  requireHost(process.getuid?.() !== 0, "a non-root test user (chmod restrictions are bypassed for root)");
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    writeFileSync(target, "keep-me");
    chmodSync(dir, 0o500);
    atomicWriteFile(target, "do-not-land");
    chmodSync(dir, 0o700);
    assert.equal(listTempFiles(dir).length, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Concurrency / determinism
// ---------------------------------------------------------------------------

test("atomicWriteFile: many sequential writes converge to the last content", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "counter.txt");
    for (let i = 0; i < 50; i += 1) {
      const result = atomicWriteFile(target, `version-${i}`);
      assert.equal(result.success, true, `write ${i} should succeed`);
    }
    assert.equal(readFileSync(target, "utf8"), "version-49");
    assert.equal(listTempFiles(dir).length, 0);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: writing the same file from two temp names does not leave both temps", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "out.txt");
    const r1 = atomicWriteFile(target, "first");
    const r2 = atomicWriteFile(target, "second");
    assert.equal(r1.success && r2.success, true);
    assert.equal(readFileSync(target, "utf8"), "second");
    assert.equal(listTempFiles(dir).length, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Idempotency / content fidelity
// ---------------------------------------------------------------------------

test("atomicWriteFile: rewriting identical content still succeeds and matches", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "same.txt");
    atomicWriteFile(target, "stable");
    atomicWriteFile(target, "stable");
    assert.equal(readFileSync(target, "utf8"), "stable");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: content with trailing newline is preserved byte-for-byte", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "nl.txt");
    const content = "line1\nline2\n";
    atomicWriteFile(target, content);
    assert.equal(readFileSync(target, "utf8"), content);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: content with null bytes is preserved byte-for-byte", () => {
  const dir = makeDir();
  try {
    const target = join(dir, "null.txt");
    const content = "a\x00b\x00c";
    atomicWriteFile(target, content);
    const read = readFileSync(target);
    assert.equal(read.length, content.length);
    assert.deepEqual(Array.from(read), Array.from(Buffer.from(content, "utf8")));
  } finally { cleanup(dir); }
});

test("atomicWriteFile: writing to a path whose directory exists is a single rename", () => {
  // Indirect: after success, the file exists and no temp remains (rename completed).
  const dir = makeDir();
  try {
    const target = join(dir, "single.txt");
    atomicWriteFile(target, "x");
    assert.ok(existsSync(target));
    assert.equal(listTempFiles(dir).length, 0);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// PERMISSIONS SURVIVE THE RENAME
//
// A rename replaces the INODE, so the target ends up wearing the temp file's
// mode. The temp file is deliberately private, so every atomic write silently
// re-permissioned whatever it wrote — and git records only the executable bit,
// which is why `git status` reported a clean tree while 53 tracked files sat
// at 0600 against 100644 in the index, the config's single source of truth
// among them. Invisible to the tool everyone checks with.
//
// POPULATION: every mode an existing target can carry, driven over the modes
// this tree actually uses (0664 and 0644 for tracked files, 0755/0775 for
// executables) plus the private 0600 the writer defaults to, and a
// group-writable directory so the umask has something to strip if it is being
// consulted at all. The modes are listed here because they are FIXTURES, not
// a claim about which files exist; the claim about files is re-derived in
// `tracked-file-modes.test.ts`.
// ---------------------------------------------------------------------------

const PRESERVED_MODES = [0o664, 0o644, 0o600, 0o755, 0o775];

test("atomicWriteFile: an existing file keeps its mode across the rename", () => {
  // The modes are iterated inside one statically-named test on purpose: the
  // test inventory refuses a name it cannot read from the source, which is
  // the right refusal — a name assembled at runtime is a test nothing can
  // enumerate, and an inventory that cannot enumerate is a universe that can
  // shrink in silence.
  const changed: string[] = [];
  for (const mode of PRESERVED_MODES) {
    const dir = makeDir();
    try {
      const target = join(dir, "keeps-mode.txt");
      writeFileSync(target, "original");
      chmodSync(target, mode);
      // LIVENESS: the fixture really has the mode under test. A filesystem
      // that ignored the chmod would make every assertion below vacuous.
      assert.equal(statSync(target).mode & 0o7777, mode, `the fixture never took mode ${mode.toString(8)}`);

      const result = atomicWriteFile(target, "replaced");
      assert.equal(result.success, true);
      assert.equal(readFileSync(target, "utf8"), "replaced");
      const after = statSync(target).mode & 0o7777;
      if (after !== mode) changed.push(`${mode.toString(8)} -> ${after.toString(8)}`);
    } finally { cleanup(dir); }
  }
  assert.deepEqual(
    changed,
    [],
    `the write changed the file's permissions: ${changed.join(", ")}. A rename replaces the inode, so the target wears the temp file's mode unless it is carried across.`,
  );
});

test("atomicWriteFile: a group-readable file stays group-readable after MANY writes", () => {
  // The drift arrived one write at a time and was never noticed, so the
  // assertion is on the state after repeated writes rather than after one.
  const dir = makeDir();
  try {
    const target = join(dir, "repeated.txt");
    writeFileSync(target, "0");
    chmodSync(target, 0o664);
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(atomicWriteFile(target, String(i)).success, true);
      assert.equal(
        statSync(target).mode & 0o060,
        0o060,
        `write ${i} stripped the group bits — this is the drift, one write at a time`,
      );
    }
    assert.equal(readFileSync(target, "utf8"), "5");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: a file that did not exist takes the private default", () => {
  // Deny by default for something this process is creating: no target means
  // no mode to preserve, and the safe answer is the restrictive one rather
  // than whatever the umask happens to allow.
  const dir = makeDir();
  try {
    const target = join(dir, "brand-new.txt");
    assert.equal(existsSync(target), false, "the fixture must not already exist");
    assert.equal(atomicWriteFile(target, "x").success, true);
    assert.equal(statSync(target).mode & 0o077, 0, "a newly created file must not be group- or world-accessible");
  } finally { cleanup(dir); }
});

test("atomicWriteFile: requiredMode tightens a too-open existing file to the floor", () => {
  // The config must be 0600. A write that PRESERVED an operator-accidental
  // 0664 left the next read refusing the file (config_mode_insecure) — the
  // recurring "chmod it by hand" cascade. With requiredMode the write corrects
  // the mode instead of preserving the permissive one. Driven across modes so
  // a single lucky value cannot pass it.
  const cases: ReadonlyArray<readonly [number, number, number]> = [
    // [existing mode, requiredMode, expected result mode]
    [0o664, 0o600, 0o600], // too open -> tightened to the floor
    [0o640, 0o600, 0o600], // group-readable -> tightened
    [0o600, 0o600, 0o600], // already at the floor -> unchanged
    [0o400, 0o600, 0o400], // stricter than the floor -> kept (tighten, never loosen)
  ];
  const wrong: string[] = [];
  for (const [existing, required, expected] of cases) {
    const dir = makeDir();
    try {
      const target = join(dir, `f-${existing.toString(8)}.txt`);
      writeFileSync(target, "before");
      chmodSync(target, existing);
      assert.equal(statSync(target).mode & 0o7777, existing, `the fixture never took mode ${existing.toString(8)}`);
      const result = atomicWriteFile(target, "after", { requiredMode: required });
      assert.equal(result.success, true);
      assert.equal(readFileSync(target, "utf8"), "after");
      const after = statSync(target).mode & 0o7777;
      if (after !== expected) wrong.push(`${existing.toString(8)} required ${required.toString(8)} -> ${after.toString(8)}, expected ${expected.toString(8)}`);
    } finally { cleanup(dir); }
  }
  assert.deepEqual(wrong, [], `requiredMode did not tighten to the floor: ${wrong.join(", ")}`);

  // A NEW file with only requiredMode takes the floor.
  const dir = makeDir();
  try {
    const fresh = join(dir, "fresh.json");
    assert.equal(atomicWriteFile(fresh, "{}", { requiredMode: 0o600 }).success, true);
    assert.equal(statSync(fresh).mode & 0o7777, 0o600);
  } finally { cleanup(dir); }
});

test("atomicWriteFile: exact restoration mode and binary bytes are published together", () => {
  const dir = makeDir();
  try {
    const path = join(dir, "binary"); writeFileSync(path, "old"); chmodSync(path, 0o600);
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff]);
    assert.equal(atomicWriteFile(path, bytes, { exactMode: 0o664 }).success, true);
    assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mode & 0o7777, 0o664);
    assert.equal(atomicWriteFile(path, "never", { exactMode: 0o777, requiredMode: 0o600 }).success, false);
    assert.deepEqual(readFileSync(path), bytes); assert.equal(statSync(path).mode & 0o7777, 0o664);
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// A final-component symbolic link: ONE rule for every writer
// ---------------------------------------------------------------------------

test("atomicWriteFile: a final link is written THROUGH only into a declared root, never replaced", () => {
  const dir = makeDir();
  const outside = makeDir();
  try {
    const inner = join(dir, "real.json");
    writeFileSync(inner, "old");
    const link = join(dir, "config.json");
    symlinkSync(inner, link);
    // Inside the declared root: the named file is replaced, the link stays a link.
    assert.equal(atomicWriteFile(link, "new", { linkTargetRoots: [dir] }).success, true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(inner, "utf8"), "new");
    // No declared root: a writer that meets a link it did not expect stops.
    assert.throws(() => atomicWriteFile(link, "x"), (error: unknown) => error instanceof SecurityError && error.code === "atomic_write_link_refused");
    // A link OUT of the root: refused, the link and its target untouched.
    const escaped = join(outside, "target.txt");
    writeFileSync(escaped, "outside");
    const out = join(dir, "escape.txt");
    symlinkSync(escaped, out);
    assert.throws(() => atomicWriteFile(out, "pwned", { linkTargetRoots: [dir] }), (error: unknown) => error instanceof SecurityError && error.code === "atomic_write_link_refused");
    assert.equal(lstatSync(out).isSymbolicLink(), true);
    assert.equal(readFileSync(escaped, "utf8"), "outside");
    // Dangling and looping links: a typed refusal, not a raw ENOENT/ELOOP.
    const dangling = join(dir, "dangling");
    symlinkSync(join(dir, "missing"), dangling);
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    for (const path of [dangling, loop]) {
      assert.throws(() => atomicWriteFile(path, "x", { linkTargetRoots: [dir] }), (error: unknown) => error instanceof SecurityError && error.code === "atomic_write_link_unresolved", path);
      assert.equal(lstatSync(path).isSymbolicLink(), true);
    }
    assert.deepEqual(listTempFiles(dir), [], "no temp residue");
  } finally { cleanup(dir); cleanup(outside); }
});

test("atomicWriteFile exclusive + durable: published only under a free name, complete; an existing target is refused untouched with no temp left", () => {
  const root = createTempDir("atomic-exclusive-");
  try {
    const target = join(root, "journal.json");
    assert.equal(atomicWriteFile(target, "first\n", { exclusive: true, durable: true, exactMode: 0o600 }).success, true);
    assert.equal(readFileSync(target, "utf8"), "first\n");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(target).nlink, 1, "the publishing link must not leave a second name");
    const refused = atomicWriteFile(target, "second\n", { exclusive: true, durable: true });
    assert.equal(refused.success, false);
    assert.equal((refused.error as { code?: unknown }).code, "EEXIST");
    assert.equal(readFileSync(target, "utf8"), "first\n", "an exclusive write replaced an existing file");
    assert.deepEqual(readdirSync(root), ["journal.json"], "a refused write left its temp file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicWriteFile: a target removed between an existence check and the mode read is ABSENT, never a thrown ENOENT (the interleaving, forced)", () => {
  // Found by twelve parallel declarations racing one lock file: the mode read
  // was `existsSync` then `statSync`, and a contender's unlink between the two
  // threw ENOENT out of a function that promises a result. The interleaving is
  // forced, not hoped for: the first observation that CONFIRMS the target
  // exists is followed at once by its removal — exactly what a contender's
  // unlink does. One stat that answers absence reads the file and carries on;
  // a second, confirming stat would meet the removal and throw.
  const root = createTempDir("atomic-vanishing-target-");
  const target = join(root, "contended.lock");
  writeFileSync(target, "held by a contender\n");
  const mutable = filesystem as unknown as { existsSync: typeof existsSync; statSync: typeof statSync };
  const original = { existsSync: mutable.existsSync, statSync: mutable.statSync };
  let removed = false;
  const removeOnce = (): void => {
    if (removed) return;
    removed = true;
    rmSync(target);
  };
  mutable.existsSync = ((path: Parameters<typeof existsSync>[0]) => {
    const answer = original.existsSync(path);
    if (path === target && answer) removeOnce();
    return answer;
  }) as typeof existsSync;
  mutable.statSync = ((path: Parameters<typeof statSync>[0], options?: { throwIfNoEntry?: boolean }) => {
    const answer = original.statSync(path, options as never);
    if (path === target && answer !== undefined) removeOnce();
    return answer;
  }) as typeof statSync;
  syncBuiltinESMExports();
  try {
    const written = atomicWriteFile(target, "new holder\n", { exclusive: true, exactMode: 0o600 });
    assert.equal(removed, true, "the target was never observed, so the interleaving was not exercised");
    assert.equal(written.success, true, `the write did not answer: ${String(written.reason)}`);
    assert.equal(readFileSync(target, "utf8"), "new holder\n");
  } finally {
    mutable.existsSync = original.existsSync;
    mutable.statSync = original.statSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
