/**
 * A COMMIT'S TRAILERS, AS GIT PARSES THEM — the one reader the commit doors
 * share (the `Lesson:` and `Test-deleted:` trailers).
 *
 * The values are git's own parse (`git interpret-trailers --parse` of a raw
 * message, `%(trailers:only,unfold)` of a recorded commit), never a regular
 * expression over the body: a `Key: value` line inside the body, or above a
 * `git commit -v` scissors line, is not a trailer. The key is matched exactly,
 * because `git log --grep` is case-sensitive.
 */
import { execFileSync } from "node:child_process";

/** git at `root`, its stdout as text (`input` on its stdin). */
export function gitText(root: string, args: readonly string[], input?: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

/** The values of `key` in git's parsed trailer lines (`Key: value`, one per line; the key exact). */
export function trailerValuesOf(parsed: string, key: string): readonly string[] {
  return parsed.split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 && line.slice(0, colon).trim() === key ? [line.slice(colon + 1).trim()] : [];
  });
}

/** The values of `key` among a raw commit message's trailers, as git parses them. */
export function messageTrailerValues(root: string, message: string, key: string): readonly string[] {
  return trailerValuesOf(gitText(root, ["interpret-trailers", "--parse"], message), key);
}
