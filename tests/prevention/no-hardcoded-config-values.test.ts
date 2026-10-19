// @vitest-environment node
/**
 * Mechanical enforcement: no hardcoded configurable values outside the
 * config owners.
 *
 * The existing `no-hardcoded-values.test.ts` flags inline `Math.max/min`
 * thresholds; `centralized-config.test.ts` flags scattered `process.env`
 * reads. This test GENERALIZES to other configurable-shaped literals that
 * must live in the single config owner, not scattered inline:
 *
 * 1. Named-constant magic numbers — `const FOO_MS = 60_000`,
 * `const MAX_X = 1_048_576`, `const TIMEOUT = 5000`. A SCREAMING_SNAKE
 * or camelCase const assigned a bare integer literal with 4+ digits
 * (>= 1000) is a timeout / limit / threshold / TTL / cost parameter
 * that belongs in config (or the safety-invariants carve-out).
 * 2. Hardcoded URL literals — `https://api.example.com` style endpoint
 * literals outside the config owner (a configurable the operator must
 * be able to repoint). URL-PARSING helpers (`new URL(x, \`http://${host}\`)`)
 * and the loopback fallback are NOT flagged — they construct a URL from
 * the request, not a configurable endpoint.
 *
 * Owners allowed to declare these literals (the single sources of
 * truth + the safety-invariants carve-out). A file becomes an owner
 * EXPLICITLY by declaring the `@config-owner` JSDoc marker in its top
 * doc block (deny-by-default + explicit-add — the same pattern as the
 * `@global-store` marker in the context-switch-reset test). The test
 * discovers the owner set DYNAMICALLY by scanning for the marker, so a
 * new owner file MUST declare the marker (a forgotten marker = the file
 * is flagged, not silently exempted). No manually-maintained owner list
 * that could rot.
 *
 * Literals < 1000 are NOT flagged (they are degenerate unit counts /
 * small bounds — 8, 32, 256 — not tunable thresholds). Expressions
 * (`256 * 1024`) are NOT flagged (the bare-literal regex matches only a
 * single integer RHS). Comment lines are stripped.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { walk, stripCommentsOnly as stripComments } from "../helpers/source-scan.ts";
import { gitSpawnAccessors, importsGitBridgeAccessor } from "../helpers/git-spawn-owner.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const ROOTS = ["src", "server"] as const;
const CONTRACTS_ROOT = "shared";

// All executable script extensions. A future `.mjs`/`.cjs`/`.js` module
// with a magic number must be flagged — the scan covers every extension,
// not just `.ts`/`.svelte` (deny-by-default: a new file type cannot bypass
// the config owner).
const SOURCE_EXTS = [".ts", ".svelte", ".mjs", ".cjs", ".js"] as const;

/**
 * Discover the set of owner files DYNAMICALLY by scanning for the
 * `@config-owner` JSDoc marker. A file is a config owner iff its raw
 * (pre-comment-strip) source contains the marker. Deny-by-default: a
 * file without the marker is NOT an owner, so its configurable-shaped
 * literals are flagged. Explicit-add: a new owner file declares the
 * marker and is auto-recognized — no manual list to maintain.
 */
function discoverConfigOwners(roots: readonly string[]): Set<string> {
  const owners = new Set<string>();
  for (const root of roots) {
    for (const file of walk(root, { exts: [...SOURCE_EXTS] })) {
      const rel = relative(process.cwd(), file).split(sep).join("/");
      const raw = readFileSync(file, "utf8");
      if (raw.includes("@config-owner")) owners.add(rel);
    }
  }
  return owners;
}

const ALLOWED_OWNERS = discoverConfigOwners([...ROOTS, CONTRACTS_ROOT]);

/**
 * A named const/let/var assigned a bare integer literal with 4+ digits (>= 1000).
 * Matches `const FOO = 60_000`, `let FOO_BAR = 1_048_576`, `export const
 * Foo = 5000`, `var FOO = 5000` (all declaration forms). Underscore
 * separators in numeric literals are allowed. Does NOT match expressions
 * (`= 256 * 1024`) — the RHS must be a single bare number.
 */
const NAMED_CONST_MAGIC_RE =
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*([0-9][0-9_]{3,})\s*[;,\n]/;

/**
 * A hardcoded URL endpoint literal: `https://` or `http://` followed by a
 * domain (not a `${...}` interpolation, not the loopback-only parsing
 * fallback). Matches `https://api.example.com`, `http://10.0.0.1:8080`.
 * Does NOT match `\`http://${...}\`` (interpolated — used for URL parsing).
 */
const URL_LITERAL_RE = /["'`](?:https?:\/\/)([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[0-9]{1,3}(?:\.[0-9]{1,3}){3}:\d+)/;

/** Whether a source line is a URL-PARSING helper (a `new URL(..., \`http://${...}\`)`
 * construction — NOT a configurable endpoint). These are exempt. */
function isUrlParsingHelper(line: string): boolean {
  return line.includes("new URL(") && line.includes("${");
}

describe("config-owner discovery (dynamic via @config-owner marker, deny-by-default)", () => {
  test("the marker scan discovers a non-empty owner set (sanity: a broken scan does not silently exempt everything)", () => {
    expect(
      ALLOWED_OWNERS.size,
      "must discover config owners via the @config-owner marker (found none — the marker scan is broken)",
    ).toBeGreaterThan(0);
  });

  test("the canonical server config owners declare @config-owner (anchor: catches a broken marker scan)", () => {
    // The two canonical server owners are the structural config sources
    // referenced in the enforcement error messages. If the marker scan
    // broke (e.g. the marker tag was renamed), these would be missing and
    // every other file would be wrongly flagged. This anchor catches that.
    expect(ALLOWED_OWNERS.has(modulePathMatching("server/kernel/config.ts")), "server/config.ts must declare @config-owner").toBe(true);
    expect(ALLOWED_OWNERS.has(modulePath("harness-config.ts")), "server/harness-config.ts must declare @config-owner").toBe(true);
    expect(ALLOWED_OWNERS.has(modulePath("safety-invariants.ts")), "server/safety-invariants.ts must declare @config-owner").toBe(true);
  });
});

describe("no hardcoded configurable values outside the config owners", () => {
  const namedConstFindings: { file: string; line: number; text: string }[] = [];
  const urlFindings: { file: string; line: number; text: string }[] = [];

  for (const root of ROOTS) {
    for (const file of walk(root, { exts: [...SOURCE_EXTS] })) {
      const rel = relative(process.cwd(), file);
      const isOwner = ALLOWED_OWNERS.has(rel);
      const raw = readFileSync(file, "utf8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        // Named-constant magic number (>= 1000).
        if (!isOwner) {
          const m = NAMED_CONST_MAGIC_RE.exec(line.trim());
          if (m) {
            namedConstFindings.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
        // Hardcoded URL endpoint literal — SERVER-side only. The client
        // (src/) has no configurable server endpoints; UI placeholder text
        // (e.g. `placeholder="https://api.example.com"`) is NOT a config
        // endpoint. URL-parsing helpers are exempt.
        if (rel.startsWith("server/") && !isOwner && !isUrlParsingHelper(line)) {
          const u = URL_LITERAL_RE.exec(line);
          if (u) {
            urlFindings.push({ file: rel, line: i + 1, text: line.trim() });
          }
        }
      }
    }
  }

  test("no named-const magic numbers (>= 1000) outside config/safety-invariants owners", () => {
    if (namedConstFindings.length > 0) {
      const detail = namedConstFindings
        .map((f) => `  ${f.file}:${f.line}  ${f.text}`)
        .join("\n");
      throw new Error(
        `Hardcoded configurable constants outside the config owners — ` +
          `move into server/config.ts (operational tunables), server/harness-config.ts ` +
          `(harness-config knobs), or server/safety-invariants.ts (security invariants):\n${detail}`,
      );
    }
  });

  test("no hardcoded URL endpoint literals outside the config owner", () => {
    if (urlFindings.length > 0) {
      const detail = urlFindings
        .map((f) => `  ${f.file}:${f.line}  ${f.text}`)
        .join("\n");
      throw new Error(
        "Hardcoded URL endpoint literals outside server/config.ts — " +
          "move the endpoint into config (DEFAULT_*/env override). URL-parsing " +
          "helpers (new URL(x, http://${...})) are exempt:\n" + detail,
      );
    }
  });

  test("the SCRYPT_N safety invariant lives in safety-invariants.ts (the safety carve-out), not auth.ts", () => {
    const inv = readFileSync(modulePath("safety-invariants.ts"), "utf8");
    expect(inv).toContain("SCRYPT_N");
    expect(inv).toContain("16384");
    // auth.ts must IMPORT it (not redeclare the literal).
    const auth = readFileSync(modulePathMatching("server/auth/auth.ts"), "utf8");
    expect(auth).toContain('from "../safety/safety-invariants.ts"');
    expect(auth).toContain("SCRYPT_N");
    // The literal 16384 must NOT be redeclared in auth.ts.
    expect(auth).not.toMatch(/^const SCRYPT_N\s*=\s*16384/);
  });

  test("ALL scrypt safety invariants live in safety-invariants.ts (the security floor has ONE owner)", () => {
    // The entire scrypt security floor — N (cost), r (memory bandwidth),
    // p (parallelization), keylen (key length), saltlen (salt length), and
    // TOKEN_BYTES (session-token entropy) — must live in the safety owner
    // (safety-invariants.ts). Lowering ANY of them weakens auth, so they are
    // safety invariants, not configurables. A prior split (N in
    // safety-invariants.ts; r/p/keylen/saltlen/tokenBytes in auth.ts) was an
    // incomplete consolidation. This pins the full set in ONE owner so a
    // future re-split is caught. auth.ts imports them (never redeclares).
    const inv = readFileSync(modulePath("safety-invariants.ts"), "utf8");
    const auth = readFileSync(modulePathMatching("server/auth/auth.ts"), "utf8");
    const params = ["SCRYPT_N", "SCRYPT_R", "SCRYPT_P", "SCRYPT_KEYLEN", "SCRYPT_SALT_LEN", "TOKEN_BYTES"];
    for (const name of params) {
      expect(inv, `${name} must be defined in safety-invariants.ts`).toMatch(
        new RegExp(`export\\s+const\\s+${name}\\s*=`),
      );
      expect(auth, `${name} must be imported by auth.ts`).toMatch(
        new RegExp(`\\b${name}\\b`),
      );
      // auth.ts must NOT redeclare the const (it imports it).
      expect(auth, `${name} must not be redeclared in auth.ts`).not.toMatch(
        new RegExp(`^const\\s+${name}\\s*=`, "m"),
      );
    }
    // The OWASP minimum literal values are pinned in the safety owner.
    expect(inv).toContain("16384"); // SCRYPT_N
    expect(inv).toContain("SCRYPT_R = 8");
    expect(inv).toContain("SCRYPT_P = 1");
    expect(inv).toContain("SCRYPT_KEYLEN = 32");
    expect(inv).toContain("SCRYPT_SALT_LEN = 16");
    expect(inv).toContain("TOKEN_BYTES = 32");
  });

  test("the DUMMY_PASSWORD_HASH login-timing constant lives in the auth owner (server/auth.ts), not the route", () => {
    // The login-timing-equality dummy hash is an auth-operation constant
    // (Single-Party-Owner: auth constants live in the auth owner). It must
    // be exported from server/auth.ts + imported by the route, not
    // redefined in routes/auth.ts (a scattered security constant).
    const auth = readFileSync(modulePathMatching("server/auth/auth.ts"), "utf8");
    expect(auth).toMatch(/export\s+const\s+DUMMY_PASSWORD_HASH\s*=/);
    const route = readFileSync(modulePathMatching("server/routes/auth.ts"), "utf8");
    expect(route).toMatch(/import\s+\{[^}]*\bDUMMY_PASSWORD_HASH\b[^}]*\}\s+from\s+["']\.\.\/auth\/auth\.ts["']/);
    // The route must NOT redefine the constant.
    expect(route).not.toMatch(/^const\s+DUMMY_PASSWORD_HASH\s*=/m);
    expect(route).not.toMatch(/^const\s+DUMMY_HASH\s*=/m);
  });

  test("the duplicate GIT_TIMEOUT_MS (5_000 vs 10_000) is unified into serverConfig.gitTimeoutMs", () => {
    // Neither git-bridge.ts nor git-ops-bridge.ts declares its own constant.
    const gb = readFileSync(modulePath("git-bridge.ts"), "utf8");
    const gob = readFileSync(modulePath("git-ops-bridge.ts"), "utf8");
    expect(gb).not.toMatch(/const GIT_TIMEOUT_MS\s*=/);
    expect(gob).not.toMatch(/const GIT_TIMEOUT_MS\s*=/);
    // (No Scattered Helpers): git-bridge.ts is the SINGLE owner
    // of the git-spawn helper (`gitText`, exported) — it references the
    // config-owned timeout. git-ops-bridge.ts imports `gitText` (along
    // with `isGitRepo` since ) and no longer owns the timeout — the
    // timeout owner is git-bridge.ts (via gitText), NOT git-ops-bridge.
    // git-ops-bridge now reads serverConfig for the git-LOG cap/
    // default (gitMaxLogEntries/gitLogDefaultEntries), which is a
    // config value it consumes — NOT the timeout, which stays in
    // git-bridge via gitText.
    expect(gb).toContain("serverConfig.gitTimeoutMs");
    // KEYED TO THE CLAIM, NOT TO A NAME. This asserted that git-bridge
    // exports `gitText` and that git-ops-bridge imports `gitText` — and both
    // died the moment the readers moved onto the refusal-aware accessor,
    // which is exactly the change this codebase wanted. What the timeout
    // ownership actually rests on is that git-ops-bridge reaches git THROUGH
    // the bridge at all, whichever accessor it uses.
    const accessors = gitSpawnAccessors(gb);
    expect(accessors.length, `git-bridge exposes no way to make git run: ${accessors.join(", ")}`).toBeGreaterThan(1);
    expect(
      importsGitBridgeAccessor(gob, accessors),
      `git-ops-bridge does not reach git through the bridge (accessors: ${accessors.join(", ")}) — it would then need a timeout of its own`,
    ).toBe(true);
    // The unified owner is config.ts.
    const cfg = readFileSync(modulePathMatching("server/kernel/config.ts"), "utf8");
    expect(cfg).toContain("gitTimeoutMs");
    expect(cfg).toContain("DEFAULT_GIT_TIMEOUT_MS");
  });
});
