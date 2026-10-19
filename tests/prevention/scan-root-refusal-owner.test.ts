// THE SHARED WALKER MUST REFUSE A ROOT IT CANNOT READ, NOT RETURN NOTHING.
//
// `walk()` is the single door 106 guard files enter through, in 258 places.
// It used to answer "nothing was found" and "nothing was looked at" with the
// same value — an empty array — by two separate paths: an `existsSync` miss
// and a `realpathSync` failure. Either one turns a guard whose subject
// directory has been renamed into a guard that reads no files, finds no
// offenders and passes. Eight of those files report exclusively by throwing
// when the offender list is non-empty, so they are structurally unable to
// tell an empty tree from an unread one.
//
// The refusal is at the door because callers do not own the door and so
// cannot forget it. This file is what keeps it there: a deletion leaves
// nothing behind to fail when someone restores the early return "to make a
// scan of an optional directory convenient", which is exactly how it would
// come back.
//
// Every refusal below is paired with a POSITIVE case through the same
// function, because a walker that threw unconditionally would satisfy the
// refusals while breaking every guard in the repository — and the positive
// cases assert real, non-zero populations, so they also fail if the walk
// silently stops finding files.

import { describe, expect, test } from "vitest";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceFiles, sourceFilesReachableFrom, walk, walkTs } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
// Scratch roots come from the temp-dir owner, which creates the directory and
// registers its removal in the same call. Reaching `os.tmpdir()` directly here
// would leak one directory per assertion — and the guard that says so caught
// this file's first draft doing exactly that, which is a fair demonstration
// that a single door beats remembering to clean up.
function scratch(): string {
  return createTempDir("scan-root-refusal-");
}

describe("walk() refuses a root it cannot read", () => {
  test("a root that does not exist throws, and names the path it looked for", () => {
    const root = join(scratch(), "never-created");
    expect(() => walk(root)).toThrow(/scan root does not exist/u);
    // The message must carry the path, or the failure is unactionable: the
    // whole point is that a reader learns WHICH directory moved.
    expect(() => walk(root)).toThrow(new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  });

  test("the refusal reaches walkTs and sourceFiles, which do not own the check", () => {
    // The two wrappers take the refusal by inheritance. If it were written at
    // the call site instead of in `walk`, these would each need their own copy
    // and a third wrapper written tomorrow would need a fourth.
    const root = join(scratch(), "never-created");
    expect(() => walkTs(root)).toThrow(/scan root does not exist/u);
    expect(() => sourceFiles(root)).toThrow(/scan root does not exist/u);
  });

  test("a root that cannot be resolved throws rather than returning nothing", () => {
    // A dangling symlink, which is the ordinary form of "the root is there in
    // the listing and unusable in fact".
    //
    // MEASURED, and it corrects the framing this fix was written under: the
    // `realpathSync` catch one line below is NOT a second reachable hole.
    // Every input that makes `realpathSync` fail — this dangling symlink, a
    // symlink loop, a parent stripped of its execute bit — makes `existsSync`
    // return false first, so this assertion exercises the FIRST refusal. The
    // second is a race guard: reachable only if the root disappears between
    // the two syscalls, which no test can stage deterministically. It throws
    // because a silent `[]` during a race is exactly as invisible as at any
    // other moment, and that is the honest reason rather than a claim of extra
    // coverage.
    const base = scratch();
    const target = join(base, "gone");
    const link = join(base, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    rmSync(target, { recursive: true });
    expect(() => walk(link)).toThrow(/scan root (does not exist|is unreadable)/u);
    rmSync(base, { recursive: true, force: true });
  });

  test("a real root still returns its real population", () => {
    // The control. Without it every refusal above is satisfied by a walker
    // that throws on everything.
    const src = walk("src");
    const server = walkTs("server");
    const contracts = sourceFiles("shared");
    expect(src.length).toBeGreaterThan(100);
    expect(server.length).toBeGreaterThan(50);
    expect(contracts.length).toBeGreaterThan(0);
    expect(src.every((f) => f.endsWith(".ts") || f.endsWith(".svelte"))).toBe(true);
    expect(server.every((f) => f.endsWith(".ts"))).toBe(true);
  });

  test("one unreadable ENTRY inside a readable root is dropped, and the rest still arrive", () => {
    // The deliberate asymmetry, asserted so it cannot be "tidied" into a third
    // refusal. A dangling symlink is one entry; the walk still owes the caller
    // everything else, and turning this into a throw would make an ordinary
    // stale link in someone's working tree break every guard at once.
    const base = scratch();
    writeFileSync(join(base, "real-one.ts"), "export const a = 1;\n");
    writeFileSync(join(base, "real-two.ts"), "export const b = 2;\n");
    symlinkSync(join(base, "absent-target.ts"), join(base, "dangling.ts"));
    const found = walk(base, { exts: [".ts"] });
    expect(found.map((f) => f.split("/").pop()).toSorted()).toEqual(["real-one.ts", "real-two.ts"]);
    rmSync(base, { recursive: true, force: true });
  });
});

describe("sourceFilesReachableFrom() refuses a missing entrypoint", () => {
  test("an entrypoint that does not exist throws instead of shrinking the closure", () => {
    // The worst form of the same defect: a capability guard's population IS
    // the closure of its entry points, so an entry point that moved makes the
    // guard examine a smaller graph and pass, with the reachable set looking
    // perfectly well-formed.
    expect(() => sourceFilesReachableFrom(["server/this-module-was-renamed.ts"], "runtime"))
      .toThrow(/entrypoint does not exist/u);
  });

  test("a real entrypoint still produces a real closure", () => {
    const reachable = sourceFilesReachableFrom([modulePathMatching("server/index.ts")], "runtime");
    expect(reachable.files.length).toBeGreaterThan(50);
  });
});

describe("the roots the guard estate actually names all resolve", () => {
  test("every top-level source directory a guard may scan is present and non-empty", () => {
    // A liveness check on the tree rather than on the walker. If one of these
    // is renamed, the guards that name it now throw — but this test says so
    // first, in one place, with a message that names the directory, instead of
    // the failure arriving as 40 identical stack traces.
    for (const root of ["src", "server", "shared", "tests", "scripts", "bench"]) {
      const files = walk(root, { exts: [".ts", ".svelte"] });
      expect(files.length, `${root} resolved to no source files — did it move?`).toBeGreaterThan(0);
    }
  });
});
