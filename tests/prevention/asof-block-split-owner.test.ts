// @vitest-environment node
/**
 * THE `asOf` BLOCK SPLIT — the client's picture of which blocks can answer
 * for a past instant must be the SERVER's picture (DESIGN-COCKPIT-V2 §6.2,
 * `server/blocks/define.ts` "THE `until` CONVENTION").
 *
 * WHY A GUARD AND NOT A COMMENT
 *
 * `src/data/asof.ts` decides, BEFORE a request is issued, whether a block
 * can be read at a planted head. It has to decide client-side: sending
 * `until` to a block whose schema does not declare it is exactly the silent
 * lie the feature exists to prevent — a plain `z.object` strips the unknown
 * key and answers about NOW, and the surface renders that under a banner
 * reading `viewing 16:00:53`. So the client carries a list, and a list can
 * drift from the schemas it claims to describe.
 *
 * This test removes the drift. It registers the REAL blocks and reads each
 * read-side input schema's own shape — zod keeps `.shape` through `.refine`,
 * so this is the declaration itself, not a source-text guess. Adding `until`
 * to a block without listing it here fails; listing a block that does not
 * implement `until` fails. Neither can be done quietly.
 *
 * The third category is also pinned: `TIME_INVARIANT_BLOCKS` is the escape
 * hatch for reads whose answer cannot depend on `asOf`, and an escape hatch
 * with no guard on it becomes the place blocks go to dodge honesty. Every
 * member must be a real registered block, must NOT declare `until`, and the
 * set is asserted small and enumerated so growth is a reviewed decision.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";

// Route the singleton timeline ledger into a temp world BEFORE config loads —
// the same hoist the other server-registry suites use.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-asof-split-root-");
});

import {
  RANGED_BLOCKS,
  TIME_INVARIANT_BLOCKS,
} from "../../src/data/asof.ts";

/**
 * The block modules and their registrars, in `server/routes/registry.ts`
 * order. Registration only closes over the db — no handler runs here — so a
 * stub is enough to enumerate declarations without standing a database up.
 */
type Registrar = (db: never) => void;

const REGISTRARS: readonly (readonly [string, () => Promise<Registrar>])[] = [
  ["checks", async () => (await import("../../server/blocks/checks.ts")).defineChecksBlocks],
  ["intelligence", async () => (await import("../../server/blocks/intelligence.ts")).defineIntelligenceBlocks],
  ["provenance", async () => (await import("../../server/blocks/provenance.ts")).defineProvenanceBlocks],
  ["coverage", async () => (await import("../../server/blocks/coverage.ts")).defineCoverageBlocks],
  ["synthesis", async () => (await import("../../server/blocks/synthesis.ts")).defineSynthesisBlocks],
  ["tools", async () => (await import("../../server/blocks/tools.ts")).defineToolsBlocks],
  ["settings", async () => (await import("../../server/blocks/settings.ts")).defineSettingsBlocks],
  ["compose", async () => (await import("../../server/blocks/compose.ts")).defineComposeBlocks],
  ["breaker", async () => (await import("../../server/blocks/breaker.ts")).defineBreakerBlocks],
  ["spectrum", async () => (await import("../../server/blocks/spectrum.ts")).defineSpectrumBlocks],
  ["arm", async () => (await import("../../server/blocks/arm.ts")).defineArmBlocks],
  ["custody", async () => (await import("../../server/blocks/custody.ts")).defineCustodyBlocks],
];

/** Block ids that declare the `until` read parameter, read from the schemas. */
let declaredRanged: Set<string>;
/** Every registered block that has a read side. */
let readingBlocks: Set<string>;
/** The registered definitions themselves, for schema-level assertions. */
let definitions: readonly Readonly<{
  definition: Readonly<{ id: string; read?: { input: unknown } }>;
}>[];

beforeAll(async () => {
  const define = await import("../../server/blocks/define.ts");
  // The registry is a module singleton; start from empty so this file's
  // picture is its own and cannot depend on import order elsewhere.
  define.clearBlocks();
  const db = new Proxy({}, { get: () => () => undefined }) as never;
  for (const [name, load] of REGISTRARS) {
    const registrar = await load();
    expect(registrar, `server/blocks/${name}.ts must export its registrar`).toBeTypeOf(
      "function",
    );
    registrar(db);
  }

  declaredRanged = new Set();
  readingBlocks = new Set();
  definitions = define.listBlocks();
  for (const { definition } of definitions) {
    if (definition.read === undefined) continue;
    readingBlocks.add(definition.id);
    // zod v4 keeps `.shape` on an object schema through `.refine()`, so this
    // reads the DECLARATION rather than parsing source text.
    const shape = (definition.read.input as { shape?: Record<string, unknown> })
      .shape;
    expect(
      shape,
      `block "${definition.id}" read input is not an object schema — the ` +
        `until convention cannot be checked on it`,
    ).toBeDefined();
    if (shape !== undefined && "until" in shape) declaredRanged.add(definition.id);
  }
});

describe("the ranged set is exactly what the server implements", () => {
  test("the registry really registered (the guard is looking at something)", () => {
    expect(readingBlocks.size).toBeGreaterThan(0);
    expect(readingBlocks.has("tools.breaker")).toBe(true);
  });

  test("every client-listed ranged block declares `until` on the server", () => {
    const missing = [...RANGED_BLOCKS].filter((id) => !declaredRanged.has(id));
    expect(
      missing,
      `listed as ranged in src/lib/data/asof.ts but no \`until\` in the ` +
        `block's read schema — a past read would send a parameter the ` +
        `server drops, and the answer would be NOW: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("every server block that declares `until` is listed on the client", () => {
    const unlisted = [...declaredRanged].filter((id) => !RANGED_BLOCKS.has(id));
    expect(
      unlisted,
      `implements \`until\` but is not in RANGED_BLOCKS, so the Broker will ` +
        `refuse it during a past view instead of using it: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });

  test("mutation — the check can see a block added to only one side", () => {
    // The two assertions above are set differences; prove they are not
    // vacuously true by running them against deliberately wrong sets.
    const clientOnly = new Set([...RANGED_BLOCKS, "coverage.darkfield"]);
    expect([...clientOnly].filter((id) => !declaredRanged.has(id))).toEqual([
      "coverage.darkfield",
    ]);
    const serverOnly = new Set([...declaredRanged, "checks.auto"]);
    expect([...serverOnly].filter((id) => !RANGED_BLOCKS.has(id))).toEqual([
      "checks.auto",
    ]);
  });

  test("every ranged `until` accepts the planted head's real precision — sub-millisecond epochs", () => {
    // The sweep head is a position BETWEEN recorded instants, so the client's
    // own past read arrives as a FRACTIONAL epoch (measured live:
    // `until=1787826816836.9668`). An integer-only schema refused that head
    // as a malformed request — a typed 400 the browser logged as a console
    // error on every past view, for the one read the block exists to answer.
    // Every ranged block parses the real head shape, and garbage still
    // refuses (the bound is a time, not anything coerce will pass).
    for (const id of RANGED_BLOCKS) {
      const input = definitions.find((d) => d.definition.id === id)!.definition
        .read!.input as { safeParse: (v: unknown) => { success: boolean } };
      const head = input.safeParse({
        ...(id === "sweep.spectrum" ? { scope: "chat", chatId: "c1" } : id === "arm.flags" ? {} : { chatId: "c1" }),
        until: "1787826816836.9668",
      });
      expect(
        head.success,
        `block "${id}" refused a fractional until — the planted head's own shape`,
      ).toBe(true);
      const garbage = input.safeParse({
        ...(id === "sweep.spectrum" ? { scope: "chat", chatId: "c1" } : id === "arm.flags" ? {} : { chatId: "c1" }),
        until: "not-a-time",
      });
      expect(garbage.success, `block "${id}" accepted a non-numeric until`).toBe(false);
    }
  });
});

describe("the time-invariant escape hatch stays narrow and honest", () => {
  test("every member is a real block with a read side", () => {
    for (const id of TIME_INVARIANT_BLOCKS) {
      expect(readingBlocks.has(id), `"${id}" is not a registered read`).toBe(true);
    }
  });

  test("no member declares `until` — invariance and bounding are different claims", () => {
    for (const id of TIME_INVARIANT_BLOCKS) {
      expect(declaredRanged.has(id)).toBe(false);
      expect(RANGED_BLOCKS.has(id)).toBe(false);
    }
  });

  test("the hatch is enumerated, so widening it is a visible decision", () => {
    // Each entry is here because its answer is addressed by an IMMUTABLE
    // identity — append-only ledger rows walked from a trace id — so "the
    // answer at 16:00:53" and "the answer now" are the same bytes. Adding an
    // id that is merely UNLIKELY to change fails this list, on purpose.
    expect([...TIME_INVARIANT_BLOCKS].sort()).toEqual(["lens.ancestry"]);
  });
});

describe("everything else refuses — the split is total", () => {
  test("no reading block is left unclassified in a way that could serve NOW as THEN", () => {
    // A block is either ranged (bounded by `until`), invariant (cannot
    // change), or refusing. There is no fourth state: `paramsWithAsOf`
    // throws for anything outside the first two, so an unlisted block can
    // only ever refuse — never quietly answer about now.
    const classified = new Set([...RANGED_BLOCKS, ...TIME_INVARIANT_BLOCKS]);
    const refusing = [...readingBlocks].filter((id) => !classified.has(id));
    expect(refusing.length).toBeGreaterThan(0);
    // The blocks the sweep agent named as unretrofitted must all be in the
    // refusing set — they are exactly the ones that must not pretend.
    for (const id of [
      "lens.recorder",
      "coverage.darkfield",
      "coverage.annunciator",
      "synthesis.conversationPulse",
      "synthesis.echoes",
      "synthesis.contextForecast",
      "checks.auto",
    ]) {
      expect(refusing, `"${id}" must refuse in a past view`).toContain(id);
    }
  });
});
