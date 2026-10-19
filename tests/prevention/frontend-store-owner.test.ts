// @vitest-environment node
/**
 * Mechanical enforcement: Frontend Store Owner (Single-Party-Owner ).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default" + ): every nanostores writable atom in `src/state/` that
 * holds user/session-originating data MUST follow ONE canonical pattern:
 * (1) a nanostores `atom`/`map` writable (the state) + `computed` derived
 * (no ad-hoc state management — no custom class, no `$state` in a
 * `.ts` state module);
 * (2) a no-arg `reset*` (or `clear*`) exported function that restores the
 * initial/empty state;
 * (3) that reset function is referenced (imported + called) by the
 * SINGLE store-reset owner `src/state/reset-all.ts::resetAllStores`;
 * (4) `src/client.ts::submitLogout` calls `resetAllStores` (after
 * closing any active SSE stream) so a logout cannot leave a previous
 * user's data in any store — closing the cross-user client-state data
 * leak flagged by -B1 (CRITICAL).
 *
 * Before `submitLogout` reset ONLY `authState`, leaving projects, chats,
 * messages, run-state, metrics, memory, timeline, auto-checks, tools,
 * schema-store, quality, code-index, ui-layout, config, models, errors, and
 * route holding the previous user's data. After logout + re-login as a
 * DIFFERENT user on the same tab, the new user briefly saw the previous
 * user's data. fix: `resetAllStores` (the single owner) clears every
 * store through ONE path; the old shell's boot guard reset on logout so
 * re-login re-ran boot (that half died with the old tree — class E below).
 *
 * Dynamic discovery: the store set is built by a RECURSIVE walk —
 * NEVER hardcoded. A new `src/state/foo.ts` that exports a writable atom
 * is automatically required to (a) have a reset function, (b) be wired into
 * `resetAllStores`. A forgotten store is caught automatically (deny-by-
 * default: the default state is "not wired"you must EXPLICITLY add the
 * reset + the `resetAllStores` call).
 *
 * Assurance classes:
 * A. Pattern consistency — every state file uses nanostores (atom/map/
 * computed); no ad-hoc state in `.ts` state modules.
 * B. Every store with a writable atom exports a no-arg reset/clear fn.
 * C. `resetAllStores` imports + calls every store's reset fn (wiring).
 * D. `submitLogout` calls `resetAllStores` + closes the active stream.
 * E. (died with the old tree — the old shell's boot guard on logout.)
 * F. Behavioral — populate every writable atom with non-default data,
 * call `resetAllStores`, assert every store is back to initial/empty.
 * (The strongest class: proves the reset actually works, not just
 * that the wiring exists.)
 *
 * Mutation-verified: removing a store's reset call from `resetAllStores`,
 * deleting a `reset*` export, adding a new store without wiring it, or
 * reverting `submitLogout` to only reset `authState` each makes the
 * relevant test FAIL.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { stripCommentsOnly, stripBlockAndOwnLineComments, walkTs } from "../helpers/source-scan.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

/** This guard's population is CODE — state-module TypeScript. The mode is
 * named once here rather than guessed from bytes per call. */
const stripComments = (src: string) => stripBlockAndOwnLineComments(src, "probe.ts");

const REPO_ROOT = process.cwd();
const SRC_DIR = join(REPO_ROOT, "src");
const STATE_DIR = join(SRC_DIR, "state");
const RESET_ALL_FILE = join(STATE_DIR, "reset-all.ts");
const CLIENT_FILE = join(SRC_DIR, "client.ts");

// ── Dynamic discovery ──

/**
 * Every store module anywhere under `src/state/`, RECURSIVELY.
 *
 * A flat `readdirSync` here shared the subject's blind spot exactly: the
 * loader globbed one directory level, this listed one directory level, and a
 * store moved into `src/state/<sub>/` disappeared from both at once — so the
 * guard agreed with the defect instead of catching it. An expectation
 * computed the same way as its subject can only ever confirm it.
 *
 * `walkTs` is the shared walker: the recursion lives in one place and a
 * missing root is a REFUSAL rather than an empty answer.
 */
function stateFiles(): string[] {
  return walkTs(STATE_DIR)
    .filter((f) => !f.endsWith(".d.ts"))
    .sort();
}

/** The writable-atom names exported by a state file: `export const X = atom`
 * or `export const X = map` (NOT `computed` — that's read-only). */
function writableAtomNames(src: string): string[] {
  const cleaned = stripComments(src);
  const names: string[] = [];
  const re = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(atom|map)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) names.push(m[1]!);
  return names;
}

/** The no-arg `reset*`/`clear*` function names exported by a state file.
 * `clearIndexing(projectId)` takes an arg → NOT matched (it's per-project,
 * not the global reset). `clearMessages` / `resetCodeIndex` (no-arg)
 * → matched (the canonical global reset). */
function resetFnNames(src: string): string[] {
  const cleaned = stripComments(src);
  const names: string[] = [];
  // no-arg: `export function resetFoo` or `export function clearFoo`
  const re = /^export\s+function\s+(reset|clear)[A-Za-z_$][\w$]*\s*\(\s*\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[0].match(/function\s+([A-Za-z_$][\w$]*)/)![1]!;
    names.push(name);
  }
  return names;
}

/** Parse `import { A as B, C } from "./mod"` → map module → {exported: local}.
 * Covers multi-line imports + `type` imports (skipped for value bindings). */
function parseImports(src: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const cleaned = stripComments(src);
  const re = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const bindings = m[1]!;
    const module = m[2]!;
    const map = out.get(module) ?? new Map<string, string>();
    for (const part of bindings.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0 || /^type\s+/.test(trimmed)) continue;
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
      const exported = trimmed.replace(/\s+as\s+.*$/, "").replace(/:.+$/, "").trim();
      const local = asMatch ? asMatch[1]! : exported;
      if (exported.length > 0) map.set(exported, local);
    }
    out.set(module, map);
  }
  return out;
}

/** Extract the `resetAllStores` function body (text between its braces). */
function resetAllStoresBody(src: string): string {
  const cleaned = stripComments(src);
  const start = cleaned.indexOf("function resetAllStores");
  if (start === -1) return "";
  // find the first `{` after the signature
  const braceStart = cleaned.indexOf("{", start);
  if (braceStart === -1) return "";
  let depth = 0;
  for (let i = braceStart; i < cleaned.length; i += 1) {
    const c = cleaned[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return cleaned.slice(braceStart, i + 1);
    }
  }
  return cleaned.slice(braceStart);
}

/** Relative module specifier reset-all.ts uses for a state file.
 * reset-all.ts is at `src/state/reset-all.ts`; stores are `src/state/<name>.ts`
 * → specifier `./<name>`. */
function moduleSpecifierFor(stateFile: string): string {
  const base = stateFile.replace(/\.ts$/, "");
  const name = base.split(sep).pop()!;
  return `./${name}`;
}

// ── A. Pattern consistency — nanostores only, no ad-hoc state ──

describe("A. pattern consistency — every state file uses nanostores (atom/map/computed)", () => {
  test("no src/state/*.ts uses ad-hoc state ($state, custom store class, writable", () => {
    // Svelte `$state` runes belong in.svelte components, NOT in.ts state
    // modules. A custom store class or `writable` (svelte/store) would be
    // a parallel state pattern — a violation of the single-pattern rule.
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of stateFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      // Every hit at its true line (the one "matches over a view" spelling; comments blanked).
      const view = sourceViewOf(src, file);
      // `$state(` in a.ts state file (runes are component-only); svelte/store
      // `writable(`/`readable(` (a parallel store lib).
      for (const pattern of [/\$state\s*\(/u, /\b(writable|readable)\s*\(/u]) {
        for (const hit of view.matches(pattern, "codeWithStrings")) offenders.push({ file: rel, line: hit.line, text: hit.text });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Ad-hoc state management found in a state module — use nanostores atom/map/computed only:\n${detail}`,
      );
    }
  });

  test("every state file that exports a writable atom imports from nanostores", () => {
    const offenders: string[] = [];
    for (const file of stateFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      const cleaned = stripComments(src);
      if (writableAtomNames(cleaned).length === 0) continue; // helper module
      if (!/from\s*["']nanostores["']/.test(cleaned)) {
        offenders.push(rel);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `State files with a writable atom must import from "nanostores": ${offenders.join(", ")}`,
      );
    }
  });
});

// ── B. every store with a writable atom exports a no-arg reset/clear fn ──

describe("B. every store with a writable atom exports a no-arg reset*/clear* fn", () => {
  test("each src/state/*.ts with a writable atom has a no-arg reset/clear fn", () => {
    const offenders: { file: string; atoms: string[]; resets: string[] }[] = [];
    for (const file of stateFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      const atoms = writableAtomNames(src);
      if (atoms.length === 0) continue; // helper/derived-only module
      const resets = resetFnNames(src);
      if (resets.length === 0) {
        offenders.push({ file: rel, atoms, resets });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `${o.file} exports writable atom(s) [${o.atoms.join(", ")}] but NO no-arg reset*/clear* function`)
        .join("\n");
      throw new Error(
        `Every state store must export a no-arg reset*/clear* function (called by resetAllStores on logout — SPO):\n${detail}`,
      );
    }
  });
});

// ── C. resetAllStores wires every store's reset fn (no forgotten store) ──
//
// changed the mechanism from a MANUALLY-MAINTAINED call list to
// a DYNAMIC auto-registering registry ("Relieve Responsibilities":
// "stores AUTO-REGISTER into a registry; the reset iterates the registry
// dynamically; adding a new store = automatically covered"). Class C now
// verifies the DYNAMIC pattern: (1) reset-all.ts re-exports resetAllStores
// from the registry owner `./store-registry`, (2) reset-all.ts loads every
// store via `import.meta.glob` so self-registrations run (no manual import
// list), (3) reset-all.ts does NOT contain a manual
// `resetXxx` call list (the rigid pattern removed), (4) every store
// with a reset fn self-registers it via `registerReset(...)` in its source.

describe("C. resetAllStores wires every store's reset fn (dynamic registry)", () => {
  test("reset-all.ts re-exports resetAllStores from./store-registry", () => {
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    expect(
      stripComments(src),
      "reset-all.ts must re-export resetAllStores from ./store-registry (the dynamic registry owner — SPO)",
    ).toMatch(/export\s*\{\s*resetAllStores\s*\}\s*from\s*["']\.\/store-registry["']/);
  });

  test("reset-all.ts loads every store via an eager import.meta.glob (dynamic discovery)", () => {
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    // THE MECHANISM, not the exact pattern. Pinning the literal here is what
    // let a NON-RECURSIVE glob pass as "dynamic discovery" — the string was
    // certified and its match set was never looked at. What the glob actually
    // matched is judged in frontend-stores-deep.test.ts against an
    // independent recursive walk of the same directory.
    // `stripCommentsOnly`, NOT the regex stripper, and the reason is
    // measured: a glob pattern contains `/*`, so the regex stripper — which
    // is not string-aware — treats the pattern's own text as the start of a
    // block comment and deletes the loader along with everything up to the
    // next comment terminator. It then reports the loader ABSENT. A stripper
    // that eats the subject is a silently smaller universe with a confident
    // verdict attached.
    expect(
      stripCommentsOnly(src),
      "reset-all.ts must use an eager import.meta.glob to load every store for self-registration — no manual import list",
    ).toMatch(/import\.meta\.glob\s*\(\s*["'][^"']+["']\s*,\s*\{\s*eager:\s*true\s*\}\s*\)/);
  });

  test("reset-all.ts does NOT contain a manually-maintained resetXxx call list (the rigid pattern removed)", () => {
    // The RIGID pattern (pre-) was 21 lines like `resetAuth;
    // resetProjects;...`. replaced it with the dynamic registry. A
    // regression to the manual list would re-introduce the "forgot to add a
    // store" risk the dynamic registry eliminates. Allow the re-export +
    // glob; reject any direct `resetXxx` / `clearXxx` CALL (not the
    // import — the import is gone too, but the call is the rigid signal).
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    const cleaned = stripComments(src);
    // Match a bare call to a reset/clear fn: `resetAuth` / `clearMessages`.
    // The re-export `export { resetAllStores }` is NOT a call. The glob is
    // not a call. A manual list regression would re-add these.
    const manualCallRe = /\b(reset|clear)[A-Za-z_$][\w$]*\s*\(\s*\)/g;
    // Strip the re-export + glob lines so they don't false-positive.
    const stripped = cleaned
      .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["']/g, "")
      .replace(/import\.meta\.glob\s*\([^)]*\)/g, "")
      .replace(/const\s+_storeModules\s*=\s*[^;]+;/g, "")
      .replace(/\bvoid\s+_storeModules\s*;?/g, "");
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = manualCallRe.exec(stripped)) !== null) {
      offenders.push(m[0]);
    }
    if (offenders.length > 0) {
      throw new Error(
        `reset-all.ts must NOT contain a manual resetXxx()/clearXxx() call list replaced it with the dynamic registry (registerReset + resetAllStores iterates the registry). Found manual calls: ${offenders.join(", ")}`,
      );
    }
  });

  test("every store with a reset fn self-registers it via registerReset(...)", () => {
    // Each store module that exports a no-arg reset*/clear* fn MUST call
    // `registerReset("<name>", <fn>)` at module scope so the dynamic
    // registry picks it up. A store that defines a reset fn but forgets to
    // register it is NOT covered by logout reset (deny-by-default — the
    // default state is "not registered"; you must EXPLICITLY register).
    const offenders: { file: string; resetFn: string; reason: string }[] = [];
    for (const file of stateFiles()) {
      const src = readFileSync(file, "utf8");
      if (writableAtomNames(src).length === 0) continue; // helper module
      const resets = resetFnNames(src);
      if (resets.length === 0) continue; // class B already flags this
      const cleaned = stripComments(src);
      // Must import registerReset from./store-registry.
      // ANY RELATIVE SPELLING OF THE REGISTRY MODULE, not literally
      // `./store-registry`. Pinning the sibling spelling made this guard a
      // claim about today's directory layout: a store legitimately grouped
      // into `src/state/<sub>/` imports `../store-registry` and was reported
      // as unregistered — the guard blocking the exact refactor the recursive
      // loader was fixed to make safe.
      if (!/from\s*["'](?:\.{1,2}\/)+(?:[^"']*\/)?store-registry(?:\.ts)?["']/.test(cleaned)) {
        for (const resetFn of resets) {
          offenders.push({ file: relative(REPO_ROOT, file).split(sep).join("/"), resetFn, reason: "does not import registerReset from ./store-registry" });
        }
        continue;
      }
      // Each reset fn must be passed to registerReset. A store may export
      // multiple reset fns; each must be registered.
      for (const resetFn of resets) {
        const re = new RegExp(`registerReset\\s*\\(\\s*["'][^"']+["']\\s*,\\s*${resetFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!re.test(cleaned)) {
          offenders.push({ file: relative(REPO_ROOT, file).split(sep).join("/"), resetFn, reason: `'${resetFn}' not passed to registerReset(...)` });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.file}: ${o.resetFn} — ${o.reason}`).join("\n");
      throw new Error(
        `Store reset functions not self-registered via registerReset (the dynamic registry — SPO; an unregistered store is NOT reset on logout = cross-user data leak):\n${detail}`,
      );
    }
  });
});

// ── D. submitLogout calls resetAllStores + closes the active stream ──

describe("D. submitLogout calls resetAllStores + closes the active SSE stream", () => {
  function submitLogoutBody(): string {
    const src = stripComments(readFileSync(CLIENT_FILE, "utf8"));
    const start = src.indexOf("function submitLogout");
    if (start === -1) return "";
    const braceStart = src.indexOf("{", start);
    if (braceStart === -1) return "";
    let depth = 0;
    for (let i = braceStart; i < src.length; i += 1) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(braceStart, i + 1);
      }
    }
    return src.slice(braceStart);
  }

  test("src/client.ts defines submitLogout", () => {
    const src = readFileSync(CLIENT_FILE, "utf8");
    expect(stripComments(src), "src/client.ts must define submitLogout").toMatch(
      /export\s+async\s+function\s+submitLogout\s*\(/,
    );
  });

  test("submitLogout calls resetAllStores", () => {
    const body = submitLogoutBody();
    expect(
      body,
      "submitLogout must call resetAllStores() — the single store-reset owner (SPO, fixes -B1 cross-user data leak)",
    ).toMatch(/\bresetAllStores\s*\(\s*\)/);
  });

  test("submitLogout closes the active SSE stream BEFORE resetAllStores (no post-reset writes)", () => {
    // An in-flight run's EventSource keeps appending messages/tool-calls/
    // agents. If the stream isn't closed, it writes into the stores AFTER
    // resetAllStores clears them — re-leaking the old user's data. The
    // close must come before resetAllStores (ordering matters).
    const body = submitLogoutBody();
    const closeIdx = body.search(/activeStreamController\s*\?\s*\.\s*close|activeStreamController\s*!==\s*null/);
    const resetIdx = body.search(/\bresetAllStores\s*\(/);
    expect(closeIdx, "submitLogout must close activeStreamController (the active SSE stream) before resetting stores").toBeGreaterThan(-1);
    expect(resetIdx, "submitLogout must call resetAllStores").toBeGreaterThan(-1);
    expect(closeIdx, "the stream close must come BEFORE resetAllStores (a live stream would re-leak data after the reset)").toBeLessThan(resetIdx);
  });

  test("submitLogout does NOT reset authState directly (uses the single owner path)", () => {
    // Before  submitLogout did `authState.set(initialAuth)` — a one-off
    // bypass of the single reset owner. routes auth reset through
    // resetAllStores (resetAuth). A direct `authState.set` here would be a
    // parallel path (SPO violation).
    const body = submitLogoutBody();
    expect(
      body,
      "submitLogout must NOT call authState.set directly — route through resetAllStores (the single owner, which calls resetAuth)",
    ).not.toMatch(/\bauthState\.set\s*\(/);
  });
});

// (Class E — the App.svelte booted guard — died with the old tree; the
// cockpit's boot latch has its own owner in tests/cockpit/boot-waves-owner.)

// ── F. behavioral — populate every store, resetAllStores, verify empty ──

describe("F. behavioral — resetAllStores clears every writable store", () => {
  // Import the writable atoms + resetAllStores. Importing the state modules
  // binds persistence listeners (no-ops in node: no localStorage) — safe.
  test("resetAllStores restores every store to its initial/empty state", async () => {
    const { resetAllStores } = await import("../../src/state/reset-all");
    const { authState, initialAuth } = await import("../../src/state/auth");
    const { projects, currentProjectId } = await import("../../src/state/projects");
    const { chatsSnapshot, setChats, currentChatId } = await import("../../src/state/chats");
    const { messages, isStreaming } = await import("../../src/state/chat-messages");
    const { autoChecks, autoChecksProjectId, autoChecksChatId } = await import("../../src/state/auto-checks");
    // (code-index / route / ui-layout are decided-deleted with the old tree
    //  and leave this drive with their stores.)
    const { configSnapshot } = await import("../../src/state/config-snapshot");
    const { errors } = await import("../../src/state/errors");
    const { memoryEntries } = await import("../../src/state/memory");
    const { metricsSnapshot, systemMetrics, tokenThroughput, metricsHistory } = await import("../../src/state/metrics");
    const { modelsCatalog, selectedModelId } = await import("../../src/state/models");
    const { qualitySnapshot } = await import("../../src/state/quality");
    const { currentRun, agents } = await import("../../src/state/run-state");
    const { uiSchema, uiSchemaValues } = await import("../../src/state/schema-store");
    const { timelineScope, timelineFilter, timelineResults } = await import("../../src/state/timeline-query");
    const { timelineRefs, currentTimelineChatId } = await import("../../src/state/timeline-refs");
    const { toolManifest, enabledTools } = await import("../../src/state/tools");

    // ── Populate EVERY writable atom with non-default data ──
    authState.set({ ...initialAuth, authenticated: true, username: "user-a", isAdmin: true });
    projects.set([{ id: "p1", name: "P", path: "/p", createdAt: "t", updatedAt: "t" }] as never);
    currentProjectId.set("p1");
    setChats([{ id: "c1", projectId: "p1", title: "C", createdAt: "t", updatedAt: "t", modelId: null, pinned: false }] as never);
    currentChatId.set("c1");
    messages.set([{ id: "m1", role: "user", content: "hi", timestamp: 1 }] as never);
    isStreaming.set(true);
    autoChecks.set([{ id: "a1", projectId: "p1", chatId: null, checkName: "lint", status: "passed", output: null, createdAt: "t" }] as never);
    autoChecksProjectId.set("p1");
    autoChecksChatId.set("c1");
    configSnapshot.set({ config: { x: 1 } } as never);
    errors.set([{ id: "e1", kind: "network", code: "x", message: "m", statusCode: undefined, timestamp: 1 }] as never);
    memoryEntries.set([{ id: "m", content: "secret", tier: "short-term", topic: null, tags: [], agentId: null, createdAt: "t", source: "user", toolName: null, originalRequest: null, chatId: null, how: "manual", userId: "u-a" }] as never);
    metricsSnapshot.set({ snapshotId: "s", entries: [], entryCount: 0, totalCallCount: 1, totalErrorCount: 0, totalCancellationCount: 0 } as never);
    systemMetrics.set({ capturedAt: "t", processUptimeMs: 1, osUptimeMs: 1, cpuCount: 1, loadAverage1m: 1, memory: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1, arrayBuffers: 1, systemFree: 1, systemTotal: 1 }, eventLoop: { utilization: 1, delayMin: 0, delayMax: 0, delayMean: 0, delayStddev: 0 } } as never);
    tokenThroughput.set({ inputTokens: 1, outputTokens: 1, totalTokens: 2, tokensPerSecond: 1 } as never);
    metricsHistory.set([{ at: 1, tokensPerSecond: 1, totalCalls: 1, totalErrors: 0, loadAverage1m: 1, heapUsed: 1, eventLoopUtil: 1 }] as never);
    modelsCatalog.set({ providers: [], defaultProvider: null, defaultModel: null, setupRequired: true, setupRemedy: "Open Settings and add a model provider." });
    selectedModelId.set("qwen");
    qualitySnapshot.set({ overallScore: 99, grade: "A", totalIssues: 0, issuesPerKloc: 0, recommendations: [] } as never);
    currentRun.set({ runId: "r1", status: "running", startedAt: 1, modelLabel: "qwen" } as never);
    agents.setKey("a1", { agentId: "a1", lifecycleState: "running" } as never);
    uiSchema.set({ menus: [], panels: [], widgets: [] } as never);
    uiSchemaValues.set({ signals: [] } as never);
    timelineScope.set({ kind: "chat", label: "chat", runIds: ["r1"], chatId: "c1" });
    timelineFilter.set({ limit: 5 } as never);
    timelineResults.set({ events: [{ id: "e", eventType: "x", timestamp: "t", runId: null, metadata: null } as never], total: 5, hasMore: true, nextCursor: "cursor-5" });
    timelineRefs.set([{ id: "r", chatId: "c1", eventId: "e", eventType: "x", timestamp: "t", metadata: null }] as never);
    currentTimelineChatId.set("c1");
    toolManifest.set([{ id: "t", name: "read", kind: "editor", category: "built-in", adapterId: "x", description: "" } as never]);
    enabledTools.set(["read"]);

    // ── Act ──
    resetAllStores();

    // ── Assert: every store is back to its initial/empty state ──
    // A store that is NOT cleared here means resetAllStores forgot it —
    // a cross-user data leak on the next login (-B1 class).
    expect(authState.get(), "authState must be reset (authenticated false)").toEqual(initialAuth);
    expect(projects.get(), "projects must be empty").toEqual([]);
    expect(currentProjectId.get(), "currentProjectId must be null").toBeNull();
    expect(chatsSnapshot(), "chats must be empty").toEqual([]);
    expect(currentChatId.get(), "currentChatId must be null").toBeNull();
    expect(messages.get(), "messages must be empty").toEqual([]);
    expect(isStreaming.get(), "isStreaming must be false").toBe(false);
    expect(autoChecks.get(), "autoChecks must be empty").toEqual([]);
    expect(autoChecksProjectId.get(), "autoChecksProjectId must be null").toBeNull();
    expect(autoChecksChatId.get(), "autoChecksChatId must be null").toBeNull();
    expect(configSnapshot.get(), "configSnapshot must be null").toBeNull();
    expect(errors.get(), "errors must be empty").toEqual([]);
    expect(memoryEntries.get(), "memoryEntries must be empty (cross-user memory leak)").toEqual([]);
    expect(metricsSnapshot.get(), "metricsSnapshot must be null").toBeNull();
    expect(systemMetrics.get(), "systemMetrics must be null").toBeNull();
    expect(tokenThroughput.get(), "tokenThroughput must be null").toBeNull();
    expect(metricsHistory.get(), "metricsHistory must be empty").toEqual([]);
    expect(modelsCatalog.get(), "modelsCatalog must be null").toBeNull();
    expect(selectedModelId.get(), "selectedModelId must be null").toBeNull();
    expect(qualitySnapshot.get(), "qualitySnapshot must be null (was missing a reset fn pre-)").toBeNull();
    expect(currentRun.get(), "currentRun must be null").toBeNull();
    expect(Object.keys(agents.get()).length, "agents map must be empty").toBe(0);
    expect(uiSchema.get(), "uiSchema must be null").toBeNull();
    expect(uiSchemaValues.get(), "uiSchemaValues must be null").toBeNull();
    expect(timelineScope.get().kind, "timelineScope must be global").toBe("global");
    expect(timelineFilter.get(), "timelineFilter must be empty").toEqual({});
    expect(timelineResults.get().total, "timelineResults must be empty (total 0)").toBe(0);
    expect(timelineRefs.get(), "timelineRefs must be empty").toEqual([]);
    expect(currentTimelineChatId.get(), "currentTimelineChatId must be null").toBeNull();
    expect(toolManifest.get(), "toolManifest must be empty").toEqual([]);
    expect(enabledTools.get(), "enabledTools must be empty").toEqual([]);
  });
});
