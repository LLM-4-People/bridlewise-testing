/**
 * THE DOCUMENTED-MUTATION INDEX — the engine estate's half of the gate.
 *
 * GUARD SUBJECT: engine prevention guards carry a structured `GUARD …:` dossier in the leading doc comment
 * GUARD OWNS: tests/helpers/prevention-dossier.ts (the parser/validator) + engine/scripts/verification/guard-dossier.ts (the discovery door) — shared with the web half, so the two runners cannot drift on what a conforming dossier is
 * GUARD PLANT: delete the `GUARD PLANT:` line from a dossier-bearing engine guard, or add an unknown `GUARD FOO:` field — the validator names the missing/unknown field and the malformed count rises above zero
 * GUARD DRIVEN: this file's tests drive parseDossier + validateDossier over real engine guard sources through node:test; the web half drives the ratchet floor
 * GUARD LIVENESS: the discovery door throws on an empty universe, asserted here by proving the discovered population is non-empty and the malformed count is a real number over real files
 *
 * ── WHY A MIRROR, AND WHY IT IS NOT A SECOND OWNER ───────────────────────
 *
 * The web suite and the engine suite run under different runners (vitest,
 * node:test) with different working directories, and each must be able to
 * fail on its own estate without the other running. The PARSER and the
 * DISCOVERY are shared — this file holds no re-implementation of either,
 * only the engine-side drive and the engine-side floor. The dossier field
 * vocabulary is asserted identical to the shared module's, so this mirror
 * cannot quietly become a second definition.
 *
 * The ratchet floor lives in the web half: the floor is one number over the
 * WHOLE population (both estates), and the web suite is the one that also
 * runs the broader guard census. This half asserts the engine estate's own
 * dossier-bearing guards are well-formed and that the engine estate's
 * discovery is non-empty.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OPTIONAL_DOSSIER_FIELDS,
  parseDossier,
  REQUIRED_DOSSIER_FIELDS,
  validateDossier,
} from "../../../tests/helpers/prevention-dossier.ts";
import {
  discoverPreventionGuards,
  validateAllDossiers,
} from "../../scripts/tooling/verification/guard-dossier.ts";

test("the dossier parser, driven from the engine estate", () => {
  const source = [
    "/**",
    " * Engine guard.",
    " *",
    " * GUARD SUBJECT: the thing under guard",
    " * GUARD OWNS: engine/src/owner.ts",
    " * GUARD PLANT: remove the call",
    " * GUARD DRIVEN: through the CLI verb",
    " * GUARD LIVENESS: the probe ran",
    " */",
    'import { x } from "./x.ts";',
  ].join("\n");
  const dossier = parseDossier(source);
  assert.ok(dossier !== null, "a dossier must be found in the leading comment");
  assert.deepEqual(validateDossier(dossier, "fixture.test.ts"), []);

  const missing = [
    "/**",
    " * GUARD SUBJECT: x",
    " * GUARD OWNS: x",
    " * GUARD DRIVEN: x",
    " */",
  ].join("\n");
  const problems = validateDossier(parseDossier(missing), "fixture.test.ts");
  assert.ok(
    problems.some((p) => p.message.includes("GUARD PLANT:")),
    `a missing required field must be named; got: ${problems.map((p) => p.message).join("; ")}`,
  );
});

test("the field vocabulary the engine mirror uses is the shared one", () => {
  assert.deepEqual([...REQUIRED_DOSSIER_FIELDS], ["SUBJECT", "OWNS", "PLANT", "DRIVEN"]);
  assert.deepEqual([...OPTIONAL_DOSSIER_FIELDS], ["LIVENESS", "BOUNDARY"]);
});

test("every discovered engine guard with a dossier is well-formed", () => {
  const universe = validateAllDossiers();
  assert.ok(universe.total > 0, "discovery must find guards");
  const engineGuards = universe.withDossier.filter((v) => v.path.startsWith("engine/test/prevention/"));
  const bad = engineGuards.filter((v) => v.problems.length > 0);
  assert.deepEqual(
    bad.map((v) => `${v.path}: ${v.problems.map((p) => p.message).join("; ")}`),
    [],
    "every engine dossier-bearing guard must validate",
  );
});

test("the engine estate is discovered non-empty, and the door REFUSES an empty universe", () => {
  const all = discoverPreventionGuards();
  const engine = all.filter((p) => p.startsWith("engine/test/prevention/"));
  assert.ok(engine.length > 0, "the engine prevention estate must not be empty");
  // DRIVE the refusal, do not read its source: an empty universe is a broken
  // discovery, and this is the behaviour the door must keep. (The previous
  // version asserted the file contained the string "empty universe", which
  // stayed green when the branch was disabled but its message left in place.)
  assert.throws(
    () => validateAllDossiers([]),
    /empty universe/,
    "the door must throw on an empty universe rather than report a clean zero",
  );
});
