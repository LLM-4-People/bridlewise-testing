// @vitest-environment node
/**
 * Mechanical enforcement: Frontend Contracts Owner (Single-Party-Owner
 * contracts audit).
 *
 * Guarantees: "Single-Party-Owner Principle" + "Deny-by-
 * Default / Explicit-Add" + "No Scattered Helpers" + +.
 *
 * The `shared/` directory is the SINGLE source of truth for shared
 * types + literals consumed by BOTH the server (`server/`) AND the client
 * (`src/`). Before  several wire types were DUPLICATED across
 * `server/` + `src/` as structurally-identical parallel definitions — a
 * drift class (a field added on one side without the other would silently
 * break the wire, exactly the bug class closed for SSE event names).
 * consolidated the PURE wire types into `shared/wire-types.ts` +
 * `shared/web-ui-types.ts` (files the SERVER can import via NodeNext —
 * NO `@harness/*` path aliases, mirroring `shared/ui-schema.ts`).
 *
 * This test pins the architecture across 6 assurance classes (DYNAMIC
 * discovery — `readdirSync` walks `server/` + `src/` + `shared/`;
 * no hardcoded file/type lists; a new file is auto-covered):
 *
 * A — `shared/constants.ts` is the SINGLE owner of its exports
 * (SSE_EVENT_TYPES, SseEventType, isKnownSseEventType,
 * CSRF_CUSTOM_HEADER, CONTENT_TYPE_JSON, MAX_PATH_LENGTH,
 * MAX_FILE_NAME_LENGTH). No parallel definition of these names in
 * `server/` or `src/` (SSE owner + CSRF owner).
 * B — `shared/ui-schema.ts` is the SINGLE owner of the UI schema wire
 * types (UiSchema, MenuEntry, PanelEntry, WidgetEntry, SettingEntry,
 * ActionEntry, SignalEntry, …). No parallel definition in `server/`
 * or `src/`.
 * C — The -consolidated types (parsed DYNAMICALLY from
 * `shared/web-ui-types.ts` + `shared/wire-types.ts` — ToolKind,
 * MemorySource, MemoryTier, MemoryEntryView, MessageView,
 * MetricsSnapshotView, SystemMetrics) are defined ONLY in `shared/`.
 * No parallel `export type X =` / `export const X =` in `server/` or
 * `src/` (a re-introduced parallel def is caught).
 * D — `shared/wire-types.ts` + `shared/web-ui-types.ts` have NO
 * `@harness/*` imports (the architectural constraint that lets the
 * SERVER import them via NodeNext — the server tsconfig has no path
 * aliases). A `@harness/*` import would break the server build.
 * E — DENY-BY-DEFAULT REGISTRY: every type defined in BOTH `server/` and
 * `src/` (same name) is EITHER (a) consolidated/registered in
 * `shared/`, OR (b) a zod-inferred mirror (the server's
 * `z.infer<...>` pattern — the zod schema owns the shape), OR
 * (c) covered by an explicit `// contract-drift-guard: <name>`
 * marker in this file (a documented unmovable type with a
 * canonical-harness dependency that blocks consolidation). A NEW
 * plain duplication is caught — it must be consolidated OR marked +
 * guarded.
 * F — DRIFT GUARDS: for each `// contract-drift-guard: <name>` marker,
 * parse the server + client definitions' field names (or union
 * members) + assert they match. A field-name drift between the two
 * unmovable mirrors is caught at runtime (vitest runs this).
 *
 * Mutation-verified: re-adding a local `export type ToolKind =` in the
 * server → C FAILS; re-adding a `const SSE_EVENT_TYPES` in a route → A
 * FAILS; adding a `@harness/` import to wire-types.ts → D FAILS; adding a
 * new plain duplicated type without a marker → E FAILS; renaming a field
 * on one side of a guarded type → F FAILS.
 */
import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, sep } from "node:path";
import {
  read,
  relpath,
  sourceFilesReachableFrom,
  stripCommentsAndStringsDropFor,
  stripCommentsOnly,
  walkTs,
} from "../helpers/source-scan.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const REPO_ROOT = process.cwd();
const CONTRACTS_DIR = join(REPO_ROOT, "shared");
const SERVER_DIR = join(REPO_ROOT, "server");
const SRC_DIR = join(REPO_ROOT, "src");
const CONSTANTS_PATH = join(CONTRACTS_DIR, "constants.ts");
const UI_SCHEMA_PATH = join(CONTRACTS_DIR, "ui-schema.ts");
const WEB_UI_TYPES_PATH = join(CONTRACTS_DIR, "web-ui-types.ts");
const WIRE_TYPES_PATH = join(CONTRACTS_DIR, "wire-types.ts");
const INPUT_SCHEMAS_PATH = join(CONTRACTS_DIR, "input-schemas.ts");
const EVENT_TYPES_PATH = join(CONTRACTS_DIR, "event-types.ts");

// ── Dynamic file discovery ──
//
// THE TWO STRIPPERS THIS FILE USED TO CARRY ARE GONE. They were private copies
// of two variants the shared owner already exposes by name, and the copy is
// what made class D vacuous: a specifier scan was handed the view that blanks
// string interiors, which is where specifiers live. The owner names its views
// so a caller has to choose one, and the choice is now visible at each site —
// `stripCommentsAndStringsDropFor` where a match must be CODE, `stripCommentsOnly`
// where the thing being matched is itself a string.

/** Parse the exported TYPE names defined as `export type X =...` or
 * `export interface X...` in a source file (comment-stripped). Returns a
 * Set of names. */
function parseExportedTypeNames(src: string, path: string): Set<string> {
  const code = stripCommentsAndStringsDropFor(src, path);
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const typeRe = /export\s+type\s+([A-Z][A-Za-z0-9_]*)\b/g;
  while ((m = typeRe.exec(code)) !== null) names.add(m[1]!);
  const ifaceRe = /export\s+interface\s+([A-Z][A-Za-z0-9_]*)\b/g;
  while ((m = ifaceRe.exec(code)) !== null) names.add(m[1]!);
  return names;
}

/** Parse the exported VALUE (const/function) names: `export const X` /
 * `export function X` (comment-stripped). */
function parseExportedValueNames(src: string, path: string): Set<string> {
  const code = stripCommentsAndStringsDropFor(src, path);
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  const constRe = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  while ((m = constRe.exec(code)) !== null) names.add(m[1]!);
  const fnRe = /export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  while ((m = fnRe.exec(code)) !== null) names.add(m[1]!);
  return names;
}

// The full file trees, scanned once.
const SERVER_FILES = walkTs(SERVER_DIR);
const SRC_FILES = walkTs(SRC_DIR);
const CONTRACTS_FILES = walkTs(CONTRACTS_DIR);

// ── A. shared/constants.ts single-owner ──

describe("A. shared/constants.ts is the SINGLE owner of its exports", () => {
  const constantsSrc = read(CONSTANTS_PATH);
  // ALL exported value names parsed dynamically from the owner (the test
  // does NOT hardcode a 6-name list — every export is protected against a
  // parallel definition, so a new constant added to constants.ts is auto-
  // covered). This is the same dynamic pattern section B uses for types.
  const ownedValues = parseExportedValueNames(constantsSrc, CONSTANTS_PATH);
  const ownedTypes = parseExportedTypeNames(constantsSrc, CONSTANTS_PATH); // incl. SseEventType

  test("the constants owner exports a non-trivial value surface (sanity — not silently empty)", () => {
    expect(ownedValues.size, "shared/constants.ts must export values (parsed dynamically)").toBeGreaterThan(0);
    expect(ownedTypes.has("SseEventType"), "shared/constants.ts must export type SseEventType").toBe(true);
  });

  test("no parallel definition of ANY constants-owner export in server/ or src/", () => {
    const offenders: string[] = [];
    for (const f of [...SERVER_FILES, ...SRC_FILES]) {
      if (f === CONSTANTS_PATH) continue;
      const code = stripCommentsAndStringsDropFor(read(f), f);
      // A parallel `const NAME =` or `function NAME(` definition of ANY
      // constants-owner export. Checking every export (not a hardcoded 6)
      // means a new constant is auto-protected against a scattered re-
      // definition.
      for (const v of ownedValues) {
        if (new RegExp(`(?:export\\s+)?const\\s+${v}\\s*=`).test(code)) {
          offenders.push(`${relpath(f)}: const ${v}`);
        }
        if (new RegExp(`(?:export\\s+)?function\\s+${v}\\s*\\(`).test(code)) {
          offenders.push(`${relpath(f)}: function ${v}`);
        }
      }
      // A parallel `type SseEventType =` of any constants-owner type.
      for (const t of ownedTypes) {
        if (new RegExp(`(?:export\\s+)?type\\s+${t}\\s*=`).test(code)) {
          offenders.push(`${relpath(f)}: type ${t}`);
        }
      }
    }
    expect(
      offenders,
      `constants-owner exports must be defined ONLY in shared/constants.ts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

// ── B. shared/ui-schema.ts single-owner ──

describe("B. shared/ui-schema.ts is the SINGLE owner of the UI schema wire types", () => {
  const uiSchemaSrc = read(UI_SCHEMA_PATH);
  const ownedTypes = parseExportedTypeNames(uiSchemaSrc, UI_SCHEMA_PATH);

  test("the ui-schema owner defines the UI schema types (sanity)", () => {
    expect(ownedTypes.size, "shared/ui-schema.ts must export types").toBeGreaterThan(0);
    // Spot-check a few canonical names (parsed dynamically above).
    for (const t of ["UiSchema", "MenuEntry", "PanelEntry", "SettingEntry", "SignalEntry"]) {
      expect(ownedTypes.has(t), `shared/ui-schema.ts must export type ${t}`).toBe(true);
    }
  });

  test("no parallel definition of the ui-schema types in server/ or src/", () => {
    const offenders: string[] = [];
    for (const f of [...SERVER_FILES, ...SRC_FILES]) {
      if (f === UI_SCHEMA_PATH) continue;
      const code = stripCommentsAndStringsDropFor(read(f), f);
      for (const t of ownedTypes) {
        // A DEFINITION is `export type X =` (the `=` distinguishes it from a
        // re-export `export { type X } from`, which has no `=` after X). An
        // interface definition is `interface X {` or `interface X extends`.
        const typeDefRe = new RegExp(`(?:export\\s+)?type\\s+${t}\\s*=`);
        const ifaceDefRe = new RegExp(`(?:export\\s+)?interface\\s+${t}\\s*[<{]`);
        if (typeDefRe.test(code) || ifaceDefRe.test(code)) {
          offenders.push(`${relpath(f)}: ${t}`);
        }
      }
    }
    expect(
      offenders,
      `ui-schema types must be defined ONLY in shared/ui-schema.ts: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

// ── C. /-consolidated types defined ONLY in shared/ ──

describe("C. /-consolidated types are defined ONLY in shared/ (no parallel def)", () => {
  // Parse the consolidated type + const names DYNAMICALLY from the
  // contracts owners (wire-types/web-ui-types + input-schemas +
  // event-types).
  const webUiTypesSrc = read(WEB_UI_TYPES_PATH);
  const wireTypesSrc = read(WIRE_TYPES_PATH);
  const inputSchemasSrc = read(INPUT_SCHEMAS_PATH);
  const eventTypesSrc = read(EVENT_TYPES_PATH);
  const consolidatedTypes = new Set<string>([
    ...parseExportedTypeNames(webUiTypesSrc, WEB_UI_TYPES_PATH),
    ...parseExportedTypeNames(wireTypesSrc, WIRE_TYPES_PATH),
    ...parseExportedTypeNames(inputSchemasSrc, INPUT_SCHEMAS_PATH),
    ...parseExportedTypeNames(eventTypesSrc, EVENT_TYPES_PATH),
  ]);
  const consolidatedValues = new Set<string>([
    ...parseExportedValueNames(webUiTypesSrc, WEB_UI_TYPES_PATH),
    ...parseExportedValueNames(wireTypesSrc, WIRE_TYPES_PATH),
    ...parseExportedValueNames(inputSchemasSrc, INPUT_SCHEMAS_PATH),
    ...parseExportedValueNames(eventTypesSrc, EVENT_TYPES_PATH),
  ]);

  test("the consolidated owners define types + values (sanity — not silently empty)", () => {
    expect(consolidatedTypes.size, "contracts owners must define types").toBeGreaterThan(0);
    // Spot-check the -moved names.
    for (const t of ["ToolKind", "MemoryEntryView", "MessageView", "SystemMetrics"]) {
      expect(consolidatedTypes.has(t), `consolidated owner must define ${t}`).toBe(true);
    }
    expect(consolidatedValues.has("MEMORY_SOURCES"), "consolidated owner must define MEMORY_SOURCES").toBe(true);
    // Spot-check the -moved names (wire-input contracts).
    for (const t of ["ProjectCreateInput", "ChatCreateInput", "AutoCheckCreateInput"]) {
      expect(consolidatedTypes.has(t), `input-schemas owner must define ${t}`).toBe(true);
    }
    for (const v of ["PROJECT_CREATE_SCHEMA", "CHAT_CREATE_SCHEMA", "AUTO_CHECK_CREATE_SCHEMA"]) {
      expect(consolidatedValues.has(v), `input-schemas owner must define ${v}`).toBe(true);
    }
    // Spot-check the event-kind vocabulary owner.
    expect(consolidatedTypes.has("EventKind"), "event-types owner must define EventKind").toBe(true);
    expect(consolidatedValues.has("EVENT_KINDS"), "event-types owner must define EVENT_KINDS").toBe(true);
    expect(consolidatedValues.has("EVENT_KIND_SCHEMA"), "event-types owner must define EVENT_KIND_SCHEMA").toBe(true);
  });

  test("no parallel `export type X =` / `export const X =` for the consolidated names in server/ or src/", () => {
    const offenders: string[] = [];
    for (const f of [...SERVER_FILES, ...SRC_FILES]) {
      if (
        f === WEB_UI_TYPES_PATH ||
        f === WIRE_TYPES_PATH ||
        f === INPUT_SCHEMAS_PATH ||
        f === EVENT_TYPES_PATH
      )
        continue;
      const code = stripCommentsAndStringsDropFor(read(f), f);
      for (const t of consolidatedTypes) {
        if (new RegExp(`(?:export\\s+)?(?:type|interface)\\s+${t}\\s*[={]`).test(code)) {
          offenders.push(`${relpath(f)}: type ${t}`);
        }
      }
      for (const v of consolidatedValues) {
        if (new RegExp(`(?:export\\s+)?const\\s+${v}\\s*=`).test(code)) {
          offenders.push(`${relpath(f)}: const ${v}`);
        }
      }
    }
    expect(
      offenders,
      `consolidated types/values must be defined ONLY in shared/ (web-ui-types.ts + wire-types.ts + input-schemas.ts + event-types.ts): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

// ── D. EVERY SPECIFIER THE SERVER'S PROGRAM REACHES MUST RESOLVE THE WAY
//      NODE RESOLVES IT ────────────────────────────────────────────────────
//
// ── WHAT THIS CLASS USED TO BE, AND WHY IT COULD NEVER FAIL ───────────────
//
// Five tests, each matching `/from\s+["']@harness\//` against ONE named file's
// stripped view. The stripper was a LOCAL COPY that blanks string-literal
// interiors — and a module specifier IS a string literal. Driven:
//
//     raw source matches : true
//     stripped view      : import { x } from "                  ";
//     stripped matches   : false
//
// All five passed with an `@harness/*` import planted in `wire-types.ts`, at
// exit 0, while this file's header claimed the mutation fails. The local copy
// is gone; the shared owner exposes both views by name, and the view that
// keeps specifiers is the one a specifier scan asks for.
//
// ── AND THE QUESTION WAS THE WRONG ONE ANYWAY ─────────────────────────────
//
// The spelling `@harness/…` is ONE way to write an unresolvable specifier. The
// invariant is not about spelling: `tsconfig.server.json` declares no `paths`,
// and `npm run serve` is `node --experimental-strip-types`, which has no path
// mapping at all — so what the server needs is that EVERY specifier in its
// program resolves as a real file or a real installed package.
//
// ── THE POPULATION, AND WHAT IT IS NOT ────────────────────────────────────
//
// This comment used to say "137 unique cross-repository edges, of which 131
// are relative, 6 are aliases and 0 are bare", and that sentence named a
// population this class does not cover. It was wrong in BOTH directions —
// too large for the covered set and too small for the repository. The two
// figures, each with the command that produced it:
//
//   THE CLOSURE THIS CLASS WALKS — `sourceFilesReachableFrom(walkTs("server"),
//   "all")`, 118 entry points, 370 files:
//       69 cross-repository RELATIVE edges, 0 alias, 0 bare.
//
//   THE WHOLE REPOSITORY — a byte scan of the 999 files under `src`, `server`,
//   `shared`, `tests`:
//       135 cross-repository relative edges, 6 alias.
//
// So 66 relative edges and ALL SIX aliases sit outside what is judged here.
// Every one of the 66 is under `tests/`. The six aliases are all in
// `shared/types.ts`, and that file appears **0 times** in
// `tsc --noEmit --listFiles -p tsconfig.server.json` (664 files, exit 0) — it
// is not in the server's program at all, which is precisely why it is allowed
// to hold aliases and why they cannot stop the server starting.
//
// ── SHOULD `tests/` BE IN SCOPE? MEASURED, AND THE ANSWER IS NO ───────────
//
// Not a budget answer — the walk costs 269 ms from `server/` and 679 ms from
// `server` + `tests`, which is affordable. The reason is that the instrument
// cannot read a test tree correctly, and would report 67 violations that do
// not exist. Driven: the same walk from 497 test entry points reaches 1,159
// files and reports 67 unresolved specifiers, and every one inspected is an
// import statement INSIDE A TEMPLATE-LITERAL FIXTURE — synthetic source a
// guard feeds to its own matcher:
//
//     `import { gestureKeysFor } from "../shell/mouse-paths.ts";\n…`
//
// A test tree contains source-as-DATA, and a specifier scanner reading raw
// bytes cannot tell a fixture's import from a real one. Extending the scope
// would therefore trade a real gap for 67 false refusals, which is the worse
// trade: a guard that cries wolf is switched off, and then covers nothing.
//
// What the gap actually is, stated rather than waved away: a stale relative
// cross-repository path in a test file. It fails LOUDLY the moment that file
// runs, and `declared-pattern-liveness` already refuses a test-runner glob
// that selects nothing, so "the file never runs" is itself guarded. The
// residual is a test file that runs and whose stale import is only reached on
// a branch — and closing that needs the scan to read a view with template
// literal interiors blanked, which is the same nested-template-literal work
// the shared lexer still owes.
//
// So this class judges the RESOLVED EDGE over a DISCOVERED population: the
// compile-time closure of `server/`, walked with `"all"` edges because `tsc`
// follows `import type` and `shared/block-contract.ts`'s single
// cross-repository import is type-only — a runtime walk would have dropped the
// one edge most worth looking at.
//
// ── WHAT IS AND IS NOT A VIOLATION HERE, STATED ───────────────────────────
//
// A relative cross-repository specifier is NOT a violation, and saying so is
// part of the guard. Driven: `tsc --noEmit -p tsconfig.server.json` exits 0
// over a 664-file program that already contains 344 files from the sibling
// repository. NodeNext resolves those paths and so does node. What breaks the
// server is a specifier that resolves to NOTHING — which is what an alias is,
// once you are outside the project that declares it.
//
// ── THE RUNG, AND WHY THIS ONE STILL EARNS ITS PLACE ──────────────────────
//
// Rung 4 already exists and is stronger: `npm run typecheck` runs
// `typecheck:server`, and an `@harness/*` import in a server-reachable file
// fails it with TS2307 (driven: exit 2, `Cannot find module
// '@harness/tool-manifest'`). This class is rung 5 and adds the two things the
// compiler cannot say: it names the ARCHITECTURE rather than a missing module,
// and it guards the property that keeps rung 4 honest — that
// `tsconfig.server.json` declares no `paths`. Adding `paths` there would make
// `tsc` green while `node` still cannot start, which is the one repair the
// compiler's own message invites.

describe("D. every specifier the server's program reaches resolves without a path alias", () => {
  // The population, discovered: every file the server can reach at COMPILE
  // time. Not a list of five contracts files — the closure is what `tsc`
  // actually compiles, so a new contracts file is covered because it was
  // imported, not because somebody remembered it.
  const serverEntrypoints = walkTs(SERVER_DIR);
  const closure = sourceFilesReachableFrom(serverEntrypoints, "all");
  const contractsInClosure = closure.files
    .filter((f) => f.startsWith(`${CONTRACTS_DIR}${sep}`))
    .map(relpath)
    .sort();

  test("the closure is a real population, and it contains the contracts layer", () => {
    // §20b: the numbers this class bounds, stated at runtime. The floors are
    // relationships, not remembered constants — the closure must be strictly
    // larger than the entry set it was grown from, and every entry point must
    // be inside it.
    expect(serverEntrypoints.length, "server/ must hold files to walk").toBeGreaterThan(0);
    expect(
      closure.files.length,
      `compile-time closure (${String(closure.files.length)}) must exceed the ` +
        `${String(serverEntrypoints.length)} entry points it was grown from`,
    ).toBeGreaterThan(serverEntrypoints.length);
    expect(closure.entrypoints.length).toBe(serverEntrypoints.length);
    expect(
      contractsInClosure.length,
      "the server must reach the contracts layer, or this class is judging the wrong program",
    ).toBeGreaterThan(0);
    // ── THE EDGE KIND IS ASSERTED, NOT ASSUMED ──────────────────────────
    //
    // An earlier draft witnessed this with `shared/block-contract.ts`, on
    // the reasoning that its only cross-repository import is type-only. That
    // was a wrong witness and it let the inert mutation through: the FILE is
    // reached by an ordinary value import from `ui-schema.ts`, so it sits in
    // both closures and swapping `"all"` for `"runtime"` changed nothing the
    // test looked at. Driven: exit 0, 28 passed, with the walk judging the
    // wrong graph.
    //
    // So the difference itself is the witness. The compile-time closure must
    // be a STRICT superset of the runtime one — a relationship, not a name,
    // so it stays true as the graph changes. Measured today: 370 against 359,
    // the 11 files reachable only through `import type`, among them
    // `shared/web-ui-types.ts`, which is one of the five files the vacuous
    // version of this class used to name.
    const runtimeOnly = sourceFilesReachableFrom(serverEntrypoints, "runtime");
    const runtimeFiles = new Set(runtimeOnly.files);
    const typeOnlyReached = closure.files.filter((f) => !runtimeFiles.has(f));
    expect(
      typeOnlyReached.length,
      "the compile-time closure must exceed the runtime one, or this class is walking runtime edges " +
        "and cannot see the specifiers only a compiler has to resolve",
    ).toBeGreaterThan(0);
    for (const file of runtimeOnly.files) {
      expect(closure.files, `${relpath(file)} is runtime-reachable and must also be compile-reachable`)
        .toContain(file);
    }
  });

  test("every BARE specifier in that closure resolves to a real module (no path aliases)", () => {
    // An alias is not a spelling to look for — it is a specifier that node
    // cannot resolve. Asking resolution rather than shape covers every alias
    // this project has, every alias it might add, and a mistyped package name
    // as well.
    const unresolvable: string[] = [];
    for (const [specifier, sites] of closure.bareSpecifiers) {
      if (isBuiltin(specifier)) continue;
      const resolvedSomewhere = sites.some((site) => {
        try {
          createRequire(site).resolve(specifier);
          return true;
        } catch {
          return false;
        }
      });
      if (!resolvedSomewhere) {
        unresolvable.push(`${specifier} (named by ${sites.map(relpath).join(", ")})`);
      }
    }
    expect(
      unresolvable,
      "the server has no path aliases and node has no path mapping, so a specifier that " +
        `resolves to no installed module cannot be started: ${unresolvable.join("; ")}`,
    ).toEqual([]);
  });

  test("every RELATIVE specifier in that closure resolves to a file on disk", () => {
    // All 69 cross-repository relative edges in this closure — the bare-
    // specifier test above judges 0 of them, because this closure contains no
    // alias and no bare cross-repository specifier at all. A relative path
    // that has gone stale is exactly as fatal as an alias and was never
    // looked at until this test existed.
    expect(
      [...closure.unresolved],
      `relative specifiers reaching nothing: ${closure.unresolved.join("; ")}`,
    ).toEqual([]);
    // A computed specifier cannot be resolved by any source scan; its number
    // is asserted rather than assumed to be zero.
    expect(closure.dynamicUnresolved, "computed specifiers this scan cannot follow").toBe(0);
  });

  test("tsconfig.server.json declares no `paths` — the property that keeps the compiler honest", () => {
    // THE GATE ABOVE THIS ONE, GUARDED. `tsc` only rejects `@harness/*`
    // because the server project has no path mapping. Adding one would turn
    // the compiler green while `node --experimental-strip-types` still fails
    // at require time, and nothing else in this repository would notice.
    const config = JSON.parse(read(join(REPO_ROOT, "tsconfig.server.json"))) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(
      config.compilerOptions?.["paths"],
      "a `paths` entry here makes tsc agree with a resolution node cannot perform",
    ).toBeUndefined();
    expect(config.compilerOptions?.["moduleResolution"]).toBe("NodeNext");
  });
});

// ── E. DENY-BY-DEFAULT REGISTRY: every server+src type-overlap is accounted for ──

describe("E. every type defined in BOTH server/ and src/ is consolidated OR zod OR drift-guarded", () => {
  // Build {name -> [serverFiles]} and {name -> [srcFiles]} for exported types.
  const serverTypes = new Map<string, string[]>(); // name -> [file paths that DEFINE it]
  for (const f of SERVER_FILES) {
    for (const name of parseExportedTypeNames(read(f), f)) {
      if (!serverTypes.has(name)) serverTypes.set(name, []);
      serverTypes.get(name)!.push(f);
    }
  }
  const srcTypes = new Map<string, string[]>();
  for (const f of SRC_FILES) {
    for (const name of parseExportedTypeNames(read(f), f)) {
      if (!srcTypes.has(name)) srcTypes.set(name, []);
      srcTypes.get(name)!.push(f);
    }
  }
  // The set of names defined in BOTH server/ and src/ (the overlap class).
  const overlap = new Set<string>();
  for (const name of serverTypes.keys()) {
    if (srcTypes.has(name)) overlap.add(name);
  }

  // The set of names defined or re-exported in shared/ (the registry).
  const contractsNames = new Set<string>();
  for (const f of CONTRACTS_FILES) {
    const src = read(f);
    for (const name of parseExportedTypeNames(src, f)) contractsNames.add(name);
    // Re-exports: `export type { X } from...` / `export { type X } from...`.
    const reTypeRe = /export\s+type\s+\{([^}]*)\}\s*from/g;
    let m: RegExpExecArray | null;
    while ((m = reTypeRe.exec(src)) !== null) {
      for (const part of m[1]!.split(",")) {
        const nm = part.trim().replace(/^type\s+/, "").trim();
        if (nm.length > 0) contractsNames.add(nm);
      }
    }
    const reInlineRe = /export\s+\{([^}]*)\}\s*from/g;
    while ((m = reInlineRe.exec(src)) !== null) {
      for (const part of m[1]!.split(",")) {
        const cleaned = part.trim().replace(/^type\s+/, "").trim();
        if (cleaned.length > 0 && !cleaned.includes(" as ")) contractsNames.add(cleaned);
      }
    }
  }

  // The drift-guard markers declared in THIS file (deny-by-default — a new
  // unmovable type must be marked here so it is covered by Class F).
  const thisFile = read(__filename ?? join(REPO_ROOT, "tests", "prevention", "frontend-contracts-owner.test.ts"));
  const guardedNames = new Set<string>();
  const guardRe = /\/\/\s*contract-drift-guard:\s*([A-Z][A-Za-z0-9_]*)/g;
  let gm: RegExpExecArray | null;
  while ((gm = guardRe.exec(thisFile)) !== null) guardedNames.add(gm[1]!);

  test("the overlap set is non-empty (sanity — the audit has something to check)", () => {
    expect(overlap.size, "expected at least one type defined in both server/ and src/").toBeGreaterThan(0);
  });

  test("every server+src type-overlap is consolidated in shared/, zod-inferred, OR drift-guarded", () => {
    const unaccounted: string[] = [];
    for (const name of overlap) {
      // (a) consolidated/registered in shared/?
      if (contractsNames.has(name)) continue;
      // (b) zod-inferred mirror? The server's definition is `z.infer<...>`.
      const serverIsZod = serverTypes.get(name)!.some((f) => {
        const code = stripCommentsAndStringsDropFor(read(f), f);
        return new RegExp(`export\\s+type\\s+${name}\\s*=\\s*z\\.infer\\b`).test(code);
      });
      if (serverIsZod) continue;
      // (c) covered by an explicit drift-guard marker in this file?
      if (guardedNames.has(name)) continue;
      unaccounted.push(name);
    }
    expect(
      unaccounted,
      `types defined in BOTH server/ and src/ that are NOT consolidated in shared/, NOT zod-inferred, and NOT drift-guarded: ${unaccounted.join(", ")}. ` +
        `Either consolidate the type into shared/wire-types.ts (preferred), OR add a \`// contract-drift-guard: <name>\` marker below + a Class F field-name check.`,
    ).toEqual([]);
  });
});

// ── F. DRIFT GUARDS for the unmovable plain duplications ──
//
// These types have a canonical-harness dependency (WebToolEntry extends
// ToolManifestEntry from @harness/*) or per-side dep-name differences
// (ChatHistoryView composes server-local ChatSummaryView/ToolCallRowView
// vs client-local ChatSummary/ToolCallViewRow) that block consolidation
// into a server-importable contracts file (the @harness/* path-alias
// boundary — the server tsconfig has no path aliases). They stay mirrored
// server↔client; these guards catch a field-name drift at runtime.
//
// To add a new unmovable type: add a `// contract-drift-guard: <TypeName>`
// marker (so Class E accounts for it) + a field-name comparison below.
//
// contract-drift-guard: WebToolEntry
// contract-drift-guard: ChatHistoryView

/** Parse the field names of a `export type X =... Readonly<{... }>`
 * declaration. The fields may be `readonly FIELD:` (a direct readonly
 * declaration) OR `FIELD:` (the `Readonly<{...}>` wrapper makes them
 * readonly via the mapped type — e.g. `WebToolEntry = ToolManifestEntry &
 * Readonly<{ category:...; kind:... }>`). Returns the set of field names
 * in the FIRST `Readonly<{...}>` block after the `=`. */
function extractReadonlyFields(src: string, path: string, typeName: string): Set<string> {
  const fields = new Set<string>();
  const code = stripCommentsAndStringsDropFor(src, path);
  const decl = code.match(
    new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*[\\s\\S]*?Readonly\\s*<\\s*\\{([\\s\\S]*?)\\}\\s*>\\s*;`),
  );
  if (!decl) return fields;
  for (const line of decl[1]!.split("\n")) {
    // `readonly FIELD:` OR `FIELD:` (the Readonly<{...}> wrapper makes the
    // field readonly even without the `readonly` keyword).
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[:?]/.exec(line);
    if (m) fields.add(m[1]!);
  }
  return fields;
}

/** Split a code body on a separator that occurs at bracket-depth 0 (so a
 * `,` inside a nested `z.object({...})` does not split a top-level field).
 * Tracks `{`, `(`, `[` vs `}`, `)`, `]`. */
function splitTopLevel(body: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Extract the top-level field names of a `export const NAME = z.object({...})`
 * or `z.strictObject({...})` schema. Returns the set of field names (the
 * identifiers before `:` at depth 0 of the object body). Used to verify a
 * server zod schema + a client `Readonly<{...}>` mirror declare the same
 * field names (a zod-inferred mirror drift guard — Class F). */
function extractZodObjectFields(src: string, path: string, constName: string): Set<string> {
  const fields = new Set<string>();
  const code = stripCommentsAndStringsDropFor(src, path);
  const declRe = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*z\\.(?:strictObject|object)\\s*\\(`,
  );
  const m = declRe.exec(code);
  if (!m) return fields;
  // Find the `{` that starts the object body (after the `(`).
  let i = m.index! + m[0].length;
  while (i < code.length && code[i] !== "{") i += 1;
  if (code[i] !== "{") return fields;
  // Bracket-match the outer `{...}`.
  let depth = 0;
  let j = i;
  while (j < code.length) {
    if (code[j] === "{") depth += 1;
    else if (code[j] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  if (depth !== 0 || code[j] !== "}") return fields;
  const body = code.slice(i + 1, j);
  for (const part of splitTopLevel(body, ",")) {
    const fm = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(part);
    if (fm) fields.add(fm[1]!);
  }
  return fields;
}

/** Extract the field names of a NESTED `z.object({...})` value at
 * `fieldName` within a `export const NAME = z.object({...})` schema. For
 * example, `tokenMetrics: z.object({...}).optional()` — this returns the
 * field names inside the nested `z.object({...})` for `tokenMetrics`.
 * Returns an empty set when the field is not a nested z.object (e.g. a
 * plain `z.string()`). Used to verify the nested sub-object field names
 * match between a server zod schema + a client `Readonly<{...}>` mirror. */
function extractZodNestedObjectFields(src: string, path: string, constName: string, fieldName: string): Set<string> {
  const fields = new Set<string>();
  const code = stripCommentsAndStringsDropFor(src, path);
  const declRe = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*z\\.(?:strictObject|object)\\s*\\(`,
  );
  const m = declRe.exec(code);
  if (!m) return fields;
  let i = m.index! + m[0].length;
  while (i < code.length && code[i] !== "{") i += 1;
  if (code[i] !== "{") return fields;
  let depth = 0;
  let j = i;
  while (j < code.length) {
    if (code[j] === "{") depth += 1;
    else if (code[j] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    j += 1;
  }
  if (depth !== 0 || code[j] !== "}") return fields;
  const body = code.slice(i + 1, j);
  // Find the top-level field segment for `fieldName`.
  for (const part of splitTopLevel(body, ",")) {
    const fm = new RegExp(`^\\s*${fieldName}\\s*:`).exec(part);
    if (!fm) continue;
    // Within this segment, find the first `z.object({...})` or
    // `z.strictObject({...})` and bracket-match its body. Allow whitespace
    // around the `.` (zod schemas are often formatted `z\n  .object({...})`).
    const objMatch = /z\s*\.\s*(?:strictObject|object)\s*\(/.exec(part);
    if (!objMatch) return fields;
    let k = objMatch.index! + objMatch[0].length;
    while (k < part.length && part[k] !== "{") k += 1;
    if (part[k] !== "{") continue;
    let d2 = 0;
    let e = k;
    while (e < part.length) {
      if (part[e] === "{") d2 += 1;
      else if (part[e] === "}") {
        d2 -= 1;
        if (d2 === 0) break;
      }
      e += 1;
    }
    if (d2 !== 0 || part[e] !== "}") continue;
    const nestedBody = part.slice(k + 1, e);
    for (const subPart of splitTopLevel(nestedBody, ",")) {
      const sfm = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(subPart);
      if (sfm) fields.add(sfm[1]!);
    }
  }
  return fields;
}

describe("F. drift guards for unmovable plain duplications (field names match server↔client)", () => {
  test("WebToolEntry: server (tools-bridge.ts) + client (shared/types.ts) declare the same extra fields", () => {
    // contract-drift-guard: WebToolEntry
    const serverFields = extractReadonlyFields(read(modulePath("tools-bridge.ts")), modulePath("tools-bridge.ts"), "WebToolEntry");
    const clientFields = extractReadonlyFields(read("shared/types.ts"), "shared/types.ts", "WebToolEntry");
    expect(serverFields.size, "server WebToolEntry must declare extra fields").toBeGreaterThan(0);
    expect(clientFields.size, "client WebToolEntry must declare extra fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client WebToolEntry missing fields the server sends: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client WebToolEntry has fields the server does not send: ${extra.join(", ")}`).toEqual([]);
  });

  test("ChatHistoryView: server (views.ts) + client (client.ts) declare the same field names", () => {
    // contract-drift-guard: ChatHistoryView
    const serverFields = extractReadonlyFields(read(modulePath("views.ts")), modulePath("views.ts"), "ChatHistoryView");
    const clientFields = extractReadonlyFields(read(modulePathMatching("src/client.ts")), modulePathMatching("src/client.ts"), "ChatHistoryView");
    expect(serverFields.size, "server ChatHistoryView must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client ChatHistoryView must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client ChatHistoryView missing fields the server sends: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client ChatHistoryView has fields the server does not send: ${extra.join(", ")}`).toEqual([]);
  });

  // The two PAGED history shapes (DESIGN-PERFORMANCE §4). They compose the
  // per-side view types whose names differ (server `ChatSummaryView` /
  // `ToolCallRowView` vs client `ChatSummary` / `ToolCallViewRow`), which is
  // the same reason `ChatHistoryView` above cannot move to shared/. The
  // scalar half — `HistoryPageView`, which is what decides whether the
  // surface may say "this is the beginning of the conversation" — IS
  // consolidated in shared/wire-types.ts, so the sentence-deciding fields
  // have one owner and only the composition is mirrored.
  test("ChatHistoryPageView: server (views.ts) + client (client.ts) declare the same field names", () => {
    // contract-drift-guard: ChatHistoryPageView
    const serverFields = extractReadonlyFields(read(modulePath("views.ts")), modulePath("views.ts"), "ChatHistoryPageView");
    const clientFields = extractReadonlyFields(read(modulePathMatching("src/client.ts")), modulePathMatching("src/client.ts"), "ChatHistoryPageView");
    expect(serverFields.size, "server ChatHistoryPageView must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client ChatHistoryPageView must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client ChatHistoryPageView missing fields the server sends: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client ChatHistoryPageView has fields the server does not send: ${extra.join(", ")}`).toEqual([]);
  });

  test("ChatMessagePageView: server (views.ts) + client (client.ts) declare the same field names", () => {
    // contract-drift-guard: ChatMessagePageView
    const serverFields = extractReadonlyFields(read(modulePath("views.ts")), modulePath("views.ts"), "ChatMessagePageView");
    const clientFields = extractReadonlyFields(read(modulePathMatching("src/client.ts")), modulePathMatching("src/client.ts"), "ChatMessagePageView");
    expect(serverFields.size, "server ChatMessagePageView must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client ChatMessagePageView must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client ChatMessagePageView missing fields the server sends: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client ChatMessagePageView has fields the server does not send: ${extra.join(", ")}`).toEqual([]);
  });

  // MessageMetadata is a zod-inferred mirror: the server owns the zod
  // schema (server/db/schema.ts MESSAGE_METADATA); the client owns a manual
  // Readonly<{...}> mirror (src/state/chat-messages.ts MessageMetadata) that
  // uses named sub-types (TokenMetrics, TimingMetrics, RunContext, EventKind)
  // + narrows eventKind to the EventKind enum (a client refinement — the
  // server's schema accepts any string for eventKind). Moving the schema to
  // shared/ would lose the named sub-types + the enum narrowing, so the
  // mirror stays + these field-name guards catch a drift (a field added or
  // renamed on one side without the other).
  test("MessageMetadata: server zod schema (server/db/schema.ts) + client mirror (src/state/chat-messages.ts) declare the same top-level field names", () => {
    // contract-drift-guard: MessageMetadata
    const serverFields = extractZodObjectFields(read(modulePathMatching("server/db/schema.ts")), modulePathMatching("server/db/schema.ts"), "PUBLIC_MESSAGE_METADATA");
    const clientFields = extractReadonlyFields(read(modulePath("chat-messages.ts")), modulePath("chat-messages.ts"), "MessageMetadata");
    expect(serverFields.size, "server PUBLIC_MESSAGE_METADATA must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client MessageMetadata must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client MessageMetadata missing fields the server persists: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client MessageMetadata has fields the server does not persist: ${extra.join(", ")}`).toEqual([]);
  });

  test("MessageMetadata.tokenMetrics: server nested z.object + client TokenMetrics declare the same field names", () => {
    const serverFields = extractZodNestedObjectFields(read(modulePathMatching("server/db/schema.ts")), modulePathMatching("server/db/schema.ts"), "PUBLIC_MESSAGE_METADATA", "tokenMetrics");
    const clientFields = extractReadonlyFields(read(modulePath("chat-messages.ts")), modulePath("chat-messages.ts"), "TokenMetrics");
    expect(serverFields.size, "server tokenMetrics nested object must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client TokenMetrics must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client TokenMetrics missing fields: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client TokenMetrics has extra fields: ${extra.join(", ")}`).toEqual([]);
  });

  test("MessageMetadata.timingMetrics: server nested z.object + client TimingMetrics declare the same field names", () => {
    const serverFields = extractZodNestedObjectFields(read(modulePathMatching("server/db/schema.ts")), modulePathMatching("server/db/schema.ts"), "PUBLIC_MESSAGE_METADATA", "timingMetrics");
    const clientFields = extractReadonlyFields(read(modulePath("chat-messages.ts")), modulePath("chat-messages.ts"), "TimingMetrics");
    expect(serverFields.size, "server timingMetrics nested object must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client TimingMetrics must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client TimingMetrics missing fields: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client TimingMetrics has extra fields: ${extra.join(", ")}`).toEqual([]);
  });

  test("MessageMetadata.context: server nested z.object + client RunContext declare the same field names", () => {
    const serverFields = extractZodNestedObjectFields(read(modulePathMatching("server/db/schema.ts")), modulePathMatching("server/db/schema.ts"), "PUBLIC_MESSAGE_METADATA", "context");
    const clientFields = extractReadonlyFields(read(modulePath("chat-messages.ts")), modulePath("chat-messages.ts"), "RunContext");
    expect(serverFields.size, "server context nested object must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "client RunContext must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `client RunContext missing fields: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `client RunContext has extra fields: ${extra.join(", ")}`).toEqual([]);
  });

  // McpServerWrite is a zod-inferred mirror: the server owns the zod gate
  // (`server/integrations/mcp-bridge.ts` MCP_SERVER_WRITE_SCHEMA — the
  // route's strict body schema); the wire type the settings form posts
  // against lives in `shared/wire-types.ts`. Moving the schema into shared/
  // would drag zod + the policy bounds into the client bundle, so the mirror
  // stays + this field-name guard catches a drift (a field added or renamed
  // on one side without the other — the form would post a body the gate
  // refuses, or never send a field the gate accepts).
  test("McpServerWrite: server zod schema (server/integrations/mcp-bridge.ts) + shared mirror (shared/wire-types.ts) declare the same top-level field names", () => {
    // contract-drift-guard: McpServerWrite
    const serverFields = extractZodObjectFields(read(modulePathMatching("server/integrations/mcp-bridge.ts")), modulePathMatching("server/integrations/mcp-bridge.ts"), "MCP_SERVER_WRITE_SCHEMA");
    const clientFields = extractReadonlyFields(read(WIRE_TYPES_PATH), WIRE_TYPES_PATH, "McpServerWrite");
    expect(serverFields.size, "server MCP_SERVER_WRITE_SCHEMA must declare fields").toBeGreaterThan(0);
    expect(clientFields.size, "shared McpServerWrite must declare fields").toBeGreaterThan(0);
    const missing = [...serverFields].filter((f) => !clientFields.has(f));
    const extra = [...clientFields].filter((f) => !serverFields.has(f));
    expect(missing, `shared McpServerWrite missing fields the gate accepts: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `shared McpServerWrite has fields the gate refuses: ${extra.join(", ")}`).toEqual([]);
  });

  // DiagnosticModesState is the array door's small wire contract: the server
  // block's read output (`server/blocks/settings.ts`) and the client mirror
  // (`src/cockpit/settings/settings-data.ts`) must agree on the block id,
  // the action name and the two fields the read serves — a drift on any of
  // the three leaves the section posting at a door that is not there or
  // rendering fields the read does not carry.
  test("DiagnosticModesState: server block (server/blocks/settings.ts) + client mirror (settings-data.ts) agree on the block id, the action name and the read's fields", () => {
    // contract-drift-guard: DiagnosticModesState
    const serverSrc = read(modulePathMatching("server/blocks/settings.ts"));
    const clientSrc = read(join(SRC_DIR, "cockpit/settings/settings-data.ts"));
    expect(clientSrc, "the client must name the block the server registers").toMatch(
      /DIAGNOSTIC_MODES_BLOCK\s*=\s*"settings\.diagnosticModes"/u,
    );
    expect(serverSrc, "the server must register that exact block id").toMatch(
      /id:\s*"settings\.diagnosticModes"/u,
    );
    expect(clientSrc, "the client must name the action the block declares").toMatch(
      /DIAGNOSTIC_MODES_SET_ACTION\s*=\s*"set"/u,
    );
    const clientFields = extractReadonlyFields(clientSrc, join(SRC_DIR, "cockpit/settings/settings-data.ts"), "DiagnosticModesState");
    expect([...clientFields].sort()).toEqual(["excluded", "modes"]);
    // The read's output object declares the same two fields, and nothing
    // else the client mirror does not know.
    const outputBlock = serverSrc.match(/output:\s*z\.strictObject\(\{([\s\S]*?)\}\),/u);
    expect(outputBlock, "the block's read must declare a strict output object").not.toBeNull();
    const serverFields = new Set(
      [...outputBlock![1]!.matchAll(/^\s*([a-zA-Z]+):\s*z\./gmu)].map((m) => m[1]!),
    );
    expect([...serverFields].sort()).toEqual(["excluded", "modes"]);
  });
});

// ── G. wire-input types are re-exported (not re-defined) in src/state ──
//
// Class C catches a NEW local `export type X = ...` re-definition in src/.
// Class G is the positive complement: it verifies the client state files
// actually re-export the -consolidated input types FROM contracts (so a
// regression that drops the re-export entirely — leaving the type
// unimported — is caught even before a consumer compile breaks). The
// expected re-export sites are DYNAMICALLY derived from the input-schemas
// owner (the set of exported types); the test does not hardcode the list.

describe("G. wire-input types are re-exported from shared/ in the client state", () => {
  const inputSchemasSrc = read(INPUT_SCHEMAS_PATH);
  const inputTypes = parseExportedTypeNames(inputSchemasSrc, INPUT_SCHEMAS_PATH);

  test("the input-schemas owner exports types (sanity — not silently empty)", () => {
    expect(inputTypes.size, "shared/input-schemas.ts must export types").toBeGreaterThan(0);
  });

  test("every input type is re-exported from shared/ somewhere in src/state/", () => {
    const stateDir = join(SRC_DIR, "state");
    const stateFiles = walkTs(stateDir);
    const missing: string[] = [];
    for (const t of inputTypes) {
      const reExported = stateFiles.some((f) => {
        // stripCommentsOnly (not stripCommentsAndStringsFor) keeps string
        // interiors so the `from "..."shared/input-schemas.ts` path is
        // matchable. Comments are stripped so a commented-out re-export
        // does not false-match.
        const code = stripCommentsOnly(read(f));
        // A re-export: `export type { X } from "...shared/input-schemas.ts"`
        // OR `export type { X, ... } from "...shared/input-schemas.ts"`.
        const reRe = new RegExp(
          `export\\s+type\\s+\\{[^}]*\\b${t}\\b[^}]*\\}\\s*from\\s*["'][^"']*shared/input-schemas\\.ts["']`,
        );
        return reRe.test(code);
      });
      if (!reExported) missing.push(t);
    }
    expect(
      missing,
      `input types not re-exported from shared/input-schemas.ts in src/state/: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the server routes import the input SCHEMAS from shared/ (not a local re-definition)", () => {
    const inputSchemas = parseExportedValueNames(inputSchemasSrc, INPUT_SCHEMAS_PATH);
    const routesDir = join(SERVER_DIR, "routes");
    const routeFiles = walkTs(routesDir);
    const missing: string[] = [];
    for (const v of inputSchemas) {
      // A re-definition in a route (`const X = z.strictObject(...)`) is
      // already caught by Class C. This check verifies the routes IMPORT
      // the schema value from contracts (the positive wiring).
      const imported = routeFiles.some((f) => {
        // stripCommentsOnly keeps the import path string intact.
        const code = stripCommentsOnly(read(f));
        const importRe = new RegExp(
          `import\\s+\\{[^}]*\\b${v}\\b[^}]*\\}\\s*from\\s*["'][^"']*shared/input-schemas\\.ts["']`,
        );
        return importRe.test(code);
      });
      if (!imported) missing.push(v);
    }
    expect(
      missing,
      `input schemas not imported from shared/input-schemas.ts in server/routes/: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

// ── H. event-kind vocabulary single-owner + schema drift guards ──
//
// The eventKind vocabulary (hallucination, steering, bias, self-healing,
// error, ui_control) was scattered across 4 inconsistent definitions
// (server zod string, server zod 5-value enum, server 4-value union, client
// 6-value union). consolidates it into `shared/event-types.ts` (the
// single owner). This class verifies:
//   1. the server's persisted-blob schema (`MESSAGE_METADATA`) validates
//      `eventKind` against the canonical `EVENT_KIND_SCHEMA` (NOT a raw
//      `z.string()` — the prior drift that accepted any string + a lying
//      comment claiming alignment with the client).
//   2. the server's event-message metadata schema
//      (`MESSAGE_EVENT_METADATA`) uses `EVENT_KIND_SCHEMA` (NOT an inline
//      enum literal — the prior 5-value inline enum that drifted from the
//      client's 6-value type).
//   3. the client's `EventKind` is re-exported from contracts (not a local
//      inline union — the prior 6-value inline union).
//   4. the server's `persistInlineEvent` param uses the canonical `EventKind`
//      (not a 4-value inline union).

describe("H. event-kind vocabulary single-owner + schema drift guards", () => {
  test("shared/event-types.ts defines the canonical EventKind + EVENT_KINDS + EVENT_KIND_SCHEMA", () => {
    // stripCommentsOnly keeps string interiors so the canonical kind
    // literals ("hallucination", etc.) are matchable.
    const code = stripCommentsOnly(read(EVENT_TYPES_PATH));
    expect(code, "EventKind must be exported").toMatch(/export\s+type\s+EventKind\s*=\s*z\.infer\b/);
    expect(code, "EVENT_KINDS const must be exported").toMatch(/export\s+const\s+EVENT_KINDS\b/);
    expect(code, "EVENT_KIND_SCHEMA const must be exported").toMatch(/export\s+const\s+EVENT_KIND_SCHEMA\s*=\s*z\.enum\(/);
    // The 6 canonical kinds must all appear in the EVENT_KINDS tuple.
    for (const kind of ["hallucination", "steering", "bias", "self-healing", "error", "ui_control"]) {
      expect(code, `EVENT_KINDS must include "${kind}"`).toContain(`"${kind}"`);
    }
  });

  test("server MESSAGE_METADATA.eventKind validates against EVENT_KIND_SCHEMA (not z.string())", () => {
    const code = stripCommentsOnly(read(modulePathMatching("server/db/schema.ts")));
    // The persisted-blob schema must reference EVENT_KIND_SCHEMA for
    // eventKind (the canonical validation). A raw `z.string()` would
    // re-introduce the drift (accept any string + the lying comment).
    expect(code, "MESSAGE_METADATA must import EVENT_KIND_SCHEMA").toMatch(/import\s+\{[^}]*EVENT_KIND_SCHEMA[^}]*\}\s*from\s+["'][^"']*shared\/event-types\.ts["']/);
    // Find the eventKind field in the MESSAGE_METADATA object + verify it
    // uses EVENT_KIND_SCHEMA (not z.string()).
    expect(code, "MESSAGE_METADATA.eventKind must use EVENT_KIND_SCHEMA.optional()").toMatch(/eventKind:\s*EVENT_KIND_SCHEMA\.optional\(\)/);
    // Deny-by-default: no `eventKind: z.string()` in the schema (the prior
    // drift — a re-introduction would accept any string again).
    expect(code, "no raw z.string() for eventKind (was the prior drift)").not.toMatch(/eventKind:\s*z\.string\(\)\.optional\(\)/);
  });

  test("server MESSAGE_EVENT_METADATA.eventKind uses EVENT_KIND_SCHEMA (not an inline enum)", () => {
    const code = stripCommentsOnly(read(modulePathMatching("server/db/schema.ts")));
    expect(code, "MESSAGE_EVENT_METADATA.eventKind must use EVENT_KIND_SCHEMA").toMatch(/eventKind:\s*EVENT_KIND_SCHEMA\b/);
    // Deny-by-default: no inline `z.enum(["hallucination", ...])` for
    // eventKind (the prior 5-value inline enum that drifted).
    expect(code, "no inline z.enum for eventKind (was the prior drift)").not.toMatch(
      /eventKind:\s*z\.enum\(\s*\[\s*"hallucination"/,
    );
  });

  test("client EventKind is re-exported from shared/ (not a local inline union)", () => {
    const code = stripCommentsOnly(read(modulePath("chat-messages.ts")));
    // A local inline union `export type EventKind = "hallucination" | ...`
    // is a re-definition (caught by Class C). This check verifies the
    // POSITIVE wiring: the file imports EventKind from contracts + re-
    // exports it.
    expect(code, "chat-messages.ts must import EventKind from shared/event-types.ts").toMatch(
      /import\s+type\s+\{\s*EventKind\s*\}\s*from\s+["'][^"']*shared\/event-types\.ts["']/,
    );
    expect(code, "chat-messages.ts must re-export EventKind").toMatch(/export\s+type\s+\{\s*EventKind\s*\}/);
    // Deny-by-default: no local inline union re-definition (the prior
    // 6-value inline union that drifted from the server).
    expect(code, "no local inline EventKind union (was the prior drift)").not.toMatch(
      /export\s+type\s+EventKind\s*=\s*"hallucination"/,
    );
  });

  test("server persistInlineEvent param uses the canonical EventKind (not a 4-value inline union)", () => {
    const code = stripCommentsOnly(runPathSource());
    expect(code, "run.ts must import EventKind from shared/event-types.ts").toMatch(
      /import\s+type\s+\{\s*EventKind\s*\}\s*from\s+["'][^"']*shared\/event-types\.ts["']/,
    );
    // The persistInlineEvent param must use EventKind (the canonical type).
    expect(code, "persistInlineEvent param must use EventKind").toMatch(/eventKind:\s*EventKind\b/);
    // Deny-by-default: no inline 4-value union for the param (the prior
    // drift — a re-introduction would drift from the canonical vocab).
    expect(code, "no inline 4-value eventKind union (was the prior drift)").not.toMatch(
      /eventKind:\s*"hallucination"\s*\|\s*"steering"\s*\|\s*"bias"\s*\|\s*"self-healing"/,
    );
  });
});
