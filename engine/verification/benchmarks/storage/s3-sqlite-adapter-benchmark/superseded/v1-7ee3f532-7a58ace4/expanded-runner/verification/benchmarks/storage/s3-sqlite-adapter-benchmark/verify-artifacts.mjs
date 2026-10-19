#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const read = async (relative) => readFile(join(root, relative));
const installBytes = await read('artifacts/raw/install-reliability.json');
const install = JSON.parse(installBytes);
const review = JSON.parse(await read('artifacts/raw/sqlite-3.53.3-review.json'));

assert(install.installs.length === 3, 'install trial count mismatch');
assert(install.installs.every((entry) => entry.exitStatus === 0), 'install failed');
assert(install.tarballIdentity.sriMatches === true, 'tarball SRI mismatch');
const results = {};
for (const stem of ['benchmark-results', 'benchmark-results-project-fs']) {
  const rawBytes = await read(`artifacts/raw/${stem}.json`);
  const raw = JSON.parse(rawBytes);
  assert(raw.format === 's3-sqlite-adapter-qualification-v1', 'raw format mismatch');
  assert(raw.environment.nodeVersion === 'v24.18.0', 'Node identity mismatch');
  assert(raw.configuration.repetitionsPerTimingCell === 30, 'repetition count mismatch');
  for (const [name, groups, samples] of [
    ['append', 12, 360],
    ['search', 12, 360],
    ['backup', 2, 60],
    ['contention', 2, 60],
    ['restart', 2, 60],
  ]) {
    const section = raw.measurements[name];
    assert(section.summary.length === groups, `${stem} ${name} group count mismatch`);
    assert(section.samples.length === samples, `${stem} ${name} sample count mismatch`);
    assert(section.summary.every((entry) => entry.duration.n === 30), `${stem} ${name} n mismatch`);
  }
  for (const correctness of Object.values(raw.correctness)) {
    assert(correctness.duplicateRejected === true, 'duplicate was not rejected');
    assert(correctness.strictProbeRejected === true, 'STRICT probe was not rejected');
    assert(correctness.callerSqlExposed === false, 'caller SQL surface exposed');
    assert(correctness.extensionLoaderExposed === false, 'extension loader exposed');
    assert(Object.values(correctness.check.cross).every((value) => value === 0), 'cross invariant failed');
    assert(Object.values(correctness.restartInspection.cross).every((value) => value === 0), 'restart invariant failed');
  }
  const kill = raw.recovery.killBoundaries;
  assert(kill.repetitionsPerBoundary === 10 && kill.results.length === 40, 'kill coverage mismatch');
  assert(kill.results.every((entry) => entry.exitSignal === 'SIGKILL'), 'kill signal mismatch');
  assert(kill.results.every((entry) => entry.inspection.counts.ledger_count === entry.expectedAfter), 'kill recovery count mismatch');
  for (const adapter of ['node:sqlite', 'better-sqlite3']) {
    const contention = raw.measurements.contention.samples.filter((entry) => entry.adapter === adapter);
    assert(contention.reduce((sum, entry) => sum + entry.busyRetries, 0) === 0, 'busy retries observed');
    const backups = raw.measurements.backup.samples.filter((entry) => entry.adapter === adapter);
    assert(new Set(backups.map((entry) => entry.sha256)).size === 1, 'backup bytes were not stable');
  }
  assert(sha256(installBytes) === raw.installReliability.sha256, 'embedded install identity mismatch');
  assert(review.qualifiedRuntimes['node:sqlite'].sqliteSourceId === raw.runtimeIdentities['node:sqlite'].sqliteSourceId, 'Node review identity mismatch');
  assert(review.qualifiedRuntimes['better-sqlite3@12.11.1'].sqliteSourceId === raw.runtimeIdentities['better-sqlite3'].sqliteSourceId, 'better review identity mismatch');
  for (const file of raw.codeIdentities.files) {
    assert(sha256(await read(file.relative)) === file.sha256, `code identity mismatch: ${file.relative}`);
  }
  const sidecar = (await read(`artifacts/raw/${stem}.sha256`)).toString('utf8').trim();
  assert(sidecar === `${sha256(rawBytes)}  ${stem}.json`, `${stem} sidecar mismatch`);
  results[stem] = { sha256: sha256(rawBytes), filesystem: raw.environment.filesystem.reportedType };
}
assert(!existsSync(join(root, 'work')), 'work directory was not removed');
assert(!existsSync('/home/example/.cache/bridlewise-sqlite-benchmark'), 'ext4 scratch was not removed');

process.stdout.write(`${JSON.stringify({
  ok: true,
  results,
  installSha256: sha256(installBytes),
  timingSamples: 1800,
  killChecks: 80,
})}\n`);
