// @vitest-environment node
/**
 * THE 1100px FOLD HAS ONE JS OWNER. tokens.css must restate it (a media
 * query cannot read JS); rooms must not.
 */
import { describe, expect, test } from "vitest";

import { NARROW_FOLD_PX } from "../../src/cockpit/shell/config.ts";
import { SETTINGS_SPLIT_MIN_PX } from "../../src/cockpit/settings/settings-config.ts";
import { CUSTODY_SPLIT_MIN_PX } from "../../src/cockpit/rooms/custody-config.ts";
import { EDITOR_SPLIT_MIN_PX } from "../../src/cockpit/editor/editor-config.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";

const TOKENS = "src/cockpit/tokens.css";

describe("the shell fold is one number", () => {
  test("JS owner equals the CSS media-query twin", () => {
    const css = read(TOKENS);
    const folds = [...css.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(folds, "tokens.css must declare the 1100 fold").toContain(NARROW_FOLD_PX);
    expect(NARROW_FOLD_PX).toBe(1100);
  });

  test("settings, custody and editor consume the owner, they do not restate it", () => {
    // The settings split is NOT the fold: it must start where the split row
    // grid actually fits beside the rail (measured ≈1330px of tracks + rail
    // + gutters), never below the fold itself. An equality pin here fired
    // the split through a band where every track sank to its floor while
    // nowrap cells kept full width — text painted over the next column.
    expect(SETTINGS_SPLIT_MIN_PX).toBeGreaterThanOrEqual(NARROW_FOLD_PX);
    expect(CUSTODY_SPLIT_MIN_PX).toBe(NARROW_FOLD_PX);
    expect(EDITOR_SPLIT_MIN_PX).toBe(NARROW_FOLD_PX);
    // EditorRoom.svelte carries a NUL draft-key delimiter, so path-scoped
    // grep treats it as binary and reports the import missing. Bytes-read.
    const editor = read("src/cockpit/rooms/EditorRoom.svelte");
    expect(editor).toMatch(/import\s*\{\s*EDITOR_SPLIT_MIN_PX\s*\}/);
    expect(editor).toMatch(/roomW\s*>=\s*EDITOR_SPLIT_MIN_PX/);
  });

  test("no cockpit config assigns 1100 except the shell owner", () => {
    const findings: string[] = [];
    for (const f of walk("src/cockpit", { exts: [".ts"] })) {
      const path = relpath(f);
      if (path === "src/cockpit/shell/config.ts") continue;
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      if (/export const \w+\s*=\s*1100\b/.test(src)) {
        findings.push(`${path} restates 1100`);
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("mutation: a restated 1100 in a config is caught", () => {
    expect(/export const \w+\s*=\s*1100\b/.test("export const SETTINGS_SPLIT_MIN_PX = 1100;")).toBe(
      true,
    );
    expect(/export const \w+\s*=\s*1100\b/.test("export { NARROW_FOLD_PX as SETTINGS_SPLIT_MIN_PX }")).toBe(
      false,
    );
  });
});

// ── THE FOLD SET: what the HORIZON rails hold, and what the side rail owes ──
//
// The run and arm columns open from the flow region's right edge
// (shell/SideRail.svelte), and that edge does NOT fold — below the 1100
// breakpoint it is the replacement mouse path for them, so a run/arm grip
// left in either HORIZON rail would be a SECOND mouse path for one chord,
// and a side rail that folded below the breakpoint would leave both chords
// with no mouse path at all. The grip sets are read out of the sources,
// never restated here.

describe("the run and arm words live on the unfoldable side rail", () => {
  const HORIZON = "src/cockpit/shell/Horizon.svelte";
  const SIDE_RAIL = "src/cockpit/shell/SideRail.svelte";

  /** Every grammar target a source's ChordGrip calls name. ChordGrip
   * renders the `data-chord-target` the guard reads, so this is the same
   * population the mouse-path owner walks. The window is BOUNDED at the
   * tag's own end (`[^>]`): each match stays inside the one grip's open
   * tag and cannot wander across grips. */
  function gripTargets(path: string): string[] {
    const src = read(path);
    const out: string[] = [];
    for (const m of src.matchAll(/<ChordGrip\b[^>]*?\btarget\s*=\s*"([a-z-]+)"/g)) {
      out.push(m[1]!);
    }
    return [...new Set(out)];
  }

  test("neither HORIZON rail names the run or arm chords (the words moved to the edge)", () => {
    const rails = gripTargets(HORIZON);
    expect(rails).not.toContain("run");
    expect(rails).not.toContain("arm");
    // The rooms are still there — the removal took the two columns only.
    for (const room of ["chat", "switch", "instruments", "custody", "editor", "settings"]) {
      expect(rails, `${room} must keep its HORIZON grip`).toContain(room);
    }
  });

  test("one inspector entry keeps both run and watch chord paths", () => {
    const src = read(SIDE_RAIL);
    expect(src).toMatch(/data-chord-target="run"/);
    expect(src).toContain('chordFor("arm")');
    const host = read("src/cockpit/shell/RightMenuHost.svelte");
    expect(host).toMatch(/data-chord-target=\{item\.chord\}/);
    expect(host).toContain("INSPECTOR_GROUPS");
    expect(read("src/cockpit/shell/right-menu.ts")).toMatch(/arm:\s*\{[^}]*chord:\s*"arm"/);
    expect(src).not.toMatch(/data-chord-target="(chat|switch|instruments|custody|editor|settings|lens)"/);
  });

  test("the side rail has no fold twin (it is the replacement mouse path below the fold)", () => {
    // tokens.css owns every fold; the side rail must appear in NO
    // width-driven block, because below 1100px the HORIZON rail folds and
    // the side rail is the only remaining path to the two columns.
    const tokens = read(TOKENS);
    for (const m of tokens.matchAll(/@media[^{]*\{([\s\S]*?)\n\s*\}/g)) {
      expect(
        m[1]!,
        "the width-driven blocks must not touch the side rail",
      ).not.toContain("side-rail");
    }
    // …and the rail's own component owns no media query either.
    expect(read(SIDE_RAIL)).not.toMatch(/@media/);
  });
});
