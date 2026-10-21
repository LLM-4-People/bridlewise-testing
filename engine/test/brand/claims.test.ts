/**
 * THE CLAIMS REGISTER AND THE MESSAGING SOURCE (scripts/brand/): each is
 * validated whole, a malformed one is refused typed (never partly read), and
 * this repository's own register and source are well formed.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { claimViolations, readClaims } from "../../scripts/brand/claims.ts";
import { messagingViolations, readMessaging } from "../../scripts/brand/messaging.ts";
import { readDecisions } from "../../scripts/roadmap/inputs.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const exists = (path: string): boolean => path === "docs/floor/evidence.md" || path === "decision:UR-17";
const register = (...claims: unknown[]): unknown => ({ schema: "bridlewise-claims/v1", claims });

test("a well-formed register of the three kinds has no violation", () => {
  assert.deepEqual(claimViolations(register(
    { id: "not-ready", kind: "holds-when-green", text: "It says it is not ready", checks: ["testing.ci"], evidence: "docs/floor/evidence.md#guardian" },
    { id: "no-bypass", kind: "designed", text: "A module cannot bypass the core", decision: "UR-17" },
    { id: "release-dates", kind: "not-claimed", text: "A release date", reason: "Intent, not a schedule." },
    { id: "audit", kind: "not-claimed", text: "An audit", reason: "None exists.", evidence: "https://example.test/x" },
  ), exists), []);
});

test("every way a claim breaks the register is named, in more than one place", () => {
  const problems = claimViolations({
    schema: "bridlewise-claims/v2",
    extra: true,
    claims: [
      { id: "Bad Id", kind: "not-claimed", text: "x", reason: "y" },
      { id: "dup", kind: "not-claimed", text: "x", reason: "y" },
      { id: "dup", kind: "not-claimed", text: "x", reason: "y" },
      { id: "no-checks", kind: "holds-when-green", text: "x", checks: [] },
      { id: "bad-check", kind: "holds-when-green", text: "x", checks: ["Testing CI"] },
      { id: "no-decision", kind: "designed", text: "x", decision: "PROTO-ONE" },
      { id: "no-reason", kind: "not-claimed", text: "x", reason: " " },
      { id: "stray", kind: "designed", text: "x", decision: "UR-17", checks: ["testing.ci"] },
      { id: "bad-kind", kind: "maybe", text: "x" },
      { id: "missing-file", kind: "not-claimed", text: "x", reason: "y", evidence: "docs/nowhere.md" },
      { id: "escape", kind: "not-claimed", text: "x", reason: "y", evidence: "../outside.md" },
      { id: "no-text", kind: "not-claimed", text: "", reason: "y" },
    ],
  }, exists);
  for (const expected of [
    /schema must be bridlewise-claims\/v1/u, /extra is not a field of the register/u, /claims\[0\]\.id must be lower-case/u, /dup is used twice/u,
    /no-checks: a holds-when-green claim binds at least one check/u, /bad-check: Testing CI is not a check id/u,
    /no-decision: decision PROTO-ONE is no decision record/u, /no-reason: a not-claimed entry states its reason/u,
    /stray: checks is not a field of a designed claim/u, /bad-kind: kind must be one of/u, /missing-file: evidence docs\/nowhere\.md does not exist/u,
    /escape: evidence must be a repository path or an https URL/u, /no-text: text is required/u,
  ]) assert.ok(problems.some((p) => expected.test(p)), `missing ${String(expected)} in:\n${problems.join("\n")}`);
});

test("this repository's register is read whole, and its not-claimed entries carry reasons", () => {
  const decisions = new Set(readDecisions(REPOSITORY_ROOT).map((d) => d.id));
  const claims = readClaims(REPOSITORY_ROOT, decisions);
  assert.ok(claims.length > 0);
  assert.ok(claims.every((c) => c.kind !== "not-claimed" || c.reason.length > 0));
  assert.ok(Object.isFrozen(claims));
});

test("the messaging source: one name and the two addresses, validated; a malformed source is refused", () => {
  assert.deepEqual(messagingViolations({ schema: "bridlewise-messaging/v1", name: "B", repositoryUrl: "https://github.com/o/r", siteUrl: "https://o.github.io/r/" }), []);
  const problems = messagingViolations({ schema: "x", name: "", repositoryUrl: "https://github.com/o/r/", siteUrl: "http://o.github.io/r", tagline: "!" });
  for (const expected of [/schema must be/u, /name is required/u, /repositoryUrl must be/u, /siteUrl must be/u, /tagline is not a field/u]) {
    assert.ok(problems.some((p) => expected.test(p)), String(expected));
  }
  const messaging = readMessaging(REPOSITORY_ROOT);
  assert.match(messaging.repositoryUrl, /^https:\/\/github\.com\//u);
  assert.throws(() => readMessaging(join(REPOSITORY_ROOT, "engine")), (error: unknown) => error instanceof InputError && error.code === "messaging_source_invalid");
});
