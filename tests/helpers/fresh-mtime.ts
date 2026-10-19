/**
 * SINGLE-PARTY OWNER of "write a file, then force its mtime so an
 * mtime-keyed cache observes the write".
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * Test files that rewrite a config (or any file behind an mtime-keyed cache)
 * forced a fresh mtime by hand. The naive shape — `utimesSync(path, Date.now()
 * / 1000 + 1, …)` — computes the SAME stamp for two writes made inside one
 * wall-clock millisecond, because `Date.now()` has millisecond resolution.
 * The cache then keys both writes to one stamp and serves the FIRST write's
 * content for the SECOND write — a silent stale-read that surfaced as a ~1-in-3
 * flake in `tests/unit/mcp-runtime.test.ts` (a disabled-server test running in
 * under a millisecond handed its stale config to the NEXT test's registry
 * build).
 *
 * The weak fix is "add another millisecond at each call site". The evidence is
 * that three separate test files invented three separate bump amounts (10ms,
 * 10ms, 1000ms) and one of them still collided. So the stamp is owned here:
 * there is no way to write through this helper and get a non-increasing mtime.
 *
 * ── Why this mechanism ───────────────────────────────────────────────────
 *
 * The stamp is `max(clock + margin, previous + 1)` — monotone BY CONSTRUCTION,
 * never by hoping the clock moved. A frozen or coarse `Date.now()` (the exact
 * condition that produced the flake) still yields strictly increasing stamps,
 * because the previous stamp is always outbid. The small forward margin keeps
 * the stamp ahead of the plain `writeFileSync` clock-mtime that precedes it —
 * never so far ahead that the file looks like it arrived from a wrong decade.
 */

import { chmodSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";

/** The last stamp this process handed out (ms). The monotonicity anchor —
 *  module state is per worker under vitest isolation, which is exactly the
 *  scope a write sequence lives in. */
let lastStampMs = 0;

/** How far ahead of the wall clock a stamp is placed. Beats the clock-mtime
 *  the freshly-created temp carries; small enough that the file's mtime stays
 *  in the plausible present (config caches compare stamps for CHANGE, not for
 *  truth). */
const FORWARD_MARGIN_MS = 10;

/** Disambiguates temp paths within one process (the pid is in the name for
 *  cross-process collisions; one worker writes sequentially, but two writes
 *  inside one wall-clock instant must not share a temp name). */
let tempCounter = 0;

/**
 * Write `content` to `path`, then stamp the file with an mtime greater than
 * every stamp this helper has produced so far — so any mtime-keyed cache
 * that observed an earlier write CANNOT serve it for this one.
 *
 * The write PUBLISHES atomically: content, mode and mtime are prepared on a
 * same-directory temp file, then ONE `rename(2)` swaps the target in. A
 * reader of the target name can never observe a half-written body, and can
 * never observe new content with the pre-mode (the chmod happens on the temp,
 * before the target name points at it — a write-then-chmod on the target
 * itself exposes exactly that window). A hardlink to the old target keeps the
 * OLD inode with the OLD bytes: the target is replaced, never truncated in
 * place. The temp lives in the target's own directory because `rename` is
 * atomic only within one filesystem.
 *
 * When `mode` is given, the file ENDS at that mode — on creation AND on
 * rewrite. Because the publish is always a fresh inode, an omitted `mode`
 * lands at the umask-derived creation default (never the previous file's
 * mode); a caller writing a mode-bearing file passes `mode` on every write.
 *
 * Returns the stamp (ms) for callers that need to relate it to another
 * observation.
 */
export function writeFileWithFreshMtime(
  path: string,
  content: string,
  options: Readonly<{ mode?: number }> = {},
): number {
  const temp = `${path}.tmp-${process.pid}-${tempCounter++}`;
  try {
    writeFileSync(temp, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    if (options.mode !== undefined) chmodSync(temp, options.mode);
    lastStampMs = Math.max(Date.now() + FORWARD_MARGIN_MS, lastStampMs + 1);
    const at = new Date(lastStampMs);
    utimesSync(temp, at, at);
    renameSync(temp, path);
  } finally {
    // After a successful rename the temp path no longer exists; a failure
    // BEFORE the rename leaves it on disk. Force the cleanup either way —
    // never leave owner-shaped temp litter beside the target.
    rmSync(temp, { force: true });
  }
  return lastStampMs;
}

/**
 * The stamp actually ON the file right now (ms) — for the owner's own
 * monotonicity proof, so a test never has to reach into `lastStampMs`.
 */
export function readMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}
