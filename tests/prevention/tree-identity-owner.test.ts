// @vitest-environment node
/**
 * THE TREE-IDENTITY OWNER — one module answers "which commit" and "is the
 * tree dirty", and every consumer goes through it.
 *
 * ── THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE ────────────────────────────
 *
 * A report or run record that labels itself with the tree it measured needs
 * two answers: HEAD's sha (from the filesystem) and whether the working tree
 * carried uncommitted work (from `git status --porcelain`). The sha already
 * had one owner — `readRepositoryHeadSha` in
 * `engine/src/shared/run-history.ts`. The dirty half did NOT: the perf
 * profile spawned its own `git status --porcelain` and parsed it inline, a
 * second porcelain spelling beside the merge door's and the engine guard's.
 * Two parsers answering "is the tree dirty" is two answers waiting to drift —
 * one caller's `--porcelain` (untracked excused) against another's
 * `--untracked-files=all` (untracked counted) would report the same tree as
 * both clean and dirty.
 *
 * So dirtiness got its owner beside the sha: `readWorkingTreeDirty` in the
 * same module, and the profile — the consumer that records a tree identity
 * for the freshness gate — reads through it. This guard pins that: the owner
 * holds the only definition, the profile never parses porcelain itself, and
 * the owner's answer is proven against git itself on a scratch repo.
 *
 * Deny-by-default: a NEW consumer that reads tree dirtiness for a recorded
 * measurement is caught by the "no inline porcelain" arm, because it must
 * either import the owner (green) or spell its own porcelain (red).
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { createTempGitRepo } from "../helpers/temp-git-repo.ts";
import { read } from "../helpers/source-scan.ts";
import { measuredTreeMark, mutationRunMark, provisionalFailureMark, readMeasuredSurfaceHash, readMeasuredTree, readRepositoryHeadSha, readTrackedTreeDirty, readWorkingTreeDirty } from "../../engine/src/shared/tree-identity.ts";
import { regeneratedPinRanges, suiteRegeneratedPaths } from "../../engine/src/workflow/hash-binding-registry.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const ROOT = process.cwd();

/** Every tracked source file that could hold a tree-identity consumer. */
function treeIdentitySources(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".git")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const top of ["engine/src", "engine/scripts", "scripts", "tests", "server"]) {
    walk(join(ROOT, top));
  }
  return out;
}

/** Blank comments so a doc-comment naming the function cannot satisfy a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("the tree-identity owner — one module, no second porcelain parser", () => {
  // The tree-identity owner's own module — the only file this guard's scans
  // may legitimately find the definitions in. Computed once so the "exactly
  // one definition" arm cannot be satisfied by this guard's own source.
  const OWNER = modulePath("tree-identity.ts");

  test("readWorkingTreeDirty is DEFINED in exactly ONE module (the shared tree-identity owner)", () => {
    // Scan SOURCE modules only — a guard that names the function in a pattern
    // (this file) is not a definition. The owner's own module is the one
    // legitimate hit; a second definition anywhere else is the drift class.
    const defs = treeIdentitySources().filter((f) => {
      const rel = relative(ROOT, f);
      if (rel.endsWith(".test.ts")) return false; // a guard's pattern is not a definition
      const src = stripComments(read(f));
      return /export function readWorkingTreeDirty\b/.test(src);
    });
    expect(
      defs.map((f) => relative(ROOT, f)),
      "readWorkingTreeDirty must live in exactly one module — a second definition is a second porcelain parser",
    ).toEqual([OWNER]);
  });

  test("a module that derives a recorded tree identity reads dirtiness through the owner, never its own porcelain", () => {
    // The drift class this arm refuses is NARROW and specific: a module that
    // (a) computes a dirty BOOLEAN for a recorded tree identity AND (b) spawns
    // its own `git status --porcelain` to get it. That was the profile before
    // the owner existed. It is NOT every porcelain read — enumerating
    // untracked PATHS (tracked-source-owner's `-z -uall` listing) or refusing
    // to merge over a dirty tree (the merge door's chain-of-custody gate) are
    // different questions with their own owners, and neither derives a dirty
    // boolean for an artifact's identity. The signature is the pairing: a
    // porcelain spawn in the same module as a `dirty:` / `TreeIdentity`
    // record — the artifact-labelling shape.
    const offenders = treeIdentitySources().filter((f) => {
      const rel = relative(ROOT, f);
      if (rel === OWNER || rel.endsWith(".test.ts")) return false;
      const src = stripComments(read(f));
      const spawnsPorcelain = /(?:execFileSync|execSync|spawnSync)\s*\(\s*["']git["']\s*,\s*\[[^\]]*["']status["']\s*,\s*["']--porcelain["']/.test(src);
      if (!spawnsPorcelain) return false;
      const derivesIdentity = /\bdirty\s*:/.test(src) || /\bTreeIdentity\b/.test(src);
      // A consumer that goes through the owner imports it — never an offender.
      const readsThroughOwner = /\breadWorkingTreeDirty\b/.test(src);
      return derivesIdentity && !readsThroughOwner;
    });
    expect(
      offenders.map((f) => relative(ROOT, f)),
      "a module derives a recorded tree identity from its own porcelain spawn instead of reading through the owner",
    ).toEqual([]);
  });

  test("the profile reads EVERY half of the tree identity through the owner (never its own subprocess)", () => {
    const src = stripComments(read("tests/performance/profile.spec.ts"));
    expect(src, "the profile no longer reads the sha through the owner").toMatch(/readRepositoryHeadSha\s*\(/);
    expect(src, "the profile no longer reads the measured surface through the owner").toMatch(
      /readMeasuredSurfaceHash\s*\(/,
    );
    expect(src, "the profile no longer reads dirtiness through the owner").toMatch(/readWorkingTreeDirty\s*\(/);
    expect(
      src,
      "the profile spawns its own git porcelain — the second parser this guard exists to refuse",
    ).not.toMatch(/execFileSync\s*\(\s*["']git["']/);
  });

  test("the surface hash is DEFINED in exactly ONE module and the gate + profile both read it through the owner", () => {
    // The same single-owner pin as the dirty read: one definition, every
    // consumer through it. A second ls-tree parser answering "what is the
    // measured surface's content" is the drift class this arm refuses.
    const defs = treeIdentitySources().filter((f) => {
      const rel = relative(ROOT, f);
      if (rel.endsWith(".test.ts")) return false;
      const src = stripComments(read(f));
      return /export function readMeasuredSurfaceHash\b/.test(src);
    });
    expect(
      defs.map((f) => relative(ROOT, f)),
      "readMeasuredSurfaceHash must live in exactly one module — a second surface derivation is a second answer",
    ).toEqual([OWNER]);
    // The freshness GATE reads the live surface through the owner too — a
    // gate that computed its own hash would be the second parser.
    const gate = stripComments(read("tests/performance/regression.test.ts"));
    expect(gate, "the gate reads the measured surface through the owner").toMatch(/readMeasuredSurfaceHash\s*\(/);
    expect(gate, "the gate spawns its own git ls-tree — a second derivation").not.toMatch(
      /(?:execFileSync|execSync|spawnSync)\s*\(\s*["']git["']/,
    );
  });

  test("the surface hash distinguishes a surface change from a scripts-only commit, and tracks deletions", () => {
    // LIVENESS: the hash must MOVE when a measured path moves and stay PUT
    // when a non-surface path moves — the two directions the gate binds to.
    // Driven on a scratch repo (never the shared clone's .git): a src/ file
    // is the measured surface; a scripts/ file is not.
    const repo = createTempGitRepo("tree-identity-surface-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    mkdirSync(join(scratch, "src"), { recursive: true });
    mkdirSync(join(scratch, "server"), { recursive: true });
    mkdirSync(join(scratch, "scripts"), { recursive: true });
    mkdirSync(join(scratch, "tests"), { recursive: true });
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(scratch, "server", "index.ts"), "export const srv = 1;\n");
    writeFileSync(join(scratch, "scripts", "door.ts"), "export const door = 1;\n");
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch"}\n');
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
    const base = readMeasuredSurfaceHash(scratch);
    expect(base, "the surface hash resolves on a healthy repo").not.toBeNull();
    expect(base, "the surface hash is a sha256").toMatch(/^[0-9a-f]{64}$/);

    // A scripts/-only commit moves HEAD but NOT the surface — the hash stays.
    writeFileSync(join(scratch, "scripts", "door.ts"), "export const door = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "scripts only"]);
    const afterScripts = readMeasuredSurfaceHash(scratch);
    expect(afterScripts, "a scripts-only commit must NOT move the surface hash").toBe(base);
    expect(git(["rev-parse", "HEAD"]), "…yet HEAD really moved").not.toBe(git(["rev-parse", "HEAD~1"]));

    // A src/ commit moves the surface — captured so the deletion below can be
    // shown to be a THIRD distinct value, not the "changed" one.
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 2;\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "src change"]);
    const afterChange = readMeasuredSurfaceHash(scratch);
    expect(afterChange, "a src commit MUST move the surface hash").not.toBe(base);

    // A measured-path DELETION moves it too (ls-tree reflects the removal) —
    // a distinct content, so the hash is the surface's bytes, not a toggle
    // between "changed" and "unchanged".
    git(["rm", "-q", "src/app.ts"]);
    git(["commit", "-q", "-m", "delete the app"]);
    const afterDelete = readMeasuredSurfaceHash(scratch);
    expect(afterDelete, "deleting a measured path MUST move the surface hash").not.toBe(base);
    expect(afterDelete, "…and a deletion is a distinct content, not the changed value").not.toBe(afterChange);
  });

  test("the surface hash reports ABSENCE on a non-repository, never a fabricated hash", () => {
    const notARepo = createTempDir("tree-identity-surface-not-repo-");
    expect(
      readMeasuredSurfaceHash(notARepo),
      "the surface hash on a non-repository must be ABSENT (null), never a guessed content",
    ).toBeNull();
  });

  test("the surface hash binds to the SERVED bytes: a commit of pre-existing dirty work leaves it put, an uncommitted edit moves it immediately", () => {
    // THE MEASURED INSTABILITY this arm closes: the round flow profiles LAST,
    // against a working tree that carries the round's uncommitted work, and
    // the coordinator commits afterwards. A hash bound to HEAD's committed
    // content moved at that commit while every served byte stood still —
    // "profiled against d2b99435 but the repository's surface is now
    // 05cf342f, minutes after a fresh profile, no source change in between".
    // The honest bind is the WORKING TREE (what the dev server serves), so:
    // committing identical bytes must NOT stale a report, and editing a
    // served file must stale it IMMEDIATELY, committed or not (the reverse
    // hole — an uncommitted edit left a HEAD-bound hash put, certifying a
    // report about bytes it never named).
    const repo = createTempGitRepo("tree-identity-surface-served-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch"}\n');
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);

    // Round work lands UNCOMMITTED (the writer's tree), is profiled, then
    // committed. The hash is a function of the bytes, not of git's state.
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 2;\n");
    const dirtyHash = readMeasuredSurfaceHash(scratch);
    expect(dirtyHash, "the hash resolves on a dirty tree").not.toBeNull();
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "the round lands"]);
    expect(
      readMeasuredSurfaceHash(scratch),
      "committing the profiled bytes must NOT move the surface hash — no served byte changed",
    ).toBe(dirtyHash);

    // The false-green hole: an uncommitted edit is a REAL content change.
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 3;\n");
    expect(
      readMeasuredSurfaceHash(scratch),
      "an uncommitted edit to a served file MUST move the surface hash — the measurements changed",
    ).not.toBe(dirtyHash);
  });

  test("a profile run does not change the surface hash (the artifact locations the profile writes are outside the measured population)", () => {
    // The population is deny-by-default: ONLY the declared measured paths are
    // hashed, so every artifact the act of profiling writes is excluded BY
    // CONSTRUCTION — never by a hand-maintained exclusion list that rots the
    // day a new artifact appears. This arm PROVES the construction against
    // the actual write locations, each DERIVED from its owner (no hand list):
    // the profile report (the harness's REPORT_PATH literal), the Playwright
    // run record (the perf config's json reporter outputFile), Playwright's
    // outputDir (the config's declaration, else the upstream default), and
    // the app's data directory (the server config's timeline db default).
    const scratch = createTempDir("tree-identity-surface-artifacts-");
    mkdirSync(join(scratch, "src"), { recursive: true });
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch"}\n');
    const before = readMeasuredSurfaceHash(scratch);
    expect(before).not.toBeNull();

    const reportLiteral = /REPORT_PATH[^=]*=\s*new URL\("([^"]+)"/.exec(
      read("tests/performance/lib/perf-harness.ts"),
    )?.[1];
    expect(reportLiteral, "the harness's REPORT_PATH literal is parseable").toBeDefined();
    const runLiteral = /outputFile:\s*"([^"]+)"/.exec(read("playwright.perf.config.ts"))?.[1];
    expect(runLiteral, "the perf config's json outputFile is parseable").toBeDefined();
    const outputDirLiteral = /outputDir:\s*"([^"]+)"/.exec(read("playwright.perf.config.ts"))?.[1]
      ?? "test-results"; // Playwright's documented default when the config is silent.
    // The server's data-directory owner is a PRODUCT module — resolved by a
    // unique path FRAGMENT through the single owner, never spelled as a full
    // path literal (a move would silently stale this guard). The fragment
    // disambiguates the two config.ts modules under server/.
    const dataDir = /DEFAULT_TIMELINE_DB_PATH = "([^"]+)"/.exec(
      read(modulePathMatching("server/kernel/config.ts")),
    )?.[1];
    expect(dataDir, "the server's default data file path is parseable").toBeDefined();

    const artifactParents = new Set<string>();
    for (const artifact of [
      join("tests/performance/lib", reportLiteral!),
      runLiteral!,
      outputDirLiteral,
      dataDir!,
    ]) {
      // Normalize to the path's parent (the profile writes files under these
      // locations; the parent covers every file the writer produces).
      artifactParents.add(artifact.replace(/\/[^/]*$/u, ""));
    }
    for (const parent of artifactParents) {
      mkdirSync(join(scratch, parent), { recursive: true });
      writeFileSync(join(scratch, parent, "profile-artifact-probe.json"), "{\"written\":\"by the profile run\"}\n");
      writeFileSync(join(scratch, parent, "profile-artifact-probe.db-wal"), "wal bytes a profile leaves\n");
    }
    expect(
      readMeasuredSurfaceHash(scratch),
      "artifacts written at the profile's own output locations must NOT move the surface hash",
    ).toBe(before);

    // The counter-direction: a file under a DECLARED root moves it. This is
    // the arm's witness — an implementation that hashed the whole tree (or
    // forgot the population) would have moved on the artifact writes above;
    // one that hashed nothing would not move here.
    writeFileSync(join(scratch, "src", "app.ts"), "export const app = 2;\n");
    expect(
      readMeasuredSurfaceHash(scratch),
      "a served-source edit MUST move the surface hash",
    ).not.toBe(before);
  });

  test("a pin restatement on a suite-regenerated measured-surface file does not move the surface hash; a non-pin byte in the same file does", () => {
    // THE MEASURED INSTABILITY this arm closes: the close-out convergence
    // re-pins a measured-surface file (the bundle pin in root-policy.ts)
    // AFTER the round's last mint, and the restatement moved the surface
    // hash with it — staling the standing profile report, so every round
    // after a close-out inherited the freshness arm RED on arrival for a
    // change no measurement observed. A regenerated pin literal is a value
    // the suite re-derives from the tree, so the surface derivation hashes
    // such a file with its pins normalized away — the same normalization the
    // cross-branch drift audit uses on the same class, both consuming the
    // one binding-registry derivation. The members driven here are DERIVED
    // from that set, never named: a binding retargeted tomorrow re-drives
    // this arm with no edit, and a hand-list derivation misses it (verified
    // by mutation the round this arm was added).
    const repo = createTempGitRepo("tree-identity-surface-pin-restatement-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    // The regenerated members the surface walk actually hashes: the measured
    // roots are declared paths, and only a member under one is reachable to
    // the walk. Today that is the engine/src root; a member nowhere under a
    // measured root would be dead to this drive, so the population must be
    // non-empty by assertion, not by construction.
    const surfacePins = [...suiteRegeneratedPaths()]
      .filter((path) => path.startsWith("engine/src"))
      .sort();
    expect(
      surfacePins.length,
      "no suite-regenerated member lies under a measured root — the pin-normalization drive went dead",
    ).toBeGreaterThan(0);
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch"}\n');
    // THE CONTENT IS THE REAL FILE, and the pins are the OWNER'S locators
    // (`regeneratedPinRanges`) — never a synthetic `pinned: "a"*64` line. The
    // round-5 narrowing made normalization locator-derived, so a synthetic
    // literal is not a pin at all (nothing locates it), and a guard written
    // against synthetic bytes would either demand blanket normalization again
    // or pass while the real file's pins move. Reading the owner's ranges from
    // the real bytes drives exactly the literals the surface hash strips.
    const surfaceText = new Map<string, string>();
    const surfaceRanges = new Map<string, ReturnType<typeof regeneratedPinRanges>>();
    for (const repoRelative of surfacePins) {
      const text = readFileSync(join(ROOT, repoRelative), "utf8");
      const ranges = regeneratedPinRanges(repoRelative, text);
      expect(
        ranges.length,
        `${repoRelative} lies in the regenerated set but its owners locate no pin in it — the normalization drive would be vacuous`,
      ).toBeGreaterThan(0);
      surfaceText.set(repoRelative, text);
      surfaceRanges.set(repoRelative, ranges);
      const absolute = join(scratch, repoRelative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text);
    }
    const before = readMeasuredSurfaceHash(scratch);
    expect(before, "the surface hash resolves with regenerated members present").not.toBeNull();

    // The convergence restatement: every pin the owner locates moves to a new
    // literal, byte length and everything else identical, judged PER MEMBER so
    // a red names the file whose restatement moved the hash.
    for (const repoRelative of surfacePins) {
      let restated = surfaceText.get(repoRelative)!;
      for (const range of [...surfaceRanges.get(repoRelative)!].sort((left, right) => right.start - left.start)) {
        restated = `${restated.slice(0, range.start)}${"b".repeat(64)}${restated.slice(range.end)}`;
      }
      expect(restated, `${repoRelative}'s restatement must move at least one literal`).not.toBe(surfaceText.get(repoRelative));
      writeFileSync(join(scratch, repoRelative), restated);
      expect(
        readMeasuredSurfaceHash(scratch),
        `a regenerated pin restatement in ${repoRelative} must NOT move the surface hash — the pins are values the suite re-derives`,
      ).toBe(before);
    }

    // The close-out COMMITS the restatement; committing identical content
    // must keep the hash put exactly as the working-tree bind promises.
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "convergence: the pins restated for the merged tree"]);
    expect(
      readMeasuredSurfaceHash(scratch),
      "the committed restatement must not move the surface hash either",
    ).toBe(before);

    // The scoping witness, in the SAME file: a byte outside any pin literal
    // is a hand-authored edit, and normalizing it away would blind the gate.
    // One member suffices — the normalization is per-file, not per-batch.
    const witness = surfacePins[0]!;
    writeFileSync(join(scratch, witness), `${surfaceText.get(witness)!}\n// an authored edit outside every pin\n`);
    expect(
      readMeasuredSurfaceHash(scratch),
      `a non-pin byte in ${witness} MUST move the surface hash — the normalization is pin-scoped, not file-scoped`,
    ).not.toBe(before);
  });

  test("a measured-surface file outside the regenerated set moves the surface hash on a pin-literal change and on an authored byte", () => {
    // The counter-direction of the pin normalization, both faces: the gate
    // must stay LIVE on real changes (a byte in an ordinary measured file),
    // and the normalization must NOT leak outside the regenerated set (a
    // 64-hex literal in an ordinary file is an authored value, not a
    // regenerated pin — normalizing it would silently exempt real edits on
    // the surface). The probe file is asserted to be OUTSIDE the set, so a
    // day the set grows to cover it makes this arm refuse loudly instead of
    // passing vacuously.
    const scratch = createTempDir("tree-identity-surface-pin-leak-");
    const probe = "engine/src/plain-source.ts";
    expect(
      suiteRegeneratedPaths().has(probe),
      `${probe} joined the regenerated set — this arm's probe needs a member that is NOT regenerated`,
    ).toBe(false);
    mkdirSync(dirname(join(scratch, probe)), { recursive: true });
    writeFileSync(join(scratch, probe), `export const digest = "${"a".repeat(64)}";\n`);
    writeFileSync(join(scratch, "package.json"), '{"name":"scratch"}\n');
    const before = readMeasuredSurfaceHash(scratch);
    expect(before, "the surface hash resolves with the probe present").not.toBeNull();

    // A pin-SHAPED literal outside the regenerated set is still real
    // content: the normalization must not touch it.
    writeFileSync(join(scratch, probe), `export const digest = "${"b".repeat(64)}";\n`);
    expect(
      readMeasuredSurfaceHash(scratch),
      "a 64-hex literal outside the regenerated set MUST move the surface hash — the normalization must not leak",
    ).not.toBe(before);

    // And an authored byte in the same file moves it too — the ordinary
    // liveness the freshness gate binds to.
    const afterPin = readMeasuredSurfaceHash(scratch);
    writeFileSync(join(scratch, probe), `export const digest = "${"b".repeat(64)}"; // authored\n`);
    expect(
      readMeasuredSurfaceHash(scratch),
      "an authored byte in an ordinary measured file MUST move the surface hash",
    ).not.toBe(afterPin);
  });

  test("the owner's dirty answer is PROVEN against git itself on a scratch repo", () => {
    // Liveness: the owner must agree with git in both directions, not merely
    // return a constant. A scratch repo is driven clean → dirty (untracked) →
    // dirty (tracked-modified) → clean, and the owner's answer must track
    // each transition.
    const repo = createTempGitRepo("tree-identity-owner-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    writeFileSync(join(scratch, "seed.txt"), "seed\n");
    git(["add", "seed.txt"]);
    git(["commit", "-q", "-m", "seed"]);

    expect(readWorkingTreeDirty(scratch), "a clean scratch repo must read clean").toBe(false);
    // The sha half agrees with git too — both answers come from one owner.
    expect(readRepositoryHeadSha(scratch), "the sha half must resolve on a healthy repo").toBe(
      git(["rev-parse", "HEAD"]),
    );

    // Untracked scratch file dirties the tree (the strict question).
    writeFileSync(join(scratch, "scratch.txt"), "scratch\n");
    expect(readWorkingTreeDirty(scratch), "an untracked file must read dirty").toBe(true);

    // A tracked modification dirties it.
    writeFileSync(join(scratch, "seed.txt"), "seed\nchanged\n");
    expect(readWorkingTreeDirty(scratch), "a tracked modification must read dirty").toBe(true);

    // Restoring the bytes returns it to clean.
    git(["checkout", "-q", "--", "seed.txt"]);
    execFileSync("rm", [join(scratch, "scratch.txt")]);
    expect(readWorkingTreeDirty(scratch), "restoring the bytes must read clean again").toBe(false);
  });

  test("the HEAD is found the way git finds it: from a folder BELOW the work tree's root (the engine runner's own root) and in a linked worktree", () => {
    // The engine runner asks from `<repo>/engine`: reading `<engine>/.git`
    // alone answered null, so no engine ledger row ever carried its HEAD
    // (WF-1b3c: a workspace's baseline of the target was never found).
    const repo = createTempGitRepo("tree-identity-nested-", { initialBranch: "master" });
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    mkdirSync(join(repo.dir, "engine", "src"), { recursive: true });
    writeFileSync(join(repo.dir, "engine", "src", "seed.txt"), "seed\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed"]);
    const head = git(["rev-parse", "HEAD"]);
    expect(readRepositoryHeadSha(join(repo.dir, "engine")), "from the engine root").toBe(head);
    expect(readRepositoryHeadSha(join(repo.dir, "engine", "src")), "from any folder of the work tree").toBe(head);
    const worktree = join(createTempDir("tree-identity-worktree-"), "linked");
    git(["worktree", "add", "-q", "--detach", worktree, "HEAD"]);
    expect(readRepositoryHeadSha(join(worktree, "engine")), "from a linked worktree's subfolder (its .git is a file)").toBe(head);
  });

  test("HEAD lookup refuses non-directory inputs inside a real repository", () => {
    const repo = createTempGitRepo("tree-identity-invalid-directory-", { initialBranch: "master" });
    mkdirSync(join(repo.dir, "engine", "nested"), { recursive: true });
    writeFileSync(join(repo.dir, "seed.txt"), "seed\n");
    repo.git("add", "seed.txt");
    repo.git("commit", "-q", "-m", "seed");
    const head = repo.git("rev-parse", "HEAD").trim();
    const index = readFileSync(join(repo.dir, ".git", "index"));
    const objects = repo.git("count-objects", "-v");
    expect(readRepositoryHeadSha(repo.dir)).toBe(head);
    expect(readRepositoryHeadSha(join(repo.dir, "engine", "nested")), "a valid child directory still discovers the ancestor repository").toBe(head);
    const invalid = ["seed.txt", "seed.txt/child", "missing/child"];
    const readings = invalid.map((path) => {
      const input = join(repo.dir, path);
      let failure: unknown;
      try {
        execFileSync("git", ["-C", input, "rev-parse", "HEAD"], { stdio: "pipe", env: { ...process.env, LC_ALL: "C" } });
      } catch (error) { failure = error; }
      const reason = path === "missing/child" ? "No such file or directory" : "Not a directory";
      expect(failure, `Git must launch and refuse exactly this invalid directory: ${path}`).toMatchObject({
        pid: expect.any(Number), status: 128, signal: null, stdout: Buffer.alloc(0),
        stderr: Buffer.from(`fatal: cannot change to '${input}': ${reason}\n`),
      });
      return { path, head: readRepositoryHeadSha(input) };
    });
    expect(readings, "a file, an impossible descendant and a missing directory must never borrow an ancestor HEAD")
      .toEqual(invalid.map((path) => ({ path, head: null })));
    expect(readFileSync(join(repo.dir, ".git", "index"))).toEqual(index);
    expect(repo.git("count-objects", "-v")).toBe(objects);
  });

  test("the measured tree (`readMeasuredTree` at the start, `measuredTreeMark` at the end) is the tree `git add -A` would commit — HEAD's tree when clean, the dirty tree's own id otherwise — and nothing a reader sees is written", () => {
    const repo = createTempGitRepo("tree-identity-measured-", { initialBranch: "master" });
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    writeFileSync(join(repo.dir, "seed.txt"), "seed\n");
    git(["add", "seed.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    const clean = readMeasuredTree(repo.dir);
    expect(clean).toBe(git(["rev-parse", "HEAD^{tree}"]));
    expect(measuredTreeMark(repo.dir, clean)).toEqual({ treeId: clean });
    // A tracked edit and an untracked file: the id is exactly the tree a commit of them holds.
    writeFileSync(join(repo.dir, "seed.txt"), "seed\nchanged\n");
    writeFileSync(join(repo.dir, "new.txt"), "new\n");
    const index = readFileSync(join(repo.dir, ".git", "index"));
    const objects = git(["count-objects", "-v"]);
    const measured = readMeasuredTree(repo.dir);
    expect(readFileSync(join(repo.dir, ".git", "index")).equals(index), "the real index is untouched").toBe(true);
    expect(git(["count-objects", "-v"]), "the store gains nothing").toBe(objects);
    expect(measuredTreeMark(repo.dir, clean), "a tree that CHANGED during the run is no tree the run measured (WF-1b3c-FIX MED-1)").toEqual({});
    expect(measuredTreeMark(repo.dir, null), "an unread start names nothing").toEqual({});
    git(["add", "-A"]);
    expect(measuredTreeMark(repo.dir, measured)).toEqual({ treeId: git(["write-tree"]) });
    // An unreadable tree is ABSENT, never a fabricated id.
    expect(readMeasuredTree(createTempDir("tree-identity-measured-not-repo-"))).toBeNull();
  });

  test("the measured tree is the WHOLE repository's, asked from any folder of it (the engine runner asks from the engine root): an unstaged edit and an untracked file OUTSIDE that folder are in it (WF-1b3c-FIX N1)", () => {
    const repo = createTempGitRepo("tree-identity-measured-sub-", { initialBranch: "master" });
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    mkdirSync(join(repo.dir, "engine"), { recursive: true });
    mkdirSync(join(repo.dir, "docs"), { recursive: true });
    writeFileSync(join(repo.dir, "engine", "e.txt"), "engine\n");
    writeFileSync(join(repo.dir, "docs", "b.md"), "doc\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed"]);
    writeFileSync(join(repo.dir, "docs", "b.md"), "doc\nedited\n");
    writeFileSync(join(repo.dir, "docs", "new.md"), "new\n");
    writeFileSync(join(repo.dir, "engine", "e.txt"), "engine\nedited\n");
    const fromEngine = readMeasuredTree(join(repo.dir, "engine"));
    expect(fromEngine, "from the engine folder = from the top").toBe(readMeasuredTree(repo.dir));
    git(["add", "-A"]);
    expect(fromEngine, "= what `git add -A` would commit").toBe(git(["write-tree"]));
  });

  test("a linked worktree whose `.git` names its git dir RELATIVELY is resolved against the worktree (WF-1b3c-FIX N4/M5)", () => {
    const repo = createTempGitRepo("tree-identity-relative-gitdir-", { initialBranch: "master" });
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    writeFileSync(join(repo.dir, "seed.txt"), "seed\n");
    git(["add", "seed.txt"]);
    git(["commit", "-q", "-m", "seed"]);
    const worktree = join(repo.dir, "linked");
    git(["worktree", "add", "-q", "--detach", worktree, "HEAD"]);
    const pointer = readFileSync(join(worktree, ".git"), "utf8").slice("gitdir:".length).trim();
    writeFileSync(join(worktree, ".git"), `gitdir: ${relative(worktree, pointer)}\n`);
    expect(readRepositoryHeadSha(worktree)).toBe(git(["rev-parse", "HEAD"]));
  });

  test("the owner reports ABSENCE, never a fabricated clean, on a non-repository", () => {
    const notARepo = createTempDir("tree-identity-not-repo-");
    expect(
      readWorkingTreeDirty(notARepo),
      "dirtiness on a non-repository must be ABSENT (null), never a guessed clean",
    ).toBeNull();
    expect(
      readTrackedTreeDirty(notARepo),
      "tracked dirtiness on a non-repository must be ABSENT (null), never a guessed clean",
    ).toBeNull();
    expect(readRepositoryHeadSha(notARepo), "the sha on a non-repository must be ABSENT").toBeNull();
    // A folder that cannot be searched (EACCES) is absence too, never a throw (WF-1b3c-FIX N7).
    const locked = join(notARepo, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(readRepositoryHeadSha(join(locked, "inner")), "an unsearchable path must be ABSENT").toBeNull();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("the tracked-width read counts committed-source edits and ignores untracked noise — proven against git itself", () => {
    // Liveness for the ledger's provisional judgement: the tracked width must
    // answer "is the COMMITTED SOURCE being edited", which is a different
    // question from the strict width's "is anything here HEAD does not know".
    // Driven on a scratch repo (never the shared clone's .git).
    const repo = createTempGitRepo("tree-identity-tracked-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    writeFileSync(join(scratch, "seed.txt"), "seed\n");
    writeFileSync(join(scratch, ".gitignore"), "cache/\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);

    expect(readTrackedTreeDirty(scratch), "a clean scratch repo must read tracked-clean").toBe(false);

    // Untracked scratch is NOT an edit of the committed source — the strict
    // width says dirty, the tracked width must say clean.
    writeFileSync(join(scratch, "notes.txt"), "scratch notes\n");
    expect(readWorkingTreeDirty(scratch), "the strict width counts untracked files").toBe(true);
    expect(readTrackedTreeDirty(scratch), "an untracked file is not a work-in-progress edit").toBe(false);

    // A gitignored generated artifact is the same class — present on disk,
    // invisible to the tracked question.
    mkdirSync(join(scratch, "cache"), { recursive: true });
    writeFileSync(join(scratch, "cache", "report.json"), "{}\n");
    expect(readTrackedTreeDirty(scratch), "a gitignored artifact is not a work-in-progress edit").toBe(false);

    // A tracked modification IS the committed source being edited.
    writeFileSync(join(scratch, "seed.txt"), "seed\nchanged\n");
    expect(readTrackedTreeDirty(scratch), "a tracked modification must read tracked-dirty").toBe(true);

    // …and so is a STAGED-only change (worktree bytes restored, edit still
    // in the index) — both halves of "the commit would carry this".
    git(["add", "seed.txt"]);
    git(["checkout", "-q", "--", "seed.txt"]);
    expect(readTrackedTreeDirty(scratch), "a staged-only edit must read tracked-dirty").toBe(true);

    // Committing the edit returns the tracked width to clean.
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "the edit lands"]);
    expect(readTrackedTreeDirty(scratch), "once committed, the tree reads tracked-clean again").toBe(false);
    execFileSync("rm", [join(scratch, "notes.txt")]);
  });

  test("the provisional mark FIRES on a tracked-dirty tree and stays empty on a clean one — the output, not only the call", () => {
    // LIVENESS for the marking half, driven at the derivation a real caller
    // (both runners) spreads: the wiring arm proves the runners CALL
    // `provisionalFailureMark`, but only THIS arm proves the mark's OUTPUT
    // changes with the tree — the witness a gutted-to-`{}` derivation cannot
    // fake. Driven on a scratch repo (never the shared clone's .git).
    const repo = createTempGitRepo("tree-identity-mark-", { initialBranch: "master" });
    const scratch = repo.dir;
    const git = (args: readonly string[]): string => repo.git(...args).trim();
    writeFileSync(join(scratch, "seed.txt"), "seed\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);

    expect(provisionalFailureMark(scratch), "a clean tree marks nothing").toEqual({});
    writeFileSync(join(scratch, "seed.txt"), "seed\nchanged\n");
    expect(provisionalFailureMark(scratch), "a tracked-dirty tree marks its failure rows provisional").toEqual({
      provisionalFailures: true,
    });
    // Untracked noise does NOT fire the mark (the tracked-width question).
    git(["checkout", "-q", "--", "seed.txt"]);
    writeFileSync(join(scratch, "scratch.txt"), "scratch\n");
    expect(provisionalFailureMark(scratch), "an untracked file alone never marks the run provisional").toEqual({});
  });

  test("the provisional marker has ONE derivation, and both judged-run append sites spread it through the door", () => {
    // The whole class this guard exists for: a judged run taken on a
    // mid-edit tree must not pollute the flaky-test memory's baseline. The
    // mark is derived ONCE — `provisionalFailureMark` in the owner — and
    // every append site SPREADS that derivation. A runner that skips it, or
    // spells its own porcelain / its own `provisionalFailures:` literal,
    // re-arms the pollution (and, for the ledger owner, a porcelain spelling
    // would drag the subprocess one hop from the server — the confinement
    // escape the boundary exists to refuse).
    const defs = treeIdentitySources().filter((f) => {
      const rel = relative(ROOT, f);
      if (rel.endsWith(".test.ts")) return false;
      const src = stripComments(read(f));
      return /export function provisionalFailureMark\b/.test(src);
    });
    expect(
      defs.map((f) => relative(ROOT, f)),
      "provisionalFailureMark must be DEFINED in exactly one module — a second derivation is a second dirty judgement",
    ).toEqual([OWNER]);

    // The ledger owner holds NO spelling of the porcelain judgement — it is
    // server-reachable, so the mark must ARRIVE in its records, never be
    // derived there.
    const ledger = stripComments(read(modulePath("run-history.ts")));
    expect(
      ledger,
      "the ledger owner derives the dirty judgement itself — the porcelain spawn would sit one hop from the server",
    ).not.toMatch(/tree-identity|execFileSync|child_process/);

    // Both runners derive the mark through the ONE spelling and spread it
    // into the record they append. The engine runner imports the owner
    // directly; the web reporter rides the ledger's web binding (one door).
    const engineRunner = stripComments(read(modulePath("run-tests.ts")));
    expect(engineRunner, "the engine runner no longer derives the provisional mark through the owner").toMatch(
      /\bprovisionalFailureMark\s*\(/,
    );
    const webReporter = stripComments(read("tests/reporters/budget-reporter.ts"));
    expect(webReporter, "the web reporter no longer derives the provisional mark through the door").toMatch(
      /\bprovisionalFailureMark\s*\(/,
    );
    // Neither runner spells the field as a runtime literal — the mark is the
    // derivation's output, spread into the record, never a hand-written
    // `{ …, provisionalFailures: true, … }`. The engine runner DOES declare
    // the mark's TYPE (`provisional: Readonly<{ provisionalFailures: true }>`),
    // which is a type annotation, not a runtime flag — so the scan strips
    // type positions before looking for a hand-written literal.
    const stripTypes = (s: string): string => s.replace(/Readonly<\{[^}]*\}>/g, " ");
    const handWrittenFlag = /[{,]\s*provisionalFailures\s*:\s*true\b/;
    for (const [name, src] of [
      [modulePath("run-tests.ts"), engineRunner],
      ["tests/reporters/budget-reporter.ts", webReporter],
    ] as const) {
      expect(
        stripTypes(src),
        `${name} hand-writes the provisional flag instead of spreading the derivation`,
      ).not.toMatch(handWrittenFlag);
    }
    // The web binding is the reporter's door: it must re-export the mark so
    // the reporter never imports the subprocess-owning module across the
    // ledger's server-reachable boundary.
    const binding = stripComments(read("tests/helpers/budget-history.ts"));
    expect(binding, "the web binding must re-export the provisional mark as the reporter's door").toMatch(
      /provisionalFailureMark/,
    );
  });

  test("the deliberate-mutation mark FIRES on the launch flag and stays empty without it — the output, not only the call", () => {
    // LIVENESS for the mutation marking half, sibling of the provisional
    // arm above: the wiring arm proves the runners CALL `mutationRunMark`,
    // only THIS arm proves the mark's OUTPUT changes with the launch
    // environment — the witness a gutted-to-`{}` derivation cannot fake.
    // The channel is the environment the OPERATOR controls (the agent
    // plants a defect and runs the owning suite with the flag set), so the
    // drive is over an explicit env, never a mutation of the live one.
    expect(mutationRunMark({}), "an ordinary launch marks nothing").toEqual({});
    expect(mutationRunMark({ HARNESS_MUTATION_RUN: "0" }), "a refused flag value marks nothing").toEqual({});
    expect(mutationRunMark({ HARNESS_MUTATION_RUN: "yes" }), "only the declared spelling arms the marker").toEqual({});
    expect(mutationRunMark({ HARNESS_MUTATION_RUN: "1" }), "the verification launch marks its run").toEqual({
      mutationRun: true,
    });
  });

  test("the deliberate-mutation marker has ONE derivation, and both judged-run append sites spread it through the door", () => {
    // The same shape as the provisional wiring arm beside it: the mark is
    // derived ONCE — `mutationRunMark` in the tree-identity owner — and
    // every append site SPREADS that derivation. A runner that skips it, or
    // spells its own `mutationRun: true` literal, re-arms the pollution the
    // marker exists to prevent: a deliberate verification red read as the
    // suite's flakiness (the standing 2026-08-24 suspect was exactly that).
    const defs = treeIdentitySources().filter((f) => {
      const rel = relative(ROOT, f);
      if (rel.endsWith(".test.ts")) return false;
      const src = stripComments(read(f));
      return /export function mutationRunMark\b/.test(src);
    });
    expect(
      defs.map((f) => relative(ROOT, f)),
      "mutationRunMark must be DEFINED in exactly one module — a second derivation is a second spelling of the operator's intent",
    ).toEqual([OWNER]);

    const engineRunner = stripComments(read(modulePath("run-tests.ts")));
    expect(engineRunner, "the engine runner no longer spreads the deliberate-mutation mark").toMatch(
      /\bmutationRunMark\s*\(\)/,
    );
    const webReporter = stripComments(read("tests/reporters/budget-reporter.ts"));
    expect(webReporter, "the web reporter no longer spreads the deliberate-mutation mark").toMatch(
      /\bmutationRunMark\s*\(\)/,
    );
    // Neither runner spells the field as a runtime literal — the mark is
    // the derivation's output, spread into the record, never a hand-written
    // `{ …, mutationRun: true, … }`.
    const handWrittenFlag = /[{,]\s*mutationRun\s*:\s*true\b/;
    for (const [name, src] of [
      [modulePath("run-tests.ts"), engineRunner],
      ["tests/reporters/budget-reporter.ts", webReporter],
    ] as const) {
      expect(
        src,
        `${name} hand-writes the mutation flag instead of spreading the derivation`,
      ).not.toMatch(handWrittenFlag);
    }
    // The web binding is the reporter's door, same as the provisional mark's.
    const binding = stripComments(read("tests/helpers/budget-history.ts"));
    expect(binding, "the web binding must re-export the mutation mark as the reporter's door").toMatch(
      /mutationRunMark/,
    );
  });
});
