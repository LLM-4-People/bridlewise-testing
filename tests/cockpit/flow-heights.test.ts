// @vitest-environment node
/**
 * HeightIndex — the flow virtualizer's height SumTree (spec §3.8).
 *
 * Correctness against a brute-force prefix sum, then the PERF budget: the
 * virtualizer path must stay far inside the §1.5 frame budget on a 5k-beat
 * log (the spec's proving size).
 */
import { describe, expect, test } from "vitest";

import { cpuWorkOf } from "../../engine/src/shared/run-cpu.ts";

import { HeightIndex } from "../../src/cockpit/flow/heights.ts";

function brute(heights: number[], y: number): number {
  let acc = 0;
  for (let i = 0; i < heights.length; i += 1) {
    if (y < acc + heights[i]!) return i;
    acc += heights[i]!;
  }
  return heights.length - 1;
}

describe("HeightIndex correctness", () => {
  test("bulk growth, prefix views, prepends, shrink and appends preserve fractional measurements and stamps", () => {
    const index = new HeightIndex(12.25, 7);
    let reference: Array<{ height: number; stamp: string | null }> = [];
    const check = () => {
      let sum = 0;
      expect(index.length).toBe(reference.length);
      for (let i = 0; i < reference.length; i += 1) {
        expect(index.offsetOf(i)).toBeCloseTo(sum, 8);
        expect(index.heightOf(i)).toBe(reference[i]!.height);
        expect(index.stampOf(i)).toBe(reference[i]!.stamp);
        expect(index.isMeasured(i)).toBe(reference[i]!.stamp !== null);
        sum += reference[i]!.height;
      }
      expect(index.totalHeight()).toBeCloseTo(sum, 8);
      expect(index.offsetOf(reference.length + 100)).toBeCloseTo(sum, 8);
      if (reference.length > 0) {
        for (let probe = 0; probe < 40; probe += 1) {
          const y = (probe + 0.37) * sum / 40;
          expect(index.indexAtOffset(y)).toBe(brute(reference.map(row => row.height), y));
        }
      }
    };
    for (const count of [1, 17, 4096]) {
      index.append(count);
      reference.push(...Array.from({ length: count }, () => ({ height: 12.25, stamp: null })));
      for (let i = 0; i < reference.length; i += 7) {
        const row = { height: i % 21 === 0 ? 0 : (i % 100) / 3, stamp: `measured-${i}` };
        index.update(i, row.height, row.stamp); reference[i] = row;
      }
      index.prepend(13);
      reference = [...Array.from({ length: 13 }, () => ({ height: 12.25, stamp: null })), ...reference];
      check();
    }
    index.truncate(5); reference.length = 5; check();
    index.append(100); reference.push(...Array.from({ length: 100 }, () => ({ height: 12.25, stamp: null }))); check();
    index.truncate(0); reference = []; check();
    index.append(); reference.push({ height: 12.25, stamp: null }); check();
  });
  test("append + estimate + measured update keep offsets exact", () => {
    const idx = new HeightIndex(40, 4);
    idx.append(10);
    expect(idx.length).toBe(10);
    expect(idx.totalHeight()).toBe(400);
    expect(idx.offsetOf(3)).toBe(120);
    idx.update(2, 100);
    expect(idx.offsetOf(3)).toBe(180);
    expect(idx.totalHeight()).toBe(460);
    expect(idx.isMeasured(2)).toBe(true);
    expect(idx.isMeasured(3)).toBe(false);
  });

  test("indexAtOffset matches brute force over random heights", () => {
    const idx = new HeightIndex(40, 8);
    const heights: number[] = [];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    idx.append(500);
    for (let i = 0; i < 500; i += 1) {
      const h = 20 + Math.floor(rnd() * 300);
      heights.push(h);
      idx.update(i, h);
    }
    const total = heights.reduce((a, b) => a + b, 0);
    expect(idx.totalHeight()).toBe(total);
    for (let probe = 0; probe < 200; probe += 1) {
      const y = Math.floor(rnd() * total);
      expect(idx.indexAtOffset(y)).toBe(brute(heights, y));
    }
    // Edges.
    expect(idx.indexAtOffset(-10)).toBe(0);
    expect(idx.indexAtOffset(total + 999)).toBe(499);
  });

  test("truncate keeps the surviving measurements", () => {
    const idx = new HeightIndex(40);
    idx.append(20);
    idx.update(5, 99);
    idx.truncate(10);
    expect(idx.length).toBe(10);
    expect(idx.heightOf(5)).toBe(99);
    expect(idx.totalHeight()).toBe(9 * 40 + 99);
  });
});

describe("HeightIndex perf — 5k beats (§3.8 proving size, §1.5 budgets)", () => {
  test("5k appends + 5k measured updates + 10k window queries stay inside 150ms", () => {
    const idx = new HeightIndex(56, 16);
    let acc = 0;
    // CPU work, never wall time (NO-LOAD-BLOCK).
    const ms = cpuWorkOf(() => {
      idx.append(5000);
      for (let i = 0; i < 5000; i += 1) idx.update(i, 24 + (i % 400));
      for (let q = 0; q < 10_000; q += 1) {
        acc += idx.indexAtOffset((q * 137) % idx.totalHeight());
      }
    });
    expect(acc).toBeGreaterThan(0);
    // Whole-log rebuild + 10k queries in 150ms leaves a single scroll frame's
    // work (2 queries + ~40 offsets) far under 1ms.
    expect(ms).toBeLessThan(150);
  });

  test("one scroll-frame's queries on a 5k log stay inside the 16ms frame", () => {
    const idx = new HeightIndex(56, 16);
    idx.append(5000);
    for (let i = 0; i < 5000; i += 1) idx.update(i, 24 + (i % 400));
    // A frame: 2 indexAtOffset + ~46 offsetOf (window of 40 + overscan); CPU work, never wall time.
    const msPerFrame = cpuWorkOf(() => {
      for (let frame = 0; frame < 100; frame += 1) {
        const start = idx.indexAtOffset((frame * 977) % idx.totalHeight());
        idx.indexAtOffset(((frame * 977) % idx.totalHeight()) + 900);
        for (let k = 0; k < 46; k += 1) idx.offsetOf(start + k);
      }
    }) / 100;
    expect(msPerFrame).toBeLessThan(16);
  });
});
