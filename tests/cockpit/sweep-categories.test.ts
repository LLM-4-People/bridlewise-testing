// @vitest-environment node
/**
 * Sweep category mapping + §12.3 wheel discipline:
 *   - every member of the closed backend TIMELINE_EVENT_TYPES registry maps
 *     to a sweep category (drift guard — a new backend event type fails
 *     here until the table catches up);
 *   - every EVENT_KINDS member maps;
 *   - the 8 hues stay ≥40° apart on the wheel (the landed tokens values);
 *   - palette resolution prefers tokens.css vars over fallbacks;
 *   - error detection reads the record, never guesses.
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { read, stripCommentsOnly } from "../helpers/source-scan";

import { TIMELINE_EVENT_TYPES } from "../../server/kernel/canonical.ts";
import { EVENT_KINDS } from "../../shared/event-types";
import {
  SWEEP_CATEGORIES,
  SWEEP_CATEGORY_IDS,
  isErrorEvent,
  resolveSweepPalette,
  sweepCategoryFor,
  toSweepEvent,
} from "../../src/cockpit/sweep/categories";

describe("event-type → category (drift-guarded against the closed registry)", () => {
  test("every TIMELINE_EVENT_TYPES member maps to a declared category", () => {
    for (const et of TIMELINE_EVENT_TYPES) {
      const cat = sweepCategoryFor(et);
      expect(SWEEP_CATEGORY_IDS, `event type "${et}"`).toContain(cat);
    }
  });

  test("every TIMELINE_EVENT_TYPES member is an EXPLICIT entry in the category table", () => {
    // The membership arm above cannot distinguish an explicit entry from the
    // "effect" fallback — both answer "effect", so a member dropped from the
    // table stays green while riding the floor the table's own header calls
    // "a floor, not the expected path". This arm reads the table's keys from
    // its owner and demands the registry be covered EXPLICITLY, so a new
    // backend event type forces a deliberate category decision instead of
    // silently borrowing the fallback.
    const src = stripCommentsOnly(read("src/cockpit/sweep/categories.ts"));
    const at = src.indexOf("EVENT_TYPE_CATEGORY");
    expect(at, "the category table moved out of categories.ts — re-point this guard").toBeGreaterThan(-1);
    const open = src.indexOf("{", src.indexOf("=", at));
    const close = src.indexOf("};", open);
    expect(open, "the category table literal was not found").toBeGreaterThan(-1);
    expect(close, "the category table literal was not found").toBeGreaterThan(open);
    const keys = [...src.slice(open, close).matchAll(/^\s*"?([\w-]+)"?\s*:/gm)].map((m) => m[1]!);
    expect(keys.length, "witness: the table actually parsed").toBeGreaterThan(10);
    const missing = TIMELINE_EVENT_TYPES.filter((et) => !keys.includes(et));
    expect(
      missing,
      `ledger event types with NO explicit category entry (they ride the fallback):\n` +
        missing.map((m) => `  ${m}`).join("\n"),
    ).toEqual([]);
  });

  test("every EVENT_KINDS member maps", () => {
    for (const kind of EVENT_KINDS) {
      expect(SWEEP_CATEGORY_IDS).toContain(sweepCategoryFor(kind));
    }
  });

  test("the load-bearing mappings", () => {
    expect(sweepCategoryFor("turn")).toBe("llm");
    expect(sweepCategoryFor("message")).toBe("user");
    expect(sweepCategoryFor("tool")).toBe("tool");
    expect(sweepCategoryFor("file-effect")).toBe("effect");
    expect(sweepCategoryFor("token")).toBe("transport");
    expect(sweepCategoryFor("context")).toBe("context");
    expect(sweepCategoryFor("run")).toBe("lifecycle");
    expect(sweepCategoryFor("hallucination")).toBe("safety");
    // The http + db effect lanes: the router's handler dispatch maps to the
    // ledger's "network" type and the data facade maps to "db" — both are
    // system work, and both must land in a DECLARED category explicitly
    // (the "effect" fallback is a floor, not the expected path).
    expect(sweepCategoryFor("network")).toBe("effect");
    expect(sweepCategoryFor("db")).toBe("effect");
  });
});

describe("§12.3 wheel discipline", () => {
  test("exactly 8 categories, hues ≥40° apart", () => {
    expect(SWEEP_CATEGORIES).toHaveLength(8);
    const hues = SWEEP_CATEGORIES.map((c) => c.hueDeg).sort((a, b) => a - b);
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]! - hues[i - 1]!, `hues ${hues[i - 1]}° / ${hues[i]}°`).toBeGreaterThanOrEqual(40);
    }
    // wrap-around distance too
    expect(hues[0]! + 360 - hues[hues.length - 1]!).toBeGreaterThanOrEqual(40);
  });

  test("every category borrows a landed tokens.css --cat-* entry", () => {
    for (const c of SWEEP_CATEGORIES) {
      expect(c.borrows).toMatch(/^--cat-[a-z]+$/);
      expect(c.cssVar).toBe(`--cat-${c.id}`);
    }
  });

  test("the wheel hues + fallback hexes are pinned projections of tokens.css", () => {
    // The drift this exists for: the category table used to carry a second
    // copy of the wheel in sRGB beside the OKLCH the owner declares, and the
    // two could only drift silently. Now the fallback is a CONVERSION of the
    // declared hue, and this guard re-reads the owner's declaration and
    // asserts the projection still matches — a palette edit in tokens.css
    // reds the suite here until the projection is re-derived.
    const css = readFileSync("src/cockpit/tokens.css", "utf8");
    for (const c of SWEEP_CATEGORIES) {
      const decl = new RegExp(
        `${c.borrows}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`,
      ).exec(css);
      expect(decl, `${c.borrows} must be declared in tokens.css`).not.toBeNull();
      // The hue the module carries must be the hue the owner declares.
      expect(c.hueDeg, `${c.id}'s hue must be ${c.borrows}'s`).toBe(Number(decl![3]));
      // And the wheel's shape (L/C) is the one the conversion assumes.
      expect(Number(decl![1])).toBeCloseTo(0.72, 5);
      expect(Number(decl![2])).toBeCloseTo(0.1, 5);
    }
    // The non-wheel fallbacks: each name's pinned hex must be the dark
    // declaration in tokens.css, byte for byte.
    const palette = resolveSweepPalette(() => "");
    const pins: Readonly<Record<string, string>> = {
      "--alarm": palette.alarm,
      "--beam": palette.beam,
      "--ground-1": palette.ground1,
      "--ground-2": palette.ground2,
      "--line-1": palette.line1,
      "--ink-2": palette.ink2,
      "--ink-3": palette.ink3,
    };
    for (const [name, value] of Object.entries(pins)) {
      const decl = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m").exec(css);
      expect(decl, `${name} must be declared as a dark hex in tokens.css`).not.toBeNull();
      expect(
        value,
        `the stylesheet-less fallback for ${name} must be the owner's declared value`,
      ).toBe(decl![1]);
    }
  });
});

describe("palette resolution", () => {
  test("tokens.css vars win over fallbacks; ledger-named var wins over alias", () => {
    const vars: Record<string, string> = {
      "--cat-turn": "oklch(0.72 0.1 250)",
      "--cat-llm": "papayawhip", // hypothetical future ledger-named entry
      "--alarm": "#e26a5f",
    };
    const p = resolveSweepPalette((n) => vars[n] ?? "");
    expect(p.categories.llm).toBe("papayawhip"); // cssVar beats aliasVar
    expect(p.alarm).toBe("#e26a5f");
  });

  test("the borrowed wheel slot resolves when only the landed table exists", () => {
    const vars: Record<string, string> = { "--cat-turn": "oklch(0.72 0.1 250)" };
    const p = resolveSweepPalette((n) => vars[n] ?? "");
    expect(p.categories.llm).toBe("oklch(0.72 0.1 250)");
  });

  test("stylesheet-less environments fall back to the computed hexes", () => {
    const p = resolveSweepPalette(() => "");
    for (const c of SWEEP_CATEGORIES) {
      expect(p.categories[c.id]).toBe(c.fallbackDark);
    }
  });
});

describe("isErrorEvent / toSweepEvent — record truth only", () => {
  test("failure is the spectrum's predicate: failed outcome OR recorded error code, never the event type", () => {
    // The engine spectrum's error row (the preferred band source and the
    // counting-policy owner) reads `outcome === "failed" || error_code !=
    // null` over the raw columns — the fallback mirrors it verbatim so both
    // binning paths agree on the same ledger rows.
    expect(isErrorEvent({ outcome: "failed" })).toBe(true);
    expect(isErrorEvent({ outcome: "succeeded", errorCode: "tool_failed" })).toBe(true);
    expect(isErrorEvent({ outcome: null, errorCode: "net_error" })).toBe(true);
    expect(isErrorEvent({ outcome: "succeeded" })).toBe(false);
    // The denied inline accounts (a gate-block's `error` event) are NOT
    // incidents on either path — the spectrum never counted them, and the
    // old fallback's event-type/denial/errorCategory clauses were the
    // divergence this alignment closed. The errorCategory case goes through
    // the projection (the full record shape still carries the field for
    // display consumers; the failure verdict simply never reads it).
    expect(isErrorEvent({ outcome: "denied" })).toBe(false);
    expect(isErrorEvent({ outcome: null })).toBe(false);
    expect(toSweepEvent({
      eventId: "cat-only", eventType: "tool",
      wallTime: "2026-07-25T14:02:31.000Z",
      outcome: "succeeded", errorCategory: "net", runId: null,
    })!.isError).toBe(false);
  });

  test("projects a real record, parsing wallTime", () => {
    const e = toSweepEvent({
      eventId: "x",
      eventType: "tool",
      wallTime: "2026-07-25T14:02:31.000Z",
      outcome: "succeeded",
      runId: "r",
      turnId: "t",
      parentEventId: "p",
      description: "d",
    });
    expect(e).not.toBeNull();
    expect(e!.timeMs).toBe(Date.parse("2026-07-25T14:02:31.000Z"));
    expect(e!.category).toBe("tool");
  });

  test("an unparseable wallTime is DROPPED (null), never given a time", () => {
    expect(
      toSweepEvent({
        eventId: "x",
        eventType: "tool",
        wallTime: "not a time",
        outcome: null,
        runId: null,
      }),
    ).toBeNull();
  });
});
