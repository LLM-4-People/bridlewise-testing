// @vitest-environment node
/**
 * Mechanical enforcement: the rate-limit SESSION-KEY BYPASS security fix
 * (security).
 *
 * flagged: the rate limit was keyed by the `harness_session` (anonymous
 * isolation) cookie — but that cookie is NOT an identity (session.ts:
 * "Session IDs are NOT authentication"). Two bypass vectors:
 * (1) OMIT the cookie → `resolveSessionId` generates a fresh UUID → a
 * fresh bucket every request → infinite budget → the limit never
 * trips (complete bypass).
 * (2) ROTATE the cookie → the client controls the value → each new value
 * resets the bucket. HackTricks rate-limit-bypass: "requesting a
 * fresh session ID each time... attackers can bypass rate limits";
 * "cookie jar garbage — submit random session cookies".
 *
 * The fix keys by something the attacker CANNOT control: the authenticated
 * userId (primary) or the un-spoofable client IP (fallback for public routes
 * like login/register). The limiter derives the key INTERNALLY — the router
 * passes `(req, db)`, never a client-controllable key string.
 *
 * This file owns the fast source-scan + in-process invariants. The four
 * HTTP-server behavioral tests (the ~360-request loops) live in
 * rate-limit-http.test.ts so they run in their own worker instead of
 * serializing the fast tests here (split for parallelism, all
 * invariants preserved).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { modulePathMatching } from "../helpers/module-resolver.ts";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import {
  rateLimitKey,
  clientIp,
  rateLimitBucketCount,
  getRemainingTokens,
} from "../../server/router/rate-limiter.ts";
import { resolveServerConfig } from "../../server/kernel/config.ts";
import { ConfigError } from "../../server/kernel/errors.ts";
import { walkTs } from "../helpers/source-scan.ts";
import {
  readSourceView,
  sourceViewOf,
} from "../../engine/scripts/verification/source-view.ts";
import { mockReq } from "../helpers/mock-http.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const LIMITER_PATH = join(process.cwd(), "server", "router", "rate-limiter.ts");
const ROUTER_PATH = join(process.cwd(), "server", "router", "router.ts");
const SERVER_DIR = join(process.cwd(), "server");

// ── (c) Source-level: the key derivation is INSIDE the limiter ──────────────

describe("Rate-limit security — key derivation is inside the limiter, not the route", () => {
  const serverFiles = walkTs(SERVER_DIR);

  test("the limiter owns the key derivation (rateLimitKey + clientIp defined there)", () => {
    const limiterSrc = readFileSync(LIMITER_PATH, "utf8");
    expect(limiterSrc).toMatch(/export async function rateLimitKey/);
    expect(limiterSrc).toMatch(/export function clientIp/);
  });

  test("the router passes the REQUEST (req, db) to checkRateLimit — NOT a derived key string", () => {
    const routerSrc = readFileSync(ROUTER_PATH, "utf8");
    expect(routerSrc).toMatch(/checkRateLimit\(\s*req\s*,\s*db\s*\)/);
    expect(routerSrc).not.toMatch(/rateLimitKey\(/);
    expect(routerSrc).not.toMatch(/\bclientIp\(/);
    expect(routerSrc).not.toMatch(/checkRateLimit\(\s*sessionId\b/);
    expect(routerSrc).not.toMatch(/\bconsumeToken\s*\(/);
  });

  test("rateLimitKey + clientIp are defined ONLY in rate-limiter.ts (single owner — dynamic discovery, )", () => {
    for (const f of serverFiles) {
      const src = readFileSync(f, "utf8");
      if (/export\s+function\s+rateLimitKey\s*\(/.test(src) && !f.endsWith("rate-limiter.ts")) {
        throw new Error(
          `${f} redefines rateLimitKey — the key-derivation owner must live ONLY in server/rate-limiter.ts (Single-Party-Owner).`,
        );
      }
      if (/function\s+clientIp\s*\(/.test(src) && !f.endsWith("rate-limiter.ts")) {
        throw new Error(
          `${f} redefines clientIp — the IP-derivation owner must live ONLY in server/rate-limiter.ts (Single-Party-Owner).`,
        );
      }
    }
  });

  test("NO server file outside the limiter calls consumeToken directly (routes must use checkRateLimit — dynamic discovery, )", () => {
    for (const f of serverFiles) {
      if (f.endsWith("rate-limiter.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (/\bconsumeToken\s*\(/.test(src)) {
        throw new Error(
          `${f} calls consumeToken directly — routes must use checkRateLimit(req, db) so the limiter derives the key internally (no client-controllable key bypass).`,
        );
      }
    }
  });

  test("rateLimitTrustProxy defaults to false (deny-by-default — x-forwarded-for is spoofable)", () => {
    const cfg = resolveServerConfig({ HARNESS_WEB_RATE_LIMIT_TRUST_PROXY: "" });
    expect(cfg.rateLimitTrustProxy).toBe(false);
    const cfgOn = resolveServerConfig({ HARNESS_WEB_RATE_LIMIT_TRUST_PROXY: "1" });
    expect(cfgOn.rateLimitTrustProxy).toBe(true);
  });
});

// ── Key derivation: rateLimitKey / clientIp behavior (no HTTP server) ───────

describe("Rate-limit security — rateLimitKey derives user:<id> | ip:<ip>", () => {
  let tmpRoot: string;
  let db: DbClient;
  let adb: AsyncDbClient;

  beforeAll(() => {
    tmpRoot = createTempDir("ch-rl-key-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    adb = AsyncDbClient.inline(db);
  });

  afterAll(() => {
    if (db) db.close();
  });

  test("an authenticated request (harness_auth cookie) keys by user:<userId>", async () => {
    const user = createTestUser(db, "rl-key-user");
    const req = mockReq({ cookie: user.cookie });
    expect(await rateLimitKey(req, adb)).toBe(`user:${user.userId}`);
  });

  test("an unauthenticated request (only harness_session, no harness_auth) keys by ip:<ip>", async () => {
    const req = mockReq({ cookie: "harness_session=anything", remoteAddress: "192.0.2.5" });
    expect(await rateLimitKey(req, adb)).toBe("ip:192.0.2.5");
  });

  test("a request with NO cookie at all keys by ip:<ip> (omit-cookie bypass closed)", async () => {
    const req = mockReq({ remoteAddress: "127.0.0.1" });
    expect(await rateLimitKey(req, adb)).toBe("ip:127.0.0.1");
  });

  test("IPv4-mapped-IPv6 remoteAddress is normalized (::ffff:127.0.0.1 → 127.0.0.1)", async () => {
    const req = mockReq({ remoteAddress: "::ffff:127.0.0.1" });
    expect(await rateLimitKey(req, adb)).toBe("ip:127.0.0.1");
  });

  test("clientIp ignores X-Forwarded-For by default (deny-by-default — spoofable header)", () => {
    const req = mockReq({ remoteAddress: "127.0.0.1", xff: "1.2.3.4" });
    expect(clientIp(req)).toBe("127.0.0.1");
  });
});

// The HTTP-server behavioral tests (the ~360-request loops for (a), (b1), (b2),
// (b3) + the regression guard) live in rate-limit-http.test.ts so they run in
// their own worker instead of serializing the fast tests here.

// ── (d) -A: LRU bucket cap (memory-DoS fix-B1) ────────────────────

describe("Rate-limit security (-A) — LRU bucket cap bounds memory (-B1 fix)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Dynamically import a FRESH rate-limiter with a stubbed cap. Returns the
   * limiter API for the fresh instance (its own `buckets` Map). */
  async function freshLimiter(cap: number) {
    vi.resetModules();
    vi.stubEnv("HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS", String(cap));
    const mod = await import("../../server/router/rate-limiter.ts");
    return mod;
  }

  test("rateLimitMaxBuckets is configurable via HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS env", () => {
    const cfgDefault = resolveServerConfig({});
    expect(cfgDefault.rateLimitMaxBuckets).toBe(10_000);
    const cfgSmall = resolveServerConfig({ HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS: "5" });
    expect(cfgSmall.rateLimitMaxBuckets).toBe(5);
    expect(() => resolveServerConfig({ HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS: "0" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_RATE_LIMIT_MAX_BUCKETS: "abc" })).toThrow(ConfigError);
  });

  test("the buckets Map is bounded by the cap (creating cap+1 keys keeps count at cap)", async () => {
    const limiter = await freshLimiter(3);
    limiter.resetRateLimiter();
    expect(limiter.rateLimitBucketCount()).toBe(0);
    limiter.consumeToken("a");
    limiter.consumeToken("b");
    limiter.consumeToken("c");
    expect(limiter.rateLimitBucketCount()).toBe(3);
    limiter.consumeToken("d");
    expect(limiter.rateLimitBucketCount()).toBe(3);
    limiter.consumeToken("e");
    limiter.consumeToken("f");
    expect(limiter.rateLimitBucketCount()).toBe(3);
  });

  test("LRU eviction removes the OLDEST (least-recently-used) bucket; recently-used survive", async () => {
    const limiter = await freshLimiter(3);
    limiter.resetRateLimiter();
    limiter.consumeToken("a");
    limiter.consumeToken("b");
    limiter.consumeToken("c");
    expect(limiter.rateLimitBucketCount()).toBe(3);
    expect(limiter.getRemainingTokens("b")).toBeLessThan(60);
    expect(limiter.getRemainingTokens("b")).toBeGreaterThan(0);

    limiter.consumeToken("a");
    limiter.consumeToken("d");
    expect(limiter.rateLimitBucketCount()).toBe(3);

    expect(limiter.getRemainingTokens("b")).toBe(60);

    expect(limiter.getRemainingTokens("a")).toBeLessThanOrEqual(58);
    expect(limiter.getRemainingTokens("a")).toBeGreaterThan(0);

    expect(limiter.getRemainingTokens("c")).toBeLessThan(60);
    expect(limiter.getRemainingTokens("c")).toBeGreaterThan(0);

    expect(limiter.getRemainingTokens("d")).toBeLessThan(60);
  });

  test("re-accessing an existing bucket marks it recently used (LRU refresh on hit)", async () => {
    const limiter = await freshLimiter(2);
    limiter.resetRateLimiter();
    limiter.consumeToken("x");
    limiter.consumeToken("y");
    limiter.consumeToken("x");
    limiter.consumeToken("z");
    expect(limiter.rateLimitBucketCount()).toBe(2);
    expect(limiter.getRemainingTokens("y")).toBe(60);
    expect(limiter.getRemainingTokens("x")).toBeLessThanOrEqual(58);
  });

  test("a cap of 1 keeps only one bucket at a time (extreme eviction)", async () => {
    const limiter = await freshLimiter(1);
    limiter.resetRateLimiter();
    limiter.consumeToken("only");
    expect(limiter.rateLimitBucketCount()).toBe(1);
    limiter.consumeToken("new");
    expect(limiter.rateLimitBucketCount()).toBe(1);
    expect(limiter.getRemainingTokens("only")).toBe(60);
  });
});

// ── THE PROVIDER SOURCE: the database, and nothing that can read a file ──

/**
 * These tests used to guard "exactly one module reads the LLM config FILE".
 * The file is gone — providers come from the database — so the guard is
 * replaced by the stronger claim the deletion earns: no server module may
 * obtain a provider from a file OR construct an LLM client from anything but
 * a database-minted credential.
 *
 * The type system already refuses the second one (`ProviderCredential` carries
 * a module-private brand, so nothing outside `server/providers.ts` can produce
 * a value of it). These scans exist for the part the compiler cannot see: a
 * module that reads the OLD path back into existence, and the mint itself
 * losing the redaction registration that makes a key knowable.
 *
 * Every detector below is proven live by a PLANT, because a scan that has
 * quietly stopped matching passes exactly as loudly as a clean tree.
 */
describe("model providers come from the database, and no file can supply one", () => {
  const serverFiles = walkTs(SERVER_DIR);
  const PROVIDERS_PATH = join(SERVER_DIR, "llm/providers.ts");
  const LLM_BRIDGE_PATH = join(SERVER_DIR, "llm/llm-bridge.ts");

  /** The path the deleted fallback read. Spelled once, matched everywhere. */
  const DELETED_FALLBACK_PATH = "/tmp/bridlewise";
  /** The config field that named it. */
  const DELETED_CONFIG_FIELD = "llmConfigPath";

  test("NO server file reads the deleted provider config file, by path or by field", () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      // THE VIEW IS THE WHOLE ANSWER HERE, in both directions.
      //
      // Raw bytes would flag the three modules whose header comments EXPLAIN
      // the deleted path — a scan that fires on its own documentation is a
      // scan nobody can keep green, and the pressure is then to delete the
      // explanation rather than the defect.
      //
      // `code()` would go too far the other way: it blanks string interiors,
      // and a real violation IS a string literal — `readFileSync("/tmp/…")`.
      // The scan would come back clean while the read sat in the tree.
      //
      // `codeWithStrings()` is the one view that separates them: comments
      // blanked, quoted strings intact.
      const src = readSourceView(file).codeWithStrings();
      if (src.includes(DELETED_FALLBACK_PATH) || src.includes(`serverConfig.${DELETED_CONFIG_FIELD}`)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these modules reach for a provider on disk. The database is the only source: ` +
      `read it through server/providers.ts::loadProviderStore.`,
    ).toEqual([]);
    // LIVENESS. A scan whose universe is empty, or whose spelling has stopped
    // matching, reports a clean tree in exactly the same words. Plant both
    // spellings and require the detector to see them.
    expect(serverFiles.length).toBeGreaterThan(50);
    //
    // The plants go through the SAME view the scan uses, not through a bare
    // string — otherwise the liveness check proves that `includes` works,
    // which was never in doubt, rather than that this VIEW still surfaces a
    // violation. And the third plant is the one that matters: a mention in a
    // COMMENT must NOT be flagged, or the guard is unkeepable.
    const planted = sourceViewOf(
      `const p = readFileSync("${DELETED_FALLBACK_PATH}/llm-api-config.json");`,
      "planted.ts",
    ).codeWithStrings();
    expect(planted.includes(DELETED_FALLBACK_PATH)).toBe(true);
    const plantedField = sourceViewOf(
      "const u = readFileText(serverConfig.llmConfigPath);",
      "planted.ts",
    ).codeWithStrings();
    expect(plantedField.includes(`serverConfig.${DELETED_CONFIG_FIELD}`)).toBe(true);
    const plantedComment = sourceViewOf(
      `// this module used to read ${DELETED_FALLBACK_PATH}/llm-api-config.json`,
      "planted.ts",
    ).codeWithStrings();
    expect(plantedComment.includes(DELETED_FALLBACK_PATH)).toBe(false);
  });

  test("the server config declares no provider path and no default model", () => {
    const src = readFileSync(join(SERVER_DIR, "kernel/config.ts"), "utf8");
    // A default VALUE (a timeout, a page size) is fine and expected. A default
    // CREDENTIAL LOCATION or a default model IDENTITY is a fallback source.
    expect(src).not.toMatch(/^\s*readonly\s+llmConfigPath\s*:/mu);
    expect(src).not.toMatch(/^\s*readonly\s+defaultModel\s*:/mu);
    expect(src).not.toMatch(/DEFAULT_LLM_CONFIG_PATH\s*=/u);
    expect(src).not.toMatch(/DEFAULT_WEB_MODEL\s*=/u);
    // LIVENESS: the patterns still match the shape they are looking for.
    expect(/^\s*readonly\s+llmConfigPath\s*:/mu.test("  readonly llmConfigPath: string;")).toBe(true);
    expect(/DEFAULT_WEB_MODEL\s*=/u.test('export const DEFAULT_WEB_MODEL = "x";')).toBe(true);
  });

  test("the LLM client is constructed in ONE module, from a credential", () => {
    const constructors: string[] = [];
    for (const file of serverFiles) {
      if (/new\s+SharedLLMClient\s*\(/u.test(readFileSync(file, "utf8"))) constructors.push(file);
    }
    expect(constructors).toEqual([LLM_BRIDGE_PATH]);
    const bridge = readFileSync(LLM_BRIDGE_PATH, "utf8");
    // It builds from the credential's own fields — not from a parsed object,
    // an env var, or a config path.
    expect(bridge).toMatch(/baseUrl:\s*credential\.baseUrl/u);
    expect(bridge).toMatch(/model:\s*credential\.modelId/u);
    // LIVENESS for the constructor scan.
    expect(/new\s+SharedLLMClient\s*\(/u.test("const c = new SharedLLMClient({});")).toBe(true);
  });

  test("the credential mint never registers a user's key process-wide — the client holds it for its own calls (CRED-F2)", () => {
    const src = readFileSync(PROVIDERS_PATH, "utf8");
    const mint = src.slice(src.indexOf("function mintCredential"));
    const body = mint.slice(0, mint.indexOf("\n}"));
    const discovery = src.slice(src.indexOf("function credentialForDiscovery"));
    const discoveryBody = discovery.slice(0, discovery.indexOf("\n}"));
    // A user's key in the process-wide registry masked every OTHER user's text
    // and, 64 of them later, switched registration off for the harness's own.
    for (const registration of ["rememberOwnCredential(", "registerKnownSecret("]) {
      expect(body).not.toContain(registration);
      expect(discoveryBody).not.toContain(registration);
    }
    // The client that carries the credential holds its key and header values
    // for every call (masked at the mint and in its diagnostics).
    const client = readFileSync(modulePathMatching("shared/llm/client.ts"), "utf8");
    expect(client).toMatch(/providerHeldSet\(\{ id: provider\.id, apiKey: provider\.apiKey, headers: \{ \.\.\.this\.config\.headers, \.\.\.provider\.headers \} \}\)\), providerHeldSet\(this\.config\)\);/u);
    // And the mint is the ONLY producer of the branded value, so the client's
    // held list covers every key this process will ever hold.
    const producers = serverFiles.filter((file) =>
      readFileSync(file, "utf8").includes("PROVIDER_CREDENTIAL_BRAND"));
    expect(producers).toEqual([PROVIDERS_PATH]);
    // LIVENESS: the slice really did capture a body, not two bytes.
    expect(body.length).toBeGreaterThan(80);
    expect(discoveryBody.length).toBeGreaterThan(80);
    expect(body).toContain("providerId: provider.id");
  });

  test("the safe projection has no field an API key could occupy", () => {
    const src = readFileSync(PROVIDERS_PATH, "utf8");
    const view = src.slice(src.indexOf("export type ProviderView"));
    const decl = view.slice(0, view.indexOf("}>;"));
    expect(decl.length).toBeGreaterThan(40);
    expect(decl).toContain("hasApiKey");
    // `hasApiKey` is a boolean about a key, not the key. A bare `apiKey:`
    // field would be the leak, and would have to be added deliberately here.
    expect(decl).not.toMatch(/\bapiKey\s*:/u);
    // LIVENESS: the pattern does match a real field declaration.
    expect(/\bapiKey\s*:/u.test("  apiKey: string;")).toBe(true);
  });
});
