/**
 * THE PROJECTION'S MODEL — what the desired GitHub state `D = project(S, L)`
 * is made of, and the input it is computed from (github-only §9.0).
 *
 * PURE: this module imports only the product's schema names (themselves
 * pure) and touches no I/O, clock or randomness.
 * It is loaded into the projector's sealed realm (`realm.ts`), where any of
 * those would be a typed refusal.
 *
 * D is a list of OBJECTS, each one GitHub object the projector owns: its
 * CLASS (`PROJECTION_CLASSES`, also the order classes are written in), its
 * KEY (a label's name, an item's id: never a GitHub number; the store maps
 * keys to numbers by the projector's marker), and its GIT-OWNED FIELDS (the
 * only fields the projector writes, compares and verifies; every other field
 * of the object is GitHub-owned and never touched). Each field belongs to a
 * WRITE PHASE (`FIELD_PHASES`), and a run writes create → link → fields →
 * state, so a link never names an object not yet created.
 */

import { schemaId } from "../../../kernel/product-identity.ts";

export const PROJECTION_SCHEMA = schemaId("projection", 1);
export const PROJECTION_INPUT_SCHEMA = schemaId("projection-input", 1);

/** The projected classes, in write order (a label exists before an issue carries it). */
export const PROJECTION_CLASSES = Object.freeze(["label", "issue"] as const);
export type ProjectionClass = typeof PROJECTION_CLASSES[number];

export type Json = null | boolean | number | string | readonly Json[] | { readonly [field: string]: Json };
export type Fields = Readonly<Record<string, Json>>;

/** One desired GitHub object. */
export type ProjectedObject = Readonly<{
  class: ProjectionClass;
  key: string;
  fields: Fields;
}>;

/** D: every desired object, sorted by class (write order) then key. */
export type Projection = Readonly<{
  schema: typeof PROJECTION_SCHEMA;
  /** The source commit S. */
  source: string;
  /** The ledger commit L (null before the ledger exists). */
  ledger: string | null;
  objects: readonly ProjectedObject[];
}>;

/** When a field is written, in write order: `create` fields go with the object's creation, `link` after every creation, `state` last. */
export const WRITE_PHASES = Object.freeze(["create", "link", "state"] as const);
export type WritePhase = typeof WRITE_PHASES[number];

/** Every class's git-owned fields and the phase each is written in (a field not named here is GitHub-owned). */
export const FIELD_PHASES: Readonly<Record<ProjectionClass, Readonly<Record<string, WritePhase>>>> = Object.freeze({
  label: Object.freeze({ color: "create", description: "create" }),
  issue: Object.freeze({
    title: "create",
    /** The generated block: the projector's marker and everything below it (the reporter's text above it is GitHub-owned). */
    block: "create",
    type: "create",
    labels: "create",
    parent: "link",
    blockedBy: "link",
    state: "state",
    stateReason: "state",
  }),
});

/** What GitHub holds for a just-created object before its `link` and `state` writes: a field D gives this value needs no write. */
export const BORN_FIELDS: Readonly<Record<ProjectionClass, Fields>> = Object.freeze({
  label: Object.freeze({}),
  issue: Object.freeze({ parent: null, blockedBy: Object.freeze([]), state: "open", stateReason: null }),
});

/** A tracker item as the projection reads it (the parser's `TrackerItem`, src/workflow/failure-owners.ts, plus its path). */
export type InputItem = Readonly<{
  id: string;
  type: string;
  title: string | null;
  state: "open" | "closed";
  resolution: "completed" | "not-planned" | "duplicate" | null;
  lane: string;
  parent: string | null;
  blockedBy: readonly string[];
  body: string;
  /** Repository-relative path of the item's file. */
  path: string;
}>;

/** A lane's GitHub label. */
export type InputLane = Readonly<{ lane: string; color: string; description: string }>;

/**
 * Everything D is computed from — read from the two trees (the source at S,
 * the ledger at L) by the host (`inputs.ts`), and nothing else: no clock, no
 * randomness, no network, no GitHub state.
 */
export type ProjectionInput = Readonly<{
  schema: typeof PROJECTION_INPUT_SCHEMA;
  source: string;
  ledger: string | null;
  /** `https://github.com/<owner>/<repository>`: the base of every permalink. */
  repositoryUrl: string;
  items: readonly InputItem[];
  lanes: readonly InputLane[];
}>;

/** The projector's marker opening an item's generated block; `digest` is filled in by the host (the realm has no hash). */
export function itemMarker(id: string, digest: string): string {
  return `<!-- bridlewise:item=${id} digest=${digest} -->`;
}
/** The digest placeholder `project` writes and the host replaces (`finalizeProjection`). */
export const DIGEST_PLACEHOLDER = "{digest}";

/** The label an item of `lane` carries. */
export function laneLabel(lane: string): string {
  return `lane:${lane}`;
}

/** GitHub's `state_reason` for a closed item. */
export const STATE_REASONS: Readonly<Record<NonNullable<InputItem["resolution"]>, string>> = Object.freeze({
  completed: "completed",
  "not-planned": "not_planned",
  duplicate: "duplicate",
});
