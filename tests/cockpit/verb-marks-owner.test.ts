// @vitest-environment node
/**
 * OK / CANCEL / ADD / REMOVE are one table (`VERB_MARK`) and markers on
 * `.verb`. A button in those four roles that writes the character or the
 * word by hand is the defect this round closed.
 */
import { describe, expect, test } from "vitest";
import { read, sourceFiles, relpath } from "../helpers/source-scan.ts";
import { VERB_MARK, VERB_MARK_IDS, VERB_MARK_WORD } from "../../src/cockpit/shell/verb-marks.ts";

const TOKENS = "src/cockpit/tokens.css";
const OWNER = "src/cockpit/shell/verb-marks.ts";

function svelteUnderCockpit(): string[] {
  return sourceFiles("src/cockpit")
    .map(relpath)
    .filter((f) => f.endsWith(".svelte"));
}

describe("control marks have one owner", () => {
  test("the table names every control role and its accessible words", () => {
    expect([...VERB_MARK_IDS].sort()).toEqual([
      "add",
      "cancel",
      "close",
      "copy",
      "edit",
      "more",
      "ok",
      "recycle",
      "remove",
      "restore",
    ]);
    expect(VERB_MARK.ok).toBe("✓");
    expect(VERB_MARK.cancel).toBe("✕");
    expect(VERB_MARK.add).toBe("+");
    expect(VERB_MARK.remove).toBe("−");
    expect(VERB_MARK.recycle).toBe("♲");
    expect(VERB_MARK.restore).toBe("↺");
    expect(VERB_MARK_WORD.recycle).toBe("Move to bin");
    expect(VERB_MARK_WORD.more).toBe("Actions");
  });

  test("the token owner names the four markers", () => {
    const css = read(TOKENS);
    for (const id of VERB_MARK_IDS) {
      expect(css, id).toMatch(new RegExp(`\\.cockpit\\s+\\.verb\\.${id}`));
    }
  });

  test("recycle and restore wear the bin / unarchive masks, not the fallback character", () => {
    const css = read(TOKENS);
    expect(css).toMatch(/--mark-recycle\s*:/);
    expect(css).toMatch(/--mark-restore\s*:/);
    expect(css).toMatch(/\.verb\.recycle:not\(\[data-state="armed"\]\)::before/);
    expect(css).toMatch(/\.verb\.restore::before/);
    expect(css).toMatch(/mask-image:\s*var\(--mark-restore\)/);
    // Hover is more specific than `[data-state="armed"]`. Without this
    // twin the confirmation's alarm ink vanishes under the pointer.
    expect(css).toMatch(/\.verb\[data-state="armed"\]:hover:not\(:disabled\)/);
  });

  test("no cockpit svelte restates cancel as a word-label on a button", () => {
    const offenders: string[] = [];
    for (const f of svelteUnderCockpit()) {
      if (f === OWNER) continue;
      const src = read(f);
      if (/>\s*cancel\s*</.test(src)) offenders.push(f);
    }
    expect(offenders, "cancel buttons must interpolate VERB_MARK.cancel").toEqual([]);
  });

  test("ok/cancel/add/remove consumers import the table", () => {
    const consumers = [
      "src/cockpit/rooms/FolderPicker.svelte",
      "src/cockpit/rooms/SwitchRoom.svelte",
      "src/cockpit/rooms/Reel.svelte",
      "src/cockpit/rooms/Parcel.svelte",
      "src/cockpit/rooms/InstrumentsRoom.svelte",
      "src/cockpit/settings/ProvidersSection.svelte",
      "src/cockpit/editor/DeleteConfirm.svelte",
      "src/cockpit/shell/room-chords.ts",
    ];
    for (const f of consumers) {
      expect(read(f), f).toContain("VERB_MARK");
    }
  });

  test("mutation: a hand-written cancel label is caught", () => {
    expect(/>\s*cancel\s*</.test(`<button>cancel</button>`)).toBe(true);
    expect(/>\s*cancel\s*</.test(`<button>{VERB_MARK.cancel}</button>`)).toBe(false);
  });

  test("control marks and beat-state glyphs do not import each other", () => {
    expect(read(OWNER)).not.toMatch(/from\s+["'][^"']*beat-state/);
    expect(read("src/cockpit/flow/beat-state.ts")).not.toMatch(/from\s+["'][^"']*verb-marks/);
  });
});
