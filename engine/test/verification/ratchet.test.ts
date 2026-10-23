/**
 * THE ONE SHRINK-ONLY RATCHET (`scripts/verification/ratchet.ts`), driven:
 *
 *   A. a baseline is a self-identifying document whose every entry says WHY
 *      (an entry with no reason, or the old reason-less map, is refused);
 *   B. the committed baseline is read from git `HEAD` — absent while the
 *      baseline is being introduced, and a refusal outside a repository
 *      (never "nothing committed");
 *   C. the commit guard refuses a commit that GROWS a staged baseline against
 *      HEAD (the gaming verify/a2-correctness §7 reproduced: append the new
 *      site to the list), accepts one that shrinks it, and refuses a staged
 *      baseline with an unjustified entry — run as the real program against a
 *      scratch repository, the verdict read from its exit status;
 *   D. THE GENERATOR (`scripts/verification/ratchet-baselines.ts`,
 *      a2b-design H2): every registered baseline is a declared generated
 *      output with a scan; a check reports a stale entry as drift, a sync
 *      prunes it (order and reasons kept) and never adds a finding;
 *      introduction writes the current findings once and refuses an existing
 *      baseline.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import {
  committedRatchetBaseline,
  declaresRatchetBaseline,
  parseRatchetBaseline,
  RATCHET_SCHEMA,
  stagedRatchetGrowth,
} from "../../scripts/verification/ratchet.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { introduceRatchetBaseline, RATCHET_BASELINES, syncRatchetBaselines, type RatchetBaselineSpec } from "../../scripts/verification/ratchet-baselines.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { generatedOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { readFileSync } from "node:fs";

const COMMIT_GUARD = join(resolve(import.meta.dirname, "..", ".."), "scripts", "commit-guard.ts");
const BASELINE = "guards/debt-baseline.json";

/** The fixture baseline's registry id (every staged baseline names its id). */
const BASELINE_ID = "fixture-debt";

function document(...entries: ReadonlyArray<readonly [string, string]>): string {
  return `${JSON.stringify({ schema: RATCHET_SCHEMA, id: BASELINE_ID, entries: entries.map(([key, reason]) => ({ key, reason })) }, null, 2)}\n`;
}

function scratchRepository(): string {
  const root = createTempDir("ratchet-repository-");
  const git = (...args: readonly string[]) => execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "ratchet@example.invalid");
  git("config", "user.name", "ratchet");
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function stageAndCommit(root: string, message: string): void {
  execFileSync("git", ["add", "--", BASELINE], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "--no-verify", "-m", message], { cwd: root, stdio: "pipe" });
}

/** The real guard against `root`'s index: the exit status is the verdict. */
function guard(root: string): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync(process.execPath, [COMMIT_GUARD, root], { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 });
  return { status: result.status ?? -1, stderr: result.stderr };
}

test("ratchet: a baseline declares itself, and every entry carries a reason", () => {
  const text = document(["src/a.ts: x ?? 30", "owned by TASK-1"]);
  assert.equal(declaresRatchetBaseline(text), true);
  assert.equal(declaresRatchetBaseline(JSON.stringify({ "src/a.ts": ["x ?? 30"] })), false, "the old reason-less map is not a baseline");
  assert.equal(declaresRatchetBaseline(`{ "schema": "${RATCHET_SCHEMA}"`), false, "text that names the schema but does not parse");
  assert.deepEqual(parseRatchetBaseline(text, "fixture").entries, [{ key: "src/a.ts: x ?? 30", reason: "owned by TASK-1" }]);
  for (const [bad, code] of [
    [document(["src/a.ts: x ?? 30", "  "]), "ratchet_baseline_unjustified"],
    [document(["", "a reason"]), "ratchet_baseline_invalid"],
    [JSON.stringify({ schema: "other/v1", entries: [] }), "ratchet_baseline_invalid"],
    ["not json", "ratchet_baseline_invalid"],
  ] as const) {
    assert.throws(() => parseRatchetBaseline(bad, "fixture"), (error: unknown) => error instanceof InputError && error.code === code, bad);
  }
});

test("ratchet: the committed baseline is read at HEAD by its id — absent while it is introduced, refused outside a repository", () => {
  const root = scratchRepository();
  write(root, BASELINE, document(["k", "r"]));
  assert.equal(committedRatchetBaseline(root, BASELINE_ID), undefined, "no commit holds it yet");
  stageAndCommit(root, "introduce");
  assert.deepEqual(committedRatchetBaseline(root, BASELINE_ID)?.entries, [{ key: "k", reason: "r" }]);
  assert.equal(committedRatchetBaseline(root, "another-id"), undefined, "a baseline is found by its id, never by its path");
  const outside = createTempDir("ratchet-no-repository-");
  assert.throws(() => committedRatchetBaseline(outside, BASELINE_ID), (error: unknown) => error instanceof InputError && error.code === "ratchet_repository_missing");
});

test("ratchet: the commit guard refuses a staged baseline that grew, accepts one that shrank, and refuses an unjustified one", () => {
  const root = scratchRepository();
  write(root, BASELINE, document(["src/a.ts: x ?? 30", "TASK-1"], ["src/a.ts: x ?? 30", "TASK-1"]));
  stageAndCommit(root, "introduce");

  // The gaming: a new site appended to the list (and a second copy of an
  // existing one) — the tree would agree with the list; HEAD does not.
  write(root, BASELINE, document(["src/a.ts: x ?? 30", "TASK-1"], ["src/a.ts: x ?? 30", "TASK-1"], ["src/a.ts: x ?? 30", "TASK-1"], ["src/b.ts: y ?? 12345", "added to pass"]));
  execFileSync("git", ["add", "--", BASELINE], { cwd: root, stdio: "pipe" });
  assert.deepEqual(stagedRatchetGrowth(root, [BASELINE]), [{ path: BASELINE, grown: ["src/a.ts: x ?? 30", "src/b.ts: y ?? 12345"] }]);
  const grown = guard(root);
  assert.equal(grown.status, 1, grown.stderr);
  assert.match(grown.stderr, /COMMIT REFUSED — a ratchet baseline grew/u);
  assert.match(grown.stderr, /\+ src\/b\.ts: y \?\? 12345/u);

  // Shrinking is always allowed.
  write(root, BASELINE, document(["src/a.ts: x ?? 30", "TASK-1"]));
  execFileSync("git", ["add", "--", BASELINE], { cwd: root, stdio: "pipe" });
  assert.deepEqual(stagedRatchetGrowth(root, [BASELINE]), []);
  const shrunk = guard(root);
  assert.equal(shrunk.status, 0, shrunk.stderr);

  // An entry with no reason cannot be committed at all.
  write(root, BASELINE, document(["src/a.ts: x ?? 30", ""]));
  execFileSync("git", ["add", "--", BASELINE], { cwd: root, stdio: "pipe" });
  const unjustified = guard(root);
  assert.equal(unjustified.status, 1, unjustified.stderr);
  assert.match(unjustified.stderr, /ratchet baselines could not be judged/u);
  assert.match(unjustified.stderr, /has no reason/u);
});

test("ratchet: a baseline MOVED to a new path is still the committed one (found by its id): the move with added entries is refused (a2b-design M1)", () => {
  const root = scratchRepository();
  write(root, BASELINE, document(["src/a.ts: x ?? 30", "TASK-1"]));
  stageAndCommit(root, "introduce");
  const moved = "guards/renamed-baseline.json";
  execFileSync("git", ["mv", BASELINE, moved], { cwd: root, stdio: "pipe" });
  write(root, moved, document(["src/a.ts: x ?? 30", "TASK-1"], ["src/b.ts: y ?? 12345", "added under a new name"]));
  execFileSync("git", ["add", "--", moved], { cwd: root, stdio: "pipe" });
  assert.deepEqual(committedRatchetBaseline(root, BASELINE_ID)?.entries, [{ key: "src/a.ts: x ?? 30", reason: "TASK-1" }], "found by its id at its old path");
  assert.deepEqual(stagedRatchetGrowth(root, [moved]), [{ path: moved, grown: ["src/b.ts: y ?? 12345"] }]);
  const refused = guard(root);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /COMMIT REFUSED — a ratchet baseline grew/u);
  // A staged baseline that names no id cannot be judged, so it is refused.
  write(root, moved, `${JSON.stringify({ schema: RATCHET_SCHEMA, entries: [{ key: "src/a.ts: x ?? 30", reason: "TASK-1" }] }, null, 2)}\n`);
  execFileSync("git", ["add", "--", moved], { cwd: root, stdio: "pipe" });
  assert.throws(() => stagedRatchetGrowth(root, [moved]), (error: unknown) => error instanceof InputError && error.code === "ratchet_baseline_invalid");
});

test("ratchet: renaming a baseline's ID (moved or in place) is a retirement plus an introduction — judged against the retired baseline, so its growth is refused (WF-1b3b design M9 / verify L2)", () => {
  const renamed = (...entries: ReadonlyArray<readonly [string, string]>): string =>
    `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "renamed-id", entries: entries.map(([key, reason]) => ({ key, reason })) }, null, 2)}\n`;
  for (const target of ["guards/moved-baseline.json", BASELINE]) {
    const root = scratchRepository();
    write(root, BASELINE, document(["src/a.ts: x ?? 30", "TASK-1"]));
    stageAndCommit(root, "introduce");
    if (target !== BASELINE) execFileSync("git", ["mv", BASELINE, target], { cwd: root, stdio: "pipe" });
    write(root, target, renamed(["src/a.ts: x ?? 30", "TASK-1"], ["src/b.ts: y ?? 12345", "added under a new id"]));
    execFileSync("git", ["add", "--", target], { cwd: root, stdio: "pipe" });
    assert.deepEqual(stagedRatchetGrowth(root, [target]), [{ path: target, grown: ["src/b.ts: y ?? 12345"] }], `a new id at ${target} hid the growth`);
    const refused = guard(root);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /COMMIT REFUSED — a ratchet baseline grew/u);
    // The same rename WITHOUT growth is accepted: nothing beyond the retired debt.
    write(root, target, renamed(["src/a.ts: x ?? 30", "TASK-1"]));
    execFileSync("git", ["add", "--", target], { cwd: root, stdio: "pipe" });
    assert.deepEqual(stagedRatchetGrowth(root, [target]), []);
  }
  // A genuine introduction (nothing retired) is not growth.
  const fresh = scratchRepository();
  write(fresh, BASELINE, document(["k", "r"]));
  execFileSync("git", ["add", "--", BASELINE], { cwd: fresh, stdio: "pipe" });
  assert.deepEqual(stagedRatchetGrowth(fresh, [BASELINE]), []);
});

test("ratchet generator: every registered baseline is a declared generated output with its guard's scan", () => {
  assert.deepEqual(RATCHET_BASELINES.map((spec) => [spec.id, spec.path]), Object.entries(ROOT_POLICY.verification.ratchetBaselines));
  const outputs = generatedOutputPaths();
  for (const spec of RATCHET_BASELINES) assert.ok(outputs.has(spec.path), `${spec.path} is regenerated by a sync pass`);
});

test("ratchet generator: a check reports debt that fell; a sync prunes it and never adds a finding; introduction happens once", () => {
  const root = createTempDir("ratchet-generator-");
  mkdirSync(join(root, "guards"), { recursive: true });
  const reason = "fixture debt (tracker FIXTURE-2)";
  let findings = ["a.ts: x ?? 30", "a.ts: x ?? 30", "b.ts: y ?? 40"];
  const fixture: readonly RatchetBaselineSpec[] = [{ id: BASELINE_ID, path: BASELINE, findings: () => findings.map((key) => ({ key, where: key })) }];
  const introduced = introduceRatchetBaseline(root, BASELINE_ID, reason, fixture);
  assert.deepEqual(introduced, { id: BASELINE_ID, path: BASELINE, entries: 3 });
  assert.equal(readFileSync(join(root, BASELINE), "utf8"), document(["a.ts: x ?? 30", reason], ["a.ts: x ?? 30", reason], ["b.ts: y ?? 40", reason]));
  assert.throws(() => introduceRatchetBaseline(root, BASELINE_ID, reason, fixture), (error: unknown) => error instanceof InputError && error.code === "ratchet_baseline_exists", "a baseline is introduced once");
  assert.throws(() => introduceRatchetBaseline(root, "nothing", reason, fixture), (error: unknown) => error instanceof InputError && error.code === "ratchet_baseline_unknown");
  // One of the two `x ?? 30` sites fixed, and a NEW site appeared.
  findings = ["a.ts: x ?? 30", "b.ts: y ?? 40", "c.ts: z ?? 50"];
  const checked = syncRatchetBaselines(root, false, fixture);
  assert.equal(checked.allCurrent, false);
  assert.deepEqual(checked.results.map((result) => [result.status, result.stale, result.unbaselined]), [["stale", ["a.ts: x ?? 30"], ["c.ts: z ?? 50"]]]);
  assert.equal(readFileSync(join(root, BASELINE), "utf8"), document(["a.ts: x ?? 30", reason], ["a.ts: x ?? 30", reason], ["b.ts: y ?? 40", reason]), "a check writes nothing");
  const synced = syncRatchetBaselines(root, true, fixture);
  assert.equal(synced.allCurrent, true);
  assert.deepEqual(synced.results.map((result) => result.status), ["pruned"]);
  assert.equal(readFileSync(join(root, BASELINE), "utf8"), document(["a.ts: x ?? 30", reason], ["b.ts: y ?? 40", reason]), "one occurrence removed; the new site is NOT added");
  assert.deepEqual(syncRatchetBaselines(root, true, fixture).results.map((result) => result.status), ["current"], "a second pass changes nothing");
  // A tree without the baseline converges by absence.
  assert.deepEqual(syncRatchetBaselines(createTempDir("ratchet-generator-absent-"), false, fixture).results.map((result) => result.status), ["absent"]);
});
