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
 *   - `milestone`: one per Milestone item (`<id> · <title>`, its computed state
 *     and the reason in the description, closed once shipped);
 *   - `issue`: one per tracker item, Milestones included — its title (the
 *     item's title, or its id), its issue type, its lane label, its milestone,
 *     its parent (a sub-issue link: the item's parent, else its Milestone's
 *     issue, so the hierarchy reads milestone → workstream → task), what
 *     blocks it (dependency links), open or closed with its reason (a
 *     Milestone's from its computed state), and its generated block: the
 *     projector's marker, the item's body with every relative link made a
 *     permalink at S, its computed roadmap state with the evidence, and a
 *     footer that permalinks the record itself, so any public claim can be
 *     audited down to the commit;
 *   - MAIN-RED: one issue per workflow judged on `main` in the ledger
 *     (`MAIN-RED/<workflow>`, type Bug): open and PINNED while the workflow's
 *     last run on main failed, its body naming every failing test and the
 *     open records that own it, or UNOWNED (the same answer the ledger judge
 *     gives); closed as completed, unpinned, once main is green again. It
 *     replaces the failure-issue workflow (one issue per failed run, title-keyed).
 */
import { compareUtf8Bytes } from "../../../kernel/ordered.ts";
import { rewriteRelativeLinks } from "../../markdown-links.ts";
import { itemStatuses, type ItemStatus } from "../../tracker-status.ts";
import {
  DIGEST_PLACEHOLDER, PROJECTION_CLASSES, PROJECTION_SCHEMA, STATE_REASONS,
  itemMarker, laneLabel, type InputItem, type ProjectedObject, type Projection, type ProjectionInput,
} from "./model.ts";

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** An item's generated block: the marker (its digest filled in by the host), the body with permalinks, its computed roadmap state, the record's own permalink. */
function itemBlock(item: InputItem, status: ItemStatus, input: ProjectionInput): string {
  const blob = `${input.repositoryUrl}/blob/${input.source}`;
  const body = rewriteRelativeLinks(item.body, folderOf(item.path), (path, fragment) => `${blob}/${path}${fragment}`);
  return [
    itemMarker(item.id, DIGEST_PLACEHOLDER),
    body,
    "",
    "---",
    `<sub>Roadmap state: **${status.state}** (${status.because}), computed from the records. Projected from [\`${item.path}\`](${blob}/${item.path}) at ${input.source}. This issue mirrors the record: change the record, not this text.</sub>`,
  ].join("\n");
}

function itemIssue(item: InputItem, status: ItemStatus, input: ProjectionInput): ProjectedObject {
  const milestone = item.type === "Milestone";
  // A Milestone is open or closed by its computed state; any other item by its record.
  const closed = milestone ? status.state === "shipped" : item.state === "closed";
  const reason = milestone ? (closed ? "completed" : null) : item.resolution === null ? null : STATE_REASONS[item.resolution];
  return {
    class: "issue",
    key: item.id,
    fields: {
      title: item.title ?? item.id,
      block: itemBlock(item, status, input),
      type: item.type,
      labels: item.lane === null ? [] : [laneLabel(item.lane)],
      milestone: milestone ? item.id : item.milestone,
      parent: milestone ? null : item.parent ?? item.milestone,
      blockedBy: [...item.blockedBy].sort(compareUtf8Bytes),
      state: closed ? "closed" : "open",
      stateReason: reason,
    },
  };
}

/** A Milestone item's GitHub milestone: `<id> · <title>`, its computed state and why, its record; closed once shipped. */
function milestoneObject(item: InputItem, status: ItemStatus, input: ProjectionInput): ProjectedObject {
  return {
    class: "milestone",
    key: item.id,
    fields: {
      title: `${item.id} · ${item.title ?? item.id}`,
      description: `${status.state}: ${status.because}. Computed from the records; the plan is ${input.repositoryUrl}/blob/${input.source}/${item.path}`,
      state: status.state === "shipped" ? "closed" : "open",
    },
  };
}

/** The MAIN-RED issue of one workflow judged on main. */
function mainRedIssue(run: ProjectionInput["mainRuns"][number], input: ProjectionInput): ProjectedObject {
  const key = `MAIN-RED/${run.workflow}`;
  const commit = `[\`${run.commit}\`](${input.repositoryUrl}/commit/${run.commit})`;
  const red = run.conclusion === "failure";
  const owner = (owners: readonly string[]): string => (owners.length === 0 ? "**UNOWNED**" : owners.map((id) => `\`${id}\``).join(", "));
  const firstLine = (message: string): string => (message.split("\n")[0] ?? "").replace(/\|/gu, "\\|");
  const body = red
    ? [
      `The last judged \`${run.workflow}\` run on \`main\`, at ${commit}, **failed** ([the run](${run.runUrl})).`,
      "",
      run.failedTests.length === 0 ? "It names no failing test: the failure is a gate or a finding of the judge (see the run)." : "| Failing test | Owned by | First line |\n|---|---|---|",
      ...run.failedTests.map((test) => `| \`${test.path}\` | ${owner(test.owners)} | ${firstLine(test.message)} |`),
      "",
      "An UNOWNED failure has no open record that names it: open one, or fix it. This issue closes when main is green again.",
    ]
    : [`The last judged \`${run.workflow}\` run on \`main\`, at ${commit}, **passed** ([the run](${run.runUrl})). Main is green again for \`${run.workflow}\`.`];
  return {
    class: "issue",
    key,
    fields: {
      title: red ? `main is red: ${run.workflow}` : `main is green again: ${run.workflow}`,
      block: [itemMarker(key, DIGEST_PLACEHOLDER), ...body, "", "---", `<sub>Projected from the ledger at ${input.ledger ?? "(none)"}; it mirrors main's last judged run.</sub>`].join("\n"),
      type: "Bug",
      labels: [],
      milestone: null,
      parent: null,
      blockedBy: [],
      state: red ? "open" : "closed",
      stateReason: red ? null : "completed",
      pinned: red,
    },
  };
}

/** D for `input`. */
export function project(input: ProjectionInput): Projection {
  const statuses = itemStatuses(input.items, { decisions: input.decisions, recordedEvidence: new Set(input.recordedEvidence), repositoryUrl: input.repositoryUrl });
  const status = (item: InputItem): ItemStatus => statuses.get(item.id) ?? { state: "planned", because: "not judged" };
  const labels: ProjectedObject[] = input.lanes.map((lane) => ({ class: "label", key: laneLabel(lane.lane), fields: { color: lane.color, description: lane.description } }));
  const milestones = input.items.filter((item) => item.type === "Milestone").map((item) => milestoneObject(item, status(item), input));
  const issues = [...input.items.map((item) => itemIssue(item, status(item), input)), ...input.mainRuns.map((run) => mainRedIssue(run, input))];
  const order = (object: ProjectedObject): number => PROJECTION_CLASSES.indexOf(object.class);
  const objects = [...labels, ...milestones, ...issues].sort((left, right) => order(left) - order(right) || compareUtf8Bytes(left.key, right.key));
  return { schema: PROJECTION_SCHEMA, source: input.source, ledger: input.ledger, objects };
}

/** The confined program's entry: the input's JSON text in, D's JSON text out (only text crosses the boundary). */
export function projectText(inputText: string): string {
  return JSON.stringify(project(JSON.parse(inputText) as ProjectionInput));
}
