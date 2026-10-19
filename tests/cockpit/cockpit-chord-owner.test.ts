// @vitest-environment node
/**
 * Chord-spelling owner guard (zero-knowledge law: the screen teaches the
 * truth).
 *
 * The mac command glyph teaches a key that DOES NOT EXIST on non-mac
 * machines, where the chords actually fire on Ctrl (matchChord routes on
 * exactly that split). So the glyph may exist in cockpit source in ONE
 * place only: the platform-aware formatter `src/cockpit/shell/chords.ts`.
 * Every on-screen chord mention routes through `chordLabel`, which spells
 * the platform truth: glyph style on mac, "Ctrl+…" everywhere else.
 *
 * The scan is comment-stripped (docs may mention the glyph; template text
 * and string literals may not) and MUTATION-TESTED: synthetic violations
 * must be flagged, comment-only mentions must not. Weakening the scanner
 * turns the self-checks red.
 *
 * Deliberately strict: TRAILING line comments (`code(); // …`) count as
 * code — a glyph mention belongs on its own comment line. This keeps the
 * scanner string-safe (a `//` inside a kept string literal is never
 * treated as a comment). What a comment IS comes from the one lexer: in a
 * `.svelte` file, `//` and `/* *\/` are comments inside `<script>`,
 * `<style>`, a tag or a `{…}` expression — in markup they are rendered
 * text, and the glyph there is flagged.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk, stripBlockAndOwnLineComments, stripHtmlComments } from "../helpers/source-scan.ts";
import { chordLabel } from "../../src/cockpit/shell/chords.ts";
import { GRAMMAR, matchChord } from "../../src/cockpit/shell/keyboard.ts";

const COCKPIT_ROOT = "src/cockpit";
/** The ONE file allowed to contain the glyph — the formatter owner. */
const OWNER = "src/cockpit/shell/chords.ts";
const MAC_GLYPH = "⌘"; // ⌘

/**
 * Scan ONE cockpit source for the mac command glyph outside comments.
 * String literals and template text are NOT stripped — an on-screen "⌘N"
 * lives in exactly those places. Returns violations (empty = clean).
 */
export function scanForMacGlyph(file: string, src: string): string[] {
  if (file === OWNER) return [];
  // The mode is the FILE's: markup comments and the glyph views differ
  // between a `.svelte` template and a `.ts` module.
  const stripped = stripBlockAndOwnLineComments(stripHtmlComments(src, file), file);
  const out: string[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.includes(MAC_GLYPH)) {
      out.push(
        `${file}:${i + 1}: literal mac command glyph outside ${OWNER} — ` +
          `route the chord through chordLabel() so non-mac screens teach Ctrl`,
      );
    }
  }
  return out;
}

describe("chordLabel — the taught key IS the key that fires", () => {
  test("mac spells glyph style, other platforms spell Ctrl", () => {
    expect(chordLabel({ key: "j", primary: true }, true)).toBe("⌘J");
    expect(chordLabel({ key: "j", primary: true }, false)).toBe("Ctrl+J");
    expect(chordLabel({ key: "n", primary: true, shift: true }, true)).toBe("⌘⇧N");
    expect(chordLabel({ key: "n", primary: true, shift: true }, false)).toBe("Ctrl+Shift+N");
    expect(chordLabel({ key: "Enter", primary: true }, true)).toBe("⌘⏎");
    expect(chordLabel({ key: "Enter", primary: true }, false)).toBe("Ctrl+Enter");
    expect(chordLabel({ key: "Enter", shift: true }, false)).toBe("Shift+Enter");
    expect(chordLabel({ key: ".", primary: true }, false)).toBe("Ctrl+.");
    expect(chordLabel({ key: "Escape" }, false)).toBe("Esc");
    expect(chordLabel({ key: "ArrowUp" }, true)).toBe("↑");
  });

  test("every GRAMMAR label agrees with what matchChord fires on, per platform", () => {
    for (const spec of GRAMMAR.filter((s) => s.primary)) {
      // Non-mac: the chord fires on Ctrl…
      expect(
        matchChord(
          { key: spec.key, metaKey: false, ctrlKey: true, shiftKey: spec.shift === true, altKey: false },
          { isMac: false, inControl: false },
        )?.target,
      ).toBe(spec.target);
      // …so the non-mac label must SAY Ctrl and never show the mac glyph.
      const label = chordLabel({ key: spec.key, primary: true, shift: spec.shift }, false);
      expect(label.startsWith("Ctrl+")).toBe(true);
      expect(label).not.toContain(MAC_GLYPH);
      // The mac label shows the glyph the mac keyboard actually carries.
      expect(chordLabel({ key: spec.key, primary: true, shift: spec.shift }, true)).toContain(MAC_GLYPH);
    }
  });

  test("the registered table itself is spelled for THIS platform (node = non-mac)", () => {
    const switchRow = GRAMMAR.find((s) => s.target === "switch")!;
    expect(switchRow.chord).toBe("Ctrl+J");
    for (const spec of GRAMMAR) expect(spec.chord).not.toContain(MAC_GLYPH);
  });
});

describe("cockpit-chord-owner — the glyph lives in ONE file", () => {
  const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] });

  test("the cockpit tree exists and the owner is in it", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.map(relpath)).toContain(OWNER);
    expect(read(OWNER)).toContain(MAC_GLYPH); // the owner really owns it
  });

  test("no cockpit source outside the owner carries the glyph (comment-stripped)", () => {
    const all: string[] = [];
    for (const f of files) all.push(...scanForMacGlyph(relpath(f), read(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────
  const AT = "src/cockpit/rooms/Example.svelte"; // synthetic location

  test("mutation: the glyph in a string literal is flagged", () => {
    expect(scanForMacGlyph(AT, `const s = "${MAC_GLYPH}N new conversation";`)).toHaveLength(1);
  });

  test("mutation: the glyph in Svelte template text is flagged", () => {
    expect(scanForMacGlyph(AT, `<span class="hints">${MAC_GLYPH}N new</span>`)).toHaveLength(1);
  });

  test("mutation: a line comment mention is NOT flagged (docs may teach mac)", () => {
    expect(scanForMacGlyph(AT, `<script>\n  // on a mac this renders ${MAC_GLYPH}N\n</script>`)).toEqual([]);
  });

  test("mutation: a block comment mention is NOT flagged", () => {
    expect(scanForMacGlyph(AT, `<script>\n  /* ${MAC_GLYPH}J summons the Switch */\n</script>`)).toEqual([]);
  });

  test("mutation: `//` in MARKUP is rendered text, not a comment — flagged, on its own line", () => {
    expect(scanForMacGlyph(AT, `<script>\n  /* one\n     two */\n</script>\n<p>\n  // on a mac press ${MAC_GLYPH}N\n</p>`)).toEqual([
      `${AT}:6: literal mac command glyph outside ${OWNER} — route the chord through chordLabel() so non-mac screens teach Ctrl`,
    ]);
  });

  test("mutation: an HTML template comment mention is NOT flagged", () => {
    expect(scanForMacGlyph(AT, `<!-- the ${MAC_GLYPH}N absence row -->`)).toEqual([]);
  });

  test("mutation: the owner file itself is exempt", () => {
    expect(scanForMacGlyph(OWNER, `const PRIMARY_GLYPH = "${MAC_GLYPH}";`)).toEqual([]);
  });

  test("mutation: a clean source is not flagged (no false positives)", () => {
    expect(
      scanForMacGlyph(AT, `const label = chordLabel({ key: "n", primary: true });`),
    ).toEqual([]);
  });
});
