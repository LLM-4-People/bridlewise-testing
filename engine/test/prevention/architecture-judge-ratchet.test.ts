/**
 * THE ARCHITECTURE JUDGE IS A GATE, AND ITS BASELINE CANNOT BE DELETED AWAY.
 *
 * `harness check` runs the derived architecture judge (S1's structural
 * verifier over the census) as the shrink-only ratchet `architecture-judge`
 * (scripts/verification/ratchet-baselines.ts). Planted here:
 *
 * - a module that takes a folder default which does not fit it is NEW debt,
 *   refused (the real judge, on a whole-repository working copy);
 * - a deleted baseline is refused (`missing`) — absence converges only by a
 *   typed scope fact read from git's index: a declared partial copy
 *   (skip-worktree) or a tree that tracks none of the baseline's folder;
 * - a baseline that grew since the base it lands on is refused, and a base
 *   the clone does not hold is refused rather than read as "no baseline".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { RATCHET_SCHEMA } from "../../scripts/verification/ratchet.ts";
import { ratchetBaseline, syncRatchetBaselines, type RatchetBaselineSpec } from "../../scripts/verification/ratchet-baselines.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";

const PATH = "tests/prevention/planted-baseline.json";

/** A scratch repository holding one tracked baseline beside another file of its folder, committed. */
function scratch(entries: readonly string[]): Readonly<{ root: string; git: (...args: readonly string[]) => string; spec: RatchetBaselineSpec; findings: string[] }> {
  const root = createTempDir("ratchet-scope-");
  const git = (...args: readonly string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "tests", "prevention"), { recursive: true });
  writeFileSync(join(root, "tests", "prevention", "other.json"), "{}\n");
  writeFileSync(join(root, PATH), `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "planted", entries: entries.map((key) => ({ key, reason: "#0" })) }, null, 2)}\n`);
  git("add", "--", "tests");
  git("commit", "-q", "-m", "base");
  const findings = [...entries];
  return { root, git, findings, spec: { id: "planted", path: PATH, findings: () => findings.map((key) => ({ key, where: key })) } };
}

test("a deleted baseline is refused; absence converges only by a typed scope fact from git's index", () => {
  const { root, git, spec } = scratch(["debt:a"]);
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "current", "liveness");
  rmSync(join(root, PATH));
  const deleted = syncRatchetBaselines(root, false, [spec]);
  assert.equal(deleted.results[0]!.status, "missing", "a deleted baseline would switch its gate off");
  assert.equal(deleted.allCurrent, false);
  // A declared partial working copy: git's index marks the path skip-worktree.
  git("update-index", "--skip-worktree", "--", PATH);
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "outside-copy");
  // A tree that tracks none of the baseline's folder (a projection that strips it).
  git("update-index", "--no-skip-worktree", "--", PATH);
  git("rm", "-q", "-r", "--cached", "--", "tests");
  assert.equal(syncRatchetBaselines(root, false, [spec]).results[0]!.status, "folder-not-in-tree");
});

test("a baseline that grew since the base it lands on is refused; an unknown base is refused, never read as an introduction", () => {
  const { root, git, spec, findings } = scratch(["debt:a"]);
  const base = git("rev-parse", "HEAD").trim();
  findings.push("debt:b");
  writeFileSync(join(root, PATH), `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "planted", entries: findings.map((key) => ({ key, reason: "#0" })) }, null, 2)}\n`);
  git("commit", "-q", "-am", "grow");
  const grown = syncRatchetBaselines(root, false, [spec], base);
  assert.equal(grown.results[0]!.status, "grown");
  assert.deepEqual(grown.results[0]!.grown, ["debt:b"]);
  assert.equal(grown.allCurrent, false);
  assert.equal(syncRatchetBaselines(root, false, [spec], "HEAD").results[0]!.status, "current", "against its own commit nothing grew (liveness)");
  assert.throws(() => syncRatchetBaselines(root, false, [spec], "0".repeat(40)), (error: unknown) => (error as { code?: unknown }).code === "ratchet_base_unknown");
});

test("the real judge refuses a module that takes a folder default which does not fit it", () => {
  const copy = createRepositoryWorkingCopy("architecture-judge-default-");
  try {
    // src/workflow/'s default is the runtime realm; this module reaches into the builder realm.
    writeFileSync(join(copy.engineRoot, "src", "workflow", "zz-wrong-default.ts"), `import { RATCHET_SCHEMA } from "../../scripts/verification/ratchet.ts";\n\n/** A module on a default that does not fit it. */\nexport const planted = RATCHET_SCHEMA;\n`);
    execFileSync("git", ["add", "-N", "--", "engine/src/workflow/zz-wrong-default.ts"], { cwd: copy.root });
    const judged = syncRatchetBaselines(copy.root, false, [ratchetBaseline("architecture-judge")]).results[0]!;
    assert.equal(judged.status, "current", `the copy's baseline matches its judge apart from the plant: ${judged.stale.slice(0, 5).join(", ")}`);
    assert.ok(judged.unbaselined.includes("architecture-realm-direction:src/workflow/zz-wrong-default.ts->scripts/verification/ratchet.ts"),
      `the silent default is new debt: ${judged.unbaselined.join(", ")}`);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
