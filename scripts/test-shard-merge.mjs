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
 *   - the receipt records relative paths only, the shard count, the test count,
 *     and a hash of the manifest it judged.
 *
 * A shard report with zero files is valid only when the manifest is empty. A
 * missing report is not an empty shard. The caller must pass exactly the
 * expected number of reports or the merge fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PLAN_SCHEMA, SHARD_REPORT_SCHEMA, manifestHash as hashManifest } from "./test-shard-manifest.mjs";

export const RECEIPT_SCHEMA = "bridlewise-test-shard-receipt/v1";

function fail(message) {
  throw new Error(message);
}

function normalizeFile(root, file, subject) {
  if (typeof file !== "string" || file.length === 0) {
    fail(`${subject}: a test result has no file name`);
  }
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${subject}: test file escapes the repository root: ${file}`);
  }
  return rel.split(sep).join("/");
}

function readJson(path, subject) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${subject}: cannot read JSON at ${path}: ${error.message}`);
  }
}

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
  return plan;
}

function readShard(root, path, index, expected = undefined) {
  const envelope = readJson(path, `shard ${index}`);
  if (envelope === null || typeof envelope !== "object") {
    fail(`shard ${index}: report is not an object`);
  }
  const wrapped = envelope.schemaVersion === SHARD_REPORT_SCHEMA;
  if (expected !== undefined && !wrapped) {
    fail(`shard ${index}: report has no ${SHARD_REPORT_SCHEMA} provenance envelope`);
  }
  if (wrapped) {
    if (envelope.shard !== index || envelope.shardCount !== expected?.shardCount) {
      fail(`shard ${index}: shard identity or count does not match the plan`);
    }
    if (String(envelope.headSha).toLowerCase() !== expected?.headSha) {
      fail(`shard ${index}: head ${String(envelope.headSha)} is not ${String(expected?.headSha)}`);
    }
    if (envelope.manifestHash !== expected?.manifestHash) {
      fail(`shard ${index}: manifest hash does not match the plan`);
    }
    if (envelope.assignmentHash !== expected?.assignmentHash) {
      fail(`shard ${index}: assignment hash does not match the plan`);
    }
  }
  const report = wrapped ? envelope.vitest : envelope;
  if (report === null || typeof report !== "object") {
    fail(`shard ${index}: report is not an object`);
  }
  if (report.success !== true) {
    fail(`shard ${index}: vitest reported success=false`);
  }
  if (report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) {
    fail(
      `shard ${index}: ${String(report.numFailedTests)} failed test(s) and ` +
        `${String(report.numFailedTestSuites)} failed suite(s)`,
    );
  }
  const pending = Number(report.numPendingTests ?? 0);
  const todo = Number(report.numTodoTests ?? 0);
  if (pending !== 0 || todo !== 0) {
    fail(`shard ${index}: ${String(pending)} skipped and ${String(todo)} todo test(s); a shard must run every selected test`);
  }
  const results = report.testResults;
  if (!Array.isArray(results)) {
    fail(`shard ${index}: report has no testResults array`);
  }
  const files = results.map((result, resultIndex) => {
    if (result === null || typeof result !== "object") {
      fail(`shard ${index}: testResults[${resultIndex}] is not an object`);
    }
    return normalizeFile(root, result.name, `shard ${index} result ${resultIndex}`);
  });
  const duplicates = files.filter((file, fileIndex) => files.indexOf(file) !== fileIndex);
  if (duplicates.length > 0) {
    fail(`shard ${index}: duplicate test file(s): ${[...new Set(duplicates)].join(", ")}`);
  }
  const totalTests = Number.isFinite(report.numTotalTests) ? report.numTotalTests : 0;
  return { index, files: files.sort(), totalTests };
}

export function mergeShardReports({
  root = process.cwd(),
  manifestPath,
  shardPaths,
  expectedShards,
  headSha,
  planPath = undefined,
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

  const manifest = readManifest(repositoryRoot, manifestPath);
  const plan = planPath === undefined ? undefined : readPlan(planPath);
  if (plan !== undefined) {
    if (plan.headSha.toLowerCase() !== headSha.toLowerCase()) {
      fail(`plan: head ${plan.headSha} is not ${headSha}`);
    }
    if (plan.shardCount !== expectedShards) fail("plan: shard count does not match expectedShards");
  }
  const computedManifestHash = hashManifest(manifest);
  if (plan !== undefined && plan.manifestHash !== computedManifestHash) {
    fail("plan: manifest hash does not match the supplied manifest");
  }
  const shards = shardPaths.map((path, index) => readShard(repositoryRoot, path, index + 1,
    plan === undefined ? undefined : {
      headSha: plan.headSha.toLowerCase(),
      manifestHash: plan.manifestHash,
      assignmentHash: plan.assignmentHash,
      shardCount: plan.shardCount,
    }));
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

  if (plan !== undefined) {
    for (const [index, planned] of plan.shards.entries()) {
      const actual = shards[index].files;
      const expectedFiles = [...planned.files].sort();
      if (actual.join("\n") !== expectedFiles.join("\n")) {
        fail(`shard ${index + 1}: files do not match the plan's exact assignment`);
      }
    }
  }

  const manifestHash = hashManifest(manifest);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    generatedAt: now.toISOString(),
    headSha: headSha.toLowerCase(),
    shardCount: expectedShards,
    manifestHash,
    ...(plan === undefined ? {} : { assignmentHash: plan.assignmentHash }),
    fileCount: manifest.length,
    testCount: shards.reduce((sum, shard) => sum + shard.totalTests, 0),
    shards: shards.map((shard) => ({
      index: shard.index,
      fileCount: shard.files.length,
      testCount: shard.totalTests,
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
    shardPaths: [],
    expectedShards: null,
    headSha: process.env.GITHUB_SHA ?? null,
    outPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--plan") options.planPath = argv[++index];
    else if (arg === "--shard") options.shardPaths.push(argv[++index]);
    else if (arg === "--expected-shards") options.expectedShards = Number(argv[++index]);
    else if (arg === "--head") options.headSha = argv[++index];
    else if (arg === "--out") options.outPath = argv[++index];
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.manifestPath) fail("--manifest is required");
  if (!options.outPath) fail("--out is required");
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const receipt = mergeShardReports(options);
    process.stdout.write(
      `shard merge: ${String(receipt.shardCount)} shard(s), ` +
        `${String(receipt.fileCount)} file(s), ${String(receipt.testCount)} test(s), ` +
        `manifest ${receipt.manifestHash.slice(0, 12)}\n`,
    );
  } catch (error) {
    process.stderr.write(`shard merge refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
