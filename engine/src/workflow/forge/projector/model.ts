/**
 * THE PROJECTION'S MODEL — what the desired GitHub state `D = project(S, L)`
 * is made of, and the input it is computed from (github-only §9.0).
 *
 * PURE: this module imports only the product's schema names (themselves
 * pure) and touches no I/O, clock or randomness.
 * It is linked into the projector's confined program (`confined.ts`), where
 * the kernel refuses any file or network it would reach.
 *
 * D is a list of OBJECTS, each one GitHub object the projector owns: its
 * CLASS (`PROJECTION_CLASSES`, also the order classes are written in), its
 * KEY (a milestone's or an item's id: never a GitHub number; the store maps
 * keys to numbers by the projector's marker), and its GIT-OWNED FIELDS (the
 * only fields the projector writes, compares and verifies; every other field
 * of the object is GitHub-owned and never touched). Each field belongs to a
 * WRITE PHASE (`FIELD_PHASES`), and a run writes create → link → fields →
 * state, so a link never names an object not yet created.
 */

import { schemaId } from "../../../kernel/product-identity.ts";

export const PROJECTION_SCHEMA = schemaId("projection", 1);
export const PROJECTION_INPUT_SCHEMA = schemaId("projection-input", 2);

/**
 * The projected classes, in write order (a milestone exists before an issue
 * carries it). Labels are not one: every label is declared once in
 * `docs/community/labels.json` and applied by `harness forge apply`; an issue
 * only CARRIES its lane's label, which the store refuses to write unless it
 * already exists (`projection_label_missing`, never created on the way).
 */
export const PROJECTION_CLASSES = Object.freeze(["milestone", "issue"] as const);
export type ProjectionClass = typeof PROJECTION_CLASSES[number];

export type Json = null | boolean | number | string | readonly Json[] | { readonly [field: string]: Json };
export type Fields = Readonly<Record<string, Json>>;

/** One desired GitHub object. */
export type ProjectedObject = Readonly<{
  class: ProjectionClass;
  key: string;
  fields: Fields;
  /**
   * An issue only: the GitHub issue its record names (the item's `gh:
   * issue-<n>`, set by the IssueOps record writer). The projector ADOPTS
   * that issue as the item's face instead of opening one: it is trusted
   * because the record at S says so, never because of a marker in it.
   */
  adopt?: number;
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
  milestone: Object.freeze({ title: "create", description: "create", state: "state" }),
  issue: Object.freeze({
    title: "create",
    /** The generated block: the projector's marker and everything below it (the reporter's text above it is GitHub-owned). */
    block: "create",
    type: "create",
    labels: "create",
    milestone: "create",
    parent: "link",
    blockedBy: "link",
    state: "state",
    stateReason: "state",
    /** Pinned to the repository's issue list (only MAIN-RED while red carries it). */
    pinned: "state",
  }),
});

/**
 * The git-owned fields NO record holds: the projector computes them (an
 * issue's generated block and its pin, a milestone's computed description and
 * state). An
 * edit of one on GitHub has no record change to propose: it is re-projected,
 * whatever the foreign-edit mode.
 */
export const PROJECTOR_OWNED_FIELDS: Readonly<Record<ProjectionClass, readonly string[]>> = Object.freeze({
  milestone: Object.freeze(["description", "state"]),
  issue: Object.freeze(["block", "pinned"]),
});

/** What GitHub holds for a just-created object before its `link` and `state` writes: a field D gives this value needs no write. */
export const BORN_FIELDS: Readonly<Record<ProjectionClass, Fields>> = Object.freeze({
  milestone: Object.freeze({ state: "open" }),
  issue: Object.freeze({ parent: null, blockedBy: Object.freeze([]), state: "open", stateReason: null, pinned: false }),
});

/** A tracker item as the projection reads it (the parser's `TrackerItem`, src/workflow/failure-owners.ts, plus its path); a Milestone has no state or lane. */
export type InputItem = Readonly<{
  id: string;
  type: string;
  title: string | null;
  state: "open" | "closed" | null;
  resolution: "completed" | "not-planned" | "duplicate" | null;
  lane: string | null;
  milestone: string | null;
  parent: string | null;
  blockedBy: readonly string[];
  decisions: readonly string[];
  tests: readonly string[];
  evidence: string | null;
  body: string;
  /** Repository-relative path of the item's file. */
  path: string;
  /** The GitHub object the record names (`issue-<n>`): the issue the projector adopts as the item's face. */
  gh: string | null;
}>;


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
  /** The decision records' progress facts (an item's state reads them, src/workflow/tracker-status.ts). */
  decisions: readonly Readonly<{ id: string; status: string; implementation: string }>[];
  /** The evidence paths recorded in tracked manifests at S (a close's proof, src/workflow/tracker-status.ts). */
  recordedEvidence: readonly string[];
  /** Main's health per workflow, from the ledger at L (`main-runs.ts`): each failing test with the open records that own it (empty: UNOWNED). */
  mainRuns: readonly Readonly<{
    workflow: string;
    commit: string;
    conclusion: "success" | "failure";
    runUrl: string;
    failedTests: readonly Readonly<{ path: string; message: string; owners: readonly string[] }>[];
  }>[];
}>;

/** The marker's parts: `<!-- bridlewise:item=<key> digest=<sha256> -->`. */
const MARKER_OPEN = "<!-- bridlewise:item=";
const MARKER_DIGEST = " digest=";
const MARKER_CLOSE = " -->";
const DIGEST = /^[0-9a-f]{64}$/u;

/** The projector's marker opening an item's generated block; `digest` is filled in by the host (the confined program imports no hash). */
export function itemMarker(id: string, digest: string): string {
  return `${MARKER_OPEN}${id}${MARKER_DIGEST}${digest}${MARKER_CLOSE}`;
}

/** The projector's END of an item's generated region: `<!-- bridlewise:end=<key> -->`, always the last line of the body it writes. */
const END_OPEN = "<!-- bridlewise:end=";
function itemEndMarker(key: string): string {
  return `${END_OPEN}${key}${MARKER_CLOSE}`;
}

/** What the projector writes between the text above its region (a reporter's, kept exactly) and the region. */
const REGION_SEPARATOR = "\n\n";

/** An issue body as the projector writes it: `above` exactly (when any), then the generated region, closed by its end marker. */
export function regionBody(above: string, block: string, key: string): string {
  return `${above === "" ? "" : `${above}${REGION_SEPARATOR}`}${block}\n${itemEndMarker(key)}`;
}

/**
 * The projector's own region of `body`, found STRUCTURALLY, never by parsing
 * the text above it: the body must END with an end marker (its key), the
 * region begins at the LAST marker of that key before it, and the text
 * above is everything before, with the projector's separator. Anything the
 * text above holds (a marker of any key, a fake end marker) is the text
 * above's. `null` when the body has no such region (none written yet, or
 * text written after the projector's end): the caller keeps the whole body.
 */
export function generatedRegion(body: string): Readonly<{ key: string; above: string; block: string }> | null {
  if (!body.endsWith(MARKER_CLOSE)) return null;
  const endAt = body.lastIndexOf(END_OPEN);
  if (endAt <= 0 || body[endAt - 1] !== "\n") return null;
  const key = body.slice(endAt + END_OPEN.length, body.length - MARKER_CLOSE.length);
  if (key === "" || /\s/u.test(key)) return null;
  const begin = body.lastIndexOf(`${MARKER_OPEN}${key}${MARKER_DIGEST}`, endAt);
  if (begin < 0) return null;
  const before = body.slice(0, begin);
  if (before !== "" && !before.endsWith(REGION_SEPARATOR)) return null;
  return { key, above: before === "" ? "" : before.slice(0, -REGION_SEPARATOR.length), block: body.slice(begin, endAt - 1) };
}

/** Where the first well-formed {@link itemMarker} in `text` begins and the key it names, or `null` when there is none. */
export function findItemMarker(text: string): Readonly<{ index: number; key: string }> | null {
  for (let index = text.indexOf(MARKER_OPEN); index >= 0; index = text.indexOf(MARKER_OPEN, index + 1)) {
    const start = index + MARKER_OPEN.length;
    const digestAt = text.indexOf(MARKER_DIGEST, start);
    const closeAt = text.indexOf(MARKER_CLOSE, start);
    if (digestAt < 0 || closeAt < 0 || closeAt < digestAt) continue;
    const key = text.slice(start, digestAt);
    if (key === "" || /\s/u.test(key) || !DIGEST.test(text.slice(digestAt + MARKER_DIGEST.length, closeAt))) continue;
    return { index, key };
  }
  return null;
}

/** GitHub's limit on an issue body, in characters: a projected body is kept under it. */
export const ISSUE_BODY_LIMIT = 65_536;

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
