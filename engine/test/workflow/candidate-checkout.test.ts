/**
 * THE CANDIDATE CLI, DRIVEN (`scripts/tooling/candidate-checkout.ts`).
 *
 * The tool treats the checkout it lives in as the SOURCE, so every arm runs
 * the CLI of a mirrored working copy of this repository (the "source") and
 * builds the candidate from it — never from, or back into, the live checkout.
 * Claims driven here:
 *
 *   A. `create` makes missing target parents (it used to die with ENOENT);
 *   B. `refresh` keeps the candidate's regenerated outputs when the source's
 *      copy is merely stale, and takes the source's copy when the source
 *      really changed it since the base;
 *   C. `copy-back` refuses a source that moved outside the authored outputs
 *      (`candidate_source_moved`), a source whose authored output changed
 *      since the base (`candidate_copy_back_conflict`), and a candidate
 *      missing an output (`candidate_output_missing`) — each before writing
 *      a single byte of the source;
 *   D. a copy-back whose `harness check` fails in the source is ROLLED BACK
 *      (`candidate_copy_back_unverified`): the backups were still on disk;
 *   E. a copy-back a crash interrupted (a journal left in the source) is
 *      rolled back by the next run of the tool, whatever its subcommand;
 *   F. a converged candidate copies back, verified, and records the new base:
 *      an immediate second copy-back is not a false "another writer" conflict;
 *      the copy-back IMPORTS the candidate's judged suite runs newer than the
 *      source's newest into the source's ledgers, marked with the candidate's
 *      path, once (step6-readiness-2 F-3: the live ledger was ten days stale
 *      while the qualifying runs sat in the candidate) — and only the runs
 *      that measured the candidate's CURRENT tree: started after its tree last
 *      changed, not a mutation run (wf-del2-correctness NEW-1);
 *   G. `withdraw-imports --since` removes the rows imported from the
 *      candidate that did not measure its tree since then, and nothing else.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { ownedFiles } from "../../src/git/repository-ownership.ts";
import { stageInCopy } from "../../src/git/working-copy.ts";
import { indexBaselinePath } from "../../src/git/index-baseline.ts";
import { pinnedBuildOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { createRepositoryLocalTemporaryDirectory, createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory, TEST_REPOSITORY_ROOT } from "../support/repository-local-temporary.ts";
import { journalPathFor } from "../../src/filesystem/journaled-commit.ts";

type CliOutcome = Readonly<{ status: number | null; json: Record<string, unknown> }>;

function cli(sourceEngine: string, argv: readonly string[]): CliOutcome {
  const result = spawnSync(process.execPath, [join(sourceEngine, "scripts", "tooling", "candidate-checkout.ts"), ...argv], {
    cwd: sourceEngine, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26,
  });
  // The result is the last JSON line of stdout, or (a refusal) of stderr —
  // central logging's audit lines share stderr with it.
  const lastJson = (text: string): string | undefined => text.trim().split("\n").reverse().find((line) => line.startsWith("{"));
  const line = lastJson(result.stdout) ?? lastJson(result.stderr) ?? "{}";
  return { status: result.status, json: JSON.parse(line) as Record<string, unknown> };
}

/** sha256 of every owned file of `root` (the "nothing was written" witness). */
function ownedFingerprint(root: string): string {
  const hash = createHash("sha256");
  for (const path of [...(ownedFiles(root) ?? [])].sort()) {
    hash.update(path);
    try { hash.update(readFileSync(join(root, path))); } catch { hash.update("<absent>"); }
  }
  return hash.digest("hex");
}

test("candidate CLI: create makes missing parents; refresh keeps regenerated outputs; copy-back refuses moved, conflicting and incomplete candidates before writing", () => {
  const source = createRepositoryWorkingCopy("candidate-cli-source-");
  const scratch = createRepositoryLocalTemporaryDirectory("candidate-cli-target-");
  try {
    // A. Parents that do not exist yet. The source stages a modification
    // HEAD does not hold first: `create` records it as protected.
    const readme = join(source.engineRoot, "README.md");
    writeFileSync(readme, `${readFileSync(readme, "utf8")}\nA staged line only the index holds.\n`);
    stageInCopy(source.root, ["engine/README.md"]);
    const target = join(scratch, "deep", "er", "candidate");
    const created = cli(source.engineRoot, ["create", "--target", target, "--no-setup", "--no-sync"]);
    assert.equal(created.status, 0, JSON.stringify(created.json));
    // A subcommand on a candidate that does not exist is named, typed (it was "undefinedundefined", or exit 0).
    for (const subcommand of ["sync", "diff"]) {
      assert.equal(cli(source.engineRoot, [subcommand, "--target", join(scratch, "never-created")]).json["error"], "candidate_target_missing", subcommand);
    }
    // The candidate carries the source's git identity in its OWN config.
    const identityOf = (root: string, scope: readonly string[]) => spawnSync("git", ["config", ...scope, "--get", "user.email"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(identityOf(target, ["--local"]), identityOf(source.root, []), "the candidate did not take the source's git identity");

    // A2. A slip that drops the protected staged blob refuses every later
    // command until the one repair (the engine CLI's `harness index repair`)
    // restores it exactly.
    const indexBefore = execFileSync("git", ["ls-files", "-s"], { cwd: source.root, encoding: "utf8" });
    execFileSync("git", ["rm", "-q", "--cached", "-f", "engine/README.md"], { cwd: source.root });
    const drifted = cli(source.engineRoot, ["diff", "--target", target]);
    assert.equal(drifted.json["error"], "live_index_drifted", JSON.stringify(drifted.json));
    assert.match(String(drifted.json["message"]), /engine\/README\.md/u);
    assert.match(String(drifted.json["message"]), /harness index repair/u);
    const repaired = spawnSync(process.execPath, [join(source.engineRoot, "src", "cli.ts"), "harness", "index", "repair"], { cwd: source.engineRoot, encoding: "utf8", timeout: 600_000 });
    assert.equal(repaired.status, 0, `${repaired.stdout}${repaired.stderr}`);
    assert.equal(execFileSync("git", ["ls-files", "-s"], { cwd: source.root, encoding: "utf8" }), indexBefore, "harness index repair did not restore the index exactly");
    assert.equal(cli(source.engineRoot, ["diff", "--target", target]).status, 0);
    const schema = ROOT_POLICY.configuration.contract.generatedSchemaPath;
    const inSource = join(source.engineRoot, schema);
    const inCandidate = join(target, "engine", schema);
    const original = readFileSync(inSource, "utf8");

    // B. The candidate "regenerates" an authored output; the source's stale
    // copy never overwrites it on refresh.
    writeFileSync(inCandidate, `${original.trimEnd()}\n\n`);
    const kept = cli(source.engineRoot, ["refresh", "--target", target, "--no-sync"]);
    assert.equal(kept.status, 0, JSON.stringify(kept.json));
    assert.equal(readFileSync(inCandidate, "utf8"), `${original.trimEnd()}\n\n`, "refresh overwrote the candidate's regenerated output");
    // …but a real source change of that file since the base is taken.
    writeFileSync(inSource, `${original.trimEnd()} \n`);
    const taken = cli(source.engineRoot, ["refresh", "--target", target, "--no-sync"]);
    assert.equal(taken.status, 0, JSON.stringify(taken.json));
    assert.equal(readFileSync(inCandidate, "utf8"), `${original.trimEnd()} \n`);
    writeFileSync(inCandidate, `${original.trimEnd()}\n\n`);

    // C1. The source moved outside the authored outputs.
    const input = join(source.engineRoot, "src", "kernel", "config-contracts.ts");
    const inputBytes = readFileSync(input, "utf8");
    writeFileSync(input, `${inputBytes}// moved\n`);
    let before = ownedFingerprint(source.root);
    const moved = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(moved.status, 1);
    assert.equal(moved.json["error"], "candidate_source_moved");
    assert.equal(ownedFingerprint(source.root), before, "a refused copy-back wrote the source");
    writeFileSync(input, inputBytes);

    // C2. The source's copy of an authored output changed since the base.
    writeFileSync(inSource, `${original.trimEnd()}  \n`);
    before = ownedFingerprint(source.root);
    const conflict = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(conflict.status, 1);
    assert.equal(conflict.json["error"], "candidate_copy_back_conflict");
    assert.match(String(conflict.json["message"]), new RegExp(schema.replaceAll(".", "\\."), "u"));
    assert.equal(ownedFingerprint(source.root), before, "a refused copy-back wrote the source");

    // C3. A candidate without its build outputs (created with --no-setup):
    // refused before anything is written, never half-applied.
    const rebased = cli(source.engineRoot, ["refresh", "--target", target, "--no-sync"]);
    assert.equal(rebased.status, 0, JSON.stringify(rebased.json));
    writeFileSync(inCandidate, `${original.trimEnd()}\n\n`);
    before = ownedFingerprint(source.root);
    const incomplete = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(incomplete.status, 1);
    assert.equal(incomplete.json["error"], "candidate_output_missing");
    assert.equal(ownedFingerprint(source.root), before, "a refused copy-back wrote the source");

    // The pinned build outputs, as a setup would have built them.
    for (const path of pinnedBuildOutputPaths()) {
      if (!existsSync(join(source.root, path))) continue;
      mkdirSync(dirname(join(target, path)), { recursive: true });
      copyFileSync(join(source.root, path), join(target, path));
    }
    const journal = journalPathFor(source.root, "candidate-copy-back");

    // D. The candidate's output does not describe the source: `harness check`
    // fails there, and every written file is put back.
    writeFileSync(inCandidate, `${original.trimEnd()}\n{ "not": "the schema" }\n`);
    before = ownedFingerprint(source.root);
    const unverified = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(unverified.status, 1);
    assert.equal(unverified.json["error"], "candidate_copy_back_unverified", JSON.stringify(unverified.json));
    // The refusal names the failing check step and its reason, not the
    // progress lines that only say which step was running (#148).
    assert.match(String(unverified.json["message"]), /harness check fails in the source: [a-z][a-z-]*: \S/u, String(unverified.json["message"]));
    assert.doesNotMatch(String(unverified.json["message"]), /Checking the /u);
    assert.equal(ownedFingerprint(source.root), before, "a copy-back that failed its check left its writes in the source");
    assert.equal(existsSync(journal), false);
    writeFileSync(inCandidate, original);

    // E. A crash between two renames left a journal: the next run of the
    // tool (here `diff`) rolls it back before doing anything else.
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `const { commitJournaled } = await import(${JSON.stringify(pathToFileURL(join(source.engineRoot, "src", "filesystem", "journaled-commit.ts")).href)});`,
      `commitJournaled(${JSON.stringify(source.root)}, "candidate-copy-back", [`,
      `  { path: ${JSON.stringify(`engine/${schema}`)}, bytes: Buffer.from("half\\n"), mode: 0o644 },`,
      `  { path: "engine/README.md", bytes: Buffer.from("half\\n"), mode: 0o644 },`,
      `], { onPhase: (phase) => { if (phase === ${JSON.stringify(`committed:engine/${schema}`)}) process.kill(process.pid, "SIGKILL"); } });`,
    ].join("\n")], { encoding: "utf8" });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    assert.equal(readFileSync(inSource, "utf8"), "half\n", "the crash landed between the two renames");
    const recovered = spawnSync(process.execPath, [join(source.engineRoot, "scripts", "tooling", "candidate-checkout.ts"), "diff", "--target", target], {
      cwd: source.engineRoot, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26,
    });
    assert.match(recovered.stderr, /"recoveredCopyBack":"rolled-back"/u);
    assert.equal(ownedFingerprint(source.root), before, "the next run did not restore the interrupted copy-back");
    assert.equal(existsSync(journal), false);

    // E2. A copy-back whose owner is still RUNNING (blocked in its verify, as
    // a real one is during `harness check`) is never recovered by a concurrent
    // run: `diff` reports it in progress and leaves it; a second copy-back is
    // refused (wf1c-design H-1: a concurrent `diff` used to roll it back and
    // the copy-back then reported success over the old bytes).
    const inVerify = join(scratch, "in-verify");
    const go = join(scratch, "go");
    const waitFor = (condition: () => boolean, what: string): void => {
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 1500 && !condition(); i += 1) Atomics.wait(pause, 0, 0, 20);
      assert.ok(condition(), what);
    };
    const owner = spawn(process.execPath, ["--input-type=module", "-e", [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `const { commitJournaled } = await import(${JSON.stringify(pathToFileURL(join(source.engineRoot, "src", "filesystem", "journaled-commit.ts")).href)});`,
      `const pause = new Int32Array(new SharedArrayBuffer(4));`,
      `commitJournaled(${JSON.stringify(source.root)}, "candidate-copy-back", [{ path: "engine/README.md", bytes: Buffer.from("in flight\\n"), mode: 0o644 }],`,
      `  { verify: () => { writeFileSync(${JSON.stringify(inVerify)}, ""); while (!existsSync(${JSON.stringify(go)})) Atomics.wait(pause, 0, 0, 20); throw new Error("released"); } });`,
    ].join("\n")], { stdio: "ignore" });
    try {
      waitFor(() => existsSync(inVerify), "the owner never reached its verify");
      const during = spawnSync(process.execPath, [join(source.engineRoot, "scripts", "tooling", "candidate-checkout.ts"), "diff", "--target", target], {
        cwd: source.engineRoot, encoding: "utf8", timeout: 600_000, maxBuffer: 1 << 26,
      });
      assert.equal(during.status, 0, during.stderr);
      assert.match(during.stderr, /"recoveredCopyBack":"in-progress"/u);
      assert.equal(existsSync(journal), true, "a concurrent diff removed a live copy-back's journal");
      assert.equal(readFileSync(join(source.engineRoot, "README.md"), "utf8"), "in flight\n", "a concurrent diff rolled back a live copy-back");
      const second = cli(source.engineRoot, ["copy-back", "--target", target]);
      assert.equal(second.json["error"], "candidate_copy_back_in_progress", JSON.stringify(second.json));
    } finally {
      writeFileSync(go, "");
    }
    // Released, the owner's own verify fails: IT rolls back, and the journal goes.
    waitFor(() => !existsSync(journal), "the owner never finished its transaction");
    assert.equal(ownedFingerprint(source.root), before, "the owner's rollback did not restore the source");
    owner.unref();

    // F. Converge the candidate, copy back (verified), and copy back again.
    // Its dependencies resolve upward to the live ones; only the bundler is
    // read by path (the bundle build opens the installed esbuild's own
    // package file), so it is linked into an ignored node_modules directory.
    mkdirSync(join(target, "engine", "node_modules"), { recursive: true });
    symlinkSync(join(TEST_REPOSITORY_ROOT, "node_modules", "esbuild"), join(target, "engine", "node_modules", "esbuild"));
    const beforeSync = Date.now();
    const synced = cli(source.engineRoot, ["sync", "--target", target]);
    assert.equal(synced.status, 0, JSON.stringify(synced.json));
    const rewrote = ((synced.json["convergence"] as { changedByPass: string[][] }).changedByPass[0] ?? []).length > 0;
    const plant = (path: string, runs: readonly object[]): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ runs }));
    };
    const runsOf = (path: string): Record<string, unknown>[] => (JSON.parse(readFileSync(path, "utf8")) as { runs: Record<string, unknown>[] }).runs;
    // The instant the candidate's tree last changed (the sync above), from its base.
    const treeSince = Date.parse((JSON.parse(readFileSync(join(target, ".git", "bridlewise-candidate-base.json"), "utf8")) as { treeSince: string }).treeSince);
    assert.ok(Number.isFinite(treeSince), "the candidate base records no tree instant");
    // The sync rewrote an output (the schema the B arm edited in the candidate): the tree changed then.
    assert.ok(rewrote, "the fixture's sync rewrote nothing, so this arm cannot see the tree instant move");
    assert.ok(treeSince >= beforeSync, "a sync that rewrote an output did not move the candidate's tree instant");
    // A row recorded `endsAfter` ms after that instant, having run `wallClockMs`.
    const run = (endsAfter: number, wallClockMs: number | null, failures: readonly string[], extra: object = {}) => ({
      timestamp: new Date(treeSince + endsAfter).toISOString(), cpuMsPerTestFile: 1, testModuleCount: 1, failures,
      ...(wallClockMs === null ? {} : { wallClockMs }), ...extra,
    });
    const webLedger = join(".bridlewise", "web-test-results", "run-history.json");
    const engineLedger = join("engine", ".bridlewise", "state", "test-results", "run-history.json");
    plant(join(source.root, webLedger), [run(-10 * 86_400_000, 1_000, ["stale"])]);
    // TWO ROUNDS (wf-del2-correctness NEW-1): only the rows that measured the
    // candidate's CURRENT tree are the source's — never a superseded round's.
    plant(join(target, webLedger), [
      run(-11 * 86_400_000, 1_000, ["older than the source's"]),
      run(-3_600_000, 60_000, ["round 1: a tree the source never holds"]),
      run(30_000, 60_000, ["round 2: started before the tree last changed"]),
      run(120_000, 60_000, ["qualified"]),
      run(130_000, 60_000, ["a planted mutation"], { mutationRun: true }),
      run(140_000, null, ["cannot say when it started"]),
    ]);
    plant(join(target, engineLedger), [run(60_000, 1_000, [])]);
    const landed = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(landed.status, 0, JSON.stringify(landed.json));
    assert.equal(landed.json["check"], "pass");
    assert.deepEqual(landed.json["ledgers"], { engine: 1, web: 1 }, "the copy-back did not import exactly the candidate's runs of its current tree");
    assert.deepEqual(runsOf(join(source.root, webLedger)).map((row) => [row["failures"], row["importedFrom"]]), [[["stale"], undefined], [["qualified"], target]]);
    const again = cli(source.engineRoot, ["copy-back", "--target", target]);
    assert.equal(again.status, 0, `a second copy-back was refused after its own success: ${JSON.stringify(again.json)}`);
    assert.deepEqual(again.json["written"], []);
    assert.deepEqual(again.json["ledgers"], { engine: 0, web: 0 }, "a second copy-back imported the same runs again");

    // G. The repair: rows imported before the bound existed are withdrawn by
    // the same rule; a row measured in the source, or imported from another
    // candidate, is never touched.
    const since = new Date(treeSince).toISOString();
    plant(join(source.root, webLedger), [
      run(-10 * 86_400_000, 1_000, ["measured here"]),
      run(-3_600_000, 60_000, ["a superseded round"], { importedFrom: target }),
      run(120_000, 60_000, ["qualified"], { importedFrom: target }),
      run(-3_600_000, 60_000, ["another candidate's"], { importedFrom: "/elsewhere/repo" }),
    ]);
    assert.equal(cli(source.engineRoot, ["withdraw-imports", "--target", target]).json["error"], "candidate_usage", "withdraw-imports ran without its bound");
    const withdrawn = cli(source.engineRoot, ["withdraw-imports", "--target", target, "--since", since]);
    assert.equal(withdrawn.status, 0, JSON.stringify(withdrawn.json));
    assert.deepEqual((withdrawn.json["withdrawn"] as Record<string, unknown>)["web"], [new Date(treeSince - 3_600_000).toISOString()]);
    assert.deepEqual(runsOf(join(source.root, webLedger)).map((row) => row["failures"]), [["measured here"], ["qualified"], ["another candidate's"]]);
  } finally {
    removeRepositoryLocalTemporaryDirectory(scratch);
    removeRepositoryLocalTemporaryDirectory(source.root);
  }
});

test("candidate CLI: `snapshot` records the source's tree under a name; `create --from` builds exactly that tree, and such a candidate never refreshes from or copies back into the source", () => {
  const source = createRepositoryWorkingCopy("candidate-snapshot-source-");
  const scratch = createRepositoryLocalTemporaryDirectory("candidate-snapshot-target-");
  try {
    const readme = join(source.engineRoot, "README.md");
    const recorded = `${readFileSync(readme, "utf8")}\nA line the snapshot records.\n`;
    writeFileSync(readme, recorded);
    const indexBefore = execFileSync("git", ["ls-files", "-s"], { cwd: source.root, encoding: "utf8" });
    // A snapshot commit carries the repository's configured identity (the
    // tool's git reads the directory alone, no GIT_* variable); a copy
    // configures none, so the test configures one, as a checkout would.
    for (const [key, value] of [["user.name", "Snapshot Test"], ["user.email", "snapshot@example.invalid"]] as const) {
      execFileSync("git", ["config", key, value], { cwd: source.root });
    }
    const snapshot = cli(source.engineRoot, ["snapshot", "--name", "wf-test"]);
    assert.equal(snapshot.status, 0, JSON.stringify(snapshot.json));
    assert.equal(snapshot.json["ref"], `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/wf-test`);
    assert.equal(execFileSync("git", ["ls-files", "-s"], { cwd: source.root, encoding: "utf8" }), indexBefore, "the snapshot touched the source's index");
    // The source moves on; the verifier's candidate must hold the SNAPSHOT.
    writeFileSync(readme, `${recorded}A later line the snapshot never saw.\n`);
    const target = join(scratch, "from-snapshot");
    // Only a snapshot ref names a snapshot (WF-1b3b verify L1): HEAD would build a copy whose own commit reads as a staged diff.
    assert.equal(cli(source.engineRoot, ["create", "--target", join(scratch, "from-head"), "--from", "HEAD", "--no-setup", "--no-sync"]).json["error"], "candidate_from_not_snapshot");
    const baselineFile = indexBaselinePath(source.root);
    const baselineBefore = existsSync(baselineFile) ? readFileSync(baselineFile, "utf8") : null;
    const refsBefore = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: source.root, encoding: "utf8" });
    const created = cli(source.engineRoot, ["create", "--target", target, "--from", String(snapshot.json["ref"]), "--no-setup", "--no-sync"]);
    assert.equal(created.status, 0, JSON.stringify(created.json));
    // Read-only toward the source: no index-baseline record, no pinned ref.
    assert.equal(existsSync(baselineFile) ? readFileSync(baselineFile, "utf8") : null, baselineBefore, "create --from recorded an index baseline in the source");
    assert.equal(execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: source.root, encoding: "utf8" }), refsBefore, "create --from moved a ref of the source");
    assert.equal(readFileSync(join(target, "engine", "README.md"), "utf8"), recorded, "the candidate holds the source's later bytes, not the snapshot's");
    assert.equal(execFileSync("git", ["write-tree"], { cwd: target, encoding: "utf8" }).trim(), snapshot.json["tree"], "the candidate's index is not the snapshot's tree");
    for (const subcommand of ["refresh", "copy-back"]) {
      assert.equal(cli(source.engineRoot, [subcommand, "--target", target]).json["error"], "candidate_from_snapshot", `${subcommand} of a snapshot candidate`);
    }
    assert.equal(cli(source.engineRoot, ["snapshot"]).json["error"], "candidate_usage", "a snapshot needs a name");
  } finally {
    removeRepositoryLocalTemporaryDirectory(scratch);
    removeRepositoryLocalTemporaryDirectory(source.root);
  }
});
