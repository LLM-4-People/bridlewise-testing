/**
 * D AND ITS INPUT, from two trees (github-only §9.0, step 1).
 *
 * {@link projectionInput} reads everything D is computed from out of the
 * source commit S (the tracker items, through the tracker's one parser,
 * src/workflow/failure-owners.ts), each lane's label checked against the
 * labels declared at S (`docs/community/labels.json`, read through its owner's
 * `readLabels` from S's tree; the projector creates no label, so an item whose lane label
 * is not declared is refused `projection_label_undeclared` before anything is
 * computed) — nothing else: no
 * working tree, no clock, no GitHub state. {@link computeProjection} hands it
 * to `project()` in two confined processes (`confined.ts`, the answers
 * compared), then fills each marker's digest and digests D. The same S and L
 * always give the same D and the same digest, in any process (V-26).
 */
import { HarnessError } from "../../../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../../kernel/integrity.ts";
import { commitTreeReader, isAncestor, resolveRevision, type TreeReader } from "../../../git/tree-reader.ts";
import { gitOutput, type GitRepository } from "../../../git/git-door.ts";
import { decisionRecords, itemStatusFacts, openBoardRows, ownersOf, trackerItemsOf, treeEntries, type TrackerItem } from "../../failure-owners.ts";
import { LABELS_PATH, readLabels } from "../../community/labels.ts";
import { mainHealth } from "./main-runs.ts";
import { DECISION_INDEX, TRACKER_BOARD } from "../../../kernel/verification-paths.ts";
import { DIGEST_PLACEHOLDER, laneLabel, PROJECTION_INPUT_SCHEMA, PROJECTION_SCHEMA, type ProjectedObject, type Projection, type ProjectionInput } from "./model.ts";
import { confinedCall, PROJECTION_PROGRAM, ROADMAP_FEED_PROGRAM, type ConfinedModule, type ProjectorConfinement } from "./confined.ts";
import { parseEvidenceManifest } from "../../evidence-store.ts";
import { ROOT_POLICY } from "../../../kernel/root-policy.ts";
import { posix } from "node:path";
import { ROADMAP_FEED_INPUT_SCHEMA, ROADMAP_FEED_SCHEMA, type RoadmapFeed, type RoadmapFeedInput } from "./roadmap-feed.ts";

/** The input of D at source commit `source` (and ledger commit `ledger`, null before the ledger exists) of `repository`. */
export function projectionInput(repository: GitRepository, source: string, ledger: string | null, repositoryUrl: string): ProjectionInput {
  const commit = resolveRevision(repository, source);
  if (commit === null) throw new HarnessError(`projection_source_missing: ${source} names no commit of ${repository.root}`, "projection_source_missing");
  const ledgerCommit = ledger === null ? null : resolveRevision(repository, ledger);
  if (ledger !== null && ledgerCommit === null) throw new HarnessError(`projection_ledger_missing: ${ledger} names no commit of ${repository.root}`, "projection_ledger_missing");
  const prefix = `${TRACKER_BOARD.items}/`;
  const tree = commitTreeReader(repository, commit);
  const items = trackerItemsOf(tree);
  requireDeclaredLaneLabels(tree, items);
  requireAdoptableFaces(items);
  return deepFreeze({
    schema: PROJECTION_INPUT_SCHEMA,
    source: commit,
    ledger: ledgerCommit,
    repositoryUrl,
    items: items.map((item) => ({
      id: item.id, type: item.type, title: item.title, state: item.state, resolution: item.resolution, lane: item.lane, milestone: item.milestone,
      parent: item.parent, blockedBy: item.blockedBy, decisions: item.decisions, tests: item.tests, evidence: item.evidence, body: item.body, path: `${prefix}${item.id}.md`, gh: item.gh,
    })),
    decisions: decisionRecords(treeEntries(tree, DECISION_INDEX.path.slice(0, DECISION_INDEX.path.lastIndexOf("/")))).map(({ id, status, implementation }) => ({ id, status, implementation })),
    recordedEvidence: recordedEvidenceAt(tree),
    mainRuns: ledgerCommit === null ? [] : mainRunsAt(repository, ledgerCommit, tree, repositoryUrl),
  });
}

/**
 * Every lane label the items at S carry is declared in S's
 * `docs/community/labels.json` (GitHub compares label names without case):
 * the forge applies that file and the projector creates no label, so an
 * undeclared one is refused here, naming each item and label
 * (`projection_label_undeclared`), and a commit without the file is refused
 * too (`projection_labels_missing`).
 */
function requireDeclaredLaneLabels(tree: TreeReader, items: readonly TrackerItem[]): void {
  if (tree.text(LABELS_PATH) === null) throw new HarnessError(`projection_labels_missing: ${LABELS_PATH} is not in the source commit, so no lane label is declared`, "projection_labels_missing");
  const declared = new Set(readLabels(tree).map((label) => label.name.toLowerCase()));
  const undeclared = items.filter((item) => item.lane !== null && !declared.has(laneLabel(item.lane).toLowerCase())).map((item) => `${item.id} (${laneLabel(item.lane!)})`);
  if (undeclared.length > 0) throw new HarnessError(`projection_label_undeclared: ${undeclared.join(", ")}: declare the label in ${LABELS_PATH} (the projector creates none)`, "projection_label_undeclared");
}

/**
 * Every record that names its GitHub face (`gh`) names an ISSUE: the
 * projector adopts that issue as the item's face. A discussion is no face it
 * projects yet, so a record naming one is refused here, naming each item
 * (`projection_adopt_unsupported`), never projected as a second face.
 */
function requireAdoptableFaces(items: readonly TrackerItem[]): void {
  const unsupported = items.filter((item) => item.gh !== null && !item.gh.startsWith("issue-")).map((item) => `${item.id} (${item.gh!})`);
  if (unsupported.length > 0) throw new HarnessError(`projection_adopt_unsupported: ${unsupported.join(", ")}: the projector adopts an issue as a record's face, not a discussion`, "projection_adopt_unsupported");
}

/**
 * Main's health at the ledger commit `ledger`,
 * each failing test with the OPEN records that own it on S's task board —
 * the same answer the workspace's ledger judge gives (failure-owners.ts
 * `ownersOf`), read from S, never from the working tree.
 */
function mainRunsAt(repository: GitRepository, ledger: string, source: TreeReader, repositoryUrl: string): ProjectionInput["mainRuns"] {
  const runs = mainHealth(commitTreeReader(repository, ledger), { repositoryUrl, isAncestor: (ancestor, descendant) => isAncestor(repository, ancestor, descendant) });
  const board = source.text(TRACKER_BOARD.path);
  const rows = board === null ? [] : openBoardRows(board);
  return runs.map((run) => ({ ...run, failedTests: run.failedTests.map((test) => ({ ...test, owners: ownersOf(rows, test.path) })) }));
}

/** An object with its marker's digest filled in: the sha256 of the object as projected. */
function withDigest(object: ProjectedObject): ProjectedObject {
  const block = object.fields.block;
  if (typeof block !== "string" || !block.includes(DIGEST_PLACEHOLDER)) return object;
  const digest = sha256(canonicalJson(object));
  return { ...object, fields: { ...object.fields, block: block.replace(DIGEST_PLACEHOLDER, digest) } };
}

/**
 * `module.exportName(input)` computed TWICE, in two confined processes, and
 * refused (`projection_nondeterministic`) unless both answer the same: the
 * clock is the one impurity no kernel boundary refuses (the vDSO), so a
 * projection that reads it and lets it change the answer is caught here (V-26:
 * the same digest in two processes, on every computation).
 */
export function deterministicCall(module: ConfinedModule, input: string, confinement: ProjectorConfinement): string {
  const first = confinedCall(module, input, confinement);
  const second = confinedCall(module, input, confinement);
  if (first !== second) throw new HarnessError(`projection_nondeterministic: two confined runs of ${module.exportName} on one input answered differently (${String(first.length)} and ${String(second.length)} characters): it reads something its input does not hold, such as the clock`, "projection_nondeterministic");
  return first;
}

/**
 * D for `input`, computed in confinement (twice, `deterministicCall`), and its
 * digest. An input of another schema, or one whose D would hold two objects
 * of one class under one key, is `projection_input_invalid`.
 */
export function computeProjection(input: ProjectionInput, confinement: ProjectorConfinement): Readonly<{ projection: Projection; digest: string }> {
  if (input.schema !== PROJECTION_INPUT_SCHEMA) throw new HarnessError(`projection_input_invalid: schema ${String(input.schema)} is not ${PROJECTION_INPUT_SCHEMA}`, "projection_input_invalid");
  const answer = JSON.parse(deterministicCall(PROJECTION_PROGRAM, canonicalJson(input), confinement)) as Projection;
  if (answer.schema !== PROJECTION_SCHEMA) throw new HarnessError(`projection_failed: the confined program answered schema ${String(answer.schema)}`, "projection_failed");
  const keys = answer.objects.map((object) => `${object.class}/${object.key}`);
  const twice = keys.filter((key, index) => keys.indexOf(key) !== index);
  if (twice.length > 0) throw new HarnessError(`projection_input_invalid: two objects of the projection are ${[...new Set(twice)].join(", ")}`, "projection_input_invalid");
  const projection: Projection = deepFreeze({ ...answer, objects: answer.objects.map(withDigest) });
  return deepFreeze({ projection, digest: canonicalHash(projection) });
}

/** The evidence paths recorded by every tracked evidence manifest of `tree` (through the store's one manifest parser): a close's `evidence:` proof at that commit. */
function recordedEvidenceAt(tree: TreeReader): readonly string[] {
  const manifests = tree.paths().filter((path) => posix.basename(path) === ROOT_POLICY.workflow.evidenceStore.manifestName);
  tree.prefetch(manifests);
  return manifests.flatMap((manifest) => parseEvidenceManifest(tree.text(manifest) ?? "", manifest).entries.map((entry) => entry.path)).sort();
}

/**
 * The roadmap feed's input at source commit `source`: the items, decision
 * records and recorded evidence at S (the items judged by the format), S's
 * committer date (the feed's "now"), and a snapshot of every item's status
 * facts, the decisions and the recorded evidence at each commit of S's
 * FIRST-PARENT history that changed an item, a decision or an evidence
 * manifest (read as written then, never judged by a later rule) — so the
 * history, and every time the feed shows, is the landings' own. No typed date
 * (an item's `opened`, `closed`) is carried.
 */
export function roadmapFeedInput(repository: GitRepository, source: string, repositoryUrl: string, minimumWeeks: number): RoadmapFeedInput {
  const commit = resolveRevision(repository, source);
  if (commit === null) throw new HarnessError(`projection_source_missing: ${source} names no commit of ${repository.root}`, "projection_source_missing");
  const decisionsDirectory = DECISION_INDEX.path.slice(0, DECISION_INDEX.path.lastIndexOf("/"));
  const tree = commitTreeReader(repository, commit);
  const items = trackerItemsOf(tree);
  const decisions = decisionRecords(treeEntries(tree, decisionsDirectory));
  const sourceDate = gitOutput(repository, ["log", "-1", "--format=%cI", commit]).stdout.toString("utf8").trim();
  const paths = [TRACKER_BOARD.items, decisionsDirectory, `:(glob)**/${ROOT_POLICY.workflow.evidenceStore.manifestName}`];
  const landings = gitOutput(repository, ["log", "--first-parent", "--reverse", "--format=%H %cI", commit, "--", ...paths]).stdout.toString("utf8").split("\n").filter((line) => line.length > 0);
  const history = landings.map((line) => {
    const [landing, date] = line.split(" ") as [string, string];
    const then = commitTreeReader(repository, landing);
    return { commit: landing, date, items: itemStatusFacts(treeEntries(then, TRACKER_BOARD.items)), decisions: decisionRecords(treeEntries(then, decisionsDirectory)), recordedEvidence: recordedEvidenceAt(then) };
  });
  return deepFreeze({
    schema: ROADMAP_FEED_INPUT_SCHEMA,
    source: commit,
    sourceDate,
    repositoryUrl,
    // Every field but the typed dates: the feed's times are the landings'.
    items: items.map(({ opened: _opened, closed: _closed, ...item }) => ({ ...item, path: `${TRACKER_BOARD.items}/${item.id}.md` })),
    decisions,
    recordedEvidence: recordedEvidenceAt(tree),
    history,
    minimumWeeks,
  });
}

/**
 * The roadmap feed for `input` (`bridlewise-roadmap-feed/v1`), computed in
 * confinement (twice, `deterministicCall`), and its digest. An input that
 * carries a typed date on an item is refused (`roadmap_feed_typed_date`): the
 * feed's times come from git landings only.
 */
export function computeRoadmapFeed(input: RoadmapFeedInput, confinement: ProjectorConfinement): Readonly<{ feed: RoadmapFeed; digest: string }> {
  if (input.schema !== ROADMAP_FEED_INPUT_SCHEMA) throw new HarnessError(`projection_input_invalid: schema ${String(input.schema)} is not ${ROADMAP_FEED_INPUT_SCHEMA}`, "projection_input_invalid");
  const dated = input.items.filter((item) => "opened" in item || "closed" in item).map((item) => item.id);
  if (dated.length > 0) throw new HarnessError(`roadmap_feed_typed_date: ${dated.join(", ")} carry a typed date; the feed's times are git landing times only`, "roadmap_feed_typed_date");
  const feed = JSON.parse(deterministicCall(ROADMAP_FEED_PROGRAM, canonicalJson(input), confinement)) as RoadmapFeed;
  if (feed.schema !== ROADMAP_FEED_SCHEMA) throw new HarnessError(`projection_failed: the confined program answered schema ${String(feed.schema)}`, "projection_failed");
  return deepFreeze({ feed, digest: canonicalHash(feed) });
}
