import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { McpError } from "../../src/mcp/errors.ts";
import { MCP_UNAVAILABILITY_CODES, mcpUnavailableReason } from "../../src/mcp/unavailability.ts";
import { RESPONSE_MCP_ITEM_TYPES } from "../../src/shared/llm/responses.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * The unavailability taxonomy's judgment must be explicit in BOTH
 * directions: every `mcp_*` error code thrown anywhere in the engine is
 * either classified as a tool unavailability (CODE_TO_KEY) or DOCUMENTED as
 * a deliberate exclusion in the taxonomy owner's header — with its reason,
 * so a reader can tell "deliberate" from "forgotten" (the silent-absence
 * class this guards). Both directions are derived from the tree, never from
 * a hand-written list: the universe is every quoted mcp_* literal found in
 * `engine/src/**` EXCEPT the taxonomy owner itself (that file's header is
 * the documentation set, not a throw site — scanning it would make the
 * stale-doc check circular), and the documentation set is the exclusion
 * list in the header itself.
 *
 * Protocol vocabulary is not an error code: the Responses protocol's native
 * MCP item types (`RESPONSE_MCP_ITEM_TYPES`, owned by the protocol module) are
 * subtracted from the universe, imported from their owner rather than listed
 * here. Two assertions keep that subtraction honest: every subtracted type is
 * really used by the protocol code, and no taxonomy code is also an item type.
 *
 * Population limits, stated: codes thrown only OUTSIDE the engine tree (the
 * web bridge's lifecycle codes) are covered by the classified direction
 * (they are in CODE_TO_KEY); the classified direction itself — every
 * taxonomy code decodes and owns a sentence — is pinned by the safety
 * investigation suite, which is why this file does not restate it.
 */

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));
const UNAVAILABILITY = join(SRC_ROOT, "mcp", "unavailability.ts");

function walkTs(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"] }));
  return acc;
}

/**
 * Every quoted mcp_* literal the engine tree carries. The view is
 * `codeWithStringsAndTemplates()`: the codes ARE string literals (so
 * `code()` would blank the very subjects being counted), and comments are
 * blanked so an mcp_* code named only in a comment is not read as a throw
 * site. Template interiors stay intact because a code interpolated into a
 * template is still a thrown/named code.
 */
function discoverThrownCodes(): ReadonlySet<string> {
  const codes = new Set<string>();
  const protocolVocabulary = new Set<string>(RESPONSE_MCP_ITEM_TYPES);
  for (const file of walkTs(SRC_ROOT)) {
    // The taxonomy owner NAMES exclusions in its header. Those names are
    // documentation, not throw sites — including them would make every
    // documented code look "thrown" and the stale-doc check vacuous.
    if (file === UNAVAILABILITY) continue;
    const src = readSourceView(file).codeWithStringsAndTemplates();
    // A code is `mcp_<word>`: the tool-name prefix `mcp__` (the naming
    // owner's namespace, `tool-name.ts`) is not an error code.
    for (const match of src.matchAll(/(["'`])(mcp_[a-z][a-z_]*)\1/g)) {
      if (!protocolVocabulary.has(match[2]!)) codes.add(match[2]!);
    }
  }
  return codes;
}

/**
 * The taxonomy owner's header comments, joined into one string. The exclusion
 * section's markers live in ONE block comment (the header's doc), and the
 * codes themselves live inside it — so the join is over the `prose()` lines,
 * each of which is one comment. An mcp_* code outside a comment is not a
 * documented exclusion.
 */
function headerProse(): string {
  return readSourceView(UNAVAILABILITY).prose().map((p) => p.text).join("\n");
}

/** The codes the taxonomy owner NAMES as deliberate exclusions, parsed from
 * the exclusion section of its own header (between two stable markers — both
 * asserted below, so a header rewrite cannot silently narrow the parse). */
function documentedExclusions(headerSource: string): ReadonlySet<string> {
  const startMarker = "is a deliberate exclusion, named here with its";
  const endMarker = "Everyone who asks";
  const start = headerSource.indexOf(startMarker);
  const end = headerSource.indexOf(endMarker);
  assert.notEqual(start, -1, "the exclusion section's start marker must exist in the header");
  assert.notEqual(end, -1, "the exclusion section's end marker must exist in the header");
  assert.ok(end > start, "the exclusion section must be a non-empty window");
  const section = headerSource.slice(start, end);
  return new Set([...section.matchAll(/\bmcp_[a-z][a-z_]*\b/g)].map((m) => m[0]));
}

test("unavailability: every thrown code is classified or documented as a deliberate exclusion", () => {
  const discovered = discoverThrownCodes();
  const classified = new Set(MCP_UNAVAILABILITY_CODES);
  const documented = documentedExclusions(headerProse());
  // The universe must be real: a scan that found nothing (wrong tree, wrong
  // pattern) must red rather than vacuously pass — and there must BE excluded
  // codes, or the documentation half of the rule is checking nothing.
  assert.ok(discovered.size > classified.size, `the scan must find more codes than the taxonomy classifies (found ${discovered.size}, classified ${classified.size})`);
  const neither = [...discovered].filter((code) => !classified.has(code) && !documented.has(code));
  assert.deepEqual(
    neither,
    [],
    `thrown but neither classified nor documented (add it to CODE_TO_KEY or name it with its reason in the unavailability header): ${neither.join(", ")}`,
  );
  // Anti-rot: a code named in the doc that nothing throws is a stale entry —
  // it promises a judgment about a code that does not exist.
  const staleDoc = [...documented].filter((code) => !discovered.has(code) && !classified.has(code));
  assert.deepEqual(
    staleDoc,
    [],
    `documented as excluded but never thrown and never classified — the entry is stale: ${staleDoc.join(", ")}`,
  );
});

test("unavailability: the subtracted protocol MCP item types are live protocol vocabulary, disjoint from the taxonomy", () => {
  const protocolRoot = join(SRC_ROOT, "shared", "llm");
  const owner = join(protocolRoot, "responses.ts");
  const used = new Set<string>();
  for (const file of walkTs(protocolRoot)) {
    if (file === owner) continue;
    for (const match of readSourceView(file).codeWithStrings().matchAll(/(["'])(mcp_[a-z_]+)\1/g)) used.add(match[2]!);
  }
  const unused = RESPONSE_MCP_ITEM_TYPES.filter((type) => !used.has(type));
  assert.deepEqual(unused, [], `a subtracted item type must be used by the protocol code, or the subtraction could hide an unrelated literal: ${unused.join(", ")}`);
  const overlap = MCP_UNAVAILABILITY_CODES.filter((code) => (RESPONSE_MCP_ITEM_TYPES as readonly string[]).includes(code));
  assert.deepEqual(overlap, [], "an unavailability code must never also be a protocol item type");
});

test("unavailability: a documented exclusion decodes to NO reason (never misclassified)", () => {
  for (const code of documentedExclusions(headerProse())) {
    assert.equal(
      mcpUnavailableReason(new McpError("probe", code)),
      null,
      `excluded code ${code} must not decode to an unavailability reason`,
    );
  }
});

test("unavailability: non-taxonomy errors never decode (a bare Error, a foreign code)", () => {
  assert.equal(mcpUnavailableReason(new McpError("probe", "mcp_never_thrown_anywhere")), null);
  assert.equal(mcpUnavailableReason(new Error("MCP client is not connected")), null);
  assert.equal(mcpUnavailableReason("mcp_not_connected"), null);
  assert.equal(mcpUnavailableReason(null), null);
});
