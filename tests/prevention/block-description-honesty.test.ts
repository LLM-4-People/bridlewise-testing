// @vitest-environment node
/**
 * Block-description honesty — mechanical guards.
 *
 * Two intelligence block descriptions were caught claiming capabilities the
 * code does not have:
 * - `code.autoHeal` promised "the proposed correction for each" broken
 *   import; the real shape (`BrokenEdge` in server/auto-heal.ts) is
 *   `{from, specifier, kind}` — NO proposal exists.
 * - `code.duplicates` promised "near-identical bodies"; the real analysis
 *   (harness `findDuplicates`) groups EXPORTED symbols by name + kind and
 *   never reads a body.
 * - `code.usage` said "where a symbol is referenced"; the real analysis
 *   (harness `findSymbolUsage`) scans import statements only.
 *
 * This file guards against recurrence with TWO mechanisms, and is honest
 * about what each can and cannot prove:
 *
 * 1. CLAIM-WORD RATCHET — an unconditional denylist of the exact phrases
 *    that lied. It is a ratchet, not a lie detector: it cannot judge whether
 *    a NEW sentence overstates, only that these specific burned phrases do
 *    not reappear. If the corresponding capability is ever really built
 *    (real fix proposals, real body similarity), delete the phrase from the
 *    list IN THE SAME COMMIT that adds the output field — the shape
 *    witnesses below will force that conversation.
 *
 * 2. OUTPUT-SHAPE WITNESSES — the real analysis functions are run on real
 *    inputs and their result shapes pinned. The moment someone adds a
 *    proposal/similarity field, a witness fails, forcing the description
 *    and the ratchet to be revisited together. This is the mechanical tie
 *    between what the description may claim and what the output carries
 *    (the block output schemas are passthrough `z.unknown()`, so the tie
 *    cannot live in the schema itself).
 *
 * Dynamic discovery: the ratchet iterates ALL registered blocks via
 * `listBlocks()` — a new block with a burned phrase is caught with no test
 * edit.
 */
import { describe, test, expect, beforeAll } from "vitest";

import { defineIntelligenceBlocks } from "../../server/blocks/intelligence.ts";
import { listBlocks, clearBlocks } from "../../server/blocks/define.ts";
import type { AsyncDbClient } from "../../server/db/async-client.ts";
import { detectBrokenEdges } from "../../server/intelligence/auto-heal.ts";
import {
  findDuplicates,
} from "../../engine/src/intelligence/reuse-discovery.ts";
import { findSymbolUsage } from "../../engine/src/intelligence/symbol-search.ts";
import type {
  ModuleInfo,
  RepositoryMap,
  SymbolInfo,
  ImportInfo,
} from "../../engine/src/intelligence/intelligence-types.ts";

// Registration never touches the db (handlers resolve it lazily per
// request), so a placeholder is sufficient — no handler is invoked here.
beforeAll(() => {
  clearBlocks();
  defineIntelligenceBlocks({} as unknown as AsyncDbClient);
});

// ── Fixtures (real shapes through the real analysis functions) ──

function sym(name: string, kind: SymbolInfo["kind"], line = 1, filePath = "a.ts"): SymbolInfo {
  return Object.freeze({
    name,
    kind,
    visibility: "exported",
    location: Object.freeze({ filePath, line, column: 0 }),
    exported: true,
    async: false,
    generator: false,
    parameterCount: 0,
    modifiers: Object.freeze([]),
  });
}

function imp(specifier: string, importedNames: readonly string[]): ImportInfo {
  return Object.freeze({
    specifier,
    kind: "direct-import",
    importedNames: Object.freeze([...importedNames]),
    resolvedPath: null,
  });
}

function mod(
  path: string,
  symbols: readonly SymbolInfo[],
  imports: readonly ImportInfo[] = [],
): ModuleInfo {
  return Object.freeze({
    path,
    contentHash: "",
    lineCount: 10,
    symbols: Object.freeze(symbols),
    imports: Object.freeze(imports),
    exports: Object.freeze([]),
    architectureModuleId: null,
    architectureLayer: null,
    architectureRealm: null,
    architectureOwner: null,
  });
}

function buildMap(modules: readonly ModuleInfo[]): RepositoryMap {
  return Object.freeze({
    schemaVersion: "bridlewise-intelligence/v1",
    rootPath: ".",
    generatedAt: new Date(0).toISOString(),
    files: Object.freeze(
      modules.map((m) =>
        Object.freeze({
          path: m.path,
          extension: ".ts",
          sizeBytes: 0,
          contentHash: "",
          lineCount: m.lineCount,
          isSource: true,
        }),
      ),
    ),
    modules: Object.freeze(modules),
    totalSymbols: modules.reduce((n, m) => n + m.symbols.length, 0),
    totalDependencies: modules.reduce((n, m) => n + m.imports.length, 0),
    mapHash: "",
  });
}

describe("claim-word ratchet — burned phrases may not reappear in any block text", () => {
  // Each entry is a phrase that a description used to claim a capability
  // that did not exist. Removal criteria: the capability now really exists
  // AND the corresponding shape witness below was updated in the same
  // commit. Anything else is the original defect returning.
  const BURNED_PHRASES: readonly RegExp[] = [
    /near[- ]?identical/i, // code.duplicates: no body similarity exists
    /proposed\s+(correction|fix|change)/i, // code.autoHeal: no proposals exist
    /suggested\s+fix/i, // same claim, other wording
    /harness\s+can\s+repair/i, // auto-heal repairs the INDEX, not imports
    /referenced\s+across/i, // code.usage: import scan, not reference search
  ];

  test("every registered block description and title is free of burned phrases", () => {
    const blocks = listBlocks();
    // Guard the guard: if registration produced nothing, this test would
    // vacuously pass — fail loudly instead.
    expect(blocks.length).toBeGreaterThan(0);
    for (const { definition } of blocks) {
      for (const phrase of BURNED_PHRASES) {
        expect(
          definition.description,
          `block "${definition.id}" description reuses burned overclaim phrase ${phrase}`,
        ).not.toMatch(phrase);
        expect(
          definition.title,
          `block "${definition.id}" title reuses burned overclaim phrase ${phrase}`,
        ).not.toMatch(phrase);
      }
    }
  });

  test("the corrected descriptions state their limitation instead of hiding it", () => {
    const byId = new Map(listBlocks().map((b) => [b.definition.id, b.definition]));
    // code.duplicates must say the match is by NAME (the honest basis).
    expect(byId.get("code.duplicates")?.description).toMatch(/name/i);
    // code.autoHeal must not be silent about the absence of fixes.
    expect(byId.get("code.autoHeal")?.description).toMatch(/does not suggest a fix/i);
    // code.usage must say it scans import statements.
    expect(byId.get("code.usage")?.description).toMatch(/import statements/i);
  });
});

describe("output-shape witnesses — the real result shapes the descriptions must not exceed", () => {
  test("BrokenEdge carries exactly {from, specifier, kind} — no proposal field", () => {
    const map = buildMap([mod("a.ts", [], [imp("./deleted", ["gone"])])]);
    const report = detectBrokenEdges(map);
    expect(report.count).toBe(1);
    const edge = report.brokenEdges[0]!;
    // Exact key pin: adding ANY field (e.g. proposedFix) fails here, which
    // is the intended tripwire for updating the description + ratchet.
    expect(Object.keys(edge).sort()).toEqual(["from", "kind", "specifier"]);
    for (const key of Object.keys(edge)) {
      expect(key).not.toMatch(/propos|suggest|fix|correct/i);
    }
  });

  test("DuplicateGroup carries exactly {name, kind, locations, count} — no similarity field, and grouping ignores everything but name+kind", () => {
    // Two exported functions sharing a name but differing in every other
    // attribute the map records — if the analysis compared anything beyond
    // name+kind, they would NOT group.
    const a = sym("parse", "function", 1, "a.ts");
    const b = Object.freeze({
      ...sym("parse", "function", 99, "z/deep/b.ts"),
      async: true,
      parameterCount: 7,
    });
    const groups = findDuplicates(buildMap([mod("a.ts", [a]), mod("z/deep/b.ts", [b])]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(Object.keys(groups[0]!).sort()).toEqual(["count", "kind", "locations", "name"]);
    for (const key of Object.keys(groups[0]!)) {
      expect(key).not.toMatch(/similar|body|score/i);
    }
  });

  test("findSymbolUsage returns importers only — files that merely define the symbol are absent", () => {
    const defining = mod("def.ts", [sym("helper", "function", 1, "def.ts")]);
    const importing = mod("use.ts", [], [imp("./def", ["helper"])]);
    const result = findSymbolUsage(buildMap([defining, importing]), "helper");
    expect(Object.keys(result).sort()).toEqual(["importers", "symbolName"]);
    const files = result.importers.map((i) => i.filePath);
    expect(files).toEqual(["use.ts"]);
    // The defining file is NOT reported — proof this is an import scan,
    // which is exactly what the description now claims and no more.
    expect(files).not.toContain("def.ts");
  });
});

describe("code.path registration — deny-by-default input, honest-direction description", () => {
  test("code.path is registered with a read side and both endpoints required", () => {
    const block = listBlocks().find((b) => b.definition.id === "code.path");
    expect(block).toBeDefined();
    const read = block!.definition.read!;
    expect(read).toBeDefined();
    // Deny-by-default: every missing piece is a rejection, not a default.
    expect(read.input.safeParse({}).success).toBe(false);
    expect(read.input.safeParse({ path: "/p" }).success).toBe(false);
    expect(read.input.safeParse({ path: "/p", from: "a.ts" }).success).toBe(false);
    // Each endpoint missing ALONE — a mutation making only `from` (or only
    // `to`) optional must be caught, not masked by the other's absence.
    expect(read.input.safeParse({ path: "/p", to: "b.ts" }).success).toBe(false);
    expect(read.input.safeParse({ path: "/p", from: "", to: "b.ts" }).success).toBe(false);
    expect(read.input.safeParse({ path: "/p", from: "a.ts", to: "" }).success).toBe(false);
    expect(read.input.safeParse({ path: "/p", from: "a.ts", to: "b.ts" }).success).toBe(true);
  });

  test("code.path description declares its direction semantics and its basis caveat", () => {
    const def = listBlocks().find((b) => b.definition.id === "code.path")!.definition;
    // Direction: the description must say the reverse is also checked —
    // the design decision this block is built on.
    expect(def.description).toMatch(/opposite direction|other direction|reverse/i);
    // Basis caveat: dynamic imports are excluded and the user must be told.
    expect(def.description).toMatch(/dynamic imports/i);
  });
});
