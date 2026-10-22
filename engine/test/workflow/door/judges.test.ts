/**
 * THE DOOR'S PURE JUDGES, broad (TESTS ARE ALWAYS BROAD): each rule's planted
 * violation and its near miss.
 *
 *   - the tree judge: size, extension, credential file names, the secret
 *     catalogue over the diff's text (the value never printed), the DCO —
 *     including the coordinator's ruling, on REAL git history: an unsigned
 *     mechanical merge of a main commit and the pull request's own commit is
 *     accepted; an unsigned merge carrying content, an unsigned merge of two
 *     non-main commits, and any unsigned plain commit are refused — and open
 *     secret-scanning alerts;
 *   - the ratchet: a hand-edited, foreign or deleted workflow with the owner
 *     unchanged; a dropped or demoted required gate either way;
 *   - the attempt discipline and the verdict's check run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { GATE_CATALOGUE } from "../../../src/workflow/gates/catalogue.ts";
import { pullCommitRecords } from "../../../src/workflow/door/judge.ts";
import { judgeRatchet } from "../../../src/workflow/door/ratchet.ts";
import { judgeTree, signOffAddresses, TREE_POLICY, type ChangedFile, type CommitRecord } from "../../../src/workflow/door/tree-judge.ts";
import { DOOR_ACTIONS, failedTestFiles, judgeAttempts, judgeRun, verdictCheckRun } from "../../../src/workflow/door/verdict.ts";
import type { GateReceipt } from "../../../src/workflow/gates/seal.ts";
import { mkGitTempDir } from "../../support/git-fixtures.ts";
import { testGitIdentityEnvironment, TEST_GIT_IDENTITY } from "../../support/test-git-identity.ts";

const SIGNED = `work\n\nSigned-off-by: ${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>\n`;

function commit(overrides: Partial<CommitRecord> = {}): CommitRecord {
  return { sha: "a".repeat(40), message: SIGNED, authorEmail: TEST_GIT_IDENTITY.email, mechanical: false, ...overrides };
}

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path: "src/a.ts", status: "modified", sizeBytes: 10, text: "export const a = 1;\n", ...overrides };
}

// ── the tree judge ────────────────────────────────────────────────────────

test("a clean diff of signed commits passes", () => {
  assert.deepEqual(judgeTree([file(), file({ path: "docs/x.md", status: "added" }), file({ path: "old.zip", status: "removed", text: null })], [commit()], new Map()), []);
});

test("each content rule refuses its planted violation, and its near miss passes", () => {
  const rules = (files: readonly ChangedFile[]) => judgeTree(files, [], new Map()).map((finding) => finding.rule);
  assert.deepEqual(rules([file({ sizeBytes: TREE_POLICY.maxFileBytes + 1 })]), ["file-size"]);
  assert.deepEqual(rules([file({ sizeBytes: TREE_POLICY.maxFileBytes })]), [], "exactly the bound passes");
  assert.deepEqual(rules([file({ path: "tools/helper.exe", text: null })]), ["file-extension"]);
  assert.deepEqual(rules([file({ path: "bundle.tar.gz", text: null })]), ["file-extension"]);
  assert.deepEqual(rules([file({ path: "src/gzip-reader.ts" })]), [], "an extension-like word inside a name is not an extension");
  assert.deepEqual(rules([file({ path: "config/.env" })]), ["secret-file"]);
  assert.deepEqual(rules([file({ path: "config/.env.example" })]), [], "a documented template is not a credential file");
  assert.deepEqual(rules([file({ path: "keys/server.pem", text: null })]), ["secret-file"]);
  // A planted credential, assembled at runtime so no credential-shaped literal is in the tree.
  const planted = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  const found = judgeTree([file({ text: `const key = "${planted}";\n` })], [], new Map());
  assert.equal(found[0]?.rule, "secret-content");
  assert.ok(!found[0]!.detail.includes(planted), "the value is never printed");
  assert.deepEqual(rules([file({ text: "const key = process.env.AWS_KEY;\n" })]), [], "a name without a value is not a credential");
});

test("DCO: every commit is signed by its author; an alert on a commit is refused", () => {
  const rules = (commits: readonly CommitRecord[], alerts = new Map<string, readonly number[]>()) => judgeTree([], commits, alerts).map((finding) => finding.rule);
  assert.deepEqual(rules([commit({ message: "work\n" })]), ["dco"]);
  assert.deepEqual(rules([commit({ message: "work\n\nSigned-off-by: Someone Else <else@example.invalid>\n" })]), ["dco"], "the sign-off names the author");
  assert.deepEqual(rules([commit({ authorEmail: TEST_GIT_IDENTITY.email.toUpperCase() })]), [], "addresses compare without case");
  assert.deepEqual(rules([commit({ message: "Signed-off-by is mentioned in prose only\n" })]), ["dco"]);
  assert.deepEqual(rules([commit({ message: "merge\n", mechanical: true })]), [], "a mechanical merge needs no sign-off");
  assert.deepEqual(rules([commit()], new Map([["a".repeat(40), [7]]])), ["secret-alert"]);
  assert.deepEqual(signOffAddresses(SIGNED), [TEST_GIT_IDENTITY.email.toLowerCase()]);
});

/** A scratch repository (never this checkout: every git call names it). */
function git(root: string, ...argv: string[]): string {
  const result = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...argv], { encoding: "utf8", env: { ...process.env, ...testGitIdentityEnvironment() } });
  assert.equal(result.status, 0, `git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const REPOSITORY = (root: string) => ({ root, executable: "git", timeoutMs: 30_000 });

test("DCO ruling on real history: an unsigned merge is accepted ONLY when it mechanically merges a main commit and the PR's own commit", () => {
  const root = mkGitTempDir("door-dco");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "base", "-s");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "pr");
  writeFileSync(join(root, "b.txt"), "pr work\n");
  git(root, "add", "b.txt");
  git(root, "commit", "-q", "-m", "pr work", "-s");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, "c.txt"), "main moved\n");
  git(root, "add", "c.txt");
  git(root, "commit", "-q", "-m", "main moves", "-s");
  const main = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "pr");
  // GitHub's "update branch": a clean merge of main into the PR, unsigned.
  git(root, "merge", "-q", "--no-edit", "--no-ff", "-m", "Merge branch 'main' into pr", "main");
  const mechanical = git(root, "rev-parse", "HEAD");
  // An unsigned merge that ALSO changes content (an evil merge).
  git(root, "checkout", "-q", "-b", "evil", "pr~1");
  git(root, "merge", "-q", "--no-ff", "--no-commit", "main");
  writeFileSync(join(root, "smuggled.txt"), "not part of either parent\n");
  git(root, "add", "smuggled.txt");
  git(root, "commit", "-q", "-m", "Merge branch 'main' into evil");
  const evil = git(root, "rev-parse", "HEAD");
  // An unsigned merge of two commits neither of which is on main.
  git(root, "checkout", "-q", "-b", "side", "pr~1");
  writeFileSync(join(root, "d.txt"), "side work\n");
  git(root, "add", "d.txt");
  git(root, "commit", "-q", "-m", "side work", "-s");
  git(root, "checkout", "-q", "-b", "twosided", "pr~1");
  writeFileSync(join(root, "e.txt"), "more pr work\n");
  git(root, "add", "e.txt");
  git(root, "commit", "-q", "-m", "more pr work", "-s");
  git(root, "merge", "-q", "--no-edit", "--no-ff", "-m", "Merge side", "side");
  const sideways = git(root, "rev-parse", "HEAD");
  // An unsigned plain commit.
  git(root, "checkout", "-q", "-b", "plain", "pr~1");
  writeFileSync(join(root, "f.txt"), "unsigned\n");
  git(root, "add", "f.txt");
  git(root, "commit", "-q", "-m", "unsigned work");
  const plain = git(root, "rev-parse", "HEAD");

  const judge = (head: string) => judgeTree([], pullCommitRecords(REPOSITORY(root), main, base, head), new Map());
  const accepted = pullCommitRecords(REPOSITORY(root), main, base, mechanical);
  assert.deepEqual(accepted.filter((record) => record.mechanical).map((record) => record.sha), [mechanical], "only the update-branch merge is mechanical");
  assert.equal(accepted.length, 3, "the range holds the merge, the PR's commit and main's");
  assert.deepEqual(judge(mechanical), [], "the mechanical update-branch merge is accepted unsigned");
  assert.deepEqual(judge(evil).map((finding) => [finding.rule, finding.commit]), [["dco", evil]], "a merge carrying content of its own is refused");
  assert.deepEqual(judge(sideways).map((finding) => [finding.rule, finding.commit]), [["dco", sideways]], "a merge with no main parent is refused");
  assert.deepEqual(judge(plain).map((finding) => [finding.rule, finding.commit]), [["dco", plain]], "an unsigned plain commit is refused");
});

// ── the ratchet ───────────────────────────────────────────────────────────

const MAIN_WORKFLOWS = new Map([["ci.yml", "ci text\n"], ["codeql.yml", "codeql text\n"]]);
const TREE_GATES = GATE_CATALOGUE.map((gate) => ({ id: gate.id, role: gate.role }));

test("the ratchet: with the owner unchanged the workflows are main's output exactly (V-7)", () => {
  const judge = (treeWorkflows: Map<string, string>, treeGates = TREE_GATES) => judgeRatchet({ generatorChanged: false, treeWorkflows, mainWorkflows: MAIN_WORKFLOWS, mainCatalogue: GATE_CATALOGUE, treeGates });
  assert.deepEqual(judge(new Map(MAIN_WORKFLOWS)), { ciChanging: false, findings: [] });
  assert.deepEqual(judge(new Map([["ci.yml", "ci text\n# hand edit\n"], ["codeql.yml", "codeql text\n"]])).findings.map((finding) => finding.rule), ["workflow-hand-edit"]);
  assert.deepEqual(judge(new Map([...MAIN_WORKFLOWS, ["extra.yml", "x\n"]])).findings.map((finding) => finding.rule), ["workflow-foreign"]);
  assert.deepEqual(judge(new Map([["ci.yml", "ci text\n"]])).findings.map((finding) => finding.rule), ["workflow-missing"]);
});

test("the ratchet: a CI-changing tree may add gates, never drop or demote a required one", () => {
  const judge = (treeGates: readonly { id: string; role: "required" | "signal" }[]) => judgeRatchet({ generatorChanged: true, treeWorkflows: new Map([["ci.yml", "anything\n"]]), mainWorkflows: MAIN_WORKFLOWS, mainCatalogue: GATE_CATALOGUE, treeGates });
  assert.deepEqual(judge([...TREE_GATES, { id: "new-gate", role: "required" }]), { ciChanging: true, findings: [] }, "an added gate and changed workflows are fine when the owner changed");
  assert.deepEqual(judge(TREE_GATES.filter((gate) => gate.id !== "docs-links")).findings.map((finding) => [finding.rule, finding.gate]), [["gate-dropped", "docs-links"]]);
  assert.deepEqual(judge(TREE_GATES.map((gate) => (gate.id === "web-suite" ? { ...gate, role: "signal" as const } : gate))).findings.map((finding) => [finding.rule, finding.gate]), [["gate-demoted", "web-suite"]]);
});

// ── attempts and the verdict ──────────────────────────────────────────────

test("a re-run never launders a failed attempt; a cancelled attempt is not a failure", () => {
  assert.deepEqual(judgeAttempts([{ attempt: 1, conclusion: "failure" }, { attempt: 2, conclusion: null }], 2).map((finding) => finding.rule), ["attempt-laundering"]);
  assert.deepEqual(judgeAttempts([{ attempt: 1, conclusion: "timed_out" }, { attempt: 2, conclusion: null }], 2).length, 1);
  assert.deepEqual(judgeAttempts([{ attempt: 1, conclusion: "cancelled" }, { attempt: 2, conclusion: null }], 2), []);
  assert.deepEqual(judgeAttempts([{ attempt: 1, conclusion: null }], 1), []);
});

const RECEIPT: GateReceipt = {
  schemaVersion: "bridlewise-gate-receipt/v1", headSha: "a".repeat(40), treeId: "b".repeat(40), catalogueDigest: "c".repeat(64), planDigest: "d".repeat(64), event: "pull_request",
  verdict: "passed", gates: [{ id: "docs-links", role: "required", status: "passed", cells: [{ cell: "docs-links", status: "passed" }] }], refusals: [], exclusions: [], tests: 12,
};

test("the verdict is success only when the receipt passed and nothing was found; its check carries K, the run and the button", () => {
  const inputs = { key: "e".repeat(64), receipt: RECEIPT, identity: [], attempts: [], ratchet: { ciChanging: false, findings: [] }, tree: [], queue: [], runUrl: "https://github.com/o/r/actions/runs/1", failedTests: [] };
  const verdict = judgeRun(inputs);
  assert.equal(verdict.conclusion, "success");
  assert.equal(verdict.budgets, "unmeasured");
  const check = verdictCheckRun(verdict, RECEIPT, []);
  assert.equal(check.conclusion, "success");
  assert.equal(check.externalId, "e".repeat(64));
  assert.equal(check.detailsUrl, inputs.runUrl);
  assert.deepEqual(check.actions!.map((action) => action.identifier), DOOR_ACTIONS.map((action) => action.identifier));
  assert.ok(DOOR_ACTIONS.every((action) => action.label.length <= 20 && action.description.length <= 40 && action.identifier.length <= 20), "GitHub's button bounds");
  for (const finding of [
    { identity: [{ rule: "identity" as const, detail: "x" }] },
    { attempts: [{ rule: "attempt-laundering" as const, detail: "x" }] },
    { queue: [{ rule: "queue-integrity" as const, detail: "x" }] },
    { tree: [{ rule: "dco" as const, commit: "f".repeat(40), detail: "x" }] },
    { ratchet: { ciChanging: false, findings: [{ rule: "workflow-hand-edit" as const, path: ".github/workflows/ci.yml", detail: "x" }] } },
    { receipt: { ...RECEIPT, verdict: "failed" as const } },
  ]) {
    assert.equal(judgeRun({ ...inputs, ...finding }).conclusion, "failure", JSON.stringify(finding));
  }
  const failed = judgeRun({ ...inputs, ratchet: { ciChanging: false, findings: [{ rule: "workflow-hand-edit", path: ".github/workflows/ci.yml", detail: "a hand edit" }] } });
  const failedCheck = verdictCheckRun(failed, RECEIPT, [{ path: "tests/unit/x.test.ts", message: "boom" }]);
  assert.deepEqual(failedCheck.annotations!.map((annotation) => [annotation.path, annotation.annotation_level]), [[".github/workflows/ci.yml", "failure"], ["tests/unit/x.test.ts", "failure"]]);
  assert.match(failedCheck.title, /workflow-hand-edit/u);
  assert.ok(failedCheck.title.length <= 255);
});

test("failed test files come from a report's rows, never its summary", () => {
  const report = { testResults: [
    { name: "/runner/x/tests/unit/a.test.ts", status: "passed", assertionResults: [] },
    { name: "/runner/x/tests/unit/b.test.ts", status: "failed", assertionResults: [{ status: "failed", title: "it works", failureMessages: ["AssertionError: expected 1\n  at x"] }] },
  ] };
  const map = (name: string) => (name.endsWith("tests/unit/b.test.ts") ? "tests/unit/b.test.ts" : name.endsWith("tests/unit/a.test.ts") ? "tests/unit/a.test.ts" : null);
  assert.deepEqual(failedTestFiles(report, map), [{ path: "tests/unit/b.test.ts", message: "it works: AssertionError: expected 1" }]);
  assert.deepEqual(failedTestFiles(null, map), []);
});
