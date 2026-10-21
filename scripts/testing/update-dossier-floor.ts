/**
 * THE EXPLICIT GUARD-DOSSIER FLOOR REBASE.
 *
 *   npm run dossier-floor:update
 *
 * This is the ONLY command that writes `tests/prevention/dossier-floor.json`.
 * The ratchet test never writes it: a missing or corrupt floor is a refusal,
 * and a content change is a refusal until somebody runs this command and
 * reviews the diff it produces.
 *
 * The command refuses to bless a state the judge would refuse anyway: every
 * discovered dossier must validate, the universe must be non-empty, and every
 * `@freshness-exempt` marker on a dossier-bearing guard must carry a real
 * reason. It prints the delta (added / removed / changed guards) before
 * writing, so the reviewed change is visible in the command's own output.
 */

import { validateAllDossiers, REPO_ROOT } from "../../engine/scripts/tooling/verification/guard-dossier.ts";
import {
  canonicalSnapshot,
  floorPathFor,
  judgeFloorSnapshot,
  observeDossiers,
  readFloorSnapshot,
  writeFloorSnapshot,
} from "../../tests/helpers/dossier-floor.ts";

function fail(message: string): void {
  console.error(`dossier-floor:update: REFUSED — ${message}`);
  process.exitCode = 1;
}

const universe = validateAllDossiers();
const malformed = universe.withDossier.filter((verdict) => verdict.problems.length > 0);
if (malformed.length > 0) {
  fail(
    `${malformed.length} dossier-bearing guard(s) are malformed; fix them before rebasing the floor:\n  ` +
      malformed.map((verdict) => `${verdict.path}: ${verdict.problems.map((problem) => problem.message).join("; ")}`).join("\n  "),
  );
} else {
  const observed = observeDossiers(universe.withDossier);
  const verdict = judgeFloorSnapshot(canonicalSnapshot(observed), observed);
  if (!verdict.ok) {
    fail(verdict.detail);
  } else {
    const floorPath = floorPathFor(REPO_ROOT);
    const before = readFloorSnapshot(floorPath);
    const beforeFacts = before.ok ? before.snapshot.facts : [];
    const beforePaths = new Set(beforeFacts.map((facts) => facts.path));
    const afterPaths = new Set(observed.map((guard) => guard.path));
    const beforeByPath = new Map(beforeFacts.map((facts) => [facts.path, facts]));
    const added = [...afterPaths].filter((path) => !beforePaths.has(path));
    const removed = [...beforePaths].filter((path) => !afterPaths.has(path));
    const changed = [...afterPaths].filter((path) => {
      const earlier = beforeByPath.get(path);
      const current = observed.find((guard) => guard.path === path)!;
      return earlier !== undefined && JSON.stringify(earlier.lines) !== JSON.stringify(current.facts.lines);
    });
    writeFloorSnapshot(floorPath, observed);
    console.log(
      `dossier-floor:update: wrote ${observed.length} guard(s) to ${floorPath}\n` +
        `  added:   ${added.length === 0 ? "none" : added.join(", ")}\n` +
        `  removed: ${removed.length === 0 ? "none" : removed.join(", ")}\n` +
        `  changed: ${changed.length === 0 ? "none" : changed.join(", ")}`,
    );
  }
}
