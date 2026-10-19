// @vitest-environment node
/**
 * Mechanical enforcement: cookie security flags (Part C).
 *
 * Two bugs fixed this round, both pinned here so they cannot regress:
 * 1. The auth + session cookies had NO `Secure` flag — a non-loopback
 * HTTPS deployment would leak the cookie over a downgraded hop. The
 * fix: `serverConfig.cookieSecure` is DERIVED from the configured
 * allowed-origin scheme (https → Secure; http loopback dev → no
 * Secure so the browser keeps the cookie), and `authCookieAttributes`
 * + the session-cookie builder append `Secure` when it is set.
 * 2. `setAuthCookie` forced `Max-Age=86400` (a hardcoded magic number)
 * when the auth TTL was 0, breaking the documented "session cookie"
 * behavior (a 0 TTL must mean a browser-session cookie, Max-Age
 * omitted). The fix: `authCookieAttributes(undefined)` OMITS Max-Age
 * (session cookie); `0` still means DELETE (logout).
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(process.cwd(), "server", "kernel", "config.ts");
const AUTH_PATH = join(process.cwd(), "server", "auth", "auth.ts");
const SESSION_PATH = join(process.cwd(), "server", "auth", "session.ts");

describe("Cookie security — Secure flag derived from the configured origin (Part C)", () => {
  test("ServerConfig declares cookieSecure (the derived Secure-flag invariant)", () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    expect(src).toMatch(/readonly\s+cookieSecure\s*:\s*boolean/);
    // The value is DERIVED from the allowed-origin scheme, not env-tunable
    // (a tunable could be mis-set to false over HTTPS — a safety hole).
    expect(src).toMatch(/cookieSecure\s*=\s*allowedOrigin\.toLowerCase\(\)\.startsWith\(\s*["']https:\/\//);
  });

  test("resolveServerConfig sets cookieSecure on the frozen config object", () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    expect(src).toMatch(/cookieSecure,/);
  });

  test("authCookieAttributes appends Secure when serverConfig.cookieSecure is true", () => {
    const src = readFileSync(AUTH_PATH, "utf8");
    expect(src).toMatch(/serverConfig\.cookieSecure/);
    expect(src).toMatch(/parts\.push\(\s*["']Secure["']\s*\)/);
  });

  test("the session cookie builder appends Secure when cookieSecure is true (not just the auth cookie)", () => {
    const src = readFileSync(SESSION_PATH, "utf8");
    expect(src).toMatch(/serverConfig\.cookieSecure/);
    expect(src).toMatch(/parts\.push\(\s*["']Secure["']\s*\)/);
  });
});

describe("Cookie security — auth TTL=0 means a browser-session cookie (Max-Age omitted)", () => {
  test("authCookieAttributes takes an OPTIONAL maxAge (undefined → omit Max-Age)", () => {
    const src = readFileSync(AUTH_PATH, "utf8");
    // The signature must be optional: `maxAgeSeconds?: number`.
    expect(src).toMatch(/export\s+function\s+authCookieAttributes\s*\(\s*maxAgeSeconds\?\s*:\s*number\s*\)/);
    // Max-Age is only appended when the arg is defined.
    expect(src).toMatch(/if\s*\(\s*maxAgeSeconds\s*!==\s*undefined\s*\)\s*parts\.push\(\s*`Max-Age=\$\{maxAgeSeconds\}`\s*\)/);
  });

  test("setAuthCookie passes `undefined` (not 86400) when the TTL is 0", () => {
    // (SPO): setAuthCookie moved from routes/auth.ts into the auth
    // owner (server/auth.ts) so ALL auth-cookie operations live in ONE
    // module. The test reads the OWNER now, not the route.
    const src = readFileSync(AUTH_PATH, "utf8");
    // The 86400 magic number must be GONE.
    expect(src).not.toMatch(/86400/);
    // When ttl === 0, pass undefined (session cookie); when > 0, pass ttl.
    expect(src).toMatch(/authCookieAttributes\(\s*ttl\s*>\s*0\s*\?\s*ttl\s*:\s*undefined\s*\)/);
  });

  test("session.ts cookie max-age is owned by serverConfig (no inline 60*60*24*365 literal)", () => {
    const src = readFileSync(SESSION_PATH, "utf8");
    // The inline 1-year literal must be GONE — replaced by the config owner.
    expect(src).not.toMatch(/60\s*\*\s*60\s*\*\s*24\s*\*\s*365/);
    expect(src).toMatch(/serverConfig\.sessionCookieMaxAgeSeconds/);
  });

  test("config.ts owns the session-cookie max-age default + env override", () => {
    const src = readFileSync(CONFIG_PATH, "utf8");
    expect(src).toMatch(/DEFAULT_SESSION_COOKIE_MAX_AGE/);
    expect(src).toMatch(/sessionCookieMaxAgeSeconds:\s*envInt\(/);
  });
});
