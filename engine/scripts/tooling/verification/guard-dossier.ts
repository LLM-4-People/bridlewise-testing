/**
 * THE GUARD-DOSSIER DOOR — who counts as a prevention guard, and what a
 * conforming one carries.
 *
 * ── What this module owns ────────────────────────────────────────────────
 *
 * The UNIVERSE. A prevention guard is a `*.test.ts` file directly inside
 * either estate's prevention directory, discovered from the filesystem at
 * run time. A guard added tomorrow is covered without an edit to anything —
 * the directory IS the registry. This module is the single answer to "which
 * files are prevention guards", so the web (vitest) and engine (node:test)
 * enforcement guards can never disagree about the population they judge.
 *
 * The verdict shape is shared too: `validateAllDossiers` reads and validates
 * every discovered guard through the dossier module's one parser, and
 * refuses on an empty universe — a discovery that found nothing is a broken
 * discovery, not a clean bill.
 *
 * ── What this module deliberately does NOT own ───────────────────────────
 *
 * The RATCHET FLOOR. The ratchet is stateful (a floor that only rises, per
 * the guard that bears it), and both runner behaviours — refusal semantics,
 * where the floor lives, when a rewrite is safe — are exercised by real runs,
 * not by this module's say-so. The floor is each enforcement guard's own
 * state, kept in the estate whose suite runs it, so the two suites never
 * hold a write lock on one another's bookkeeping.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseDossier,
  validateDossier,
  type Dossier,
  type DossierProblem,
} from "../../../../tests/helpers/prevention-dossier.ts";

/** One estate's prevention directory, repo-root-relative. */
export interface PreventionEstate {
  /** Short name for diagnostics: `web` or `engine`. */
  readonly name: string;
  /** Repo-root-relative directory holding the guards. */
  readonly dir: string;
}

/** Both prevention estates, in stable order. */
export const PREVENTION_ESTATES: readonly PreventionEstate[] = [
  { name: "web", dir: "tests/prevention" },
  { name: "engine", dir: "engine/test/prevention" },
];

const TEST_FILE = /^[^.]+\.test\.ts$/;

/**
 * The repository root, derived from THIS module's own path
 * (`engine/scripts/verification/guard-dossier.ts`) rather than from the
 * caller's working directory — the engine suite and the web suite run with
 * different cwds, and a dossier universe that depends on who invoked the
 * runner is not a universe.
 */
export const REPO_ROOT: string = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * Discover every prevention guard in both estates. Returns repo-relative
 * paths, sorted, estate by estate. This is the ONLY definition of "a
 * prevention guard" the dossier guards use — a file added to either
 * directory is discovered on the next run.
 */
export function discoverPreventionGuards(): readonly string[] {
  const guards: string[] = [];
  for (const estate of PREVENTION_ESTATES) {
    const absolute = join(REPO_ROOT, estate.dir);
    const entries = readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && TEST_FILE.test(entry.name)) {
        guards.push(`${estate.dir}/${entry.name}`);
      }
    }
  }
  return guards.sort();
}

/** A guard whose dossier parsed, with the validation verdict. */
export interface GuardDossierVerdict {
  readonly path: string;
  readonly dossier: Dossier | null;
  readonly problems: readonly DossierProblem[];
  /**
   * The guard's own source. Carried so the ratchet can judge the guard's
   * `@freshness-exempt` reason without a second file read that could race a
   * writer — one read at the door is the source the whole judgement sees.
   */
  readonly source: string;
}

/** The full population verdict, with the universe never allowed to be empty. */
export interface DossierUniverse {
  /** Every discovered guard, both estates. */
  readonly total: number;
  /** Guards carrying a dossier, each with its validation verdict. */
  readonly withDossier: readonly GuardDossierVerdict[];
  /** Guards carrying no dossier — the un-ratcheted population. */
  readonly withoutDossier: readonly string[];
}

/**
 * Read and validate the dossier of every discovered guard.
 *
 * THROWS when the universe is empty: a discovery that found no guards is a
 * broken discovery (a renamed directory, a wrong root), and an empty
 * universe must fail loudly rather than report "0 guards, 0 violations".
 *
 * `guards` is injectable so the refusal can be DRIVEN with an empty list
 * rather than inferred from a source substring. The default is the real
 * discovery; production callers never pass anything else.
 */
export function validateAllDossiers(guards: readonly string[] = discoverPreventionGuards()): DossierUniverse {
  if (guards.length === 0) {
    throw new Error(
      `guard-dossier: discovery found no prevention guards under ${PREVENTION_ESTATES.map((e) => e.dir).join(", ")} — ` +
        `an empty universe is a broken discovery, not a clean bill`,
    );
  }
  const withDossier: GuardDossierVerdict[] = [];
  const withoutDossier: string[] = [];
  for (const path of guards) {
    const source = readFileSync(join(REPO_ROOT, path), "utf8");
    const dossier = parseDossier(source);
    if (dossier === null) {
      withoutDossier.push(path);
    } else {
      withDossier.push({ path, dossier, problems: validateDossier(dossier, path), source });
    }
  }
  return { total: guards.length, withDossier, withoutDossier };
}
