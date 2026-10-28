/**
 * D AND ITS INPUT, from two trees (github-only §9.0, step 1).
 *
 * {@link projectionInput} reads everything D is computed from out of the
 * source commit S (the tracker items, through the tracker's one parser,
 * src/workflow/failure-owners.ts; the lanes' labels) — nothing else: no
 * working tree, no clock, no GitHub state. {@link computeProjection} hands it
 * to `project()` in two confined processes (`confined.ts`, the answers
 * compared), then fills each marker's digest and digests D. The same S and L
 * always give the same D and the same digest, in any process (V-26).
 */
import { HarnessError } from "../../../kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../../kernel/integrity.ts";
import { commitTreeReader, gitOutput, resolveRevision, type GitRepository, type TreeReader } from "../../../git/tree-reader.ts";
import { decisionRecords, itemStatusFacts, TRACKER_LANES, trackerItems } from "../../failure-owners.ts";
import { DECISION_INDEX, TRACKER_BOARD } from "../../../kernel/verification-paths.ts";
import { DIGEST_PLACEHOLDER, PROJECTION_INPUT_SCHEMA, PROJECTION_SCHEMA, type ProjectedObject, type Projection, type ProjectionInput } from "./model.ts";
import { confinedCall, PROJECTION_PROGRAM, ROADMAP_FEED_PROGRAM, type ConfinedModule, type ProjectorConfinement } from "./confined.ts";
import { parseEvidenceManifest } from "../../evidence-store.ts";
import { ROOT_POLICY } from "../../../kernel/root-policy.ts";
import { posix } from "node:path";
import { ROADMAP_FEED_INPUT_SCHEMA, ROADMAP_FEED_SCHEMA, type RoadmapFeed, type RoadmapFeedInput } from "./roadmap-feed.ts";

/** The input of D at source commit `source` (and ledger commit `ledger`, null before the ledger exists) of `repository`. */
export function projectionInput(repository: GitRepository, source: string, ledger: string | null, repositoryUrl: string): ProjectionInput {
  const commit = resolveRevision(repository, source);
  if (commit === null) throw new HarnessError(`projection_source_missing: ${source} names no commit of ${repository.root}`, "projection_source_missing");
  const prefix = `${TRACKER_BOARD.items}/`;
  const tree = commitTreeReader(repository, commit);
  const items = trackerItems(treeEntries(tree, TRACKER_BOARD.items));
  return deepFreeze({
    schema: PROJECTION_INPUT_SCHEMA,
    source: commit,
    ledger,
    repositoryUrl,
    items: items.map((item) => ({
      id: item.id, type: item.type, title: item.title, state: item.state, resolution: item.resolution, lane: item.lane, milestone: item.milestone,
      parent: item.parent, blockedBy: item.blockedBy, decisions: item.decisions, tests: item.tests, evidence: item.evidence, body: item.body, path: `${prefix}${item.id}.md`,
    })),
    lanes: Object.entries(TRACKER_LANES).map(([lane, { color, description }]) => ({ lane, color, description })),
    decisions: decisionRecords(treeEntries(tree, DECISION_INDEX.path.slice(0, DECISION_INDEX.path.lastIndexOf("/")))).map(({ id, status, implementation }) => ({ id, status, implementation })),
    recordedEvidence: recordedEvidenceAt(tree),
  });
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

/** The `.md` entries directly in `directory` of `tree` (not its README), read in one batch. */
function treeEntries(tree: TreeReader, directory: string): readonly { name: string; text: string }[] {
  const prefix = `${directory}/`;
  const paths = tree.paths().filter((path) => path.startsWith(prefix) && path.endsWith(".md") && !path.slice(prefix.length).includes("/") && path !== `${prefix}README.md`);
  tree.prefetch(paths);
  return paths.map((path) => ({ name: path.slice(prefix.length), text: tree.text(path) ?? "" }));
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
  const items = trackerItems(treeEntries(tree, TRACKER_BOARD.items));
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
