// @vitest-environment node
/**
 * Mechanical enforcement: NO VOCABULARY IS WRITTEN TWICE.
 *
 * ── THE CLASS ─────────────────────────────────────────────────────────────
 *
 * A finite union and a list of its members, declared separately:
 *
 *     type MemorySource = "tool" | "conversation" | "llm" | "user";
 *     const MEMORY_SOURCES: readonly MemorySource[] = ["tool", ...];
 *
 * is one vocabulary held in two places, and TypeScript cannot join them: an
 * array with FEWER members is assignable to `readonly T[]`. So adding a
 * member to the union and forgetting the array compiles with zero errors,
 * while every consumer built from the array answers for the smaller set.
 *
 * Driven on this tree before the fix, in both repositories:
 *
 *   - `MEMORY_SOURCES` fed the server's validation set AND the `sources`
 *     field of `/api/memory`. A fifth source would have been REJECTED at the
 *     boundary and ABSENT from the API, silently.
 *   - `MEMORY_TIERS`' own doc comment said it existed so nothing "would
 *     silently miss a new tier" — while being the exact shape that can.
 *   - a guard over the flow compression ladder said it was "DYNAMIC over the
 *     level list, so a level added tomorrow cannot quietly omit identity",
 *     above a hand-written list of three.
 *   - a test titled "all ErrorKind values are present" listed seven by hand.
 *   - the CHEP matrix generator restated FOUR vocabularies its own types
 *     module already exported, so a new phase or arm could have been dropped
 *     from a preregistered factorial design with nothing red.
 *
 * ── WHY A GUARD, GIVEN THE INSTANCES ARE FIXED ────────────────────────────
 *
 * Every instance above is now owned by its array (`as const` with `type T =
 * typeof ARRAY[number]`) or derived from a `Record<T, …>` the compiler forces
 * to be complete, which puts the omission at rung 2 — unrepresentable, not
 * merely discouraged. That is the fix, and it does not stop the NEXT one from
 * being written. The next one is invisible in exactly the way these were: it
 * typechecks, its tests pass, and it is wrong only about a member that does
 * not exist yet.
 *
 * ── WHAT THIS FILE ADDS THAT THE OWNER DOES NOT ───────────────────────────
 *
 * The rule lives in one shared module. This file drives it over BOTH
 * repositories' real trees and plants violations from OUTSIDE the owner, into
 * temporary files injected into the scan list — never into a tracked source
 * file, because two guards once chose the same real module as a canary, ran
 * in parallel, and left it at zero bytes.
 *
 * It also asserts the guard does not read its own prose. A scanner whose
 * universe comes from source text will scan its own comments: the owner's
 * header contains the exact declaration it refuses, and this header does too.
 */
import { describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIBERATE_SUBSET_MARKER,
  declaredUniverseFailure,
  findDeclaredUniverses,
  scanForDeclaredUniverses,
  unownedUniverses,
} from "../../engine/scripts/verification/declared-universe.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const WEB_ROOT = process.cwd();
const INTEGRATION_ROOT = join(WEB_ROOT, "engine");

/**
 * The two trees, and the directories each one's source lives in.
 *
 * ── THIS LIST WAS ASYMMETRIC, AND THE ASYMMETRY WAS THE DEFECT ────────────
 *
 * The web side named its test tree; the integration side did not. So the test
 * titled "integration: every declared vocabulary is owned or declares why it
 * is partial" was green over a tree where it had never looked, and
 * `scanForDeclaredUniverses(INTEGRATION_ROOT, ["test"])` found SEVEN refused
 * declarations sitting outside its population — including one list of all
 * eight `AttemptKind` members and one of all six `AttemptOutcome` members,
 * both COMPLETE today, so a ninth kind tomorrow left those tests asserting the
 * old set with nothing red. Precisely the shape the rule exists for, in the
 * rule's own repository.
 *
 * ── AND IT IS STILL A LIST, WHICH IS STILL A WEAKNESS ─────────────────────
 *
 * A universe written by hand is the defect this file is about, one level up,
 * and saying so is better than pretending the repair is complete. What
 * remains outside, DRIVEN rather than assumed — `scanForDeclaredUniverses` over
 * the integration tree's other top-level directories reports **10 refused
 * declarations (UNIT = sites)** under `verification/benchmarks/` (6) and
 * `_experiments/` (4). Those are an archived analysis corpus and archived
 * experiment sources; neither is on a path anything ships, and clearing them
 * is a migration this step did not do. The number is written here so the next
 * reader inherits a quantity rather than a silence, and the durable repair is
 * to derive the roots from the repository instead of naming them.
 */
const REPOSITORIES: readonly Readonly<{ name: string; root: string; dirs: readonly string[] }>[] = [
  { name: "web", root: WEB_ROOT, dirs: ["src", "server", "shared", "tests", "bench", "scripts"] },
  { name: "integration", root: INTEGRATION_ROOT, dirs: ["src", "scripts", "test"] },
];

/**
 * Write a plant to disk and scan ONLY it. `source` never appears as a literal
 * in this file's own bytes for the cases that must be DETECTED — a plant that
 * names itself can be defeated by filtering that exact literal, and this file
 * is itself inside the population the real-tree test scans.
 */
function scanPlant(name: string, source: string) {
  const dir = createTempDir(`declared-universe-${name}-`);
  const file = join(dir, "plant.ts");
  writeFileSync(file, source);
  const universes = findDeclaredUniverses(source, file);
  return { file, universes, offenders: unownedUniverses(universes) };
}

/**
 * Assembled at runtime so the refused shape is not a literal in this file —
 * this file is inside the population the real-tree tests scan, and a plant
 * that names itself can be defeated by filtering that exact literal.
 *
 * `comment`, when given, is emitted IMMEDIATELY above the declaration with no
 * blank line, which is where a marker has to sit to belong to it.
 */
function handWrittenVocabulary(
  name: string,
  type: string,
  members: readonly string[],
  comment?: string,
): string {
  const list = members.map((m) => `  ${JSON.stringify(m)},`).join("\n");
  return [
    ...(comment === undefined ? [] : [`// ${comment}`]),
    `export ${"const"} ${name}: readonly ${type}[] = [`,
    list,
    "];",
  ].join("\n");
}

/** The union the vocabularies above are annotated with. */
function unionDeclaration(type: string, members: readonly string[]): string {
  return `export type ${type} = ${members.map((m) => JSON.stringify(m)).join(" | ")};`;
}

const LANES = ["air", "sea", "rail"] as const;

describe("declared universes — both repositories are free of hand-written vocabularies", () => {
  for (const repo of REPOSITORIES) {
    test(`${repo.name}: every declared vocabulary is owned or declares why it is partial`, () => {
      const { scanned, universes } = scanForDeclaredUniverses(repo.root, repo.dirs);

      // POPULATION AS A RUNTIME NUMBER (§ the floor that names what it bounds).
      // Both floors matter and they fail differently: zero files means the
      // walk broke, zero declarations means the MATCHER broke. A guard that
      // reports "no violations" after finding nothing to examine has agreed
      // with everything.
      expect(scanned, `${repo.name}: no source files were scanned`).toBeGreaterThan(0);
      expect(
        universes.length,
        `${repo.name}: the matcher found no annotated list declarations at all across ${scanned} files — ` +
          "a detector that recognises nothing cannot refuse anything",
      ).toBeGreaterThan(0);

      const failure = declaredUniverseFailure(unownedUniverses(universes));
      expect(failure, `${repo.name}\n${failure ?? ""}`).toBeNull();
    });
  }
});

describe("the declared-universe rule can fail — planted from outside the owner", () => {
  test("a hand-written vocabulary is REFUSED, and the refusal names it", () => {
    const planted = scanPlant(
      "unowned",
      handWrittenVocabulary("SHIPPING_LANES", "ShippingLane", ["air", "sea", "rail"]),
    );
    expect(planted.offenders).toHaveLength(1);
    const failure = declaredUniverseFailure(planted.offenders);
    expect(failure).not.toBeNull();
    // It must name the DECLARATION, not merely report a count — an operator
    // handed "1 violation" has to go and find it.
    expect(String(failure)).toContain("SHIPPING_LANES");
    expect(String(failure)).toContain("ShippingLane");
    // And the remedy is part of the guard: advice that does not survive being
    // followed is a guard certifying what it just rejected.
    expect(String(failure)).toContain("as const");
    expect(String(failure)).toContain("Object.keys");
  });

  test("the extracted members are the ones in the file, not a restatement of the pattern", () => {
    // § print what you extracted, and back the print with an assertion — a
    // display diagnoses, only an assertion gates. A matcher that reported the
    // declaration it matched rather than the list it read would pass every
    // test above while being wrong about every file.
    const planted = scanPlant(
      "members",
      handWrittenVocabulary("SHIPPING_LANES", "ShippingLane", ["air", "sea", "rail"]),
    );
    expect(planted.universes[0]?.members).toEqual(["air", "sea", "rail"]);
    expect(planted.universes[0]?.name).toBe("SHIPPING_LANES");
    expect(planted.universes[0]?.elementType).toBe("ShippingLane");
  });

  test("a declared reason with a CHECKED COUNT exempts it; a bare marker does not", () => {
    const withReason = handWrittenVocabulary(
      "SHIPPING_LANES",
      "ShippingLane",
      ["air", "sea"],
      `${DELIBERATE_SUBSET_MARKER} 2 of 3 — rail is not served on this route`,
    );
    const bare = handWrittenVocabulary(
      "SHIPPING_LANES",
      "ShippingLane",
      ["air", "sea"],
      DELIBERATE_SUBSET_MARKER,
    );

    expect(
      unownedUniverses(findDeclaredUniverses(withReason, "reasoned.ts")),
      "a partial list that states its count and why is a recorded decision",
    ).toHaveLength(0);
    expect(
      unownedUniverses(findDeclaredUniverses(bare, "bare.ts")),
      "an exemption with no reason is a claim about the world with no evidence behind it",
    ).toHaveLength(1);
  });

  // ── THE SEVEN WAYS THE EXEMPTION USED TO BE SILENCED ────────────────────
  //
  // Every one of these was DRIVEN against the previous implementation and came
  // back `offenders=0`. `declaredSubsetReason` returned any non-empty text
  // after the marker, `unownedUniverses` filtered on `!== null`, and there was
  // NO member-count check of any kind — the "8 of 9 / 5 of 13" arithmetic in
  // the live exemptions was done by hand and nothing re-checked it. That is
  // the "an exemption with no evidence is a claim nothing re-checks" the
  // owner's own header demands, unmet by the owner.

  test("PLANT 1 — the marker above a FULL vocabulary must state that it is full", () => {
    // Previously silenced: a 3-of-3 list wearing a "subset" marker. A complete
    // list is allowed (`src/quality/config.ts` names all eight signals on
    // purpose) — but it has to be WRITTEN as `3 of 3`, which is a claim
    // somebody made rather than one nobody checked.
    const understated = handWrittenVocabulary(
      "SHIPPING_LANES",
      "ShippingLane",
      [...LANES],
      `${DELIBERATE_SUBSET_MARKER} 2 of 3 — one lane is seasonal`,
    );
    const offenders = unownedUniverses(findDeclaredUniverses(understated, "full.ts"));
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.malformedSubsetReason).toMatch(/claims 2 member\(s\) and the declaration holds 3/u);

    const honest = handWrittenVocabulary(
      "SHIPPING_LANES",
      "ShippingLane",
      [...LANES],
      `${DELIBERATE_SUBSET_MARKER} 3 of 3 — it names every lane today, and that must stay a decision`,
    );
    expect(
      unownedUniverses(findDeclaredUniverses(honest, "full-declared.ts")),
      "a complete list that SAYS it is complete is a recorded decision, not a defect",
    ).toHaveLength(0);
  });

  test("PLANT 2 — a reason with NO machine-checkable count is refused", () => {
    // Previously silenced: prose alone. "two of the four lanes" reads as
    // evidence and is not: nothing compares it to anything.
    const prose = handWrittenVocabulary(
      "SHIPPING_LANES",
      "ShippingLane",
      ["air", "sea"],
      `${DELIBERATE_SUBSET_MARKER} two of the four lanes, on purpose`,
    );
    const offenders = unownedUniverses(findDeclaredUniverses(prose, "prose.ts"));
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.malformedSubsetReason).toMatch(/no machine-checkable count/u);
  });

  test("PLANT 3+4 — the marker inside a STRING or a TEMPLATE literal is not an exemption", () => {
    // Previously silenced, and provably read from a string interior: the
    // returned reason ended `";`. The repair is that the marker must sit on a
    // line that BEGINS as a comment, which a string interior does not.
    for (const [label, carrier] of [
      ["string", `const note = "${DELIBERATE_SUBSET_MARKER} 2 of 3 — see the ticket";`],
      ["template", "const note = `" + DELIBERATE_SUBSET_MARKER + " 2 of 3 — see the ticket`;"],
    ] as const) {
      const source = [
        carrier,
        handWrittenVocabulary("SHIPPING_LANES", "ShippingLane", ["air", "sea"]),
        "",
      ].join("\n");
      expect(
        unownedUniverses(findDeclaredUniverses(source, `${label}.ts`)),
        `a marker inside a ${label} literal is text, not a declaration`,
      ).toHaveLength(1);
    }
  });

  test("PLANT 5+6 — `.push(` inside a comment or a string no longer exempts anything", () => {
    // Previously silenced TWICE: `appendedTo` tested `\bNAME\.push\s*\(`
    // against RAW BYTES, so a mention in a comment or a string set it true and
    // `unownedUniverses` dropped the declaration. `appendedTo` is no longer an
    // exemption at all — an accumulator declares itself like everything else —
    // so both carriers are now inert.
    for (const [label, carrier] of [
      ["comment", "// historically we did SHIPPING_LANES.push(\"rail\") here"],
      ["string", 'const hint = "SHIPPING_LANES.push(rail)";'],
    ] as const) {
      const source = [
        carrier,
        "",
        handWrittenVocabulary("SHIPPING_LANES", "ShippingLane", ["air", "sea"]),
        "",
      ].join("\n");
      const found = findDeclaredUniverses(source, `push-${label}.ts`);
      expect(
        unownedUniverses(found),
        `a .push( mentioned only in a ${label} must not exempt the declaration`,
      ).toHaveLength(1);
    }
  });

  test("PLANT 7 — ADJACENT declarations, no blank line: the second cannot inherit the first's exemption", () => {
    // The plant the previous permanent test could not express, because its
    // fixture joined the parts with a blank line — so the very case the rule
    // is about was never driven. Here the two declarations are contiguous.
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      `// ${DELIBERATE_SUBSET_MARKER} 2 of 3 — only the lanes this route serves`,
      `export ${"const"} SERVED_LANES: readonly ShippingLane[] = ["air", "sea"];`,
      `export ${"const"} AUDITED_LANES: readonly ShippingLane[] = ["air"];`,
      "",
    ].join("\n");
    const offenders = unownedUniverses(findDeclaredUniverses(source, "adjacent.ts"));
    expect(
      offenders.map((o) => o.name),
      "the second declaration sits directly under the first, with no blank line to stop the walk",
    ).toEqual(["AUDITED_LANES"]);
  });

  test("a marker belonging to the PREVIOUS declaration does not exempt this one", () => {
    // The window is bounded by the blank line AND by the first non-comment
    // line. A window bounded by "the next similar construct" is how a guard
    // once manufactured an error code that had never existed — and here it
    // would silently extend one declaration's exemption over its neighbour.
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      handWrittenVocabulary(
        "SERVED_LANES",
        "ShippingLane",
        ["air", "sea"],
        `${DELIBERATE_SUBSET_MARKER} 2 of 3 — only the lanes this route serves`,
      ),
      "",
      handWrittenVocabulary("AUDITED_LANES", "ShippingLane", ["air"]),
      "",
    ].join("\n");
    const offenders = unownedUniverses(findDeclaredUniverses(source, "neighbour.ts"));
    expect(offenders.map((o) => o.name)).toEqual(["AUDITED_LANES"]);
  });

  test("an accumulator is recognised as one, and still has to declare itself", () => {
    const source = [
      "export function required(stream: boolean): readonly Capability[] {",
      `  const needed: readonly Capability[] = ["text"];`,
      `  if (stream) needed.push("streaming");`,
      "  return needed;",
      "}",
      "",
    ].join("\n");
    const found = findDeclaredUniverses(source, "accumulator.ts");
    expect(found, "the declaration is still recognised").toHaveLength(1);
    expect(found[0]?.appendedTo, "and recognised as appended to").toBe(true);
    expect(
      unownedUniverses(found),
      "being pushed to is INFORMATION, not an exemption — that flag was computed from raw " +
        "bytes and a `.push(` in a comment or a string silenced the guard entirely",
    ).toHaveLength(1);

    const declared = [
      "export function required(stream: boolean): readonly Capability[] {",
      `  // ${DELIBERATE_SUBSET_MARKER} 1 of 8 — an accumulator; the branches below add the rest`,
      `  const needed: readonly Capability[] = ["text"];`,
      `  if (stream) needed.push("streaming");`,
      "  return needed;",
      "}",
      "",
    ].join("\n");
    expect(
      unownedUniverses(findDeclaredUniverses(declared, "accumulator-declared.ts")),
      "one declared mechanism, checked, instead of a second undeclared one",
    ).toHaveLength(0);
  });

  test("an INDEXED ACCESS TYPE in the initializer is not read as a list", () => {
    // A LIVE FALSE POSITIVE, made permanent. The first draft took "the next
    // `[` within 200 characters" as the list, and on the first real run it
    // grabbed the bracket of `TimelineEdgeRecord["edgeType"]` — reporting a
    // mapped database read as a one-member vocabulary called `edges`.
    // Bracket-hunting is not parsing; the bracket must BE the initializer.
    const source = [
      "function rows(raw: readonly Row[]): readonly EdgeRecord[] {",
      "  const edges: readonly EdgeRecord[] = raw.map((e) => ({",
      `    edgeType: String(e.edge_type) as EdgeRecord["edgeType"],`,
      "  }));",
      "  return edges;",
      "}",
      "",
    ].join("\n");
    expect(
      findDeclaredUniverses(source, "indexed.ts"),
      "a mapped read is not a vocabulary, whatever brackets appear downstream",
    ).toHaveLength(0);
  });

  test("a declaration written inside a COMMENT is not part of the population", () => {
    // The owner's header, and this file's header, both contain the exact
    // declaration the rule refuses — written out so a reader can see the
    // shape. A scanner whose universe comes from source text will scan its
    // own comments, and documentation would then change the measurement.
    const source = [
      "/**",
      ` * export const SHIPPING_LANES: readonly ShippingLane[] = ["air", "sea"];`,
      " */",
      `// export const AUDITED_LANES: readonly ShippingLane[] = ["air"];`,
      "export const real = 1;",
      "",
    ].join("\n");
    expect(findDeclaredUniverses(source, "prose.ts")).toHaveLength(0);
  });

  test("the guard's own owner and this file are scanned, and neither is flagged", () => {
    // Not a claim — driven. Both files are inside the population the
    // real-tree tests walk, so if prose joined the universe these would be
    // the first two offenders.
    const owner = join(
      INTEGRATION_ROOT,
      "scripts",
      "verification",
      "declared-universe.ts",
    );
    const { universes } = scanForDeclaredUniverses(INTEGRATION_ROOT, [], [owner]);
    expect(universes, "the rule's own source must not match itself").toEqual([]);

    const web = scanForDeclaredUniverses(WEB_ROOT, ["tests/prevention"]);
    expect(
      web.scanned,
      "the prevention directory was not walked, so this proves nothing",
    ).toBeGreaterThan(0);
    expect(
      unownedUniverses(web.universes).map((u) => u.file),
      "no prevention guard may itself hold a hand-written vocabulary",
    ).toEqual([]);
  });

  // ── THE SAME CLAIM, IN THE OTHER POSITIONS TYPESCRIPT ALLOWS ────────────
  //
  // The rule reads ONE piece of evidence: a literal list of strings whose
  // ELEMENT TYPE IS NAMED. It used to recognise that evidence in exactly one
  // syntactic position — the variable annotation — so the identical claim
  // written as a constructor type argument, an `as` assertion or a `satisfies`
  // clause was invisible. Driven before the widening: a complete copy of an
  // eleven-member union inside `new Set<ToolKind>([…])` gave `tsc -p
  // tsconfig.server.json` exit 0, `tsc -p tsconfig.json` exit 0 and this
  // scanner `offenders=0`, while a config naming a twelfth kind failed the
  // set's membership test and fell through to the catch-all default.
  //
  // The shapes are assembled at run time so this file's own bytes do not
  // contain the refused form — it is inside the population the real-tree tests
  // scan, and a plant that names itself can be defeated by filtering it.

  test("a type-argument annotation carries the claim: `new Set<T>([…])` is refused", () => {
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      `export ${"const"} SERVED = new Set<ShippingLane>([${LANES.map((l) => JSON.stringify(l)).join(", ")}]);`,
      "",
    ].join("\n");
    const offenders = unownedUniverses(findDeclaredUniverses(source, "type-argument.ts"));
    expect(offenders.map((o) => o.name)).toEqual(["SERVED"]);
    expect(offenders[0]?.elementType).toBe("ShippingLane");
    expect(offenders[0]?.members).toEqual([...LANES]);
  });

  test("an `as T[]` assertion and a `satisfies readonly T[]` clause carry it too", () => {
    for (const [label, clause] of [
      ["as", "as ShippingLane[]"],
      ["satisfies", "satisfies readonly ShippingLane[]"],
    ] as const) {
      const source = [
        unionDeclaration("ShippingLane", LANES),
        "",
        `for (const lane of [${LANES.map((l) => JSON.stringify(l)).join(", ")}] ${clause}) {`,
        "  use(lane);",
        "}",
        "",
      ].join("\n");
      const offenders = unownedUniverses(findDeclaredUniverses(source, `${label}.ts`));
      expect(
        offenders.map((o) => o.elementType),
        `a list annotated with ${clause} makes the same unbacked claim as a variable annotation`,
      ).toEqual(["ShippingLane"]);
      expect(offenders[0]?.members).toEqual([...LANES]);
    }
  });

  test("the type argument is what is read — the CALLEE is not in the pattern", () => {
    // The widening must not become a list of blessed container names. A
    // container nobody has written yet is covered the moment it names its
    // element type, so the plant uses one that exists nowhere in either tree.
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      `export ${"const"} SERVED = new ManifestRegistry<ShippingLane>(["air", "sea"]);`,
      "",
    ].join("\n");
    expect(
      unownedUniverses(findDeclaredUniverses(source, "unknown-container.ts")).map((o) => o.name),
    ).toEqual(["SERVED"]);
  });

  test("a PRIMITIVE element type is not a vocabulary, in the new positions either", () => {
    // `new Set<string>([…])` is an ordinary set of strings and claims nothing
    // about any union. Refusing it would be the guard reporting on the wrong
    // subject, and there are hundreds of them.
    const source = [
      `export ${"const"} SEEN = new Set<string>(["air", "sea"]);`,
      `export ${"const"} ALSO = ["air", "sea"] as string[];`,
      "",
    ].join("\n");
    expect(findDeclaredUniverses(source, "primitive.ts")).toEqual([]);
  });

  test("a COMMENT INSIDE THE LIST no longer hides the declaration", () => {
    // A LIVE MISS, made permanent. The body matcher requires the list to hold
    // nothing but string literals, and it used to run over RAW BYTES — so a
    // `//` note between two members made the body impure and the whole
    // declaration was skipped. Driven on this tree: a FIFTY-member hand-written
    // vocabulary in `src/quality/config.ts` was invisible for exactly that
    // reason. The scan runs over a comment-blanked view now.
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      `export ${"const"} SERVED: readonly ShippingLane[] = [`,
      `  "air",`,
      `  // the sea route was added when the rail line closed`,
      `  "sea",`,
      `  "rail",`,
      "];",
      "",
    ].join("\n");
    const found = findDeclaredUniverses(source, "commented-list.ts");
    expect(found.map((f) => f.name)).toEqual(["SERVED"]);
    expect(found[0]?.members, "the comment is blanked, the members survive").toEqual([...LANES]);
  });

  test("a NESTED template literal cannot smuggle a declaration into the code view", () => {
    // The FATAL this file's reader was rebuilt for. A template's `${…}` may
    // hold another template, and a lexer that ends a template at "the next
    // backtick" ends the OUTER span at the INNER literal's OPENING backtick —
    // so the fixture's body lands in the code half, at a line start, ahead of
    // the real declaration. Driven against the tier guard, the planted fixture
    // was read INSTEAD of the declaration and the guard passed, exit 0.
    const inner = `export ${"const"} SERVED: readonly ShippingLane[] = ["air", "sea", "rail"];`;
    const source = [
      unionDeclaration("ShippingLane", LANES),
      "",
      "export const MIGRATION_NOTE = `${`",
      inner,
      "`}`;",
      `export ${"const"} SERVED: readonly ShippingLane[] = ["air"];`,
      "",
    ].join("\n");
    const found = findDeclaredUniverses(source, "nested-template.ts");
    expect(
      found.map((f) => f.members),
      "the fixture inside the nested template is DATA; only the real declaration is a declaration",
    ).toEqual([["air"]]);
  });

  test("a REGEX INSIDE AN INTERPOLATION cannot swallow the declaration below it", () => {
    // A LIVE RESIDUAL IN THE LEXER, made permanent. `interpolationEnd` walks
    // `${…}` as an expression and had NO regex rule — and an expression is
    // exactly where a regex lives. So the literal's own characters steered the
    // walk, and the limit written in the owner's source claimed the damage was
    // "bounded to that literal because the outer walk resumes at the next `}`
    // it does find". That was true for ONE of these four and false for three:
    // `/[{]/` deepened the brace count, `` /`/ `` opened a template and `/'/`
    // opened a string, each swallowing everything to end-of-file.
    //
    // The third is live in this tree twice, both the identical shell-quoting
    // construct `return `'${s.replace(/'/g, "'\\''")}'`;` — once in
    // `src/shared/git-churn.ts`, inside the scanned population.
    //
    // A stated bound that is false for three of four spellings is worse than
    // no bound, because a reader stops checking it.
    const QUOTE = String.fromCharCode(39);
    const BACKTICK = String.fromCharCode(96);
    for (const [label, body] of [
      ["closing brace", "/[}]/"],
      ["opening brace", "/[{]/"],
      ["backtick", `/${BACKTICK}/`],
      ["single quote", `/${QUOTE}/`],
    ] as const) {
      const source = [
        `const shellQuote = ${BACKTICK}\${input.replace(${body}, "x")}${BACKTICK};`,
        "",
        unionDeclaration("ShippingLane", LANES),
        `export ${"const"} SERVED: readonly ShippingLane[] = ["air", "sea"];`,
        "",
      ].join("\n");
      expect(
        findDeclaredUniverses(source, `interp-${label}.ts`).map((u) => u.name),
        `a regex holding a ${label} inside an interpolation must not swallow the declaration ` +
          "below it — a silently smaller universe inside the instrument built to refuse them",
      ).toEqual(["SERVED"]);
    }
  });

  test("and the ordinary readings are untouched — division stays division", () => {
    // The inert half. A rule that answered "regex" to every `/` would pass the
    // test above and be wrong about arithmetic, which is far commoner.
    const BACKTICK = String.fromCharCode(96);
    for (const [label, expression] of [
      ["division", "width / height"],
      ["a regex opening the expression", "/ab/.test(name)"],
      ["nested braces", "{ a: { b: 1 } }.a.b"],
    ] as const) {
      const source = [
        `const label = ${BACKTICK}\${${expression}}${BACKTICK};`,
        "",
        unionDeclaration("ShippingLane", LANES),
        `export ${"const"} SERVED: readonly ShippingLane[] = ["air", "sea"];`,
        "",
      ].join("\n");
      expect(
        findDeclaredUniverses(source, `inert-${label}.ts`).map((u) => u.name),
        `${label} inside an interpolation must be read as it always was`,
      ).toEqual(["SERVED"]);
    }
  });

  test("an empty scan is a refusal, not a pass", () => {
    // The degenerate case every population-based rule satisfies trivially.
    const empty = scanForDeclaredUniverses(createTempDir("declared-universe-empty-"), ["src"]);
    expect(empty.scanned).toBe(0);
    expect(empty.universes).toEqual([]);
    // The rule itself has nothing to say about an empty answer — which is
    // exactly why the real-tree tests above assert a floor on BOTH the file
    // count and the declaration count rather than trusting a null failure.
    expect(declaredUniverseFailure(unownedUniverses(empty.universes))).toBeNull();
  });
});
