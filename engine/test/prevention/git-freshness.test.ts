import { describe, test } from "node:test";
import { execSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

function gitStatusShort(): string {
  return execSync("git status --short", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10000,
  }).trimEnd();
}

// A short-format porcelain entry means uncommitted work unless it is one of
// the two classes that never carry any: `??` (untracked) and `!!` (ignored).
// Declared once so the guard and its own class-boundary check judge the
// spelling the same way instead of drifting into two answers.
const meansUncommittedWork = (line: string): boolean =>
  !line.startsWith("??") && !line.startsWith("!!");

describe("Git freshness (commit after each round so git stays a reliable restore source)", () => {
  test("the working tree matches the committed state (no stale index)", () => {
    const status = gitStatusShort();
    // Short-format porcelain marks each entry with a two-column XY code:
    // column X is the state staged into the index, column Y is the state of
    // the working tree. Uncommitted work is present when EITHER column names
    // a real change, and the only entries that never mean uncommitted work
    // are `??` (untracked) and `!!` (ignored). A filter that looks only for
    // worktree-side spellings such as " M" misses everything `git add` has
    // already staged — "M ", "A ", "AM", "R ", "D " sit in the first column
    // and leave `git status` looking exactly like a clean tree that is not
    // one. Judging the entry kind instead of memorizing prefix spellings
    // covers every staged state, including ones this tree has not met yet.
    const stale = status
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter(meansUncommittedWork);
    assert.equal(
      stale.length,
      0,
      `Git index is stale — ${stale.length} tracked file(s) are modified but not committed ` +
        `(staged or unstaged). The coordinator commits the working tree after each ` +
        `round, because git checkout/restore/reset --hard only ever restores the committed ` +
        `state and a stale index means those commands destroy the uncommitted rest. ` +
        `Commit now:\n  ` +
        stale.slice(0, 20).join("\n  "),
    );
  });

  test("every status entry that is neither untracked nor ignored is uncommitted work", () => {
    // The classifier above sees status as KINDS, not spellings: the two
    // classes it admits (untracked, ignored) are the only ones with nothing
    // staged or modified, and everything else — staged-only, worktree-only,
    // both — must be counted. This asserts the class boundary itself on
    // representative spellings, so a future edit to the filter cannot
    // quietly re-narrow it to worktree-side entries while the stale arm
    // keeps passing on an empty tree.
    const statuses = [
      { line: "?? notes.txt", verdict: false }, // untracked: new work, acceptable
      { line: "!! cache.bin", verdict: false }, // ignored: no opinion, acceptable
      { line: " M tracked.ts", verdict: true }, // worktree-modified, unstaged
      { line: "M  tracked.ts", verdict: true }, // staged-modified, the miss this repairs
      { line: "MM tracked.ts", verdict: true }, // staged AND worktree-modified
      { line: "A  added.ts", verdict: true }, // staged-new
      { line: "AM added.ts", verdict: true }, // staged-new then edited
      { line: " D tracked.ts", verdict: true }, // worktree-deleted
      { line: "D  tracked.ts", verdict: true }, // staged-deleted
      { line: "R  old.ts -> new.ts", verdict: true }, // staged-rename
    ];
    for (const { line, verdict } of statuses) {
      assert.equal(
        meansUncommittedWork(line),
        verdict,
        `the classifier reads ${JSON.stringify(line)} as ${verdict ? "uncommitted work" : "freshness-free"} — ` +
          `any other answer re-opens the staged-vs-unstaged confusion`,
      );
    }
  });

  test("the stale-index arm sees staged-but-uncommitted work, planted in a scratch repo", () => {
    // The classifier is proven above on spellings; this plant proves the
    // verdict against git itself. A scratch repo is driven to the only shape
    // the arm was blind to — a file modified and `git add`ed but never
    // committed — and the arm's own classifier must count that entry as
    // uncommitted work. It must also count nothing once the entry is
    // un-staged, so the plant exercises the boundary in both directions
    // rather than asserting the presence of a flag.
    const scratch = createTempDir("git-freshness-staged-");
    const git = (args: string) =>
      execSync(`git ${args}`, { cwd: scratch, encoding: "utf8" }).trim();
    const staleCount = () =>
      git("status --short")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .filter(meansUncommittedWork).length;
    git('init -q -b master');
    git('config user.email plant@example.invalid');
    git('config user.name plant');
    writeFileSync(join(scratch, "seed.txt"), "seed\n");
    git('add seed.txt');
    git('commit -q -m seed');
    assert.equal(staleCount(), 0, "a clean scratch repo must read fresh");

    // The plant: modify and STAGE, but do not commit.
    writeFileSync(join(scratch, "seed.txt"), "seed\nstaged change\n");
    git('add seed.txt');
    assert.equal(
      git("status --short").startsWith("M  "),
      true,
      `the plant must produce a staged-only entry; short status was: ${JSON.stringify(git("status --short"))}`,
    );
    assert.equal(
      staleCount(),
      1,
      "a file staged but not committed is uncommitted work — the stale-index arm must not be blind to the first status column",
    );

    // And the other direction: undo the staging, restore the bytes, and the
    // arm reads fresh again — a verdict that only ever red flags nothing.
    git('reset -q HEAD -- seed.txt');
    git('checkout -q -- seed.txt');
    assert.equal(staleCount(), 0, "restoring the staged bytes must read fresh again");
  });

  test("the HEAD commit exists (git is initialized + has history)", () => {
    const head = execSync("git rev-parse --short HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    assert.match(head, /^[0-9a-f]{7,}$/, `HEAD commit should be a short SHA, got: ${head}`);
  });
});

/**
 * THE HALF OF "THE WORKING TREE MATCHES THE COMMITTED STATE" THAT
 * `git status` CANNOT SEE.
 *
 * Git records exactly one permission bit — the executable one — so a tracked
 * file's mode can change on disk and every check above stays green. It did:
 * 53 tracked files sat at 0600 against 100644 in the index, including
 * `bridlewise.config.json`, the single source of truth for configuration.
 * The cause was the atomic writer, whose rename replaces the inode and
 * therefore installs the temp file's private mode over the target's; the fix
 * lives at that writer, and this is the check that would have named it.
 *
 * POPULATION, re-derived on every run and never listed: every regular file in
 * `git ls-files -s`, compared against `lstat`. The expected mode is not a
 * constant either — it is the MAJORITY disk mode among tracked non-executable
 * files, so a machine with a different umask judges itself by its own tree
 * instead of failing against a number written on another one. What is
 * asserted is agreement, and the floor below makes a universe that collapsed
 * to nothing fail rather than certify a clean tree.
 */
describe("tracked files keep the permissions the rest of the tree has", () => {
  test("no tracked file has drifted away from the tree's own file mode", () => {
    const listing = execSync("git ls-files -s", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: 30000,
    });

    const tracked: { path: string; indexMode: string; diskMode: number }[] = [];
    for (const line of listing.split("\n")) {
      const m = /^(\d{6}) [0-9a-f]+ \d+\t(.*)$/.exec(line);
      if (m === null) continue;
      let stat;
      try {
        stat = lstatSync(`${REPO_ROOT}${m[2]}`);
      } catch {
        continue; // deleted in the working tree — the check above owns that
      }
      if (!stat.isFile()) continue;
      tracked.push({ path: m[2]!, indexMode: m[1]!, diskMode: stat.mode & 0o7777 });
    }

    // LIVENESS: a listing that came back empty must fail rather than pass.
    assert.ok(
      tracked.length > 500,
      `only ${tracked.length} tracked files were read — the scan lost its universe and cannot certify anything`,
    );

    const nonExec = tracked.filter((f) => f.indexMode === "100644");
    assert.ok(nonExec.length > 500, `only ${nonExec.length} non-executable tracked files found`);

    // THE RULE IS THE FLOOR THE DEFECT BROKE, NOT THE MAJORITY.
    //
    // A majority vote was tried and rejected: this tree carries two umasks'
    // worth of history (0644 and 0664 among tracked files), so "agree with the
    // most common mode" would fail on 341 files that no writer touched and
    // that are committed exactly as they are. Judging by a popularity contest
    // would make this guard red on arrival and then be silenced, which is how
    // a guard becomes a comment.
    //
    // What the writer actually destroyed is GROUP READABILITY: it took files
    // to 0600, owner-only, so anything running as another member of the group
    // — a second checkout, a service account, a container user — stopped being
    // able to read tracked source, and nothing said so. That is an absolute
    // property with a real consequence, so it is asserted absolutely.
    // THE ONE FILE WHOSE MODE IS REQUIRED TO BE OWNER-ONLY, and it is not an
    // exemption written as prose — it is a positive assertion below. The
    // configuration document is refused by the config reader itself unless it
    // is exactly the private mode, so a check demanding the opposite here
    // would be two owners disagreeing about one fact. Its NAME comes from the
    // root policy, the same declaration the reader uses, so a rename moves
    // both together. (An earlier audit counted this file among the drifted
    // ones; it was never drift. Chmodding it "back" to 0664 stopped the
    // suite from running at all, which is the enforcement working.)
    const configBasename = ROOT_POLICY.configuration.basename;
    const configFile = nonExec.find((f) => f.path === configBasename);
    assert.ok(configFile !== undefined, `${configBasename} is not tracked — the exemption below has no subject`);
    assert.equal(
      configFile.diskMode & 0o077,
      0,
      `${configBasename} must stay owner-only: the config reader refuses any other mode, and the suite cannot run without it`,
    );

    const unreadable = nonExec
      .filter((f) => f.path !== configBasename)
      .filter((f) => (f.diskMode & 0o040) === 0)
      .map((f) => `${f.path} ${f.diskMode.toString(8)}`);

    assert.deepEqual(
      unreadable,
      [],
      `${unreadable.length} tracked file(s) are no longer group-readable. ` +
        "git records only the executable bit, so `git status` reports a clean tree while this is true. " +
        "The usual cause is a writer that renames a private temp file over its target — fix it at the writer, " +
        "because re-chmodding a list of files leaves the next write to do it again.\n  " +
        unreadable.slice(0, 20).join("\n  "),
    );

    // The detector is awake: it can see the mode it is looking for when that
    // mode is present. Supplied as a value rather than as a file, so nothing
    // in this tree has to be broken for the check to be proven live.
    assert.equal((0o600 & 0o040) === 0, true, "the group-readable test does not recognise an owner-only mode");
    assert.equal((0o644 & 0o040) === 0, false, "the group-readable test rejects a mode it should accept");
  });
});
