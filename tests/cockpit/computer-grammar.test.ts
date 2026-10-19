// @vitest-environment node
/**
 * The composer grammars (spec §4.5 `?`, §5.3 `/`).
 *
 * `?` — parse + the enumerable askable list (only questions a registered
 * block can answer). `/` — the palette is GENERATED from the served
 * blockActions manifest; labels/consequences verbatim; deny-by-default on
 * unbuildable input (no template / $sel refs).
 */
import { afterEach, describe, expect, test } from "vitest";

import { ASKABLE, parseAsk } from "../../src/cockpit/computer/ask.ts";
import {
  commandEntries,
  fuzzyMatchScore,
  matchCommands,
  parseCommand,
  runCommand,
} from "../../src/cockpit/computer/commands.ts";
import { uiSchema } from "../../src/state/schema-store.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";

afterEach(() => uiSchema.set(null));

describe("? — ask the computer", () => {
  test("askable questions all name an existing intelligence block", () => {
    expect(ASKABLE.map((q) => q.blockId).sort()).toEqual([
      "code.impact",
      "code.path",
      "code.reuse",
    ]);
  });

  test("bare ? lists the askable — the palette cannot promise more", () => {
    const r = parseAsk("?");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/\? impact <file>/);
  });

  test("parses impact / path / reuse with their arities", () => {
    const impact = parseAsk("? impact src/x.ts");
    expect(impact.ok).toBe(true);
    if (impact.ok) expect(impact.parsed.question.blockId).toBe("code.impact");

    const path = parseAsk("? path a.ts b.ts");
    expect(path.ok).toBe(true);
    if (path.ok) expect(path.parsed.args).toEqual(["a.ts", "b.ts"]);

    const short = parseAsk("? path a.ts");
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.hint).toMatch(/usage/);

    const unknown = parseAsk("? weather tomorrow");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.hint).toMatch(/no computable question/);
  });
});

function fakeSchema(): UiSchema {
  return {
    version: "test",
    modules: [],
    menus: [],
    panels: [],
    widgets: [],
    settings: [],
    actions: [],
    signals: [],
    blockActions: {
      "tools.enabled": [
        {
          name: "toggle",
          title: "Turn on or off",
          consequence: "Turns one tool on or off for your account only.",
          params: { tool: "$sel.tool", enabled: "false" },
          invalidates: ["tools:changed"],
        },
      ],
      "checks.auto": [
        {
          name: "run",
          title: "Run checks",
          consequence: "Runs the project checks now.",
          params: { projectId: "p1" },
        },
        {
          name: "bespoke",
          title: "Bespoke thing",
          consequence: "Needs input no generic surface can supply.",
        },
      ],
    },
  };
}

describe("/ — the block-action palette", () => {
  test("with no schema, the palette says the registry has not arrived", () => {
    const r = parseCommand("/anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/not loaded yet/);
  });

  test("entries are generated verbatim from the manifest", () => {
    uiSchema.set(fakeSchema());
    const entries = commandEntries();
    expect(entries.map((e) => e.id).sort()).toEqual([
      "checks.auto/bespoke",
      "checks.auto/run",
      "tools.enabled/toggle",
    ]);
    const toggle = entries.find((e) => e.id === "tools.enabled/toggle")!;
    expect(toggle.label).toBe("Turn on or off");
    expect(toggle.consequence).toMatch(/your account only/);
  });

  test("deny-by-default: $sel refs and missing templates are blocked WITH reasons", () => {
    uiSchema.set(fakeSchema());
    const toggle = commandEntries().find((e) => e.id === "tools.enabled/toggle")!;
    expect(toggle.blockedReason).toMatch(/needs a selection \(tool\)/);
    const bespoke = commandEntries().find((e) => e.id === "checks.auto/bespoke")!;
    expect(bespoke.blockedReason).toMatch(/its own surface/);
    const runnable = commandEntries().find((e) => e.id === "checks.auto/run")!;
    expect(runnable.blockedReason).toBeNull();
    expect(runnable.input).toEqual({ projectId: "p1" });
  });

  test("a blocked entry refuses to run, stating the reason", async () => {
    uiSchema.set(fakeSchema());
    const parsed = parseCommand("/tools.enabled/toggle");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const r = await runCommand(parsed.entry);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/needs a selection/);
    }
  });

  test("exact id parses; a single fuzzy match resolves; ambiguity returns matches", () => {
    uiSchema.set(fakeSchema());
    const exact = parseCommand("/checks.auto/run");
    expect(exact.ok).toBe(true);
    const single = parseCommand("/toggle");
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.entry.id).toBe("tools.enabled/toggle");
    const ambiguous = parseCommand("/checks");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.matches.length).toBeGreaterThan(1);
  });

  test("fuzzy scoring prefers prefixes and consecutive runs", () => {
    expect(fuzzyMatchScore("tog", "toggle")).toBeGreaterThan(fuzzyMatchScore("tog", "the-o-g-thing")!);
    expect(fuzzyMatchScore("zzz", "toggle")).toBeNull();
    uiSchema.set(fakeSchema());
    expect(matchCommands("run")[0]!.entry.id).toBe("checks.auto/run");
  });
});
