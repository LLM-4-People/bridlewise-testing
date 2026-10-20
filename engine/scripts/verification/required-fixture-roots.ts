/**
 * THE FIXTURE CORPORA THIS SUITE NEEDS AND GIT DOES NOT CARRY.
 *
 * Some tests measure real code at real scale — a parser against Babel, a
 * walker against Express — and those corpora are vendored, gitignored, and
 * far too large to track. Git therefore cannot tell anyone they are missing:
 * a fresh clone, a new worktree, or a history-preserving migration produces a
 * tree that looks complete and is not.
 *
 * WHY THIS FILE EXISTS, MEASURED. At the monorepo assembly (2026-07-30) the
 * 4.1 GB `large-codebases/` corpus did not come across, because the assembly
 * moved tracked files and this one is ignored by design. Nothing said so. The
 * engine suite ran 18 minutes, produced NO receipt, and died in `epoll_wait`
 * with zero CPU; a second run did the same in 3. The absence was knowable in
 * milliseconds and cost two runs and a wrong diagnosis instead.
 *
 * So the requirement is DECLARED here, and checked before the first test runs.
 * Two rules keep the declaration honest:
 *
 *   - It is checked at the START of a run, not at the point of use. A
 *     prerequisite discovered halfway through has already wasted the run.
 *   - The refusal names the path AND where the corpus comes from, because
 *     "missing" without "here is how to have it" is a dead end, and this is
 *     exactly the moment someone is looking at an unfamiliar tree.
 *
 * The pool that consumes these roots refuses an absent one too
 * (`worker_pool_root_absent`) — that is the choke point for code paths, this
 * is the choke point for the run. Neither replaces the other: the pool cannot
 * speak before a test reaches it, and this cannot see a root invented later.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type RequiredFixtureRoot = Readonly<{
  /** Repository-relative path, as the tests that read it resolve it. */
  path: string;
  /** What stops working without it — stated in what a reader loses, not in file names. */
  purpose: string;
  /** How to obtain it. A refusal without a way forward is a dead end. */
  provenance: string;
  /**
   * The README that documents this root, repo-relative. The corpus is
   * gitignored, so its README is untracked-by-design and the freshness census
   * (which derives from the tracked index) can never see it. This declaration
   * is the honest backstop: a required root must carry its README, and the
   * check below refuses when the root exists but its README is gone — so the
   * documentation cannot silently rot or vanish on a corpus re-vendor.
   */
  readme: string;
}>;

export const REQUIRED_FIXTURE_ROOTS: readonly RequiredFixtureRoot[] = Object.freeze([
  Object.freeze({
    path: "large-codebases",
    purpose:
      "the real-scale corpora the concurrency, parser and walker tests measure against — " +
      "without them those tests cannot answer, and some wait rather than fail",
    provenance:
      "vendored, gitignored (~4.1 GB). The public path is `npm run corpus:fetch`: it materialises the " +
      "pinned subset in `engine/test/fixtures/corpus-manifest.json` outside the tree and links it here. " +
      "A full private copy can also be symlinked instead.",
    readme: "large-codebases/README.md",
  }),
]);

export type FixtureRootVerdict = Readonly<{
  ok: boolean;
  missing: readonly RequiredFixtureRoot[];
  /** Roots that exist but whose declared README is absent — documentation rot. */
  missingReadme: readonly RequiredFixtureRoot[];
  message: string | null;
}>;

/**
 * PURE over the filesystem answers it is handed, so a test can drive every arm
 * without planting 4 GB anywhere: the caller says which roots exist.
 */
export function judgeFixtureRoots(
  declared: readonly RequiredFixtureRoot[],
  exists: (path: string) => boolean,
): FixtureRootVerdict {
  const missing = declared.filter((root) => !exists(root.path));
  // A root that exists but whose README is gone: the corpus is present, its
  // documentation is not. Distinct from an absent root — the run can proceed,
  // but the README is untracked, so only this check stands between it and rot.
  const missingReadme = declared.filter((root) => exists(root.path) && !exists(root.readme));
  if (missing.length === 0 && missingReadme.length === 0) {
    return Object.freeze({ ok: true, missing: [], missingReadme: [], message: null });
  }
  const lines = missing.map(
    (root) => `  ${root.path} — ${root.purpose}\n    how to get it: ${root.provenance}`,
  );
  const readmeLines = missingReadme.map(
    (root) =>
      `  ${root.readme} — the README documenting ${root.path} is absent while the corpus is ` +
      `present. It is untracked by design (the corpus is gitignored), so nothing else reports its ` +
      `loss. Restore it from the corpus source.`,
  );
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `${missing.length} declared fixture root(s) are absent, so the suite was not run.\n` +
        `${lines.join("\n")}\n` +
        `These are gitignored by design: git cannot report them missing, which is why they are ` +
        `declared here. Provide them, or remove the declaration if the tests that need them are gone.`,
    );
  }
  if (readmeLines.length > 0) {
    parts.push(
      `${readmeLines.length} fixture root(s) are present but their README is absent:\n` + readmeLines.join("\n"),
    );
  }
  return Object.freeze({
    ok: false,
    missing: Object.freeze(missing),
    missingReadme: Object.freeze(missingReadme),
    message: parts.join("\n"),
  });
}

/** The run's own check: resolve against `root` and ask the real filesystem. */
export function checkRequiredFixtureRoots(root: string): FixtureRootVerdict {
  return judgeFixtureRoots(REQUIRED_FIXTURE_ROOTS, (path) => existsSync(resolve(root, path)));
}
