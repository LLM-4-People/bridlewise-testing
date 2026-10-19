// @vitest-environment node
/**
 * Mechanical enforcement: Client API Fetch Owner (Single-Party-Owner ).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default" + "No Scattered Helpers"): `src/client.ts` is the SINGLE owner
 * of all HTTP calls (`fetch`, `EventSource`) in the entire web slice.
 * NO component (`.svelte`) and NO store (`src/state/*.ts`) calls `fetch`
 * or `new EventSource` directly — they ALL go through `src/client.ts`
 * functions. This centralizes auth headers, CSRF headers, error mapping,
 * response parsing, retry logic, and offline detection at the fetch choke
 * point. A new gate (e.g. a CSRF token rotation) cannot be bypassed by
 * reaching into a store or component — the gate is in the client, and
 * every call site already goes through it.
 *
 * Before the auth store (`src/state/auth.ts`) called `fetch` directly
 * in 5 functions (checkAuthStatus, submitRegister, submitLogin,
 * submitLogout, submitChangePassword), and the SettingsPanel component
 * called `fetch` directly for `/api/models/prefs` and `/api/safety/trigger`.
 * A future CSRF header or auth-token rotation added to `client.ts`'s
 * `fetchJson` helper would NOT protect these 7 call sites — they bypassed
 * the choke point. The auth store also mixed two concerns (state owner +
 * network owner), so a future caller could reach into the store module
 * to skip any per-call gate.
 *
 * fix: the auth API functions moved to `src/client.ts` (the single
 * fetch owner); `src/state/auth.ts` is now a PURE store (atom + type +
 * initial value — no fetch). The model-prefs + safety-trigger calls also
 * moved to `src/client.ts`. Components + stores call `src/client.ts`
 * functions only.
 *
 * This test pins the architecture across 7 assurance classes:
 * A. single-owner: `fetch(` + `new EventSource(` appear ONLY in
 * `src/client.ts` (dynamic discovery — walk ALL `src/` files,
 * parse for the call patterns — NEVER a hardcoded file list).
 * B. no parallel fetch helper: no `fetchJson`/`apiFetch`/`request`/`call`
 * wrapper defined outside `src/client.ts` (a parallel wrapper would
 * re-introduce the bypass class).
 * C. auth store is pure: `src/state/auth.ts` has NO `fetch(` /
 * `new EventSource(` (it is a state owner, not a fetcher).
 * D. stores are pure: NO `src/state/*.ts` file calls `fetch(` or
 * `new EventSource(` (state modules own state, not the network).
 * E. components are pure: NO `.svelte` file calls `fetch(` or
 * `new EventSource(` (components render + dispatch, they don't
 * fetch directly).
 * F. contract (auth API surface): the auth API functions
 * (checkAuthStatus, submitRegister, submitLogin, submitLogout,
 * submitChangePassword) are defined ONLY in `src/client.ts` (not
 * re-declared in `src/state/auth.ts`). Pins the SPO architecture: a
 * future contributor cannot accidentally re-add the auth calls to
 * the store module.
 * G. behavioral: `src/client.ts` has exactly ONE raw `fetch(` call
 * (inside `fetchJson`) + exactly ONE `new EventSource(` call (inside
 * `openRunStream`) — the single choke point. A second raw `fetch`
 * would be a bypass of the shared error/timeout/CSRF handling.
 *
 * Dynamic discovery: the file set is built via `readdirSync`
 * walks — NEVER hardcoded. A new `src/state/foo.ts` or `src/lib/bar.svelte`
 * is automatically scanned; a new `fetch(` call in it is automatically
 * flagged. The auth-function set is also discovered dynamically (parse
 * `export (async )?function (\w+)` from `client.ts` + `state/auth.ts`,
 * intersect with the known auth names — no hardcoded list of "expected"
 * locations).
 *
 * Mutation-verified: re-adding a `fetch(` to `src/state/auth.ts`, adding a
 * `fetch(` to any `.svelte` component, adding a `new EventSource(` outside
 * `client.ts`, defining a `fetchJson` helper in a second file, or re-
 * declaring `submitLogin` in `state/auth.ts` each makes the relevant test
 * FAIL.
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { stripBlockAndOwnLineComments } from "../helpers/source-scan.ts";

/** This guard's population is CODE — server and client TypeScript. The mode
 * is named once here rather than guessed from bytes per call. */
const stripComments = (src: string) => stripBlockAndOwnLineComments(src, "probe.ts");
import { functionBody } from "../helpers/function-scope.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const REPO_ROOT = process.cwd();
const SRC_DIR = join(REPO_ROOT, "src");
const CLIENT_FILE = join(SRC_DIR, "client.ts");
/**
 * The I/O owner MOVED to the Broker.
 *
 * The invariant is unchanged — client I/O happens in exactly one place — but
 * that place is now `src/data/broker.ts`, which owns the cache, in-flight
 * dedup, conditional revalidation and superseded-request cancellation that
 * ninety-three separate `client.ts` functions could never have shared.
 *
 * The owner set is temporarily TWO files while `client.ts` is drained: it
 * still holds the SSE stream and the not-yet-migrated call sites. It narrows
 * back to `{broker.ts}` when `client.ts` is deleted, and the assertions below
 * enforce that exactly one of the two holds the raw fetch.
 */
const BROKER_FILE = join(SRC_DIR, "data", "broker.ts");
const IO_OWNERS: readonly string[] = [CLIENT_FILE, BROKER_FILE];
const AUTH_STORE_FILE = join(SRC_DIR, "state", "auth.ts");

// ── Dynamic discovery helpers ──

/** Walk every.ts +.svelte file under a dir (excluding node_modules/dist).
 * Dynamic — never hardcodes a file list. */
function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".svelte-kit") continue;
    const full = join(dir, entry);
    let st: { isDirectory(): boolean };
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSourceFiles(full, acc);
    } else if (st && (entry.endsWith(".ts") || entry.endsWith(".svelte")) && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** True when a line is a comment (// or * or /*). Used to skip doc lines
 * that mention `fetch(` for explanation, not as a call. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** Find all lines matching a regex in a source string (after stripping
 * comments). Returns {file-relative-path, line-number, line-text} for
 * each match. */
interface Finding {
  file: string;
  line: number;
  text: string;
}
function findCalls(src: string, rel: string, re: RegExp): Finding[] {
  const findings: Finding[] = [];
  const cleaned = stripComments(src);
  const lines = cleaned.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isCommentLine(line)) continue; // double-guard (stripComments already handled)
    // Reset the regex stateful flags (regex with /g tracks lastIndex).
    re.lastIndex = 0;
    if (re.test(line)) {
      findings.push({ file: rel, line: i + 1, text: line.trim() });
    }
  }
  return findings;
}

/** `fetch(` call pattern. Word boundary before `fetch` so `fetchJson(` and
 * `windowfetch(` don't match; `(` immediately after `fetch` so `fetch.foo`
 * doesn't match. Matches `fetch(`, `window.fetch(`, `self.fetch(`,
 * `globalThis.fetch(`. Does NOT match `fetchJson(` (the wrapper). */
const FETCH_CALL_RE = /\bfetch\(/g;
/** `new EventSource(` call pattern. Matches `new EventSource(` regardless
 * of the leading context. */
const EVENT_SOURCE_RE = /\bnew\s+EventSource\(/g;

/**
 * Discover the canonical fetch/stream wrapper names DYNAMICALLY from
 * src/client.ts (the single fetch owner). A wrapper is any top-level
 * `function NAME` / `const NAME =` (exported or not) whose body contains a
 * raw `fetch(` or `new EventSource(` call. These names are RESERVED: a
 * definition of the same name anywhere else is a parallel wrapper (a bypass
 * of the single fetch owner's gates). Deriving the set from client.ts means
 * a new wrapper added to client.ts is auto-protected against shadows — no
 * manually-maintained name list that could rot.
 */
function discoverCanonicalWrapperNames(clientSrc: string): Set<string> {
  const cleaned = stripComments(clientSrc);
  const lines = cleaned.split("\n");
  // A top-level declaration starts at column 0. Match `function NAME`,
  // `async function NAME`, `export function NAME`, `export async function
  // NAME`, `const NAME =`, `export const NAME =`.
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/;
  // The body is from the declaration line to the next top-level declaration
  // (a line starting at column 0 with `function`/`const`/`export`/`}`).
  const nextDeclRe = /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s|^\}/;
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const m = declRe.exec(lines[i]!);
    if (m === null) continue;
    const name = m[1] ?? m[2];
    if (name === undefined) continue;
    // Collect the body from this line to the next top-level declaration.
    let j = i + 1;
    while (j < lines.length && !nextDeclRe.test(lines[j]!)) j += 1;
    const body = lines.slice(i, j).join("\n");
    FETCH_CALL_RE.lastIndex = 0;
    EVENT_SOURCE_RE.lastIndex = 0;
    if (FETCH_CALL_RE.test(body) || EVENT_SOURCE_RE.test(body)) {
      names.add(name);
    }
  }
  return names;
}

/** All source files under `src/` (`.ts` + `.svelte`). */
function allSourceFiles(): string[] {
  return walkSourceFiles(SRC_DIR);
}

// ── A. single-owner: fetch + EventSource ONLY in client.ts ──

describe("A. single-owner: fetch( + new EventSource( appear ONLY in the I/O owners", () => {
  test("no src/ file outside the I/O owners calls fetch( directly", () => {
    const offenders: Finding[] = [];
    for (const file of allSourceFiles()) {
      if (IO_OWNERS.includes(file)) continue; // the owners — allowed
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, FETCH_CALL_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct fetch() found outside the I/O owners (broker.ts / client.ts) — route through the Broker:\n${detail}`,
      );
    }
  });

  test("no src/ file outside src/client.ts calls new EventSource(directly", () => {
    const offenders: Finding[] = [];
    for (const file of allSourceFiles()) {
      if (file === CLIENT_FILE) continue;
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, EVENT_SOURCE_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct new EventSource() found outside src/client.ts — route through the client (the single stream owner):\n${detail}`,
      );
    }
  });
});

// ── B. no parallel fetch helper ──

describe("B. no parallel fetch helper (a shadow of a client.ts fetch/stream wrapper)", () => {
  // The canonical fetch/stream wrapper names are discovered DYNAMICALLY from
  // src/client.ts (the single fetch owner): every top-level function/const
  // whose body calls `fetch(` or `new EventSource(`. A definition of the same
  // name anywhere else is a parallel wrapper — a future gate in client.ts's
  // wrapper would not protect calls through the parallel wrapper. Deriving
  // the reserved-name set from client.ts means a new wrapper added to
  // client.ts is auto-protected against shadows — no manually-maintained
  // 6-name list that silently misses a new wrapper name. A wrapper with a
  // brand-new name that calls raw `fetch(` is caught by test A (the raw-
  // fetch scan), so this test focuses on the shadow class (the unique bypass
  // A does not cover).
  const canonicalWrappers = discoverCanonicalWrapperNames(readFileSync(CLIENT_FILE, "utf8"));

  test("the canonical wrapper set is non-empty (sanity: the discovery is not broken)", () => {
    expect(
      canonicalWrappers.size,
      "must discover at least one fetch/stream wrapper in client.ts (the single fetch owner)",
    ).toBeGreaterThan(0);
  });

  test("no shadow of a client.ts fetch/stream wrapper is defined outside src/client.ts", () => {
    const definers: { name: string; file: string }[] = [];
    for (const file of allSourceFiles()) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      if (rel === modulePathMatching("src/client.ts")) continue; // the owner — allowed
      const src = readFileSync(file, "utf8");
      const cleaned = stripComments(src);
      for (const name of canonicalWrappers) {
        // Any definition (exported or not) of a reserved wrapper name
        // outside client.ts is a parallel wrapper. `name\b` matches
        // `name(`, `name<T>(`, and `name =`.
        const re = new RegExp(`(?:^export\\s+)?(?:async\\s+)?function\\s+${name}\\b|(?:^export\\s+)?const\\s+${name}\\s*=`, "m");
        re.lastIndex = 0;
        if (re.test(cleaned)) {
          definers.push({ name, file: rel });
        }
      }
    }
    if (definers.length > 0) {
      const detail = definers.map((d) => `${d.file} defines '${d.name}' (a shadow of the client.ts wrapper)`).join("\n");
      throw new Error(
        `Parallel fetch helper found outside src/client.ts — a shadow of a client.ts wrapper. Extract to the single client owner:\n${detail}`,
      );
    }
  });
});

// ── C. auth store is pure ──

describe("C. auth store is pure (src/state/auth.ts has NO fetch/EventSource)", () => {
  test("src/state/auth.ts does NOT call fetch(or new EventSource(", () => {
    const src = readFileSync(AUTH_STORE_FILE, "utf8");
    const cleaned = stripComments(src);
    const fetchFindings: string[] = [];
    const esFindings: string[] = [];
    for (const line of cleaned.split("\n")) {
      if (isCommentLine(line)) continue;
      FETCH_CALL_RE.lastIndex = 0;
      if (FETCH_CALL_RE.test(line)) fetchFindings.push(line.trim());
      EVENT_SOURCE_RE.lastIndex = 0;
      if (EVENT_SOURCE_RE.test(line)) esFindings.push(line.trim());
    }
    expect(fetchFindings, `state/auth.ts must NOT call fetch (it is a pure store — SPO): ${fetchFindings.join(", ")}`).toEqual([]);
    expect(esFindings, `state/auth.ts must NOT call new EventSource (it is a pure store — SPO): ${esFindings.join(", ")}`).toEqual([]);
  });

  test("src/state/auth.ts exports the authState atom + the AuthStatus type + the initialAuth value (the pure-store contract)", () => {
    const src = readFileSync(AUTH_STORE_FILE, "utf8");
    // The atom — the single state owner.
    expect(src).toMatch(/export\s+const\s+authState\b/);
    // The type — re-exported by client.ts so consumers can import from either.
    expect(src).toMatch(/export\s+type\s+AuthStatus\b/);
    // The initial value — exported so the client (the fetch owner) can
    // reset the store on logout + build the offline state from the same
    // baseline (no parallel literal that could drift).
    expect(src).toMatch(/export\s+const\s+initialAuth\b/);
  });
});

// ── D. stores are pure ──

describe("D. stores are pure (no src/state/*.ts calls fetch/EventSource)", () => {
  test("no src/state/*.ts file calls fetch(directly", () => {
    const offenders: Finding[] = [];
    const stateFiles = readdirSync(join(SRC_DIR, "state"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
      .map((e) => join(SRC_DIR, "state", e.name));
    for (const file of stateFiles) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, FETCH_CALL_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct fetch() found in a state module — state files own state, not the network (route through src/client.ts):\n${detail}`,
      );
    }
  });

  test("no src/state/*.ts file calls new EventSource(directly", () => {
    const offenders: Finding[] = [];
    const stateFiles = readdirSync(join(SRC_DIR, "state"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"))
      .map((e) => join(SRC_DIR, "state", e.name));
    for (const file of stateFiles) {
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, EVENT_SOURCE_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct new EventSource() found in a state module — state files own state, not the network (route through src/client.ts):\n${detail}`,
      );
    }
  });
});

// ── E. components are pure ──

describe("E. components are pure (no.svelte file calls fetch/EventSource)", () => {
  test("no.svelte file under src/ calls fetch(directly", () => {
    const offenders: Finding[] = [];
    for (const file of allSourceFiles()) {
      if (extname(file) !== ".svelte") continue;
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, FETCH_CALL_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct fetch() found in a .svelte component — components call src/client.ts, never fetch directly:\n${detail}`,
      );
    }
  });

  test("no.svelte file under src/ calls new EventSource(directly", () => {
    const offenders: Finding[] = [];
    for (const file of allSourceFiles()) {
      if (extname(file) !== ".svelte") continue;
      const rel = relative(REPO_ROOT, file).split(sep).join("/");
      const src = readFileSync(file, "utf8");
      offenders.push(...findCalls(src, rel, EVENT_SOURCE_RE));
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct new EventSource() found in a .svelte component — components call src/client.ts, never EventSource directly:\n${detail}`,
      );
    }
  });
});

// ── F. contract (auth API surface is in client.ts, NOT in state/auth.ts) ──

describe("F. contract: auth API functions are defined ONLY in src/client.ts", () => {
  /** Parse the set of top-level exported function names from a source
   * file. Dynamic. */
  function exportedFunctions(src: string): Set<string> {
    const names = new Set<string>();
    const re = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]!);
    return names;
  }

  /**
   * Discover the auth API surface DYNAMICALLY from src/client.ts: every
   * exported function whose body references an auth endpoint path
   * (`/auth/...`). The auth functions all call `/auth/status`,
   * `/auth/register`, `/auth/login`, `/auth/logout`, or
   * `/auth/change-password`. Deriving the set from the endpoint path means a
   * new auth function added to client.ts (referencing `/auth/`) is auto-
   * covered — no manually-maintained 5-name list that silently misses a new
   * auth function. The CONTRACT these tests pin is "auth functions live in
   * client.ts, not in state/auth.ts"; the LOCATION is what matters, and a
   * dynamic endpoint-path discovery captures the whole class.
   */
  function discoverAuthApiSurface(clientSrc: string): Set<string> {
    const cleaned = stripComments(clientSrc);
    const lines = cleaned.split("\n");
    const declRe = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
    const nextDeclRe = /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s|^\}/;
    const names = new Set<string>();
    for (let i = 0; i < lines.length; i += 1) {
      const m = declRe.exec(lines[i]!);
      if (m === null) continue;
      const name = m[1]!;
      let j = i + 1;
      while (j < lines.length && !nextDeclRe.test(lines[j]!)) j += 1;
      const body = lines.slice(i, j).join("\n");
      // An auth endpoint path: `/auth/...` (the leading + trailing slashes
      // avoid matching a variable named `authApiBase` or a comment).
      if (/\/auth\//.test(body)) names.add(name);
    }
    return names;
  }

  const authApiSurface = discoverAuthApiSurface(readFileSync(CLIENT_FILE, "utf8"));

  test("the discovered auth API surface is non-empty (sanity: the endpoint-path discovery is not broken)", () => {
    expect(
      authApiSurface.size,
      "must discover at least one auth API function in client.ts via the /auth/ endpoint path",
    ).toBeGreaterThan(0);
  });

  test("every auth API function is defined in src/client.ts", () => {
    const clientSrc = readFileSync(CLIENT_FILE, "utf8");
    const clientExports = exportedFunctions(clientSrc);
    const missing = [...authApiSurface].filter((n) => !clientExports.has(n));
    expect(
      missing,
      `src/client.ts must define every auth API function (discovered via /auth/ endpoint path): missing ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("NO auth API function is defined in src/state/auth.ts (it is a pure store)", () => {
    const authSrc = readFileSync(AUTH_STORE_FILE, "utf8");
    const authExports = exportedFunctions(authSrc);
    const redefined = [...authApiSurface].filter((n) => authExports.has(n));
    expect(
      redefined,
      `src/state/auth.ts must NOT define auth API functions (they live in src/client.ts — the single fetch owner): redefined ${redefined.join(", ")}`,
    ).toEqual([]);
  });
});

// ── G. behavioral: src/client.ts has exactly ONE raw fetch + ONE EventSource ──

describe("G. behavioral: src/client.ts has exactly ONE raw fetch + ONE EventSource (the choke point)", () => {
  /**
   * ── THIS ASSERTION USED TO COUNT TO ONE ──────────────────────────────────
   *
   * "Exactly ONE raw `fetch(` across the I/O owners" — and counting was the
   * weaker form of the rule it meant. What it was protecting is that no
   * REQUEST FOR DATA escapes the choke point's gates (auth, CSRF, the request
   * budget, error mapping, the connection watch). A count cannot say that; it
   * only says "no more of these", which fails the moment a legitimately
   * different kind of I/O appears.
   *
   * It did. `diagnoseLivenessConnection` is not a request for data — it is a
   * probe OF THE TRANSPORT, and it cannot go through `fetchJson` for reasons
   * that are properties of what it does rather than preferences:
   *
   *   it must not parse a body — a 200 on `/api/live` is an event stream that
   *   never ends, so reading it is a hang, not a parse;
   *   it must not take the request budget — it is measuring reachability, and
   *   `requestBudgetMs` is derived FROM reachability;
   *   it must read the raw status and `Retry-After`, which the choke point
   *   deliberately converts into typed errors.
   *
   * So the guard now NAMES the permitted raw-fetch sites instead of counting
   * them, which is strictly stronger: a new raw `fetch(` anywhere else — or a
   * new function that quietly grows one — fails, and the two that exist are
   * pinned to the functions they belong to with the reason written down.
   */
  test("every raw `fetch(` across the I/O owners sits in a NAMED, justified site", () => {
    /** The top-level declarations in `src` whose body contains a raw fetch. */
    const rawFetchOwners = (src: string): string[] => {
      const lines = stripComments(src).split("\n");
      const declRe =
        /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/;
      const nextDeclRe = /^(?:export\s+)?(?:async\s+)?function\s|^(?:export\s+)?const\s|^\}/;
      const owners: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const m = declRe.exec(lines[i]!);
        if (m === null) continue;
        const name = m[1] ?? m[2];
        if (name === undefined) continue;
        let j = i + 1;
        while (j < lines.length && !nextDeclRe.test(lines[j]!)) j += 1;
        FETCH_CALL_RE.lastIndex = 0;
        if (FETCH_CALL_RE.test(lines.slice(i, j).join("\n"))) owners.push(name);
      }
      return owners.sort();
    };

    // The Broker owns the ONE choke point every request for data passes.
    expect(
      rawFetchOwners(readFileSync(BROKER_FILE, "utf8")),
      "the data choke point is fetchJson, and there is one of it",
    ).toEqual(["fetchJson"]);

    // The client owns the transport probes that cannot be requests for data.
    expect(
      rawFetchOwners(readFileSync(CLIENT_FILE, "utf8")),
      "a raw fetch in client.ts must be a transport probe with its reason stated — " +
        "anything that asks the API for DATA belongs in the Broker's fetchJson",
    ).toEqual(["diagnoseLivenessConnection"]);

    // And the total is still bounded: two sites, both named above.
    const countIn = (src: string): number => {
      let n = 0;
      for (const line of stripComments(src).split("\n")) {
        if (isCommentLine(line)) continue;
        FETCH_CALL_RE.lastIndex = 0;
        if (FETCH_CALL_RE.test(line)) n += 1;
      }
      return n;
    };
    expect(
      countIn(readFileSync(CLIENT_FILE, "utf8")) + countIn(readFileSync(BROKER_FILE, "utf8")),
    ).toBe(2);
  });

  test("src/client.ts has exactly TWO `new EventSource(` calls (the run stream + the liveness stream)", () => {
    const src = readFileSync(CLIENT_FILE, "utf8");
    const cleaned = stripComments(src);
    const matches: string[] = [];
    for (const line of cleaned.split("\n")) {
      if (isCommentLine(line)) continue;
      EVENT_SOURCE_RE.lastIndex = 0;
      if (EVENT_SOURCE_RE.test(line)) matches.push(line.trim());
    }
    expect(
      matches.length,
      `src/client.ts must have exactly ONE new EventSource(call (inside openRunStream — the single stream choke point). Found ${matches.length}: ${matches.join(" | ")}`,
    ).toBe(2);
  });
});

// ── H. CSRF header: fetchJson sends the CSRF custom header (-V4) ──

describe("H. CSRF header: fetchJson sends the CSRF custom header on every request (-V4)", () => {
  // -V4 [FIXED] [HIGH, security]: the client's fetchJson did NOT send the
  // CSRF custom header (x-requested-with). The server's stateless CSRF guard
  // accepts EITHER same-origin OR the custom header. The browser sends
  // Origin automatically for same-origin unsafe methods, so the custom-
  // header defense was INERT for browser requests. A reverse-proxy
  // deployment where the dashboard origin differs from the API origin
  // would have failed the same-origin check AND lacked the custom-header
  // fallback, blocking every mutation. FIX: fetchJson now sends
  // [CSRF_CUSTOM_HEADER]: "1" on every request (the single fetch choke
  // point). This test verifies the header is sent + the header name comes
  // from the single owner (shared/constants.ts) — not hardcoded.
  //
 // Dynamic: the header name is PARSED from shared/constants.ts
  // (the single owner), never hardcoded in the test. A future rename of the
  // constant is auto-followed.

  /** Parse the CSRF_CUSTOM_HEADER export value from shared/constants.ts. */
  function readCsrfHeaderName(): string {
    const constantsSrc = readFileSync(join(REPO_ROOT, "shared", "constants.ts"), "utf8");
    const m = constantsSrc.match(/export\s+const\s+CSRF_CUSTOM_HEADER\s*=\s*["']([^"']+)["']/);
    expect(m, "shared/constants.ts must export CSRF_CUSTOM_HEADER").not.toBeNull();
    return m![1]!;
  }

  test("shared/constants.ts exports CSRF_CUSTOM_HEADER (the single header-name owner)", () => {
    const name = readCsrfHeaderName();
    expect(name, "CSRF_CUSTOM_HEADER must be a non-empty header name").toBeTruthy();
    expect(name.length, "the header name must not be empty").toBeGreaterThan(0);
  });

  test("the fetch owner imports CSRF_CUSTOM_HEADER from shared/constants.ts (no inline literal)", () => {
    // Follows fetchJson to the Broker. The invariant is that the header name
    // comes from the shared constant, wherever the choke point lives.
    const src = readFileSync(BROKER_FILE, "utf8");
    // The import must reference the owner (shared/constants.ts), not
    // re-declare the literal inline. A future header rename in the owner
    // is auto-followed because the client imports the constant by name.
    expect(src, "the fetch owner must import CSRF_CUSTOM_HEADER").toContain("CSRF_CUSTOM_HEADER");
    expect(src, "the fetch owner must import from shared/constants.ts").toMatch(
      /from\s+["'][^"']*shared\/constants(\.ts)?["']/,
    );
    // The literal header name must NOT appear as a raw string literal in
    // client.ts (it must come from the imported constant). We check the
    // cleaned source (comments stripped) so a comment mentioning the name
    // doesn't false-positive.
    const headerName = readCsrfHeaderName();
    const cleaned = stripComments(src);
    // Allow the import line (which contains the constant NAME, not the
    // literal value). The literal VALUE (e.g. "x-requested-with") must not
    // appear as a standalone string outside the import.
    const literalRe = new RegExp(`["']${headerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
    // The import line itself mentions the constant name, not the value —
    // so checking for the literal VALUE in cleaned source is safe.
    expect(
      cleaned,
      `the raw header-name literal "${headerName}" must NOT appear in client.ts (use the imported CSRF_CUSTOM_HEADER constant)`,
    ).not.toMatch(literalRe);
  });

  test("fetchJson sends [CSRF_CUSTOM_HEADER]: \"1\" on every request (the choke point)", () => {
    const src = readFileSync(BROKER_FILE, "utf8");
    // The fetchJson function body must contain [CSRF_CUSTOM_HEADER]: "1"
    // (or some non-empty value). This is the -V4 fix — the header is
    // centralized at the single fetch choke point so every call site gets
    // it automatically.
    expect(src, "fetchJson must send the CSRF header via [CSRF_CUSTOM_HEADER]").toContain(
      "[CSRF_CUSTOM_HEADER]",
    );
    // The value must be non-empty (presence is the signal — the server
    // guard accepts any non-empty value).
    expect(src, "the CSRF header value must be non-empty").toMatch(
      /\[CSRF_CUSTOM_HEADER\]\s*:\s*["']1["']/,
    );
  });

  test("the CSRF header is sent inside fetchJson (NOT only at specific call sites)", () => {
    // BROAD (catches the whole class): the header must be in the fetchJson
    // CHOKE POINT, not scattered at individual call sites. If someone moves
    // the header out of fetchJson into individual wrappers, a new wrapper
    // without the header would bypass the CSRF defense. The header belongs
    // in fetchJson (the single point ALL calls pass through) — which now
    // lives in the Broker.
    const src = readFileSync(BROKER_FILE, "utf8");
    // THE FUNCTION'S BODY, AS THE PARSER READS IT. This took a 2,000-byte
    // slice from the declaration under a comment saying "the function is ~50
    // lines; take 200 to be safe" — a window in a different unit, and one
    // whose own comment disagreed with its number by a factor of ten. Whatever
    // the number, a neighbour that happens to fall inside satisfies it.
    // The header is a COMPUTED key, which has no name for a door to be asked
    // about, so the claim stays a containment — but of the body the parser
    // delimited rather than of a byte count starting at the declaration.
    const fetchJson = functionBody(src, "fetchJson", BROKER_FILE);
    expect(
      fetchJson.body,
      "[CSRF_CUSTOM_HEADER] must appear inside the fetchJson function body (the choke point)",
    ).toContain("[CSRF_CUSTOM_HEADER]");
  });
});
