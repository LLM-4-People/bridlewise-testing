/**
 * MWA Tranche 4 — hostile qualification matrix: shared test harness.
 *
 * Provides the disposable-repo factory, genesis helper, fault-injectable port
 * wrappers, a two-process runner (real `child_process.fork` with the tsx
 * loader), an independent oracle that re-reads the raw journal/backend state
 * and recomputes the chain, a SIGKILL helper, and typed assertion utilities.
 *
 * Design authority: MWA-DESIGN §7. Every family uses disposable repos/DBs
 * under `os.tmpdir`, real git, the real genesis tool, the real backend, the
 * real repository-facts adapter, the real effects adapter, and injectable
 * mock clock/events for deterministic fault injection. No `Math.random` for
 * fault seeds (sequential counters + crypto.randomUUID only).
 */

import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { sha256 } from "../../../src/kernel/integrity.ts";
import { computeChainHash, ZERO_CHAIN_HASH } from "../../../src/timeline/ledger-primitives.ts";
import { createMigrationWriteAuthorityGenesis } from "../../../scripts/tooling/migration-write-authority-genesis.ts";
import { createNodeSqliteMigrationBackend, MWA_DEFAULT_CONFIG, MWA_DEFAULT_ROOT_POLICY } from "../../../verification/core/coordination/migration-write-authority/backend-node-sqlite.ts";
import {
  createMigrationRepositoryFactsAdapter,
  type MigrationRepositoryFactsConfig,
} from "../../../verification/core/coordination/migration-write-authority/repository-facts.ts";
import { createMigrationEffectAdapter } from "../../../verification/core/coordination/migration-write-authority/effects.ts";
import { createImmutableReceiptPort } from "../../../verification/core/coordination/migration-write-authority/receipts.ts";
import { createMigrationWriteAuthority } from "../../../verification/core/coordination/migration-write-authority/authority.ts";
import {
  createLiveGrant,
  MWA_LEDGER_DOMAIN,
  MWA_PROTOCOL_SCHEMA_VERSION,
  MWA_RECEIPT_AUTHORITY,
  type AcquireInput,
  type Actor,
  type BackendAcquireResult,
  type BackendError,
  type BackendFenceResult,
  type BackendInspectResult,
  type BackendResult,
  type BaseIdentity,
  type ClockObservation,
  type LeaseEvidence,
  type LiveGrant,
  type MigrationAuthorityBackendPort,
  type MigrationAuthorityConfig,
  type MigrationAuthorityRootPolicy,
  type MigrationAttemptEventSink,
  type MigrationClockProcessPort,
  type MigrationEffectPort,
  type MigrationResource,
  type PathIdentity,
  type ProcessIdentity,
  type ProcessLivenessEvidence,
  type RepositoryBinding,
  type TargetState,
} from "../../../verification/core/coordination/migration-write-authority/contracts.ts";
import type { MigrationWriteAuthorityGenesisRecord } from "../../../verification/core/coordination/migration-write-authority/genesis.ts";
import { createTempDir } from "../../support/temp-dir.ts";

// ---------------------------------------------------------------------------
// Closed git environment (mirrors ROOT_POLICY.verification.candidateFormat.gitIdentity)
// ---------------------------------------------------------------------------

export const CLOSED_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_ASKPASS: "/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EXTERNAL_DIFF: "",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/nonexistent/bridlewise-verification-home",
  LANG: "C",
  LC_ALL: "C",
  PAGER: "cat",
  PATH: "/usr/bin:/bin",
  TZ: "UTC",
  GIT_AUTHOR_NAME: "Code Harness",
  GIT_AUTHOR_EMAIL: "harness@example.invalid",
  GIT_COMMITTER_NAME: "Code Harness",
  GIT_COMMITTER_EMAIL: "harness@example.invalid",
});

export const CONFIG_OVERRIDES: readonly string[] = Object.freeze([
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.pager=cat",
  "core.untrackedCache=false",
  "diff.external=",
  "diff.trustExitCode=false",
  "filter.lfs.clean=",
  "filter.lfs.process=",
  "filter.lfs.required=false",
  "filter.lfs.smudge=",
  "interactive.diffFilter=",
  "pager.status=false",
]);

export const GIT_EXECUTABLE = "/usr/bin/git";
export const GIT_IDENTITY = Object.freeze({ name: "Code Harness", email: "harness@example.invalid" });

export const FACTS_CONFIG: MigrationRepositoryFactsConfig = Object.freeze({
  executablePath: GIT_EXECUTABLE,
  processEnvironment: CLOSED_ENV,
  configurationOverrides: CONFIG_OVERRIDES,
});

export const REGISTRY_ID = sha256("mwa-hostile-registry-v1");
export const NORMALIZER_ID = sha256("mwa-hostile-normalizer-v1");

// ---------------------------------------------------------------------------
// Disposable repo factory
// ---------------------------------------------------------------------------

export type DisposableRepo = Readonly<{
  baseDir: string;
  commonDir: string;
  worktree1: string;
  worktree2: string;
  repoBinding: RepositoryBinding;
  cleanup: () => void;
}>;

function gitCmd(args: readonly string[], cwd: string): string {
  const result = spawnSync(GIT_EXECUTABLE, ["-C", cwd, ...args], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Creates a disposable repository with a main worktree and a linked worktree,
 * both sharing the same git common directory (so they share one MWA authority).
 * Layout: `<tmpdir>/mwa-hostile-<uuid>/{main,wt2}`. Cleanup is unconditional.
 */
export async function createDisposableRepo(): Promise<DisposableRepo> {
  const baseDir = createTempDir(`mwa-hostile-${randomUUID().slice(0, 8)}`);
  const worktree1 = join(baseDir, "main");
  const worktree2 = join(baseDir, "wt2");
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      spawnSync(GIT_EXECUTABLE, ["-C", worktree1, "worktree", "remove", "--force", worktree2], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
  try {
    spawnSync(GIT_EXECUTABLE, ["init", "--initial-branch=main", worktree1], { env: CLOSED_ENV as Record<string, string>, encoding: "utf8" });
    writeFileSync(join(worktree1, "baseline.txt"), "baseline\n");
    gitCmd(["add", "baseline.txt"], worktree1);
    gitCmd(["commit", "-m", "baseline"], worktree1);
    gitCmd(["worktree", "add", "-b", "wt2-branch", worktree2], worktree1);
    const commonDir = gitCmd(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree1);
    if (!existsSync(commonDir)) throw new Error("common dir does not exist");
    const factsAdapter = createMigrationRepositoryFactsAdapter({ repositoryLocator: worktree1, config: FACTS_CONFIG });
    const facts = await factsAdapter.acquire();
    return Object.freeze({ baseDir, commonDir, worktree1, worktree2, repoBinding: facts.repositoryBinding, cleanup });
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Genesis helper: run the real genesis tool on a repo
// ---------------------------------------------------------------------------

export type MwaSetup = Readonly<{
  authorityRootPath: string;
  dbPath: string;
  genesisRecord: MigrationWriteAuthorityGenesisRecord;
  rootPolicy: MigrationAuthorityRootPolicy;
  config: MigrationAuthorityConfig;
  repoBinding: RepositoryBinding;
  worktree1: string;
  worktree2: string;
  cleanup: () => void;
}>;

/**
 * Runs the real genesis tool on the repo's main worktree, then reads the
 * genesis record back from the immutable receipt so the authority can be
 * reconstructed by any process (parent or child).
 */
export async function setupMwaForRepo(repo: DisposableRepo, overrides: Readonly<{ authorityRootName?: string }> = {}): Promise<MwaSetup> {
  const genesisResult = await createMigrationWriteAuthorityGenesis({
    repositoryLocator: repo.worktree1,
    authorityRootName: overrides.authorityRootName ?? `mwa-hostile-${randomUUID().slice(0, 8)}`,
  });
  if (genesisResult.outcome !== "created") {
    throw new Error(`genesis failed: ${genesisResult.error.code}: ${genesisResult.error.message}`);
  }
  // Read the genesis record back from the receipt (content-addressed).
  const receiptPath = join(genesisResult.authorityRootPath, "receipts", "sha256", `${genesisResult.receiptCursor}.bin`);
  const receiptBytes = readFileSync(receiptPath, "utf8").trimEnd();
  const genesisRecord = JSON.parse(receiptBytes) as MigrationWriteAuthorityGenesisRecord;
  return Object.freeze({
    authorityRootPath: genesisResult.authorityRootPath,
    dbPath: join(genesisResult.authorityRootPath, "authority.db"),
    genesisRecord,
    rootPolicy: MWA_DEFAULT_ROOT_POLICY,
    config: MWA_DEFAULT_CONFIG,
    repoBinding: repo.repoBinding,
    worktree1: repo.worktree1,
    worktree2: repo.worktree2,
    cleanup: repo.cleanup,
  });
}

// ---------------------------------------------------------------------------
// Controllable clock (mock) — deterministic, no Math.random
// ---------------------------------------------------------------------------

export type ControllableClock = MigrationClockProcessPort & {
  readonly advance: (ns: bigint) => void;
  readonly setWallClock: (iso: string) => void;
  readonly setProcessIdentity: (pid: ProcessIdentity) => void;
  readonly regressMonotonic: (ns: bigint) => void;
  readonly setLivenessObserved: (observed: "alive" | "dead" | "ambiguous-after-restart") => void;
  readonly snapshot: () => ClockObservation;
};

export function createControllableClock(seed: Readonly<{ pid?: number; executableIdentity?: string }> = {}): ControllableClock {
  let monotonic = 0n;
  let wall = "2026-01-01T00:00:00.000Z";
  let procIdentity: ProcessIdentity = Object.freeze({
    pid: seed.pid ?? process.pid,
    startTimeMs: "1",
    executableIdentity: seed.executableIdentity ?? sha256("mwa-hostile-exec"),
  });
  let livenessOverride: "alive" | "dead" | "ambiguous-after-restart" | undefined = undefined;
  function snapshot(): ClockObservation {
    return Object.freeze({
      monotonicNanoseconds: monotonic.toString(10),
      wallClockIso: wall,
      processIdentity: procIdentity,
    });
  }
  return Object.freeze({
    monotonicNanoseconds: () => monotonic,
    wallClockIso: () => wall,
    processIdentity: () => procIdentity,
    isAlive: (target: ProcessIdentity): ProcessLivenessEvidence =>
      Object.freeze({
        observed: livenessOverride ?? (target.pid === procIdentity.pid ? "alive" : "ambiguous-after-restart"),
        observedWallIso: wall,
        evidenceHash: sha256(`${target.pid}-${procIdentity.pid}`),
      }),
    observe: snapshot,
    advance: (ns: bigint) => { monotonic += ns; },
    setWallClock: (iso: string) => { wall = iso; },
    setProcessIdentity: (pid: ProcessIdentity) => { procIdentity = pid; },
    regressMonotonic: (ns: bigint) => { monotonic = ns; },
    setLivenessObserved: (observed: "alive" | "dead" | "ambiguous-after-restart") => { livenessOverride = observed; },
    snapshot,
  }) as ControllableClock;
}

// ---------------------------------------------------------------------------
// Collecting event sink (mock)
// ---------------------------------------------------------------------------

export type CollectingEventSink = MigrationAttemptEventSink & {
  readonly events: readonly Readonly<{ kind: string; event: unknown }>[];
  readonly receipt: () => Readonly<{ receiptHash: string; cursor: string }>;
};

export function createCollectingEventSink(): CollectingEventSink {
  const events: { kind: string; event: unknown }[] = [];
  const receipt = Object.freeze({ receiptHash: sha256("mwa-hostile-receipt"), cursor: sha256("mwa-hostile-cursor") });
  return Object.freeze({
    appendStart: (e: unknown) => { events.push({ kind: "start", event: e }); return receipt; },
    appendTransition: (e: unknown) => { events.push({ kind: "transition", event: e }); return receipt; },
    appendEffectIntent: (e: unknown) => { events.push({ kind: "intent", event: e }); return receipt; },
    appendObservation: (e: unknown) => { events.push({ kind: "observation", event: e }); return receipt; },
    appendTerminal: (e: unknown) => { events.push({ kind: "terminal", event: e }); return receipt; },
    get events() { return Object.freeze([...events]) as readonly Readonly<{ kind: string; event: unknown }>[]; },
    receipt: () => receipt,
  }) as CollectingEventSink;
}

// ---------------------------------------------------------------------------
// Resource + request builders
// ---------------------------------------------------------------------------

const PID_DIR: PathIdentity = Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" });

export function absentState(entryName = "x"): TargetState {
  return Object.freeze({ kind: "absent", parentIdentity: PID_DIR, entryName });
}

export function physical(resourceId: string, access: "read" | "write", path: string): MigrationResource {
  return Object.freeze({
    kind: "physical-path", resourceId, access, resolution: "resolved",
    registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId],
    path, portableCollisionKey: path, observedState: absentState(path.split("/").pop() ?? "x"),
  });
}

export function semantic(resourceId: string, access: "read" | "write", ownerId: string, ancestors: readonly string[] = []): MigrationResource {
  return Object.freeze({
    kind: "semantic-owner", resourceId, access, resolution: "resolved",
    registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId],
    ownerKind: "module", ownerId, ancestorOwnerIds: ancestors,
  });
}

export function generatedOutput(resourceId: string, access: "read" | "write", generatorId: string, outputPath: string, authorityKey: string): MigrationResource {
  return Object.freeze({
    kind: "generated-output", resourceId, access, resolution: "resolved",
    registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId],
    generatorId, outputPath, authorityKey,
  });
}

export function gitRef(resourceId: string, access: "read" | "write", refName: string, refFamilyId: string): MigrationResource {
  return Object.freeze({
    kind: "git-ref", resourceId, access, resolution: "resolved",
    registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId],
    refName, refFamilyId, expectedOld: null, intendedObjectKind: "commit" as const,
  });
}

export function packageSurface(resourceId: string, access: "read" | "write", surfaceKind: "export" | "script" | "compiler" | "dependency" | "executable-registry", surfaceId: string): MigrationResource {
  return Object.freeze({
    kind: "package-surface", resourceId, access, resolution: "resolved",
    registryIdentity: REGISTRY_ID, normalizerIdentity: NORMALIZER_ID, aliasClosure: [resourceId],
    surfaceKind, surfaceId,
  });
}

let reqCounter = 0;
export function nextIdempotencyKey(): string { reqCounter += 1; return sha256(`mwa-hostile-idem-${reqCounter}`); }
export function nextRequestId(): string {
  reqCounter += 1;
  const h = sha256(`mwa-hostile-req-${reqCounter}`).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function nextEffectId(n: number): string {
  return `0000000${n}-0000-4000-8000-${String(n).padStart(12, "0")}`.slice(-36);
}
/**
 * Seeds the request/idempotency counter so distinct processes (forked
 * children) generate disjoint keys. Each child must call this with a unique
 * seed (e.g. its `clockPid`) before its first acquire to avoid
 * `idempotency-conflict` on the shared backend DB.
 */
export function seedRequestCounter(seed: number): void { reqCounter = seed * 1000; }

export function makeActor(attemptId = "11111111-1111-4111-8111-111111111111"): Actor {
  return Object.freeze({ actorId: "agent-1", taskId: "task-1", subtaskId: "sub-1", attemptId, processIdentity: sha256("mwa-hostile-proc") });
}

export function makeBase(overrides: Partial<BaseIdentity> = {}): BaseIdentity {
  return Object.freeze({
    commit: "0".repeat(40), tree: "0".repeat(40),
    index: sha256("mwa-hostile-index"), candidate: sha256("mwa-hostile-candidate"),
    configuration: sha256("mwa-hostile-config"), policy: sha256("mwa-hostile-policy"),
    capabilities: sha256("mwa-hostile-caps"),
    ...overrides,
  });
}

export function makeAcquireInput(
  repo: RepositoryBinding,
  resources: readonly MigrationResource[],
  clock: ClockObservation,
  overrides: Partial<AcquireInput> = {},
): AcquireInput {
  return Object.freeze({
    schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION, messageKind: "request", operation: "acquire",
    requestId: nextRequestId(), idempotencyKey: nextIdempotencyKey(), repository: repo,
    actor: makeActor(), planIdentity: sha256("mwa-hostile-plan"), base: makeBase(),
    resourceRegistryIdentity: REGISTRY_ID, requestedTtlMs: 60_000, resources, clock,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Authority construction (real backend + facts + effects, injectable clock/events)
// ---------------------------------------------------------------------------

export type AuthorityHandle = Readonly<{
  authority: ReturnType<typeof createMigrationWriteAuthority>;
  backend: MigrationAuthorityBackendPort;
  clock: ControllableClock;
  events: CollectingEventSink;
  effects: MigrationEffectPort;
  close: () => void;
}>;

/**
 * Constructs a real MWA authority from a genesis setup, bound to a specific
 * worktree. Uses the real backend, real facts, real effects adapter; injectable
 * clock and events for fault injection. The `resolvePhysicalPath` maps a
 * resource id to an absolute path under the worktree root via a provided map.
 */
export function createAuthorityHandle(
  setup: MwaSetup,
  worktreePath: string,
  overrides: Readonly<{
    clock?: ControllableClock;
    events?: CollectingEventSink;
    effects?: MigrationEffectPort;
    resourcePathMap?: Readonly<Record<string, string>>;
    backendOverrides?: Partial<MigrationAuthorityBackendPort>;
  }> = {},
): AuthorityHandle {
  const clock = overrides.clock ?? createControllableClock();
  const events = overrides.events ?? createCollectingEventSink();
  const resourcePathMap = overrides.resourcePathMap ?? {};
  const resolvePhysicalPath = (resourceId: string): string => {
    const rel = resourcePathMap[resourceId];
    if (rel === undefined) return join(worktreePath, resourceId.replace(/[.]/g, "/"));
    return join(worktreePath, rel);
  };
  let effects: MigrationEffectPort;
  if (overrides.effects !== undefined) {
    effects = overrides.effects;
  } else {
    effects = createMigrationEffectAdapter({
      gitExecutablePath: GIT_EXECUTABLE,
      gitIdentity: GIT_IDENTITY,
      worktreeRoot: worktreePath,
      resolvePhysicalPath,
      config: { executablePath: GIT_EXECUTABLE, processEnvironment: CLOSED_ENV, configurationOverrides: CONFIG_OVERRIDES },
    });
  }
  let backend: MigrationAuthorityBackendPort = createNodeSqliteMigrationBackend({
    dbPath: setup.dbPath,
    rootPolicy: setup.rootPolicy,
    config: setup.config,
    genesisRecord: setup.genesisRecord,
  });
  if (overrides.backendOverrides) {
    backend = wrapBackend(backend, overrides.backendOverrides);
  }
  const facts = createMigrationRepositoryFactsAdapter({ repositoryLocator: worktreePath, config: FACTS_CONFIG });
  const receipts = createImmutableReceiptPort({ authorityRootPath: setup.authorityRootPath });
  const authority = createMigrationWriteAuthority({
    backend, facts, effects, events, clock, receipts,
    config: setup.config, rootPolicy: setup.rootPolicy,
  });
  const close = (): void => { try { backend.close(); } catch { /* best-effort */ } };
  return Object.freeze({ authority, backend, clock, events, effects, close });
}

function wrapBackend(base: MigrationAuthorityBackendPort, overrides: Partial<MigrationAuthorityBackendPort>): MigrationAuthorityBackendPort {
  return Object.freeze({ ...base, ...overrides }) as MigrationAuthorityBackendPort;
}

// ---------------------------------------------------------------------------
// Fault injection: wrap port methods with before/afterStage hooks
// ---------------------------------------------------------------------------

export type FaultStage = Readonly<{ port: "backend" | "facts" | "effects" | "clock"; method: string; call: number }>;

export type FaultInjection = Readonly<{
  before?: (stage: FaultStage) => BackendError | void;
  after?: (stage: FaultStage, result: unknown) => void;
}>;

/**
 * Wraps each backend method so `before` is invoked before the call (and may
 * return a `BackendError` to short-circuit with a typed denial) and `after`
 * observes the result. Hooks may NOT skip validation or mint authority: a
 * `before` that returns a `BackendError` produces a `denied` result with
 * `partialReservationRetained: false`, never an `accepted` result.
 */
export function createFaultInjectableBackend(base: MigrationAuthorityBackendPort, injection: FaultInjection): MigrationAuthorityBackendPort {
  const counters: Record<string, number> = {};
  function callCount(method: string): number { counters[method] = (counters[method] ?? 0) + 1; return counters[method]; }
  function deniedResult(error: BackendError): BackendResult {
    return Object.freeze({ outcome: "denied", error, partialReservationRetained: false });
  }
  function wrapAcquire(method: "acquire"): (i: AcquireInput) => BackendAcquireResult {
    return (input: AcquireInput): BackendAcquireResult => {
      const stage: FaultStage = { port: "backend", method, call: callCount(method) };
      const injected = injection.before?.(stage);
      if (injected !== undefined) return Object.freeze({ outcome: "denied", error: injected, partialReservationRetained: false }) as BackendAcquireResult;
      const result = base[method](input);
      injection.after?.(stage, result);
      return result;
    };
  }
  function wrapFence(method: "fence"): (i: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").FenceInput) => BackendFenceResult {
    return (input): BackendFenceResult => {
      const stage: FaultStage = { port: "backend", method, call: callCount(method) };
      const injected = injection.before?.(stage);
      if (injected !== undefined) return Object.freeze({ outcome: "denied", error: injected, partialReservationRetained: false }) as BackendFenceResult;
      const result = base[method](input);
      injection.after?.(stage, result);
      return result;
    };
  }
  function wrapInspect(method: "inspect"): (i: import("../../../verification/core/coordination/migration-write-authority/contracts.ts").InspectInput) => BackendInspectResult {
    return (input): BackendInspectResult => {
      const stage: FaultStage = { port: "backend", method, call: callCount(method) };
      const injected = injection.before?.(stage);
      if (injected !== undefined) return Object.freeze({ outcome: "denied", error: injected, partialReservationRetained: false }) as BackendInspectResult;
      const result = base[method](input);
      injection.after?.(stage, result);
      return result;
    };
  }
  function wrapSimple<K extends "reserve" | "heartbeat" | "checkpoint" | "compareAndCommit" | "release" | "recover">(
    method: K,
  ): (input: Parameters<MigrationAuthorityBackendPort[K]>[0]) => BackendResult {
    return (input: Parameters<MigrationAuthorityBackendPort[K]>[0]): BackendResult => {
      const stage: FaultStage = { port: "backend", method, call: callCount(method) };
      const injected = injection.before?.(stage);
      if (injected !== undefined) return deniedResult(injected);
      const result = (base[method] as (i: Parameters<MigrationAuthorityBackendPort[K]>[0]) => BackendResult)(input);
      injection.after?.(stage, result);
      return result;
    };
  }
  return Object.freeze({
    acquire: wrapAcquire("acquire"),
    reserve: wrapSimple("reserve"),
    heartbeat: wrapSimple("heartbeat"),
    checkpoint: wrapSimple("checkpoint"),
    fence: wrapFence("fence"),
    compareAndCommit: wrapSimple("compareAndCommit"),
    release: wrapSimple("release"),
    inspect: wrapInspect("inspect"),
    recover: wrapSimple("recover"),
    open: base.open.bind(base),
    close: base.close.bind(base),
  }) as MigrationAuthorityBackendPort;
}

// ---------------------------------------------------------------------------
// Two-process runner: real child_process.fork with the tsx loader + IPC
// ---------------------------------------------------------------------------

export type ChildScenario = Readonly<{
  /** Operation the child performs. */
  operation: "acquire" | "acquire-write" | "acquire-crash" | "acquire-release" | "heartbeat" | "recover" | "inspect-then-acquire";
  /** Resources to acquire (JSON-serializable). */
  resources: readonly MigrationResource[];
  /** Map of resourceId → relative path under the worktree (for FS effects). */
  resourcePathMap?: Readonly<Record<string, string>>;
  /** Worktree path the child binds to (worktree1 or worktree2). */
  worktreePath: string;
  /** Fault stage at which to crash (for acquire-crash). */
  crashStage?: string;
  /** Recovery config (for recover). */
  recovery?: Readonly<{ leaseId: string; generation: string; fenceIdentity: string; recoveryGeneration: string; supersedesGeneration: string; supersedesFenceIdentity: string }>;
  /** Lease evidence + grant for operations requiring authority (recover/heartbeat). */
  leaseEvidence?: LeaseEvidence;
  /** Clock seed pid. */
  clockPid?: number;
}>;

export type ChildResult = Readonly<{
  pid: number;
  exitOk: boolean;
  signal: NodeJS.Signals | null;
  exitCode: number | null;
  message: unknown;
  error: string | undefined;
}>;

const WORKER_PATH = new URL("./worker.ts", import.meta.url).pathname;

/**
 * Forks the worker with a scenario, passing the full setup via env. The child
 * uses the same tsx loader as the parent (from `process.execArgv`), so TS
 * imports resolve identically. IPC carries the result back.
 */
export function forkWorker(setup: MwaSetup, scenario: ChildScenario): ChildProcess {
  const env: Record<string, string> = {
    ...process.env,
    MWA_HOSTILE_SETUP: JSON.stringify({
      authorityRootPath: setup.authorityRootPath,
      dbPath: setup.dbPath,
      genesisRecord: setup.genesisRecord,
      rootPolicy: setup.rootPolicy,
      config: setup.config,
      repoBinding: setup.repoBinding,
    }),
    MWA_HOSTILE_SCENARIO: JSON.stringify(scenario),
  };
  return fork(WORKER_PATH, [], {
    execArgv: process.execArgv,
    env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  } as ForkOptions);
}

/**
 * Runs two child processes concurrently and observes their results via IPC.
 * Resolves when both children exit (or are killed). For race tests, both
 * children start at the same time and contend on the shared backend DB.
 */
export async function runTwoProcess(setup: MwaSetup, scenario1: ChildScenario, scenario2: ChildScenario): Promise<[ChildResult, ChildResult]> {
  const child1 = forkWorker(setup, scenario1);
  const child2 = forkWorker(setup, scenario2);
  const collect = (child: ChildProcess): Promise<ChildResult> =>
    new Promise((resolve) => {
      let message: unknown;
      let errorText = "";
      child.stdout?.on("data", () => { /* swallow stdout */ });
      child.stderr?.on("data", (d: Buffer) => { errorText += d.toString("utf8"); });
      child.on("message", (msg: unknown) => { message = msg; });
      child.on("error", (err: Error) => {
        resolve({ pid: child.pid ?? 0, exitOk: false, signal: null, exitCode: null, message: undefined, error: err.message });
      });
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        resolve({ pid: child.pid ?? 0, exitOk: signal === null && code === 0, signal, exitCode: code, message, error: errorText.length > 0 ? errorText : undefined });
      });
    });
  return Promise.all([collect(child1), collect(child2)]);
}

/**
 * Runs a single child process and observes its result. Used for crash tests
 * where the child is expected to be killed.
 */
export async function runOneProcess(setup: MwaSetup, scenario: ChildScenario): Promise<{ child: ChildProcess; result: Promise<ChildResult> }> {
  const child = forkWorker(setup, scenario);
  const result = new Promise<ChildResult>((resolve) => {
    let message: unknown;
    let errorText = "";
    child.stdout?.on("data", () => { /* swallow */ });
    child.stderr?.on("data", (d: Buffer) => { errorText += d.toString("utf8"); });
    child.on("message", (msg: unknown) => { message = msg; });
    child.on("error", (err: Error) => {
      resolve({ pid: child.pid ?? 0, exitOk: false, signal: null, exitCode: null, message: undefined, error: err.message });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ pid: child.pid ?? 0, exitOk: signal === null && code === 0, signal, exitCode: code, message, error: errorText.length > 0 ? errorText : undefined });
    });
  });
  return { child, result };
}

// ---------------------------------------------------------------------------
// SIGKILL helper
// ---------------------------------------------------------------------------

/**
 * Sends SIGKILL to a child process and verifies it is dead. Returns once the
 * process has exited (the 'close' event fires) or after a bounded wait.
 */
export async function killChildProcess(child: ChildProcess): Promise<{ signal: NodeJS.Signals | null; exitCode: number | null }> {
  const pid = child.pid;
  if (pid === undefined) return { signal: null, exitCode: null };
  const exitPromise = new Promise<{ signal: NodeJS.Signals | null; exitCode: number | null }>((resolve) => {
    const timeout = setTimeout(() => resolve({ signal: "SIGKILL", exitCode: null }), 5000);
    child.once("close", (code, signal) => { clearTimeout(timeout); resolve({ signal, exitCode: code }); });
  });
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
  return exitPromise;
}

// ---------------------------------------------------------------------------
// Independent oracle: re-reads raw journal + backend state, recomputes chain
// ---------------------------------------------------------------------------

export type OracleReport = Readonly<{
  journalAppendOnly: boolean;
  journalChainIntact: boolean;
  noDoubleAcquire: boolean;
  usefulDisjointConcurrency: boolean;
  leaseCount: number;
  journalEntryCount: number;
  writeReservationCount: number;
  details: string[];
}>;

type JournalRow = {
  sequence: number;
  previous_entry_identity: string | null;
  entry_identity: string;
  repository_identity: string;
  lease_id: string;
  generation: string;
  transition: string;
  request_identity: string;
  effect_identity: string | null;
  observed_state_identity: string | null;
};

type ReservationRow = { resource_id: string; lease_id: string; access: string };

/**
 * Creates an independent oracle that opens the backend DB directly and
 * verifies: journal append-only (unique entry_identity), journal chain
 * integrity (recompute each entry_identity from the envelope), no
 * double-acquire of the same resource (one writer per resource), and useful
 * disjoint concurrency (two leases with disjoint write resources).
 */
export function createOracle(dbPath: string): Readonly<{
  verify: () => OracleReport;
  rawJournal: () => readonly JournalRow[];
  rawReservations: () => readonly ReservationRow[];
}> {
  function open(): DatabaseSync {
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  function rawJournal(): JournalRow[] {
    const db = open();
    try {
      return db.prepare(
        "SELECT sequence, previous_entry_identity, entry_identity, repository_identity, lease_id, generation, transition, request_identity, effect_identity, observed_state_identity FROM journal ORDER BY sequence",
      ).all() as JournalRow[];
    } finally {
      db.close();
    }
  }
  function rawReservations(): ReservationRow[] {
    const db = open();
    try {
      return db.prepare("SELECT resource_id, lease_id, access FROM resource_reservations ORDER BY reservation_ordinal").all() as ReservationRow[];
    } finally {
      db.close();
    }
  }
  function verify(): OracleReport {
    const details: string[] = [];
    const journal = rawJournal();
    const reservations = rawReservations();
    // Journal append-only: entry_identity UNIQUE, sequence AUTOINCREMENT. Verify
    // no two rows share a sequence and all entry_identities are distinct.
    const seqs = new Set<number>();
    const ids = new Set<string>();
    let journalAppendOnly = true;
    for (const row of journal) {
      if (seqs.has(row.sequence)) { journalAppendOnly = false; details.push(`duplicate sequence ${row.sequence}`); }
      if (ids.has(row.entry_identity)) { journalAppendOnly = false; details.push(`duplicate entry_identity ${row.entry_identity}`); }
      seqs.add(row.sequence);
      ids.add(row.entry_identity);
    }
    // Journal chain integrity: recompute each entry_identity from the envelope
    // and verify the previous_entry_identity links match.
    let journalChainIntact = true;
    let prevIdentity = ZERO_CHAIN_HASH;
    for (const row of journal) {
      const expectedPrev = row.previous_entry_identity === null ? ZERO_CHAIN_HASH : row.previous_entry_identity;
      if (expectedPrev !== prevIdentity) {
        journalChainIntact = false;
        details.push(`chain break at sequence ${row.sequence}: expected prev ${prevIdentity.slice(0, 12)}, got ${expectedPrev.slice(0, 12)}`);
      }
      const envelope = Object.freeze({
        schemaVersion: MWA_PROTOCOL_SCHEMA_VERSION,
        messageKind: "journal-entry",
        previousEntryIdentity: "",
        repositoryIdentity: row.repository_identity,
        leaseId: row.lease_id,
        generation: row.generation,
        transition: row.transition,
        requestIdentity: row.request_identity,
        effectIdentity: row.effect_identity,
        observedStateIdentity: row.observed_state_identity,
        receiptAuthority: MWA_RECEIPT_AUTHORITY,
      });
      const recomputed = computeChainHash(MWA_LEDGER_DOMAIN, expectedPrev, envelope);
      if (recomputed !== row.entry_identity) {
        journalChainIntact = false;
        details.push(`chain mismatch at sequence ${row.sequence}: recomputed ${recomputed.slice(0, 12)} != stored ${row.entry_identity.slice(0, 12)}`);
      }
      prevIdentity = row.entry_identity;
    }
    // No double-acquire: for each resource_id with access='write', at most one
    // lease holds it. (The resource_write_unique partial index enforces this;
    // the oracle independently re-verifies.)
    const writeByResource = new Map<string, string[]>();
    for (const r of reservations) {
      if (r.access === "write") {
        const list = writeByResource.get(r.resource_id) ?? [];
        list.push(r.lease_id);
        writeByResource.set(r.resource_id, list);
      }
    }
    let noDoubleAcquire = true;
    for (const [resourceId, leaseIds] of writeByResource) {
      const unique = new Set(leaseIds);
      if (unique.size > 1) {
        noDoubleAcquire = false;
        details.push(`double-acquire of write resource ${resourceId} by leases ${[...unique].join(", ")}`);
      }
    }
    // Useful disjoint concurrency: there exist two leases with disjoint write
    // resources (both acquired successfully).
    const writeByLease = new Map<string, Set<string>>();
    for (const r of reservations) {
      if (r.access === "write") {
        const set = writeByLease.get(r.lease_id) ?? new Set<string>();
        set.add(r.resource_id);
        writeByLease.set(r.lease_id, set);
      }
    }
    let usefulDisjointConcurrency = false;
    const leases = [...writeByLease.entries()];
    for (let i = 0; i < leases.length && !usefulDisjointConcurrency; i += 1) {
      for (let j = i + 1; j < leases.length; j += 1) {
        const [_, a] = leases[i]!;
        const [__, b] = leases[j]!;
        const disjoint = [...a].every((x) => !b.has(x));
        if (disjoint && a.size > 0 && b.size > 0) {
          usefulDisjointConcurrency = true;
          break;
        }
      }
    }
    return Object.freeze({
      journalAppendOnly,
      journalChainIntact,
      noDoubleAcquire,
      usefulDisjointConcurrency,
      leaseCount: new Set(reservations.map((r) => r.lease_id)).size,
      journalEntryCount: journal.length,
      writeReservationCount: reservations.filter((r) => r.access === "write").length,
      details: Object.freeze(details) as string[],
    });
  }
  return Object.freeze({ verify, rawJournal, rawReservations });
}

// ---------------------------------------------------------------------------
// Typed assertion utilities
// ---------------------------------------------------------------------------

export function assertAccepted<T extends Readonly<{ outcome: string }>>(result: T, message: string): asserts result is T & Readonly<{ outcome: "accepted" }> {
  assert.equal(result.outcome, "accepted", message);
}

export function assertDenied(result: Readonly<{ outcome: string }>, expectedError: BackendError["code"], message: string): void {
  assert.equal(result.outcome, "denied", `${message}: expected denied, got ${result.outcome}`);
  if (result.outcome === "denied") {
    assert.equal((result as unknown as Readonly<{ error: BackendError }>).error.code, expectedError, `${message}: expected ${expectedError}`);
  }
}

export function assertBackendError(result: Readonly<{ outcome: string }>, expectedCode: BackendError["code"], message: string): void {
  assertDenied(result, expectedCode, message);
}

// ---------------------------------------------------------------------------
// Helpers for recover: construct a grant matching a persisted lease
// ---------------------------------------------------------------------------

/**
 * Constructs a `LiveGrant` matching a persisted lease's fields, so a recovery
 * process can recover a lease it did not originally acquire. The backend
 * re-validates every field inside its transaction, so a fabricated grant with
 * the right fields grants nothing extra — the recovery fence must still be
 * strictly newer than the current fencing sequence.
 */
export function grantForLease(lease: Readonly<{ leaseId: string; generation: string; fenceIdentity: string; repositoryIdentity: string; resourceRegistryIdentity: string; processIdentity: string }>): LiveGrant {
  return createLiveGrant({
    leaseId: lease.leaseId,
    generation: lease.generation,
    fenceIdentity: lease.fenceIdentity,
    repositoryIdentity: lease.repositoryIdentity,
    resourceRegistryIdentity: lease.resourceRegistryIdentity,
    processIdentity: lease.processIdentity,
  });
}

/**
 * Reads a lease's persisted fields from the backend via `inspect`. Returns the
 * raw lease row fields needed to construct a matching grant for recovery.
 */
export function inspectLease(setup: MwaSetup, leaseId: string): Readonly<{
  leaseId: string; generation: string; fenceIdentity: string;
  repositoryIdentity: string; resourceRegistryIdentity: string;
  processIdentity: string; state: string; journalCursor: string;
}> {
  const db = new DatabaseSync(setup.dbPath, { readOnly: true });
  try {
    const row = db.prepare(
      "SELECT lease_id, generation, fence_identity, repository_identity, resource_registry_identity, process_identity, state, journal_cursor FROM leases WHERE lease_id = ?",
    ).get(leaseId) as
      | { lease_id: string; generation: string; fence_identity: string; repository_identity: string; resource_registry_identity: string; process_identity: string; state: string; journal_cursor: string }
      | undefined;
    if (row === undefined) throw new Error(`lease ${leaseId} not found`);
    return Object.freeze({
      leaseId: row.lease_id, generation: row.generation, fenceIdentity: row.fence_identity,
      repositoryIdentity: row.repository_identity, resourceRegistryIdentity: row.resource_registry_identity,
      processIdentity: row.process_identity, state: row.state, journalCursor: row.journal_cursor,
    });
  } finally {
    db.close();
  }
}
