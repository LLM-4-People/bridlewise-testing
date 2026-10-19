// @vitest-environment node
/**
 * CLOSE AND SEND ARE MARKERS ON `.verb`, not sibling recipes.
 *
 * Four hosts restated the verb spine as `.close { appearance, min-height,
 * hairline, hover }`. Desk restated it as `.send`. The owner now names
 * `.verb.close` / the send chip is `class="verb send"`. A restated spine
 * in those files is the defect this round closed.
 */
import { describe, expect, test } from "vitest";

import { read } from "../helpers/source-scan.ts";

const TOKENS = "src/cockpit/tokens.css";
const CLOSES = [
  "src/cockpit/shell/RoomHost.svelte",
  "src/cockpit/shell/ScopeHost.svelte",
  "src/cockpit/shell/Popover.svelte",
  "src/cockpit/shell/RightMenuHost.svelte",
] as const;

function rawStyleBlock(src: string): string {
  const i = src.indexOf("<style");
  if (i < 0) return "";
  const j = src.indexOf("</style>", i);
  return src.slice(i, j < 0 ? undefined : j);
}

describe("close and send consume the verb recipe", () => {
  test("the token owner names the close marker", () => {
    const css = read(TOKENS);
    expect(css).toMatch(/\.cockpit\s+\.verb\.close\s*\{/);
  });

  test("the four close hosts mark verb close and do not restate the spine", () => {
    for (const path of CLOSES) {
      const src = read(path);
      expect(src, path).toMatch(/class="verb close/);
      const style = rawStyleBlock(src);
      expect(style, path).not.toMatch(/\.close\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
      expect(style, path).not.toMatch(/\.close:hover/);
    }
  });

  test("the desk send chip is a verb; Desk does not restate the spine", () => {
    const src = read("src/cockpit/shell/Desk.svelte");
    expect(src).toMatch(/class="verb send primary"/);
    const style = rawStyleBlock(src);
    expect(style).not.toMatch(/\.send\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
    expect(style).not.toMatch(/\.send:hover/);
  });

  test("mutation: a restated close spine is caught", () => {
    expect(
      /\.close\s*\{[^}]*min-height:\s*var\(--hit-min\)/.test(
        "<style>.close { min-height: var(--hit-min); }</style>",
      ),
    ).toBe(true);
    expect(
      /\.close\s*\{[^}]*min-height:\s*var\(--hit-min\)/.test(
        "<style>.body { display: flex; }</style>",
      ),
    ).toBe(false);
  });

  test("the settings index marks the owned setting-row", () => {
    const src = read("src/cockpit/rooms/SettingsRoom.svelte");
    expect(src).toMatch(/class="setting-row"/);
    expect(rawStyleBlock(src)).not.toMatch(/\.row\s*\{[^}]*border-bottom/);
  });

  test("the token owner names the menu marker", () => {
    expect(read(TOKENS)).toMatch(/\.cockpit\s+\.verb\.menu\s*\{/);
  });

  test("ContextMenu marks verb menu and does not restate the spine", () => {
    const src = read("src/cockpit/shell/ContextMenu.svelte");
    expect(src).toMatch(/class="verb menu"/);
    expect(rawStyleBlock(src)).not.toMatch(/\.menu-verb\s*\{/);
  });

  test("Flow history-head verbs consume .verb, not a local .head-verb spine", () => {
    const src = read("src/cockpit/flow/Flow.svelte");
    expect(src).toMatch(/class="verb"/);
    expect(src).not.toMatch(/class="head-verb"/);
    expect(rawStyleBlock(src)).not.toMatch(/\.head-verb\s*\{[^}]*appearance:\s*none/);
  });

  test("the arm menu body's arm/clear/capture consume .verb; layout only stays local", () => {
    // The verbs live in the BODY (sweep/ArmMenuBody.svelte — one body, two
    // hosts); ArmMenu.svelte is only the standalone Popover wrapper. The
    // recipe guard reads the file that renders the controls.
    const src = read("src/cockpit/sweep/ArmMenuBody.svelte");
    for (const action of ["set", "capture", "clear"]) {
      const controls = [...src.matchAll(/<button\b[^>]*>/g)].map(match => match[0]).filter(tag => tag.includes(`data-action="arm.flags/${action}"`));
      expect(controls.length, action).toBeGreaterThan(0);
      expect(controls.every(tag => /class="verb(?:\s|"|$)/.test(tag)), action).toBe(true);
    }
    expect(src).not.toMatch(/class="act /);
    const style = rawStyleBlock(src);
    expect(style).not.toMatch(/\.act:hover/);
    expect(style).toMatch(/\.row \.verb/);
  });

  test("an empty conversation arrives through the owned spark, skip first chat", () => {
    const src = read("src/cockpit/flow/Flow.svelte");
    expect(src).toMatch(/becauseChanged\("the open conversation"/);
    expect(src).toMatch(/use:moves=\{land\}/);
    expect(src).toMatch(/previous === null \|\| previous === next/);
  });

  test("the token owner names the mark marker", () => {
    expect(read(TOKENS)).toMatch(/\.cockpit\s+\.verb\.mark\s*\{/);
  });

  test("CopyButton is a verb reveal-item and does not restate the spine", () => {
    const src = read("src/cockpit/render/CopyButton.svelte");
    expect(src).toMatch(/class="verb reveal-item copy"/);
    expect(src).not.toMatch(/class="copy-btn"/);
    const style = rawStyleBlock(src);
    expect(style).not.toMatch(/min-height:\s*var\(--hit-min\)/);
    expect(style).not.toMatch(/:hover\s*\{[^}]*--layer-hover/);
  });

  test("hover-reveal keys the marker, not a copy-btn twin", () => {
    const css = read(TOKENS).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.reveal-on-hover\s+\.reveal-item\s*\{/);
    expect(css).not.toMatch(/\.hover-reveal\s+\.copy-btn/);
    expect(css).not.toMatch(/--copy-btn-pad-x/);
  });

  test("copy hosts mark the owned reveal container", () => {
    for (const path of [
      "src/cockpit/render/CodeBlock.svelte",
      "src/cockpit/render/UnifiedDiff.svelte",
      "src/cockpit/render/ToolOutput.svelte",
    ] as const) {
      const src = read(path);
      expect(src, path).toMatch(/reveal-on-hover/);
      expect(src, path).not.toMatch(/class="[^"]*hover-reveal/);
    }
  });

  test("Flow unread-wall read-again is a verb, not a local spine", () => {
    const src = read("src/cockpit/flow/Flow.svelte");
    expect(src).toMatch(/data-verb-id="chat\.history\.read-again"/);
    expect(src).not.toMatch(/class="read-again"/);
    expect(rawStyleBlock(src)).not.toMatch(/\.read-again\s*\{/);
  });

  test("NewTabButton consumes .verb; .new-tab is layout only", () => {
    const src = read("src/cockpit/shell/NewTabButton.svelte");
    expect(src).toMatch(/class="verb add new-tab"/);
    const style = rawStyleBlock(src);
    expect(style).not.toMatch(/min-height:\s*var\(--hit-min\)/);
    expect(style).not.toMatch(/\.new-tab:hover/);
  });

  test("FolderPicker row checkmarks mark verb.mark; local CSS does not restate the floor", () => {
    const src = read("src/cockpit/rooms/FolderPicker.svelte");
    expect(src).toMatch(/class="verb mark ok choose"/);
    const style = rawStyleBlock(src);
    expect(style).not.toMatch(/\.choose\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
    expect(style).not.toMatch(/\.verb\s*\{[^}]*padding:\s*0\s+var\(--sp-1\)/);
  });

  test("mutation: a restated copy spine is caught", () => {
    expect(
      /min-height:\s*var\(--hit-min\)/.test(
        "<style>.copy-btn { min-height: var(--hit-min); }</style>",
      ),
    ).toBe(true);
    expect(
      /min-height:\s*var\(--hit-min\)/.test("<style>.done { color: var(--ok); }</style>"),
    ).toBe(false);
  });

  test("the token owner names the more-bar marker", () => {
    expect(read(TOKENS)).toMatch(/\.cockpit\s+\.verb\.more\s*\{/);
  });

  test("CodeBlock and UnifiedDiff fold bars consume verb.more; no restated hover", () => {
    for (const path of [
      "src/cockpit/render/CodeBlock.svelte",
      "src/cockpit/render/UnifiedDiff.svelte",
    ] as const) {
      const src = read(path);
      expect(src, path).toMatch(/class="verb more"/);
      expect(
        src,
        path,
      ).not.toMatch(/<button[^>]*class="more"/);
      const style = rawStyleBlock(src);
      expect(style, path).not.toMatch(/\.more:hover/);
      expect(style, path).not.toMatch(/\.more\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
    }
  });

  test("ThinkingFold grip is a verb; thinking body arrives, skip first open", () => {
    const src = read("src/cockpit/flow/ThinkingFold.svelte");
    expect(src).toMatch(/class="verb grip"/);
    expect(src).toMatch(/becauseChanged\("the thinking block"/);
    expect(src).toMatch(/use:moves=\{land\}/);
    expect(rawStyleBlock(src)).not.toMatch(/\.grip:hover/);
    expect(rawStyleBlock(src)).not.toMatch(/min-height:\s*var\(--hit-min\)/);
    expect(
      rawStyleBlock(src),
      "zeroing padding restates the recipe pad and sits the chip flush on its hairline",
    ).not.toMatch(/\.grip\s*\{[^}]*padding:\s*0/);
  });

  test("FindingNote how/dismiss consume .verb; derivation arrives", () => {
    const src = read("src/cockpit/computer/FindingNote.svelte");
    expect(src).toMatch(/class="verb"/);
    expect(src).not.toMatch(/derivation-toggle/);
    expect(src).toMatch(/becauseChanged\("the finding derivation"/);
    expect(rawStyleBlock(src)).not.toMatch(/--layer-hover/);
  });

  test("Desk grip, ItemBody expand, settings fold/clear consume .verb", () => {
    const desk = read("src/cockpit/shell/Desk.svelte");
    expect(desk).toMatch(/class="verb grip"/);
    expect(rawStyleBlock(desk)).not.toMatch(/\.grip:hover/);
    const body = read("src/cockpit/desk/ItemBody.svelte");
    expect(body).toMatch(/data-verb-id="desk\.body\/expand"/);
    expect(body).toMatch(/class="verb"/);
    expect(rawStyleBlock(body)).not.toMatch(/--layer-hover/);
    const settings = read("src/cockpit/rooms/SettingsRoom.svelte");
    expect(settings).toMatch(/class="verb fold"/);
    expect(settings).toMatch(/class="verb clear"/);
    expect(rawStyleBlock(settings)).not.toMatch(/\.fold:hover/);
    expect(rawStyleBlock(settings)).not.toMatch(/\.clear:hover/);
  });

  test("FolderPicker rows consume verb.menu; local CSS does not restate hover", () => {
    const src = read("src/cockpit/rooms/FolderPicker.svelte");
    expect(src).toMatch(/class="verb menu row"/);
    expect(rawStyleBlock(src)).not.toMatch(/\.row:hover/);
    expect(rawStyleBlock(src)).not.toMatch(/\.row\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
  });

  test("mutation: a restated fold-bar spine is caught", () => {
    expect(
      /\.more:hover/.test("<style>.more:hover { background: var(--layer-hover); }</style>"),
    ).toBe(true);
    expect(/\.more:hover/.test("<style>.more { padding: 0; }</style>")).toBe(false);
  });

  test("strip tab-close is a bare verb inside the slot bezel", () => {
    const src = read("src/cockpit/shell/WorkspaceStrip.svelte");
    expect((src.match(/class="verb bare close tab-close"/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/class="verb close tab-close"/);
    const style = rawStyleBlock(src);
    expect(style).toMatch(/\.slot \.verb\.tab-close/);
    expect(style).toMatch(/border-left-color:\s*transparent/);
    expect(style).not.toMatch(/\.tab-close\s*\{[^}]*padding:\s*0/);
  });

  test("mutation: a boxed tab-close (no bare) is caught", () => {
    expect(/class="verb close tab-close"/.test(`class="verb close tab-close"`)).toBe(true);
    expect(/class="verb close tab-close"/.test(`class="verb bare close tab-close"`)).toBe(false);
  });

  test("mutation: a grip that zeroes the recipe pad is caught", () => {
    expect(/\.grip\s*\{[^}]*padding:\s*0/.test("<style>.grip { gap: 4px; padding: 0; }</style>")).toBe(
      true,
    );
    expect(/\.grip\s*\{[^}]*padding:\s*0/.test("<style>.grip { gap: var(--sp-1); }</style>")).toBe(
      false,
    );
  });
});
