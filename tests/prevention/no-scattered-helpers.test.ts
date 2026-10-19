// @vitest-environment node
/**
 * Mechanical enforcement: the "No Scattered Helpers" principle ( —
 * "Shared logic MUST live in ONE place, not be duplicated across files. If a
 * helper function appears in MORE than one file, it's a violation. Extract
 * it to the single owner module + reuse.").
 *
 * this test scans the ENTIRE `server/` source tree for
 * top-level function/const definitions and FAILS when the same name is
 * DEFINED in 2+ files. A scattered helper is a copy-pasted reusable
 * function (e.g. the prior `sendError` in routes/config.ts AND
 * routes/models.ts, `notFound` in routes/auto-checks.ts AND chats.ts,
 * `gitText` in git-bridge.ts AND git-ops-bridge.ts, `post` in 3 worker
 * files). The fix is to extract it to ONE owner module + import it
 * everywhere — never to redefine the same name.
 *
 * Scope rules (deliberate — avoid false positives):
 * TOP-LEVEL only: a definition at column 0 (optionally `export`/`async`
 * prefixed). A NESTED closure (e.g. an indented `function walk(dir,
 * depth)` inside `buildTree`) is a LOCAL implementation detail, NOT a
 * scattered helper — it is not reachable from other files, so the name
 * reuse is coincidental, not a duplication. This is what distinguishes
 * a real scattered helper (a reusable top-level function copy-pasted
 * across files) from a nested helper that just shares a common name.
 * Function declarations AND top-level arrow consts (`const name = (` /
 * `const name = async (`) — both define a callable at module scope.
 * Class methods are NOT matched (they're not `function name(` at column
 * 0), so DbClient methods + worker class methods don't false-positive.
 * IMPORTS are not definitions — reusing an imported name is the GOAL,
 * not a violation.
 *
 * Mutation-verified: re-introducing a duplicate (e.g. defining `gitText`
 * in a second file) makes this test FAIL.
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const SERVER_ROOT = join(process.cwd(), "server");
const SRC_ROOT = join(process.cwd(), "src");

/** Recursively list every `.ts` file under `server/` (excludes `.d.ts`). */
function listServerTsFiles(): string[] {
  return walk(SERVER_ROOT, { exts: [".ts"] }).filter((f) => !f.endsWith(".d.ts"));
}

/**
 * Recursively list every `.ts` file under `src/` (excludes `.d.ts` AND
 * `.svelte` — Svelte component `<script>` functions are LOCAL to the
 * component, not scattered reusable helpers; they're indented inside the
 * `<script>` block so the column-0 anchor already excludes them, but we
 * also skip `.svelte` outright to avoid parsing markup as code).
 */
function listSrcTsFiles(): string[] {
  return walk(SRC_ROOT, { exts: [".ts"] }).filter((f) => !f.endsWith(".d.ts"));
}

// Top-level function declaration: line starts with optional `export `/`async `
// then `function name(`. The `^` (no leading whitespace) anchors to column 0
// so NESTED functions (indented inside another function body) are excluded —
// they are local implementation details, not scattered reusable helpers.
const TOP_LEVEL_FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
// Top-level arrow const: line starts with optional `export ` then
// `const|let name = (` or `= async (`. Captures the callable's name.
const TOP_LEVEL_ARROW_RE = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/gm;

/** Collect the set of top-level callable names DEFINED in a source file. */
function topLevelCallables(src: string): Set<string> {
  const names = new Set<string>();
  function collect(re: RegExp): void {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) names.add(m[1]!);
  }
  //.exec with /g tracks lastIndex; reset before each file.
  TOP_LEVEL_FN_RE.lastIndex = 0;
  TOP_LEVEL_ARROW_RE.lastIndex = 0;
  collect(TOP_LEVEL_FN_RE);
  collect(TOP_LEVEL_ARROW_RE);
  return names;
}

describe("No scattered helpers (shared logic lives in one place)", () => {
  // Build name → Set<file> across the whole server tree ONCE.
  const defMap = new Map<string, Set<string>>();
  for (const file of listServerTsFiles()) {
    const src = readFileSync(file, "utf8");
    for (const name of topLevelCallables(src)) {
      let set = defMap.get(name);
      if (set === undefined) {
        set = new Set();
        defMap.set(name, set);
      }
      set.add(relative(SERVER_ROOT, file));
    }
  }
  const duplicates = [...defMap.entries()]
    .filter(([, files]) => files.size >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));

  test("no top-level function/const is DEFINED in more than one file (zero tolerance)", () => {
    if (duplicates.length > 0) {
      const lines = duplicates.map(
        ([name, files]) =>
          `  ${name}  →  ${[...files].join(", ")}`,
      );
      throw new Error(
        `Scattered helpers — these top-level callables are defined in 2+ files ` +
          `(extract each to ONE owner module + import it; "No Scattered Helpers"):\n` +
          lines.join("\n"),
      );
    }
    expect(duplicates).toHaveLength(0);
  });

  test("the specific consolidations hold (regression guard)", () => {
    // These were the flagged duplicates; pin that they stay consolidated.
    expect(defMap.get("sendError") ?? new Set()).toHaveProperty("size", 0);
    expect(defMap.get("notFound") ?? new Set()).toHaveProperty("size", 0);
    // gitText now has ONE definition (git-bridge.ts) + is imported elsewhere.
    expect(defMap.get("gitText")?.size ?? 0).toBe(1);
    // post (the worker IPC helper) is gone — replaced by postWorkerResult.
    expect(defMap.get("post") ?? new Set()).toHaveProperty("size", 0);
    expect(defMap.get("postWorkerResult")?.size ?? 0).toBe(1);
    // countLines (string variant) stays in editor-bridge; file-tree's was
    // renamed to countFileLines so the names no longer collide.
    expect((defMap.get("countLines")?.size ?? 0) <= 1).toBe(true);
    expect((defMap.get("countFileLines")?.size ?? 0) <= 1).toBe(true);
  });

  test("mutation: re-introducing a top-level duplicate makes the test FAIL", () => {
    // THE PLANT IS A FILE THIS TEST CREATES, NOT A FILE THE REPOSITORY OWNS.
    //
    // This used to append to `server/worker-ipc.ts` and restore it in a
    // `finally` — and so did `git-bridge-owner.test.ts`, on the SAME path,
    // in a parallel fork. `writeFileSync` truncates before it writes, so a
    // `readFileSync` landing in that window returns "" and the `finally`
    // then restores nothing. Measured: the file was left at ZERO BYTES by a
    // suite run, and it was noticed only because ten other tests import it.
    // A mutation harness must not write to state another run can touch, and
    // a tracked source file is the most shared state in the repository.
    //
    // The scan's universe is a file LIST, so the plant is injected there.
    const canaryPath = join(createTempDir("scattered-helpers-canary-"), "planted-canary.ts");
    const duplicateName = "gitText"; // a real consolidated name
    writeFileSync(
      canaryPath,
      "function gitText(_a: string, _b: readonly string[]): string | null { return null; }\n",
    );
    const names = topLevelCallables(readFileSync(canaryPath, "utf8"));
    expect(names.has(duplicateName)).toBe(true);
    // The full-tree scan, WITH the plant in its population, now reports
    // gitText in 2 files — where the live tree reports exactly 1.
    const withPlant = new Set<string>();
    const live = new Set<string>();
    for (const file of [...listServerTsFiles(), canaryPath]) {
      if (!topLevelCallables(readFileSync(file, "utf8")).has(duplicateName)) continue;
      withPlant.add(relative(SERVER_ROOT, file));
      if (file !== canaryPath) live.add(relative(SERVER_ROOT, file));
    }
    expect(withPlant.size).toBeGreaterThanOrEqual(2);
    // THE CONTROL: the mutation changed an answer. Without it, the count is
    // the one the assertion above this describe already asserts.
    expect(live.size).toBe(1);
  });
});

describe("No ad-hoc error formatting in routes (error mapping is centralized in the router)", () => {
  // broader enforcement: the scattered-helper principle also bans
  // the inline `sendJson(res, { error, message }, STATUS)` error idiom
  // duplicated across route files — routes THROW typed errors and the
  // router's statusForError + errorBody produce the body. The ONE
  // intentional exception is the timeline event-detail 404, whose body
  // carries `{ error, eventId }` (a client contract pinned by a test) and
  // is therefore kept inline. Every other route must not format its own
  // error response.
  const ROUTES_DIR = join(SERVER_ROOT, "routes");
  const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));

  test("no route writes an error response with res.writeHead (the router owns response headers + error bodies)", () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (/\bres\.writeHead\s*\(/.test(src) || /\bctx\.res\.writeHead\s*\(/.test(src)) {
        throw new Error(
          `${file} calls res.writeHead directly — error responses must be a thrown typed ` +
            `error (the router maps it); response headers are owned by the router ` +
            `("No Scattered Helpers": error mapping has one owner).`,
        );
      }
    }
  });

  test("the inline `sendJson(res, { error:... }, STATUS)` idiom is gone except the timeline event-detail contract", () => {
    for (const file of routeFiles) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      // Match `sendJson(<res>, { error:... }, <status>)`. Allow the ONE
      // timeline event-detail line whose body is `{ error: "not_found", eventId }`.
      const matches = [...src.matchAll(/sendJson\([^,]+,\s*\{\s*error:\s*[^}]+\}\s*,\s*\d+\s*\)/g)];
      for (const m of matches) {
        const line = m[0];
        if (/eventId/.test(line) && file === "timeline.ts") continue; // the documented contract
        throw new Error(
          `${file} formats an error response inline (\`${line}\`) — throw a typed error ` +
            `(NotFoundError/ForbiddenError/BadRequestError/...) and let the router map it ` +
            `("No Scattered Helpers": error mapping has one owner).`,
        );
      }
    }
  });
});

// ── cross-cutting extensions (src/ name scan, readFileSync-utf8
// ban, format-functions-no-parallel, auth-cookie consolidation). ──

describe("No scattered helpers — frontend (src/,.ts only; Svelte locals excluded)", () => {
  // The server-only scan (above) catches server↔server duplicates. This
  // block catches src↔src duplicates — the same reusable-helper collision
  // on the frontend. Server↔src name overlaps are INTENTIONAL (the two
  // sides of a wire may share a name by design — a client wrapper calling
  // its server bridge namesake), so they are NOT scanned here; only
  // src↔src collisions are a scattered-helper concern.
  const defMap = new Map<string, Set<string>>();
  for (const file of listSrcTsFiles()) {
    const src = readFileSync(file, "utf8");
    for (const name of topLevelCallables(src)) {
      let set = defMap.get(name);
      if (set === undefined) {
        set = new Set();
        defMap.set(name, set);
      }
      set.add(relative(SRC_ROOT, file));
    }
  }
  const duplicates = [...defMap.entries()]
    .filter(([, files]) => files.size >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));

  test("no top-level function/const is DEFINED in more than one src/ file (zero tolerance)", () => {
    if (duplicates.length > 0) {
      const lines = duplicates.map(
        ([name, files]) => `  ${name}  →  ${[...files].join(", ")}`,
      );
      throw new Error(
        `Scattered helpers (frontend) — these top-level callables are defined in 2+ src/ files ` +
          `(extract each to ONE owner module + import it; "No Scattered Helpers"):\n` +
          lines.join("\n"),
      );
    }
    expect(duplicates).toHaveLength(0);
  });
});

describe("No scattered readFileSync(path, \"utf8\") outside the file-read utility", () => {
  // "Lowest-Level Enforcement": UTF-8 encoding is a cross-cutting
  // concern with ONE owner (`server/file-read.ts::readFileText`). A text
  // read that re-declares `readFileSync(path, "utf8")` re-introduces the
  // encoding decision at a call site (forgetting `"utf8"` silently reads a
  // Buffer / mojibake). The mechanical test bans the utf8 literal form
  // outside the utility. Binary reads (`readFileSync(path)` with NO
  // encoding — e.g. the DB key in db-crypto.ts) are NOT matched (they
  // correctly need a Buffer); only the utf8 STRING form is banned.
  const FILE_READ_OWNER = "filesystem/file-read.ts";
  // Matches `readFileSync(<args>, "utf8")` / `'utf8'` / `"utf-8"` / `'utf-8'`,
  // allowing the path + encoding to span lines (lazy across the call).
  const UTF8_READ_RE = /readFileSync\(\s*[^,)]*,\s*["']utf-?8["']\s*\)/;

  test("no server.ts file (except file-read.ts) reads with readFileSync(..., 'utf8')", () => {
    const offenders: string[] = [];
    for (const file of listServerTsFiles()) {
      const rel = relative(SERVER_ROOT, file);
      if (rel === FILE_READ_OWNER) continue; // the single owner — allowed
      const src = readFileSync(file, "utf8");
      if (UTF8_READ_RE.test(src)) offenders.push(rel);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Scattered readFileSync(..., "utf8") — these files read text with a raw utf8 ` +
          `readFileSync instead of the shared readFileText owner ("Lowest-Level ` +
          `Enforcement"; server/file-read.ts is the single owner):\n  ` +
          offenders.join("\n  "),
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("the file-read utility owns UTF-8 and preserves ordinary string reads", () => {
    const ownerPath = join(SERVER_ROOT, FILE_READ_OWNER);
    const src = readFileSync(ownerPath, "utf8");
    // The utility exists + exports readFileText.
    expect(src).toMatch(/export\s+function\s+readFileText\s*\(/);
    // It wraps readFileSync WITH "utf8" (the ONE place the encoding is decided).
    expect(src).toMatch(/readFileSync\([^,)]*,\s*["']utf8["']\)/);
  });
});

// (The format-owner class died with src/lib/shared/format.ts — the cockpit
// owns its own formatters, and no surviving code consumed that file.)

describe("Auth-cookie Set-Cookie is owned by the auth owner", () => {
  // The auth-cookie Set-Cookie operations (setAuthCookie, clearAuthCookie)
  // must live in ONE module: `server/auth.ts` (the auth owner). A route must
  // NOT build a Set-Cookie value for the auth cookie — it imports + calls
  // the owner. This pins the consolidation (the prior route-local
  // setAuthCookie/clearAuthCookie were a scattered response-header concern).
  test("setAuthCookie + clearAuthCookie are defined ONLY in server/auth.ts (not in routes)", () => {
    const AUTH_PATH = join(SERVER_ROOT, "auth/auth.ts");
    const authSrc = readFileSync(AUTH_PATH, "utf8");
    expect(authSrc).toMatch(/export\s+function\s+setAuthCookie\s*\(/);
    expect(authSrc).toMatch(/export\s+function\s+clearAuthCookie\s*\(/);

    const ROUTES_DIR = join(SERVER_ROOT, "routes");
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      // A route must NOT define its own setAuthCookie/clearAuthCookie (it
      // imports them). `function setAuthCookie` / `function clearAuthCookie`
      // at column 0 = a local definition = a violation.
      if (/^function\s+setAuthCookie\s*\(/m.test(src) || /^function\s+clearAuthCookie\s*\(/m.test(src)) {
        throw new Error(
          `${file} defines its own setAuthCookie/clearAuthCookie — the auth-cookie Set-Cookie ` +
            `must be owned by server/auth.ts (the auth owner), not the route. Import + call it ` +
            `("No Scattered Helpers": response headers have one owner per domain).`,
        );
      }
    }
  });

  test("no route builds an auth-cookie Set-Cookie value inline (appendHeader('Set-Cookie', harness_auth...))", () => {
    const ROUTES_DIR = join(SERVER_ROOT, "routes");
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(ROUTES_DIR, file), "utf8");
      // A route must not construct `harness_auth=...` Set-Cookie inline —
      // that bypasses the auth owner. (The owner uses AUTH_COOKIE_NAME.)
      if (/harness_auth\s*=/.test(src) && /Set-Cookie/.test(src)) {
        throw new Error(
          `${file} builds an auth-cookie Set-Cookie inline — use setAuthCookie/clearAuthCookie ` +
            `from server/auth.ts (the auth owner). "No Scattered Helpers".`,
        );
      }
    }
  });
});

describe("Cookie reading has ONE owner (no second parse loop)", () => {
  // (No Scattered Helpers + Session/cookie
  // management: ONE owner module handles all cookie/session operations).
  // Before this fix, `readCookie` (session.ts, private) and `readAuthCookie`
  // (user-context.ts, exported) each re-implemented the SAME
  // `req.headers.cookie.split(";")` parse loop — a near-duplicate with
  // different names that the name-based scan + the exact-body scan both
  // missed. The fix: `readCookie` is the single exported cookie reader
  // (session.ts); `readAuthCookie` is a thin delegate. This test pins both
  // the consolidation (deny-by-default: a second direct cookie-header reader
  // anywhere in server/ fails the test) and the delegation (readAuthCookie
  // does not re-implement the loop).

  test("exactly ONE server file reads req.headers.cookie directly (the single cookie-reader owner)", () => {
    // Dynamic discovery: scan EVERY server .ts file (no hardcoded list) for
    // a direct `req.headers.cookie` / `headers.cookie` read. The single
    // owner is server/session.ts (readCookie). A second file with a direct
    // read is a scattered cookie parser.
    const readers: string[] = [];
    for (const file of listServerTsFiles()) {
      const src = readFileSync(file, "utf8");
      // Match a direct cookie-header read: `req.headers.cookie` or
      // `<x>.headers.cookie`. Excludes the string `"headers.cookie"` in
      // comments (the scan reads raw source; a comment mentioning the
      // pattern would false-positive, so strip comments first).
      const stripped = stripCommentsForScan(src);
      if (/\b\w+\.headers\.cookie\b/.test(stripped)) {
        readers.push(relative(SERVER_ROOT, file));
      }
    }
    // Exactly one owner. If a future module reads the cookie header
    // directly (instead of calling readCookie), this fails.
    expect(readers).toHaveLength(1);
    expect(readers[0]).toBe("auth/session.ts");
  });

  test("readAuthCookie delegates to readCookie (no second parse loop in user-context.ts)", () => {
    const ctxSrc = readFileSync(join(SERVER_ROOT, "auth/user-context.ts"), "utf8");
    // Must import readCookie from the session owner.
    expect(ctxSrc).toMatch(/import\s+\{[^}]*\breadCookie\b[^}]*\}\s+from\s+["']\.\/session\.ts["']/);
    // The readAuthCookie body must be a thin delegate (return readCookie(...)),
    // NOT a re-implemented parse loop (no split(";") inside it).
    const fnMatch = ctxSrc.match(/export\s+function\s+readAuthCookie\s*\([\s\S]*?\}\s*\n/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/readCookie\s*\(/);
    expect(body).not.toMatch(/\.split\(\s*["'];["']\s*\)/);
  });

  test("readCookie is exported from session.ts (the single cookie-reader owner)", () => {
    const sessionSrc = readFileSync(join(SERVER_ROOT, "auth/session.ts"), "utf8");
    expect(sessionSrc).toMatch(/export\s+function\s+readCookie\s*\(/);
  });

  test("the rotation-marker cookie name is a named constant (no magic string)", () => {
    // The `harness_session_created` cookie name is used at a read site +
    // a Set-Cookie site. It MUST be a named constant (SESSION_CREATED_COOKIE_NAME)
    // so the two sites cannot drift on the name (DRY — the same pattern as
    // SESSION_COOKIE_NAME). Deny-by-default: the bare literal must not
    // appear as a value (only inside the const declaration + the doc comment).
    const sessionSrc = readFileSync(join(SERVER_ROOT, "auth/session.ts"), "utf8");
    expect(sessionSrc).toMatch(/export\s+const\s+SESSION_CREATED_COOKIE_NAME\s*=\s*["']harness_session_created["']/);
    // The read + Set-Cookie sites must use the constant, not the literal.
    // (Allow the literal only in the const declaration + comments.)
    const stripped = stripCommentsForScan(sessionSrc)
      .replace(/export\s+const\s+SESSION_CREATED_COOKIE_NAME\s*=\s*["']harness_session_created["']/, "");
    expect(stripped).not.toMatch(/["']harness_session_created["']/);
    // The template `${SESSION_CREATED_COOKIE_NAME}=...` must be used for the Set-Cookie.
    expect(sessionSrc).toMatch(/\$\{SESSION_CREATED_COOKIE_NAME\}/);
    // The read must use the constant.
    expect(sessionSrc).toMatch(/readCookie\(\s*req,\s*SESSION_CREATED_COOKIE_NAME\s*\)/);
  });
});

describe("Set-Cookie mechanism is consistent (appendHeader, never setHeader)", () => {
  // (No Scattered Helpers: response headers have
  // one owner per domain; the Set-Cookie MECHANISM must be consistent so
  // call order cannot drop a cookie). The auth owner (auth.ts) uses
  // `appendHeader` for Set-Cookie; the session owner (session.ts) MUST
  // also use `appendHeader` (not `setHeader`, which REPLACES any prior
  // Set-Cookie and would drop the auth cookie if the call order ever
  // changed). A login response carries both the session cookie AND the
  // auth cookie — `appendHeader` for both ensures neither overwrites the
  // other regardless of order.
  test("session.ts uses appendHeader for Set-Cookie (not setHeader, which could overwrite the auth cookie)", () => {
    const sessionSrc = readFileSync(join(SERVER_ROOT, "auth/session.ts"), "utf8");
    // The session cookie must be set via appendHeader.
    expect(sessionSrc).toMatch(/res\.appendHeader\(\s*["']Set-Cookie["']/);
    // setHeader("Set-Cookie", ...) would REPLACE any prior Set-Cookie —
    // banned (a future call-order change would silently drop the auth
    // cookie on login). Deny-by-default: no setHeader for Set-Cookie.
    expect(sessionSrc).not.toMatch(/res\.setHeader\(\s*["']Set-Cookie["']/);
  });

  test("auth.ts uses appendHeader for Set-Cookie (consistent with session.ts)", () => {
    const authSrc = readFileSync(join(SERVER_ROOT, "auth/auth.ts"), "utf8");
    expect(authSrc).toMatch(/res\.appendHeader\(\s*["']Set-Cookie["']/);
    expect(authSrc).not.toMatch(/res\.setHeader\(\s*["']Set-Cookie["']/);
  });
});

/** Strip line + block comments for the cookie-reader scan (so a comment
 * mentioning `headers.cookie` does not false-positive). Keeps strings so
 * the regex still sees real reads. */
function stripCommentsForScan(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const cl = src.indexOf("*/", i + 2);
      i = cl === -1 ? src.length : cl + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
