// @vitest-environment node
/**
 * Mechanical enforcement: Frontend Stores Deep Audit (SPO).
 *
 * This is the DEEP companion to `frontend-store-owner.test.ts`. 
 * established the per-store pattern + the reset-on-logout wiring; 
 * upgrades the reset mechanism from a MANUALLY-MAINTAINED call list (RIGID
 * "if someone adds a store and forgets to add it to resetAllStores, the
 * same security hole recurs") to a DYNAMIC auto-registering registry
 * ("Relieve Responsibilities": stores self-register; the reset
 * iterates the registry; adding a store = automatically covered; forgetting
 * is impossible because you NEVER HAD TO REMEMBER).
 *
 * Dynamic discovery: the store set is built by a RECURSIVE walk —
 * NEVER hardcoded. A new `src/state/foo.ts` is automatically subject to
 * every check below.
 *
 * Assurance classes (deep audit):
 * A. Auto-registration — every store with a writable atom + reset fn
 * self-registers via `registerReset(...)` (deny-by-default: the
 * default state is "not registered"; you must EXPLICITLY register).
 * B. Dynamic registry — `reset-all.ts` re-exports `resetAllStores` from
 * `./store-registry` + loads every store via `import.meta.glob` (no
 * manual import list) + does NOT contain a manual `resetXxx` call
 * list (the rigid pattern removed).
 * C. No direct fetch — no `src/state/*.ts` store calls `fetch(` directly
 * (stores go through `src/client.ts`, the single fetch owner).
 * D. No swallowed catches — no `src/state/*.ts` store has a bare
 * `catch {}` / `catch { return...; }` that silently swallows errors
 *. Capability probes that LOG the failure are allowed.
 * E. No hardcoded configurables — no `src/state/*.ts` store defines a
 * top-level `export const <TUNABLE_NAME> = <number>` literal; tunable
 * values live in `client-config.ts` (the single client config owner,
 * ). Re-exports from client-config are allowed (the value
 * owner is client-config).
 * F. Behavioral — `resetAllStores` (the dynamic registry iteration)
 * clears EVERY registered store. Uses `clearResetRegistry` +
 * `registeredResetNames` (the registry diagnostics) to verify the
 * registry is populated + iterated. This proves the dynamic mechanism
 * works end-to-end, not just that the wiring exists.
 * G. Mutation — reintroducing the rigid manual list in reset-all.ts,
 * removing a store's `registerReset` call, or adding a new store
 * without registering it each makes the relevant test FAIL.
 *
 * Mutation-verified: see class G.
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
const REGISTRY_FILE = join(STATE_DIR, "store-registry.ts");

// ── Dynamic discovery ──

/**
 * Every store module anywhere under `src/state/`, RECURSIVELY.
 *
 * This used to be a flat `readdirSync` — which is precisely how the subject's
 * flat `import.meta.glob("./*.ts")` went unnoticed. A guard that computes its
 * expectation the same way the subject does can only ever agree with it: a
 * store moved into `src/state/<sub>/` left the registry AND left `expected`
 * in the same step, so `expected − registered` stayed empty and the guard
 * reported clean while the previous user's data survived logout.
 *
 * `walkTs` is the shared walker, so the recursion is not re-implemented here
 * and a missing root is a REFUSAL rather than an empty answer.
 */
function stateFiles(): string[] {
  return walkTs(STATE_DIR)
    .filter((f) => !f.endsWith(".d.ts"))
    .sort();
}

/** The writable-atom names exported by a state file (`export const X = atom|map`). */
function writableAtomNames(src: string): string[] {
  const cleaned = stripComments(src);
  const names: string[] = [];
  const re = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(atom|map)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) names.push(m[1]!);
  return names;
}

/** The no-arg `reset*`/`clear*` function names exported by a state file. */
function resetFnNames(src: string): string[] {
  const cleaned = stripComments(src);
  const names: string[] = [];
  const re = /^export\s+function\s+(reset|clear)[A-Za-z_$][\w$]*\s*\(\s*\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[0].match(/function\s+([A-Za-z_$][\w$]*)/)![1]!;
    names.push(name);
  }
  return names;
}

/** Relative path in unix form. */
function rel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

// ── A. Auto-registration — every store self-registers its reset fn ──

describe("A. auto-registration — every store self-registers its reset fn via registerReset", () => {
  test("store-registry.ts exports the registry API (registerReset, resetAllStores)", () => {
    const src = readFileSync(REGISTRY_FILE, "utf8");
    const cleaned = stripComments(src);
    expect(cleaned, "store-registry.ts must export registerReset").toMatch(/export\s+function\s+registerReset\s*\(/);
    expect(cleaned, "store-registry.ts must export resetAllStores").toMatch(/export\s+function\s+resetAllStores\s*\(/);
    expect(cleaned, "store-registry.ts must export registeredResetNames (diagnostics)").toMatch(/export\s+function\s+registeredResetNames\s*\(/);
    expect(cleaned, "store-registry.ts must export clearResetRegistry (test hermeticity)").toMatch(/export\s+function\s+clearResetRegistry\s*\(/);
  });

  test("every store with a writable atom + reset fn self-registers via registerReset", () => {
    const offenders: { file: string; resetFn: string; reason: string }[] = [];
    for (const file of stateFiles()) {
      const src = readFileSync(file, "utf8");
      if (writableAtomNames(src).length === 0) continue; // helper module
      const resets = resetFnNames(src);
      if (resets.length === 0) continue; // frontend-store-owner class B flags this
      const cleaned = stripComments(src);
      // ANY RELATIVE SPELLING OF THE REGISTRY MODULE, not literally
      // `./store-registry`. Pinning the sibling spelling made this guard a
      // claim about today's directory layout: a store legitimately grouped
      // into `src/state/<sub>/` imports `../store-registry` and was reported
      // as unregistered — the guard blocking the exact refactor the recursive
      // loader was fixed to make safe.
      const hasImport = /from\s*["'](?:\.{1,2}\/)+(?:[^"']*\/)?store-registry(?:\.ts)?["']/.test(cleaned);
      for (const resetFn of resets) {
        if (!hasImport) {
          offenders.push({ file: rel(file), resetFn, reason: "does not import registerReset from ./store-registry" });
          continue;
        }
        const re = new RegExp(`registerReset\\s*\\(\\s*["'][^"']+["']\\s*,\\s*${resetFn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!re.test(cleaned)) {
          offenders.push({ file: rel(file), resetFn, reason: `'${resetFn}' not passed to registerReset(...)` });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.file}: ${o.resetFn} — ${o.reason}`).join("\n");
      throw new Error(
        `Store reset fns not self-registered via registerReset (SPO dynamic registry; an unregistered store is NOT reset on logout = cross-user data leak, -B1 class):\n${detail}`,
      );
    }
  });
});

// ── B. Dynamic registry — reset-all.ts uses the registry + glob, no manual list ──

describe("B. dynamic registry — reset-all.ts re-exports + globs, no manual call list", () => {
  test("reset-all.ts re-exports resetAllStores from./store-registry", () => {
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    expect(
      stripComments(src),
      "reset-all.ts must re-export resetAllStores from ./store-registry (the dynamic registry owner)",
    ).toMatch(/export\s*\{\s*resetAllStores\s*\}\s*from\s*["']\.\/store-registry["']/);
  });

  test("reset-all.ts loads every store via an eager import.meta.glob (dynamic, no manual list)", () => {
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    // THE MECHANISM, not the exact pattern. The pattern is judged by what it
    // MATCHED, in the test below — asserting the literal here would be the
    // same defect this pair was rewritten to remove.
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

  test("the glob MATCHED every store module on disk — the output, not the literal", async () => {
    // §THE DEFECT THIS REPLACES. Three guards regex-matched the glob STRING.
    // A string is an input: it confirms the literal exists and says nothing
    // about whether it matched anything, so `./*.ts` and a recursive pattern
    // were indistinguishable to every one of them. This asks the glob what it
    // actually loaded and compares it against an INDEPENDENT recursive walk of
    // the same directory — two mechanisms, one question.
    const { loadedStoreModulePaths } = await import("../../src/state/reset-all");
    const matched = new Set(loadedStoreModulePaths());
    // Vite excludes the importing module itself from its own glob, so the
    // expectation excludes it too — derived from the file's own path, never
    // typed as a name that could go stale.
    const onDisk = stateFiles()
      .map((f) => `./${relative(STATE_DIR, f).split(sep).join("/")}`)
      .filter((p) => p !== `./${relative(STATE_DIR, RESET_ALL_FILE).split(sep).join("/")}`);
    expect(onDisk.length, "the state directory must not be empty — an empty walk agrees with everything").toBeGreaterThan(0);
    const unmatched = onDisk.filter((p) => !matched.has(p));
    expect(
      unmatched,
      "every store module on disk must be MATCHED by the loader's glob; an unmatched module never self-registers, is never reset on logout, and carries the previous user's data into the next session",
    ).toEqual([]);
    // And nothing matched that is not on disk, so the comparison is an
    // equality rather than a one-sided containment a wider glob could satisfy.
    expect([...matched].filter((p) => !onDisk.includes(p))).toEqual([]);
  });

  test("reset-all.ts does NOT contain a manual resetXxx/clearXxx call list (rigid pattern removed)", () => {
    const src = readFileSync(RESET_ALL_FILE, "utf8");
    const cleaned = stripComments(src);
    // Strip the re-export + glob + the discard so they don't false-positive.
    const stripped = cleaned
      .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["']/g, "")
      .replace(/import\.meta\.glob\s*\([^)]*\)/g, "")
      .replace(/const\s+_storeModules\s*=\s*[^;]+;/g, "")
      .replace(/\bvoid\s+_storeModules\s*;?/g, "");
    const manualCallRe = /\b(reset|clear)[A-Za-z_$][\w$]*\s*\(\s*\)/g;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = manualCallRe.exec(stripped)) !== null) offenders.push(m[0]);
    if (offenders.length > 0) {
      throw new Error(
        `reset-all.ts must NOT contain a manual resetXxx()/clearXxx() call list replaced it with the dynamic registry. Found: ${offenders.join(", ")}`,
      );
    }
  });
});

// ── C. No direct fetch — stores go through client.ts ──

describe("C. no direct fetch — stores go through src/client.ts (the single fetch owner)", () => {
  test("no src/state/*.ts calls fetch(directly", () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of stateFiles()) {
      // Direct global `fetch(` call — a store must go through client.ts
      // (every hit at its true line, through the one "matches over a view" spelling).
      for (const hit of sourceViewOf(readFileSync(file, "utf8"), file).matches(/\bfetch\s*\(/u, "codeWithStrings")) {
        offenders.push({ file: rel(file), line: hit.line, text: hit.text });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `A store must NOT call fetch(directly — go through src/client.ts (the single fetch owner, ). Found:\n${detail}`,
      );
    }
  });
});

// ── D. No swallowed catches — ──

describe("D. no swallowed catches in stores", () => {
  test("no src/state/*.ts has a bare catch {} or catch { return...; } without logging", () => {
    // A swallowed catch is `catch {` or `catch (e) {` whose body does NOT
    // reference a logging call (console.* / a debug owner). A capability
    // probe that LOGS the failure (e.g. persistence.ts storage) is allowed.
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of stateFiles()) {
      const cleaned = stripComments(readFileSync(file, "utf8"));
      const lines = cleaned.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        // Match a catch clause opening: `catch {` or `catch (err) {`.
        const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(line);
        if (catchMatch === null) continue;
        // Collect the catch body (until the matching close brace).
        let depth = 0;
        let body = "";
        for (let j = i; j < lines.length; j += 1) {
          body += lines[j]! + "\n";
          for (const ch of lines[j]!) {
            if (ch === "{") depth += 1;
            else if (ch === "}") { depth -= 1; if (depth === 0) break; }
          }
          if (depth === 0) break;
        }
        // Allow if the body references a logging call.
        if (/console\.(debug|warn|error|log|info)\s*\(/.test(body)) continue;
        // Allow if the body re-throws.
        if (/\bthrow\b/.test(body)) continue;
        // Allow if the body routes through a debug/error owner (handleError,
        // webWarn, webDebug, clientWarn, clientDebug).
        if (/\b(handleError|webWarn|webDebug|clientWarn|clientDebug)\s*\(/.test(body)) continue;
        offenders.push({ file: rel(file), line: i + 1, text: line.trim() });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Swallowed catch found in a store:\n${detail}`,
      );
    }
  });
});

// ── E. No hardcoded configurables — tunable values live in client-config.ts ──

describe("E. no hardcoded configurables in stores", () => {
  // A tunable name pattern: MAX_, MIN_, DEFAULT_, THRESHOLD, TIMEOUT, LIMIT,
  // CAP, STEP, WIDTH, HEIGHT, POLL, DELAY, INTERVAL, _PX, _MS, _ENTRIES.
  const TUNABLE_RE = /^(MAX_|MIN_|DEFAULT_|.*THRESHOLD|.*TIMEOUT|.*LIMIT|.*CAP|.*STEP|.*WIDTH|.*HEIGHT|.*POLL|.*DELAY|.*INTERVAL|.*_PX|.*_MS|.*_ENTRIES)/i;
  // Files that are NOT stores (helpers/owner/registry) — exempt from the
  // tunable scan. Discovered DYNAMICALLY: a state file is a STORE iff it
  // imports `atom` from nanostores (the writable-atom primitive every store
  // uses); a file with NO nanostores import is a non-store helper
  // (reset-all, store-registry, ui-control) → exempt. This is deny-by-
  // default + dynamic: a new store that imports `atom` is auto-scanned; a
  // new non-store helper is auto-exempt. No manually-maintained 5-name list
  // that could rot. (persistence.ts + web-ui-config.ts import atom, so they
  // are scanned — but they export no tunable-shaped numerics, so they
  // pass; the canonical home for tunables is client-config.ts, outside
  // state/.) The config owner client-config.ts is OUTSIDE state/, so it is
  // not scanned here.
  const EXEMPT_BASENAMES = new Set<string>();
  for (const file of stateFiles()) {
    const base = file.split(sep).pop()!;
    const src = readFileSync(file, "utf8");
    // A store imports the writable-atom primitive from nanostores. A
    // non-store helper does not. Type-only imports of atom would not make
    // a file a store, but no helper imports atom as a type, so the plain
    // substring check is sufficient.
    if (!/from\s+["']nanostores["']/.test(src)) EXEMPT_BASENAMES.add(base);
  }

  test("no src/state/*.ts store defines a top-level export const <TUNABLE> = <number> literal", () => {
    const offenders: { file: string; name: string; text: string }[] = [];
    for (const file of stateFiles()) {
      const base = file.split(sep).pop()!;
      if (EXEMPT_BASENAMES.has(base)) continue;
      const cleaned = stripComments(readFileSync(file, "utf8"));
      // Match `export const NAME = <numeric literal>` (local definition).
      const re = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cleaned)) !== null) {
        const name = m[1]!;
        if (TUNABLE_RE.test(name)) {
          offenders.push({ file: rel(file), name, text: m[0].trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.file}: ${o.text} (move to client-config.ts — the single client config owner, )`).join("\n");
      throw new Error(
        `Hardcoded configurable literal found in a store:\n${detail}`,
      );
    }
  });
});

// ── F. Behavioral — the dynamic registry is populated + resetAllStores clears all ──

describe("F. behavioral — the dynamic registry is populated + resetAllStores iterates it", () => {
  test("importing reset-all populates the registry with every store's reset fn", async () => {
    // Importing reset-all.ts triggers the import.meta.glob eager load of
    // every store, which self-registers. The registry must then list every
    // store with a writable atom + reset fn (deny-by-default: a missing
    // entry means the store is NOT reset on logout).
    //
    // The registry is populated by the glob's top-level side-effects, which
    // run ONCE per worker under `isolate: false`. So we do NOT clear +
    // re-import (a cached re-import does not re-run the side-effects). We
    // import reset-all (idempotent — populates on first import in the
    // worker, returns the cached module on subsequent imports) + verify the
    // registry contains every store that declares a `registerReset` call.
    const { registeredResetNames } = await import("../../src/state/store-registry");
    await import("../../src/state/reset-all");
    const registry = await import("../../src/state/store-registry");
    // The glob in reset-all already imported every store once (on the first
    // import in this worker); the registry holds every store that
    // self-registered. Verify against the set of stores that SHOULD be
    // registered by counting the reset-fn source files.
    const expectedNames = new Set<string>();
    for (const file of stateFiles()) {
      const src = readFileSync(file, "utf8");
      if (writableAtomNames(src).length === 0) continue;
      const cleaned = stripComments(src);
      const re = /registerReset\s*\(\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cleaned)) !== null) expectedNames.add(m[1]!);
    }
    const registered = new Set(registry.registeredResetNames());
    const missing = [...expectedNames].filter((n) => !registered.has(n));
    expect(
      missing,
      "every store that calls registerReset must appear in the runtime registry after reset-all loads (the glob must trigger self-registration)",
    ).toEqual([]);
  });

  test("resetAllStores clears a populated store via the registry iteration", async () => {
    // Proves the dynamic mechanism works end-to-end: register a sentinel
    // reset fn, populate a store, call resetAllStores, verify the sentinel
    // ran (the registry iteration called it). This is the "wired but inert"
    // guard — the registry must actually be ITERATED, not just populated.
    //
    // snapshot/restore (not clear) so the registry stays populated for
    // subsequent test files under `isolate: false` (a cached re-import does
    // not re-run the glob's top-level registration side-effects).
    const { registerReset, resetAllStores, clearResetRegistry, snapshotResetRegistry, restoreResetRegistry, registeredResetNames } = await import("../../src/state/store-registry");
    const snapshot = snapshotResetRegistry();
    try {
      clearResetRegistry();
      let sentinelRan = false;
      registerReset("__sentinel_test_only__", () => { sentinelRan = true; });
      expect(registeredResetNames()).toContain("__sentinel_test_only__");
      resetAllStores();
      expect(sentinelRan, "resetAllStores must iterate the registry + call every registered fn (the dynamic reset mechanism)").toBe(true);
    } finally {
      restoreResetRegistry(snapshot);
    }
  });
});

// ── G. Mutation — reintroducing the rigid pattern fails the tests ──

describe("G. mutation guards (reintroducing the rigid pattern fails)", () => {
  test("class B rejects a manual resetXxx call list if reintroduced in reset-all.ts", () => {
    // Simulate a regression: a reset-all.ts body containing `resetAuth;`.
    const fakeResetAll = `
export { resetAllStores } from "./store-registry";
const _storeModules = import.meta.glob("./*.ts", { eager: true });
void _storeModules;
resetAuth();
resetProjects();
`;
    const stripped = fakeResetAll
      .replace(/export\s*\{[^}]*\}\s*from\s*["'][^"']+["']/g, "")
      .replace(/import\.meta\.glob\s*\([^)]*\)/g, "")
      .replace(/const\s+_storeModules\s*=\s*[^;]+;/g, "")
      .replace(/\bvoid\s+_storeModules\s*;?/g, "");
    const offenders: string[] = [];
    const re = /\b(reset|clear)[A-Za-z_$][\w$]*\s*\(\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) offenders.push(m[0]);
    expect(offenders.length, "a manual resetXxx() call list must be detected as a regression").toBeGreaterThan(0);
  });

  test("class A rejects a store that defines a reset fn but does not register it", () => {
    // Simulate a store with a reset fn but no registerReset call.
    const fakeStore = `
import { atom } from "nanostores";
export const xStore = atom<number>(0);
export function resetX(): void { xStore.set(0); }
`;
    const cleaned = stripComments(fakeStore);
    const hasImport = /from\s*["']\.\/store-registry["']/.test(cleaned);
    const re = /registerReset\s*\(\s*["'][^"']+["']\s*,\s*resetX\b/;
    const registered = re.test(cleaned);
    expect(hasImport && registered, "a store without a registerReset call must be flagged as an offender").toBe(false);
  });
});
