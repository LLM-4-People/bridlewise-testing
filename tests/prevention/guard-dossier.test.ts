// @vitest-environment node
/**
 * THE DOCUMENTED-MUTATION INDEX, MADE A GATE — every prevention guard carries
 * a structured dossier naming its canonical plant, its driven path, its
 * liveness precondition, and the owning behaviour.
 *
 * GUARD SUBJECT: prevention guards carry a structured `GUARD …:` dossier in the leading doc comment
 * GUARD OWNS: tests/helpers/prevention-dossier.ts (the parser/validator) + tests/helpers/dossier-floor.ts (the ratchet judge and its tracked floor) + engine/scripts/tooling/verification/guard-dossier.ts (the discovery door)
 * GUARD PLANT: delete the `GUARD PLANT:` line from a dossier-bearing guard, drop a guard from the observed population, swap a dossier line between two guards, or corrupt/remove the tracked floor — each is refused by content, and the dropped-guard plant reds if `judgeDossierFloor` is mutated to answer `ok: true`
 * GUARD DRIVEN: this file drives parseDossier + validateDossier over real guard sources, and judgeDossierFloor over the TRACKED content floor: the real population, a dropped guard, a line moved between guards, an empty universe, an all-ignored universe, an absent floor in a temp root, a corrupt floor, and the retired count-only format
 * GUARD LIVENESS: the discovery is asserted non-empty; the floor is asserted to be a committed git file; absent and corrupt floors refuse WITHOUT writing; the update command is asserted to be a separate registered command, and the judge leaves the tracked floor byte-identical
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
 * enforced as a RATCHET, not a sweep: the guards that carry the dossier now
 * are the ratcheted set, and a TRACKED floor records their factual content.
 * A guard that loses a dossier, changes a fact, or arrives new without the
 * floor being rebased is refused; a guard adding a dossier is recorded by the
 * explicit `npm run dossier-floor:update` command, never as a side effect of
 * a test run.
 *
 * ── WHY THE FLOOR IS TRACKED, AND WHY IT IS CONTENT ──────────────────────
 *
 * The first version kept the floor in the gitignored `.bridlewise/run-flags/`
 * directory and wrote the observed count when it was absent. On a fresh clone
 * that made the ratchet VACUOUS: deleting a dossier from a real guard with the
 * flag absent left the suite 12/12 green and wrote a lower floor. It also
 * compared only counts, so a dossier line moved from one guard to another was
 * invisible. The floor is now committed, absent/corrupt floors are REFUSALS,
 * and each record is the guard's canonical `GUARD <FIELD>:` lines — content,
 * not a number. The only writer is `scripts/testing/update-dossier-floor.ts`.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  OPTIONAL_DOSSIER_FIELDS,
  parseDossier,
  REQUIRED_DOSSIER_FIELDS,
  validateDossier,
} from "../helpers/prevention-dossier.ts";
import {
  canonicalSnapshot,
  createJudge,
  floorPathFor,
  FLOOR_RELATIVE_PATH,
  judgeDossierFloor,
  judgeFloorSnapshot,
  observeDossiers,
  readFloorSnapshot,
  writeFloorSnapshot,
  type ObservedGuard,
} from "../helpers/dossier-floor.ts";
import {
  PREVENTION_ESTATES,
  REPO_ROOT,
  validateAllDossiers,
} from "../../engine/scripts/tooling/verification/guard-dossier.ts";

import { gitTrackedPaths } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { modulePath } from "../helpers/module-resolver.ts";

const FLOOR_PATH = floorPathFor(REPO_ROOT);

/** The real observed population, read once per run. */
let discoveryCache: readonly ObservedGuard[] | undefined;
function discovered(): readonly ObservedGuard[] {
  discoveryCache ??= observeDossiers(validateAllDossiers().withDossier);
  return discoveryCache;
}

/** The judged population's total fact-line count — the number a count-only floor compared. */
function factLineCount(guards: readonly ObservedGuard[]): number {
  return guards.reduce((total, guard) => total + guard.facts.lines.length, 0);
}

/** A loaded tracked floor, or a thrown failure naming why it could not be read. */
function trackedFloor() {
  const load = readFloorSnapshot(FLOOR_PATH);
  if (!load.ok) throw new Error(`the tracked floor must load: ${load.detail}`);
  return load;
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

describe("the tracked content floor", () => {
  test("the floor is COMMITTED and its factual content matches the live dossiers", () => {
    // A floor that is not in the git index is the fresh-clone hole this round
    // closed: a checkout would not carry it, and the old test would write one.
    expect(
      gitTrackedPaths(REPO_ROOT).has(FLOOR_RELATIVE_PATH),
      `${FLOOR_RELATIVE_PATH} must be tracked — a gitignored floor is absent on a fresh checkout, ` +
        "which is exactly how the ratchet certified its own retreat",
    ).toBe(true);
    const load = trackedFloor();
    const observed = discovered();
    const verdict = judgeDossierFloor(load, observed);
    expect(verdict.ok, verdict.detail).toBe(true);
    expect(verdict.detail, "a green means the content was compared").toContain("content compared line by line");

    // THE FLOOR IS CONTENT, NOT A COUNT. A count-only snapshot cannot see a
    // line move between guards; these three fields are the shapes that cannot.
    const raw = JSON.parse(readFileSync(FLOOR_PATH, "utf8")) as Record<string, unknown>;
    expect(raw.facts, "the floor records per-guard fact sets").toBeInstanceOf(Array);
    expect(raw.floor, "a count is not a floor").toBeUndefined();
    expect(raw.population, "a path list cannot see content move between guards").toBeUndefined();
    expect(raw.writtenAt, "a reviewed floor carries no clock").toBeUndefined();
    expect(raw, "the committed file is exactly the canonical live snapshot").toEqual(
      JSON.parse(JSON.stringify(canonicalSnapshot(observed))) as unknown,
    );
  });

  test("a fresh checkout without the floor REFUSES, and nothing writes one", () => {
    const dir = createTempDir("ch-dossier-floor-absent-");
    const absent = join(dir, "dossier-floor.json");
    const load = readFloorSnapshot(absent);
    expect(load.ok, "an absent floor must not load as a green").toBe(false);
    if (load.ok) throw new Error("unreachable");
    expect(load.code).toBe("floor_absent");
    expect(load.detail, "the refusal names the committed location").toContain(FLOOR_RELATIVE_PATH);

    const observed = discovered();
    const verdict = judgeDossierFloor(load, observed);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("floor_absent");
    expect(existsSync(absent), "the judge MUST NOT establish a floor — that was the vacuity").toBe(false);

    // Corrupt is a refusal too, and the judge does not repair it.
    writeFileSync(absent, "{ not json", "utf8");
    const corrupt = readFloorSnapshot(absent);
    expect(corrupt.ok).toBe(false);
    if (corrupt.ok) throw new Error("unreachable");
    expect(corrupt.code).toBe("floor_corrupt");
    expect(readFileSync(absent, "utf8"), "a corrupt floor is never silently replaced").toBe("{ not json");

    // The RETIRED count-only format is corrupt, not a floor to honour: it is
    // the shape whose blind spot this round closed.
    writeFileSync(
      absent,
      JSON.stringify({ flag: "guard-dossier-ratchet-floor", floor: 16, population: ["tests/prevention/x.test.ts"] }),
      "utf8",
    );
    const legacy = readFloorSnapshot(absent);
    expect(legacy.ok).toBe(false);
    if (legacy.ok) throw new Error("unreachable");
    expect(legacy.code).toBe("floor_corrupt");
    expect(legacy.detail).toContain("count-only");
  });

  test("the update mode is a SEPARATE command; a test run never writes the floor", () => {
    // The floor changes only through a visibly different command. The test's
    // own judge is pure, and this test proves the tracked bytes survive it.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(
      manifest.scripts?.["dossier-floor:update"],
      "the explicit rebase command must be registered in package.json",
    ).toContain("scripts/testing/update-dossier-floor.ts");
    expect(
      existsSync(join(REPO_ROOT, "scripts/testing/update-dossier-floor.ts")),
      "the registered rebase command must exist",
    ).toBe(true);

    const observed = discovered();
    const before = readFileSync(FLOOR_PATH, "utf8");
    judgeDossierFloor(trackedFloor(), observed);
    expect(readFileSync(FLOOR_PATH, "utf8"), "the judge is not a writer").toBe(before);

    // The writer itself is driven against a TEMP path: it canonicalizes order
    // and round-trips the content, so the command cannot bless a lossy shape.
    const dir = createTempDir("ch-dossier-floor-update-");
    const target = join(dir, "dossier-floor.json");
    writeFloorSnapshot(target, [...observed].reverse());
    const reloaded = readFloorSnapshot(target);
    expect(reloaded.ok, reloaded.ok ? "" : reloaded.detail).toBe(true);
    if (!reloaded.ok) throw new Error("unreachable");
    expect(reloaded.snapshot.facts).toEqual(canonicalSnapshot(observed).facts);
  });
});

describe("the ratchet bites", () => {
  test("the plant CALLS the ratchet: a dropped dossier is refused by judgeDossierFloor", () => {
    // The previous plant computed `observed.length >= plantedFloor.floor` in
    // the test body and never called the judgment. Mutating the ratchet to
    // return `{ok: true}` left it green. This one hands the mutated population
    // to the real judge, so that mutation reds it.
    const load = trackedFloor();
    const observed = discovered();
    const victim = observed[0]!;
    const dropped = observed.filter((guard) => guard.path !== victim.path);

    const verdict = judgeDossierFloor(load, dropped);
    expect(verdict.ok, "a population that lost a recorded guard must be refused").toBe(false);
    expect(verdict.code).toBe("guard_missing");
    expect(verdict.detail).toContain(victim.path);
    expect(createJudge(load)(dropped), "the bound judge is the same judgment").toEqual(verdict);
  });

  test("a fact MOVED between guards changes no count and is still refused", () => {
    // The old floor recorded total size, size by guard and list length. Swapping
    // one fact line between two guards preserves all three, which is the exact
    // content move a count-only comparison could not see.
    const load = trackedFloor();
    const observed = discovered();
    const [left, right] = observed;
    expect(left, "the plant needs two guards").toBeDefined();
    expect(right, "the plant needs two guards").toBeDefined();
    const leftLine = left!.facts.lines[0]!;
    const rightLine = right!.facts.lines[0]!;
    const moved = observed.map((guard) => {
      if (guard.path === left!.path) return { ...guard, facts: { path: guard.path, lines: [rightLine, ...guard.facts.lines.slice(1)] } };
      if (guard.path === right!.path) return { ...guard, facts: { path: guard.path, lines: [leftLine, ...guard.facts.lines.slice(1)] } };
      return guard;
    });

    // The counts a number-only floor compared are IDENTICAL.
    expect(moved.length).toBe(observed.length);
    expect(factLineCount(moved)).toBe(factLineCount(observed));
    expect(moved.map((guard) => guard.facts.lines.length)).toEqual(observed.map((guard) => guard.facts.lines.length));

    const verdict = judgeDossierFloor(load, moved);
    expect(verdict.ok, "a line moved between guards must be refused").toBe(false);
    expect(verdict.code).toBe("facts_changed");
    expect(verdict.detail).toContain(left!.path);
  });

  test("an empty universe and an all-ignored universe are REFUSED, not skipped", () => {
    // The previous arms read the door's SOURCE for the string "empty universe"
    // and asserted a boolean about a population length. Neither can fail when
    // the refusal branch is disabled but its message is left in the file.
    const load = trackedFloor();
    const observed = discovered();

    expect(() => validateAllDossiers([]), "the door must throw on an empty universe").toThrowError(/empty universe/);

    const empty = judgeDossierFloor(load, []);
    expect(empty.ok).toBe(false);
    expect(empty.code).toBe("universe_empty");

    const allIgnored = judgeDossierFloor(load, observed, { ignoredPaths: () => true });
    expect(allIgnored.ok, "an all-ignored universe is an empty one").toBe(false);
    expect(allIgnored.code).toBe("universe_empty");

    // …and hiding ONE guard is not an empty universe, but it is still a refusal:
    // the ignore filter cannot quietly shrink the ratcheted set.
    const oneIgnored = judgeDossierFloor(load, observed, {
      ignoredPaths: (path) => path === observed[0]!.path,
    });
    expect(oneIgnored.ok).toBe(false);
    expect(oneIgnored.code).toBe("guard_missing");

    // SECONDARY ONLY: the behaviour above is the guard; this keeps the door's
    // diagnostic from rotting away unnoticed.
    const door = readFileSync(join(REPO_ROOT, modulePath("guard-dossier.ts")), "utf8");
    expect(door).toContain("empty universe");
    expect(PREVENTION_ESTATES.map((estate) => estate.dir)).toEqual([
      "tests/prevention",
      "engine/test/prevention",
    ]);
  });

  test("a @freshness-exempt reason that explains nothing is refused by the judge", () => {
    // The exemption that kept the old floor out of the freshness census was
    // never judged. These are the three dishonest shapes, driven through the
    // ratchet's own verdict, plus one honest reason that must pass.
    const load = trackedFloor();
    const observed = discovered();
    const subject = observed.find((guard) => guard.path === "tests/prevention/atomic-write-owner.test.ts");
    expect(subject, "the plant's subject must be in the ratcheted population").toBeDefined();
    const withMarker = (reason: string): readonly ObservedGuard[] =>
      observed.map((guard) =>
        guard.path === subject!.path
          ? { ...guard, source: `${guard.source}\n/**\n * @freshness-exempt${reason.length > 0 ? ` ${reason}` : ""}\n */\n` }
          : guard,
      );

    for (const [reason, expected] of [
      ["", "has no reason"],
      ["n/a", "placeholder"],
      ["it was always done this way and the behaviour is unchanged by any future edit at all", "names nothing"],
    ] as const) {
      const verdict = judgeDossierFloor(load, withMarker(reason));
      expect(verdict.ok, `reason ${JSON.stringify(reason)} must be refused`).toBe(false);
      expect(verdict.code).toBe("exemption_reason");
      expect(verdict.detail).toContain(expected);
    }

    const honest = judgeDossierFloor(
      load,
      withMarker("the atomic write owner preserves permission bits on real files, so the fixture is content complete"),
    );
    expect(honest.ok, honest.detail).toBe(true);
  });

  test("the floor is judged against the WHOLE population, not a subset", () => {
    // A judge that only checked the first record (or a sample) would pass the
    // real run and every plant above. Drop the LAST guard and require refusal.
    const load = trackedFloor();
    const observed = discovered();
    const last = observed[observed.length - 1]!;
    const verdict = judgeFloorSnapshot(load.snapshot, observed.slice(0, -1));
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("guard_missing");
    expect(verdict.detail).toContain(last.path);
  });
});
