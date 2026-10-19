// @vitest-environment node
/**
 * Signed-out shell, room tabs, popovers, restorable delete — the choke
 * points this round owns. Each arm is planted: a weakened source reds.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { read, stripCommentsOnlyFor, walk } from "../helpers/source-scan.ts";
import { GRAMMAR } from "../../src/cockpit/shell/keyboard.ts";

const COCKPIT = "src/cockpit";
const SHELL = "src/cockpit/Cockpit.svelte";
const HORIZON = "src/cockpit/shell/Horizon.svelte";
const TOKENS = "src/cockpit/tokens.css";
const SWITCH = "src/cockpit/rooms/SwitchRoom.svelte";
const SETTINGS = "src/cockpit/rooms/SettingsRoom.svelte";
const BRIDGE = "server/filesystem/editor-bridge.ts";

function src(path: string): string {
  return stripCommentsOnlyFor(read(path), path);
}

function deskAuthedFindings(source: string): string[] {
  const out: string[] = [];
  if (!/\{#if authed\}\s*<div class="desk-underlay"[^>]*>\s*<Desk/.test(source)) {
    out.push("Desk is not gated on {#if authed}");
  }
  if (!/const authed = \$derived\(revealed && username\.length > 0\)/.test(source)) {
    out.push("authed is not derived from revealed && username");
  }
  return out;
}

describe("A — signed-out is registration only", () => {
  test("Desk, sweep, and rail are gated on authed, not merely revealed", () => {
    const cockpit = src(SHELL);
    expect(deskAuthedFindings(cockpit)).toEqual([]);
    expect(cockpit).toMatch(/\{#if authed\}[\s\S]*sweep-outlet/);
    const horizon = src(HORIZON);
    expect(horizon).toMatch(/authed/);
    expect(horizon).toMatch(/\{#if authed\}[\s\S]*class="rail room-tabs"/);
    expect(horizon).toMatch(/\{#if authed && showPlace\}/);
  });

  test("MUTATION: Desk outside authed reds", () => {
    const original = src(SHELL);
    const planted = original.replace(/\{#if authed\}(\s*<div class="desk-underlay"[^>]*>\s*<Desk)/, "$1");
    expect(planted).not.toBe(original);
    expect(deskAuthedFindings(planted).length).toBeGreaterThan(0);
  });
});

describe("B — top-right options are tabs including Chat", () => {
  test("Chat is a grammar target and a tab face, not a ChatRoom file", () => {
    expect(GRAMMAR.some((s) => s.target === "chat")).toBe(true);
    const horizon = src(HORIZON);
    expect(horizon).toMatch(/target="chat"/);
    expect(horizon).toMatch(/role="tablist"/);
    expect(horizon).toMatch(/tab=\{true\}/);
    expect(horizon).toMatch(/selected=\{roomId === null\}/);
    const rooms = walk("src/cockpit/rooms", { exts: [".svelte"] }).map((f) => f.replace(/.*\//, ""));
    expect(rooms.some((n) => n === "ChatRoom.svelte")).toBe(false);
  });

  test("tokens own the tab selected/rest/hover recipe", () => {
    const tokens = readFileSync(TOKENS, "utf8");
    expect(tokens).toMatch(/\.cockpit \.room-tabs \.chord-grip/);
    expect(tokens).toMatch(/\[aria-selected="true"\]/);
  });

  test("Cockpit routes chat by closing the room", () => {
    const cockpit = src(SHELL);
    expect(cockpit).toMatch(/spec\.target === "chat"/);
    expect(cockpit).toMatch(/shell\.closeRoom\(\)/);
  });

  test("rooms sit below the HORIZON so the tab rail stays clickable", () => {
    const host = src("src/cockpit/shell/RoomHost.svelte");
    expect(host).toMatch(/top:\s*var\(--room-top,\s*var\(--horizon-h\)\)/);
    expect(host).not.toMatch(/inset:\s*0/);
  });
});

describe("C — project identity and contextual actions", () => {
  test("the project cap retains its exact identity and one deliberate menu", () => {
    const raw = src(SWITCH);
    const cap = /<header class="cap"[\s\S]*?<\/header>/.exec(raw)?.[0] ?? "";
    expect(cap).toContain('cap.project.name');
    expect(cap).toContain('pathHints[cap.project.id]');
    expect(cap).toContain('data-verb-id="switch.project-menu"');
    expect(cap).not.toContain('data-verb-id="switch.cap-new-conversation"');
    expect(cap).not.toContain('data-verb-id="switch.cap-trash"');
    expect(raw).toContain('data-verb-id="switch.create-menu"');
    // Native shell-scroll-clip measures columns, containment and a restored
    // CSS-only column fault; the model owner proves virtual offsets/focus.
  });
});

describe("D — labelled index rails auto-width", () => {
  test("tokens own .index-rail; Settings consumes it", () => {
    const tokens = readFileSync(TOKENS, "utf8");
    expect(tokens).toMatch(/--index-rail-min:/);
    expect(tokens).toMatch(/--index-rail-max:/);
    expect(tokens).toMatch(/\.cockpit \.index-rail \{[\s\S]*width:\s*max-content/);
    expect(tokens).toMatch(/grid-template-columns:\s*1fr\s+auto/);
    expect(src(SETTINGS)).toMatch(/class="index-rail settings-rail"/);
    expect(src(SETTINGS)).not.toMatch(/--settings-rail-w/);
  });
});

describe("E — settings rows share tracks", () => {
  test("split rows consume the shared identity/read-back recipe", () => {
    const tokens = readFileSync(TOKENS, "utf8");
    expect(tokens).toMatch(/\.cockpit \.setting-tracks/);
    expect(src(SETTINGS)).toMatch(/class:setting-tracks=\{split\}/);
    expect(tokens).toMatch(/\.cockpit \.setting-tracks \.row-face\s*\{/);
    expect(src(SETTINGS)).toMatch(/class="row-identity"/);
    expect(src(SETTINGS)).toMatch(/class="row-reading"/);
    // Alignment and long-content containment are actual layout properties.
    // settings-width-owner.spec.ts measures them across rows and restores
    // a discriminating one-row track fault. No subgrid/nowrap requirement:
    // the paired composition must wrap rather than clip long real labels.
  });
});

describe("F — Popover is the raised surface for pickers and confirmations", () => {
  test("folder pickers and confirmations host in Popover", () => {
    const sw = src(SWITCH);
    expect(sw).toMatch(/<Popover[\s\S]*size="picker"[\s\S]*<FolderPicker/);
    expect(sw).not.toMatch(/class="pick-panel"/);
    expect(sw).toMatch(/kind="alertdialog"/);
    const pane = src("src/cockpit/editor/FilePane.svelte");
    expect(pane).toMatch(/kind="alertdialog"/);
    expect(pane).toMatch(/<DeleteConfirm/);
    expect(pane).toMatch(/restore last saved/);
    const parcel = src("src/cockpit/rooms/Parcel.svelte");
    expect(parcel).toMatch(/<Popover[\s\S]*kind="alertdialog"/);
    expect(src("src/cockpit/shell/Popover.svelte")).toMatch(/kind\?: "dialog" \| "alertdialog"/);
  });

  test("no alert() and no second overlay recipe for those confirms", () => {
    for (const f of walk(COCKPIT, { exts: [".svelte", ".ts"] })) {
      const body = src(f);
      expect(body, f).not.toMatch(/\balert\s*\(/);
    }
  });
});

describe("G — deleteFile moves to recycle; copy never says irreversible", () => {
  test("deleteFile moves, restoreFile exists, rename is the door not rmSync-first", () => {
    const bridge = src(BRIDGE);
    expect(bridge).toMatch(/export function restoreFile/);
    expect(bridge).toMatch(/export function listRecycledFiles/);
    expect(bridge).toMatch(/recycleId/);
    const del = /export function deleteFile[\s\S]*?export function listRecycledFiles/m.exec(bridge)?.[0] ?? "";
    // The move goes through the single rename owner (movePath), and it lands
    // BEFORE the effect is recorded — never rmSync-first.
    expect(del).toMatch(/movePath\(\s*abs/);
    expect(del).toMatch(/recordFileEffect/);
    expect(del.indexOf("movePath")).toBeLessThan(del.indexOf("recordFileEffect"));
  });

  test("user-facing copy forbids 'cannot be undone' / 'nothing here can bring it back'", () => {
    const FORBIDDEN = /cannot be undone|nothing here can bring it back/i;
    const hits: string[] = [];
    for (const f of [
      ...walk(COCKPIT, { exts: [".svelte", ".ts"] }),
      join(process.cwd(), "server/blocks/custody.ts"),
    ]) {
      const body = src(f);
      if (FORBIDDEN.test(body)) hits.push(f);
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});
