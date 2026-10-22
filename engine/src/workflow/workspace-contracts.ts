import { z } from "zod";

import { InputError } from "../kernel/errors.ts";
import { GIT_OBJECT_NAME } from "../git/git-port.ts";
import { canonicalDomainHash, deepFreeze, type DeepReadonly, sha256HexSchema } from "../kernel/integrity.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { schemaId, cryptoDomain, STATE_DIRECTORY_NAME } from "../kernel/product-identity.ts";
import { wholesaleGeneratedPaths } from "./hash-binding-registry.ts";

/**
 * Workspace contracts — closed, schema-versioned types for the isolated
 * workspace system (`harness workspace`: git worktrees with an integrator
 * that merges in the workspace and lands by fast-forward).
 *
 * State machine:
 *
 * admitted -> active -> validating -> merging -> merged
 * | | | |
 * +---------+-----------+-----------+--> aborted
 * +---------+-----------+-----------+--> quarantined
 *
 * - `admitted`: the lease is reserved (the admission check passed under the
 *   admission lock); the worktree is being made and set up.
 * - `active`: worktree + branch + lease exist and are set up; the agent may work.
 * - `validating`: in-worktree gates are running / have passed; ready to merge.
 * - `merging`: the serialized integrator owns the workspace. It leaves
 *   to `active` when the merge failed before the land, back to `validating`
 *   when git refused the land itself (the validation still holds), and an
 *   integrator that died here is recovered (`workspace recover`).
 * - `merged`: landed, receipt emitted (unless recovered after a dead
 *   integrator), worktree torn down (terminal).
 * - `aborted`: lease tombstoned, worktree and branch removed (terminal).
 * - `quarantined`: worktree preserved untouched for forensics (terminal).
 *
 * Three kinds of workspace:
 * - `feature`: a branch `agent/<name>/<nonce>` leased for a write set; lands
 *   on its target branch.
 * - `feature` with an `overlay`: the same, started from a SNAPSHOT of a dirty
 *   checkout (`snapshotWorkingTree`); landing adopts it into that checkout.
 * - `read-only`: a detached worktree for a verifier — no branch, no lease, no
 *   target; it can be validated and never merges.
 *
 * A feature workspace's record also carries its FORGE state (the target's
 * upstream, its pull request, the head its last round published, whether it
 * is ready for review: `workspace-forge.ts`); a read-only one has none.
 *
 * Every schema is a zod strict object: unknown keys are rejected so a
 * record written by a different revision fails closed instead of being
 * silently truncated.
 */

export const WORKSPACE_SCHEMA_VERSION = schemaId("workspace", 5);
/** The version before the forge: records of it are migrated in memory on read ({@link migrateWorkspaceRecord}), never written (read-only to this version). */
const WORKSPACE_SCHEMA_V2 = schemaId("workspace", 2);
/** The version of `ws publish`/`ready` before the land (its records are migrated in memory, never written: read-only to this version). */
const WORKSPACE_SCHEMA_V3 = schemaId("workspace", 3);
/** The version of `ws land` before the stacks (its records are migrated in memory, never written: read-only to this version). */
const WORKSPACE_SCHEMA_V4 = schemaId("workspace", 4);

/** The versions before this one, newest first: their stores are read, migrated in memory, and never written (`workspace-registry.ts`). */
export const OLDER_WORKSPACE_SCHEMA_VERSIONS = deepFreeze([WORKSPACE_SCHEMA_V4, WORKSPACE_SCHEMA_V3, WORKSPACE_SCHEMA_V2] as const);
export type OlderWorkspaceSchemaVersion = typeof OLDER_WORKSPACE_SCHEMA_VERSIONS[number];

export const WORKSPACE_STATES = deepFreeze([
  "admitted",
  "active",
  "validating",
  "merging",
  "merged",
  "aborted",
  "quarantined",
] as const);
export type WorkspaceState = typeof WORKSPACE_STATES[number];

const WORKSPACE_KINDS = deepFreeze(["feature", "read-only"] as const);
export type WorkspaceKind = typeof WORKSPACE_KINDS[number];

const WORKSPACE_CONFLICT_KINDS = deepFreeze([
  "static-overlap",
  "dynamic-overlap",
  "textual-conflict",
] as const);
export type WorkspaceConflictKind = typeof WORKSPACE_CONFLICT_KINDS[number];

/**
 * How a merge reached its target: a fast-forward of the checkout that has the
 * target checked out (or the completion of one a crash left torn there:
 * `tree-landing.ts`), a compare-and-swap of the target ref when no checkout
 * has it, or the adoption of an overlay into the checkout it was taken from.
 */
const WORKSPACE_LANDINGS = deepFreeze(["fast-forward", "torn-completion", "update-ref", "overlay-adoption"] as const);
export type WorkspaceLanding = typeof WORKSPACE_LANDINGS[number];

/**
 * Paths no workspace may lease: the WHOLLY generated outputs (derived:
 * `wholesaleGeneratedPaths`, repository-relative — a lease would fork the
 * generated authority; the regenerate phase re-derives them), and anything
 * under a segment that is never source: the harness state directory, git's
 * own directory, installed dependencies.
 */
const NEVER_LEASABLE_SEGMENTS: ReadonlySet<string> = new Set([STATE_DIRECTORY_NAME, ".git", "node_modules"]);

export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = deepFreeze({
  admitted: ["active", "aborted", "quarantined"],
  active: ["validating", "aborted", "quarantined"],
  validating: ["merging", "active", "aborted", "quarantined"],
  merging: ["merged", "active", "validating", "aborted", "quarantined"],
  merged: [],
  aborted: [],
  quarantined: [],
});

const GIT_SHA_SCHEMA = z.string().regex(GIT_OBJECT_NAME);
const WORKSPACE_ID_SCHEMA = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u);
const WORKSPACE_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const AGENT_NAME_SCHEMA = z.string().min(1).max(64).regex(WORKSPACE_AGENT_NAME_PATTERN);
const RELATIVE_PATH_SCHEMA = z.string().min(1).max(1024);
const ISO_TIMESTAMP_SCHEMA = z.string().min(20).max(40);
const MESSAGE_SCHEMA = z.string().max(4096);
/** The longest reason a record keeps (a transition's, an abort's, a conflict's). */
const REASON_MAXIMUM_CHARACTERS = 1024;
const REASON_SCHEMA = z.string().max(REASON_MAXIMUM_CHARACTERS);
const BRANCH_SCHEMA = z.string().min(1).max(256);
/**
 * A gate is a configured command (the config's command-name shape) or one of
 * the manager's own: `write-set-proof`, `converged` (nothing left
 * uncommitted after a phase) and `merge-gates` (skipped: the tree was
 * already qualified).
 */
const GATE_NAME_SCHEMA = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);

const workspaceGateResultSchema = z.strictObject({
  gate: GATE_NAME_SCHEMA,
  status: z.enum(["pass", "fail", "skip"]),
  message: MESSAGE_SCHEMA,
  details: z.array(MESSAGE_SCHEMA).max(256),
});
export type WorkspaceGateResult = DeepReadonly<z.infer<typeof workspaceGateResultSchema>>;

export const validationReportSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  baseSha: GIT_SHA_SCHEMA,
  headSha: GIT_SHA_SCHEMA,
  /** The tree of `headSha`: what the gates judged (a merge whose tree is this one needs no second qualification). */
  tree: GIT_SHA_SCHEMA,
  /** Whether the regenerate phase, the convergence check and the merge gates ran too (`validate --full`). */
  full: z.boolean(),
  changedPaths: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  gates: z.array(workspaceGateResultSchema).min(1).max(64),
  status: z.enum(["pass", "fail"]),
  /** When the gates began: a judged run recorded since then measured `tree` (a land imports those rows). */
  startedAt: ISO_TIMESTAMP_SCHEMA,
  validatedAt: ISO_TIMESTAMP_SCHEMA,
});
export type ValidationReport = DeepReadonly<z.infer<typeof validationReportSchema>>;

const conflictEntrySchema = z.strictObject({
  path: RELATIVE_PATH_SCHEMA,
  otherWorkspaceId: WORKSPACE_ID_SCHEMA.nullable(),
  reason: REASON_SCHEMA,
});
export type ConflictEntry = DeepReadonly<z.infer<typeof conflictEntrySchema>>;

export const conflictReportSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  kind: z.enum(WORKSPACE_CONFLICT_KINDS),
  workspaceId: WORKSPACE_ID_SCHEMA,
  conflicts: z.array(conflictEntrySchema).min(1).max(100_000),
  detectedAt: ISO_TIMESTAMP_SCHEMA,
});
export type ConflictReport = DeepReadonly<z.infer<typeof conflictReportSchema>>;

export const mergeReceiptSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  agentName: AGENT_NAME_SCHEMA,
  branch: BRANCH_SCHEMA,
  targetBranch: BRANCH_SCHEMA,
  baseSha: GIT_SHA_SCHEMA,
  /** The target's tip the merge was built on (the merge commit's first parent). */
  preMergeHeadSha: GIT_SHA_SCHEMA,
  mergeCommitSha: GIT_SHA_SCHEMA,
  mergeTree: GIT_SHA_SCHEMA,
  landing: z.enum(WORKSPACE_LANDINGS),
  /** The checkout the landing moved (fast-forward, overlay adoption), or null for a ref-only landing. */
  landedIn: z.string().min(1).max(4096).nullable(),
  changedPaths: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  /** Generated outputs the regenerate phase rewrote in the merge commit. */
  regeneratedPaths: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  /** Conflicted generated paths resolved to the target's side and re-derived. */
  resolvedConflicts: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  /** Per ledger gate: `<ledger>: <rows>` imported into the landing checkout's ledger (its judged runs of the landed tree). */
  importedRuns: z.array(MESSAGE_SCHEMA).max(64),
  timelineImportedEvents: z.number().int().nonnegative(),
  timelineSkippedEvents: z.number().int().nonnegative(),
  gateResults: z.array(workspaceGateResultSchema).max(64),
  /**
   * Every frozen-record acceptance the merge lands (`harness frozen accept`: a
   * pinned historical record re-pinned or dropped, with its reason), listed
   * for review. Absent in a receipt written before it was recorded.
   */
  frozenAcceptances: z.array(z.strictObject({
    path: RELATIVE_PATH_SCHEMA,
    from: z.string().max(256).nullable(),
    to: z.string().max(256).nullable(),
    reason: MESSAGE_SCHEMA,
    acceptedAt: z.string().min(1).max(64),
  })).max(100_000).optional(),
  mergedAt: ISO_TIMESTAMP_SCHEMA,
  receiptHash: sha256HexSchema,
});
export type MergeReceipt = DeepReadonly<z.infer<typeof mergeReceiptSchema>>;
export type UnsignedMergeReceipt = Omit<MergeReceipt, "receiptHash">;

/**
 * An overlay: the snapshot of a dirty checkout a feature workspace started
 * from. Landing adopts it into that checkout only while the checkout still
 * holds exactly that tree (a fresh snapshot's tree equals `tree`) and the same
 * index (`indexDigest`: the sha256 of its `ls-files --stage` records).
 */
const workspaceOverlaySchema = z.strictObject({
  commit: GIT_SHA_SCHEMA,
  tree: GIT_SHA_SCHEMA,
  checkout: z.string().min(1).max(4096),
  indexDigest: sha256HexSchema,
});
export type WorkspaceOverlay = DeepReadonly<z.infer<typeof workspaceOverlaySchema>>;

const workspaceLeaseSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  agentName: AGENT_NAME_SCHEMA,
  kind: z.enum(WORKSPACE_KINDS),
  nonce: z.string().min(8).max(64),
  /** The workspace's branch; null for a read-only (detached) workspace. */
  branch: BRANCH_SCHEMA.nullable(),
  /** The branch it lands on; null for a read-only workspace. */
  targetBranch: BRANCH_SCHEMA.nullable(),
  worktreePath: z.string().min(1).max(4096),
  /** The commit the workspace forked from on its target (for an overlay: the snapshot's parent). */
  baseSha: GIT_SHA_SCHEMA,
  overlay: workspaceOverlaySchema.nullable(),
  writeSet: z.array(RELATIVE_PATH_SCHEMA).max(4096),
  /** The exact write lease's identity; null for a read-only workspace (no lease). */
  writeSetIdentity: sha256HexSchema.nullable(),
  issuedAt: ISO_TIMESTAMP_SCHEMA,
  heartbeatAt: ISO_TIMESTAMP_SCHEMA,
  expiresAt: ISO_TIMESTAMP_SCHEMA,
  generation: z.number().int().positive(),
}).superRefine((lease, context) => {
  const readOnly = lease.kind === "read-only";
  if (readOnly !== (lease.writeSet.length === 0) || readOnly !== (lease.writeSetIdentity === null)) {
    context.addIssue({ code: "custom", path: ["writeSet"], message: "a write set (and its lease identity) is empty exactly when the workspace is read-only" });
  }
  if (readOnly !== (lease.branch === null) || readOnly !== (lease.targetBranch === null)) {
    context.addIssue({ code: "custom", path: ["branch"], message: "a read-only workspace has no branch and no target; a feature workspace has both" });
  }
  if (readOnly && lease.overlay !== null) {
    context.addIssue({ code: "custom", path: ["overlay"], message: "a read-only workspace carries no overlay" });
  }
});
export type WorkspaceLease = DeepReadonly<z.infer<typeof workspaceLeaseSchema>>;

/**
 * A feature workspace's place on the forge (`workspace-forge.ts`): its land
 * target's upstream (the remote and the trunk its pull request is opened
 * against, resolved once at create), the pull request (opened as a draft by
 * the first published round: the forge opens none without a commit), the
 * branch head the last round published (the local branch was moved to it: the
 * same tree), and whether the writer marked it ready for review.
 */
const workspaceForgeSchema = z.strictObject({
  remote: z.string().min(1).max(128).regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/u),
  trunk: BRANCH_SCHEMA,
  pullRequest: z.strictObject({
    number: z.number().int().positive(),
    url: z.string().min(1).max(1024),
  }).nullable(),
  publishedHead: GIT_SHA_SCHEMA.nullable(),
  ready: z.boolean(),
  /**
   * The land in flight (`ws land`: the merge queue entered at the published
   * head; set as the record becomes `merging`, cleared when the land ends):
   * `head` is the head the queue was asked for, the ONLY head this
   * workspace may be found merged at. Null when no land is in flight.
   */
  land: z.strictObject({ head: GIT_SHA_SCHEMA }).nullable(),
  /**
   * The workspace this one is STACKED on (`create --stack-on`): its branch
   * starts at that workspace's published head, its pull request is opened
   * against the trunk like any other (never against the parent's branch:
   * the forge deletes a landed branch and closes the pull requests based on
   * it), and it lands only after the parent did. Null for a workspace on the
   * trunk itself.
   */
  stackedOn: WORKSPACE_ID_SCHEMA.nullable(),
}).superRefine((forge, context) => {
  if ((forge.pullRequest === null) !== (forge.publishedHead === null)) {
    context.addIssue({ code: "custom", path: ["pullRequest"], message: "the first published round opens the pull request: both exist, or neither" });
  }
  if (forge.ready && forge.pullRequest === null) {
    context.addIssue({ code: "custom", path: ["ready"], message: "only an opened pull request is marked ready" });
  }
  if (forge.land !== null && (!forge.ready || forge.land.head !== forge.publishedHead)) {
    context.addIssue({ code: "custom", path: ["land"], message: "only a ready pull request lands, and only at the head this workspace published" });
  }
});
export type WorkspaceForgeState = DeepReadonly<z.infer<typeof workspaceForgeSchema>>;

/**
 * The forge state of a feature workspace created BEFORE the forge (a v2
 * record, migrated in memory): it has no upstream recorded. A v2-only
 * workspace is read-only to this version (`workspace_owned_by_v2_checkout`,
 * `workspace-registry.ts`), so nothing here ever publishes, lands or saves it.
 */
const legacyForgeSchema = z.strictObject({ legacy: z.literal(true) });
export type LegacyForgeState = DeepReadonly<z.infer<typeof legacyForgeSchema>>;

/** Whether a record's forge state is a migrated legacy one ({@link legacyForgeSchema}). */
export function isLegacyForgeState(forge: WorkspaceForgeState | LegacyForgeState): forge is LegacyForgeState {
  return "legacy" in forge;
}

/** A local merge receipt written by an older version (v2, v3, v4): kept verbatim (its hash binds its own version), never re-tagged. */
const legacyMergeReceiptSchema = mergeReceiptSchema.extend({ schemaVersion: z.enum([WORKSPACE_SCHEMA_V2, WORKSPACE_SCHEMA_V3, WORKSPACE_SCHEMA_V4]) });

/**
 * How the LOCAL target followed a forge land: the local follows of the tree
 * landing (`fast-forward`, `torn-completion`, `update-ref`), the overlay's
 * adoption, `current` (it already held the trunk), or `refused` (git
 * declined: the land happened on the forge all the same, and the receipt
 * says why the checkout did not follow).
 */
const WORKSPACE_FOLLOWS = deepFreeze(["fast-forward", "torn-completion", "update-ref", "overlay-adoption", "current", "refused"] as const);
export type WorkspaceFollow = typeof WORKSPACE_FOLLOWS[number];

/**
 * THE RECEIPT OF A FORGE LAND (`ws land`): the pull request, the head the
 * queue was asked for and found merged at (`landedHead`: the merge commit's
 * second parent, checked against the published head), the merge commit and
 * its tree, the trunk tip the local target followed to and how, and the
 * local validation of the landed head's tree. Hashed like the merge receipt,
 * in its own domain.
 */
const landReceiptSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  kind: z.literal("land"),
  workspaceId: WORKSPACE_ID_SCHEMA,
  agentName: AGENT_NAME_SCHEMA,
  branch: BRANCH_SCHEMA,
  targetBranch: BRANCH_SCHEMA,
  remote: z.string().min(1).max(128).regex(/^[A-Za-z0-9._][A-Za-z0-9._-]*$/u),
  trunk: BRANCH_SCHEMA,
  pullRequest: z.strictObject({ number: z.number().int().positive(), url: z.string().min(1).max(1024) }),
  landedHead: GIT_SHA_SCHEMA,
  baseSha: GIT_SHA_SCHEMA,
  /** The trunk's tip the forge merged onto (the merge commit's first parent). */
  preMergeHeadSha: GIT_SHA_SCHEMA,
  mergeCommitSha: GIT_SHA_SCHEMA,
  mergeTree: GIT_SHA_SCHEMA,
  /** The trunk's tip the local target followed to (the merge commit, or a later land on top of it). */
  trunkTip: GIT_SHA_SCHEMA,
  follow: z.enum(WORKSPACE_FOLLOWS),
  /** The checkout the local follow moved, or null. */
  followedIn: z.string().min(1).max(4096).nullable(),
  /** Why the local target did not follow (`follow: refused`), else null. */
  followRefusal: MESSAGE_SCHEMA.nullable(),
  changedPaths: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  importedRuns: z.array(MESSAGE_SCHEMA).max(64),
  timelineImportedEvents: z.number().int().nonnegative(),
  timelineSkippedEvents: z.number().int().nonnegative(),
  /** The local validation of the landed head's tree. */
  gateResults: z.array(workspaceGateResultSchema).max(64),
  mergedAt: ISO_TIMESTAMP_SCHEMA,
  receiptHash: sha256HexSchema,
});
export type LandReceipt = DeepReadonly<z.infer<typeof landReceiptSchema>>;
/** A land receipt written by v4: kept verbatim (its hash binds its own version), never re-tagged. */
const legacyLandReceiptSchema = landReceiptSchema.extend({ schemaVersion: z.literal(WORKSPACE_SCHEMA_V4) });
export type UnsignedLandReceipt = Omit<LandReceipt, "receiptHash">;

const LAND_RECEIPT_HASH_DOMAIN = cryptoDomain("workspace-land-receipt", 1);

/** The land receipt, hashed and checked against its closed schema. */
export function finalizeLandReceipt(unsigned: UnsignedLandReceipt): LandReceipt {
  return parseClosed(landReceiptSchema, { ...unsigned, receiptHash: canonicalDomainHash(LAND_RECEIPT_HASH_DOMAIN, unsigned) }, "land receipt", "workspace_receipt_invalid");
}

const workspaceTransitionSchema = z.strictObject({
  from: z.enum(WORKSPACE_STATES),
  to: z.enum(WORKSPACE_STATES),
  at: ISO_TIMESTAMP_SCHEMA,
  reason: REASON_SCHEMA,
});
export type WorkspaceTransition = DeepReadonly<z.infer<typeof workspaceTransitionSchema>>;

export const workspaceRecordSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  agentName: AGENT_NAME_SCHEMA,
  state: z.enum(WORKSPACE_STATES),
  lease: workspaceLeaseSchema,
  changedPaths: z.array(RELATIVE_PATH_SCHEMA).max(100_000),
  validationReport: validationReportSchema.nullable(),
  conflictReport: conflictReportSchema.nullable(),
  /** The local integrator's merge receipt, a forge land's receipt, or an older version's merge receipt (verbatim). */
  mergeReceipt: z.union([mergeReceiptSchema, landReceiptSchema, legacyMergeReceiptSchema, legacyLandReceiptSchema]).nullable(),
  abortReason: REASON_SCHEMA.nullable(),
  history: z.array(workspaceTransitionSchema).max(4096),
  /** The forge state of a feature workspace (or its legacy marker); null for a read-only one (it never publishes). */
  forge: z.union([workspaceForgeSchema, legacyForgeSchema]).nullable(),
  /**
   * How many times the record was saved: the store's compare-and-swap token
   * (`workspace-registry.ts`). A save of a record whose revision is not the
   * stored one is refused, so a long command (a validate that ran for an hour)
   * can never overwrite what an extend, an abort or a sweep wrote meanwhile.
   */
  revision: z.number().int().nonnegative(),
}).superRefine((record, context) => {
  if (record.lease.kind === "read-only" && (record.state === "merging" || record.state === "merged")) {
    context.addIssue({ code: "custom", path: ["state"], message: "a read-only workspace never merges" });
  }
  if ((record.lease.kind === "read-only") !== (record.forge === null)) {
    context.addIssue({ code: "custom", path: ["forge"], message: "a feature workspace has a forge state; a read-only one has none" });
  }
});
export type WorkspaceRecord = DeepReadonly<z.infer<typeof workspaceRecordSchema>>;

const MERGE_RECEIPT_HASH_DOMAIN = cryptoDomain("workspace-merge-receipt", 2);

/** A reason as a record keeps it: at most the schema's bound (the head of a longer message). */
export function recordedReason(text: string): string {
  return text.slice(0, REASON_MAXIMUM_CHARACTERS);
}

/**
 * A workspace id as the CLI and the record store accept it: the record
 * schema's own shape, so an id can never name a path outside the registry
 * (`../workspaces/<id>`).
 */
export function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_SCHEMA.safeParse(workspaceId).success) {
    throw new InputError(`workspace id "${workspaceId}" is not a workspace id`, "workspace_id_invalid");
  }
}

export function assertWorkspaceAgentName(agentName: string): void {
  if (typeof agentName !== "string" || agentName.length === 0 || agentName.length > 64 ||
    !WORKSPACE_AGENT_NAME_PATTERN.test(agentName)) {
    throw new InputError(`workspace agent name "${agentName}" is invalid`, "workspace_agent_name_invalid");
  }
}

export function isWorkspaceTransitionAllowed(from: WorkspaceState, to: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[from].includes(to);
}

export function assertWorkspaceTransition(from: WorkspaceState, to: WorkspaceState): void {
  if (!isWorkspaceTransitionAllowed(from, to)) {
    throw new InputError(
      `workspace state transition ${from} -> ${to} is not allowed`,
      "workspace_transition_invalid",
    );
  }
}

export function isTerminalWorkspaceState(state: WorkspaceState): boolean {
  return WORKSPACE_TRANSITIONS[state].length === 0;
}

/**
 * Canonicalize one declared write-set path: NFC-normalized, repository-
 * relative, forward slashes, no trailing slash, no traversal. Returns the
 * canonical form or throws InputError. The canonical form is what every
 * prefix comparison consumes so "src/foo" and "src/foo/" cannot drift.
 */
export function canonicalizeWriteSetPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new InputError("write-set path must be a non-empty string", "workspace_write_set_invalid");
  }
  const normalized = path.normalize("NFC").replaceAll("\\", "/");
  const stripped = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  if (stripped.length === 0 || stripped.normalize("NFC") !== stripped ||
    relativePathViolationKinds(stripped).length > 0) {
    throw new InputError(`write-set path "${path}" is not canonical`, "workspace_write_set_invalid");
  }
  return stripped;
}

/**
 * A feature workspace's write set: non-empty, and no path in it is never
 * leasable — a wholly generated output (or a directory holding one), or a
 * path under the state directory, `.git` or `node_modules`.
 */
export function assertLeasableWriteSet(writeSet: readonly string[]): void {
  if (writeSet.length === 0) {
    throw new InputError("write set must not be empty", "workspace_write_set_empty");
  }
  const wholesale = [...wholesaleGeneratedPaths()];
  for (const path of writeSet) {
    const segment = path.split("/").find((part) => NEVER_LEASABLE_SEGMENTS.has(part));
    if (segment !== undefined) {
      throw new InputError(
        `write-set path "${path}" is under "${segment}", which is never source`,
        "workspace_write_set_never_leasable",
      );
    }
    const generated = wholesale.find((output) => output === path || output.startsWith(`${path}/`));
    if (generated !== undefined) {
      throw new InputError(
        `write-set path "${path}" covers the wholly generated output "${generated}" (the regenerate phase derives it)`,
        "workspace_write_set_never_leasable",
      );
    }
  }
}

/**
 * Prefix-boundary write-set membership: `path` is leased when it equals a
 * write-set entry exactly or sits below it on a `/` boundary. "src/foo"
 * leases "src/foo/bar.ts" but never "src/foobar/x.ts".
 */
export function isPathWithinWriteSet(path: string, writeSet: readonly string[]): boolean {
  for (const entry of writeSet) {
    if (path === entry || path.startsWith(`${entry}/`)) return true;
  }
  return false;
}

/**
 * Changed paths that fall outside the declared write set (the out-of-lease
 * proof). `exempt` — the changed paths whose change is REGENERATION ONLY
 * (`generationOnlyPaths`, workspace-manager.ts: a wholly generated output,
 * or a pin or generated block re-derived and nothing authored) — need no
 * lease: every commit regenerates them with its sources. An authored edit
 * of a file that also holds a generated part is never exempt.
 */
export function computeUnleasedPaths(
  changedPaths: readonly string[],
  writeSet: readonly string[],
  exempt: ReadonlySet<string> = new Set(),
): readonly string[] {
  return deepFreeze(changedPaths.filter((path) => !exempt.has(path) && !isPathWithinWriteSet(path, writeSet)).toSorted());
}

/**
 * Intersect a candidate's changed paths against N pending workspaces'
 * declared write sets. One conflict entry per (changed path, pending
 * workspace) pair — the dynamic pre-merge conflict check.
 */
export function computePendingWriteSetConflicts(
  changedPaths: readonly string[],
  pending: readonly Readonly<{ workspaceId: string; writeSet: readonly string[] }>[],
): readonly ConflictEntry[] {
  const conflicts: ConflictEntry[] = [];
  for (const path of changedPaths) {
    for (const candidate of pending) {
      if (isPathWithinWriteSet(path, candidate.writeSet)) {
        conflicts.push(deepFreeze({
          path,
          otherWorkspaceId: candidate.workspaceId,
          reason: `changed path is inside the pending write set of workspace ${candidate.workspaceId}`,
        }));
      }
    }
  }
  return deepFreeze(conflicts.toSorted(compareConflictEntries));
}

/** Intersect a candidate's changed paths against paths merged to the target since its base. */
export function computeMergedSinceConflicts(
  changedPaths: readonly string[],
  mergedPaths: readonly string[],
): readonly ConflictEntry[] {
  const merged = new Set(mergedPaths);
  const conflicts: ConflictEntry[] = [];
  for (const path of changedPaths) {
    if (merged.has(path)) {
      conflicts.push(deepFreeze({
        path,
        otherWorkspaceId: null,
        reason: "path was merged to the target after the workspace base; rebase and re-validate required",
      }));
    }
  }
  return deepFreeze(conflicts.toSorted(compareConflictEntries));
}

function compareConflictEntries(left: ConflictEntry, right: ConflictEntry): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  const leftOther = left.otherWorkspaceId ?? "";
  const rightOther = right.otherWorkspaceId ?? "";
  if (leftOther < rightOther) return -1;
  if (leftOther > rightOther) return 1;
  return 0;
}

export function computeMergeReceiptHash(unsigned: UnsignedMergeReceipt): string {
  return canonicalDomainHash(MERGE_RECEIPT_HASH_DOMAIN, unsigned);
}

/** Parses `value` against a closed schema, frozen, or refuses with the record's own typed code. */
function parseClosed<Schema extends z.ZodType>(schema: Schema, value: unknown, what: string, code: string): DeepReadonly<z.infer<Schema>> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InputError(`${what} does not match the canonical schema`, code);
  return deepFreeze(parsed.data) as DeepReadonly<z.infer<Schema>>;
}

export function finalizeMergeReceipt(unsigned: UnsignedMergeReceipt): MergeReceipt {
  return parseClosed(mergeReceiptSchema, { ...unsigned, receiptHash: computeMergeReceiptHash(unsigned) }, "merge receipt", "workspace_receipt_invalid");
}

export function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  return parseClosed(workspaceRecordSchema, value, "workspace record", "workspace_record_invalid");
}

/**
 * THE ONE MIGRATION CHAIN of a stored record, IN MEMORY (the record store
 * runs it on every read of an older store and never writes the result back:
 * older code still reads those stores), one deterministic step per version:
 * - v2 → v3 (the forge): the record, its lease and its reports re-tagged;
 *   the forge state `null` for a read-only workspace and the legacy marker
 *   for a feature one ({@link legacyForgeSchema});
 * - v3 → v4 (the land): re-tagged; a live forge state gains `land: null`;
 * - v4 → v5 (the stacks): re-tagged; a live forge state gains `stackedOn: null`.
 * A merge receipt is kept verbatim at every step (its hash binds its own
 * version). A current record is answered as it is; any other version is
 * refused (`workspace_record_invalid`). Answers the parsed record and
 * whether it was migrated.
 */
export function migrateWorkspaceRecord(value: unknown): Readonly<{ record: WorkspaceRecord; migrated: boolean }> {
  let stored = value !== null && typeof value === "object" ? value as Readonly<Record<string, unknown>> : {};
  if (stored["schemaVersion"] === WORKSPACE_SCHEMA_VERSION) return deepFreeze({ record: parseWorkspaceRecord(value), migrated: false });
  if (!(OLDER_WORKSPACE_SCHEMA_VERSIONS as readonly unknown[]).includes(stored["schemaVersion"])) {
    throw new InputError(`workspace record of version ${String(stored["schemaVersion"])} is neither ${WORKSPACE_SCHEMA_VERSION} nor one this version migrates (${OLDER_WORKSPACE_SCHEMA_VERSIONS.join(", ")})`, "workspace_record_invalid");
  }
  const retag = (version: string) => (part: unknown): unknown => (part !== null && typeof part === "object" ? { ...part, schemaVersion: version } : part);
  const retagRecord = (record: Readonly<Record<string, unknown>>, version: string): Record<string, unknown> => ({
    ...record, schemaVersion: version, lease: retag(version)(record["lease"]), validationReport: retag(version)(record["validationReport"]), conflictReport: retag(version)(record["conflictReport"]),
  });
  if (stored["schemaVersion"] === WORKSPACE_SCHEMA_V2) {
    const lease = stored["lease"] as Readonly<Record<string, unknown>> | undefined;
    stored = { ...retagRecord(stored, WORKSPACE_SCHEMA_V3), forge: lease?.["kind"] === "read-only" ? null : { legacy: true } };
  }
  // One step per version, each gaining what its successor added (a field the older version already names was written by no version's code).
  const step = (version: string, field: string, gained: unknown): void => {
    const forge = stored["forge"] as Readonly<Record<string, unknown>> | null | undefined;
    if (forge !== null && typeof forge === "object" && field in forge) throw new InputError(`a workspace record before ${version} names \`${field}\`, which its version never had`, "workspace_record_invalid");
    stored = { ...retagRecord(stored, version), forge: forge === null || forge === undefined || "legacy" in forge ? forge ?? null : { ...forge, [field]: gained } };
  };
  if (stored["schemaVersion"] === WORKSPACE_SCHEMA_V3) step(WORKSPACE_SCHEMA_V4, "land", null);
  step(WORKSPACE_SCHEMA_VERSION, "stackedOn", null);
  return deepFreeze({ record: parseWorkspaceRecord(stored), migrated: true });
}

export function parseValidationReport(value: unknown): ValidationReport {
  return parseClosed(validationReportSchema, value, "validation report", "workspace_report_invalid");
}

export function parseMergeReceipt(value: unknown): MergeReceipt {
  const receipt = parseClosed(mergeReceiptSchema, value, "merge receipt", "workspace_receipt_invalid");
  const { receiptHash, ...unsigned } = receipt;
  if (computeMergeReceiptHash(unsigned) !== receiptHash) {
    throw new InputError("merge receipt hash does not match its content", "workspace_receipt_invalid");
  }
  return receipt;
}
