/**
 * THE FOURTH DECLARATION CLASS: Playwright's `testDir` + `testMatch`.
 *
 * Three file-selecting declaration classes already refuse a dead member at
 * their own door — tsconfig `include`, the vitest runner's globs, and the
 * harness's qualified test-source patterns. The two Playwright configs were
 * the class nobody converted: a `testDir` and a path-shaped regex, with no
 * liveness check of any kind, and `declared-pattern-liveness.test.ts` did not
 * reach them.
 *
 * ── WHY IT MATTERS HERE MORE THAN ELSEWHERE ───────────────────────────────
 *
 * Total loss is loud: Playwright exits non-zero with `No tests found`. PARTIAL
 * loss is silent, and alternation is what makes it silent — a regex naming two
 * trees keeps matching when one of them disappears, and the run reports a
 * perfectly healthy pass over the survivors. That was live: the config named
 * `tests/e2e` and `tests/cockpit/e2e`, `tests/e2e` does not exist, and the
 * declaration still selected all 5 specs because the regex was unanchored and
 * `e2e` is a substring of `cockpit/e2e`. Measured: 7 tracked `*.spec.ts`, of
 * which this config selects 5 and `playwright.perf.config.ts` selects 2.
 *
 * ── WHAT IS SHARED AND WHAT IS LOCAL ──────────────────────────────────────
 *
 * The RULE and the WORDING come from `pattern-liveness.ts`, which already owns
 * "which declared patterns matched nothing, and what an operator must be told"
 * for the other three classes. Local is only what is genuinely specific: that
 * the candidates are `*.spec.ts` files under a `testDir`, and that a config
 * refuses by throwing while it is being loaded.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  patternLivenessFailure,
  regexMatchCounts,
} from "../../engine/scripts/verification/pattern-liveness.ts";

/**
 * Every `*.spec.ts` under `dir`, as `testDir`-relative forward-slash paths —
 * the shape a `testMatch` regex is written against.
 *
 * A MISSING ROOT IS A REFUSAL, never an empty answer. `testDir` pointing at
 * nothing is the strongest form of this defect: zero candidates means zero
 * dead patterns, so a per-pattern rule would certify a declaration that
 * selects nothing at all.
 *
 * `configDir` is REQUIRED and is the directory of the config that declares
 * `testDir`. Playwright resolves a relative `testDir` against the config
 * module, not the shell's cwd; resolving it against `process.cwd()` here made
 * both configs refuse to load from another directory (measured:
 * `cd /tmp && node … import("playwright.config.ts")` threw
 * `ENOENT … /tmp/tests`).
 */
export function specPathsUnder(testDir: string, configDir: string): string[] {
  const root = resolve(configDir, testDir);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (error) {
    throw new Error(
      `playwright testDir does not exist or is unreadable: ${testDir} (resolved: ${root}): ` +
      `${error instanceof Error ? error.message : String(error)}. A testDir that resolves to ` +
      `nothing offers no candidates, and a liveness rule over no candidates agrees with every ` +
      `declaration.`,
    );
  }
  const out: string[] = [];
  const queue = entries.map((entry) => join(root, entry));
  while (queue.length > 0) {
    const current = queue.pop()!;
    let isDirectory = false;
    try {
      isDirectory = statSync(current).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      if (current.endsWith(`${sep}node_modules`)) continue;
      for (const entry of readdirSync(current)) queue.push(join(current, entry));
    } else if (current.endsWith(".spec.ts")) {
      out.push(relative(root, current).split(sep).join("/"));
    }
  }
  return out.sort();
}

/**
 * Refuse a Playwright config whose declared spec trees do not all select at
 * least one spec.
 *
 * Throws rather than returning a verdict, because this runs while the config
 * is being loaded and a returned verdict is a verdict a caller can forget to
 * read.
 *
 * `configDir` is the config module's own directory (`import.meta.dirname`),
 * so a relative `testDir` is resolved the way Playwright resolves it — from
 * the config — and never from wherever the process was started.
 */
export function assertSpecPatternsAreLive(
  subject: string,
  testDir: string,
  trees: readonly string[],
  configDir: string,
): void {
  const specs = specPathsUnder(testDir, configDir);
  if (specs.length === 0) {
    throw new Error(
      `${subject}: testDir "${testDir}" holds no *.spec.ts files at all. Playwright would ` +
      `report "No tests found"; this says which declaration is empty and where it looked.`,
    );
  }
  // A declaration with NO sub-trees names exactly one thing — the `testDir`
  // itself — and the refusal above is the whole of its liveness. Handing an
  // empty list to the per-pattern rule would raise "declares NO patterns",
  // which is true of the list and false of the declaration.
  if (trees.length === 0) return;
  // ANCHORED AT THE START OF THE `testDir`-RELATIVE PATH, and it took a
  // planted mutation to get this right. The first attempt anchored to a
  // SEGMENT boundary — `(?:^|/)e2e/` — which re-created the exact defect being
  // fixed: a dead `e2e` still matched inside `cockpit/e2e/…`, the plant
  // returned exit 0, and the escape was invisible until it was driven. A
  // declared tree is rooted at `testDir`, so `^` is the only anchor that makes
  // "this tree is live" mean this tree.
  const failure = patternLivenessFailure(
    `${subject}: the spec trees declared under testDir "${testDir}"`,
    regexMatchCounts(
      trees.map((tree) => `^${tree}/`),
      specs,
    ),
  );
  if (failure !== null) {
    throw new Error(
      `${failure} ${specs.length} *.spec.ts files were offered under "${testDir}".`,
    );
  }
}
