/**
 * MAIN-RED (src/workflow/forge/projector/main-runs.ts and project.ts, runbook
 * P5.5): main's health per workflow is the LAST judged run on main in the
 * ledger; a red one is ONE open, pinned issue per workflow naming every failing
 * test and the open records that own it (or UNOWNED), closed and unpinned once
 * main is green again — never one issue per failed run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { LABELS_PATH } from "../../src/workflow/community/labels.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import type { TreeReader } from "../../src/git/tree-reader.ts";
import { applyProjection } from "../../src/workflow/forge/projector/apply.ts";
import { LEDGER_MAIN_RUNS, mainHealth } from "../../src/workflow/forge/projector/main-runs.ts";
import { ISSUE_BODY_LIMIT, PROJECTION_INPUT_SCHEMA, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { escapeGithubText } from "../../../shared/markup.ts";
import { computeProjection, projectionInput } from "../../src/workflow/forge/projector/projection.ts";
import type { ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import { memoryStore } from "./projection-store.ts";

/** Every projection here runs confined: this engine's guardian, an empty keep-out registry of the test's own. */
const CONFINEMENT: ProjectorConfinement = { harnessRoot: join(import.meta.dirname, "..", ".."), keepOut: emptyKeepOutFacts(), cpuSeconds: 60, memoryBytes: 1_610_612_736 };
const RED = "a".repeat(40);
const GREEN = "b".repeat(40);
const run = (workflow: string, commit: string, conclusion: "success" | "failure", failedTests: { path: string; message: string }[] = []): string =>
  JSON.stringify({ schema: LEDGER_MAIN_RUNS.schema, workflow, commit, conclusion, runUrl: "https://github.com/owner/repo/actions/runs/1", failedTests });
/** Main's history here: RED, then GREEN (linear); any other commit is on another line. */
const HISTORY = [RED, GREEN];
const FACTS = {
  repositoryUrl: "https://github.com/owner/repo",
  isAncestor: (ancestor: string, descendant: string): boolean => HISTORY.includes(ancestor) && HISTORY.includes(descendant) && HISTORY.indexOf(ancestor) <= HISTORY.indexOf(descendant),
};
const ledger = (text: string | null): TreeReader => ({ label: "ledger", paths: () => [], entry: () => null, text: (path) => (path === LEDGER_MAIN_RUNS.path ? text : null), prefetch: () => {} });
const input = (mainRuns: ProjectionInput["mainRuns"]): ProjectionInput => ({
  schema: PROJECTION_INPUT_SCHEMA, source: GREEN, ledger: "c".repeat(40), repositoryUrl: "https://github.com/owner/repo", items: [], decisions: [], recordedEvidence: [], mainRuns,
});

test("main's health is each workflow's row at the NEWEST commit by ancestry; a malformed row, a foreign run and diverging rows are refused typed", () => {
  const rows = [run("door", RED, "failure", [{ path: "tests/a.test.ts", message: "boom" }]), run("audit", RED, "success"), run("door", GREEN, "success")].join("\n");
  assert.deepEqual(mainHealth(ledger(rows), FACTS).map((entry) => [entry.workflow, entry.commit, entry.conclusion]), [["audit", RED, "success"], ["door", GREEN, "success"]]);
  assert.deepEqual(mainHealth(ledger(null), FACTS), [], "no ledger file yet: no health");
  // An older green appended AFTER a newer red never hides it: append order is not main's order.
  const late = [run("door", GREEN, "failure", [{ path: "tests/a.test.ts", message: "boom" }]), run("door", RED, "success")].join("\n");
  assert.deepEqual(mainHealth(ledger(late), FACTS).map((entry) => [entry.commit, entry.conclusion]), [[GREEN, "failure"]]);
  // A re-run of one commit answers by its last row.
  assert.deepEqual(mainHealth(ledger([run("door", RED, "failure"), run("door", RED, "success")].join("\n")), FACTS).map((entry) => entry.conclusion), ["success"]);
  assert.throws(() => mainHealth(ledger([run("door", RED, "failure"), run("door", "d".repeat(40), "success")].join("\n")), FACTS), (error: Error & { code?: string }) => error.code === "ledger_rows_diverge");
  for (const [text, why] of [
    ["{not json", /main-runs\.jsonl:2: not JSON/u],
    [JSON.stringify({ schema: "other/v1" }), /schema is not bridlewise-ledger-main-run\/v1/u],
    [run("Door Run", RED, "failure"), /workflow must be a lower-case name/u],
    [run("door", "abc", "failure"), /commit must be a full commit id/u],
    [JSON.stringify({ ...JSON.parse(run("door", RED, "failure")), failedTests: [{ path: "" }] }), /failedTests\[0\] must be \{ path, message \}/u],
    // Only this repository's own Actions runs: another host, another repository, another page of this one.
    [JSON.stringify({ ...JSON.parse(run("door", RED, "failure")), runUrl: "https://evil.example/owner/repo/actions/runs/1" }), /runUrl must be one of this repository's Actions runs/u],
    [JSON.stringify({ ...JSON.parse(run("door", RED, "failure")), runUrl: "https://github.com/owner/repo-fork/actions/runs/1" }), /runUrl must be one of this repository's Actions runs/u],
    [JSON.stringify({ ...JSON.parse(run("door", RED, "failure")), runUrl: "https://github.com/owner/repo/issues/1" }), /runUrl must be one of this repository's Actions runs/u],
  ] as const) {
    assert.throws(() => mainHealth(ledger(`${run("audit", RED, "success")}\n${text}`), FACTS), (error: Error & { code?: string }) => error.code === "ledger_row_invalid" && why.test(error.message), String(why));
  }
});

test("a red workflow is ONE open, pinned Bug naming each failing test and its owners or UNOWNED; green again closes and unpins it", async () => {
  const red = computeProjection(input([{ workflow: "door", commit: RED, conclusion: "failure", runUrl: "https://github.com/owner/repo/actions/runs/1", failedTests: [
    { path: "tests/a.test.ts", message: "expected 1\nto be 2", owners: ["FLAKY-A"] },
    { path: "tests/b.test.ts", message: "a | b", owners: [] },
  ] }]), CONFINEMENT).projection;
  const issue = red.objects.find((object) => object.key === "MAIN-RED/door")!;
  assert.deepEqual([issue.fields.title, issue.fields.type, issue.fields.state, issue.fields.pinned], ["main is red: door", "Bug", "open", true]);
  const block = String(issue.fields.block);
  assert.match(block, /^<!-- bridlewise:item=MAIN-RED\/door digest=[0-9a-f]{64} -->/u);
  assert.ok(block.includes(`| ${escapeGithubText("tests/a.test.ts")} | ${escapeGithubText("FLAKY-A")} | ${escapeGithubText("expected 1")} |`), "an owned failure names its open record; only the message's first line");
  assert.ok(block.includes(`| ${escapeGithubText("tests/b.test.ts")} | **UNOWNED** | ${escapeGithubText("a | b")} |`), "an unowned failure says so; a pipe cannot break the table");
  const github = memoryStore();
  const opened = await applyProjection(red, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  assert.equal(opened.verified, true);
  assert.deepEqual([github.get("issue", "MAIN-RED/door")?.fields.state, github.get("issue", "MAIN-RED/door")?.fields.pinned], ["open", true]);
  const green = computeProjection(input([{ workflow: "door", commit: GREEN, conclusion: "success", runUrl: "https://github.com/owner/repo/actions/runs/2", failedTests: [] }]), CONFINEMENT).projection;
  const closed = await applyProjection(green, github.store, { allowance: 100, previous: opened, foreignEdit: "approval" });
  assert.equal(closed.verified, true);
  assert.deepEqual(closed.foreignEdits, []);
  const live = github.get("issue", "MAIN-RED/door")!.fields;
  assert.deepEqual([live.title, live.state, live.stateReason, live.pinned], ["main is green again: door", "closed", "completed", false]);
  // Another failure of the same workflow reopens the SAME issue: one per workflow, never one per run.
  const again = await applyProjection(red, github.store, { allowance: 100, previous: closed, foreignEdit: "approval" });
  assert.ok(again.writes.every((write) => write.kind !== "create"), "no second issue");
  assert.equal(github.get("issue", "MAIN-RED/door")?.fields.state, "open");
});

test("a run's texts are text: no code-span breakout, no markup, no @mention; a body past GitHub's limit ends with a stable count of what it does not show", () => {
  const planted = computeProjection(input([{ workflow: "door", commit: RED, conclusion: "failure", runUrl: "https://github.com/owner/repo/actions/runs/1", failedTests: [
    { path: "tests/x`; @everyone ping `y.test.ts", message: "@org/team look ``` <img src=x onerror=alert(1)> [x](javascript:y)", owners: ["@owner-team"] },
  ] }]), CONFINEMENT).projection;
  const block = String(planted.objects.find((object) => object.key === "MAIN-RED/door")!.fields.block);
  for (const raw of ["@everyone", "@org/team", "@owner-team", "<img", "](javascript"]) assert.ok(!block.includes(raw), `${raw} reached the issue raw:\n${block}`);
  const row = block.split("\n").find((line) => line.startsWith("| tests"))!;
  assert.doesNotMatch(row, /(?:^|[^\\])`/u, "no backtick opens a code span: every one is escaped");
  const many = Array.from({ length: 4000 }, (_, index) => ({ path: `tests/generated/${String(index).padStart(4, "0")}.test.ts`, message: "x".repeat(60), owners: [] as string[] }));
  const capped = String(computeProjection(input([{ workflow: "door", commit: RED, conclusion: "failure", runUrl: "https://github.com/owner/repo/actions/runs/1", failedTests: many }]), CONFINEMENT).projection.objects.find((object) => object.key === "MAIN-RED/door")!.fields.block);
  assert.ok(capped.length <= ISSUE_BODY_LIMIT, `the body is ${String(capped.length)} characters`);
  const shown = capped.split("\n").filter((line) => line.startsWith("| tests")).length;
  assert.ok(shown > 0 && shown < many.length);
  assert.ok(capped.includes(`${String(many.length - shown)} more failing tests are not shown`), "the note counts what it leaves out");
});

test("the projection's input reads main's health at the ledger commit and each failing test's owners from the board at S", () => {
  const root = createTempDir("main-red-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  writeFileSync(join(root, TRACKER_BOARD.items, "FLAKY-A.md"), "---\nschema: bridlewise-tracker-item/v1\npublished: false\nid: FLAKY-A\ntype: Flake\nstate: open\nlane: flaky-burn-down\nopened: 2026-10-21\n---\n\nOwns tests/a.test.ts.\n");
  // The item's lane label, declared where the forge reads labels (the projector refuses an undeclared one).
  mkdirSync(join(root, LABELS_PATH, ".."), { recursive: true });
  writeFileSync(join(root, LABELS_PATH), `${JSON.stringify({ schema: schemaId("community-labels", 1), labels: [{ name: "lane:flaky-burn-down", color: "d93f0b", description: "Tracker lane: owns an entry of a flaky burn-down list" }] })}\n`);
  writeFileSync(join(root, TRACKER_BOARD.path), `# Tasks\n\n${TRACKER_BOARD.begin}\n\n## Flaky burn-down owners\n\n- [ ] **FLAKY-A** — Owns tests/a.test.ts.\n\n${TRACKER_BOARD.end}\n`);
  git("add", "."); git("commit", "-q", "-m", "source");
  const source = git("rev-parse", "HEAD");
  git("checkout", "-q", "--orphan", "ledger");
  git("rm", "-q", "-rf", ".");
  writeFileSync(join(root, LEDGER_MAIN_RUNS.path), `${run("door", source, "failure", [{ path: "tests/a.test.ts", message: "boom" }, { path: "tests/b.test.ts", message: "bang" }])}\n`);
  git("add", LEDGER_MAIN_RUNS.path); git("commit", "-q", "-m", "a verdict");
  const repository = configuredGitRepository({}, root);
  const read = projectionInput(repository, source, "ledger", "https://github.com/owner/repo");
  assert.equal(read.ledger, git("rev-parse", "ledger"), "the ledger is its full commit id");
  assert.deepEqual(read.mainRuns[0]!.failedTests.map((test) => [test.path, test.owners]), [["tests/a.test.ts", ["FLAKY-A"]], ["tests/b.test.ts", []]]);
  assert.deepEqual(projectionInput(repository, source, null, "https://github.com/owner/repo").mainRuns, [], "before the ledger exists, no main health is projected");
  assert.throws(() => projectionInput(repository, source, "no-such-ledger", "https://github.com/owner/repo"), (error: Error & { code?: string }) => error.code === "projection_ledger_missing");
});
