#!/usr/bin/env node

import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { cpus, freemem, homedir, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distribution,
  elapsedMs,
  makeEvent,
  makePayload,
  makeRng,
  nowNs,
  pathState,
  sha256,
  shuffle,
} from './common.mjs';
import { inspectBetterSqlite3, openBetterSqlite3 } from './adapters/better-sqlite3.mjs';
import { inspectNodeSqlite, openNodeSqlite } from './adapters/node-sqlite.mjs';
import { assertClosedSqlSurface, SCHEMA_SQL, STATIC_SQL_TEXT } from './schema.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORK = resolve(process.env.S3_SQLITE_BENCH_WORK_ROOT ?? join(ROOT, 'work'));
const RAW = join(ROOT, 'artifacts', 'raw');
const OUTPUT_STEM = process.env.S3_SQLITE_BENCH_OUTPUT_STEM ?? 'benchmark-results';
const WORKER = join(ROOT, 'bench-worker.mjs');
const REPETITIONS = 30;
const KILL_REPETITIONS = 10;
const PAYLOAD_SIZES = [1024, 16 * 1024, 256 * 1024];
const SEARCH_ROW_COUNTS = [1_000, 10_000, 50_000];
const BACKUP_ROWS = 5_000;
const CONTENTION_WRITERS = 4;
const CONTENTION_EVENTS_PER_WRITER = 8;

const implementations = Object.freeze({
  'node:sqlite': { open: openNodeSqlite, inspect: inspectNodeSqlite, slug: 'node' },
  'better-sqlite3': { open: openBetterSqlite3, inspect: inspectBetterSqlite3, slug: 'better' },
});

function progress(message) {
  process.stderr.write(`[benchmark] ${new Date().toISOString()} ${message}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonSafe(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function quickCheckIsOk(rows) {
  return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
}

function validateCheck(check, label) {
  assert(quickCheckIsOk(check.quickCheck), `${label}: quick_check failed`);
  assert(check.foreignKeyErrors.length === 0, `${label}: foreign key errors`);
  assert(Object.values(check.cross).every((value) => value === 0), `${label}: cross-table mismatch`);
  assert(check.journalMode === 'wal', `${label}: journal mode is not WAL`);
  assert(check.synchronous === 2, `${label}: synchronous is not FULL`);
  assert(check.foreignKeys === 1, `${label}: foreign keys disabled`);
  assert(check.trustedSchema === 0, `${label}: trusted_schema enabled`);
  assert(
    check.databases.every((row) => row.name === 'main' || row.name === 'temp'),
    `${label}: attached database found`,
  );
  assert(check.strictTables.length === 3, `${label}: missing schema tables`);
  assert(check.strictTables.every((row) => row.strict === 1), `${label}: non-STRICT table`);
}

function validateInspect(inspection, expected, label) {
  assert(quickCheckIsOk(inspection.quickCheck), `${label}: backup/recovery quick_check failed`);
  assert(Object.values(inspection.cross).every((value) => value === 0), `${label}: cross mismatch`);
  assert(inspection.counts.ledger_count === expected, `${label}: ledger count mismatch`);
  assert(inspection.counts.outbox_count === expected, `${label}: outbox count mismatch`);
  assert(inspection.counts.max_seq === expected, `${label}: sequence gap or mismatch`);
}

async function hashFile(path, algorithm = 'sha256', encoding = 'hex') {
  return createHash(algorithm).update(await readFile(path)).digest(encoding);
}

async function removeDatabaseFamily(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function summarize(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const identity = keys.map((key) => String(row[key])).join('\u0000');
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(row);
  }
  return [...groups.values()].map((group) => ({
    ...Object.fromEntries(keys.map((key) => [key, group[0][key]])),
    duration: distribution(group.map((row) => row.durationMs)),
  })).sort((left, right) => keys.map((key) => String(left[key])).join('|')
    .localeCompare(keys.map((key) => String(right[key])).join('|')));
}

async function environmentIdentity() {
  const packageLock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  const registry = JSON.parse(execFileSync(
    'npm',
    ['view', 'better-sqlite3@12.11.1', 'version', 'dist.integrity', 'dist.shasum', 'dist.tarball', 'engines', '--json'],
    { encoding: 'utf8' },
  ));
  const nativeAddon = join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const filesystem = await statfs(WORK, { bigint: false });
  const dfFields = execFileSync('df', ['-PT', WORK], { encoding: 'utf8' })
    .trim().split('\n').at(-1).trim().split(/\s+/u);
  return {
    nodeVersion: process.version,
    npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    nodeVersions: process.versions,
    platform: platform(),
    kernelRelease: release(),
    architecture: process.arch,
    cpu: { model: cpus()[0]?.model ?? null, logicalCores: cpus().length },
    memoryBytes: { total: totalmem(), freeAtStart: freemem() },
    filesystem: {
      type: filesystem.type,
      typeHex: `0x${filesystem.type.toString(16)}`,
      reportedType: dfFields[1],
      mountPoint: dfFields.at(-1),
      blockSize: filesystem.bsize,
      blocks: filesystem.blocks,
      availableBlocks: filesystem.bavail,
    },
    codeRoot: ROOT,
    workRoot: WORK,
    workRootIsInsideCodeRoot: WORK.startsWith(`${ROOT}${sep}`),
    workRootIsInsideHome: WORK.startsWith(`${homedir()}${sep}`),
    betterSqlite3: {
      registry,
      lockedVersion: packageLock.packages['node_modules/better-sqlite3'].version,
      lockedIntegrity: packageLock.packages['node_modules/better-sqlite3'].integrity,
      nativeAddonSha256: await hashFile(nativeAddon),
      nativeAddonBytes: (await stat(nativeAddon)).size,
    },
  };
}

async function runtimeIdentities() {
  const root = join(WORK, 'identity');
  await mkdir(root, { recursive: true });
  const result = {};
  for (const [name, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    const adapter = implementation.open(path);
    try {
      const exposedSurface = Object.keys(adapter).toSorted();
      assert(
        ['exec', 'prepare', 'loadExtension', 'attach', 'rawDatabase'].every(
          (name) => !exposedSurface.includes(name),
        ),
        `${name}: caller SQL or extension surface exposed`,
      );
      result[name] = adapter.identity();
      validateCheck(adapter.check(), `${name} identity database`);
    } finally {
      adapter.close();
    }
  }
  return result;
}

async function validateCorrectness() {
  progress('running pre-timing correctness gates');
  assertClosedSqlSurface();
  const root = join(WORK, 'correctness');
  await mkdir(root, { recursive: true });
  const results = {};
  const payload = makePayload(1024, 0xc011ec7);
  const payloadHash = sha256(payload);
  for (const [name, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    const backupPath = join(root, `${implementation.slug}.backup.sqlite`);
    const prefix = `${implementation.slug}-correctness`;
    const first = makeEvent({ prefix, index: 1, payload, payloadHash, entityCount: 2 });
    const second = {
      ...makeEvent({ prefix, index: 2, payload, payloadHash, entityCount: 2 }),
      entityKey: first.entityKey,
    };
    const third = {
      ...makeEvent({ prefix, index: 3, payload, payloadHash, entityCount: 2 }),
      entityKey: `${prefix}-entity-other`,
    };
    const adapter = implementation.open(path);
    let duplicateRejected = false;
    try {
      const exposedSurface = Object.keys(adapter).toSorted();
      assert(
        ['exec', 'prepare', 'loadExtension', 'attach', 'rawDatabase'].every(
          (surfaceName) => !exposedSurface.includes(surfaceName),
        ),
        `${name}: caller SQL or extension surface exposed`,
      );
      const sequences = [adapter.append(first), adapter.append(second), adapter.append(third)];
      assert(JSON.stringify(sequences) === '[1,2,3]', `${name}: sequence allocation failed`);
      const counts = adapter.counts();
      assert(counts.ledger_count === 3, `${name}: ledger correctness count`);
      assert(counts.projection_count === 2, `${name}: projection upsert count`);
      assert(counts.outbox_count === 3, `${name}: outbox correctness count`);
      const entityRows = adapter.searchEntity(first.entityKey, 3, 10);
      assert(entityRows.map((row) => row.seq).join(',') === '2,1', `${name}: entity search order`);
      assert(adapter.searchOutbox(0, 10).length === 3, `${name}: outbox search count`);
      try {
        adapter.append(first);
      } catch {
        duplicateRejected = true;
      }
      assert(duplicateRejected, `${name}: duplicate event was accepted`);
      assert(adapter.counts().ledger_count === 3, `${name}: duplicate transaction was not atomic`);
      assert(adapter.strictProbeRejected(), `${name}: STRICT BLOB type was not enforced`);
      assert(adapter.counts().ledger_count === 3, `${name}: strict probe changed ledger`);
      const check = adapter.check();
      validateCheck(check, `${name} correctness`);
      const whileOpen = await pathState(path);
      const backupResult = jsonSafe(await adapter.backup(backupPath));
      const backupInspection = implementation.inspect(backupPath);
      validateInspect(backupInspection, 3, `${name} correctness backup`);
      results[name] = {
        sequences,
        counts,
        duplicateRejected,
        strictProbeRejected: true,
        exposedSurface,
        callerSqlExposed: false,
        extensionLoaderExposed: false,
        entitySearchSequences: entityRows.map((row) => row.seq),
        outboxSearchCount: adapter.searchOutbox(0, 10).length,
        check,
        whileOpen,
        backupResult,
        backupSha256: await hashFile(backupPath),
      };
    } finally {
      adapter.close();
    }
    results[name].afterClose = await pathState(path);
    const reopened = implementation.inspect(path);
    validateInspect(reopened, 3, `${name} correctness restart`);
    results[name].restartInspection = reopened;
  }
  return results;
}

async function appendBenchmark() {
  progress('running randomized connection-cold/prepared-warm append benchmark');
  const root = join(WORK, 'append');
  await mkdir(root, { recursive: true });
  const cells = [];
  for (const [adapter, implementation] of Object.entries(implementations)) {
    for (const payloadBytes of PAYLOAD_SIZES) {
      for (const mode of ['cold-connection', 'warm-prepared']) {
        const path = join(root, `${implementation.slug}-${payloadBytes}-${mode}.sqlite`);
        const initial = implementation.open(path);
        initial.close();
        cells.push({ adapter, implementation, payloadBytes, mode, path });
      }
    }
  }
  const warmAdapters = new Map();
  for (const cell of cells.filter((item) => item.mode === 'warm-prepared')) {
    warmAdapters.set(cell.path, cell.implementation.open(cell.path));
  }
  const payloads = new Map(PAYLOAD_SIZES.map((size, index) => {
    const payload = makePayload(size, 0xa990000 + index);
    return [size, { payload, hash: sha256(payload) }];
  }));
  const rng = makeRng(0xa9905eed);
  const samples = [];
  try {
    for (let round = 0; round < REPETITIONS; round += 1) {
      for (const cell of shuffle(cells, rng)) {
        const content = payloads.get(cell.payloadBytes);
        const prefix = `${cell.implementation.slug}-append-${cell.payloadBytes}-${cell.mode}`;
        const event = makeEvent({
          prefix,
          index: round,
          payload: content.payload,
          payloadHash: content.hash,
          entityCount: 64,
        });
        const started = nowNs();
        let sequence;
        if (cell.mode === 'cold-connection') {
          const adapter = cell.implementation.open(cell.path);
          try {
            sequence = adapter.append(event);
          } finally {
            adapter.close();
          }
        } else {
          sequence = warmAdapters.get(cell.path).append(event);
        }
        samples.push({
          adapter: cell.adapter,
          payloadBytes: cell.payloadBytes,
          mode: cell.mode,
          round,
          sequence,
          durationMs: elapsedMs(started),
        });
      }
    }
  } finally {
    for (const adapter of warmAdapters.values()) adapter.close();
  }
  const invariants = {};
  for (const cell of cells) {
    const adapter = cell.implementation.open(cell.path);
    try {
      assert(adapter.counts().ledger_count === REPETITIONS, `${cell.adapter} append count`);
      validateCheck(adapter.check(), `${cell.adapter} ${cell.mode} ${cell.payloadBytes}`);
      invariants[`${cell.adapter}|${cell.mode}|${cell.payloadBytes}`] = {
        counts: adapter.counts(),
        check: adapter.check(),
        checkpoint: adapter.checkpointPassive(),
        whileOpen: await pathState(cell.path),
      };
    } finally {
      adapter.close();
    }
    invariants[`${cell.adapter}|${cell.mode}|${cell.payloadBytes}`].afterClose = await pathState(cell.path);
  }
  return { samples, summary: summarize(samples, ['adapter', 'mode', 'payloadBytes']), invariants };
}

async function searchBenchmark() {
  progress('running practical-row-count warm search benchmark');
  const root = join(WORK, 'search');
  await mkdir(root, { recursive: true });
  const states = {};
  const payload = makePayload(1024, 0x5ea2c4);
  const payloadHash = sha256(payload);
  for (const [adapter, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    states[adapter] = {
      adapter: implementation.open(path),
      implementation,
      path,
      prefix: `${implementation.slug}-search`,
      seeded: 0,
    };
  }
  const rng = makeRng(0x5ea2c001);
  const samples = [];
  const thresholdChecks = [];
  try {
    for (const rowCount of SEARCH_ROW_COUNTS) {
      for (const [adapterName, state] of Object.entries(states)) {
        const events = [];
        for (let index = state.seeded; index < rowCount; index += 1) {
          events.push(makeEvent({
            prefix: state.prefix,
            index,
            payload,
            payloadHash,
            entityCount: 100,
          }));
        }
        state.adapter.appendBatch(events);
        state.seeded = rowCount;
        assert(state.adapter.counts().ledger_count === rowCount, `${adapterName} search seed count`);
        validateCheck(state.adapter.check(), `${adapterName} search seed ${rowCount}`);
        thresholdChecks.push({ adapter: adapterName, rowCount, counts: state.adapter.counts() });
      }
      const cells = Object.keys(states).flatMap((adapter) => [
        { adapter, query: 'entity-history' },
        { adapter, query: 'pending-outbox' },
      ]);
      for (let round = 0; round < REPETITIONS; round += 1) {
        for (const cell of shuffle(cells, rng)) {
          const state = states[cell.adapter];
          let rows;
          const started = nowNs();
          if (cell.query === 'entity-history') {
            const entity = `${state.prefix}-entity-${String(round % 100).padStart(6, '0')}`;
            rows = state.adapter.searchEntity(entity, rowCount - ((round * 17) % 97), 20);
          } else {
            const maximumStart = Math.max(1, rowCount - 50);
            rows = state.adapter.searchOutbox((round * 997) % maximumStart, 50);
          }
          const durationMs = elapsedMs(started);
          assert(rows.length > 0, `${cell.adapter} ${cell.query} returned no rows`);
          samples.push({
            adapter: cell.adapter,
            rowCount,
            query: cell.query,
            round,
            rowsReturned: rows.length,
            durationMs,
          });
        }
      }
    }
  } finally {
    for (const state of Object.values(states)) state.adapter.close();
  }
  const finalState = {};
  for (const [adapter, state] of Object.entries(states)) {
    const inspection = state.implementation.inspect(state.path);
    validateInspect(inspection, SEARCH_ROW_COUNTS.at(-1), `${adapter} search final`);
    finalState[adapter] = { inspection, afterClose: await pathState(state.path) };
  }
  return {
    samples,
    summary: summarize(samples, ['adapter', 'rowCount', 'query']),
    thresholdChecks,
    finalState,
  };
}

async function backupBenchmark() {
  progress('running randomized online-backup benchmark');
  const root = join(WORK, 'backup');
  await mkdir(root, { recursive: true });
  const payload = makePayload(1024, 0xbacc001);
  const payloadHash = sha256(payload);
  const states = {};
  for (const [adapter, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}-source.sqlite`);
    const opened = implementation.open(path);
    const events = Array.from({ length: BACKUP_ROWS }, (_, index) => makeEvent({
      prefix: `${implementation.slug}-backup`,
      index,
      payload,
      payloadHash,
      entityCount: 500,
    }));
    opened.appendBatch(events);
    validateCheck(opened.check(), `${adapter} backup source`);
    states[adapter] = { implementation, path, opened };
  }
  const rng = makeRng(0xbacc5eed);
  const samples = [];
  try {
    for (let round = 0; round < REPETITIONS; round += 1) {
      for (const adapter of shuffle(Object.keys(states), rng)) {
        const state = states[adapter];
        const destination = join(root, `${state.implementation.slug}-backup-${round}.sqlite`);
        await removeDatabaseFamily(destination);
        const started = nowNs();
        const result = jsonSafe(await state.opened.backup(destination));
        const durationMs = elapsedMs(started);
        const inspection = state.implementation.inspect(destination);
        validateInspect(inspection, BACKUP_ROWS, `${adapter} backup ${round}`);
        samples.push({
          adapter,
          round,
          sourceRows: BACKUP_ROWS,
          durationMs,
          backupResult: result,
          bytes: (await stat(destination)).size,
          sha256: await hashFile(destination),
        });
        await removeDatabaseFamily(destination);
      }
    }
  } finally {
    for (const state of Object.values(states)) state.opened.close();
  }
  const finalState = {};
  for (const [adapter, state] of Object.entries(states)) {
    const inspection = state.implementation.inspect(state.path);
    validateInspect(inspection, BACKUP_ROWS, `${adapter} backup source final`);
    finalState[adapter] = { inspection, afterClose: await pathState(state.path) };
  }
  return { samples, summary: summarize(samples, ['adapter']), finalState };
}

function encodeWorkerConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

function spawnWorker(config) {
  const child = fork(WORKER, [encodeWorkerConfig(config)], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages = [];
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  const waitMessage = (predicate, milliseconds = 30_000) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const location = waiters.indexOf(waiter);
        if (location >= 0) waiters.splice(location, 1);
        reject(new Error(`worker message timeout; stderr=${stderr}`));
      }, milliseconds);
      waiters.push(waiter);
    });
  };
  const waitExit = (milliseconds = 30_000) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stderr });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker exit timeout; stderr=${stderr}`)), milliseconds);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stderr });
      });
    });
  };
  return { child, waitMessage, waitExit, stderr: () => stderr };
}

async function runContentionTrial({ adapter, implementation, databasePath, round }) {
  const workers = [];
  for (let writer = 0; writer < CONTENTION_WRITERS; writer += 1) {
    const worker = spawnWorker({
      mode: 'contention',
      adapter,
      databasePath,
      round,
      writer,
      count: CONTENTION_EVENTS_PER_WRITER,
      payloadSize: 1024,
      prefix: `${implementation.slug}-contention`,
      seed: 0xc017000 + (round * 10) + writer,
    });
    const ready = await worker.waitMessage((message) => message.type === 'ready' || message.type === 'fatal');
    assert(ready.type === 'ready', `${adapter} contention worker failed: ${ready.message}`);
    workers.push(worker);
  }
  const started = nowNs();
  for (const worker of workers) worker.child.send('start');
  const results = await Promise.all(workers.map((worker) => worker.waitMessage(
    (message) => message.type === 'result' || message.type === 'fatal',
    60_000,
  )));
  const durationMs = elapsedMs(started);
  assert(results.every((result) => result.type === 'result'), `${adapter} contention fatal result`);
  const exits = await Promise.all(workers.map((worker) => worker.waitExit()));
  assert(exits.every((exit) => exit.code === 0), `${adapter} contention worker exit failed`);
  return {
    adapter,
    round,
    writers: CONTENTION_WRITERS,
    eventsPerWriter: CONTENTION_EVENTS_PER_WRITER,
    durationMs,
    busyRetries: results.reduce((sum, result) => sum + result.busyRetries, 0),
    workerDurationMs: results.map((result) => result.durationMs),
  };
}

async function contentionBenchmark() {
  progress('running four-process single-writer contention benchmark');
  const root = join(WORK, 'contention');
  await mkdir(root, { recursive: true });
  const states = {};
  for (const [adapter, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    const opened = implementation.open(path);
    opened.close();
    states[adapter] = { implementation, path };
  }
  const rng = makeRng(0xc0175eed);
  const samples = [];
  for (let round = 0; round < REPETITIONS; round += 1) {
    for (const adapter of shuffle(Object.keys(states), rng)) {
      const state = states[adapter];
      samples.push(await runContentionTrial({
        adapter,
        implementation: state.implementation,
        databasePath: state.path,
        round,
      }));
      const expected = (round + 1) * CONTENTION_WRITERS * CONTENTION_EVENTS_PER_WRITER;
      const inspection = state.implementation.inspect(state.path);
      validateInspect(inspection, expected, `${adapter} contention round ${round}`);
    }
  }
  const finalState = {};
  for (const [adapter, state] of Object.entries(states)) {
    const opened = state.implementation.open(state.path);
    try {
      const check = opened.check();
      validateCheck(check, `${adapter} contention final`);
      finalState[adapter] = {
        counts: opened.counts(),
        check,
        whileOpen: await pathState(state.path),
      };
    } finally {
      opened.close();
    }
    finalState[adapter].afterClose = await pathState(state.path);
  }
  return { samples, summary: summarize(samples, ['adapter']), finalState };
}

async function restartBenchmark() {
  progress('running close/reopen recovery benchmark');
  const root = join(WORK, 'restart');
  await mkdir(root, { recursive: true });
  const payload = makePayload(1024, 0x2e57a27);
  const payloadHash = sha256(payload);
  const states = {};
  for (const [adapter, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    const opened = implementation.open(path);
    opened.close();
    states[adapter] = { implementation, path, prefix: `${implementation.slug}-restart` };
  }
  const rng = makeRng(0x2e575eed);
  const samples = [];
  for (let round = 0; round < REPETITIONS; round += 1) {
    for (const adapter of shuffle(Object.keys(states), rng)) {
      const state = states[adapter];
      const writer = state.implementation.open(state.path);
      writer.append(makeEvent({
        prefix: state.prefix,
        index: round,
        payload,
        payloadHash,
        entityCount: 16,
      }));
      writer.close();
      const started = nowNs();
      const reopened = state.implementation.open(state.path);
      const counts = reopened.counts();
      const durationMs = elapsedMs(started);
      assert(counts.ledger_count === round + 1, `${adapter} restart count`);
      const check = reopened.check();
      validateCheck(check, `${adapter} restart round ${round}`);
      reopened.close();
      samples.push({ adapter, round, durationMs, recoveredRows: counts.ledger_count });
    }
  }
  const finalState = {};
  for (const [adapter, state] of Object.entries(states)) {
    const inspection = state.implementation.inspect(state.path);
    validateInspect(inspection, REPETITIONS, `${adapter} restart final`);
    finalState[adapter] = { inspection, afterClose: await pathState(state.path) };
  }
  return { samples, summary: summarize(samples, ['adapter']), finalState };
}

async function killBoundaryTrial({ adapter, state, boundary, round, expectedBefore }) {
  const worker = spawnWorker({
    mode: 'kill-boundary',
    adapter,
    databasePath: state.path,
    boundary,
    index: (round * 10) + (boundary === 'after-commit' ? 1 : 0),
    payloadSize: 1024,
    prefix: `${state.implementation.slug}-kill-${boundary}-${round}`,
    seed: 0x4111000 + (round * 2) + (boundary === 'after-commit' ? 1 : 0),
  });
  const expectedMessage = boundary === 'before-commit' ? 'staged' : 'committed';
  const message = await worker.waitMessage(
    (value) => value.type === expectedMessage || value.type === 'fatal',
  );
  assert(message.type === expectedMessage, `${adapter} ${boundary} worker failed: ${message.message}`);
  const afterSignalBeforeRecovery = await pathState(state.path);
  worker.child.kill('SIGKILL');
  const exit = await worker.waitExit();
  assert(exit.signal === 'SIGKILL', `${adapter} ${boundary}: child not killed`);
  const afterKillBeforeRecovery = await pathState(state.path);
  const expectedAfter = expectedBefore + (boundary === 'after-commit' ? 1 : 0);
  const inspection = state.implementation.inspect(state.path);
  validateInspect(inspection, expectedAfter, `${adapter} ${boundary} recovery ${round}`);
  return {
    adapter,
    boundary,
    round,
    childSequence: message.seq,
    exitSignal: exit.signal,
    expectedBefore,
    expectedAfter,
    afterSignalBeforeRecovery,
    afterKillBeforeRecovery,
    afterRecovery: await pathState(state.path),
    inspection,
  };
}

async function killBoundaryChecks() {
  progress('running SIGKILL before/after-commit recovery checks');
  const root = join(WORK, 'kill-boundary');
  await mkdir(root, { recursive: true });
  const states = {};
  for (const [adapter, implementation] of Object.entries(implementations)) {
    const path = join(root, `${implementation.slug}.sqlite`);
    const opened = implementation.open(path);
    opened.close();
    states[adapter] = { implementation, path, expected: 0 };
  }
  const rng = makeRng(0x41115eed);
  const results = [];
  const baseCells = Object.keys(states).flatMap((adapter) => [
    { adapter, boundary: 'before-commit' },
    { adapter, boundary: 'after-commit' },
  ]);
  for (let round = 0; round < KILL_REPETITIONS; round += 1) {
    for (const cell of shuffle(baseCells, rng)) {
      const state = states[cell.adapter];
      const result = await killBoundaryTrial({
        adapter: cell.adapter,
        state,
        boundary: cell.boundary,
        round,
        expectedBefore: state.expected,
      });
      state.expected = result.expectedAfter;
      results.push(result);
    }
  }
  const finalState = {};
  for (const [adapter, state] of Object.entries(states)) {
    const opened = state.implementation.open(state.path);
    try {
      const check = opened.check();
      validateCheck(check, `${adapter} kill final`);
      assert(opened.counts().ledger_count === KILL_REPETITIONS, `${adapter} committed kill count`);
      finalState[adapter] = { counts: opened.counts(), check };
    } finally {
      opened.close();
    }
    finalState[adapter].afterClose = await pathState(state.path);
  }
  return { repetitionsPerBoundary: KILL_REPETITIONS, results, finalState };
}

async function codeIdentities() {
  const paths = [
    'package.json',
    'package-lock.json',
    'schema.mjs',
    'common.mjs',
    'adapters/node-sqlite.mjs',
    'adapters/better-sqlite3.mjs',
    'bench-worker.mjs',
    'install-check.mjs',
    'benchmark.mjs',
  ];
  const files = [];
  for (const relative of paths) {
    const path = join(ROOT, relative);
    files.push({ relative, bytes: (await stat(path)).size, sha256: await hashFile(path) });
  }
  const payload = files.map((file) => `${file.sha256}  ${file.relative}\n`).join('');
  return { files, orderedDigestSha256: sha256(payload), schemaSqlSha256: sha256(SCHEMA_SQL), staticSqlSha256: sha256(STATIC_SQL_TEXT) };
}

async function main() {
  assert(process.version === 'v24.18.0', `Node must be v24.18.0, got ${process.version}`);
  assert(/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(OUTPUT_STEM), 'unsafe output stem');
  assert(WORK !== ROOT && WORK !== homedir(), 'unsafe work root');
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await mkdir(RAW, { recursive: true });
  const startedAt = new Date().toISOString();
  const environment = await environmentIdentity();
  assert(environment.betterSqlite3.lockedVersion === '12.11.1', 'better-sqlite3 lock mismatch');
  assert(
    environment.betterSqlite3.registry['dist.integrity'] === environment.betterSqlite3.lockedIntegrity,
    'npm registry/lock integrity mismatch',
  );
  const identities = await runtimeIdentities();
  const correctness = await validateCorrectness();
  const append = await appendBenchmark();
  const search = await searchBenchmark();
  const backup = await backupBenchmark();
  const contention = await contentionBenchmark();
  const restart = await restartBenchmark();
  const killBoundaries = await killBoundaryChecks();
  const code = await codeIdentities();
  const installReliabilityPath = join(RAW, 'install-reliability.json');
  const installReliability = {
    path: 'artifacts/raw/install-reliability.json',
    sha256: await hashFile(installReliabilityPath),
    result: JSON.parse(await readFile(installReliabilityPath, 'utf8')),
  };
  const finishedAt = new Date().toISOString();
  const raw = {
    format: 's3-sqlite-adapter-qualification-v1',
    scope: 'synthetic-only; no user or OpenCode data; no production selection claim',
    startedAt,
    finishedAt,
    configuration: {
      repetitionsPerTimingCell: REPETITIONS,
      killRepetitionsPerBoundary: KILL_REPETITIONS,
      payloadSizesBytes: PAYLOAD_SIZES,
      searchRowCounts: SEARCH_ROW_COUNTS,
      backupRows: BACKUP_ROWS,
      contentionWriters: CONTENTION_WRITERS,
      contentionEventsPerWriter: CONTENTION_EVENTS_PER_WRITER,
      appendColdDefinition: 'new connection, safety PRAGMAs, schema IF NOT EXISTS, and statement preparation per append; OS cache not flushed',
      appendWarmDefinition: 'one persistent connection with precompiled statements',
      synchronous: 'FULL',
      journalMode: 'WAL',
      extensionLoading: 'not exposed; node:sqlite also opened allowExtension=false',
      callerSql: false,
      attach: false,
      outputStem: OUTPUT_STEM,
      workRoot: WORK,
    },
    environment,
    installReliability,
    runtimeIdentities: identities,
    codeIdentities: code,
    correctness,
    measurements: {
      append,
      search,
      backup,
      contention,
      restart,
    },
    recovery: { killBoundaries },
  };
  const outputName = `${OUTPUT_STEM}.json`;
  const output = join(RAW, outputName);
  await writeFile(output, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  const outputHash = await hashFile(output);
  await writeFile(
    join(RAW, `${OUTPUT_STEM}.sha256`),
    `${outputHash}  ${outputName}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  await rm(WORK, { recursive: true, force: true });
  progress(`complete: ${output}`);
  process.stdout.write(`${JSON.stringify({ output, sha256: outputHash, startedAt, finishedAt })}\n`);
}

await main();
