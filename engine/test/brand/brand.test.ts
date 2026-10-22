/**
 * THE PUBLIC WORDS (scripts/brand/): the messaging source and the claims
 * register are validated whole (planted violations in more than one place,
 * near-misses), a designed claim whose decision got built must be rebound to
 * its check, every claim is judged from the checks that ran on the published
 * commit (a red or missing check RETRACTS it; no snapshot retracts nothing),
 * and every surface renders from the sources alone, escaped and promise-free.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { syncFrontDoors, withFrontBlock } from "../../scripts/brand/cli.ts";
import { createTempDir } from "../support/temp-dir.ts";

import { InputError } from "../../src/kernel/errors.ts";
import { claimViolations, decisionStates, readClaims, type Claim } from "../../scripts/brand/claims.ts";
import { messagingViolations, readMessaging, type Messaging } from "../../src/workflow/messaging.ts";
import { readWords, type Words } from "../../scripts/brand/words.ts";
import { CLAIMS_PAGE_BLOCK, claimsPage, FRONT_DOORS, judgeClaims, orgProfile, readmeHero, releaseHeader, repositoryMetadata, siteFront } from "../../scripts/brand/render.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const COMMIT = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const exists = (path: string): boolean => path === "docs/floor/evidence.md";
const states = (id: string): string | undefined => ({ "UR-17": "standing", "D-DONE": "done" } as Record<string, string>)[id];
const register = (...claims: unknown[]): unknown => ({ schema: "bridlewise-claims/v1", claims });

const SOURCE: Messaging = {
  name: "Bridlewise",
  promise: "Every claim comes with a receipt.", summary: "A cockpit <for> runs.", repository: "This repository is the floor.", status: "Developer preview. Not for sensitive code.",
  license: "AGPL-3.0", description: "A cockpit. Developer preview.", topics: ["agent-harness"],
  about: { word: "bridle-wise", partOfSpeech: "adjective", definition: "trained to obey the reins", source: "Collins", sourceUrl: "https://example.test/d", line: "The harness holds the reins." },
};
/** The words a surface renders: the source plus the addresses package.json declares. */
const MESSAGING: Words = { ...SOURCE, repositoryUrl: "https://github.com/o/r", siteUrl: "https://o.github.io/r/" };
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
  assert.deepEqual(messagingViolations({ schema: "bridlewise-messaging/v1", ...SOURCE }), []);
  // The addresses are package.json's, never restated in the words.
  assert.deepEqual(messagingViolations({ schema: "bridlewise-messaging/v1", ...MESSAGING }), ["repositoryUrl is not a field of the messaging source", "siteUrl is not a field of the messaging source"]);
  assert.equal(readWords(REPOSITORY_ROOT).repositoryUrl, JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")).repository.url.replace(/\.git$/u, ""));
  const problems = messagingViolations({ ...SOURCE, schema: "x", status: "Production ready.", description: "x".repeat(351), topics: ["Bad Topic", "a", "a"], promise: "Ship 10x faster, guaranteed.", tagline: "!", about: { ...SOURCE.about, sourceUrl: "ftp://x" } });
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
  const page = claimsPage(MESSAGING, judged, COMMIT, decisions);
  // The page is the site's own shell; its block is the only part the publish writes, and it spells no address.
  const shell = readFileSync(join(REPOSITORY_ROOT, CLAIMS_PAGE_BLOCK.path), "utf8");
  assert.ok(shell.split("\n").includes("permalink: /floor/claims/"));
  assert.equal(withFrontBlock(shell, CLAIMS_PAGE_BLOCK.begin, CLAIMS_PAGE_BLOCK.end, page)?.includes(page), true);
  assert.ok(!page.includes(MESSAGING.repositoryUrl), "a page the site serves reads site.repository_url, never a spelled address");
  assert.match(page, /<tr data-verdict="retracted"><td class="floor-claim">Green &lt;claim&gt;<\/td>/u);
  assert.match(page, /<a href="https:\/\/example\.test\/run\/1">testing\.ci<\/a> <span class="floor-state" data-status="fail">fail<\/span>/u);
  assert.match(page, /0 hold · 2 retracted · 0 not checked · 1 designed, not built · 1 not claimed/u);
  assert.equal(page, claimsPage(MESSAGING, judged, COMMIT, decisions), "deterministic");
});

test("the front doors: this repository's are current, and harness sync is the only writer", () => {
  assert.deepEqual(syncFrontDoors(REPOSITORY_ROOT, false), { allCurrent: true, status: "current", changed: [], problems: [] });
  const text = withFrontBlock("a\n<!-- B -->\nold\n<!-- E -->\nz", "<!-- B -->", "<!-- E -->", "new");
  assert.equal(text, "a\n<!-- B -->\nnew\n<!-- E -->\nz");
  assert.equal(withFrontBlock("no markers", "<!-- B -->", "<!-- E -->", "x"), null);
  assert.equal(withFrontBlock("<!-- B --><!-- E --><!-- B -->", "<!-- B -->", "<!-- E -->", "x"), null, "a second block is refused");
  assert.match(siteFront(MESSAGING), /<h1>Every claim comes with a receipt\.<\/h1>/u);
  assert.match(siteFront(MESSAGING), /A cockpit &lt;for&gt; runs\./u);
});

test("mutation: a broken source, a missing block or a hand edit fails the front-door check", () => {
  // A copy of the sources, the decision records and the front doors, in a scratch tree.
  const root = createTempDir("front-doors-");
  for (const path of ["package.json", "docs/brand", "docs/decisions", ...new Set(FRONT_DOORS.map((d) => d.path))]) cpSync(join(REPOSITORY_ROOT, path), join(root, path), { recursive: true });
  const claims = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "docs/brand/claims.json"), "utf8")) as { claims: { evidence?: string | null }[] };
  for (const c of claims.claims) if (typeof c.evidence === "string" && !c.evidence.startsWith("https://")) {
    mkdirSync(join(root, c.evidence.replace(/#.*$/u, ""), ".."), { recursive: true });
    writeFileSync(join(root, c.evidence.replace(/#.*$/u, "")), "");
  }
  assert.equal(syncFrontDoors(root, false).status, "current");
  // A hand edit inside the README block is stale; sync rewrites it.
  const readme = join(root, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replace("**Every claim comes with a receipt.**", "**A hand-written promise.**"));
  assert.deepEqual(syncFrontDoors(root, false), { allCurrent: false, status: "stale", changed: ["README.md"], problems: [] });
  assert.equal(syncFrontDoors(root, true).status, "regenerated");
  assert.equal(syncFrontDoors(root, false).status, "current");
  // A claim citing a proof the tree does not hold is refused (the PR that deletes a cited proof).
  const proof = claims.claims.find((c) => typeof c.evidence === "string" && !c.evidence.startsWith("https://"))!.evidence!;
  writeFileSync(join(root, "docs/brand/claims.json"), JSON.stringify({ ...claims, claims: claims.claims.map((c) => (c.evidence === proof ? { ...c, evidence: "tests/deleted.test.ts" } : c)) }));
  const refused = syncFrontDoors(root, false);
  assert.equal(refused.status, "refused");
  assert.equal(refused.problems.length, 1);
  assert.ok(refused.problems[0]!.startsWith("claims_register_invalid: ") && refused.problems[0]!.includes("tests/deleted.test.ts"), refused.problems[0]);
  // A messaging source that drops the developer-preview line is refused.
  writeFileSync(join(root, "docs/brand/claims.json"), JSON.stringify(claims));
  const messaging = JSON.parse(readFileSync(join(root, "docs/brand/messaging.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(root, "docs/brand/messaging.json"), JSON.stringify({ ...messaging, status: "Production-ready." }));
  const unhonest = syncFrontDoors(root, false).problems;
  assert.ok(unhonest.length === 1 && unhonest[0]!.startsWith("messaging_source_invalid: ") && unhonest[0]!.includes("status must say it is a developer preview"), unhonest.join("\n"));
  // A front door that lost its markers is refused, never skipped.
  writeFileSync(join(root, "docs/brand/messaging.json"), JSON.stringify(messaging));
  writeFileSync(readme, "# A README without its block\n");
  assert.deepEqual(syncFrontDoors(root, false).problems, [`README.md carries no single generated block between "${FRONT_DOORS[0]!.begin}" and "${FRONT_DOORS[0]!.end}"`]);
  // A page with two blocks keeps both: setting one never undoes the other.
  writeFileSync(readme, readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8"));
  assert.equal(syncFrontDoors(root, false).status, "current");
});
