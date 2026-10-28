/**
 * THE ARCHITECTURE JUDGE IS A GATE, AND ITS BASELINE CANNOT BE DELETED AWAY.
 *
 * `harness check` runs the derived architecture judge (S1's structural
 * verifier over the census) as the shrink-only ratchet `architecture-judge`
 * (scripts/verification/ratchet-baselines.ts). Planted here:
 *
 * - a module that takes a folder default which does not fit it is NEW debt,
 *   refused (the real judge, on a whole-repository working copy);
 * - in every tree but the DECLARED product projection (the promotion's one
 *   owner of that classification), a deleted baseline is refused (`missing`),
 *   with no scope exception, and a deleted judge (S1) is refused too — never
 *   skipped; the declared product does not run the gate and says so;
 * - growth against the base is the commit guard's judgement, keyed by id: a
 *   grown baseline is refused, a moved and renamed one hides nothing, and a
 *   base the clone does not hold is refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { structureAnswer } from "../../scripts/tooling/s1-verification.ts";
import { RATCHET_SCHEMA, ratchetGrowthSince } from "../../scripts/verification/ratchet.ts";
import { ratchetBaseline, syncRatchetBaselines, type RatchetBaselineSpec } from "../../scripts/verification/ratchet-baselines.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { stageInCopy } from "../../src/git/working-copy.ts";
import { workingTreeReader } from "../../src/git/tree-reader.ts";
import { loadPromotionProfiles } from "../../src/workflow/promotion/profile.ts";
import { classifyTree, shippedSources } from "../../src/workflow/promotion/projection.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { declaredTreeKind, PRODUCT_TREE_DECLARATION } from "../../src/workflow/promotion/tree-kind.ts";

const PATH = "tests/prevention/planted-baseline.json";

/** A scratch repository holding one tracked testing-floor baseline, committed. */
function scratch(entries: readonly string[]): Readonly<{ root: string; git: (...args: readonly string[]) => string; spec: RatchetBaselineSpec; findings: string[] }> {
  const root = createTempDir("ratchet-gate-");
  const git = (...args: readonly string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "tests", "prevention"), { recursive: true });
  writeFileSync(join(root, PATH), document(entries));
  git("add", "--", "tests");
  git("commit", "-q", "-m", "base");
  const findings = [...entries];
  return { root, git, findings, spec: { id: "planted", path: PATH, testingFloor: true, findings: () => findings.map((key) => ({ key, where: key })) } };
}

function document(entries: readonly string[]): string {
  return `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "planted", entries: entries.map((key) => ({ key, reason: "#0" })) }, null, 2)}\n`;
}

test("in every tree but the DECLARED product, a missing baseline is refused — no scope exception; the declared product does not run the gate", () => {
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
  // A declaration beside any testing-floor fact (here: this gate's own folder and baseline) is a CONTRADICTION: the
  // tree is judged as the source it is — the gate still runs — and the declaration is refused.
  writeFileSync(join(root, PATH), document(["debt:a"]));
  writeFileSync(join(root, PRODUCT_TREE_DECLARATION), "product\n");
  const contradicted = syncRatchetBaselines(root, false, [spec]);
  assert.equal(contradicted.results[0]!.status, "current", "the gate ran");
  assert.deepEqual(contradicted.results[0]!.contradiction, ["tests", PATH], "every testing-floor fact present is named");
  assert.equal(contradicted.allCurrent, false, "the declaration is refused");
  // Only a tree with the declaration and NONE of the testing floor is the product: no gate, and it says so.
  rmSync(join(root, "tests"), { recursive: true, force: true });
  const product = syncRatchetBaselines(root, false, [spec]);
  assert.equal(product.results[0]!.status, "not-in-this-tree");
  assert.equal(product.allCurrent, true);
});

test("the real judge refuses a module on a folder default that does not fit it — and the reviewer's forgery (a declaration plus a deleted promotion/) cannot switch it off: the gate RUNS and refuses", () => {
  const copy = createRepositoryWorkingCopy("architecture-judge-forgery-");
  try {
    writeFileSync(join(copy.root, PRODUCT_TREE_DECLARATION), "product\n");
    rmSync(join(copy.root, "promotion"), { recursive: true, force: true });
    // src/workflow/'s default is the runtime realm; this module reaches into the builder realm.
    writeFileSync(join(copy.engineRoot, "src", "workflow", "zz-forged.ts"), `import { RATCHET_SCHEMA } from "../../scripts/verification/ratchet.ts";\n\n/** A module on a default that does not fit it. */\nexport const forged = RATCHET_SCHEMA;\n`);
    // The reviewer's README plant: a competing evidence authority in prose is gated too.
    appendFileSync(join(copy.engineRoot, "src", "filesystem", "README.md"), "\nauthority: timeline\n");
    stageInCopy(copy.root, ["engine/src/workflow/zz-forged.ts", "engine/src/filesystem/README.md"]);
    const judged = syncRatchetBaselines(copy.root, false, [ratchetBaseline("architecture-judge")]);
    const result = judged.results[0]!;
    assert.notEqual(result.status, "not-in-this-tree", "a testing tree can never read as the product");
    assert.ok(result.contradiction.includes("tests") && result.contradiction.includes("engine/test"), result.contradiction.join(", "));
    assert.ok(result.unbaselined.includes("architecture-realm-direction:src/workflow/zz-forged.ts->scripts/verification/ratchet.ts"), result.unbaselined.join(", "));
    assert.ok(result.unbaselined.includes("evidence-graph-competing-authority:src/filesystem/README.md"), result.unbaselined.join(", "));
    assert.equal(judged.allCurrent, false);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("the REAL profile ships TREE-KIND.txt and none of the testing floor, and over that projection the gate reports not-in-this-tree", () => {
  const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
  const document = loadPinnedConfigSnapshot().document;
  const tree = workingTreeReader(repositoryRoot);
  const profiles = loadPromotionProfiles(tree, document.promotion!.profileDirectory, new Set(Object.keys(document.workspaceIsolation?.commands ?? {})));
  const product = profiles.find((loaded) => loaded.profile.name === document.promotion?.release?.profile);
  assert.ok(product !== undefined, "the release profile is loaded (liveness)");
  const shipped = shippedSources(classifyTree(tree, product.profile));
  assert.equal(shipped.get(PRODUCT_TREE_DECLARATION), `product-only/${PRODUCT_TREE_DECLARATION}`, "the overlay ships the declaration at the product's root");
  for (const fact of ["engine/scripts/tooling/s1-verification.ts", VERIFICATION_PATHS.architectureJudgeBaseline]) assert.equal(shipped.has(fact), false, `${fact} ships`);
  for (const folder of ["tests/", "engine/test/", `${document.promotion!.profileDirectory}/`]) {
    assert.equal([...shipped.keys()].some((path) => path.startsWith(folder)), false, `${folder} ships`);
  }
  // The projection's files the gate reads: the declaration, and none of the testing floor.
  const projected = createTempDir("product-projection-");
  writeFileSync(join(projected, PRODUCT_TREE_DECLARATION), readFileSync(join(repositoryRoot, shipped.get(PRODUCT_TREE_DECLARATION)!), "utf8"));
  const answer = syncRatchetBaselines(projected, false, [ratchetBaseline("architecture-judge")]);
  assert.equal(answer.results[0]!.status, "not-in-this-tree");
  assert.equal(answer.allCurrent, true);
});

test("every finding kind is classified by name: gated, or shown under the check that owns it; a kind nobody classified is reported for refusal", () => {
  const answer = structureAnswer(["architecture-reverse-layer:a->b", "s2-test-inventory-unavailable", "evidence-graph-competing-authority:x.md", "a-kind-nobody-classified:y"]);
  assert.deepEqual(answer.structural, ["architecture-reverse-layer:a->b", "evidence-graph-competing-authority:x.md"]);
  assert.deepEqual(Object.values(answer.shown).flat(), ["s2-test-inventory-unavailable"]);
  assert.ok(Object.keys(answer.shown).every((owner) => owner.includes("#599") || owner.startsWith("harness check:")), "each shown family names the check that owns it");
  assert.deepEqual(answer.unclassified, ["a-kind-nobody-classified:y"]);
});

test("a testing tree whose architecture judge (S1) is deleted is refused, not skipped", () => {
  const root = createTempDir("ratchet-no-instrument-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  mkdirSync(join(root, "tests", "prevention"), { recursive: true });
  writeFileSync(join(root, VERIFICATION_PATHS.architectureJudgeBaseline), `${JSON.stringify({ schema: RATCHET_SCHEMA, id: "architecture-judge", entries: [] }, null, 2)}\n`);
  assert.equal(declaredTreeKind(root, ["promotion"]).kind, "source", "an undeclared tree is a source tree");
  assert.throws(() => syncRatchetBaselines(root, false, [ratchetBaseline("architecture-judge")]), (error: unknown) => (error as { code?: unknown }).code === "ratchet_instrument_absent");
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

