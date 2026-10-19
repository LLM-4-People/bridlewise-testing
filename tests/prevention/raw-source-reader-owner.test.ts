// @vitest-environment node
/**
 * THE GUARD-OF-GUARDS: NOBODY MATCHES RAW SOURCE BYTES WITHOUT SAYING WHY.
 *
 * ── THE HALF THIS IS ──────────────────────────────────────────────────────
 *
 * `source-view.ts` is the first half and says so in its own last paragraph:
 *
 *   > A type closes the door a caller would otherwise walk through by habit;
 *   > only a guard-of-guards over the byte-reading callers can refuse the ones
 *   > that walk around it. Either half alone is a door with a corridor beside
 *   > it, and this file is the first half.
 *
 * A brand cannot refuse a caller that never names the branded type. So the
 * rule lives in `raw-source-readers.ts` and this file drives it over BOTH real
 * trees, and plants violations from OUTSIDE the owner — into temp files and
 * into strings, never into a tracked source file, because two guards once chose
 * the same real module as a canary, ran in parallel forks, and left it at zero
 * bytes (§28a).
 *
 * ── WHAT WOULD MAKE THE CLASS IMPOSSIBLE, AND WHY THIS IS RUNG 4 ─────────
 *
 * Rung 1–2 are unavailable for a specific mechanical reason and not for a
 * budgetary one: `readFileSync` is a Node built-in returning `string`, and
 * TypeScript cannot make a built-in's return type unassignable in one
 * repository. Rung 3 is unavailable because the bad call takes no argument the
 * compiler could demand — `readFileSync(p, "utf8").includes(x)` is
 * well-typed by construction. What IS available is a runtime choke point over
 * the enumerating callers, plus deny-by-default, which is what this is.
 *
 * ── THE INERT PLANTS ARE THE POINT ────────────────────────────────────────
 *
 * Every test below that asserts something is DETECTED has a sibling asserting
 * a near-identical shape is NOT. A detector that fires on everything is a
 * detector that has told you nothing, and the migration target — a file that
 * reads through `readSourceView` and matches `view.code()` — MUST leave the
 * universe, or migrating a scanner would not be visible to this guard at all
 * and the debt count could never fall.
 */
import { describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGITIMATE_RAW_READERS,
  UNMIGRATED_SCANNERS,
  allowedKeys,
  allowlistVerdict,
  classifyRawSourceMatcher,
  isGuardedUniverse,
  rawReaderFailure,
  readerKey,
  scanForRawSourceMatchers,
  type ScanRoot,
} from "../../engine/scripts/tooling/verification/raw-source-readers.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const WEB_ROOT = process.cwd();
const INTEGRATION_ROOT = join(WEB_ROOT, "engine");

/**
 * The two trees. Identical to the roots `consumer-plants.ts` walks, and
 * deliberately so: the universe a §28 receipt covers and the universe this
 * guard refuses from must be the same universe, or one of them is answering
 * about a tree the other cannot see.
 *
 * THE ORDER IS NOW LOAD-BEARING, AND IT WAS NOT BEFORE. Until the monorepo
 * assembly these were sibling checkouts with disjoint absolute prefixes, so
 * `keyOf` could test them in any order. `engine/` is INSIDE `WEB_ROOT` now, so
 * every engine path also starts with the web prefix — the more specific root
 * must be tried FIRST or the whole engine tree would be keyed `web:engine/…`
 * and every one of the 112 `integration:` records would read as unlisted.
 * This is §38 itself: a path is not a partition until it names its root, and
 * with one root nested in the other, naming means matching in nesting order.
 */
const ROOTS: readonly ScanRoot[] = [
  { name: "integration", root: INTEGRATION_ROOT, sources: ["src", "test", "scripts"] },
  { name: "web", root: WEB_ROOT, sources: ["src", "server", "shared", "tests", "scripts"] },
];

/** The allowlist key of a scanned path, derived the way the records spell it. */
function keyOf(path: string): string {
  for (const scanRoot of ROOTS) {
    const prefix = `${scanRoot.root}/`;
    if (path.startsWith(prefix)) return readerKey(scanRoot.name, path.slice(prefix.length));
  }
  // A found file outside every root is not a naming problem, it is the walk
  // having left its own universe. Surfacing the raw path makes that legible
  // rather than silently producing a key that matches nothing.
  return `UNROOTED:${path}`;
}

/**
 * Assemble a plant. The refused shapes are BUILT AT RUN TIME from fragments so
 * this file's own bytes never contain them: this file sits inside the tree the
 * real-tree test below scans, and a guard whose fixtures join the population it
 * measures is the defect four agents in a row have shipped while writing the
 * guard about it.
 */
const READ = ["read", "File", "Sync"].join("");
const ENUMERATE = ["read", "dir", "Sync"].join("");

function plant(lines: readonly string[]): ReturnType<typeof classifyRawSourceMatcher> {
  return classifyRawSourceMatcher(sourceViewOf(lines.join("\n") + "\n", "plant.ts"));
}

describe("the guard-of-guards refuses an unlisted raw source matcher", () => {
  test("a file that reads bytes, matches them and enumerates the tree is IN the universe", () => {
    const found = plant([
      `import { ${READ}, ${ENUMERATE} } from "node:fs";`,
      `for (const name of ${ENUMERATE}("src")) {`,
      `  const source = ${READ}(name, "utf8");`,
      `  if (source.includes("allowedProjectRoots")) report(name);`,
      "}",
    ]);
    expect(found, "the plant reads bytes, so it is at least classified").not.toBeNull();
    expect(isGuardedUniverse(found!)).toBe(true);
    // The evidence must NAME the line a reader will open. `SourceView` blanks
    // rather than deletes, so an index into a view is an index into the file —
    // the property every deleting stripper lacks, and the reason a guard that
    // reports `file:line` has to come through that door.
    expect(found!.reads[0]?.line).toBe(3);
    expect(found!.matches[0]?.line).toBe(4);
    expect(found!.matches[0]?.text).toContain("allowedProjectRoots");
  });

  test("and the verdict REFUSES it by name, with a remedy that survives being followed", () => {
    const verdict = allowlistVerdict(["web:tests/prevention/not-a-real-file.test.ts"]);
    expect(verdict.unlisted).toEqual(["web:tests/prevention/not-a-real-file.test.ts"]);
    const failure = rawReaderFailure(verdict);
    expect(failure).not.toBeNull();
    expect(String(failure)).toContain("not-a-real-file.test.ts");
    // §31c — the remedy is part of the guard. It must name the door and the
    // three views, or an operator following it has to guess which one.
    expect(String(failure)).toContain("readSourceView");
    expect(String(failure)).toContain("codeWithStrings()");
    expect(String(failure)).toContain("prose()");
  });

  test("a STALE entry is refused too — migrating must delete the entry", () => {
    // The direction that keeps the debt honest. Without this, a migrated
    // scanner leaves the universe, its entry stays, and the record slowly
    // becomes a list of keys certifying nothing — §25's universe that shrank
    // while reporting the same result.
    const verdict = allowlistVerdict([]);
    expect(verdict.stale.length).toBeGreaterThan(0);
    expect(String(rawReaderFailure(verdict))).toContain("NO LONGER in the universe");
  });
});

describe("the INERT plants — a detector that fires on everything has said nothing", () => {
  test("INERT: `readSourceView` + `view.code()` is NOT in the universe", () => {
    // THE MIGRATION TARGET. If this were detected, migrating a scanner would
    // not remove it from the universe, the debt could never fall, and the whole
    // instrument would be a permanent 110-entry allowlist.
    const found = plant([
      `import { readSourceView } from "./source-view.ts";`,
      `import { ${ENUMERATE} } from "node:fs";`,
      `for (const name of ${ENUMERATE}("src")) {`,
      `  const view = readSourceView(name);`,
      `  if (view.code().includes("allowedProjectRoots")) report(name);`,
      "}",
    ]);
    expect(found, "no byte read at all, so not even classified").toBeNull();
  });

  test("INERT: a byte read named only in a COMMENT is prose, not evidence", () => {
    // This file's own header names the refused call. A scanner whose universe
    // comes from source text will scan its own comments, and documentation
    // would then change the measurement.
    const found = plant([
      `import { ${ENUMERATE} } from "node:fs";`,
      `// const source = ${READ}(name, "utf8"); source.includes("x");`,
      "/**",
      ` * const source = ${READ}(name, "utf8");`,
      " */",
      `for (const name of ${ENUMERATE}("src")) report(name);`,
    ]);
    expect(found).toBeNull();
  });

  test("INERT: a byte read quoted inside a TEMPLATE is data, not a call", () => {
    // The FATAL the lexer under this was rebuilt for, one level out: a fixture
    // spelling out a call inside `${`…`}` used to land in the code half at a
    // line start. If it did here, every test tree holding source-as-data would
    // enter the universe.
    const found = plant([
      `import { ${ENUMERATE} } from "node:fs";`,
      "export const FIXTURE = `${`",
      `const source = ${READ}(name, "utf8");`,
      `source.includes("allowedProjectRoots");`,
      "`}`;",
      `for (const name of ${ENUMERATE}("src")) report(name);`,
    ]);
    expect(found).toBeNull();
  });

  test("INERT: reading bytes and never matching the value is not in the universe", () => {
    const found = plant([
      `import { ${READ}, ${ENUMERATE} } from "node:fs";`,
      `for (const name of ${ENUMERATE}("src")) {`,
      `  const source = ${READ}(name, "utf8");`,
      "  total += source.length;",
      "}",
    ]);
    expect(found, "it reads bytes, so it is classified").not.toBeNull();
    expect(found!.matches, "but nothing matches the value it read").toEqual([]);
    expect(isGuardedUniverse(found!)).toBe(false);
  });

  test("INERT: matching a file it was HANDED, without enumerating, is outside", () => {
    // The stated narrowing, driven. 97 files in the two trees have this shape
    // and this guard does not refuse them — asserting it here means the limit
    // is a measurement and not a sentence.
    const found = plant([
      `import { ${READ} } from "node:fs";`,
      `const lock = ${READ}("package-lock.json", "utf8");`,
      `if (lock.includes("workspaces")) report();`,
    ]);
    expect(found).not.toBeNull();
    expect(found!.matches.length).toBeGreaterThan(0);
    expect(found!.enumerations, "it reads one artifact it was handed").toEqual([]);
    expect(isGuardedUniverse(found!)).toBe(false);
  });

  test("INERT: the DECLARE-THEN-ASSIGN read is caught (the miss that was live)", () => {
    // Not inert — the opposite. The first spelling of the binding pattern
    // required `const|let|var` on the same statement, so this shape was
    // invisible, and
    // the file it hid was `consumer-plants.ts`: a shipped scanner in the
    // owner's own directory, walking both repositories. The guard-of-guards did
    // not see its own neighbour. Universe 102 → 110 when this was fixed.
    const found = plant([
      `import { ${READ}, ${ENUMERATE} } from "node:fs";`,
      `for (const file of ${ENUMERATE}("src")) {`,
      "  let source: string;",
      `  try { source = ${READ}(file, "utf8"); } catch { continue; }`,
      `  for (const m of source.matchAll(SPECIFIER)) use(m);`,
      "}",
    ]);
    expect(found).not.toBeNull();
    expect(isGuardedUniverse(found!), "declare-then-assign is a byte read like any other").toBe(true);
  });
});

describe("the scan refuses an empty universe on BOTH inputs", () => {
  test("zero files scanned is a refusal, not a pass", () => {
    const scan = scanForRawSourceMatchers([
      { name: "empty", root: createTempDir("raw-reader-empty-"), sources: ["src"] },
    ]);
    expect(scan.scanned).toEqual([]);
    expect(scan.failure, "an empty universe agrees with every claim about it").not.toBeNull();
    expect(String(scan.failure)).toContain("ZERO files");
  });

  test("files scanned but ZERO matchers found is ALSO a refusal — the detector went blind", () => {
    // The one that matters more, and the one a naive floor misses. A healthy
    // tree cannot answer zero here, so an empty answer is the instrument
    // breaking — otherwise indistinguishable from a perfectly clean tree.
    const dir = createTempDir("raw-reader-blind-");
    writeFileSync(join(dir, "plain.ts"), "export const value = 1;\n");
    const scan = scanForRawSourceMatchers([{ name: "blind", root: dir, sources: ["."] }]);
    expect(scan.scanned.length, "the walk DID find a file, so this is not the other failure")
      .toBeGreaterThan(0);
    expect(scan.failure).not.toBeNull();
    expect(String(scan.failure)).toContain("ZERO raw source");
  });
});

describe("both real trees are clean against the declared allowlist", () => {
  // The real-tree scan, read ONCE per run. Two arms below ask the same
  // question of the same two trees, and the trees cannot change under a
  // running suite — the same reasoning as the promotion view's memo
  // (tests/helpers/promotion-view.ts): a second arm re-paying the full
  // two-repository walk buys an identical answer. Measured
  // before this memo: the walk cost ~1.9s and was paid twice, once per arm.
  let realTreeScan: ReturnType<typeof scanForRawSourceMatchers> | undefined;
  const theRealTreeScan = (): ReturnType<typeof scanForRawSourceMatchers> =>
    (realTreeScan ??= scanForRawSourceMatchers(ROOTS));

  test("every raw source matcher in both repositories is declared, with a reason", () => {
    const scan = theRealTreeScan();
    expect(scan.failure, String(scan.failure ?? "")).toBeNull();

    // BOTH floors, and they fail differently: zero files means the walk broke,
    // zero found means the DETECTOR broke.
    expect(scan.scanned.length, "no files were scanned").toBeGreaterThan(0);
    expect(scan.found.length, "the detector recognised nothing").toBeGreaterThan(0);

    // THE STATED LIMIT, ASSERTED. The two wider units must strictly contain the
    // guarded one, or the narrowing this module documents is not the narrowing
    // it performs.
    expect(scan.readsBytes.length).toBeGreaterThan(scan.readValueReachesMatcher.length);
    expect(scan.readValueReachesMatcher.length).toBeGreaterThan(scan.found.length);

    const verdict = allowlistVerdict(scan.found.map((f) => keyOf(f.path)));
    const failure = rawReaderFailure(verdict);
    expect(failure, `\n${failure ?? ""}`).toBeNull();
  });

  test("the guarded universe spans BOTH repositories", () => {
    // §28b — a guard holding ONE index let a test append to the sibling repo's
    // tracked source and exit 0. A universe that has quietly become
    // single-repository passes every test above.
    const scan = theRealTreeScan();
    const keys = scan.found.map((f) => keyOf(f.path));
    expect(keys.filter((k) => k.startsWith("integration:")).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith("web:")).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith("UNROOTED:")), "the walk left its own roots").toEqual([]);
  });

  test("the debt is recorded, addressed, and only ever falls", () => {
    const verdict = allowlistVerdict(allowedKeys());
    expect(verdict.unlisted).toEqual([]);
    expect(verdict.stale).toEqual([]);
    // Not a budget — a quantity a reader inherits instead of a silence.
    expect(verdict.debtRemaining).toBe(Object.keys(UNMIGRATED_SCANNERS).length);
    for (const debt of Object.values(UNMIGRATED_SCANNERS)) {
      expect(debt.kind).toBe("unmigrated-scanner");
      expect(debt.task, "a debt with no address is a silence").not.toBe("");
    }
  });

  test("every LEGITIMATE entry carries a reason somebody wrote, not a label", () => {
    // An exemption with no evidence is a claim about the world that nothing
    // re-checks. `why: "legacy"` would satisfy a non-empty check and say
    // nothing, so the floor is a sentence's worth of characters and the entry
    // must not simply restate its own key.
    for (const [key, reason] of Object.entries(LEGITIMATE_RAW_READERS)) {
      expect(reason.why.length, `${key}: the reason is too short to be one`).toBeGreaterThan(120);
      expect(reason.why, `${key}: the reason must not merely name the file`).not.toContain(key);
    }
  });

  test("no key appears in both records, and none appears twice", () => {
    const keys = allowedKeys();
    expect(new Set(keys).size, "a duplicated key makes one of the two entries dead").toBe(keys.length);
    const legitimate = new Set(Object.keys(LEGITIMATE_RAW_READERS));
    for (const key of Object.keys(UNMIGRATED_SCANNERS)) {
      expect(legitimate.has(key), `${key} is both a decision and a debt`).toBe(false);
    }
  });
});
