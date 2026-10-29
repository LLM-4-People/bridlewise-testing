/**
 * WHAT A MODEL-CHOSEN COMMAND CAN REACH — the one judgement both
 * `execute_command` doors ask (the engine's adapter, `built-in-tools.ts`, and
 * the web server's executor, `server/tools/tool-executor.ts`) before a program
 * runs, and the one the configuration contract asks of `tools.allowedCommands`.
 *
 * git is never reachable through `execute_command`: every git need goes
 * through the harness's git tools (`git_status`, `git_diff`, `git_log`,
 * `git_branch`, `git_commit`), which own the repository's history. Allowing
 * the program by name gated only the NAME, so a model could commit, rewrite
 * or push through it. It is refused, typed (`tool_command_reaches_git`), by
 * what the command IS, never by how it is spelled:
 *
 * - its name is `git` or one of git's own programs (`git-*`, e.g.
 *   `git-receive-pack`);
 * - the file it resolves to on the child's `PATH` is git's file (same device
 *   and inode: a symbolic or hard link under another name), or that file's
 *   real name is git's.
 *
 * TWO MORE WAYS A NAME GATE IS ARGUMENT-BLIND, and both are refused:
 *
 * - A PROGRAM LAUNCHER runs whatever program its arguments name (a shell,
 *   `env`, `xargs`, `timeout`…). Allowing one allows every program, git
 *   included, so it is refused by name at the door AND in the configuration
 *   (`tool_command_launches_programs`): an operator cannot list one.
 * - An otherwise-inert command that LAUNCHES A PROGRAM FROM AN ARGUMENT
 *   (`find -exec`, `fd --exec`, `rg --pre`, `sort --compress-program`,
 *   `cmake -E`) is refused on that argument
 *   (`tool_command_argument_launches_program`). `awk` and `sed` are general
 *   interpreters and refused as launchers.
 *
 * WHAT THIS DOES NOT CLAIM. A code runner (`node`, `npm`, `npx`, `python`,
 * `make`, `cargo`, `go`, a compiler, a linter that loads its configuration as
 * code) runs project code by design, and that code can start git or write
 * `.git` whatever its arguments say: an argument filter (`node -e`) would be a
 * spelling, not a boundary. Closing that path is the confinement's job (the
 * guardian denying the child writes to the repository's `.git`), tracked as
 * #670; it is stated here so nobody reads this gate as that boundary.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { deepFreeze } from "../kernel/integrity.ts";
import { allowedCommandNameRefusal, isGitName, type CommandReachRefusal } from "../kernel/command-names.ts";

/**
 * Per command, the options by which it runs a program an argument names:
 * `words`, whole arguments (`find`'s single-dash options); `longs`, long
 * options, also in their `--option=value` spelling; `shorts`, single-letter
 * options, also inside a cluster (`-Hx`).
 */
type ArgumentLaunch = Readonly<{ words?: readonly string[]; longs?: readonly string[]; shorts?: readonly string[] }>;
const FD_LAUNCH: ArgumentLaunch = { longs: ["--exec", "--exec-batch"], shorts: ["x", "X"] };
const ARGUMENT_LAUNCHES: Readonly<Record<string, ArgumentLaunch>> = deepFreeze({
  find: { words: ["-exec", "-execdir", "-ok", "-okdir"] },
  fd: FD_LAUNCH,
  fdfind: FD_LAUNCH,
  rg: { longs: ["--pre"] },
  sort: { longs: ["--compress-program"] },
  // `cmake -E` is a toolbox whose subcommands run their trailing arguments (`env`, `chdir`, `time`, …): every form
  // is refused rather than a list of the ones that run a program today.
  cmake: { words: ["-E"] },
});

/** The argument of `args` by which `launch` runs a program, or undefined. Everything after `--` is an operand. */
function launchingArgument(launch: ArgumentLaunch, args: readonly string[]): string | undefined {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).find((arg) =>
    (launch.words ?? []).includes(arg) ||
    (launch.longs ?? []).some((option) => arg === option || arg.startsWith(`${option}=`)) ||
    (/^-[^-]/u.test(arg) && (launch.shorts ?? []).some((letter) => arg.slice(1).includes(letter))));
}

/**
 * Where `command` resolves on `path` (a `PATH` value), exactly as a spawn
 * without a shell resolves it: a name with a `/` is itself; otherwise the
 * first directory of `path` holding that name. Null when none does.
 */
export function resolveOnPath(command: string, path: string | undefined): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  if (path === undefined || path.length === 0) return null;
  for (const directory of path.split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A resolved file's identity (it exists: `resolveOnPath` found it); a file that cannot be read is an error, never "not git". */
function identity(path: string): Readonly<{ dev: number; ino: number; real: string }> {
  const stats = statSync(path);
  return { dev: stats.dev, ino: stats.ino, real: realpathSync(path) };
}

/** Whether `command`, resolved on `path`, is git: by name, by its file's real name, or by its file. */
export function commandIsGit(command: string, path: string | undefined): boolean {
  if (isGitName(basename(command))) return true;
  const resolved = resolveOnPath(command, path);
  if (resolved === null) return false;
  const target = identity(resolved);
  if (isGitName(basename(target.real))) return true;
  const gitPath = resolveOnPath("git", path);
  if (gitPath === null) return false;
  const git = identity(gitPath);
  return git.dev === target.dev && git.ino === target.ino;
}

/**
 * THE DOOR'S QUESTION: may `command` with `args` run, as a child whose `PATH`
 * is `path`? Null when it may; the typed refusal otherwise.
 */
export function commandReachRefusal(command: string, args: readonly string[], path: string | undefined): CommandReachRefusal | null {
  const named = allowedCommandNameRefusal(basename(command));
  if (named !== null) return named;
  if (commandIsGit(command, path)) {
    return { code: "tool_command_reaches_git", message: `'${command}' resolves to git: every git need goes through the harness's git tools (git_status, git_diff, git_log, git_branch, git_commit), never execute_command` };
  }
  const launch = ARGUMENT_LAUNCHES[basename(command)];
  const launching = launch === undefined ? undefined : launchingArgument(launch, args);
  if (launching !== undefined) {
    return { code: "tool_command_argument_launches_program", message: `'${command} ${launching.split("=")[0]!}' runs a program its arguments name; run the search without it` };
  }
  return null;
}
