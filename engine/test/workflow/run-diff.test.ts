/**
 * THE RUN DIFF (`src/shared/run-history.ts` `diffRunFailures`,
 * `scripts/tooling/run-diff.ts`): new / persisting / changed / fixed between
 * two judged runs of a ledger, `unmeasured` for a run that recorded no
 * failure list; each side named by index or by its recorded timestamp, with
 * its identity (tree, conditions, where the row came from); strict arguments.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { ledgerSuite, runDiff } from "../../scripts/tooling/run-diff.ts";
import { appendJudgedRun, currentQualificationOutcome, finalizeQualifiedRun, parseRunQualification, qualificationInvocation, qualificationTerminal, runForInvocation, QUALIFICATION_INVOCATION_ENV, failureDigest, failureLocation, latestRunOfTree, normalizedFailureText, readRunHistory, WEB_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import { commandTerminalFacts, commandTerminalOutcome, parseCommandTerminalFacts, supervisedCommandOutcome, TEST_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import { fixtureSupervisedCommand } from "../workspaces/workspace-test-support.ts";
import type { RunQualification, RunQualificationTerminal } from "../../src/shared/budget-verdict.ts";
import { createTempDir, systemTempRoot } from "../support/temp-dir.ts";
import { mutationRunMark } from "../../src/shared/tree-identity.ts";

const row = (timestamp: string, failures?: readonly string[], extra: Readonly<Record<string, unknown>> = {}) =>
  ({ timestamp, cpuMsPerTestFile: 4000, testModuleCount: 466, ...(failures === undefined ? {} : { failures }), ...extra });

test("two ledgers' rows diff into new, persisting and fixed; a row with no failure list is unmeasured", () => {
  const dir = createTempDir("run-diff-");
  const baseline = join(dir, "baseline.json");
  const current = join(dir, "current.json");
  writeFileSync(baseline, JSON.stringify({ runs: [row("t0", ["a::x", "b::y"])] }));
  writeFileSync(current, JSON.stringify({ runs: [row("t1", ["b::y", "c::z"]), row("t2")] }));
  const compared = JSON.parse(runDiff(["--baseline", baseline, "--current", `${current}#0`])) as { diff: Record<string, unknown> };
  assert.deepEqual(compared.diff, { verdict: "compared", new: ["c::z"], persisting: ["b::y"], changed: [], fixed: ["a::x"] });
  const vacuous = JSON.parse(runDiff(["--baseline", baseline, "--current", current])) as { diff: Record<string, unknown> };
  assert.equal(vacuous.diff["verdict"], "unmeasured", "a row with no failure list was read as all fixed");
  assert.throws(() => runDiff(["--baseline", `${baseline}#5`, "--current", current]), (error: unknown) => (error as { code?: string }).code === "run_diff_row_missing");
});

test("a persisting identity that fails DIFFERENTLY is `changed`; an equal or missing digest is not (FIX1-RUN-DIFF-CHANGED)", () => {
  const dir = createTempDir("run-diff-changed-");
  const ledger = join(dir, "ledger.json");
  const failures = ["guard::offenders", "same::message", "undigested::row"];
  writeFileSync(ledger, JSON.stringify({ runs: [
    row("t0", failures, { failureDigests: { "guard::offenders": failureDigest({ message: "1 offender: a.ts" }, dir), "same::message": failureDigest({ message: "took 10ms" }, dir) } }),
    row("t1", failures, { failureDigests: { "guard::offenders": failureDigest({ message: "3 offenders: a.ts, b.ts, c.ts" }, dir), "same::message": failureDigest({ message: "took 99ms" }, dir) } }),
  ] }));
  const { diff } = JSON.parse(runDiff(["--baseline", `${ledger}#0`, "--current", `${ledger}#1`])) as { diff: Record<string, unknown> };
  assert.deepEqual(diff["changed"], ["guard::offenders"]);
  assert.deepEqual(diff["persisting"], [...failures].sort());
  assert.deepEqual(diff["new"], []);
});

test("the digest masks what moves between runs of ONE failure — ids, temp folders, the checkout root — and keeps what differs (WF-1b3b verify M3)", () => {
  const rootA = "/home/u/.local/state/cand-a/repo";
  const rootB = "/home/u/.local/state/verify-b/repo";
  // Two real web messages of the same persisting failure, one per run.
  const one = { name: "AssertionError", message: "run run-df8743cc-4532-4f1a-9c2b-0e1d2c3b4a59 accepted for 354795ec-aa12-4b3c-8d9e-0f1a2b3c4d5e at /home/u/.local/state/cand-a/repo/server/db/x.ts:12 in " + join(systemTempRoot(), "ch-guard-Ab12Cd", "f.json") };
  const two = { name: "AssertionError", message: "run run-87b2625d-1111-4222-8333-944455556666 accepted for 0f0f0f0f-aaaa-4bbb-8ccc-dddddddddddd at /home/u/.local/state/verify-b/repo/server/db/x.ts:98 in " + join(systemTempRoot(), "ch-guard-Zz99Yy", "f.json") };
  assert.equal(failureDigest(one, rootA), failureDigest(two, rootB), "the same failure in two runs digested differently");
  assert.equal(normalizedFailureText({ message: "nonce deadbeef00112233 took 12ms" }, rootA), ": nonce <hex> took #ms");
  // A byte delta changes sign and length between runs; a digest is hex with letters (two real rewind-test rows, r1 #1 vs #2).
  assert.equal(normalizedFailureText({ message: '"heapDeltaBytes":-123456789,"chainHash":"3bb0a1f9e"' }, rootA), normalizedFailureText({ message: '"heapDeltaBytes":45678,"chainHash":"e5c2af07cb"' }, rootA));
  assert.notEqual(failureDigest(one, rootA), failureDigest({ ...one, message: one.message.replace("accepted", "refused") }, rootA), "a different statement must digest differently");
  assert.notEqual(failureDigest(one, rootA), failureDigest({ ...one, name: "TypeError" }, rootA));
});

test("WHERE A FAILURE HAPPENED is kept beside what it said: the operator and the names of its test file's own frames (never line numbers, never other files' frames); the same message from another place is `changed` (design NH-D)", () => {
  const stack = (fn: string, line: number) => [
    "AssertionError: expected 1 to be 2",
    `    at ${fn} (/home/u/repo/engine/test/x.test.ts:${String(line)}:5)`,
    "    at helper (/home/u/repo/engine/src/elsewhere.ts:3:1)",
    `    at async TestContext.<anonymous> (file:///home/u/repo/engine/test/x.test.ts:${String(line + 40)}:3)`,
  ].join("\n");
  const here = failureLocation({ message: "m", stack: stack("checksTheCount", 10), operator: "strictEqual" }, "test/x.test.ts");
  assert.match(here ?? "", /^[0-9a-f]{16}$/u);
  assert.equal(failureLocation({ message: "m", stack: stack("checksTheCount", 99), operator: "strictEqual" }, "test/x.test.ts"), here, "an edit above the test moves lines, not the place");
  assert.notEqual(failureLocation({ message: "m", stack: stack("checksTheOrder", 10), operator: "strictEqual" }, "test/x.test.ts"), here, "another function is another place");
  assert.notEqual(failureLocation({ message: "m", stack: stack("checksTheCount", 10), operator: "deepStrictEqual" }, "test/x.test.ts"), here, "another operator is another assertion");
  assert.equal(failureLocation({ message: "m", stack: "Error: timeout" }, "test/x.test.ts"), null, "no frame of the test's file and no operator: no place");
  assert.equal(failureLocation({ message: "m", stack: stack("checksTheCount", 10) }, "test/y.test.ts"), null, "only the failing test's own file counts");
  const dir = createTempDir("run-diff-location-");
  const ledger = join(dir, "ledger.json");
  const failures = ["x::moved", "x::same", "x::unrecorded"];
  const digest = failureDigest({ message: "expected 1 to be 2" }, dir);
  writeFileSync(ledger, JSON.stringify({ runs: [
    row("t0", failures, { failureDigests: Object.fromEntries(failures.map((id) => [id, digest])), failureLocations: { "x::moved": "1111111111111111", "x::same": "2222222222222222" } }),
    row("t1", failures, { failureDigests: Object.fromEntries(failures.map((id) => [id, digest])), failureLocations: { "x::moved": "3333333333333333", "x::same": "2222222222222222", "x::unrecorded": "4444444444444444" } }),
  ] }));
  const { diff } = JSON.parse(runDiff(["--baseline", `${ledger}#0`, "--current", `${ledger}#1`])) as { diff: Record<string, unknown> };
  assert.deepEqual(diff["changed"], ["x::moved"], "the same message from another place fails differently; a place one side did not record is not compared");
});

test("rows of different suites are refused: an engine ledger against a web ledger shares no identities (WF-1b3b verify L3)", () => {
  const dir = createTempDir("run-diff-suites-");
  const engineLedger = join(dir, "engine", TEST_RUN_HISTORY_PATH);
  const webLedger = join(dir, WEB_RUN_HISTORY_PATH);
  for (const ledger of [engineLedger, webLedger]) {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, JSON.stringify({ runs: [row("t0", ["a::x"])] }));
  }
  assert.equal(ledgerSuite(engineLedger), "engine");
  assert.equal(ledgerSuite(webLedger), "web");
  assert.equal(ledgerSuite(join(dir, "ledger.json")), undefined);
  assert.throws(() => runDiff(["--baseline", engineLedger, "--current", webLedger]), (error: unknown) => (error as { code?: string }).code === "run_diff_usage");
  const same = JSON.parse(runDiff(["--baseline", webLedger, "--current", webLedger])) as Record<string, Record<string, unknown>>;
  assert.equal(same["baseline"]!["suite"], "web");
});

test("a row is named by its recorded timestamp; each side says which tree, which conditions and where the row came from", () => {
  const dir = createTempDir("run-diff-identity-");
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ runs: [
    row("2026-09-30T10:00:00.000Z", [], { headSha: "a".repeat(40), ambientLoad5PerCpu: 0.5 }),
    row("2026-09-30T11:00:00.000Z", [], { importedFrom: "/cand/repo", provisionalFailures: true, mutationRun: true }),
    row("2026-09-30T12:00:00.000Z", []),
  ] }));
  const out = JSON.parse(runDiff(["--baseline", `${ledger}@2026-09-30T10:00:00.000Z`, "--current", `${ledger}@2026-09-30T11:00:00.000Z`])) as Record<string, Record<string, unknown>>;
  assert.equal(out["baseline"]!["index"], 0);
  assert.equal(out["baseline"]!["headSha"], "a".repeat(40));
  assert.equal(out["baseline"]!["load5PerCpu"], 0.5);
  assert.equal(out["baseline"]!["environment"], "this ledger's checkout");
  assert.equal(out["current"]!["index"], 1);
  assert.equal(out["current"]!["environment"], "imported from /cand/repo");
  assert.ok(typeof out["current"]!["provisional"] === "string" && typeof out["current"]!["mutation"] === "string");
  const latest = JSON.parse(runDiff(["--baseline", `${ledger}#-1`, "--current", ledger])) as Record<string, Record<string, unknown>>;
  assert.equal(latest["baseline"]!["index"], 2, "a negative index is reported as the row it names");
  assert.throws(() => runDiff(["--baseline", `${ledger}@2026-01-01T00:00:00.000Z`, "--current", ledger]), (error: unknown) => (error as { code?: string }).code === "run_diff_row_missing");
});

test("arguments are strict: an unknown flag, a missing side, an empty or non-integer index are refusals, never a default", () => {
  const dir = createTempDir("run-diff-strict-");
  const ledger = join(dir, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ runs: [row("t0", [])] }));
  const usage = (error: unknown): boolean => (error as { code?: string }).code === "run_diff_usage";
  assert.throws(() => runDiff(["--baseline", ledger, "--current", ledger, "--verbose"]), usage);
  assert.throws(() => runDiff(["--baseline", ledger]), usage);
  assert.throws(() => runDiff(["--baseline", `${ledger}#`, "--current", ledger]), usage, "`path#` must not select row 0");
  assert.throws(() => runDiff(["--baseline", `${ledger}#1.5`, "--current", ledger]), usage);
  assert.throws(() => runDiff(["--baseline", ledger, "--current", ledger, "extra"]), usage);
});

test("the latest run of a tree is chosen by the TREE a row names and by its TIMESTAMP, never by its place in the file; a mutation run or a row that names no tree is no run of it (WF-1b3c-FIX MED-2, N8)", () => {
  const ledger = join(createTempDir("run-of-tree-"), "ledger.json");
  const tree = "a".repeat(40);
  writeFileSync(ledger, JSON.stringify({ runs: [
    row("2026-10-01T00:00:02.000Z", ["late::x"], { treeId: tree }),
    // Appended after it (an import), older by its timestamp.
    row("2026-10-01T00:00:01.000Z", ["imported::y"], { treeId: tree, importedFrom: "/candidate" }),
    row("2026-10-01T00:00:03.000Z", ["mutant::z"], { treeId: tree, mutationRun: true }),
    row("2026-10-01T00:00:04.000Z", ["unnamed::w"], { headSha: "b".repeat(40) }),
    row("2026-10-01T00:00:05.000Z", ["other::v"], { treeId: "c".repeat(40) }),
  ] }));
  const rows = readRunHistory(ledger);
  assert.deepEqual(latestRunOfTree(rows, tree)?.failures, ["late::x"]);
  assert.deepEqual(latestRunOfTree(rows, tree, Date.parse("2026-10-01T00:00:02.000Z"))?.failures, ["imported::y"], "strictly before `before`");
  assert.equal(latestRunOfTree(rows, "d".repeat(40)), undefined);
});

/** Complete typed controls: the same real parser/ledger/admission owns all variants. */
function qualifiedFixture(failures: readonly string[] = []) {
  const invocationId = qualificationInvocation({});
  const treeId = "a".repeat(40);
  const terminal = qualificationTerminal(invocationId, treeId, fixtureSupervisedCommand(failures.length > 0 ? 1 : 0));
  const qualification: RunQualification = { schemaVersion: 1, invocationId, treeId, producer: "web", producerComplete: true,
    outcomes: [{ gate: "per-file-pool-share", kind: "pass", message: "measured within the share limit" }], terminal };
  const current = row("2026-10-03T00:00:00.000Z", failures, { treeId, qualification });
  return { current, qualification, expected: { invocationId, treeId, producer: "web" as const, outer: terminal } };
}

test("current qualification preserves legacy exact-tree test references without inventing current proof", () => {
  const fixture = qualifiedFixture(["file::owned"]);
  const ledger = join(createTempDir("qualification-legacy-"), "ledger.json");
  writeFileSync(ledger, JSON.stringify({ runs: [row("2026-10-02T00:00:00.000Z", ["file::owned"], { treeId: fixture.expected.treeId })] }));
  const legacy = readRunHistory(ledger)[0]!;
  assert.deepEqual(latestRunOfTree([legacy], fixture.expected.treeId)?.failures, ["file::owned"]);
  assert.equal(currentQualificationOutcome(legacy, fixture.expected).kind, "fail");
  const report = JSON.parse(runDiff(["--baseline", ledger, "--current", ledger]));
  assert.equal(report.current.qualification, null);
  assert.match(report.current.evidenceClaim, /historical test reference only/u);
});

test("current qualification parses actual enums and exact Git object names before admission", () => {
  const fixture = qualifiedFixture();
  const ledger = join(createTempDir("qualification-malformed-"), "ledger.json");
  for (const kind of [["fail"], { kind: "fail" }, null, 0, "failure"]) {
    const qualification = { ...fixture.qualification, outcomes: [{ gate: "per-file-pool-share", kind, message: "an independent failure" }] };
    assert.equal(parseRunQualification(qualification), undefined, JSON.stringify(kind));
    writeFileSync(ledger, JSON.stringify({ runs: [{ ...fixture.current, qualification }] }));
    assert.equal(currentQualificationOutcome(readRunHistory(ledger)[0], fixture.expected).kind, "fail", "malformed FAIL cannot become a passing current result");
  }
  for (const length of [39, 41, 48, 63, 65]) assert.equal(parseRunQualification({ ...fixture.qualification, treeId: "a".repeat(length) }), undefined);
  for (const length of [40, 64]) assert.notEqual(parseRunQualification({ ...fixture.qualification, treeId: "a".repeat(length) }), undefined);
  assert.throws(() => qualificationInvocation({ [QUALIFICATION_INVOCATION_ENV]: "borrow-the-previous-run" }), /invalid qualification invocation/u);
});

test("C3-S2: current failure census refuses malformed rows before tolerant historical normalization", () => {
  const fixture = qualifiedFixture(["file::owned"]);
  const empty = qualifiedFixture();
  const ledger = join(createTempDir("qualification-census-"), "ledger.json");
  const valid = { ...fixture.current, failureDigests: { "file::owned": "known-digest" } };
  writeFileSync(ledger, JSON.stringify({ runs: [valid] }));
  assert.equal(currentQualificationOutcome(runForInvocation(ledger, fixture.expected.invocationId), fixture.expected).kind, "pass");
  // Missing diagnostic digests remain legitimate; missing failure census does not.
  writeFileSync(ledger, JSON.stringify({ runs: [fixture.current] }));
  assert.equal(currentQualificationOutcome(runForInvocation(ledger, fixture.expected.invocationId), fixture.expected).kind, "pass");
  const cases: readonly [string, Record<string, unknown>, typeof fixture.expected][] = [
    ["missing", { ...empty.current, failures: undefined }, empty.expected],
    ["nonarray", { ...empty.current, failures: {} }, empty.expected],
    ["mixed-null", { ...valid, failures: ["file::owned", null] }, fixture.expected],
    ["empty-name", { ...valid, failures: ["file::owned", ""] }, fixture.expected],
    ["duplicate", { ...valid, failures: ["file::owned", "file::owned"] }, fixture.expected],
    ["digest-null", { ...valid, failureDigests: { "file::owned": "known-digest", other: null } }, fixture.expected],
    ["digest-nonobject", { ...valid, failureDigests: [] }, fixture.expected],
    ["digest-empty", { ...valid, failureDigests: { "file::owned": "" } }, fixture.expected],
    ["digest-unowned", { ...valid, failureDigests: { other: "unowned-digest" } }, fixture.expected],
  ];
  const wronglyAdmitted: string[] = [];
  for (const [name, current, expected] of cases) {
    writeFileSync(ledger, JSON.stringify({ runs: [current] }));
    assert.equal(readRunHistory(ledger).length, 1, `${name}: numeric history keeps its existing tolerance`);
    for (const [reader, row] of [["current", runForInvocation(ledger, expected.invocationId)], ["history", readRunHistory(ledger)[0]]] as const) {
      if (currentQualificationOutcome(row, expected).kind !== "fail") wronglyAdmitted.push(`${name}:${reader}`);
    }
  }
  assert.deepEqual(wronglyAdmitted, [], "current qualification must not erase malformed census entries");
});

test("complete current outcomes retain FAIL alongside owned test failures while NOT JUDGED remains disclosed", () => {
  for (const failures of [[], ["file::owned"]]) {
    const fixture = qualifiedFixture(failures);
    for (const kind of ["pass", "not-judged", "fail"] as const) {
      const current = { ...fixture.current, qualification: { ...fixture.qualification,
        outcomes: [{ gate: "per-file-pool-share", kind, message: "the actual producer outcome" }] } };
      const result = currentQualificationOutcome(current, fixture.expected);
      assert.equal(result.kind, kind === "fail" ? "fail" : "pass");
      assert.match(result.message, kind === "fail" ? /current non-test gate failed: per-file-pool-share/u : /per-file-pool-share=/u);
    }
  }
});

test("current qualification requires both exact terminal boundaries and accounts every exit", () => {
  const fixture = qualifiedFixture(["file::owned"]);
  assert.equal(currentQualificationOutcome(fixture.current, fixture.expected).kind, "pass");
  // Real marker, append and read: private ordinary fixtures must not weaken
  // the rejection of an actual deliberately marked qualification.
  for (const mutation of [false, true]) {
    const ledger = join(createTempDir("qualification-mutation-"), "ledger.json");
    appendJudgedRun({ ...fixture.current, ...mutationRunMark(mutation ? { HARNESS_MUTATION_RUN: "1" } : {}) }, ledger);
    const recorded = runForInvocation(ledger, fixture.expected.invocationId);
    assert.equal(recorded?.mutation, mutation ? true : undefined, "the real mutation provenance survives publication and normalization");
    const admission = currentQualificationOutcome(recorded, fixture.expected);
    assert.equal(admission.kind, mutation ? "fail" : "pass", "current admission distinguishes ordinary and deliberate mutation runs");
    if (mutation) assert.equal(admission.message, "current qualification identity does not match this invocation/tree/producer");
  }
  const mutations: readonly Partial<RunQualificationTerminal>[] = [
    { ending: "stalled" }, { ending: "ceiling" }, { ending: "stopped" }, { ending: "signal" },
    { ending: "unverified" }, { ending: "launcher-exited" }, { outputComplete: false },
    { receiptPresent: false }, { noOwnedChildren: false }, { timedOut: true }, { interrupted: true },
    { commandKilled: true }, { killedDescendants: 1 }, { orphanedGroupKilled: true },
    { signal: "SIGTERM" }, { status: 2 }, { exitCode: 2, status: 2 }, { exitCode: 0, status: 0 },
    { invocationId: qualificationInvocation({}) }, { treeId: "b".repeat(40) },
  ];
  for (const delta of mutations) {
    const terminal = { ...fixture.expected.outer, ...delta };
    assert.equal(currentQualificationOutcome(fixture.current, { ...fixture.expected, outer: terminal }).kind, "fail", `outer ${JSON.stringify(delta)}`);
    assert.equal(currentQualificationOutcome({ ...fixture.current, qualification: { ...fixture.qualification, terminal } }, fixture.expected).kind, "fail", `inner ${JSON.stringify(delta)}`);
  }
  assert.equal(currentQualificationOutcome(fixture.current, { ...fixture.expected, outer: undefined }).kind, "fail");
  const { terminal: _terminal, ...unfinished } = fixture.qualification;
  assert.equal(currentQualificationOutcome({ ...fixture.current, qualification: unfinished }, fixture.expected).kind, "fail");
  assert.equal(currentQualificationOutcome({ ...fixture.current, qualification: { ...fixture.qualification, producerComplete: false } }, fixture.expected).kind, "fail");
  assert.equal(currentQualificationOutcome({ ...fixture.current, failures: [] }, fixture.expected).kind, "fail", "exit1 without accounted tests is not completion");
});

test("shared command terminal facts validate stored shapes without inventing native proof", () => {
  // Typed parser controls, not an assertion that a native process was observed.
  const facts = commandTerminalFacts(fixtureSupervisedCommand(0));
  assert.deepEqual(parseCommandTerminalFacts(JSON.parse(JSON.stringify(facts))), facts);
  assert.equal(commandTerminalOutcome(parseCommandTerminalFacts(facts), "fixture", 0).kind, "pass");
  assert.equal(commandTerminalOutcome(null, "fixture", 0).message, "fixture has no terminal proof");
  const malformed: readonly unknown[] = [undefined, null, [], {}, { ...facts, unobservedClaim: true },
    { ...facts, ending: "finished" }, { ...facts, exitCode: "0" }, { ...facts, exitCode: 0.5 },
    { ...facts, status: "0" }, { ...facts, status: 0.5 }, { ...facts, signal: false },
    { ...facts, killedDescendants: -1 }, { ...facts, killedDescendants: 0.5 },
    { ...facts, killedDescendants: "0" },
  ];
  for (const value of malformed) {
    assert.equal(parseCommandTerminalFacts(value), undefined, JSON.stringify(value));
    assert.equal(commandTerminalOutcome(parseCommandTerminalFacts(value), "fixture").kind, "fail");
  }
  for (const key of ["outputComplete", "receiptPresent", "noOwnedChildren", "timedOut", "interrupted", "commandKilled", "orphanedGroupKilled"] as const) {
    for (const value of [undefined, null, 0, "false"]) {
      assert.equal(parseCommandTerminalFacts({ ...facts, [key]: value }), undefined, `${key}:${String(value)}`);
    }
  }
  const noReceipt = commandTerminalFacts({ ...fixtureSupervisedCommand(0), supervision: undefined });
  assert.equal(noReceipt.receiptPresent, false);
  assert.equal(commandTerminalOutcome(parseCommandTerminalFacts(noReceipt), "fixture", 0).kind, "fail");
});

test("shared native completion accepts ordinary exit1 and preserves raw versus policy exit", () => {
  for (const exitCode of [0, 1]) {
    const run = fixtureSupervisedCommand(exitCode);
    const facts = parseCommandTerminalFacts(commandTerminalFacts(run));
    assert.equal(commandTerminalOutcome(facts, "fixture", exitCode).kind, "pass");
    assert.deepEqual(supervisedCommandOutcome(run, "fixture", exitCode), commandTerminalOutcome(facts, "fixture", exitCode));
    assert.equal(commandTerminalOutcome(facts, "fixture", exitCode === 0 ? 1 : 0).message,
      "fixture terminal exit does not match its reported command result");
  }
  const healthy = commandTerminalFacts(fixtureSupervisedCommand(0));
  for (const delta of [{ killedDescendants: 1 }, { noOwnedChildren: false }, { outputComplete: false },
    { receiptPresent: false }, { commandKilled: true }, { orphanedGroupKilled: true },
    { timedOut: true }, { interrupted: true }, { status: null }, { signal: "SIGTERM" }]) {
    assert.equal(commandTerminalOutcome(parseCommandTerminalFacts({ ...healthy, ...delta }), "fixture", 0).message,
      "fixture did not complete normally with complete output and clean descendant teardown", JSON.stringify(delta));
  }
});

test("qualification finalization binds exactly one unfinished row and refuses missing duplicate or conflicting identities", () => {
  const fixture = qualifiedFixture(["file::owned"]);
  const ledger = join(createTempDir("qualification-finalize-"), "ledger.json");
  const { terminal: _terminal, ...unfinished } = fixture.qualification;
  assert.throws(() => finalizeQualifiedRun(ledger, fixture.expected.invocationId, fixture.expected.treeId, fixture.expected.outer), /one unfinished matching/u);
  appendJudgedRun({ ...fixture.current, qualification: unfinished }, ledger);
  assert.equal(currentQualificationOutcome(runForInvocation(ledger, fixture.expected.invocationId), fixture.expected).kind, "fail", "append cannot claim future wrapper completion");
  finalizeQualifiedRun(ledger, fixture.expected.invocationId, fixture.expected.treeId, fixture.expected.outer);
  assert.equal(currentQualificationOutcome(runForInvocation(ledger, fixture.expected.invocationId), fixture.expected).kind, "pass");
  const before = readFileSync(ledger);
  assert.throws(() => finalizeQualifiedRun(ledger, fixture.expected.invocationId, fixture.expected.treeId, fixture.expected.outer), /one unfinished matching/u);
  assert.deepEqual(readFileSync(ledger), before, "a conflicting finalization never rewrites the record");
  appendJudgedRun({ ...fixture.current, qualification: unfinished }, ledger);
  assert.equal(runForInvocation(ledger, fixture.expected.invocationId), undefined, "duplicate invocation is not latest-wins");
  assert.throws(() => finalizeQualifiedRun(ledger, fixture.expected.invocationId, fixture.expected.treeId, fixture.expected.outer), /one unfinished matching/u);
});
