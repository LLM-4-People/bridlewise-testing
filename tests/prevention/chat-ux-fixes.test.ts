// @vitest-environment node
/**
 * Prevention tests for the 7 UX fixes (exp522). Each test locks in a fix so
 * the failure mechanism cannot re-introduce. Adversarial cases
 *: improper usage, edge inputs, and the exact prior bugs.
 *
 * Assertions are scoped to the relevant code block (not whole-file bans) so
 * explanatory comments and unrelated rules don't trip them.
 */
import { describe, test, expect } from "vitest";
import { read } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
/** Extract the CSS rule body for a selector (the text between the `{` after
 * the selector-as-a-rule and its matching closing `}`), with CSS comments
 * stripped so assertions test actual declarations, not explanatory text.
 * The selector is matched as a CSS rule start (selector + whitespace + `{`)
 * so it does not match the selector name inside a comment or a TS generic. */
function extractCssBlock(source: string, selector: string): string {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{");
  const m = re.exec(source);
  if (m === null) return "";
  const open = source.indexOf("{", m.index);
  if (open === -1) return "";
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return "";
  // Strip CSS comments (/* … */) so a declaration value mentioned in an
  // explanatory comment does not trip a "not to contain" assertion.
  return source.slice(open, end + 1).replace(/\/\*[\s\S]*?\*\//g, "");
}

// (The Crest/right-panel class died with the old shell.)

// (The phantom-assistant class died with the old chat surface.)

describe("MCP tools appear ONCE (no duplication)", () => {
  const bridge = read(modulePath("tools-bridge.ts"));

  test("the unified manifest deduplicates by name (throws on duplicate)", () => {
    // The dedup guard checks the entry name before registering. 
    // refactored `add` to normalize the schema first, so the guard now
    // checks `normalized.name` (the dedup behavior is unchanged — still
    // throws `tool_manifest_duplicate_name` on a duplicate).
    expect(bridge).toContain("byName.has(normalized.name)");
    expect(bridge).toContain("tool_manifest_duplicate_name");
  });

  test("MCP entries are a single source (buildMcpToolEntries, one per server)", () => {
    expect(bridge).toContain("buildMcpToolEntries");
    // The one tagging site: every discovered MCP tool becomes ONE entry with
    // the mcp category (the live manifest's MCP half is asserted by name and
    // category in tests/unit/mcp-runtime.test.ts).
    expect(bridge).toContain('tagWithCategory(t.manifest, "mcp")');
  });
});

// (The tools-modal class died with the old tools panel.)

// (The indexing-badge class died with the old header.)

describe("no false 429 on read-only routes (server-offline/burst)", () => {
  const router = read(modulePath("router.ts"));

  test("ALL GET routes are exempt from rate limiting (read-only never 429)", () => {
    // The false-429 root cause: the prior fix exempted a hardcoded subset
    // of poll routes but NOT the boot routes, so a boot burst could exhaust
    // the bucket and surface "Too many requests" while the server was
    // merely busy/restarting. The root-cause fix exempts by HTTP method.
    expect(router).toContain('method === "GET"');
    expect(router).toContain("isReadOnly");
  });

  test("the hardcoded poll-route VARIABLE is gone", () => {
    // Ban the variable declaration, not the word in comments.
    expect(router).not.toMatch(/const isPollRoute/);
    expect(router).not.toMatch(/isPollRoute =/);
  });

  test("mutating routes are still rate-limited (LLM quota protected)", () => {
    // the router calls `checkRateLimit(req, db)` — the limiter derives
    // the key INTERNALLY (userId or IP), NOT the client-controllable
    // `sessionId` (the session-cookie bypass fix). Passing the request (not
    // a session string) is the lowest-level enforcement: a route cannot
    // derive a client-controllable key because it never derives the key.
    expect(router).toContain("checkRateLimit(req, db)");
    expect(router).toContain("rate_limited");
    // The router must NOT pass the client-controllable session id to the
    // limiter (the -flagged bypass vector).
    expect(router).not.toMatch(/checkRateLimit\(\s*sessionId\b/);
  });

  test("error-messages: a network error (server offline) says 'Server offline', not 429", () => {
    const fmt = read(modulePath("error-messages.ts"));
    expect(fmt).toContain('"network"');
    expect(fmt).toContain("Server offline");
    // The network branch is checked BEFORE the 429 branch so a true offline
    // (ECONNREFUSED → ClientError "network") never surfaces as rate-limit.
    const netIdx = fmt.indexOf('code === "network"');
    const rateIdx = fmt.indexOf("statusCode === 429");
    expect(netIdx).toBeGreaterThan(-1);
    expect(rateIdx).toBeGreaterThan(-1);
    expect(netIdx).toBeLessThan(rateIdx);
  });
});

// (The tree-view classes died with the old timeline surfaces; the dead
//  declaration itself is gone with the whole panel vocabulary.)
