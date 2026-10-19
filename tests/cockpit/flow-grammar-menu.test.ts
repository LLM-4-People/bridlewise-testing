// @vitest-environment node
/**
 * The LIVE grammar menu (§5.3) — `grammarMenuFor`, the per-keystroke
 * derivation behind the desk-line autocomplete (shell path AND dev
 * harness — one derivation, no twin):
 *   - `/` lists matching registered block actions with their declared
 *     consequence sentences VERBATIM (never invented);
 *   - a not-runnable action is LISTED with its honest reason;
 *   - `?` lists the askable questions;
 *   - plain text → NO menu (no grammar over ordinary words).
 */
import { beforeEach, describe, expect, test } from "vitest";

import { grammarMenuFor } from "../../src/cockpit/flow/composer-router";
import { matchCommands } from "../../src/cockpit/computer/commands";
import { uiSchema } from "../../src/state/schema-store";
import type { UiSchema } from "../../shared/ui-schema";

const SCHEMA = {
  menus: [],
  panels: [],
  widgets: [],
  blockActions: {
    "tools.enabled": [
      {
        name: "toggle",
        title: "Turn tool on or off",
        consequence: "Switches the tool for your account; a running run stops using it.",
        params: { tool: "shell", enabled: "false" },
        invalidates: ["tools:changed"],
      },
      {
        name: "wipe",
        title: "Wipe tool history",
        consequence: "Erases the call history.",
        // no params template — bespoke-caller action, listed but blocked
        invalidates: [],
      },
    ],
  },
} as unknown as UiSchema;

beforeEach(() => {
  uiSchema.set(SCHEMA);
});

describe("grammarMenuFor — the live `/` menu", () => {
  test("lists matching actions with VERBATIM consequences", () => {
    const menu = grammarMenuFor("/togg");
    expect(menu.length).toBeGreaterThan(0);
    expect(menu[0]!.head).toBe("/tools.enabled/toggle");
    expect(menu[0]!.detail).toBe(
      "Switches the tool for your account; a running run stops using it.",
    );
  });

  test("a not-runnable action is listed with its honest reason", () => {
    const menu = grammarMenuFor("/wipe");
    const wipe = menu.find((m) => m.head === "/tools.enabled/wipe");
    expect(wipe).toBeDefined();
    expect(wipe!.detail).toContain("not runnable here");
  });

  test("bare `/` lists the registry (type to filter)", () => {
    expect(grammarMenuFor("/").length).toBe(2);
  });

  test("`?` lists the askable questions", () => {
    const menu = grammarMenuFor("?");
    expect(menu.length).toBeGreaterThan(0);
    for (const item of menu) expect(item.head.startsWith("?")).toBe(true);
  });

  test("MUTATION: plain words produce NO menu", () => {
    expect(grammarMenuFor("hello there")).toEqual([]);
    expect(grammarMenuFor("")).toEqual([]);
  });

  test("MUTATION: with no schema loaded the `/` menu is empty, never invented", () => {
    uiSchema.set(null);
    expect(grammarMenuFor("/togg")).toEqual([]);
  });
});

describe("the palette ranks runnable rows first", () => {
  test("a blocked row never outranks a runnable one, whatever their match scores", () => {
    // The blocked action is deliberately the BETTER textual match for the
    // query, so ordering by score alone would front-load the dead row —
    // the shape the sweep observed.
    uiSchema.set({
      menus: [],
      panels: [],
      widgets: [],
      blockActions: {
        "tools.enabled": [
          {
            name: "wipeout",
            title: "Wipe everything",
            consequence: "Erases it all.",
            // no params template — listed but blocked here.
            invalidates: [],
          },
          {
            name: "wip",
            title: "Work in progress",
            consequence: "Marks it.",
            params: { flag: "on" },
            invalidates: [],
          },
        ],
      },
    } as unknown as Parameters<typeof uiSchema.set>[0]);
    const matches = matchCommands("wip");
    expect(matches.length).toBe(2);
    // Liveness of the premise: both are real matches and the blocked one
    // scores at least as well textually (exact-prefix "wipeout" vs "wip").
    expect(matches.some((m) => m.entry.blockedReason !== null)).toBe(true);
    // The runnable row leads; the blocked row still lists, with its reason.
    expect(matches[0]!.entry.blockedReason).toBeNull();
    expect(matches[1]!.entry.blockedReason).not.toBeNull();
  });
});
