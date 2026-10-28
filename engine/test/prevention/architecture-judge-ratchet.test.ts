/**
 * THE ARCHITECTURE JUDGE IS A GATE, AND ITS BASELINE CANNOT BE DELETED AWAY.
 *
 * `harness check` runs the derived architecture judge (S1's structural
 * verifier over the census) as the shrink-only ratchet `architecture-judge`
 * (scripts/verification/ratchet-baselines.ts). Planted here:
 *
 * - a module that takes a folder default which does not fit it is NEW debt,
 *   refused (the real judge, on a whole-repository working copy);
 * - wherever the gate's instrument is, a deleted baseline is refused
 *   (`missing`), with no scope exception; a tree without the instrument (the
 *   product projection) does not run the gate and says so;
 * - growth against the base is the commit guard's judgement, keyed by id: a
 *   grown baseline is refused, a moved and renamed one hides nothing, and a
 *   base the clone does not hold is refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RATCHET_SCHEMA, ratchetGrowthSince } from "../../scripts/verification/ratchet.ts";
import { ratchetBaseline, syncRatchetBaselines, type RatchetBaselineSpec } from "../../scripts/verification/ratchet-baselines.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";

const PATH = "tests/prevention/planted-baseline.json";
const INSTRUMENT = "engine/scripts/tooling/planted-instrument.ts";

/** A scratch repository holding one tracked baseline and its gate's instrument, committed. */
function scratch(entries: readonly string[]): Readonly<{ root: string; git: (...args: readonly string[]) => string; spec: RatchetBaselineSpec; findings: string[] }> {
  const root = createTempDir("ratchet-gate-");
  const git = (...args: readonly string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "tests", "prevention"), { recursive: true });
  mkdirSync(join(root, "engine", "scripts", "tooling"), { recursive: true });
  writeFileSync(join(root, INSTRUMENT), "export {};\n");
  writeFileSync(join(root, PATH), document(entries));
  git("add", "--", "tests", "engine");
  git("commit", "-q", "-m", "base");
  const findings = [...entries];
  return { root, git, findings, spec: { id: "planted", path: PATH, instrument: INSTRUMENT, findings: () => findings.map((key) => ({ key, where: key })) } };
}

function document(entries: readonly string[]): string {
  return `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "planted", entries: entries.map((key) => ({ key, reason: "#0" })) }, null, 2)}\n`;
}

test("wherever the gate's instrument is, a missing baseline is refused — no scope exception; a tree without the instrument does not run the gate", () => {
  const { root, git, spec } = scratch(["debt:a"]);
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "current", "liveness");
  rmSync(join(root, PATH));
  const deleted = syncRatchetBaselines(root, false, [spec]);
  assert.equal(deleted.results[0]!.status, "missing", "a deleted baseline would switch its gate off");
  assert.equal(deleted.allCurrent, false);
  // Marking the path skip-worktree, or untracking its whole folder, changes nothing: missing is missing.
  git("update-index", "--skip-worktree", "--", PATH);
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "missing");
  git("update-index", "--no-skip-worktree", "--", PATH);
  git("rm", "-q", "-r", "--cached", "--", "tests");
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "missing");
  // The product projection strips the testing floor: no instrument, no gate, and it says so.
  rmSync(join(root, INSTRUMENT));
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "not-in-this-tree");
});

test("growth against the base is the commit guard's judgement, by id: a grown baseline is refused, a moved one hides nothing, an unknown base is refused", () => {
  const { root, git, spec, findings } = scratch(["debt:a"]);
  const base = git("rev-parse", "HEAD").trim();
  findings.push("debt:b");
  writeFileSync(join(root, PATH), document(findings));
  git("commit", "-q", "-am", "grow");
  const grown = syncRatchetBaselines(root, false, [spec], base);
  assert.equal(grown.results[0]!.status, "grown");
  assert.deepEqual(grown.results[0]!.grown, ["debt:b"]);
  assert.equal(grown.allCurrent, false);
  assert.deepEqual(ratchetGrowthSince(root, "HEAD"), [], "against its own commit nothing grew (liveness)");
  // Moved to another path and given another id: judged against every retired baseline, the growth still shows.
  git("mv", PATH, "tests/prevention/moved.json");
  writeFileSync(join(root, "tests", "prevention", "moved.json"), document(findings).replace('"id": "planted"', '"id": "renamed"'));
  git("commit", "-q", "-am", "move and rename");
  assert.deepEqual(ratchetGrowthSince(root, base), [{ id: "renamed", grown: ["debt:b"] }]);
  assert.throws(() => ratchetGrowthSince(root, "0".repeat(40)), (error: unknown) => (error as { code?: unknown }).code === "ratchet_base_unknown");
});

test("the real judge refuses a module that takes a folder default which does not fit it", () => {
  const copy = createRepositoryWorkingCopy("architecture-judge-default-");
  try {
    // src/workflow/'s default is the runtime realm; this module reaches into the builder realm.
    writeFileSync(join(copy.engineRoot, "src", "workflow", "zz-wrong-default.ts"), `import { RATCHET_SCHEMA, ratchetGrowthSince } from "../../scripts/verification/ratchet.ts";\n\n/** A module on a default that does not fit it. */\nexport const planted = RATCHET_SCHEMA;\n`);
    execFileSync("git", ["add", "-N", "--", "engine/src/workflow/zz-wrong-default.ts"], { cwd: copy.root });
    const judged = syncRatchetBaselines(copy.root, false, [ratchetBaseline("architecture-judge")]).results[0]!;
    assert.equal(judged.status, "current", `the copy's baseline matches its judge apart from the plant: ${judged.stale.slice(0, 5).join(", ")}`);
    assert.ok(judged.unbaselined.includes("architecture-realm-direction:src/workflow/zz-wrong-default.ts->scripts/verification/ratchet.ts"),
      `the silent default is new debt: ${judged.unbaselined.join(", ")}`);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
