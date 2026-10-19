import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
export function makePayload(size, seed) {
  if (!Number.isSafeInteger(size) || size < 1) throw new TypeError('invalid payload size');
  let state = (seed >>> 0) || 0x9e3779b9;
  const payload = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[index] = state & 0xff;
  }
  return payload;
}

export function makeEvent({
  prefix,
  index,
  payload,
  payloadHash = sha256(payload),
  entityCount = 100,
}) {
  const ordinal = String(index).padStart(10, '0');
  return {
    eventId: `${prefix}-event-${ordinal}`,
    entityKey: `${prefix}-entity-${String(index % entityCount).padStart(6, '0')}`,
    eventType: 'object.appended',
    createdAtMs: 1_760_000_000_000 + index,
    payload,
    payloadHash,
    objectKey: `ledger/${prefix}/${ordinal}.bin`,
  };
}

export function makeRng(seed = 0x5eeda11) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function shuffle(values, rng) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export function nowNs() {
  return process.hrtime.bigint();
}

export function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export function distribution(samples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('empty sample set');
  const sorted = [...samples].sort((a, b) => a - b);
  const quantile = (fraction) => sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
  return {
    n: sorted.length,
    minMs: sorted[0],
    p05Ms: quantile(0.05),
    p50Ms: quantile(0.50),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: sorted.at(-1),
    meanMs: mean,
    stdevMs: Math.sqrt(variance),
  };
}

export async function pathState(databasePath) {
  const result = {};
  for (const [label, path] of [
    ['database', databasePath],
    ['wal', `${databasePath}-wal`],
    ['shm', `${databasePath}-shm`],
  ]) {
    try {
      const metadata = await stat(path);
      result[label] = { exists: true, bytes: metadata.size, mode: metadata.mode & 0o777 };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      result[label] = { exists: false, bytes: 0, mode: null };
    }
  }
  return result;
}

export function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? Number(value) : value,
  ]));
}
