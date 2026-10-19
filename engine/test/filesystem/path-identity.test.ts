import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { createTempDir } from "../support/temp-dir.ts";
import { InputError } from "../../src/kernel/errors.ts";
import {
  createPathLocator,
  identityKey,
  identityOverlapIndex,
  resolveLocation,
} from "../../src/filesystem/path-identity.ts";

/**
 * The resolver is the door the guardian's safety floor now speaks through, so
 * its contract is tested directly and not only through the compiler: a floor
 * that compares locations is only as good as the function that produces them.
 */

function fixture(): Readonly<{ root: string; cleanup: () => void }> {
  const root = realpathSync(createTempDir("path-identity-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("path-identity: a relative path, '~/' and '$HOME' are refused with a typed code", () => {
  const refused = ["relative/x", "./x", "../x", "~/", "~/secrets", "$HOME", ""];
  assert.ok(refused.length >= 7, `non-absolute shapes driven: ${refused.length}`);
  for (const raw of refused) {
    assert.throws(
      () => resolveLocation(raw),
      (error: unknown) =>
        error instanceof InputError && error.code === "path_not_absolute",
      `${JSON.stringify(raw)} is not absolute`,
    );
  }
  // CLEAN CONTROL: the resolver is not simply refusing everything.
  assert.equal(resolveLocation("/usr"), realpathSync("/usr"));
});

test("path-identity: every spelling of one directory resolves to that one directory", () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const link = join(root, "link-to-a");
    symlinkSync(join(root, "a"), link);
    const target = join(root, "a");
    const spellings = [
      target,
      `${target}/`,
      `${target}/.`,
      `${target}/b/..`,
      `${target}//`,
      `/${target}`,
      link,
      `${link}/`,
      `${link}/b/..`,
    ];
    assert.ok(spellings.length >= 9, `spellings driven: ${spellings.length}`);
    for (const raw of spellings) {
      assert.equal(resolveLocation(raw), target, `${raw} names ${target}`);
    }
    // PLANTED VIOLATION: a path that genuinely is somewhere else must NOT
    // collapse onto the target, or the assertions above are satisfied by a
    // resolver that returns the same answer for everything.
    assert.notEqual(resolveLocation(join(root, "a", "b")), target);
  } finally {
    cleanup();
  }
});

test("path-identity: the lexical pass runs BEFORE the link pass, as the kernel does", () => {
  // THE ORDER IS THE WHOLE ANSWER, and getting it backwards is a plausible
  // implementation that is wrong in the dangerous direction. `<link>/..` must
  // resolve to the LINK'S PARENT — which is what `open()` does after the
  // lexical `..` is applied — and not to the parent of the link's target,
  // which is somewhere the operator never named.
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "outer", "target"), { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    const link = join(root, "elsewhere", "to-target");
    symlinkSync(join(root, "outer", "target"), link);
    assert.equal(
      resolveLocation(`${link}/..`),
      join(root, "elsewhere"),
      "'<link>/..' is the link's own parent",
    );
    assert.notEqual(resolveLocation(`${link}/..`), join(root, "outer"));
  } finally {
    cleanup();
  }
});

test("path-identity: a path that does not exist yet keeps its missing tail", () => {
  // An allow-rule may legitimately name something not created yet — a
  // project's scratch folder is exactly that — so the resolver must answer
  // rather than throw, and the answer must still be the resolved ancestor
  // plus the tail.
  const { root, cleanup } = fixture();
  try {
    const link = join(root, "link-to-root");
    symlinkSync(root, link);
    assert.equal(
      resolveLocation(join(link, "not", "created", "yet")),
      join(root, "not", "created", "yet"),
    );
    // …and the tail is normalised on the way through.
    assert.equal(
      resolveLocation(join(link, "not", ".", "created", "x", "..", "yet")),
      join(root, "not", "created", "yet"),
    );
  } finally {
    cleanup();
  }
});

test("path-identity: a symbolic link to a FILE resolves to the file", () => {
  const { root, cleanup } = fixture();
  try {
    const file = join(root, "real.txt");
    writeFileSync(file, "x");
    const link = join(root, "link.txt");
    symlinkSync(file, link);
    assert.equal(resolveLocation(link), file);
  } finally {
    cleanup();
  }
});

test("path-identity: ancestry is compared by whole segments, not by string prefix", () => {
  const { root, cleanup } = fixture();
  try {
    for (const name of ["ale", "alex", join("ale", "project")]) mkdirSync(join(root, name), { recursive: true });
    const identity = identityOverlapIndex();
    const ale = resolveLocation(join(root, "ale")), alex = resolveLocation(join(root, "alex")), inside = resolveLocation(join(root, "ale", "project"));
    // The classic off-by-a-separator: `ale` IS a string prefix of `alex` and is not an ancestor of it.
    assert.equal(identity.atOrUnder(alex, ale), false);
    assert.equal(identity.atOrUnder(inside, ale), true);
    assert.equal(identity.atOrUnder(ale, ale), true, "a place is at-or-under itself");
    assert.equal(identity.overlaps(ale, alex), false);
  } finally {
    cleanup();
  }
});

test("path-identity: a place measured while missing is still recognised once created, and a named place (`below`) by its base", () => {
  const { root, cleanup } = fixture();
  try {
    const locator = createPathLocator();
    const home = locator.locate(resolveLocation(root));
    const store = locator.locate(resolveLocation(join(root, ".aws")));
    const named = locator.below(home, [".aws"]);
    assert.deepEqual(store.tail, [".aws"], "measured while missing: anchor + name");
    mkdirSync(join(root, ".aws", "sso"), { recursive: true });
    writeFileSync(join(root, ".aws", "credentials"), "x");
    const credentials = locator.locate(resolveLocation(join(root, ".aws", "credentials")));
    for (const spot of [store, named]) {
      assert.equal(locator.atOrUnder(credentials, spot), true, "a file created later under the missing place is inside it");
      assert.equal(locator.atOrUnder(home, spot), false);
      assert.equal(locator.atOrUnder(spot, home), true, "the home contains it");
    }
    // Deleted and re-created (a new inode): the name under the base still holds.
    rmSync(join(root, ".aws"), { recursive: true });
    mkdirSync(join(root, ".aws"));
    writeFileSync(join(root, ".aws", "config"), "x");
    assert.equal(locator.atOrUnder(locator.locate(resolveLocation(join(root, ".aws", "config"))), named), true);
    // A sibling whose name merely starts the same is not inside.
    mkdirSync(join(root, ".awsx"));
    assert.equal(locator.atOrUnder(locator.locate(resolveLocation(join(root, ".awsx"))), named), false);
  } finally {
    cleanup();
  }
});

test("path-identity: one identity spelling, from bigint stats", () => {
  const { root, cleanup } = fixture();
  try {
    const key = identityKey(statSync(root, { bigint: true }));
    assert.match(key, /^\d+:\d+$/u);
    assert.equal(key, identityKey(statSync(`${root}/.`, { bigint: true })));
  } finally {
    cleanup();
  }
});

test("path-identity: a prefix-named place stands for every entry of its folder that starts with it, created later too", () => {
  const { root, cleanup } = fixture();
  try {
    const locator = createPathLocator();
    const family = locator.below(locator.locate(resolveLocation(root)), ["web.db"], true);
    writeFileSync(join(root, "web.db.pre-v21"), "x");
    for (const name of ["web.db", "web.db-wal", "web.db.pre-v21", "web.db.staging-1-2-ab"]) {
      assert.equal(locator.atOrUnder(locator.locate(resolveLocation(join(root, name))), family), true, name);
    }
    assert.equal(locator.atOrUnder(locator.locate(resolveLocation(join(root, "notes.md"))), family), false);
    assert.equal(locator.atOrUnder(family, locator.locate(resolveLocation(root))), true, "its folder contains it");
    assert.deepEqual(locator.namesUnder(locator.locate(resolveLocation(join(root, "a", "b"))), locator.locate(resolveLocation(root))), ["a", "b"]);
  } finally {
    cleanup();
  }
});

test("path-identity: on a Windows drive a SHORT (8.3) name resolves to the long name with its identity (WSL hosts that have one)", () => {
  // Stat only. `CODEX~1` and `.codex` are one inode on DrvFs (measured); a
  // resolved spelling must never carry the short one, or a comparison by name
  // under a measured base misses it (secd-security 1b).
  const pairs: string[][] = [];
  try {
    for (const user of readdirSync("/mnt/c/Users")) {
      const long = join("/mnt/c/Users", user, ".codex"), short = join("/mnt/c/Users", user, "CODEX~1");
      if (existsSync(long) && existsSync(short) && statSync(long).ino === statSync(short).ino) pairs.push([long, short]);
    }
  } catch { /* no Windows drive */ }
  for (const [long, short] of pairs) {
    assert.equal(resolveLocation(short!), long);
    assert.equal(resolveLocation(join(short!, "auth.json")), join(long!, "auth.json"));
  }
  // Off a Windows drive a `~` name is just a name.
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "BACKUP~1"));
    assert.equal(resolveLocation(join(root, "BACKUP~1")), join(root, "BACKUP~1"));
  } finally {
    cleanup();
  }
});
