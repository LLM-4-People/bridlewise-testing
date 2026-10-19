import { makeEvent, makePayload, nowNs, elapsedMs, sha256 } from './common.mjs';
import { openNodeSqlite } from './adapters/node-sqlite.mjs';
import { openBetterSqlite3 } from './adapters/better-sqlite3.mjs';

const config = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const factories = {
  'node:sqlite': openNodeSqlite,
  'better-sqlite3': openBetterSqlite3,
};
const open = factories[config.adapter];
if (!open) throw new Error(`unsupported adapter: ${config.adapter}`);

const isBusy = (error) => error?.code === 'SQLITE_BUSY'
  || error?.errcode === 5
  || /database is (?:busy|locked)/iu.test(String(error?.message));

function sleep(milliseconds) {
  const word = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(word, 0, 0, milliseconds);
}
function send(document) {
  if (process.send) process.send(document);
}

async function contention() {
  const payload = makePayload(config.payloadSize, config.seed);
  const payloadHash = sha256(payload);
  const events = Array.from({ length: config.count }, (_, ordinal) => makeEvent({
    prefix: `${config.prefix}-writer-${config.writer}`,
    index: (config.round * 100_000) + (config.writer * 1_000) + ordinal,
    payload,
    payloadHash,
    entityCount: 32,
  }));
  const adapter = open(config.databasePath);
  send({ type: 'ready', pid: process.pid });
  process.once('message', (message) => {
    if (message !== 'start') throw new Error('unexpected worker control message');
    let busyRetries = 0;
    const started = nowNs();
    for (const event of events) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          adapter.append(event);
          break;
        } catch (error) {
          if (!isBusy(error) || attempt >= 20) throw error;
          busyRetries += 1;
          sleep(Math.min(20, attempt + 1));
        }
      }
    }
    const durationMs = elapsedMs(started);
    adapter.close();
    send({
      type: 'result',
      pid: process.pid,
      adapter: config.adapter,
      writer: config.writer,
      count: events.length,
      busyRetries,
      durationMs,
    });
  });
}

async function killBoundary() {
  const payload = makePayload(config.payloadSize, config.seed);
  const event = makeEvent({
    prefix: config.prefix,
    index: config.index,
    payload,
    payloadHash: sha256(payload),
    entityCount: 8,
  });
  const adapter = open(config.databasePath);
  if (config.boundary === 'before-commit') {
    const seq = adapter.stageForKill(event);
    send({ type: 'staged', pid: process.pid, seq });
  } else if (config.boundary === 'after-commit') {
    const seq = adapter.append(event);
    send({ type: 'committed', pid: process.pid, seq });
  } else {
    throw new Error(`unknown kill boundary: ${config.boundary}`);
  }
  setInterval(() => {}, 60_000);
}

try {
  if (config.mode === 'contention') await contention();
  else if (config.mode === 'kill-boundary') await killBoundary();
  else throw new Error(`unsupported worker mode: ${config.mode}`);
} catch (error) {
  send({ type: 'fatal', pid: process.pid, message: error?.stack ?? String(error) });
  process.exitCode = 1;
}
