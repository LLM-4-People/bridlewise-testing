// @vitest-environment jsdom
/**
 * THE NO-FAKE-MOTION LAW HAS A MECHANISM NOW — this is what drives it.
 *
 * DESIGN-COCKPIT-V2 §11.8 prescribes: "animation utilities accept an
 * event/gesture handle, not a timer." Until this landed, the rule was honoured
 * BY HAND on three animations and there was nothing to stop the fourth being
 * decoration — which is the half of the law that gets faked, because a
 * `@keyframes` block looks the same whether what it moves is reporting an
 * event or performing liveliness.
 *
 * THE BINDING TEST: every moving thing must NAME the signal it is bound to. A
 * pulse that means "working" is information; a pulse that means "we have a
 * pulse" is decoration. So the assertions below are not about durations or
 * easings — they are about whether the movement can say why it happened.
 */
import { describe, expect, test } from "vitest";

import { walk, read, relpath, stripCssBlockComments } from "../helpers/source-scan.ts";
import {
  readSourceView,
  sourceViewOf,
  type SourceView,
} from "../../engine/scripts/verification/source-view.ts";
import {
  MOTIONS,
  MOTION_CAUSE_IDS,
  MOTION_IDS,
  MotionContract,
  becauseArrived,
  becauseChanged,
  becauseOfGesture,
  consume,
  moves,
} from "../../src/cockpit/motion/motion.ts";

const OWNER = "src/cockpit/motion/motion.ts";
const TOKENS = "src/cockpit/tokens.css";

/**
 * ★ THE CLOCK BARRIER, CORRECTED — the property this suite actually holds.
 *
 * This block was called "a cause cannot come from a clock", and the owner's
 * docstring said there is no factory taking a duration, a delay, a timestamp
 * or an interval. TRUE OF THE SIGNATURES, FALSE OF THE PROPERTY: all three
 * timer routes were driven and all three started a motion —
 * `setTimeout` + `becauseChanged` (the timer ticks the value it reports),
 * `requestAnimationFrame` + `becauseArrived("frame-" + t)`, and
 * `setInterval` + `becauseOfGesture` on a retained event. `becauseArrived`
 * takes `String(performance.now())` because an identity is a string and a
 * clock reading is a string.
 *
 * THE HONEST PROPERTY IS WEAKER AND STILL VALUABLE: a timer-driven motion
 * MUST LIE IN A PLACE A READER CAN SEE. `data-motion-signal` is on the
 * element, so a motion whose signal is a frame number is in the DOM saying
 * so. Rung 3 for STARTING is about NAMING, not about clocks. The equality
 * refusal at rung 4 is the one a timer cannot walk around, and it is driven
 * below against an actual poll.
 */
describe("what a clock can and cannot do here", () => {
  /** Every clock this module must not be able to reach, by spelling. */
  const CLOCKS = ["setTimeout", "setInterval", "requestAnimationFrame", "Date.now", "performance.now"] as const;

  /** The clocks reachable in this source's CODE — never in its prose. */
  function clocksReachableIn(view: SourceView): string[] {
    const code = view.code();
    return CLOCKS.filter((clock) => code.includes(`${clock}(`));
  }

  test("the owner's own source can read no clock at all", () => {
    // "There is no timer in here" is exactly the kind of claim that rots
    // quietly, so it is asserted against the owner's source rather than
    // described in its docstring alone.
    //
    // READ THROUGH `code()` RATHER THAN RAW BYTES, and that is not a
    // convenience (W-11 — your own prose joins the population you measure).
    // Driven: this test failed the moment the owner's docstring was corrected
    // to SAY that `becauseArrived` accepts `String(performance.now())`, which
    // would have made the honest documentation of a limit impossible to write.
    // A guard that forbids describing its own subject is a guard that will be
    // satisfied by silence.
    const view = readSourceView(OWNER);
    // THE WITNESS (§36): the file must be the real one before an absence in it
    // means anything.
    expect(view.length, "the witness: the owner was actually read").toBeGreaterThan(3000);
    expect(view.code(), "the witness: this is the motion owner").toContain("becauseChanged");
    expect(
      clocksReachableIn(view),
      "a clock reachable from the motion owner is a factory one call away from a timer",
    ).toEqual([]);
  });

  test("the clock scan is DRIVEN — a call is found, a mention of one is not", () => {
    // Without both halves, the emptiness above is satisfied by a scan that
    // stopped matching and by one that reads comments as code.
    expect(clocksReachableIn(sourceViewOf(`const t = setTimeout(f, 10);\n`, "p.ts"))).toEqual([
      "setTimeout",
    ]);
    expect(
      clocksReachableIn(sourceViewOf(`// never call setTimeout( from here\nconst x = 1;\n`, "p.ts")),
      "a comment naming the forbidden call is documentation, not a clock",
    ).toEqual([]);
    expect(clocksReachableIn(sourceViewOf(`requestAnimationFrame(paint);\n`, "p.ts"))).toEqual([
      "requestAnimationFrame",
    ]);
  });

  test("a re-measurement that produced the SAME reading is refused, not animated", () => {
    // The load-bearing line. A monitor polls on a schedule; without this, "the
    // poll fired" wears "the reading changed"'s clothes and the numeral twitches
    // every three seconds over an unchanged number.
    expect(() => becauseChanged("context tokens", 4096, 4096)).toThrow(MotionContract);
    expect(() => becauseChanged("context tokens", 4096, 4096)).toThrow(/nothing changed/);
    expect(() => becauseChanged("a reading", "same", "same")).toThrow(/nothing changed/);
    // BOTH DIRECTIONS: a real change must succeed, or a factory that threw
    // unconditionally would satisfy the assertion above while being useless.
    expect(becauseChanged("context tokens", 4096, 8192).signal).toBe("context tokens");
  });

  test("a gesture cause demands the real event, which a timer callback does not have", () => {
    expect(() => becauseOfGesture({ type: "click" } as never, "a press")).toThrow(
      /needs the real event/,
    );
    expect(becauseOfGesture(new Event("pointerdown"), "a press").cause).toBe("gesture");
  });

  test("an arrival cause demands the identity of what arrived", () => {
    expect(() => becauseArrived("", "something landed")).toThrow(/needs the identity/);
    expect(() => becauseArrived("   ", "something landed")).toThrow(/time\s+passing is not/);
    expect(becauseArrived("evt-7", "a recorded event landed").cause).toBe("arrival");
  });

  test("EVERY cause must name its signal in plain words", () => {
    // Derived from the declaration: a cause kind added later is covered here
    // without an edit, because the set comes from the owner's own object.
    expect(MOTION_CAUSE_IDS.slice().sort()).toEqual(["arrival", "change", "gesture"]);
    expect(() => becauseChanged("", 1, 2)).toThrow(/must NAME its signal/);
    expect(() => becauseArrived("id", "   ")).toThrow(/must NAME its signal/);
    expect(() => becauseOfGesture(new Event("x"), "")).toThrow(/must NAME its signal/);
  });

  test("★ A CLOCK READING IS AN ACCEPTED IDENTITY — the barrier that is not there", () => {
    // Stated rather than left for the next reader to discover by writing it.
    // If this ever throws, the owner has grown a real clock barrier and the
    // docstring above is the thing that is now wrong.
    const cause = becauseArrived(String(performance.now()), "frame tick");
    expect(cause.cause, "an arrival cause was produced from nothing but a clock").toBe("arrival");
  });

  test("★ …BUT IT CANNOT MOVE ANONYMOUSLY: what the timer named is on the element", () => {
    // THE HONEST PROPERTY. A motion started from a frame number is legal and
    // is legible: the element carries the words the timer chose, so a reader
    // with an inspector open can disagree with them.
    const node = document.createElement("div");
    const handle = moves(node, {
      motion: "rise",
      cause: becauseArrived(String(performance.now()), "frame tick"),
    });
    expect(node.getAttribute("data-motion-cause")).toBe("arrival");
    expect(
      node.getAttribute("data-motion-signal"),
      "a timer-driven motion has to write its own name where anyone can read it",
    ).toBe("frame tick");
    handle.destroy();
  });

  test("★ THE POLL IS STILL REFUSED — the rung a timer cannot walk around", () => {
    // A real interval over a real unchanged reading, driven rather than
    // described: every tick raises, and the one tick where the value actually
    // moved is the one that yields a cause.
    let reading = 4096;
    const tick = (): unknown => {
      try {
        return becauseChanged("context tokens", reading, reading);
      } catch (err) {
        return err;
      }
    };
    for (let i = 0; i < 3; i += 1) {
      expect(tick(), "a schedule firing over an unchanged value must raise").toBeInstanceOf(
        MotionContract,
      );
    }
    // BOTH DIRECTIONS: when the timer actually MOVES the value, that is news,
    // and news is allowed to animate.
    const before = reading;
    reading = 8192;
    expect(becauseChanged("context tokens", before, reading).signal).toBe("context tokens");
  });
});

describe("★ the signal is NORMALISED once, and the normalisation is OBSERVED", () => {
  /**
   * WHAT WAS WRONG, AND WHAT WAS ACTUALLY WRONG.
   *
   * The reported defect was "`make` computes `words = signal.trim()` and then
   * stores the RAW value, so the trim is computed and discarded". Driven at
   * the parent commit, that is FALSE: `make` stored `words` in both the value
   * and the spend record, and DELETING the `.trim()` was killed (rc 1) by the
   * whitespace-only refusal above.
   *
   * What IS true is the half nothing could see. Storing the raw string in
   * EITHER place — `{ cause, signal }` on the value, or `{ cause, signal, … }`
   * in the ledger — left the suite at rc 0, 13/13 passed, because every test
   * in this file passed an already-trimmed signal. The trim was correct and
   * unobserved, which is the same exposure as a trim that is absent.
   *
   * The repair is both halves: the ledger no longer carries a copy of the
   * cause (there is one place the trim has to be right), and these drive a
   * padded signal all the way to the attribute a reader opens.
   */
  const PADDED = "  tokens in context \n";
  const CLEAN = "tokens in context";

  test("the cause CARRIES the normalised words, not the way they were typed", () => {
    expect(becauseChanged(PADDED, 1, 2).signal).toBe(CLEAN);
    expect(becauseArrived("evt-7", PADDED).signal).toBe(CLEAN);
    expect(becauseOfGesture(new Event("pointerdown"), PADDED).signal).toBe(CLEAN);
  });

  test("and `consume` stamps the normalised words, not a twin of them", () => {
    expect(consume(becauseChanged(PADDED, 1, 2), "roll")["data-motion-signal"]).toBe(CLEAN);
  });

  test("★ and it reaches the ELEMENT — the surface a reader actually opens", () => {
    const node = document.createElement("div");
    const handle = moves(node, { motion: "roll", cause: becauseChanged(PADDED, 1, 2) });
    expect(
      node.getAttribute("data-motion-signal"),
      "data-motion-signal is read by a person with an inspector open; leading "
      + "whitespace there is the raw string leaking through the door",
    ).toBe(CLEAN);
    handle.destroy();
  });

  test("the spend message quotes the normalised words too", () => {
    const cause = becauseChanged(PADDED, 1, 2);
    consume(cause, "roll");
    // The second half of §33's shape: the message a reader gets is part of the
    // guard, and it must not print the raw string either.
    expect(() => consume(cause, "roll")).toThrow(`the cause "${CLEAN}" has already moved`);
  });
});

describe("a cause is spent when it is used", () => {
  test("replaying a stored cause throws, so it cannot be handed to an interval", () => {
    const cause = becauseChanged("a reading", 1, 2);
    expect(consume(cause, "roll")["data-motion-signal"]).toBe("a reading");
    // This is the one-line defeat of the whole mechanism if it is not refused:
    // obtain a cause once, keep it, and fire it on a schedule.
    expect(() => consume(cause, "roll")).toThrow(/already moved something/);
  });

  test("an object that merely LOOKS like a cause is not one", () => {
    const forgery = { cause: "change", signal: "invented" } as never;
    expect(() => consume(forgery, "roll")).toThrow(/not a motion cause/);
  });

  test("an undeclared motion id is refused", () => {
    expect(() => consume(becauseChanged("x", 1, 2), "shimmer" as never)).toThrow(
      /is not a declared motion/,
    );
  });
});

describe("the action stamps the signal on the element, and clears it at rest", () => {
  test("a moving element SAYS what it is bound to", () => {
    const node = document.createElement("div");
    const handle = moves(node, {
      motion: "roll",
      cause: becauseChanged("tokens in context", 10, 20),
    });
    expect(node.getAttribute("data-motion")).toBe("roll");
    expect(node.getAttribute("data-motion-cause")).toBe("change");
    // THE WHOLE LAW IN ONE ATTRIBUTE: open the element and it tells you why it
    // moved. A motion that could not fill this is decoration.
    expect(node.getAttribute("data-motion-signal")).toBe("tokens in context");

    node.dispatchEvent(new Event("animationend"));
    expect(node.getAttribute("data-motion"), "at rest, nothing is moving").toBeNull();
    expect(node.getAttribute("data-motion-signal")).toBeNull();
    handle.destroy();
  });

  test("re-running the action with the SAME param does not replay a spent cause", () => {
    const node = document.createElement("div");
    const param = {
      motion: "cut" as const,
      cause: becauseChanged("the open room", "switch", "settings"),
    };
    const handle = moves(node, param);
    expect(() => handle.update(param)).not.toThrow();
    expect(node.getAttribute("data-motion")).toBe("cut");
    node.dispatchEvent(new Event("animationend"));
    expect(() => handle.update(param)).toThrow(/already moved something/);
    handle.destroy();
  });

  test("null means 'not now' — it does not fabricate a cause to have something to pass", () => {
    const node = document.createElement("div");
    const handle = moves(node, null);
    expect(node.hasAttribute("data-motion")).toBe(false);
    handle.destroy();
  });
});

describe("the vocabulary and its dressing cannot drift apart", () => {
  test("the token owner dresses every declared motion, and the ids are derived", () => {
    expect(MOTION_IDS, "derived from the declaration, not typed out").toEqual(
      Object.keys(MOTIONS),
    );
    expect(MOTION_IDS.length).toBeGreaterThan(0);
    const css = stripCssBlockComments(read(TOKENS));
    for (const id of MOTION_IDS) {
      expect(
        new RegExp(`\\[data-motion="${id}"\\]\\s*\\{[^}]*animation:`).test(css),
        `[data-motion="${id}"] must be dressed by the token owner — a motion ` +
          `declared with no rule is a motion that never happens`,
      ).toBe(true);
    }
  });
});

describe("no cockpit surface starts a motion of its own", () => {
  /**
   * THE FLOOR, AND IT SAYS SO. The rungs above are in the owner's docstring;
   * what none of them reaches is a component writing `animation:` in its own
   * scoped `<style>`, because Svelte scoping is not something a module can
   * see into. Same shape and same limits as the response grammar's bypass
   * guard.
   *
   * `transition` is deliberately NOT in this guard's subject. A transition
   * cannot start itself: it runs because a property changed, and the thing
   * that changed the property is the event. An `animation` runs the moment its
   * element exists or its class lands, which is the only motion in this tree
   * that can happen with nothing behind it.
   */
  const components = walk("src/cockpit", { exts: [".svelte"] }).map(relpath);

  function styleBlock(src: string): string | null {
    const i = src.indexOf("<style");
    if (i < 0) return null;
    const j = src.indexOf("</style>", i);
    return stripCssBlockComments(src.slice(i, j < 0 ? undefined : j));
  }

  test("the population is real, and one converted surface proves the walk reaches it", () => {
    expect(components.length).toBeGreaterThanOrEqual(70);
    // THE WITNESS (§36): a scan of an empty walk finds no violations either.
    expect(components).toContain("src/cockpit/shell/ScopeHost.svelte");
    expect(
      read("src/cockpit/shell/ScopeHost.svelte"),
      "the witness: the converted surface really does go through the owner",
    ).toContain("use:moves");
  });

  test("zero components declare a self-starting animation", () => {
    const findings: string[] = [];
    let scanned = 0;
    for (const file of components) {
      const style = styleBlock(read(file));
      if (style === null) continue;
      scanned += 1;
      if (/(^|[\s;{])animation(-name)?\s*:/m.test(style)) findings.push(file);
    }
    expect(scanned, "components with a style block").toBeGreaterThanOrEqual(50);
    expect(
      findings,
      "a self-starting animation in a component's own style block names no " +
        "signal and cannot be asked what it means — declare it in tokens.css " +
        "against [data-motion] and start it with use:moves",
    ).toEqual([]);
  });

  /**
   * ★ A KEYED REMOUNT MUST NOT SHARE A REACTIVE MOVES PARAM — the second
   * consumption path. Driven in the live browser, not in jsdom: a numeral
   * wired as `{#key value}<span use:moves={cause}>` threw an UNCAUGHT
   * MotionContract on a real value change — the action-param path and the
   * keyed remount both ran `apply` with the same fresh cause, the second
   * consume hit the spent-cause contract, and the roll was LOST for that
   * update (telemetered as a client error on every live change). jsdom
   * cannot reproduce that interleaving (no animationend timing, a different
   * effect flush order — restoring the wiring leaves the behavioral arms
   * green), so the class is pinned here as a SOURCE SHAPE over the whole
   * component population: inside a `{#key}` block the sanctioned stamp is
   * minted once and applied imperatively (RoomHost's cut shape), never a
   * reactive param the remount can double-consume.
   */
  function keyedMovesFindings(src: string): string[] {
    const found: string[] = [];
    const open = /(\{#key\b)/g;
    let m: RegExpExecArray | null;
    while ((m = open.exec(src)) !== null) {
      const close = src.indexOf("{/key}", m.index);
      const window = src.slice(m.index, close < 0 ? undefined : close);
      const at = window.indexOf("use:moves");
      if (at >= 0) found.push(`${m[0]} … use:moves at +${at}`);
    }
    return found;
  }

  test("★ zero components pass a reactive moves param inside a keyed block", () => {
    const findings = components.flatMap((file) => {
      // READ THROUGH `code()` (W-11 — your own prose joins the population
      // you measure): the cell's own comments describe this exact trap, and
      // a raw scan would flag the documentation rather than the wiring.
      const src = readSourceView(file).code();
      return keyedMovesFindings(src).map((where) => `${file}: ${where}`);
    });
    expect(
      findings,
      "a `use:moves` param inside a {#key} block is consumed by two paths for " +
        "one change (the action update and the remount's mount), and the second " +
        "consume throws the spent-cause contract uncaught — mint the cause once " +
        "and stamp it onto the arriving node from an effect instead",
    ).toEqual([]);
  });

  test("★ the keyed-moves scan is DRIVEN — flagged, inert, and window-bounded", () => {
    const at = (src: string): string[] =>
      keyedMovesFindings(sourceViewOf(src, "Planted.svelte").code());
    // PLANT — the exact wiring the live browser threw on.
    expect(
      at(`{#key display}\n  <span use:moves={roll}>{display}</span>\n{/key}\n`),
      "the planted double-consumption shape must be flagged",
    ).toHaveLength(1);
    // INERT 1 — the sanctioned shape: a keyed block with no moves action.
    expect(at(`{#key display}\n  <span>{display}</span>\n{/key}\n`)).toEqual([]);
    // INERT 2 — moves OUTSIDE any keyed block stay legal (every other consumer).
    expect(at(`<div use:moves={cause}></div>\n`)).toEqual([]);
    // INERT 3 — a comment DESCRIBING the trap is documentation, not wiring.
    expect(
      at(`<!-- a reactive \`use:moves\` param beside {#key} is the trap -->\n<span></span>\n`),
      "a detector that flagged its own documentation would make the guard's " +
        "explanation illegal to write",
    ).toEqual([]);
    // WINDOW-BOUNDED — a moves action after the keyed block closed is not
    // inside it; flagging it would make the guard forbid every use:moves in a
    // file that also keys something.
    expect(
      at(`{#key a}\n  <i>{a}</i>\n{/key}\n<span use:moves={x}></span>\n`),
    ).toEqual([]);
    // WITNESS — both halves came from the same function: the plant fires and
    // the population above is the same walk this drives.
    expect(components).toContain("src/cockpit/shell/Popover.svelte");
  });

  /**
   * ★ THE TWO ESCAPES THE FLOOR DID NOT NAME.
   *
   * The scan above reads `<style>` blocks, so two routes to a motion passed
   * straight through it and neither was written down anywhere:
   *
   *   • an INLINE `style="animation: …"` on markup — not a stylesheet at all;
   *   • `node.animate(…)` — the Web Animations API, where no CSS exists to
   *     scan and the `[data-motion]` dressing is not involved.
   *
   * MEASURED BEFORE CLOSING, so this is a floor being extended over an empty
   * region rather than a repair being reported: `grep -rn "\.animate(" src/`
   * → 0 occurrences and `grep -rn 'style="[^"]*animation' src/` → 0
   * occurrences (unit: matching lines, rc 1 from grep on no match). Neither is
   * live today, which is the cheapest moment to close them.
   *
   * READ THROUGH THE SANCTIONED VIEWS (§29): `code()` for the WAAPI verbs, so
   * a paragraph explaining why `node.animate` is refused is not itself a
   * finding, and `codeWithStrings()` for the inline attribute, whose subject
   * IS the interior of a quoted string.
   */
  function waapiAndInlineFindings(view: SourceView, file: string): string[] {
    const found: string[] = [];
    const code = view.code();
    for (const verb of ["animate(", "getAnimations(", "KeyframeEffect("]) {
      const at = code.indexOf(verb);
      if (at >= 0) found.push(`${file}:${view.lineAt(at)} ${verb} — Web Animations API`);
    }
    const inline = /style\s*=\s*(["'])[^"']*animation[^"']*\1/.exec(view.codeWithStrings());
    if (inline !== null) found.push(`${file}:${view.lineAt(inline.index)} inline style="…animation…"`);
    return found;
  }

  test("★ zero components start a motion by inline style or by the Web Animations API", () => {
    const findings = components.flatMap((file) =>
      waapiAndInlineFindings(readSourceView(file), file),
    );
    expect(
      findings,
      "a motion started by node.animate() or by an inline style attribute is invisible to "
      + "the stylesheet scan above and carries no data-motion-signal, so nothing can be asked "
      + "what it means — route it through use:moves and dress it in tokens.css",
    ).toEqual([]);
  });

  test("the escape scan is DRIVEN — both directions, and the inert one", () => {
    const at = (src: string): string[] =>
      waapiAndInlineFindings(sourceViewOf(src, "Planted.svelte"), "Planted.svelte");

    // PLANT 1 — WAAPI.
    expect(at(`<script>\n  node.animate([{ opacity: 0 }], 200);\n</script>\n`)).toHaveLength(1);
    // PLANT 2 — the inline attribute.
    expect(at(`<div style="animation: rise 150ms ease-out"></div>\n`)).toHaveLength(1);
    // INERT 1 — a comment ABOUT the escape is documentation, not a bypass. A
    // detector that flagged it would make this module's own docstring illegal.
    expect(at(`<script>\n  // never call node.animate( here\n</script>\n`)).toEqual([]);
    // INERT 2 — an inline style that is not a motion must not be flagged, or
    // the guard would forbid every `style=` attribute in the cockpit.
    expect(at(`<div style="width: 12px"></div>\n`)).toEqual([]);
    // WITNESS: the two inert cases above are zero because the detector judged
    // them, not because it stopped working — the plants above are the proof it
    // fires, and this asserts both halves came from the same function.
    expect(at(`<div style="width: 12px"></div>\n<div style="animation: rise 1ms"></div>\n`)).toHaveLength(1);
  });
});

/**
 * ── THE CALLER'S HALF OF THE CONTRACT: a MovesParam must not be STORED ────
 *
 * THE DEFECT, DRIVEN THREE TIMES BEFORE IT WAS NAMED. The flow's arrival
 * motion held its param in `$state`, written by an `$effect` — and an effect
 * runs a tick AFTER the render that changed it, so the empty-state branch
 * could re-mount its `use:moves` div with the PREVIOUS transition's cause
 * already consumed. The contract refused the replay by throwing, and the
 * throw was uncaught: three live drives printed
 * `MotionContract: the cause "the open conversation" has already moved
 * something` from the flow's own arrival path.
 *
 * THE SANCTIONED SHAPES (the whole tree uses one of these):
 *   - `$derived.by((): MovesParam => …)` — the cause is minted IN the render
 *     that reads it, so a mount never sees a cause older than itself, and a
 *     re-render that changes nothing re-derives `null`;
 *   - a per-instance `const` minted at open (Popover) — a fresh instance
 *     means a fresh cause.
 * The stored shapes — `let x = $state<MovesParam>` written by an `$effect`,
 * or any `$effect` writing a MovesParam binding — are the crash class, and
 * this arm denies them across every component the walk finds: a component
 * added tomorrow is covered the day it lands, not when it crashes.
 */
describe("a MovesParam bound to use:moves is never a stored cause", () => {
  /** The bindings a file hands to the action, and how each was declared. */
  function storedParamFindings(src: string, file: string): string[] {
    const findings: string[] = [];
    const bindings = [...src.matchAll(/use:moves=\{([a-zA-Z_$][\w$]*)\}/g)];
    for (const [, name] of bindings) {
      // The sanctioned derivations: minted per render, or per instance.
      const derived = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\$derived`).test(src);
      const perInstance = new RegExp(
        `const\\s+${name}\\s*=\\s*\\{[\\s\\S]*?\\}\\s*(?:as\\s+const)?\\s*;`,
      ).test(src) && !new RegExp(`let\\s+${name}`).test(src);
      if (derived || perInstance) continue;
      findings.push(`${file}: \`${name}\` is bound to use:moves but is not a $derived.by or per-instance const — a stored cause re-consumed on a re-mount throws the contract uncaught`);
    }
    return findings;
  }

  test("every use:moves consumer in the cockpit derives or mints its param", () => {
    const findings: string[] = [];
    for (const file of walk("src/cockpit", { exts: [".svelte"] })) {
      findings.push(...storedParamFindings(read(file), relpath(file)));
    }
    expect(findings).toEqual([]);
  });

  test("the scan is DRIVEN — the stored-$state shape it exists to refuse", () => {
    // The defect class itself: a $state param written inside an $effect.
    const planted = [
      "<script>",
      "  let land = $state<MovesParam>(null);",
      "  $effect(() => { land = { motion: 'arrive', cause: becauseChanged('the open conversation', 1, 2) }; });",
      "</script>",
      "<div use:moves={land}></div>",
    ].join("\n");
    expect(storedParamFindings(planted, "Planted.svelte")).toHaveLength(1);
    // And the sanctioned shapes stay silent — the guard judges, it does not
    // forbid the whole vocabulary.
    const derived = [
      "<script>const land = $derived.by((): MovesParam => null);</script>",
      "<div use:moves={land}></div>",
    ].join("\n");
    expect(storedParamFindings(derived, "Derived.svelte")).toEqual([]);
    const minted = [
      "<script>const openedCause = { motion: 'rise', cause: becauseArrived('m', 'a menu opened') } as const;</script>",
      "<div use:moves={openedCause}></div>",
    ].join("\n");
    expect(storedParamFindings(minted, "Minted.svelte")).toEqual([]);
  });
});
