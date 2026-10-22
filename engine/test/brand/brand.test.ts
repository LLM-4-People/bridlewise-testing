/**
 * THE PUBLIC WORDS (scripts/brand/): the messaging source and the claims
 * register are validated whole (planted violations in more than one place,
 * near-misses), a designed claim whose decision got built must be rebound to
 * its check, every claim is judged from the checks that ran on the published
 * commit (a red or missing check RETRACTS it; no snapshot retracts nothing),
 * and every surface renders from the sources alone, escaped and promise-free.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { claimViolations, decisionStates, readClaims, type Claim } from "../../scripts/brand/claims.ts";
import { messagingViolations, readMessaging, type Messaging } from "../../scripts/brand/messaging.ts";
import { claimsSitePage, judgeClaims, orgProfile, readmeHero, releaseHeader, repositoryMetadata } from "../../scripts/brand/render.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const COMMIT = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const exists = (path: string): boolean => path === "docs/floor/evidence.md";
const states = (id: string): string | undefined => ({ "UR-17": "standing", "D-DONE": "done" } as Record<string, string>)[id];
const register = (...claims: unknown[]): unknown => ({ schema: "bridlewise-claims/v1", claims });

const MESSAGING: Messaging = {
  name: "Bridlewise", repositoryUrl: "https://github.com/o/r", siteUrl: "https://o.github.io/r/",
  promise: "Every claim comes with a receipt.", summary: "A cockpit <for> runs.", status: "Developer preview. Not for sensitive code.",
  license: "AGPL-3.0", description: "A cockpit. Developer preview.", topics: ["agent-harness"],
  about: { word: "bridle-wise", partOfSpeech: "adjective", definition: "trained to obey the reins", source: "Collins", sourceUrl: "https://example.test/d", line: "The harness holds the reins." },
};
const CLAIMS: Claim[] = [
  { id: "green", kind: "holds-when-green", text: "Green <claim>", checks: ["testing.ci"], evidence: "tests/a.test.ts" },
  { id: "two", kind: "holds-when-green", text: "Two checks", checks: ["testing.ci", "testing.codeql"], evidence: null },
  { id: "planned", kind: "designed", text: "Not yet", decision: "UR-17" },
  { id: "audit", kind: "not-claimed", text: "An audit", reason: "None exists.", evidence: null },
];

test("the claims register: the three kinds pass; every violation is named, in more than one place", () => {
  assert.deepEqual(claimViolations(register(
    { id: "a", kind: "holds-when-green", text: "x", checks: ["testing.ci"], evidence: "docs/floor/evidence.md#x" },
    { id: "b", kind: "designed", text: "x", decision: "UR-17" },
    { id: "c", kind: "not-claimed", text: "x", reason: "y", evidence: "https://example.test/x" },
  ), exists, states), []);
  const problems = claimViolations({
    schema: "bridlewise-claims/v2", extra: true,
    claims: [
      { id: "Bad Id", kind: "not-claimed", text: "x", reason: "y" },
      { id: "dup", kind: "not-claimed", text: "x", reason: "y" }, { id: "dup", kind: "not-claimed", text: "x", reason: "y" },
      { id: "no-checks", kind: "holds-when-green", text: "x", checks: [] },
      { id: "bad-check", kind: "holds-when-green", text: "x", checks: ["Testing CI"] },
      { id: "no-decision", kind: "designed", text: "x", decision: "NOPE" },
      { id: "built", kind: "designed", text: "x", decision: "D-DONE" },
      { id: "no-reason", kind: "not-claimed", text: "x", reason: " " },
      { id: "stray", kind: "designed", text: "x", decision: "UR-17", checks: ["testing.ci"] },
      { id: "bad-kind", kind: "maybe", text: "x" },
      { id: "missing-file", kind: "not-claimed", text: "x", reason: "y", evidence: "docs/nowhere.md" },
      { id: "escape", kind: "not-claimed", text: "x", reason: "y", evidence: "../outside.md" },
    ],
  }, exists, states);
  for (const expected of [
    /schema must be/u, /extra is not a field/u, /claims\[0\]\.id must be lower-case/u, /dup is used twice/u, /no-checks: a holds-when-green claim binds/u,
    /bad-check: Testing CI is not a check id/u, /no-decision: decision NOPE is no decision record/u, /built: decision D-DONE is built; rebind/u,
    /no-reason: a not-claimed entry states its reason/u, /stray: checks is not a field/u, /bad-kind: kind must be one of/u,
    /missing-file: evidence docs\/nowhere\.md does not exist/u, /escape: evidence must be a repository path/u,
  ]) assert.ok(problems.some((p) => expected.test(p)), `missing ${String(expected)}`);
});

test("the messaging source: complete and honest, or refused", () => {
  assert.deepEqual(messagingViolations({ schema: "bridlewise-messaging/v1", ...MESSAGING }), []);
  const problems = messagingViolations({ ...MESSAGING, schema: "x", status: "Production ready.", description: "x".repeat(351), topics: ["Bad Topic", "a", "a"], promise: "Ship 10x faster, guaranteed.", tagline: "!", about: { ...MESSAGING.about, sourceUrl: "ftp://x" } });
  for (const expected of [/schema must be/u, /status must say it is a developer preview/u, /description is 351 characters/u, /topic "Bad Topic"/u, /a topic is listed twice/u, /promise makes a promise or names a date/u, /tagline is not a field/u, /about\.sourceUrl must be/u]) {
    assert.ok(problems.some((p) => expected.test(p)), String(expected));
  }
  assert.doesNotThrow(() => readMessaging(REPOSITORY_ROOT));
  assert.throws(() => readMessaging(join(REPOSITORY_ROOT, "engine")), (error: unknown) => error instanceof InputError && error.code === "messaging_source_invalid");
});

test("this repository's register is read whole against its own decision records", () => {
  const claims = readClaims(REPOSITORY_ROOT);
  assert.ok(claims.some((c) => c.kind === "holds-when-green") && claims.some((c) => c.kind === "designed") && claims.some((c) => c.kind === "not-claimed"));
  const decisions = decisionStates(REPOSITORY_ROOT);
  for (const c of claims) if (c.kind === "designed") assert.notEqual(decisions.get(c.decision)?.implementation, "done");
});

test("judging: a claim holds only while every bound check passed on the commit; red or missing retracts; no snapshot retracts nothing", () => {
  const verdicts = (checks: Parameters<typeof judgeClaims>[1]) => Object.fromEntries(judgeClaims(CLAIMS, checks, COMMIT).map((j) => [j.claim.id, j.verdict]));
  assert.deepEqual(verdicts([{ id: "testing.ci", status: "pass", headSha: COMMIT, runUrl: null }, { id: "testing.codeql", status: "pass", headSha: COMMIT, runUrl: null }]), { green: "holds", two: "holds", planned: "designed", audit: "not-claimed" });
  assert.deepEqual(verdicts([{ id: "testing.ci", status: "pass", headSha: COMMIT, runUrl: null }, { id: "testing.codeql", status: "fail", headSha: COMMIT, runUrl: null }]).two, "retracted");
  assert.deepEqual(verdicts([{ id: "testing.ci", status: "pass", headSha: "0".repeat(40), runUrl: null }]).green, "retracted", "a pass on another commit did not run on this one");
  assert.deepEqual(verdicts([]).green, "retracted", "a check the snapshot does not report did not run");
  assert.deepEqual(verdicts(null).green, "unchecked");
});

test("every surface renders from the sources: escaped, honest, the retraction visible", () => {
  const decisions = new Map([["UR-17", { implementation: "standing", path: "docs/decisions/UR-17-no-fallbacks.md" }]]);
  const hero = readmeHero(MESSAGING, CLAIMS, decisions);
  assert.match(hero, /^\*\*Every claim comes with a receipt\.\*\*/u);
  assert.match(hero, /Green \\<claim\\>/u, "Markdown-significant characters are escaped");
  assert.match(hero, /> \[!WARNING\]\n> \*\*Developer preview\./u);
  assert.match(hero, /\[UR-17\]\(https:\/\/github\.com\/o\/r\/blob\/main\/docs\/decisions\/UR-17-no-fallbacks\.md\)/u);
  assert.match(orgProfile(MESSAGING, CLAIMS), /2 claims, each with the check that backs it; 1 designed but not built yet/u);
  assert.deepEqual(repositoryMetadata(MESSAGING), { description: MESSAGING.description, homepage: MESSAGING.siteUrl, topics: MESSAGING.topics });
  assert.match(releaseHeader(MESSAGING), /^> \[!WARNING\]\n> \*\*Developer preview\./u);
  const judged = judgeClaims(CLAIMS, [{ id: "testing.ci", status: "fail", headSha: COMMIT, runUrl: "https://example.test/run/1" }], COMMIT);
  const page = claimsSitePage(MESSAGING, judged, COMMIT, decisions);
  assert.ok(page.startsWith("---\nlayout: default\n"), "the claims page opens with its front matter");
  assert.ok(page.slice(0, page.indexOf("\n---\n", 4) + 1).split("\n").includes("permalink: /floor/claims/"), "the front matter places the page at /floor/claims/");
  assert.match(page, /<tr data-verdict="retracted"><td class="floor-claim">Green &lt;claim&gt;<\/td>/u);
  assert.match(page, /<a href="https:\/\/example\.test\/run\/1">testing\.ci<\/a> <span class="floor-state" data-status="fail">fail<\/span>/u);
  assert.match(page, /0 hold · 2 retracted · 0 not checked · 1 designed, not built · 1 not claimed/u);
  assert.equal(page, claimsSitePage(MESSAGING, judged, COMMIT, decisions), "deterministic");
});
