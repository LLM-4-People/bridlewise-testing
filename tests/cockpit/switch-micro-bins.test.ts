// @vitest-environment node
/**
 * THE SWITCH — micro-sweep decoder (spec §5.2: real density, §1.1: no
 * fabrication). The decoder consumes the `sweep.spectrum` wire contract
 * (base64 Int16Array + header) and REFUSES payloads that lie about
 * themselves. Mutations of every refusal path are exercised — a decoder
 * that stops refusing goes red here.
 */
import { describe, expect, test } from "vitest";

import {
  assertMicroDensityConsistent,
  decodeMicroDensity,
  type MicroDensity,
} from "../../src/cockpit/rooms/micro-bins.ts";
import { SwitchHonestyViolation } from "../../src/cockpit/rooms/switch-outcome.ts";

const CATS = ["a", "b", "c"] as const; // any category naming — the strip sums rows

/** Pack a rows×bins matrix exactly as the server does. */
function pack(matrix: readonly (readonly number[])[]): string {
  const rows = matrix.length;
  const bins = matrix[0]!.length;
  const flat = new Int16Array(rows * bins);
  for (let r = 0; r < rows; r += 1)
    for (let b = 0; b < bins; b += 1) flat[r * bins + b] = matrix[r]![b]!;
  return Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength).toString("base64");
}

function wire(
  matrix: readonly (readonly number[])[],
  headerOverride: Record<string, unknown> = {},
): unknown {
  const bins = matrix[0]!.length;
  return {
    header: {
      categories: CATS,
      errorRow: CATS.length,
      errorRowIsOverlay: true,
      rows: CATS.length + 1,
      bins,
      binMs: 1000,
      t0: 1_000,
      t1: 1_000 + bins * 1000,
      events: 0,
      unbinnable: 0,
      attributedOnly: true,
      clamped: false,
      ...headerOverride,
    },
    packed: pack(matrix),
  };
}

describe("decodeMicroDensity — the wire, honestly", () => {
  test("totals are the category-row sums; errors are the overlay row", () => {
    const d = decodeMicroDensity(
      wire(
        [
          [1, 0, 2], // cat a
          [0, 0, 3], // cat b
          [2, 0, 0], // cat c
          [1, 0, 2], // error overlay (subset of the above)
        ],
        { events: 8 },
      ),
    );
    expect(d).not.toBeNull();
    expect(d!.totals).toEqual([3, 0, 5]);
    expect(d!.errors).toEqual([1, 0, 2]);
    expect(d!.events).toBe(8);
    expect(d!.t0).toBe(1_000);
  });

  test("an empty scope (0 events, no window) decodes to the honest blank", () => {
    const empty = {
      header: {
        categories: CATS, errorRow: 3, errorRowIsOverlay: true, rows: 4,
        bins: 0, binMs: 0, t0: null, t1: null, events: 0, unbinnable: 0,
        attributedOnly: true, clamped: false,
      },
      packed: "",
    };
    expect(decodeMicroDensity(empty)).toBeNull();
  });

  test("mutation: events claimed but no window → refuse", () => {
    const lying = {
      header: {
        categories: CATS, errorRow: 3, errorRowIsOverlay: true, rows: 4,
        bins: 0, binMs: 0, t0: null, t1: null, events: 7, unbinnable: 0,
        attributedOnly: true, clamped: false,
      },
      packed: "",
    };
    expect(() => decodeMicroDensity(lying)).toThrow(SwitchHonestyViolation);
  });

  test("mutation: a payload that will not declare overlay semantics → refuse", () => {
    expect(() =>
      decodeMicroDensity(wire([[1], [1], [1], [0]], { errorRowIsOverlay: undefined })),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: header geometry disagreeing with itself → refuse", () => {
    expect(() => decodeMicroDensity(wire([[1], [1], [1], [0]], { rows: 9 }))).toThrow(
      SwitchHonestyViolation,
    );
    expect(() => decodeMicroDensity(wire([[1], [1], [1], [0]], { errorRow: 1 }))).toThrow(
      SwitchHonestyViolation,
    );
  });

  test("mutation: packed length not matching the declared matrix → refuse", () => {
    expect(() =>
      decodeMicroDensity(wire([[1, 2], [0, 0], [0, 0], [0, 0]], { bins: 5 })),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: a negative count → refuse", () => {
    expect(() => decodeMicroDensity(wire([[-1], [0], [0], [0]]))).toThrow(
      SwitchHonestyViolation,
    );
  });

  test("mutation: an error overlay exceeding its stack → refuse", () => {
    expect(() => decodeMicroDensity(wire([[1], [0], [0], [5]]))).toThrow(
      SwitchHonestyViolation,
    );
  });

  test("mutation: not a {header, packed} payload at all → refuse", () => {
    expect(() => decodeMicroDensity(null)).toThrow(SwitchHonestyViolation);
    expect(() => decodeMicroDensity({ header: {} })).toThrow(SwitchHonestyViolation);
  });
});

describe("assertMicroDensityConsistent — the painter's precondition", () => {
  const good: MicroDensity = {
    t0: 0, t1: 3000, binMs: 1000,
    totals: [3, 0, 5], errors: [1, 0, 2], events: 8,
  };

  test("a consistent density passes", () => {
    expect(() => assertMicroDensityConsistent(good)).not.toThrow();
  });

  test("mutation: errors exceeding totals throws", () => {
    expect(() =>
      assertMicroDensityConsistent({ ...good, errors: [4, 0, 2] }),
    ).toThrow(SwitchHonestyViolation);
  });

  test("mutation: negative or non-integer counts throw", () => {
    expect(() => assertMicroDensityConsistent({ ...good, totals: [-1, 0, 5] })).toThrow(
      SwitchHonestyViolation,
    );
    expect(() => assertMicroDensityConsistent({ ...good, totals: [1.5, 0, 5] })).toThrow(
      SwitchHonestyViolation,
    );
  });

  test("mutation: disagreeing array lengths or a broken window throw", () => {
    expect(() => assertMicroDensityConsistent({ ...good, errors: [1] })).toThrow(
      SwitchHonestyViolation,
    );
    expect(() => assertMicroDensityConsistent({ ...good, t1: -1 })).toThrow(
      SwitchHonestyViolation,
    );
  });
});
