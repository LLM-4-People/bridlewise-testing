/**
 * A THROWAWAY GIT REPOSITORY FOR A TEST FIXTURE — hermetic about identity, and
 * loud when a fixture step fails.
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * Fixtures ran `git init` / `git commit` with the AMBIENT identity and did not
 * check the result. On a machine whose global config names no `user.name`,
 * the commit failed silently ("empty ident name"), HEAD never existed, every
 * later `update-ref HEAD` failed too, and the test reported a PRODUCT defect
 * (`getBranches` "found no origin/main") for what was a broken fixture. The
 * identity lived in six files as a copied three-line block, each spelling it
 * slightly differently.
 *
 * So the identity is set here, in the repository's own config (never the
 * environment: `GIT_AUTHOR_*` would override the config a test may be
 * asserting about), and every git step goes through `git`, which THROWS with
 * git's own stderr on a non-zero exit — a broken fixture fails as a fixture.
 * The directory comes from the temp-dir owner, so its removal is registered.
 *
 * HERMETIC about the ambient git too (a4-design M5): every step runs without
 * the caller's `GIT_*` variables — git exports `GIT_DIR`/`GIT_INDEX_FILE` to
 * hooks and linked worktrees, and an inherited one pointed `git init` and
 * `git config` at ANOTHER repository (the owner's `directoryGitEnvironment`)
 * — and without global or system config (an ambient `init.defaultBranch`,
 * `core.hooksPath`, `init.templateDir` or `tag.gpgsign` shaped the fixture).
 * The first branch is always named (`main` unless the caller names one).
 */
import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

import { directoryGitEnvironment } from "../../engine/src/git/git-door.ts";
import { createTempDir } from "./temp-dir.ts";
import { TEST_GIT_IDENTITY } from "../../engine/test/support/test-git-identity.ts";


export type TempGitRepo = Readonly<{
  /** The repository's working tree. */
  dir: string;
  /** Run git in `dir`; returns stdout, throws on a non-zero exit with git's stderr. */
  git: (...args: string[]) => string;
}>;

/** The environment of every fixture step: no inherited `GIT_*`, no global or system config (read per call: a test may set the environment first). */
function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  return { ...directoryGitEnvironment(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
}

/** Run git in `cwd`, returning stdout; a non-zero exit (or a spawn failure) throws with git's own words. */
function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: fixtureGitEnvironment() });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd} (status ${String(result.status)}): ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * A new repository under a registered temp directory, with the fixture
 * identity and unsigned commits configured locally. `initialBranch` names the
 * first branch (`main` when the caller names none — never an ambient default).
 */
export function createTempGitRepo(prefix: string, options: Readonly<{ initialBranch?: string }> = {}): TempGitRepo {
  const dir = createTempDir(prefix);
  const git = (...args: string[]): string => runGit(dir, args);
  git("init", "-q", "-b", options.initialBranch ?? "main");
  git("config", "user.name", TEST_GIT_IDENTITY.name);
  git("config", "user.email", TEST_GIT_IDENTITY.email);
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}
