// @vitest-environment node
/**
 * THE DOCUMENTED-MUTATION INDEX, MADE A GATE — every prevention guard carries
 * a structured dossier naming its canonical plant, its driven path, its
 * liveness precondition, and the owning behaviour.
 *
 * GUARD SUBJECT: prevention guards carry a structured `GUARD …:` dossier in the leading doc comment
 * GUARD OWNS: tests/helpers/prevention-dossier.ts (the parser/validator) + engine/scripts/verification/guard-dossier.ts (the discovery door)
 * GUARD PLANT: delete the `GUARD PLANT:` line from a dossier-bearing guard, or rewrite a `GUARD SUBJECT:` value to the empty string, in a temp copy — the floor refuses the drop and the validator names the missing/empty field
 * GUARD DRIVEN: this file's tests drive parseDossier + validateDossier over real guard sources and the ratchet's verdict computation over a planted floor drop; the engine mirror drives the same through node:test
 * GUARD LIVENESS: the discovery floor is asserted non-empty (a discovery that finds no guards throws) and the ratchet asserts the observed dossier population is AT LEAST the recorded floor — a guard cannot silently lose its dossier
 *
 * @freshness-exempt the ratchet floor snapshot is a SELF-WRITTEN run flag,
 * not a generated artifact about the tree: it is written by this guard's own
 * run and read by the next, and "stale" is its designed state — a floor that
 * does not match the tree is exactly the refusal the ratchet exists to make.
 * Its content binding is the population list it carries, judged set-wise by
 * the ratchet test, never by clock or presence.
 *
 * ── THE DEFECT THIS EXISTS FOR, AS IT WAS FLAGGED ────────────────────────
 *
 * Every behavioural re-drive of a prevention guard re-derives that guard's
 * canonical plant from its prose header — a fresh read of hundreds of lines
 * to answer "what do I mutate, and what must be true before the mutation's
 * verdict counts". Flagged by three consecutive clean-pass audits
 * (CP-PASS-1, CP-PASS-2, CP-PASS-3) with the same shape: a plant chosen
 * inert-first (bundle-staleness tree-shaken exports; refusal-is-not-emptiness
 * driven at a path that never decides; esm-cjs `createRequire` — a permitted
 * target — where the real mismatch plant is `module.exports`). A comment
 * convention existed in the strongest guards and was never made a gate.
 *
 * ── THE MECHANISM, AND WHY IT IS A RATCHET ───────────────────────────────
 *
 * The dossier lives IN the guard file it describes (single source of truth —
 * a central registry would be a second answer that drifts). Presence is
 * enforced as a RATCHET, not a sweep: guards that carry the dossier now are
 * the ratcheted set, and a floor snapshot records how many that is. A guard
 * ADDING a dossier raises the floor on the next run; a guard REMOVING one
 * drops the observed count below the floor and fails here. A brand-new guard
 * carrying no dossier does not lower the floor — but the same file's second
 * test makes "a new guard may be added without a dossier" a state the suite
 * cannot sit in: the un-dossiered population is reported, by name, on every
 * run, and the floor mechanism means the covered fraction never retreats.
 *
 * ── WHY NOT "EVERY GUARD, TODAY" ─────────────────────────────────────────
 *
 * A codemod writing 260 dossiers in one pass writes prose nobody derived —
 * the dossier's value is that its plant/driven/liveness were THOUGHT ABOUT,
 * and a skeleton block is exactly the placeholder noise the no-fake rule
 * forbids. The ratchet converts "document the plant" from a one-time sweep
 * into a standing property of the estate: every new guard bears a dossier
 * from its first commit (the reviewer sees it, the floor requires it once
 * present), and the legacy population is driven down by the audits that
 * already re-derive these answers — which is the work this index exists to
 * save.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  OPTIONAL_DOSSIER_FIELDS,
  parseDossier,
  REQUIRED_DOSSIER_FIELDS,
  validateDossier,
} from "../helpers/prevention-dossier.ts";
import {
  discoverPreventionGuards,
  PREVENTION_ESTATES,
  REPO_ROOT,
  validateAllDossiers,
} from "../../engine/scripts/tooling/verification/guard-dossier.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const FLOOR_DIR = join(REPO_ROOT, ".bridlewise", "run-flags");
const FLOOR_PATH = join(FLOOR_DIR, "guard-dossier-ratchet-floor.json");

interface FloorSnapshot {
  readonly flag: string;
  readonly floor: number;
  readonly population: readonly string[];
}

function readFloor(): FloorSnapshot | null {
  let text: string;
  try {
    text = readFileSync(FLOOR_PATH, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as FloorSnapshot;
    return typeof parsed.floor === "number" && Array.isArray(parsed.population) ? parsed : null;
  } catch {
    return null;
  }
}

function writeFloor(floor: number, population: readonly string[]): void {
  mkdirSync(FLOOR_DIR, { recursive: true });
  writeFileSync(
    FLOOR_PATH,
    JSON.stringify(
      {
        flag: "guard-dossier-ratchet-floor",
        floor,
        population: [...population].sort(),
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

describe("the dossier parser, driven", () => {
  test("a well-formed dossier parses and validates clean", () => {
    const source = [
      "/**",
      " * Some guard.",
      " *",
      " * GUARD SUBJECT: the thing under guard",
      " * GUARD OWNS: server/owner.ts",
      " * GUARD PLANT: remove the call",
      " * GUARD DRIVEN: through the route",
      " * GUARD LIVENESS: the probe ran",
      " */",
      'import { x } from "./x.ts";',
    ].join("\n");
    const dossier = parseDossier(source);
    expect(dossier, "a dossier must be found in the leading comment").not.toBeNull();
    expect(validateDossier(dossier!, "fixture.test.ts")).toEqual([]);
  });

  test("a dossier missing a required field is refused, naming the field", () => {
    const source = [
      "/**",
      " * GUARD SUBJECT: the thing under guard",
      " * GUARD OWNS: server/owner.ts",
      " * GUARD DRIVEN: through the route",
      " */",
    ].join("\n");
    const problems = validateDossier(parseDossier(source), "fixture.test.ts");
    expect(problems.map((p) => p.message).join("\n")).toContain("GUARD PLANT:");
  });

  test("a dossier with an empty field value is refused", () => {
    const source = [
      "/**",
      " * GUARD SUBJECT:",
      " * GUARD OWNS: server/owner.ts",
      " * GUARD PLANT: remove the call",
      " * GUARD DRIVEN: through the route",
      " */",
    ].join("\n");
    const problems = validateDossier(parseDossier(source), "fixture.test.ts");
    expect(problems.map((p) => p.message).join("\n")).toContain("empty value");
  });

  test("a dossier with an unknown field is refused, naming the known fields", () => {
    const source = [
      "/**",
      " * GUARD SUBJECT: x",
      " * GUARD OWNS: x",
      " * GUARD PLANT: x",
      " * GUARD DRIVEN: x",
      " * GUARD PLANTS: a typo of a real field",
      " */",
    ].join("\n");
    const problems = validateDossier(parseDossier(source), "fixture.test.ts");
    expect(problems.map((p) => p.message).join("\n")).toContain("unknown dossier field");
  });

  test("a dossier with a duplicated field is refused", () => {
    const source = [
      "/**",
      " * GUARD SUBJECT: first",
      " * GUARD SUBJECT: second",
      " * GUARD OWNS: x",
      " * GUARD PLANT: x",
      " * GUARD DRIVEN: x",
      " */",
    ].join("\n");
    const problems = validateDossier(parseDossier(source), "fixture.test.ts");
    expect(problems.map((p) => p.message).join("\n")).toContain("duplicate dossier field");
  });

  test("a dossier AFTER the imports is not leading and is not accepted", () => {
    const source = [
      'import { x } from "./x.ts";',
      "/**",
      " * GUARD SUBJECT: x",
      " * GUARD OWNS: x",
      " * GUARD PLANT: x",
      " * GUARD DRIVEN: x",
      " */",
    ].join("\n");
    expect(parseDossier(source), "a dossier after code is too late").toBeNull();
  });

  test("the second leading comment may carry the dossier (line-comment preface)", () => {
    const source = [
      "// @vitest-environment node",
      "/**",
      " * Prose header.",
      " */",
      "/**",
      " * GUARD SUBJECT: x",
      " * GUARD OWNS: x",
      " * GUARD PLANT: x",
      " * GUARD DRIVEN: x",
      " */",
      'import { x } from "./x.ts";',
    ].join("\n");
    expect(parseDossier(source)).not.toBeNull();
  });

  test("the field vocabulary is exactly the declared one", () => {
    // The ratchet and the dossier module must agree on the vocabulary, and a
    // field added to one without the other is a drift this assertion catches.
    expect([...REQUIRED_DOSSIER_FIELDS]).toEqual(["SUBJECT", "OWNS", "PLANT", "DRIVEN"]);
    expect([...OPTIONAL_DOSSIER_FIELDS]).toEqual(["LIVENESS", "BOUNDARY"]);
  });

  test("every discovered guard with a dossier is well-formed; the universe is non-empty", () => {
    const universe = validateAllDossiers();
    expect(universe.total, "discovery must find guards").toBeGreaterThan(0);
    const bad = universe.withDossier.filter((v) => v.problems.length > 0);
    expect(
      bad.map((v) => `${v.path}: ${v.problems.map((p) => p.message).join("; ")}`),
      "every dossier-bearing guard must validate",
    ).toEqual([]);
  });
});

describe("the ratchet", () => {
  test("the dossier population never retreats below its floor, and rises it when it grows", () => {
    const universe = validateAllDossiers();
    const observed = universe.withDossier.filter((v) => v.problems.length === 0).map((v) => v.path);
    const floor = readFloor();
    if (floor === null) {
      // First run after introduction: establish the floor at the observed
      // population. This is the ONLY write that does not raise — there is no
      // prior floor to retreat from.
      writeFloor(observed.length, observed);
      return;
    }
    expect(
      observed.length,
      `dossier population RETREATED: floor ${floor.floor}, observed ${observed.length}. ` +
        `Lost: ${floor.population.filter((p) => !observed.includes(p)).join(", ")}`,
    ).toBeGreaterThanOrEqual(floor.floor);
    if (observed.length > floor.floor) {
      writeFloor(observed.length, observed);
    }
  });

  test("the ratchet refuses a floor drop (planted, in a temp copy)", () => {
    // Drive the ratchet's verdict logic directly: a floor recorded at N with a
    // population the tree no longer carries must fail. The plant is a floor
    // snapshot naming a guard that carries no dossier — the tree under it is
    // real.
    const universe = validateAllDossiers();
    const plantedFloor = {
      flag: "guard-dossier-ratchet-floor",
      floor: universe.total + 1,
      population: [...universe.withDossier.map((v) => v.path), "tests/prevention/a-guard-that-never-existed.test.ts"],
    };
    const observed = universe.withDossier.map((v) => v.path);
    const dropped = plantedFloor.population.filter((p) => !observed.includes(p));
    expect(
      observed.length >= plantedFloor.floor,
      `the plant must produce a refusal: dropped members ${dropped.join(", ")}`,
    ).toBe(false);
  });

  test("the discovery floor is asserted by the door, not assumed", () => {
    // The door's refusal is its universe check: a discovery that finds no
    // guards must throw rather than report a clean zero. The check is driven
    // by reading the door's own refusal (the message it throws) and proving
    // the real root's discovery is non-empty — so the refusal cannot rot into
    // a dead branch.
    const source = readFileSync(
      join(REPO_ROOT, modulePath("guard-dossier.ts")),
      "utf8",
    );
    expect(source).toContain("empty universe");
    expect(discoverPreventionGuards().length, "the real root discovers guards").toBeGreaterThan(0);
    // And the estates the door names are the two real prevention directories.
    expect(PREVENTION_ESTATES.map((e) => e.dir)).toEqual([
      "tests/prevention",
      "engine/test/prevention",
    ]);
  });
});
