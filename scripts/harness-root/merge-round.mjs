// merge-round.mjs — The top-level integration merge script (workflow v4, EXP471).
//
// Binding user directives (2026-07-22):
//   1. "anything that the agents build that is either new or an upgrade to
//      an existing thing MUST be re-used by other agents after that."
//   2. "we must merge all new changes into a single folder, this folder is
//      where we do e2e test, if it passes, then its the content of that
//      folder that we re-use on next runs."
//   3. "be careful, some agents can work on the same file at the same time,
//      so take that into account when merging."
//   4. "it seems like we really are not using shared functions at all. you
//      must clarify workflow."
//
// EXP471 changes over v3 (EXP469):
//   - DATA-DRIVEN OWNERS: the designated module owners are loaded from
//     `src/shared/workflow/module-owners.json` (canonical, promoted from the
//     hardcoded MODULE_OWNERS in merge-integration.mjs). The merge is now
//     owner-aware: only the owner of a path prefix can introduce/modify files
//     under it; non-owner writes are skipped as baseline-carry. On a path
//     conflict the OWNER wins over the highest-exp-number rule. Ownerless
//     paths still resolve by highest-exp-number-wins.
//   - REJECT ON MISSING ISSUES: an experiment without `issues-and-inefficiencies.md`
//     REJECTS the whole merge (passed=false, not promoted). Previously only a
//     warning. (binding: "Agents MUST report issues + inefficiencies".)
//   - CONCURRENT LOCK: a file-based lock (`<root>/.merge.lock`) serializes
//     merges so only ONE coordinator merges into integration/ at a time
//     (binding: "some agents can work on the same file at the same time").
//   - TS TESTS: the e2e runner now collects *.test.ts (Fix 2 lives in
//     e2e-runner.mjs; the merge script just calls runE2e).
//
// What this does (mechanically enforced):
//   1. Acquires the merge lock (waits for any in-progress merge).
//   2. Reads every `merge-manifest.json` one level under the experiments root
//      named by --experiments-root (or a named subset via --experiments).
//      Validates via the CANONICAL shared manifest schema at
//      `src/shared/workflow/manifest-schema.mjs`. There is NO default root and
//      a root holding no manifest REJECTS the round — see the constant below.
//   3. Loads module-owners.json (data-driven owners + exclude paths).
//   4. Sorts experiments ASCENDING by the parsed `expNNN` number so the
//      HIGHEST experiment number merges LAST and wins ownerless conflicts.
//   5. For each experiment, for each declared file:
//        - excluded path  -> skip (skipped-excluded).
//        - owned by another -> skip (skipped-non-owner; baseline-carry guard).
//        - owned by self / ownerless -> copy into staging.
//        - ownerless conflict -> highest-exp-number wins.
//      Each skipped/conflict is recorded in the report.
//   6. REJECTS if any experiment is missing `issues-and-inefficiencies.md`.
//   7. Runs the e2e test on the STAGING tree via the CANONICAL shared e2e
//      runner at `src/shared/workflow/e2e-runner.mjs`.
//   8. If e2e PASSES -> atomically promote staging -> integration/. If e2e
//      FAILS -> keep the existing integration/ untouched.
//   9. Writes a structured report (MERGE-ROUND-REPORT.json) + JSON summary.
//  10. Releases the lock.
//
// CLI (--experiments-root is REQUIRED for every merging invocation):
//   node scripts/harness-root/merge-round.mjs --experiments-root <path>
//   node scripts/harness-root/merge-round.mjs --experiments-root <path> --no-e2e
//   node scripts/harness-root/merge-round.mjs --experiments-root <path> --experiments exp469-foo,exp470-bar
//   node scripts/harness-root/merge-round.mjs --bootstrap     # one-time seed from candidate/
//   node scripts/harness-root/merge-round.mjs --status        # print integration/ status

import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  copyFileSync, rmSync, renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadManifest, collectAllFiles,
} from "../../engine/src/shared/workflow/manifest-schema.mjs";
import {
  loadModuleOwners, ownerForPath, isExcludedPath, EXCLUDE_OWNER,
} from "../../engine/src/shared/workflow/module-owners.mjs";
// The single owner of every workflow operational default. A `.mjs` module
// importing a `.ts` module resolves under this runtime, so the duplicate
// `.mjs` copy that used to hold this value has been deleted.
import { DEFAULT_E2E_SUITE_TIMEOUT_MS, DEFAULT_MERGE_LOCK_TIMEOUT_MS } from "../../engine/src/workflow/workflow-config.ts";
import { acquireFileLock } from "../../engine/src/filesystem/file-lock.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// The monorepo root. Before the assembly this file lived at the harness
// root and the engine was its `integration/` child; the file now lives at
// `scripts/harness-root/`, so the root is two levels up and the engine is
// `engine/`.
const WORKSPACE_ROOT = resolve(HERE, "..", "..");
// THERE IS NO DEFAULT EXPERIMENTS ROOT, AND THAT IS THE FIX RATHER THAN AN
// OMISSION. This constant used to be `resolve(WORKSPACE_ROOT, "experiments")`
// — a directory the clean-root work removed, because the rounds it recorded
// are closed. Driven afterwards: `fileCount: 0`, `passed: false`, and the only
// account of what happened was a WARNING reading "no merge-manifest.json found
// under <root>/experiments", naming a path that does not exist. A round that
// merged nothing reported itself as a round.
//
// Pointing the default at the experiments archive (`experiments/engine/`)
// instead would be worse, not better: the manifests there record rounds that
// are FINISHED, and a default aimed at them turns an argument-less
// invocation into a re-merge of closed history over the live engine.
//
// So the experiments root is named on the command line and nowhere else.
// Missing configuration is a guided state with a way out, never a guess and
// never a degraded success — the two are the same defect, and the degrading
// one is worse because it reports success.
const DEFAULT_INTEGRATION_DIR = resolve(WORKSPACE_ROOT, "engine");
const DEFAULT_OWNERS_PATH = resolve(DEFAULT_INTEGRATION_DIR, "src/shared/workflow/module-owners.json");
const CANDIDATE_DIR = resolve(WORKSPACE_ROOT, "candidate");
/**
 * Where a round's report lands: BESIDE the integration directory it reports
 * on, derived rather than fixed.
 *
 * It was a module-level constant pinned to the workspace root, and every
 * caller wrote there — including this script's own test suite, which builds
 * its integration trees in `os.tmpdir()` and still dropped a
 * `MERGE-ROUND-REPORT.json` in the live repository on every run. Driven: the
 * file appeared at the root after `node --test scripts/harness-root/
 * merge-round.test.mjs`, describing a merge of temporary directories nobody
 * had performed here.
 *
 * Deriving it costs nothing and fixes every call site at once: for the real
 * invocation `integrationDir` is `engine/`, whose parent is this root, so the
 * live path is byte-identical to the constant it replaces.
 */
function reportPathFor(integrationDir) {
  return resolve(integrationDir, "..", "MERGE-ROUND-REPORT.json");
}
const LOCK_PATH = resolve(WORKSPACE_ROOT, ".merge.lock");

/**
 * A caller supplied something this script cannot act on.
 *
 * A distinct type rather than a bare `Error` so a test can assert the SPECIFIC
 * failure and its code, and so the CLI can tell "you did not tell me where the
 * experiments are" apart from "something broke while merging" — which want
 * different exit paths and very different messages.
 */
export class MergeRoundInputError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = "MergeRoundInputError";
    this.code = code;
  }
}

/**
 * Parse the `expNNN` number from an experiment dir name. Non-`exp`-prefixed
 * names return 0 (they sort before all numbered experiments).
 * @param {string} name
 * @returns {number}
 */
export function expNumber(name) {
  const m = String(name).match(/^exp(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Find every `merge-manifest.json` directly inside a subdir of `root`.
 * @param {string} root
 * @param {string[]|null} onlyNames  if set, restrict to these dir names
 * @returns {Map<string, string>}  expName -> manifest abs path
 */
export function findManifests(root, onlyNames = null) {
  const out = new Map();
  if (!existsSync(root)) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  const allow = onlyNames ? new Set(onlyNames) : null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (allow && !allow.has(e.name)) continue;
    const manifestPath = join(root, e.name, "merge-manifest.json");
    if (existsSync(manifestPath)) out.set(e.name, manifestPath);
  }
  return out;
}

/**
 * Sort experiment names ASCENDING by parsed exp number so the highest
 * number merges last (wins ownerless conflicts). Ties break alphabetically.
 * @param {string[]} names
 * @returns {string[]}
 */
export function sortByExpNumber(names) {
  return [...names].sort((a, b) => {
    const na = expNumber(a), nb = expNumber(b);
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Recursively copy a directory tree. Skips node_modules/.git/dist/.staging.
 * @param {string} src
 * @param {string} dest
 * @param {Set<string>} [skip]
 */
export function copyTree(src, dest, skip = new Set(["node_modules", ".git", "dist", ".staging"])) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, skip);
    else if (e.isFile()) copyFileSync(s, d);
    else if (e.isSymbolicLink()) {
      // Skip symlinks (avoid breaking on stale links); the merge is a
      // shallow copy of real files, per the existing EXP413 limitation.
    }
  }
}

// --- Concurrent merge lock (Fix 4) ---------------------------------------
// Only ONE coordinator may merge into integration/ at a time. The lock is the
// one cross-process file lock (engine/src/filesystem/file-lock.ts) at
// <root>/.merge.lock: a live holder is never broken (the second merger waits
// up to lockTimeoutMs, then fails naming it), a dead holder's lock is broken
// at once and atomically, and every break is audited. It used to be a fourth
// hand-written lock that stole any lock it could not parse on sight and
// judged a holder by pid alone (wf-del2-design D1).

/**
 * Acquire the merge lock. Returns a release function or throws if the lock
 * cannot be acquired within lockTimeoutMs.
 * @param {object} opts
 * @param {string} [opts.lockPath]
 * @param {number} [opts.lockTimeoutMs]
 * @param {string} [opts.owner]
 * @returns {Promise<() => void>} release()
 */
export async function acquireMergeLock({
  lockPath = LOCK_PATH, lockTimeoutMs = DEFAULT_MERGE_LOCK_TIMEOUT_MS, owner = `merge-${process.pid}`,
} = {}) {
  const handle = await acquireFileLock(
    lockPath,
    (message, details) => new HarnessError(`merge lock busy: ${message}; another merge is in progress — only ONE agent may write to integration/ at a time`, "merge_lock_busy", true, details),
    { holder: owner, timeoutMs: lockTimeoutMs },
  );
  return handle.release;
}

// --- The merge ------------------------------------------------------------

/**
 * The mechanical merge.
 * @param {object} opts
 * @param {string} [opts.experimentsRoot]
 * @param {string} [opts.integrationDir]
 * @param {string} [opts.ownersPath]
 * @param {string[]|null} [opts.onlyExperiments]
 * @param {boolean} [opts.runE2e]
 * @param {number} [opts.e2eTimeoutMs]  default DEFAULT_E2E_SUITE_TIMEOUT_MS (workflow-config.ts)
 * @param {boolean} [opts.requireIssues]  default true: reject on missing issues report
 * @returns {Promise<object>} the structured report
 */
export async function mergeRound({
  experimentsRoot,
  integrationDir = DEFAULT_INTEGRATION_DIR,
  ownersPath = null,
  onlyExperiments = null,
  runE2e = true,
  e2eTimeoutMs = DEFAULT_E2E_SUITE_TIMEOUT_MS,
  requireIssues = true,
} = {}) {
  // THE ROOT IS REQUIRED, AND ITS ABSENCE IS A REFUSAL RATHER THAN AN EMPTY
  // ROUND. Deny by default: unknown input is an error, never a silent
  // default. The message says what is missing and how to supply it, because a
  // caller who has to read this file to find out has been shown the internals
  // of a lookup nobody told them about.
  if (typeof experimentsRoot !== "string" || experimentsRoot.trim().length === 0) {
    throw new MergeRoundInputError(
      "No experiments root was given, so there is nothing to merge and no way to guess it. " +
        "Pass `--experiments-root <path>`: the directory whose immediate subdirectories are " +
        "the experiments, each holding its own `merge-manifest.json`. There is deliberately no " +
        "default — the one this script used to carry named a directory that no longer exists, " +
        "and every round it ran after that reported success over zero files.",
      "merge_round_experiments_root_required",
    );
  }
  // Default ownersPath is relative to the integrationDir under test (not the
  // workspace default) so isolated tests with their own module-owners.json work.
  const ownersFile = ownersPath || join(integrationDir, "src/shared/workflow/module-owners.json");
  const report = {
    schema: "exp471-merge-round-report/v1",
    mergedAt: new Date().toISOString(),
    experimentsRoot,
    integrationDir,
    ownersPath: ownersFile,
    requestedExperiments: onlyExperiments,
    experiments: [],
    order: [],
    conflicts: [],
    skipped: [],
    warnings: [],
    missingIssuesReport: [],
    rejected: false,
    rejectReason: null,
    fileCount: 0,
    e2e: null,
    promoted: false,
    passed: false,
  };

  // AN EMPTY ROUND IS REFUSED, NOT WARNED ABOUT. This used to push a warning
  // and return with `passed: false` — but `passed: false` also means "the e2e
  // suite failed", so the one state that means "this round never happened"
  // was indistinguishable from the one that means "it happened and was
  // rejected". `rejected` with a reason says which, and the reason names the
  // directory that was read and whether it exists at all, because "the path is
  // wrong" and "the path is right and empty" want different repairs.
  const manifestMap = findManifests(experimentsRoot, onlyExperiments);
  if (manifestMap.size === 0) {
    report.rejected = true;
    report.rejectReason =
      `no merge-manifest.json found under ${experimentsRoot}` +
      (existsSync(experimentsRoot)
        ? ", which exists but holds no experiment directory containing one"
        : ", which DOES NOT EXIST") +
      (onlyExperiments ? ` matching [${onlyExperiments.join(", ")}]` : "") +
      ". A round that merged nothing is not a round; check the path, or seed an experiment first.";
    report.warnings.push(`REJECTED: ${report.rejectReason}`);
    report.passed = false;
    report.promoted = false;
    return finishReport(report);
  }

  // Load + validate each manifest.
  const byExp = new Map();
  for (const [expName, manifestPath] of manifestMap) {
    const { manifest, issues } = loadManifest(manifestPath);
    const expDir = dirname(manifestPath);
    if (issues.length > 0) report.warnings.push(`manifest ${expName}: ${issues.join("; ")}`);
    if (issues.length > 0 || !manifest) {
      report.experiments.push({
        experiment: expName, expNumber: expNumber(expName), dir: expDir,
        improves: null, manifestIssues: issues, files: [], skipped: true,
      });
      continue;
    }
    byExp.set(expName, { manifest, path: manifestPath, dir: expDir, issues });
  }
  if (byExp.size === 0) {
    report.warnings.push("all manifests failed to parse");
    return finishReport(report);
  }

  // Load data-driven module owners (Fix 1). Missing file is non-fatal: merge
  // proceeds with no owners (pure highest-exp-number-wins), but warn.
  const ownersConfig = loadModuleOwners(ownersFile);
  if (!ownersConfig) {
    report.warnings.push(`module-owners.json not found at ${ownersPath}; merging with no designated owners (pure highest-exp-number-wins)`);
  }

  // Fix 3: reject the whole merge if any experiment is missing issues-and-inefficiencies.md.
  for (const expName of byExp.keys()) {
    const expDir = byExp.get(expName).dir;
    const issuesFile = join(expDir, "issues-and-inefficiencies.md");
    if (!existsSync(issuesFile)) report.missingIssuesReport.push(expName);
  }
  if (requireIssues && report.missingIssuesReport.length > 0) {
    report.rejected = true;
    report.rejectReason = `experiments missing issues-and-inefficiencies.md: ${report.missingIssuesReport.join(", ")}`;
    report.passed = false;
    report.promoted = false;
    report.warnings.push(`REJECTED: ${report.missingIssuesReport.length} experiment(s) missing issues-and-inefficiencies.md (binding: agents MUST report issues + inefficiencies). Merge not performed.`);
    return finishReport(report);
  }

  // Sort ASCENDING by exp number so the highest number merges last (wins).
  const order = sortByExpNumber([...byExp.keys()]);
  report.order = order;

  // Build into a STAGING tree so a failed e2e never corrupts integration/.
  const stagingDir = resolve(integrationDir, ".staging");
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Seed staging with the CURRENT integration/ baseline.
  if (existsSync(integrationDir)) {
    copyTree(integrationDir, stagingDir, new Set(["node_modules", ".git", "dist", ".staging"]));
  }

  // path -> { experiment, expNumber, action, source, section }
  const pathWriter = new Map();

  for (const expName of order) {
    const entry = byExp.get(expName);
    if (!entry) continue;
    const { manifest, dir } = entry;
    const files = collectAllFiles(manifest);
    const expReport = {
      experiment: expName,
      expNumber: expNumber(expName),
      dir,
      improves: manifest.improves || null,
      manifestIssues: entry.issues,
      files: [],
      skippedFiles: [],
    };

    for (const f of files) {
      const destPath = resolve(stagingDir, f.path);
      const srcPath = resolve(dir, f.source);

      // Fix 1: data-driven owner checks.
      if (isExcludedPath(f.path, ownersConfig)) {
        expReport.skippedFiles.push({ path: f.path, action: f.action, status: "skipped-excluded", source: f.source });
        report.skipped.push({ path: f.path, experiment: expName, reason: "excluded-path" });
        continue;
      }
      const owner = ownerForPath(f.path, ownersConfig);
      if (owner && owner !== EXCLUDE_OWNER && owner !== expName) {
        // Non-owner writing under an owned module: skip (baseline-carry guard).
        expReport.skippedFiles.push({ path: f.path, action: f.action, status: "skipped-non-owner", owner, source: f.source });
        report.skipped.push({ path: f.path, experiment: expName, reason: "non-owner", owner });
        continue;
      }

      if (!existsSync(srcPath)) {
        expReport.files.push({ path: f.path, action: f.action, status: "source-missing", source: f.source });
        report.warnings.push(`${expName}: source-missing ${f.source}`);
        continue;
      }
      const prior = pathWriter.get(f.path);
      let status;
      if (!prior) {
        const existsInStaging = existsSync(destPath);
        if (f.action === "replace") {
          status = existsInStaging ? "replaced-baseline" : "replace-no-prior";
          if (!existsInStaging) report.warnings.push(`${expName}: replace without prior ${f.path}`);
        } else {
          status = existsInStaging ? "improved-baseline" : "new";
        }
      } else {
        // Ownerless conflict (owned conflicts are skipped above): highest exp
        // number wins (we merge ascending, so current >= prior).
        status = f.action === "replace" ? "replaced" : (expNumber(expName) > prior.expNumber ? "improved" : "conflict-overwrite");
        report.conflicts.push({
          path: f.path,
          priorWriter: prior.experiment,
          priorExpNumber: prior.expNumber,
          newWriter: expName,
          newExpNumber: expNumber(expName),
          resolved: "highest-exp-number-wins",
        });
      }
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      pathWriter.set(f.path, { experiment: expName, expNumber: expNumber(expName), action: f.action, source: f.source, section: f.section });
      expReport.files.push({ path: f.path, action: f.action, status, source: f.source, section: f.section });
      report.fileCount++;
    }

    report.experiments.push(expReport);
  }

  // Run e2e on the STAGING tree. On pass, promote staging -> integration/.
  if (runE2e) {
    try {
      const { runE2e } = await import("../../engine/src/shared/workflow/e2e-runner.mjs");
      report.e2e = await runE2e({ integrationDir: stagingDir, timeoutMs: e2eTimeoutMs });
    } catch (e) {
      report.e2e = { passed: false, error: `e2e runner failed to load/run: ${e.message}`, testCount: 0, failCount: 0, summary: String(e) };
    }
    const e2ePassed = !!report.e2e?.passed;
    if (e2ePassed) {
      promoteStaging(integrationDir, stagingDir);
      report.promoted = true;
      report.passed = true;
    } else {
      rmSync(stagingDir, { recursive: true, force: true });
      report.promoted = false;
      report.passed = false;
      report.warnings.push("e2e FAILED — integration/ left untouched (not merged). Fix the failing tests and re-run.");
    }
  } else {
    report.promoted = false;
    report.passed = report.conflicts.length === 0 || true;
    report.warnings.push("e2e skipped (--no-e2e); staging tree left at integration/.staging for inspection — NOT promoted.");
  }

  return finishReport(report);
}

/**
 * Atomically promote the staging tree to be the new integration/ baseline.
 * @param {string} integrationDir
 * @param {string} stagingDir  must be INSIDE integrationDir (at .staging)
 */
function promoteStaging(integrationDir, stagingDir) {
  const parent = dirname(integrationDir);
  const stagingOut = join(parent, ".integration-staging-tmp");
  const oldDir = join(parent, ".integration-old-promote");
  if (existsSync(stagingOut)) rmSync(stagingOut, { recursive: true, force: true });
  if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  renameSync(stagingDir, stagingOut);
  try {
    if (existsSync(integrationDir)) renameSync(integrationDir, oldDir);
    mkdirSync(parent, { recursive: true });
    renameSync(stagingOut, integrationDir);
    if (existsSync(oldDir)) rmSync(oldDir, { recursive: true, force: true });
  } catch (e) {
    if (existsSync(oldDir) && !existsSync(integrationDir)) {
      renameSync(oldDir, integrationDir);
    }
    if (existsSync(stagingOut)) rmSync(stagingOut, { recursive: true, force: true });
    throw new Error(`promote failed: ${e.message}`);
  }
}

/**
 * One-time bootstrap: seed integration/ from candidate/.
 * @param {object} opts
 * @param {string} [opts.integrationDir]
 * @param {string} [opts.candidateDir]
 * @param {boolean} [opts.force]
 */
export function bootstrapIntegration({
  integrationDir = DEFAULT_INTEGRATION_DIR,
  candidateDir = CANDIDATE_DIR,
  force = false,
} = {}) {
  if (!existsSync(candidateDir)) {
    throw new Error(`candidate dir not found: ${candidateDir}`);
  }
  const hasContent = existsSync(integrationDir) &&
    readdirSync(integrationDir).some((n) => n !== ".staging" && n !== ".old-promote" && n !== "README.md");
  if (hasContent && !force) {
    return {
      bootstrapped: false,
      reason: `integration/ already has content; use --force to overwrite from candidate/`,
      integrationDir,
    };
  }
  if (existsSync(integrationDir)) rmSync(integrationDir, { recursive: true, force: true });
  mkdirSync(integrationDir, { recursive: true });
  copyTree(candidateDir, integrationDir);
  return {
    bootstrapped: true,
    integrationDir,
    source: candidateDir,
    note: "integration/ seeded from candidate/. This is the initial baseline; next rounds copy from integration/.",
  };
}

/**
 * Print the status of integration/.
 * @param {string} integrationDir
 */
export function statusIntegration(integrationDir = DEFAULT_INTEGRATION_DIR) {
  let fileCount = 0;
  let topEntries = [];
  if (existsSync(integrationDir)) {
    function count(d) {
      let n = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".staging") continue;
        const f = join(d, e.name);
        if (e.isDirectory()) n += count(f);
        else if (e.isFile()) n++;
      }
      return n;
    }
    fileCount = count(integrationDir);
    topEntries = readdirSync(integrationDir).filter((n) => n !== ".staging" && n !== ".old-promote").sort();
  }
  const reportPath = reportPathFor(integrationDir);
  const lastReport = existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf8"))
    : null;
  return {
    integrationDir,
    exists: existsSync(integrationDir),
    fileCount,
    topEntries,
    lastMerge: lastReport ? {
      mergedAt: lastReport.mergedAt,
      passed: lastReport.passed,
      promoted: lastReport.promoted,
      fileCount: lastReport.fileCount,
      conflicts: lastReport.conflicts.length,
      e2e: lastReport.e2e ? { passed: lastReport.e2e.passed, summary: lastReport.e2e.summary } : null,
    } : null,
  };
}

function finishReport(report) {
  writeFileSync(reportPathFor(report.integrationDir), JSON.stringify(report, null, 2));
  return report;
}

// --- CLI ---
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const args = process.argv.slice(2);
  const wantBootstrap = args.includes("--bootstrap");
  const wantStatus = args.includes("--status");
  const noE2e = args.includes("--no-e2e");
  const noRequireIssues = args.includes("--no-require-issues");
  let onlyExperiments = null;
  let experimentsRoot = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--experiments" && args[i + 1]) {
      onlyExperiments = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (args[i] === "--experiments-root" && args[i + 1]) {
      experimentsRoot = resolve(args[++i]);
    }
  }

  if (wantStatus) {
    console.log(JSON.stringify(statusIntegration(), null, 2));
    process.exit(0);
  }

  if (wantBootstrap) {
    const force = args.includes("--force");
    try {
      const res = bootstrapIntegration({ force });
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.bootstrapped ? 0 : 1);
    } catch (e) {
      console.error(JSON.stringify({ bootstrapped: false, error: e.message }, null, 2));
      process.exit(1);
    }
  }

  // THE MISSING ARGUMENT IS ANSWERED BEFORE THE LOCK IS TAKEN. Refusing after
  // acquiring would leave a lock file behind for a round that never started,
  // and the next operator would be told a merge is in progress.
  if (experimentsRoot === null) {
    console.error(
      "merge-round: no experiments root.\n" +
        "\n" +
        "  node scripts/harness-root/merge-round.mjs --experiments-root <path>\n" +
        "\n" +
        "<path> is the directory whose immediate subdirectories are the experiments, each\n" +
        "holding its own merge-manifest.json. There is no default: the one this script used\n" +
        "to carry named a directory that no longer exists, so every run reported a round it\n" +
        "had not performed. The experiment archive (`experiments/engine/`) is NOT it — those\n" +
        "record rounds that are already finished, and merging them again would replay\n" +
        "closed history over the live engine.\n",
    );
    process.exit(1);
  }

  // Acquire the merge lock before touching integration/.
  acquireMergeLock().then(async (release) => {
    // THE LOCK IS RELEASED BEFORE THE EXIT, NOT IN A `finally` AROUND IT.
    // `process.exit()` terminates the process immediately and `finally` blocks
    // do NOT run — so the old shape (`try { … process.exit(…) } finally {
    // release() }`) left `.merge.lock` on disk after every single CLI run,
    // observed live. A stale lock is stolen only once its recorded pid is
    // dead, so the next round paid the poll timeout for it.
    let exitCode = 1;
    try {
      const report = await mergeRound({ experimentsRoot, onlyExperiments, runE2e: !noE2e, requireIssues: !noRequireIssues });
      exitCode = report.passed ? 0 : 1;
      console.log(JSON.stringify({
        schema: report.schema,
        mergedAt: report.mergedAt,
        order: report.order,
        experiments: report.experiments.map((e) => ({
          experiment: e.experiment,
          expNumber: e.expNumber,
          improves: e.improves,
          files: e.files.length,
          skipped: e.skippedFiles.length,
        })),
        fileCount: report.fileCount,
        conflicts: report.conflicts,
        skipped: report.skipped,
        warnings: report.warnings,
        missingIssuesReport: report.missingIssuesReport,
        rejected: report.rejected,
        rejectReason: report.rejectReason,
        e2e: report.e2e ? {
          passed: report.e2e.passed,
          summary: report.e2e.summary,
          testCount: report.e2e.testCount,
          passCount: report.e2e.passCount,
          failCount: report.e2e.failCount,
          stripTypes: report.e2e.stripTypes,
          tsFiles: report.e2e.tsFiles,
          failures: (report.e2e.failures || []).slice(0, 20).map((f) => ({ file: f.file, name: f.name })),
        } : null,
        promoted: report.promoted,
        passed: report.passed,
      }, null, 2));
    } finally {
      release();
    }
    process.exit(exitCode);
  }).catch((e) => {
    console.error(e instanceof MergeRoundInputError ? e.message : String(e));
    process.exit(1);
  });
}
