// @vitest-environment node
/**
 * Mechanical enforcement: RECORDING IS STRUCTURALLY UNAVOIDABLE.
 *
 * Binding guideline: "we must ensure things cannot NOT be recorded... we don't
 * want to have to remember to code them or pass them into a function."
 *
 * THE MEASURED DEFECT
 *
 * Recording used to happen wherever somebody wrote `recorder.recordX(...)` —
 * about ten call sites, essentially all in one route file. Against 24,816 real
 * events: `actor_kind` was the constant `"harness"` for ALL of them, `outcome`
 * was null on 87%, and `traceId` on 100%. The ledger had a rich model and
 * recorded the same value every time.
 *
 * The answer was two structures, not more call sites:
 *   - an ambient `AsyncLocalStorage` context entered ONCE at the request
 *     boundary, so a handler is attributed without opting in; and
 *   - `recordEffect(kind, name, fn)`, which cannot forget `outcome` because it
 *     is holding the result.
 *
 * A guard on "did you remember to record" would reproduce the original defect.
 * These classes guard the STRUCTURES instead: one import boundary, one sink,
 * one place the boundary is entered, and a closed kind vocabulary.
 *
 * Assurance classes:
 *   A. Discovery is live (the kind map parsed, the call sites were found).
 *   B. Every `recordEffect*` kind literal is mapped in the ONE kind table.
 *      An unmapped kind does not fail — it falls to `"resource"`, which is the
 *      silent-miscategorisation shape the explicit table exists to prevent.
 *      The table lives in the engine's timeline vocabulary; the population it
 *      is held against is EVERY producer tree (server/, src/ and engine/src)
 *      because both sinks — the web bridge and the harness runtime
 *      bootstrap — consume the same table.
 *   C. The recording primitives are reached ONLY through `server/canonical.ts`.
 *      A module importing the harness path directly is a second boundary. The
 *      denied module set is DERIVED from the hub's own re-exports — every
 *      module canonical.ts re-exports from, no hand list.
 *   D. The ambient boundary is entered in the ROUTER and nowhere else in
 *      `server/`. A per-route `withRecordingContext` is something a route can
 *      forget; the dispatch is the choke point every request already crosses.
 *   E. `setEffectSink` is installed exactly once, by the timeline bridge.
 *   F. RATCHET — the number of declared effect kinds that NOTHING produces may
 *      only fall. See the baseline comment for what remains.
 *
 * DISCOVERY IS DYNAMIC: the kind table is parsed from its owner
 * (`engine/src/timeline/timeline-types.ts`), the call sites by walking
 * `server/`, `src/` and `engine/src`. Wrapping a new choke point, or adding a
 * kind, needs no edit here.
 */
import { describe, test, expect } from "vitest";

import { walk, read, relpath, sourceFiles, stripCommentsOnly } from "../helpers/source-scan.ts";
import { callArgumentsOf } from "../helpers/function-scope.ts";
import { hubDecoratedPopulation, hubEngineSpanCalls, hubNamespaceSourcePaths, bareEngineValueReExports } from "../helpers/hub-population.ts";
import { ENGINE_SPAN_EXCLUSIONS } from "../../engine/src/performance/engine-instrumentation.ts";
import { readArchitectureModuleDecisions } from "../../engine/src/workflow/architecture-module-entries.ts";
import { architectureModuleId } from "../../engine/src/architecture-manifest.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const TIMELINE_BRIDGE = modulePath("timeline-bridge.ts");
let manifestModulesCache: readonly Readonly<{ path: string; id: string }>[] | undefined;
/**
 * Every engine src/ module's architecture id (engine-relative path → id), once
 * per file run: its decision's id, or the id its path derives — read as data
 * from the decisions file, the module list being the tree's own.
 */
const manifestModules = (): readonly Readonly<{ path: string; id: string }>[] => {
  if (manifestModulesCache !== undefined) return manifestModulesCache;
  const { entries } = readArchitectureModuleDecisions(read(modulePath("architecture-modules.ts")));
  const idByPath = new Map(entries.flatMap((entry) => entry.id === undefined ? [] : [[entry.path, entry.id] as const]));
  manifestModulesCache = sourceFiles("engine/src").filter((path) => path.endsWith(".ts")).map((path) => {
    const engineRelative = path.slice("engine/".length);
    return { path: engineRelative, id: idByPath.get(engineRelative) ?? architectureModuleId(engineRelative) };
  });
  return manifestModulesCache;
};
const CANONICAL_HUB = modulePath("canonical.ts");
const ROUTER = modulePath("router.ts");
/** The engine module that owns the effect-kind → ledger-lane table. */
const EFFECT_KIND_TABLE_OWNER = modulePath("timeline-types.ts");
/** The harness runtime's sink — the second consumer of the ONE kind table. */
const HARNESS_BOOTSTRAP = modulePath("harness-bootstrap.ts");
/** Every tree whose code can wrap a choke point in `recordEffect*`. */
const PRODUCER_ROOTS = ["server", "src", "engine/src"] as const;

/**
 * Effect kinds the ONE sink table knows how to categorise, parsed from the
 * timeline vocabulary module that owns it (`EFFECT_KIND_EVENT_TYPES`). Parsed
 * rather than imported because exporting the table's entries purely for a
 * test would move ownership to satisfy the guard, which is backwards.
 */
function declaredKinds(): string[] {
  const src = stripCommentsOnly(read(EFFECT_KIND_TABLE_OWNER));
  const at = src.indexOf("EFFECT_KIND_EVENT_TYPES");
  if (at === -1) return [];
  const open = src.indexOf("{", src.indexOf("=", at));
  const close = src.indexOf("}", open);
  if (open === -1 || close === -1) return [];
  return [...src.slice(open, close).matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
}

/** Every `recordEffect*(...)` kind literal, with its file. */
function producedKinds(): { kind: string; where: string }[] {
  const out: { kind: string; where: string }[] = [];
  for (const root of PRODUCER_ROOTS) {
    for (const file of walk(root, { exts: [".ts", ".svelte"] })) {
      const rel = relpath(file);
      const code = stripCommentsOnly(read(rel));
      for (const m of code.matchAll(/\brecordEffect(?:Auto|Async)?\s*\(\s*["']([^"']+)["']/g)) {
        out.push({ kind: m[1]!, where: rel });
      }
    }
  }
  return out;
}

/**
 * Declared kinds with no producing call site. ZERO: every kind in the ONE
 * sink table is wrapped at a real choke point —
 *   tool       — server/tool-executor.ts::executeToolCall
 *   git        — server/git-bridge.ts::gitText (mutating invocations only;
 *                read-only git is not an effect and is not recorded)
 *   llm        — server/llm-bridge.ts::recordProviderStream (one effect per
 *                provider call, never per token)
 *   process    — server/tool-executor.ts::spawnSyncSafe (execute_command) and
 *                server/auto-check-runner.ts::spawnCapture (check subprocesses)
 *   filesystem — server/routes/filesystem.ts (the non-project mkdir)
 *   http       — server/router/router.ts::dispatch (the handler call)
 *   db         — server/db/async-client.ts::call and ::transaction
 *   action     — engine/src/shared/exposure/action.ts (block ACTION verbs)
 *   engine     — engine/src/performance/engine-instrumentation.ts
 *                (engineSpans: every function-valued re-export of the
 *                canonical hub, decorated at the ONE boundary server code
 *                crosses)
 * The former speculative entries (`file`, `provider`, `network`, `memory` —
 * kinds neither producer tree ever emitted) were REMOVED when the two private
 * sink tables were merged into the vocabulary's one: a declared kind nothing
 * produces is a lane that lies. File effects are recorded by the editor
 * bridge via the purpose-built `recordFileEffect` (real before/after digests
 * — see file-effect-recording.test.ts), never through the generic sink.
 * This number may only FALL — it cannot: a kind added to the table with
 * nothing producing it now fails immediately, which is the ratchet's endpoint.
 */
const UNPRODUCED_KIND_BASELINE = 0;

describe("recording choke points — performing the work IS recording it", () => {
  test("A. discovery is live (the kind table parsed and call sites were found)", () => {
    expect(
      declaredKinds().length,
      `no effect kinds parsed from ${TIMELINE_BRIDGE} — the scan is broken, not the tree`,
    ).toBeGreaterThan(2);
    expect(
      producedKinds().length,
      "no recordEffect call site found — either the scan broke or recording was removed",
    ).toBeGreaterThan(0);
  });

  test("B. every recorded effect kind is mapped in the ONE sink table", () => {
    const declared = new Set(declaredKinds());
    const unmapped = producedKinds()
      .filter((p) => !declared.has(p.kind))
      .map((p) => `${p.where}: recordEffect("${p.kind}", …) — no entry in EFFECT_KIND_EVENT_TYPES`);
    expect(
      [...new Set(unmapped)],
      `An unmapped kind does not throw: the sink falls back to the \`"resource"\` display floor,\n` +
        `so the event lands in the ledger under a category nobody is looking at — and the web\n` +
        `bridge warns at runtime. The table in ${EFFECT_KIND_TABLE_OWNER} is the single owner of\n` +
        `kind → ledger event type, consumed by BOTH sinks (the web bridge and the harness\n` +
        `runtime bootstrap).\n` +
        unmapped.join("\n"),
    ).toEqual([]);
  });

  test("B2. the sink consumes the ONE table — no private kind mapping beside a sink", () => {
    // The two sinks each carried a private `EFFECT_EVENT_TYPE` mirror "kept
    // identical" by hand, and they already disagreed (the web table had no
    // entry for the one kind the engine actually produces; the engine table
    // had four entries nothing produces). The merge made the vocabulary
    // module the single owner — this arm holds the extraction in place: a
    // private table re-forming beside either sink reds.
    const bridge = stripCommentsOnly(read(TIMELINE_BRIDGE));
    expect(
      bridge,
      `${TIMELINE_BRIDGE} must map kinds through eventTypeForEffectKind/EFFECT_KIND_EVENT_TYPES\n` +
        `from the canonical hub — a private mapping table is the drift this round removed.`,
    ).not.toMatch(/EFFECT_EVENT_TYPE\s*[:=]/);
    expect(bridge).toContain("createTimelineEffectSink(");
    const sharedSink = stripCommentsOnly(read(modulePath("effect-sink.ts")));
    expect(sharedSink).toMatch(/eventTypeForEffectKind\(record\.kind\)/);
    expect(sharedSink).toContain("EFFECT_KIND_EVENT_TYPES[record.kind]");
    const bootstrap = read(HARNESS_BOOTSTRAP);
    expect(
      bootstrap,
      `the harness runtime's sink must consume the shared table too — its private\n` +
        `mirror was the second half of the drift.`,
    ).toContain("createTimelineEffectSink(");
    expect(bootstrap).not.toMatch(/EFFECT_EVENT_TYPE\s*[:=]/);
  });

  test("C. the recording primitives are reached only through the canonical hub", () => {
    // The denied module set is DERIVED from the hub itself: every module
    // canonical.ts re-exports from is a module the hub has made a decision
    // about (which value forms may be re-exported, which only types), and a
    // server file importing one directly is a second import path that
    // bypasses those decisions. No hand list — a module newly re-exported
    // by the hub is covered the day the re-export lands.
    const hubSource = read(CANONICAL_HUB);
    const hubModules = [...hubSource.matchAll(/from\s+["'](\.\.\/\.\.\/engine\/src\/[^"']+)["']/g)]
      .map((m) => m[1]!.replace(/^\.\.\/\.\.\/engine\/src\//u, ""));
    expect(
      new Set(hubModules).size,
      "no hub re-exports parsed — the derived deny-list is blind, not empty",
    ).toBeGreaterThan(10);
    // Each module path becomes a specifier fragment; the trailing .ts is
    // optional so an extensionless import of the same module is caught too.
    const alternation = hubModules
      .map((m) => m.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\\.ts$/u, "(?:\\.ts)?"))
      .join("|");
    const directImport = new RegExp(`from\\s+["']([^"']*engine\\/src\\/(?:${alternation}))["']`, "g");
    // The ONE declared bypass, with its reason (and held to importing nothing else).
    const HUB_BYPASS: Readonly<Record<string, string>> = {
      [modulePath("process-fault-policy.ts")]: "the server's FIRST import installs the process fault policy before any other module loads — the hub's own graph included — so a fault while the hub loads is already the policy's (SCALE-CR1 C2, SCALE-CR1-FIX H2)",
    };
    for (const bypass of Object.keys(HUB_BYPASS)) {
      const imports = [...stripCommentsOnly(read(bypass)).matchAll(/^import\s[^;]*?["']([^"']+)["']/gmu)].map((m) => m[1]);
      expect(imports, `${bypass} imports the fault policy and nothing else`).toEqual(["../../engine/src/process/fault-policy.ts"]);
    }
    const offenders: string[] = [];
    for (const root of ["server", "src"]) {
      for (const file of walk(root, { exts: [".ts", ".svelte"] })) {
        const rel = relpath(file);
        if (rel === CANONICAL_HUB || rel in HUB_BYPASS) continue;
        const code = stripCommentsOnly(read(rel));
        for (const hit of code.matchAll(directImport)) {
          offenders.push(`${rel} imports "${hit[1]}" directly instead of through ${CANONICAL_HUB}`);
        }
      }
    }
    expect(
      offenders,
      `The hub owns the relative path to the harness tree. A second import path is a second\n` +
        `place to update, and it bypasses the hub's documented decisions about which value\n` +
        `forms may be re-exported at all. Re-exporting a FUNCTION through the hub is not a\n` +
        `neutral move: every value re-export is span-decorated, so inside a recording context\n` +
        `each call becomes an "engine" ledger event. Decide which it is — an effect worth\n` +
        `recording, or machinery (a pure formatter, a hot config resolution) that belongs in\n` +
        `ENGINE_SPAN_EXCLUSIONS with its review fields.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("D. the request boundary exists, and no nested boundary invents an actor", () => {
    const routerCode = stripCommentsOnly(read(ROUTER));
    expect(
      /\bwithRecordingContext\s*\(/.test(routerCode),
      `${ROUTER} must enter the recording context — it is the choke point every request\n` +
        `already crosses, which is what lets a handler be attributed without opting in.`,
    ).toBe(true);

    // Boundaries NEST by design (a request, then a run, then a turn), so a
    // second call site is not the defect. The defect is a nested boundary
    // supplying a made-up actor: that is exactly how `actor_kind` came to be
    // the constant "harness" for all 24,816 events. A boundary that does not
    // resolve a real identity must carry the ambient one forward.
    const invented: string[] = [];
    for (const file of walk("server", { exts: [".ts"] })) {
      const rel = relpath(file);
      if (rel === CANONICAL_HUB) continue;
      // THE BALANCED ARGUMENT LIST, not its first 200 bytes: a boundary whose
      // context object is longer than the window fell OUT of the population
      // silently, and a guard's universe must not be decided by a byte count.
      //
      // THE RAW SOURCE, NOT A STRIPPED VIEW. `callArgumentsOf` parses, so a
      // comment cannot contribute a call and stripping buys nothing — while the
      // stripper blanks the CONTENTS of string and regular-expression literals,
      // which left a regular expression unterminated and made this file
      // unparseable. Measured: this exact call threw `source_structure_unparsable`
      // until the strip was removed.
      for (const args of callArgumentsOf(read(rel), "withRecordingContext", rel)) {
        const arg = /^\s*\{([\s\S]*?)\}\s*,/.exec(args)?.[1] ?? args;
        const actor = /\bactor\s*:\s*([^,}]+)/.exec(arg)?.[1]?.trim();
        if (actor === undefined) {
          invented.push(`${rel}: a recording boundary supplies no actor`);
          continue;
        }
        // Either the ambient actor is carried forward, or an identity is
        // resolved by a named function (the router's resolveRequestActor).
        if (/^currentActor\s*\(/.test(actor)) continue;
        if (/^[A-Za-z_$][\w$]*(\s*\(|$)/.test(actor)) continue;
        invented.push(`${rel}: recording boundary hardcodes actor \`${actor}\``);
      }
    }
    expect(
      invented,
      `A nested boundary that invents an actor overwrites the identity the outer boundary\n` +
        `resolved — the exact mechanism that made "who did this" unanswerable. Pass\n` +
        `currentActor() (carry it forward) or a resolver that derives a real identity.\n` +
        invented.join("\n"),
    ).toEqual([]);
  });

  test("D2. the router mints a TRACE ID into the request boundary", () => {
    // Trace identity used to begin only at the FIRST effect span
    // (`withSpan` falling back to `traceId = spanId`), so an HTTP request,
    // its run, its LLM calls and its tool calls shared no id a client could
    // quote, and a request that failed before any effect had NO trace at
    // all. The mint belongs at the dispatch — the one boundary every request
    // crosses — and the minted id must reach the recording context, from
    // where ambient provenance carries it into every ledger event without
    // any call site passing it by hand.
    const routerCode = stripCommentsOnly(read(ROUTER));
    // MINTED at dispatch, by the canonical generator, under the trace domain.
    expect(
      routerCode,
      `${ROUTER} must mint the request's trace id with the canonical id generator ` +
        `(generateId("trace")) — a second id grammar here would not match the ` +
        `ledger's identifier contract.`,
    ).toMatch(/\bgenerateId\s*\(\s*["']trace["']\s*\)/);
    // STAMPED on the response, so the client can quote it back.
    expect(
      routerCode,
      `${ROUTER} must stamp the minted trace id on the response via the shared ` +
        `header constant — a header the client cannot see is a trace nobody ` +
        `can ask about.`,
    ).toMatch(/res\.setHeader\s*\(\s*TRACE_ID_HEADER\s*,\s*traceId\s*\)/);
    // ENTERED into the recording context: the withRecordingContext call in
    // the router carries the traceId field, so every event written under the
    // request inherits it. Parsed from the BALANCED argument list of the
    // actual call (the same parser class D uses), not a byte window — a
    // boundary whose argument object grew would silently fall out of a
    // regex's reach.
    const boundaryArgs = callArgumentsOf(read(ROUTER), "withRecordingContext", relpath(ROUTER));
    expect(
      boundaryArgs.length,
      "the router's request boundary was not found — the scan is broken, not the tree",
    ).toBeGreaterThan(0);
    const carriesTrace = boundaryArgs.some((args) => /\btraceId\b/.test(args));
    expect(
      carriesTrace,
      `the router's withRecordingContext call must carry traceId so every ledger ` +
        `event under the request is traceable. Arguments seen: ${JSON.stringify(boundaryArgs)}`,
    ).toBe(true);
  });

  test("E. the effect sink is installed exactly once, by the timeline bridge", () => {
    const installers: string[] = [];
    for (const file of walk("server", { exts: [".ts"] })) {
      const rel = relpath(file);
      if (rel === CANONICAL_HUB) continue; // the hub re-exports, it does not call
      const calls = stripCommentsOnly(read(rel)).match(/\bsetEffectSink\s*\(/g);
      for (let i = 0; i < (calls?.length ?? 0); i++) installers.push(rel);
    }
    expect(
      installers,
      `The sink is a module-level slot: a second installer silently replaces the first, and\n` +
        `every effect after that point lands somewhere else (or nowhere). Installers found:\n` +
        installers.join("\n"),
    ).toEqual([TIMELINE_BRIDGE]);
  });

  test(`F. ratchet — declared kinds nothing produces stays at or below ${UNPRODUCED_KIND_BASELINE}`, () => {
    const produced = new Set(producedKinds().map((p) => p.kind));
    const unproduced = declaredKinds().filter((k) => !produced.has(k));
    expect(
      unproduced.length,
      `Declared effect kinds with no producing call site rose to ${unproduced.length} ` +
        `(baseline ${UNPRODUCED_KIND_BASELINE}): ${unproduced.join(", ")}.\n` +
        `Declaring a kind is a promise that its choke point is wrapped. Wrap it with\n` +
        `recordEffect/recordEffectAsync, or drop the table entry. If a choke point was\n` +
        `legitimately wrapped, LOWER UNPRODUCED_KIND_BASELINE to lock the gain in.`,
    ).toBeLessThanOrEqual(UNPRODUCED_KIND_BASELINE);
  });

  // ── G. engine auto-instrumentation: the hub IS the decoration choke point ──
  //
  // The measured hole: engine internals were dark — a new engine function
  // became server-visible the moment the hub re-exported it, but nothing
  // wrapped it, so coverage was manual forever. The fix is structural: the
  // hub's VALUE re-exports are destructured from `engineSpans(...)`, so every
  // re-export is decorated the day it lands and the only way to bypass the
  // decoration is a bare `export { … } from "../../engine/src/…"` statement —
  // the exact shape this class refuses. The reviewed hot-path/machinery
  // exclusions live in the decoration owner's own table; the function
  // manifest's own test cross-checks them against the real generated
  // manifest (engine/test/performance/function-manifest.test.ts).

  test("G. every hub value re-export flows through the engine-span decoration — no bare engine value re-export exists", () => {
    // Deny-by-default: a bare statement is the only bypass, so it is refused
    // outright. A NEW re-export added through the engineSpans destructure is
    // covered the day it lands with no edit anywhere else.
    const bare = bareEngineValueReExports();
    expect(
      bare,
      `A bare value re-export from an engine path crosses the hub WITHOUT the\n` +
        `engine-span decoration — an uninstrumented server-visible engine function,\n` +
        `the exact hole this class exists to close. Destructure the names from\n` +
        `engineSpans(<namespace>, "<architecture-module-id>") instead:\n` +
        bare.join("\n"),
    ).toEqual([]);
    // And the decorated population is alive: a scan that parsed nothing is
    // blind, not empty.
    const population = hubDecoratedPopulation();
    expect(
      population.length,
      "no engineSpans destructures parsed from the hub — the scan is broken, not the tree",
    ).toBeGreaterThan(40);
    // A name may be re-exported exactly once — the hub is one export surface,
    // and a duplicate destructure would shadow silently.
    const names = population.map((p) => p.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate hub re-export names: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
    // Every module id the hub names must be a real architecture module — the
    // ids also key the exclusion table and the function manifest cross-check.
    // The manifest's blocks, read as data by their one reader (property order
    // and layout free) — never by importing the ~480 KB generated module,
    // which would carry it into the browser-side test closure.
    const declaredIds = new Set(manifestModules().map((module) => module.id));
    const unknownIds = [...new Set(population.map((p) => p.moduleId))].filter((id) => !declaredIds.has(id));
    expect(
      unknownIds,
      `The hub passes engineSpans an architecture module id the architecture manifest\n` +
        `does not declare — the id keys the exclusion table and the manifest\n` +
        `cross-check, so a wrong id is a silent hole, not a label.\n${unknownIds.join("\n")}`,
    ).toEqual([]);
  });

  test("G2. every engine-span exclusion is a reviewed member of the hub population", () => {
    // The exclusions are the ONLY way out of the decoration, so each one must
    // name a REAL hub re-export (a stale exclusion is a lie about coverage) and
    // carry the four review fields (the manifest's own exclusion discipline —
    // rationale, owner, evidence, scope).
    const population = new Set(hubDecoratedPopulation().map((p) => `${p.moduleId}:${p.name}`));
    const problems: string[] = [];
    for (const [key, exclusion] of Object.entries(ENGINE_SPAN_EXCLUSIONS)) {
      if (!population.has(key)) {
        problems.push(`${key}: excluded but not re-exported by the hub — a stale exclusion`);
      }
      if (exclusion.rationale.trim().length === 0) problems.push(`${key}: exclusion has no rationale`);
      if (exclusion.owner.trim().length === 0) problems.push(`${key}: exclusion has no owner`);
      if (exclusion.evidence.length === 0) problems.push(`${key}: exclusion has no evidence`);
      if (exclusion.scope.trim().length === 0) problems.push(`${key}: exclusion has no scope`);
    }
    expect(
      problems,
      `Exclusions are the one escape from the auto-decoration, so they are held\n` +
        `to the reviewed-exclusion discipline the function manifest itself enforces.\n` +
        problems.join("\n"),
    ).toEqual([]);
  });

  test("G3. every engine-span call names the architecture module its namespace imports", () => {
    // A real id attached to the WRONG module is a silent mislabel: the id
    // exists, so the id census above stays green, while every span the call
    // records is attributed to a module that never ran the code — and the
    // exclusion table and function-manifest cross-check key on exactly that
    // id. The correspondence is derived from the two registries that own
    // the facts: the hub's own import statements (namespace → source path)
    // and the architecture manifest (path → id). No hand map.
    const idByPath = new Map(manifestModules().map((module) => [module.path, module.id]));
    expect(
      idByPath.size,
      "no architecture module ids parsed from the manifest — the correspondence scan is broken, not the tree",
    ).toBeGreaterThan(100);
    const nsPaths = hubNamespaceSourcePaths();
    const problems: string[] = [];
    for (const call of hubEngineSpanCalls()) {
      const path = nsPaths.get(call.namespace);
      if (path === undefined) {
        problems.push(`${call.namespace}: no engine-src import backs this engineSpans namespace`);
        continue;
      }
      const declared = idByPath.get(path);
      if (declared === undefined) {
        problems.push(`${call.namespace} (${path}): the architecture manifest declares no module for the imported path`);
      } else if (declared !== call.moduleId) {
        problems.push(
          `${call.namespace}: engineSpans names "${call.moduleId}" but decorates ${path}, whose architecture module id is "${declared}"`,
        );
      }
    }
    expect(
      problems,
      `An engine-span id must belong to the module the call decorates — an id that\n` +
        `exists on the wrong module misattributes every span it records.\n` +
        problems.join("\n"),
    ).toEqual([]);
  });
});
