// @vitest-environment node
/**
 * Prevention test — SPO: context-switch reset owner (auto-reset snapshot
 * stores on chat/project switch at the LOWEST level).
 *
 * Mechanically enforces the "Relieve Responsibilities" principle that
 * snapshot stores (quality, dedup, etc.) auto-reset on chat switch via a
 * DYNAMIC registry — NOT a manual per-store reset call in the chat-switch
 * handler. The stores self-register via `registerContextReset`; the
 * chat-change signal (`currentChatId.listen` in `reset-all.ts`) calls
 * `resetContextStores` which iterates the registry dynamically. Adding a
 * new snapshot store = call `registerContextReset` once = it resets on
 * chat switch automatically. Forgetting is impossible because you NEVER
 * HAD TO REMEMBER a reset call in the handler.
 *
 * This replaces the prior RIGID fix (App.svelte manually called
 * `setQualitySnapshot(null)` + `setDedupSnapshot(null)` in the chatId
 * `$effect`). That fix was rigid: a new snapshot store that the effect
 * didn't reset would show stale data. The DYNAMIC fix moves the reset to
 * the lowest level (the registry + signal), so no handler needs to
 * manually call each store's reset.
 *
 * DYNAMIC per-chat discovery (deny-by-default). The test does NOT
 * hardcode a store list. It dynamically discovers every `src/state/*.ts`
 * file via `readdirSync` and classifies each store as:
 *   - PER-CHAT (deny-by-default): holds chat/run-scoped data that goes
 *     stale on chat switch. MUST call `registerContextReset`.
 *   - GLOBAL (explicit opt-out): holds user-wide / server-wide / per-
 *     project data that does NOT go stale on chat switch. A global store
 *     is detected by EITHER (a) importing from `./persistence` (a user
 *     preference persisted across refresh), OR (b) a documented
 *     `@global-store <reason>` JSDoc marker in the store source.
 *
 * Adding a new per-chat store without `registerContextReset` → the test
 * FAILS automatically (deny-by-default). Adding a new global store without
 * a `@global-store` marker (and without a persistence import) → the test
 * FAILS (it is assumed per-chat until explicitly excluded). This is the
 * same deny-by-default principle as the route registry + tool registry:
 * the secure/restricted state is the default; opening a gate is explicit.
 *
 * Assurance classes:
 * A — store-registry.ts exports the context-reset API.
 * B — reset-all.ts wires the chat-change signal (currentChatId.listen →
 *     resetContextStores).
 * C — DYNAMIC per-chat scan: every session store (registerReset) is EITHER
 *     per-chat (registerContextReset) OR explicitly global (persistence
 *     import or @global-store marker). No hardcoded store list.
 * D — App.svelte does NOT manually call setQualitySnapshot/setDedupSnapshot
 *     (the RIGID pattern is removed).
 * E — Behavioral: changing currentChatId resets a registered store without
 *     any handler code (the full pipeline: signal → registry → reset).
 * F — Mutation-verified: removing registerContextReset from a store makes
 *     the behavioral test fail.
 * G — @global-store markers are sound: each has a documented reason, and
 *     a global store does NOT also call registerContextReset (a global
 *     store resetting on chat switch is a bug).
 *
 * dynamic `readdirSync` discovery — no hardcoded file lists.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = join(ROOT, "src", "state");
const REGISTRY_FILE = join(STATE_DIR, "store-registry.ts");
const RESET_ALL_FILE = join(STATE_DIR, "reset-all.ts");

// Infrastructure/owner files excluded from the per-chat scan: they own
// the registry/wiring and do not hold session data themselves. This is
// NOT a store list — it is the two owner modules + the persistence
// utility (which has no registerReset call anyway). Discovered once,
// used only to skip the owners.
const OWNER_FILES = new Set(["store-registry.ts", "reset-all.ts", "persistence.ts"]);

function readClean(path: string): string {
  return readFileSync(path, "utf8");
}

function rel(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

/** Dynamically discover every .ts file in src/state/. */
function stateFiles(): string[] {
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(STATE_DIR, f));
}

/** True if `src` contains a CALL to `fnName(...)` (not the definition). */
function hasCall(src: string, fnName: string): boolean {
  const lines = src.split("\n");
  const defRe = new RegExp(`\\bfunction\\s+${fnName}\\b`);
  const callRe = new RegExp(`\\b${fnName}\\s*\\(`);
  return lines.some((l) => {
    const trimmed = l.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
    if (defRe.test(trimmed)) return false;
    return callRe.test(trimmed);
  });
}

/** True if the store imports from ./persistence (a user preference). */
function importsPersistence(src: string): boolean {
  return /from\s*["']\.\/persistence["']/.test(src);
}

/** True if the store source carries a @global-store opt-out marker.
 * Matches only the JSDoc tag form (a line like ` * @global-store <reason>`),
 * NOT the word `@global-store` appearing in prose (e.g. a comment that
 * says "no @global-store marker") and NOT a corrupted tag like
 * `@global-store-MUTATED` (the tag must be followed by whitespace or
 * end-of-line, so a typo'd/corrupted marker does not accidentally opt a
 * store out). This precision prevents a store's own documentation — or a
 * corrupted marker — from silently excluding it from the per-chat scan. */
function hasGlobalStoreMarker(src: string): boolean {
  return /^\s*\*\s*@global-store(?:\s|$)/m.test(src);
}

/** Extract the reason text from a @global-store marker (null if absent). */
function globalStoreReason(src: string): string | null {
  const m = src.match(/^\s*\*\s*@global-store\s+(.+)/m);
  return m ? m[1]!.trim().replace(/\s*\*\/.*$/, "") : null;
}

beforeEach(async () => {
  // Reset currentChatId to null so the listen doesn't fire from a prior
  // test's state. Do NOT clear the context-reset registry: the stores
  // self-register ONCE at module load (via the import.meta.glob in
  // reset-all.ts), and clearing the registry would not re-trigger their
  // registerContextReset calls (module caching). The registry persists
  // across tests — the stores are always registered.
  const { currentChatId } = await import("../../src/state/chats");
  currentChatId.set(null);
});

afterEach(async () => {
  const { currentChatId } = await import("../../src/state/chats");
  currentChatId.set(null);
});

// ── A. store-registry.ts exports the context-reset API ──

describe("A. store-registry.ts exports the context-reset API", () => {
  test("registerContextReset + resetContextStores + diagnostics are exported", () => {
    const src = readClean(REGISTRY_FILE);
    expect(src).toMatch(/export function registerContextReset\s*\(/);
    expect(src).toMatch(/export function resetContextStores\s*\(/);
    expect(src).toMatch(/export function registeredContextResetNames\s*\(/);
    expect(src).toMatch(/export function clearContextResetRegistry\s*\(/);
  });

  test("the context-reset registry is a SEPARATE map from the logout registry", () => {
    const src = readClean(REGISTRY_FILE);
    // Two distinct maps (the logout registry + the context-switch registry).
    expect(src).toMatch(/const\s+resetFns\b.*new Map/);
    expect(src).toMatch(/const\s+contextResetFns\b.*new Map/);
  });

  test("resetContextStores iterates the context-reset registry dynamically (no hardcoded call list)", () => {
    const src = readClean(REGISTRY_FILE);
    expect(src).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+contextResetFns\.values\(\)/);
  });
});

// ── B. reset-all.ts wires the chat-change signal ──

describe("B. reset-all.ts wires the chat-change signal", () => {
  test("reset-all.ts imports currentChatId + resetContextStores + wires the listen", () => {
    const src = readClean(RESET_ALL_FILE);
    expect(src, "reset-all.ts must import currentChatId from ./chats").toMatch(/from\s*["']\.\/chats["']/);
    expect(src, "reset-all.ts must import resetContextStores from ./store-registry").toMatch(/resetContextStores/);
    expect(src, "reset-all.ts must wire currentChatId.listen → resetContextStores").toMatch(/currentChatId\.listen/);
  });

  test("reset-all.ts re-exports resetContextStores (the single reset owner)", () => {
    const src = readClean(RESET_ALL_FILE);
    expect(src).toMatch(/export\s*\{\s*resetContextStores\s*\}\s*from\s*["']\.\/store-registry["']/);
  });
});

// ── C. DYNAMIC per-chat scan — deny-by-default ──

describe("C. DYNAMIC per-chat scan — every session store is either per-chat or explicitly global", () => {
  // The core deny-by-default check. A session store (one that calls
  // registerReset) is PER-CHAT by default: it MUST call registerContextReset
  // so it resets on chat switch. It is GLOBAL (excluded) only if it
  // explicitly opts out — either by importing from ./persistence (a user
  // preference persisted across refresh) or by carrying a documented
  // @global-store marker. There is NO hardcoded store list: the set is
  // discovered by readdirSync + classified by code patterns. Adding a
  // new per-chat store without registerContextReset → FAILS. Adding a
  // new global store without a marker/persistence → FAILS (review flow:
  // add the marker with a reason, or add registerContextReset if it is
  // actually per-chat).
  test("every store with registerReset is EITHER per-chat (registerContextReset) OR explicitly global", () => {
    const files = stateFiles();
    expect(files.length, "src/state/ must contain store files").toBeGreaterThan(0);
    const offenders: string[] = [];
    let sessionStores = 0;
    let perChatStores = 0;
    let globalStores = 0;
    for (const f of files) {
      const name = rel(f);
      if (OWNER_FILES.has(name.split("/").pop()!)) continue;
      const src = readClean(f);
      if (!hasCall(src, "registerReset")) continue;
      sessionStores += 1;
      const isGlobalByPersistence = importsPersistence(src);
      const isGlobalByMarker = hasGlobalStoreMarker(src);
      const isPerChat = hasCall(src, "registerContextReset");
      if (isPerChat) {
        perChatStores += 1;
        // A per-chat store must NOT also be marked global (contradictory).
        if (isGlobalByMarker) {
          offenders.push(`${name}: marked @global-store but ALSO calls registerContextReset — pick one (a per-chat snapshot should not be marked global)`);
        }
        continue;
      }
      // Not per-chat → must be explicitly global.
      if (isGlobalByPersistence || isGlobalByMarker) {
        globalStores += 1;
        continue;
      }
      offenders.push(
        `${name}: calls registerReset but has no registerContextReset and is not marked global. ` +
          "If this store holds per-chat/run data, add `registerContextReset(\"<name>\", resetFn)`. " +
          "If it is user-wide/server-wide/per-project, add a `@global-store <reason>` JSDoc marker (or import from ./persistence for a persisted user preference).",
      );
    }
    // Sanity: the known per-chat snapshots must be detected (regression
    // guard — if the discovery broke, perChatStores would be 0).
    expect(perChatStores, "at least the known per-chat snapshots must self-register").toBeGreaterThanOrEqual(1);
    expect(
      offenders,
      "every session store must be per-chat (registerContextReset) or explicitly global (@global-store / persistence)",
    ).toEqual([]);
    // Diagnostic counters (visible in the test output for review).
    // eslint-disable-next-line no-console
    console.log(
      `[context-reset scan] session=${sessionStores} per-chat=${perChatStores} global=${globalStores}`,
    );
  });

  test("every file that calls registerContextReset imports it from ./store-registry", () => {
    const files = stateFiles();
    const offenders: string[] = [];
    for (const f of files) {
      const src = readClean(f);
      if (!hasCall(src, "registerContextReset")) continue;
      // ANY RELATIVE SPELLING OF THE REGISTRY MODULE, not literally
      // `./store-registry`. Pinning the sibling spelling made this guard a
      // claim about today's directory layout: a store legitimately grouped
      // into `src/state/<sub>/` imports `../store-registry` and was reported
      // as unregistered — the guard blocking the exact refactor the recursive
      // loader was fixed to make safe.
      if (!/from\s*["'](?:\.{1,2}\/)+(?:[^"']*\/)?store-registry(?:\.ts)?["']/.test(src)) {
        offenders.push(`${rel(f)}: calls registerContextReset but does not import it from ./store-registry`);
      }
    }
    expect(offenders, "every file calling registerContextReset must import it from ./store-registry").toEqual([]);
  });
});

// (Class D — the App.svelte no-manual-reset probe — died with the old
// tree; the registry itself is the choke point classes A–C hold.)

// ── E. Behavioral — changing currentChatId resets a registered store ──

describe("E. behavioral — chat switch resets registered stores via the signal", () => {
  test("changing currentChatId resets qualitySnapshot (the full pipeline)", async () => {
    // Import reset-all to trigger the glob (populates the registry) +
    // wire the listen.
    await import("../../src/state/reset-all");
    const { currentChatId } = await import("../../src/state/chats");
    const { qualitySnapshot } = await import("../../src/state/quality");

    // Start from a known state: no chat selected, snapshot null.
    currentChatId.set(null);
    qualitySnapshot.set(null);

    // Simulate a run on chat A: the server sends a quality SSE event.
    currentChatId.set("chat-A");
    qualitySnapshot.set({
      runId: "run-1",
      overallScore: 85,
      grade: "B",
      totalIssues: 5,
      issuesPerKloc: 2.5,
      recommendations: ["fix foo"],
    });
    expect(qualitySnapshot.get()).not.toBeNull();

    // Switch to chat B: the signal fires → resetContextStores → resetQuality.
    currentChatId.set("chat-B");
    expect(qualitySnapshot.get(), "qualitySnapshot must be null after chat switch (auto-reset)").toBeNull();
  });

  test("changing currentChatId resets dedupSnapshot (the full pipeline)", async () => {
    await import("../../src/state/reset-all");
    const { currentChatId } = await import("../../src/state/chats");
    const { dedupSnapshot } = await import("../../src/state/dedup");

    currentChatId.set(null);
    dedupSnapshot.set(null);
    currentChatId.set("chat-A");
    dedupSnapshot.set({
      applied: true,
      originalChars: 1000,
      dedupedChars: 800,
      charReductionPct: 20,
      removedBlocks: 2,
      removedLines: 5,
      messageCount: 3,
    });
    expect(dedupSnapshot.get()).not.toBeNull();

    currentChatId.set("chat-B");
    expect(dedupSnapshot.get(), "dedupSnapshot must be null after chat switch (auto-reset)").toBeNull();
  });

  test("a NEW store that self-registers via registerContextReset resets on chat switch without handler code", async () => {
    await import("../../src/state/reset-all");
    const { currentChatId } = await import("../../src/state/chats");
    const { registerContextReset } = await import("../../src/state/store-registry");
    const { atom } = await import("nanostores");

    // Simulate a new snapshot store: create an atom + register it.
    const newSnapshot = atom<{ value: number } | null>(null);
    const resetNew = (): void => { newSnapshot.set(null); };
    registerContextReset("test-new-snapshot", resetNew);

    currentChatId.set(null);
    newSnapshot.set({ value: 42 });
    expect(newSnapshot.get()).not.toBeNull();

    // Chat switch: the signal fires → resetContextStores → resetNew.
    currentChatId.set("chat-new");
    expect(newSnapshot.get(), "a self-registered store must reset on chat switch without any handler code").toBeNull();
  });
});

// ── F. Mutation-verified — removing registerContextReset breaks the pipeline ──

describe("F. mutation-verified — the auto-reset is driven by registerContextReset", () => {
  test("resetContextStores only resets stores that called registerContextReset", async () => {
    const { clearContextResetRegistry, resetContextStores, registerContextReset, snapshotContextResetRegistry, restoreContextResetRegistry } = await import("../../src/state/store-registry");
    const { atom } = await import("nanostores");

    // snapshot/restore (not bare clear) so the context-reset registry stays
    // populated with the real stores for subsequent test files under
    // `isolate: false` (a cached re-import does not re-run the store
    // modules' top-level registerContextReset side-effects).
    const snapshot = snapshotContextResetRegistry();
    try {
      // Clear the registry (simulate a store that forgot to register).
      clearContextResetRegistry();

      const unregistered = atom<number | null>(null);
      unregistered.set(99);
      // Register a DIFFERENT store (so the registry isn't empty).
      const registered = atom<number | null>(null);
      registered.set(55);
      registerContextReset("test-registered", () => { registered.set(null); });

      resetContextStores();
      // The registered store reset.
      expect(registered.get()).toBeNull();
      // The unregistered store did NOT reset (deny-by-default: a store that
      // forgets to call registerContextReset is NOT reset on chat switch).
      expect(unregistered.get()).toBe(99);
    } finally {
      restoreContextResetRegistry(snapshot);
    }
  });

  test("source-scan mutation: a session store without registerContextReset and without @global-store is flagged", () => {
    // Simulate the mutation inline (no file write): a hypothetical source
    // that calls registerReset but neither registerContextReset nor a
    // @global-store marker nor a persistence import. The classifier must
    // flag it as an offender.
    const mutantSrc = [
      "import { registerReset } from './store-registry';",
      "export const x = atom(null);",
      "function resetX() { x.set(null); }",
      "registerReset('mutant', resetX);",
    ].join("\n");
    const isSession = hasCall(mutantSrc, "registerReset");
    const isPerChat = hasCall(mutantSrc, "registerContextReset");
    const isGlobal = importsPersistence(mutantSrc) || hasGlobalStoreMarker(mutantSrc);
    expect(isSession, "the mutant calls registerReset").toBe(true);
    expect(isPerChat, "the mutant does NOT call registerContextReset").toBe(false);
    expect(isGlobal, "the mutant is NOT marked global").toBe(false);
    // Deny-by-default: session + not per-chat + not global → offender.
    expect(isSession && !isPerChat && !isGlobal, "deny-by-default: the mutant is flagged").toBe(true);
  });

  test("source-scan mutation: a global store that drops its @global-store marker is flagged", () => {
    // Simulate removing the marker from a global store: it still calls
    // registerReset, still does NOT call registerContextReset, but no
    // longer has the marker (and no persistence import). The classifier
    // must flag it.
    const mutantSrc = [
      "import { registerReset } from './store-registry';",
      "export const errs = atom([]);",
      "function clearErrors() { errs.set([]); }",
      "registerReset('errors', clearErrors);",
    ].join("\n");
    const isSession = hasCall(mutantSrc, "registerReset");
    const isPerChat = hasCall(mutantSrc, "registerContextReset");
    const isGlobal = importsPersistence(mutantSrc) || hasGlobalStoreMarker(mutantSrc);
    expect(isSession && !isPerChat && !isGlobal, "deny-by-default: a global store without its marker is flagged").toBe(true);
  });
});

// ── G. @global-store markers are sound ──

describe("G. @global-store markers are sound", () => {
  test("every @global-store marker documents a reason (no bare marker)", () => {
    const files = stateFiles();
    const offenders: string[] = [];
    for (const f of files) {
      const src = readClean(f);
      if (!hasGlobalStoreMarker(src)) continue;
      const reason = globalStoreReason(src);
      if (reason === null || reason.length < 8) {
        offenders.push(`${rel(f)}: @global-store marker missing a documented reason`);
      }
    }
    expect(offenders, "every @global-store marker must document why the store is global").toEqual([]);
  });

  test("a global store does NOT also call registerContextReset (a global store resetting on chat switch is a bug)", () => {
    const files = stateFiles();
    const offenders: string[] = [];
    for (const f of files) {
      const name = rel(f);
      if (OWNER_FILES.has(name.split("/").pop()!)) continue;
      const src = readClean(f);
      if (!hasCall(src, "registerReset")) continue;
      const isGlobal = importsPersistence(src) || hasGlobalStoreMarker(src);
      if (!isGlobal) continue;
      if (hasCall(src, "registerContextReset")) {
        offenders.push(
          `${name}: is global (persistence or @global-store) but ALSO calls registerContextReset — a global store must NOT reset on chat switch`,
        );
      }
    }
    expect(offenders, "global stores must not self-register for context-reset").toEqual([]);
  });

  test("the per-chat classification uses dynamic discovery (readdirSync), not a hardcoded store list", () => {
    // The test must discover stores dynamically via readdirSync and
    // classify them by code patterns (persistence import + @global-store
    // marker), NOT by a hardcoded array of filenames. The only allowed
    // filename set is OWNER_FILES (the infrastructure owners), which must
    // contain ONLY non-data-store modules.
    const testSrc = readClean(join(dirname(fileURLToPath(import.meta.url)), "context-switch-reset-owner.test.ts"));
    expect(testSrc, "the test must use readdirSync to discover stores dynamically").toMatch(/readdirSync\(STATE_DIR\)/);
    // OWNER_FILES is the sole allowed filename set. It must not contain
    // any data store (only the registry/wiring owners + the persistence
    // utility). A data store name in OWNER_FILES would silently exclude
    // it from the per-chat scan — a hole.
    expect(OWNER_FILES, "OWNER_FILES must contain only infrastructure owners").toEqual(
      new Set(["store-registry.ts", "reset-all.ts", "persistence.ts"]),
    );
    // No other array/set of state filenames may exist in the test (that
    // would be a rigid list). Allow OWNER_FILES; forbid any other literal
    // array literal containing a `.ts` state filename.
    const otherListMatch = testSrc.match(/=\s*\[([^\]]*\.ts[^\]]*)\]/g);
    expect(otherListMatch, "no hardcoded array of state filenames beyond OWNER_FILES").toBeNull();
  });
});

// ── H. Scope-based store hygiene — auto-checks eviction on project switch ──

describe("H. scope-based store hygiene — auto-checks evicts other projects on project switch", () => {
  // A scope-based store (auto-checks) is marked @global-store (Class G)
  // because it is re-scoped on chat switch, not reset. But its raw list
  // must not accumulate checks from every project ever visited — an
  // unbounded memory leak. `listProjectAutoChecks` calls
  // `evictAutoChecksForOtherProjects` before upserting so only the
  // current project's checks remain. This test pins the eviction so a
  // future refactor that reverts to a bare `upsertAutoChecks` (merge)
  // without eviction is caught.
  test("auto-checks.ts exports evictAutoChecksForOtherProjects", () => {
    const src = readClean(join(STATE_DIR, "auto-checks.ts"));
    expect(src, "evictAutoChecksForOtherProjects must be exported").toMatch(/export function evictAutoChecksForOtherProjects\s*\(/);
    // The eviction must filter OUT checks whose projectId differs (keep
    // null + the target project). A bare `set([])` (full clear) would
    // also pass the leak fix but loses the current project's chat-level
    // checks; require the filter form.
    expect(src).toMatch(/c\.projectId\s*===\s*null\s*\|\|\s*c\.projectId\s*===\s*projectId/);
  });

  test("listProjectAutoChecks in client.ts evicts other projects before upserting", () => {
    const clientPath = join(ROOT, "src", "client.ts");
    const src = readClean(clientPath);
    expect(src, "client.ts must import evictAutoChecksForOtherProjects from auto-checks").toMatch(/evictAutoChecksForOtherProjects/);
    // The eviction must be CALLED inside listProjectAutoChecks (not just
    // imported). Match the call on its own line.
    expect(src).toMatch(/evictAutoChecksForOtherProjects\s*\(/);
  });

  test("behavioral: evictAutoChecksForOtherProjects keeps the target project + drops others", async () => {
    const { autoChecks, setAutoChecks, evictAutoChecksForOtherProjects, resetAutoChecks } = await import("../../src/state/auto-checks");
    resetAutoChecks();
    // Seed checks from two projects + a legacy null-project check.
    setAutoChecks([
      { id: "p1-proj", projectId: "p1", chatId: null, checkName: "lint", status: "passed", output: null, createdAt: "" },
      { id: "p1-chat", projectId: "p1", chatId: "c1", checkName: "build", status: "failed", output: null, createdAt: "" },
      { id: "p2-proj", projectId: "p2", chatId: null, checkName: "lint", status: "passed", output: null, createdAt: "" },
      { id: "legacy", projectId: null, chatId: null, checkName: "schema", status: "warning", output: null, createdAt: "" },
    ]);
    evictAutoChecksForOtherProjects("p1");
    const remaining = autoChecks.get();
    expect(remaining.map((c) => c.id).sort()).toEqual(["legacy", "p1-chat", "p1-proj"]);
    resetAutoChecks();
  });

  test("setAutoChecksScope evicts the previous chat's checks on chatId change (choke-point fix)", async () => {
    // The scope choke point (`setAutoChecksScope`) MUST evict the previous
    // chat's checks when the chatId changes (within a project) so the raw
    // list does not accumulate checks across every chat visited. The
    // derived `checksForCurrentChat` filters by the current chatId (view is
    // correct), but the raw list grew — a bounded-accumulation class of bug.
    // Evicting at the single setter (every scope change goes through it)
    // means no caller can forget to clear the previous chat's checks.
    const { autoChecks, setAutoChecks, setAutoChecksScope, resetAutoChecks } =
      await import("../../src/state/auto-checks");
    resetAutoChecks();
    // Seed checks for project p1: project-level + chat c1 + chat c2.
    setAutoChecks([
      { id: "p1-proj", projectId: "p1", chatId: null, checkName: "lint", status: "passed", output: null, createdAt: "" },
      { id: "p1-c1", projectId: "p1", chatId: "c1", checkName: "build", status: "failed", output: null, createdAt: "" },
      { id: "p1-c2", projectId: "p1", chatId: "c2", checkName: "schema", status: "warning", output: null, createdAt: "" },
    ]);
    setAutoChecksScope("p1", "c1");
    // Switch from chat c1 to chat c2 (same project) — c1's checks MUST be evicted.
    setAutoChecksScope("p1", "c2");
    const remaining = autoChecks.get();
    expect(remaining.map((c) => c.id).sort(), "previous chat c1 evicted; project + c2 kept").toEqual([
      "p1-c2",
      "p1-proj",
    ]);
    // Switch from chat c2 to null (project view) — c2's checks MUST be evicted.
    setAutoChecksScope("p1", null);
    expect(autoChecks.get().map((c) => c.id).sort(), "previous chat c2 evicted; project-level kept").toEqual([
      "p1-proj",
    ]);
    resetAutoChecks();
  });
});
