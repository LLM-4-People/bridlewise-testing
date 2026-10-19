// @vitest-environment node
/**
 * THE RESPONSE GRAMMAR IS THE SOLE OWNER of how a cockpit surface says it has
 * no content.
 *
 * WHAT THIS GUARD IS FOR, and what it deliberately is not. The state SET and
 * the evidence each state demands are enforced by the type system and by a
 * throw at the render boundary — a surface cannot answer `{kind:"loading"}`
 * because `loading` is not a key of the declaration, and it cannot answer
 * `absent("")` because the factory refuses at the door. Neither of those needs
 * a test to be true.
 *
 * What a type system cannot reach is a component that IGNORES the grammar and
 * hand-writes its own markup and its own style rule. That bypass is not a bad
 * value, it is the absence of a call, and it is the only thing this file
 * exists to catch. It is therefore the floor of the enforcement, not the
 * design — the design is in `response/grammar.ts`.
 *
 * EVERY UNIVERSE HERE IS DERIVED FROM THE DECLARATION, never typed out. The
 * reserved class names, the required tokens and the expected `[data-answer]`
 * rules all come from `ANSWER_STATES`, so adding a state to the grammar
 * extends this guard automatically and adding one without dressing it fails.
 * A guard that lists its own subject by hand contains the defect it exists to
 * end.
 *
 * THE SCAN READS THROUGH THE SHARED SOURCE READER, NEVER `grep`. Three cockpit
 * source files contain legitimate NUL bytes, and GNU grep treats such a file as
 * binary — printing nothing and exiting cleanly, which is a silently smaller
 * universe. Two published counts in this project were wrong for exactly that
 * reason, and one of the files grep cannot see (`rooms/EditorRoom.svelte`) is in
 * this guard's population. The first test asserts that file's content genuinely
 * arrives, because "the helper is unaffected" is a claim and this guard's
 * numbers are only as good as its reader.
 */
import { describe, test, expect } from "vitest";

import { walk, read, relpath, stripCssBlockComments } from "../helpers/source-scan.ts";
import {
  ANSWER_STATES,
  ANSWER_STATE_IDS,
  OUTCOME_STATE_IDS,
  OWNED_CLASS_NAMES,
  REQUIRED_STATE_TOKENS,
  absent,
  failed,
  pending,
  present,
  refused,
  wordsOf,
} from "../../src/cockpit/response/grammar.ts";

const COCKPIT = "src/cockpit";
const TOKENS = "src/cockpit/tokens.css";
/** The grammar's own files are the OWNER and are exempt by identity, not by
 * name-matching: they are the one place the reserved names may be declared. */
const OWNER_FILES = ["src/cockpit/response/Answer.svelte"];

function nullableStyleBlock(src: string): string | null {
  const i = src.indexOf("<style");
  if (i < 0) return null;
  const j = src.indexOf("</style>", i);
  return stripCssBlockComments(src.slice(i, j < 0 ? undefined : j));
}

/**
 * Does this style block DECLARE a rule for `.name`? A declaration
 * (`.absent { … }`), not a use — the class is applied in markup by the
 * shared element by design; what is forbidden is a component deciding for
 * itself what the state looks like.
 *
 * THE LEADING SET ADMITS EVERYTHING THAT CAN END THE PRECEDING SIMPLE
 * SELECTOR, because a CHAINED selector is a declaration too. The first
 * version admitted only whitespace, commas and combinators, so
 * `.consequence.failed { … }` — the class chained onto another — was
 * invisible, and the ratchet's "zero private opinions" was measured with a
 * blind instrument (it was wrong by exactly one site when the blindness was
 * found). Word characters (chaining), `)` (`:is(…)`/`:not(…)`), `]`
 * (attribute selectors) and `(` (a class inside a functional pseudo-class)
 * all precede a `.` mid-selector; the negative lookahead still refuses
 * `.failed-x`, which is a different class.
 */
function declaresClass(style: string, name: string): boolean {
  const re = new RegExp(String.raw`(^|[\s,>+~(]|[\w)\]])\.${name}(?![\w-])[^{}]*\{`, "m");
  return re.test(style);
}

const components = walk(COCKPIT, { exts: [".svelte"] }).map(relpath);

/**
 * THE SURFACES THAT ARE ON THE GRAMMAR — declared once, consumed by both
 * assertions below. It used to be typed out twice, which is a second list to
 * keep in step and exactly the shape §31b warns about: the two copies would
 * eventually disagree about which file is converted, and the weaker one would
 * be the one nobody noticed had shrunk.
 *
 * This list is NOT the ratchet and does not replace it. It is the complement:
 * the ratchet says "no NEW surface may invent its own absence rule", this says
 * "and these ones must not relapse". A count alone cannot express the second —
 * converting one file while another regresses leaves the total unchanged.
 */
const CONVERTED_SURFACES = [
  "src/cockpit/shell/RoomHost.svelte",
  "src/cockpit/shell/ScopeHost.svelte",
  "src/cockpit/desk/ChannelScope.svelte",
  "src/cockpit/desk/TripScope.svelte",
  "src/cockpit/desk/ItemBody.svelte",
  "src/cockpit/desk/ChannelStrip.svelte",
  "src/cockpit/desk/DeskPanel.svelte",
  "src/cockpit/desk/Gauge.svelte",
  "src/cockpit/editor/FilePane.svelte",
  "src/cockpit/editor/FileTree.svelte",
  "src/cockpit/rooms/CustodyRoom.svelte",
  "src/cockpit/rooms/EditorRoom.svelte",
  "src/cockpit/rooms/SwitchRoom.svelte",
  "src/cockpit/rooms/Parcel.svelte",
  "src/cockpit/flow/Flow.svelte",
  "src/cockpit/flow/EffectBeat.svelte",
  "src/cockpit/flow/ToolBeat.svelte",
  "src/cockpit/flow/TurnBeat.svelte",
  "src/cockpit/render/ArtifactFrame.svelte",
  "src/cockpit/render/Prose.svelte",
  "src/cockpit/rooms/DiffSheet.svelte",
  "src/cockpit/rooms/InstrumentCell.svelte",
  "src/cockpit/rooms/Reel.svelte",
  "src/cockpit/rooms/SettingsRoom.svelte",
  "src/cockpit/settings/SettingSheet.svelte",
];

describe("response grammar — one vocabulary, and it is the only one", () => {
  test("the population is real and every component is readable as bytes", () => {
    // A guard whose universe comes back empty must fail rather than pass, and
    // the floor is stated as a runtime number so a file that becomes
    // unreadable — or a walk whose pattern goes stale — reds the run instead
    // of certifying less. 70+ components existed when this was written.
    expect(components.length, "cockpit component population").toBeGreaterThanOrEqual(70);

    // LIVENESS FOR THE READER, not for a detector. Three cockpit files contain
    // a legitimate NUL byte, and GNU grep treats such a file as binary — it
    // prints nothing and exits 0, so a shell-based version of this scan would
    // drop them silently. The shared `read()` helper decodes as UTF-8 and is
    // unaffected, but "unaffected" is a claim, so it is checked: the file is in
    // the population AND its content genuinely arrives.
    expect(components).toContain("src/cockpit/rooms/EditorRoom.svelte");
    const nulFile = read("src/cockpit/rooms/EditorRoom.svelte");
    expect(nulFile.length, "a NUL-bearing file must still be read in full").toBeGreaterThan(1000);
    expect(nulFile, "and its style block must be visible to this scan").toContain("<style");
  });

  // ── The declaration is the single source of the vocabulary ──────────────

  test("the token owner declares an ink for every state the grammar declares", () => {
    const css = read(TOKENS);
    expect(REQUIRED_STATE_TOKENS.length, "the grammar requires tokens").toBeGreaterThan(0);
    for (const name of REQUIRED_STATE_TOKENS) {
      expect(
        new RegExp(`${name}\\s*:`).test(css),
        `${name} is required by the grammar declaration and must be declared in the token owner`,
      ).toBe(true);
    }
  });

  test("every ANSWER state has exactly one treatment, and it differs only in ink", () => {
    const css = stripCssBlockComments(read(TOKENS));
    const props = new Set<string>();
    for (const id of ANSWER_STATE_IDS) {
      if (id === "present") continue; // present renders content, not a treatment
      const rule = new RegExp(`\\.answer\\[data-answer="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `${id} must have exactly one treatment in the token owner`).not.toBeNull();
      for (const decl of rule![1]!.split(";")) {
        const name = decl.split(":")[0]?.trim();
        if (name !== undefined && name.length > 0) props.add(name);
      }
    }
    // The whole point of one grammar: four states a reader must tell apart,
    // distinguished by ONE property. If one changed ink and another changed
    // face, the reader could not tell a change of STATE from a change of room.
    expect([...props], "the answer states differ in ink and nothing else").toEqual(["color"]);
  });

  test("state inks resolve to existing tokens, so the light theme needs no second copy", () => {
    // Every state ink is a `var()` into a token the light theme already
    // re-derives. A raw hex here would be a value to remember at every theme
    // change — which is how nine copies of one ground colour came to exist.
    const css = read(TOKENS);
    for (const id of ANSWER_STATE_IDS) {
      const ink = ANSWER_STATES[id].ink;
      if (ink === null) continue;
      const decl = new RegExp(`${ink}\\s*:\\s*([^;]+);`).exec(css);
      expect(decl, `${ink} must be declared`).not.toBeNull();
      expect(
        decl![1]!.trim(),
        `${ink} must resolve to an existing token, not a literal colour`,
      ).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  // ── The bypass: a surface holding a private opinion ─────────────────────

  test("the declaration detector sees every selector shape a declaration can wear", () => {
    // LIVENESS FOR THE DETECTOR ITSELF, on fixtures supplied here rather
    // than trusted to exist in the tree. The chained shape is the one that
    // escaped: `.consequence.failed { … }` styled an owned name for a whole
    // round while the guard reported zero. Each positive is a shape a real
    // component could write; each negative is a use or a different class
    // that must not count as a declaration.
    const declares = [
      ".failed { color: red; }",
      ".consequence.failed {\n  color: red;\n}",
      "p.failed { color: red; }",
      "[data-x].failed { color: red; }",
      ".row > .failed { color: red; }",
      ":is(.a).failed { color: red; }",
    ];
    for (const css of declares) {
      expect(declaresClass(css, "failed"), `must catch: ${css}`).toBe(true);
    }
    const doesNot = [
      ".failed-note { color: red; }", // a different class, not the owned name
      ".failure { color: red; }",
      "/* .failed { } */", // comments are stripped before scanning
      ".consequence { color: red; }",
    ];
    for (const css of doesNot) {
      expect(
        declaresClass(stripCssBlockComments(css), "failed"),
        `must not catch: ${css}`,
      ).toBe(false);
    }
  });

  test("no component declares a class the grammar owns", () => {
    expect(OWNED_CLASS_NAMES.length, "the reserved set is derived and non-empty").toBeGreaterThan(0);

    const findings: string[] = [];
    let scanned = 0;
    for (const file of components) {
      if (OWNER_FILES.includes(file)) continue;
      const style = nullableStyleBlock(read(file));
      if (style === null) continue;
      scanned += 1;
      for (const name of OWNED_CLASS_NAMES) {
        if (declaresClass(style, name)) findings.push(`${file} declares .${name}`);
      }
    }
    // The detector's covered population, as a runtime number. A walk that
    // silently stopped finding style blocks would otherwise certify zero.
    expect(scanned, "components with a style block").toBeGreaterThanOrEqual(50);

    // THE RATCHET IS GONE, BECAUSE IT REACHED ZERO. While the conversion was
    // in flight this was a downward-only count (29 when the grammar landed,
    // 23 after the first round, then down file by file); now every surface is
    // on the grammar and the honest assertion is exact: NO component declares
    // an owned absence class. A single new declaration anywhere reds the run
    // with its file and class named.
    expect(findings, "no component may declare its own absence rule").toEqual([]);

    // And the converted surfaces must STAY converted. This is the half a bare
    // count cannot express: without it, converting one file and relapsing
    // another keeps the total unchanged and the guard says nothing.
    const converted = CONVERTED_SURFACES;
    for (const file of converted) {
      expect(components, `${file} must remain in the scanned population`).toContain(file);
      expect(
        findings.filter((f) => f.startsWith(file)),
        `${file} is on the grammar and must not declare its own absence rule again`,
      ).toEqual([]);
    }
  });

  test("a converted surface renders its absence through the grammar, not its own markup", () => {
    // The immediate composer no longer renders the setup body's answers.
    // The canonical inspector mounts DeskPanel, which remains in the full
    // converted population below, rather than exempting those absences.
    expect(read("src/cockpit/shell/Desk.svelte")).not.toMatch(/<Answer\s/);
    expect(read("src/cockpit/shell/outlets.ts")).toMatch(/setup:\s*\(\)\s*=>\s*import\("\.\.\/desk\/DeskPanel\.svelte"\)/);
    expect(read("src/cockpit/shell/RightMenuHost.svelte")).toContain("loadInspectorGroup(id)");
    // The complement of the rule above, and the reason it is needed: deleting a
    // `.absent` rule while leaving `<p class="absent">` in the template would
    // satisfy every assertion so far and leave the surface rendering an
    // unstyled sentence. The count guard cannot see it, because the count is
    // of DECLARATIONS.
    for (const file of CONVERTED_SURFACES) {
      const src = read(file);
      expect(src, `${file} must import the shared element`).toContain(
        "response/Answer.svelte",
      );
      expect(src, `${file} must render through it`).toMatch(/<Answer\s/);

      // EVERY site, not merely one. A planted mutation that replaced ONE of
      // TripScope's two answers with a hand-written `{ state: "absent", … }`
      // escaped an earlier version of this assertion, because a `toMatch` over
      // the whole file is satisfied by any single surviving factory call. The
      // shape of that escape is this project's recurring one: the guard
      // measured the file when the claim was about each site.
      //
      // The type system is what ultimately refuses that mutant — the brand on
      // `Answer<T>` makes the literal unassignable, and `npm run
      // typecheck:templates` reports exactly that. This assertion is the
      // cheaper, earlier signal, and it is written per-site so the two agree.
      const sites = (src.match(/<Answer\s/g) ?? []).length;
      const constructed = (src.match(/answer=\{(absent|pending|refused|failed|present)\(/g) ?? [])
        .length;
      expect(sites, `${file} must render at least one answer`).toBeGreaterThan(0);
      expect(
        constructed,
        `${file}: every <Answer> must get its value from a grammar factory ` +
          `(${sites} sites, ${constructed} constructed through the grammar)`,
      ).toBe(sites);
      expect(
        /class="[^"]*\babsent\b/.test(src),
        `${file} must not keep the retired class in its markup`,
      ).toBe(false);
    }
  });

  // ── The evidence gate, driven at the door a real caller uses ────────────

  test("every state that is defined by plain words refuses to exist without them", () => {
    // Derived from the declaration: every state whose evidence is words is
    // driven here, so a state added later is covered without an edit.
    const wordFactories = {
      pending,
      absent,
      refused,
      failed,
    } as const;
    const wordStates = ANSWER_STATE_IDS.filter(
      (id) => ANSWER_STATES[id].evidence !== "value",
    );
    expect(
      wordStates.slice().sort(),
      "every non-value state must be driven by this test",
    ).toEqual(Object.keys(wordFactories).sort());

    for (const id of wordStates) {
      const make = wordFactories[id as keyof typeof wordFactories];
      for (const empty of ["", "   ", "\n\t"]) {
        expect(() => make(empty), `${id}("${empty}") must be refused`).toThrowError(
          /needs its (subject|reason) in plain words/,
        );
      }
      // And it must SUCCEED with words — otherwise a factory that threw
      // unconditionally would pass the assertion above while being useless.
      const ok = make("a real sentence");
      expect(wordsOf(ok)).toBe("a real sentence");
      expect(ok.state).toBe(id);
    }
  });

  test("the refusal names the state and the evidence, so the message is actionable", () => {
    // A guard that accepts any throw accepts the wrong throw. The specific
    // code and the specific words are the contract.
    let caught: unknown = null;
    try {
      absent("");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("cockpit_contract");
    expect((caught as Error).message).toBe(
      'a "absent" answer needs its reason in plain words; it was given none',
    );
  });

  test("a present answer carries its value and no words", () => {
    const a = present({ n: 1 });
    expect(a.state).toBe("present");
    expect(wordsOf(a)).toBe("");
  });

  test("the two axes stay disjoint — no id belongs to both", () => {
    // Merging the answer and outcome axes is what produced five colliding
    // vocabularies, where `absent` meant "no reasoning here" on one surface
    // and "the read refused" on another. An overlap is that regression
    // starting again.
    const overlap = ANSWER_STATE_IDS.filter((id) =>
      (OUTCOME_STATE_IDS as readonly string[]).includes(id),
    );
    expect(overlap, "an id in both axes means the axes are collapsing again").toEqual([]);
  });
});
