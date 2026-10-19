// @vitest-environment jsdom
/**
 * SYMMETRIC TOOL-CALL DETAIL — a success and a failure are the same object.
 *
 * THE USER'S REQUIREMENT, VERBATIM: "success and error tool call should carry
 * the same amount of details when collapsed and also when expanded".
 *
 * WHAT WAS THERE. Spec §3.2 had a tool beat "open while running, closes to a
 * one-line summary on success, stays open on failure." That made sense when
 * status was invisible until you clicked: the failure had to shout. The
 * bubble system removed the premise — status is legible at rest now, at every
 * fisheye level — so all the asymmetry still bought was two costs:
 *
 *   - two calls could not be COMPARED, because one was a card and the other
 *     was a line;
 *   - you learned DIFFERENT FACTS depending on an outcome you could already
 *     see: a failure gave you its whole transformation, a success gave you a
 *     hint of it. At the ghost level it was worse — a failing call printed
 *     the literal word "failed" where a succeeding one printed its real
 *     output, so the failure showed strictly LESS.
 *
 * THE RULE THIS FILE ENFORCES: outcome changes the CONTENT of a cell, never
 * the SHAPE of the beat. It is enforced by RENDERING, not by reading source —
 * the same mechanism that produced the defect. Each beat is rendered once per
 * status at each fisheye level, and the sequences of `data-field` names must
 * be exactly equal. A field present for one outcome and absent for the other
 * is a failure here, not a review note.
 *
 * WHAT IS DELIBERATELY *NOT* SYMMETRIC, and why it does not contradict the
 * above: PROMINENCE. fisheye.ts still refuses to compress an abnormal beat,
 * so a failure may sit at `full` beside a success that ghosted. That rule
 * chooses which LEVEL a beat is held at; this file governs what a level
 * SHOWS. Both are pinned below, together, so a future reader sees that they
 * were reconciled on purpose.
 *
 * The colour half of the same pass is pinned in flow-bubble-system.test.ts.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import BeatView from "../../src/cockpit/flow/Beat.svelte";
import ToolBeat from "../../src/cockpit/flow/ToolBeat.svelte";
import { fisheyeLevel, FISHEYE_LEVELS, type FisheyeLevel } from "../../src/cockpit/flow/fisheye.ts";
import { clearLog } from "../../src/cockpit/flow/log.ts";
import type { Beat, ToolStatus } from "../../src/cockpit/flow/types.ts";
import { read, stripTemplateComments } from "../helpers/source-scan.ts";

const TOOL_BEAT = "src/cockpit/flow/ToolBeat.svelte";
const BEAT = "src/cockpit/flow/Beat.svelte";
const TOKENS = "src/cockpit/tokens.css";

// ── Fixtures: one recorded call, three ways it could have gone ─────────────

/**
 * The same tool, the same arguments, the same duration — so that ANY
 * difference the guard sees is attributable to the outcome and to nothing
 * else. This is the whole experimental design of the file.
 */
function toolBeat(status: ToolStatus, output: unknown, extra: Partial<Beat> = {}): Beat {
  return {
    id: `b-${status}`,
    kind: "tool",
    parentId: null,
    turnIndex: 4,
    at: 1,
    abnormal: status === "error",
    bleed: true,
    verbs: [],
    tool: {
      name: "read_file",
      label: "read file",
      status,
      input: { path: "src/lib/reader.ts" },
      output,
      startedAt: 1,
      ...(status === "running" ? {} : { durationMs: 42 }),
    },
    ...extra,
  };
}

const SUCCESS = toolBeat("done", "export const x = 1;\n");
const FAILURE = toolBeat("error", "ENOENT: no such file or directory, open 'src/lib/reader.ts'");
const RUNNING = toolBeat("running", "");

/** The same pair, with the record carrying no output on either side. */
const SUCCESS_BARE = toolBeat("done", "");
const FAILURE_BARE = toolBeat("error", "");

const NOOP = {
  onfocusbeat: () => {},
  onstepbeat: () => {},
  onoverridebeat: () => {},
  onopenbeat: () => {},
  onexpandbeat: () => {},
  onmenubeat: () => {},
};

afterEach(() => {
  cleanup();
  clearLog();
});

// ── The instrument: what a rendering's ANATOMY is ──────────────────────────

/**
 * The ordered list of `data-field` names in a rendered subtree.
 *
 * This is the definition of "anatomy" the whole file rests on: which named
 * structural slots exist, and in what order. It is deliberately blind to the
 * TEXT inside them — content is exactly what outcome is allowed to change.
 */
export function anatomy(root: Element): string[] {
  return [...root.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field") ?? "");
}

function renderTool(beat: Beat, expanded: boolean): string[] {
  const { container } = render(ToolBeat, { props: { beat, expanded } });
  return anatomy(container);
}

function renderAtLevel(beat: Beat, level: FisheyeLevel, expanded = false): string[] {
  const { container } = render(BeatView, {
    props: {
      beat,
      fisheye: { level, reason: "a stated reason" },
      focused: false,
      onChain: false,
      expanded,
      projectPath: null,
      ...NOOP,
    },
  });
  return anatomy(container);
}

function textOf(beat: Beat, expanded: boolean): string {
  const { container } = render(ToolBeat, { props: { beat, expanded } });
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ── THE CLAIM, at every level ──────────────────────────────────────────────

describe("symmetric detail — COLLAPSED, a success and a failure have one anatomy", () => {
  test("the field sequences are identical", () => {
    const ok = renderTool(SUCCESS, false);
    expect(ok.length, "the collapsed beat must render named fields").toBeGreaterThan(0);
    expect(
      renderTool(FAILURE, false),
      "a collapsed failure must show the same fields, in the same order, as a collapsed success — " +
        "only the status mark and the output cell's CONTENT may differ",
    ).toEqual(ok);
  });

  test("the collapsed anatomy is the one §3.2 describes: name, status, input→output", () => {
    // Stated positively so the guard cannot be satisfied by rendering nothing
    // for both outcomes.
    expect(renderTool(SUCCESS, false)).toEqual([
      "tool-name",
      "status",
      "duration",
      "input-hint",
      "output-hint",
    ]);
  });

  test("a failure is NOT auto-expanded — it closes exactly as a success does", () => {
    // The behaviour this pass removed. If it returns, the failure grows the
    // two-cell body and this comparison breaks immediately.
    const collapsed = renderTool(SUCCESS, false);
    const failure = renderTool(FAILURE, false);
    expect(failure).not.toContain("output-cell");
    expect(failure).toEqual(collapsed);
  });
});

describe("symmetric detail — EXPANDED, a success and a failure have one anatomy", () => {
  test("the field sequences are identical", () => {
    const ok = renderTool(SUCCESS, true);
    expect(
      renderTool(FAILURE, true),
      "an expanded failure must show the same fields as an expanded success — full input, full " +
        "output, same order, same treatment",
    ).toEqual(ok);
  });

  test("the expanded anatomy is both sides of the transformation, in order", () => {
    expect(renderTool(SUCCESS, true)).toEqual([
      "tool-name",
      "status",
      "duration",
      "input-cell",
      "input-label",
      "input-body",
      "arrow",
      "output-cell",
      "output-label",
      "output-body",
    ]);
  });

  test("the output cell is named the same thing for both outcomes", () => {
    // It used to be labelled "error" on a failure and "output" on a success,
    // which made one cell read as a different FIELD rather than as the same
    // field holding a different value.
    expect(textOf(SUCCESS, true)).toContain("output");
    expect(textOf(FAILURE, true)).toContain("output");
    expect(textOf(FAILURE, true)).not.toMatch(/\berror\b/);
  });
});

describe("symmetric detail — RUNNING shares the same anatomy, honestly pending", () => {
  test("a running call renders the expanded anatomy with both cells", () => {
    // `running` is the ONE status still allowed to open the beat, because it
    // is the live axis rather than an outcome: the transformation is arriving
    // and watching it arrive is the only thing to do.
    //
    // `duration` is present: `toolCallDurationMs` measures live elapsed
    // while the call is running (`now - startedAt`). That is a field
    // conditional on the RECORD (a start timestamp exists), never on the
    // outcome — the two settled fixtures also carry it.
    expect(renderTool(RUNNING, false)).toEqual([
      "tool-name",
      "status",
      "duration",
      "input-cell",
      "input-label",
      "input-body",
      "arrow",
      "output-cell",
      "output-label",
      "output-body",
    ]);
  });

  test("…and its output cell says it is pending rather than inventing one", () => {
    // Through the response grammar now: `pending` DEMANDS the subject in
    // plain words, which is what stops this cell degenerating into a spinner.
    // The wording moved with the conversion; the claim did not.
    expect(textOf(RUNNING, false)).toContain("waiting for what this call returns");
  });
});

describe("symmetric detail — EVERY fisheye level, not just the full beat", () => {
  for (const level of ["full", "ghost", "tick"] as const) {
    test(`${level}: success and failure render the same fields`, () => {
      const ok = renderAtLevel(SUCCESS, level);
      expect(ok.length, `the ${level} level must render named fields`).toBeGreaterThan(0);
      expect(
        renderAtLevel(FAILURE, level),
        `at ${level}, a failure must show whatever a success shows — with the failing content in ` +
          "place of the succeeding content",
      ).toEqual(ok);
    });
  }

  test("ghost: the failure carries its REAL output, not the word 'failed'", () => {
    // The sharpest instance of the old defect. A ghosted failure printed
    // "read file src/lib/reader.ts → failed" — the server's message thrown
    // away, and replaced by the one fact the status mark beside it already
    // stated. The failure showed strictly LESS than the success.
    const { container } = render(BeatView, {
      props: {
        beat: FAILURE,
        fisheye: { level: "ghost", reason: "r" },
        focused: false,
        onChain: false,
        expanded: false,
        projectPath: null,
        ...NOOP,
      },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("ENOENT");
    expect(text, "the status word must not stand in for the recorded output").not.toMatch(
      /→ failed/,
    );
  });

  test("every level states the status at rest, for both outcomes", () => {
    for (const level of ["full", "ghost", "tick"] as const) {
      for (const beat of [SUCCESS, FAILURE]) {
        expect(
          renderAtLevel(beat, level),
          `${level} must carry the status affordance — legibility is never bought by clicking`,
        ).toContain("status");
      }
    }
  });
});

// ── Content may differ. It may differ ONLY where the record differs. ───────

describe("symmetric detail — outcome changes CONTENT, and only content", () => {
  test("each outcome's cell holds its own recorded value, verbatim", () => {
    expect(textOf(SUCCESS, true)).toContain("export const x = 1;");
    expect(textOf(FAILURE, true)).toContain("ENOENT: no such file or directory");
  });

  test("identical records render identically, whatever the status says", () => {
    // Two calls whose records carry the same (absent) output must produce the
    // same words. This is the strongest form of the claim: nothing about the
    // rendering is a function of `status` except the status affordance itself.
    // Both renderings are normalised by blanking the STATUS AFFORDANCE — its
    // glyph and its word — and nothing else. Whatever is left must match
    // character for character.
    const blankStatus = (s: string): string => s.replace(/[✓✕△◍]/g, "§").replace(/done|failed/, "§");
    const ok = blankStatus(textOf(SUCCESS_BARE, false));
    const bad = blankStatus(textOf(FAILURE_BARE, false));
    expect(bad, "with the same record, only the status affordance may differ").toEqual(ok);
  });

  test("NO FABRICATION: a failure with no detail says so, and invents nothing", () => {
    const text = textOf(FAILURE_BARE, true);
    expect(text).toContain("the record carries no output for this call");
    // …and the success with the same empty record says the same true thing,
    // rather than one of them getting a bespoke sentence.
    expect(textOf(SUCCESS_BARE, true)).toContain("the record carries no output for this call");
  });

  test("a client's own observation is labelled as the client's, not as output", () => {
    const observed = toolBeat("error", "");
    const beat: Beat = {
      ...observed,
      tool: { ...observed.tool!, incompleteReason: "the stream ended before a result arrived" },
    };
    expect(textOf(beat, true)).toContain("client observation, not the tool's output");
  });

  test("both sides are truncated by the same budget", () => {
    const long = "x".repeat(5_000);
    const okLine = textOf(toolBeat("done", long), false);
    const errLine = textOf(toolBeat("error", long), false);
    expect(okLine.length, "a 5000-char output must be clipped, not printed").toBeLessThan(400);
    expect(
      errLine.length - okLine.length,
      "the two lines may differ only by the status word's length",
    ).toBeLessThanOrEqual("failed".length);
  });
});

// ── The source-level ratchet: the shape decision has ONE input set ─────────

describe("symmetric detail — the shape decision cannot consult the outcome", () => {
  const src = read(TOOL_BEAT);
  const template = src.slice(src.indexOf("</script>"));

  test("`open` reads the user's toggle and the LIVE flag, and nothing else", () => {
    expect(
      src,
      "the moment an outcome can widen or narrow the beat, two calls stop being comparable",
    ).toMatch(/const open = \$derived\(expanded \|\| live\);/);
  });

  test("no branch anywhere in the beat's TEMPLATE tests the tool's status", () => {
    // The template is where shape is decided. A status test in it is a shape
    // difference waiting to happen, which is why the guard is on the whole
    // template rather than on a list of known offenders.
    expect(template, "the template must branch on the RECORD, never on the outcome").not.toMatch(
      /tool\.status/,
    );
  });

  test("neither the beat nor the ghost line special-cases `error`", () => {
    for (const file of [TOOL_BEAT, BEAT]) {
      // Comments discuss the removed behaviour on purpose; read the template
      // through the sanctioned view so the guard sees CODE, not prose — and a
      // `//` inside a string literal (a URL) cannot open a phantom comment.
      const body = stripTemplateComments(read(file));
      expect(body, `${file} must not branch on a failed status`).not.toMatch(/status === "error"/);
      expect(body, `${file} must not branch on a succeeded status`).not.toMatch(
        /status === "done"/,
      );
    }
  });

  test("the render layer does not take a status flag at all", () => {
    // ToolOutput used to accept `error` and tint its whole body alarm-red,
    // which made a failure's cell a visibly different object. Status belongs
    // to the status affordances; the body renders its data.
    expect(read("src/cockpit/render/ToolOutput.svelte")).not.toMatch(/error\??\s*:\s*boolean/);
  });
});

// ── Prominence may differ. Shape may not. ─────────────────────────────────

describe("symmetric detail — reconciled with 'abnormality resists compression'", () => {
  test("PROMINENCE still differs: an abnormal beat is held at full", () => {
    const r = fisheyeLevel({
      beat: FAILURE,
      focusTurnIndex: 40,
      onFocusChain: false,
      latestTurnIndex: 40,
    });
    expect(r.level, "a failure far from focus is still never compressed away").toBe("full");
  });

  test("…while a comparable success at the same distance does compress", () => {
    const r = fisheyeLevel({
      beat: SUCCESS,
      focusTurnIndex: 40,
      onFocusChain: false,
      latestTurnIndex: 40,
    });
    // GHOST, not tick — the automatic floor for a tool call is one full
    // line. This assertion used to read `tick`, and the user reported what
    // that looked like: "tool call still shows as ultra collapsed, like
    // this, until I click on them." Prominence still differs (the failure
    // above is held at `full`, this success is not); what changed is how far
    // down the ramp a tool call is allowed to fall on its own.
    expect(r.level).toBe("ghost");
    expect(r.reason).toContain("never compresses below one full line");
  });

  test("mutation: the tool floor must not be a floor for every kind", () => {
    // The floor is deliberately NARROW. A check delta is a single fact and
    // its status mark is a fair rendering of it, so the tick survives there
    // — if this ever returns "ghost" the fisheye has stopped compressing
    // anything and the guard above has become meaningless.
    const check = { ...SUCCESS, kind: "check-delta" as const, tool: undefined };
    expect(
      fisheyeLevel({
        beat: check,
        focusTurnIndex: 40,
        onFocusChain: false,
        latestTurnIndex: 40,
      }).level,
    ).toBe("tick");
  });

  test("and when a failure IS collapsed, it wears the collapsed anatomy exactly", () => {
    // The two rules meet here: the DOI chose the level, the renderer chose
    // the anatomy, and the anatomy did not know which outcome it was drawing.
    expect(renderAtLevel(FAILURE, "tick")).toEqual(renderAtLevel(SUCCESS, "tick"));
    expect(renderAtLevel(FAILURE, "ghost")).toEqual(renderAtLevel(SUCCESS, "ghost"));
  });
});

// ── The colour decision, measured ─────────────────────────────────────────

/** Every `--name: value` declared inside one CSS block, by its selector. */
function blockTokens(css: string, selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  const body = css.slice(at, css.indexOf("}", at));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out.set(m[1]!, m[2]!);
  return out;
}

function relativeLuminance(hex: string): number {
  const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x!, y!) + 0.05) / (Math.min(x!, y!) + 0.05);
}

describe("the outcome colours — success green, error red, warning yellow", () => {
  const css = read(TOKENS);
  const dark = blockTokens(css, ":root {");
  const light = blockTokens(css, ':root[data-cockpit-theme="light"]');

  test("all three hues exist as real tokens in BOTH themes", () => {
    for (const [name, table] of [
      ["dark", dark],
      ["light (paper)", light],
    ] as const) {
      for (const token of ["--ok", "--warn", "--alarm"]) {
        expect(table.get(token), `${name} is missing ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test("the success hue is a REAL green, not a desaturated grey", () => {
    // "do not half-apply it by making green so desaturated it reads as grey."
    for (const table of [dark, light]) {
      const hex = table.get("--ok")!;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(g!, `${hex} must lead on green`).toBeGreaterThan(r!);
      expect(g!, `${hex} must lead on green`).toBeGreaterThan(b!);
      const max = Math.max(r!, g!, b!);
      const min = Math.min(r!, g!, b!);
      expect((max - min) / max, `${hex} is too grey to read as green`).toBeGreaterThan(0.25);
    }
  });

  test("every hue clears WCAG AA on every CARBON ground, in both themes", () => {
    const failures: string[] = [];
    for (const [theme, table] of [
      ["dark", dark],
      ["light (paper)", light],
    ] as const) {
      for (const hue of ["--ok", "--warn", "--alarm", "--beam"]) {
        for (const ground of ["--ground-0", "--ground-1", "--ground-2", "--ground-3"]) {
          const ratio = contrastRatio(table.get(hue)!, table.get(ground)!);
          // 4.5:1 is AA for text; the same figure covers the 3:1 non-text
          // indicator floor for the leading edge with room to spare.
          if (ratio < 4.5) failures.push(`${theme} ${hue} on ${ground}: ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures, `measured, not eyeballed:\n${failures.join("\n")}`).toEqual([]);
  });

  // ── THE DATA-HINT INKS (UIE-046) ─────────────────────────────────────────
  //
  // The beat's output preview, its compressed twin, the fold control beside
  // them and the fisheye's explanation are INFORMATIVE surfaces (WCAG
  // 1.4.11: graphical objects that carry meaning; 1.4.3 for the text), and
  // they all sat on ink-4 — the "faintest ink that still reads" register
  // (placeholders, spent rail cells, retired rows) — at 2.03–2.45:1 in BOTH
  // themes. The fix re-registered them to ink-3, the register the
  // neighboring data fields already wear. This arm pins it END TO END: the
  // consumed token is read from the COMPONENT source (so a re-point back to
  // ink-4 is the mutation it catches), resolved through tokens.css per
  // theme, and held to 3:1 against both grounds a beat row can sit on.
  const HINT_SURFACES: ReadonlyArray<readonly [string, string, string]> = [
    [TOOL_BEAT, "result-hint", "the open card's output preview"],
    [TOOL_BEAT, "arrow", "the input→output separator glyph"],
    [BEAT, "ghost-out", "the compressed row's output hint"],
    [BEAT, "reason", "the focused compressed beat's explanation"],
    ["src/cockpit/render/JsonNode.svelte", "twisty", "the JSON tree's fold control"],
  ];

  /** The `color: var(--ink-*)` one selector's rule block consumes. */
  function consumedInk(source: string, selector: string): string | null {
    const m = source.match(new RegExp(`\\.${selector}\\s*\\{[^}]*?color:\\s*var\\((--ink-\\d)\\)`));
    return m === null ? null : m[1]!;
  }

  test("every data-hint surface clears 3:1 on both beat grounds, in both themes", () => {
    const failures: string[] = [];
    for (const [file, selector, what] of HINT_SURFACES) {
      const source = read(file);
      const ink = consumedInk(source, selector);
      if (ink === null) {
        failures.push(`${selector} (${what}): no --ink-* color found in ${file}`);
        continue;
      }
      for (const [theme, table] of [
        ["dark", dark],
        ["light (paper)", light],
      ] as const) {
        const hex = table.get(ink);
        if (hex === undefined) {
          failures.push(`${selector} (${what}): ${ink} is not a declared hex in the ${theme} theme`);
          continue;
        }
        for (const ground of ["--ground-1", "--ground-2"]) {
          const ratio = contrastRatio(hex, table.get(ground)!);
          if (ratio < 3) {
            failures.push(
              `${what} (.${selector}) — ${theme} ${ink} on ${ground}: ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    expect(failures, `measured, not eyeballed:\n${failures.join("\n")}`).toEqual([]);
  });
});

// ── MUTATION SELF-CHECKS ──────────────────────────────────────────────────

describe("mutation — the symmetry guards catch what they claim to", () => {
  test("re-introducing the auto-expansion is caught by the `open` pin", () => {
    const restored = `const open = $derived(expanded || tool.status === "running" || tool.status === "error");`;
    expect(/const open = \$derived\(expanded \|\| live\);/.test(restored)).toBe(false);
    expect(/status === "error"/.test(restored)).toBe(true);
  });

  test("a field rendered for ONE outcome only is caught by the sequence compare", () => {
    const doc = new DOMParser().parseFromString(
      `<div><span data-field="tool-name"></span><span data-field="status"></span>
       <span data-field="error-detail"></span></div>`,
      "text/html",
    );
    const withExtra = anatomy(doc.body);
    const without = ["tool-name", "status"];
    expect(withExtra).not.toEqual(without);
    expect(withExtra).toContain("error-detail");
  });

  test("a field MISSING for one outcome is caught too (the compare is two-way)", () => {
    const doc = new DOMParser().parseFromString(
      `<div><span data-field="tool-name"></span></div>`,
      "text/html",
    );
    expect(anatomy(doc.body)).not.toEqual(["tool-name", "status"]);
  });

  test("a status word standing in for the recorded output is caught", () => {
    expect(/→ failed/.test("read file src/lib/reader.ts → failed")).toBe(true);
    expect(/→ failed/.test("read file src/lib/reader.ts → ENOENT: no such file")).toBe(false);
  });

  test("a status-labelled output cell is caught", () => {
    expect(/\berror\b/.test("read file failed 42ms input path output ENOENT")).toBe(false);
    expect(/\berror\b/.test("read file failed 42ms input path error ENOENT")).toBe(true);
  });

  test("the contrast maths is right on known pairs", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#808080", "#808080")).toBeCloseTo(1, 5);
  });

  test("a desaturated 'green' is caught by the greyness check", () => {
    const grey = "#8a908c";
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(grey.slice(i, i + 2), 16));
    const max = Math.max(r!, g!, b!);
    expect((max - Math.min(r!, g!, b!)) / max).toBeLessThan(0.25);
  });
});

// ── IDENTITY SURVIVES COMPRESSION ─────────────────────────────────────────
//
// THE USER'S REPORT, VERBATIM: "when collapsing further a tool call, we just
// have its checkmark, we lose the name and everything, just ... then a
// checkmark."
//
// A bare checkmark is a claim that SOMETHING succeeded. It cannot be read,
// cannot be searched, and cannot be told apart from the call above it. The
// principle the ladder now encodes: compression drops DETAIL, never
// IDENTITY. Detail leaves in order — output, then input, then timing — and
// the name is the last field standing.

describe("the compression ladder — every level that renders, names the call", () => {
  // DYNAMIC over the level list, so a level added tomorrow cannot quietly
  // omit identity: it will be exercised here the moment it exists.
  //
  // That sentence used to sit above `const LEVELS: FisheyeLevel[] = ["full",
  // "ghost", "tick"]`, which is a HAND-WRITTEN list wearing the word dynamic.
  // A subset of a union is assignable to it, so a fourth level would have
  // compiled, shipped, and never been exercised here at all — the guard would
  // have kept passing while covering three quarters of its subject. The
  // vocabulary is now imported from the owner that defines the type, so the
  // sentence is true.
  const LEVELS: readonly FisheyeLevel[] = FISHEYE_LEVELS;

  test("the level vocabulary this guard iterates is not empty", () => {
    // A guard whose universe comes back empty must FAIL rather than pass: an
    // empty `for` loop registers no cases and reports success.
    expect(
      LEVELS.length,
      "the fisheye level vocabulary is empty — a ladder guard with no rungs agrees with everything",
    ).toBeGreaterThan(0);
  });

  for (const level of LEVELS) {
    for (const [name, beat] of [
      ["success", SUCCESS],
      ["failure", FAILURE],
    ] as const) {
      test(`${level}/${name}: the tool's name is rendered`, () => {
        const fields = renderAtLevel(beat, level);
        expect(
          fields,
          `at ${level} a tool call must still say which tool it was — a status mark alone is ` +
            "an outcome with no subject",
        ).toContain("tool-name");
      });
    }
  }

  test("…and the name is really in the text, not just in an attribute", () => {
    for (const level of LEVELS) {
      const { container } = render(BeatView, {
        props: {
          beat: SUCCESS,
          fisheye: { level, reason: "r" },
          focused: false,
          onChain: false,
          expanded: false,
          projectPath: null,
          ...NOOP,
        },
      });
      expect(container.textContent ?? "", `${level} must print the tool's label`).toContain(
        "read file",
      );
    }
  });

  test("detail leaves in order: the deepest rung keeps name+status and drops the rest", () => {
    // Stated positively so "keep everything at every level" (which would also
    // satisfy the assertions above) is not a passing answer: the ladder has
    // to be a ladder.
    const tick = renderAtLevel(SUCCESS, "tick");
    const ghost = renderAtLevel(SUCCESS, "ghost");
    expect(tick).toContain("status");
    expect(tick).toContain("tool-name");
    expect(tick, "a tick drops the transformation, keeps the identity").not.toContain(
      "output-hint",
    );
    expect(ghost, "a ghost adds the transformation back").toContain("output-hint");
    expect(ghost).toContain("input-hint");
    expect(ghost).toContain("duration");
    expect(
      ghost.length,
      "each rung up must state strictly more than the one below it",
    ).toBeGreaterThan(tick.length);
  });

  test("mutation: dropping the name from the deepest rung is caught", () => {
    // The exact shape of the defect that was reported — a tick rendering
    // only its status mark.
    const withoutName = ["tick-mark", "status"];
    expect(withoutName).not.toContain("tool-name");
  });
});
