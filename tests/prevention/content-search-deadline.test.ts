// @vitest-environment node
/**
 * A MODEL-SUPPLIED REGULAR EXPRESSION MUST NOT BE ABLE TO STOP THE SERVER.
 *
 * `search_code` compiles a pattern the LLM wrote and applies it to every line
 * of every file in the project. A pattern with nested quantifiers backtracks
 * exponentially in the length of the line it is matching: measured on this
 * machine, `(a+)+$` against a single 35-character line occupied a thread for
 * 64.6 seconds inside ONE `RegExp.test` call, and every further two characters
 * multiplies that by roughly seven — 37 characters is 468 seconds, and a
 * 61-character line does not return in any time worth writing down. Run on the server's event loop —
 * which is where it used to run — that is every request, every SSE frame and
 * every other user's chat stopped for the duration, triggered by one tool call
 * on a project of any size.
 *
 * No deadline checked between lines can end it, because control never returns
 * between lines. Nor can the pattern be screened: deciding whether a regex
 * backtracks catastrophically is not something an inspection does reliably,
 * and a denylist of "dangerous shapes" refuses legitimate patterns while still
 * missing others. The only mechanism that works is running the match somewhere
 * that can be killed, so the search runs on a worker thread and the pool
 * terminates it at its deadline.
 *
 * WHY THIS LIVES IN ITS OWN FILE. The invariant is about a DEADLINE, so the
 * test costs whatever the deadline is. Derived from the bound rather than
 * fixed independently of it, the same assertions cost a second here instead of
 * the fifteen the production setting would charge the suite — and, more
 * importantly, the test still fails if the deadline stops being enforced,
 * which is the property that matters. Pointing the config owner at a temp
 * document is what makes the bound the test's to choose.
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";

/** The deadline this file configures, and the one every assertion is derived
 *  from. Long enough that the bomb cannot possibly finish inside it, short
 *  enough to be free. */
const DEADLINE_MS = 5_000;

await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const { writeFileSync: write } = await import("node:fs");
  const dir = createTempDir("ch-content-search-deadline-");
  const path = `${dir}/harness.config.json`;
  write(path, JSON.stringify({ tools: { searchTimeoutMs: 5_000 } }));
  process.env.HARNESS_CONFIG_PATH = path;
});

const { executeToolCall } = await import("../../server/tools/tool-executor.ts");
const { getSearchTimeoutMs } = await import("../../server/kernel/harness-config.ts");
const { activeWorkerCount } = await import("../../server/run/worker-pool.ts");

let root: string;
const ctx = { runId: "deadline-guard", userId: "deadline-guard" };

beforeAll(() => {
  root = createTempDir("content-search-deadline-");
  writeFileSync(join(root, "benign.ts"), "const canary = 1;\nconst other = 2;\n");
  // The subject the pattern backtracks over. 64 characters puts the match far
  // beyond any deadline this suite would tolerate, while the file itself is
  // trivial to read.
  writeFileSync(join(root, "bomb.txt"), `${"a".repeat(64)}X\n`);
});


describe("a catastrophic pattern is contained by a deadline, not by luck", () => {
  test("the deadline under test is the configured one, so the bound below is real", () => {
    // If the config override did not take, every timing assertion here would
    // be measuring the production deadline and the derivation would be a
    // fiction. Checked rather than assumed.
    expect(getSearchTimeoutMs()).toBe(DEADLINE_MS);
  });

  test("liveness — a benign search really searches and really finds", async () => {
    const result = await executeToolCall("search_code", { pattern: "canary" }, { ...ctx, projectRoot: root });
    // Carry the typed error in the assertion: a bare `success: false` under
    // full-suite contention reads as a regression but may be the deadline
    // doing its job on a saturated pool — only the output separates them.
    expect(result.success, `benign search refused, output: ${result.output}`).toBe(true);
    expect(result.output).toContain("benign.ts:1");
  });

  test("the search is refused at the deadline, and the event loop runs throughout", async () => {
    let ticks = 0;
    let longestStall = 0;
    let last = Date.now();
    const beat = setInterval(() => {
      const now = Date.now();
      longestStall = Math.max(longestStall, now - last);
      last = now;
      ticks += 1;
    }, 20);

    const started = Date.now();
    const result = await executeToolCall("search_code", { pattern: "(a+)+$" }, { ...ctx, projectRoot: root });
    const elapsed = Date.now() - started;
    clearInterval(beat);

    // Liveness for the cost assertions: the expensive operation must actually
    // have been attempted and actually have been refused. A tool that rejected
    // every pattern instantly would satisfy the loop measurement below by
    // never doing any work at all, which is precisely how a cost guard passes
    // while measuring a refusal.
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/time limit/i);
    expect(elapsed, "the deadline was actually reached").toBeGreaterThanOrEqual(DEADLINE_MS * 0.8);
    expect(elapsed, "and enforced, rather than the match completing").toBeLessThan(DEADLINE_MS * 8);

    // The discriminator the synchronous walk cannot reproduce. Matched inline
    // on the main thread this pattern pins the loop for its whole duration and
    // `ticks` is 0; only running it somewhere else produces a moving loop.
    expect(ticks, "the event loop must have advanced during the search").toBeGreaterThan(elapsed / 100);
    expect(longestStall, "no long main-thread stall").toBeLessThan(DEADLINE_MS / 2);
  });

  /**
   * THE DEADLINE MUST KILL THE THREAD, NOT MERELY STOP AWAITING IT.
   *
   * Everything above is satisfied by a pool that rejects the promise on time
   * and leaves the worker running: the loop still moves, the refusal still
   * arrives, and every assertion passes — while a thread pegs a core forever
   * and the next such call adds another. Deleting `worker.terminate()` from
   * the pool's cleanup passed the entire file before this test existed.
   *
   * There is no in-process handle on a terminated thread to assert against, so
   * the evidence is the only thing a surviving thread cannot hide: CPU. A
   * thread spinning inside `RegExp.test` consumes a full core, so the
   * process's CPU time over a wall-clock window is close to that window if the
   * thread lives and near nothing if it does not. `worker.terminate()` really
   * does interrupt a running regex on this runtime — measured directly, an
   * isolated worker spinning in one `RegExp.test` stopped 2 ms after
   * `terminate()` and burned 0.3 ms of CPU over the next 1.5 s — so this is a
   * guard on the call still being made, not on V8 being able to honour it.
   */
  test("the terminated worker really stops, rather than spinning on unwatched", async () => {
    const started = Date.now();
    const result = await executeToolCall("search_code", { pattern: "(a+)+$" }, { ...ctx, projectRoot: root });

    // Liveness for the cost measurement below, twice over: the search must
    // have been ATTEMPTED (a tool that refused instantly leaves no thread to
    // leak, and would pass a CPU bound by doing nothing) and REFUSED at the
    // deadline rather than completed.
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/time limit/i);
    expect(Date.now() - started, "the deadline was actually reached").toBeGreaterThanOrEqual(DEADLINE_MS * 0.8);

    // Let the termination land, then measure a clean window.
    await new Promise((r) => setTimeout(r, 100));
    const before = process.cpuUsage();
    const windowMs = 700;
    const windowStart = Date.now();
    await new Promise((r) => setTimeout(r, windowMs));
    const elapsedWall = Date.now() - windowStart;
    const delta = process.cpuUsage(before);
    const burnedMs = (delta.user + delta.system) / 1000;

    // A surviving thread burns ~100% of a core: `burnedMs` would track
    // `elapsedWall`. Half of it is far above anything an idle test process
    // does and far below what one spinning thread costs.
    expect(burnedMs, `${burnedMs.toFixed(1)}ms of CPU over ${elapsedWall}ms of wall time — a worker survived its deadline`)
      .toBeLessThan(elapsedWall * 0.5);
    expect(activeWorkerCount(), "the pool still believes a worker is running").toBe(0);
  });
});
