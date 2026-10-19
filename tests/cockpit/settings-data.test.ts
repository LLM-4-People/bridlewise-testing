// @vitest-environment node
/**
 * Settings data — the pure layer behind the sheet + the index (spec §9).
 *
 * What must hold:
 *   - rows come from the SERVED schema only (customization-backed entries);
 *   - search is by behavior words (the served descriptions), not categories;
 *   - the fact→setting mapping is MECHANICAL registry linkage (identical id
 *     first, namespace second, nothing invented);
 *   - the measured-effect line exists only when genuinely derivable — a
 *     DECLARED measuring signal (`measuredBy` first, an identical-id
 *     registration second) plus a present reading, and nothing looser;
 *   - the surface link exists only for a room that is actually built;
 *   - the raw-key law: labelViolation catches every raw-key shape
 *     (mutation-tested both directions).
 */
import { describe, expect, test } from "vitest";

import {
  parseTokenQuantity,
  formatSetting,
  formatValue,
  labelViolation,
  optionViolation,
  optionWords,
  settingOptions,
  linkedSignal,
  measuredEffect,
  moduleOf,
  saveDescriptor,
  searchRows,
  servedRow,
  servedRows,
  servedValue,
  settingIdsForSignal,
  surfaceFor,
  surfaceForModule,
} from "../../src/cockpit/settings/settings-data.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";
import { SCHEMA, VALUES } from "./fixtures/settings-schema.ts";

describe("served rows", () => {
  test("only customization-backed entries become rows; served words ride along", () => {
    const rows = servedRows(SCHEMA);
    expect(rows.map((r) => r.id)).toEqual([
      "tools.parallelCap",
      "context.compactStrategy",
      "editor.atomicWriteEnabled",
      "awareness.enabledSignals",
    ]);
    const cap = rows[0]!;
    expect(cap.label).toBe("Parallel tool calls");
    expect(cap.module).toBe("tools");
    expect(cap.min).toBe(1);
    expect(cap.max).toBe(16);
    expect(cap.unit).toBe("calls");
  });

  test("a null schema yields nothing (honest absence, no fabricated rows)", () => {
    expect(servedRows(null)).toEqual([]);
    expect(servedRow(null, "tools.parallelCap")).toBeNull();
    expect(servedValue(null, "tools.parallelCap")).toBeUndefined();
  });

  test("servedValue joins the values snapshot; absence stays absent", () => {
    expect(servedValue(VALUES, "tools.parallelCap")).toBe(4);
    expect(servedValue(VALUES, "never.registered")).toBeUndefined();
    expect(formatValue(undefined)).toBe("not read yet");
  });
});

describe("enum choices are SPELLED, and the spelling is derived (§9.3 · #57)", () => {
  test("the derivation turns the tokens the registry actually holds into words", () => {
    // These are real member spellings from the exposure registrations, not
    // invented specimens: `round-robin` (llm queueStrategy), `next-run` (the
    // effect vocabulary), `short-term` (memory tiers), `oldest` (context
    // compaction). What each has in common is that the TOKEN CARRIES ITS
    // WORDS, which is the property the derivation depends on.
    expect(optionWords("round-robin")).toBe("Round robin");
    expect(optionWords("next-run")).toBe("Next run");
    expect(optionWords("short-term")).toBe("Short term");
    expect(optionWords("oldest")).toBe("Oldest");
    expect(optionWords("nextRun")).toBe("Next Run");
  });

  test("THE STATED LIMIT, asserted so it cannot be quietly forgotten", () => {
    // An acronym does not carry its words and nothing over the token can
    // invent them. This is asserted rather than merely documented because the
    // temptation, the first time someone sees `Fifo` on screen, is to add a
    // map — and the map is the defect this derivation exists instead of.
    // The fix is the DECLARATION carrying words; see the module docstring.
    expect(optionWords("fifo")).toBe("Fifo");
    expect(optionWords("tfidf")).toBe("Tfidf");
    // …and the violation check honestly does NOT flag them, because it
    // cannot tell `fifo` from `oldest` by inspection. A check that claimed to
    // would be a check nobody could act on.
    expect(optionViolation("fifo")).toBeNull();
    expect(optionViolation("oldest")).toBeNull();
  });

  test("a member that is structurally internal vocabulary IS flagged", () => {
    expect(optionViolation("memory.shortTerm")).toMatch(/dotted or pathed/);
    expect(optionViolation("a/b")).toMatch(/dotted or pathed/);
    expect(optionViolation("   ")).toMatch(/empty token/);
    expect(optionViolation("42")).toMatch(/no letters/);
  });

  test("the row hands out choices, not tokens — so there is no bare token to render", () => {
    const row = servedRow(SCHEMA, "context.compactStrategy")!;
    expect(row.options).toEqual([
      { value: "summarize", words: "Summarize" },
      { value: "truncate", words: "Truncate" },
      { value: "drop-oldest", words: "Drop oldest" },
    ]);
    // The FIELD is gone, not merely unused: a surface cannot reach for the
    // old shape because the row does not carry it.
    expect("enumValues" in row, "the retired string[] must not survive").toBe(false);
  });

  test("formatSetting spells an enum value; formatValue alone cannot and never could", () => {
    const row = servedRow(SCHEMA, "context.compactStrategy")!;
    expect(formatSetting(row, "drop-oldest")).toBe("Drop oldest");
    // The type-only reader is not wrong — it simply does not have the row, and
    // that is exactly why every raw token reached the screen through it.
    expect(formatValue("drop-oldest")).toBe("drop-oldest");
    // A value outside the row's own choices is a real fact about the install
    // and prints, rather than being hidden behind a dash.
    expect(formatSetting(row, "invented-by-nobody")).toBe("invented-by-nobody");
    const cap = servedRow(SCHEMA, "tools.parallelCap")!;
    expect(formatSetting(cap, 4)).toBe("4 calls");
    expect(formatSetting(cap, undefined)).toBe("not read yet");
  });

  test("settingOptions is the one builder, and it is order-preserving", () => {
    expect(settingOptions(["b-two", "a-one"])).toEqual([
      { value: "b-two", words: "B two" },
      { value: "a-one", words: "A one" },
    ]);
  });
});

describe("search — behavior words (§9.3)", () => {
  const rows = servedRows(SCHEMA);

  test("an enum row is findable by BOTH spellings of its choices", () => {
    // The haystack used to spread a `readonly string[]`. Spreading the option
    // OBJECTS instead would have put `[object Object]` in it and silently
    // ended search-by-choice — a change with no failing test unless one is
    // written for it, which is why this one is.
    expect(searchRows(rows, "drop-oldest").map((r) => r.id)).toEqual([
      "context.compactStrategy",
    ]);
    expect(searchRows(rows, "drop oldest").map((r) => r.id)).toEqual([
      "context.compactStrategy",
    ]);
    expect(searchRows(rows, "object Object")).toEqual([]);
  });

  test("a behavior word from the served description finds the row", () => {
    const hits = searchRows(rows, "half-written");
    expect(hits.map((r) => r.id)).toEqual(["editor.atomicWriteEnabled"]);
  });

  test("multiple terms AND together; case-insensitive", () => {
    expect(searchRows(rows, "Tool QUEUE").map((r) => r.id)).toEqual(["tools.parallelCap"]);
  });

  test("empty query returns everything; no term matches nothing", () => {
    expect(searchRows(rows, "  ")).toEqual(rows);
    expect(searchRows(rows, "zzz-not-a-behavior")).toEqual([]);
  });
});

describe("registry linkage — mechanical, never hand-wired (§9.1)", () => {
  test("identical id is the exact fact→setting link", () => {
    expect(settingIdsForSignal(SCHEMA, "editor.atomicWriteEnabled")).toEqual([
      "editor.atomicWriteEnabled",
    ]);
  });

  test("a signal without an identical-id setting maps to its namespace", () => {
    expect(settingIdsForSignal(SCHEMA, "tools.activeCalls")).toEqual(["tools.parallelCap"]);
  });

  test("an unlinked namespace maps to NOTHING — no invented setting", () => {
    expect(settingIdsForSignal(SCHEMA, "sweep.spectrum")).toEqual([]);
    expect(settingIdsForSignal(null, "tools.activeCalls")).toEqual([]);
  });

  test("moduleOf derives the namespace exactly once", () => {
    expect(moduleOf("search.threshold")).toBe("search");
    expect(moduleOf("plain")).toBe("plain");
  });
});

describe("measured effect — only when genuinely derivable (§9.1)", () => {
  test("identical-id signal with a reading produces the measured line", () => {
    expect(measuredEffect(SCHEMA, VALUES, "editor.atomicWriteEnabled")).toBe(
      "measured now · on",
    );
    expect(linkedSignal(SCHEMA, "editor.atomicWriteEnabled")?.module).toBe("editor");
  });

  test("the DECLARED measuredBy linkage is honored — the explicit claim wins", () => {
    // `tools.parallelCap` declares `measuredBy: "tools.activeCalls"` — a
    // different id, which is the shape only the explicit claim can express.
    // Before this was honored, every setting that declared its measurement
    // showed no reading at all while the surface claimed the linkage was
    // mechanical.
    expect(measuredEffect(SCHEMA, VALUES, "tools.parallelCap")).toBe("measured now · 2");
    expect(linkedSignal(SCHEMA, "tools.parallelCap")?.id).toBe("tools.activeCalls");
  });

  test("MUTANT: no declared linkage at all → NO line (omitted, not fabricated)", () => {
    // `context.compactStrategy` declares no `measuredBy` and no signal shares
    // its id. A namespace-mate exists for neither — and reaching for one would
    // be a linkage the registry never made.
    expect(measuredEffect(SCHEMA, VALUES, "context.compactStrategy")).toBeNull();
    expect(linkedSignal(SCHEMA, "context.compactStrategy")).toBeNull();
    // …and a missing values snapshot omits the line even when the linkage holds.
    expect(measuredEffect(SCHEMA, null, "editor.atomicWriteEnabled")).toBeNull();
    // MUTANT: a declared linkage POINTING AT NOTHING renders nothing, rather
    // than falling back to some other signal that happens to be nearby.
    const dangling = {
      ...SCHEMA,
      settings: SCHEMA.settings.map((x) =>
        x.id === "tools.parallelCap" ? { ...x, measuredBy: "tools.neverRegistered" } : x,
      ),
    } as unknown as UiSchema;
    expect(linkedSignal(dangling, "tools.parallelCap")).toBeNull();
    expect(measuredEffect(dangling, VALUES, "tools.parallelCap")).toBeNull();
  });
});

describe("surface mapping — honest links only (§9.3)", () => {
  const rows = servedRows(SCHEMA);
  const capRow = rows[0]!; // tools.*
  const editorRow = rows[2]!; // editor.* (has signals, no room of its own)

  test("namespace room when built; instruments when the module is measured", () => {
    const withTools = surfaceFor(SCHEMA, capRow, (r) => r === "tools");
    expect(withTools).toEqual({ room: "tools", label: "manifests in the tools room" });
    const viaInstruments = surfaceFor(SCHEMA, editorRow, (r) => r === "instruments");
    expect(viaInstruments).toEqual({ room: "instruments", label: "measured in the instruments room" });
  });

  test("no built room → NO link (never a link into 'not built yet')", () => {
    expect(surfaceFor(SCHEMA, capRow, () => false)).toBeNull();
  });

  test("local rows have no ONE surface — no link", () => {
    const local = { ...capRow, kind: "local" as const };
    expect(surfaceFor(SCHEMA, local, () => true)).toBeNull();
  });

  test("a readings-only module (no rows at all) answers by module id — the derivation, not a member name", () => {
    // The real class: `webPerformance` (the fixture's readings-only module)
    // owns no setting rows, so the only settings-side trace it can ever have
    // is its declaration — the rail tile. The same derivation the row-level
    // mapping uses must answer for the declaration alone, or the area's
    // readings hang on prior knowledge of where readings render.
    expect(surfaceForModule(SCHEMA, "webPerformance", (r) => r === "instruments")).toEqual({
      room: "instruments",
      label: "measured in the instruments room",
    });
    // The derivation answers the CLASS, not the member: a SECOND
    // readings-only module the real registry does not carry — declared +
    // one signal, zero settings — gets the same pointer mechanically.
    const planted: UiSchema = {
      ...SCHEMA,
      exposureModules: [
        ...(SCHEMA.exposureModules ?? []),
        { id: "sweep", title: "Sweep", purpose: "planted readings-only module" },
      ],
      signals: [
        ...SCHEMA.signals,
        { id: "sweep.spectrum", module: "sweep", name: "Spectrum", description: "d", type: "gauge" },
      ],
    } as unknown as UiSchema;
    expect(surfaceForModule(planted, "sweep", (r) => r === "instruments")).toEqual({
      room: "instruments",
      label: "measured in the instruments room",
    });
    // A module with a built room of its own points THERE instead — the
    // same precedence the row-level link carries.
    expect(surfaceForModule(planted, "tools", () => true)).toEqual({
      room: "tools",
      label: "manifests in the tools room",
    });
    // An empty area with NO signals and NO room of its own gets NO pointer —
    // a link with no destination would be fabricated (the `memory` case).
    expect(surfaceForModule(SCHEMA, "memory", (r) => r === "instruments")).toBeNull();
    expect(surfaceForModule(null, "sweep", () => false)).toBeNull();
  });
});

describe("the fixture's readings-only class member mirrors the served registration (fixture freshness)", () => {
  // The fixture's `webPerformance` member (the module declaration + the
  // one carried signal) is the class proof the room suites speak with —
  // and it is a HAND-RESTATED copy of the real registration. A copy with
  // no binding rots silently: a registration-side edit of the title,
  // purpose or signal words would leave every room suite green against a
  // wire that no longer says what the tests rehearse. This arm binds the
  // fixture's member BYTE-EQUAL to the SERVED registration — the registry
  // is read live here, so the comparison cannot be satisfied by another
  // restatement.
  test("the fixture's webPerformance declaration and signal are byte-equal to the served registration", async () => {
    const { registerWebPerformanceExposure, resetWebPerformanceRegistration } = await import(
      "../../engine/src/shared/exposure/registrations/web-performance.ts"
    );
    const { getExposureModule, listSignals } = await import(
      "../../engine/src/shared/exposure/index.ts"
    );
    resetWebPerformanceRegistration();
    registerWebPerformanceExposure();
    const servedModule = getExposureModule("webPerformance");
    expect(servedModule, "the webPerformance registration must be served").toBeDefined();
    const fixtureModule = (SCHEMA.exposureModules ?? []).find((m) => m.id === "webPerformance");
    expect(fixtureModule, "the fixture must carry the webPerformance declaration").toBeDefined();
    expect(fixtureModule!.id, "the fixture's module id must match the served registration").toBe(servedModule!.id);
    expect(fixtureModule!.title, "the fixture's module title must match the served registration — a retitled category leaves every room suite rehearsing stale words").toBe(servedModule!.title);
    expect(fixtureModule!.purpose, "the fixture's module purpose must match the served registration").toBe(servedModule!.purpose);
    const servedSignal = listSignals().find((s) => s.id === "webPerformance.typingMeanMaxMs");
    expect(servedSignal, "the registration's carried signal must be served").toBeDefined();
    const fixtureSignal = SCHEMA.signals.find((s) => s.id === "webPerformance.typingMeanMaxMs");
    expect(fixtureSignal, "the fixture must carry the registration's signal").toBeDefined();
    expect(fixtureSignal!.module, "the fixture's signal module must match the served registration").toBe(servedSignal!.module);
    expect(fixtureSignal!.name, "the fixture's signal name must match the served registration").toBe(servedSignal!.name);
    expect(fixtureSignal!.description, "the fixture's signal description must match the served registration verbatim — a shortened paraphrase is a rotted wire the room suites cannot see").toBe(servedSignal!.description);
    expect(fixtureSignal!.type, "the fixture's signal type must match the served registration").toBe(servedSignal!.type);
    expect(fixtureSignal!.unit, "the fixture's signal unit must match the served registration").toBe(servedSignal!.unit);
    resetWebPerformanceRegistration();
  });
});

describe("the save verb's served words", () => {
  test("the declared descriptor is found; an absent manifest yields null", () => {
    expect(saveDescriptor(SCHEMA)?.title).toBe("Save");
    expect(saveDescriptor(null)).toBeNull();
    expect(saveDescriptor({ ...SCHEMA, blockActions: undefined } as unknown as UiSchema)).toBeNull();
  });
});

describe("the raw-key law (mutation-tested both ways)", () => {
  test("mutation: a label that IS the raw key is flagged", () => {
    expect(labelViolation("context.maxContext", "context.maxContext")).toMatch(/raw key/);
  });

  test("mutation: a dotted internal id as label is flagged", () => {
    expect(labelViolation("tools.parallel_cap", "x")).toMatch(/dotted internal id/);
  });

  test("mutation: snake_case labels are flagged", () => {
    expect(labelViolation("parallel_cap", "x")).toMatch(/snake_case/);
  });

  test("mutation: an empty label is flagged", () => {
    expect(labelViolation("   ", "x")).toMatch(/empty/);
  });

  test("plain behavior words pass (no false positives)", () => {
    expect(labelViolation("Parallel tool calls", "tools.parallelCap")).toBeNull();
    expect(labelViolation("Search Threshold", "search.threshold")).toBeNull();
  });
});


describe("token quantity entry", () => {
  test.each([["32k",32000,"32000"],["1.5M",1500000,"1500000"],[".125k",125,"125"],["1.2345678901234567",1.2345678901234567,"1.2345678901234567"],["00032.00",32,"32"],["9007199254740991",9007199254740991,"9007199254740991"]])("%s retains exact decimal JSON meaning", (raw,value,expanded) => expect(parseTokenQuantity(String(raw))).toEqual({value,expanded}));
  test.each(["0","-1","Infinity","1e3","1.23.4k","1ki","9007199254740992","1.23456789012345678"])("invalid or rounded quantity is refused: %s", raw => expect(parseTokenQuantity(raw)).toBeNull());
  test("blank is omitted and a long trailing-zero decimal stays exact", () => {
    expect(parseTokenQuantity("  ")).toBeUndefined();
    expect(parseTokenQuantity("1"+"0".repeat(100000)+"1")).toBeNull();
    expect(parseTokenQuantity("1."+"0".repeat(100000))).toEqual({value:1,expanded:"1"});
  });
});
