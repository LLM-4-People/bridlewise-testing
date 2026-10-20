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
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_SCHEMA = "bridlewise-test-shard-manifest/v1";
export const PLAN_SCHEMA = "bridlewise-test-shard-plan/v1";
export const SHARD_REPORT_SCHEMA = "bridlewise-test-shard-report/v1";

function fail(message) {
  throw new Error(message);
}

function readJson(path, subject) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${subject}: cannot read JSON at ${path}: ${error.message}`);
  }
}

function normalizeFile(root, file, subject) {
  if (typeof file !== "string" || file.length === 0) fail(`${subject}: empty path`);
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${subject}: path escapes the repository root: ${file}`);
  }
  return rel.split(sep).join("/");
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

/** Verify the checked-in manifest against a live `vitest list` output. */
export function verifyManifest({ root = process.cwd(), manifestPath, livePath }) {
  const repositoryRoot = resolve(root);
  const manifest = readManifest(repositoryRoot, manifestPath);
  const live = readJson(livePath, "live manifest");
  if (!Array.isArray(live) || live.length === 0) fail("live manifest: expected a non-empty array");
  const liveFiles = live.map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`live manifest: entry ${index} is not an object`);
    return normalizeFile(repositoryRoot, entry.file, `live manifest entry ${index}`);
  });
  const liveSet = new Set(liveFiles);
  if (liveSet.size !== liveFiles.length) fail("live manifest: duplicate file");
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

function assignmentHash(shards) {
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
  const options = { root: process.cwd(), command: argv[0] ?? null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--live") options.livePath = argv[++index];
    else if (arg === "--shards") options.shardCount = Number(argv[++index]);
    else if (arg === "--head") options.headSha = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--github-output") options.githubOutput = argv[++index];
    else if (arg === "--plan") options.planPath = argv[++index];
    else if (arg === "--shard") options.shard = Number(argv[++index]);
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
    if (options.command === "verify") {
      if (!options.manifestPath || !options.livePath) fail("verify requires --manifest and --live");
      const verdict = verifyManifest(options);
      process.stdout.write(`shard manifest: ${verdict.fileCount} supported, ${verdict.excludedCount} excluded, ${verdict.liveCount} live, ${verdict.manifestHash.slice(0, 12)}\n`);
    } else if (options.command === "plan") {
      if (!options.manifestPath || !options.outDir || !options.headSha || !options.shardCount) {
        fail("plan requires --manifest, --shards, --head, and --out-dir");
      }
      const plan = planShards(options);
      if (options.githubOutput) {
        writeFileSync(options.githubOutput, `shards=${JSON.stringify(plan.shards.map((shard) => shard.index))}\n`, { flag: "a" });
      }
      process.stdout.write(`shard plan: ${plan.shardCount} shard(s), ${plan.manifestHash.slice(0, 12)}\n`);
    } else if (options.command === "wrap") {
      if (!options.planPath || !options.vitestPath || !options.outPath || !options.shard) {
        fail("wrap requires --plan, --vitest, --shard, and --out");
      }
      wrapShardReport(options);
      process.stdout.write(`shard report: shard ${options.shard} wrapped\n`);
    } else {
      fail("command must be verify, plan, or wrap");
    }
  } catch (error) {
    process.stderr.write(`shard manifest refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
