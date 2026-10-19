// @vitest-environment node
/**
 * FLOW DENSITY OWNER — the collapsed-beat budget and the beat's control
 * relationship, enforced mechanically (DESIGN-COCKPIT-V2 §2.1, §3.2, §3.8).
 *
 * THE DEFECT THIS EXISTS TO PREVENT. A `.beat.level-ghost` measured 88px on
 * screen to render 23px of text: the gutter glyph's lead and a CONTROL
 * COLUMN the reader could not even see yet (24px inline verb stacked over a
 * 24px cluster, both hover-revealed) each set the row height, and the beat's
 * own 12px padding was applied twice on top. The fisheye's collapsed form
 * therefore cost nearly as much vertical space as the full beat it replaced
 * — §3.2's "full beat → one-line ghost → tick" bought nothing, and an 800px
 * viewport held about three beats.
 *
 A SECOND DEFECT, THE SAME SHAPE, HORIZONTALLY. The beat row reserved a
 * third column for its controls. That column held width on the right even
 * when it held nothing, so a right-aligned user bubble stopped ~187px short
 * of the flow's edge (measured at 1536px) and read as misaligned rather than
 * as a margin — and it put a ghost tool call's `open` verb ~1900px from its
 * own subject.
 *
 * THE USER'S CORRECTION, VERBATIM: "also the message of the user, is not on
 * the very right. options below each message/tool call/error/status should
 * be similar." Both halves are one fix: the options move UNDER the content,
 * in one row and one form for every kind, and the reserved column goes away,
 * which lets the body reach the edge.
 *
 * WHAT IS PINNED HERE (each with a mutation self-check below):
 *
 *   A. the collapsed budget is ARITHMETIC — a ghost costs about one line,
 *      a tick costs less, and both are read out of tokens.css rather than
 *      asserted as a vibe;
 *   B. a collapsed beat's options carry `height: 0` — a beat's height is a
 *      pure function of its CONTENT, so no hover-revealed control can push a
 *      row open and no pointer entering a row can make the virtualizer
 *      re-measure it (§3.8);
 *   C. the counterweight — every grip still clears the 24px pointer floor.
 *      The height may not be bought by shrinking the target;
 *   D. the beat has TWO columns and nothing reserves width on the right, so
 *      the body reaches the flow's edge with only the page gutter between;
 *   E. the two widths have ONE OWNER each — `--measure` for running prose,
 *      `--rail` for everything instrumental — and no third content width
 *      may appear in the flow or the render layer;
 *   F. patch counting has one implementation (render/diff.ts), not a
 *      private copy inside a beat;
 *   G. the options row is UNIFORM across every kind — one row, one form,
 *      one placement, behaviour by kind.
 *
 * The real-layout-engine half lives in
 * `tests/cockpit/e2e/flow-density-owner.spec.ts`, which measures the actual
 * rendered pixels in Chromium. This file is the source-level ratchet that
 * runs in the default suite.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk } from "../helpers/source-scan.ts";
import { cssDeclares, cssRule } from "../helpers/function-scope.ts";
import { cssRuleBody, sizesToFloor, styleBlock, ownerClearsFloor } from "../helpers/control-floor.ts";

const TOKENS = "src/cockpit/tokens.css";
const BEAT = "src/cockpit/flow/Beat.svelte";
const EFFECT_BEAT = "src/cockpit/flow/EffectBeat.svelte";

/**
 * THE ONE-LINE BUDGET. §3.2 calls the middle representation a "one-line
 * ghost"; a line of --f-data-size (12.5px mono) with its descenders and the
 * beat's own breathing room is ~26px, and 32px is the ceiling at which the
 * word "one line" stops being true. Stated once, here, because this is the
 * test that owns the claim.
 */
const ONE_LINE_BUDGET_PX = 32;

// ── Token arithmetic ───────────────────────────────────────────────────────

/** Every `--name: value` in a CSS source, first declaration wins (`:root`). */
export function tokenTable(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/**
 * Resolve a token to px, following `var(--other)` chains and the spacing
 * scale's `calc(var(--unit) * N)`. Returns null for anything that is not a
 * length this arithmetic can add (a `ch`, a `min()`, a percentage) — those
 * are font- or container-relative and cannot be added up here, which is
 * itself information the callers below rely on.
 */
export function resolvePx(table: Map<string, string>, name: string, depth = 0): number | null {
  if (depth > 8) return null;
  const raw = table.get(name);
  if (raw === undefined) return null;
  const chain = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  if (chain !== null) return resolvePx(table, chain[1]!, depth + 1);
  const scale = /^calc\(\s*var\(\s*(--[\w-]+)\s*\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)$/.exec(raw);
  if (scale !== null) {
    const base = resolvePx(table, scale[1]!, depth + 1);
    return base === null ? null : base * Number(scale[2]);
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(raw);
  return px === null ? null : Number(px[1]);
}

// ── Width-owner scan ───────────────────────────────────────────────────────

/**
 * Every `max-width:` VALUE declared in a Svelte `<style>` block. Used to
 * prove that the flow and the render layer name only the two sanctioned
 * content widths — a third one is exactly how "prose at the measure,
 * instruments bleed" quietly became three different rails last time.
 */
export function maxWidthValues(style: string): string[] {
  return [...style.matchAll(/max-width\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
}

/** The widths a flow/render surface is allowed to declare. */
const ALLOWED_WIDTHS = new Set([
  "var(--measure)", // running prose (§2.1)
  "min(100%, var(--measure))", // same measure bounded by the compact viewport
  "var(--rail)", // instrumental bleed + the beat's content column (§2.1)
  // --rail-open is --rail's ONE exception and it is EARNED BY A GESTURE: an
  // instrument the reader deliberately opened may take a wider column than
  // one sitting at rest ("fully expanded into multiple lines (allowed to
  // also take a larger width)" — the user's direction). It is not a third
  // resting width: every CLOSED card, code block, diff and control edge
  // still measures against --rail, so the column the eye scans is unchanged.
  // The pin below keeps it strictly wider than --rail and strictly
  // gesture-scoped.
  "var(--rail-open)",
  "var(--verbs-max-w)", // the verb column is chrome, not content
  "100%",
  "none",
  "fit-content",
]);

// ── The suite ──────────────────────────────────────────────────────────────

describe("flow-density-owner — a collapsed beat costs about one line", () => {
  const tokens = tokenTable(read(TOKENS));
  const beatStyle = styleBlock(read(BEAT));

  const ghostRow = resolvePx(tokens, "--beat-ghost-h");
  const tickRow = resolvePx(tokens, "--beat-tick-h");
  const pad = resolvePx(tokens, "--beat-pad-collapsed");
  const hitMin = resolvePx(tokens, "--hit-min");
  const dataSize = Number.parseFloat(tokens.get("--f-data-size")!) * 16;

  test("the budget tokens exist and resolve to px (the arithmetic is real)", () => {
    expect(ghostRow, "--beat-ghost-h must be a px length").not.toBeNull();
    expect(tickRow, "--beat-tick-h must be a px length").not.toBeNull();
    expect(pad, "--beat-pad-collapsed must resolve to a px length").not.toBeNull();
    expect(hitMin).toBe(40);
    expect(tokens.get("--f-data-size")).toMatch(/^\d*\.?\d+rem$/);
  });

  test("A. a GHOST costs about one line — never more than the budget", () => {
    const total = ghostRow! + 2 * pad!;
    expect(
      total,
      `a one-line ghost budgets ${ONE_LINE_BUDGET_PX}px; --beat-ghost-h + 2×--beat-pad-collapsed = ${total}px`,
    ).toBeLessThanOrEqual(ONE_LINE_BUDGET_PX);
  });

  test("A. a ghost row still FITS its line (the budget cannot be met by clipping text)", () => {
    expect(
      ghostRow!,
      "--beat-ghost-h must hold a line of --f-data-size — a budget met by cutting the text off is not a budget",
    ).toBeGreaterThanOrEqual(dataSize!);
  });

  test("A. a TICK costs strictly less than a ghost (the ramp actually ramps)", () => {
    expect(tickRow! + 2 * pad!).toBeLessThan(ghostRow! + 2 * pad!);
  });

  test("A. the collapsed rows CONSUME the budget tokens (no restated numbers)", () => {
    // Read from the whole style block, not one rule body: the height is
    // declared on the row's OWN rule, beside the pair rule that gives both
    // rows their shared flex layout.
    expect(beatStyle).toMatch(/\.ghost-row\s*\{[^}]*height:\s*var\(--beat-ghost-h\)/);
    expect(beatStyle).toMatch(/\.tick-row\s*\{[^}]*height:\s*var\(--beat-tick-h\)/);
  });

  test("B. a COLLAPSED beat's options never set its height (height: 0)", () => {
    expect(
      cssDeclares(cssRule(beatStyle, ".level-ghost .options"), "height", "0"),
      "the collapsed options row must carry `height: 0` — a beat's height is a function of its " +
        "CONTENT, so revealing an option on hover can never re-measure the row (§3.8)",
    ).toBe(true);
  });

  test("B. the collapsed gutter glyph does not set the row height either", () => {
    // The glyph's resting lead (margin-top + padding) is there to align it
    // with a bubble's first line. There is no bubble at a collapsed level,
    // and the lead was 24.5px — taller than the whole ghost budget.
    expect(
      cssDeclares(cssRule(beatStyle, ".level-ghost .beat-glyph"), "margin-top", "0"),
      "a collapsed .beat-glyph must drop its lead, or the gutter re-inflates the row",
    ).toBe(true);
  });

  test("C. COUNTERWEIGHT — the grips still clear the pointer floor", () => {
    // The row got shorter by taking the controls OUT of the height flow, not
    // by making them smaller. If a future edit buys the height back by
    // shrinking a target below --hit-min, this goes red (as does
    // cockpit-mouse-path-owner, which owns the both-axes rule for every
    // control that names a chord).
    expect(read(BEAT)).toContain('class="verb beat-grip ');
    const grip = sizesToFloor(styleBlock(read(BEAT)), "verb");
    expect(grip.found, ".beat-grip must have a sizing rule").toBe(true);
    expect(grip.ok, ".beat-grip must clear var(--hit-min) in both axes").toBe(true);
    // A verb's floor is owned by the token owner now: `.cockpit .verb` in
    // tokens.css carries `min-height`/`min-width: var(--hit-min)` for every
    // verb in the cockpit, the flow's included. Assert the OWNER's rule
    // keeps the floor, at the owner — the component no longer restates it.
    expect(ownerClearsFloor("verb"), "the shared verb recipe must keep both axes at the floor").toBe(true);
  });
});

describe("flow-density-owner — a control belongs to its beat, not to the viewport", () => {
  const beatStyle = styleBlock(read(BEAT));
  const beatRule = cssRuleBody(beatStyle, "beat");

  test("D. the beat has TWO columns — nothing reserves width on the right", () => {
    expect(beatRule, ".beat must have a rule").not.toBeNull();
    const cols = /grid-template-columns\s*:\s*([^;]+);/.exec(beatRule!)?.[1] ?? "";
    expect(cols, "the beat's grid must name its columns").not.toBe("");
    // A third track reserved inline width on the right even when it held
    // nothing, so a right-aligned user bubble stopped ~187px short of the
    // flow's edge and read as misaligned rather than as a margin.
    const tracks = cols.split(/\s+(?![^(]*\))/).filter((t) => t.length > 0);
    expect(tracks, `expected [gutter, content]; got: ${cols}`).toHaveLength(2);
    expect(cols, "the content column takes ALL the remaining width").toContain("1fr");
  });

  test("D. the only thing between the body and the edge is the page gutter", () => {
    expect(
      beatRule!,
      "the beat's right inset must be the normal page gutter and nothing more",
    ).toMatch(/padding:[^;]*var\(--gutter-bleed\)/);
  });

  test("D. the reserved controls column is GONE", () => {
    expect(
      cssRuleBody(beatStyle, "controls"),
      "a `.controls` column would reserve width on the right again",
    ).toBeNull();
  });
});

/**
 * THE USER'S OWN WORDS: "options below each message/tool call/error/status
 * should be similar."
 *
 * Before this, the same idea was laid out three different ways — verbs
 * inside the bubble for turns, a `.verbs-under` footer for instrument
 * cards, and a right-hand cluster column for the grammar grips. This pins
 * the single form: ONE options row, rendered once, under the content, for
 * every kind.
 */
describe("flow-density-owner — the options row is UNIFORM across every kind", () => {
  const beatSrc = read(BEAT);
  const beatStyle = styleBlock(beatSrc);
  const template = beatSrc.slice(0, beatSrc.indexOf("<style"));

  test("the row is rendered ONCE, not per kind", () => {
    // The row carries the owned reveal marker (`reveal-item`) beside its
    // own class, so the count keys on the class word, not the exact string.
    const rows = [...template.matchAll(/class="options[\s"]/g)];
    expect(
      rows,
      "one options row for the whole beat — a per-kind copy is how the three placements happened",
    ).toHaveLength(1);
  });

  test("the row sits UNDER the content, inside the same stack", () => {
    // The content branch and the options row are siblings in `.stack`, in
    // that order — so "below the item" is structural, not a margin.
    // The trailing `{/if}` is the hidden-beat wrapper (beat-state.ts
    // `rendersInFlow`): a beat with nothing to say emits no row at all, so the
    // whole row lives inside one conditional. It does not change the property
    // under test — the options row is still the LAST child of `.stack`.
    const stack = /class="stack"([\s\S]*)<\/div>\s*<\/div>\s*(?:\{\/if\}\s*)?$/.exec(
      template.trimEnd(),
    );
    expect(stack, "the beat must render a .stack").not.toBeNull();
    const contentAt = template.indexOf('class="body"');
    const optionsAt = template.search(/class="options[\s"]/);
    expect(contentAt).toBeGreaterThan(0);
    expect(optionsAt, "the options row must come AFTER the content").toBeGreaterThan(contentAt);
  });

  test("NO kind component renders options of its own", () => {
    // Each of these used to (or could) carry its own verb footer, which is
    // exactly how one idea came to have three placements. The beat ROW owns
    // the options now; the raised surfaces (the beat menu, the SCOPE sheet)
    // are different surfaces and keep their own lists.
    const KIND_COMPONENTS = [
      "TurnBeat",
      "ToolBeat",
      "EffectBeat",
      "CheckDeltaBeat",
      "EventBeat",
    ];
    const offenders: string[] = [];
    for (const name of KIND_COMPONENTS) {
      const src = read(`src/cockpit/flow/${name}.svelte`);
      if (/import\s+Verb\s+from/.test(src)) offenders.push(`${name} imports Verb`);
      if (/verbs-under/.test(src)) offenders.push(`${name} keeps a .verbs-under footer`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  test("the `.verbs-under` footer class is gone from the beat row entirely", () => {
    const beatTemplate = beatSrc.slice(0, beatSrc.indexOf("<style"));
    expect(beatTemplate).not.toMatch(/class="verbs/);
  });

  test("alignment follows the content: right under a right-aligned bubble", () => {
    // EACH CLAIM IS ABOUT ONE RULE'S DECLARATIONS. The windows these replace
    // ran past the closing brace, so a `justify-content` in the NEXT rule
    // satisfied them — and `cssRule` refuses outright when the selector is
    // absent, which the old form could not distinguish from a rule that simply
    // did not carry the declaration. `cssDeclares` then reads that rule's
    // declaration LIST, so `justify-content: flex-end` cannot be answered by a
    // `justify-content` inside a nested block or by a longer property name.
    expect(
      cssDeclares(cssRule(beatStyle, ".mine .options"), "justify-content", "flex-end"),
      "a `you` turn's options must right-align with its bubble",
    ).toBe(true);
    expect(
      cssDeclares(cssRule(beatStyle, ".options"), "justify-content", "flex-start"),
      "everything else aligns left with its content",
    ).toBe(true);
  });

  test("QUIET UNTIL WANTED — no kind is exempt from the hover/focus reveal", () => {
    // THE DECISION THIS REVERSES. Instrumental rows (tool, effect, check,
    // event, finding) used to be EXEMPT: their options were drawn at rest on
    // the mouse-first argument that a control living only under the pointer
    // is not discoverable. The user has seen that in practice and overruled
    // it, verbatim: "buttons beside the chat should show only when we have
    // our mouse over the actual message." At the density a real conversation
    // reaches, the exempt rows out-massed the cards they belonged to — and,
    // sitting in the gap BETWEEN two cards, did not even read as belonging to
    // either, so the exemption was not buying the discoverability it was
    // defended for.
    //
    // A kind-scoped `opacity: 1` is exactly how the exemption would come
    // back, so that is what this scans for.
    const exemptions = [...beatStyle.matchAll(/\.kind-[a-z-]+\s+\.options[^{]*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(
      exemptions.filter((r) => /opacity:\s*1/.test(r)),
      "no beat kind may carry its options at rest",
    ).toEqual([]);
    // The row is REVEALED by the pointer and by focus landing inside it
    // through the OWNED pattern (the beat marks itself `.reveal-on-hover`,
    // the row `.reveal-item`, and tokens.css's hover/focus-within rule does
    // the revealing) — plus the flow's own roving-focus trigger, which stays
    // here because `.focused` is the flow's state, not the owner's.
    expect(template, "the beat marks itself the reveal container").toMatch(
      /class="beat [^"]*\breveal-on-hover\b/,
    );
    expect(beatStyle).toMatch(/\.beat\.focused \.options/);
    const tokensCss = read("src/cockpit/tokens.css");
    expect(tokensCss, "the owned pattern must reveal on hover and focus-within").toMatch(
      /\.reveal-on-hover:hover \.reveal-item/,
    );
    expect(tokensCss).toMatch(/\.reveal-on-hover:focus-within \.reveal-item/);
    const rule = cssRuleBody(beatStyle, "options");
    expect(rule, ".options must have a rule").not.toBeNull();
    expect(rule!, "the row rests hidden via the owned reveal pattern, never a local `opacity: 0`").not.toMatch(/opacity:\s*0/);
    expect(template, "the row carries the reveal item marker").toMatch(
      /class="options[\s"][^"]*\breveal-item\b/,
    );
    expect(
      rule!,
      "a `display` reveal changes the row height and re-measures the virtualizer",
    ).not.toMatch(/display:\s*none/);
    expect(
      rule!,
      "a `visibility` reveal is the same defect wearing a different property",
    ).not.toMatch(/visibility:\s*hidden/);
  });

  test("mutation: a kind-scoped at-rest exemption is caught", () => {
    // The scanner above is only worth what it can catch. This is the exact
    // shape of the rule that was removed.
    const reintroduced = ".kind-tool .options,\n  .kind-effect .options {\n    opacity: 1;\n  }";
    const exemptions = [
      ...reintroduced.matchAll(/\.kind-[a-z-]+\s+\.options[^{]*\{[^}]*\}/g),
    ].map((m) => m[0]);
    expect(exemptions.filter((r) => /opacity:\s*1/.test(r)).length).toBeGreaterThan(0);
  });

  test("a disabled verb never stands in the row — its reason lives where the reach is", () => {
    // THE USER'S REPORT: `run again– no block declares a re-run action for a
    // single …` printed between every tool card, truncated mid-word, identical
    // hundreds of times down one conversation. §1.2 asks a refusing control to
    // say why; it does not ask it to say why unprompted, forever, to someone
    // who never reached for it.
    const beatSrc = read(BEAT);
    expect(
      beatSrc,
      "the options row must draw WIRED verbs only",
    ).toMatch(/beat\.verbs\.filter\(\(v\) => v\.wired\)/);
    // …and the reason must still exist, whole, one gesture away — on BOTH
    // depth surfaces, because there are now two and every kind has exactly
    // one of them. The SCOPE sheet serves the kinds that still open a sheet;
    // the open card's inline depth serves the kinds that no longer do (the
    // `⋯` menu, which was the third such surface, is deleted).
    for (const surface of ["src/cockpit/flow/BeatScope.svelte", "src/cockpit/flow/BeatDepth.svelte"]) {
      expect(
        read(surface),
        `${surface} must render EVERY verb, disabled ones included, so nothing is hidden`,
      ).toMatch(/beat\.verbs as verb/);
    }
  });

  test("EVERY kind has exactly one surface carrying its full verb set", () => {
    // The rule the two surfaces divide between them, checked from the OWNER
    // of the split rather than from a list here: a kind either opens a sheet
    // (BeatScope renders its verbs) or renders inline depth (BeatDepth does).
    // Neither both nor neither — "neither" is how a refusal's reason becomes
    // unreachable, which is the failure the `⋯` menu's deletion could have
    // caused and did not.
    const beatSrc = read(BEAT);
    expect(beatSrc, "the row must ask the owner which kinds open a sheet").toMatch(
      /opensScopeSheet\(beat\.kind\)/,
    );
    expect(beatSrc, "…and render the inline depth for exactly the others").toMatch(
      /showsDepth = \$derived\(!hasSheet/,
    );
  });
});

describe("flow-density-owner — prose at the measure, instruments bleed (§2.1)", () => {
  const tokens = tokenTable(read(TOKENS));

  test("E. --measure is font-relative (it is read in the prose face)", () => {
    expect(tokens.get("--measure")).toMatch(/\dch\b/);
  });

  test("E. --rail is ABSOLUTE — the same number in every font", () => {
    // The controls right-align to the rail's edge. A `ch` rail would put the
    // verb somewhere different on a mono row than on a prose row, and the
    // column would stop being learnable.
    const rail = tokens.get("--rail") ?? "";
    expect(rail, "--rail must exist").not.toBe("");
    expect(rail, "--rail must not be font-relative").not.toMatch(/\d(ch|em|ex)\b/);
    expect(rail).toMatch(/\d+px/);
  });

  test("E. --rail-open is WIDER than --rail, and only an OPENED card may use it", () => {
    // Two ways this could rot into the "third content width" the rule above
    // forbids: the token could stop being wider than --rail (making the
    // gesture buy nothing), or it could be applied to something that is not
    // gated on being open (making it the resting width after all).
    const railPx = Number(/(\d+)px/.exec(tokens.get("--rail") ?? "")?.[1] ?? 0);
    const openPx = Number(/(\d+)px/.exec(tokens.get("--rail-open") ?? "")?.[1] ?? 0);
    expect(railPx, "--rail must state a px number").toBeGreaterThan(0);
    expect(openPx, "--rail-open must be wider than --rail or it buys nothing").toBeGreaterThan(
      railPx,
    );
    const users: string[] = [];
    for (const f of [
      ...walk("src/cockpit/flow", { exts: [".svelte"] }),
      ...walk("src/cockpit/render", { exts: [".svelte"] }),
    ]) {
      const style = styleBlock(read(f));
      for (const [, selector] of style.matchAll(
        /([^{}]+)\{[^{}]*max-width\s*:\s*var\(--rail-open\)/g,
      )) {
        users.push(`${relpath(f)}: ${selector!.trim()}`);
      }
    }
    expect(users.length, "--rail-open must actually be used, or the token is dead").toBeGreaterThan(
      0,
    );
    for (const u of users) {
      expect(
        u,
        `${u} takes the opened width without being gated on being open — that is a resting width`,
      ).toMatch(/\.open\b/);
    }
  });

  test("E. the flow and the render layer declare NO third content width", () => {
    const files = [
      ...walk("src/cockpit/flow", { exts: [".svelte"] }),
      ...walk("src/cockpit/render", { exts: [".svelte"] }),
    ];
    const rogue: string[] = [];
    for (const f of files) {
      for (const v of maxWidthValues(styleBlock(read(f)))) {
        if (!ALLOWED_WIDTHS.has(v)) rogue.push(`${relpath(f)}: max-width: ${v}`);
      }
    }
    expect(
      rogue,
      "prose reads at --measure and instruments bleed to --rail; a third width is how the rule " +
        `drifted last time:\n${rogue.join("\n")}`,
    ).toEqual([]);
  });

  test("E. the MEASURE is applied to running prose BLOCKS, not to an ancestor", () => {
    // `ch` is font-relative: 76ch is 553px at the 13.5px UI face and 635px at
    // the 15.5px reading face. Capping an ancestor (the bubble) silently gave
    // prose the SMALLER number, which is why turns read at ~36% of a 1536px
    // screen. The measure therefore lives on the block itself.
    const md = styleBlock(read("src/cockpit/render/MdBlocks.svelte"));
    for (const sel of ["p", "ul", "ol", "blockquote"]) {
      const rule = new RegExp(`(^|[,{}\\s])${sel}\\s*[,{][^}]*max-width:\\s*(?:var\\(--measure\\)|min\\(100%,\\s*var\\(--measure\\)\\))`, "s");
      expect(md, `${sel} must be capped at --measure in MdBlocks`).toMatch(rule);
    }
    const bubble = cssRuleBody(styleBlock(read("src/cockpit/flow/TurnBeat.svelte")), "bubble");
    expect(bubble, ".bubble must have a rule").not.toBeNull();
    expect(
      bubble!,
      "the bubble must NOT re-apply the measure — it resolves in the bubble's own (smaller) font " +
        "and wins over the prose's",
    ).not.toContain("var(--measure)");
  });

  test("E. instrumental renderers bleed to the rail", () => {
    for (const [file, cls] of [
      ["src/cockpit/render/CodeBlock.svelte", "code-block"],
      ["src/cockpit/render/MdBlocks.svelte", "table-scroll"],
    ] as const) {
      const body = cssRuleBody(styleBlock(read(file)), cls);
      expect(body, `${file}: .${cls} must have a rule`).not.toBeNull();
      expect(body!, `${file}: .${cls} must bleed to --rail`).toContain("var(--rail)");
    }
    // The instrument BUBBLES take their width from the one shared vocabulary
    // rather than five identical copies of the same rule.
    const card = cssRuleBody(read(TOKENS), "beat-card");
    expect(card, "tokens.css must own .beat-card").not.toBeNull();
    expect(card!, ".beat-card must bleed to --rail").toContain("var(--rail)");
    expect(card!, ".beat-card must hug its content").toContain("fit-content");
  });

  test("E. no instrument component re-declares the shared card", () => {
    // Five copies of ground + hairline + radius + padding + mono type is
    // five chances to drift; the vocabulary has one owner now.
    const offenders: string[] = [];
    for (const f of ["ToolBeat", "EffectBeat", "EventBeat", "CheckDeltaBeat"]) {
      const style = styleBlock(read(`src/cockpit/flow/${f}.svelte`));
      if (/border-radius:\s*var\(--radius-card\)/.test(style)) offenders.push(`${f} re-declares the card radius`);
      if (/max-width:\s*var\(--rail\)/.test(style)) offenders.push(`${f} re-declares the card width`);
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });
});

describe("flow-density-owner — one implementation of a patch's ± count", () => {
  test("F. the effect beat has no private patch counter", () => {
    const src = read(EFFECT_BEAT);
    expect(
      /function\s+countPatch\b/.test(src),
      "the flow's effect beat must not carry its own patch counter — the header number and the " +
        "lines on screen come from render/diff.ts's summarizePatch, one parse, one count",
    ).toBe(false);
    expect(src).toContain("summarizePatch");
  });

  test("F. the counter lives next to the parser it is derived from", () => {
    expect(read("src/cockpit/render/diff.ts")).toMatch(/export function summarizePatch/);
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the density scanners catch what they claim to", () => {
  test("an over-budget ghost is caught by the arithmetic", () => {
    const t = tokenTable(":root{--beat-ghost-h: 64px;--sp-0: 2px;--beat-pad-collapsed: var(--sp-0);}");
    const total = resolvePx(t, "--beat-ghost-h")! + 2 * resolvePx(t, "--beat-pad-collapsed")!;
    expect(total).toBeGreaterThan(ONE_LINE_BUDGET_PX);
  });

  test("the token chain is followed through var() indirection", () => {
    const t = tokenTable(":root{--a: var(--b);--b: var(--c);--c: 12px;}");
    expect(resolvePx(t, "--a")).toBe(12);
  });

  test("a font-relative or min() token is reported as unresolvable, not guessed", () => {
    const t = tokenTable(":root{--m: 76ch;--r: min(768px, 100%);}");
    expect(resolvePx(t, "--m")).toBeNull();
    expect(resolvePx(t, "--r")).toBeNull();
  });

  test("a spacing-scale calc of a px unit resolves", () => {
    const t = tokenTable(":root{--sp-unit: 4px;--sp-0: calc(var(--sp-unit) * 0.5);--pad: var(--sp-0);}");
    expect(resolvePx(t, "--pad")).toBe(2);
  });

  test("a controls rule WITHOUT height: 0 is caught", () => {
    const body = cssRuleBody("<style>.controls { display: flex; align-items: flex-end; }</style>", "controls");
    expect(/(^|[;{\s])height\s*:\s*0\s*(;|$)/.test(body!)).toBe(false);
  });

  test("a controls rule WITH height: 0 passes", () => {
    const body = cssRuleBody("<style>.controls { display: flex; height: 0; }</style>", "controls");
    expect(/(^|[;{\s])height\s*:\s*0\s*(;|$)/.test(body!)).toBe(true);
    // …and `height: 0px` written as a literal is still caught by the tokens
    // owner's px-literal rule, so there is exactly one spelling.
  });

  test("a reserved third column is caught", () => {
    const body = cssRuleBody(
      "<style>.beat { grid-template-columns: var(--gutter-beat) minmax(0, 1fr) auto; }</style>",
      "beat",
    );
    const cols = /grid-template-columns\s*:\s*([^;]+);/.exec(body!)?.[1] ?? "";
    const tracks = cols.split(/\s+(?![^(]*\))/).filter((t) => t.length > 0);
    expect(tracks).toHaveLength(3);
  });

  test("the two-column form passes the same split", () => {
    const body = cssRuleBody(
      "<style>.beat { grid-template-columns: var(--gutter-beat) minmax(0, 1fr); }</style>",
      "beat",
    );
    const cols = /grid-template-columns\s*:\s*([^;]+);/.exec(body!)?.[1] ?? "";
    expect(cols.split(/\s+(?![^(]*\))/).filter((t) => t.length > 0)).toHaveLength(2);
  });

  test("a third content width is caught by the width scan", () => {
    const style = "<style>.x { max-width: var(--code-measure); } .y { max-width: 100%; }</style>";
    const rogue = maxWidthValues(style).filter((v) => !ALLOWED_WIDTHS.has(v));
    expect(rogue).toEqual(["var(--code-measure)"]);
  });

  test("the width scan does not fire on the sanctioned pair", () => {
    const style = "<style>.p { max-width: var(--measure); } .t { max-width: var(--rail); }</style>";
    expect(maxWidthValues(style).filter((v) => !ALLOWED_WIDTHS.has(v))).toEqual([]);
  });

  test("a bubble that re-applies the measure is caught", () => {
    const body = cssRuleBody("<style>.bubble { max-width: var(--measure); }</style>", "bubble");
    expect(body!.includes("var(--measure)")).toBe(true);
  });
});
