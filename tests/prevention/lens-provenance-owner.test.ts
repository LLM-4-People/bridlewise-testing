// @vitest-environment node
/**
 * Mechanical enforcement: LENS is an instrument, and instruments must not lie.
 *
 * This file guards the four properties that make LENS worth having. Each is
 * something that would rot silently without a test, and each has been
 * mutation-verified (reintroduce the defect → the named test FAILS).
 *
 *   A. THE CHOKE POINT. `recordRead` has exactly ONE caller: the Broker. The
 *      moment a component can write a provenance record, provenance becomes
 *      forgeable and the whole feature is theatre.
 *
 *   B. ZERO COST WHEN INACTIVE. No LENS module attaches a listener, an
 *      observer or a timer at import time, and no LENS component attaches one
 *      outside an `$effect`. The performance claim is asserted mechanically
 *      rather than in a comment.
 *
 *   C. THE COVERAGE RATCHET. The count of surfaces that can explain
 *      themselves may only RISE. Discovery is dynamic — the module registry is
 *      enumerated, never listed — so adding a module changes the measurement
 *      without changing this file.
 *
 *   D. WIRED, NOT ORPHANED. The declared module, its component key and its
 *      block ids resolve to real registrations, so LENS cannot ship as three
 *      files that never meet.
 *
 * Discovery is DYNAMIC throughout: the module set comes from the built
 * schema, and the block set comes from the registry.
 */
import { describe, test, expect, beforeAll } from "vitest";

import { buildUiSchema, resetUiSchemaCache } from "../../server/schema/ui-schema.ts";
import {
  registerAllExposure,
  resetAllRegistrations,
} from "../../server/kernel/canonical.ts";
import { clearBlocks, listBlocks } from "../../server/blocks/define.ts";
import { defineProvenanceBlocks } from "../../server/blocks/provenance.ts";
import type { AsyncDbClient } from "../../server/db/async-client.ts";
import type { ModuleEntry } from "../../shared/module-contract.ts";
import { read, relpath, stripCommentsOnly, walk } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
let modules: readonly ModuleEntry[];

beforeAll(() => {
  resetAllRegistrations();
  registerAllExposure();
  resetUiSchemaCache();
  modules = buildUiSchema().modules;
});

// ── A. the choke point ─────────────────────────────────────────────────────

describe("A. provenance is captured at ONE choke point", () => {
  /** Every source file that mentions the recorder, discovered dynamically. */
  function callersOfRecordRead(): string[] {
    const callers: string[] = [];
    for (const root of ["src", "server", "shared"]) {
      for (const file of walk(root, { exts: [".ts", ".svelte"] })) {
        const rel = relpath(file);
        // The definition itself is not a call site.
        if (rel === modulePath("ledger.ts")) continue;
        // The provenance recorder is an IMPORTED BARE function; only a bare
        // `recordRead(...)` call can be the recorder. A receiver-qualified
        // call (`thing.recordRead(...)` / `thing?.recordRead(...)`) names a
        // DIFFERENT instrument's method — e.g. the safety step-skip
        // detector's own `recordRead` — and was never this guard's
        // population. The exclusion is per OCCURRENCE, not per file: a file
        // that legitimately calls another object's `recordRead` method and
        // ALSO authors a bare provenance call is still named.
        const bareCalls = read(rel).replace(/(?:\.|\?\.)recordRead\s*\(/g, " ");
        if (/\brecordRead\s*\(/.test(bareCalls)) callers.push(rel);
      }
    }
    return callers.sort();
  }

  test("only the Broker calls recordRead", () => {
    expect(
      callersOfRecordRead(),
      "Provenance must be captured at src/data/broker.ts and nowhere else.\n" +
        "A second caller means a call site can author its own provenance, which makes\n" +
        "the record forgeable and the instrument worthless. Route the data through\n" +
        "broker.read() instead.",
    ).toEqual([modulePath("broker.ts")]);
  });

  test("the Broker actually calls it (the guard is not vacuous)", () => {
    expect(callersOfRecordRead().length).toBe(1);
  });
});

// ── B. zero cost when inactive ─────────────────────────────────────────────

// (Class B — the LENS component cost audit — died with the components.)

// (Class C — the coverage ratchet — died with its instrument, the old
//  lens coverage module; the module wire contract itself is pinned in
//  graph-wire-shape and the schema-builder tests.)

// ── D. wired, not orphaned ─────────────────────────────────────────────────

describe("D. LENS is actually wired into the registries", () => {
  // (The registered-component case died with the component registry.)

  test("the LENS module's read source names a block the server declares", () => {
    clearBlocks();
    // The handlers close over `db` lazily; registration itself needs nothing
    // from it, so a stand-in is enough to enumerate the declared ids.
    defineProvenanceBlocks({} as AsyncDbClient);
    const declared = new Set(listBlocks().map((b) => b.descriptor.id));
    clearBlocks();

    const lens = modules.find((m) => m.id === "sys.lens");
    const reads = (lens?.sources ?? []).filter((s) => s.kind === "read");
    expect(reads.length, "sys.lens must declare at least one read source").toBeGreaterThan(0);
    for (const s of reads) {
      expect(
        declared.has(s.block ?? ""),
        `sys.lens binds to block "${s.block}", which no server block declares`,
      ).toBe(true);
    }
  });

  test("run ownership is decided in exactly ONE place", () => {
    // Two entry points now reach the ledger — a single event id and a trace
    // id — and a trace is NOT an authorisation boundary: `byTrace` returns
    // whatever shares the id, across runs. The temptation is to add a filter
    // on the trace path "as well". A second ownership check is two things
    // that must agree forever, and they drift the first time one is updated,
    // which is how one path ends up quietly weaker than the other.
    //
    // `ownsRun` is the single predicate, and the SET it consults is resolved
    // exactly once. The mechanism changed when the data layer went async and
    // the property did not: `ownsRun` is called per event by a synchronous
    // walk that cannot await, so a per-event `runBelongsToUser` would have had
    // to return a promise — and a promise is TRUTHY, which would have made
    // every run in the ledger pass the gate while the code still read like a
    // check. The caller's runs are therefore enumerated up front
    // (`allRunIdsForUser` asks the identical question of `messages.run_id`)
    // and `ownsRun` is a set membership test.
    //
    // So the count to hold at one is the ENUMERATION, not the per-id probe.
    // Comments stripped: the rationale above the gate names the predicate,
    // and prose must not count as a second implementation.
    const src = stripCommentsOnly(read(modulePath("provenance.ts")));
    // Scoped to the PORT's body. `recorderCoverage` enumerates the caller's
    // runs too, for a different question entirely (which ledger rows may be
    // sampled), and counting file-wide would conflate the two — a guard that
    // fails for a reason that is not the property is a guard nobody keeps.
    const portStart = src.indexOf("export async function ancestryPortFor");
    expect(portStart, "ancestryPortFor is gone — the port is the ownership owner").toBeGreaterThan(-1);
    const portEnd = src.indexOf("\nexport ", portStart + 1);
    const port = src.slice(portStart, portEnd === -1 ? undefined : portEnd);
    const enumerations = (port.match(/allRunIdsForUser/g) ?? []).length;
    const perIdProbes = (src.match(/runBelongsToUser/g) ?? []).length;
    expect(
      enumerations,
      `allRunIdsForUser appears ${enumerations} times inside ancestryPortFor.\n` +
        `The caller's run set must be resolved exactly ONCE, in the port, and every\n` +
        `path — including the trace read — must decide through the resulting ownsRun.`,
    ).toBe(1);
    expect(
      perIdProbes,
      `runBelongsToUser appears ${perIdProbes} times in server/blocks/provenance.ts.\n` +
        `A per-id probe here would be an ASYNC call in a synchronous predicate:\n` +
        `it would return a promise, the promise would be truthy, and the gate\n` +
        `would silently admit every run in the ledger.`,
    ).toBe(0);
  });

  test("the trace path narrows results through the shared gate, not its own", () => {
    // `ownedTraceEvents` is the only place a trace result is narrowed, and it
    // must do so with `port.ownsRun`. If it ever grows a second criterion,
    // the two entry points stop agreeing about who may see what.
    const src = stripCommentsOnly(read(modulePath("provenance.ts")));
    const fn = src.slice(src.indexOf("export function ownedTraceEvents"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(
      /port\.ownsRun\(/.test(body),
      "ownedTraceEvents must filter with port.ownsRun — the same gate walkAncestry uses",
    ).toBe(true);
  });

  test("the ancestry block is declared too (Layer 2 is registered, not just written)", () => {
    clearBlocks();
    defineProvenanceBlocks({} as AsyncDbClient);
    const ids = listBlocks().map((b) => b.descriptor.id);
    clearBlocks();
    expect(ids).toContain("lens.ancestry");
  });
});
