#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const rawDirectory = join(root, 'artifacts', 'raw');
mkdirSync(rawDirectory, { recursive: true });
const expectedVersion = '12.11.1';
const expectedIntegrity = 'sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

const registry = JSON.parse(run('npm', [
  'view',
  `better-sqlite3@${expectedVersion}`,
  'version',
  'dist.integrity',
  'dist.shasum',
  'dist.tarball',
  'engines',
  '--json',
]).stdout);
const distTags = JSON.parse(run('npm', ['view', 'better-sqlite3', 'dist-tags', '--json']).stdout);
if (registry.version !== expectedVersion || distTags.latest !== expectedVersion) {
  throw new Error('requested better-sqlite3 release is not the current registry stable');
}
if (registry['dist.integrity'] !== expectedIntegrity) throw new Error('registry integrity mismatch');

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
if (lock.packages['node_modules/better-sqlite3'].integrity !== expectedIntegrity) {
  throw new Error('lock integrity mismatch');
}

const installs = [];
for (let repetition = 1; repetition <= 3; repetition += 1) {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const started = process.hrtime.bigint();
  const install = run('npm', ['ci']);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const smoke = run('node', [
    '--input-type=module',
    '-e',
    "import Database from 'better-sqlite3'; const d=new Database(':memory:'); console.log(JSON.stringify(d.prepare('SELECT sqlite_version() sqliteVersion, sqlite_source_id() sqliteSourceId').get())); d.close();",
  ]);
  installs.push({
    repetition,
    durationMs,
    exitStatus: install.status,
    stdout: install.stdout.trim().split('\n').filter(Boolean),
    stderr: install.stderr.trim().split('\n').filter(Boolean),
    runtimeSmoke: JSON.parse(smoke.stdout),
  });
}

const packDirectory = join(root, 'artifacts', 'package-check');
rmSync(packDirectory, { recursive: true, force: true });
mkdirSync(packDirectory, { recursive: true });
const packed = run('npm', ['pack', `better-sqlite3@${expectedVersion}`, '--pack-destination', packDirectory, '--json']);
const packResult = JSON.parse(packed.stdout)[0];
const tarballPath = join(packDirectory, packResult.filename);
const tarball = readFileSync(tarballPath);
const tarballIdentity = {
  bytes: tarball.length,
  sha256: createHash('sha256').update(tarball).digest('hex'),
  sha512Base64: createHash('sha512').update(tarball).digest('base64'),
  registrySri: expectedIntegrity,
  sriMatches: `sha512-${createHash('sha512').update(tarball).digest('base64')}` === expectedIntegrity,
  npmPackIntegrity: packResult.integrity,
  npmPackShasum: packResult.shasum,
};
if (!tarballIdentity.sriMatches) throw new Error('downloaded tarball does not match registry SRI');
rmSync(packDirectory, { recursive: true, force: true });

const result = {
  format: 's3-sqlite-install-reliability-v1',
  nodeVersion: process.version,
  npmVersion: run('npm', ['--version']).stdout.trim(),
  registry,
  distTags,
  lockIntegrity: lock.packages['node_modules/better-sqlite3'].integrity,
  installs,
  tarballIdentity,
};
const output = `${JSON.stringify(result, null, 2)}\n`;
const outputPath = join(rawDirectory, 'install-reliability.json');
await import('node:fs/promises').then(({ writeFile }) => writeFile(outputPath, output));
process.stdout.write(`${JSON.stringify({ outputPath, sha256: createHash('sha256').update(output).digest('hex') })}\n`);
