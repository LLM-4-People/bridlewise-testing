/**
 * `project(S, L)` — THE DESIRED GITHUB STATE, a pure function of its input
 * (github-only §9.0).
 *
 * PURE: it imports only the projection's other pure modules, and runs in a
 * separate process under the harness's confinement (`confined.ts`): no file
 * and no network reachable, the program and its input on stdin, its answer on
 * stdout; computed twice and refused if the two differ. The same input always
 * gives the same D; the host spells it canonically (`canonicalJson`) and
 * digests it.
 *
 * What it projects (each class's fields are `FIELD_PHASES`, model.ts):
 *   - `label`: one per tracker lane (`lane:<lane>`, its colour and description);
 *   - `issue`: one per tracker item — its title (the item's title, or its id),
 *     its issue type, its lane label, its parent (a sub-issue link), what
 *     blocks it (dependency links), open or closed with its reason, and its
 *     generated block: the projector's marker, the item's body with every
 *     relative link made a permalink at S, and a footer that permalinks the
 *     record itself, so any public claim can be audited down to the commit.
 */
import { rewriteRelativeLinks } from "../../markdown-links.ts";
import {
  DIGEST_PLACEHOLDER, PROJECTION_CLASSES, PROJECTION_SCHEMA, STATE_REASONS,
  itemMarker, laneLabel, type InputItem, type ProjectedObject, type Projection, type ProjectionInput,
} from "./model.ts";

function byCode(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** An item's generated block: the marker (its digest filled in by the host), the body with permalinks, the record's own permalink. */
function itemBlock(item: InputItem, input: ProjectionInput): string {
  const blob = `${input.repositoryUrl}/blob/${input.source}`;
  const body = rewriteRelativeLinks(item.body, folderOf(item.path), (path, fragment) => `${blob}/${path}${fragment}`);
  return [
    itemMarker(item.id, DIGEST_PLACEHOLDER),
    body,
    "",
    "---",
    `<sub>Projected from [\`${item.path}\`](${blob}/${item.path}) at ${input.source}. This issue mirrors the record: change the record, not this text.</sub>`,
  ].join("\n");
}

function itemIssue(item: InputItem, input: ProjectionInput): ProjectedObject {
  return {
    class: "issue",
    key: item.id,
    fields: {
      title: item.title ?? item.id,
      block: itemBlock(item, input),
      type: item.type,
      labels: [laneLabel(item.lane)],
      parent: item.parent,
      blockedBy: [...item.blockedBy].sort(byCode),
      state: item.state,
      stateReason: item.resolution === null ? null : STATE_REASONS[item.resolution],
    },
  };
}

/** D for `input`. */
export function project(input: ProjectionInput): Projection {
  const labels: ProjectedObject[] = input.lanes.map((lane) => ({ class: "label", key: laneLabel(lane.lane), fields: { color: lane.color, description: lane.description } }));
  const issues = input.items.map((item) => itemIssue(item, input));
  const order = (object: ProjectedObject): number => PROJECTION_CLASSES.indexOf(object.class);
  const objects = [...labels, ...issues].sort((left, right) => order(left) - order(right) || byCode(left.key, right.key));
  return { schema: PROJECTION_SCHEMA, source: input.source, ledger: input.ledger, objects };
}

/** The confined program's entry: the input's JSON text in, D's JSON text out (only text crosses the boundary). */
export function projectText(inputText: string): string {
  return JSON.stringify(project(JSON.parse(inputText) as ProjectionInput));
}
