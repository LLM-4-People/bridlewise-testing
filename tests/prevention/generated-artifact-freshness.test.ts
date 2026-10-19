// @vitest-environment node
/**
 * GENERATED-ARTIFACT FRESHNESS — a guard that reads an untracked, gitignored
 * generated artifact and asserts a verdict depending on its currency must bind
 * that trust to CONTENT, never to the clock or to mere presence.
 *
 * ── THE DEFECT CLASS THIS EXISTS TO REFUSE ───────────────────────────────
 *
 * A generated artifact (a report, a cache, a ledger, a receipt) is written by
 * one run and read by a later one. When a guard asserts on it, "is this safe
 * to trust?" has exactly one honest answer: the artifact names the thing it
 * was produced against — a tree identity (HEAD sha) or a content hash — and
 * the reader compares it to the live tree. The two dishonest answers both
 * appeared here:
 *
 *   - **WALL-CLOCK.** Judging by file age reds on an unchanged tree (a false
 *     red that trains readers to ignore the gate) and greens on a report
 *     regenerated an hour ago against a tree that has since moved. The perf
 *     regression gate judged `.report.json` this way until freshness bound to
 *     the HEAD sha it was profiled against.
 *
 *   - **PRESENCE.** "The file exists and parses" is the treadmill: the
 *     artifact is regenerated on a schedule, the guard stays green, and the
 *     green certifies nothing about whether the artifact still describes the
 *     tree.
 *
 * Not every artifact needs a sha. A cache keyed by content hash invalidates
 * itself (a stale entry can never be read — the hash changed); an append-only
 * ledger is never "stale", only grown; a receipt consumed within a single run
 * has no second reader to mislead. Those are EXEMPTIONS, and an exemption is
 * a claim about the world, so it carries the same burden as a detection: a
 * `@freshness-exempt <reason>` marker in the reader's source, proven
 * well-formed below.
 *
 * ── DENY-BY-DEFAULT, AND WHY THIS DETECTOR IS PRECISE ────────────────────
 *
 * Three looser detectors were tried and rejected. Keyed on the bare substring
 * `.bridlewise/`, the scan reds on writers, cleaners, docstring mentions
 * and scratch-fixture builders. Keyed on any `_PATH` constant, it reds on
 * readers of TRACKED source (`bridlewise.config.json`, the manifests).
 * Keyed on "names the artifact's path segment AND reads", it reds on tests
 * that WRITE a fixture to a temp dir and read it back — the basename matches,
 * but the target is `/tmp/…`, not the repo's artifact. A guard that reds on
 * the innocent trains its reader to ignore the red — the very treadmill this
 * file exists to refuse.
 *
 * So the census is keyed on the ONE property that separates a guard trusting
 * a prior run's output from everything else: it reads through a path constant
 * whose DECLARED VALUE is a repo-relative path that **git itself reports as
 * IGNORED**. The discovery is mechanical and cannot drift: scan every
 * guard/test/helper source for a path-constant declaration whose literal
 * value git ignores; find every file that READS through that constant; each
 * such reader must bind to a content identity or carry the marker. A temp-dir
 * write-read never resolves to a git-ignored repo path (it is under `/tmp`);
 * a tracked-source read never resolves to one either (git tracks it). A NEW
 * gitignored-artifact reader added tomorrow is caught the day it lands.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { STATE_DIRECTORY_NAME } from "../../engine/src/kernel/product-identity.ts";

const ROOT = process.cwd();

/** Every guard/test/helper source file that could read a generated artifact. */
function guardSources(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mts)$/.test(entry.name)) out.push(full);
    }
  };
  for (const top of ["tests", "engine/test"]) walk(join(ROOT, top));
  return out;
}

/** git check-ignore verdicts, cached so each distinct path is asked once. */
const ignoreCache = new Map<string, boolean>();
function isGitIgnored(repoRelativePath: string): boolean {
  const cached = ignoreCache.get(repoRelativePath);
  if (cached !== undefined) return cached;
  let verdict = false;
  try {
    execFileSync("git", ["check-ignore", "-q", repoRelativePath], { cwd: ROOT });
    verdict = true; // exit 0 means ignored
  } catch {
    verdict = false; // exit 1 means not ignored
  }
  ignoreCache.set(repoRelativePath, verdict);
  return verdict;
}

/**
 * The repo-relative path a constant declares, when it is a string literal or
 * a `join(process.cwd(), "a", "b.json")` of literals. Returns null for a
 * constant whose value is not a resolvable repo-relative literal (an absolute
 * `new URL(…)` is handled separately by its pathname literal).
 */
/**
 * A declared path AND whether it is relative to the DECLARING file. A
 * `new URL("../x.json", import.meta.url)` is file-relative (its `../`
 * segments resolve against the declaring file's directory); a
 * `join(process.cwd(), …)` or a bare literal is already repo-rooted. The
 * caller re-roots ONLY the file-relative form — re-rooting a cwd-joined path
 * would prepend the declaring file's directory and produce a path that never
 * exists.
 */
interface DeclaredPath {
  readonly repoPath: string;
  readonly fileRelative: boolean;
}

function declaredRepoPath(constName: string, code: string, depth = 0, declaringFileAbs: string | null = null): DeclaredPath | null {
  if (depth > 8) return null; // a constant cycle is not a path
  const QT = "[\"'\\`]"; // a quote or backtick, without nesting a backtick in a template
  // `const X = statePath("a", "b.json")` — the product's one state-path
  // spelling (engine/src/kernel/product-identity.ts): the state directory
  // then the segments. The ledger owner declares WEB_RUN_HISTORY_PATH so.
  const state = new RegExp(
    "(?:const|readonly)\\s+" + constName + "\\b[^=]*=\\s*statePath\\s*\\(([^)]*)\\)",
  ).exec(code);
  if (state) {
    const segments = [...state[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
    if (segments.length > 0) return { repoPath: [STATE_DIRECTORY_NAME, ...segments].join("/"), fileRelative: false };
  }
  // `const X = ".bridlewise/a/b.json"` (a direct literal — already repo-rooted).
  const direct = new RegExp(
    "(?:const|readonly)\\s+" + constName + "\\b[^=]*=\\s*" + QT + "([^\"'\\`]+\\.json)" + QT,
  ).exec(code);
  if (direct) return { repoPath: direct[1]!, fileRelative: false };
  // `const X = join(process.cwd(), "a", "b.json")` or `join(ROOT, …)`. The
  // argument list may itself contain parens (`process.cwd()`), so a naive
  // `[^)]*` stops at the first `)`. Grab to the closing paren that precedes
  // the statement's end (`;` or newline) — the call's own close.
  const joined = new RegExp(
    "(?:const|readonly)\\s+" + constName + "\\b[^=]*=\\s*(?:join|resolve)\\s*\\(([\\s\\S]*?)\\)\\s*(?:;|$)",
    "m",
  ).exec(code);
  if (joined) {
    const argsText = joined[1]!;
    // String-literal segments, dropping the root placeholders (process.cwd(),
    // ROOT, __dirname, import.meta.url) which contribute no path segment.
    const literalSegments = [...argsText.matchAll(/["'`]([^"'`]+)["'`]/g)]
      .map((m) => m[1]!)
      .filter((s) => !/^(?:process\.cwd|ROOT|__dirname|import\.meta)/.test(s));
    // A NESTED constant segment: `join(SUMMARY_DIR, "run-history.json")` —
    // resolve the constant to its own declared path and prepend its segments.
    // This is how `BUDGET_HISTORY_PATH` reaches `.bridlewise/web-test-results`.
    const nestedConst = /\b([A-Z][A-Z0-9_]+)\b/.exec(
      argsText.replace(/["'`][^"'`]*["'`]/g, ""), // constants only, not literals
    );
    let prefixSegments: string[] = [];
    if (nestedConst && nestedConst[1] !== constName) {
      // Declared here, or IMPORTED by the declaring file (`join(process.cwd(),
      // WEB_RUN_HISTORY_PATH)` in budget-paths.ts: the ledger path is spelled
      // once, by its owner).
      const nestedPath = declaredRepoPath(nestedConst[1]!, code, depth + 1, declaringFileAbs) ??
        (declaringFileAbs === null ? null : importedDeclaredPath(nestedConst[1]!, code, declaringFileAbs, depth + 1));
      if (nestedPath !== null) prefixSegments = nestedPath.repoPath.split("/").filter((s) => s.length > 0);
    }
    const all = [...prefixSegments, ...literalSegments];
    // A `join(process.cwd(), …)` is repo-rooted (cwd IS the repo root for the
    // runners); it is NOT relative to the declaring file.
    if (all.length > 0) return { repoPath: all.join("/").replace(/^\/+/, ""), fileRelative: false };
  }
  // `new URL("../.report.json", import.meta.url).pathname` — take the literal
  // AS WRITTEN and mark it FILE-RELATIVE: the leading `../` resolves against
  // the declaring file's directory, so the caller re-roots it.
  const url = new RegExp(
    "(?:const|readonly)\\s+" + constName + "\\b[^=]*=\\s*new URL\\(\\s*" + QT + "([^\"'\\`]+\\.json)" + QT,
  ).exec(code);
  if (url) return { repoPath: url[1]!, fileRelative: true };
  return null;
}

/** An actual read of a filesystem artifact (string literals kept). The
 * ledger owner's reads (`readRunFailureRows` / `readRunHistory`) ARE reads —
 * a guard that consumes the run-history ledger through the owner reads the
 * artifact just as surely as a direct `readFileSync`. */
const READ_RE = /\breadFileSync\s*\(|JSON\.parse\s*\(|\breadRun(?:FailureRows|History)\s*\(|\b(?:readProfileReport|judgeableProfileReport)\s*\(/;

/**
 * The path constants a file can read through, resolved to their declared
 * repo-relative values — scoped to the FILE, never a global map. A constant
 * name is not unique across the tree (`ARTIFACT_PATH` is declared in two
 * files with two different values), so a name→path map keyed globally
 * misattributes one file's constant to another's value. Resolution: a
 * constant read in this file is resolved to (a) a declaration in THIS file,
 * or (b) the declaration in the module this file imports it from. Nothing
 * else is reachable.
 */
function constPathsForFile(code: string, fileRel: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  // (a) constants declared in THIS file. A file-relative URL path declared
  // HERE is re-rooted against THIS file's directory.
  for (const m of code.matchAll(/(?:export\s+)?(?:const|readonly)\s+([A-Z][A-Z0-9_]+)\b[^=]*=/g)) {
    const decl = declaredRepoPath(m[1]!, code, 0, join(ROOT, fileRel));
    if (decl !== null) {
      map.set(m[1]!, decl.fileRelative ? rerootDeclaredPath(decl.repoPath, join(ROOT, fileRel)) : decl.repoPath);
    }
  }
  // (b) constants IMPORTED from a relative module — resolve the import's
  // source file and read the declaration there.
  for (const imp of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g)) {
    const names = imp[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter((s) => /^[A-Z][A-Z0-9_]+$/.test(s));
    if (names.length === 0) continue;
    const specifier = imp[2]!;
    if (!specifier.startsWith(".")) continue; // only relative imports resolve here
    const targetAbs = resolveImport(join(ROOT, fileRel), specifier);
    if (targetAbs === null) continue;
    let targetCode: string;
    try {
      targetCode = stripCommentsOnly(read(targetAbs));
    } catch {
      continue;
    }
    for (const name of names) {
      if (map.has(name)) continue;
      const decl = declaredRepoPath(name, targetCode, 0, targetAbs);
      if (decl !== null) {
        // Only a FILE-RELATIVE path (a `new URL("…", import.meta.url)`) is
        // re-rooted against the DECLARING file. A `join(process.cwd(), …)` is
        // already repo-rooted and must NOT be re-rooted.
        map.set(name, decl.fileRelative ? rerootDeclaredPath(decl.repoPath, targetAbs) : decl.repoPath);
      }
    }
  }
  return map;
}

/** The declared path of `name` as the module `code` (at `fileAbs`) imports it from a relative module, or null. */
function importedDeclaredPath(name: string, code: string, fileAbs: string, depth: number): DeclaredPath | null {
  for (const imp of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g)) {
    const names = imp[1]!.split(",").map((part) => part.trim().replace(/^type\s+/, ""));
    if (!names.includes(name) || !imp[2]!.startsWith(".")) continue;
    const targetAbs = resolveImport(fileAbs, imp[2]!);
    if (targetAbs === null) return null;
    let targetCode: string;
    try {
      targetCode = stripCommentsOnly(read(targetAbs));
    } catch {
      return null;
    }
    return declaredRepoPath(name, targetCode, depth, targetAbs);
  }
  return null;
}

/** Resolve a relative import specifier to an absolute file path. */
function resolveImport(fromFileAbs: string, specifier: string): string | null {
  const dir = dirname(fromFileAbs);
  // The specifier may already carry its extension (`./x.ts`, common in this
  // codebase) or omit it (`./lib/perf-harness`). Try the specifier as written
  // first, then with each extension.
  const candidates = [specifier, `${specifier}.ts`, `${specifier}.mts`, `${specifier}/index.ts`];
  for (const c of candidates) {
    const candidate = join(dir, c);
    try {
      read(candidate); // an existence probe — the content is not used
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Re-root a path declared in another file to the repository root. A `new
 * URL("../.report.json", import.meta.url)` in `tests/performance/lib`
 * resolves against THAT file's directory; the leading `../` segments are
 * relative to it. We normalize against the declaring file's directory.
 */
function rerootDeclaredPath(declaredPath: string, declaringFileAbs: string): string {
  if (!declaredPath.startsWith(".")) return declaredPath; // already repo-relative
  const abs = join(dirname(declaringFileAbs), declaredPath);
  return relative(ROOT, abs).split("\\").join("/");
}

/**
 * True if the source reads a gitignored generated artifact through a path
 * constant reachable from it: it performs a read through an UPPER_SNAKE
 * constant whose DECLARED value (resolved per-file) git reports as ignored.
 */
function readsIgnoredArtifact(code: string, fileRel: string): boolean {
  if (!READ_RE.test(code)) return false;
  const constPaths = constPathsForFile(code, fileRel);
  // Reads through an UPPER_SNAKE constant: `readFileSync(X)`,
  // `readRunFailureRows(X)` / `readRunHistory(X)` (the ledger owner's reads), or
  // the profile report owner's `readProfileReport(X)` / `judgeableProfileReport(root, X)`
  // (scripts/testing/performance-measurements.ts).
  const readConsts = [
    ...[...code.matchAll(/readFileSync\s*\(\s*([A-Z][A-Z0-9_]+)\s*[,)]/g)].map((m) => m[1]!),
    ...[...code.matchAll(/readRun(?:FailureRows|History)\s*\(\s*([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]!),
    ...[...code.matchAll(/readProfileReport\s*\(\s*([A-Z][A-Z0-9_]+)\s*\)/g)].map((m) => m[1]!),
    ...[...code.matchAll(/judgeableProfileReport\s*\(\s*\w+\s*,\s*([A-Z][A-Z0-9_]+)\s*\)/g)].map((m) => m[1]!),
  ];
  for (const name of readConsts) {
    const declared = constPaths.get(name);
    if (declared !== undefined && isGitIgnored(declared)) return true;
  }
  return false;
}

/** True if the source carries a `@freshness-exempt <reason>` JSDoc marker. */
function hasExemptionMarker(rawSrc: string): boolean {
  return /^\s*\*\s*@freshness-exempt(?:\s|$)/m.test(rawSrc);
}

/** True if the source binds the artifact to a CONTENT identity. The
 * tree-identity owner's three readers (the commit, the measured surface, the
 * dirty flag) each bind content — a reader going through ANY of them is bound
 * to the tree it describes, never to the clock. */
function bindsToContentIdentity(code: string): boolean {
  if (/\breadRepositoryHeadSha\b/.test(code)) return true;
  if (/\breadWorkingTreeDirty\b/.test(code)) return true;
  if (/\breadMeasuredSurfaceHash\b/.test(code)) return true;
  return /createHash\(/.test(code) && /cached\.hash\s*===|\.hash\s*===\s*hash/.test(code);
}

describe("generated-artifact freshness — every gitignored-artifact reader binds to content or is exempt", () => {
  // The readers a healthy tree MUST yield — the LIVENESS floor proving the
  // detector is awake. NOT an allowlist: the census discovers the universe;
  // this list only proves the discovery did not go blind. A reader REMOVED
  // from the tree lowers this floor in the same edit (re-derived, never
  // asserted stale).
  const KNOWN_READERS: readonly string[] = [
    "tests/performance/regression.test.ts", // reads .report.json → binds to the tree identity
    "tests/prevention/no-a11y-warnings.test.ts", // content-hash cache → binds to content
    "tests/prevention/flaky-test-memory.test.ts", // reads the run-history ledger (append-only → exempt)
    // engine/test/prevention/flaky-test-memory.test.ts reads the same class of
    // ledger through a lowercase local (`historyPath`), a shape this census —
    // keyed on UPPER_SNAKE path constants — deliberately does not force. Its
    // @freshness-exempt marker is the honest classification either way.
  ];

  function discover(): { rel: string; code: string; raw: string }[] {
    const found: { rel: string; code: string; raw: string }[] = [];
    for (const f of guardSources()) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (rel.endsWith("generated-artifact-freshness.test.ts")) continue; // this guard's own patterns
      const raw = read(f);
      const code = stripCommentsOnly(raw);
      if (readsIgnoredArtifact(code, rel)) found.push({ rel, code, raw });
    }
    return found;
  }

  // The census, read ONCE per run. Two arms below consume the same discovered
  // readership, and the guard sources cannot change under a running suite —
  // the same reasoning as the promotion view's memo
  // (tests/helpers/promotion-view.ts): a second arm re-walking the whole
  // guard tree buys an identical answer. Measured before this memo: the walk
  // cost ~1.5s and was paid twice, once per arm.
  let census: ReadonlyArray<{ rel: string; code: string; raw: string }> | undefined;
  const theCensus = (): ReadonlyArray<{ rel: string; code: string; raw: string }> =>
    (census ??= discover());

  test("the census discovers every gitignored-artifact reader, and the detector is awake", () => {
    const rel = theCensus().map((x) => x.rel);
    for (const known of KNOWN_READERS) {
      expect(
        rel,
        `the census did not find ${known} — the artifact-read detector went blind, ` +
          "and a green here would certify nothing",
      ).toContain(known);
    }
  });

  test("every discovered reader binds to a content identity OR carries a @freshness-exempt reason", () => {
    const violations: string[] = [];
    for (const { rel, code, raw } of theCensus()) {
      const bound = bindsToContentIdentity(code);
      const exempt = hasExemptionMarker(raw);
      if (!bound && !exempt) {
        violations.push(
          `${rel} reads a gitignored generated artifact with no content-identity binding and no ` +
            "@freshness-exempt reason — a guard that judges such an artifact by presence or by the " +
            "clock is the treadmill shape. Bind it to the tree identity (the shared owner) or to a " +
            "content hash, or record why neither applies.",
        );
      }
    }
    expect(violations, violations.length > 0 ? `\n  ${violations.join("\n  ")}` : "").toEqual([]);
  });

  test("a planted artifact reader that judges by presence ALONE is caught (mutation-liveness)", () => {
    // Driven through the real predicates with a real git-ignored path. The
    // plant declares its path constant inline, so per-file resolution applies.
    const plantedPresenceOnly =
      `import { readFileSync } from "node:fs";\n` +
      `const METRICS_PATH = ".bridlewise/web-test-results/run-history.json";\n` +
      `const data = JSON.parse(readFileSync(METRICS_PATH, "utf8"));\n` +
      `export const metrics = data;\n`;
    expect(
      readsIgnoredArtifact(plantedPresenceOnly, "tests/prevention/__plant__.test.ts"),
      "the plant must register as a gitignored-artifact read (the constant's value is git-ignored)",
    ).toBe(true);
    expect(bindsToContentIdentity(plantedPresenceOnly), "the plant binds to nothing").toBe(false);
    expect(hasExemptionMarker(plantedPresenceOnly), "the plant carries no marker").toBe(false);

    // A reader of a TRACKED path constant (a config) is NOT in the class.
    const trackedReader =
      `import { readFileSync } from "node:fs";\n` +
      `const CONFIG_PATH = "bridlewise.config.json";\n` +
      `const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));\n`;
    expect(
      readsIgnoredArtifact(trackedReader, "tests/prevention/__plant__.test.ts"),
      "a tracked source file is NOT a gitignored artifact — git's verdict must exclude it",
    ).toBe(false);

    // The SAME read bound to the tree-identity owner is GREEN — through ANY
    // of its three content readers (the commit, the surface, the dirty flag).
    const plantedBound =
      plantedPresenceOnly +
      `import { readRepositoryHeadSha } from "../engine/src/shared/run-history.ts";\n` +
      `const sha = readRepositoryHeadSha(process.cwd());\n`;
    expect(bindsToContentIdentity(plantedBound), "a tree-identity binding must satisfy the arm").toBe(true);
    const plantedSurfaceBound =
      plantedPresenceOnly +
      `import { readMeasuredSurfaceHash } from "../engine/src/shared/tree-identity.ts";\n` +
      `const surface = readMeasuredSurfaceHash(process.cwd());\n`;
    expect(bindsToContentIdentity(plantedSurfaceBound), "a measured-surface binding must satisfy the arm").toBe(true);

    // And the SAME read with an exemption marker is GREEN; a corrupted one is not.
    const plantedExempt =
      `/**\n * @freshness-exempt append-only ledger — never stale, only grown.\n */\n` +
      plantedPresenceOnly;
    expect(hasExemptionMarker(plantedExempt), "a genuine marker must satisfy the arm").toBe(true);
    const corrupted = plantedPresenceOnly + "\n// @freshness-exempt-MUTATED\n";
    expect(hasExemptionMarker(corrupted), "a corrupted marker must NOT count").toBe(false);
  });

  test("every @freshness-exempt marker in the tree carries a non-empty reason", () => {
    const bare: string[] = [];
    for (const f of guardSources()) {
      const raw = read(f);
      const markers = raw.match(/^\s*\*\s*@freshness-exempt\s*(.*)$/gm) ?? [];
      for (const m of markers) {
        const reason = m.replace(/^\s*\*\s*@freshness-exempt\s*/, "").trim();
        if (reason.length === 0) bare.push(relative(ROOT, f).split("\\").join("/"));
      }
    }
    expect(
      bare,
      `@freshness-exempt markers with no reason: ${bare.join(", ")} — an exemption must say WHY the artifact needs no content binding`,
    ).toEqual([]);
  });
});
