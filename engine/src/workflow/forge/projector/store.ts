/**
 * THE PROJECTION STORE — the one surface the projector reads and writes
 * GitHub through (github-only §9.0, steps 2, 4 and 5).
 *
 * It speaks the projection's own terms: an object is its class, its key (a
 * label's name, an item's id) and its git-owned fields (`FIELD_PHASES`,
 * model.ts). Mapping a key to GitHub's identity (an issue's number, found by
 * the projector's marker), splitting the generated block from a reporter's
 * text above it, and turning a field write into the right API call (a sub-issue
 * link, a dependency, a state change) are the store's job, so the apply
 * algorithm (`apply.ts`) is one algorithm for every class.
 *
 * The GitHub store is written on the forge port's client (GH-1,
 * src/workflow/forge/port.ts `ForgeClient`); the tests run the same algorithm
 * on an in-memory store.
 */
import type { Fields, ProjectionClass, WritePhase } from "./model.ts";

/** One live GitHub object the projector owns or must judge, with its git-owned fields as GitHub now holds them. */
export type LiveObject = Readonly<{
  class: ProjectionClass;
  key: string;
  fields: Fields;
}>;

/** One write: create an object with its `create` fields, or set some fields of an existing one. */
export type ProjectionWrite = Readonly<{
  phase: WritePhase;
  kind: "create" | "update";
  class: ProjectionClass;
  key: string;
  fields: Fields;
}>;

export type ProjectionStore = Readonly<{
  /** Every live object of `classes` (conditional reads: an unchanged answer costs no rate limit). */
  read: (classes: readonly ProjectionClass[]) => Promise<readonly LiveObject[]>;
  /** One write; a refusal is typed (a budget refusal carries when to resume). */
  write: (write: ProjectionWrite) => Promise<void>;
}>;
