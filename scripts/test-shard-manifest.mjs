/**
 * THE SHARD MANIFEST AND PLAN OWNER.
 *
 * `vitest list --filesOnly --json` is the only population: the runner's own
 * selection, not a second glob. This module accounts for every live file as
 * either a supported file or an explicitly excluded file with a reason, then
 * turns the measured weights into deterministic disjoint shards.
 *
 * The checked-in manifest is a measurement, not a run. A checked-in file
 * cannot carry the SHA of the commit that contains it, so it records the
 * commit whose weights were measured. The plan records the head SHA of the
 * run that will use it, and every shard report is wrapped with that same
 * provenance before the merge will consider it.
 *
 * `measure` is the one weight producer. It reads the wrapped shard reports
 * from a green run (the JSON reporter's per-file `endTime - startTime`), and
 * rewrites the supported files' weights plus `measuredHeadSha`, `measuredAt`
 * and `weightSource`. It refuses a partial, duplicated, non-green or
 * different-manifest population, so a measurement cannot describe a set the
 * manifest does not carry.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = "bridlewise-test-shard-manifest/v1";
export const PLAN_SCHEMA = "bridlewise-test-shard-plan/v1";
export const SHARD_REPORT_SCHEMA = "bridlewise-test-shard-report/v1";
/** The one per-file duration definition the weights are measured with. */
const WEIGHT_SOURCE = "vitest-json:endTime-startTime";

export function fail(message) {
  throw new Error(message);
}

export function readJson(path, subject) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${subject}: cannot read JSON at ${path}: ${error.message}`);
  }
}

export function normalizeFile(root, file, subject) {
  if (typeof file !== "string" || file.length === 0) fail(`${subject}: empty path`);
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${subject}: path escapes the repository root: ${file}`);
  }
  return rel.split(sep).join("/");
}

/**
 * The ONE green-report rule: a shard counts as evidence only when vitest says
 * it succeeded and no test failed, was skipped, or was parked. The merge and
 * the weight measurement both read a report's counts, so the rule lives here
 * rather than being respelled at each reader.
 */
export function requireGreenReport(report, subject) {
  if (report === null || typeof report !== "object") fail(`${subject}: report is not an object`);
  if (report.success !== true) fail(`${subject}: vitest reported success=false`);
  // ABSENT IS NOT ZERO. Every count this rule judges must be DECLARED by the
  // report, as a NUMBER: a numeric string is a shape the report never emits
  // and was accepted through `Number(value)`. Defaulting a missing
  // `numFailedTestSuites` to 0 is how a report that never said it had no
  // failing suite merged as green; the same substitution could hide a missing
  // failed-test, skipped or todo count. `numTotalTests` and `numPassedTests`
  // were the last two read outside this rule — a missing total became 0 and a
  // fractional one merged as a fractional test count (3.7 is not a test).
  const declared = (field) => {
    const value = report[field];
    if (value === undefined || value === null) {
      fail(`${subject}: report does not declare ${field}; absent is not zero`);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      fail(`${subject}: ${field} is not a declared non-negative integer (${String(value)})`);
    }
    return value;
  };
  const failedTests = declared("numFailedTests");
  const failedSuites = declared("numFailedTestSuites");
  const pendingTests = declared("numPendingTests");
  const todoTests = declared("numTodoTests");
  const totalTests = declared("numTotalTests");
  const passedTests = declared("numPassedTests");
  if (failedTests !== 0 || failedSuites !== 0) {
    fail(`${subject}: ${String(failedTests)} failed test(s) and ${String(failedSuites)} failed suite(s)`);
  }
  if (pendingTests !== 0 || todoTests !== 0) {
    fail(
      `${subject}: ${String(pendingTests)} skipped and ` +
        `${String(todoTests)} todo test(s); a shard must run every selected test`,
    );
  }
  return { failedTests, pendingTests, todoTests, totalTests, passedTests };
}

/**
 * A shard report produced in CI names the checkout under the runner's own
 * root, so a downloaded report cannot be resolved against this checkout.
 * The manifest is the canonical population: accept an outside path only when
 * its suffix names exactly one supported file, and never guess between two.
 */
function normalizeReportFile(root, file, subject, supported) {
  if (typeof file !== "string" || file.length === 0) fail(`${subject}: empty path`);
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  const candidates = supported.filter((path) => file === path || file.endsWith(`/${path}`));
  if (candidates.length === 1) return candidates[0];
  fail(
    `${subject}: path is outside the repository root and ` +
      `${candidates.length === 0 ? "matches no" : "matches more than one"} supported file: ${file}`,
  );
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The one hash definition shared by the manifest, the plan, and the merge. */
export function manifestHash(files) {
  return sha256(files.map((file) => typeof file === "string" ? file : file.path).sort().join("\n"));
}

function readEntries(manifest, root) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest: expected an object");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    fail(`manifest: expected schema ${MANIFEST_SCHEMA}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("manifest: files must be a non-empty array");
  }
  if (!Array.isArray(manifest.excluded)) fail("manifest: excluded must be an array");
  const files = manifest.files.map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`manifest: file ${index} is not an object`);
    const path = normalizeFile(root, entry.path, `manifest file ${index}`);
    if (!Number.isSafeInteger(entry.weightMs) || entry.weightMs <= 0) {
      fail(`manifest: ${path} must carry a positive integer weightMs`);
    }
    return { path, weightMs: entry.weightMs };
  });
  const excluded = manifest.excluded.map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`manifest: exclusion ${index} is not an object`);
    const path = normalizeFile(root, entry.path, `manifest exclusion ${index}`);
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      fail(`manifest: exclusion ${path} has no reason`);
    }
    if (typeof entry.evidence !== "string" || entry.evidence.trim().length === 0) {
      fail(`manifest: exclusion ${path} has no evidence`);
    }
    return { path, reason: entry.reason, evidence: entry.evidence };
  });
  const filePaths = files.map((entry) => entry.path);
  if (new Set(filePaths).size !== filePaths.length) fail("manifest: duplicate supported file");
  const excludedPaths = excluded.map((entry) => entry.path);
  if (new Set(excludedPaths).size !== excludedPaths.length) fail("manifest: duplicate exclusion");
  for (const path of filePaths) {
    if (excludedPaths.includes(path)) fail(`manifest: ${path} is both supported and excluded`);
  }
  return { files, excluded };
}

export function readManifest(root, manifestPath) {
  const manifest = readJson(manifestPath, "manifest");
  const { files, excluded } = readEntries(manifest, resolve(root));
  return {
    schemaVersion: MANIFEST_SCHEMA,
    measuredHeadSha: manifest.measuredHeadSha,
    measuredAt: manifest.measuredAt,
    files,
    excluded,
    hash: manifestHash(files),
  };
}

/**
 * The content identity of the working tree at `root`: every tracked and
 * untracked-not-ignored file, hashed with its repository-relative path.
 *
 * `vitest list` never runs the global setup, so the listing process takes no
 * source fingerprint (and no instrument lock — that gap is stated in
 * `docs/testing.md`). The listing command below supplies the missing
 * fingerprint: it reads this identity before and after the listing and
 * refuses a tree that moved. Verification recomputes it and refuses a listing
 * recorded against another tree or another checkout.
 */
export function treeFingerprint(root = process.cwd()) {
  const repositoryRoot = resolve(root);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repositoryRoot, encoding: "utf8" });
  if (top.status !== 0) fail(`tree identity: ${repositoryRoot} is not inside a git repository`);
  if (resolve(top.stdout.trim()) !== repositoryRoot) {
    fail(`tree identity: ${repositoryRoot} is not the repository root (${top.stdout.trim()})`);
  }
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) fail(`tree identity: git could not list ${repositoryRoot}: ${listed.stderr ?? ""}`);
  const paths = [...new Set(listed.stdout.split("\0").filter((path) => path.length > 0))].sort();
  if (paths.length === 0) fail(`tree identity: ${repositoryRoot} has no tracked or untracked file — an empty tree has no state`);
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(repositoryRoot, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * `vitest list --filesOnly --json`, wrapped with the tree identity it selected
 * from. `run` is injectable so a test can drive a tree that moves mid-listing.
 */
export function listTestFiles({ root = process.cwd(), run = spawnSync } = {}) {
  const repositoryRoot = resolve(root);
  const tree = treeFingerprint(repositoryRoot);
  const listing = run("npx", ["vitest", "list", "--filesOnly", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listing.error !== undefined) fail(`test listing: could not start vitest: ${listing.error.message}`);
  if (listing.status !== 0) fail(`test listing: vitest list exited ${String(listing.status)}\n${listing.stderr ?? ""}`);
  let files;
  try {
    files = JSON.parse(listing.stdout);
  } catch (error) {
    fail(`test listing: vitest did not print JSON: ${error.message}`);
  }
  if (!Array.isArray(files) || files.length === 0) fail("test listing: vitest selected no files");
  const after = treeFingerprint(repositoryRoot);
  if (after !== tree) {
    fail(
      `test listing: the working tree changed while the listing ran (before ${tree}, after ${after}). ` +
        "A listing from two trees is not a state any manifest can be verified against.",
    );
  }
  return { schemaVersion: "bridlewise-test-listing/v1", tree, files };
}

/**
 * Verify the checked-in manifest against a TREE-BOUND `vitest list` output.
 *
 * THE TREE IS RECOMPUTED HERE, NOT TAKEN FROM THE CALLER. The listing's
 * `tree` used to be compared with a caller-supplied `--tree`, so anyone could
 * pass the STALE fingerprint a listing was written under and the listing
 * verified even after the working tree had moved. The document's tree is
 * compared with a fresh `treeFingerprint(root)`; an explicit `tree` is only a
 * cross-check that must equal that same computed value. `fingerprint` is
 * injectable so a fixture can drive a tree without a real git checkout.
 *
 * THE POPULATION IS RE-DERIVED HERE TOO, NOT TAKEN FROM THE SUBJECT. The
 * fingerprint binds the listing to a tree, but the listing's own `files`
 * array was still the only evidence about what that tree SELECTS: a document
 * written from a stale selection (or edited to omit a file) verified as long
 * as its fingerprint was current and every file it did name was classified.
 * A test file the manifest does not know is then invisible to every check.
 * So verification re-runs `listTestFiles` — the same enumeration the listing
 * command runs — and compares the two file SETS: the subject may not omit a
 * file the fresh enumeration selected, nor name one it did not. The fresh
 * enumeration is the evidence; the subject is the thing judged. `list` is
 * injectable for fixtures that are not a real checkout.
 */
export function verifyManifest({
  root = process.cwd(),
  manifestPath,
  livePath,
  tree = undefined,
  fingerprint = treeFingerprint,
  list = listTestFiles,
}) {
  if (tree !== undefined && (typeof tree !== "string" || tree.length === 0)) {
    fail("live manifest: --tree must be a non-empty working-tree identity when supplied");
  }
  const repositoryRoot = resolve(root);
  const manifest = readManifest(repositoryRoot, manifestPath);
  const liveDocument = readJson(livePath, "live manifest");
  if (Array.isArray(liveDocument)) {
    fail(
      "live manifest: a plain array from `vitest list` is not accepted — it is bound to no tree " +
        "state, so it could have been selected from another checkout or while the tree was moving. " +
        "Use `npm run test:list`.",
    );
  }
  if (liveDocument === null || typeof liveDocument !== "object" || liveDocument.schemaVersion !== "bridlewise-test-listing/v1") {
    fail("live manifest: expected a `bridlewise-test-listing/v1` document from `npm run test:list`");
  }
  const currentTree = fingerprint(repositoryRoot);
  if (liveDocument.tree !== currentTree) {
    fail(
      `live manifest: the listing is bound to tree ${String(liveDocument.tree)}, not the working ` +
        `tree being verified (${currentTree}). A listing taken before the tree moved cannot certify it.`,
    );
  }
  if (tree !== undefined && tree !== currentTree) {
    fail(
      `live manifest: --tree ${tree} is not the working tree being verified (${currentTree}); ` +
        `the caller's identity is a cross-check, not an override.`,
    );
  }
  const live = liveDocument.files;
  if (!Array.isArray(live) || live.length === 0) fail("live manifest: expected a non-empty `files` array");
  const declaredFiles = live.map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`live manifest: entry ${index} is not an object`);
    return normalizeFile(repositoryRoot, entry.file, `live manifest entry ${index}`);
  });
  const declaredSet = new Set(declaredFiles);
  if (declaredSet.size !== declaredFiles.length) fail("live manifest: duplicate file");
  // THE FRESH ENUMERATION. This is the evidence about the population; the
  // document above is only the claim. `listTestFiles` binds its own result to
  // the same tree before and after the run, and its tree is checked against
  // the tree this verification computed, so the two reads describe one state.
  const fresh = list({ root: repositoryRoot });
  if (fresh === null || typeof fresh !== "object" || fresh.schemaVersion !== "bridlewise-test-listing/v1") {
    fail("fresh enumeration: expected a `bridlewise-test-listing/v1` document from listTestFiles");
  }
  if (typeof fresh.tree !== "string" || fresh.tree.length === 0) {
    fail("fresh enumeration: the enumeration carries no working-tree identity");
  }
  if (fresh.tree !== currentTree) {
    fail(
      `fresh enumeration: the enumeration is bound to tree ${fresh.tree}, not the working tree being ` +
        `verified (${currentTree}); the population was selected from a tree that moved.`,
    );
  }
  if (!Array.isArray(fresh.files) || fresh.files.length === 0) {
    fail("fresh enumeration: expected a non-empty `files` array");
  }
  const liveFiles = fresh.files.map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`fresh enumeration: entry ${index} is not an object`);
    return normalizeFile(repositoryRoot, entry.file, `fresh enumeration entry ${index}`);
  });
  const liveSet = new Set(liveFiles);
  if (liveSet.size !== liveFiles.length) fail("fresh enumeration: duplicate file");
  const omitted = liveFiles.filter((file) => !declaredSet.has(file));
  if (omitted.length > 0) {
    fail(
      `live manifest: the listing OMITS ${omitted.length} file(s) the fresh enumeration selected: ` +
        `${omitted.slice(0, 8).join(", ")}. A listing is not evidence about a population it did not select.`,
    );
  }
  const invented = [...declaredSet].filter((file) => !liveSet.has(file));
  if (invented.length > 0) {
    fail(
      `live manifest: the listing names ${invented.length} file(s) the fresh enumeration did not select: ` +
        `${invented.slice(0, 8).join(", ")}.`,
    );
  }
  const known = new Set([...manifest.files.map((file) => file.path), ...manifest.excluded.map((file) => file.path)]);
  const missing = [...liveSet].filter((file) => !known.has(file));
  if (missing.length > 0) fail(`live manifest: unclassified file(s): ${missing.slice(0, 8).join(", ")}`);
  const stale = [...known].filter((file) => !liveSet.has(file));
  if (stale.length > 0) fail(`manifest: file(s) no longer selected: ${stale.slice(0, 8).join(", ")}`);
  for (const file of manifest.files) {
    if (!existsSync(resolve(repositoryRoot, file.path))) fail(`manifest: supported file is missing on disk: ${file.path}`);
  }
  return {
    manifestHash: manifest.hash,
    fileCount: manifest.files.length,
    excludedCount: manifest.excluded.length,
    liveCount: liveFiles.length,
    tree: currentTree,
  };
}

/** Deterministic longest-processing-time assignment by measured weights. */
export function assignShards(files, shardCount) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > files.length) {
    fail("shardCount must be between 1 and the supported file count");
  }
  const bins = Array.from({ length: shardCount }, (_, index) => ({ index: index + 1, weightMs: 0, files: [] }));
  const ordered = [...files].sort((a, b) =>
    b.weightMs - a.weightMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    let target = bins[0];
    for (const bin of bins) if (bin.weightMs < target.weightMs) target = bin;
    target.files.push(file.path);
    target.weightMs += file.weightMs;
  }
  for (const bin of bins) bin.files.sort();
  return bins;
}

export function assignmentHash(shards) {
  return sha256(shards.map((shard) => shard.files.map((file) => `${shard.index}:${file}`).join("\n")).join("\n"));
}

export function planShards({ root = process.cwd(), manifestPath, shardCount, headSha, outDir, now = new Date() }) {
  const repositoryRoot = resolve(root);
  if (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha)) fail("headSha must be a commit SHA");
  const manifest = readManifest(repositoryRoot, manifestPath);
  const shards = assignShards(manifest.files, shardCount);
  const plan = {
    schemaVersion: PLAN_SCHEMA,
    generatedAt: now.toISOString(),
    headSha: headSha.toLowerCase(),
    manifestHash: manifest.hash,
    assignmentHash: assignmentHash(shards),
    shardCount,
    shards,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest.files.map((file) => ({ file: file.path })), null, 2)}\n`);
  writeFileSync(resolve(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function timestamp(value, subject) {
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === "number" || /^\d+$/.test(String(value));
  const ms = numeric ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < 0) fail(`${subject} must be an epoch millisecond value or an ISO timestamp`);
  return ms;
}

/**
 * The ONE per-file shard weight definition: the JSON reporter's
 * `endTime - startTime`, validated there and nowhere else. A second module
 * subtracting those two fields is the duplicate derivation the measurement
 * contract refuses (the registry names this function as the producer).
 *
 * Missing, non-numeric or inverted timestamps REFUSE the measurement; they
 * never become a zero weight. A measured duration of 0 is honest (the file
 * rounded to no elapsed milliseconds), and the declared floor of 1 is applied
 * HERE rather than in the caller: the registry names this function as the one
 * producer, and the body that derives the number is the body that owns its
 * floor. A floor in `measureManifest` made the forbidden-quantity clause
 * vacuous for the registry's promise (it inspected a function that computed
 * nothing) and left two bodies sharing one definition.
 */
export function measuredFileDurationMs(result, subject) {
  if (result === null || typeof result !== "object") fail(`${subject}: not an object`);
  if (!Number.isFinite(result.startTime) || !Number.isFinite(result.endTime)) {
    fail(`${subject}: no numeric startTime and endTime`);
  }
  if (result.endTime < result.startTime) fail(`${subject}: endTime is before startTime`);
  return Math.max(1, Math.round(result.endTime - result.startTime));
}

function readMeasurementReport(repositoryRoot, reportPath, index, manifest) {
  const envelope = readJson(reportPath, `shard report ${index}`);
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail(`shard report ${index}: expected an object`);
  }
  if (envelope.schemaVersion !== SHARD_REPORT_SCHEMA) {
    fail(`shard report ${index}: expected schema ${SHARD_REPORT_SCHEMA}`);
  }
  if (!Number.isSafeInteger(envelope.shard) || envelope.shard < 1) {
    fail(`shard report ${index}: shard index is missing`);
  }
  if (!Number.isSafeInteger(envelope.shardCount) || envelope.shardCount < 1) {
    fail(`shard report ${index}: shard count is missing`);
  }
  if (typeof envelope.headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(envelope.headSha)) {
    fail(`shard report ${index}: headSha is missing`);
  }
  if (envelope.manifestHash !== manifest.hash) {
    fail(`shard report ${index}: manifest hash does not match the checked-in manifest`);
  }
  const report = envelope.vitest;
  if (report === null || typeof report !== "object") fail(`shard report ${index}: vitest report is missing`);
  requireGreenReport(report, `shard report ${index}`);
  if (!Array.isArray(report.testResults)) fail(`shard report ${index}: report has no testResults array`);
  if (envelope.timing === undefined) {
    // measuredAt is the moment the RUN finished, so a report without a window
    // cannot contribute one. The old fallback wrote the invocation clock into
    // `measuredAt`, which made a measurement with no measured time look like
    // evidence.
    fail(`shard report ${index}: no timing window; a measurement needs the runner's startedAt and finishedAt`);
  }
  timestamp(envelope.timing.startedAt, `shard report ${index} timing.startedAt`);
  const finishedMs = timestamp(envelope.timing.finishedAt, `shard report ${index} timing.finishedAt`);
  const supported = manifest.files.map((file) => file.path);
  const entries = report.testResults.map((result, resultIndex) => {
    const subject = `shard report ${index} testResults[${resultIndex}]`;
    const durationMs = measuredFileDurationMs(result, subject);
    const file = normalizeReportFile(repositoryRoot, result.name, subject, supported);
    return { file, durationMs };
  });
  return {
    shard: envelope.shard,
    shardCount: envelope.shardCount,
    headSha: envelope.headSha.toLowerCase(),
    finishedMs,
    entries,
  };
}

/**
 * Derive the per-file weights from a complete green run's wrapped shard
 * reports and write the manifest through the owner. Without `outPath` the
 * measurement is computed and returned without touching the manifest.
 */
export function measureManifest({
  root = process.cwd(),
  manifestPath,
  reportPaths,
  headSha = undefined,
  runner = undefined,
  outPath = undefined,
}) {
  const repositoryRoot = resolve(root);
  const manifest = readManifest(repositoryRoot, manifestPath);
  if (!Array.isArray(reportPaths) || reportPaths.length === 0) {
    fail("measure: at least one shard report is required");
  }
  if (headSha !== undefined && (typeof headSha !== "string" || !/^[0-9a-f]{7,64}$/i.test(headSha))) {
    fail("measure: headSha must be a commit SHA");
  }
  const reports = reportPaths.map((path, index) => readMeasurementReport(repositoryRoot, path, index + 1, manifest));
  const shardCount = reports[0].shardCount;
  if (reports.length !== shardCount) {
    fail(`measure: expected ${String(shardCount)} shard report(s), received ${String(reports.length)}`);
  }
  const indexes = new Set();
  for (const report of reports) {
    if (report.shardCount !== shardCount) fail("measure: shard reports disagree on shardCount");
    if (indexes.has(report.shard)) fail(`measure: shard ${String(report.shard)} was measured twice`);
    indexes.add(report.shard);
  }
  for (let index = 1; index <= shardCount; index += 1) {
    if (!indexes.has(index)) fail(`measure: shard ${String(index)} is missing`);
  }
  const heads = new Set(reports.map((report) => report.headSha));
  if (heads.size !== 1) fail("measure: shard reports name more than one head commit");
  const measuredHeadSha = [...heads][0];
  if (headSha !== undefined && measuredHeadSha !== headSha.toLowerCase()) {
    fail(`measure: shard reports name head ${measuredHeadSha}, not ${headSha.toLowerCase()}`);
  }
  const supported = new Set(manifest.files.map((file) => file.path));
  const weights = new Map();
  for (const report of reports) {
    for (const entry of report.entries) {
      if (!supported.has(entry.file)) fail(`measure: ${entry.file} is not a supported manifest file`);
      if (weights.has(entry.file)) fail(`measure: ${entry.file} was measured more than once`);
      weights.set(entry.file, entry.durationMs);
    }
  }
  const missing = manifest.files.filter((file) => !weights.has(file.path)).map((file) => file.path);
  if (missing.length > 0) {
    fail(
      `measure: ${String(missing.length)} supported file(s) were not measured: ` +
        `${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
    );
  }
  const measuredAt = new Date(Math.max(...reports.map((report) => report.finishedMs)));
  const weightSource = `${WEIGHT_SOURCE}; ${String(manifest.files.length)} supported files from ` +
    `${String(reports.length)} green shard report(s) at ${measuredHeadSha}` +
    `${runner === undefined ? "" : ` (${runner})`}`;
  const raw = readJson(manifestPath, "manifest");
  const measured = {
    ...raw,
    measuredHeadSha,
    measuredAt: measuredAt.toISOString(),
    weightSource,
    files: raw.files.map((entry) => {
      const path = normalizeFile(repositoryRoot, entry.path, "manifest file");
      // Already rounded and floored by the producer; a second floor here
      // would be a second definition of the same weight.
      return { ...entry, weightMs: weights.get(path) };
    }),
  };
  if (outPath !== undefined) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), `${JSON.stringify(measured, null, 2)}\n`);
  }
  return {
    measuredHeadSha,
    measuredAt: measured.measuredAt,
    weightSource,
    fileCount: manifest.files.length,
    totalWeightMs: measured.files.reduce((sum, file) => sum + file.weightMs, 0),
    manifest: measured,
  };
}

export function wrapShardReport({ root = process.cwd(), planPath, shard, vitestPath, outPath, startedAt, finishedAt }) {
  const repositoryRoot = resolve(root);
  const plan = readJson(planPath, "plan");
  if (plan.schemaVersion !== PLAN_SCHEMA) fail(`plan: expected schema ${PLAN_SCHEMA}`);
  if (!Number.isSafeInteger(shard) || shard < 1 || shard > plan.shardCount) fail("shard is outside the plan");
  const report = readJson(vitestPath, `vitest report for shard ${shard}`);
  const startMs = timestamp(startedAt, "startedAt");
  const finishMs = timestamp(finishedAt, "finishedAt");
  if ((startMs === undefined) !== (finishMs === undefined)) fail("startedAt and finishedAt must be supplied together");
  if (startMs !== undefined && finishMs !== undefined && finishMs < startMs) fail("finishedAt is before startedAt");
  const envelope = {
    schemaVersion: SHARD_REPORT_SCHEMA,
    headSha: plan.headSha,
    manifestHash: plan.manifestHash,
    assignmentHash: plan.assignmentHash,
    shard,
    shardCount: plan.shardCount,
    ...(startMs === undefined ? {} : { timing: { startedAt: new Date(startMs).toISOString(), finishedAt: new Date(finishMs).toISOString(), durationMs: finishMs - startMs } }),
    vitest: report,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

function parseArgs(argv) {
  const options = { root: process.cwd(), command: argv[0] ?? null, reportPaths: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--live") options.livePath = argv[++index];
    else if (arg === "--tree") options.tree = argv[++index];
    else if (arg === "--shards") options.shardCount = Number(argv[++index]);
    else if (arg === "--head") options.headSha = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--github-output") options.githubOutput = argv[++index];
    else if (arg === "--plan") options.planPath = argv[++index];
    else if (arg === "--shard") options.shard = Number(argv[++index]);
    else if (arg === "--report") options.reportPaths.push(argv[++index]);
    else if (arg === "--runner") options.runner = argv[++index];
    else if (arg === "--started-at") options.startedAt = argv[++index];
    else if (arg === "--finished-at") options.finishedAt = argv[++index];
    else if (arg === "--vitest") options.vitestPath = argv[++index];
    else if (arg === "--out") options.outPath = argv[++index];
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "list") {
      const listing = listTestFiles({ root: options.root });
      const text = `${JSON.stringify(listing, null, 2)}\n`;
      if (options.outPath) {
        const outPath = resolve(options.outPath);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, text);
      } else process.stdout.write(text);
    } else if (options.command === "supported") {
      // The SUPPORTED file set, one path per line: the population a full run
      // judges. The four excluded files have declared reasons and are not a
      // clean run's business (a runner that includes them cannot go green in
      // the public snapshot).
      const manifest = readJson(options.manifestPath ?? resolve(process.cwd(), "tests/test-shards.json"), "manifest");
      for (const file of manifest.files) process.stdout.write(`${file.path}\n`);
    } else if (options.command === "verify") {
      if (!options.manifestPath || !options.livePath) fail("verify requires --manifest and --live");
      // `--tree` is a cross-check, never an override: `verifyManifest`
      // recomputes the working tree itself, so a stale fingerprint the caller
      // supplies cannot make an old listing verify.
      const verdict = verifyManifest(options);
      process.stdout.write(`shard manifest: ${verdict.fileCount} supported, ${verdict.excludedCount} excluded, ${verdict.liveCount} live, ${verdict.manifestHash.slice(0, 12)} at tree ${verdict.tree.slice(0, 12)}\n`);
    } else if (options.command === "plan") {
      if (!options.manifestPath || !options.outDir || !options.headSha || !options.shardCount) {
        fail("plan requires --manifest, --shards, --head, and --out-dir");
      }
      const plan = planShards(options);
      if (options.githubOutput) {
        writeFileSync(options.githubOutput, `shards=${JSON.stringify(plan.shards.map((shard) => shard.index))}\n`, { flag: "a" });
      }
      process.stdout.write(`shard plan: ${plan.shardCount} shard(s), ${plan.manifestHash.slice(0, 12)}\n`);
    } else if (options.command === "measure") {
      if (!options.manifestPath || options.reportPaths.length === 0) {
        fail("measure requires --manifest and at least one --report");
      }
      const measured = measureManifest(options);
      process.stdout.write(
        `shard manifest measured: ${measured.fileCount} file(s), ` +
          `${measured.totalWeightMs}ms total, head ${measured.measuredHeadSha.slice(0, 12)}` +
          `${options.outPath ? ` -> ${options.outPath}` : " (dry run; pass --out to write)"}\n`,
      );
    } else if (options.command === "wrap") {
      if (!options.planPath || !options.vitestPath || !options.outPath || !options.shard) {
        fail("wrap requires --plan, --vitest, --shard, and --out");
      }
      wrapShardReport(options);
      process.stdout.write(`shard report: shard ${options.shard} wrapped\n`);
    } else {
      fail("command must be list, supported, verify, plan, measure, or wrap");
    }
  } catch (error) {
    process.stderr.write(`shard manifest refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
