// @vitest-environment node
/**
 * COCKPIT spine blocks — the pure pieces and the placement guards.
 *
 * The END-TO-END behavior of every action (pin/mute/trim, set/arm/reset,
 * set/capture/clear) is proven over real HTTP in
 * tests/prevention/block-action-owner.test.ts (the liveness ratchet). This
 * file pins what that file cannot see:
 *
 *   A. packSpectrum — the category fold + Int16 packing is hand-verifiable,
 *      exhaustive over the harness event-type registry, and honest about
 *      clamping.
 *   B. arm predicate validation — the ambient-vocabulary gate refuses what
 *      the live stream cannot bind, and string literals are never mistaken
 *      for identifiers.
 *   C. breaker config carrier — the breaker slice merges into the override
 *      row's config without destroying foreign keys.
 *   D. the ledger `until` bound on the breaker's event fold — the ranged-
 *      read convention against REAL recorded events.
 *   E. PLACEMENT (mechanical) — the run loop's next-boundary honor point
 *      and the run start's compose hookup sit exactly where the boundary
 *      semantics require: honor INSIDE the turn loop and BEFORE the model
 *      stream starts (so a flip can never land mid-call), compose BEFORE
 *      the context manager is seeded. Moving either is a failing test, not
 *      a silent semantics change.
 */
import { describe, test, expect, vi } from "vitest";

// Route the singleton timeline ledger into a temp world BEFORE config loads.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-cockpit-spine-root-");
});

import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { TIMELINE_EVENT_TYPES, type TimelineSpectrum } from "../../server/kernel/canonical.ts";
import { getTimelineRecorder } from "../../server/observability/timeline-bridge.ts";
import {
  EVENT_TYPE_CATEGORY,
  SWEEP_CATEGORIES,
  packSpectrum,
} from "../../server/blocks/spectrum.ts";
import {
  ARM_PREDICATE_VOCABULARY,
  predicateRoots,
  validatePredicate,
} from "../../server/blocks/arm.ts";
import {
  breakerConfigOf,
  foldToolEvents,
  withBreakerConfig,
} from "../../server/blocks/breaker.ts";
import type { ToolSettingRow } from "../../server/db/client.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

// ── A. spectrum packing ────────────────────────────────────────────────────

function decodePacked(packed: string): Int16Array {
  const buf = Buffer.from(packed, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

describe("packSpectrum", () => {
  const spectrum: TimelineSpectrum = {
    events: 7,
    unbinnable: 0,
    t0: "2026-07-01T00:00:00.000Z",
    t1: "2026-07-01T00:30:00.000Z",
    binMs: 600_001,
    bins: 3,
    eventTypeBins: {
      run: [1, 0, 0], // lifecycle
      turn: [0, 2, 0], // lifecycle — folds into the SAME row as run
      tool: [0, 1, 0], // tool
      memory: [0, 0, 3], // context
    },
    errorBins: [0, 1, 0],
  };

  test("folds event types into category rows, hand-checkable", () => {
    const { header, packed } = packSpectrum(spectrum);
    expect(header.rows).toBe(SWEEP_CATEGORIES.length + 1);
    expect(header.errorRow).toBe(SWEEP_CATEGORIES.length);
    expect(header.bins).toBe(3);
    expect(header.t0).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
    expect(header.clamped).toBe(false);
    expect(header.attributedOnly).toBe(true);
    const matrix = decodePacked(packed);
    expect(matrix.length).toBe(header.rows * 3);
    const row = (category: string) => SWEEP_CATEGORIES.indexOf(category as never);
    // lifecycle = run + turn, per bin.
    expect([...matrix.slice(row("lifecycle") * 3, row("lifecycle") * 3 + 3)]).toEqual([1, 2, 0]);
    expect([...matrix.slice(row("tool") * 3, row("tool") * 3 + 3)]).toEqual([0, 1, 0]);
    expect([...matrix.slice(row("context") * 3, row("context") * 3 + 3)]).toEqual([0, 0, 3]);
    expect([...matrix.slice(header.errorRow * 3, header.errorRow * 3 + 3)]).toEqual([0, 1, 0]);
    // Every counted event is in the matrix exactly once (categories sum).
    let total = 0;
    for (let i = 0; i < header.errorRow * 3; i++) total += matrix[i]!;
    expect(total).toBe(spectrum.events);
    // CANONICAL SEMANTICS: the error row is an OVERLAY — declared in the
    // header, and per bin it never exceeds the category stack (an error
    // event is counted in its category row AND redrawn in the ridge).
    expect(header.errorRowIsOverlay).toBe(true);
    for (let bin = 0; bin < 3; bin++) {
      let stack = 0;
      for (let r = 0; r < header.errorRow; r++) stack += matrix[r * 3 + bin]!;
      expect(matrix[header.errorRow * 3 + bin]!).toBeLessThanOrEqual(stack);
    }
  });

  test("a cell past Int16 range is clamped AND the header admits it", () => {
    const { header, packed } = packSpectrum({
      ...spectrum,
      events: 40_000,
      eventTypeBins: { run: [40_000, 0, 0] },
      errorBins: [0, 0, 0],
    });
    expect(header.clamped).toBe(true);
    expect(decodePacked(packed)[0]).toBe(32_767);
  });

  test("the category table is exhaustive over the harness registry", () => {
    for (const eventType of TIMELINE_EVENT_TYPES) {
      const category = EVENT_TYPE_CATEGORY[eventType];
      expect(category, `event type "${eventType}" has no category`).toBeDefined();
      expect(SWEEP_CATEGORIES).toContain(category);
    }
  });
});

// ── B. arm predicate validation ────────────────────────────────────────────

describe("arm predicate validation", () => {
  test("vocabulary-bound predicates pass; unknown roots and bad syntax are refused", () => {
    expect(() => validatePredicate("event.type == 'tool' && tool.failed")).not.toThrow();
    expect(() => validatePredicate("context.pct >= 80")).not.toThrow();
    expect(() => validatePredicate("check.status == 'failed' || event.errorCode != null")).not.toThrow();
    // Unknown root: nothing on the live stream binds it.
    expect(() => validatePredicate("database.rows > 0")).toThrow(/unknown vocabulary/);
    // Malformed: does not parse under the shared grammar.
    expect(() => validatePredicate("event.type ==")).toThrow(/does not parse/);
  });

  test("string literals are never mistaken for identifiers", () => {
    // 'database.rows' appears only INSIDE a string — the roots are event only.
    expect(predicateRoots("event.description == 'database.rows broke'")).toEqual(["event"]);
    expect(() => validatePredicate("event.description == 'database.rows broke'")).not.toThrow();
  });

  test("every documented root is actually accepted", () => {
    for (const root of Object.keys(ARM_PREDICATE_VOCABULARY)) {
      expect(() => validatePredicate(`${root}.anything == 1`)).not.toThrow();
    }
  });
});

// ── C. breaker config carrier ──────────────────────────────────────────────

describe("breaker config slice", () => {
  const row = (config: unknown): ToolSettingRow => ({
    id: "row-1",
    user_id: "u-1",
    tool_name: "grep",
    enabled: true,
    config,
    updated_at: "2026-07-01T00:00:00.000Z",
  });

  test("merges into existing config without destroying foreign keys", () => {
    const merged = withBreakerConfig({ otherOwner: { keep: true } }, { tripAfterFailures: 3 });
    expect(merged).toEqual({ otherOwner: { keep: true }, breaker: { tripAfterFailures: 3 } });
    // An empty slice REMOVES the breaker key, foreign keys stay.
    expect(withBreakerConfig(merged, {})).toEqual({ otherOwner: { keep: true } });
  });

  test("decodes only well-formed slices; foreign shapes are an empty config, never a crash", () => {
    expect(breakerConfigOf(row({ breaker: { tripAfterFailures: 2 } }))).toEqual({ tripAfterFailures: 2 });
    expect(breakerConfigOf(row(null))).toEqual({});
    expect(breakerConfigOf(row("garbage"))).toEqual({});
    expect(breakerConfigOf(row({ breaker: "garbage" }))).toEqual({});
    expect(breakerConfigOf(undefined)).toEqual({});
  });
});

// ── D. the `until` bound on the breaker's ledger fold ──────────────────────

describe("foldToolEvents against real recorded events", () => {
  test("counts recorded tool events per name, and `until` excludes later ones (inclusive bound)", async () => {
    const recorder = getTimelineRecorder();
    // Unique per invocation: with the shared worker module-registry the
    // timeline singleton may be another file's (persistent) store, so a
    // fixed run id would accumulate counts across runs.
    const runId = `run-until-${crypto.randomUUID()}`;
    recorder.recordEvent({
      eventType: "tool",
      description: "tool:grep",
      outcome: "succeeded",
      correlation: { runId },
    });
    await new Promise((r) => setTimeout(r, 15));
    const midpoint = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    recorder.recordEvent({
      eventType: "tool",
      description: "tool:grep",
      outcome: "failed",
      error: { category: "tool", code: "tool_failed", message: "grep exploded", retryable: false },
      correlation: { runId },
    });

    const live = foldToolEvents([runId]);
    expect(live.get("grep")?.calls).toBe(2);
    // The LAST recorded call failed, so the live row carries its error.
    expect(live.get("grep")?.lastError).toBe("grep exploded");

    // Planted head: at the midpoint only the first (successful) call exists.
    const until = foldToolEvents([runId], midpoint);
    expect(until.get("grep")?.calls).toBe(1);
    expect(until.get("grep")?.lastError).toBeUndefined();

    // An empty run scope is a proven-empty fold, not a whole-ledger read.
    expect(foldToolEvents([]).size).toBe(0);
  });
});

// ── E. placement — the honor points sit where the semantics require ────────

describe("run.ts hookup placement (mechanical)", () => {
  const source = stripCommentsOnly(runPathSource());

  test("the tools.breaker honor point is INSIDE the turn loop, BEFORE the model stream — never mid-call", () => {
    const loopStart = source.indexOf("while (true) {");
    expect(loopStart).toBeGreaterThan(-1);
    const honor = source.indexOf("honorToolBoundary(");
    expect(honor, "run.ts no longer calls honorToolBoundary — the next-boundary contract is unwired").toBeGreaterThan(-1);
    // Exactly one call site: a second one would be a second boundary owner.
    expect(source.split("honorToolBoundary(").length - 1).toBe(1);
    // Inside the loop…
    expect(honor).toBeGreaterThan(loopStart);
    // …and before the turn's model stream begins, so the re-derived tool
    // definitions are what THIS turn's request carries and an in-flight call
    // can never be cut.
    const streamCall = source.indexOf("for await (const event of streamChat(");
    expect(streamCall).toBeGreaterThan(-1);
    expect(honor).toBeLessThan(streamCall);
    // The flip lands on the variables the request builder reads.
    expect(source).toContain("toolManifest = boundary.manifest");
    expect(source).toContain("toolDefinitions = boundary.definitions");
    expect(source).toContain("let toolManifest");
    expect(source).toContain("let toolDefinitions");
  });

  test("the run.compose hookup runs BEFORE the context manager is seeded", () => {
    const compose = source.indexOf("applyComposeAdjustments(");
    expect(compose, "run.ts no longer applies compose adjustments — the desk's verbs are decorative").toBeGreaterThan(-1);
    const seed = source.indexOf("seedContextManagerFromHistory(");
    expect(seed).toBeGreaterThan(-1);
    expect(compose).toBeLessThan(seed);
    // The seed consumes the ADJUSTED history, not the raw one.
    expect(source).toContain("seedContextManagerFromHistory(contextManager, effectiveHistory)");
  });
});


// ── F. ONE ASSEMBLY, TWO PROJECTIONS (`run.compose` + `run.composeItem`) ────
//
// The context desk's promise is "this is exactly what is about to be sent".
// The strips serve the numbers and `run.composeItem` serves the words, and
// the ONLY way those two can be guaranteed to describe the same thing is for
// both to be projections of one assembly pass. A detail handler that re-read
// the message rows, or re-ran retrieval, would answer with text that is
// plausible and possibly wrong — unredacted, untrimmed, pre-adjustment — and
// nothing on screen would say so. That is the failure this pins.

describe("compose.ts — the body and the number come from ONE assembly", () => {
  const source = stripCommentsOnly(read("server/blocks/compose.ts"));

  /**
   * The body of a top-level `function name(` in the source, ending at the
   * first `}` ALONE on its own line. A multi-line return-type annotation
   * closes with `} {`, which is not alone on its line — so the scan is not
   * fooled into stopping at the signature.
   */
  function fnBody(src: string, name: string): string {
    const at = src.indexOf(`function ${name}(`);
    if (at === -1) return "";
    const close = src.indexOf("\n}\n", at);
    return close === -1 ? src.slice(at) : src.slice(at, close);
  }

  /**
   * THE PREVIEW MUST NOT EVICT BEFORE IT KNOWS WHAT THE RUN IS SENDING.
   *
   * `assembleComposition` seeded the manager and called `manager.trim()`
   * immediately — several lines BEFORE it read the tool manifest. So it
   * evicted as though the run were sending no retrieval tool, while the run it
   * claims to mirror prices the same conversation against the manifest it
   * actually carries. Driven on one eight-artifact conversation: the compose
   * ordering kept 7 messages and 519 tokens, the run ordering 17 and 1,254.
   * A desk strip that says "this is exactly what is about to be sent" was
   * describing a smaller assembly than the run makes.
   *
   * Deriving the LLM input is what prices and trims, so the preview needs no
   * trim of its own — and must not have one, because a trim before the
   * manifest read is an irreversible eviction at the wrong price.
   */
  test("the preview does not trim before it has read the manifest", () => {
    const body = fnBody(source, "assembleComposition");
    expect(body, "assembleComposition is missing — this guard's subject has vanished").not.toBe("");
    expect(
      body.match(/\.trim\(\)/g) ?? [],
      "the composition preview trims on its own — deriving the LLM input is what prices and trims",
    ).toEqual([]);
    // And the order it does keep: the manifest is read, then the LLM input is
    // derived from it. Both indices are asserted present so a renamed call
    // fails loudly rather than comparing -1 against -1.
    const manifest = body.indexOf("getEnabledToolManifestForSession(");
    const derive = body.indexOf("buildLLMInput(");
    expect(manifest, "the preview no longer reads the tool manifest").toBeGreaterThan(-1);
    expect(derive, "the preview no longer derives the LLM input").toBeGreaterThan(-1);
    expect(manifest).toBeLessThan(derive);
  });

  test("both reads project the same assembler, and there is only one", () => {
    // Exactly one function assembles the next turn.
    expect(source.split("function assembleComposition(").length - 1).toBe(1);
    for (const projection of ["buildNextTurnComposition", "composeItemDetail"]) {
      const body = fnBody(source, projection);
      expect(body, `${projection} is missing`).not.toBe("");
      expect(
        body.includes("assembleComposition("),
        `${projection} must project the one assembly, not build its own`,
      ).toBe(true);
    }
  });

  test("the detail read RE-DERIVES nothing — no second opinion about what is sent", () => {
    const body = fnBody(source, "composeItemDetail");
    // Every owner that could produce a DIFFERENT answer than the assembly's.
    for (const reFetch of [
      "buildConversationHistory(",
      "retrieveRelevantMemories(",
      "assembleSystemPrompt(",
      "buildLLMInput(",
      "getMemoryEntry(",
      "listMessages(",
    ]) {
      expect(
        body.includes(reFetch),
        `composeItemDetail calls ${reFetch} — a re-fetch can differ from what is sent`,
      ).toBe(false);
    }
  });

  test("the item read is ownership-gated exactly as its sibling is", () => {
    // Both handlers resolve the caller before touching the chat, and the
    // assembly itself refuses a chat that is not theirs.
    expect(source.split("await requireUserContext(ctx, db)").length - 1).toBeGreaterThanOrEqual(2);
    expect(fnBody(source, "assembleComposition")).toContain("throw new NotFoundError");
  });

  test("a body past the ceiling is COUNTED, never silently cut", () => {
    const body = fnBody(source, "capParts");
    expect(body).toContain("COMPOSE_ITEM_MAX_CHARS");
    expect(body).toContain("withheldChars");
    // The remainder is measured from the real length, not guessed.
    expect(body).toContain("part.text.length - budget");
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────
  test("mutation: a detail handler that re-fetched would be caught", () => {
    const bad = [
      "function composeItemDetail(db, args) {",
      "  const history = buildConversationHistory(db, args);",
      "  return history;",
      "}",
      "",
    ].join("\n");
    expect(fnBody(bad, "composeItemDetail")).toContain("buildConversationHistory(");
  });

  test("mutation: a projection that built its own assembly would be caught", () => {
    const bad = [
      "function buildNextTurnComposition(db, args) {",
      "  return { channels: [] };",
      "}",
      "",
    ].join("\n");
    expect(fnBody(bad, "buildNextTurnComposition").includes("assembleComposition(")).toBe(false);
  });
});
