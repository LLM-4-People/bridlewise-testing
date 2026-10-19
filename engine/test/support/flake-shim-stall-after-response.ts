/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision): ONE event-loop stall, longer than the loopback server's
 * keep-alive close, at a deterministic point of ONE named test. It recreates,
 * on any machine and without load, what load did to the matrix-executor's
 * "tokens accumulate from run usage" (2026-10-07 20:03Z and 22:31Z, "expected
 * 101160, got 100845": one reference run lost) as LAND-OC-FIX round 3
 * measured it: after a stall past the server's keep-alive close (5 s + 1 s),
 * the server's close runs first, and the client writes its next POST on that
 * pooled socket before its own idle timer has run.
 *
 * How the point is found, deterministically: the reproduction runs ONLY that
 * test (`--only-named`, a recorded condition), and right after the CLIENT has
 * read its {@link STALL_AFTER_RESPONSE}th whole answer (undici's
 * `undici:request:trailers` channel) the process busy-waits {@link STALL_MS}
 * once, on the next turn — between the client's reading of an answer and the
 * writing of its next request on the pooled connection. Neither the client
 * nor the server is changed, and nothing wraps the test runner (a wrapper
 * would move the test's reported file, and its ledger identity with it).
 *
 * Preloaded into every test file's process of a reproduction run (`node
 * --test --import`); never imported by a test.
 */
import { subscribe } from "node:diagnostics_channel";

/** After the client read this answer of that test (its first): a pooled connection carries the next POST. */
const STALL_AFTER_RESPONSE = 1;
/** Past the loopback server's keep-alive close (node's 5 s keep-alive + its 1 s buffer), with a margin. */
const STALL_MS = 7_500;

let answers = 0;
let stalled = false;
subscribe("undici:request:trailers", () => {
  if (stalled) return;
  answers += 1;
  if (answers !== STALL_AFTER_RESPONSE) return;
  stalled = true;
  setImmediate(() => {
    const until = Date.now() + STALL_MS;
    while (Date.now() < until) { /* the stalled event loop */ }
  });
});
