/**
 * A COMMIT'S TRAILERS, AS GIT PARSES THEM — the one reader the commit doors
 * share (the `Lesson:` and `Test-deleted:` trailers, the DCO's `Signed-off-by:`
 * and every identity trailer).
 *
 * The values are git's own parse (`git interpret-trailers --parse` of a raw
 * message, `%(trailers:only,unfold)` of a recorded commit), never a regular
 * expression over the body: a `Key: value` line inside the body, or above a
 * `git commit -v` scissors line, is not a trailer. A decision trailer's key
 * (`Lesson:`, `Test-deleted:`) is matched exactly, because `git log --grep` is case-sensitive;
 * an identity trailer is judged by any spelling of its key ({@link trailersOf}).
 */
import { execFileSync } from "node:child_process";

/** git at `root`, its stdout as text (`input` on its stdin). */
export function gitText(root: string, args: readonly string[], input?: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

/** Every trailer of git's parsed lines (`Key: value`, one per line), key and value as written. */
export function trailersOf(parsed: string): ReadonlyArray<Readonly<{ key: string; value: string }>> {
  return parsed.split("\n").flatMap((line) => {
    const colon = line.indexOf(":");
    return colon > 0 ? [{ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }] : [];
  });
}

/** Every trailer of a raw commit message, as git parses them. */
export function messageTrailers(root: string, message: string): ReadonlyArray<Readonly<{ key: string; value: string }>> {
  return trailersOf(gitText(root, ["interpret-trailers", "--parse"], message));
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
