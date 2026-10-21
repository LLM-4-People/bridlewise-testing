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
import { TRACKER_BOARD } from "../../../kernel/verification-paths.ts";
import { commitTreeReader, resolveRevision, type GitRepository } from "../../../git/tree-reader.ts";
import { TRACKER_LANES, trackerItems } from "../../failure-owners.ts";
import { DIGEST_PLACEHOLDER, PROJECTION_INPUT_SCHEMA, PROJECTION_SCHEMA, type ProjectedObject, type Projection, type ProjectionInput } from "./model.ts";
import { confinedCall, PROJECTION_PROGRAM, type ConfinedModule, type ProjectorConfinement } from "./confined.ts";

/** The input of D at source commit `source` (and ledger commit `ledger`, null before the ledger exists) of `repository`. */
export function projectionInput(repository: GitRepository, source: string, ledger: string | null, repositoryUrl: string): ProjectionInput {
  const commit = resolveRevision(repository, source);
  if (commit === null) throw new HarnessError(`projection_source_missing: ${source} names no commit of ${repository.root}`, "projection_source_missing");
  const tree = commitTreeReader(repository, commit);
  const prefix = `${TRACKER_BOARD.items}/`;
  const paths = tree.paths().filter((path) => path.startsWith(prefix) && path.endsWith(".md") && !path.slice(prefix.length).includes("/") && path !== `${prefix}README.md`);
  tree.prefetch(paths);
  const items = trackerItems(paths.map((path) => ({ name: path.slice(prefix.length), text: tree.text(path) ?? "" })));
  return deepFreeze({
    schema: PROJECTION_INPUT_SCHEMA,
    source: commit,
    ledger,
    repositoryUrl,
    // A Milestone is projected as a milestone, not an issue (its state is computed from its members).
    items: items.flatMap((item) => (item.state === null || item.lane === null ? [] : [{
      id: item.id, type: item.type, title: item.title, state: item.state, resolution: item.resolution, lane: item.lane,
      parent: item.parent, blockedBy: item.blockedBy, body: item.body, path: `${prefix}${item.id}.md`,
    }])),
    lanes: Object.entries(TRACKER_LANES).map(([lane, { color, description }]) => ({ lane, color, description })),
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
