/**
 * THE RUN PATH'S SOURCE, AS ONE SUBJECT.
 *
 * The run used to be one file. `GET /api/run/:runId/stream` was the executor,
 * so `server/routes/run.ts` contained the route registration, the projection
 * writers, the provider loop, the tool dispatch and the teardown — and around
 * twenty guards each opened that path by name and asserted something about the
 * text they found.
 *
 * Splitting it (control routes / subscriber / executor / registry / feed) was
 * the fix for a defect that cost real money. It also broke every one of those
 * guards at once, and each broke by looking in a file that no longer holds
 * what it is asking about — which is the silently-smaller-universe failure,
 * arriving through a path literal.
 *
 * ── WHAT THIS OWNER IS FOR ─────────────────────────────────────────────────
 *
 * A guard asking "does the run path do X?" should be asking about the RUN
 * PATH, not about whichever file happened to hold X on the day it was
 * written. `runPathSource()` is that subject. A guard that genuinely cares
 * which module does something keeps naming that module — the distinction is
 * real and worth keeping.
 *
 * ── THE MEMBERSHIP LIST IS EXPLICIT *AND* DERIVED, BECAUSE EITHER ALONE ────
 *    LEAVES ONE DIRECTION OPEN
 *
 * A pattern (`server/run-*.ts`) is discovery, and discovery is usually right
 * — but a pattern is also a layer that SELECTS, and a member renamed out of
 * the pattern would drop out of every guard's universe with nothing failing.
 * So the members are named.
 *
 * A NAMED LIST HAS THE OPPOSITE HOLE, and naming them was not enough. This
 * helper was written to fix a silently-smaller-universe defect and promptly
 * became one: deleting `server/run-executor.ts` — the only module that spends
 * money — from the list below shrank twenty-one guards' subject from five
 * modules to four, cut `runPathSource()` from ~110,800 bytes to ~44,000, and
 * produced ZERO test failures. `runPathModules()` did not throw, because the
 * four that remained all existed. A check that a named file is present cannot
 * notice a file that was never named.
 *
 * So both directions are closed, and the two mechanisms check EACH OTHER:
 *
 *   named → disk: a member that no longer exists throws, naming it (a rename
 *                 breaks loudly at the one site that has to be updated).
 *   disk → named: the run path is re-derived from the filesystem and must
 *                 EQUAL the list. A module added to the tree and not to the
 *                 list throws; a module deleted from the list while still on
 *                 disk throws. Neither can quietly change what the guards
 *                 examine.
 *
 * The derivation is the pattern the modules are actually named by, and it is
 * asserted rather than trusted: if the two ever disagree, that disagreement
 * is the finding.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/**
 * Every module that implements the run path, in the order a reader would meet
 * them: what starts a run, what subscribes to one, what performs one, what
 * remembers one, and what carries its output.
 */
const RUN_PATH_MEMBERS = [
  "server/routes/run.ts",
  "server/routes/run-stream.ts",
  "server/routes/run-status.ts",
  "server/run/run-executor.ts",
  "server/run/run-registry.ts",
  "server/run/run-feed.ts",
] as const;

/**
 * THE RUN PATH AS THE FILESYSTEM HAS IT — the independent second opinion.
 *
 * `server/run-*.ts` plus `server/routes/run*.ts`: the names the run path's
 * modules are in fact given. Derived on every call, so it cannot go stale,
 * and deliberately NOT the source of the list — it is what the list is
 * checked against. Two instruments, and a disagreement between them is a
 * finding rather than a silently smaller universe.
 */
export function discoverRunPathModules(): readonly string[] {
  const found: string[] = [];
  for (const [dir, matches] of [
    ["server", (n: string): boolean => /^run-[\w-]+\.ts$/.test(n)],
    ["server/routes", (n: string): boolean => /^run(?:-[\w-]+)?\.ts$/.test(n)],
  ] as const) {
    for (const name of readdirSync(resolve(REPO_ROOT, dir))) {
      if (matches(name)) found.push(`${dir}/${name}`);
    }
  }
  // A discovery that comes back empty must FAIL rather than certify nothing:
  // an empty universe is the shape every guard in this project has been
  // defeated by, and it is indistinguishable from "no violations" downstream.
  if (found.length === 0) {
    throw new Error(
      `No run-path modules were discovered under ${join(REPO_ROOT, "server")}. ` +
        `A subject that comes back empty would make every guard reading it pass ` +
        `vacuously, so this is refused rather than returned.`,
    );
  }
  return found;
}

/**
 * The members, verified present AND verified complete. Throws naming what
 * disagrees.
 */
/** One named member of the run path, as the type the members list holds —
 *  the precise answer to "which module may this be", so a consumer looping
 *  the census can hand a member straight back to a member-typed reader. */
export type RunPathModule = (typeof RUN_PATH_MEMBERS)[number];

export function runPathModules(): readonly RunPathModule[] {
  const missing = RUN_PATH_MEMBERS.filter((rel) => !existsSync(resolve(REPO_ROOT, rel)));
  if (missing.length > 0) {
    throw new Error(
      `The run path's source owner names ${missing.length} module(s) that do not exist: ` +
        `${missing.join(", ")}. A guard reading this subject would otherwise examine a ` +
        `smaller universe than it believes. Update tests/helpers/run-source.ts.`,
    );
  }
  // THE OTHER DIRECTION, and the one the original design left open. Deleting
  // a member from the list above passed every check and quietly removed it
  // from twenty-one guards' subject; the filesystem still had it, so asking
  // the filesystem is what notices.
  const named = new Set<string>(RUN_PATH_MEMBERS);
  const unnamed = discoverRunPathModules().filter((rel) => !named.has(rel));
  if (unnamed.length > 0) {
    throw new Error(
      `The run path has ${unnamed.length} module(s) on disk that its source owner does not ` +
        `name: ${unnamed.join(", ")}. Every guard reading this subject would examine a ` +
        `smaller universe than the run path actually is — which is the defect this owner ` +
        `exists to prevent, one level up. Add them to RUN_PATH_MEMBERS in ` +
        `tests/helpers/run-source.ts, or rename them out of the run path deliberately.`,
    );
  }
  return RUN_PATH_MEMBERS;
}

/**
 * The run path's source as one string, with a banner before each member so a
 * failure message can say WHICH module the offending text came from.
 */
export function runPathSource(): string {
  return runPathModules()
    .map((rel) => `\n// ===== ${rel} =====\n${readFileSync(resolve(REPO_ROOT, rel), "utf8")}`)
    .join("\n");
}

/** One named member of the run path. Use when the guard's claim is genuinely
 *  about that module rather than about the path as a whole. */
export function readRunPathModule(rel: (typeof RUN_PATH_MEMBERS)[number]): string {
  runPathModules();
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}
