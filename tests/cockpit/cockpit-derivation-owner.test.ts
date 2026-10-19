// @vitest-environment node
/**
 * cockpit-derivation-owner (spec §4.4) — a finding may not render without a
 * machine-readable derivation; extrapolations must include the word
 * "projection" and their input window.
 *
 * Two layers, both mutation-tested:
 *   RUNTIME — `assertDerivation` is the render-boundary validator
 *     (FindingNote calls it before painting a sentence). Every degenerate
 *     shape must throw with the violated clause named.
 *   STATIC — every `<FindingNote` usage in `src/cockpit/**` must pass a
 *     `derivation` prop (literal or spread-carried), and FindingNote.svelte
 *     itself must call `assertDerivation`. The scanner is a pure function,
 *     self-checked on synthetic violations below.
 */
import { describe, expect, test } from "vitest";

import { assertDerivation, type Derivation } from "../../src/cockpit/computer/derivation.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";

const good: Derivation = {
  method: "joined a with b",
  steps: [{ source: "beats", sourceId: "cockpit.flow.log", count: 4 }],
  asOf: 1_000,
};

describe("runtime validator — assertDerivation", () => {
  test("a complete derivation passes and is returned unchanged", () => {
    expect(assertDerivation(good, "a sentence")).toBe(good);
  });

  test("mutation: missing derivation throws", () => {
    expect(() => assertDerivation(undefined, "s")).toThrow(/no derivation/);
    expect(() => assertDerivation(null, "s")).toThrow(/no derivation/);
  });

  test("mutation: empty method throws", () => {
    expect(() => assertDerivation({ ...good, method: "" }, "s")).toThrow(/method/);
  });

  test("mutation: no steps throws", () => {
    expect(() => assertDerivation({ ...good, steps: [] }, "s")).toThrow(/steps/);
  });

  test("mutation: a step without a measured count throws", () => {
    expect(() =>
      assertDerivation(
        { ...good, steps: [{ source: "x", sourceId: "y", count: Number.NaN }] },
        "s",
      ),
    ).toThrow(/measured count/);
  });

  test("mutation: a step without a source id throws", () => {
    expect(() =>
      assertDerivation({ ...good, steps: [{ source: "x", sourceId: "", count: 1 }] }, "s"),
    ).toThrow(/source id/);
  });

  test("mutation: missing asOf throws", () => {
    expect(() => assertDerivation({ ...good, asOf: 0 }, "s")).toThrow(/asOf/);
  });

  test("mutation: a projection sentence without a window throws", () => {
    expect(() => assertDerivation(good, "projection from thin air")).toThrow(/input window/);
  });

  test("mutation: a windowed derivation whose sentence never says 'projection' throws", () => {
    expect(() =>
      assertDerivation({ ...good, window: "last 10 runs" }, "context fills soon"),
    ).toThrow(/label itself/);
  });

  test("a labeled projection WITH its window passes", () => {
    expect(() =>
      assertDerivation(
        { ...good, window: "your last 10 messages" },
        "fills in ~12 — projection from your last 10 messages",
      ),
    ).not.toThrow();
  });
});

// ── Static scan ──────────────────────────────────────────────────────────────

/** Every `<FindingNote` opening tag must carry a `derivation` binding. */
export function scanFindingNoteUsages(src: string, file: string): string[] {
  const violations: string[] = [];
  const re = /<FindingNote\b([^>]*?)(\/?)>/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1]!;
    if (!/\bderivation\s*=/.test(attrs) && !/\{\.\.\./.test(attrs)) {
      violations.push(`${file}: <FindingNote> without a derivation prop (§4.4)`);
    }
  }
  return violations;
}

describe("static scan — every FindingNote usage carries its derivation", () => {
  const files = walk("src/cockpit", { exts: [".svelte"] });

  test("FindingNote.svelte exists and enforces the contract at its render boundary", () => {
    const own = files.find((f) => relpath(f).endsWith("computer/FindingNote.svelte"));
    expect(own).toBeDefined();
    const src = read(own!);
    expect(src).toMatch(/assertDerivation\s*\(/);
  });

  test("no usage in the cockpit tree omits the derivation prop", () => {
    const all: string[] = [];
    for (const f of files) {
      if (relpath(f).endsWith("FindingNote.svelte")) continue;
      all.push(...scanFindingNoteUsages(read(f), relpath(f)));
    }
    expect(all, all.join("\n")).toEqual([]);
  });

  test("mutation: a usage without derivation is flagged", () => {
    const bad = `<FindingNote sentence={"x"} verbs={[]} />`;
    expect(scanFindingNoteUsages(bad, "X.svelte")).toHaveLength(1);
  });

  test("mutation: a multi-line usage without derivation is flagged", () => {
    const bad = `<FindingNote\n  sentence={s}\n  verbs={v}\n/>`;
    expect(scanFindingNoteUsages(bad, "X.svelte")).toHaveLength(1);
  });

  test("mutation: a compliant usage is NOT flagged", () => {
    const ok = `<FindingNote sentence={s} derivation={d} />`;
    expect(scanFindingNoteUsages(ok, "X.svelte")).toEqual([]);
  });
});
