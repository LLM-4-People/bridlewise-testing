// @vitest-environment node
/**
 * Mechanical enforcement: the Single-Party-Owner principle for GIT
 * operations ("Single-Party-Owner Principle" + "No Scattered
 * Helpers" + "Deny-by-Default").
 *
 * The git bridge (`server/git-bridge.ts`) is the SINGLE owner of git
 * subprocess operations: it owns `gitText` (the single "spawn git with the
 * configured env + timeout + safeCRLF args" pattern) and
 * `isGitRepo` (the single "is this path a working git repo" probe ). The git-ops bridge (`server/git-ops-bridge.ts`) EXTENDS it (branch
 * / log / diff) by importing those primitives. ALL git operations go
 * through the bridge → `fs-gate` (ownership gate at the choke
 * point). No route, service, or LLM tool spawns git directly.
 *
 * This test verifies:
 * (a) all git operations go through the bridge — `spawnSync("git"`
 * appears ONLY in git-bridge.ts (the single spawn owner).
 * (b) the bridge uses fs-gate — every git-owner file imports +
 * calls `assertProjectPathOwnership`, + a behavioral gate test
 * proves a gate whose DB denies ownership rejects every operation.
 * (c) no route/service spawns git directly — subsumed by (a); also
 * bans `execSync("git` / `execFileSync("git` / `spawn("git`.
 * (d) `gitText` + `isGitRepo` are each DEFINED in exactly ONE file
 * (the no-scattered-helpers consolidation).
 * (e) the git-log cap is the single config owner (no scattered
 * `MAX_LOG_ENTRIES` literal); `gitMaxLogEntries` +
 * `gitLogDefaultEntries` live in config.ts.
 * (f) behavioral: the ref argument-injection guard rejects a ref
 * starting with `-` (prevents `git diff --output=FILE` file writes).
 * (g) behavioral: `getBranches` detects remote branches (bug fix —
 * `remote` was ALWAYS false before the full-refname fix).
 *
 * Mutation-verified: re-introducing a direct git spawn OR a duplicate
 * `isGitRepo` definition makes the scan FAIL.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { walk } from "../helpers/source-scan.ts";
import { callArgumentsOf } from "../helpers/function-scope.ts";
import { GIT_SPAWN, gitSpawnAccessors, importsGitBridgeAccessor } from "../helpers/git-spawn-owner.ts";

import {
  getBranches,
  getLog,
  getDiffSummary,
  getDiffPatch,
  getGitStatus,
} from "../../server/intelligence/git-ops-bridge.ts";
import { getProjectGitStatus, gitText, isGitRepo } from "../../server/intelligence/git-bridge.ts";
import { makeFsGate } from "../../server/filesystem/fs-gate.ts";
import { ForbiddenError, BadRequestError } from "../../server/kernel/errors.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { createTempGitRepo, type TempGitRepo } from "../helpers/temp-git-repo.ts";

const SERVER_ROOT = join(process.cwd(), "server");

// ── Dynamic discovery ──

/** Recursively list every `.ts` file under `server/` (excludes `.d.ts`). */
function listServerTsFiles(): string[] {
  return walk(SERVER_ROOT, { exts: [".ts"] }).filter((f) => !f.endsWith(".d.ts"));
}

const SERVER_TS = listServerTsFiles();

// Top-level callable-definition matchers (column-0 anchored so NESTED
// closures inside another function body are NOT matched — they are local
// implementation details, not scattered reusable helpers; same scoping
// rule as no-scattered-helpers.test.ts).
const TOP_FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
const TOP_ARROW_RE = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/gm;

/** Names DEFINED at the top level of a source file (column-0 anchored). */
function topLevelNames(src: string): Set<string> {
  const names = new Set<string>();
  function collect(re: RegExp): void {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]!);
  }
  collect(TOP_FN_RE);
  collect(TOP_ARROW_RE);
  return names;
}

/**
 * Strip `/* block *\/` + `// line` comments so a doc-comment that
 * references a historical name (e.g. "the prior `const GIT_ENV =...`")
 * does NOT trip a definition scan. The definition scans check for
 * `const/let NAME` — a real definition is never inside a comment, so
 * stripping comments removes only false positives. (Same approach as
 * no-hardcoded-values.test.ts.)
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "");
}

/** Count files that DEFINE `name` as a `const`/`let` (comments stripped). */
function constDefCount(name: string): number {
  const re = new RegExp(`(?:const|let)\\s+${name}\\b`);
  return SERVER_TS.filter((f) => re.test(stripComments(readFileSync(f, "utf8")))).length;
}

/** Files that DEFINE `name` at the top level (relative to server/). */
function filesDefining(name: string, files: readonly string[] = SERVER_TS): string[] {
  return files
    .filter((f) => topLevelNames(readFileSync(f, "utf8")).has(name))
    .map((f) => relative(SERVER_ROOT, f));
}

/** A git subprocess spawn: `spawnSync("git"`, `execSync("git"`, etc. */
const GIT_SPAWN_RE = /\b(?:spawnSync|execSync|execFileSync|spawn|exec)\s*\(\s*["']git["']/;

// ── (a)+(c) all git operations go through the bridge; no direct spawn ──

describe("Git bridge owner — single spawn owner (no route/service spawns git)", () => {
  const gitSpawners = SERVER_TS
    .filter((f) => GIT_SPAWN_RE.test(readFileSync(f, "utf8")))
    .map((f) => relative(SERVER_ROOT, f));

  test("(a/c) NOTHING spawns git directly — not even the bridge", () => {
    // Deny-by-default, and the bar moved: a direct git spawn is a bypass
    // wherever it is, INCLUDING in the bridge that used to hold it.
    //
    // WHY THE OWNER LOST ITS OWN SPAWN. `git` is not an inert reader. It
    // executes programs named in the repository's own `.git/config` —
    // `core.fsmonitor` on an ordinary read-only `git status`, plus aliases,
    // pager and filters — and the repository is the project, which is
    // writable from inside the sandbox. Measured on git 2.47.3: a confined
    // command planted `core.fsmonitor` and a read-only status through this
    // bridge executed it with the server's full authority. So the bridge is
    // still the single owner of "how git is invoked", and the invocation now
    // goes through the confinement door like every other subprocess.
    //
    // Dynamically discovered — a new file that spawns git is caught
    // automatically (no allowlist to rot).
    expect(gitSpawners).toEqual([]);

    // LIVENESS, because an empty expectation is satisfied by a server that
    // never invokes git at all: the bridge must still be the ONE place that
    // asks the confinement owner for a git child.
    // THE UNIVERSE OF A GUARD MUST NOT BE DECIDED BY A WINDOW. This filter
    // says "a file that asks the confinement owner for a git child", and it
    // said it by allowing 200 bytes between the call and the command — so a
    // file planning `node` 190 bytes above an unrelated `command: "git"`
    // counted, and a file whose options object is longer than the window did
    // not. Both errors are silent, and the second SHRINKS the population the
    // assertion below is made about.
    const gitPlanners = SERVER_TS
      .filter((f) => callArgumentsOf(readFileSync(f, "utf8"), "prepareConfinedSpawn")
        .some((args) => /command:\s*["']git["']/.test(args)))
      .map((f) => relative(SERVER_ROOT, f));
    expect(gitPlanners).toEqual(["intelligence/git-bridge.ts"]);
  });

  test("no server file shells out to git via exec/execSync/execFileSync/spawn", () => {
    // Broader net: the shell-based execs are a different bypass class
    // (shell injection surface). git-bridge uses spawnSync (no shell).
    const shellGit = SERVER_TS.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /\b(?:execSync|exec|execFileSync)\s*\(\s*["']git\b/.test(src);
    });
    expect(shellGit.map((f) => relative(SERVER_ROOT, f))).toEqual([]);
  });
});

// ── (d) gitText + isGitRepo defined in exactly ONE file ──

describe("Git bridge owner — no scattered git helpers (one definition each)", () => {
  test("(d) gitText is DEFINED in exactly ONE file (git-bridge.ts)", () => {
    const defs = filesDefining("gitText");
    expect(defs).toEqual(["intelligence/git-bridge.ts"]);
  });

  test("(d) isGitRepo is DEFINED in exactly ONE file (consolidation — was duplicated in git-ops-bridge.ts)", () => {
    const defs = filesDefining("isGitRepo");
    expect(defs).toEqual(["intelligence/git-bridge.ts"]);
  });

  test("GIT_ENV/GIT_TIMEOUT are not redefined (config owns them); GIT_ARGS is single-owner (not scattered)", () => {
    // removed the local GIT_ENV/GIT_ARGS copies from git-ops-bridge.
    // GIT_ENV is now `serverConfig.subprocessEnv` (the subprocess env for
    // ALL child processes — git + execute_command + typecheck; was
    // `gitEnv`, a name that lied about its non-git consumers) +
    // GIT_TIMEOUT is `serverConfig.gitTimeoutMs` (both owned by config.ts)
    // — no source file may REDEFINE them. GIT_ARGS (the safeCRLF spawn
    // args) stays as the single spawn owner's local in git-bridge.ts — at
    // most ONE definition (not scattered). Comments are stripped first so
    // a doc-comment mentioning "the prior `const GIT_ENV`" is history,
    // not a violation.
    expect(constDefCount("GIT_ENV")).toBe(0);
    expect(constDefCount("GIT_TIMEOUT")).toBe(0);
    expect(constDefCount("GIT_ARGS")).toBeLessThanOrEqual(1);
    // And the config owner actually owns the env + timeout.
    const configSrc = readFileSync(join(SERVER_ROOT, "kernel/config.ts"), "utf8");
    expect(configSrc).toContain("subprocessEnv");
    expect(configSrc).toContain("gitTimeoutMs");
  });
});

// ── (b) the bridge uses fs-gate (ownership at the choke point) ──

describe("Git bridge owner — fs-gate enforcement at the bridge choke point", () => {
  // The git-owner BRIDGES are: `git-bridge.ts` (the file that DEFINES the
  // spawn) ∪ files that IMPORT ANY of its spawn primitives. Routes that
  // consume a higher-level export (e.g. routes/projects.ts imports
  // getProjectGitStatus) are NOT bridges — they pass the gate to the bridge;
  // the bridge enforces it.
  //
  // ── THE UNIVERSE IS DERIVED, NOT SPELLED ─────────────────────────────────
  //
  // This used to be keyed to the single name `gitText`, and that was a guard
  // keyed to one spelling of its subject. When the user-facing readers moved
  // off `gitText` onto the refusal-aware `gitTextOrRefuse` — a strict
  // improvement — this population would have silently fallen from three files
  // to one, and two real bridges would have stopped being checked with
  // nothing failing. A count going DOWN is the tell, and nothing was watching
  // the count.
  //
  // So the primitive set is read from the owner's own source: every exported
  // function in `git-bridge.ts` whose BODY reaches the spawn, plus the spawn
  // itself. A fifth primitive added tomorrow joins the set because it calls
  // what the others call, not because someone remembered to add its name.
  const GIT_BRIDGE_SRC = readFileSync(join(SERVER_ROOT, "intelligence/git-bridge.ts"), "utf8");
  const spawnPrimitives = gitSpawnAccessors(GIT_BRIDGE_SRC);

  const gitOwnerFiles = [
    ...filesDefining(GIT_SPAWN),
    ...SERVER_TS
      .filter((f) => importsGitBridgeAccessor(readFileSync(f, "utf8"), spawnPrimitives))
      .map((f) => relative(SERVER_ROOT, f)),
  ];
  const uniqOwnerFiles = [...new Set(gitOwnerFiles)];

  test("the git-owner population is DERIVED and has not shrunk", () => {
    // The primitives really were discovered from the source, not assumed.
    expect(
      spawnPrimitives,
      `only ${spawnPrimitives.length} spawn primitive(s) found in git-bridge.ts — the derivation stopped working`,
    ).toEqual(expect.arrayContaining([GIT_SPAWN, "gitText", "gitTextOrRefuse"]));
    // THE FLOOR. Three server modules reach the spawn today. If a rename, a
    // move or a helper swap takes this below three, that is a universe
    // shrinking in silence and it must fail here rather than pass quieter.
    expect(
      uniqOwnerFiles,
      `git-owner bridges found: ${uniqOwnerFiles.join(", ")}. A DROP here means the population shrank — re-derive it before changing this number.`,
    ).toEqual(expect.arrayContaining(["intelligence/git-bridge.ts", "intelligence/git-ops-bridge.ts", "blocks/custody.ts"]));
  });

  test("every git-owner BRIDGE imports assertProjectPathOwnership from fs-gate", () => {
    expect(uniqOwnerFiles.length).toBeGreaterThanOrEqual(3);
    for (const rel of uniqOwnerFiles) {
      const src = readFileSync(join(SERVER_ROOT, rel), "utf8");
      expect(
        src,
        `${rel} is a git-owner bridge but does not import the fs-gate ownership probe — every git bridge MUST enforce path ownership at the choke point`,
      ).toMatch(/assertProjectPathOwnership/);
    }
  });

  test("every git-owner BRIDGE calls assertProjectPathOwnership (gate enforcement, not just an import)", () => {
    for (const rel of uniqOwnerFiles) {
      const src = readFileSync(join(SERVER_ROOT, rel), "utf8");
      // Strip comments so a doc-comment mention doesn't satisfy the
      // check — we need an actual CALL site `assertProjectPathOwnership(`.
      const stripped = stripComments(src);
      expect(
        stripped,
        `${rel} imports assertProjectPathOwnership but never CALLS it — the gate must run at the bridge choke point, not just be imported`,
      ).toMatch(/assertProjectPathOwnership\s*\(/);
    }
  });

  test("git-bridge.ts calls assertProjectPathOwnership in getProjectGitStatus (gate before isGitRepo)", () => {
    const src = readFileSync(join(SERVER_ROOT, "intelligence/git-bridge.ts"), "utf8");
    expect(src).toMatch(/assertProjectPathOwnership/);
  });

  test("(b behavioral) a gate whose DB denies ownership rejects EVERY git operation before touching git", async () => {
    // Deny-by-default: the DB holds a project row at the location that the
    // caller does not own → assertProjectPathOwnership throws ForbiddenError
    // at the bridge choke point, BEFORE isGitRepo / any git spawn. This
    // proves the gate runs at the lowest level (the bridge), not in the route.
    const denyDb = {
      projectAtPath: async () => ({ id: "someone-elses-row", userId: "user-b" }),
      getProjectByPath: async () => null,
    } as unknown as AsyncDbClient;
    const anyPath = "/tmp/r13-not-owned";
    const gate = await makeFsGate("user-a", denyDb, anyPath);
    expect(() => getBranches(anyPath, gate)).toThrow(ForbiddenError);
    expect(() => getLog(anyPath, 10, gate)).toThrow(ForbiddenError);
    expect(() => getDiffSummary(anyPath, undefined, gate)).toThrow(ForbiddenError);
    expect(() => getDiffPatch(anyPath, undefined, undefined, gate)).toThrow(ForbiddenError);
    expect(() => getGitStatus(anyPath, gate)).toThrow(ForbiddenError);
    expect(() => getProjectGitStatus(anyPath, gate)).toThrow(ForbiddenError);
  });

  test("(b behavioral) a gate whose DB grants ownership does NOT throw (the gate passes through to git)", async () => {
    // Positive control: ownership granted → no ForbiddenError (the
    // bridge proceeds to isGitRepo, which returns false for a non-repo
    // → empty/null result, not a throw). Proves the gate is the gate,
    // not an unconditional block.
    //
    // The gate now resolves the path BY LOCATION and asks which row holds
    // that location, so the double must answer like the real DB: a row whose
    // stored path IS the probed location, and that row as the location's
    // holder.
    const nonRepo = "/tmp/r13-owned-nonrepo";
    const grantDb = {
      getProjectByPath: async (path: string) =>
        path === nonRepo ? { id: "p1", name: "n", path: nonRepo, user_id: "user-a" } : null,
      projectAtPath: async (path: string) =>
        path === nonRepo ? { id: "p1", userId: "user-a" } : null,
    } as unknown as AsyncDbClient;
    const gate = await makeFsGate("user-a", grantDb, nonRepo);
    expect(() => getBranches(nonRepo, gate)).not.toThrow();
    expect(getBranches(nonRepo, gate)).toEqual([]);
    expect(() => getProjectGitStatus(nonRepo, gate)).not.toThrow();
    expect(getProjectGitStatus(nonRepo, gate)).toBeNull();
  });

  // ── NOT-A-REPOSITORY IS A TYPED FACT, NOT A ZEROED SUCCESS ─────────────
  //
  // A folder with no git repository used to collapse into the zeroed 200
  // shape (branch null, every count 0), which every reader mapped onto
  // "branch detached · working tree clean" — two fabricated facts about a
  // folder with no repository. The status read must carry the absence as
  // its own typed field so the surface can say "not under version
  // control" (the custody room's own wording) instead.

  test("(b behavioral) getGitStatus answers repository:false for a non-repo — the typed absence, never a zeroed success", async () => {
    const nonRepo = "/tmp/r13-owned-nonrepo";
    const grantDb = {
      getProjectByPath: async (path: string) =>
        path === nonRepo ? { id: "p1", name: "n", path: nonRepo, user_id: "user-a" } : null,
      projectAtPath: async (path: string) =>
        path === nonRepo ? { id: "p1", userId: "user-a" } : null,
    } as unknown as AsyncDbClient;
    const gate = await makeFsGate("user-a", grantDb, nonRepo);
    const status = getGitStatus(nonRepo, gate);
    expect(status.repository, "a folder with no repository must say so, not read as a detached clean one").toBe(false);
    expect(status.branch).toBeNull();
    expect(status.entries).toEqual([]);
  });

  test("(b behavioral) a REAL repository answers repository:true (the field distinguishes, it does not vanish)", async () => {
    // A real throwaway repository, initialized in the owner's temp dir — the
    // repo this suite runs in is self-protected (the bridge refuses to run
    // git against the harness's own tree), so the positive half of the typed
    // fact needs its own subject. createTempDir registers the removal.
    const dir = createTempDir("git-owner-repo-");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const status = getGitStatus(dir);
    expect(status.repository, "a working repository must read as one").toBe(true);
  });
});

// ── (e) the git-log cap is the single config owner ──

describe("Git bridge owner — git-log cap is a single config owner (no scattered literal)", () => {
  test("no server file defines a scattered MAX_LOG_ENTRIES literal (config owns the cap)", () => {
    // Match a DEFINITION (`const/let MAX_LOG_ENTRIES`) with comments
    // stripped — the violation is re-introducing the named constant.
    const scattered = SERVER_TS
      .filter((f) => /(?:const|let)\s+MAX_LOG_ENTRIES\b/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SERVER_ROOT, f));
    expect(scattered).toEqual([]);
  });

  test("config.ts owns gitMaxLogEntries + gitLogDefaultEntries (the single cap + default)", () => {
    const configSrc = readFileSync(join(SERVER_ROOT, "kernel/config.ts"), "utf8");
    expect(configSrc).toContain("gitMaxLogEntries");
    expect(configSrc).toContain("gitLogDefaultEntries");
    expect(configSrc).toContain("DEFAULT_GIT_MAX_LOG_ENTRIES");
    expect(configSrc).toContain("DEFAULT_GIT_LOG_DEFAULT_ENTRIES");
  });

  test("git-ops-bridge.ts caps getLog via serverConfig.gitMaxLogEntries (the config owner, not a local literal)", () => {
    const src = readFileSync(join(SERVER_ROOT, "intelligence/git-ops-bridge.ts"), "utf8");
    expect(src).toContain("serverConfig.gitMaxLogEntries");
    expect(src).toContain("serverConfig.gitLogDefaultEntries");
  });

  test("the route + the LLM tool no longer re-cap with a scattered 100/50/20 literal (bridge is the only capper)", () => {
    const routeSrc = readFileSync(join(SERVER_ROOT, "routes/git-ops.ts"), "utf8");
    expect(routeSrc).not.toMatch(/Math\.min\([^)]*\b100\b/);
    expect(routeSrc).toContain("serverConfig.gitLogDefaultEntries");
    const execSrc = readFileSync(join(SERVER_ROOT, "tools/tool-executor.ts"), "utf8");
    expect(execSrc).not.toMatch(/Math\.min\([^)]*args\.max[^)]*\b100\b/);
    expect(execSrc).toContain("serverConfig.gitLogDefaultEntries");
  });

  test("the tool manifest's git_log maximum derives from the config owner (no scattered 100)", () => {
    const manifestSrc = readFileSync(join(SERVER_ROOT, "tools/tools-bridge.ts"), "utf8");
    expect(manifestSrc).toContain("maximum: serverConfig.gitMaxLogEntries");
  });
});

// ── (f) behavioral: ref argument-injection guard ──

describe("Git bridge owner — ref argument-injection guard", () => {
  test("(f) a ref starting with '-' is rejected before git runs (prevents git diff --output=FILE writes)", () => {
    // No gate + a non-repo path: the ref guard runs AFTER the (absent)
    // gate check + BEFORE isGitRepo, so the guard fires regardless of
    // whether the path is a real repo.
    const canary = "/tmp/bridlewise/r13-injection-canary";
    expect(() => getDiffSummary("/tmp/r13-anything", "--output=" + canary)).toThrow(BadRequestError);
    expect(() => getDiffPatch("/tmp/r13-anything", undefined, "--output=" + canary)).toThrow(BadRequestError);
    // The guard prevented the call → git never ran → no canary file written.
    expect(existsSync(canary)).toBe(false);
  });

  test("a normal ref (or no ref) does NOT trip the guard", () => {
    // Non-repo path → isGitRepo false → empty/null (no throw, no injection guard).
    expect(() => getDiffSummary("/tmp/r13-anything", "HEAD")).not.toThrow();
    expect(() => getDiffSummary("/tmp/r13-anything", "main")).not.toThrow();
    expect(() => getDiffSummary("/tmp/r13-anything", undefined)).not.toThrow();
  });
});

// ── (g) behavioral: getBranches remote detection (bug fix) ──

describe("Git bridge owner — getBranches remote detection (bug fix)", () => {
  /** A committed repository (the shared fixture owner: its own identity, and
   * every git step checked, so a broken fixture fails AS a fixture). */
  function makeTempRepo(): TempGitRepo {
    const repo = createTempGitRepo("r13-branches-");
    writeFileSync(join(repo.dir, "a.txt"), "a\n");
    repo.git("add", "a.txt");
    repo.git("commit", "-q", "-m", "init");
    repo.git("rev-parse", "--verify", "HEAD");
    return repo;
  }

  test("(g) remote-tracking branches are detected as remote (was ALWAYS false before )", () => {
    const { dir, git } = makeTempRepo();
    try {
      // Simulate a fetched remote-tracking branch (refs/remotes/origin/main).
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const branches = getBranches(dir);
      const remoteBranch = branches.find((b) => b.name === "origin/main");
      expect(remoteBranch, "remote-tracking branch origin/main must be listed").toBeDefined();
      // fix: was ALWAYS false (the short name has no `remotes/` prefix,
      // so the old `line.includes("remotes/")` never matched).
      expect(remoteBranch!.remote).toBe(true);
      // A local branch (main or master, depending on git default) is NOT remote.
      const local = branches.find((b) => b.name === "main" || b.name === "master");
      expect(local, "the local HEAD branch must be listed").toBeDefined();
      expect(local!.remote).toBe(false);
    } finally {
    }
  });

  test("(g2) the origin/HEAD symref is excluded (was a bogus 'origin' branch in the list)", () => {
    const { dir, git } = makeTempRepo();
    try {
      // Simulate a fetched remote with a HEAD symref (GitHub clones carry
      // refs/remotes/origin/HEAD -> origin/main). git shortens its short
      // name to the BOGUS `origin` (not `origin/HEAD`), so without the
      // symref filter the branch list contained a phantom `origin` entry
      // that does not name a real branch.
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const branches = getBranches(dir);
      // The symref must NOT appear — it is a pointer, not a checkout-able branch.
      expect(
        branches.find((b) => b.name === "origin"),
        "the bogus origin/HEAD symref (shortened to 'origin') must be filtered out",
      ).toBeUndefined();
      expect(
        branches.find((b) => b.name === "origin/HEAD"),
        "the origin/HEAD symref must be filtered out",
      ).toBeUndefined();
      // The real remote-tracking branch is still listed.
      expect(branches.find((b) => b.name === "origin/main"), "origin/main must still be listed").toBeDefined();
    } finally {
    }
  });

  test("isGitRepo + getProjectGitStatus behave on a real repo (smoke)", () => {
    const { dir } = makeTempRepo();
    try {
      expect(isGitRepo(dir)).toBe(true);
      expect(isGitRepo("/tmp/r13-definitely-not-a-repo-" + Date.now())).toBe(false);
      const status = getProjectGitStatus(dir);
      expect(status).not.toBeNull();
      expect(typeof status!.dirtyFiles).toBe("number");
    } finally {
    }
  });
});

// ── Mutation verification (WORKFLOW.md §9) ──

/**
 * A PLANT THAT ENTERS THROUGH THE SCAN'S DOOR, NOT THROUGH THE FILESYSTEM.
 *
 * ── WHAT THIS REPLACES, AND WHAT IT COST ─────────────────────────────────
 *
 * These three mutations used to APPEND to a live tracked source file
 * (`server/worker-ipc.ts`), assert, and restore it in a `finally`. Two things
 * were wrong with that, and the second one destroyed a file.
 *
 * 1. `no-scattered-helpers.test.ts` used THE SAME live file as its canary,
 *    and vitest runs test FILES in parallel forks. Two processes each doing
 *    read → truncating write → restore on one path interleave, and
 *    `writeFileSync` truncates before it writes: a `readFileSync` landing in
 *    that window returns the EMPTY STRING. `original` then holds `""`, and
 *    the `finally` faithfully restores nothing.
 *
 * 2. Measured on this tree: `server/worker-ipc.ts` was left at ZERO BYTES by
 *    a suite run, and it surfaced only because ten downstream tests import
 *    it. Had the canary been a file nothing imports, the run would have been
 *    GREEN with a first-party source file emptied on disk, and the next
 *    commit would have recorded the deletion. A test that proves a scan by
 *    performing the real mutation must not perform it on shared state
 *    another concurrent run can touch — and a live source file is the most
 *    shared state there is.
 *
 * The scans' universe is a FILE LIST, so the plant does not need to be inside
 * `server/` at all: it is written to a private temporary directory and passed
 * to the scan as an extra member of its population. Nothing under `server/`
 * is opened for writing, no other concurrently-running guard can see the
 * plant, and a crash mid-test leaves a temp file rather than a hole in the
 * repository.
 */
const CANARY_BASENAME = "planted-canary.ts";

function withPlantedFile<T>(source: string, body: (population: readonly string[]) => T): T {
  // A FRESH DIRECTORY PER CALL, from the suite's temp-dir owner, so two tests
  // — in this file or any other — can never name the same path.
  const canaryPath = join(createTempDir("git-bridge-canary-"), CANARY_BASENAME);
  writeFileSync(canaryPath, source);
  return body([...SERVER_TS, canaryPath]);
}

/** Did the scan report the planted file, whatever relative path it got? */
function includesCanary(paths: readonly string[]): boolean {
  return paths.some((p) => p.endsWith(CANARY_BASENAME));
}

describe("Git bridge owner — mutation verification (the scan catches regressions)", () => {
  test("re-introducing a direct git spawn outside the bridge makes the spawn-scan FAIL", () => {
    withPlantedFile('const _r13 = spawnSync("git", ["status"]);\n', (population) => {
      const files = population
        .filter((f) => GIT_SPAWN_RE.test(readFileSync(f, "utf8")))
        .map((f) => relative(SERVER_ROOT, f));
      // The canary alone → 1, where the live tree measures 0, so the (a)
      // assertion would now FAIL. The bridge is no longer among them: it
      // invokes git through the confinement owner, not with its own spawn.
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(includesCanary(files), "the planted spawn must be reported").toBe(true);
      expect(files).not.toContain("intelligence/git-bridge.ts");
    });
    // AND THE CONTROL: with the plant gone, the live tree measures zero. A
    // mutation that never changed an answer proves nothing about the guard.
    expect(SERVER_TS.filter((f) => GIT_SPAWN_RE.test(readFileSync(f, "utf8"))).length).toBe(0);
  });

  test("re-introducing a duplicate isGitRepo definition makes the one-owner scan FAIL", () => {
    withPlantedFile("function isGitRepo(_p: string): boolean { return false; }\n", (population) => {
      const defs = filesDefining("isGitRepo", population);
      // git-bridge.ts + the canary → 2 (the (d) assertion would now FAIL).
      expect(defs.length).toBe(2);
      expect(defs).toContain("intelligence/git-bridge.ts");
      expect(includesCanary(defs), "the planted definition must be reported").toBe(true);
    });
    expect(filesDefining("isGitRepo").length).toBe(1);
  });

  test("re-introducing a scattered MAX_LOG_ENTRIES literal makes the cap-scan FAIL", () => {
    withPlantedFile("const MAX_LOG_ENTRIES = 100;\n", (population) => {
      const scattered = population
        .filter((f) => /\bMAX_LOG_ENTRIES\b/.test(readFileSync(f, "utf8")))
        .map((f) => relative(SERVER_ROOT, f));
      expect(includesCanary(scattered), "the planted literal must be reported").toBe(true);
      expect(scattered.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── Config sanity (the cap/default are sane + wired) ──

describe("Git bridge owner — config wiring sanity", () => {
  test("serverConfig.gitMaxLogEntries + gitLogDefaultEntries are positive integers", () => {
    expect(Number.isInteger(serverConfig.gitMaxLogEntries)).toBe(true);
    expect(Number.isInteger(serverConfig.gitLogDefaultEntries)).toBe(true);
    expect(serverConfig.gitMaxLogEntries).toBeGreaterThanOrEqual(1);
    expect(serverConfig.gitLogDefaultEntries).toBeGreaterThanOrEqual(1);
  });

  test("gitText is exported from git-bridge.ts (the single git-spawn owner) + is callable", () => {
    // Importability + callability smoke: gitText on a non-repo returns null.
    expect(typeof gitText).toBe("function");
    expect(typeof isGitRepo).toBe("function");
    expect(gitText("/tmp/r13-not-a-repo-" + Date.now(), ["rev-parse", "--is-inside-work-tree"])).toBeNull();
  });
});
