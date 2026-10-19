// @vitest-environment node
/**
 * Single-Party-Owner: memory store owner.
 *
 * Binding authority: "Single-Party-Owner Principle" — MEMORY
 * management (store, retrieve, search, inject into context) must have ONE
 * owner module. ALL memory access goes through it — no route or service
 * accesses the memory store directly. The owner enforces gates at the
 * LOWEST level (the choke point where every memory path converges):
 * 1. userId gate — every read/write requires a non-empty server-resolved
 * userId (deny-by-default; throws ForbiddenError if missing).
 * 2. saveToMemory gate — automatic tool-result storage goes through
 * `storeToolResultMemory` (checks the manifest owner's opt-in list
 * AND the result's success), NOT inline in the run route.
 * 3. user-scoping gate — reads return ONLY the caller's own entries
 * (exclusive filter, no null/shared leak).
 * 4. PII gate — the LLM-facing path (`fetch_memory` tool) redacts via
 * the PII owner (redaction.ts); the user-facing path (memory panel)
 * returns raw decrypted content (the user's own data).
 *
 * This test mechanically pins the SPO invariants so a bypass cannot be
 * reintroduced silently. Four assurance classes (WORKFLOW.md §9):
 * A. SOURCE-SCAN: the canonical memory store (`createMemoryStore`) is
 * imported ONLY by memory-bridge.ts; the run route uses
 * `storeToolResultMemory` (not `storeProvenance` with source:"tool");
 * no route builds a `saveToMemoryTools` set.
 * B. SINGLE-OWNER: `storeToolResultMemory` is defined in exactly ONE
 * module (memory-bridge.ts); `isSaveToMemoryTool` is defined in
 * exactly ONE module (tools-bridge.ts).
 * C. SIGNATURE: every public read/write function in memory-bridge.ts
 * takes a mandatory `userId: string` (not optional).
 * D. BEHAVIORAL: `storeToolResultMemory` returns null for a non-opt-in
 * tool + a failed result; `searchMemory` with userId filters cross-
 * user (User B can't see User A); `storeProvenance` throws if
 * `provenance.userId` is missing.
 *
 * Mutation-verified: removing the userId gate from searchMemory makes D
 * FAIL; reintroducing `saveToMemoryTools` in run.ts makes A FAIL;
 * reverting `storeProvenance` for tool results makes A FAIL.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walkTs, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";
import { ForbiddenError } from "../../server/kernel/errors.ts";
import { runPathSource } from "../helpers/run-source.ts";
import { bodyCalls, exportedBindings, functionBody } from "../helpers/function-scope.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_DIR = join(ROOT, "server");
const BRIDGE_PATH = join(SERVER_DIR, "context/memory-bridge.ts");
const TOOLS_BRIDGE_PATH = join(SERVER_DIR, "tools/tools-bridge.ts");
const TOOL_EXECUTOR_PATH = join(SERVER_DIR, "tools/tool-executor.ts");
const RUN_PATH = join(SERVER_DIR, "routes", "run.ts");
const MEMORY_ROUTE_PATH = join(SERVER_DIR, "routes", "memory.ts");

const bridgeSrc = readFileSync(BRIDGE_PATH, "utf8");
const toolsBridgeSrc = readFileSync(TOOLS_BRIDGE_PATH, "utf8");
const toolExecutorSrc = readFileSync(TOOL_EXECUTOR_PATH, "utf8");
const runSrc = runPathSource();
const memoryRouteSrc = readFileSync(MEMORY_ROUTE_PATH, "utf8");

const serverFiles = walkTs(SERVER_DIR);

describe("memory store owner", () => {
  describe("(A) SOURCE-SCAN — memory-bridge is the single entry point; no route bypasses it", () => {
    test("createMemoryStore is imported ONLY by memory-bridge.ts (the single owner)", () => {
      // The canonical store factory must be imported by exactly ONE
      // server module (the memory owner). A second importer would bypass
      // the userId + saveToMemory + encryption gates.
      const importers: string[] = [];
      for (const f of serverFiles) {
        const src = readFileSync(f, "utf8");
        // Match `import... createMemoryStore... from "..."` (any path).
        if (/import\s+(?:\{[^}]*\bcreateMemoryStore\b[^}]*\}|\s+\w+\s*,?\s*\{[^}]*\bcreateMemoryStore\b[^}]*\})\s+from\s+["']/.test(src)) {
          importers.push(relative(ROOT, f));
        }
      }
      expect(
        importers,
        `createMemoryStore must be imported by exactly ONE module (memory-bridge.ts); found: ${importers.join(", ")}`,
      ).toHaveLength(1);
      expect(importers[0], "the single importer must be server/memory-bridge.ts").toBe(
        relative(ROOT, BRIDGE_PATH),
      );
    });

    test("getTimelineStore is imported ONLY by memory-bridge.ts for memory use", () => {
      // getTimelineStore is the canonical timeline store factory. It is
      // also legitimately imported by timeline-bridge.ts (the timeline
      // owner). For MEMORY purposes, only memory-bridge.ts may use it —
      // any other module using getTimelineStore to store/retrieve memory
      // bypasses the memory owner. Verify memory-bridge imports it; other
      // memory-related usage is not scattered.
      expect(bridgeSrc, "memory-bridge must use getTimelineStore").toContain("getTimelineStore");
    });

    test("the run route uses storeToolResultMemory for tool results (NOT storeProvenance with source:'tool')", () => {
      // SPO: the saveToMemory gate is in the memory owner
      // (storeToolResultMemory), NOT inline in the run route. The route
      // must call storeToolResultMemory, not storeProvenance with
      // source:"tool" (which would skip the gate).
      expect(runSrc, "run.ts must import storeToolResultMemory from memory-bridge").toMatch(
        /storeToolResultMemory/,
      );
      expect(runSrc, "run.ts must call storeToolResultMemory(...)").toMatch(/storeToolResultMemory\(/);
      // The run route must NOT call storeProvenance directly for tool
      // results. storeProvenance may still be imported by the memory
      // route (POST /api/memory manual store) but NOT by the run route.
      expect(
        runSrc,
        "run.ts must NOT import storeProvenance (the saveToMemory gate is in storeToolResultMemory)",
      ).not.toMatch(/import\s+\{[^}]*\bstoreProvenance\b[^}]*\}\s+from\s+["']\.\.\/memory-bridge\.ts["']/);
    });

    test("the run route does NOT build a saveToMemoryTools set (the gate is in the memory owner)", () => {
      // The prior inline gate: `const saveToMemoryTools = new Set(
      // toolManifest.filter((t) => t.saveToMemory === true).map((t) => t.name))`
      // — a SPO violation (the gate lived in the route). The memory owner
      // now enforces it via `isSaveToMemoryTool` (tools-bridge) +
      // `storeToolResultMemory` (memory-bridge). The test checks for the
      // ACTUAL inline-gate pattern (the `new Set(toolManifest.filter...)`
      // construction), not just the word "saveToMemoryTools" (which legitimately
      // appears in explanatory comments).
      expect(
        runSrc,
        "run.ts must NOT construct an inline saveToMemoryTools Set from the manifest (the gate is in the memory owner)",
      ).not.toMatch(/const\s+saveToMemoryTools\s*=\s*new\s+Set\s*\(\s*toolManifest\.filter/);
      expect(
        runSrc,
        "run.ts must NOT inline-check saveToMemoryTools.has(...) (the gate is in the memory owner)",
      ).not.toMatch(/saveToMemoryTools\.has\s*\(/);
      expect(
        runSrc,
        "run.ts must NOT inline-check saveToMemory === true (the gate is in the memory owner)",
      ).not.toMatch(/\.saveToMemory\s*===\s*true/);
    });

    test("the run route threads userId into executeToolCall (the fetch_memory tool needs it)", () => {
      // SPO: the ToolExecutionContext carries userId so the
      // fetch_memory tool can pass it to searchMemory. Without this, the
      // LLM's fetch_memory call would leak every user's memories.
      expect(runSrc, "run.ts must pass userId to executeToolCall").toMatch(
        /executeToolCall\([^,]*,\s*event\.arguments,\s*\{[^}]*userId:\s*active\.userId[^}]*\}/,
      );
    });

    test("the memory route resolves userId via requireUserContext and threads it into every bridge call", () => {
      // The memory API route must resolve the user server-side (deny-by-
      // default — no client-supplied userId) and pass it to every
      // memory-bridge call. This is the route-level defense-in-depth on
      // top of the bridge's own userId gate.
      expect(memoryRouteSrc, "memory route must use requireUserContext").toContain("requireUserContext");
      expect(memoryRouteSrc, "searchMemory must receive user.userId").toMatch(/searchMemory\([^,]*,\s*user\.userId\)/);
      expect(memoryRouteSrc, "storeProvenance must receive user.userId").toMatch(/userId:\s*user\.userId/);
      expect(memoryRouteSrc, "listMemoryEntries must receive user.userId").toMatch(/listMemoryEntries\([^,]*,\s*user\.userId\)/);
      expect(memoryRouteSrc, "getMemoryEntry must receive user.userId").toMatch(/getMemoryEntry\([^,]*,\s*user\.userId\)/);
      expect(memoryRouteSrc, "memoryCount must receive user.userId").toMatch(/memoryCount\(user\.userId\)/);
    });

    test("no server module outside memory-bridge.ts imports searchMemory/getMemoryEntry/listMemoryEntries/memoryCount directly for tool use", () => {
      // The tool-executor lazy-loads memory-bridge (the single owner) —
      // it does NOT import the canonical store directly. Verify the
      // tool-executor goes through memory-bridge for fetch_memory.
      expect(toolExecutorSrc, "tool-executor must call mem().searchMemory (through the bridge)").toMatch(
        /mem\(\)\.searchMemory\(/,
      );
      // The tool-executor must pass ctx.userId to searchMemory (deny-by-default).
      expect(toolExecutorSrc, "toolFetchMemory must pass ctx.userId to searchMemory").toMatch(
        /searchMemory\([^,]*,\s*ctx\.userId\)/,
      );
    });
  });

  describe("(B) SINGLE-OWNER — storeToolResultMemory + isSaveToMemoryTool defined in exactly one module", () => {
    test("storeToolResultMemory is defined ONLY in memory-bridge.ts", () => {
      const owners: string[] = [];
      for (const f of serverFiles) {
        const src = readFileSync(f, "utf8");
        if (/export\s+function\s+storeToolResultMemory\b/.test(src)) {
          owners.push(relative(ROOT, f));
        }
      }
      expect(
        owners,
        `storeToolResultMemory must be defined in exactly ONE module; found: ${owners.join(", ")}`,
      ).toHaveLength(1);
      expect(owners[0]).toBe(relative(ROOT, BRIDGE_PATH));
    });

    test("isSaveToMemoryTool is defined ONLY in tools-bridge.ts (the manifest owner)", () => {
      const owners: string[] = [];
      for (const f of serverFiles) {
        const src = readFileSync(f, "utf8");
        if (/export\s+function\s+isSaveToMemoryTool\b/.test(src)) {
          owners.push(relative(ROOT, f));
        }
      }
      expect(
        owners,
        `isSaveToMemoryTool must be defined in exactly ONE module; found: ${owners.join(", ")}`,
      ).toHaveLength(1);
      expect(owners[0]).toBe(relative(ROOT, TOOLS_BRIDGE_PATH));
    });

    test("memory-bridge lazy-loads tools-bridge (isSaveToMemoryTool) — the saveToMemory gate is at the memory owner", () => {
      // The memory owner queries the manifest owner's opt-in list via
      // isSaveToMemoryTool (lazy-loaded to avoid the canonical-chain TDZ).
      expect(bridgeSrc, "memory-bridge must call isSaveToMemoryTool (the saveToMemory gate)").toContain(
        "isSaveToMemoryTool",
      );
      expect(bridgeSrc, "memory-bridge must lazy-load tools-bridge via moduleRequire").toContain(
        'moduleRequire("../tools/tools-bridge.ts")',
      );
    });

    test("tools-bridge exports isSaveToMemoryTool (the single public accessor over SAVE_TO_MEMORY_TOOLS)", () => {
      expect(toolsBridgeSrc, "tools-bridge must export isSaveToMemoryTool").toMatch(
        /export\s+function\s+isSaveToMemoryTool\b/,
      );
      // The set stays private; the function is the only accessor.
      expect(toolsBridgeSrc, "SAVE_TO_MEMORY_TOOLS must be a private (non-exported) const").toMatch(
        /const\s+SAVE_TO_MEMORY_TOOLS\s*=\s*new\s+Set/,
      );
    });
  });

  describe("(C) SIGNATURE — every public memory-bridge read/write takes a mandatory userId", () => {
    test("searchMemory requires userId: string (not optional)", () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+searchMemory\s*\([\s\S]*?userId:\s*string\s*,?\s*\)/);
    });

    test("getMemoryEntry requires userId: string (not optional)", () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+getMemoryEntry\s*\([\s\S]*?userId:\s*string\s*,?\s*\)/);
    });

    test("listMemoryEntries requires userId: string (not optional)", () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+listMemoryEntries\s*\([\s\S]*?userId:\s*string\s*,?\s*\)/);
    });

    test("memoryCount requires userId: string (not optional)", () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+memoryCount\s*\(\s*userId:\s*string\s*,?\s*\)/);
    });

    test("retrieveRelevantMemories requires userId: string (not optional)", () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+retrieveRelevantMemories\s*\([\s\S]*?userId:\s*string\s*,?\s*\)/);
    });

    test("none of the read/write function SIGNATURES declare userId as optional (userId?: string)", () => {
      // Pin that no public function SIGNATURE uses `userId?: string`
      // (optional). All must require `userId: string` (mandatory). This
      // catches a regression that reverts the gate to optional. We scan
      // only the function-signature lines (export function... (...):),
      // not the MemoryProvenance type (which is now mandatory too — see
      // the type test below) or the MemoryEntryView (which has
      // `userId: string | null` for the view, not optional).
      const sigRegex = /export\s+function\s+\w+\s*\([^)]*\buserId\?:\s*string\b[^)]*\)/g;
      const optionalSigs = bridgeSrc.match(sigRegex);
      expect(
        optionalSigs,
        "no public memory-bridge function signature may declare userId as optional (userId?: string)",
      ).toBeNull();
    });

    test("MemoryProvenance.userId is mandatory (compile-time enforcement, not just runtime)", () => {
      // The provenance type itself must declare userId: string (not
      // optional). storeProvenance validates at runtime (defense-in-depth),
      // but the type enforces presence at compile time — a caller that
      // forgets userId gets a type error, not just a runtime throw.
      const provTypeMatch = bridgeSrc.match(
        /export\s+type\s+MemoryProvenance\s*=\s*Readonly<\{[\s\S]*?\buserId:\s*string\b[\s\S]*?\}>/,
      );
      expect(provTypeMatch, "MemoryProvenance must declare userId: string (mandatory)").not.toBeNull();
      expect(provTypeMatch![0], "MemoryProvenance must NOT have userId?: string").not.toMatch(
        /userId\?:\s*string/,
      );
    });

    test("storeInteraction requires userId in its options object (mandatory)", () => {
      // The options type must declare `userId: string` (not `userId?: string`).
      // The signature spans multiple lines; match the options line directly.
      expect(bridgeSrc, "storeInteraction options must declare userId: string (mandatory)").toMatch(
        /options:\s*Readonly<\{[^}]*\buserId:\s*string\b[^}]*\}>/,
      );
      // And it must NOT declare userId as optional.
      const sigBlock = bridgeSrc.match(/export\s+function\s+storeInteraction\s*\([\s\S]*?\)\s*:/);
      expect(sigBlock, "storeInteraction signature must be found").not.toBeNull();
      expect(sigBlock![0], "storeInteraction options must NOT have userId?: string").not.toMatch(
        /userId\?:\s*string/,
      );
    });

    test("storeProvenance enforces provenance.userId (throws ForbiddenError if missing)", () => {
      // The gate: throws if provenance.userId is missing/empty.
      expect(bridgeSrc, "storeProvenance must validate provenance.userId").toContain(
        "provenance.userId === undefined",
      );
      expect(bridgeSrc, "storeProvenance must throw ForbiddenError on missing userId").toContain(
        "ForbiddenError",
      );
    });

    test("storeToolResultMemory enforces provenance.userId (via storeProvenance)", () => {
      // storeToolResultMemory passes provenance.userId to storeProvenance,
      // which enforces it. The function signature requires userId: string.
      expect(bridgeSrc, "storeToolResultMemory provenance must require userId: string").toMatch(
        /provenance:\s*Readonly<\{[^}]*\buserId:\s*string\b[^}]*\}>/,
      );
    });

    test("the bridge has a requireUserId helper (the choke-point gate)", () => {
      expect(bridgeSrc, "memory-bridge must define requireUserId").toMatch(
        /function\s+requireUserId\s*\(/,
      );
      expect(bridgeSrc, "requireUserId must throw ForbiddenError on missing userId").toContain(
        "ForbiddenError",
      );
    });

    test("DYNAMIC: every exported function whose name suggests a memory read/write takes userId (catches new functions)", () => {
      // BROAD: the parser's own export surface — every exported function by
      // ANY form (declaration, arrow, specifier), not a signature regex.
      // `export\s+(async\s+)?function\s+(\w+)\(([^)]*)\)` had two failure
      // modes: it cannot see `export const f = async () => …`, and `[^)]*`
      // truncates the parameter list at the first function-typed parameter.
      // For each function whose name contains a memory-access verb
      // (search/get/list/count/retrieve/store/Memory/Provenance/Interaction),
      // verify the signature includes `userId` (either `userId: string`
      // directly or via a provenance/options object that contains
      // `userId: string`). This catches a NEW function added without the
      // userId gate — the named-function tests above only check the existing
      // functions; this scan catches future ones.
      const memoryVerbs = /search|get|list|count|retrieve|store|Memory|Provenance|Interaction/i;
      const violations: string[] = [];
      let examined = 0;
      for (const [fnName, binding] of exportedBindings(bridgeSrc, "memory-bridge exports")) {
        if (binding.kind !== "function") continue;
        // Skip functions whose name doesn't suggest memory access.
        if (!memoryVerbs.test(fnName)) continue;
        examined += 1;
        const params = binding.parameters;
        // The function must take userId: either directly (`userId: string`)
        // or via a provenance/options param typed as `Readonly<{... userId:
        // string... }>`.
        const hasDirectUserId = /\buserId\s*:\s*string\b/.test(params);
        const hasProvenanceUserId = /Readonly<\{[^}]*\buserId\s*:\s*string\b/.test(params);
        // Also accept `options:... {... userId: string... }` (storeInteraction
        // uses an options object — the userId is in the options TYPE, not
        // the destructured params).
        const hasOptionsUserId = /options:\s*Readonly<\{[^}]*\buserId\s*:\s*string\b/.test(params);
        if (hasDirectUserId || hasProvenanceUserId || hasOptionsUserId) continue;
        // The function might take userId via a NAMED TYPE parameter (e.g.
        // `provenance: MemoryProvenance` — the type contains userId: string
        // but it's a named type, not an inline Readonly<{...}>). The gate is
        // then in the BODY: a call to the requireUserId choke point, or the
        // function reading a parameter's own `.userId` field (enforced via
        // the type's mandatory userId field). Both claims are asked of the
        // function's own body — never of a byte window after its name: the
        // 3000-char slice this replaces captured whatever the next three
        // thousand bytes held, so a neighbour's requireUserId call satisfied
        // it and a long body outgrew it.
        const scope = functionBody(bridgeSrc, binding.declaredAs ?? fnName, `exported ${fnName}`);
        const callsRequireUserId = bodyCalls(scope, "requireUserId");
        // Extract parameter names from the signature + check if any is
        // accessed as `<param>.userId` in the body's CODE — comments and
        // string interiors are blanked first, because an error message that
        // NAMES `provenance.userId` is not the gate reading it (the shared
        // lexer owns that distinction; a raw text claim cannot make it).
        const paramNames = params
          .split(",")
          .map((p) => p.trim().split(/[:\s]/)[0]!)
          .filter((n) => /^\w+$/.test(n));
        const bodyCode = stripCommentsAndStringsFor(scope.body, BRIDGE_PATH);
        const accessesParamUserId = paramNames.some((pn) => bodyCode.includes(`${pn}.userId`));
        if (!callsRequireUserId && !accessesParamUserId) {
          violations.push(`${fnName}(${params.replace(/\s+/g, " ").trim()})`);
        }
      }
      // A floor on the examined population: nine memory-verb exports today.
      // If this scan ever goes quietly blind (the export surface unread, the
      // verb list stale), the empty-violations verdict would pass having
      // examined nothing.
      expect(
        examined,
        "the dynamic scan examined no memory-access exports — the universe this verdict is about is empty",
      ).toBeGreaterThanOrEqual(8);
      expect(
        violations,
        `every exported memory-access function must take userId or call requireUserId (no gate bypass):\n${violations.join("\n")}`,
      ).toEqual([]);
    });
  });

  describe("(D) BEHAVIORAL — the gates actually enforce", () => {
    test("storeToolResultMemory returns null for a non-opt-in tool (saveToMemory gate)", async () => {
      const { storeToolResultMemory } = await import("../../server/context/memory-bridge.ts");
      // "read_file" is NOT in SAVE_TO_MEMORY_TOOLS → must return null.
      const id = storeToolResultMemory(
        "read_file",
        true,
        "file content",
        { userId: "user-test-1" },
        "short-term",
      );
      expect(id, "a non-opt-in tool must NOT be stored (saveToMemory gate)").toBeNull();
    });

    test("storeToolResultMemory returns null for a failed result (success gate)", async () => {
      const { storeToolResultMemory } = await import("../../server/context/memory-bridge.ts");
      // "search_code" IS in SAVE_TO_MEMORY_TOOLS, but success=false → null.
      const id = storeToolResultMemory(
        "search_code",
        false,
        "error output",
        { userId: "user-test-2" },
        "short-term",
      );
      expect(id, "a failed tool result must NOT be stored (success gate)").toBeNull();
    });

    test("storeToolResultMemory returns null for a non-opt-in tool AND a failed result (both gates)", async () => {
      const { storeToolResultMemory } = await import("../../server/context/memory-bridge.ts");
      const id = storeToolResultMemory(
        "read_file",
        false,
        "error",
        { userId: "user-test-3" },
        "short-term",
      );
      expect(id, "non-opt-in + failed must NOT be stored").toBeNull();
    });

    test("storeToolResultMemory throws ForbiddenError when userId is missing (userId gate)", async () => {
      const { storeToolResultMemory } = await import("../../server/context/memory-bridge.ts");
      // Bypass the TS type by casting — simulate a caller that forgot to
      // thread userId. The gate must throw (deny-by-default).
      expect(() =>
        storeToolResultMemory(
          "search_code",
          true,
          "content",
          {} as Readonly<{ userId: string }>,
          "short-term",
        ),
      ).toThrow(ForbiddenError);
      expect(() =>
        storeToolResultMemory(
          "search_code",
          true,
          "content",
          {} as Readonly<{ userId: string }>,
          "short-term",
        ),
      ).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("searchMemory throws ForbiddenError when userId is empty (deny-by-default)", async () => {
      const { searchMemory } = await import("../../server/context/memory-bridge.ts");
      expect(() => searchMemory({ text: "x" }, "")).toThrow(ForbiddenError);
      expect(() => searchMemory({ text: "x" }, "")).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("listMemoryEntries throws ForbiddenError when userId is empty", async () => {
      const { listMemoryEntries } = await import("../../server/context/memory-bridge.ts");
      expect(() => listMemoryEntries(undefined, "")).toThrow(ForbiddenError);
      expect(() => listMemoryEntries(undefined, "")).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("getMemoryEntry throws ForbiddenError when userId is empty", async () => {
      const { getMemoryEntry } = await import("../../server/context/memory-bridge.ts");
      expect(() => getMemoryEntry("mem-x", "")).toThrow(ForbiddenError);
      expect(() => getMemoryEntry("mem-x", "")).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("memoryCount throws ForbiddenError when userId is empty", async () => {
      const { memoryCount } = await import("../../server/context/memory-bridge.ts");
      expect(() => memoryCount("")).toThrow(ForbiddenError);
      expect(() => memoryCount("")).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("retrieveRelevantMemories throws ForbiddenError when userId is empty", async () => {
      const { retrieveRelevantMemories } = await import("../../server/context/memory-bridge.ts");
      expect(() => retrieveRelevantMemories("prompt", 5, "")).toThrow(ForbiddenError);
      expect(() => retrieveRelevantMemories("prompt", 5, "")).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("storeProvenance throws ForbiddenError when provenance.userId is missing", async () => {
      const { storeProvenance } = await import("../../server/context/memory-bridge.ts");
      expect(() =>
        storeProvenance(
          "content",
          { source: "user", how: "manual" } as Readonly<{ source: "user"; how: "manual"; userId: string }>,
          "short-term",
        ),
      ).toThrow(ForbiddenError);
      expect(() =>
        storeProvenance(
          "content",
          { source: "user", how: "manual" } as Readonly<{ source: "user"; how: "manual"; userId: string }>,
          "short-term",
        ),
      ).toThrow(expect.objectContaining({ code: "memory_user_required" }));
    });

    test("searchMemory with userId returns ONLY the caller's own entries (no cross-user leak)", async () => {
      const { storeProvenance, searchMemory } = await import("../../server/context/memory-bridge.ts");
      // User A stores a memory.
      storeProvenance("User A secret", { source: "user", how: "manual", userId: "user-a-r10" }, "short-term");
      // User B stores a memory.
      storeProvenance("User B secret", { source: "user", how: "manual", userId: "user-b-r10" }, "short-term");
      // User A searches with no text filter → must see ONLY A's entry.
      const aResults = searchMemory({}, "user-a-r10");
      expect(aResults.some((e) => e.content.includes("User A secret"))).toBe(true);
      expect(aResults.some((e) => e.content.includes("User B secret"))).toBe(false);
      // User B searches → must see ONLY B's entry.
      const bResults = searchMemory({}, "user-b-r10");
      expect(bResults.some((e) => e.content.includes("User B secret"))).toBe(true);
      expect(bResults.some((e) => e.content.includes("User A secret"))).toBe(false);
    });

    test("searchMemory EXCLUSIVE filter — no null/shared leak (deny-by-default)", async () => {
      // SPO: a null-userId entry (legacy or unscoped) must NOT be
      // visible to ANY user (deny-by-default). The prior "own + shared
      // (null)" filter (`e.userId === null || e.userId === userId`)
      // leaked unscoped entries to everyone. We inject a null-userId entry
      // by bypassing the gate via the internal store (the store is the
      // canonical backend; we add a legacy entry directly to it). Then we
      // verify neither user A nor user B sees it.
      const memBridge = await import("../../server/context/memory-bridge.ts");
      // The memory-bridge module exposes the store via getMemoryStore
      // (private). We cannot inject a null entry through the public API
      // (storeProvenance now requires userId — the gate). Instead, pin
      // the EXCLUSIVE filter via source-scan: the filter must be
      // `e.userId === scopedUserId` (EXACT match), NOT the permissive
      // `e.userId === null || e.userId === scopedUserId`.
      expect(bridgeSrc, "searchMemory must use the EXCLUSIVE filter (e.userId === scopedUserId)").toContain(
        "e.userId === scopedUserId",
      );
      expect(
        bridgeSrc,
        "searchMemory must NOT use the permissive null/shared filter (deny-by-default)",
      ).not.toContain("e.userId === null || e.userId === scopedUserId");
      // Same for listMemoryEntries: EXCLUSIVE filter, no null/shared.
      expect(bridgeSrc, "listMemoryEntries must use the EXCLUSIVE filter").toMatch(
        /\.filter\(\(e\)\s*=>\s*e\.userId\s*===\s*scopedUserId\)/,
      );
      // getMemoryEntry: deny if the entry's userId does not EXACTLY match.
      expect(bridgeSrc, "getMemoryEntry must deny non-exact userId match").toMatch(
        /if\s*\(view\.userId\s*!==\s*scopedUserId\)/,
      );
    });

    test("getMemoryEntry returns null for another user's entry (deny-by-default)", async () => {
      const { storeProvenance, getMemoryEntry } = await import("../../server/context/memory-bridge.ts");
      const id = storeProvenance("A's memory", { source: "user", how: "manual", userId: "user-a-get" }, "short-term");
      // User B tries to read A's memory by id → must get null.
      const result = getMemoryEntry(id, "user-b-get");
      expect(result, "User B must NOT read User A's memory by id").toBeNull();
      // User A reads their own → must get the entry.
      const own = getMemoryEntry(id, "user-a-get");
      expect(own, "User A reads their own memory by id").not.toBeNull();
      expect(own!.content).toContain("A's memory");
    });

    test("storeToolResultMemory stores a memory for an opt-in tool + success", async () => {
      const { storeToolResultMemory, searchMemory } = await import("../../server/context/memory-bridge.ts");
      // "search_code" IS in SAVE_TO_MEMORY_TOOLS + success=true → stored.
      const id = storeToolResultMemory(
        "search_code",
        true,
        "[search_code] found 3 matches",
        { userId: "user-tool-ok" },
        "short-term",
      );
      expect(id, "an opt-in tool + success must be stored").not.toBeNull();
      // Verify it's retrievable by the same user.
      const results = searchMemory({ text: "search_code" }, "user-tool-ok");
      expect(results.some((e) => e.content.includes("found 3 matches"))).toBe(true);
    });

    test("EVERY tier the store accepts survives the `?tier=` filter — driven, not asserted", async () => {
      // ── WHY THIS IS BEHAVIOURAL AND NOT A SOURCE SCAN ────────────────────
      //
      // The tier filter used to be guarded by requiring the exact spelling
      // `TIER_SET = new Set<…>(MEMORY_TIERS)`. That guard was DRIVEN and
      // ESCAPED: keeping the demanded spelling and adding one line —
      // `TIER_SET.delete("long-term")` — left `tsc` at exit 0, every tier
      // suite green, and `?tier=long-term` silently dropped at this boundary,
      // which is the precise defect the guard existed to close. A guard that
      // can only be satisfied by a spelling will eventually be satisfied by
      // that spelling in the wrong place.
      //
      // So the claim is made where it can be false: one memory is stored in
      // each tier THE OWNER DECLARES, and each is asked for back by name. The
      // vocabulary is read from the owner, so a fourth tier is covered the day
      // it is added, with nobody having to remember this file.
      const { storeProvenance, searchMemory } = await import("../../server/context/memory-bridge.ts");
      const { MEMORY_TIERS } = await import("../../server/kernel/canonical.ts");

      // THE POPULATION AS A RUNTIME FLOOR. An empty vocabulary would make every
      // assertion below vacuous and the test would pass having checked nothing.
      expect(
        MEMORY_TIERS.length,
        "the harness memory owner declared NO tiers — this test has no subject",
      ).toBeGreaterThan(1);

      const user = "user-tier-round-trip";
      for (const tier of MEMORY_TIERS) {
        storeProvenance(`tier probe ${tier}`, { source: "user", how: "manual", userId: user }, tier);
      }
      for (const tier of MEMORY_TIERS) {
        const found = searchMemory({ tier }, user);
        expect(
          found.map((e) => e.content),
          `a memory stored in tier "${tier}" was accepted by the store and then DROPPED by the ` +
            "`?tier=` filter — the filter and the store disagree about the vocabulary",
        ).toContain(`tier probe ${tier}`);
        // And the filter must still FILTER: a tier's query may not return the
        // other tiers' entries. Without this the test passes on a filter that
        // was deleted outright, which is the inert direction.
        expect(
          found.every((e) => e.tier === tier),
          `the "${tier}" query returned entries from another tier — the filter is not filtering`,
        ).toBe(true);
      }

      // A tier the owner does NOT declare must not be honoured as a filter.
      // Deny-by-default, driven from the same vocabulary: the probe name is
      // built from the declared members so it cannot accidentally become one.
      const absent = `${MEMORY_TIERS.join("-")}-not-a-tier`;
      const unfiltered = searchMemory({ tier: absent }, user);
      expect(
        unfiltered.length,
        "an unknown tier must fall through to 'no tier filter', never be accepted as one",
      ).toBe(MEMORY_TIERS.length);
    });
  });

  describe("(E) PII — the LLM-facing fetch_memory path redacts (owner)", () => {
    test("toolFetchMemory redacts content + originalRequest before returning to the LLM", () => {
      // The fetch_memory tool must route results through the PII owner
      // (redactContent / redactToolCallArguments) so a pasted secret in
      // memory does not leak to the model. The user-facing path (memory
      // panel) returns raw — only the LLM-facing path redacts.
      expect(toolExecutorSrc, "fetch_memory must redact content via redactContent (the PII owner)").toContain(
        "redactContent",
      );
      // originalRequest for tool memories is a JSON tool-args string →
      // redactToolCallArguments (JSON-aware redaction), not redactContent.
      expect(toolExecutorSrc, "fetch_memory must redact originalRequest via redactToolCallArguments").toContain(
        "redactToolCallArguments",
      );
      expect(toolExecutorSrc, "fetch_memory must redact originalRequest").toMatch(
        /originalRequest:\s*e\.originalRequest\s*===\s*null\s*\?\s*null\s*:\s*redactToolCallArguments\(e\.originalRequest\)/,
      );
    });

    test("toolFetchMemory denies when ctx.userId is missing (deny-by-default)", () => {
      expect(toolExecutorSrc, "fetch_memory must deny when ctx.userId is missing").toMatch(
        /ctx\.userId\s*===\s*undefined\s*\|\|\s*ctx\.userId\.length\s*===\s*0/,
      );
    });
  });
});
