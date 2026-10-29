/**
 * THE PROJECTION STORE — the one surface the projector reads and writes
 * GitHub through (github-only §9.0, steps 2, 4 and 5).
 *
 * It speaks the projection's own terms: an object is its class, its key (a
 * milestone's or an item's id) and its git-owned fields (`FIELD_PHASES`,
 * model.ts). Mapping a key to GitHub's identity (an issue's number, found by
 * the projector's marker), splitting the generated block from a reporter's
 * text above it, and turning a field write into the right API call (a sub-issue
 * link, a dependency, a state change) are the store's job, so the apply
 * algorithm (`apply.ts`) is one algorithm for every class.
 *
 * The GitHub store (`github-store.ts`) is written on the forge port's client
 * (src/workflow/forge/port.ts `ForgeClient`); the algorithm's own tests run
 * on an in-memory store.
 */
import type { Fields, ProjectionClass, WritePhase } from "./model.ts";

/** One live GitHub object the projector owns or must judge, with its git-owned fields as GitHub now holds them. */
export type LiveObject = Readonly<{
  class: ProjectionClass;
  key: string;
  fields: Fields;
  /**
   * Whether the projector made it: an issue carrying its marker, a milestone
   * it created. Only an owned object D does not hold is an orphan; a
   * person's issue is GitHub's own.
   */
  owned: boolean;
  /**
   * An ADOPTED issue only: the text above the projector's region, the
   * reporter's, exactly. The apply algorithm records its digest and never
   * writes the region over an edit of it (a foreign edit, reported).
   */
  above?: string;
}>;

/** One write: create an object with its `create` fields, set some fields of an existing one, or post a notice on it (an issue comment: `fields.text`). */
export type ProjectionWrite = Readonly<{
  phase: WritePhase;
  kind: "create" | "update" | "notice";
  class: ProjectionClass;
  key: string;
  fields: Fields;
}>;

/**
 * The issues D adopts: each item key → the GitHub issue number its record
 * names (model.ts `ProjectedObject.adopt`), and whether the projector has
 * ESTABLISHED its region there (the previous receipt recorded the reporter's
 * text). The store reads each as that item's live issue, whoever opened it;
 * a number that names no issue, or a pull request, is refused typed. Until
 * the region is established, the WHOLE body is the reporter's text: a region
 * a reporter forged at the end of their own text is never taken for the
 * projector's.
 */
export type Adoptions = ReadonlyMap<string, Readonly<{ number: number; established: boolean }>>;

export type ProjectionStore = Readonly<{
  /** Every live object of `classes` (conditional reads: an unchanged answer costs no rate limit). The GitHub store paces its content-creating writes by GitHub's own answer (`retry-after`, the secondary-limit reset), never a fixed sleep. */
  read: (classes: readonly ProjectionClass[], adoptions: Adoptions) => Promise<readonly LiveObject[]>;
  /** One write; a refusal is typed (a budget refusal carries when to resume). */
  write: (write: ProjectionWrite) => Promise<void>;
}>;
