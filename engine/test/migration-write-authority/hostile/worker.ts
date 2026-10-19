/**
 * MWA Tranche 4 — hostile qualification matrix: two-process worker.
 *
 * Forked by `harness.forkWorker` with the tsx loader (inherited from the
 * parent's `process.execArgv`). Reads the genesis setup + scenario from env,
 * constructs a real MWA authority (real backend, real facts, real effects),
 * performs the operation, and sends the result back via IPC (`process.send`).
 *
 * For crash scenarios (`acquire-crash`), the worker kills itself with SIGKILL
 * at the injected fault stage, leaving the backend/FS in an intermediate
 * state for the parent to recover.
 */

import { Buffer } from "node:buffer";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { createNodeSqliteMigrationBackend } from "../../../verification/core/coordination/migration-write-authority/backend-node-sqlite.ts";
import {
  createMigrationRepositoryFactsAdapter,
} from "../../../verification/core/coordination/migration-write-authority/repository-facts.ts";
import { createMigrationEffectAdapter } from "../../../verification/core/coordination/migration-write-authority/effects.ts";
import { createImmutableReceiptPort } from "../../../verification/core/coordination/migration-write-authority/receipts.ts";
import { createMigrationWriteAuthority } from "../../../verification/core/coordination/migration-write-authority/authority.ts";
import {
  MWA_AUTHORITY_CONTEXT,
  MWA_PROTOCOL_SCHEMA_VERSION,
  createLiveGrant,
  type AcquireInput,
  type ClockObservation,
  type FenceContext,
  type FenceInput,
  type MigrationAuthorityBackendPort,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
  type MigrationEffectPort,
  type MigrationResource,
  type ProcessIdentity,
  type RecoverInput,
  type ReleaseInput,
  type RepositoryBinding,
  type TargetState,
} from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import type { MigrationWriteAuthorityGenesisRecord } from "../../../verification/core/coordination/migration-write-authority/genesis.ts";

import {
  CLOSED_ENV, CONFIG_OVERRIDES, FACTS_CONFIG, GIT_EXECUTABLE, GIT_IDENTITY,
  REGISTRY_ID, makeActor, makeBase, nextEffectId, nextIdempotencyKey, nextRequestId,
  seedRequestCounter,
} from "./harness.ts";

// ---------------------------------------------------------------------------
// Read scenario from env
// ---------------------------------------------------------------------------

type SetupEnv = Readonly<{
  authorityRootPath: string;
  dbPath: string;
  genesisRecord: MigrationWriteAuthorityGenesisRecord;
  rootPolicy: MigrationAuthorityRootPolicy;
  config: MigrationAuthorityConfig;
  repoBinding: RepositoryBinding;
}>;

type ScenarioEnv = Readonly<{
  operation: "acquire" | "acquire-write" | "acquire-crash" | "acquire-release" | "heartbeat" | "recover" | "inspect-then-acquire";
  resources: readonly MigrationResource[];
  resourcePathMap?: Readonly<Record<string, string>>;
  worktreePath: string;
  crashStage?: string;
  recovery?: Readonly<{ leaseId: string; generation: string; fenceIdentity: string; recoveryGeneration: string; supersedesGeneration: string; supersedesFenceIdentity: string }>;
  leaseEvidence?: Readonly<{ leaseId: string; generation: string; fenceIdentity: string; state: string; receiptAuthority: string }>;
  clockPid?: number;
}>;

function readEnv(): { setup: SetupEnv; scenario: ScenarioEnv } {
  const setupRaw = process.env.MWA_HOSTILE_SETUP;
  const scenarioRaw = process.env.MWA_HOSTILE_SCENARIO;
  if (!setupRaw || !scenarioRaw) throw new Error("MWA_HOSTILE_SETUP/MWA_HOSTILE_SCENARIO env vars required");
  return { setup: JSON.parse(setupRaw) as SetupEnv, scenario: JSON.parse(scenarioRaw) as ScenarioEnv };
}

// ---------------------------------------------------------------------------
// Controllable clock for the worker
// ---------------------------------------------------------------------------

const PID_DIR: TargetState = Object.freeze({ kind: "absent", parentIdentity: Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" }), entryName: "x" });

function makeClock(pid: number, startNs = 1n): ClockObservation {
  const proc: ProcessIdentity = Object.freeze({ pid, startTimeMs: "1", executableIdentity: sha256("mwa-hostile-exec") });
  return Object.freeze({ monotonicNanoseconds: startNs.toString(10), wallClockIso: new Date().toISOString(), processIdentity: proc });
}

// ---------------------------------------------------------------------------
// Construct the authority (real backend/facts/effects; crash wrappers)
// ---------------------------------------------------------------------------

type AuthorityBundle = Readonly<{
  authority: ReturnType<typeof createMigrationWriteAuthority>;
  backend: MigrationAuthorityBackendPort;
  effects: MigrationEffectPort;
  close: () => void;
}>;

function constructAuthority(setup: SetupEnv, scenario: ScenarioEnv): AuthorityBundle {
  const resourcePathMap = scenario.resourcePathMap ?? {};
  const resolvePhysicalPath = (resourceId: string): string => {
    const rel = resourcePathMap[resourceId];
    return join(scenario.worktreePath, rel ?? resourceId.replace(/[.]/g, "/"));
  };
  const effects = createMigrationEffectAdapter({
    gitExecutablePath: GIT_EXECUTABLE,
    gitIdentity: GIT_IDENTITY,
    worktreeRoot: scenario.worktreePath,
    resolvePhysicalPath,
    config: { executablePath: GIT_EXECUTABLE, processEnvironment: CLOSED_ENV, configurationOverrides: CONFIG_OVERRIDES },
  });
  const crashStage = scenario.crashStage;
  const wrappedEffects = crashStage ? makeCrashEffects(effects, crashStage) : effects;
  let backend: MigrationAuthorityBackendPort = createNodeSqliteMigrationBackend({
    dbPath: setup.dbPath,
    rootPolicy: setup.rootPolicy,
    config: setup.config,
    genesisRecord: setup.genesisRecord,
  });
  if (crashStage && crashStage.startsWith("backend.")) {
    backend = makeCrashBackend(backend, crashStage);
  }
  const facts = createMigrationRepositoryFactsAdapter({ repositoryLocator: scenario.worktreePath, config: FACTS_CONFIG });
  const receipts = createImmutableReceiptPort({ authorityRootPath: setup.authorityRootPath });
  const events = Object.freeze({
    appendStart: () => Object.freeze({ receiptHash: sha256("r"), cursor: sha256("r") }),
    appendTransition: () => Object.freeze({ receiptHash: sha256("r"), cursor: sha256("r") }),
    appendEffectIntent: () => Object.freeze({ receiptHash: sha256("r"), cursor: sha256("r") }),
    appendObservation: () => Object.freeze({ receiptHash: sha256("r"), cursor: sha256("r") }),
    appendTerminal: () => Object.freeze({ receiptHash: sha256("r"), cursor: sha256("r") }),
  });
  const clock = Object.freeze({
    monotonicNanoseconds: () => 1n,
    wallClockIso: () => "2026-01-01T00:00:00.000Z",
    processIdentity: () => Object.freeze({ pid: scenario.clockPid ?? process.pid, startTimeMs: "1", executableIdentity: sha256("mwa-hostile-exec") }),
    isAlive: () => Object.freeze({ observed: "alive" as const, observedWallIso: "2026-01-01T00:00:00.000Z", evidenceHash: sha256("r") }),
    observe: () => makeClock(scenario.clockPid ?? process.pid),
  });
  const authority = createMigrationWriteAuthority({
    backend, facts, effects: wrappedEffects, events: events as never, clock: clock as never, receipts,
    config: setup.config, rootPolicy: setup.rootPolicy,
  });
  return { authority, backend, effects: wrappedEffects, close: () => { try { backend.close(); } catch { /* */ } } };
}

function makeCrashEffects(base: MigrationEffectPort, crashStage: string): MigrationEffectPort {
  const kill = (): never => {
    try { process.kill(process.pid, "SIGKILL"); } catch { /* */ }
    process.exit(137);
  };
  const wrap = <K extends keyof MigrationEffectPort>(method: K) =>
    (input: Parameters<MigrationEffectPort[K]>[0]): ReturnType<MigrationEffectPort[K]> => {
      const stageName = `effects.${String(method)}`;
      if (crashStage === stageName || crashStage === `${stageName}.before`) kill();
      const result = (base[method] as (...a: unknown[]) => unknown)(input as unknown);
      if (crashStage === `${stageName}.after`) kill();
      return result as ReturnType<MigrationEffectPort[K]>;
    };
  return Object.freeze({
    createFileExclusive: wrap("createFileExclusive"),
    replaceFile: wrap("replaceFile"),
    removeFile: wrap("removeFile"),
    syncDirectory: wrap("syncDirectory"),
    gitWriteTree: wrap("gitWriteTree"),
    gitCommitTree: wrap("gitCommitTree"),
    gitMktagStrict: wrap("gitMktagStrict"),
    gitUpdateRefTransaction: wrap("gitUpdateRefTransaction"),
    rereadObject: wrap("rereadObject"),
    rereadRef: wrap("rereadRef"),
  }) as MigrationEffectPort;
}

function makeCrashBackend(base: MigrationAuthorityBackendPort, crashStage: string): MigrationAuthorityBackendPort {
  const kill = (): never => {
    try { process.kill(process.pid, "SIGKILL"); } catch { /* */ }
    process.exit(137);
  };
  const wrapSimple = <K extends keyof MigrationAuthorityBackendPort>(method: K) =>
    (input: Parameters<MigrationAuthorityBackendPort[K]>[0]): ReturnType<MigrationAuthorityBackendPort[K]> => {
      if (crashStage === `backend.${String(method)}.before`) kill();
      const result = (base[method] as (...a: unknown[]) => unknown)(input as unknown);
      if (crashStage === `backend.${String(method)}.after`) kill();
      return result as ReturnType<MigrationAuthorityBackendPort[K]>;
    };
  return Object.freeze({
    acquire: wrapSimple("acquire"),
    reserve: wrapSimple("reserve"),
    heartbeat: wrapSimple("heartbeat"),
    checkpoint: wrapSimple("checkpoint"),
    fence: wrapSimple("fence"),
    compareAndCommit: wrapSimple("compareAndCommit"),
    release: wrapSimple("release"),
    inspect: wrapSimple("inspect"),
    recover: wrapSimple("recover"),
    open: base.open.bind(base),
    close: base.close.bind(base),
  }) as MigrationAuthorityBackendPort;
}

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Acquire input builder
// ---------------------------------------------------------------------------

function buildAcquireInput(setup: SetupEnv, scenario: ScenarioEnv, pid: number): AcquireInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "acquire",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
    actor: makeActor(`${pid}-attempt`), planIdentity: sha256("mwa-hostile-plan"), base: makeBase(),
    resourceRegistryIdentity: REGISTRY_ID, requestedTtlMs: 60_000, resources: scenario.resources,
    clock: makeClock(pid),
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function runOperation(setup: SetupEnv, scenario: ScenarioEnv): Promise<unknown> {
  const pid = scenario.clockPid ?? process.pid;
  const bundle = constructAuthority(setup, scenario);
  const { authority, effects, close } = bundle;
  try {
    switch (scenario.operation) {
      case "acquire": {
        return await authority.acquire(buildAcquireInput(setup, scenario, pid));
      }
      case "acquire-release": {
        const acq = await authority.acquire(buildAcquireInput(setup, scenario, pid));
        if (acq.outcome !== "accepted") return { acquire: acq };
        const rel = authority.release(Object.freeze({
          schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "release",
          requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
          authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
          disposition: "completed", journalCursor: acq.journalCursor,
        } as ReleaseInput));
        return { acquire: acq, release: rel };
      }
      case "acquire-write": {
        const acq = await authority.acquire(buildAcquireInput(setup, scenario, pid));
        if (acq.outcome !== "accepted") return { acquire: acq };
        const writeRes = scenario.resources.find((r) => r.access === "write") ?? scenario.resources[0]!;
        const resourceId = writeRes.resourceId;
        const effectId = nextEffectId(1);
        const fenceInput: FenceInput = Object.freeze({
          schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "fence",
          requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
          authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
          effectId, effectKind: "filesystem-create", resourceId,
          expectedState: PID_DIR,
          intendedState: Object.freeze({ kind: "file", identity: Object.freeze({ device: "1", inode: "2", mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }), byteLength: 6, sha256: sha256("hello\n") }),
          base: makeBase(), journalCursor: acq.journalCursor,
        });
        const fence = authority.fence(fenceInput);
        if (fence.outcome !== "accepted") return { acquire: acq, fence };
        // Perform the FS effect via the effects adapter.
        const fenceCtx: FenceContext = Object.freeze({ leaseId: fence.fenceToken.leaseId, generation: fence.fenceToken.generation, fenceIdentity: fence.fenceToken.fenceIdentity, effectId, resourceId });
        const effectObs = effects.createFileExclusive(Object.freeze({
          grant: acq.liveGrant, fence: fenceCtx, resourceId, intendedBytes: Buffer.from("hello\n"), intendedMode: 0o600,
        }));
        return { acquire: acq, fence, effect: effectObs };
      }
      case "acquire-crash": {
        // Acquire then crash at the injected stage (crash wrapper handles it).
        return await authority.acquire(buildAcquireInput(setup, scenario, pid));
      }
      case "heartbeat": {
        const acq = await authority.acquire(buildAcquireInput(setup, scenario, pid));
        if (acq.outcome !== "accepted") return { acquire: acq };
        const hb = authority.heartbeat(Object.freeze({
          schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "heartbeat",
          requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
          authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence: acq.leaseEvidence, liveGrant: acq.liveGrant,
          requestedTtlMs: 120_000, clock: makeClock(pid, 2n),
        }));
        return { acquire: acq, heartbeat: hb };
      }
      case "recover": {
        if (!scenario.recovery || !scenario.leaseEvidence) throw new Error("recovery scenario requires recovery + leaseEvidence");
        const rec = scenario.recovery;
        const grant = createLiveGrant({
          leaseId: rec.leaseId, generation: rec.generation, fenceIdentity: rec.fenceIdentity,
          repositoryIdentity: setup.repoBinding.repositoryIdentity, resourceRegistryIdentity: REGISTRY_ID,
          processIdentity: sha256("mwa-hostile-exec"),
        });
        const leaseEvidence = Object.freeze({
          leaseId: rec.leaseId, generation: rec.generation, fenceIdentity: rec.fenceIdentity,
          state: scenario.leaseEvidence.state as "active" | "expired", receiptAuthority: "evidence-only-never-authority",
        });
        const recoverInput: RecoverInput = Object.freeze({
          schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "recover",
          requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
          authorityContext: MWA_AUTHORITY_CONTEXT, leaseEvidence, liveGrant: grant,
          journalIdentity: sha256("journal"), observationIdentity: sha256("obs"),
          directionPreference: "next",
          clock: makeClock(pid, 999_000_000_000n),
          recoveryFence: Object.freeze({
            generation: rec.recoveryGeneration, fenceIdentity: sha256("recovery-fence"),
            supersedesGeneration: rec.supersedesGeneration, supersedesFenceIdentity: rec.supersedesFenceIdentity,
          }),
        });
        return authority.recover(recoverInput);
      }
      case "inspect-then-acquire": {
        const inspectResult = authority.inspect(Object.freeze({
          schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "inspect",
          requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: setup.repoBinding,
          leaseId: scenario.recovery?.leaseId ?? "00000000-0000-4000-8000-000000000000",
        }));
        const acq = await authority.acquire(buildAcquireInput(setup, scenario, pid));
        return { inspect: inspectResult, acquire: acq };
      }
      default:
        throw new Error(`unknown operation: ${scenario.operation}`);
    }
  } finally {
    close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { setup, scenario } = readEnv();
  // Seed the request/idempotency counter with the clockPid so distinct
  // children generate disjoint keys (avoids idempotency-conflict on the
  // shared backend DB).
  seedRequestCounter(scenario.clockPid ?? process.pid);
  try {
    const result = await runOperation(setup, scenario);
    if (process.send) process.send({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.send) process.send({ ok: false, error: message, code: (error as { code?: string })?.code });
  }
  // Flush IPC, then exit.
  setTimeout(() => process.exit(0), 50);
}

void main();
