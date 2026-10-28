/**
 * THE COMMIT GUARD CERTIFIES THE STAGED TREE — DRIVEN, IN A WORKING COPY.
 *
 * `scripts/commit-guard.ts` materializes the INDEX (the working-copy
 * builder's "staged" mode) and runs `harness check --skip-typecheck` and both
 * compile legs there, so the certificate describes what the commit records.
 * Every arm runs on a mirrored working copy of this repository (its own git
 * and index), never on the live checkout:
 *
 *   A. a staged, stale schema artifact is refused, naming the step;
 *   B. fresh bytes on disk with the stale bytes still staged: still refused
 *      (the working tree is not what is committed);
 *   C. staging the fresh bytes clears the refusal;
 *   D. regenerated outputs staged WITHOUT the source they were generated
 *      from are refused;
 *   E. sources and outputs staged but a SECOND source they were generated
 *      from left unstaged is refused; staging it too is accepted.
 *
 * The copy's own `typecheck` scripts are replaced (and staged) by a no-op in
 * the baseline: the compile legs are driven in `commit-compile-door.test.ts`;
 * here they must neither cost minutes nor fail on the copy's missing
 * dependencies, so the arms judge the generated facts alone.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { generatedOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { syncFrozenRecords } from "../../src/workflow/record-links.ts";
import { snapshotWorkingTree, stageInCopy } from "../../src/git/working-copy.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

function runGuard(root: string): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync(process.execPath, [join(root, "engine", "scripts", "commit-guard.ts"), root], {
    cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26,
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

/**
 * The copy's OWN generator (`harness sync`), which owns its fixed point: ONE
 * invocation converges even after a registry edit (it repeats its pass until
 * one changes nothing — a1b-design M3), so a second call is never needed.
 */
function regenerate(engineRoot: string): void {
  const result = spawnSync(process.execPath, [join(engineRoot, "src", "cli.ts"), "harness", "sync"], {
    cwd: engineRoot, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26,
  });
  assert.equal(result.status, 0, `one harness sync must converge: ${`${result.stdout}${result.stderr}`.slice(-3000)}`);
}

/** Replaces a package's `typecheck` script with a no-op (see the header). */
function stubTypecheck(packageJson: string): void {
  const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts: Record<string, string> };
  manifest.scripts["typecheck"] = "node -e \"\"";
  writeFileSync(packageJson, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("commit guard: the staged tree is certified — stale, unstaged, source-less and second-source-unstaged outputs are refused", () => {
  const copy = createRepositoryWorkingCopy("commit-guard-facts-");
  try {
    stubTypecheck(join(copy.root, "package.json"));
    stubTypecheck(join(copy.engineRoot, "package.json"));
    // Every stage goes through the one staging door (a raw `git add` in a
    // copy freshens the borrowed store's packs, wf1a-correctness §5).
    // Baseline: the copy's whole tree committed in its OWN repository, so the
    // staged tree starts equal to the (coherent) working tree and only what
    // each arm stages is under judgement.
    stageInCopy(copy.root, ["."]);
    // A commit in a copy through the one snapshot door: `git commit` re-wrote
    // unchanged subtrees whose cache-tree was invalid, and git freshened the
    // canonical store's packs holding them (measured: five packs per run).
    snapshotWorkingTree(copy.root, { message: "baseline", advanceHead: true, identity: { name: "Commit Guard Test", email: "guard.invalid@example.invalid" } });
    const artifact = join(copy.engineRoot, ROOT_POLICY.configuration.contract.generatedSchemaPath);
    const fresh = readFileSync(artifact, "utf8");

    // A. stale bytes staged.
    writeFileSync(artifact, `${fresh.trimEnd()} \n`);
    stageInCopy(copy.root, [artifact]);
    const stale = runGuard(copy.root);
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /STAGED engine's generated facts/u);
    assert.match(stale.stderr, /config-schema-artifact/u);

    // B. fresh on disk, stale still staged: the commit would record the stale bytes.
    writeFileSync(artifact, fresh);
    const unstaged = runGuard(copy.root);
    assert.equal(unstaged.status, 1, unstaged.stderr);
    assert.match(unstaged.stderr, /config-schema-artifact/u);

    // C. staged fresh: accepted.
    stageInCopy(copy.root, [artifact]);
    const staged = runGuard(copy.root);
    assert.equal(staged.status, 0, staged.stderr);

    // D. a source edit, regenerated by the real generator, outputs staged WITHOUT the source.
    const registry = join(copy.engineRoot, "traceability", "requirements.json");
    const narrative = join(copy.engineRoot, "traceability", "canonical", "harness-requirements.md");
    // A format-valid edit (the candidate-format step refuses an extra final newline, so that is no "source edit"):
    // one more space inside a line changes the registry's bytes and nothing else.
    writeFileSync(registry, readFileSync(registry, "utf8").replace('"artifactRole": "', '"artifactRole":  "'));
    regenerate(copy.engineRoot);
    stageInCopy(copy.root, [...generatedOutputPaths()]);
    const sourceless = runGuard(copy.root);
    assert.equal(sourceless.status, 1, `outputs staged without their source must be refused:\n${sourceless.stderr}`);
    assert.match(sourceless.stderr, /STAGED engine's generated facts/u);

    // E. a SECOND source feeding the same outputs, left unstaged.
    appendFileSync(narrative, "An edited line.\n");
    regenerate(copy.engineRoot);
    // Everything the generator changed is staged EXCEPT the second source.
    stageInCopy(copy.root, ["engine", `:(exclude)${narrative.slice(copy.root.length + 1)}`]);
    const secondSource = runGuard(copy.root);
    assert.equal(secondSource.status, 1, `an unstaged second source must be refused:\n${secondSource.stderr}`);
    assert.match(secondSource.stderr, /STAGED engine's generated facts/u);
    stageInCopy(copy.root, [narrative]);
    const coherent = runGuard(copy.root);
    assert.equal(coherent.status, 0, coherent.stderr);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("commit guard: EVERY commit is certified for its frozen records — a docs-only commit that edits a pinned frozen record is refused, named", () => {
  const copy = createRepositoryWorkingCopy("commit-guard-frozen-");
  try {
    stubTypecheck(join(copy.root, "package.json"));
    stubTypecheck(join(copy.engineRoot, "package.json"));
    // A tree that carries no frozen-record population (the public snapshot
    // publishes none) still proves the guard: plant one record outside the
    // engine and pin it through the frozen-record owner, so the refusal below
    // never depends on which records a tree happens to hold.
    if (!existsSync(join(copy.root, ROOT_POLICY.verification.frozenRecordManifest))) {
      const plantedRoot = ROOT_POLICY.verification.frozenRecordRoots.find((root) => !root.startsWith("engine/"))!;
      mkdirSync(join(copy.root, plantedRoot), { recursive: true });
      writeFileSync(join(copy.root, plantedRoot, "planted-frozen-record.md"), "# A planted frozen record\n\nIts bytes are pinned.\n");
      syncFrozenRecords(copy.root, true);
    }
    stageInCopy(copy.root, ["."]);
    snapshotWorkingTree(copy.root, { message: "baseline", advanceHead: true, identity: { name: "Commit Guard Test", email: "guard.invalid@example.invalid" } });
    const manifest = JSON.parse(readFileSync(join(copy.root, ROOT_POLICY.verification.frozenRecordManifest), "utf8")) as { files: Record<string, string> };
    const record = Object.keys(manifest.files).find((path) => !path.startsWith(`${ROOT_POLICY.verification.frozenRecordRoots.find((root) => root.startsWith("engine/")) ?? "engine/"}`))!;
    assert.ok(!record.startsWith("engine/"), `a frozen record outside the engine, so the commit touches no engine path: ${record}`);
    appendFileSync(join(copy.root, record), "\nrewritten history\n");
    stageInCopy(copy.root, [record]);
    const refused = runGuard(copy.root);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /\[commit-guard\] frozen records \(staged tree\): fail/u);
    assert.ok(refused.stderr.includes(`history changed: ${record}`), refused.stderr);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
