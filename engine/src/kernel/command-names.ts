/**
 * THE NAMES NO `execute_command` MAY RUN — the pure half of the reach judgement
 * (`src/tools/command-reach.ts` holds the half that reads the filesystem), here
 * so the configuration contract can refuse them in `tools.allowedCommands`:
 * git (every git need goes through the harness's git tools) and a program
 * launcher (allowing one allows every program, git included).
 */
import { deepFreeze } from "./integrity.ts";

/**
 * Programs that run another program their arguments name — allowing one allows them all. `awk` (`system()`,
 * pipes, `getline` from a command) and `sed` (`e`, `s///e`) are general interpreters of the same kind: filtering
 * their programs would block one spelling, never the capability (edits go through the file tools).
 */
export const PROGRAM_LAUNCHERS: ReadonlySet<string> = deepFreeze(new Set([
  "sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh", "busybox",
  "awk", "gawk", "mawk", "nawk", "sed", "gsed",
  "env", "xargs", "nohup", "timeout", "nice", "ionice", "stdbuf", "setsid", "sudo", "doas", "su",
  "chroot", "unshare", "nsenter", "flock", "watch", "script", "strace", "ltrace", "time", "parallel",
]));

/** A typed refusal: what the door throws or answers with. */
export type CommandReachRefusal = Readonly<{ code: string; message: string }>;

/** git's own name, and the prefix of git's own programs. */
export function isGitName(name: string): boolean {
  return name === "git" || name.startsWith("git-");
}

/** The refusal of a NAME no allowed-command list may hold (git, a launcher), or null. */
export function allowedCommandNameRefusal(name: string): CommandReachRefusal | null {
  if (isGitName(name)) {
    return { code: "tool_command_reaches_git", message: `'${name}' is git: every git need goes through the harness's git tools (git_status, git_diff, git_log, git_branch, git_commit), never execute_command` };
  }
  if (PROGRAM_LAUNCHERS.has(name)) {
    return { code: "tool_command_launches_programs", message: `'${name}' runs whatever program its arguments name, so allowing it would allow every program (git included)` };
  }
  return null;
}
