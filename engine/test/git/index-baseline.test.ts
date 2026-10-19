/**
 * THE LIVE INDEX'S BASELINE, DRIVEN (`src/git/index-baseline.ts`).
 *
 * A planted repository whose index holds a staged NEW file (its blob is in
 * no commit) and a staged modification of a committed file: the two
 * PROTECTED entries. Driven here:
 *
 *   - the slips it exists for (`git rm --cached`, `git restore --staged`,
 *     `git reset`) are drift, and the one repair restores them byte for byte
 *     — even after `git gc --prune=now` (the pin keeps the blobs);
 *   - the ordinary workflow is NOT drift (wf1b-correctness §5, wf1b-design
 *     M2): a stray `git add`, a commit of another path, a commit of the
 *     protected path itself; HEAD moving advances the record by itself;
 *   - the repair can never stage the reversal of a commit, never removes an
 *     entry, refuses a missing blob with the index untouched, keeps
 *     intent-to-add entries intent-to-add, and takes any legal path (`\n`,
 *     a leading `"`: `-z`);
 *   - conflict stages are not protected; a garbled record is typed.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checkIndexBaseline, indexBaselineDrift, indexBaselinePath, recordIndexBaseline, repairIndexToBaseline } from "../../src/git/index-baseline.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Index Test", "-c", "user.email=index@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

/** A committed file, a staged modification of it, a staged NEW file (both staged blobs exist nowhere else), an untracked file. */
function plantedRepository(): string {
  const root = createTempDir("index-baseline-");
  git(root, "init", "-q");
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(root, "lib", "other.ts"), "export const other = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "lib", "kept.ts"), "export const kept = 2;\n");
  writeFileSync(join(root, "lib", "inherited.ts"), "export const inherited = 'only staged';\n");
  git(root, "add", "lib/kept.ts", "lib/inherited.ts");
  // The working tree moves on after staging: the staged blobs exist nowhere else.
  writeFileSync(join(root, "lib", "inherited.ts"), "export const inherited = 'edited after staging';\n");
  writeFileSync(join(root, "lib", "kept.ts"), "export const kept = 3;\n");
  writeFileSync(join(root, "lib", "stray.ts"), "export const stray = 1;\n");
  return root;
}

const lostOf = (root: string): readonly string[] => {
  const state = indexBaselineDrift(root);
  return state.state === "drifted" ? [...state.lost].sort() : [];
};

test("only staged blobs HEAD does not hold are protected; an unrecorded checkout says so", () => {
  const root = plantedRepository();
  assert.equal(indexBaselineDrift(root).state, "unrecorded");
  const recorded = recordIndexBaseline(root);
  assert.equal(recorded.baselinePath, indexBaselinePath(root));
  assert.equal(recorded.protected, 2, "the committed, unchanged lib/other.ts is not at risk and must not be recorded");
  assert.match(git(root, "for-each-ref", "--format=%(refname)", ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace), /index-baselines\/[0-9a-f]{64}/u);
  const state = indexBaselineDrift(root);
  assert.equal(state.state, "clean");
});

test("rm --cached, restore --staged and reset are drift; the ONE repair restores the index byte for byte, even after gc --prune=now", () => {
  for (const slip of [
    (root: string) => git(root, "rm", "-q", "--cached", "-f", "lib/inherited.ts"),
    (root: string) => git(root, "restore", "--staged", "lib/kept.ts", "lib/inherited.ts"),
    (root: string) => git(root, "reset", "-q"),
  ]) {
    const root = plantedRepository();
    recordIndexBaseline(root);
    const before = git(root, "ls-files", "-s");
    slip(root);
    assert.notDeepEqual(lostOf(root), [], "a slip dropping a protected blob was not reported");
    const drift = indexBaselineDrift(root);
    assert.ok(drift.state === "drifted" && drift.repair.join(" ") === "harness index repair", "the repair is named as the engine CLI verb, never a script path");
    git(root, "gc", "-q", "--prune=now");
    repairIndexToBaseline(root);
    assert.equal(git(root, "ls-files", "-s"), before, "the index is not back to its baseline byte for byte");
    assert.equal(git(root, "show", ":lib/inherited.ts"), "export const inherited = 'only staged';\n", "the staged-only blob was not recovered");
    assert.equal(indexBaselineDrift(root).state, "clean");
  }
});

test("the ordinary workflow is never drift: a stray add, a commit of another path, a commit of the protected path; HEAD moving advances the record", () => {
  const root = plantedRepository();
  recordIndexBaseline(root);
  git(root, "add", "lib/stray.ts");
  assert.equal(indexBaselineDrift(root).state, "clean", "a stray git add lost nothing");
  git(root, "commit", "-q", "-m", "commit the stray and whatever else is staged", "--", "lib/stray.ts");
  const afterOther = checkIndexBaseline(root);
  assert.equal(afterOther.state, "clean", "a commit of another path is not drift");
  assert.equal(afterOther.advanced, true, "HEAD moved with nothing lost: the record advances by itself");
  git(root, "commit", "-q", "-m", "commit the inherited work");
  assert.equal(indexBaselineDrift(root).state, "clean", "committing the protected entries is not drift");
  const advanced = checkIndexBaseline(root);
  assert.ok(advanced.state === "clean" && advanced.advanced === true && advanced.protected === 0, "once committed, nothing is at risk: the advanced record protects nothing");
  assert.equal(git(root, "for-each-ref", ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace), "", "an empty record keeps no pin");
});

test("A READ NEVER WRITES: after HEAD moves, the status verb and the signal's summary report the due advance and leave the record and its pin as they were", async () => {
  // step6-readiness F-6: `harness index status` answered `advanced: true`, so a
  // status query rewrote the record and moved its pin ref.
  const { harnessIndex } = await import("../../src/workflow/harness-commands.ts");
  const { indexBaselineSummary } = await import("../../src/git/index-baseline.ts");
  const root = plantedRepository();
  const { baselinePath } = recordIndexBaseline(root);
  git(root, "add", "lib/stray.ts");
  git(root, "commit", "-q", "-m", "HEAD moves", "--", "lib/stray.ts");
  const record = readFileSync(baselinePath);
  const pins = git(root, "for-each-ref", ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace);
  const verb = harnessIndex(root, ["status"]);
  assert.equal(verb.status, "pass");
  const status = verb.result as Readonly<Record<string, unknown>>;
  assert.ok(status.state === "clean" && status.headMoved === true, `the status must report the due advance: ${JSON.stringify(status)}`);
  assert.equal("advanced" in status, false, "the status verb advanced the record");
  assert.match(indexBaselineSummary(root), /^clean: /u);
  assert.deepEqual(readFileSync(baselinePath), record, "a read rewrote the index baseline record");
  assert.equal(git(root, "for-each-ref", ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace), pins, "a read moved the baseline's pin ref");
  // The writer still advances it.
  assert.equal(checkIndexBaseline(root).advanced, true);
  assert.notDeepEqual(readFileSync(baselinePath), record);
});

test("the repair can never stage the reversal of a commit, and never removes an entry", () => {
  const root = plantedRepository();
  recordIndexBaseline(root);
  // The slip, then a commit of a NEWER version of the same path: the commit is the new truth.
  git(root, "restore", "--staged", "lib/kept.ts");
  writeFileSync(join(root, "lib", "kept.ts"), "export const kept = 4;\n");
  git(root, "add", "lib/kept.ts", "lib/stray.ts");
  git(root, "commit", "-q", "-m", "a newer kept.ts", "--", "lib/kept.ts");
  assert.deepEqual(lostOf(root), [], "a path a commit changed is superseded, never lost");
  const repaired = repairIndexToBaseline(root);
  assert.deepEqual(repaired.restored, []);
  assert.equal(git(root, "diff", "--cached", "--name-status", "--", "lib/kept.ts"), "", "the repair staged a reversal of the commit");
  assert.match(git(root, "ls-files", "--", "lib/stray.ts"), /lib\/stray\.ts/u, "the repair removed an entry");
});

test("a missing blob is refused before the index is touched", () => {
  const root = plantedRepository();
  recordIndexBaseline(root);
  git(root, "rm", "-q", "--cached", "-f", "lib/inherited.ts");
  const index = readFileSync(join(root, ".git", "index"));
  for (const ref of git(root, "for-each-ref", "--format=%(refname)", ROOT_POLICY.verification.liveIndexBaseline.pinRefNamespace).split("\n").filter(Boolean)) git(root, "update-ref", "-d", ref);
  git(root, "reflog", "expire", "--expire=now", "--all");
  git(root, "gc", "-q", "--prune=now");
  assert.throws(() => repairIndexToBaseline(root), (error: unknown) => (error as { code?: unknown }).code === "index_baseline_objects_missing");
  assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "a refused repair changed the index");
});

test("intent-to-add stays intent-to-add: never protected, never turned into a real empty file; a real empty file turned i-t-a is drift", () => {
  const root = plantedRepository();
  writeFileSync(join(root, "lib", "intended.ts"), "export const intended = 1;\n");
  git(root, "add", "-N", "lib/intended.ts");
  writeFileSync(join(root, "lib", "empty.ts"), "");
  git(root, "add", "lib/empty.ts");
  assert.equal(recordIndexBaseline(root).protected, 3, "the i-t-a entry carries no blob and is not protected; the real empty file is");
  git(root, "rm", "-q", "--cached", "lib/intended.ts");
  assert.deepEqual(lostOf(root), [], "dropping an intent loses no blob");
  git(root, "rm", "-q", "--cached", "lib/empty.ts");
  git(root, "add", "-N", "lib/empty.ts");
  assert.deepEqual(lostOf(root), ["lib/empty.ts"], "a real staged empty file turned into an intent was reported clean");
  repairIndexToBaseline(root);
  assert.equal(git(root, "diff", "--cached", "--name-status", "--", "lib/empty.ts").trim(), "A\tlib/empty.ts", "the real empty file was not restored");
  assert.equal(git(root, "diff", "--cached", "--name-only", "--", "lib/intended.ts"), "", "the repair turned an intent into a staged file");
});

test("any legal path is repaired exactly (-z): a newline, a leading quote", () => {
  const root = plantedRepository();
  for (const name of ["odd\nname.ts", "\"quoted\"", "\"half"]) {
    writeFileSync(join(root, "lib", name), `export const x = ${JSON.stringify(name)};\n`);
    git(root, "add", "--", join("lib", name));
  }
  recordIndexBaseline(root);
  const before = git(root, "ls-files", "-s", "-z");
  git(root, "rm", "-q", "--cached", "--", "lib/odd\nname.ts", "lib/\"quoted\"", "lib/\"half");
  assert.equal(lostOf(root).length, 3);
  repairIndexToBaseline(root);
  assert.equal(git(root, "ls-files", "-s", "-z"), before, "an odd path was not restored exactly (or a wrong entry was added)");
});

test("conflict stages are not protected: resolving a conflict is not drift", () => {
  const root = plantedRepository();
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "commit everything: only the conflict is staged below");
  git(root, "switch", "-q", "-c", "side");
  writeFileSync(join(root, "lib", "other.ts"), "export const other = 'side';\n");
  git(root, "commit", "-q", "-am", "side");
  git(root, "switch", "-q", "-");
  writeFileSync(join(root, "lib", "other.ts"), "export const other = 'main';\n");
  git(root, "commit", "-q", "-am", "main");
  assert.notEqual(spawnSync("git", ["merge", "-q", "side"], { cwd: root }).status, 0, "the fixture must conflict");
  assert.equal(recordIndexBaseline(root).protected, 0, "unmerged stages carry blobs of the merge's commits and are not protected");
  writeFileSync(join(root, "lib", "other.ts"), "export const other = 'resolved';\n");
  git(root, "add", "lib/other.ts");
  assert.equal(indexBaselineDrift(root).state, "clean");
});

test("a garbled or edited record is a typed refusal, never a silent pass", () => {
  const root = plantedRepository();
  const { baselinePath } = recordIndexBaseline(root);
  writeFileSync(baselinePath, "{ \"half\": ");
  assert.throws(() => indexBaselineDrift(root), (error: unknown) => (error as { code?: unknown }).code === "index_baseline_unreadable");
  recordIndexBaseline(root);
  const document = JSON.parse(readFileSync(baselinePath, "utf8")) as { entries: Array<{ objectId: string }> };
  document.entries[0]!.objectId = "0".repeat(40);
  writeFileSync(baselinePath, JSON.stringify(document));
  assert.throws(() => indexBaselineDrift(root), (error: unknown) => (error as { code?: unknown }).code === "index_baseline_unreadable", "an entry edited by hand was accepted");
});
