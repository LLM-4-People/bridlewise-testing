/**
 * THE GUARD-DOSSIER RATCHET — one judge, one tracked floor.
 *
 * ── The defect this file exists to end ───────────────────────────────────
 *
 * The ratchet used to keep its floor in the gitignored run-flag directory
 * (`.bridlewise/run-flags/guard-dossier-ratchet-floor.json`). On a fresh clone
 * that file does not exist, and the test's "first run" branch WROTE the
 * observed count and returned green. The exact retreat the ratchet exists to
 * refuse — a guard losing its dossier — therefore certified itself: an agent
 * deleted a dossier from a real guard with the flag absent, and the suite went
 * 12/12 green while writing a lower floor.
 *
 * It also compared three NUMBERS (total, per-guard size, population length).
 * A dossier line moved from one guard to another preserves every one of them,
 * so the content could move between guards undetected.
 *
 * ── The three properties this owner implements ───────────────────────────
 *
 * 1. THE FLOOR IS TRACKED. It lives at `tests/prevention/dossier-floor.json`
 *    and is committed with the tree. A checkout always carries it; a missing
 *    floor is a REFUSAL, never a signal to establish one.
 *
 * 2. THE JUDGE NEVER WRITES. `judgeDossierFloor` answers yes/no over a floor
 *    it was handed. The only writer is the explicit rebase command
 *    (`npm run dossier-floor:update` → `scripts/testing/update-dossier-floor.ts`),
 *    which is visibly a different command and is never reached by a test run.
 *
 * 3. THE FLOOR IS CONTENT. Each record is the guard's sorted `GUARD <FIELD>:`
 *    lines, keyed by path. Moving a line between guards, swapping two values,
 *    or editing a fact changes the record even when every count is identical.
 *    Growth is also a refusal: a new dossier is recorded by the explicit
 *    command, so the reviewed floor never changes as a side effect of running
 *    the suite.
 *
 * The floor is a FROZEN RECORD, not a second owner: its content is derived
 * from the dossiers in the guard files by `factsOf`, and the live dossiers are
 * the only place the values are authored.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  OPTIONAL_DOSSIER_FIELDS,
  REQUIRED_DOSSIER_FIELDS,
  type Dossier,
} from "./prevention-dossier.ts";
import { validateFreshnessExemptions } from "./freshness-exemption.ts";

/** The flag name carried by the tracked floor (kept from the old snapshot). */
export const FLOOR_FLAG = "guard-dossier-ratchet-floor";

/** The schema version. v2 records FACTS; v1 recorded a count and a path list. */
export const FLOOR_SCHEMA_VERSION = "bridlewise-guard-dossier-floor/v2";

/** The one tracked location, repository-relative. */
export const FLOOR_RELATIVE_PATH = "tests/prevention/dossier-floor.json";

/** The absolute floor path for a repository root. */
export function floorPathFor(repositoryRoot: string): string {
  return `${repositoryRoot.replace(/\/+$/u, "")}/${FLOOR_RELATIVE_PATH}`;
}

/** The canonical field order of a dossier, and therefore of its fact lines. */
const FACT_FIELDS: readonly string[] = [...REQUIRED_DOSSIER_FIELDS, ...OPTIONAL_DOSSIER_FIELDS];

/** One guard's factual content: its canonical `GUARD <FIELD>: <value>` lines. */
export interface GuardFacts {
  readonly path: string;
  readonly lines: readonly string[];
}

/** The tracked floor: factual content, keyed by guard path. */
export interface FloorSnapshot {
  readonly flag: typeof FLOOR_FLAG;
  readonly schemaVersion: typeof FLOOR_SCHEMA_VERSION;
  readonly facts: readonly GuardFacts[];
}

/** A read attempt: absent/corrupt are verdicts, never a reason to write one. */
export type FloorLoad =
  | { readonly ok: true; readonly snapshot: FloorSnapshot; readonly path: string }
  | {
      readonly ok: false;
      readonly code: "floor_absent" | "floor_corrupt";
      readonly detail: string;
      readonly path: string;
    };

/** One discovered guard, as the judge sees it. */
export interface ObservedGuard {
  readonly path: string;
  readonly facts: GuardFacts;
  readonly source: string;
}

/** Why a floor was refused. */
export type FloorRefusalCode =
  | "floor_absent"
  | "floor_corrupt"
  | "universe_empty"
  | "guard_missing"
  | "population_unrecorded"
  | "facts_changed"
  | "exemption_reason";

/** The judge's verdict. `ok` is the whole answer; `code` locates a refusal. */
export interface FloorVerdict {
  readonly ok: boolean;
  readonly code: FloorRefusalCode | null;
  readonly detail: string;
}

/** Options a caller may narrow the universe with (test plants and future doors). */
export interface FloorJudgeOptions {
  /**
   * Paths the caller's discovery deliberately ignores. A universe consisting
   * ONLY of ignored paths is an EMPTY universe, not a clean one — the vacuity
   * the measurement contract refuses. The judge applies the predicate itself
   * (rather than trusting a pre-filtered list) so a discovery that forgets to
   * filter is still judged.
   */
  readonly ignoredPaths?: (path: string) => boolean;
}

/** The structural shape `observeDossiers` needs from a discovery verdict. */
export interface DossierVerdictLike {
  readonly path: string;
  readonly dossier: Dossier | null;
  readonly source: string;
  readonly problems: readonly { readonly message: string }[];
}

/**
 * The canonical fact lines of a valid dossier. Throws on a dossier the parser
 * should already have refused: a floor built from duplicates or unknown fields
 * would freeze the ambiguity instead of the fact.
 */
export function factsOf(path: string, dossier: Dossier): GuardFacts {
  const values = new Map<string, string>();
  for (const field of dossier.fields) {
    if (!FACT_FIELDS.includes(field.name)) {
      throw new Error(`factsOf(${path}): unknown dossier field ${JSON.stringify(field.name)}`);
    }
    if (values.has(field.name)) {
      throw new Error(`factsOf(${path}): duplicate dossier field ${JSON.stringify(field.name)}`);
    }
    values.set(field.name, field.value);
  }
  for (const required of REQUIRED_DOSSIER_FIELDS) {
    if (!values.has(required)) throw new Error(`factsOf(${path}): missing required dossier field GUARD ${required}:`);
  }
  return {
    path,
    lines: FACT_FIELDS.filter((name) => values.has(name)).map((name) => `GUARD ${name}: ${values.get(name)!}`),
  };
}

/**
 * The observed population from a discovery verdict: valid dossiers only, in
 * canonical fact form. The source is carried for the exemption-quality arm.
 */
export function observeDossiers(verdicts: readonly DossierVerdictLike[]): readonly ObservedGuard[] {
  const observed: ObservedGuard[] = [];
  for (const verdict of verdicts) {
    if (verdict.dossier === null || verdict.problems.length > 0) continue;
    observed.push({ path: verdict.path, facts: factsOf(verdict.path, verdict.dossier), source: verdict.source });
  }
  return observed;
}

/** The snapshot a set of observations canonically produces. */
export function canonicalSnapshot(observed: readonly ObservedGuard[]): FloorSnapshot {
  const seen = new Set<string>();
  const facts = observed.map((guard) => {
    if (seen.has(guard.path)) throw new Error(`canonicalSnapshot(): duplicate guard ${guard.path}`);
    seen.add(guard.path);
    return { path: guard.path, lines: [...guard.facts.lines] };
  });
  facts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { flag: FLOOR_FLAG, schemaVersion: FLOOR_SCHEMA_VERSION, facts };
}

const FACT_LINE = /^GUARD ([A-Z][A-Z0-9 -]*?): (\S.*)$/u;

/** Every structural problem that makes a parsed floor CORRUPT rather than absent. */
function snapshotProblems(parsed: unknown): readonly string[] {
  const problems: string[] = [];
  const raw = parsed as {
    flag?: unknown;
    schemaVersion?: unknown;
    facts?: unknown;
    floor?: unknown;
    population?: unknown;
  } | null;
  if (raw === null || typeof raw !== "object") return ["the floor is not a JSON object"];
  if (typeof raw.floor === "number" && raw.facts === undefined) {
    return [
      "the floor is the retired count-only snapshot (a `floor` number and a `population` list), " +
        "which cannot detect content moving between guards — regenerate it with `npm run dossier-floor:update`",
    ];
  }
  if (raw.flag !== FLOOR_FLAG) return [`the floor's flag is ${JSON.stringify(raw.flag)}, not ${JSON.stringify(FLOOR_FLAG)}`];
  if (raw.schemaVersion !== FLOOR_SCHEMA_VERSION) {
    return [
      `the floor's schemaVersion is ${JSON.stringify(raw.schemaVersion)}, not ` +
        `${JSON.stringify(FLOOR_SCHEMA_VERSION)} — regenerate it with \`npm run dossier-floor:update\``,
    ];
  }
  if (!Array.isArray(raw.facts)) return ["the floor has no `facts` array — a count-only snapshot is not a content floor"];
  if (raw.facts.length === 0) return ["the floor records no guards — an empty floor certifies nothing"];
  const seen = new Set<string>();
  raw.facts.forEach((entry: unknown, index: number) => {
    const record = entry as { path?: unknown; lines?: unknown } | null;
    const where = `facts[${index}]`;
    if (record === null || typeof record !== "object") {
      problems.push(`${where} is not an object`);
      return;
    }
    if (typeof record.path !== "string" || record.path.length === 0) {
      problems.push(`${where}.path is not a non-empty string`);
      return;
    }
    if (seen.has(record.path)) problems.push(`${where}.path ${JSON.stringify(record.path)} is recorded twice`);
    seen.add(record.path);
    if (!Array.isArray(record.lines) || record.lines.length === 0) {
      problems.push(`${where} (${record.path}) has no fact lines`);
      return;
    }
    const names = new Set<string>();
    for (const line of record.lines) {
      if (typeof line !== "string") {
        problems.push(`${where} (${record.path}) carries a non-string fact line`);
        continue;
      }
      const match = FACT_LINE.exec(line);
      if (match === null) {
        problems.push(`${where} (${record.path}) carries a malformed fact line ${JSON.stringify(line)}`);
        continue;
      }
      if (names.has(match[1]!)) problems.push(`${where} (${record.path}) records GUARD ${match[1]} twice`);
      names.add(match[1]!);
    }
    for (const required of REQUIRED_DOSSIER_FIELDS) {
      if (!names.has(required)) problems.push(`${where} (${record.path}) is missing GUARD ${required}:`);
    }
  });
  return problems;
}

/**
 * Read the tracked floor. ABSENT and CORRUPT are refusals with their own codes;
 * this function never creates, repairs, or rewrites the file.
 */
export function readFloorSnapshot(path: string): FloorLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        code: "floor_absent",
        path,
        detail:
          `the tracked dossier floor ${path} is MISSING. A fresh checkout must carry it ` +
          `(${FLOOR_RELATIVE_PATH} is committed). This test never writes a floor; to rebase it deliberately, ` +
          "run `npm run dossier-floor:update`.",
      };
    }
    return {
      ok: false,
      code: "floor_corrupt",
      path,
      detail: `the dossier floor ${path} could not be read (${code ?? String(error)}); it must be a committed file`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      code: "floor_corrupt",
      path,
      detail: `the dossier floor ${path} is not valid JSON (${(error as Error).message})`,
    };
  }
  const problems = snapshotProblems(parsed);
  if (problems.length > 0) {
    return {
      ok: false,
      code: "floor_corrupt",
      path,
      detail: `the dossier floor ${path} is corrupt:\n  ${problems.join("\n  ")}`,
    };
  }
  return { ok: true, snapshot: parsed as FloorSnapshot, path };
}

/**
 * THE ONLY WRITER. Called by the explicit rebase command, never by the judge
 * and never by a test run. The snapshot is canonical: facts sorted by path,
 * field lines in the dossier's canonical order, no timestamp (a clock in a
 * reviewed floor is churn, not evidence).
 */
export function writeFloorSnapshot(path: string, observed: readonly ObservedGuard[]): FloorSnapshot {
  const snapshot = canonicalSnapshot(observed);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

/** The first place two fact-line arrays differ, or null when they are equal. */
function firstDifference(expected: readonly string[], actual: readonly string[]): string | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    if (expected[index] === actual[index]) continue;
    return `line ${index + 1}: floor has ${JSON.stringify(expected[index] ?? null)}, tree has ${JSON.stringify(actual[index] ?? null)}`;
  }
  return null;
}

/**
 * Judge an observed population against a floor held IN MEMORY. Pure: no file
 * is read or written here, which is what lets the tests drive absent, corrupt,
 * empty, ignored-only, dropped, grown and moved cases without touching the
 * checkout.
 */
export function judgeFloorSnapshot(
  snapshot: FloorSnapshot,
  observed: readonly ObservedGuard[],
  options: FloorJudgeOptions = {},
): FloorVerdict {
  if (snapshot.facts.length === 0) {
    return {
      ok: false,
      code: "floor_corrupt",
      detail: "the floor records no guards — an empty floor certifies nothing",
    };
  }
  const ignored = options.ignoredPaths;
  const judged = ignored === undefined ? [...observed] : observed.filter((guard) => !ignored(guard.path));
  if (judged.length === 0) {
    return {
      ok: false,
      code: "universe_empty",
      detail:
        observed.length === 0
          ? "the dossier universe is EMPTY — a discovery that found no guards is a broken discovery, not a clean bill"
          : `every one of the ${observed.length} observed guard path(s) is ignored by the caller — an all-ignored universe is an EMPTY universe, not a clean one`,
    };
  }

  const byPath = new Map<string, ObservedGuard>();
  for (const guard of judged) {
    if (byPath.has(guard.path)) {
      return { ok: false, code: "population_unrecorded", detail: `the observed universe records ${guard.path} twice` };
    }
    byPath.set(guard.path, guard);
  }
  const floorByPath = new Map(snapshot.facts.map((facts) => [facts.path, facts]));

  const missing = snapshot.facts.map((facts) => facts.path).filter((path) => !byPath.has(path));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "guard_missing",
      detail:
        `the dossier population RETREATED: ${missing.length} guard(s) recorded in the floor are no longer in the ` +
        `observed population:\n  ${missing.join("\n  ")}\n` +
        "A guard may not lose its dossier silently. Restore it, or rebase the floor deliberately with " +
        "`npm run dossier-floor:update`.",
    };
  }

  const unrecorded = judged.map((guard) => guard.path).filter((path) => !floorByPath.has(path));
  if (unrecorded.length > 0) {
    return {
      ok: false,
      code: "population_unrecorded",
      detail:
        `${unrecorded.length} dossier-bearing guard(s) are NOT recorded in the floor:\n  ${unrecorded.join("\n  ")}\n` +
        "Growth is recorded by the explicit command, never by a test run: `npm run dossier-floor:update`.",
    };
  }

  for (const facts of snapshot.facts) {
    const guard = byPath.get(facts.path)!;
    const difference = firstDifference(facts.lines, guard.facts.lines);
    if (difference === null) continue;
    return {
      ok: false,
      code: "facts_changed",
      detail:
        `the dossier CONTENT of ${facts.path} changed (${difference}). Counts cannot see a line move between ` +
        "guards, so the floor compares the facts themselves. Rebase deliberately with `npm run dossier-floor:update` " +
        "after reviewing the change.",
    };
  }

  const exemptionProblems: string[] = [];
  for (const guard of judged) {
    for (const problem of validateFreshnessExemptions(guard.source, guard.path)) {
      exemptionProblems.push(`line ${problem.line}: ${problem.message}`);
    }
  }
  if (exemptionProblems.length > 0) {
    return {
      ok: false,
      code: "exemption_reason",
      detail:
        `a @freshness-exempt marker on a dossier-bearing guard does not carry a real reason:\n  ` +
        `${exemptionProblems.join("\n  ")}\n` +
        "An exemption is a claim about the world; name the artifact and why it needs no content binding.",
    };
  }

  return {
    ok: true,
    code: null,
    detail: `dossier floor holds: ${judged.length} guard(s), content compared line by line`,
  };
}

/**
 * The production entry: refuse an absent/corrupt floor, then judge the content.
 * This is the function a test calls; it has no access to a writer.
 */
export function judgeDossierFloor(
  load: FloorLoad,
  observed: readonly ObservedGuard[],
  options: FloorJudgeOptions = {},
): FloorVerdict {
  if (!load.ok) return { ok: false, code: load.code, detail: load.detail };
  return judgeFloorSnapshot(load.snapshot, observed, options);
}

/** A judge bound to one floor — the shape the plants drive. */
export function createJudge(
  load: FloorLoad,
  options: FloorJudgeOptions = {},
): (observed: readonly ObservedGuard[]) => FloorVerdict {
  return (observed) => judgeDossierFloor(load, observed, options);
}
