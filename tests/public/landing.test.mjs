// The landing filled at publish (scripts/floor/landing.ts): every block from
// its source, the refusal struck with its claim, every string escaped where it
// lands, the shell carrying each block once, and every refusal planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { certificateBlock, fillLanding, LANDING_BLOCKS, LandingRefusal, landingMarkers, ledgerBlock, nameBlock, readingsBlock, refusalBlock, roadmapBlock, runBlock, runRefusal } from "../../scripts/floor/landing.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);

const claim = (id, kind, extra = {}) => ({ claim: { id, kind, text: `${id} text`, ...extra }, verdict: kind === "holds-when-green" ? "holds" : kind, checks: [] });
const JUDGED = [
  { ...claim("typed-refusals", "holds-when-green", { checks: ["ci"], evidence: "tests/public/cli.test.mjs" }), verdict: "retracted", checks: [{ id: "ci", status: "fail", runUrl: "https://example.test/run/1" }] },
  { ...claim("codeql-runs", "holds-when-green", { checks: ["codeql"], evidence: null }), verdict: "holds", checks: [{ id: "codeql", status: "pass", runUrl: null }] },
  claim("memory-layers", "designed", { decision: "MEM-DIR" }),
  claim("signed-releases", "not-claimed", { reason: "no signature yet", evidence: null }),
];
const CHECKS = [
  { id: "ci", label: "CI", required: true, status: "fail", headSha: COMMIT, runUrl: "https://example.test/run/1", jobs: [{ name: "Engine suite", status: "completed", conclusion: "failure", url: "https://example.test/job/1" }, { name: "Typecheck, public tests, build", status: "completed", conclusion: "success", url: null }] },
  { id: "codeql", label: "CodeQL", required: true, status: "pass", headSha: OTHER, runUrl: null, jobs: [] },
  { id: "pages", label: "Pages", required: false, status: "pass", headSha: COMMIT, runUrl: null, jobs: null },
];
const DECISIONS = new Map([["MEM-DIR", { implementation: "pending", path: "docs/decisions/MEM-DIR.md" }]]);
const dom = (html) => new JSDOM(`<body>${html}</body>`).window.document;

test("the certificate counts every verdict it holds and names the judged commit", () => {
  const doc = dom(certificateBlock(JUDGED, COMMIT, "2026-10-29T06:00:00.000Z"));
  const tally = Object.fromEntries([...doc.querySelectorAll(".tally li")].map((li) => [li.dataset.verdict, Number(li.querySelector(".n").textContent)]));
  assert.deepEqual(tally, { holds: 1, retracted: 1, designed: 1, "not-claimed": 1 }, "a verdict nobody holds (not checked) is not listed");
  assert.equal(doc.querySelector(".total .n").textContent, "4");
  assert.match(doc.querySelector(".serial").textContent, /aaaaaaaa/u);
  assert.match(doc.querySelector(".stamp").textContent, /2026-10-29/u);
});

test("the ledger strikes nothing by itself: each row carries its verdict, its bound check by its label, and its evidence", () => {
  const doc = dom(ledgerBlock(JUDGED, CHECKS, DECISIONS));
  const rows = [...doc.querySelectorAll("tbody tr")];
  assert.deepEqual(rows.map((row) => row.dataset.verdict), ["retracted", "holds", "designed", "not-claimed"]);
  assert.match(rows[0].querySelector(".bound").textContent, /^CI/u);
  assert.match(rows[0].querySelector(".evidence").textContent, /tests\/public\/cli\.test\.mjs/u);
  assert.equal(rows[0].querySelector("a.run").getAttribute("href"), "https://example.test/run/1");
  assert.match(rows[2].querySelector(".bound").textContent, /MEM-DIR/u);
  assert.throws(() => ledgerBlock([claim("ghost", "designed", { decision: "NOPE" })], CHECKS, DECISIONS), (error) => error instanceof LandingRefusal && error.code === "landing_decision_missing");
});

test("the refusal stands under typed-refusals: retracted, it is struck with its claim", () => {
  const refusal = { error: "no_harness_subcommand", message: "a harness subcommand is required (check, test)", available: ["check", "test"] };
  const doc = dom(refusalBlock(refusal, JUDGED));
  assert.equal(doc.querySelector(".refusal").dataset.verdict, "retracted");
  assert.equal(doc.querySelector(".code-word").textContent, "no_harness_subcommand");
  assert.equal(doc.querySelector(".answer pre").textContent, refusal.message);
  assert.throws(() => refusalBlock(refusal, JUDGED.slice(1)), (error) => error instanceof LandingRefusal && error.code === "landing_refusal_unclaimed");
});

test("the refusal is the harness's own answer, run from this checkout through the one bounded run", async () => {
  const refusal = await runRefusal(ROOT);
  assert.equal(refusal.error, "no_harness_subcommand");
  assert.ok(refusal.available.includes("check") && refusal.available.length > 5);
  assert.ok(refusal.message.includes(refusal.available.join(", ")), "the sentence lists every verb it reports");
});

test("the readings show every required check job by job, and say when a run is elsewhere or its jobs were not read", () => {
  const doc = dom(readingsBlock(CHECKS, COMMIT));
  const text = doc.body.textContent;
  assert.match(text, /Engine suite/u);
  assert.equal(doc.querySelectorAll(".result[data-state='fail']").length, 1);
  assert.equal(doc.querySelectorAll(".result[data-state='pass']").length, 1);
  assert.match(text, /another commit/u, "a run at another commit is not a reading of this one");
  assert.doesNotMatch(text, /Pages/u, "a check that is not required is not a station");
  assert.throws(() => readingsBlock([CHECKS[2]], COMMIT), (error) => error instanceof LandingRefusal && error.code === "landing_checks_missing");
});

test("the run, the roadmap and the name come from their sources", () => {
  const record = JSON.parse(readFileSync(join(ROOT, "docs/run/run-record.json"), "utf8"));
  const run = dom(runBlock(record));
  assert.equal(run.querySelectorAll(".beat").length, record.beats.length);
  assert.match(run.querySelector(".synthetic").textContent, /Illustrative/u);
  const roadmap = dom(roadmapBlock({ total: 10, tally: { shipped: 0, claimed: 4, "in progress": 1, planned: 4, blocked: 1, "not planned": 0 }, notPlanned: 3 }));
  assert.equal(roadmap.querySelector(".big .n").textContent, "0 of 10");
  assert.match(roadmap.querySelector("figcaption").textContent, /3 more not planned/u);
  const messaging = JSON.parse(readFileSync(join(ROOT, "docs/brand/messaging.json"), "utf8"));
  const name = dom(nameBlock({ about: messaging.about }));
  assert.equal(name.querySelector(".headword").firstChild.textContent, messaging.about.word);
  assert.equal(name.querySelector(".line").textContent, messaging.about.line);
});

test("every string a block carries is escaped where it lands", () => {
  const evil = '<script>alert(1)</script>"';
  const judged = [{ ...claim("typed-refusals", "holds-when-green", { checks: ["ci"], evidence: evil }), checks: [{ id: "ci", status: "pass", runUrl: null }] }];
  const checks = [{ ...CHECKS[0], label: evil, jobs: [{ name: evil, status: "completed", conclusion: "success", url: null }] }];
  for (const html of [ledgerBlock(judged, checks, DECISIONS), refusalBlock({ error: evil, message: evil, available: [] }, judged), readingsBlock(checks, COMMIT)]) {
    const doc = dom(html);
    assert.equal(doc.querySelectorAll("script").length, 0);
    assert.ok(doc.body.textContent.includes(evil), "the text reads as itself");
  }
});

test("the shell carries every block once; a missing or repeated block refuses", () => {
  const shell = readFileSync(join(ROOT, "docs/index.md"), "utf8");
  const blocks = Object.fromEntries(LANDING_BLOCKS.map((block) => [block, `<p>${block} filled</p>`]));
  const filled = fillLanding(shell, blocks);
  for (const block of LANDING_BLOCKS) assert.ok(filled.includes(`<p>${block} filled</p>`), block);
  const { begin } = landingMarkers("ledger");
  assert.throws(() => fillLanding(shell.replace(begin, ""), blocks), (error) => error instanceof LandingRefusal && error.code === "landing_shell_invalid");
  assert.throws(() => fillLanding(`${shell}\n${begin}\n${landingMarkers("ledger").end}\n`, blocks), (error) => error instanceof LandingRefusal && error.code === "landing_shell_invalid");
});
