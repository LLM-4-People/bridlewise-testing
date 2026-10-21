/**
 * THE ONE APPLY ALGORITHM (github-only §9.0), used by every trigger — a land,
 * the hourly reconcile, a single-object reconcile, `--verify` on demand:
 *
 *   1. compute D and its digest (`projection.ts`);
 *   2. read the live state (the store's conditional reads);
 *   3. diff field by field, git-owned fields only ({@link planProjection});
 *   4. write only the difference, in phase order (create → link → state),
 *      paced, within the run's content-creation allowance — an exhausted
 *      allowance is the typed `github_content_budget_exhausted` and the rest
 *      waits for the next run, which resumes the diff;
 *   5. RE-READ and verify: every git-owned field of every object must now
 *      equal D. A mismatch is `projection_unverified{object, field}` — which
 *      is also how a field GitHub silently dropped is caught (V-28), never
 *      reported as a success;
 *   6. answer the projection RECEIPT: `{ S, L, digest(D), digest(observed),
 *      writes, refusals, pending, orphans, unverified, verified }`, which the
 *      caller appends to the ledger.
 *
 * A second run on the same D against the state the first left makes no write
 * (V-25: idempotent). A live object the projector OWNS that D does not hold
 * (an issue whose record was removed, a lane label no lane declares) is an
 * ORPHAN: reported, never written here. A person's own label or issue is
 * GitHub's, never an orphan.
 *
 * FOREIGN EDITS (V-27). The receipt records each object's observed digest.
 * A later run finds an object FOREIGN-EDITED when its live git-owned fields
 * differ from D AND from what the previous receipt observed: someone changed
 * GitHub, not the record (a changed record moves D, never the receipt's
 * digest). It is reported (`forge.projection.drift`, the receipt's
 * `foreignEdits`) and handled by the mode `forge.projection.foreignEdit`:
 *   - `approval` (the default): nothing is written to it; the receipt carries
 *     a PROPOSAL — the live values, for the publisher to open as a record
 *     change through the door. The edit becomes truth only by landing;
 *   - `auto`: the projected values are restored, and an issue gets a NOTICE
 *     (a comment naming its record and how to change it);
 *   - `manual`: nothing is written; the drift is reported only.
 * A held object (approval, manual) keeps its last projected digest in the
 * receipt, so it stays foreign until the record or GitHub moves to meet the
 * other, and the receipt is not verified while one is held.
 */
import { HarnessError } from "../../../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze } from "../../../kernel/integrity.ts";
import { schemaId } from "../../../kernel/product-identity.ts";
import { auditEvent, debugLog } from "../../../shared/debug/debug-system.ts";
import { BORN_FIELDS, FIELD_PHASES, PROJECTION_CLASSES, WRITE_PHASES, type Fields, type Json, type ProjectedObject, type Projection, type ProjectionClass } from "./model.ts";
import type { LiveObject, ProjectionStore, ProjectionWrite } from "./store.ts";

const PROJECTION_RECEIPT_SCHEMA = schemaId("projection-receipt", 1);

/** One git-owned field that is not what D says after the run. */
export type UnverifiedField = Readonly<{ class: ProjectionClass; key: string; field: string; expected: Json; observed: Json | undefined }>;

/** How a foreign edit to a git-owned field is handled (`forge.projection.foreignEdit`). */
const FOREIGN_EDIT_MODES = Object.freeze(["approval", "auto", "manual"] as const);
export type ForeignEditMode = typeof FOREIGN_EDIT_MODES[number];

/** One object someone edited on GitHub: the git-owned fields that differ from D, and what the run did. */
export type ForeignEdit = Readonly<{ class: ProjectionClass; key: string; fields: readonly string[]; mode: ForeignEditMode; action: "proposed" | "restored" | "reported" }>;

/** A record change the publisher opens for approval: the live values of a foreign-edited object's fields. */
export type RecordProposal = Readonly<{ class: ProjectionClass; key: string; fields: Fields }>;

/** A refusal the run met: typed, with the object it was writing when there was one. */
export type ProjectionRefusal = Readonly<{ code: string; message: string; class?: ProjectionClass; key?: string; retryable: boolean }>;

export type ProjectionReceipt = Readonly<{
  schema: typeof PROJECTION_RECEIPT_SCHEMA;
  source: string;
  ledger: string | null;
  /** sha256 of D, canonical. */
  digest: string;
  /** sha256 of the git-owned fields observed after the run, for D's objects, in D's spelling. */
  observedDigest: string;
  writes: readonly Readonly<{ phase: string; kind: string; class: ProjectionClass; key: string; fields: readonly string[] }>[];
  refusals: readonly ProjectionRefusal[];
  /** `<class>/<key>` of every object a refusal left unwritten (the next run resumes them). */
  pending: readonly string[];
  /** `<class>/<key>` of every live object D does not hold. */
  orphans: readonly string[];
  unverified: readonly UnverifiedField[];
  /** Every object someone edited on GitHub since the previous receipt, and what the run did. */
  foreignEdits: readonly ForeignEdit[];
  /** The record changes the publisher opens for approval (mode `approval`). */
  proposals: readonly RecordProposal[];
  /** `<class>/<key>` → the digest of the object's git-owned fields as projected and observed: the next run's foreign-edit baseline. */
  objects: Readonly<Record<string, string>>;
  /** Every write made, nothing pending, refused or held, every git-owned field equal to D. */
  verified: boolean;
}>;

export type ApplyOptions = Readonly<{
  /** How many writes this run may make (the content-creation budget left in the window, src: the ledger's receipts). */
  allowance: number;
  /** The previous run's receipt (the ledger's last), whose object digests tell a foreign edit from a record change; `null` on a first run. */
  previous: ProjectionReceipt | null;
  /** How a foreign edit is handled (`forge.projection.foreignEdit`). */
  foreignEdit: ForeignEditMode;
  /** Awaited before each write (the content-creation pacing; the tests pass none). */
  pace?: () => Promise<void>;
}>;

const id = (object: Readonly<{ class: ProjectionClass; key: string }>): string => `${object.class}/${object.key}`;
const same = (left: Json | undefined, right: Json | undefined): boolean => left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right);

/** The digest of `fields` restricted to the git-owned fields `names` (an absent field reads as null). */
function fieldsDigest(names: readonly string[], fields: Fields | undefined): string {
  return canonicalHash(Object.fromEntries([...names].sort().map((name) => [name, fields?.[name] ?? null])));
}

/** The git-owned fields of `object` that belong to `phase`. */
function phaseFields(object: Readonly<{ class: ProjectionClass; fields: Fields }>, phase: string): Record<string, Json> {
  const phases = FIELD_PHASES[object.class];
  return Object.fromEntries(Object.entries(object.fields).filter(([field]) => phases[field] === phase));
}

/** The writes that make `live` equal D, in write order (phase, then class, then key), and the orphans. */
export function planProjection(projection: Projection, live: readonly LiveObject[]): Readonly<{ writes: readonly ProjectionWrite[]; orphans: readonly string[] }> {
  const liveById = new Map(live.map((object) => [id(object), object]));
  const writes: ProjectionWrite[] = [];
  for (const object of projection.objects) {
    const current = liveById.get(id(object));
    for (const phase of WRITE_PHASES) {
      const wanted = phaseFields(object, phase);
      if (current === undefined && phase === "create") {
        writes.push({ phase, kind: "create", class: object.class, key: object.key, fields: wanted });
        continue;
      }
      const have = current === undefined ? BORN_FIELDS[object.class] : current.fields;
      const changed = Object.fromEntries(Object.entries(wanted).filter(([field, value]) => !same(have[field], value)));
      if (Object.keys(changed).length > 0) writes.push({ phase, kind: "update", class: object.class, key: object.key, fields: changed });
    }
  }
  const order = (write: ProjectionWrite): readonly number[] => [WRITE_PHASES.indexOf(write.phase), PROJECTION_CLASSES.indexOf(write.class)];
  writes.sort((left, right) => {
    const [lp, lc] = order(left);
    const [rp, rc] = order(right);
    return lp! - rp! || lc! - rc! || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  });
  const wanted = new Set(projection.objects.map(id));
  const classes = new Set<ProjectionClass>(projection.objects.map((object) => object.class));
  const orphans = live.filter((object) => object.owned && classes.has(object.class) && !wanted.has(id(object))).map(id).sort();
  return deepFreeze({ writes, orphans });
}

/** Every git-owned field of D's objects (all but `skip`) that `observed` does not hold as D says. */
function verifyProjection(projection: Projection, observed: readonly LiveObject[], skip: ReadonlySet<string> = new Set()): readonly UnverifiedField[] {
  const byId = new Map(observed.map((object) => [id(object), object]));
  const unverified: UnverifiedField[] = [];
  for (const object of projection.objects) {
    if (skip.has(id(object))) continue;
    const live = byId.get(id(object));
    for (const [field, expected] of Object.entries(object.fields)) {
      const value = live?.fields[field];
      if (!same(value, expected)) unverified.push({ class: object.class, key: object.key, field, expected, observed: value });
    }
  }
  return deepFreeze(unverified);
}

function observedDigest(projection: Projection, observed: readonly LiveObject[]): string {
  const byId = new Map(observed.map((object) => [id(object), object]));
  return canonicalHash(projection.objects.map((object: ProjectedObject) => {
    const live = byId.get(id(object));
    return { class: object.class, key: object.key, fields: live === undefined ? null : Object.fromEntries(Object.keys(object.fields).map((field) => [field, live.fields[field] ?? null])) };
  }));
}

function refusalOf(error: unknown, write: ProjectionWrite | undefined): ProjectionRefusal {
  const typed = error instanceof HarnessError ? error : null;
  return deepFreeze({
    code: typed?.code ?? "projection_write_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: typed?.retryable ?? false,
    ...(write === undefined ? {} : { class: write.class, key: write.key }),
  });
}

/** Steps 2–6 of the algorithm for `projection` against `store`; the receipt says what happened (see {@link projectionFailure}). */
export async function applyProjection(projection: Projection, store: ProjectionStore, options: ApplyOptions): Promise<ProjectionReceipt> {
  const classes = PROJECTION_CLASSES.filter((name) => projection.objects.some((object) => object.class === name));
  const live = await store.read(classes);
  const liveById = new Map(live.map((object) => [id(object), object]));
  // Foreign edits: live differs from D and from what the previous run observed.
  const foreignEdits: ForeignEdit[] = [];
  const proposals: RecordProposal[] = [];
  const held = new Set<string>();
  for (const object of projection.objects) {
    const current = liveById.get(id(object));
    const baseline = options.previous?.objects[id(object)];
    if (current === undefined || baseline === undefined) continue;
    const names = Object.keys(object.fields);
    const differing = names.filter((field) => !same(current.fields[field], object.fields[field])).sort();
    if (differing.length === 0 || fieldsDigest(names, current.fields) === baseline) continue;
    const action = options.foreignEdit === "auto" ? "restored" : options.foreignEdit === "approval" ? "proposed" : "reported";
    foreignEdits.push({ class: object.class, key: object.key, fields: differing, mode: options.foreignEdit, action });
    if (options.foreignEdit === "approval") proposals.push({ class: object.class, key: object.key, fields: Object.fromEntries(differing.map((field) => [field, current.fields[field] ?? null])) });
    if (options.foreignEdit !== "auto") held.add(id(object));
    auditEvent("forge.projection.drift", { class: object.class, key: object.key, fields: differing, mode: options.foreignEdit, action });
  }
  const planned = planProjection(projection, live);
  // An auto-restored issue gets a notice: its record, and how to change it.
  const notices: ProjectionWrite[] = foreignEdits.filter((edit) => edit.action === "restored" && edit.class === "issue").map((edit) => ({
    phase: "state", kind: "notice", class: edit.class, key: edit.key,
    fields: { text: `The ${edit.fields.join(", ")} of this issue ${edit.fields.length === 1 ? "is" : "are"} projected from its record and ${edit.fields.length === 1 ? "was" : "were"} restored. To change ${edit.fields.length === 1 ? "it" : "them"}, change the record (\`${edit.key}\`) in a pull request.` },
  }));
  const plan = { writes: [...planned.writes.filter((write) => !held.has(id(write))), ...notices], orphans: planned.orphans };
  const done: ProjectionWrite[] = [];
  const refusals: ProjectionRefusal[] = [];
  for (const write of plan.writes) {
    if (done.length >= options.allowance) {
      refusals.push({ code: "github_content_budget_exhausted", message: `this run's content-creation allowance (${String(options.allowance)} writes) is spent; ${String(plan.writes.length - done.length)} writes wait for the next run`, retryable: true });
      break;
    }
    try {
      await options.pace?.();
      await store.write(write);
      done.push(write);
    } catch (error) {
      // A refusal stops the run: the previous projection stays, the next run resumes the diff.
      refusals.push(refusalOf(error, write));
      break;
    }
  }
  const pending = [...new Set(plan.writes.slice(done.length).map(id))].sort();
  const observed = await store.read(classes);
  const observedById = new Map(observed.map((object) => [id(object), object]));
  const unverified = verifyProjection(projection, observed, new Set([...pending, ...held]));
  // The next run's baseline: what was observed, except a held object, which keeps its last projected digest (still foreign until met).
  const objects = Object.fromEntries(projection.objects.map((object) => {
    const names = Object.keys(object.fields);
    const kept = held.has(id(object)) ? options.previous?.objects[id(object)] : undefined;
    return [id(object), kept ?? fieldsDigest(names, observedById.get(id(object))?.fields)];
  }));
  const receipt: ProjectionReceipt = deepFreeze({
    schema: PROJECTION_RECEIPT_SCHEMA,
    source: projection.source,
    ledger: projection.ledger,
    digest: canonicalHash(projection),
    observedDigest: observedDigest(projection, observed),
    writes: done.map((write) => ({ phase: write.phase, kind: write.kind, class: write.class, key: write.key, fields: Object.keys(write.fields).sort() })),
    refusals,
    pending,
    orphans: plan.orphans,
    unverified,
    foreignEdits,
    proposals,
    objects,
    verified: refusals.length === 0 && pending.length === 0 && unverified.length === 0 && held.size === 0,
  });
  const level = receipt.verified ? "info" : "warn";
  debugLog("forge", level, `projection of ${projection.source}: ${String(done.length)} writes, ${String(pending.length)} pending, ${String(unverified.length)} unverified, ${String(plan.orphans.length)} orphans, ${String(foreignEdits.length)} foreign edits (${options.foreignEdit})${receipt.verified ? ", verified" : ""}`, () => ({ digest: receipt.digest, refusals: refusals.map((refusal) => refusal.code) }));
  return receipt;
}

/**
 * The typed failure a receipt carries, or `null` when it is verified:
 * `projection_drift` (a foreign edit held for approval or reported, naming
 * each object), then `projection_unverified` (naming each
 * `<class>/<key>.<field>`), then the first refusal's own code (a budget
 * refusal is retryable: the next run resumes).
 */
export function projectionFailure(receipt: ProjectionReceipt): HarnessError | null {
  const held = receipt.foreignEdits.filter((edit) => edit.action !== "restored");
  if (held.length > 0) {
    const objects = held.map((edit) => `${edit.class}/${edit.key} (${edit.fields.join(", ")}: ${edit.action})`);
    return new HarnessError(`projection_drift: GitHub differs from the projection of ${receipt.source} by foreign edit: ${objects.join("; ")}`, "projection_drift", false, { objects: held.map((edit) => `${edit.class}/${edit.key}`).join(",") });
  }
  if (receipt.unverified.length > 0) {
    const fields = receipt.unverified.map((field) => `${field.class}/${field.key}.${field.field}`);
    return new HarnessError(`projection_unverified: after the run, ${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} not what the projection of ${receipt.source} says (a write GitHub did not keep)`, "projection_unverified", false, { fields: fields.join(",") });
  }
  const refusal = receipt.refusals[0];
  if (refusal !== undefined) return new HarnessError(`${refusal.code}: ${refusal.key === undefined ? "" : `${refusal.class}/${refusal.key}: `}${refusal.message}`, refusal.code, refusal.retryable);
  return null;
}
