#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const manifest = JSON.parse(await readFile(join(ROOT, 'artifacts', 'manifest.json'), 'utf8'));
const resultBytes = await readFile(join(ROOT, manifest.result.path));
assert(resultBytes.length === manifest.result.bytes, 'result byte count mismatch');
assert(sha256(resultBytes) === manifest.result.sha256, 'result SHA-256 mismatch');
const result = JSON.parse(resultBytes);

assert(result.format === 's4-harness-owned-storage-qualification-v1', 'format mismatch');
assert(result.summary.total === 126, 'case inventory mismatch');
assert(result.summary.passed === 126 && result.summary.failed === 0, 'qualification not green');
assert(result.priorBenchmark.timingSamples === 1800, 'prior timing inventory mismatch');
assert(result.priorBenchmark.killChecks === 80, 'prior kill inventory mismatch');
assert(result.environment.node === 'v24.18.0', 'Node identity mismatch');
assert(result.environment.nodeSqlite === '3.53.1', 'node:sqlite identity mismatch');
assert(result.environment.betterSqlite3 === '12.11.1', 'better-sqlite3 identity mismatch');
assert(result.environment.betterSqliteRuntime === '3.53.2', 'better SQLite identity mismatch');
assert(result.environment.nodeSqliteStability === '1.2 release candidate', 'stability label lost');
assert(result.environment.currentUpstreamSqlite === '3.53.3', 'upstream SQLite identity mismatch');
assert(result.environment.missingRequiredCapabilities.some((item) => item.includes('power-loss')),
  'power-loss blocker was not preserved');

const adapters = ['node:sqlite', 'better-sqlite3'];
const requiredScenarios = [
  'schema-bigint-prepared-begin-immediate',
  'append-only-chain-graph-constraints',
  'deterministic-versioned-migrations',
  'online-backup-restore',
  'projection-rebuild-attempt-memory-lineage',
  'timeline-taxonomy-ordered-headers-commit-links',
  'independent-oracle-false-green-controls',
  'defensive-authorizer-extension-controls',
  'busy-timeout-semantics',
  'four-process-single-writer-contention',
  'wal-reader-starvation-and-truncate-checkpoint',
  'integrity-foreign-keys-private-file-modes',
  'resource-and-latency-bounds',
  'sigkill-before-begin',
  'sigkill-after-begin',
  'sigkill-after-event-row',
  'sigkill-before-commit',
  'sigkill-after-commit',
  'durability-normal-commit-sigkill',
  'durability-full-commit-sigkill',
  'durability-extra-commit-sigkill',
];

for (const adapter of adapters) {
  const selected = result.cases.filter((entry) => entry.adapter === adapter);
  assert(selected.length === 63, `${adapter} case count mismatch`);
  assert(selected.every((entry) => entry.status === 'pass'), `${adapter} contains failure`);
  for (const scenario of requiredScenarios) {
    const repetitions = selected.filter((entry) => entry.scenario === scenario)
      .map((entry) => entry.repetition).sort();
    assert(JSON.stringify(repetitions) === '[0,1,2]', `${adapter}/${scenario} is not x3`);
  }
}

for (const entry of result.cases.filter((item) => item.scenario === 'independent-oracle-false-green-controls')) {
  assert(entry.details.baseline.ok === true, 'false-green baseline failed');
  assert(entry.details.mutant.ok === false, 'mutant falsely passed');
  assert(entry.details.mutant.failures.some((failure) => failure.startsWith('chain-link:')),
    'chain mutant control missing');
  assert(entry.details.mutant.failures.some((failure) => failure.startsWith('document-digest:')),
    'document mutant control missing');
}

for (const entry of result.cases.filter((item) => item.scenario === 'defensive-authorizer-extension-controls')) {
  if (entry.adapter === 'node:sqlite') {
    assert(entry.details.attach.rejected === true, 'node authorizer ATTACH control failed');
    assert(entry.details.securityState.authorizer === 'enforced', 'node authorizer state missing');
  } else {
    assert(entry.details.attach.rawDriverCanAttach === true,
      'better-sqlite3 raw ATTACH limitation was hidden');
    assert(entry.details.securityState.authorizer === 'not-exposed',
      'better-sqlite3 authorizer limitation was hidden');
  }
}

const sourceFiles = [];
for (const expected of manifest.source.files) {
  const bytes = await readFile(join(ROOT, expected.name));
  assert(bytes.length === expected.bytes, `source byte count mismatch: ${expected.name}`);
  const observed = sha256(bytes);
  assert(observed === expected.sha256, `source SHA-256 mismatch: ${expected.name}`);
  sourceFiles.push({ name: expected.name, sha256: observed });
}
const ordered = sourceFiles.map((file) => `${file.sha256}  ${file.name}\n`).join('');
assert(sha256(ordered) === manifest.source.orderedSha256, 'ordered source identity mismatch');

process.stdout.write(`${JSON.stringify({
  ok: true,
  resultSha256: manifest.result.sha256,
  sourceSha256: manifest.source.orderedSha256,
  cases: result.summary.total,
  repetitionsPerScenario: 3,
  priorTimingSamples: result.priorBenchmark.timingSamples,
  priorKillChecks: result.priorBenchmark.killChecks,
})}\n`);
