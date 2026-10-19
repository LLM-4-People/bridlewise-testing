/**
 * WHO CAN MAKE GIT RUN — derived from the owner's own source, not spelled.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Four separate guards asked the same question in four different ways, and
 * every one of them asked it by naming `gitText`:
 *
 *   - "which modules are git-owner bridges, and must enforce the fs gate"
 *   - "which line is a git subcommand rather than raw transaction SQL"
 *   - "does git-ops-bridge get its timeout from the spawn owner"
 *   - "does a user-facing module import an accessor that hides a refusal"
 *
 * When the user-facing readers moved off `gitText` onto the refusal-aware
 * `gitTextOrRefuse` — a strict improvement — two of those guards went RED on
 * a correct change and the other two went quietly SMALLER, one of them
 * shrinking its population from three modules to one with nothing failing.
 * That is the same lesson this repository has now recorded several times: a
 * guard keyed to a SPELLING is a guard keyed to today's code, and renaming
 * the right thing breaks it in whichever direction is least visible.
 *
 * So the set is derived once, here, from `server/git-bridge.ts` itself: every
 * exported function whose BODY reaches the spawn. A fifth accessor written
 * tomorrow joins the set because it behaves like the others, not because
 * somebody remembered to add its name to four files.
 *
 * The derivation REFUSES an empty answer. A universe that comes back empty
 * must fail rather than certify that nothing is wrong.
 */
import { readFileSync } from "node:fs";

import { bodyCalls, exportedBindings, functionBody } from "./function-scope.ts";

/** The one module allowed to create a git subprocess. */
export const GIT_BRIDGE_PATH = "server/intelligence/git-bridge.ts";

/** The primitive every other accessor is built on. */
export const GIT_SPAWN = "gitRead";

/**
 * Every exported name in the git bridge through which git can be made to run
 * — `gitRead` plus every exported function whose body calls it.
 *
 * Derived ONCE per source text and cached. The derivation parses the bridge,
 * and `callsGitBridge` is asked about every line of every server file — the
 * uncached version turned one guard into 5.7% of the whole suite's worker
 * time and pushed the wall-clock budget over. A cache keyed on the source
 * text cannot go stale: different bytes are a different key.
 */
const ACCESSOR_CACHE = new Map<string, readonly string[]>();

export function gitSpawnAccessors(source = readFileSync(GIT_BRIDGE_PATH, "utf8")): readonly string[] {
  const cached = ACCESSOR_CACHE.get(source);
  if (cached !== undefined) return cached;
  const derived = [...exportedBindings(source, "git-bridge exports").entries()]
    .filter(([name, binding]) => binding.kind === "function"
      && name !== GIT_SPAWN
      && bodyCalls(functionBody(source, name), GIT_SPAWN))
    .map(([name]) => name);
  const all = [GIT_SPAWN, ...derived];
  if (all.length < 2) {
    throw new Error(
      `git-spawn accessors could not be derived from ${GIT_BRIDGE_PATH}: found ${all.join(", ") || "nothing"}. `
      + "A guard whose subject has vanished must fail rather than report that nothing is wrong with it.",
    );
  }
  ACCESSOR_CACHE.set(source, all);
  return all;
}

/**
 * The accessors that answer `null` for a REFUSAL — they reach the spawn and
 * never raise on it, so a caller can render "we could not look" as "there is
 * nothing to see". Derived the same way, by what the body does.
 */
export function refusalConflatingAccessors(source = readFileSync(GIT_BRIDGE_PATH, "utf8")): readonly string[] {
  return gitSpawnAccessors(source).filter((name) => name !== GIT_SPAWN
    && !bodyCalls(functionBody(source, name), "raiseIfNotRun"));
}

/** One alternation over every accessor, built once per accessor set. */
const CALL_RE_CACHE = new Map<string, RegExp>();

/** Does this line hand a subcommand to the guarded git bridge? */
export function callsGitBridge(line: string, accessors: readonly string[] = gitSpawnAccessors()): boolean {
  const key = accessors.join("|");
  let re = CALL_RE_CACHE.get(key);
  if (re === undefined) {
    re = new RegExp(`\\b(?:${key})\\s*\\(`);
    CALL_RE_CACHE.set(key, re);
  }
  return re.test(line);
}

/** Does this source import any accessor that can make git run, from the bridge? */
export function importsGitBridgeAccessor(
  source: string,
  accessors: readonly string[] = gitSpawnAccessors(),
): boolean {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*git-bridge\.ts["']/g)]
    .some((m) => accessors.some((name) => new RegExp(`\\b${name}\\b`).test(m[1] ?? "")));
}

/** The names one source imports from the git bridge, `type` prefixes removed. */
export function gitBridgeImportsOf(source: string): readonly string[] {
  return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*git-bridge\.ts["']/g)]
    .flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim().replace(/^type\s+/, "")))
    .filter((s) => s.length > 0);
}
