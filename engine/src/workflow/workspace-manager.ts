import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { deepFreeze, generateId, sha256 } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { ensurePrivateStateDirectory } from "../filesystem/private-state.ts";
import { detectWriteSetConflictAmong } from "../agents/agent-config.ts";
import { DEFAULT_TIMELINE_QUERY_LIMIT, type TimelineConfig, type WorkspaceIsolationConfig } from "../kernel/config-contracts.ts";
import {
  bindTransientWriteRootCapability,
  compileExactWriteLease,
  EXACT_WRITE_LEASE_OPERATIONS,
  type ExactWriteEffect,
} from "../modules/effect-boundary/domain/write-lease.ts";
import type { GitIdentity } from "../git/git-port.ts";
import { gitOutput, type GitRepository } from "../git/tree-reader.ts";
import type { StatusEntry, WorktreeGitPort } from "../git/worktree-port.ts";
import { snapshotWorkingTree, type WorkingTreeSnapshot } from "../git/working-copy.ts";
import { indexFilePath } from "../git/repository-ownership.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { blobSizes, ignoredCopies } from "../git/ignored-copies.ts";
import { createTimelineStore } from "../timeline/timeline-store.ts";
import type { EventLedgerStoragePort } from "../timeline/timeline-types.ts";
import { auditEvent } from "../shared/debug/debug-system.ts";
import { currentQualificationOutcome, qualificationTerminal, runForInvocation, diffRunFailures, failureIdentityFile, importJudgedRuns, latestRunOfTree, readRunHistory, runsOfTree, suiteLedgerPaths, type SuiteLedgerName } from "../shared/run-history.ts";
import { openBoardRows, ownersOf } from "./failure-owners.ts";
import { finiteNumber, type JudgedRunRecord, type RunQualificationTerminal } from "../shared/budget-verdict.ts";
import { acquireLock } from "./resource-lock.ts";
import { generatedOutputPaths, isGenerationOnlyChange } from "./hash-binding-registry.ts";
import { frozenAcceptancesBetween } from "./record-links.ts";
import { applyCheckoutFiles, assertSameFilesystem, removeGateLogs, runCheckoutPhase, runDeclaredCommands, settleCheckout, type CheckoutCommand, type CheckoutPhase, type CheckoutStep } from "./checkout-setup.ts";
import { LandingError, branchCheckout, commitCandidate, landCommit, refuseUndeclaredWrites } from "./tree-landing.ts";
import { importWorkspaceTimelineShard, openWorkspaceTimelineShard } from "./timeline-shard.ts";
import { createWorkspaceRecordStore, refuseOwnedByOlder, workspaceRecordStores, type WorkspaceRecordStore } from "./workspace-registry.ts";
import { remoteTrackingRef } from "../git/git-port.ts";
import { fetchForgeBranches, publishBranch, queuePreflightConflict, remoteUrlOf, resolveForgeTarget, type ForgePullRequest, type ForgeTarget, type PublishedRound, type WorkspaceForge, type WorkspaceForgeFactory } from "./workspace-forge.ts";
import { repositoryRegistryArea, resolveRepositoryRegistry, workspaceRootOf, type RepositoryRegistry } from "./repository-registry.ts";
import { DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS, WORKSPACE_NONCE_CHARACTERS, WORKSPACE_REFUSAL_PATHS_NAMED, WORKSPACE_SHORT_ID_CHARACTERS } from "./workflow-config.ts";
import {
  assertLeasableWriteSet,
  assertWorkspaceAgentName,
  assertWorkspaceTransition,
  canonicalizeWriteSetPath,
  computeMergedSinceConflicts,
  computePendingWriteSetConflicts,
  computeUnleasedPaths,
  finalizeMergeReceipt,
  isTerminalWorkspaceState,
  recordedReason,
  WORKSPACE_SCHEMA_VERSION,
  type ConflictEntry,
  type ConflictReport,
  type MergeReceipt,
  type ValidationReport,
  type WorkspaceGateResult,
  type WorkspaceLanding,
  type WorkspaceOverlay,
  finalizeLandReceipt,
  isLegacyForgeState,
  type LandReceipt,
  type WorkspaceFollow,
  type WorkspaceForgeState,
  type WorkspaceRecord,
  type WorkspaceState,
  type WorkspaceTransition,
} from "./workspace-contracts.ts";


/** A budget's value in a ledger row: `field` is a dotted path (`performanceMeasurements.apiResponseMaxMs`); a non-finite or absent value is none. */
export function budgetFieldOf(row: unknown, field: string): number | undefined {
  let value: unknown = row;
  for (const key of field.split(".")) value = value !== null && typeof value === "object" ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
  return finiteNumber(value) ?? undefined;
}
export { createWorkspaceRecordStore, type WorkspaceRecordStore } from "./workspace-registry.ts";

/**
 * Workspace manager — the lifecycle of isolated workspaces (git worktrees)
 * and the serialized integrator that lands them (`harness workspace`,
 * `npm run ws`).
 *
 * ONE REGISTRY PER REPOSITORY, in its git common directory
 * (`<common dir>/bridlewise/`: `workspaces/` the records, `locks/` the two
 * repository locks, `timeline/` the shards and the integrator's ledger), so
 * a command run from any checkout of the repository — the canonical one, a
 * workspace's own worktree — sees the same records and takes the same locks.
 *
 * Every record write is a compare-and-swap on its revision
 * (`workspace-registry.ts`): a command that read a record before another
 * wrote it (a validate that ran for an hour while an extend or an abort
 * happened) is refused, `workspace_record_changed`, never a lost update.
 *
 * CREATE: the target must be a declared land target
 *   (`workspaceIsolation.landTargets`: a product branch that changes only
 *   through its promotion door is never one) and a `--base` must be in the
 *   target's history; then, under the ADMISSION lock, the static write-set
 *   check against every pending lease and the record reserved as `admitted`;
 *   then — outside the lock — `git worktree add` at `<workspaceRoot>/<id>`
 *   (relative to the repository home, on the same filesystem), the checkout
 *   files (links, the config mode) and the `setup` phase (dependencies from
 *   the worktree's own lockfiles, native outputs, the bundle). Three kinds:
 *   - feature: branch `agent/<name>/<nonce>` at the target's tip (or `--base`);
 *   - overlay: a feature workspace started from `snapshotWorkingTree` of the
 *     invoking dirty checkout (its real index and files untouched), leased for
 *     what the snapshot changed; refused when a staged blob differs from both
 *     HEAD and the worktree, or a staged deletion's file is still on disk
 *     (the snapshot could not carry either), or when a deleted file's bytes
 *     sit at an ignored path (a move-loss);
 *   - read-only: a detached worktree for a verifier, no lease, never merges.
 * THE CHANGED SET is what `git merge` brings: the diff from the fork point
 *   with the target (`merge-base(target tip, HEAD)`) to HEAD. A changed path
 *   needs no lease only when its change is REGENERATION ONLY
 *   (`isGenerationOnlyChange`: a wholly generated output, or a pin or
 *   generated block re-derived with nothing authored changed); the
 *   merged-since and pending-lease checks judge the same authored set.
 * VALIDATE in the worktree, fail-fast: the write-set proof (clean worktree,
 *   authored changes ⊆ lease), the `validate` phase; with `--full` also
 *   `regenerate`, the `converged` check (nothing left uncommitted) and the
 *   `merge` phase.
 * PUBLISH and READY (`workspace-forge.ts`): a feature workspace's target has
 *   an upstream (resolved at create, refused when it has none); a round
 *   publishes the branch's new commits as forge-signed twins (the same trees)
 *   once the worktree is clean and its changes since the fetched trunk are
 *   inside the lease, moves the local branch to them, and opens the DRAFT pull
 *   request on the first round (regenerating its body on every one); `ready`
 *   takes it out of draft once the published tree passed `validate`.
 * STACKS (`create --stack-on`): a workspace started at a live, published
 *   workspace's head is judged from it (validate, publish) while that parent
 *   is open, publishes only its own commits, opens its pull request against
 *   the trunk (never the parent's branch: the forge deletes a landed branch),
 *   and lands (`land`, `merge`) only after its parent did. A stack is ordered
 *   by construction, so its members' leases never rival each other.
 * LEDGER GATES (a command that declares its suite `ledger`) are judged like
 *   a qualification: the run's row against the BASELINE of the target's tip —
 *   a non-mutation run of the target's TREE (a row's `treeId`, the tree the
 *   run measured wherever it was taken: a candidate's qualification of the
 *   tree a commit landed is that commit's baseline; a row that names no tree
 *   measures none and is never a baseline), in the workspace's ledger or the landing checkout's; when none
 *   exists it is measured first, LIKE FOR LIKE, in the same worktree detached
 *   at the target's tip (`ensureTargetBaselines`: the row that run recorded
 *   is the baseline, whatever identity the target's runner wrote; a tip whose
 *   regenerate rewrites it, or a run that recorded nothing, is said so) —
 *   never a run demanded of a live checkout. A gate passes iff no failure is
 *   new and none fails differently; the land imports the qualifying rows (of
 *   the landed tree only) into the landing checkout's ledger.
 *   There is ONE judge (UR-17): no subset run re-judged by a full suite, and
 *   no new failure forgiven because its file passed when re-run alone.
 * MERGE (under the MERGE lock), in the WORKSPACE, never in a checkout anyone
 *   else uses: the land-target, lease, staleness, merged-since and
 *   pending-lease checks; detach at the target's tip T; `merge --no-ff
 *   --no-commit --no-autostash` of the branch; a conflict on a generated
 *   output whose branch-side change is regeneration only is resolved to T's
 *   side — any other is reported; the `regenerate` phase, whose writes must
 *   all be generated outputs; then ONE `git commit`, which runs the
 *   repository's hooks (the commit guard certifies the merge commit M like
 *   any commit); the `merge` phase (skipped when M's tree is the tree
 *   `validate --full` qualified); the convergence check; then the LAND:
 *   `merge --ff-only --no-autostash M` in the checkout that has the target
 *   checked out (git refuses, changing nothing, if that would touch its
 *   dirty, staged or untracked state, or if the target moved), a
 *   compare-and-swap `update-ref` when no checkout has it, or the overlay's
 *   adoption into the checkout it came from (only while that checkout still
 *   holds exactly the snapshot and the same index). A failure before the land
 *   that the integrator survives leaves every checkout untouched: the
 *   worktree goes back to its branch and the record to `active` (to
 *   `validating` when git refused the land itself: nothing the validation
 *   judged changed). Then the timeline import, teardown and the hashed
 *   receipt.
 * RECOVER: an integrator that DIED (killed, out of memory, a tool timeout)
 *   leaves its record `merging`. Holding the merge lock proves no integrator
 *   runs; `recover` (and `sweep`) then finish a land that happened (`merged`)
 *   or put the worktree back on its branch (`active`).
 * ABORT removes the worktree and branch (or quarantines them); SWEEP ends
 *   expired leases, recovers dead integrators' records and removes
 *   quarantined worktrees past their retention.
 */

const WORKSPACE_INTEGRATOR_LEDGER_ID = "workspace-integrator" as const;
const TRUNCATION_MARKER = "...[truncated]";

/** One gate's outcome as a command step reports it (a built-in gate is built the same way). */
export type WorkspaceGateOutcome = CheckoutStep;

/**
 * The commands port: the production one runs each declared command under
 * the native supervisor (`checkoutCommandRunner`); tests inject fakes.
 */
export type WorkspaceCommands = Readonly<{
  run(checkoutRoot: string, name: string, command: CheckoutCommand): Promise<WorkspaceGateOutcome>;
}>;

export type WorkspaceManagerTimeouts = Readonly<{
  /** Worktree add/remove/switch and the land. */
  worktreeMs: number;
  /** Repository inspection. */
  inspectMs: number;
  /** The merge commit, which runs the repository's commit hooks. */
  mergeMs: number;
  /** A fetch from the forge's remote. */
  fetchMs: number;
}>;

export type WorkspaceTimelineHooks = Readonly<{
  queryDefaultLimit?: TimelineConfig["queryDefaultLimit"];
  openShard(workspaceId: string): EventLedgerStoragePort;
  openCanonical(): EventLedgerStoragePort;
}>;

export type WorkspaceManagerOptions = Readonly<{
  /** Any directory inside the checkout the command runs from. */
  checkoutRoot: string;
  /** The engine root's path relative to a checkout's top level (derived by the caller). */
  engineRelative: string;
  config: WorkspaceIsolationConfig;
  git: WorktreeGitPort;
  /** The binary-safe git of a checkout (`configuredGitRepository`: the configured executable and ceiling). */
  repository: (root: string) => GitRepository;
  /**
   * The forge client of a land target (`workspace-forge.ts`). Absent: every
   * verb that reaches the forge (publish, ready) is refused
   * `workspace_forge_unavailable`; the local verbs work.
   */
  forge?: WorkspaceForgeFactory;
  commands: WorkspaceCommands;
  timeouts: WorkspaceManagerTimeouts;
  /** The integrator's commit identity; absent: the repository's configured identity. */
  identity?: GitIdentity;
  records?: WorkspaceRecordStore;
  timeline?: WorkspaceTimelineHooks | null;
  /** Waits between two looks at a land (default: a timer; tests advance their fake forge). */
  sleep?: (ms: number) => Promise<void>;
  /** The one snapshot of a dirty tree (tests may observe it). */
  snapshot?: typeof snapshotWorkingTree;
  now?: () => Date;
  /** Told what the manager is doing (an operator's progress line). */
  onProgress?: (line: string) => void;
}>;

export type WorkspaceCreateRequest = Readonly<{
  agentName: string;
  mode: "feature" | "overlay" | "read-only";
  /** Leased paths (feature; added to an overlay's own changed set). */
  writeSet: readonly string[];
  /** The commit a feature or read-only workspace starts at (default: the target's tip; read-only: HEAD). */
  base?: string;
  /** The branch a feature workspace lands on (default: the branch checked out where the command runs). */
  target?: string;
  /**
   * STACKS the new feature workspace on another one (see {@link create}): it
   * starts at that workspace's published head, lands on the same target, and
   * lands only after it.
   */
  stackOn?: string;
}>;

export type WorkspaceManager = Readonly<{
  registry: RepositoryRegistry;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceRecord>;
  extend(workspaceId: string, writeSet: readonly string[]): Promise<WorkspaceRecord>;
  validate(workspaceId: string, options?: Readonly<{ full?: boolean }>): Promise<ValidationReport>;
  /** Publishes the branch's new commits as signed twins and opens (or regenerates) its draft pull request. */
  publish(workspaceId: string): Promise<WorkspacePublication>;
  /** Marks the pull request ready for review: the published head is the validated tree. */
  ready(workspaceId: string): Promise<WorkspaceRecord>;
  merge(workspaceId: string): Promise<MergeReceipt>;
  /** Lands the published, ready, validated head through the forge's merge queue and waits for it (see `land` below). */
  land(workspaceId: string): Promise<LandReceipt>;
  /** Finishes or rolls back a merge whose integrator died (see `recover` below). */
  recover(workspaceId: string): Promise<WorkspaceRecord>;
  abort(workspaceId: string, options?: Readonly<{ quarantine?: boolean; reason?: string }>): Promise<WorkspaceRecord>;
  snapshot(workspaceId: string, label: string): WorkingTreeSnapshot;
  list(): readonly WorkspaceRecord[];
  status(workspaceId: string): WorkspaceRecord;
  /** Ends expired leases, recovers dead integrators, removes expired quarantines; reports live records whose worktree is gone. */
  sweep(): Promise<WorkspaceSweep>;
}>;

/** What a sweep did: the workspaces it ended or finished, and the live ones whose worktree is gone (reported, untouched). */
export type WorkspaceSweep = Readonly<{ swept: readonly string[]; orphaned: readonly string[] }>;

/** What `publish` did: the record as saved and the round. */
export type WorkspacePublication = Readonly<{ record: WorkspaceRecord; round: PublishedRound }>;

export class WorkspaceConflictError extends HarnessError {
  readonly report: ConflictReport;
  constructor(report: ConflictReport) {
    super(
      `workspace conflict (${report.kind}): ${report.conflicts.map((entry) => entry.path).join(", ")}`,
      "workspace_conflict",
      false,
      { kind: report.kind, count: report.conflicts.length },
    );
    this.report = report;
  }
}

export class WorkspaceLeaseExpiredError extends HarnessError {
  constructor(workspaceId: string) {
    super(`workspace lease for ${workspaceId} has expired`, "workspace_lease_expired", false, { workspaceId });
  }
}

export class WorkspaceIntegrityError extends HarnessError {
  constructor(workspaceId: string, detail: string) {
    super(`workspace ${workspaceId} worktree integrity failed: ${detail}`, "workspace_integrity_failed", false, { workspaceId });
  }
}

/** A phase's gate failed (setup, regenerate or merge): nothing landed. */
export class WorkspaceGateFailedError extends HarnessError {
  readonly gateResults: readonly WorkspaceGateResult[];
  constructor(workspaceId: string, phase: string, gateResults: readonly WorkspaceGateResult[], code = "workspace_gate_failed") {
    const failing = gateResults.filter((gate) => gate.status === "fail");
    const failed = failing.map((gate) => gate.gate).join(", ");
    // Each failed gate's own words and its output tail: the operator reads
    // WHY here, not only which gate.
    const why = failing.map((gate) => `${gate.gate}: ${gate.message}${gate.details.length === 0 ? "" : `\n${gate.details.join("\n")}`}`).join("\n");
    super(`workspace ${workspaceId}: the ${phase} phase failed (${failed}); nothing landed\n${why}`, code, false, { workspaceId, phase, failed });
    this.gateResults = gateResults;
  }
}

/** Cap one gate outcome at the persistence boundary (reports, receipts). */
function persistedGate(outcome: WorkspaceGateOutcome): WorkspaceGateResult {
  const cap = (text: string): string =>
    text.length <= DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS
      ? text
      : `${text.slice(0, DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
  return deepFreeze({ gate: outcome.step, status: outcome.status, message: cap(outcome.message), details: deepFreeze(outcome.details.map(cap)) });
}

function builtinGate(gate: string, status: CheckoutStep["status"], message: string, details: readonly string[] = []): WorkspaceGateOutcome {
  return deepFreeze({ step: gate, status, message, details: deepFreeze([...details]) });
}

/** The timeline stores of a registry: per-workspace shards and the integrator's ledger, in its `timeline/` area. */
export function createWorkspaceTimelineHooks(
  registry: RepositoryRegistry,
  timelineConfig?: Partial<TimelineConfig>,
): WorkspaceTimelineHooks {
  // Timeline configuration consists of scalar values. Capture the same
  // immutable selection for every later store open and import page limit.
  const capturedConfig = timelineConfig !== undefined ? deepFreeze({ ...timelineConfig }) : undefined;
  const dbFilename = capturedConfig?.dbFilename ?? "timeline.db";
  const stateRootAbsolute = ensurePrivateStateDirectory(repositoryRegistryArea(registry, "timeline"));
  return deepFreeze({
    queryDefaultLimit: capturedConfig?.queryDefaultLimit ?? DEFAULT_TIMELINE_QUERY_LIMIT,
    openShard(workspaceId: string): EventLedgerStoragePort {
      return openWorkspaceTimelineShard({ stateRootAbsolute, workspaceId, ...(capturedConfig !== undefined ? { timelineConfig: capturedConfig } : {}) });
    },
    openCanonical(): EventLedgerStoragePort {
      return createTimelineStore({
        path: join(stateRootAbsolute, dbFilename),
        ledgerId: WORKSPACE_INTEGRATOR_LEDGER_ID,
        ...(capturedConfig !== undefined ? { timelineConfig: capturedConfig } : {}),
      });
    },
  });
}

/** The paths the status names (the port's one reader, `StatusEntry`). */
function statusPaths(entries: readonly StatusEntry[]): readonly string[] {
  return entries.map((entry) => entry.path);
}

/** THE ONE EXPIRY PREDICATE: `record`'s lease ran out before `nowMs` (admission, every verb and the sweep ask here). */
function leaseExpired(record: WorkspaceRecord, nowMs: number): boolean {
  return nowMs > new Date(record.lease.expiresAt).getTime();
}

/** The paths whose WORKING-TREE side differs from the index (unstaged, or untracked): what ran after the staging wrote. */
function unstagedStatusPaths(entries: readonly StatusEntry[]): readonly string[] {
  return statusPaths(entries.filter((entry) => entry.unstaged || entry.untracked));
}

export function createWorkspaceManager(options: WorkspaceManagerOptions): WorkspaceManager {
  const { config, git, commands, timeouts } = options;
  const timeline = options.timeline ?? null;
  const now = options.now ?? (() => new Date());
  const snapshot = options.snapshot ?? snapshotWorkingTree;
  const progress = options.onProgress ?? ((): void => undefined);
  const checkoutRoot = git.toplevel(resolve(options.checkoutRoot), timeouts.inspectMs);
  const registry = resolveRepositoryRegistry(git, checkoutRoot, timeouts.inspectMs);
  const store = options.records ?? createWorkspaceRecordStore(workspaceRecordStores(registry));
  const lockDirectory = repositoryRegistryArea(registry, "locks");
  const workspaceRoot = workspaceRootOf(registry, config.workspaceRoot);
  const snapshotIdentity = options.identity === undefined ? {} : { identity: options.identity };
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); }));

  function iso(date: Date): string {
    return date.toISOString();
  }

  async function withRepositoryLock<T>(lock: WorkspaceIsolationConfig["mergeLock"], owner: string, work: () => Promise<T> | T): Promise<T> {
    ensurePrivateStateDirectory(lockDirectory);
    const handle = await acquireLock(registry.root, lock.name, { lockDirectory, timeoutMs: lock.timeoutMs, unreadableAfterMs: lock.staleMs, owner });
    try {
      return await work();
    } finally {
      handle.release();
    }
  }

  /**
   * A record a verb may CHANGE: refused (`workspace_owned_by_v<N>_checkout`)
   * before anything is touched when only an older store knows the workspace —
   * its worktree, branch and record belong to the checkout of the version
   * that made it until the recorded cutover (`workspace-registry.ts`).
   */
  function requireOwnedRecord(workspaceId: string): WorkspaceRecord {
    const record = requireRecord(workspaceId);
    const older = store.olderRecord(workspaceId);
    if (older !== null) refuseOwnedByOlder(workspaceId, older, record.lease.worktreePath);
    return record;
  }

  function requireRecord(workspaceId: string): WorkspaceRecord {
    const record = store.load(workspaceId);
    if (record === null) throw new InputError(`workspace ${workspaceId} does not exist`, "workspace_not_found");
    return record;
  }

  function transition(record: WorkspaceRecord, to: WorkspaceState, reason: string): WorkspaceRecord {
    assertWorkspaceTransition(record.state, to);
    const entry: WorkspaceTransition = deepFreeze({ from: record.state, to, at: iso(now()), reason: recordedReason(reason) });
    return deepFreeze({ ...record, state: to, history: deepFreeze([...record.history, entry]) });
  }

  /** Every write goes through the store's compare-and-swap: `record` must be the stored revision; returns the new one. */
  function saveTransition(record: WorkspaceRecord, to: WorkspaceState, reason: string): WorkspaceRecord {
    return store.save(transition(record, to, reason));
  }

  function recordTimelineEvent(
    scope: "shard" | "canonical",
    record: WorkspaceRecord,
    description: string,
    outcome?: "succeeded" | "failed" | "cancelled",
  ): void {
    if (timeline === null) return;
    const ledger = scope === "shard" ? timeline.openShard(record.workspaceId) : timeline.openCanonical();
    try {
      ledger.appendEvent({
        eventId: generateId("workspace-event"),
        ledgerId: ledger.ledgerId,
        eventType: "agent",
        actor: deepFreeze({ kind: "harness", id: "workspace-manager" }),
        correlation: deepFreeze({ agentId: record.agentName, taskId: record.workspaceId }),
        description,
        wallTime: iso(now()),
        ...(outcome !== undefined ? { outcome } : {}),
      });
    } finally {
      ledger.close();
    }
  }

  function buildConflictReport(kind: ConflictReport["kind"], workspaceId: string, conflicts: readonly ConflictEntry[]): ConflictReport {
    return deepFreeze({ schemaVersion: WORKSPACE_SCHEMA_VERSION, kind, workspaceId, conflicts, detectedAt: iso(now()) });
  }

  function refuse(record: WorkspaceRecord, kind: ConflictReport["kind"], conflicts: readonly ConflictEntry[], reason: string): never {
    const conflictReport = buildConflictReport(kind, record.workspaceId, conflicts);
    saveTransition(deepFreeze({ ...record, conflictReport }), "active", reason);
    auditEvent("workspace-merge-refused", { workspaceId: record.workspaceId, kind, paths: conflicts.map((entry) => entry.path) });
    throw new WorkspaceConflictError(conflictReport);
  }

  function quarantineRecord(record: WorkspaceRecord, reason: string): WorkspaceRecord {
    const worktreePath = record.lease.worktreePath;
    if (existsSync(worktreePath)) {
      try {
        git.worktreeLock({ repoRoot: checkoutRoot, worktreePath, reason, timeoutMs: timeouts.worktreeMs });
      } catch (error) {
        // A worktree git can no longer lock (already locked, a broken .git
        // entry) is still preserved: quarantine only records the decision.
        if (!(error instanceof HarnessError)) throw error;
      }
    }
    const updated = saveTransition(deepFreeze({ ...record, abortReason: recordedReason(reason) }), "quarantined", reason);
    recordTimelineEvent("canonical", updated, `workspace-quarantined: ${reason}`, "failed");
    auditEvent("workspace-quarantined", { workspaceId: record.workspaceId, reason });
    return updated;
  }

  /** The prefix of a workspace's `snapshot` refs (`<namespace>/<id>.<label>`). */
  const snapshotRefPrefix = (workspaceId: string): string => `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/${workspaceId}.`;

  function removeWorktreeAndBranch(record: WorkspaceRecord): void {
    const worktreePath = record.lease.worktreePath;
    if (existsSync(worktreePath)) {
      removeGateLogs(worktreePath);
      git.worktreeRemove({ repoRoot: checkoutRoot, worktreePath, force: true, timeoutMs: timeouts.worktreeMs });
    } else {
      git.worktreePrune(checkoutRoot, timeouts.worktreeMs);
    }
    // Its recovery points go with it (A5-design L4: they outlived every merge
    // and abort); a quarantine keeps them, with the worktree, for inspection.
    for (const [ref, sha] of git.refsUnder(checkoutRoot, snapshotRefPrefix(record.workspaceId), timeouts.inspectMs)) {
      git.deleteRef(checkoutRoot, ref, sha, timeouts.inspectMs);
    }
    if (record.lease.branch === null) return;
    try {
      git.deleteBranch(checkoutRoot, record.lease.branch, true, timeouts.worktreeMs);
    } catch (error) {
      // A branch already gone (a create that failed before `worktree add`
      // made it) leaves nothing to delete.
      if (!(error instanceof HarnessError)) throw error;
    }
  }

  /**
   * Ends a workspace: its pull request (if one was opened and is still open)
   * is closed with the reason — the forge's branch is kept, archive-never-
   * delete — then the worktree is removed (or quarantined). A `merging`
   * workspace belongs to its integrator or its land until that ends.
   */
  async function abortInternal(record: WorkspaceRecord, quarantine: boolean, reason: string): Promise<WorkspaceRecord> {
    if (isTerminalWorkspaceState(record.state)) return record;
    if (record.state === "merging") {
      throw new InputError(`workspace ${record.workspaceId} is merging: its integrator or its land owns it until that ends (workspace recover)`, "workspace_abort_denied");
    }
    const pullRequest = record.forge !== null && !isLegacyForgeState(record.forge) ? record.forge.pullRequest : null;
    if (pullRequest !== null) {
      const { forge } = forgeOf(record, "recorded");
      if ((await forge.pullRequest(pullRequest.number)).state === "open") {
        await forge.closePullRequest(pullRequest.number, `Workspace \`${record.workspaceId}\` ended: ${recordedReason(reason)}. Its branch is kept.`);
      }
    }
    if (quarantine) return quarantineRecord(record, reason);
    removeWorktreeAndBranch(record);
    const updated = saveTransition(deepFreeze({ ...record, abortReason: recordedReason(reason) }), "aborted", reason);
    recordTimelineEvent("canonical", updated, `workspace-aborted: ${reason}`, "cancelled");
    auditEvent("workspace-aborted", { workspaceId: record.workspaceId, reason });
    return updated;
  }

  async function assertLeaseLive(record: WorkspaceRecord): Promise<void> {
    if (leaseExpired(record, now().getTime())) {
      await abortInternal(record, config.preserveOnFailure, "lease-expired");
      throw new WorkspaceLeaseExpiredError(record.workspaceId);
    }
  }

  function assertWorktreeIntact(record: WorkspaceRecord): void {
    if (!git.verifyWorktreeIntact(record.lease.worktreePath, timeouts.inspectMs)) {
      quarantineRecord(record, "worktree .git entry missing or gitdir unreadable");
      throw new WorkspaceIntegrityError(record.workspaceId, "worktree .git entry missing or gitdir unreadable");
    }
  }

  /** The tree of a commit, or null when the repository does not hold it (a row of a foreign checkout). */
  const commitTrees = new Map<string, string | null>();
  function treeOf(commit: string): string | null {
    if (!commitTrees.has(commit)) {
      let tree: string | null = null;
      try {
        tree = git.revParse(checkoutRoot, `${commit}^{tree}`, timeouts.inspectMs);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
      }
      commitTrees.set(commit, tree);
    }
    return commitTrees.get(commit)!;
  }

  /** The checkout a land writes into, if any: the overlay's own, else the one that has the target checked out (none: the land is a ref update). */
  function landingCheckout(record: WorkspaceRecord): string | null {
    if (record.lease.overlay !== null) return record.lease.overlay.checkout;
    const target = record.lease.targetBranch;
    if (target === null) return null;
    return branchCheckout(git, checkoutRoot, target, timeouts.inspectMs);
  }

  /** The ledger files a target baseline may sit in: the workspace's own and the landing checkout's (never an unrelated checkout's). */
  function baselineLedgers(record: WorkspaceRecord, cwd: string, ledger: SuiteLedgerName): readonly string[] {
    const relative = suiteLedgerPaths(options.engineRelative)[ledger];
    const holder = landingCheckout(record);
    return [...new Set([cwd, ...(holder === null ? [] : [holder])].map((root) => join(root, relative)))];
  }

  /**
   * THE BASELINE OF A TARGET: the latest row, recorded before `before`, of a
   * run that measured `targetTip`'s TREE — keyed by the tree, never by where
   * the run was taken: a row whose `treeId` is the target's tree (a
   * candidate's qualification of exactly the tree a commit later landed, a
   * workspace's, the landing checkout's own; `latestRunOfTree`). Never a
   * mutation run; a row of another tree, or one that names no tree, is never
   * a baseline.
   */
  function targetBaseline(paths: readonly string[], targetTip: string, before: number): JudgedRunRecord | undefined {
    const tree = treeOf(targetTip);
    if (tree === null) return undefined;
    return latestRunOfTree(paths.flatMap((path) => readRunHistory(path)), tree, before);
  }

  /** The runs of `tree` recorded before `before`, whatever ran beside them: the rows a budget is judged against (NO-LOAD-BLOCK, audit A-05). */
  function measuredRunsOfTree(paths: readonly string[], tree: string, before: number): readonly JudgedRunRecord[] {
    return runsOfTree(paths.flatMap((path) => readRunHistory(path)), tree)
      .filter((row) => Date.parse(row.timestamp ?? "") < before);
  }

  /**
   * The command that measures a ledger — its suite's gate: the merge phase's
   * command of that ledger, the one owner of "which command answers for a
   * ledger" for the baseline measurement ({@link ensureTargetBaselines}).
   */
  function ledgerSuiteCommand(ledger: SuiteLedgerName): string | undefined {
    return config.phases.merge.find((name) => config.commands[name]?.ledger === ledger);
  }

  /** What a ledger gate is judged against: the target's tip (null: a read-only workspace, which lands nothing). */
  type LedgerJudge = Readonly<{ record: WorkspaceRecord; targetTip: string | null }>;

  /**
   * A gate that declares its `ledger` is judged like a qualification: its
   * run's row (it must have recorded one: a cold, refused or crashed run
   * measures nothing) against the target's baseline ({@link targetBaseline},
   * measured like for like by {@link ensureTargetBaselines}). It passes iff it
   * fails nothing new, no persisting failure fails differently (a changed
   * digest: a new defect under an old identity), and every failure that
   * persists from the target is OWNED — an open task row names its test's
   * repository path (src/workflow/failure-owners.ts; UR-24). Nothing else decides: a new
   * failure is a regression even when its file would pass alone (a flaky test
   * is fixed at its cause, never re-run until it passes).
   */
  function currentTreeUnchanged(cwd: string, tree: string): boolean {
    return git.status(cwd, timeouts.inspectMs).length === 0 && git.revParse(cwd, "HEAD^{tree}", timeouts.inspectMs) === tree;
  }

  async function judgedByLedger(cwd: string, name: string, command: CheckoutCommand, judge: LedgerJudge): Promise<WorkspaceGateOutcome> {
    const ledger = command.ledger;
    if (ledger === undefined) return commands.run(cwd, name, command);
    // The current command must measure this clean committed tree, including
    // in read-only workspaces. Historical target lookup remains separate.
    if (git.status(cwd, timeouts.inspectMs).length > 0) return builtinGate(name, "fail", "current qualification requires a clean checkout before execution");
    const tree = git.revParse(cwd, "HEAD^{tree}", timeouts.inspectMs);
    const outcome = await commands.run(cwd, name, command);
    if (!currentTreeUnchanged(cwd, tree)) {
      return builtinGate(name, "fail", "current qualification tree changed during execution", outcome.details);
    }
    const invocationId = outcome.evidence?.invocationId;
    const terminal = outcome.evidence?.terminal;
    if (outcome.status === "skip" || invocationId === undefined || terminal === undefined) {
      return builtinGate(name, "fail", "current suite command has no invocation-bound terminal evidence", outcome.details);
    }
    const ledgerPath = suiteLedgerPaths(options.engineRelative)[ledger];
    const current = runForInvocation(join(cwd, ledgerPath), invocationId);
    let outer: RunQualificationTerminal;
    try { outer = qualificationTerminal(invocationId, tree, terminal); }
    catch (error) {
      if (!(error instanceof HarnessError) || error.code !== "qualification_terminal_invalid") throw error;
      return builtinGate(name, "fail", "current suite command has malformed invocation-bound terminal evidence", outcome.details);
    }
    const budgets: Readonly<Record<string, Readonly<{ budget: string; field: string }>>> = ROOT_POLICY.workflow.failureOwners.budgets[ledger];
    const completion = currentQualificationOutcome(current, { invocationId, treeId: tree, producer: ledger, outer, judgedBudgets: new Set(Object.keys(budgets)) });
    if (completion.kind !== "pass" || current === undefined) return builtinGate(name, "fail", completion.message, outcome.details);
    // A budget gate that did not PASS is a breach to judge: a "not-judged" there is no softer than a "fail"
    // (UR-24-BUDGETS; design M-A: unmeasured is never a pass). It passes only as owned and not worse.
    const breaches = (current.qualification?.outcomes ?? []).filter((gate) => gate.kind !== "pass" && budgets[gate.gate] !== undefined);
    if (judge.targetTip === null) {
      return builtinGate(name, (current.failures?.length ?? 0) === 0 && breaches.length === 0 ? "pass" : "fail",
        `${completion.message}; ${String(current.failures?.length ?? 0)} current test failure(s), ${String(breaches.length)} budget breach(es); read-only validation has no target comparison`, outcome.details);
    }
    const before = Date.parse(current.timestamp!);
    const measured = measuredBaselines.get(baselineKey(judge.targetTip, ledger));
    const reference = targetBaseline(baselineLedgers(judge.record, cwd, ledger), judge.targetTip, before);
    if (reference === undefined) {
      return builtinGate(name, "fail",
        `unmeasured: no run of the target's tree (${judge.targetTip}) in ${ledgerPath} to judge this run against${measured?.why === undefined ? "" : `: ${measured.why}`}`,
        [...(measured?.paths ?? []), ...outcome.details]);
    }
    const diff = diffRunFailures(reference, current);
    if (diff.verdict === "unmeasured") return builtinGate(name, "fail", `unmeasured against ${reference.timestamp ?? "the baseline"}: ${diff.reason}`, outcome.details);
    // OWNED, OR REFUSED: a failure that persists from the target's recorded
    // run is accepted only when an open task row of the owner tracker names
    // its test's repository path — the user's policy "zero new failures, and
    // every remaining failure owned by a named task". One judgement: nothing
    // is re-run, nothing else decides.
    const trackerPath = ROOT_POLICY.workflow.failureOwners.tracker;
    let tracker: string;
    try {
      tracker = readFileSync(join(cwd, trackerPath), "utf8");
    } catch (error) {
      return builtinGate(name, "fail", `the failure owners' tracker ${trackerPath} is unreadable (${(error as NodeJS.ErrnoException).code ?? "unknown"}), so no persisting failure can be judged owned`, outcome.details);
    }
    const rows = openBoardRows(tracker);
    const repositoryPath = (identity: string): string | null => {
      const file = failureIdentityFile(identity);
      return file === null ? null : ledger === "engine" ? `${options.engineRelative}/${file}` : file;
    };
    const persisting = diff.persisting.filter((identity) => !diff.changed.includes(identity)).map((identity) => {
      const path = repositoryPath(identity);
      return { identity, path, owners: path === null ? [] : ownersOf(rows, path) };
    });
    const owned = persisting.filter((entry) => entry.owners.length > 0);
    const unowned = persisting.filter((entry) => entry.owners.length === 0);
    const counts = `${diff.persisting.length} persisting (${owned.length} owned), ${diff.fixed.length} fixed, against the run of ${judge.targetTip} at ${reference.timestamp ?? "(unstamped)"}`;
    const regressions = [
      ...diff.new,
      ...diff.changed.map((identity) => `${identity} (fails differently now)`),
      ...unowned.map((entry) => `${entry.identity} (persists from the target, but no open task row of ${trackerPath} names ${entry.path ?? "its file"})`),
    ];
    const ownedDetails = owned.map((entry) => `${entry.identity} (an owned failure: persists on the target with the same digest; owner ${entry.owners.join(", ")})`);
    // THE BUDGETS, IN THE SAME JUDGEMENT (UR-24, the coordinator's budget
    // amendment): a breach passes only when it persists from the target NOT
    // WORSE — this change's value no higher than the LOWEST value the target's
    // tree recorded — and an open task row declares the budget. Every
    // recorded run of the target counts, whatever ran beside it: the values
    // are CPU work (NO-LOAD-BLOCK, audit A-05); a target with none is
    // measured first ({@link ensureTargetBaselines}). A breach with no target
    // value, a worse one or an unowned breach fails. No allowance, no re-run.
    const targetTree = treeOf(judge.targetTip);
    const baseRows = targetTree === null ? [] : measuredRunsOfTree(baselineLedgers(judge.record, cwd, ledger), targetTree, before);
    const budgetVerdicts = breaches.map((breach) => {
      const spec = budgets[breach.gate]!;
      const field = (row: unknown): number | undefined => budgetFieldOf(row, spec.field);
      const value = field(current);
      const baseValues = baseRows.map(field).filter((v): v is number => v !== undefined);
      const lowest = baseValues.length === 0 ? undefined : Math.min(...baseValues);
      const owners = ownersOf(rows, spec.budget);
      const base = lowest === undefined ? "the target recorded no value"
        : `the target's lowest of ${String(baseValues.length)} value(s) is ${lowest.toFixed(1)}`;
      const reason = value === undefined || lowest === undefined ? `unmeasured: ${value === undefined ? "this run" : "the target"} recorded no ${spec.field}`
          : value > lowest ? `WORSE than the target: ${value.toFixed(1)} > ${lowest.toFixed(1)}`
            : owners.length === 0 ? `persists from the target not worse, but no open task row of ${trackerPath} declares ${spec.budget}`
              : undefined;
      const line = `${breach.gate} (${spec.budget}): ${value === undefined ? "no value" : value.toFixed(1)}; ${base}`;
      return { pass: reason === undefined, line: reason === undefined ? `${line}; persists from the target, not worse; owner ${owners.join(", ")}` : `${line}; ${reason}` };
    });
    const budgetFails = budgetVerdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.line);
    const budgetOwned = budgetVerdicts.filter((verdict) => verdict.pass).map((verdict) => verdict.line);
    return regressions.length === 0 && budgetFails.length === 0
      ? builtinGate(name, "pass", `${completion.message}; no new, changed or unowned failure (${counts}); ${String(budgetOwned.length)} owned budget breach(es), none worse`, [...ownedDetails, ...budgetOwned])
      : builtinGate(name, "fail", `${diff.new.length} new, ${diff.changed.length} changed and ${unowned.length} unowned failure(s), ${String(budgetFails.length)} refused budget breach(es) (${counts})`, [...regressions, ...budgetFails, ...ownedDetails, ...budgetOwned]);
  }

  /** A phase in `cwd`, fail-fast, through the commands port; ledger gates are judged by `judge`. */
  async function runPhase(cwd: string, phase: CheckoutPhase, judge: LedgerJudge): Promise<readonly WorkspaceGateResult[]> {
    const steps = await runCheckoutPhase(config, phase, (name, command) => {
      // A read-only workspace (a verifier's) runs no heavy setup instrument: it runs single files, and its first run warms
      // the module cache.
      if (command.holdsInstrumentLock === true && judge.record.lease.kind === "read-only") {
        return Promise.resolve(builtinGate(name, "skip", "a read-only workspace does not run a heavy setup instrument: its first run warms the cache"));
      }
      progress(`${phase}: ${name}`);
      return judgedByLedger(cwd, name, command, judge);
    });
    return deepFreeze(steps.map(persistedGate));
  }

  /**
   * The target tips THIS manager measured, by tip and ledger (each once per
   * process), and why a measurement yielded no {@link targetBaseline} when it
   * did not: the gate's "unmeasured" message names it. The baseline itself is
   * only ever the row found by the tree it measured — never a row adopted
   * because this manager ran it (WF-1b3c-FIX MED-3).
   */
  const measuredBaselines = new Map<string, Readonly<{ why?: string; paths?: readonly string[] }>>();
  const baselineKey = (targetTip: string, ledger: SuiteLedgerName): string => `${targetTip}\u0000${ledger}`;

  /**
   * EVERY MOVE OF A WORKTREE KEEPS ITS CHECKOUT FILES: a checkout or a merge
   * inside a workspace's worktree rewrites each file it changes with git's own
   * mode (0644, or 0664 under the usual umask), so the config document's
   * required 0600 is re-applied after every move, as at create
   * ({@link applyCheckoutFiles}). Without it the next harness command in the
   * worktree refuses the config (`config_mode_insecure`): measured, a target
   * baseline's checkout and the return to the branch left it 0664 and the
   * workspace's own harness-sync gate failed.
   */
  function moveWorktree(worktreePath: string, move: () => void): void {
    move();
    settleCheckout(worktreePath, options.engineRelative);
  }

  /**
   * LIKE FOR LIKE: before `phase`'s ledger gates judge the workspace, each
   * LEDGER they answer for must have a {@link targetBaseline} — a run of the
   * target's TREE recorded anywhere this repository keeps one (a candidate's
   * qualification of the tree a commit landed, imported by its copy-back; a
   * workspace's land). One that has none is measured HERE, in the same
   * worktree on the same machine: detached at the target's tip, the
   * `regenerate` phase (the target's own build outputs; a tip it rewrites is
   * not measurable as committed, and is said so), then each such ledger's
   * suite command ({@link ledgerSuiteCommand}), whose recorded row —
   * carrying the tree it measured — is then found as that tip's baseline like
   * any other (when it is not, {@link measuredBaselines} says why); then
   * `back` returns the worktree to where it was. Never a run of a live
   * checkout.
   */
  async function ensureTargetBaselines(record: WorkspaceRecord, cwd: string, phase: CheckoutPhase, targetTip: string, back: () => void): Promise<void> {
    const wanted = [...new Set(config.phases[phase].flatMap((name) => {
      const ledger = config.commands[name]?.ledger;
      return ledger === undefined ? [] : [ledger];
    }))];
    // A ledger whose budgets are judged needs a target run carrying the value
    // of every budget an open task row OWNS (only an owned breach can pass,
    // and only against the target's value; a perf budget's comes from the
    // profile step its suite requires). A target without one is measured here.
    const targetTree = treeOf(targetTip);
    const trackerText = (() => {
      try {
        return readFileSync(join(cwd, ROOT_POLICY.workflow.failureOwners.tracker), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    })();
    const taskRows = trackerText === "" ? [] : openBoardRows(trackerText);
    const budgetFields = (ledger: SuiteLedgerName): readonly string[] => Object.values(ROOT_POLICY.workflow.failureOwners.budgets[ledger] as Readonly<Record<string, Readonly<{ budget: string; field: string }>>>)
      .filter((spec) => ownersOf(taskRows, spec.budget).length > 0).map((spec) => spec.field);
    const missing = wanted.filter((ledger) => !measuredBaselines.has(baselineKey(targetTip, ledger)) &&
      (targetBaseline(baselineLedgers(record, cwd, ledger), targetTip, Number.POSITIVE_INFINITY) === undefined ||
        (budgetFields(ledger).length > 0 && targetTree !== null &&
          !measuredRunsOfTree(baselineLedgers(record, cwd, ledger), targetTree, Number.POSITIVE_INFINITY)
            .some((row) => budgetFields(ledger).every((path) => budgetFieldOf(row, path) !== undefined)))));
    if (missing.length === 0) return;
    progress(`baseline: measuring ${missing.join(", ")} at the target's tip ${targetTip}`);
    moveWorktree(cwd, () => git.checkoutDetached(cwd, targetTip, timeouts.worktreeMs, true));
    try {
      await runCheckoutPhase(config, "regenerate", (name, command) => commands.run(cwd, name, command));
      const rewritten = statusPaths(git.status(cwd, timeouts.inspectMs));
      for (const ledger of missing) {
        const name = ledgerSuiteCommand(ledger);
        if (name === undefined) {
          measuredBaselines.set(baselineKey(targetTip, ledger), { why: `no suite command of the ${ledger} ledger exists to measure its baseline` });
          continue;
        }
        if (rewritten.length > 0) {
          measuredBaselines.set(baselineKey(targetTip, ledger), { why: `the regenerate phase rewrote ${String(rewritten.length)} path(s) at the target's tip: its committed tree is not converged, so no run there measures it`, paths: rewritten });
          continue;
        }
        const started = now().getTime();
        // Through the one sequencer: the suite's producers run first, as in its gate.
        const outcome = (await runDeclaredCommands(config, "baseline", [name], (step, command) => commands.run(cwd, step, command))).at(-1)!;
        const row = readRunHistory(join(cwd, suiteLedgerPaths(options.engineRelative)[ledger])).at(-1);
        const left = statusPaths(git.status(cwd, timeouts.inspectMs));
        measuredBaselines.set(baselineKey(targetTip, ledger),
          row === undefined || !(Date.parse(row.timestamp ?? "") >= started) || row.mutation === true
            ? { why: `the target's baseline run (${name}) recorded no judged run (${outcome.message})` }
            : left.length > 0
              ? { why: `the target's baseline run (${name}) left ${String(left.length)} path(s) changed: it did not measure the committed tree`, paths: left }
              : targetBaseline(baselineLedgers(record, cwd, ledger), targetTip, Number.POSITIVE_INFINITY) === undefined
                ? { why: `the target's baseline run (${name}) recorded a run that names no tree of the target (its runner records no tree id, or the tree changed while it ran)` }
                : {});
      }
    } finally {
      back();
    }
  }

  /** After a land: the workspace's judged runs of the landed tree (rows that name `measured`, the tree), imported into the landing checkout's ledgers (it holds that tree now). */
  function importQualifyingRuns(record: WorkspaceRecord, landedIn: string | null, measuredSince: string, measured: string): readonly string[] {
    if (landedIn === null) return [];
    const ledgers = [...new Set([...config.phases.validate, ...config.phases.merge].flatMap((name) => config.commands[name]?.ledger ?? []))];
    return ledgers.map((ledger) => {
      const relative = suiteLedgerPaths(options.engineRelative)[ledger];
      return `${ledger}: ${String(importJudgedRuns(join(record.lease.worktreePath, relative), join(landedIn, relative), `workspace ${record.workspaceId}`, measuredSince, measured))}`;
    });
  }

  /**
   * The changed paths whose change from `from` to `to` is REGENERATION ONLY
   * (`isGenerationOnlyChange`: a wholly generated output, or a generated
   * output whose authored part is unchanged): the only ones exempt from the
   * lease, the merged-since and the pending-lease checks.
   */
  function generationOnlyPaths(cwd: string, from: string, to: string, changed: readonly string[], generated: ReadonlySet<string>): ReadonlySet<string> {
    return new Set(changed.filter((path) => generated.has(path) &&
      isGenerationOnlyChange(path, git.blobAt(cwd, from, path, timeouts.inspectMs), git.blobAt(cwd, to, path, timeouts.inspectMs))));
  }

  /**
   * What a branch changes, as `git merge` will bring it: the diff from the
   * fork point with the target (`merge-base(targetTip, head)`, never the
   * recorded base, which a branch's history can leave behind), and the
   * subset of it that is regeneration only.
   */
  function branchChange(cwd: string, forkPoint: string, head: string): Readonly<{ changed: readonly string[]; exempt: ReadonlySet<string> }> {
    const changed = git.diffNameOnly({ cwd, refA: forkPoint, refB: head, threeDot: false, timeoutMs: timeouts.inspectMs });
    return { changed, exempt: generationOnlyPaths(cwd, forkPoint, head, changed, generatedOutputPaths(cwd)) };
  }

  function leaseIdentity(workspaceId: string, writeSet: readonly string[]): string | null {
    if (writeSet.length === 0) return null;
    const rootCapability = bindTransientWriteRootCapability(deepFreeze({ workspaceId }));
    const effects: ExactWriteEffect[] = writeSet.flatMap((path) =>
      EXACT_WRITE_LEASE_OPERATIONS.map((operation) => deepFreeze({ operation, relativePath: path })));
    return compileExactWriteLease(rootCapability, effects).writeSetIdentity;
  }

  /**
   * The unfinished feature workspaces but `workspaceId`'s own, split by
   * whether their lease still holds their paths: while it is live or its
   * merge is running. An EXPIRED lease holds nothing — every verb of its
   * workspace, `extend` included, ends it first ({@link assertLeaseLive}), so
   * it can never validate, merge or renew again — and counting it refused
   * every overlapping writer until a sweep ended it, the one door that also
   * retires the worktree and branch a successor may be landing the work
   * from. A merging record always counts: its integrator owns its paths until
   * the land, whatever the clock says.
   */
  function featureLeases(workspaceId: string, stackedOn: string | null = stackParentOf(store.load(workspaceId))): Readonly<{ pending: readonly WorkspaceRecord[]; expired: readonly WorkspaceRecord[] }> {
    const nowMs = now().getTime();
    // A workspace's own stack (its ancestors and descendants) is ordered by construction: never its rival.
    const stack = stackRelatives(workspaceId, stackedOn);
    const others = store.list().filter((record) => record.workspaceId !== workspaceId && !stack.has(record.workspaceId) && !isTerminalWorkspaceState(record.state) && record.lease.kind === "feature");
    const holds = (record: WorkspaceRecord): boolean => record.state === "merging" || !leaseExpired(record, nowMs);
    return deepFreeze({ pending: others.filter(holds), expired: others.filter((record) => !holds(record)) });
  }

  /** The feature leases that still hold their paths ({@link featureLeases}). */
  function pendingFeatureLeases(workspaceId: string): readonly WorkspaceRecord[] {
    return featureLeases(workspaceId).pending;
  }

  /**
   * Static admission: the write set against every pending feature lease but
   * `workspaceId`'s own ({@link pendingFeatureLeases}). Admitting over an
   * EXPIRED lease's paths is an audit event naming that workspace and the
   * paths (`workspace-admitted-over-expired`), so its owner learns why its
   * next verb will end it, before a merge does.
   */
  function assertAdmissible(workspaceId: string, writeSet: readonly string[], stackedOn: string | null): void {
    const { pending, expired } = featureLeases(workspaceId, stackedOn);
    for (const record of expired) {
      const paths = [...new Set(detectWriteSetConflictAmong([deepFreeze({ name: record.workspaceId, writeSet: record.lease.writeSet }), deepFreeze({ name: workspaceId, writeSet })])
        .conflicts.map((conflict) => conflict.path))].toSorted();
      if (paths.length > 0) auditEvent("workspace-admitted-over-expired", { workspaceId, expiredWorkspaceId: record.workspaceId, expiredAt: record.lease.expiresAt, paths });
    }
    const pendingOwners = pending
      .map((record) => deepFreeze({ name: record.workspaceId, writeSet: record.lease.writeSet }));
    const conflicts = detectWriteSetConflictAmong([...pendingOwners, deepFreeze({ name: workspaceId, writeSet })])
      .conflicts
      .filter((conflict) => conflict.agentA === workspaceId || conflict.agentB === workspaceId);
    if (conflicts.length > 0) {
      throw new WorkspaceConflictError(buildConflictReport("static-overlap", workspaceId, conflicts.map((conflict) => {
        const otherWorkspaceId = conflict.agentA === workspaceId ? conflict.agentB : conflict.agentA;
        return deepFreeze({ path: conflict.path, otherWorkspaceId, reason: `write set overlaps the pending workspace ${otherWorkspaceId}` });
      })));
    }
  }

  /** A workspace lands only on a declared land target (`workspaceIsolation.landTargets`): its target's upstream trunk on the forge. */
  function assertLandable(trunk: string): void {
    if (!config.landTargets.includes(trunk)) {
      throw new InputError(
        `${trunk} is not a land target: a workspace lands only on the forge trunk ${config.landTargets.join(", ")} (workspaceIsolation.landTargets, its target's upstream) — target a branch whose upstream is it (git branch --set-upstream-to <remote>/${config.landTargets[0]!} <target>); a product branch changes only through its promotion door`,
        "workspace_target_not_landable",
      );
    }
  }

  /** The workspace root exists on the repository home's filesystem (tmpfs roots fail here, not later in the harness). */
  function assertWorkspaceRootPlacement(): void {
    mkdirSync(workspaceRoot, { recursive: true });
    assertSameFilesystem(registry.home, workspaceRoot, "workspace_root_filesystem_mismatch");
  }

  function indexDigest(checkout: string): string {
    return sha256(git.lsFilesStage(checkout, timeouts.inspectMs));
  }

  /**
   * The overlay of the invoking checkout: refusals first (a staged blob the
   * snapshot cannot carry; a deletion whose bytes sit at an ignored path),
   * then the one snapshot. Its changed paths are the overlay's own lease.
   */
  function takeOverlay(head: string): Readonly<{ overlay: WorkspaceOverlay; changed: readonly string[] }> {
    const unstaged = new Set(git.diffNames(checkoutRoot, "index-to-worktree", timeouts.inspectMs));
    const divergent = git.diffNames(checkoutRoot, "head-to-index", timeouts.inspectMs).filter((path) => unstaged.has(path));
    // A staged deletion whose file is still on disk (`git rm --cached`): the
    // snapshot adds the file back, so the adoption would silently undo it.
    const keptDeletions = git.diffNames(checkoutRoot, "staged-deletions", timeouts.inspectMs).filter((path) => existsSync(join(checkoutRoot, path)));
    if (divergent.length > 0 || keptDeletions.length > 0) {
      throw new InputError(
        `the index stages ${[...divergent.map((path) => `a version of ${path} that neither HEAD nor the working tree holds`), ...keptDeletions.map((path) => `the deletion of ${path}, whose file is still on disk`)].join("; ")}; an overlay snapshots the working tree, so that staged state would be lost — commit it, or make the working tree match it, first`,
        "workspace_overlay_staged_divergent",
      );
    }
    const digest = indexDigest(checkoutRoot);
    const taken = snapshot(checkoutRoot, { message: `overlay: working tree of ${checkoutRoot} at ${iso(now())}`, ...snapshotIdentity });
    const deleted = git.deletedBlobs(checkoutRoot, head, taken.commit, timeouts.inspectMs);
    if (deleted.length > 0) {
      const sizes = blobSizes(checkoutRoot, deleted.map((entry) => entry.blob), "directory");
      const losses = ignoredCopies(checkoutRoot, deleted.map((entry) => ({ ...entry, size: sizes.get(entry.blob)! })), "directory");
      if (losses.length > 0) {
        throw new InputError(
          `the working tree deletes ${[...new Set(losses.map((loss) => loss.from))].join(", ")} while their bytes sit at ignored paths (${losses.map((loss) => loss.to).join(", ")}): a move into an ignored path loses the file — use git mv, or commit the deletion through the commit guard (declared) first`,
          "workspace_overlay_move_loss",
        );
      }
    }
    const changed = git.diffNameOnly({ cwd: checkoutRoot, refA: head, refB: taken.commit, threeDot: false, timeoutMs: timeouts.inspectMs });
    return deepFreeze({ overlay: deepFreeze({ commit: taken.commit, tree: taken.tree, checkout: checkoutRoot, indexDigest: digest }), changed });
  }

  /**
   * The parent a `create --stack-on` names (see {@link create}): a feature
   * workspace this version owns, live (active or validating: not landing,
   * landed or ended) and published (its head is on the forge). The child
   * takes its target; it names no target, base or overlay of its own.
   */
  function stackParentForCreate(request: WorkspaceCreateRequest): WorkspaceRecord {
    if (request.mode !== "feature" || request.target !== undefined || request.base !== undefined) {
      throw new InputError("a stacked workspace is a feature workspace that starts at its parent's published head and lands on its parent's target: it takes no --target, --base or --overlay", "workspace_stack_invalid");
    }
    const parent = requireOwnedRecord(request.stackOn!);
    if (parent.lease.kind !== "feature") {
      throw new InputError(`workspace ${parent.workspaceId} is read-only: it never publishes, so nothing can be stacked on it`, "workspace_stack_invalid");
    }
    if (parent.lease.overlay !== null) {
      throw new InputError(`workspace ${parent.workspaceId} is an overlay: it lands by adoption into the checkout it snapshotted, so nothing can be stacked on it`, "workspace_stack_invalid");
    }
    // A feature record this version owns has a live forge state (the record's schema; an older store's legacy marker was refused above).
    const state = parent.forge as WorkspaceForgeState;
    if (parent.state !== "active" && parent.state !== "validating") {
      throw new InputError(`workspace ${parent.workspaceId} is ${parent.state}: a workspace is stacked only on a live one`, "workspace_stack_parent_ended");
    }
    if (state.publishedHead === null) {
      throw new InputError(`workspace ${parent.workspaceId} has published nothing yet: publish it first (its head is the stacked workspace's base)`, "workspace_not_published");
    }
    return parent;
  }

  /** The workspace a record is stacked on, or null. */
  function stackParentOf(record: WorkspaceRecord | null): string | null {
    const state = record?.forge;
    return state === null || state === undefined || isLegacyForgeState(state) ? null : state.stackedOn;
  }

  /** `workspaceId`'s stack (but itself): every workspace it is stacked on, transitively, and every one stacked on it. */
  function stackRelatives(workspaceId: string, stackedOn: string | null): ReadonlySet<string> {
    const relatives = new Set<string>();
    for (let parent = stackedOn; parent !== null && !relatives.has(parent); parent = stackParentOf(store.load(parent))) relatives.add(parent);
    const records = store.list();
    const descends = (record: WorkspaceRecord): boolean => {
      const seen = new Set<string>();
      for (let parent = stackParentOf(record); parent !== null && !seen.has(parent); parent = stackParentOf(records.find((other) => other.workspaceId === parent) ?? null)) {
        if (parent === workspaceId) return true;
        seen.add(parent);
      }
      return false;
    };
    for (const record of records) if (descends(record)) relatives.add(record.workspaceId);
    return relatives;
  }

  /**
   * THE BASE A STACKED WORKSPACE IS JUDGED FROM while its parent has not
   * landed: the parent's published head (its validate, publish and pull
   * request see only what the branch adds beyond it), or null — no parent,
   * or a parent that landed (the trunk holds its head: the ordinary fork
   * point). The parent's published head must be in the branch's history
   * (`workspace_stack_parent_moved`: the parent published another head —
   * rebase onto it); a parent that ended without landing leaves nothing to
   * stand on (`workspace_stack_parent_ended`).
   */
  function stackBase(record: WorkspaceRecord, head: string): string | null {
    const parentId = stackParentOf(record);
    if (parentId === null) return null;
    const parent = store.load(parentId);
    if (parent === null || parent.state === "aborted" || parent.state === "quarantined") {
      throw new InputError(`workspace ${record.workspaceId} is stacked on ${parentId}, which ended without landing: nothing it stands on will land — abort it, or move its work onto the trunk in a new workspace`, "workspace_stack_parent_ended");
    }
    const published = (parent.forge as WorkspaceForgeState).publishedHead!;
    if (!git.isAncestor(record.lease.worktreePath, published, head, timeouts.inspectMs)) {
      throw new InputError(`workspace ${record.workspaceId} is stacked on ${parentId}, whose published head ${published} is not in its history: rebase onto it (git -C ${record.lease.worktreePath} rebase ${published})`, "workspace_stack_parent_moved");
    }
    return parent.state === "merged" ? null : published;
  }

  /** `ws land` and `ws merge` of a stacked workspace wait for its parent: refused while the parent has not landed. */
  function assertStackLanded(record: WorkspaceRecord, head: string): void {
    if (stackBase(record, head) !== null) {
      const parent = store.load(stackParentOf(record)!)!;
      const number = (parent.forge as WorkspaceForgeState).pullRequest?.number;
      throw new InputError(`workspace ${record.workspaceId} is stacked on ${parent.workspaceId}${number === undefined ? "" : ` (pull request #${String(number)})`}, which has not landed: land it first`, "workspace_stack_parent_unlanded");
    }
  }

  async function create(request: WorkspaceCreateRequest): Promise<WorkspaceRecord> {
    assertWorkspaceAgentName(request.agentName);
    const readOnly = request.mode === "read-only";
    const nonce = generateId("nonce").replaceAll("-", "").slice(-WORKSPACE_NONCE_CHARACTERS);
    const workspaceId = `${request.agentName}-${nonce}`;
    const worktreePath = join(workspaceRoot, workspaceId);
    assertWorkspaceRootPlacement();
    const invokingBranch = git.symbolicBranch(checkoutRoot, timeouts.inspectMs);
    const generated = generatedOutputPaths(checkoutRoot);

    let targetBranch: string | null = null;
    let forgeState: WorkspaceForgeState | null = null;
    const parent = request.stackOn === undefined ? null : stackParentForCreate(request);
    const stackedOn = parent?.workspaceId ?? null;
    let baseSha: string;
    let overlay: WorkspaceOverlay | null = null;
    let writeSet: readonly string[] = [];
    if (readOnly) {
      if (request.writeSet.length > 0 || request.target !== undefined) {
        throw new InputError("a read-only workspace takes no write set and no target: it never merges", "workspace_read_only");
      }
      baseSha = git.revParse(checkoutRoot, request.base ?? "HEAD", timeouts.inspectMs);
    } else {
      targetBranch = parent?.lease.targetBranch ?? request.target ?? invokingBranch;
      if (targetBranch === null) {
        throw new InputError("the checkout's HEAD is detached: name the branch the workspace lands on (--target <branch>)", "workspace_target_missing");
      }
      // Where it will land: the target's upstream on the forge (refused when it has none: it could never
      // land), whose trunk must be a declared land target — the forge's view, never the local branch's name.
      const upstream = resolveForgeTarget(options.repository(checkoutRoot), targetBranch);
      // The forge for that upstream is made now (no forge call): a remote that is not the trunk the forge knows (another
      // host's) is refused first, at create, naming the forge's trunk — not at the first publish.
      options.forge?.(upstream);
      assertLandable(upstream.trunk);
      forgeState = deepFreeze({ remote: upstream.remote, trunk: upstream.trunk, pullRequest: null, publishedHead: null, ready: false, land: null, stackedOn });
      const tip = git.revParse(checkoutRoot, `refs/heads/${targetBranch}`, timeouts.inspectMs);
      if (request.mode === "overlay") {
        if (targetBranch !== invokingBranch || request.base !== undefined) {
          throw new InputError("an overlay lands into the checkout it snapshots: its target is that checkout's branch and its base that checkout's HEAD", "workspace_overlay_target");
        }
        const taken = takeOverlay(tip);
        overlay = taken.overlay;
        baseSha = tip;
        writeSet = [...new Set([...taken.changed.filter((path) => !generated.has(path)), ...request.writeSet].map(canonicalizeWriteSetPath))].toSorted();
        if (taken.changed.length === 0) {
          throw new InputError(`the checkout ${checkoutRoot} holds nothing HEAD does not: there is nothing to adopt`, "workspace_overlay_clean");
        }
      } else if (parent !== null) {
        // A stacked workspace starts at its parent's published head: what the parent carries is the parent's, judged and landed by it.
        baseSha = (parent.forge as WorkspaceForgeState).publishedHead!;
        writeSet = [...new Set(request.writeSet.map(canonicalizeWriteSetPath))].toSorted();
      } else {
        baseSha = request.base === undefined ? tip : git.revParse(checkoutRoot, request.base, timeouts.inspectMs);
        // A base off the target's history would bring its own delta along
        // with the branch, and that delta was never leased.
        if (!git.isAncestor(checkoutRoot, baseSha, tip, timeouts.inspectMs)) {
          throw new InputError(`the base ${request.base ?? baseSha} is not in ${targetBranch}'s history: a workspace forks from its target (its tip, or a commit the tip contains)`, "workspace_base_not_on_target");
        }
        writeSet = [...new Set(request.writeSet.map(canonicalizeWriteSetPath))].toSorted();
      }
      assertLeasableWriteSet(writeSet);
    }

    const branch = readOnly ? null : `${config.branchNamespace}${request.agentName}/${nonce}`;
    const issued = now();
    let record: WorkspaceRecord = deepFreeze({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      agentName: request.agentName,
      state: "admitted",
      lease: deepFreeze({
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        workspaceId,
        agentName: request.agentName,
        kind: readOnly ? "read-only" : "feature",
        nonce,
        branch,
        targetBranch,
        worktreePath,
        baseSha,
        overlay,
        writeSet: deepFreeze([...writeSet]),
        writeSetIdentity: leaseIdentity(workspaceId, writeSet),
        issuedAt: iso(issued),
        heartbeatAt: iso(issued),
        expiresAt: iso(new Date(issued.getTime() + config.leaseTtlMs)),
        generation: 1,
      }),
      changedPaths: deepFreeze([]),
      validationReport: null,
      conflictReport: null,
      mergeReceipt: null,
      abortReason: null,
      history: deepFreeze([]),
      forge: forgeState,
      revision: 0,
    });
    // ADMISSION: the static check and the reservation are one step under the
    // admission lock, so two creates can never both pass the check.
    record = await withRepositoryLock(config.admissionLock, `workspace-create:${workspaceId}`, () => {
      if (!readOnly) assertAdmissible(workspaceId, writeSet, stackedOn);
      return store.save(record);
    });

    try {
      progress(`create: worktree ${worktreePath}`);
      if (branch === null) {
        git.worktreeAddDetached({ repoRoot: checkoutRoot, worktreePath, commitSha: baseSha, timeoutMs: timeouts.worktreeMs });
      } else {
        git.worktreeAdd({ repoRoot: checkoutRoot, worktreePath, branch, baseSha: overlay?.commit ?? baseSha, timeoutMs: timeouts.worktreeMs });
      }
      // An agent's checkout commits as the project's agent identity, from the one declared source, and says it is
      // an agent's: the commit-msg hook then refuses any other identity here (scripts/verification/sign-off.ts).
      git.agentCheckoutIdentity({ repoRoot: checkoutRoot, worktreePath, identity: ROOT_POLICY.workflow.commitIdentity.agent, markerKey: ROOT_POLICY.workflow.commitIdentity.agentCheckoutKey, timeoutMs: timeouts.worktreeMs });
      applyCheckoutFiles(worktreePath, checkoutRoot, options.engineRelative, config);
      const setup = await runPhase(worktreePath, "setup", { record, targetTip: null });
      if (setup.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "setup", setup, "workspace_setup_failed");
    } catch (error) {
      removeWorktreeAndBranch(record);
      saveTransition(deepFreeze({ ...record, abortReason: recordedReason(`create failed: ${error instanceof Error ? error.message : String(error)}`) }), "aborted", "create failed");
      throw error;
    }
    record = saveTransition(record, "active", overlay === null ? "workspace created" : `workspace created from the overlay ${overlay.commit}`);
    recordTimelineEvent("shard", record, `workspace-created base=${baseSha}`, "succeeded");
    auditEvent("workspace-created", { workspaceId, kind: record.lease.kind, targetBranch, baseSha, overlay: overlay?.commit ?? null, writeSet, stackedOn });
    return record;
  }

  async function extend(workspaceId: string, paths: readonly string[]): Promise<WorkspaceRecord> {
    return withRepositoryLock(config.admissionLock, `workspace-extend:${workspaceId}`, async () => {
      const record = requireOwnedRecord(workspaceId);
      if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
      if (record.lease.kind === "read-only") throw new InputError("a read-only workspace has no lease to extend", "workspace_read_only");
      if (record.state === "merging") throw new InputError(`workspace ${workspaceId} is merging; the integrator owns it`, "workspace_precondition_failed");
      // An expired lease is never revived: extend ends it like every other verb.
      await assertLeaseLive(record);
      const writeSet = [...new Set([...record.lease.writeSet, ...paths.map(canonicalizeWriteSetPath)])].toSorted();
      assertLeasableWriteSet(writeSet);
      assertAdmissible(workspaceId, writeSet, stackParentOf(record));
      const renewed = now();
      const updated: WorkspaceRecord = deepFreeze({
        ...record,
        lease: deepFreeze({
          ...record.lease,
          writeSet: deepFreeze(writeSet),
          writeSetIdentity: leaseIdentity(workspaceId, writeSet),
          heartbeatAt: iso(renewed),
          expiresAt: iso(new Date(renewed.getTime() + config.leaseTtlMs)),
          generation: record.lease.generation + 1,
        }),
      });
      const saved = store.save(updated);
      auditEvent("workspace-extended", { workspaceId, writeSet, generation: saved.lease.generation });
      return saved;
    });
  }

  async function validate(workspaceId: string, validateOptions: Readonly<{ full?: boolean }> = {}): Promise<ValidationReport> {
    const full = validateOptions.full === true;
    let record = requireOwnedRecord(workspaceId);
    if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
    if (record.state !== "active" && record.state !== "validating") {
      throw new InputError(`workspace ${workspaceId} cannot be validated from ${record.state}`, "workspace_precondition_failed");
    }
    await assertLeaseLive(record);
    assertWorktreeIntact(record);
    if (record.state === "active") record = saveTransition(record, "validating", full ? "full validation started" : "validation started");

    const worktreePath = record.lease.worktreePath;
    const startedAt = iso(now());
    const headSha = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
    const tree = git.revParse(worktreePath, `${headSha}^{tree}`, timeouts.inspectMs);
    const target = record.lease.targetBranch;
    const targetTip = target === null ? null : git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
    const judge: LedgerJudge = { record, targetTip };
    // What `git merge` would bring: the change since the fork point with the
    // target (a read-only workspace: since its base; a stacked one whose
    // parent has not landed: since the parent's published head).
    const stacked = stackBase(record, headSha);
    const { changed: changedPaths, exempt } = branchChange(worktreePath, stacked ?? (targetTip === null ? record.lease.baseSha : git.mergeBase(checkoutRoot, targetTip, headSha, timeouts.inspectMs)), headSha);
    const backToBranch = (): void => moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, record.lease.branch!, timeouts.worktreeMs, true));
    const gates: WorkspaceGateResult[] = [];
    if (record.lease.kind === "read-only") {
      gates.push(persistedGate(builtinGate("write-set-proof", "skip", "read-only: no lease to prove")));
    } else {
      const dirty = git.status(worktreePath, timeouts.inspectMs);
      const unleased = computeUnleasedPaths(changedPaths, record.lease.writeSet, exempt);
      gates.push(persistedGate(builtinGate(
        "write-set-proof",
        dirty.length === 0 && unleased.length === 0 ? "pass" : "fail",
        dirty.length > 0
          ? "the worktree has uncommitted changes: the gates judge commits"
          : unleased.length === 0
            ? `changed set (${changedPaths.length} paths) is inside the declared write set`
            : `${unleased.length} changed paths are outside the declared write set (extend the lease or revert them)`,
        [...statusPaths(dirty).map((path) => `uncommitted: ${path}`), ...unleased.map((path) => `unleased: ${path}`)],
      )));
    }
    const failedSoFar = (): boolean => gates.some((gate) => gate.status === "fail");
    if (!failedSoFar() && targetTip !== null) await ensureTargetBaselines(record, worktreePath, "validate", targetTip, backToBranch);
    if (!failedSoFar()) gates.push(...await runPhase(worktreePath, "validate", judge));
    if (full && !failedSoFar()) {
      if (targetTip !== null) await ensureTargetBaselines(record, worktreePath, "merge", targetTip, backToBranch);
      gates.push(...await runPhase(worktreePath, "regenerate", judge));
      if (!failedSoFar()) {
        const left = statusPaths(git.status(worktreePath, timeouts.inspectMs));
        gates.push(persistedGate(builtinGate(
          "converged",
          left.length === 0 ? "pass" : "fail",
          left.length === 0 ? "the regenerate phase left the tree as committed" : `the regenerate phase rewrote ${left.length} path(s): the commits are not converged — commit them`,
          left,
        )));
      }
      if (!failedSoFar()) gates.push(...await runPhase(worktreePath, "merge", judge));
    }

    const status: "pass" | "fail" = failedSoFar() ? "fail" : "pass";
    const report: ValidationReport = deepFreeze({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      baseSha: record.lease.baseSha,
      headSha,
      tree,
      full,
      changedPaths,
      gates: deepFreeze(gates),
      startedAt,
      status,
      validatedAt: iso(now()),
    });
    const updated = deepFreeze({ ...record, validationReport: report, changedPaths });
    const saved = store.save(status === "pass" ? updated : transition(updated, "active", "validation failed"));
    recordTimelineEvent("shard", saved, `workspace-validated status=${status} full=${String(full)}`, status === "pass" ? "succeeded" : "failed");
    return report;
  }


  /** The overlay's checkout still holds exactly the snapshot and the same index, and its branch is still at the base. */
  /** Why the overlay's checkout can no longer adopt a land (empty: it still holds exactly the snapshot and the same index, and its branch is at the base). */
  function overlayStaleness(record: WorkspaceRecord, overlay: WorkspaceOverlay, targetTip: string): readonly string[] {
    const fresh = snapshot(overlay.checkout, { message: `overlay check of ${record.workspaceId}`, ...snapshotIdentity });
    return [
      ...(targetTip === record.lease.baseSha ? [] : [`${record.lease.targetBranch} moved from ${record.lease.baseSha} to ${targetTip}`]),
      ...(fresh.tree === overlay.tree ? [] : ["the checkout's working tree changed since the overlay"]),
      ...(indexDigest(overlay.checkout) === overlay.indexDigest ? [] : ["the checkout's index changed since the overlay"]),
    ];
  }

  function assertOverlayCurrent(record: WorkspaceRecord, overlay: WorkspaceOverlay, targetTip: string): void {
    const stale = overlayStaleness(record, overlay, targetTip);
    if (stale.length > 0) {
      saveTransition(record, "active", `overlay stale: ${stale.join("; ")}`);
      throw new HarnessError(`the overlay of ${overlay.checkout} is stale (${stale.join("; ")}); the checkout was touched after the overlay was taken — abort this workspace and take a new overlay`, "workspace_overlay_stale", false, { workspaceId: record.workspaceId });
    }
  }

  /**
   * THE OVERLAY'S ADOPTION of `commit` into the checkout it was taken from
   * (its branch at `localTip`): the index becomes the snapshot's tree (the
   * working tree already is it), then a two-way switch to `commit` touches
   * only what differs, then the branch moves by compare-and-swap. A step that
   * fails before the branch moved gives the checkout its own index back, byte
   * for byte (A5-correctness L1: it was left at the snapshot's tree; the files
   * are only rewritten by the switch, which git does all or nothing). The
   * local land and the forge land's follow both adopt through here.
   */
  function adoptOverlay(record: WorkspaceRecord, overlay: WorkspaceOverlay, commit: string, localTip: string): void {
    const target = record.lease.targetBranch!;
    const index = indexFilePath(overlay.checkout, "directory");
    const ownIndex = readFileSync(index);
    try {
      git.readTree(overlay.checkout, overlay.commit, timeouts.worktreeMs);
      git.refreshIndex(overlay.checkout, timeouts.worktreeMs);
      git.readTreeSwitch(overlay.checkout, overlay.commit, commit, timeouts.worktreeMs);
      settleCheckout(overlay.checkout, options.engineRelative);
    } catch (error) {
      const restored = atomicWriteFile(index, ownIndex);
      if (!restored.success) throw new HarnessError(`the overlay's adoption failed and ${index} could not be given back (${restored.reason ?? "unknown"}): restore it with git read-tree ${overlay.commit}`, "workspace_overlay_index_unrestored", false, { workspaceId: record.workspaceId });
      throw error;
    }
    const moved = git.updateRef(overlay.checkout, `refs/heads/${target}`, commit, localTip, timeouts.worktreeMs);
    if (moved.refusal !== null) {
      throw new HarnessError(
        `the overlay's files and index were adopted but ${target} moved meanwhile (${moved.refusal}); the checkout ${overlay.checkout} now holds ${commit}'s tree on top of the new ${target}: inspect it with git status`,
        "workspace_overlay_adoption_incomplete",
        false,
        { workspaceId: record.workspaceId, commit },
      );
    }
  }

  /**
   * THE LAND (see the header). Throws `workspace_land_refused` with git's
   * words when git declines; nothing moved in that case.
   */
  function landLocally(record: WorkspaceRecord, mergeCommit: string, targetTip: string): Readonly<{ landing: WorkspaceLanding; landedIn: string | null }> {
    const target = record.lease.targetBranch!;
    const overlay = record.lease.overlay;
    if (overlay !== null) {
      assertOverlayCurrent(record, overlay, git.revParse(overlay.checkout, `refs/heads/${target}`, timeouts.inspectMs));
      adoptOverlay(record, overlay, mergeCommit, targetTip);
      return { landing: "overlay-adoption", landedIn: overlay.checkout };
    }
    const outcome = landCommit(git, checkoutRoot, target, mergeCommit, targetTip, options.engineRelative, timeouts.worktreeMs);
    if (outcome.refusal !== null) {
      throw new HarnessError(
        `git refused to land ${record.workspaceId} on ${target}${outcome.landedIn === null ? "" : ` in ${outcome.landedIn}`}: ${outcome.refusal}`,
        "workspace_land_refused",
        false,
        { workspaceId: record.workspaceId },
      );
    }
    return { landing: outcome.landing, landedIn: outcome.landedIn };
  }

  async function merge(workspaceId: string): Promise<MergeReceipt> {
    return withRepositoryLock(config.mergeLock, `workspace-merge:${workspaceId}`, async () => {
      let record = requireOwnedRecord(workspaceId);
      if (record.lease.kind === "read-only") throw new InputError(`workspace ${workspaceId} is read-only: it never merges`, "workspace_read_only");
      const validated = record.validationReport;
      if (record.state !== "validating" || validated === null || validated.status !== "pass") {
        throw new InputError(`workspace ${workspaceId} is not validated (state=${record.state})`, "workspace_merge_precondition_failed");
      }
      assertLandable((record.forge as WorkspaceForgeState).trunk);
      await assertLeaseLive(record);
      assertWorktreeIntact(record);
      assertStackLanded(record, git.revParse(record.lease.worktreePath, "HEAD", timeouts.inspectMs));
      record = saveTransition(record, "merging", "the integrator took the merge lock");

      const worktreePath = record.lease.worktreePath;
      const branch = record.lease.branch!;
      const target = record.lease.targetBranch!;
      const head = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
      // The validated commit, or its signed twin (a published round moves the
      // branch to it: the same tree) — never another commit of the same tree
      // (an amend after the validation is new work).
      const published = record.forge !== null && !isLegacyForgeState(record.forge) ? record.forge.publishedHead : null;
      const twinOfValidated = head === published && git.revParse(worktreePath, `${head}^{tree}`, timeouts.inspectMs) === validated.tree;
      if (head !== validated.headSha && !twinOfValidated) {
        saveTransition(record, "active", "worktree HEAD moved after validation; re-validate");
        throw new InputError(`workspace ${workspaceId} validation is stale (HEAD moved)`, "workspace_validation_stale");
      }
      if (git.status(worktreePath, timeouts.inspectMs).length > 0) {
        saveTransition(record, "active", "worktree has uncommitted changes at merge");
        throw new InputError(`workspace ${workspaceId} worktree is dirty at merge`, "workspace_merge_precondition_failed");
      }
      const generated = generatedOutputPaths(worktreePath);
      const targetTip = git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
      // The fork point with the target: what `git merge` brings is its diff to the head.
      const forkPoint = git.mergeBase(checkoutRoot, targetTip, head, timeouts.inspectMs);
      const { changed: changedPaths, exempt } = branchChange(worktreePath, forkPoint, head);
      const authored = changedPaths.filter((path) => !exempt.has(path));
      const unleased = computeUnleasedPaths(changedPaths, record.lease.writeSet, exempt);
      if (unleased.length > 0) {
        refuse(record, "dynamic-overlap", unleased.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "changed path is outside the declared write set" })), "changed set escaped the write set at merge");
      }
      if (record.lease.overlay !== null) assertOverlayCurrent(record, record.lease.overlay, targetTip);
      if (forkPoint !== targetTip) {
        const staleness = git.revListCount(checkoutRoot, forkPoint, targetTip, timeouts.inspectMs);
        const merged = git.diffNameOnly({ cwd: checkoutRoot, refA: forkPoint, refB: targetTip, threeDot: false, timeoutMs: timeouts.inspectMs });
        const mergedExempt = generationOnlyPaths(checkoutRoot, forkPoint, targetTip, merged, generated);
        const mergedConflicts = computeMergedSinceConflicts(authored, merged.filter((path) => !mergedExempt.has(path)));
        if (mergedConflicts.length > 0) refuse(record, "dynamic-overlap", mergedConflicts, "a path merged since the base; rebase and re-validate");
        if (staleness > config.baseStalenessCommits) {
          refuse(record, "dynamic-overlap", [deepFreeze({ path: "(base)", otherWorkspaceId: null, reason: `${target} moved ${staleness} commits since the base (budget ${config.baseStalenessCommits}); rebase required` })], "base too stale; rebase and re-validate");
        }
      }
      const pending = pendingFeatureLeases(workspaceId)
        .map((other) => deepFreeze({ workspaceId: other.workspaceId, writeSet: other.lease.writeSet }));
      const pendingConflicts = computePendingWriteSetConflicts(authored, pending);
      if (pendingConflicts.length > 0) refuse(record, "dynamic-overlap", pendingConflicts, "a pending workspace leases a changed path; re-sequence and re-validate");

      // IN THE WORKSPACE: canonical is untouched until the land.
      const message = `merge: workspace ${workspaceId} (${record.agentName})`;
      const judge: LedgerJudge = { record, targetTip };
      let mergeInProgress = false;
      // Back to the branch, the record back to `active`: nothing landed. The
      // worktree was verified clean when the merge began, so what the merge
      // and its phases wrote to tracked files is discarded with it.
      const restore = (reason: string, conflictReport: ConflictReport | null = null): void => {
        if (mergeInProgress) git.mergeAbort(worktreePath, timeouts.worktreeMs);
        moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
        saveTransition(conflictReport === null ? record : deepFreeze({ ...record, conflictReport }), "active", reason);
      };
      let mergeCommit: string;
      let mergeTree: string;
      const gateResults: WorkspaceGateResult[] = [];
      const resolved: string[] = [];
      let regenerated: readonly string[];
      let qualifiedSince: string;
      try {
        progress(`merge: ${branch} into ${target} at ${targetTip}, in ${worktreePath}`);
        moveWorktree(worktreePath, () => git.checkoutDetached(worktreePath, targetTip, timeouts.worktreeMs));
        await ensureTargetBaselines(record, worktreePath, "merge", targetTip, () => moveWorktree(worktreePath, () => git.checkoutDetached(worktreePath, targetTip, timeouts.worktreeMs, true)));
        let merged!: ReturnType<typeof git.mergeNoCommit>;
        moveWorktree(worktreePath, () => { merged = git.mergeNoCommit({ cwd: worktreePath, branch, message, timeoutMs: timeouts.worktreeMs, ...(options.identity === undefined ? {} : { identity: options.identity }) }); });
        mergeInProgress = true;
        // A conflict on a generated output whose branch-side change is
        // regeneration only is resolved to the target's side; the regenerate
        // phase re-derives it from the merged sources. Any other is reported.
        const resolvable = generationOnlyPaths(worktreePath, forkPoint, head, merged.conflictPaths, generated);
        const unresolved = merged.conflictPaths.filter((path) => !resolvable.has(path));
        if (unresolved.length > 0) {
          const conflictReport = buildConflictReport("textual-conflict", workspaceId, unresolved.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "textual merge conflict" })));
          restore("textual merge conflict; resolve it in the worktree (rebase) and re-validate", conflictReport);
          auditEvent("workspace-merge-refused", { workspaceId, kind: "textual-conflict", paths: unresolved });
          throw new WorkspaceConflictError(conflictReport);
        }
        resolved.push(...merged.conflictPaths);
        git.resolveToOurs(worktreePath, resolved, timeouts.worktreeMs);
        gateResults.push(...await runPhase(worktreePath, "regenerate", judge));
        if (gateResults.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "regenerate", gateResults);
        // The merge staged the branch's changes; what the phase wrote is on the working-tree side.
        regenerated = unstagedStatusPaths(git.status(worktreePath, timeouts.inspectMs));
        try {
          refuseUndeclaredWrites(regenerated, generated, "regenerate", "the regenerate phase", worktreePath);
        } catch (error) {
          if (!(error instanceof LandingError) || error.failure !== "undeclared_write") throw error;
          throw new HarnessError(error.message, "workspace_regenerate_undeclared_write", false, { workspaceId, paths: (error.facts["paths"] as readonly string[]).join(", ") });
        }
        git.addPaths(worktreePath, regenerated, timeouts.worktreeMs);
        // THE LANDING'S COMMIT (tree-landing.ts): the hooks run, then its postconditions — the staged tree, the parents [target, branch], no missing object.
        mergeTree = git.stageAll(worktreePath, timeouts.worktreeMs);
        try {
          mergeCommit = commitCandidate({
            git, root: worktreePath, message, tree: mergeTree, parents: [targetTip, head], timeoutMs: timeouts.mergeMs,
            ...(options.identity === undefined ? {} : { identity: options.identity }),
          }).commit;
        } catch (error) {
          if (!(error instanceof LandingError) || error.failure !== "commit_refused") throw error;
          throw new HarnessError(error.message, "workspace_merge_commit_refused", false, { workspaceId });
        }
        mergeInProgress = false;
        if (validated.full && validated.tree === mergeTree) {
          qualifiedSince = validated.startedAt;
          gateResults.push(persistedGate(builtinGate("merge-gates", "skip", `the merge's tree ${mergeTree} is the tree validate --full qualified`)));
        } else {
          qualifiedSince = iso(now());
          const mergeGates = await runPhase(worktreePath, "merge", judge);
          gateResults.push(...mergeGates);
          if (mergeGates.some((gate) => gate.status === "fail")) throw new WorkspaceGateFailedError(workspaceId, "merge", gateResults);
        }
        const left = statusPaths(git.status(worktreePath, timeouts.inspectMs));
        gateResults.push(persistedGate(builtinGate("converged", left.length === 0 ? "pass" : "fail", left.length === 0 ? "the gates left the merge as committed" : "the gates rewrote tracked paths: the merge is not converged", left)));
        if (left.length > 0) {
          throw new HarnessError(`the merge gates rewrote ${left.join(", ")}: the merge is not converged`, "workspace_gates_not_converged", false, { workspaceId, paths: left.join(", ") });
        }
      } catch (error) {
        if (!(error instanceof WorkspaceConflictError)) {
          restore(`merge failed before the land: ${error instanceof Error ? error.message : String(error)}`);
          auditEvent("workspace-merge-refused", { workspaceId, code: (error as { code?: unknown }).code ?? "unknown" });
        }
        throw error;
      }

      let landed: Readonly<{ landing: WorkspaceLanding; landedIn: string | null }>;
      try {
        progress(`land: ${mergeCommit} on ${target}`);
        landed = landLocally(record, mergeCommit, targetTip);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "workspace_overlay_adoption_incomplete") {
          moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
          // A land git refused (a dirty overlap, the target moved) changed
          // nothing the validation judged: the workspace stays validated, and
          // the next merge rebuilds and gates its merge commit.
          const current = requireRecord(workspaceId);
          if (current.state === "merging") saveTransition(current, "validating", `land refused: ${error instanceof Error ? error.message : String(error)}`);
        }
        auditEvent("workspace-land-refused", { workspaceId, code: (error as { code?: unknown }).code ?? "unknown" });
        throw error;
      }
      return finishLanded(record, {
        mergeCommit, mergeTree, landing: landed.landing, landedIn: landed.landedIn, targetTip, changedPaths,
        regenerated, resolved, gateResults, imported: importQualifyingRuns(record, landed.landedIn, qualifiedSince, mergeTree),
      });
    });
  }

  /**
   * After the land: the timeline import, the teardown and the hashed
   * receipt; the record becomes `merged`. A failure here (the land already
   * happened) leaves the record `merging` with no integrator: `recover`
   * finishes it.
   */
  /**
   * The workspace's timeline shard imported into the canonical ledger (a
   * land's and a merge's last step before the teardown). Appenders do not
   * share the merge lock: the source is retained even after a successful
   * bounded import; a tip check cannot authorize its deletion.
   */
  function importTimeline(workspaceId: string): Readonly<{ importedEvents: number; skippedEvents: number }> {
    if (timeline === null) return { importedEvents: 0, skippedEvents: 0 };
    const shard = timeline.openShard(workspaceId);
    try {
      const canonicalStore = timeline.openCanonical();
      try {
        const importResult = importWorkspaceTimelineShard({ shard, canonical: canonicalStore, ...(timeline.queryDefaultLimit !== undefined ? { queryDefaultLimit: timeline.queryDefaultLimit } : {}) });
        return { importedEvents: importResult.imported, skippedEvents: importResult.skipped };
      } finally {
        canonicalStore.close();
      }
    } finally {
      shard.close();
    }
  }

  function finishLanded(record: WorkspaceRecord, landed: Readonly<{
    mergeCommit: string; mergeTree: string; landing: WorkspaceLanding; landedIn: string | null; targetTip: string;
    changedPaths: readonly string[]; regenerated: readonly string[]; resolved: readonly string[];
    gateResults: readonly WorkspaceGateResult[]; imported: readonly string[];
  }>): MergeReceipt {
    const { workspaceId } = record;
    const branch = record.lease.branch!;
    const target = record.lease.targetBranch!;
    auditEvent("workspace-landed", { workspaceId, targetBranch: target, mergeCommit: landed.mergeCommit, landing: landed.landing, importedRuns: landed.imported });

    const { importedEvents, skippedEvents } = importTimeline(workspaceId);

    removeGateLogs(record.lease.worktreePath);
    git.worktreeRemove({ repoRoot: checkoutRoot, worktreePath: record.lease.worktreePath, force: true, timeoutMs: timeouts.worktreeMs });
    git.deleteBranch(checkoutRoot, branch, true, timeouts.worktreeMs);

    const receipt = finalizeMergeReceipt({
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      workspaceId,
      agentName: record.agentName,
      branch,
      targetBranch: target,
      baseSha: record.lease.baseSha,
      preMergeHeadSha: landed.targetTip,
      mergeCommitSha: landed.mergeCommit,
      mergeTree: landed.mergeTree,
      landing: landed.landing,
      landedIn: landed.landedIn,
      changedPaths: deepFreeze([...landed.changedPaths]),
      regeneratedPaths: deepFreeze([...landed.regenerated]),
      resolvedConflicts: deepFreeze([...landed.resolved]),
      importedRuns: deepFreeze([...landed.imported]),
      timelineImportedEvents: importedEvents,
      timelineSkippedEvents: skippedEvents,
      gateResults: deepFreeze([...landed.gateResults]),
      frozenAcceptances: frozenAcceptancesBetween(checkoutRoot, landed.targetTip, landed.mergeCommit),
      mergedAt: iso(now()),
    });
    const mergedRecord = saveTransition(deepFreeze({ ...record, mergeReceipt: receipt, changedPaths: deepFreeze([...landed.changedPaths]) }), "merged", "workspace landed and torn down");
    recordTimelineEvent("canonical", mergedRecord, `workspace-merged receipt=${receipt.receiptHash}`, "succeeded");
    return receipt;
  }

  /**
   * RECOVER a workspace whose integrator died mid-merge (killed, out of
   * memory, an agent tool timeout), leaving its record `merging` with nobody
   * to finish it. Under the merge lock, taken WITHOUT WAITING: an integrator
   * holds it for its whole merge, so a held lock means one is running
   * (`workspace_recover_denied`), and the lock owner reclaims a dead
   * holder's lock — holding it proves no integrator runs. Then: if the target
   * already contains the branch's work (or the teardown already removed the
   * branch), the land happened, so the teardown is finished and the record
   * is `merged` (its receipt died with the integrator); otherwise the
   * worktree goes back to its branch (`merge --abort`, `checkout -f`) and the
   * record to `active` (`quarantined` when the worktree is gone). Any other
   * state is returned as it is.
   */
  async function recover(workspaceId: string): Promise<WorkspaceRecord> {
    const record = requireOwnedRecord(workspaceId);
    // A land through the forge: one look at the forge (its integrator is the queue, never a local process).
    if (record.state === "merging" && landInFlight(record) !== null) return recoverForgeLand(record);
    try {
      return await withRepositoryLock({ ...config.mergeLock, timeoutMs: 0 }, `workspace-recover:${workspaceId}`, () => recoverUnderMergeLock(requireOwnedRecord(workspaceId)));
    } catch (error) {
      if ((error as { code?: unknown }).code !== "lock_acquisition_timeout") throw error;
      throw new InputError(`an integrator holds the merge lock (it is running): workspace ${workspaceId} is not stuck`, "workspace_recover_denied");
    }
  }

  function recoverUnderMergeLock(record: WorkspaceRecord): WorkspaceRecord {
    if (record.state !== "merging") return record;
    const branch = record.lease.branch!;
    const target = record.lease.targetBranch!;
    const branchHead = git.branchTip(checkoutRoot, branch, timeouts.inspectMs);
    const targetTip = git.revParse(checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
    const worktreePath = record.lease.worktreePath;
    if (branchHead === null || git.isAncestor(checkoutRoot, branchHead, targetTip, timeouts.inspectMs)) {
      removeWorktreeAndBranch(record);
      const merged = saveTransition(record, "merged", `recovered: the land on ${target} had happened (${targetTip}); the teardown is finished, the receipt was lost with the integrator`);
      auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "merged", targetTip });
      return merged;
    }
    if (!git.verifyWorktreeIntact(worktreePath, timeouts.inspectMs)) {
      return quarantineRecord(record, "recovered: the integrator died before the land and the worktree is gone");
    }
    try {
      git.mergeAbort(worktreePath, timeouts.worktreeMs);
    } catch (error) {
      // No merge in progress (the integrator died before or after it).
      if (!(error instanceof HarnessError)) throw error;
    }
    moveWorktree(worktreePath, () => git.checkoutBranch(worktreePath, branch, timeouts.worktreeMs, true));
    const active = saveTransition(record, "active", "recovered: the integrator died before the land; nothing landed");
    auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "active" });
    return active;
  }

  /**
   * THE LOCAL FOLLOW of a forge land: the local target follows the trunk's
   * tip — the overlay's adoption into the checkout it came from, else the
   * tree landing's land (a fast-forward of the checkout that has the target,
   * or a compare-and-swap of the ref). The land already happened on the
   * forge, so git's refusal (a dirty overlap, local commits the trunk does not
   * hold, a stale overlay) is RECORDED, never thrown: the receipt names it.
   */
  function followTrunk(record: WorkspaceRecord, trunk: string): Readonly<{ follow: WorkspaceFollow; followedIn: string | null; refusal: string | null }> {
    const target = record.lease.targetBranch!;
    const overlay = record.lease.overlay;
    const localTip = git.revParse(overlay?.checkout ?? checkoutRoot, `refs/heads/${target}`, timeouts.inspectMs);
    const refused = (refusal: string): Readonly<{ follow: WorkspaceFollow; followedIn: string | null; refusal: string }> => {
      auditEvent("workspace-follow-refused", { workspaceId: record.workspaceId, targetBranch: target, refusal });
      return deepFreeze({ follow: "refused", followedIn: null, refusal });
    };
    if (localTip === trunk) return deepFreeze({ follow: "current", followedIn: null, refusal: null });
    if (!git.isAncestor(checkoutRoot, localTip, trunk, timeouts.inspectMs)) return refused(`${target} holds commits the trunk ${trunk} does not (${localTip}): it was not moved`);
    if (overlay !== null) {
      const stale = overlayStaleness(record, overlay, localTip);
      if (stale.length > 0) return refused(`the overlay of ${overlay.checkout} is stale (${stale.join("; ")}): the checkout was touched after the overlay was taken, so it did not adopt the trunk`);
      try {
        adoptOverlay(record, overlay, trunk, localTip);
      } catch (error) {
        if (!(error instanceof HarnessError)) throw error;
        return refused(error.message);
      }
      return deepFreeze({ follow: "overlay-adoption", followedIn: overlay.checkout, refusal: null });
    }
    const outcome = landCommit(git, checkoutRoot, target, trunk, localTip, options.engineRelative, timeouts.worktreeMs);
    if (outcome.refusal !== null) return refused(`git refused to move ${target}${outcome.landedIn === null ? "" : ` in ${outcome.landedIn}`}: ${outcome.refusal}`);
    return deepFreeze({ follow: outcome.landing, followedIn: outcome.landedIn, refusal: null });
  }

  /**
   * LAND (`ws land`, github-only §5.3, §6.1): the published, ready head whose
   * tree passed `validate` enters the forge's merge queue — `enqueue` with
   * the head this workspace published as `expectedHeadSha` (a push in between
   * refuses it), never auto-merge — and the land is awaited: merged at
   * EXACTLY that head → the local follow, the teardown and the land receipt;
   * merged at any other head → refused (`workspace_land_foreign_head`), no
   * receipt. Before the request, the harness's own judgement against the
   * trunk as fetched now: the land target (the upstream trunk), the lease, the
   * overlay's checkout, the paths landed since the fork point, the staleness
   * budget and the pending leases — refused as a conflict, the record back to
   * `active`. A record already `merging` through the forge is resumed.
   */
  async function land(workspaceId: string): Promise<LandReceipt> {
    let record = requireOwnedRecord(workspaceId);
    if (record.lease.kind === "read-only") throw new InputError(`workspace ${workspaceId} is read-only: it never lands`, "workspace_read_only");
    // Landed already (this land, another, or a recover finished it): its receipt.
    const landed = landedReceipt(record);
    if (landed !== null) return landed;
    if (record.state === "merging" && landInFlight(record) === null) {
      throw new InputError(`workspace ${workspaceId} is being merged by the local integrator (ws merge), not landed through the forge`, "workspace_precondition_failed");
    }
    if (record.state !== "merging") record = await requestLand(record);
    return awaitLand(record);
  }

  /** The land receipt of a record the forge landed (`merged` through `land`), or null. */
  function landedReceipt(record: WorkspaceRecord): LandReceipt | null {
    const receipt = record.mergeReceipt;
    // An older version's land receipt belongs to a record this version never changes (its store is read-only).
    return record.state === "merged" && receipt !== null && "kind" in receipt && receipt.schemaVersion === WORKSPACE_SCHEMA_VERSION ? receipt as LandReceipt : null;
  }

  /** The land in flight of a record (the head the queue was asked for), or null. */
  function landInFlight(record: WorkspaceRecord): string | null {
    return record.forge !== null && !isLegacyForgeState(record.forge) ? record.forge.land?.head ?? null : null;
  }

  async function requestLand(initial: WorkspaceRecord): Promise<WorkspaceRecord> {
    let record = initial;
    const { workspaceId } = record;
    const validated = record.validationReport;
    if (record.state !== "validating" || validated === null || validated.status !== "pass") {
      throw new InputError(`workspace ${workspaceId} is not validated (state=${record.state})`, "workspace_land_precondition_failed");
    }
    await assertLeaseLive(record);
    assertWorktreeIntact(record);
    const { forge, target, state } = forgeOf(record);
    assertLandable(target.trunk);
    if (state.pullRequest === null || state.publishedHead === null) {
      throw new InputError(`workspace ${workspaceId} has no pull request yet: publish a round first`, "workspace_not_published");
    }
    if (!state.ready) throw new InputError(`pull request #${String(state.pullRequest.number)} is not ready for review: ready it first`, "workspace_not_ready");
    const worktreePath = record.lease.worktreePath;
    const head = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
    if (head !== state.publishedHead || git.status(worktreePath, timeouts.inspectMs).length > 0) {
      throw new InputError(`workspace ${workspaceId} holds work its last round did not publish (published ${state.publishedHead}, HEAD ${head}): publish, validate and ready it again`, "workspace_unpublished_commits");
    }
    if (git.revParse(worktreePath, `${head}^{tree}`, timeouts.inspectMs) !== validated.tree) {
      throw new InputError(`workspace ${workspaceId}'s validation is of another tree than its published head: validate it again`, "workspace_validation_stale");
    }
    assertStackLanded(record, head);

    // The harness's judgement, against the trunk as the forge holds it now.
    fetchForgeBranches(git, worktreePath, target.remote, [target.trunk], timeouts.fetchMs);
    const trunk = trunkTip(record, target);
    const forkPoint = git.mergeBase(worktreePath, trunk, head, timeouts.inspectMs);
    const { changed, exempt } = branchChange(worktreePath, forkPoint, head);
    const authored = changed.filter((path) => !exempt.has(path));
    const unleased = computeUnleasedPaths(changed, record.lease.writeSet, exempt);
    if (unleased.length > 0) {
      refuse(record, "dynamic-overlap", unleased.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "changed path is outside the declared write set" })), "changed set escaped the write set at land");
    }
    if (record.lease.overlay !== null) {
      const stale = overlayStaleness(record, record.lease.overlay, git.revParse(record.lease.overlay.checkout, `refs/heads/${record.lease.targetBranch!}`, timeouts.inspectMs));
      if (stale.length > 0) {
        saveTransition(record, "active", `overlay stale: ${stale.join("; ")}`);
        throw new HarnessError(`the overlay of ${record.lease.overlay.checkout} is stale (${stale.join("; ")}); the checkout was touched after the overlay was taken — abort this workspace and take a new overlay`, "workspace_overlay_stale", false, { workspaceId });
      }
    }
    if (forkPoint !== trunk) {
      const staleness = git.revListCount(worktreePath, forkPoint, trunk, timeouts.inspectMs);
      const merged = git.diffNameOnly({ cwd: worktreePath, refA: forkPoint, refB: trunk, threeDot: false, timeoutMs: timeouts.inspectMs });
      const mergedExempt = generationOnlyPaths(worktreePath, forkPoint, trunk, merged, generatedOutputPaths(worktreePath));
      const mergedConflicts = computeMergedSinceConflicts(authored, merged.filter((path) => !mergedExempt.has(path)));
      if (mergedConflicts.length > 0) refuse(record, "dynamic-overlap", mergedConflicts, "a path landed on the trunk since the fork point; rebase, publish and re-validate");
      if (staleness > config.baseStalenessCommits) {
        refuse(record, "dynamic-overlap", [deepFreeze({ path: "(base)", otherWorkspaceId: null, reason: `${target.trunk} moved ${String(staleness)} commits since the fork point (budget ${String(config.baseStalenessCommits)}); rebase required` })], "base too stale; rebase, publish and re-validate");
      }
    }
    const pending = pendingFeatureLeases(workspaceId).map((other) => deepFreeze({ workspaceId: other.workspaceId, writeSet: other.lease.writeSet }));
    const pendingConflicts = computePendingWriteSetConflicts(authored, pending);
    if (pendingConflicts.length > 0) refuse(record, "dynamic-overlap", pendingConflicts, "a pending workspace leases a changed path; re-sequence and re-validate");

    const number = state.pullRequest.number;
    const current = await forge.pullRequest(number);
    // A merged one is an answer (a land another tool finished), never a refusal: its head is judged after the merge.
    if (!current.merged) assertOpenAtPublishedHead(record, current, head);
    // THE QUEUE PREFLIGHT: never enter a queue that would drop this pull request (workspace-forge.ts). It is
    // read-only and runs BEFORE the record moves: a preflight that fails — a conflict, or the forge or git
    // failing to answer — leaves the workspace exactly as it was, never `merging` with nothing queued (which
    // `recover` would later read as a dequeue). Not asked of a land already merged or queued at this head.
    if (!current.merged && !current.queued) {
      const queued = (await forge.mergeQueue(target.trunk)).filter((entry) => entry.number !== number);
      const conflict = queuePreflightConflict(git, worktreePath, target.remote, trunk, queued, head, timeouts);
      if (conflict !== null) {
        auditEvent("workspace-land-queue-conflict", { workspaceId, pullRequest: number, head, paths: conflict.paths.join(","), ahead: conflict.ahead.join(",") });
        throw new HarnessError(
          `pull request #${String(number)} conflicts with the merge queue ahead of it (${conflict.ahead.length === 0 ? "the trunk" : `#${conflict.ahead.join(", #")}`}) in ${conflict.paths.join(", ")}: ` +
            "the queue would drop it — wait for those to land, rebase onto the trunk, publish and validate again",
          "workspace_queue_conflict", false, { workspaceId, paths: conflict.paths.join(","), ahead: conflict.ahead.join(",") },
        );
      }
    }
    // `merging` BEFORE the request, naming the one head that may land: a land that dies after it is found by `recover`.
    record = store.save(transition(deepFreeze({ ...record, forge: deepFreeze({ ...state, land: deepFreeze({ head }) }) }), "merging", `the land of ${head} was requested (pull request #${String(number)})`));
    // Already merged (a land another tool finished) or already queued at this head: nothing to ask, only to wait.
    if (current.merged || current.queued) return record;
    progress(`land: pull request #${String(number)} at ${head} into the ${target.trunk} merge queue`);
    const answer = await forge.enqueue(number, { expectedHeadSha: head });
    auditEvent("workspace-land-requested", { workspaceId, pullRequest: number, head, answer: answer.kind });
    if (answer.kind === "refused") {
      endLand(record, "validating", `the forge refused to queue the land: ${answer.message}`);
      throw new HarnessError(`the forge refused to queue pull request #${String(number)}: ${answer.message}`, "workspace_enqueue_refused", false, { workspaceId });
    }
    if (answer.headSha !== head) {
      endLand(record, "active", `the forge queued ${answer.headSha}, not the published ${head}`);
      throw new HarnessError(`the forge queued pull request #${String(number)} at ${answer.headSha}, not at the head this workspace published (${head}): dequeue it on the forge`, "workspace_land_foreign_head", false, { workspaceId });
    }
    return record;
  }

  /** One look at a land in flight: ONE read of the pull request's whole state. */
  async function landOutcome(record: WorkspaceRecord, forge: WorkspaceForge): Promise<
    | Readonly<{ kind: "waiting" }>
    | Readonly<{ kind: "merged"; mergeCommitSha: string }>
    | Readonly<{ kind: "ended"; code: string; reason: string }>
  > {
    const state = record.forge as WorkspaceForgeState;
    const number = state.pullRequest!.number;
    const pull = await forge.pullRequest(number);
    if (pull.merged && pull.mergeCommitSha !== null) return { kind: "merged", mergeCommitSha: pull.mergeCommitSha };
    if (pull.state !== "open") return { kind: "ended", code: "workspace_pull_request_closed", reason: `pull request #${String(number)} was closed without landing` };
    if (pull.headSha !== state.land!.head) return { kind: "ended", code: "workspace_published_head_moved", reason: `pull request #${String(number)}'s head moved to ${pull.headSha} while it waited to land at ${state.land!.head}: the queue drops it` };
    if (pull.queued) return { kind: "waiting" };
    return { kind: "ended", code: "workspace_land_dequeued", reason: `pull request #${String(number)} left the merge queue without landing (its group failed, or it was removed): the queue judged it — fix the cause, publish, validate and ready it again` };
  }

  /** Waits on a land in flight (see {@link land}); stops waiting after `landing.timeoutMs`, the record still `merging`. */
  async function awaitLand(initial: WorkspaceRecord): Promise<LandReceipt> {
    const { workspaceId } = initial;
    const { forge } = forgeOf(initial, "recorded");
    const number = (initial.forge as WorkspaceForgeState).pullRequest!.number;
    const deadline = now().getTime() + config.landing.timeoutMs;
    for (;;) {
      const record = requireRecord(workspaceId);
      const landed = landedReceipt(record);
      if (landed !== null) return landed;
      const outcome = await landOutcome(record, forge);
      if (outcome.kind === "merged") return finishForgeLand(workspaceId, outcome.mergeCommitSha);
      if (outcome.kind === "ended") {
        endLand(record, "active", outcome.reason);
        throw new HarnessError(outcome.reason, outcome.code, false, { workspaceId });
      }
      if (now().getTime() >= deadline) {
        throw new HarnessError(`pull request #${String(number)} has not landed after ${String(config.landing.timeoutMs)}ms (in the merge queue): workspace land ${workspaceId} resumes the wait`, "workspace_land_pending", true, { workspaceId });
      }
      progress(`land: pull request #${String(number)} is in the merge queue`);
      await sleep(config.landing.pollIntervalMs);
    }
  }

  /** A land that ended without landing: the record back to `to`, the land forgotten. */
  function endLand(record: WorkspaceRecord, to: "active" | "validating", reason: string): WorkspaceRecord {
    auditEvent("workspace-land-ended", { workspaceId: record.workspaceId, reason });
    return saveTransition(deepFreeze({ ...record, forge: deepFreeze({ ...(record.forge as WorkspaceForgeState), land: null }) }), to, reason);
  }

  /**
   * After the forge merged it (under the merge lock: the local follow is a
   * ref move): the trunk is fetched (it must hold the merge commit:
   * `workspace_land_unconfirmed`), the merge commit's second parent must be
   * EXACTLY the head the queue was asked for — any other head is refused
   * (`workspace_land_foreign_head`) and no receipt is written; then the local
   * follow, the qualifying runs and the timeline imported, the teardown (the
   * worktree and the local branch; the forge's branch is the forge's), the
   * hashed land receipt; the record becomes `merged`. Idempotent: a record
   * another land or recover already finished answers its receipt.
   */
  async function finishForgeLand(workspaceId: string, mergeCommitSha: string): Promise<LandReceipt> {
    return withRepositoryLock(config.mergeLock, `workspace-land:${workspaceId}`, () => {
      const record = requireOwnedRecord(workspaceId);
      const landed = landedReceipt(record);
      if (landed !== null) return landed;
      const land = landInFlight(record);
      if (record.state !== "merging" || land === null) throw new InputError(`workspace ${workspaceId} is ${record.state} with no land in flight`, "workspace_precondition_failed");
      const state = record.forge as WorkspaceForgeState;
      fetchForgeBranches(git, checkoutRoot, state.remote, [state.trunk], timeouts.fetchMs);
      const trunk = git.revParse(checkoutRoot, remoteTrackingRef(state.remote, state.trunk), timeouts.inspectMs);
      // A merge commit the trunk does not hold was never fetched here: absent is unconfirmed too, never git's error.
      if (!holdsCommit(mergeCommitSha) || !git.isAncestor(checkoutRoot, mergeCommitSha, trunk, timeouts.inspectMs)) {
        throw new HarnessError(`the forge reported ${mergeCommitSha} merged, but ${state.remote}/${state.trunk} (${trunk}) does not hold it`, "workspace_land_unconfirmed", true, { workspaceId });
      }
      const landedHead = secondParentOf(mergeCommitSha);
      if (landedHead !== land) {
        endLand(record, "active", `the forge merged ${landedHead ?? "no second parent"}, not the published ${land}`);
        throw new HarnessError(`pull request #${String(state.pullRequest!.number)} was merged at ${landedHead ?? "(a commit with no second parent)"}, not at the head this workspace published and asked the queue for (${land}): no receipt is written — inspect what landed`, "workspace_land_foreign_head", false, { workspaceId });
      }
      const mergeTree = git.revParse(checkoutRoot, `${mergeCommitSha}^{tree}`, timeouts.inspectMs);
      const preMergeHeadSha = git.revParse(checkoutRoot, `${mergeCommitSha}^1`, timeouts.inspectMs);
      progress(`land: ${mergeCommitSha} landed on ${state.trunk}; following it locally`);
      const followed = followTrunk(record, trunk);
      const validated = record.validationReport!;
      const imported = importQualifyingRuns(record, followed.followedIn, validated.startedAt, mergeTree);
      auditEvent("workspace-landed", { workspaceId, trunk: state.trunk, mergeCommit: mergeCommitSha, follow: followed.follow, importedRuns: imported });
      const { importedEvents, skippedEvents } = importTimeline(workspaceId);
      removeWorktreeAndBranch(record);
      const receipt = finalizeLandReceipt({
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        kind: "land",
        workspaceId,
        agentName: record.agentName,
        branch: record.lease.branch!,
        targetBranch: record.lease.targetBranch!,
        remote: state.remote,
        trunk: state.trunk,
        pullRequest: state.pullRequest!,
        landedHead,
        baseSha: record.lease.baseSha,
        preMergeHeadSha,
        mergeCommitSha,
        mergeTree,
        trunkTip: trunk,
        follow: followed.follow,
        followedIn: followed.followedIn,
        followRefusal: followed.refusal === null ? null : recordedReason(followed.refusal),
        changedPaths: deepFreeze([...validated.changedPaths]),
        importedRuns: deepFreeze([...imported]),
        timelineImportedEvents: importedEvents,
        timelineSkippedEvents: skippedEvents,
        gateResults: deepFreeze([...validated.gates]),
        mergedAt: iso(now()),
      });
      const merged = saveTransition(deepFreeze({ ...record, mergeReceipt: receipt, changedPaths: deepFreeze([...validated.changedPaths]), forge: deepFreeze({ ...state, land: null }) }), "merged", "landed on the forge and torn down");
      recordTimelineEvent("canonical", merged, `workspace-landed receipt=${receipt.receiptHash}`, "succeeded");
      return receipt;
    });
  }

  /** One look at a forge land in flight (`recover`, `sweep`): merged → finished; ended → `active`; still queued → as it is. */
  async function recoverForgeLand(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    const outcome = await landOutcome(record, forgeOf(record, "recorded").forge);
    if (outcome.kind === "merged") {
      await finishForgeLand(record.workspaceId, outcome.mergeCommitSha);
      auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "landed" });
      return requireRecord(record.workspaceId);
    }
    if (outcome.kind === "ended") {
      auditEvent("workspace-recovered", { workspaceId: record.workspaceId, outcome: "active" });
      return endLand(record, "active", outcome.reason);
    }
    return record;
  }

  /** Whether this repository holds the commit `sha`. */
  function holdsCommit(sha: string): boolean {
    return gitOutput(options.repository(checkoutRoot), ["rev-parse", "-q", "--verify", `${sha}^{commit}`], { allowed: [0, 1] }).status === 0;
  }

  /** The second parent of `commit` in this repository (a merge's merged head), or null when it has none. */
  function secondParentOf(commit: string): string | null {
    // `rev-list --parents` answers the commit, then its parents.
    const [, , second] = gitOutput(options.repository(checkoutRoot), ["rev-list", "--parents", "-n", "1", commit]).stdout.toString("utf8").trim().split(" ");
    return second ?? null;
  }

  /**
   * The forge client of a feature workspace's target, and the target as git
   * names it now: an upstream changed since create (another remote or trunk)
   * is refused, never followed (`workspace_target_upstream_changed`).
   */
  function forgeOf(record: WorkspaceRecord, which: "upstream" | "recorded" = "upstream"): Readonly<{ forge: WorkspaceForge; target: ForgeTarget; state: WorkspaceForgeState }> {
    const state = record.forge;
    if (state === null) throw new InputError(`workspace ${record.workspaceId} is read-only: it never reaches the forge`, "workspace_read_only");
    if (isLegacyForgeState(state)) {
      // Only an older store's workspace carries the legacy marker, and every verb that reaches here refused it already.
      throw new InputError(`workspace ${record.workspaceId} was made before the forge: it never reaches the forge`, "workspace_owned_by_v2_checkout");
    }
    if (options.forge === undefined) {
      throw new HarnessError("this workspace manager was made without a forge (the workspace CLI's is githubWorkspaceForgeFactory): it cannot reach the forge", "workspace_forge_unavailable", false, { workspaceId: record.workspaceId });
    }
    const repository = options.repository(checkoutRoot);
    // `recorded`: the remote this workspace was made for (an abort, a land in flight); `upstream`: its target's upstream now, which must still be that one.
    const target = which === "recorded"
      ? Object.freeze({ remote: state.remote, remoteUrl: remoteUrlOf(repository, state.remote), trunk: state.trunk })
      : resolveForgeTarget(repository, record.lease.targetBranch!);
    if (target.remote !== state.remote || target.trunk !== state.trunk) {
      throw new InputError(`${record.lease.targetBranch!}'s upstream is ${target.remote}/${target.trunk} now, but the workspace was created for ${state.remote}/${state.trunk}: abort it and create a new one`, "workspace_target_upstream_changed");
    }
    // Frozen shallowly: the client is the composition root's object, never the manager's to freeze.
    return Object.freeze({ forge: options.forge(target), target, state });
  }

  /** A feature workspace a forge verb may act on: not read-only, not terminal, not merging; its lease live and its worktree intact. */
  async function requireForgeable(workspaceId: string, verb: string): Promise<WorkspaceRecord> {
    const record = requireOwnedRecord(workspaceId);
    if (record.lease.kind === "read-only") throw new InputError(`workspace ${workspaceId} is read-only: it never reaches the forge`, "workspace_read_only");
    if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
    if (record.state !== "active" && record.state !== "validating") {
      throw new InputError(`workspace ${workspaceId} cannot ${verb} from ${record.state}`, "workspace_precondition_failed");
    }
    await assertLeaseLive(record);
    assertWorktreeIntact(record);
    return record;
  }

  /** The tracked trunk as last fetched, in the workspace's repository. */
  function trunkTip(record: WorkspaceRecord, target: ForgeTarget): string {
    return git.revParse(record.lease.worktreePath, remoteTrackingRef(target.remote, target.trunk), timeouts.inspectMs);
  }

  /**
   * PUBLISH one round (see `workspace-forge.ts`): a clean worktree whose
   * changes since the trunk are inside the lease (judged against the trunk as
   * fetched now: what the pull request carries) is published as signed twins;
   * the first round opens the DRAFT pull request (or adopts the one a crashed
   * round opened), every later one regenerates its title and body.
   */
  async function publish(workspaceId: string): Promise<WorkspacePublication> {
    // One round at a time per workspace: two concurrent publishes would both make twins.
    ensurePrivateStateDirectory(lockDirectory);
    const lock = await acquireLock(registry.root, `workspace-publish.${workspaceId.toLowerCase()}`, { lockDirectory, timeoutMs: config.mergeLock.timeoutMs, unreadableAfterMs: config.mergeLock.staleMs, owner: `workspace-publish:${workspaceId}` });
    try {
      return await publishRound(workspaceId);
    } finally {
      lock.release();
    }
  }

  async function publishRound(workspaceId: string): Promise<WorkspacePublication> {
    const record = await requireForgeable(workspaceId, "publish");
    const worktreePath = record.lease.worktreePath;
    const branch = record.lease.branch!;
    const { forge, target, state } = forgeOf(record);
    const dirty = git.status(worktreePath, timeouts.inspectMs);
    if (dirty.length > 0) {
      throw new InputError(`workspace ${workspaceId} has uncommitted changes (${statusPaths(dirty).slice(0, WORKSPACE_REFUSAL_PATHS_NAMED).join(", ")}): a round publishes commits`, "workspace_publish_dirty");
    }
    fetchForgeBranches(git, worktreePath, target.remote, [target.trunk], timeouts.fetchMs);
    const head = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
    const stacked = stackBase(record, head);
    const { changed, exempt } = branchChange(worktreePath, stacked ?? git.mergeBase(worktreePath, trunkTip(record, target), head, timeouts.inspectMs), head);
    const unleased = computeUnleasedPaths(changed, record.lease.writeSet, exempt);
    if (unleased.length > 0) {
      throw new WorkspaceConflictError(buildConflictReport("dynamic-overlap", workspaceId, unleased.map((path) => deepFreeze({ path, otherWorkspaceId: null, reason: "changed path is outside the declared write set" }))));
    }
    progress(`publish: ${branch} to ${target.remote}`);
    const round = await publishBranch({ forge, repository: options.repository(worktreePath), git, target, branch, expectedHead: state.publishedHead, stackBase: stacked, fetchMs: timeouts.fetchMs });
    // THE READY GATE HOLDS ON EVERY ROUND: a new head is not what was made
    // ready (its tree was never judged ready), so a ready pull request goes
    // back to draft and the record forgets `ready` until `ready` is earned again.
    const newHead = round.head !== state.publishedHead;
    const published: WorkspaceRecord = deepFreeze({ ...record, forge: deepFreeze({ ...state, publishedHead: round.head, ready: state.ready && !newHead }) });
    const { title, body } = pullRequestText(published, round.head, target, stacked);
    let pullRequest = state.pullRequest;
    if (pullRequest === null) {
      const found = await forge.findPullRequest(branch);
      if (found !== null && found.base !== target.trunk) {
        throw new InputError(`pull request #${String(found.number)} for ${branch} is opened against ${found.base}, not ${target.trunk}: it is not this workspace's — close it`, "workspace_pull_request_base_mismatch");
      }
      const opened = found ?? await forge.openDraftPullRequest({ head: branch, base: target.trunk, title, body });
      pullRequest = deepFreeze({ number: opened.number, url: opened.url });
    } else if (state.ready && newHead) {
      await forge.convertToDraft(pullRequest.number);
      auditEvent("workspace-ready-withdrawn", { workspaceId, pullRequest: pullRequest.number, head: round.head });
    }
    await forge.updatePullRequest(pullRequest.number, { title, body });
    const saved = store.save(deepFreeze({ ...published, forge: deepFreeze({ ...published.forge!, pullRequest }) }));
    recordTimelineEvent("shard", saved, `workspace-published head=${round.head} commits=${String(round.commits.length)} pr=${String(pullRequest.number)}`, "succeeded");
    auditEvent("workspace-published", { workspaceId, head: round.head, commits: round.commits.length, blobs: round.blobs, pullRequest: pullRequest.number });
    return deepFreeze({ record: saved, round });
  }

  /** The body's stack lines: the parent this pull request waits for, and where its own diff begins. */
  function stackNotice(record: WorkspaceRecord, stacked: string | null): readonly string[] {
    if (stacked === null) return [];
    const parent = store.load(stackParentOf(record)!)!;
    const number = (parent.forge as WorkspaceForgeState).pullRequest?.number;
    return [
      `**Stacked on** ${number === undefined ? `\`${parent.workspaceId}\`` : `#${String(number)}`} (workspace \`${parent.workspaceId}\`): until it lands, this pull request also carries its commits. This one's own change begins after \`${stacked.slice(0, WORKSPACE_SHORT_ID_CHARACTERS)}\`, and it lands only after its parent.`,
      "",
    ];
  }

  /**
   * The pull request's generated title and body: the branch's first commit
   * subject; the workspace, its lease, its commits and the local validation of
   * the published tree. Gate names and verdicts only, never a gate's words (a
   * message may name a local path).
   */
  function pullRequestText(record: WorkspaceRecord, head: string, target: ForgeTarget, stacked: string | null): Readonly<{ title: string; body: string }> {
    const worktreePath = record.lease.worktreePath;
    const repository = options.repository(worktreePath);
    // A stacked workspace's own commits: what it adds beyond its parent's published head.
    const commits = gitOutput(repository, ["log", "--reverse", "--format=%h%x09%s", `${remoteTrackingRef(target.remote, target.trunk)}..${head}`, ...(stacked === null ? [] : [`^${stacked}`])]).stdout.toString("utf8")
      .split("\n").filter((line) => line.length > 0).map((line) => line.split("\t") as [string, string]);
    const tree = git.revParse(worktreePath, `${head}^{tree}`, timeouts.inspectMs);
    const validated = record.validationReport;
    const validation = validated === null || validated.tree !== tree
      ? ["Not validated at this tree yet (`ws validate`)."]
      : [`${validated.status === "pass" ? "Passed" : "Failed"}${validated.full ? " (full)" : ""} at ${validated.validatedAt}.`, "", "| Gate | Verdict |", "|---|---|",
        ...validated.gates.map((gate) => `| \`${gate.gate}\` | ${gate.status} |`)];
    const body = [
      `<!-- bridlewise:workspace ${record.workspaceId} — generated by \`ws publish\` on every round; edits are overwritten -->`,
      `**Workspace** \`${record.workspaceId}\` · **agent** \`${record.agentName}\` · **base** \`${record.lease.baseSha.slice(0, WORKSPACE_SHORT_ID_CHARACTERS)}\` on \`${target.trunk}\` · **head** \`${head.slice(0, WORKSPACE_SHORT_ID_CHARACTERS)}\` (tree \`${tree.slice(0, WORKSPACE_SHORT_ID_CHARACTERS)}\`)`,
      "",
      ...stackNotice(record, stacked),
      "### Write set",
      ...record.lease.writeSet.map((path) => `- \`${path}\``),
      "",
      "### Commits",
      ...commits.map(([sha, subject]) => `- \`${sha}\` ${subject}`),
      "",
      "### Local validation",
      ...validation,
      "",
    ].join("\n");
    return deepFreeze({ title: commits[0]?.[1] ?? `workspace ${record.workspaceId}`, body });
  }

  /**
   * READY: the pull request leaves draft for review (the harness dispatches the
   * verifier). Only a published head whose tree passed the local validation is
   * ready; the forge's head must be the one this workspace published.
   */
  /**
   * THE ONE CHECK that a workspace's pull request (read once, `current`) is
   * open at exactly the head it published, against the trunk: a closed one is
   * refused (`workspace_pull_request_closed`), and so are one whose head
   * another writer moved (`workspace_published_head_moved`) and one whose
   * base was changed away from the trunk (`workspace_pull_request_base_mismatch`:
   * a merge into any other branch is no land). `ready` and `land` both ask it
   * before they act on the forge.
   */
  function assertOpenAtPublishedHead(record: WorkspaceRecord, current: ForgePullRequest, head: string): void {
    if (current.state !== "open") throw new InputError(`pull request #${String(current.number)} is ${current.state}`, "workspace_pull_request_closed");
    const trunk = (record.forge as WorkspaceForgeState).trunk;
    if (current.base !== trunk) {
      throw new InputError(`pull request #${String(current.number)} is opened against ${current.base}, not the trunk ${trunk}: set its base back to ${trunk}`, "workspace_pull_request_base_mismatch");
    }
    if (current.headSha !== head) {
      throw new InputError(`pull request #${String(current.number)}'s head is ${current.headSha}, not the published ${head}: someone else pushed to ${record.lease.branch!}`, "workspace_published_head_moved");
    }
  }

  async function ready(workspaceId: string): Promise<WorkspaceRecord> {
    const record = await requireForgeable(workspaceId, "be marked ready");
    const worktreePath = record.lease.worktreePath;
    const { forge, state } = forgeOf(record);
    if (state.pullRequest === null || state.publishedHead === null) {
      throw new InputError(`workspace ${workspaceId} has no pull request yet: publish a round first`, "workspace_not_published");
    }
    const head = git.revParse(worktreePath, "HEAD", timeouts.inspectMs);
    if (head !== state.publishedHead || git.status(worktreePath, timeouts.inspectMs).length > 0) {
      throw new InputError(`workspace ${workspaceId} holds work its last round did not publish (published ${state.publishedHead}, HEAD ${head}): publish it first`, "workspace_unpublished_commits");
    }
    const validated = record.validationReport;
    const tree = git.revParse(worktreePath, `${head}^{tree}`, timeouts.inspectMs);
    if (validated === null || validated.status !== "pass" || validated.tree !== tree) {
      throw new InputError(`workspace ${workspaceId}'s published tree ${tree} has no passing validation: validate it first`, "workspace_not_validated");
    }
    const current = await forge.pullRequest(state.pullRequest.number);
    assertOpenAtPublishedHead(record, current, head);
    if (current.draft) await forge.markReadyForReview(current.number);
    const saved = store.save(deepFreeze({ ...record, forge: deepFreeze({ ...state, ready: true }) }));
    auditEvent("workspace-ready", { workspaceId, pullRequest: current.number, head });
    return saved;
  }

  async function abort(workspaceId: string, abortOptions: Readonly<{ quarantine?: boolean; reason?: string }> = {}): Promise<WorkspaceRecord> {
    return abortInternal(requireOwnedRecord(workspaceId), abortOptions.quarantine ?? false, abortOptions.reason ?? "operator abort");
  }

  function snapshotWorkspace(workspaceId: string, label: string): WorkingTreeSnapshot {
    const record = requireOwnedRecord(workspaceId);
    if (isTerminalWorkspaceState(record.state)) throw new InputError(`workspace ${workspaceId} is terminal (${record.state})`, "workspace_terminal");
    return snapshot(record.lease.worktreePath, { message: `workspace ${workspaceId} snapshot ${label}`, name: `${workspaceId}.${label}`, ...snapshotIdentity });
  }

  async function sweep(): Promise<WorkspaceSweep> {
    const swept: string[] = [];
    const orphaned: string[] = [];
    const nowMs = now().getTime();
    for (const record of store.list()) {
      // A workspace known only to the legacy store is older code's: this code never sweeps it (until the P7 cutover).
      if (store.olderRecord(record.workspaceId) !== null) continue;
      if (record.state === "merging") {
        // A merging record whose integrator is gone (the merge lock is free)
        // is recovered; a running integrator's is left to it.
        try {
          if ((await recover(record.workspaceId)).state !== "merging") swept.push(record.workspaceId);
        } catch (error) {
          if ((error as { code?: unknown }).code !== "workspace_recover_denied") throw error;
        }
        continue;
      }
      if (!isTerminalWorkspaceState(record.state)) {
        if (leaseExpired(record, nowMs)) {
          await abortInternal(record, config.preserveOnFailure, "lease-expired");
          swept.push(record.workspaceId);
        } else if (!existsSync(record.lease.worktreePath)) {
          // A live record whose worktree is gone (removed by hand, a lost
          // disk): reported, never silently dropped — its owner aborts it.
          orphaned.push(record.workspaceId);
          auditEvent("workspace-orphaned", { workspaceId: record.workspaceId, worktreePath: record.lease.worktreePath, state: record.state });
        }
        continue;
      }
      if (record.state !== "quarantined") continue;
      const lastTransition = record.history.at(-1);
      const worktreePath = record.lease.worktreePath;
      if (lastTransition === undefined || !existsSync(worktreePath) || nowMs <= new Date(lastTransition.at).getTime() + config.quarantineTtlMs) continue;
      // A quarantined worktree is LOCKED (`worktree lock`): `remove --force`
      // refuses a locked one, so it is unlocked first.
      try {
        git.worktreeUnlock({ repoRoot: checkoutRoot, worktreePath, timeoutMs: timeouts.worktreeMs });
      } catch (error) {
        // Not locked (quarantined before it could be): nothing to unlock.
        if (!(error instanceof HarnessError)) throw error;
      }
      // Its branch and recovery points go with the worktree (A5-correctness
      // L2: the branch outlived the sweep); the record stays, the terminal
      // account of what was quarantined and why.
      removeWorktreeAndBranch(record);
      auditEvent("workspace-swept", { workspaceId: record.workspaceId, worktreePath });
      swept.push(record.workspaceId);
    }
    return deepFreeze({ swept: deepFreeze(swept), orphaned: deepFreeze(orphaned) });
  }

  return deepFreeze({
    registry,
    create,
    extend,
    validate,
    publish,
    ready,
    merge,
    land,
    recover,
    abort,
    snapshot: snapshotWorkspace,
    list: (): readonly WorkspaceRecord[] => store.list(),
    status: requireRecord,
    sweep,
  });
}
