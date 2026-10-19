// @vitest-environment node
/**
 * The bin-source seam (§6.6): the painter consumes ONE shape whatever the
 * source. The decoder targets the LANDED `sweep.spectrum` wire shape
 * (server/blocks/spectrum.ts — category-major Int16 rows + error row last,
 * JSON header): round-trips exactly, rejects lying payloads, and the
 * spectrum source re-bins without inventing events. The category vocabulary
 * is cross-checked against the server module so the two ends cannot drift.
 */
import { describe, expect, test } from "vitest";

import {
  SERVER_CATEGORY_TO_SWEEP,
  clientWindowSource,
  decodeSpectrumRead,
  encodeSpectrumPacked,
  spectrumSource,
  type SpectrumReadWire,
} from "../../src/cockpit/sweep/bin-source";
import { SWEEP_CATEGORY_IDS } from "../../src/cockpit/sweep/categories";
import { assertBinsConsistent } from "../../src/cockpit/sweep/bins";
import {
  SweepHonestyViolation,
  type SweepEvent,
} from "../../src/cockpit/sweep/types";
// The server block's vocabulary + packer — the drift guards for the seam.
import {
  packSpectrum,
  SWEEP_CATEGORIES as SERVER_SPECTRUM_CATEGORIES,
} from "../../server/blocks/spectrum.ts";

const CATS = SERVER_SPECTRUM_CATEGORIES;

function readOf(
  categoryRows: number[][],
  errorRow: number[],
  overrides: Partial<SpectrumReadWire["header"]> = {},
): SpectrumReadWire {
  const bins = errorRow.length;
  const events = categoryRows.reduce(
    (a, row) => a + row.reduce((x, y) => x + y, 0),
    0,
  );
  return {
    header: {
      categories: CATS,
      errorRow: CATS.length,
      errorRowIsOverlay: true,
      rows: CATS.length + 1,
      bins,
      binMs: 1000,
      t0: 0,
      t1: bins * 1000,
      events,
      unbinnable: 0,
      attributedOnly: true,
      clamped: false,
      ...overrides,
    },
    packed: encodeSpectrumPacked(categoryRows, errorRow),
  };
}

function rows(bins: number): number[][] {
  return CATS.map(() => new Array<number>(bins).fill(0));
}

describe("the seam cannot drift", () => {
  test("every server spectrum category maps to a sweep stack category", () => {
    for (const c of SERVER_SPECTRUM_CATEGORIES) {
      expect(
        SERVER_CATEGORY_TO_SWEEP[c],
        `server category "${c}" has no sweep mapping`,
      ).toBeDefined();
      expect(SWEEP_CATEGORY_IDS).toContain(SERVER_CATEGORY_TO_SWEEP[c]!);
    }
  });

  test("the SERVER's own packer declares errorRowIsOverlay: true — and its payload decodes", () => {
    // End-to-end pin of the on-wire field: pack with the real server code,
    // decode with the real client code. If either end drops or renames the
    // overlay declaration, this fails.
    const packed = packSpectrum({
      bins: 2,
      binMs: 1000,
      t0: new Date(0).toISOString(),
      t1: new Date(2000).toISOString(),
      events: 3,
      unbinnable: 0,
      eventTypeBins: { tool: [2, 0], error: [0, 1] },
      errorBins: [0, 1],
    });
    expect(packed.header.errorRowIsOverlay).toBe(true);
    const bins = decodeSpectrumRead(packed as unknown as SpectrumReadWire);
    expect(bins).not.toBeNull();
    // Overlay semantics on the real payload: the error event sits in its
    // category row AND the ridge (the documented double-count in totals);
    // header.events stays the true population.
    expect(packed.header.events).toBe(3);
  });

  test("a payload that will not declare the overlay is REFUSED (the field is load-bearing)", () => {
    const read = readOf(rows(1), [0]);
    const { errorRowIsOverlay: _dropped, ...withoutField } = read.header;
    expect(() =>
      decodeSpectrumRead({ header: withoutField, packed: read.packed } as unknown as SpectrumReadWire),
    ).toThrow(SweepHonestyViolation);
    expect(() =>
      decodeSpectrumRead({
        header: { ...read.header, errorRowIsOverlay: false },
        packed: read.packed,
      } as unknown as SpectrumReadWire),
    ).toThrow(SweepHonestyViolation);
  });
});

describe("spectrum decode", () => {
  test("decodes the landed layout, conserving every cell", () => {
    const cat = rows(3);
    cat[CATS.indexOf("tool")]![0] = 5;
    cat[CATS.indexOf("lifecycle")]![1] = 2;
    cat[CATS.indexOf("effect")]![2] = 32767; // Int16 max survives
    const err = [1, 0, 2];
    const bins = decodeSpectrumRead(readOf(cat, err));
    expect(bins).not.toBeNull();
    expect(bins!.source).toBe("spectrum");
    expect([...bins!.errors]).toEqual(err);
    expect(bins!.counts[0]![SWEEP_CATEGORY_IDS.indexOf("tool")]).toBe(5);
    expect(bins!.counts[1]![SWEEP_CATEGORY_IDS.indexOf("lifecycle")]).toBe(2);
    expect(bins!.counts[2]![SWEEP_CATEGORY_IDS.indexOf("effect")]).toBe(32767);
    assertBinsConsistent(bins!);
  });

  test("server categories MERGE into sweep lanes (aggregation, not fabrication)", () => {
    const cat = rows(1);
    cat[CATS.indexOf("agent")]![0] = 3; // agent → lifecycle
    cat[CATS.indexOf("lifecycle")]![0] = 2;
    const bins = decodeSpectrumRead(readOf(cat, [0]))!;
    expect(bins.counts[0]![SWEEP_CATEGORY_IDS.indexOf("lifecycle")]).toBe(5);
  });

  test("an honestly-empty scope decodes to null (absence, not a fake band)", () => {
    const read = readOf(rows(0), [], { t0: null, t1: null, bins: 0, binMs: 0, events: 0 });
    expect(decodeSpectrumRead(read)).toBeNull();
  });

  test("rejects an empty header that still claims events", () => {
    const read = readOf(rows(0), [], { t0: null, t1: null, bins: 0, binMs: 0, events: 5 });
    expect(() => decodeSpectrumRead(read)).toThrow(SweepHonestyViolation);
  });

  test("rejects a packed length that disagrees with the header", () => {
    const read = readOf(rows(2), [0, 0], { bins: 3, t1: 3000 });
    expect(() => decodeSpectrumRead(read)).toThrow(SweepHonestyViolation);
  });

  test("rejects negative (wrapped) cells", () => {
    const cat = rows(1);
    cat[0]![0] = -5;
    expect(() => decodeSpectrumRead(readOf(cat, [0], { events: -5 })))
      .toThrow(SweepHonestyViolation);
  });

  test("rejects an events claim the category cells do not support", () => {
    const cat = rows(1);
    cat[0]![0] = 2;
    expect(() => decodeSpectrumRead(readOf(cat, [0], { events: 99 })))
      .toThrow(SweepHonestyViolation);
  });

  test("rejects an unmappable category", () => {
    const read = readOf(rows(1), [0], { categories: ["nonsense", ...CATS.slice(1)] });
    expect(() => decodeSpectrumRead(read)).toThrow(SweepHonestyViolation);
  });

  test("rejects a mis-declared error row / geometry", () => {
    const read = readOf(rows(1), [0], { errorRow: 2 });
    expect(() => decodeSpectrumRead(read)).toThrow(SweepHonestyViolation);
  });
});

describe("spectrumSource — the drop-in BinSource", () => {
  const cat = rows(10);
  for (let b = 0; b < 10; b++) cat[CATS.indexOf("tool")]![b] = 2;
  const err = new Array<number>(10).fill(1);
  const source = spectrumSource(readOf(cat, err));

  test("is not partial and reports server coverage", () => {
    expect(source.partial).toBe(false);
    expect(source.coverage()).toEqual({ t0: 0, t1: 10_000 });
  });

  test("full-window bins conserve the server totals exactly", () => {
    const bins = source.bins({ t0: 0, t1: 10_000 }, 10);
    expect(bins.eventCount).toBe(30); // 10 bins × (2 + 1 ridge)
    expect(bins.errors.reduce((a, b) => a + b, 0)).toBe(10);
    assertBinsConsistent(bins);
  });

  test("sub-window re-bins aggregate whole server bins — never fractional events", () => {
    const bins = source.bins({ t0: 2_500, t1: 4_500 }, 4);
    // Snapped to server-bin edges: [2000, 5000) = 3 server bins = 9 cells.
    expect(bins.window).toEqual({ t0: 2_000, t1: 5_000 });
    expect(bins.eventCount).toBe(9);
    for (const t of bins.totals) expect(Number.isInteger(t)).toBe(true);
    assertBinsConsistent(bins);
  });

  test("an empty server scope falls back to the streamed window (honest)", () => {
    const empty = readOf(rows(0), [], { t0: null, t1: null, bins: 0, binMs: 0, events: 0 });
    const s = spectrumSource(empty, []);
    expect(s.kind).toBe("client-window");
    expect(s.coverage()).toBeNull();
  });
});

describe("clientWindowSource", () => {
  const e = (timeMs: number): SweepEvent => ({
    eventId: `e${timeMs}`,
    timeMs,
    category: "tool",
    isError: false,
    eventType: "tool",
    outcome: null,
    errorCode: null,
    runId: "r",
    turnId: null,
    parentEventId: null,
    description: "",
  });

  test("is partial (the honest v1 label) and covers only what streamed", () => {
    const s = clientWindowSource([e(100), e(900)]);
    expect(s.partial).toBe(true);
    expect(s.coverage()).toEqual({ t0: 100, t1: 900 });
    expect(s.kind).toBe("client-window");
  });

  test("eventsIn returns exactly the windowed events", () => {
    const s = clientWindowSource([e(100), e(500), e(900)]);
    expect(s.eventsIn({ t0: 200, t1: 800 }).map((x) => x.timeMs)).toEqual([500]);
  });

  test("empty source: null coverage, empty bins", () => {
    const s = clientWindowSource([]);
    expect(s.coverage()).toBeNull();
    const bins = s.bins({ t0: 0, t1: 1000 }, 5);
    expect(bins.eventCount).toBe(0);
    expect(bins.totals.every((t) => t === 0)).toBe(true);
  });
});
