// @vitest-environment node
/**
 * The keyboard grammar (§2.7) — the COMPLETE table is registered on day
 * one, and a pressed chord never silently does nothing: every entry
 * carries the chord label + plain-words meaning the grammar hint needs,
 * and `matchChord` routes deterministically (platform primary modifier,
 * typing-wins rule for bare keys, ⇧-required chords).
 */
import { describe, expect, test } from "vitest";

import {
  GRAMMAR,
  detectMac,
  matchChord,
  type ChordSpec,
} from "../../src/cockpit/shell/keyboard.ts";

const ev = (
  key: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
) => ({
  key,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
});

describe("cockpit keyboard grammar — complete, honest, deterministic", () => {
  test("every §2.7 grammar row is present in the table", () => {
    const targets = new Set(GRAMMAR.map((s) => s.target));
    for (const required of [
      "command", "switch", "desk", "instruments", "settings", "custody",
      "scrub-back", "scrub-forward", "focus-prev", "focus-next",
      "collapse", "expand", "open-scope", "escape",
      "setting", "lens", "arm", "send",
    ]) {
      expect(targets.has(required as ChordSpec["target"]), `missing target: ${required}`).toBe(true);
    }
  });

  test("a RETIRED chord is out of the table, not left hinting", () => {
    // `verb-menu` (`.`) opened the `⋯` beat menu. The user ruled the menu
    // useless — "all options already showing as buttons" — and it was deleted
    // entirely. A chord whose only surface is gone must leave the table with
    // it: left in, `.` would print the grammar's "not built yet" hint, which
    // is a different untruth (it WAS built, and was removed on purpose).
    expect(GRAMMAR.some((s) => (s.target as string) === "verb-menu")).toBe(false);
    // …and `.` therefore matches nothing at all.
    expect(matchChord(ev("."), { isMac: true, inControl: false })).toBeNull();
  });

  test("every entry can build its grammar hint (chord + meaning, plain words)", () => {
    for (const spec of GRAMMAR) {
      expect(spec.chord.length).toBeGreaterThan(0);
      expect(spec.means.length).toBeGreaterThan(3);
    }
  });

  test("⌘ is meta on mac, ctrl elsewhere", () => {
    expect(matchChord(ev("j", { meta: true }), { isMac: true, inControl: false })?.target).toBe("switch");
    expect(matchChord(ev("j", { ctrl: true }), { isMac: false, inControl: false })?.target).toBe("switch");
    // The wrong modifier for the platform does not fire.
    expect(matchChord(ev("j", { ctrl: true }), { isMac: true, inControl: false })).toBeNull();
  });

  test("typing wins: bare grammar keys are ignored in editable targets", () => {
    expect(matchChord(ev("."), { isMac: true, inControl: true })).toBeNull();
    expect(matchChord(ev(","), { isMac: true, inControl: true })).toBeNull();
    expect(matchChord(ev("["), { isMac: true, inControl: true })).toBeNull();
    expect(matchChord(ev("i"), { isMac: true, inControl: true })).toBeNull();
    // …but fire when focus is not in an input.
    expect(matchChord(ev("["), { isMac: true, inControl: false })?.target).toBe("scrub-back");
    expect(matchChord(ev(","), { isMac: true, inControl: false })?.target).toBe("setting");
  });

  test("Esc and ⌘⏎ work everywhere, including inside the composer", () => {
    expect(matchChord(ev("Escape"), { isMac: true, inControl: true })?.target).toBe("escape");
    expect(matchChord(ev("Enter", { meta: true }), { isMac: true, inControl: true })?.target).toBe("send");
    // Plain Enter in an input is typing, not a grammar chord.
    expect(matchChord(ev("Enter"), { isMac: true, inControl: true })).toBeNull();
  });

  test("⌘⇧A requires shift; ⌘A does not arm", () => {
    expect(matchChord(ev("a", { meta: true, shift: true }), { isMac: true, inControl: false })?.target).toBe("arm");
    expect(matchChord(ev("a", { meta: true }), { isMac: true, inControl: false })).toBeNull();
  });

  test("scrub keys accept the ⇧ by-run variant", () => {
    expect(matchChord(ev("[", { shift: true }), { isMac: true, inControl: false })?.target).toBe("scrub-back");
    expect(matchChord(ev("]"), { isMac: true, inControl: false })?.target).toBe("scrub-forward");
  });

  test("alt chords never match (no hidden grammar)", () => {
    expect(matchChord(ev("j", { meta: true, alt: true }), { isMac: true, inControl: false })).toBeNull();
  });

  test("detectMac reads platform or UA", () => {
    expect(detectMac({ platform: "MacIntel" })).toBe(true);
    expect(detectMac({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" })).toBe(true);
    expect(detectMac({ platform: "Win32", userAgent: "Windows NT" })).toBe(false);
  });
});
