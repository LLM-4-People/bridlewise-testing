/**
 * MERGE SHARD REPORTS INTO ONE QUALIFICATION RECEIPT.
 *
 * Sharding changes the unit of execution, not the claim. A set of green shard
 * jobs is not evidence about the full suite until someone proves that the
 * shards cover the canonical file set exactly once. This module is that proof:
 *
 *   - the manifest is the canonical list produced by `vitest list --filesOnly`;
 *   - every shard report names the files it actually ran;
 *   - the union must equal the manifest, with no missing file, no duplicate
 *     file, no file from outside the root, and no failed shard;
 *   - the receipt records relative paths only, the shard count, the test
 *     counts, a hash of the manifest it judged, and the named exclusions with
 *     their evidence anchors from the checked-in manifest.
 *
 * A shard report with zero files is valid only when the manifest is empty. A
 * missing report is not an empty shard. The caller must pass exactly the
 * expected number of reports or the merge fails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isEntryPoint } from "../engine/src/runtime/entry-point.ts";
import {
  PLAN_SCHEMA,
  SHARD_REPORT_SCHEMA,
  assignShards,
  assignmentHash as hashAssignment,
  fail,
  manifestHash as hashManifest,
  normalizeFile,
  readJson,
  readShardPopulation,
  requireGreenReport,
} from "./test-shard-manifest.mjs";

export const RECEIPT_SCHEMA = "bridlewise-test-shard-receipt/v1";

function readManifest(root, path) {
  const entries = readJson(path, "manifest");
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("manifest: expected a non-empty JSON array from `vitest list --filesOnly --json`");
  }
  const files = entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      fail(`manifest: entry ${index} is not an object`);
    }
    return normalizeFile(root, entry.file, `manifest entry ${index}`);
  });
  const unique = [...new Set(files)].sort();
  if (unique.length !== files.length) {
    fail("manifest: the same test file appears more than once");
  }
  return unique;
}

function readPlan(path) {
  const plan = readJson(path, "plan");
  if (plan === null || typeof plan !== "object") fail("plan: not an object");
  if (plan.schemaVersion !== PLAN_SCHEMA) fail(`plan: expected schema ${PLAN_SCHEMA}`);
  if (!Array.isArray(plan.shards) || plan.shards.length === 0) fail("plan: no shards");
  if (!Number.isSafeInteger(plan.shardCount) || plan.shardCount !== plan.shards.length) {
    fail("plan: shardCount does not match the shard list");
  }
  if (typeof plan.manifestHash !== "string" || !/^[0-9a-f]{64}$/i.test(plan.manifestHash)) {
    fail("plan: manifestHash is missing");
  }
  if (typeof plan.assignmentHash !== "string" || !/^[0-9a-f]{64}$/i.test(plan.assignmentHash)) {
    fail("plan: assignmentHash is missing");
  }
  if (typeof plan.headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(plan.headSha)) fail("plan: headSha is missing");
  for (const [index, shard] of plan.shards.entries()) {
    if (shard.index !== index + 1 || !Array.isArray(shard.files)) fail(`plan: shard ${index + 1} is malformed`);
  }
  // THE PLAN'S HASH IS A CLAIM ABOUT ITS OWN SHARDS. Every report envelope
  // copies `plan.assignmentHash`, so trusting it without recomputing made a
  // plan (or a receipt) that lied about the assignment agree with itself.
  // Recompute from the plan's bytes before any report is accepted.
  if (hashAssignment(plan.shards) !== plan.assignmentHash) {
    fail("plan: assignmentHash does not match the plan's shard assignment");
  }
  return plan;
}

function readShard(root, path, index, expected, requireTiming) {
  const envelope = readJson(path, `shard ${index}`);
  if (envelope === null || typeof envelope !== "object") {
    fail(`shard ${index}: report is not an object`);
  }
  // A RAW VITEST REPORT IS NOT EVIDENCE. Its provenance used to be checked
  // only when a plan happened to be supplied, so a plan-less merge accepted
  // raw reports and wrote a receipt naming the caller's `--head` with nothing
  // binding the files to that commit. Refused unconditionally: only the
  // wrapper records the head, manifest/assignment hashes, shard identity and
  // timing window this receipt claims.
  if (envelope.schemaVersion !== SHARD_REPORT_SCHEMA) {
    fail(`shard ${index}: report has no ${SHARD_REPORT_SCHEMA} provenance envelope`);
  }
  if (envelope.shard !== index || envelope.shardCount !== expected.shardCount) {
    fail(`shard ${index}: shard identity or count does not match the plan`);
  }
  if (String(envelope.headSha).toLowerCase() !== expected.headSha) {
    fail(`shard ${index}: head ${String(envelope.headSha)} is not ${String(expected.headSha)}`);
  }
  if (envelope.manifestHash !== expected.manifestHash) {
    fail(`shard ${index}: manifest hash does not match the plan`);
  }
  if (envelope.assignmentHash !== expected.assignmentHash) {
    fail(`shard ${index}: assignment hash does not match the plan`);
  }
  const report = envelope.vitest;
  if (report === null || typeof report !== "object") {
    fail(`shard ${index}: report is not an object`);
  }
  const green = requireGreenReport(report, `shard ${index}`);
  const failedTests = green.failedTests;
  const pendingTests = green.pendingTests;
  const todoTests = green.todoTests;
  const results = report.testResults;
  if (!Array.isArray(results)) {
    fail(`shard ${index}: report has no testResults array`);
  }
  const rows = results.map((result, resultIndex) => {
    if (result === null || typeof result !== "object") {
      fail(`shard ${index}: testResults[${resultIndex}] is not an object`);
    }
    const file = normalizeFile(root, result.name, `shard ${index} result ${resultIndex}`);
    // THE SUMMARY IS A CLAIM; THE ROW IS THE RECORD. `numFailedTestSuites`
    // and `numFailedTests` are integers the report carries beside the rows,
    // and a wrapped report could claim zero on both while a row beneath them
    // recorded a failed suite. Worse, the rows could be OMITTED: a report
    // declaring ten green tests beside one empty `assertionResults` array
    // merged as green because the merge counted only the summary integers.
    // Every suite, every test and every failure message is judged here, and
    // the counts below are derived from these rows — never from the summary.
    if (result.status !== "passed") {
      fail(
        `shard ${index}: ${file} records a ${String(result.status)} test suite ` +
          `(the report's summary counts claimed it was green)`,
      );
    }
    if (result.message !== undefined && result.message !== null && String(result.message).length > 0) {
      fail(
        `shard ${index}: ${file} records a passed suite carrying a failure message: ` +
          `${String(result.message).slice(0, 200)}`,
      );
    }
    if (!Array.isArray(result.assertionResults)) {
      fail(`shard ${index}: ${file} has no assertionResults; the test-level result cannot be judged`);
    }
    if (result.assertionResults.length === 0) {
      fail(
        `shard ${index}: ${file} records zero assertions; a supported file that ran no ` +
          `test is not evidence that it passed`,
      );
    }
    for (const assertion of result.assertionResults) {
      if (assertion === null || typeof assertion !== "object") {
        fail(`shard ${index}: ${file} records a test result that is not an object`);
      }
      if (assertion.status !== "passed") {
        fail(
          `shard ${index}: ${file} records a ${String(assertion.status)} test ` +
            `(the report's summary counts claimed it was green)`,
        );
      }
      const failureMessages = assertion.failureMessages;
      const recorded = Array.isArray(failureMessages)
        ? failureMessages.length > 0 ? failureMessages.map(String).join("\n") : ""
        : failureMessages === undefined || failureMessages === null ? "" : String(failureMessages);
      if (recorded.length > 0) {
        fail(
          `shard ${index}: ${file} records a passed test carrying failure messages: ` +
            `${recorded.slice(0, 200)}`,
        );
      }
    }
    return { file, assertions: result.assertionResults.length };
  });
  const files = rows.map((row) => row.file);
  const duplicates = files.filter((file, fileIndex) => files.indexOf(file) !== fileIndex);
  if (duplicates.length > 0) {
    fail(`shard ${index}: duplicate test file(s): ${[...new Set(duplicates)].join(", ")}`);
  }
  // THE ROWS ARE THE SINGLE SOURCE OF THE COUNTS. The summary integers used
  // to be trusted beside the rows, so a report could declare any test count
  // it liked while recording fewer (or no) assertions. Sum the rows, require
  // the declaration to agree, and hand the row sum to the receipt.
  const rowTotal = rows.reduce((sum, row) => sum + row.assertions, 0);
  if (rowTotal !== green.totalTests) {
    fail(
      `shard ${index}: testResults record ${String(rowTotal)} assertion(s), but ` +
        `numTotalTests declares ${String(green.totalTests)}; the rows are the record ` +
        `and the total is only a claim`,
    );
  }
  if (rowTotal !== green.passedTests) {
    fail(
      `shard ${index}: testResults record ${String(rowTotal)} assertion(s), but ` +
        `numPassedTests declares ${String(green.passedTests)}`,
    );
  }
  // BOTH COUNTS COME FROM THE ROWS. This used to re-read `numPassedTests` here
  // and FALL BACK to `total - failed - skipped - todo` when it was absent — a
  // second derivation of the same count, and one that could disagree with the
  // report. Absence and fractions are refused by `requireGreenReport` before
  // this line; the add-up check keeps the other declared counts honest.
  const totalTests = rowTotal;
  const passedTests = green.passedTests;
  if (passedTests < 0 || passedTests + failedTests + pendingTests + todoTests !== totalTests) {
    fail(
      `shard ${index}: test counts do not add up (${String(passedTests)} passed, ` +
        `${String(failedTests)} failed, ${String(pendingTests)} skipped, ` +
        `${String(todoTests)} todo, ${String(totalTests)} total)`,
    );
  }
  let timing;
  if (envelope.timing !== undefined) {
    const candidate = envelope.timing;
    const startedAt = Date.parse(String(candidate?.startedAt));
    const finishedAt = Date.parse(String(candidate?.finishedAt));
    const durationMs = Number(candidate?.durationMs);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || !Number.isFinite(durationMs) || finishedAt < startedAt || durationMs < 0) {
      fail(`shard ${index}: timing is not a valid startedAt, finishedAt, and durationMs`);
    }
    // The duration is the window's LENGTH, so a contradiction between the
    // recorded durationMs and the two timestamps is not a rounding question:
    // it makes the receipt's critical path a number nobody measured. The
    // merge used to take durationMs on faith while computing the window from
    // the timestamps, so a report could claim either.
    if (durationMs !== finishedAt - startedAt) {
      fail(
        `shard ${index}: timing durationMs ${String(durationMs)} does not equal ` +
          `finishedAt - startedAt (${String(finishedAt - startedAt)})`,
      );
    }
    const vitestStart = Number(report.startTime);
    const vitestEnd = Number(report.endTime);
    if (Number.isFinite(vitestStart) && Number.isFinite(vitestEnd)) {
      // When vitest dates its own run, it has to sit inside the window the
      // wrapper recorded: a test process cannot start before its job or
      // finish after it.
      if (vitestStart < startedAt || vitestEnd > finishedAt) {
        fail(
          `shard ${index}: vitest ran ${new Date(vitestStart).toISOString()}…${new Date(vitestEnd).toISOString()}, ` +
            `outside the shard window ${new Date(startedAt).toISOString()}…${new Date(finishedAt).toISOString()}`,
        );
      }
    }
    timing = { startedAtMs: startedAt, finishedAtMs: finishedAt, durationMs };
  }
  if (requireTiming && timing === undefined) fail(`shard ${index}: no measured shard timing`);
  return { index, files: files.sort(), totalTests, passedTests, failedTests, skippedTests: pendingTests + todoTests, timing };
}

export function mergeShardReports({
  root = process.cwd(),
  manifestPath,
  shardPaths,
  expectedShards,
  headSha,
  planPath = undefined,
  weightsPath = undefined,
  runnerClass = undefined,
  requireTiming = true,
  outPath,
  now = new Date(),
}) {
  const repositoryRoot = resolve(root);
  if (!Number.isSafeInteger(expectedShards) || expectedShards <= 0) {
    fail("expectedShards must be a positive integer");
  }
  if (!Array.isArray(shardPaths) || shardPaths.length !== expectedShards) {
    fail(
      `expected ${String(expectedShards)} shard report(s), received ` +
        `${String(Array.isArray(shardPaths) ? shardPaths.length : 0)}`,
    );
  }
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha)) {
    fail("headSha must be a commit SHA");
  }
  // THE PLAN IS REQUIRED. It is the only thing that binds the receipt's head,
  // manifest hash, assignment hash and exact per-shard file assignment to the
  // reports being merged. Without it the merge used to accept raw reports and
  // stamp them with whatever `--head` the caller passed.
  if (planPath == null) {
    fail("plan: --plan is required; a merge without the plan has nothing binding its receipt to the reports");
  }

  const manifest = readManifest(repositoryRoot, manifestPath);
  const plan = readPlan(planPath);
  if (plan.headSha.toLowerCase() !== headSha.toLowerCase()) {
    fail(`plan: head ${plan.headSha} is not ${headSha}`);
  }
  if (plan.shardCount !== expectedShards) fail("plan: shard count does not match expectedShards");
  const computedManifestHash = hashManifest(manifest);
  if (plan.manifestHash !== computedManifestHash) {
    fail("plan: manifest hash does not match the supplied manifest");
  }
  if (weightsPath == null) {
    fail(
      "population: --weights is required to re-derive the shard assignment. " +
        "Without the measured file list and weights the plan's own claim about its shards " +
        "is the only account of who ran what.",
    );
  }
  // The population re-derived from THIS tree (the include binding, each file's own exclusion) and the
  // measured weights: the same inputs the plan was made from.
  const manifestSource = readShardPopulation(repositoryRoot, weightsPath);
  if (manifestSource.hash !== computedManifestHash) {
    fail("population: hash does not match the supplied manifest");
  }
  if (plan.manifestHash !== manifestSource.hash) {
    fail("population: hash does not match the plan");
  }
  if (manifestSource.files.length !== manifest.length) {
    fail("population: supported file count does not match the supplied manifest");
  }
  // THE PLAN IS A CLAIM ABOUT THE ASSIGNMENT, NOT THE ASSIGNMENT. `readPlan`
  // only proves the plan's hash describes the plan's own bytes: a hand-written
  // plan could put every file in shard 1, leave shard 2 empty and carry a
  // recomputed hash. The merge accepted that because it compared the reports
  // with the plan it had just read. Re-derive the canonical LPT assignment
  // from the measured manifest here, at the lowest point that has the weights,
  // and require the plan to BE that assignment.
  const canonicalShards = assignShards(manifestSource.files, plan.shardCount);
  if (plan.shards.length !== canonicalShards.length) {
    fail("plan: shard list does not match the manifest's shard count");
  }
  for (const [index, planned] of plan.shards.entries()) {
    const canonical = canonicalShards[index];
    if (planned.index !== canonical.index) {
      fail(`plan: shard ${String(index + 1)} has index ${String(planned.index)}`);
    }
    if (planned.files.length === 0) {
      fail(
        `plan: shard ${String(index + 1)} has no files while the manifest holds ` +
          `${String(manifestSource.files.length)} supported file(s); it ran nothing`,
      );
    }
    if ([...planned.files].sort().join("\n") !== canonical.files.join("\n")) {
      fail(
        `plan: shard ${String(index + 1)} does not match the assignment re-derived from ` +
          `the measured manifest`,
      );
    }
    if (planned.weightMs !== canonical.weightMs) {
      fail(
        `plan: shard ${String(index + 1)} weight ${String(planned.weightMs)} does not match ` +
          `the measured manifest's ${String(canonical.weightMs)}`,
      );
    }
  }
  const canonicalAssignmentHash = hashAssignment(canonicalShards);
  if (canonicalAssignmentHash !== plan.assignmentHash) {
    fail(
      "plan: assignmentHash does not match the assignment re-derived from the measured manifest",
    );
  }
  const shards = shardPaths.map((path, index) => readShard(repositoryRoot, path, index + 1, {
    headSha: plan.headSha.toLowerCase(),
    manifestHash: plan.manifestHash,
    assignmentHash: plan.assignmentHash,
    shardCount: plan.shardCount,
  }, requireTiming));
  const expected = new Set(manifest);
  const seen = new Map();

  for (const shard of shards) {
    for (const file of shard.files) {
      if (!expected.has(file)) {
        fail(`shard ${shard.index}: file is not in the manifest: ${file}`);
      }
      if (seen.has(file)) {
        fail(`shard ${shard.index}: file also ran in shard ${seen.get(file)}: ${file}`);
      }
      seen.set(file, shard.index);
    }
  }

  const missing = manifest.filter((file) => !seen.has(file));
  if (missing.length > 0) {
    fail(
      `missing ${String(missing.length)} manifest file(s): ${missing.slice(0, 10).join(", ")}` +
        (missing.length > 10 ? ", ..." : ""),
    );
  }

  for (const [index, planned] of plan.shards.entries()) {
    const actual = shards[index].files;
    const expectedFiles = [...planned.files].sort();
    if (actual.join("\n") !== expectedFiles.join("\n")) {
      fail(`shard ${index + 1}: files do not match the plan's exact assignment`);
    }
  }

  const manifestHash = hashManifest(manifest);
  const timings = shards.map((shard) => shard.timing);
  const measuredTiming = timings.every((timing) => timing !== undefined);
  const testPhaseMs = measuredTiming
    ? Math.max(...timings.map((timing) => timing.finishedAtMs)) - Math.min(...timings.map((timing) => timing.startedAtMs))
    : null;
  const testPhaseCpuMs = measuredTiming
    ? timings.reduce((sum, timing) => sum + timing.durationMs, 0)
    : null;
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    generatedAt: now.toISOString(),
    headSha: headSha.toLowerCase(),
    shardCount: expectedShards,
    ...(runnerClass === undefined ? {} : { runnerClass }),
    manifestHash,
    assignmentHash: canonicalAssignmentHash,
    fileCount: manifest.length,
    testCount: shards.reduce((sum, shard) => sum + shard.totalTests, 0),
    passedTests: shards.reduce((sum, shard) => sum + shard.passedTests, 0),
    failedTests: shards.reduce((sum, shard) => sum + shard.failedTests, 0),
    skippedTests: shards.reduce((sum, shard) => sum + shard.skippedTests, 0),
    ...(manifestSource === undefined ? {} : {
      excludedFileCount: manifestSource.excluded.length,
      exclusions: manifestSource.excluded,
    }),
    testPhaseMs,
    testPhaseCpuMs,
    shards: shards.map((shard) => ({
      index: shard.index,
      fileCount: shard.files.length,
      testCount: shard.totalTests,
      passedTests: shard.passedTests,
      failedTests: shard.failedTests,
      skippedTests: shard.skippedTests,
      ...(shard.timing === undefined ? {} : {
        startedAt: new Date(shard.timing.startedAtMs).toISOString(),
        finishedAt: new Date(shard.timing.finishedAtMs).toISOString(),
        durationMs: shard.timing.durationMs,
      }),
    })),
  };

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    manifestPath: null,
    planPath: null,
    weightsPath: null,
    shardPaths: [],
    expectedShards: null,
    headSha: process.env.GITHUB_SHA ?? null,
    runnerClass: undefined,
    requireTiming: true,
    outPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--plan") options.planPath = argv[++index];
    else if (arg === "--weights") options.weightsPath = argv[++index];
    else if (arg === "--shard") options.shardPaths.push(argv[++index]);
    else if (arg === "--expected-shards") options.expectedShards = Number(argv[++index]);
    else if (arg === "--head") options.headSha = argv[++index];
    else if (arg === "--runner") options.runnerClass = argv[++index];
    else if (arg === "--require-timing") options.requireTiming = true;
    else if (arg === "--out") options.outPath = argv[++index];
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.manifestPath) fail("--manifest is required");
  if (!options.weightsPath) fail("--weights is required");
  if (!options.planPath) fail("--plan is required");
  if (!options.outPath) fail("--out is required");
  return options;
}

if (isEntryPoint(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const receipt = mergeShardReports(options);
    process.stdout.write(
      `shard merge: ${String(receipt.shardCount)} shard(s), ` +
        `${String(receipt.fileCount)} file(s), ${String(receipt.testCount)} test(s), ` +
        `${String(receipt.excludedFileCount)} exclusion(s), ` +
        `manifest ${receipt.manifestHash.slice(0, 12)}\n`,
    );
  } catch (error) {
    process.stderr.write(`shard merge refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
