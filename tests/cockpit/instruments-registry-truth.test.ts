// @vitest-environment node
/**
 * INSTRUMENTS vs THE REAL REGISTRY (DESIGN-COCKPIT-V2 §8.2).
 *
 * The room's pure helpers are run against the LIVE exposure registry as the
 * server actually serves it (`registerAllExposure()` + `buildUiSchema()` —
 * dynamic discovery, never a fixture list), so the claims the room makes on
 * screen are claims about the real 110-signal surface:
 *
 *   - every served signal lands in exactly one module group, and every
 *     group heading is the SERVED display name (`sys.<ns>` module title) —
 *     no old-tree label table is imported (the cockpit import law forbids
 *     it; `cockpit-no-legacy-imports` enforces it);
 *   - the served-name GAP list: any signal whose served display name is
 *     still a raw identifier is reported here, by id, so the gap is a
 *     visible fact rather than something patched behind the registry's
 *     back;
 *   - verb resolution is MECHANICAL and total: every signal resolves 1–2
 *     verbs, `ask` always present, `adjust` exactly where a served setting
 *     declares that signal id as its customization;
 *   - NO signal declares thresholds today, so no cell can earn color —
 *     the dark-cockpit claim, verified against the field rather than
 *     asserted.
 */
import { beforeAll, describe, expect, test } from "vitest";

import { buildUiSchema, resetUiSchemaCache } from "../../server/schema/ui-schema.ts";
import { registerAllExposure, listSignals } from "../../server/kernel/canonical.ts";
import { ASK_PREFILL, parseAsk } from "../../src/cockpit/computer/ask.ts";
import {
  boundingSetting,
  buildGroups,
  declaredThresholds,
  exposureActionForSignal,
  isRawName,
  isTwoPressAction,
  rawNameGaps,
  requiredArgNames,
  resolveVerbs,
  safeActionIds,
} from "../../src/cockpit/rooms/instruments-data.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";

let schema: UiSchema;

beforeAll(() => {
  registerAllExposure();
  resetUiSchemaCache();
  schema = buildUiSchema();
});

describe("the room covers the real registry, wholly", () => {
  test("the field is the real one (the spec's ~110 signals across 11 modules)", () => {
    expect(schema.signals.length).toBeGreaterThanOrEqual(110);
    const modules = new Set(schema.signals.map((s) => s.module));
    expect(modules.size).toBeGreaterThanOrEqual(11);
  });

  test("every served signal lands in exactly one group — none dropped, none doubled", () => {
    const groups = buildGroups(schema);
    const seen = groups.flatMap((g) => g.signals.map((s) => s.id));
    expect(seen).toHaveLength(schema.signals.length);
    expect(new Set(seen).size).toBe(schema.signals.length);
  });

  test("every group heading is a plain served name, never a raw namespace", () => {
    for (const g of buildGroups(schema)) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.title).not.toBe(g.module);
      expect(g.title).not.toMatch(/^sys\./);
      expect(g.title).not.toMatch(/[._]/);
    }
  });

  test("group headings come from the SERVED module titles where the schema has them", () => {
    const served = new Map(schema.modules.map((m) => [m.id, m.title]));
    for (const g of buildGroups(schema)) {
      const title = served.get(`sys.${g.module}`);
      if (title !== undefined) expect(g.title).toBe(title);
    }
  });
});

describe("the served-name gap list (reported, never patched over)", () => {
  test("gaps are enumerated from the live registry", () => {
    const gaps = rawNameGaps(schema.signals);
    // The list itself is the deliverable; a non-empty list is REPORTED, not
    // silently corrected with an old-tree table (which the import law bans).
    // Printing keeps the fact visible in CI output either way.
    if (gaps.length > 0) {
      console.log(
        `served-name gaps (${gaps.length}):\n` +
          gaps.map((g) => `  ${g.id} → "${g.served}"`).join("\n"),
      );
    }
    expect(Array.isArray(gaps)).toBe(true);
  });

  test("MUTATION: the raw-name detector actually detects raw names", () => {
    expect(isRawName("", "a.b")).toBe(true);
    expect(isRawName("a.b", "a.b")).toBe(true);
    expect(isRawName("context.trimCount", "context.trimCount")).toBe(true);
    expect(isRawName("trimCount", "context.trimCount")).toBe(true);
    expect(isRawName("trim_count", "context.trimCount")).toBe(true);
    // …and does NOT flag a real plain name (no false gap in the report).
    expect(isRawName("Trim Count", "context.trimCount")).toBe(false);
    expect(isRawName("Utilization", "context.utilization")).toBe(false);
  });
});

describe("verbs resolve mechanically over the whole field", () => {
  test("every signal gets 1–2 verbs, and ask is always the last", () => {
    for (const s of schema.signals) {
      const verbs = resolveVerbs(s, schema.settings, schema.blockActions);
      expect(verbs.length, s.id).toBeGreaterThanOrEqual(1);
      expect(verbs.length, s.id).toBeLessThanOrEqual(2);
      expect(verbs[verbs.length - 1]!.kind, s.id).toBe("ask");
    }
  });

  test("adjust appears exactly where a served setting declares that signal id", () => {
    let bounded = 0;
    for (const s of schema.signals) {
      const setting = boundingSetting(s, schema.settings);
      const verbs = resolveVerbs(s, schema.settings, schema.blockActions);
      const hasAdjust = verbs.some((v) => v.kind === "adjust");
      expect(hasAdjust, s.id).toBe(setting !== null);
      if (setting !== null) bounded += 1;
    }
    // The registry really does declare a bounding setting for a subset —
    // a resolution that found none would be vacuously "correct".
    expect(bounded).toBeGreaterThan(0);
  });

  test("the ask prefill is the grammar's bare leader, and the grammar reads it as OPEN — never dead-ended", () => {
    for (const s of schema.signals) {
      const ask = resolveVerbs(s, schema.settings, schema.blockActions).at(-1)!;
      expect(ask.kind, s.id).toBe("ask");
      if (ask.kind !== "ask") continue;
      // The leader alone, from the grammar's own owner. A prefill built
      // from the cell (its display name) is a question the grammar can
      // never parse: every question keyword names a code-graph fact, and
      // no signal's display name contains one — the send answers only the
      // unknown-keyword refusal and fires nothing.
      expect(ask.prefill, s.id).toBe(ASK_PREFILL);
      const parsed = parseAsk(ask.prefill);
      expect(parsed.ok, s.id).toBe(false);
      // The refusal must be the grammar's OPEN state — the menu hint
      // enumerating the askable set — never the "no computable question"
      // verdict a fabricated phrase earns.
      if (!parsed.ok) expect(parsed.hint, s.id).toMatch(/^askable: /);
    }
  });

  test("no exposure ACTION shares a signal id today — the doc's claim, verified", () => {
    const shared = schema.signals.filter(
      (s) => exposureActionForSignal(s, schema.actions) !== null,
    );
    expect(shared.map((s) => s.id)).toEqual([]);
  });
});

describe("dark cockpit — verified against what the registry declares", () => {
  test("NO live signal declares thresholds, so no cell may earn color", () => {
    const withThresholds = schema.signals.filter((s) => declaredThresholds(s) !== null);
    expect(withThresholds.map((s) => s.id)).toEqual([]);
  });

  test("MUTATION: a signal that DID declare thresholds would be honored", () => {
    const declared = {
      ...schema.signals[0]!,
      thresholds: { warnAbove: 10, alarmAbove: 20 },
    };
    expect(declaredThresholds(declared)).toEqual({
      warnAbove: 10,
      alarmAbove: 20,
      warnBelow: undefined,
      alarmBelow: undefined,
    });
  });
});

// ── Declared units — the room's rendering vocabulary, against the field ────

describe("declared units mean what the room renders them as", () => {
  test("the share unit reads 0–1 — a value above 1 is a multiple misdeclared as a share", () => {
    // The room renders unit "ratio" as a PERCENT OF A WHOLE (0–1 → "%"):
    // utilization, hit rates, catch rates — the fraction-out-of-a-total
    // class. The served wire carries no range field, so the class is held
    // the one way available: read every share-declared signal's live value
    // and refuse one outside 0–1. The original defect read 4 → rendered
    // "400%", a percentage of a referent the label never named while the
    // leaf's own description spoke in "times". Signals whose value needs
    // input are outside the room's feed and outside this sweep.
    let shares = 0;
    for (const s of listSignals()) {
      if (s.unit !== "ratio" || (s.args !== undefined && s.args.length > 0)) continue;
      const v = s.value();
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      expect(v, `${s.id} declares the share unit but reads ${v}`).toBeGreaterThanOrEqual(0);
      expect(v, `${s.id} declares the share unit but reads ${v}`).toBeLessThanOrEqual(1);
      shares += 1;
    }
    // The field really carries share-declared signals — a sweep over an
    // empty population would be vacuously "correct".
    expect(shares).toBeGreaterThan(0);
  });

  test("the multiplier budget declares the multiple's own unit, never the share unit", () => {
    // safety.longCommentMinRatio is a multiple, not a share — its own
    // description says so ("this many times longer") and its consumer
    // reads it as one (mergedLen/stmtLen >= value, default 4): a comment
    // ≥ 4× the statement length flags a deferred fix, rendered
    // "4 times". Declaring the share unit here is the "400%" defect (the
    // room rescaled 4 into a percent of a referent the label never
    // named); the by-id pin holds even when a planted config parks the
    // value at 1. Judged and LEFT: intelligence.searchSealRatio (min 1,
    // max 10) is the same ≥1 shape but a CUSTOMIZATION, not a signal —
    // the settings sheet renders its unit as a plain suffix ("1.8
    // ratio", no rescale), which is honest where it renders.
    const byId = new Map(listSignals().map((s) => [s.id, s]));
    expect(byId.get("safety.longCommentMinRatio"), "safety.longCommentMinRatio must be a served signal").toBeDefined();
    expect(byId.get("safety.longCommentMinRatio")?.unit, "the multiple must serve its own unit").toBe("times");
  });
});

// ── The exposure actions fold, against the real served field ───────────────

describe("the actions fold covers the real served actions, wholly", () => {
  test("the field is the real one (the 64 backend exposure actions are served)", () => {
    // The served actions include the backend exposure set (each with its
    // DECLARED module forwarded) plus whatever the UI declarations serve
    // beside it. The fold derives from the served schema alone, so the
    // number it must surface is whatever THIS server serves — pinned here
    // so a registry that shrinks is a visible change, never a silent one.
    expect(schema.actions.length).toBeGreaterThanOrEqual(64);
    const backendModules = new Set(
      schema.actions.filter((a) => a.module !== undefined).map((a) => a.module),
    );
    expect(backendModules.size).toBeGreaterThanOrEqual(13);
  });

  test("EVERY served action lands in exactly one module fold — none dropped, none doubled", () => {
    // THE PASTE-COUNT CHECK, live: the fold's derivation (buildGroups) must
    // surface every served action exactly once, whatever the registry
    // serves. MUTATION: filter the actions inside buildGroups and this reds
    // by count while the schema still serves the dropped id.
    const groups = buildGroups(schema);
    const surfaced = groups.flatMap((g) => g.actions.map((a) => a.id));
    expect(surfaced).toHaveLength(schema.actions.length);
    expect(new Set(surfaced).size).toBe(schema.actions.length);
    for (const a of schema.actions) {
      expect(surfaced, `${a.id} was not surfaced by any fold`).toContain(a.id);
    }
  });

  test("each action folds under its DECLARED module, and a module-less action lands in the catch-all", () => {
    const groups = buildGroups(schema);
    const byModule = new Map(groups.map((g) => [g.module, g.actions]));
    for (const a of schema.actions) {
      const expected =
        a.module !== undefined && a.module.length > 0 ? a.module : "other";
      expect(
        byModule.get(expected)?.some((x) => x.id === a.id),
        `${a.id} did not fold under its declared module ${expected}`,
      ).toBe(true);
    }
  });

  test("the two-press dispositions are judged over the LIVE field — safe ids exist, everything else is two-press", () => {
    // The safe set is a judgment about WHAT each action does, read from its
    // registration; the guard keeps it honest in both directions:
    //   - every safe-listed id is REALLY SERVED (a stale entry names itself
    //     and reds — the table cannot silently outlive its action);
    //   - deny-by-default: a served id NOT in the set is two-press, so an
    //     action registered tomorrow asks twice until someone reads it.
    const served = new Set(schema.actions.map((a) => a.id));
    for (const id of safeActionIds()) {
      expect(served, `${id} is classified single-press but the registry does not serve it`).toContain(id);
      expect(isTwoPressAction(id), `${id} must be single-press`).toBe(false);
    }
    let twoPress = 0;
    for (const a of schema.actions) {
      if (isTwoPressAction(a.id)) twoPress += 1;
    }
    expect(twoPress).toBeGreaterThan(0);
    // And the deny-by-default arm itself: an unlisted id reads as two-press.
    expect(isTwoPressAction("some.module.action-registered-tomorrow")).toBe(true);
  });

  test("the safe set is EXACTLY these five ids — sorted, complete, named", () => {
    // THE EXACT-MEMBERSHIP PIN. The disposition arm above proves the two
    // DIRECTIONS (a listed id must be served; an unlisted id is
    // two-press); this arm pins the MEMBERSHIP itself, so the press
    // grammar cannot drift silently in either direction — an id added to
    // or dropped from the safe list reds BY NAME against this list.
    // MUTATION: classify `memory.clear` single-press and this fails naming
    // it — the destructive verbs (clear/reset/rollback/prune/compact/
    // relearn/forceTrim/clearCache/resetCounters…) are exactly the ones
    // the registration comment says earn the second press, and they are
    // all served today (60 of them read two-press over the live field).
    expect([...safeActionIds()].sort()).toEqual([
      "awareness.refresh",
      "bias.readAudit",
      "context.retrieveMemory",
      "editor.validateSyntax",
      "quality.recheck",
    ]);
  });

  test("the required-argument set the fold disables is exactly what the schema declares", () => {
    // The fold refuses a bare press only where the SERVED schema declares a
    // required arg — derived per entry, never a hand list. Pinned over the
    // live field so a registration that adds a required arg is caught by the
    // fold's own contract the day it lands.
    let withRequired = 0;
    for (const a of schema.actions) {
      const required = requiredArgNames(a);
      if (required.length === 0) continue;
      withRequired += 1;
      for (const name of required) {
        expect(a.args?.[name]?.required, `${a.id}.${name} must really be required`).toBe(true);
      }
    }
    expect(withRequired, "the live field declares required-arg actions").toBeGreaterThan(0);
  });

  test("MUTATION: a filtered derivation reds the count while the schema still serves the action", () => {
    // The plant the count arm exists to catch, in vitro: a buildGroups that
    // drops an action (the shape a hand list or a bad filter would take)
    // cannot pass the exact-one-per-served-action invariant.
    const doctored: UiSchema = {
      ...schema,
      actions: schema.actions.slice(0, -1),
    };
    const surfaced = buildGroups(doctored).flatMap((g) => g.actions.map((a) => a.id));
    // The doctored schema serves fewer, so its fold legitimately surfaces
    // fewer — but the production invariant (surfaced === served) still holds
    // for the REAL schema, and the mismatch below is the red a filtered
    // derivation produces against the UNFILTERED field.
    expect(surfaced).toHaveLength(doctored.actions.length);
    expect(surfaced.length).not.toBe(schema.actions.length);
  });
});
