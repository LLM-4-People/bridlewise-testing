/**
 * THE ONE GIT DOOR: every git process outside the pinned port (the workspace
 * port's closed-environment exec, src/git/worktree-port.ts) runs through
 * {@link gitOutput}, against a {@link GitRepository}, as the one bounded run
 * (`runCpuBoundedSync`, src/process/bounded-run-sync.ts): its process group's
 * CPU budget, a stall over the time it could run, the git output bound and
 * one hang backstop, never a wall ceiling a loaded host runs out. It also
 * owns which git variables a question carries ({@link GitEnvironment}).
 *
 * `engine/test/prevention/spawn-owners.test.ts` refuses a direct process
 * spawn outside the declared owners (`scripts/verification/spawn-owners.ts`),
 * so a git process anywhere else is refused.
 */
import { HarnessError } from "../kernel/errors.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { runCpuBoundedSync } from "../process/bounded-run-sync.ts";
import { boundedEnding, type SubprocessBounds } from "../process/subprocess-bounds.ts";
import { subprocessBounds } from "../workflow/workflow-config.ts";

/** A repository and the git that answers about it: the executable (the configured one: `configuredGitRepository`, src/git/worktree-port.ts) and the bounds of each call (`harness.subprocessBounds`). */
export type GitRepository = Readonly<{
  /** Any directory inside a checkout of the repository. */
  root: string;
  /** The git executable: an absolute path, or a name the bounded run's shell finds on PATH. */
  executable: string;
  /** The bounds of one git process (the one bounded run's). */
  bounds: SubprocessBounds;
}>;

/**
 * A repository at `root` asked of the git on PATH (found by the bounded run's
 * shell) under the default bounds, for a caller that holds no configuration
 * document (a hook, a verification script). A configured caller uses
 * `configuredGitRepository` (src/git/worktree-port.ts).
 */
export function localGitRepository(root: string): GitRepository {
  return Object.freeze({ root, executable: "git", bounds: subprocessBounds({}) });
}

/**
 * The process environment minus every `GIT_*` variable, for commands that
 * CREATE or drive a second repository (the working-copy builder, checkout
 * setup): an inherited `GIT_DIR` or `GIT_INDEX_FILE` (git exports them to
 * hooks) would point those commands at the source's git instead of the copy's.
 * The readers above deliberately honour the environment: inside a hook the
 * index being committed IS the answer, and a test may plant an index this way.
 */
export function directoryGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([name]) => !name.startsWith("GIT_")));
}

/**
 * Which git a question is asked of:
 *
 * - `inherited`: the caller's `GIT_*` count. Inside a hook they ARE the
 *   answer (git exports `GIT_INDEX_FILE` for `commit -a`, `GIT_DIR` for a
 *   linked worktree or `--git-dir`, `GIT_WORK_TREE` for `--work-tree`).
 * - `directory`: git is asked about the directory alone ({@link directoryGitEnvironment}).
 *   A question about ANOTHER place than the hook's repository must be asked
 *   this way: with the hook's `GIT_DIR` and no `GIT_WORK_TREE`, git takes the
 *   current directory for the top of the work tree, so `--show-toplevel` from
 *   `<top>/engine` answers `<top>/engine` (wf1b-correctness §2 N1: the commit
 *   guard located its engine at "" in every linked worktree).
 */
export type GitEnvironment = "inherited" | "directory";

/** The process environment a git question of `environment` runs with. */
function gitProcessEnvironment(environment: GitEnvironment): NodeJS.ProcessEnv {
  return environment === "directory" ? directoryGitEnvironment() : process.env;
}

/**
 * `git <argv>` in `repository` (the directory's own git: no inherited
 * `GIT_DIR` or index; `gc.auto=0`, so no read starts a background collection),
 * stdout as bytes, or the typed refusal `tree_reader_git_failed` (its message
 * says how the run ended when the bounds stopped it). `allowed` lists the exit
 * statuses that answer a question (`merge-base --is-ancestor` answers 1 for
 * "no"), or is `"any"` when every exit status is an answer (the caller reads
 * it; a run the bounds stopped, or a git that never started, is still the
 * typed refusal); `environment` adds variables (a private `GIT_INDEX_FILE`),
 * or names which git variables the question carries ({@link GitEnvironment}:
 * `"directory"` by default, `"inherited"` for a hook's own git). The one
 * git door: every git process outside the pinned port runs here, bounded by
 * its work (`runCpuBoundedSync`), its output by the git output bound.
 */
export function gitOutput(
  repository: GitRepository,
  argv: readonly string[],
  options: Readonly<{ input?: Buffer; allowed?: readonly number[] | "any"; environment?: Readonly<Record<string, string>> | GitEnvironment }> = {},
): Readonly<{ status: number; stdout: Buffer; stderr: Buffer }> {
  const environment = typeof options.environment === "string"
    ? gitProcessEnvironment(options.environment)
    : { ...gitProcessEnvironment("directory"), ...options.environment };
  const bounds = { ...repository.bounds, outputBytes: Math.min(repository.bounds.outputBytes, ROOT_POLICY.runtime.limits.maximumGitOutputBytes) };
  const run = runCpuBoundedSync(repository.executable, ["-c", "gc.auto=0", ...argv], {
    cwd: repository.root,
    env: environment,
    bounds,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  const allowed = options.allowed ?? [0];
  if (run.ending !== "exited" || run.status === null || (allowed !== "any" && !allowed.includes(run.status))) {
    const reason = run.ending === "exited"
      ? (run.signal === null ? run.stderr.toString("utf8").trim() : `it ended by ${run.signal}`)
      : run.ending === "unstarted" ? `git did not run (${run.startError ?? "unknown"})` : boundedEnding(run, bounds);
    // How it ended, for a caller that tells the machine's failure (a bound, a signal, git not run) from git's answer.
    const ending = run.ending !== "exited" ? run.ending : run.signal !== null ? "signal" : "exited";
    throw new HarnessError(`git ${argv.join(" ")} failed in ${repository.root}: ${reason}`, "tree_reader_git_failed", ending !== "exited", { ending });
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}
