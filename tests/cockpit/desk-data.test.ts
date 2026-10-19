// @vitest-environment node
/**
 * DESK pure data layer (§3.4–3.5) — decoders + the two mechanical honesty
 * guards, MUTATION-TESTED:
 *
 *   - EVERY BAR IS MEASURED: a strip's bar fraction must be exactly the
 *     served tokens over the served total (`stripBarViolations`); a
 *     fabricated bar (equal-width fallback, stale total, invented strip)
 *     must be flagged — weakening the validator turns the self-checks red.
 *
 *   - THE SHOWN NUMBER IS THE SENT NUMBER: the trim handle's numbering is
 *     the FULL saved conversation's user-turn numbering — the numbering
 *     `run.compose/trim { beforeTurn }` consumes — mapped from the served
 *     post-trim window by `trimNumbering` (offset = recorded trim − 1).
 */
import { describe, expect, test } from "vitest";

import {
  decodeBreakerRows,
  decodeCompose,
  decodeItemDetail,
  decodeToolCalls,
  itemBodyViolations,
  executingToolName,
  fmtMs,
  fmtPercent,
  fmtTokens,
  fullTurnOfItem,
  relabelHistoryItem,
  stripBarViolations,
  stripsFrom,
  toolsEdgeSummary,
  trimNumbering,
  type ComposeView,
  type StripView,
} from "../../src/cockpit/desk/desk-data.ts";

// ── Fixtures: a served run.compose read ─────────────────────────────────────

const WIRE = {
  channels: [
    {
      id: "system",
      tokens: 3211,
      items: [{ id: "system-prompt", label: "system prompt — project context", tokens: 3211 }],
    },
    {
      id: "memories",
      tokens: 812,
      items: [
        { id: "mem-1", label: "[insight] prefers tabs", tokens: 500 },
        { id: "mem-2", label: "[fact] repo uses pnpm", tokens: 312 },
      ],
    },
    {
      id: "history",
      tokens: 9404,
      items: [
        { id: "turn-0", label: "context frame (summarized prior conversation)", tokens: 1000 },
        { id: "turn-1", label: "turn 1: fix the reader", tokens: 4000 },
        { id: "turn-2", label: "turn 2: now the writer", tokens: 4404 },
      ],
    },
    { id: "toolResults", tokens: 2006, items: [{ id: "call-1", label: "tool result (call-1)", tokens: 2006 }] },
    {
      id: "toolSchemas",
      tokens: 6808,
      items: [
        { id: "tool-schemas", label: "tool schemas (46 tools) — every enabled tool's JSON schema, sent with each request", tokens: 6808 },
      ],
    },
  ],
  limit: 100_000,
  settings: { pinnedMemoryIds: ["mem-1"], mutedChannels: [], mutedMemoryIds: [] },
};

const TOTAL = 3211 + 812 + 9404 + 2006 + 6808;

describe("decodeCompose — served wire only, absence over guessing", () => {
  test("decodes a served read and totals the served channels", () => {
    const view = decodeCompose(WIRE)!;
    expect(view).not.toBeNull();
    expect(view.total).toBe(TOTAL);
    expect(view.limit).toBe(100_000);
    expect(view.channels).toHaveLength(5);
    expect(view.settings.pinnedMemoryIds).toEqual(["mem-1"]);
    expect(view.settings.trimBeforeTurn).toBeUndefined();
  });

  test("malformed wire → null (never a partial guess)", () => {
    expect(decodeCompose(null)).toBeNull();
    expect(decodeCompose({})).toBeNull();
    expect(decodeCompose({ channels: [], limit: 0 })).toBeNull(); // no limit served
    expect(
      decodeCompose({ channels: [{ id: "files", tokens: 1, items: [] }], limit: 10 }),
    ).toBeNull(); // a channel this assembly does not serve
    expect(
      decodeCompose({ channels: [{ id: "system", tokens: "3k", items: [] }], limit: 10 }),
    ).toBeNull(); // non-measured tokens
  });
});

describe("stripsFrom — every bar is tokens/total, nothing else", () => {
  const view = decodeCompose(WIRE)!;
  const strips = stripsFrom(view);

  test("fractions are exactly served tokens over served total", () => {
    for (const strip of strips) {
      expect(strip.fraction).toBe(strip.channel.tokens / TOTAL);
    }
    expect(strips.reduce((s, x) => s + x.fraction, 0)).toBeCloseTo(1, 12);
  });

  test("an empty composition renders zero-width bars, not NaN", () => {
    const empty = decodeCompose({
      channels: [{ id: "system", tokens: 0, items: [] }],
      limit: 10,
      settings: {},
    })!;
    expect(stripsFrom(empty)[0]!.fraction).toBe(0);
  });

  test("names carry the measured counts in plain words", () => {
    expect(strips.find((s) => s.channel.id === "memories")!.name).toBe("Memories (2)");
    expect(strips.find((s) => s.channel.id === "history")!.name).toBe("History · 2 turns sent");
    expect(strips.find((s) => s.channel.id === "toolSchemas")!.name).toBe("Tool schemas");
  });

  test("the guard passes the honest derivation", () => {
    expect(stripBarViolations(strips, view)).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS: a fabricated bar must be flagged ──────────────
  test("mutation: an equal-width fallback bar is flagged", () => {
    const faked: StripView[] = strips.map((s) => ({ ...s, fraction: 1 / strips.length }));
    expect(stripBarViolations(faked, view).length).toBeGreaterThan(0);
  });

  test("mutation: a bar computed against the LIMIT instead of the total is flagged", () => {
    const faked = strips.map((s) => ({ ...s, fraction: s.channel.tokens / view.limit }));
    expect(stripBarViolations(faked, view).length).toBeGreaterThan(0);
  });

  test("mutation: an invented strip (no served channel) is flagged", () => {
    const invented: StripView = {
      channel: { id: "memories", tokens: 1, items: [] },
      name: "phantom",
      fraction: 0.5,
    };
    const view2: ComposeView = { ...view, channels: view.channels.filter((c) => c.id !== "memories") };
    expect(stripBarViolations([...stripsFrom(view2), invented], view2).length).toBeGreaterThan(0);
  });
});

describe("trimNumbering — the shown number IS the sent number", () => {
  test("no recorded trim: displayed numbering equals full numbering", () => {
    const n = trimNumbering(decodeCompose(WIRE)!)!;
    expect(n.offset).toBe(0);
    expect(n.current).toBe(1);
    expect(n.min).toBe(1);
    expect(n.max).toBe(2); // keep only the last displayed turn
    expect(fullTurnOfItem("turn-2", n)).toBe(2);
    expect(fullTurnOfItem("turn-0", n)).toBeNull(); // the context frame is not a turn
  });

  test("recorded trim beforeTurn=4: displayed turn k is full turn k+3", () => {
    const wire = {
      ...WIRE,
      settings: { ...WIRE.settings, trimBeforeTurn: 4 },
    };
    const n = trimNumbering(decodeCompose(wire)!)!;
    expect(n.offset).toBe(3);
    // The handle sits at the recorded trim point, spelled in FULL numbering:
    expect(n.current).toBe(4);
    // …and dragging to displayed turn 2 SENDS beforeTurn 5 — the same number
    // the handle would then show:
    expect(fullTurnOfItem("turn-2", n)).toBe(5);
    // The range starts at turn 1, not at the current point: the slider can
    // WIDEN the window too (a trim that could only tighten would be a
    // one-way verb, §3.4) — so ArrowLeft below the current point drafts a
    // real widening, never a silently dead key (UIE-010).
    expect(n.min).toBe(1);
    expect(n.max).toBe(5);
  });

  test("history item labels are re-spelled in the action's numbering", () => {
    const wire = { ...WIRE, settings: { ...WIRE.settings, trimBeforeTurn: 4 } };
    const n = trimNumbering(decodeCompose(wire)!)!;
    expect(relabelHistoryItem({ id: "turn-1", label: "turn 1: fix the reader", tokens: 4 }, n).label)
      .toBe("turn 4: fix the reader");
    // Non-turn items pass through untouched.
    const frame = { id: "turn-0", label: "context frame (summarized prior conversation)", tokens: 1 };
    expect(relabelHistoryItem(frame, n)).toEqual(frame);
  });

  test("no displayed turns → no numbering (nothing to trim)", () => {
    const wire = {
      channels: [{ id: "history", tokens: 0, items: [] }],
      limit: 10,
      settings: {},
    };
    expect(trimNumbering(decodeCompose(wire)!)).toBeNull();
  });
});

describe("decodeBreakerRows + toolsEdgeSummary (§3.5)", () => {
  const ROWS = [
    { id: "edit_file", label: "edit file", description: "Supplied tool text — preserved verbatim.", state: "on", calls: 12, lastMs: 3200 },
    { id: "run_command", label: "run command", state: "on", calls: 4, lastMs: 11 },
    { id: "web_fetch", label: "web fetch", state: "off", calls: 0 },
    {
      id: "search",
      label: "search",
      state: "tripped",
      calls: 7,
      lastError: "3 failures in a row",
      tripAfterFailures: 3,
    },
  ];

  test("decodes served rows; malformed → null", () => {
    const rows = decodeBreakerRows(ROWS)!;
    expect(rows).toHaveLength(4);
    expect(rows[0]!.lastMs).toBe(3200);
    expect(rows[0]!.description).toBe(ROWS[0]!.description);
    expect(rows[1]!.description).toBeUndefined();
    expect(decodeBreakerRows([{ ...ROWS[0], description: 42 }])![0]!.description).toBeUndefined();
    expect(rows[3]!.state).toBe("tripped");
    expect(rows[3]!.tripAfterFailures).toBe(3);
    expect(decodeBreakerRows({})).toBeNull();
    expect(decodeBreakerRows([{ id: "x", label: "x", state: "maybe", calls: 0 }])).toBeNull();
    expect(decodeBreakerRows([{ id: "x", label: "x", state: "on", calls: -1 }])).toBeNull();
  });

  test("edge summary exists ONLY when ≠ all-on (dark when normal)", () => {
    expect(toolsEdgeSummary(decodeBreakerRows(ROWS)!)).toBe("tools 2/4");
    const allOn = decodeBreakerRows(ROWS.map((r) => ({ ...r, state: "on" })))!;
    expect(toolsEdgeSummary(allOn)).toBeNull();
    expect(toolsEdgeSummary([])).toBeNull();
  });
});

describe("executingToolName — glow only for a call genuinely in flight", () => {
  const running = { role: "tool", toolCall: { name: "edit_file", status: "running" } };
  const done = { role: "tool", toolCall: { name: "search", status: "done" } };

  test("the latest RUNNING tool while streaming; null otherwise", () => {
    expect(executingToolName([done, running], true)).toBe("edit_file");
    expect(executingToolName([running, done], true)).toBe("edit_file");
    expect(executingToolName([done], true)).toBeNull();
    expect(executingToolName([], true)).toBeNull();
  });

  test("a dropped stream never leaves a phantom glow", () => {
    // Same messages, stream no longer live → no executing tool.
    expect(executingToolName([done, running], false)).toBeNull();
  });
});

describe("formatting — measured numbers, plain register", () => {
  test("tokens, durations, percents", () => {
    expect(fmtTokens(15_921)).toBe("15,921");
    expect(fmtMs(11)).toBe("11ms");
    expect(fmtMs(3200)).toBe("3.2s");
    expect(fmtPercent(0.16)).toBe("16%");
  });
});


// ── THE REAL BODY (`run.composeItem`) ──────────────────────────────────────
//
// The desk's whole promise is "see exactly what you are about to send". A
// detail view that renders a placeholder, a summary, or an invented
// "(empty)" breaks that promise silently, which is worse than showing
// nothing. `itemBodyViolations` is the mechanical statement of the rule, and
// these self-checks fail if it is ever weakened.

const SERVED_ITEM = {
  channel: "history",
  itemId: "turn-3",
  label: "turn 3: use the edit tool",
  tokens: 323,
  origin: "the messages of this turn, exactly as they go on the wire (2 of them)",
  parts: [
    { role: "user", field: "content", text: "use the edit tool to change index.ts" },
    { role: "assistant", field: "tool_calls", text: '[{"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"index.ts\\"}"}}]' },
  ],
  withheldChars: 0,
};

describe("decodeItemDetail — a body arrives whole, or not at all", () => {
  test("the served body decodes to exactly what was sent", () => {
    const view = decodeItemDetail(SERVED_ITEM);
    expect(view).not.toBeNull();
    expect(view!.channel).toBe("history");
    expect(view!.tokens).toBe(323);
    expect(view!.withheldChars).toBe(0);
    expect(view!.absence).toBeNull();
    expect(view!.parts.map((p) => p.field)).toEqual(["content", "tool_calls"]);
    expect(view!.parts[0]!.text).toBe("use the edit tool to change index.ts");
  });

  test("an honest absence survives decoding as an absence, not as empty text", () => {
    const view = decodeItemDetail({
      ...SERVED_ITEM,
      parts: [],
      absence: "this result went out empty — there is no text to show",
    });
    expect(view!.parts).toEqual([]);
    expect(view!.absence).toContain("went out empty");
  });

  test("a malformed member yields NULL — never a partial body", () => {
    expect(decodeItemDetail(null)).toBeNull();
    expect(decodeItemDetail({ ...SERVED_ITEM, channel: "files" })).toBeNull();
    expect(decodeItemDetail({ ...SERVED_ITEM, tokens: "323" })).toBeNull();
    expect(decodeItemDetail({ ...SERVED_ITEM, withheldChars: -1 })).toBeNull();
    // A part whose field is not a real wire field: the shape is unknown, so
    // the whole body is refused rather than half-rendered.
    expect(
      decodeItemDetail({ ...SERVED_ITEM, parts: [{ role: "user", field: "summary", text: "x" }] }),
    ).toBeNull();
    // A part with no text at all.
    expect(decodeItemDetail({ ...SERVED_ITEM, parts: [{ role: "user", field: "content" }] })).toBeNull();
  });
});

describe("itemBodyViolations — no fabricated body may reach the screen", () => {
  const served = decodeItemDetail(SERVED_ITEM)!;

  test("the served body renders itself with no violations", () => {
    expect(itemBodyViolations(served, served)).toEqual([]);
  });

  test("a shorter rendering of the same text is allowed (the fold)", () => {
    const folded = decodeItemDetail({
      ...SERVED_ITEM,
      parts: [
        { ...SERVED_ITEM.parts[0], text: "use the edit tool" },
        SERVED_ITEM.parts[1],
      ],
    })!;
    expect(itemBodyViolations(folded, served)).toEqual([]);
  });

  // ── MUTATIONS: each of these must be caught ────────────────────────────
  test("mutation: a PLACEHOLDER body is flagged", () => {
    const placeholder = decodeItemDetail({
      ...SERVED_ITEM,
      parts: [{ role: "user", field: "content", text: "(loading…)" }, SERVED_ITEM.parts[1]],
    })!;
    const hits = itemBodyViolations(placeholder, served);
    expect(hits.some((h) => h.includes("fabricated body"))).toBe(true);
  });

  test("mutation: an invented extra part is flagged", () => {
    const extra = decodeItemDetail({
      ...SERVED_ITEM,
      parts: [...SERVED_ITEM.parts, { role: "system", field: "content", text: "and more" }],
    })!;
    expect(itemBodyViolations(extra, served).length).toBeGreaterThan(0);
  });

  test("mutation: a part relabelled as a different role or field is flagged", () => {
    const mislabelled = decodeItemDetail({
      ...SERVED_ITEM,
      parts: [{ ...SERVED_ITEM.parts[0], role: "assistant" }, SERVED_ITEM.parts[1]],
    })!;
    expect(itemBodyViolations(mislabelled, served).some((h) => h.includes("labelled"))).toBe(true);
  });

  test("mutation: hiding the server's own withheld count is flagged", () => {
    const truncated = decodeItemDetail({ ...SERVED_ITEM, withheldChars: 4000 })!;
    const hits = itemBodyViolations(served, truncated);
    expect(hits.some((h) => h.includes("withheld count"))).toBe(true);
  });
});

describe("decodeToolCalls — a call is rendered as the call it is", () => {
  test("the wire array becomes name + parsed arguments", () => {
    const calls = decodeToolCalls(SERVED_ITEM.parts[1]!.text);
    expect(calls).not.toBeNull();
    expect(calls!).toHaveLength(1);
    expect(calls![0]!.name).toBe("read_file");
    expect(calls![0]!.args).toEqual({ path: "index.ts" });
  });

  test("arguments that are not JSON are handed on as the string they are", () => {
    const calls = decodeToolCalls('[{"id":"c1","function":{"name":"run","arguments":"ls -la"}}]');
    expect(calls![0]!.args).toBe("ls -la");
  });

  test("anything that is not the array it claims to be yields NULL (raw text wins)", () => {
    expect(decodeToolCalls("not json")).toBeNull();
    expect(decodeToolCalls("[]")).toBeNull();
    expect(decodeToolCalls('[{"id":"c1"}]')).toBeNull();
    expect(decodeToolCalls('{"function":{"name":"x"}}')).toBeNull();
  });
});
