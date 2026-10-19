import process from 'node:process';
import { openDriver, isBusy } from './adapters.mjs';
import { appendEvent, insertEventRows, makeEvent } from './operations.mjs';
import { applyMigrations } from './schema.mjs';

const configuration = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));

function send(message) {
  if (process.send) process.send(message);
}

function sleep(milliseconds) {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}

function open(options = {}) {
  const driver = openDriver(configuration.adapter, configuration.databasePath, {
    timeoutMs: configuration.timeoutMs ?? 5000,
    synchronous: configuration.synchronous ?? 'FULL',
    walAutoCheckpoint: configuration.walAutoCheckpoint ?? 1000,
    ...options,
  });
  applyMigrations(driver);
  return driver;
}

async function holdWriter() {
  const driver = open();
  driver.exec('BEGIN IMMEDIATE');
  send({ type: 'writer-locked', pid: process.pid });
  process.once('message', (message) => {
    if (message !== 'release') throw new Error('unexpected holder control message');
    driver.exec('ROLLBACK');
    driver.close();
    send({ type: 'released' });
    process.exit(0);
  });
}

async function tryWriter() {
  const driver = open();
  const started = process.hrtime.bigint();
  try {
    appendEvent(driver, makeEvent({ ordinal: configuration.ordinal }));
    send({ type: 'write-result', outcome: 'committed', durationMs: Number(process.hrtime.bigint() - started) / 1e6 });
  } catch (error) {
    send({
      type: 'write-result',
      outcome: isBusy(error) ? 'busy' : 'error',
      code: error?.code ?? null,
      message: String(error?.message),
      durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    });
  } finally {
    driver.close();
  }
}

async function contentionWriter() {
  const driver = open();
  send({ type: 'ready', writer: configuration.writer });
  process.once('message', (message) => {
    if (message !== 'start') throw new Error('unexpected contention control message');
    let retries = 0;
    const started = process.hrtime.bigint();
    for (let index = 0; index < configuration.count; index += 1) {
      const ordinal = configuration.baseOrdinal + (configuration.writer * configuration.count) + index;
      for (let attempt = 0; ; attempt += 1) {
        try {
          appendEvent(driver, makeEvent({
            ordinal,
            subjectId: `contention-subject-${ordinal % 11}`,
            actorId: `writer-${configuration.writer}`,
          }), { includeEdge: true });
          break;
        } catch (error) {
          if (!isBusy(error) || attempt >= 20) throw error;
          retries += 1;
          sleep(Math.min(25, 2 + attempt));
        }
      }
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    driver.close();
    send({ type: 'contention-result', writer: configuration.writer, retries, durationMs });
  });
}

async function holdReader() {
  const driver = open();
  driver.exec('BEGIN');
  const count = driver.get('SELECT count(*) AS count FROM event_log').count;
  send({ type: 'reader-held', count: count.toString() });
  process.once('message', (message) => {
    if (message !== 'release') throw new Error('unexpected reader control message');
    driver.exec('COMMIT');
    driver.close();
    send({ type: 'reader-released' });
    process.exit(0);
  });
}

async function killBoundary() {
  const driver = open();
  const event = makeEvent({ ordinal: configuration.ordinal });
  if (configuration.boundary === 'before-begin') {
    send({ type: 'boundary-ready', boundary: configuration.boundary });
    return;
  }
  driver.exec('BEGIN IMMEDIATE');
  if (configuration.boundary === 'after-begin') {
    send({ type: 'boundary-ready', boundary: configuration.boundary });
    return;
  }
  if (configuration.boundary === 'after-event-row') {
    insertEventRows(driver, event, { includeDocuments: false, includeEdge: false });
    send({ type: 'boundary-ready', boundary: configuration.boundary });
    return;
  }
  insertEventRows(driver, event, { includeDocuments: true, includeEdge: true });
  if (configuration.boundary === 'before-commit') {
    send({ type: 'boundary-ready', boundary: configuration.boundary });
    return;
  }
  if (configuration.boundary === 'after-commit') {
    driver.exec('COMMIT');
    send({ type: 'boundary-ready', boundary: configuration.boundary });
    return;
  }
  throw new Error(`unknown boundary: ${configuration.boundary}`);
}

try {
  if (configuration.mode === 'hold-writer') await holdWriter();
  else if (configuration.mode === 'try-writer') await tryWriter();
  else if (configuration.mode === 'contention-writer') await contentionWriter();
  else if (configuration.mode === 'hold-reader') await holdReader();
  else if (configuration.mode === 'kill-boundary') await killBoundary();
  else throw new Error(`unknown worker mode: ${configuration.mode}`);
} catch (error) {
  send({ type: 'fatal', message: String(error?.stack ?? error), code: error?.code ?? null });
  process.exitCode = 1;
}
