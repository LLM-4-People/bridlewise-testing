// @vitest-environment jsdom
/**
 * A TOKEN READ ONCE IS NOT A TOKEN — the owner, and the band that proved it.
 *
 * THE DEFECT (#52). The SWEEP resolved its whole palette in `onMount` into a
 * `$state`, so switching Theme from Carbon to Logbook left the band painting
 * a carbon housing, carbon grounds and carbon inks onto a warm paper page.
 * `src/cockpit/tokens.css` re-declares every one of the fifteen values
 * `SweepPalette` holds under `:root[data-cockpit-theme="light"]`, so the stale
 * palette was wrong in every single field, not merely in `--beam`.
 *
 * WHAT IS DRIVEN HERE, and why it takes two halves. Reading tokens at paint
 * time is only half the fix and it is the half that LOOKS done: fresh values
 * are worth nothing if nothing re-runs the paint when the theme changes. So
 * the band is driven through a real theme switch — the same
 * `data-cockpit-theme` attribute the settings sheet writes — with a stubbed 2D
 * context capturing what the painter actually put on the canvas. The
 * assertion is on the PIXELS' colours, not on the shape of the source.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";

import { walk, read, relpath } from "../helpers/source-scan.ts";
import { callArgumentsOf, exportedBindings, functionsCalling } from "../helpers/function-scope.ts";
import {
  readSourceView,
  sourceViewOf,
} from "../../engine/scripts/verification/source-view.ts";

import Sweep from "../../src/cockpit/sweep/Sweep.svelte";
import { resetSweep, sweepMarks } from "../../src/cockpit/sweep/sweep-store";
import { resetSpectrumFeed } from "../../src/cockpit/sweep/spectrum-load";
import type { StreamState, SweepEvent } from "../../src/cockpit/sweep/types";
import {
  StaleTokenRead,
  designConditions,
  designConditionsObserverAttached,
  watchDesignConditions,
  watchedDesignAttributes,
  TOKEN_FALLBACKS,
  UnknownPaintToken,
  withPaintTokens,
} from "../../src/cockpit/paint/design-tokens.ts";
import { SPACING_DEFAULT, SPACING_ID, setLocalPref } from "../../src/cockpit/settings/local-prefs.ts";

const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: null,
  errorCode: null,
  runId: extra.runId !== undefined ? extra.runId : "run-1",
  turnId: extra.turnId !== undefined ? extra.turnId : "t1",
  parentEventId: extra.parentEventId ?? null,
  description: extra.description ?? "",
});

const T0 = Date.parse("2026-07-25T13:40:00");
const IDLE: StreamState = { status: "idle", lastEventMs: null, eventsReceived: 0 };

/** Every colour string the painter assigned, in order. */
let painted: string[];
let widthOverride: PropertyDescriptor | undefined;

function stubCanvas(): void {
  painted = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "canvas") return undefined;
        // Every drawing verb is a no-op; only the colours are recorded.
        return () => undefined;
      },
      set(_t, prop, value) {
        if (prop === "fillStyle" || prop === "strokeStyle") painted.push(String(value));
        return true;
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
}

beforeEach(() => {
  cleanup();
  resetSweep();
  resetSpectrumFeed();
  sweepMarks.set([]);
  document.documentElement.removeAttribute("data-cockpit-theme");
  designConditions.set(0);
  stubCanvas();
  // jsdom lays nothing out, and the band refuses to paint a zero-width box
  // (correctly — a zero-width paint is not a paint). One override, this file
  // only, so the paint path is genuinely entered.
  widthOverride = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 480;
    },
  });
});

afterEach(() => {
  if (widthOverride !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", widthOverride);
  }
  vi.restoreAllMocks();
});

describe("withPaintTokens — the only door, and it closes", () => {
  test("a read answers the document as it is NOW, not as it was", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    document.documentElement.style.setProperty("--beam", "#8fd3ff");
    expect(withPaintTokens(el, (read) => read("--beam", "fallback"))).toBe("#8fd3ff");

    // The theme changes. A reader created per paint answers the new value; the
    // captured palette this replaces answered the old one forever.
    document.documentElement.style.setProperty("--beam", "#0f6fa8");
    expect(withPaintTokens(el, (read) => read("--beam", "fallback"))).toBe("#0f6fa8");
    document.documentElement.style.removeProperty("--beam");
  });

  test("an unset token yields the caller's fallback, never an empty string", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(withPaintTokens(el, (read) => read("--nothing-declares-this", "#123456"))).toBe(
      "#123456",
    );
    // And with no element at all (a painter that has not mounted yet).
    expect(withPaintTokens(null, (read) => read("--beam", "#123456"))).toBe("#123456");
  });

  test("an omitted fallback fills from TOKEN_FALLBACKS, and an unknown name throws", () => {
    expect(withPaintTokens(null, (read) => read("--beam"))).toBe(TOKEN_FALLBACKS["--beam"]);
    expect(withPaintTokens(null, (read) => read("--sp-3"))).toBe(TOKEN_FALLBACKS["--sp-3"]);
    expect(() => withPaintTokens(null, (read) => read("--nothing-declares-this"))).toThrow(
      UnknownPaintToken,
    );
  });

  test("a reader that OUTLIVES its paint throws, rather than answering with last frame's theme", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let escaped: ((n: string, f: string) => string) | null = null;
    const insideWorked = withPaintTokens(el, (read) => {
      escaped = read;
      // BOTH DIRECTIONS: it must WORK inside, or a reader that threw
      // unconditionally would satisfy the assertion below while being useless.
      return read("--nope", "inside");
    });
    expect(insideWorked).toBe("inside");
    expect(() => escaped!("--nope", "outside")).toThrow(StaleTokenRead);
    expect(() => escaped!("--nope", "outside")).toThrow(/outlived the paint/);
  });

  test("the reader is revoked even when the paint THROWS half way through a frame", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    let escaped: ((n: string, f: string) => string) | null = null;
    expect(() =>
      withPaintTokens(el, (read) => {
        escaped = read;
        throw new Error("the paint broke");
      }),
    ).toThrow("the paint broke");
    // This is the case a `live = false` after the call would miss, and it is
    // exactly the case where a stashed reader survives into the next frame.
    expect(() => escaped!("--x", "y")).toThrow(StaleTokenRead);
  });
});

describe("designConditions — the signal a repaint binds to", () => {
  test("it advances on a theme change and on a density change, and on nothing else", () => {
    const release = watchDesignConditions();
    // THE WITNESS (§36): an assertion that a counter did NOT move is
    // indistinguishable from one made with no observer attached at all.
    expect(designConditionsObserverAttached(), "the witness: something is watching").toBe(true);

    const before = designConditions.get();
    document.documentElement.setAttribute("data-cockpit-theme", "light");
    document.documentElement.setAttribute("data-density", "deep");
    // MutationObserver delivers on a microtask.
    return Promise.resolve().then(() => {
      expect(designConditions.get()).toBeGreaterThan(before);
      const afterReal = designConditions.get();
      document.documentElement.setAttribute("data-unrelated-thing", "x");
      return Promise.resolve().then(() => {
        expect(
          designConditions.get(),
          "an attribute that changes no token must not cost a repaint",
        ).toBe(afterReal);
        document.documentElement.removeAttribute("data-unrelated-thing");
        release();
      });
    });
  });

  test("the watch is refcounted, so the last painter out takes the observer down", () => {
    const a = watchDesignConditions();
    const b = watchDesignConditions();
    expect(designConditionsObserverAttached()).toBe(true);
    a();
    expect(designConditionsObserverAttached(), "one painter leaving is not all of them").toBe(
      true,
    );
    b();
    expect(designConditionsObserverAttached()).toBe(false);
    // Releasing twice must not drive the count negative — that would leave the
    // next painter's observer un-started.
    b();
    const c = watchDesignConditions();
    expect(designConditionsObserverAttached()).toBe(true);
    c();
    expect(designConditionsObserverAttached()).toBe(false);
  });

  test("a spacing change through the one token-override door advances it", async () => {
    const release = watchDesignConditions();
    expect(designConditionsObserverAttached(), "the witness: something is watching").toBe(true);
    const before = designConditions.get();
    setLocalPref(SPACING_ID, String(SPACING_DEFAULT + 1));
    await Promise.resolve();
    expect(designConditions.get()).toBeGreaterThan(before);
    setLocalPref(SPACING_ID, String(SPACING_DEFAULT));
    release();
  });

  test("the watched attributes are the ones that actually remap tokens", () => {
    expect(watchedDesignAttributes()).toEqual([
      "data-cockpit-theme",
      "data-density",
      "class",
      "style",
    ]);
  });
});

describe("#52 — the SWEEP repaints in the theme it is being looked at in", () => {
  test("a theme switch changes the colours the band actually paints", async () => {
    // `--ground-1` is the band's HOUSING — the largest area of the instrument
    // and the one a reader cannot miss. It is chosen over `--beam` here for a
    // reason worth recording: the beam is spent only on the now edge and the
    // head, so a band with no live edge paints none, and an assertion on it
    // would have passed for the wrong reason. The housing is painted on every
    // frame, which is what makes it a witnessable subject.
    document.documentElement.style.setProperty("--ground-1", "#15181d"); // carbon
    render(Sweep, {
      props: { events: [ev(T0), ev(T0 + 1000), ev(T0 + 2000)], stream: IDLE },
    });
    // The band schedules its paint on a real animation frame, so the wait is
    // for the PAINT, never for a duration — a fixed sleep here would be a
    // timer standing in for the event it is meant to observe.
    await waitFor(() => expect(painted.length).toBeGreaterThan(0));

    // THE WITNESS (§36) — the band must be painting SOMETHING before "the
    // colour changed" can mean anything. A zero-length capture would make
    // every assertion below vacuously true.
    expect(painted.length, "the witness: the painter is reaching the canvas").toBeGreaterThan(0);
    expect(painted, "the carbon housing is on the canvas").toContain("#15181d");
    expect(painted).not.toContain("#fbfaf7");

    // THE THEME SWITCH, exactly as the settings sheet performs it: the light
    // palette's value, and the attribute that selects it.
    painted.length = 0;
    document.documentElement.style.setProperty("--ground-1", "#fbfaf7"); // logbook
    document.documentElement.setAttribute("data-cockpit-theme", "light");
    await waitFor(() => expect(painted.length).toBeGreaterThan(0));

    expect(painted.length, "the switch must cause a repaint at all").toBeGreaterThan(0);
    expect(painted, "the logbook housing is on the canvas").toContain("#fbfaf7");
    expect(
      painted,
      "the carbon housing must be gone — a band that keeps it is a dark instrument on a paper page",
    ).not.toContain("#15181d");

    document.documentElement.style.removeProperty("--ground-1");
  });
});

describe("the class is closed — no surface resolves a design token privately", () => {
  /**
   * THE FLOOR, AND IT SAYS SO. The three rungs above this one are in the
   * owner's own docstring; what none of them can reach is a component that
   * ignores the owner and writes `getComputedStyle(el).getPropertyValue("--x")`
   * itself, because that bypass is not a bad value, it is the absence of a
   * call. This is the same shape the response grammar's guard occupies and it
   * carries the same warning: it is only as good as the universe it walks.
   *
   * The universe is the WHOLE cockpit tree, derived by walking it, and the
   * only exemption is the owner itself — by path identity, not by pattern,
   * because a pattern-based exemption is a second thing to keep in step.
   */
  const OWNER = "src/cockpit/paint/design-tokens.ts";

  test("the walk finds the tree, and finds the owner in it", () => {
    const files = walk("src/cockpit", { exts: [".svelte", ".ts"] }).map(relpath);
    // THE WITNESS (§36). A scan that returns no violations because it walked
    // an empty directory is indistinguishable from a clean tree. So the walk
    // must contain the one file that DOES the forbidden thing legitimately,
    // and that file must contain the forbidden spelling.
    expect(files, "the witness: the walk reaches the owner").toContain(OWNER);
    expect(read(OWNER), "the witness: the owner really does read tokens").toContain(
      "getPropertyValue",
    );
    expect(files.length, "the cockpit tree is not empty").toBeGreaterThan(100);
  });

  test("nothing outside the owner reads a property this guard cannot IDENTIFY, custom or otherwise", () => {
    const files = walk("src/cockpit", { exts: [".svelte", ".ts"] }).map(relpath);
    const findings: string[] = [];
    let layoutReads = 0;
    for (const file of files) {
      if (file === OWNER) continue;
      for (const read of computedStyleReads(readSourceView(file).codeWithStrings(), file)) {
        if (read.verdict === "layout") layoutReads += 1;
        else findings.push(`${file}:${read.line} [${read.verdict}] getPropertyValue(${read.argument})`);
      }
    }
    // Reported so the ALLOWED half of the population is a number too: a
    // detector that had stopped seeing `getPropertyValue` at all would print
    // zero here while the assertion below stayed green (§31).
    console.log(`[computed-style] layout reads allowed: ${layoutReads}`);
    expect(
      findings,
      "a design token resolved outside paint/design-tokens.ts is a value that " +
        "cannot be revoked and a paint that is bound to no signal — route it " +
        "through withPaintTokens and tap $designConditions. A property name " +
        "this guard cannot read is refused for the same reason: `unreadable` " +
        "means the claim in this test's name could not be checked, and an " +
        "unchecked claim must fail rather than pass.",
    ).toEqual([]);
  });

  describe("the detector is driven, in both directions and in the inert one", () => {
    // §36 made permanent rather than performed once: without these, the
    // `toEqual([])` above is satisfied by a detector that matches nothing.
    const at = (code: string): ReturnType<typeof computedStyleReads> =>
      computedStyleReads(sourceViewOf(code, "plant.ts").codeWithStrings(), "plant.ts");

    test("PLANT — a literal custom property is FOUND, and reported as such", () => {
      const found = at(`const v = getComputedStyle(el).getPropertyValue("--beam");`);
      expect(found.map((f) => f.verdict)).toEqual(["custom"]);
      expect(found[0]!.argument).toBe(`"--beam"`);
    });

    test("★ PLANT — the NAME IN A VARIABLE, the exact shape that passed before", () => {
      // Driven against the previous pattern (`getPropertyValue(\s*["'`]--`) this
      // returned nothing and the guard reported the tree clean while its own
      // message claimed nothing outside the owner reads a custom property.
      const found = at(
        `const TOKEN = "--beam";\nconst v = getComputedStyle(el).getPropertyValue(TOKEN);`,
      );
      expect(found.map((f) => f.verdict)).toEqual(["unreadable"]);
      expect(found[0]!.argument).toBe("TOKEN");
    });

    test("INERT — a LAYOUT property read by literal name is not this class, and is not flagged", () => {
      // The wired-but-inert direction. A detector that flagged every
      // `getPropertyValue` would satisfy both plants above and be useless: a
      // computed `overflow-y` cannot go stale across a theme switch, because
      // no theme re-declares it.
      const found = at(`const v = getComputedStyle(el).getPropertyValue("overflow-y");`);
      expect(found.map((f) => f.verdict)).toEqual(["layout"]);
    });

    test("the view is live — a custom-property read inside a COMMENT is not a read", () => {
      const found = at(`// getComputedStyle(el).getPropertyValue("--beam")\nconst v = 1;`);
      expect(found, "a comment is documentation, not a bypass").toEqual([]);
      // WITNESS: the same bytes without the comment marker ARE found, so the
      // emptiness above is the view working rather than the matcher broken.
      expect(at(`const v = getComputedStyle(el).getPropertyValue("--beam");`)).toHaveLength(1);
    });
  });
});

/**
 * ═════════════════════════════════════════════════════════════════════════
 * ★ A PAINTER THAT READS A TOKEN MUST RE-RUN WHEN THE THEME CHANGES.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS EXISTS, MEASURED ─────────────────────────────────────────────
 *
 * The half of #52 that LOOKS done is the half that was guarded. Deleting
 * `void $designConditions;` — the tap that binds a paint to the signal —
 * from each of the four painters in this cockpit, keeping the fresh
 * paint-time reads, and running `tests/cockpit` (125 files / 2,285 tests):
 *
 *     sweep/Sweep.svelte        1 failed   rc 1
 *     rooms/MicroSweep.svelte   passed     rc 0
 *     rooms/Spark.svelte        passed     rc 0
 *     rooms/SwitchRoom.svelte   passed     rc 0
 *
 * and for `MicroSweep` at FULL-SUITE scope the failing-file set was identical
 * to baseline: the mutation killed nothing in the entire suite. `MicroSweep`
 * and `Spark` are the two components that HAD this exact defect. The lesson
 * was enforced for the band and for nothing else, so a future edit dropping
 * the tap from any of the other three restores the original bug with a green
 * run.
 *
 * ── WHY IT IS STRUCTURAL AND NOT FOUR COPIES OF THE BAND'S TEST ───────────
 *
 * The band's behavioural test above is worth what it costs: it drives a real
 * theme switch through a real render and asserts on the pixels' colours. But
 * it needs a stubbed 2D context, a `clientWidth` override and a props fixture
 * shaped for that one component, so paying it four times buys four fixtures
 * and still says nothing about the fifth painter somebody adds next month.
 *
 * The property is the same for all of them and it is structural: THE TOKEN
 * READ MUST BE REACHABLE FROM A REACTIVE SCOPE THAT TAPS THE SIGNAL. So the
 * population is DERIVED — every file under `src/cockpit` whose code calls the
 * owner's door — and never listed (§31b: a hand-written universe contains the
 * defect it exists to end).
 *
 * ── WHY `withPaintTokens` IS THE WHOLE POPULATION OF TOKEN READERS ────────
 *
 * Because the census above says so, in this same file: nothing outside the
 * owner resolves a custom property out of a computed style, including through
 * a name the scan cannot read. The two guards compose — one closes the door,
 * this one requires everyone who walks through it to be bound to the signal —
 * and neither is sound alone.
 *
 * ── READ STRUCTURALLY, NOT BY PROXIMITY ──────────────────────────────────
 *
 * Through `source-structure.ts`, the shared owner: `callArgumentsOf` hands
 * back each `$effect(…)` argument as the PARSER delimited it, and
 * `functionsCalling` builds the reachability closure by name. Nothing here is
 * bounded by a byte count or by the next construct's spelling.
 */
describe("★ every painter that reads a design token re-runs when the theme changes", () => {
  const OWNER = "src/cockpit/paint/design-tokens.ts";
  /** The owner's one door to a token. Checked against the owner's exports below. */
  const DOOR = "withPaintTokens";
  /** The signal a repaint binds to, as Svelte spells an auto-subscription. */
  const TAP = /(?:^|[^\w$])\$designConditions\b/;

  type Painter = Readonly<{
    file: string;
    /** Every local name that reaches the door, the door itself included. */
    readers: readonly string[];
    /** One entry per `$effect(…)`, in source order. */
    scopes: readonly Readonly<{ index: number; reachesRead: boolean; tapsSignal: boolean }>[];
  }>;

  /**
   * THE NAMES THAT REACH THE DOOR — a closure, not a guess.
   *
   * `Sweep` is four hops deep (`$effect` → `schedulePaint` → `paintNow` →
   * `readPalette` → `withPaintTokens`), so a one-hop rule would have declared
   * the band unbound and a zero-hop rule would have found no painters at all.
   */
  function readersIn(source: string, file: string): readonly string[] {
    const names = new Set<string>([DOOR]);
    for (;;) {
      const before = names.size;
      for (const name of [...names]) {
        for (const scope of functionsCalling(source, name, `${file} → ${name}`)) names.add(scope.name);
      }
      if (names.size === before) return [...names];
    }
  }

  /** Does this body call any of `names` — as the parser delimits a call? */
  function callsAnyOf(body: string, names: readonly string[], what: string): boolean {
    return names.some((name) => callArgumentsOf(body, name, what).length > 0);
  }

  /**
   * THE DETECTOR. A pure function of one file's source, so the plants below
   * drive exactly the code the tree scan runs — a mutation modelled as a local
   * lambda proves nothing about the scan above it.
   */
  function painterOf(source: string, file: string): Painter | null {
    if (!sourceViewOf(source, file).code().includes(`${DOOR}(`)) return null;
    const readers = readersIn(source, file);
    const scopes = callArgumentsOf(source, "$effect", `${file} $effect`).map((body, index) => ({
      index,
      reachesRead: callsAnyOf(body, readers, `${file} $effect#${index}`),
      // The comments are blanked before this asks, so the paragraph explaining
      // the tap cannot stand in for the tap.
      tapsSignal: TAP.test(sourceViewOf(body, "effect.ts").code()),
    }));
    return { file, readers, scopes };
  }

  /**
   * What is wrong with this painter, in the words the next reader needs.
   *
   * TWO KINDS, because there are two ways to lose the property and only one of
   * them is the one that was guarded:
   *   • the read is in no reactive scope at all — the ORIGINAL #52 defect,
   *     tokens resolved once in `onMount`;
   *   • a reactive scope reaches the read and is bound to nothing — the defect
   *     that survived in three of four components.
   */
  function faultsOf(painter: Painter): readonly string[] {
    const reading = painter.scopes.filter((s) => s.reachesRead);
    if (reading.length === 0) {
      return [
        `${painter.file}: resolves design tokens (${painter.readers.join(" → ")}) but no `
        + "$effect reaches that read, so nothing re-runs it when the theme changes",
      ];
    }
    return reading
      .filter((s) => !s.tapsSignal)
      .map((s) => `${painter.file}: $effect #${s.index} resolves design tokens and does not tap $designConditions`);
  }

  /**
   * The scan, MEMOISED AND DEFERRED — deliberately not a `const` at describe
   * scope. Vitest orders files by TEST duration, so work done while the suite
   * is being COLLECTED is a cost the scheduler sorts by a number that does not
   * include it; `web-ui-runtime-budget.test.ts` gates exactly that share and
   * says so. Parsing the whole cockpit tree belongs inside the tests that ask
   * for it, and both of them get the same answer for one parse.
   */
  let scanned: readonly Painter[] | null = null;
  const painters = (): readonly Painter[] => {
    if (scanned === null) {
      scanned = walk("src/cockpit", { exts: [".svelte", ".ts"] })
        .map(relpath)
        .filter((file) => file !== OWNER)
        .map((file) => painterOf(readSourceView(file).codeWithStrings(), file))
        .filter((p): p is Painter => p !== null);
    }
    return scanned;
  };

  test("the population is DERIVED, non-empty, and its door still exists under that name", () => {
    // §25: after a rename, the guard that still PASSES is the dangerous one.
    // If `withPaintTokens` is renamed, `painters` silently becomes empty and
    // this guard certifies nothing — so the door is checked against the
    // owner's own exports rather than taken on trust.
    const exported = [...exportedBindings(readSourceView(OWNER).codeWithStrings(), OWNER).keys()];
    expect(exported, `the owner must still export ${DOOR}, or this guard's universe is empty`).toContain(DOOR);
    const found = painters();
    expect(found.length, "no painter was found at all — the walk or the door name has moved").toBeGreaterThan(0);
    // §31a, containment per part: a scalar over the whole population cannot
    // see one painter's scopes collapse while another's grow. Every painter
    // must have a token-reading reactive scope of its own, and that positive
    // count is the WITNESS (§36) for the emptiness asserted below.
    for (const painter of found) {
      expect(
        painter.scopes.filter((s) => s.reachesRead).length,
        `the witness: ${painter.file} was really analysed and its token read really was located`,
      ).toBeGreaterThan(0);
    }
    console.log(
      `[painters] ${found.length} files, `
      + found.map((p) => `${p.file}(${p.scopes.filter((s) => s.reachesRead).length}/${p.scopes.length} scopes)`).join(" "),
    );
  });

  test("★ every token-reading reactive scope taps the signal", () => {
    expect(
      painters().flatMap(faultsOf),
      "a painter that resolves design tokens inside a scope bound to nothing keeps painting the "
      + "theme that was active when it last ran, and every line of it looks correct. Tap the named "
      + "signal in the same $effect that does the painting: `void $designConditions;`.",
    ).toEqual([]);
  });

  describe("the detector is driven on planted painters — both directions, and the inert one", () => {
    /** A painter shaped exactly like the live ones, with the tap as a parameter. */
    const component = (tap: string): string =>
      `<script lang="ts">\n`
      + `  import { designConditions, withPaintTokens } from "../paint/design-tokens.ts";\n`
      + `  let canvas: HTMLCanvasElement | undefined;\n`
      + `  function paint(el: HTMLCanvasElement): void {\n`
      + `    const ink = withPaintTokens(el, (r) => r("--ink-3", "#79818d"));\n`
      + `    el.getContext("2d")!.fillStyle = ink;\n`
      + `  }\n`
      + `  $effect(() => {\n`
      + `    const el = canvas;\n`
      + `${tap}`
      + `    if (el === undefined) return;\n`
      + `    paint(el);\n`
      + `  });\n`
      + `</script>\n<canvas bind:this={canvas}></canvas>\n`;

    const faultsIn = (source: string): readonly string[] => {
      const painter = painterOf(source, "Planted.svelte");
      expect(painter, "the fixture must be recognised as a painter at all").not.toBeNull();
      return faultsOf(painter!);
    };

    test("CONTROL — the live shape, with the tap, is clean", () => {
      expect(faultsIn(component("    void $designConditions;\n"))).toEqual([]);
    });

    test("★ PLANT — DELETE THE TAP and the painter is found, by name", () => {
      const faults = faultsIn(component(""));
      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain("does not tap $designConditions");
    });

    test("★ PLANT — the INERT form: the right VALUE, no reactive dependency", () => {
      // `designConditions.get()` reads the same number `$designConditions`
      // does. It is not a subscription, so the effect never re-runs — the
      // mutation that survives in a component and cannot be seen in a diff.
      const faults = faultsIn(component("    void designConditions.get();\n"));
      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain("does not tap $designConditions");
    });

    test("★ PLANT — the ORIGINAL #52 shape: the read resolved outside every reactive scope", () => {
      const onMountOnly =
        `<script lang="ts">\n`
        + `  import { onMount } from "svelte";\n`
        + `  import { withPaintTokens } from "../paint/design-tokens.ts";\n`
        + `  let canvas: HTMLCanvasElement | undefined;\n`
        + `  let ink = "#000";\n`
        + `  onMount(() => { ink = withPaintTokens(canvas, (r) => r("--ink-3", "#79818d")); });\n`
        + `  $effect(() => { void canvas; });\n`
        + `</script>\n`;
      const faults = faultsIn(onMountOnly);
      expect(faults).toHaveLength(1);
      expect(faults[0]).toContain("no $effect reaches that read");
    });

    test("INERT — a component that reads no token is not a painter and is not judged", () => {
      // Without this, a detector that flagged every untapped `$effect` in the
      // cockpit would pass all four tests above and fail the whole tree.
      const notAPainter =
        `<script lang="ts">\n`
        + `  let n = $state(0);\n`
        + `  $effect(() => { console.log(n); });\n`
        + `</script>\n`;
      expect(painterOf(notAPainter, "NotAPainter.svelte")).toBeNull();
    });

    test("the reachability is a CLOSURE, not one hop — the band is four deep", () => {
      // `Sweep` is $effect → schedulePaint → paintNow → readPalette → the door.
      // A one-hop rule would call the band unbound; this pins the property that
      // makes the live scan correct rather than accidentally correct.
      const deep =
        `<script lang="ts">\n`
        + `  import { designConditions, withPaintTokens } from "../paint/design-tokens.ts";\n`
        + `  let host: HTMLElement | undefined;\n`
        + `  function readPalette() { return withPaintTokens(host, (r) => r("--beam", "#fff")); }\n`
        + `  function paintNow() { void readPalette(); }\n`
        + `  function schedulePaint() { const run = () => { paintNow(); }; run(); }\n`
        + `  $effect(() => { void $designConditions; schedulePaint(); });\n`
        + `</script>\n`;
      const painter = painterOf(deep, "Deep.svelte")!;
      expect(painter.readers).toEqual(
        expect.arrayContaining([DOOR, "readPalette", "paintNow", "schedulePaint"]),
      );
      expect(painter.scopes.filter((s) => s.reachesRead)).toHaveLength(1);
      expect(faultsOf(painter)).toEqual([]);
    });
  });
});

/**
 * EVERY `getPropertyValue(…)` IN THIS VIEW, with what the argument NAMES.
 *
 * ── THE HOLE THIS CLOSES, DRIVEN ──────────────────────────────────────────
 *
 * The census used to match `getPropertyValue\(\s*["'`]--` — LITERALS ONLY —
 * under a message reading "nothing outside the owner reads a CUSTOM PROPERTY
 * out of a computed style". Planted into a cockpit file:
 *
 *     const TOKEN = "--beam";
 *     getComputedStyle(el).getPropertyValue(TOKEN);
 *
 * the guard exited 0 and passed. §31c: the guard's own message is part of the
 * guard, and that message claimed a great deal more than its pattern could
 * support. Either the pattern supports the claim or the claim narrows to what
 * it can prove — this is the first.
 *
 * So the classification is by what the argument IS, and the third verdict is
 * the point:
 *
 *   `custom`     a string literal naming a custom property — the class.
 *   `layout`     a string literal naming an ordinary property. Not this class:
 *                `overflow-y` is not re-declared by a theme, so it cannot go
 *                stale across one.
 *   `unreadable` anything else — an identifier, a call, an interpolated
 *                template. The guard cannot tell which of the two above it is,
 *                and an unchecked claim must FAIL rather than pass.
 *
 * TEMPLATE LITERALS READ AS `unreadable` BY CONSTRUCTION and that is
 * deliberate rather than an oversight: `codeWithStrings()` blanks template
 * interiors (a runtime-built name lives there), so a backtick argument arrives
 * here as blanks. The conservative verdict is the safe one, and it is stated
 * rather than discovered.
 *
 * The caller passes `codeWithStrings()` — quoted-string interiors intact,
 * because the subject of this question IS a quoted string, and comments
 * blanked, because a documented spelling is not a bypass (§29).
 */
export function computedStyleReads(
  view: string,
  file: string,
): readonly Readonly<{ file: string; line: number; argument: string; verdict: "custom" | "layout" | "unreadable" }>[] {
  const out: { file: string; line: number; argument: string; verdict: "custom" | "layout" | "unreadable" }[] = [];
  const call = /\bgetPropertyValue\s*\(/g;
  for (let m = call.exec(view); m !== null; m = call.exec(view)) {
    // The argument list is bounded by its own parentheses — never by a byte
    // count and never by the next construct's spelling.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < view.length && depth > 0; i += 1) {
      if (view[i] === "(") depth += 1;
      else if (view[i] === ")") depth -= 1;
    }
    if (depth !== 0) continue; // unbalanced: not a call this guard can read
    const argument = view.slice(m.index + m[0].length, i - 1).trim();
    const literal = /^(["'])(.*)\1$/s.exec(argument);
    const verdict =
      literal === null ? "unreadable" : literal[2]!.startsWith("--") ? "custom" : "layout";
    out.push({ file, line: view.slice(0, m.index).split("\n").length, argument, verdict });
  }
  return out;
}
