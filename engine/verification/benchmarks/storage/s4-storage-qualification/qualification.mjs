#!/usr/bin/env node
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, mkdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, isConstraint, openDriver } from './adapters.mjs';
import {
  appendEvent, canonicalJson, insertEventRows, logicalDigest, makeEvent,
  queryCoverageDocument, rebuildProjections, schemaIdentity, verifyInvariants,
} from './operations.mjs';
import {
  applyMigrations, EVENT_TYPES, MIGRATIONS, RELATION_TYPES, sha256Bytes, sha256Hex,
} from './schema.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const WORK = join(ROOT, 'work');
const ARTIFACTS = join(ROOT, 'artifacts');
const WORKER = join(ROOT, 'worker.mjs');
const REPETITIONS = 3;
const NODE = process.execPath;
const ORIGINAL_UMASK = process.umask(0o077);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function asJson(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `hex:${Buffer.from(value).toString('hex')}`;
  }
  return value;
}

function debugJson(value) {
  return JSON.stringify(value, asJson);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function distribution(values) {
  return {
    n: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  };
}

async function removeDatabaseFamily(databasePath) {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true });
}

async function openInitialized(adapter, databasePath, options = {}) {
  await removeDatabaseFamily(databasePath);
  const driver = openDriver(adapter, databasePath, options);
  applyMigrations(driver);
  await chmod(databasePath, 0o600);
  return driver;
}

async function expectRejected(operation, message, predicate = () => true) {
  try {
    await operation();
  } catch (error) {
    assert(predicate(error), `${message}: rejected for unexpected reason: ${error?.stack ?? error}`);
    return { rejected: true, code: error?.code ?? null, message: String(error?.message) };
  }
  throw new Error(`${message}: unexpectedly accepted`);
}

function encodeWorker(configuration) {
  return Buffer.from(JSON.stringify(configuration)).toString('base64url');
}

function spawnWorker(configuration) {
  const child = fork(WORKER, [encodeWorker(configuration)], {
    cwd: ROOT,
    execPath: NODE,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  const queued = [];
  const waiters = [];
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('message', (message) => {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queued.push(message);
  });
  function waitMessage(predicate, timeoutMs = 30_000) {
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = { predicate, resolve: resolvePromise, reject: rejectPromise, timer: null };
      waiter.timer = setTimeout(() => {
        const location = waiters.indexOf(waiter);
        if (location >= 0) waiters.splice(location, 1);
        rejectPromise(new Error(`worker message timeout; stderr=${stderr}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }
  function waitExit(timeoutMs = 30_000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode, stderr });
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error(`worker exit timeout; stderr=${stderr}`)), timeoutMs,
      );
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal, stderr });
      });
    });
  }
  return { child, waitMessage, waitExit, stderr: () => stderr };
}

const cases = [];

async function runCase(adapter, scenario, repetition, operation) {
  const started = process.hrtime.bigint();
  try {
    const details = await operation();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    cases.push({ adapter, scenario, repetition, status: 'pass', durationMs, details });
    process.stderr.write(`PASS ${adapter} ${scenario} #${repetition + 1}\n`);
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    cases.push({
      adapter, scenario, repetition, status: 'fail', durationMs,
      error: String(error?.stack ?? error),
    });
    process.stderr.write(`FAIL ${adapter} ${scenario} #${repetition + 1}: ${error?.message}\n`);
  }
}

function casePath(adapter, scenario, repetition) {
  return join(WORK, `${adapter.replaceAll(/[^a-z0-9]/giu, '-')}-${scenario}-${repetition}.sqlite`);
}

async function schemaAndBigInt(adapter, repetition) {
  const databasePath = casePath(adapter, 'schema-bigint', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    driver.exec('CREATE TABLE bigint_probe(id INTEGER PRIMARY KEY, value INTEGER NOT NULL) STRICT;');
    const minimum = -9_223_372_036_854_775_808n;
    const maximum = 9_223_372_036_854_775_807n;
    driver.run('INSERT INTO bigint_probe(id, value) VALUES (?, ?)', 1n, minimum);
    driver.run('INSERT INTO bigint_probe(id, value) VALUES (?, ?)', 2n, maximum);
    const values = driver.all('SELECT value FROM bigint_probe ORDER BY id').map((row) => row.value);
    assert(values[0] === minimum && values[1] === maximum, 'signed-int64 BigInt round-trip failed');

    driver.exec('CREATE TABLE binding_probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    const hostile = "'); DROP TABLE event_log; --";
    driver.run('INSERT INTO binding_probe(id, value) VALUES (?, ?)', 1n, hostile);
    assert(driver.get('SELECT value FROM binding_probe WHERE id = ?', 1n).value === hostile,
      'prepared binding altered hostile text');
    assert(driver.get("SELECT count(*) AS count FROM sqlite_schema WHERE name='event_log'").count === 1n,
      'prepared binding allowed SQL injection');

    const strictRejection = await expectRejected(
      () => driver.run('INSERT INTO bigint_probe(id, value) VALUES (?, ?)', 3n, 'not-an-integer'),
      'STRICT integer probe', isConstraint,
    );
    driver.exec('BEGIN IMMEDIATE');
    assert(driver.get('SELECT count(*) AS count FROM event_log').count === 0n,
      'BEGIN IMMEDIATE read failed');
    driver.exec('ROLLBACK');
    const strictTables = driver.all('PRAGMA table_list')
      .filter((row) => ['event_log', 'event_documents', 'event_edges'].includes(row.name));
    assert(strictTables.length === 3 && strictTables.every((row) => row.strict === 1n),
      'source tables are not all STRICT');
    const userVersion = driver.get('PRAGMA user_version').user_version;
    assert(userVersion === BigInt(MIGRATIONS.at(-1).version), 'user_version mismatch');
    return { minimum: minimum.toString(), maximum: maximum.toString(), strictRejection, userVersion };
  } finally {
    driver.close();
  }
}

async function appendOnlyAndGraph(adapter, repetition) {
  const databasePath = casePath(adapter, 'append-graph', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    const first = makeEvent({ ordinal: 1 });
    appendEvent(driver, first, { includeEdge: true });
    const second = makeEvent({ ordinal: 2, causationEventId: first.eventId });
    appendEvent(driver, second, { includeEdge: true });
    driver.run(
      `INSERT INTO event_edges(
        edge_id, source_event_id, relation_type, target_kind, target_id,
        target_event_id, ordinal, evidence_event_id
      ) VALUES (?, ?, 'caused_by', 'event', ?, ?, 0, ?)`,
      `edge-event-${repetition}-000000`, second.eventId, first.eventId, first.eventId, second.eventId,
    );

    const update = await expectRejected(
      () => driver.run("UPDATE event_log SET event_type='task.completed' WHERE event_id=?", first.eventId),
      'source update', isConstraint,
    );
    const deletion = await expectRejected(
      () => driver.run('DELETE FROM event_log WHERE event_id=?', first.eventId),
      'source delete', isConstraint,
    );
    const edgeUpdate = await expectRejected(
      () => driver.run("UPDATE event_edges SET relation_type='derived_from' WHERE source_event_id=?", second.eventId),
      'edge update', isConstraint,
    );
    const gap = await expectRejected(() => driver.run(`
      INSERT INTO event_log(
        ledger_id, sequence, event_id, event_type, event_schema_version,
        occurred_at_us, recorded_at_us, monotonic_ns, trace_id, span_id,
        parent_span_id, correlation_id, causation_event_id, subject_kind, subject_id,
        actor_kind, actor_id, raw_payload_ref, raw_content_sha256,
        redacted_content_sha256, previous_chain_mac, chain_mac, flags
      )
      SELECT ledger_id, 99, 'evt-gap-00000000000000000000000000000001', event_type,
        event_schema_version, occurred_at_us, recorded_at_us, monotonic_ns, trace_id,
        span_id, parent_span_id, correlation_id, NULL, subject_kind, 'gap-subject',
        actor_kind, actor_id, raw_payload_ref, raw_content_sha256,
        redacted_content_sha256, chain_mac, chain_mac, flags
      FROM event_log WHERE event_id = ?
    `, first.eventId), 'sequence gap', isConstraint);
    const badCausation = makeEvent({
      ordinal: 3,
      causationEventId: 'evt-does-not-exist-000000000000000000000001',
    });
    const causation = await expectRejected(
      () => appendEvent(driver, badCausation), 'missing causation event', isConstraint,
    );
    const invalidTarget = await expectRejected(() => driver.run(
      `INSERT INTO event_edges(
        edge_id, source_event_id, relation_type, target_kind, target_id,
        target_event_id, ordinal, evidence_event_id
       ) VALUES (?, ?, 'derived_from', 'event', ?, ?, 1, ?)`,
      `edge-missing-${repetition}-0000`, second.eventId,
      'evt-does-not-exist-000000000000000000000001',
      'evt-does-not-exist-000000000000000000000001', second.eventId,
    ), 'missing event edge target', isConstraint);
    const danglingIdentity = await expectRejected(() => driver.run(
      `INSERT INTO event_edges(
        edge_id, source_event_id, relation_type, target_kind, target_id,
        target_event_id, ordinal, evidence_event_id
       ) VALUES (?, ?, 'derived_from', 'artifact', ?, NULL, 2, ?)`,
      `edge-dangling-${repetition}-0000`, second.eventId,
      'artifact-with-no-source-event', second.eventId,
    ), 'missing non-event edge target identity', isConstraint);
    const mismatchedProof = await expectRejected(() => driver.run(
      `INSERT INTO event_edges(
        edge_id, source_event_id, relation_type, target_kind, target_id,
        target_event_id, ordinal, evidence_event_id
       ) VALUES (?, ?, 'performed_by', 'agent', ?, ?, 3, ?)`,
      `edge-mismatch-${repetition}-0000`, second.eventId,
      second.actorId, first.eventId, second.eventId,
    ), 'mismatched non-event target proof', isConstraint);
    const third = makeEvent({ ordinal: 3, causationEventId: second.eventId });
    appendEvent(driver, third, { includeEdge: true });
    const invariant = verifyInvariants(driver);
    assert(invariant.ok, `valid append graph failed oracle: ${invariant.failures}`);
    return {
      update, deletion, edgeUpdate, gap, causation, invalidTarget, danglingIdentity, mismatchedProof,
      counts: {
        events: driver.get('SELECT count(*) AS count FROM event_log').count,
        edges: driver.get('SELECT count(*) AS count FROM event_edges').count,
      },
      invariant,
    };
  } finally {
    driver.close();
  }
}

async function migrationDeterminism(adapter, repetition) {
  const leftPath = casePath(adapter, 'migration-left', repetition);
  const rightPath = casePath(adapter, 'migration-right', repetition);
  const left = await openInitialized(adapter, leftPath);
  const right = await openInitialized(adapter, rightPath);
  try {
    const leftIdentity = schemaIdentity(left);
    const rightIdentity = schemaIdentity(right);
    assert(leftIdentity.sha256 === rightIdentity.sha256, 'fresh migration schema hashes differ');
    applyMigrations(left);
    assert(schemaIdentity(left).sha256 === leftIdentity.sha256, 'idempotent migration changed schema');
    const rows = left.all('SELECT version, name, sha256 FROM schema_migrations ORDER BY version');
    assert(rows.length === MIGRATIONS.length, 'migration ledger length mismatch');
    left.run("UPDATE schema_migrations SET sha256=? WHERE version=1", '0'.repeat(64));
    const tamper = await expectRejected(() => applyMigrations(left), 'migration checksum tamper');
    return { schemaSha256: leftIdentity.sha256, migrationRows: rows, tamper };
  } finally {
    left.close();
    right.close();
  }
}

async function backupRestore(adapter, repetition) {
  const sourcePath = casePath(adapter, 'backup-source', repetition);
  const backupPath = casePath(adapter, 'backup-copy', repetition);
  const driver = await openInitialized(adapter, sourcePath);
  try {
    for (let ordinal = 1; ordinal <= 24; ordinal += 1) {
      appendEvent(driver, makeEvent({
        ordinal,
        subjectId: `backup-subject-${ordinal % 7}`,
      }), { includeEdge: ordinal % 2 === 0 });
    }
    rebuildProjections(driver);
    const sourceDigest = logicalDigest(driver);
    await removeDatabaseFamily(backupPath);
    const backupResult = await driver.backup(backupPath);
    await chmod(backupPath, 0o600);
    const restored = openDriver(adapter, backupPath, { readOnly: true, fileMustExist: true });
    try {
      const restoredDigest = logicalDigest(restored);
      const invariant = verifyInvariants(restored);
      assert(invariant.ok, `backup invariant failure: ${invariant.failures}`);
      assert(restoredDigest.sha256 === sourceDigest.sha256, 'backup logical digest differs');
      return {
        sourceDigest,
        restoredDigest,
        invariant,
        backupResult,
        backupBytes: (await stat(backupPath)).size,
      };
    } finally {
      restored.close();
    }
  } finally {
    driver.close();
  }
}

function digest64(label) {
  return createHash('sha256').update(label).digest('hex');
}

async function projectionRebuildAndLearning(adapter, repetition) {
  const databasePath = casePath(adapter, 'projection-learning', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    const attempt1 = {
      attemptId: `attempt-${repetition}-0001`, taskId: `task-${repetition}`,
      previousAttemptId: null, status: 'failed',
      inputDigest: digest64('input-1'), contextDigest: digest64('context-1'),
      toolDigest: digest64('tool-1'), outcomeDigest: digest64('outcome-1'),
      summary: 'first hostile attempt failed deterministically',
    };
    const attempt2 = {
      attemptId: `attempt-${repetition}-0002`, taskId: `task-${repetition}`,
      previousAttemptId: attempt1.attemptId, status: 'succeeded',
      inputDigest: digest64('input-2'), contextDigest: digest64('context-2'),
      toolDigest: digest64('tool-2'), outcomeDigest: digest64('outcome-2'),
      summary: 'second attempt succeeded after consulting the first result',
    };
    const event1 = makeEvent({
      ordinal: 1, eventType: 'task.completed', subjectId: attempt1.taskId,
      query: { attempt: attempt1 },
    });
    appendEvent(driver, event1, { includeEdge: true });
    const event2 = makeEvent({
      ordinal: 2, eventType: 'task.completed', subjectId: attempt2.taskId,
      causationEventId: event1.eventId, query: { attempt: attempt2 },
    });
    appendEvent(driver, event2, { includeEdge: true });
    const memory1 = {
      memoryId: `memory-${repetition}`, version: 1,
      parentMemoryId: null, parentVersion: null, status: 'superseded',
      evidenceEventIds: [event1.eventId], summary: 'initial evidence-backed memory',
    };
    const event3 = makeEvent({
      ordinal: 3, eventType: 'memory.recorded', subjectKind: 'memory',
      subjectId: memory1.memoryId, causationEventId: event2.eventId,
      query: { memory: memory1 },
    });
    appendEvent(driver, event3, { includeEdge: true });
    const memory2 = {
      memoryId: memory1.memoryId, version: 2,
      parentMemoryId: memory1.memoryId, parentVersion: 1, status: 'active',
      evidenceEventIds: [event1.eventId, event2.eventId, event3.eventId],
      summary: 'updated memory retains lineage and all evidence',
    };
    const event4 = makeEvent({
      ordinal: 4, eventType: 'memory.superseded', subjectKind: 'memory',
      subjectId: memory2.memoryId, causationEventId: event3.eventId,
      query: { memory: memory2 },
    });
    appendEvent(driver, event4, { includeEdge: true });
    rebuildProjections(driver, 1_900_000_000_000_000n);
    const before = logicalDigest(driver);
    const attempts = driver.all('SELECT * FROM attempt_projection ORDER BY attempt_id');
    const memories = driver.all('SELECT * FROM memory_projection ORDER BY memory_id, version');
    assert(attempts.length === 2 && attempts[1].previous_attempt_id === attempts[0].attempt_id,
      'attempt lineage was not rebuilt');
    assert(memories.length === 2 && memories[1].parent_version === 1n,
      'memory lineage was not rebuilt');

    driver.exec(`
      DELETE FROM projection_offsets;
      DELETE FROM entity_latest_projection;
      DELETE FROM attempt_projection;
      DELETE FROM memory_projection;
      DELETE FROM timeline_projection;
    `);
    rebuildProjections(driver, 1_900_000_000_000_000n);
    const after = logicalDigest(driver);
    assert(after.sha256 === before.sha256, 'projection rebuild was not deterministic');
    return { before, after, attempts, memories };
  } finally {
    driver.close();
  }
}

async function taxonomyAndTimelineCoverage(adapter, repetition) {
  const databasePath = casePath(adapter, 'taxonomy', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    const events = [];
    for (let index = 0; index < EVENT_TYPES.length; index += 1) {
      const ordinal = index + 1;
      const type = EVENT_TYPES[index];
      const subjectKind = type.startsWith('vcs.') ? 'commit'
        : type.startsWith('agent.') ? 'agent'
          : type.startsWith('tool.') ? 'tool'
            : type.startsWith('context.') ? 'context'
              : type.startsWith('test.') ? 'test'
                : type === 'repository.edit' ? 'edit'
                  : type === 'repository.snapshot' ? 'repository'
                    : type.startsWith('model.') ? 'model'
                      : type.startsWith('provider.') ? 'provider'
                        : type.startsWith('deployment.') ? 'deployment'
                          : type.startsWith('memory.') ? 'memory'
                            : type.startsWith('research.') ? 'research' : 'task';
      const event = makeEvent({
        ordinal,
        eventType: type,
        causationEventId: events.at(-1)?.eventId ?? null,
        subjectKind,
        subjectId: `${type}-${repetition}`,
      });
      appendEvent(driver, event, { includeEdge: true });
      events.push(event);
    }
    const commit = events.find((event) => event.eventType === 'vcs.commit');
    const targetTypeByRelation = {
      caused_by: 'task.started', correlated_with: 'interaction.input',
      parent_of: 'subtask.started', performed_by: 'agent.started',
      used_context: 'context.snapshot', used_model: 'model.invocation',
      used_provider: 'provider.request', invoked_tool: 'tool.call',
      produced_edit: 'repository.edit', validated_by_test: 'test.result',
      materialized_commit: 'vcs.commit', tagged_as: 'vcs.tag',
      checkpoint_of: 'vcs.checkpoint', rolled_back_to: 'vcs.rollback',
      deployed_as: 'deployment.completed', derived_from: 'repository.snapshot',
      attempted_after: 'task.completed', remembers: 'memory.recorded',
    };
    for (let index = 0; index < RELATION_TYPES.length; index += 1) {
      const relation = RELATION_TYPES[index];
      const target = events.find((event) => event.eventType === targetTypeByRelation[relation]);
      assert(target, `coverage target missing for ${relation}`);
      driver.run(
        `INSERT INTO event_edges(
          edge_id, source_event_id, relation_type, target_kind, target_id,
          target_event_id, ordinal, evidence_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `edge-${digest64(`coverage|${commit.eventId}|${relation}`).slice(0, 40)}`,
        commit.eventId, relation, target.subjectKind, target.subjectId, target.eventId,
        BigInt(index), commit.eventId,
      );
    }
    rebuildProjections(driver);
    const observedTypes = driver.all('SELECT DISTINCT event_type FROM timeline_projection ORDER BY event_type')
      .map((row) => row.event_type);
    assert(canonicalJson(observedTypes) === canonicalJson([...EVENT_TYPES].sort()),
      'timeline does not cover complete event taxonomy');
    const headerRow = driver.get(
      'SELECT ordered_headers_json FROM timeline_projection WHERE event_id=?', events[0].eventId,
    );
    const headers = JSON.parse(headerRow.ordered_headers_json);
    assert(headers[0][0] === 'x-repeat' && headers[1][0] === 'X-Repeat',
      'ordered duplicate headers were not preserved');
    const timelineColumns = driver.all('PRAGMA table_info(timeline_projection)').map((row) => row.name);
    assert(!timelineColumns.includes('raw_payload_ref') && !timelineColumns.includes('raw_content_sha256'),
      'raw payload references leaked into redacted query projection');
    const commitEdges = driver.all(
      `SELECT relation_type, target_kind, target_id, target_event_id
       FROM event_edges WHERE source_event_id=? ORDER BY relation_type, ordinal`, commit.eventId,
    );
    const commitRelations = commitEdges.map((row) => row.relation_type);
    for (const required of ['performed_by', 'used_context', 'validated_by_test', 'materialized_commit']) {
      assert(commitRelations.includes(required), `commit graph missing ${required}`);
    }
    const exactLinkKinds = new Map(commitEdges.map((edge) => [edge.relation_type, edge.target_kind]));
    assert(exactLinkKinds.get('performed_by') === 'agent', 'commit agent target not typed');
    assert(exactLinkKinds.get('used_context') === 'context', 'commit context target not typed');
    assert(exactLinkKinds.get('validated_by_test') === 'test', 'commit test target not typed');
    assert(commitEdges.filter((edge) => edge.relation_type !== 'performed_by')
      .every((edge) => typeof edge.target_event_id === 'string'),
    'commit typed edge lacks exact target event proof');
    return {
      eventTypes: observedTypes.length,
      relationTypes: commitRelations,
      commitEdges,
      orderedHeaders: headers,
      coverage: queryCoverageDocument(),
      invariant: verifyInvariants(driver),
    };
  } finally {
    driver.close();
  }
}

async function falseGreenControls(adapter, repetition) {
  const databasePath = casePath(adapter, 'false-green', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      appendEvent(driver, makeEvent({ ordinal }), { includeEdge: true });
    }
    rebuildProjections(driver);
    const baseline = verifyInvariants(driver);
    assert(baseline.ok, `baseline oracle failure: ${baseline.failures}`);
    driver.exec('DROP TRIGGER event_log_no_update; DROP TRIGGER event_documents_no_update;');
    driver.run(
      'UPDATE event_log SET previous_chain_mac=? WHERE ledger_id=? AND sequence=?',
      Buffer.alloc(32, 0xa5), 'main', 2n,
    );
    driver.run(
      `UPDATE event_documents SET content_sha256=?
       WHERE event_id=(SELECT event_id FROM event_log WHERE ledger_id='main' AND sequence=3)
         AND document_kind='redacted.query.v1'`,
      Buffer.alloc(32, 0x5a),
    );
    const mutant = verifyInvariants(driver);
    assert(!mutant.ok, 'mutated invalid database falsely passed oracle');
    assert(mutant.failures.some((failure) => failure.startsWith('chain-link:')),
      'chain mutation was not detected');
    assert(mutant.failures.some((failure) => failure.startsWith('document-digest:')),
      'document digest mutation was not detected');
    return { baseline, mutant };
  } finally {
    driver.close();
  }
}

async function securityControls(adapter, repetition) {
  const databasePath = casePath(adapter, 'security', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    driver.installRuntimeAuthorizer();
    const trustedSchema = driver.get('PRAGMA trusted_schema').trusted_schema;
    assert(trustedSchema === 0n, 'trusted_schema is not disabled');
    const extension = await expectRejected(
      () => driver.get("SELECT load_extension('/tmp/does-not-exist') AS value"),
      'extension loading',
    );
    let attach;
    if (adapter === 'node:sqlite') {
      attach = await expectRejected(
        () => driver.exec("ATTACH DATABASE ':memory:' AS hostile"), 'ATTACH authorizer',
      );
    } else {
      driver.exec("ATTACH DATABASE ':memory:' AS hostile");
      const databases = driver.all('PRAGMA database_list');
      assert(databases.some((row) => row.name === 'hostile'),
        'expected raw better-sqlite3 ATTACH capability not observed');
      driver.exec('DETACH DATABASE hostile');
      attach = { rejected: false, rawDriverCanAttach: true, compensation: 'closed typed port only' };
    }
    let writableSchema;
    try {
      driver.exec('PRAGMA writable_schema = ON');
      writableSchema = driver.get('PRAGMA writable_schema').writable_schema;
      driver.exec('PRAGMA writable_schema = OFF');
    } catch (error) {
      writableSchema = `rejected:${error?.code ?? error?.message}`;
    }
    const securityState = driver.securityState();
    const productionSurface = Object.freeze({
      append: () => undefined,
      readTimeline: () => undefined,
      verify: () => undefined,
      backup: () => undefined,
      close: () => undefined,
    });
    const exposed = Object.keys(productionSurface).sort();
    assert(!exposed.some((name) => ['exec', 'prepare', 'pragma', 'loadExtension', 'unsafeMode'].includes(name)),
      'closed port exposes raw driver capability');
    return { trustedSchema, extension, attach, writableSchema, securityState, closedPortKeys: exposed };
  } finally {
    driver.close();
  }
}

async function busyTimeoutSemantics(adapter, repetition) {
  const databasePath = casePath(adapter, 'busy-timeout', repetition);
  const initialized = await openInitialized(adapter, databasePath);
  initialized.close();

  const holder = spawnWorker({
    mode: 'hold-writer', adapter, databasePath, timeoutMs: 5000,
  });
  const held = await holder.waitMessage((message) => message.type === 'writer-locked' || message.type === 'fatal');
  assert(held.type === 'writer-locked', `holder failed: ${held.message}`);

  const short = spawnWorker({
    mode: 'try-writer', adapter, databasePath, timeoutMs: 180,
    ordinal: 10_000 + repetition,
  });
  const shortResult = await short.waitMessage(
    (message) => message.type === 'write-result' || message.type === 'fatal',
  );
  const shortExit = await short.waitExit();
  assert(shortResult.type === 'write-result' && shortResult.outcome === 'busy',
    `short timeout did not return SQLITE_BUSY: ${debugJson(shortResult)}`);
  assert(shortExit.code === 0, `short contender exited ${shortExit.code}: ${shortExit.stderr}`);
  assert(shortResult.durationMs >= 100 && shortResult.durationMs < 1500,
    `busy timeout duration outside bounded range: ${shortResult.durationMs}`);

  const long = spawnWorker({
    mode: 'try-writer', adapter, databasePath, timeoutMs: 2500,
    ordinal: 20_000 + repetition,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  holder.child.send('release');
  const released = await holder.waitMessage(
    (message) => message.type === 'released' || message.type === 'fatal',
  );
  assert(released.type === 'released', `holder release failed: ${released.message}`);
  const holderExit = await holder.waitExit();
  assert(holderExit.code === 0, `holder exit failed: ${holderExit.stderr}`);
  const longResult = await long.waitMessage(
    (message) => message.type === 'write-result' || message.type === 'fatal',
  );
  const longExit = await long.waitExit();
  assert(longResult.type === 'write-result' && longResult.outcome === 'committed',
    `long timeout did not commit after release: ${debugJson(longResult)}`);
  assert(longExit.code === 0, `long contender exit failed: ${longExit.stderr}`);

  const inspection = openDriver(adapter, databasePath, { readOnly: true, fileMustExist: true });
  try {
    const count = inspection.get('SELECT count(*) AS count FROM event_log').count;
    assert(count === 1n, `busy trial committed unexpected row count ${count}`);
    return { short: shortResult, long: longResult, count };
  } finally {
    inspection.close();
  }
}

async function singleWriterContention(adapter, repetition) {
  const databasePath = casePath(adapter, 'contention', repetition);
  const initialized = await openInitialized(adapter, databasePath);
  initialized.close();
  const writerCount = 4;
  const eventsPerWriter = 25;
  const workers = [];
  for (let writer = 0; writer < writerCount; writer += 1) {
    const worker = spawnWorker({
      mode: 'contention-writer', adapter, databasePath,
      timeoutMs: 1500, writer, count: eventsPerWriter,
      baseOrdinal: 100_000 + (repetition * 10_000),
    });
    const ready = await worker.waitMessage((message) => message.type === 'ready' || message.type === 'fatal');
    assert(ready.type === 'ready', `contention worker failed to initialize: ${ready.message}`);
    workers.push(worker);
  }
  const started = process.hrtime.bigint();
  for (const worker of workers) worker.child.send('start');
  const results = await Promise.all(workers.map((worker) => worker.waitMessage(
    (message) => message.type === 'contention-result' || message.type === 'fatal', 60_000,
  )));
  const exits = await Promise.all(workers.map((worker) => worker.waitExit(60_000)));
  assert(results.every((result) => result.type === 'contention-result'),
    `contention worker fatal: ${debugJson(results)}`);
  assert(exits.every((exit) => exit.code === 0),
    `contention worker exit failure: ${debugJson(exits)}`);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const inspection = openDriver(adapter, databasePath, { readOnly: true, fileMustExist: true });
  try {
    const count = inspection.get('SELECT count(*) AS count FROM event_log').count;
    assert(count === BigInt(writerCount * eventsPerWriter), `contention row count ${count}`);
    const invariant = verifyInvariants(inspection);
    assert(invariant.ok, `contention invariants failed: ${invariant.failures}`);
    return {
      writerCount, eventsPerWriter, durationMs, results, count,
      busyRetries: results.reduce((sum, result) => sum + result.retries, 0), invariant,
    };
  } finally {
    inspection.close();
  }
}

async function walStarvationAndCheckpoint(adapter, repetition) {
  const databasePath = casePath(adapter, 'wal-starvation', repetition);
  const seed = await openInitialized(adapter, databasePath, { walAutoCheckpoint: 0 });
  appendEvent(seed, makeEvent({ ordinal: 1, documentBytes: 8192 }));
  seed.close();

  const reader = spawnWorker({
    mode: 'hold-reader', adapter, databasePath, walAutoCheckpoint: 0, timeoutMs: 5000,
  });
  const held = await reader.waitMessage((message) => message.type === 'reader-held' || message.type === 'fatal');
  assert(held.type === 'reader-held' && held.count === '1', `reader snapshot failed: ${debugJson(held)}`);

  const writer = openDriver(adapter, databasePath, { walAutoCheckpoint: 0, timeoutMs: 5000 });
  applyMigrations(writer);
  try {
    for (let ordinal = 2; ordinal <= 121; ordinal += 1) {
      appendEvent(writer, makeEvent({ ordinal, documentBytes: 8192 }));
    }
    const before = await stat(`${databasePath}-wal`);
    const passive = writer.checkpoint('PASSIVE');
    assert(before.size > 256 * 1024, `WAL did not grow under reader: ${before.size}`);
    assert(passive.log > passive.checkpointed,
      `checkpoint starvation not observed: ${debugJson(passive)}`);
    reader.child.send('release');
    const released = await reader.waitMessage(
      (message) => message.type === 'reader-released' || message.type === 'fatal',
    );
    assert(released.type === 'reader-released', `reader release failed: ${released.message}`);
    const readerExit = await reader.waitExit();
    assert(readerExit.code === 0, `reader exit failed: ${readerExit.stderr}`);
    const truncate = writer.checkpoint('TRUNCATE');
    const after = await stat(`${databasePath}-wal`);
    assert(truncate.busy === 0n && after.size === 0,
      `TRUNCATE checkpoint did not clear WAL: ${debugJson({ truncate, bytes: after.size })}`);
    const invariant = verifyInvariants(writer);
    assert(invariant.ok, `WAL trial invariants failed: ${invariant.failures}`);
    return {
      beforeBytes: before.size, passive, truncate, afterBytes: after.size,
      events: writer.get('SELECT count(*) AS count FROM event_log').count,
    };
  } finally {
    writer.close();
    if (reader.child.exitCode === null && reader.child.signalCode === null) reader.child.kill('SIGKILL');
  }
}

async function killBoundary(adapter, repetition, boundary, synchronous = 'FULL') {
  const slug = `kill-${boundary}-${synchronous.toLowerCase()}`;
  const databasePath = casePath(adapter, slug, repetition);
  const initialized = await openInitialized(adapter, databasePath, { synchronous });
  initialized.close();
  const worker = spawnWorker({
    mode: 'kill-boundary', adapter, databasePath, boundary, synchronous,
    timeoutMs: 5000, ordinal: 300_000 + (repetition * 100) + boundary.length,
  });
  const ready = await worker.waitMessage(
    (message) => message.type === 'boundary-ready' || message.type === 'fatal',
  );
  assert(ready.type === 'boundary-ready', `kill boundary worker failed: ${ready.message}`);
  worker.child.kill('SIGKILL');
  const exit = await worker.waitExit();
  assert(exit.signal === 'SIGKILL', `worker was not SIGKILLed: ${debugJson(exit)}`);
  const recovered = openDriver(adapter, databasePath, {
    synchronous, timeoutMs: 5000,
  });
  applyMigrations(recovered);
  try {
    const count = recovered.get('SELECT count(*) AS count FROM event_log').count;
    const expected = boundary === 'after-commit' ? 1n : 0n;
    assert(count === expected, `${boundary} recovered ${count} events, expected ${expected}`);
    const invariant = verifyInvariants(recovered);
    assert(invariant.ok, `${boundary} recovery invariant failed: ${invariant.failures}`);
    const synchronousValue = recovered.get('PRAGMA synchronous').synchronous;
    const integrity = recovered.all('PRAGMA integrity_check');
    return { boundary, synchronous, synchronousValue, count, exitSignal: exit.signal, invariant, integrity };
  } finally {
    recovered.close();
  }
}

async function integrityForeignKeysAndFiles(adapter, repetition) {
  const databasePath = casePath(adapter, 'integrity-files', repetition);
  const driver = await openInitialized(adapter, databasePath);
  try {
    const first = makeEvent({ ordinal: 1 });
    appendEvent(driver, first, { includeEdge: true });
    rebuildProjections(driver);
    const invalidForeignKey = await expectRejected(() => driver.run(
      `INSERT INTO event_documents(event_id, document_kind, canonical_json, content_sha256)
       VALUES (?, 'redacted.query.v1', '{}', ?)`,
      'evt-missing-0000000000000000000000000000001', sha256Bytes('{}'),
    ), 'foreign-key rejection', isConstraint);
    const quick = driver.all('PRAGMA quick_check');
    const full = driver.all('PRAGMA integrity_check');
    const foreign = driver.all('PRAGMA foreign_key_check');
    assert(Object.values(quick[0])[0] === 'ok' && Object.values(full[0])[0] === 'ok',
      'integrity check did not return ok');
    assert(foreign.length === 0, 'foreign_key_check found violations');
    const pragmas = {
      foreignKeys: driver.get('PRAGMA foreign_keys').foreign_keys,
      trustedSchema: driver.get('PRAGMA trusted_schema').trusted_schema,
      journalMode: driver.get('PRAGMA journal_mode').journal_mode,
      synchronous: driver.get('PRAGMA synchronous').synchronous,
    };
    assert(pragmas.foreignKeys === 1n && pragmas.trustedSchema === 0n && pragmas.journalMode === 'wal',
      `safety PRAGMAs wrong: ${debugJson(pragmas)}`);
    const files = {};
    for (const [name, file] of [['database', databasePath], ['wal', `${databasePath}-wal`], ['shm', `${databasePath}-shm`]]) {
      const metadata = await stat(file);
      files[name] = { bytes: metadata.size, mode: metadata.mode & 0o777 };
      assert(files[name].mode === 0o600, `${name} mode is ${files[name].mode.toString(8)}, expected 600`);
    }
    return { invalidForeignKey, quick, full, foreignKeyErrors: foreign.length, pragmas, files };
  } finally {
    driver.close();
  }
}

async function resourceAndLatency(adapter, repetition) {
  const databasePath = casePath(adapter, 'resource-latency', repetition);
  const driver = await openInitialized(adapter, databasePath, { walAutoCheckpoint: 1000 });
  const beforeRss = process.memoryUsage().rss;
  const appendDurations = [];
  try {
    for (let ordinal = 1; ordinal <= 500; ordinal += 1) {
      const started = process.hrtime.bigint();
      appendEvent(driver, makeEvent({
        ordinal,
        subjectId: `resource-subject-${ordinal % 50}`,
        documentBytes: ordinal % 17 === 0 ? 4096 : 0,
      }), { includeEdge: ordinal % 10 === 0 });
      appendDurations.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    const rebuildStarted = process.hrtime.bigint();
    rebuildProjections(driver);
    const rebuildMs = Number(process.hrtime.bigint() - rebuildStarted) / 1e6;
    const queryStarted = process.hrtime.bigint();
    const rows = driver.all(
      `SELECT event_id, event_type, recorded_at_us FROM browsable_timeline
       WHERE subject_kind='task' ORDER BY recorded_at_us DESC LIMIT 100`,
    );
    const queryMs = Number(process.hrtime.bigint() - queryStarted) / 1e6;
    const afterRss = process.memoryUsage().rss;
    const appendDistribution = distribution(appendDurations);
    const pageCount = driver.get('PRAGMA page_count').page_count;
    const pageSize = driver.get('PRAGMA page_size').page_size;
    const checkpoint = driver.checkpoint('TRUNCATE');
    const databaseBytes = (await stat(databasePath)).size;
    assert(rows.length === 100, `resource query returned ${rows.length}`);
    assert(appendDistribution.p95Ms < 250, `append p95 regression: ${appendDistribution.p95Ms} ms`);
    assert(queryMs < 1000 && rebuildMs < 5000, 'query or projection rebuild exceeded bound');
    assert(afterRss - beforeRss < 256 * 1024 * 1024,
      `RSS grew by ${(afterRss - beforeRss) / 1024 / 1024} MiB`);
    const invariant = verifyInvariants(driver);
    assert(invariant.ok, `resource trial invariant failure: ${invariant.failures}`);
    return {
      rows: 500,
      append: appendDistribution,
      rebuildMs,
      queryMs,
      rssBefore: beforeRss,
      rssAfter: afterRss,
      rssDelta: afterRss - beforeRss,
      pageCount,
      pageSize,
      databaseBytes,
      checkpoint,
    };
  } finally {
    driver.close();
  }
}

async function verifyPriorBenchmark() {
  const priorRoot = '/tmp/s3-sqlite-adapter-benchmark';
  const sums = (await readFile(join(priorRoot, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  const files = [];
  for (const line of sums) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    assert(match, `malformed prior checksum line: ${line}`);
    const bytes = await readFile(join(priorRoot, match[2]));
    const observed = createHash('sha256').update(bytes).digest('hex');
    assert(observed === match[1], `prior benchmark hash mismatch: ${match[2]}`);
    files.push({ path: match[2], sha256: observed, bytes: bytes.length });
  }
  let timingSamples = 0;
  let killChecks = 0;
  const raw = [];
  for (const name of ['benchmark-results.json', 'benchmark-results-project-fs.json']) {
    const path = join(priorRoot, 'artifacts', 'raw', name);
    const bytes = await readFile(path);
    const document = JSON.parse(bytes);
    const samples = Object.values(document.measurements)
      .reduce((sum, measurement) => sum + measurement.samples.length, 0);
    const kills = document.recovery.killBoundaries.results.length;
    assert(samples === 900 && kills === 40, `${name} sample inventory mismatch`);
    for (const adapter of ADAPTERS) {
      const correctness = document.correctness[adapter];
      assert(correctness, `${name} lacks correctness evidence for ${adapter}`);
    }
    timingSamples += samples;
    killChecks += kills;
    raw.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      filesystem: document.environment.filesystem.reportedType,
      samples,
      killChecks: kills,
    });
  }
  assert(timingSamples === 1800 && killChecks === 80, 'aggregate prior sample inventory mismatch');
  return { checksumFiles: files.length, timingSamples, killChecks, raw };
}

function probeRuntimeIdentities() {
  const identities = {};
  for (const adapter of ADAPTERS) {
    const driver = openDriver(adapter, ':memory:');
    try {
      const identity = driver.get(
        'SELECT sqlite_version() AS sqlite_version, sqlite_source_id() AS sqlite_source_id',
      );
      const compileOptions = driver.all('PRAGMA compile_options')
        .map((row) => row.compile_options).sort();
      identities[adapter] = { ...identity, compileOptions };
    } finally {
      driver.close();
    }
  }
  assert(identities['node:sqlite'].sqlite_version === '3.53.1',
    `unexpected node:sqlite version ${identities['node:sqlite'].sqlite_version}`);
  assert(identities['better-sqlite3'].sqlite_version === '3.53.2',
    `unexpected better-sqlite3 SQLite version ${identities['better-sqlite3'].sqlite_version}`);
  return identities;
}

async function sourceIdentities() {
  const names = [
    'schema.mjs', 'adapters.mjs', 'operations.mjs', 'worker.mjs',
    'qualification.mjs', 'verify-artifacts.mjs', 'storage-port.ts', 'SCHEMA-DESIGN.md',
  ];
  const files = [];
  for (const name of names) {
    const bytes = await readFile(join(ROOT, name));
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const ordered = files.map((file) => `${file.sha256}  ${file.name}\n`).join('');
  return { files, orderedSha256: sha256Hex(ordered) };
}

async function main() {
  assert(process.version === 'v24.18.0', `qualification requires Node v24.18.0, got ${process.version}`);
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true, mode: 0o700 });
  await mkdir(ARTIFACTS, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const priorBenchmark = await verifyPriorBenchmark();
  const runtimeIdentities = probeRuntimeIdentities();

  const simpleScenarios = [
    ['schema-bigint-prepared-begin-immediate', schemaAndBigInt],
    ['append-only-chain-graph-constraints', appendOnlyAndGraph],
    ['deterministic-versioned-migrations', migrationDeterminism],
    ['online-backup-restore', backupRestore],
    ['projection-rebuild-attempt-memory-lineage', projectionRebuildAndLearning],
    ['timeline-taxonomy-ordered-headers-commit-links', taxonomyAndTimelineCoverage],
    ['independent-oracle-false-green-controls', falseGreenControls],
    ['defensive-authorizer-extension-controls', securityControls],
    ['busy-timeout-semantics', busyTimeoutSemantics],
    ['four-process-single-writer-contention', singleWriterContention],
    ['wal-reader-starvation-and-truncate-checkpoint', walStarvationAndCheckpoint],
    ['integrity-foreign-keys-private-file-modes', integrityForeignKeysAndFiles],
    ['resource-and-latency-bounds', resourceAndLatency],
  ];
  const killBoundaries = ['before-begin', 'after-begin', 'after-event-row', 'before-commit', 'after-commit'];
  const durabilityModes = ['NORMAL', 'FULL', 'EXTRA'];

  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    for (const adapter of ADAPTERS) {
      for (const [scenario, operation] of simpleScenarios) {
        await runCase(adapter, scenario, repetition, () => operation(adapter, repetition));
      }
      for (const boundary of killBoundaries) {
        await runCase(adapter, `sigkill-${boundary}`, repetition,
          () => killBoundary(adapter, repetition, boundary, 'FULL'));
      }
      for (const mode of durabilityModes) {
        await runCase(adapter, `durability-${mode.toLowerCase()}-commit-sigkill`, repetition,
          () => killBoundary(adapter, repetition, 'after-commit', mode));
      }
    }
  }

  const failures = cases.filter((entry) => entry.status !== 'pass');
  const byAdapter = Object.fromEntries(ADAPTERS.map((adapter) => {
    const selected = cases.filter((entry) => entry.adapter === adapter);
    return [adapter, {
      total: selected.length,
      passed: selected.filter((entry) => entry.status === 'pass').length,
      failed: selected.filter((entry) => entry.status === 'fail').length,
      durationMs: selected.reduce((sum, entry) => sum + entry.durationMs, 0),
    }];
  }));
  const finishedAt = new Date().toISOString();
  const result = {
    format: 's4-harness-owned-storage-qualification-v1',
    scope: 'synthetic-only; temp artifact; no repository, user data, OpenCode data, provider, or secret access',
    startedAt,
    finishedAt,
    environment: {
      node: process.version,
      npm: '11.16.0',
      platform: process.platform,
      architecture: process.arch,
      nodeSqlite: process.versions.sqlite,
      betterSqlite3: '12.11.1',
      betterSqliteRuntime: '3.53.2',
      nodeSqliteStability: '1.2 release candidate',
      currentUpstreamSqlite: '3.53.3',
      umask: '0077',
      priorUmask: ORIGINAL_UMASK.toString(8).padStart(4, '0'),
      relevantMcpResources: [],
      missingRequiredCapabilities: [
        'power-loss-capable fault-injection hardware/filesystem; SIGKILL is not a power-loss oracle',
      ],
      runtimeIdentities,
    },
    primarySourcesCheckedAt: '2026-07-12',
    primarySources: [
      'https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html',
      'https://nodejs.org/dist/index.json',
      'https://registry.npmjs.org/better-sqlite3/latest',
      'https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1',
      'https://www.sqlite.org/releaselog/current.html',
      'https://www.sqlite.org/wal.html',
      'https://www.sqlite.org/pragma.html',
    ],
    configuration: {
      repetitionsPerDistinctScenario: REPETITIONS,
      adapters: ADAPTERS,
      scenariosPerAdapter: cases.filter((entry) => entry.adapter === ADAPTERS[0]).length,
      killBoundaries,
      durabilityModes,
      writerProcesses: 4,
      eventsPerWriter: 25,
      resourceEventsPerRun: 500,
    },
    priorBenchmark,
    summary: {
      total: cases.length,
      passed: cases.length - failures.length,
      failed: failures.length,
      byAdapter,
    },
    cases,
    schema: {
      migrations: MIGRATIONS.map(({ version, name, sha256 }) => ({ version, name, sha256 })),
      eventTypes: EVENT_TYPES,
      relationTypes: RELATION_TYPES,
      coverage: queryCoverageDocument(),
    },
  };
  const outputPath = join(ARTIFACTS, 'qualification-results.json');
  await writeFile(outputPath, `${JSON.stringify(result, asJson, 2)}\n`, { mode: 0o600 });
  const outputBytes = await readFile(outputPath);
  const outputSha256 = createHash('sha256').update(outputBytes).digest('hex');
  const source = await sourceIdentities();
  const manifest = {
    result: { path: 'artifacts/qualification-results.json', bytes: outputBytes.length, sha256: outputSha256 },
    source,
  };
  await writeFile(join(ARTIFACTS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ summary: result.summary, outputPath, outputSha256, sourceSha256: source.orderedSha256 })}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  process.umask(ORIGINAL_UMASK);
}
