// @vitest-environment node
/**
 * THE KEY-ROUTING CONTRACT (src/cockpit/shell/routing.ts) — the shell's
 * answer to "who gets this chord, and who gets Esc".
 *
 * ── The two defects this replaces ──
 *
 * 1. `claimKey` was a `Map.set`, so MOUNT ORDER decided who owned a chord.
 *    The SWEEP mounts after the FLOW, so the flow's `escape` claim never
 *    fired; three surfaces (BeatMenu, LensCallout, the shared Popover) each
 *    grew a capture-phase Esc listener to route around the shell's own
 *    grammar table, and the table stopped being the authority it claimed.
 * 2. The escape order was `room → scope → claimed`, with room-internal claims
 *    consulted LAST — so Esc with a difference open inside Custody closed the
 *    whole room instead of the difference.
 *
 * ── What is asserted here ──
 *
 *   A. CLAIMS ARE A STACK, and release pops the entry it was handed back
 *      for — not "whatever is on top".
 *   B. A SECOND PERMANENT CLAIMANT IS REFUSED, loudly, and the incumbent
 *      keeps the chord. (MUTATION: last-claim-wins would let the newcomer
 *      answer the key; that is what these assertions fail on.)
 *   C. `escape` CANNOT BE CLAIMED at all — Esc has one router.
 *   D. DISMISSAL IS INNERMOST-FIRST, one level per press, and a layer is
 *      scoped to the room it was pushed in (kept-alive rooms).
 *   E. RELEASE IS THE WHOLE LIFECYCLE — an unmount that does not release
 *      leaves Esc landing on a surface nobody can see, so the release is
 *      asserted to actually remove the layer and the claim.
 *   F. STATIC — no cockpit surface may grow a new capture-phase keydown
 *      listener; the two that remain are enumerated with their reasons.
 */
import { describe, expect, test } from "vitest";

import {
  ESCAPE_IS_SHELL_OWNED,
  ShellRoutingConflict,
  createKeyRouting,
  permanentConflict,
} from "../../src/cockpit/shell/routing.ts";
import { read, relpath, stripCommentsOnlyFor, walk } from "../helpers/source-scan.ts";

/** A router that reports refusals instead of throwing, so a test can read
 *  the words a shipped build would put on the grammar hint. */
function quiet() {
  const refusals: string[] = [];
  const routing = createKeyRouting({
    strict: false,
    onRefused: (m) => refusals.push(m),
  });
  return { routing, refusals };
}

/** A router in DEV strictness — a refused claim throws at the claim site. */
function strict() {
  return createKeyRouting({
    strict: true,
    onRefused: () => {
      throw new Error("unreachable — strict routers throw");
    },
  });
}

/** A handler that records that it, and not somebody else, answered. */
function spy(name: string, log: string[]) {
  return () => log.push(name);
}

// ── A. claims are a stack ──────────────────────────────────────────────────

describe("A. a chord claim is a stack entry, not an assignment", () => {
  test("with nothing claimed the target has no handler (the grammar hint's case)", () => {
    const { routing } = quiet();
    expect(routing.handlerFor("focus-next")).toBeUndefined();
  });

  test("the top of the stack answers the chord", () => {
    const log: string[] = [];
    const { routing } = quiet();
    routing.claim("focus-next", spy("flow", log), { owner: "the FLOW" });
    routing.claim("focus-next", spy("menu", log), {
      transient: true,
      owner: "an open menu",
    });
    routing.handlerFor("focus-next")!({ shift: false });
    expect(log).toEqual(["menu"]);
  });

  test("releasing the transient claim gives the chord BACK to the permanent owner", () => {
    const log: string[] = [];
    const { routing } = quiet();
    routing.claim("focus-next", spy("flow", log), { owner: "the FLOW" });
    const release = routing.claim("focus-next", spy("menu", log), {
      transient: true,
      owner: "an open menu",
    });
    release();
    routing.handlerFor("focus-next")!({ shift: false });
    expect(log).toEqual(["flow"]);
    expect(routing.claimants("focus-next")).toEqual(["the FLOW"]);
  });

  test("a release pops ITS OWN entry, whatever landed on top since", () => {
    const log: string[] = [];
    const { routing } = quiet();
    routing.claim("lens", spy("base", log), { owner: "base" });
    const releaseMiddle = routing.claim("lens", spy("middle", log), {
      transient: true,
      owner: "middle",
    });
    routing.claim("lens", spy("top", log), { transient: true, owner: "top" });
    // Out-of-order teardown (a nested surface outliving its parent's own
    // close) must not strand the chord on a handler that has gone away.
    releaseMiddle();
    expect(routing.claimants("lens")).toEqual(["base", "top"]);
    routing.handlerFor("lens")!({ shift: false });
    expect(log).toEqual(["top"]);
  });

  test("a release is idempotent — calling it twice never eats a stranger's claim", () => {
    const { routing } = quiet();
    const release = routing.claim("arm", () => {}, { owner: "the SWEEP" });
    release();
    release();
    routing.claim("arm", () => {}, { owner: "a later SWEEP" });
    expect(routing.claimants("arm")).toEqual(["a later SWEEP"]);
  });
});

// ── B. a second permanent claimant is a defect ─────────────────────────────

describe("B. a conflicting permanent claim is REFUSED, never a silent steal", () => {
  test("the incumbent keeps the chord and the newcomer is told why", () => {
    const log: string[] = [];
    const { routing, refusals } = quiet();
    routing.claim("scrub-back", spy("sweep", log), { owner: "the SWEEP" });
    routing.claim("scrub-back", spy("impostor", log), { owner: "a second band" });

    // MUTATION: this is the exact assertion last-claim-wins fails. With the
    // old `claims.set(target, handler)` the impostor answers here.
    routing.handlerFor("scrub-back")!({ shift: false });
    expect(log).toEqual(["sweep"]);
    expect(routing.claimants("scrub-back")).toEqual(["the SWEEP"]);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toBe(
      permanentConflict("scrub-back", "the SWEEP", "a second band"),
    );
    // The words name BOTH sides and the way out — a message that only said
    // "conflict" would leave the next author guessing which two.
    expect(refusals[0]).toContain("the SWEEP");
    expect(refusals[0]).toContain("a second band");
    expect(refusals[0]).toContain("transient: true");
  });

  test("the refused claim's release is inert — it cannot pop the incumbent", () => {
    const log: string[] = [];
    const { routing } = quiet();
    routing.claim("lens", spy("lens", log), { owner: "the LENS callout" });
    const bogus = routing.claim("lens", spy("impostor", log), { owner: "an impostor" });
    bogus();
    routing.handlerFor("lens")!({ shift: false });
    expect(log).toEqual(["lens"]);
  });

  test("in DEV it THROWS at the claim site, typed — the stack names the taker", () => {
    const routing = strict();
    routing.claim("expand", () => {}, { owner: "the FLOW" });
    expect(() => routing.claim("expand", () => {}, { owner: "a second flow" }))
      .toThrow(ShellRoutingConflict);
  });

  test("a TRANSIENT claim over a permanent one is legitimate, not a conflict", () => {
    const routing = strict();
    routing.claim("collapse", () => {}, { owner: "the FLOW" });
    expect(() =>
      routing.claim("collapse", () => {}, { transient: true, owner: "a sheet" }),
    ).not.toThrow();
  });

  test("two TRANSIENT claims stack — nesting is the normal case, not an error", () => {
    const routing = strict();
    expect(() => {
      routing.claim("collapse", () => {}, { transient: true, owner: "outer" });
      routing.claim("collapse", () => {}, { transient: true, owner: "inner" });
    }).not.toThrow();
    expect(routing.claimants("collapse")).toEqual(["outer", "inner"]);
  });

  test("re-claiming after a clean release is not a conflict (remount is normal)", () => {
    const routing = strict();
    const release = routing.claim("open-scope", () => {}, { owner: "the FLOW" });
    release();
    expect(() => routing.claim("open-scope", () => {}, { owner: "the FLOW" })).not.toThrow();
  });
});

// ── C. escape has ONE router ───────────────────────────────────────────────

describe("C. `escape` is the shell's and cannot be claimed", () => {
  test("claiming it is refused, with the seam that replaces it named", () => {
    const { routing, refusals } = quiet();
    routing.claim("escape", () => {}, { owner: "the SWEEP" });
    expect(routing.handlerFor("escape")).toBeUndefined();
    expect(refusals).toEqual([ESCAPE_IS_SHELL_OWNED]);
    expect(refusals[0]).toContain("pushDismiss");
  });

  test("in DEV it throws — the collision cannot be shipped unnoticed", () => {
    expect(() => strict().claim("escape", () => {})).toThrow(ShellRoutingConflict);
  });

  test("no cockpit surface claims `escape` any more", () => {
    const hits: string[] = [];
    for (const file of walk("src/cockpit", { exts: [".svelte", ".ts"] })) {
      // The file's own view with its comments out, strings intact — a claim
      // discussed in a comment is not a claim, and a `//` inside a string
      // literal (a URL) must not open a phantom comment.
      const src = stripCommentsOnlyFor(read(file), file);
      if (/claimKey\(\s*"escape"/.test(src)) hits.push(relpath(file));
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

// ── D. dismissal is innermost-first ────────────────────────────────────────

describe("D. Esc dismisses the innermost open surface, one level per press", () => {
  test("the most recently pushed layer wins", () => {
    const { routing } = quiet();
    routing.pushDismiss({ label: "the scope", dismiss: () => {} }, null);
    routing.pushDismiss({ label: "the beat menu", dismiss: () => {} }, null);
    expect(routing.topDismissal(null)?.label).toBe("the beat menu");
  });

  // MUTATION: an Esc that skipped an inner surface — the old
  // `room → scope → claimed` order — walks these three the wrong way round.
  test("a popover inside a scope inside a room unwinds in that order", () => {
    const closed: string[] = [];
    const { routing } = quiet();
    // The room is the shell's own step; the scope and the popover are layers
    // pushed inside it, in the order they were opened.
    const releaseScope = routing.pushDismiss(
      { label: "the scope", dismiss: () => closed.push("scope") },
      "instruments",
    );
    const releasePopover = routing.pushDismiss(
      { label: "the popover", dismiss: () => closed.push("popover") },
      "instruments",
    );

    routing.topDismissal("instruments")!.dismiss();
    releasePopover();
    routing.topDismissal("instruments")!.dismiss();
    releaseScope();
    // Only now is there nothing left inside the room, so the next press is
    // the room's — which the shell, not this module, performs.
    expect(routing.topDismissal("instruments")).toBeNull();
    expect(closed).toEqual(["popover", "scope"]);
  });

  test("a layer pushed inside a room is silent while another room is on screen", () => {
    const { routing } = quiet();
    routing.pushDismiss({ label: "the difference", dismiss: () => {} }, "custody");
    // Custody hidden (the shell shows the flow, or another room): the
    // difference is still open, but it is not what Esc means here.
    expect(routing.topDismissal(null)).toBeNull();
    expect(routing.topDismissal("switch")).toBeNull();
    // …and it speaks again the moment Custody is back, with no
    // re-registration — which is what keeps kept-alive rooms honest.
    expect(routing.topDismissal("custody")?.label).toBe("the difference");
  });

  test("a FLOOR layer is context-free and never pre-empts a nested surface", () => {
    const { routing } = quiet();
    routing.pushDismiss({ label: "the past view", floor: true, dismiss: () => {} }, null);
    routing.pushDismiss({ label: "the beat menu", dismiss: () => {} }, null);
    // The menu is what Esc closes first…
    expect(routing.topDismissal(null)?.label).toBe("the beat menu");
    // …and the planted head is not offered as a nested layer in ANY room.
    expect(routing.topDismissal("custody")).toBeNull();
    expect(routing.floorDismissal()?.label).toBe("the past view");
  });

  test("with nothing open there is nothing to dismiss (the honest-hint case)", () => {
    const { routing } = quiet();
    expect(routing.topDismissal(null)).toBeNull();
    expect(routing.floorDismissal()).toBeNull();
  });
});

// ── E. release is the whole lifecycle ──────────────────────────────────────

describe("E. an unmount that does not release is the defect this catches", () => {
  test("releasing removes the layer — Esc stops landing on a closed surface", () => {
    const { routing } = quiet();
    const release = routing.pushDismiss({ label: "the beat menu", dismiss: () => {} }, null);
    expect(routing.activeLayers(null).map((l) => l.label)).toEqual(["the beat menu"]);
    release();
    expect(routing.activeLayers(null)).toEqual([]);
    expect(routing.topDismissal(null)).toBeNull();
  });

  test("releasing a middle layer leaves the ones around it alone", () => {
    const { routing } = quiet();
    routing.pushDismiss({ label: "outer", dismiss: () => {} }, null);
    const middle = routing.pushDismiss({ label: "middle", dismiss: () => {} }, null);
    routing.pushDismiss({ label: "inner", dismiss: () => {} }, null);
    middle();
    expect(routing.activeLayers(null).map((l) => l.label)).toEqual(["outer", "inner"]);
  });

  test("a release is idempotent — a double teardown cannot pop a stranger", () => {
    const { routing } = quiet();
    const release = routing.pushDismiss({ label: "gone", dismiss: () => {} }, null);
    release();
    routing.pushDismiss({ label: "later", dismiss: () => {} }, null);
    release();
    expect(routing.activeLayers(null).map((l) => l.label)).toEqual(["later"]);
  });
});

// ── F. static: no surface re-grows a capture-phase Esc ─────────────────────

/**
 * The capture-phase `keydown` listeners that MAY exist in the cockpit, each
 * with the reason it is not a routing workaround. RATCHET: this list does not
 * grow. A new entry means someone is taking a key ahead of the shell again,
 * which is exactly the defect the dismissal ladder removed.
 */
const CAPTURE_KEYDOWN_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "src/cockpit/shell/Popover.svelte",
    "a TAB focus trap — it must win against whatever is focused inside the " +
      "surface. It does not touch Esc under a shell; dismissal is a layer.",
  ],
  [
    "src/cockpit/rooms/SwitchRoom.svelte",
    "the Switch's OWN grammar (its toggle chord, new-conversation, grid " +
      "navigation) plus Esc-to-clear-the-filter, which it consumes only when " +
      "it has something to clear and otherwise passes to the shell.",
  ],
]);

describe("F. the shell is the only router of Esc", () => {
  const files = walk("src/cockpit", { exts: [".svelte", ".ts"] });

  test("the scan has something to look at", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("every capture-phase keydown listener is enumerated with its reason", () => {
    const found: string[] = [];
    for (const file of files) {
      const src = read(file);
      if (/addEventListener\(\s*"keydown"[^)]*,\s*true\s*\)/.test(src)) {
        found.push(relpath(file));
      }
    }
    const unlisted = found.filter((f) => !CAPTURE_KEYDOWN_ALLOWED.has(f));
    expect(
      unlisted,
      `a capture-phase keydown listener takes the key ahead of the shell:\n${unlisted.join("\n")}`,
    ).toEqual([]);
    // RATCHET: an entry whose listener is gone must be deleted from the list.
    for (const listed of CAPTURE_KEYDOWN_ALLOWED.keys()) {
      expect(found, `${listed} no longer needs its exception — delete it`).toContain(listed);
    }
  });

  test("mutation — the scanner sees a listener that is reintroduced", () => {
    const re = /addEventListener\(\s*"keydown"[^)]*,\s*true\s*\)/;
    expect(re.test(`window.addEventListener("keydown", onKey, true);`)).toBe(true);
    expect(re.test(`window.addEventListener("keydown", onKey);`)).toBe(false);
  });

  test("the three surfaces that hand-rolled Esc no longer listen for it at all", () => {
    // One of the three (flow/BeatMenu.svelte, the `⋯` beat menu) no longer
    // exists: the user ruled it useless — "all options already showing as
    // buttons" — and it was deleted whole. A surface that is gone cannot
    // listen for anything, and reading a deleted file to prove it does not
    // would be a guard asserting against nothing.
    for (const f of [
      "src/cockpit/lens/LensCallout.svelte",
    ]) {
      const src = read(f);
      expect(/addEventListener\(\s*"keydown"/.test(src), `${f} still listens for keydown`).toBe(false);
    }
    // The Popover keeps ONE listener and it is the Tab trap: its capture
    // handler must not act on Escape any more.
    const popover = read("src/cockpit/shell/Popover.svelte");
    const trap = /const onKey = \(\w+: KeyboardEvent\): void => \{([\s\S]*?)\n    \};/.exec(popover);
    expect(trap, "the Popover's capture handler moved — re-read this guard").not.toBeNull();
    expect(trap![1]).not.toContain("Escape");
  });
});
