/**
 * REUSE BY THE KEY K (github-only §5.4, ci §3.3–§3.4): a tree that the door
 * already judged — the same tree, catalogue, toolchain, config, runner class
 * and probes, so the same K — is not run again; the door's attested verdict
 * for K is the proof.
 *
 * ONE PATH, TWO ROLES:
 *   - the LOCATOR is an artifact the door uploads with every verdict,
 *     `door-verdict-<K>-<success|failure>` (the artifacts API filters by
 *     name), holding the key document and the predicate;
 *   - the PROOF is the door's Sigstore attestation of that verdict, whose
 *     subject is the key document itself: `gh attestation verify keydoc.json`
 *     bound to `door.yml` on `main`, on a GitHub-hosted runner, with the
 *     verdict predicate type. A locator without a valid proof reuses nothing.
 *
 * ELIGIBILITY: a pull request from a fork, a tree that changes the pipeline's
 * owner (the gate catalogue or its generator), a cold run (the door's button
 * or the nightly schedule), and a key with ANY failed verdict on record (a
 * failure of this exact key stands until a new tree; FLAKE-REPRO) never
 * reuse; they run cold.
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import type { ForgeClient } from "../forge/port.ts";
import { GENERATOR_SOURCES } from "./catalogue.ts";

/** The predicate type of the door's verdict attestation. */
export const DOOR_PREDICATE_TYPE = "https://bridlewise.dev/attestations/gate-verdict/v1";

export type VerdictOutcome = "success" | "failure";

/** The locator artifact's name for a verdict of K. */
export function verdictLocatorName(key: string, outcome: VerdictOutcome): string {
  if (!/^[0-9a-f]{64}$/u.test(key)) throw new InputError("a verdict locator names a full key", "gate_reuse_invalid");
  return `door-verdict-${key}-${outcome}`;
}

export type Locator = Readonly<{ artifactId: number; runId: number; name: string }>;

/** The newest unexpired locator of K's `outcome` verdict, or null. */
export async function findVerdictLocator(client: ForgeClient, repository: Readonly<{ owner: string; name: string }>, key: string, outcome: VerdictOutcome): Promise<Locator | null> {
  const name = verdictLocatorName(key, outcome);
  const answer = (await client.rest({ method: "GET", path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/actions/artifacts`, query: { name, per_page: 100 } })).data as { artifacts?: unknown };
  if (!Array.isArray(answer.artifacts)) throw new InputError("GitHub answered an artifact list without artifacts", "gate_reuse_invalid");
  const live = (answer.artifacts as Readonly<Record<string, unknown>>[])
    .filter((artifact) => artifact.name === name && artifact.expired !== true && typeof artifact.id === "number")
    .map((artifact) => ({ artifactId: artifact.id as number, runId: (artifact.workflow_run as { id?: unknown } | undefined)?.id, created: String(artifact.created_at ?? "") }))
    .filter((artifact): artifact is { artifactId: number; runId: number; created: string } => typeof artifact.runId === "number")
    .toSorted((left, right) => (left.created < right.created ? 1 : left.created > right.created ? -1 : 0));
  const newest = live[0];
  return newest === undefined ? null : deepFreeze({ artifactId: newest.artifactId, runId: newest.runId, name });
}

export type ReuseEligibility = Readonly<{ eligible: boolean; reasons: readonly string[] }>;

/** Whether a run may reuse at all (before any lookup). */
export function reuseEligibility(facts: Readonly<{ fork: boolean; generatorChanged: boolean; cold: boolean; failedBefore: boolean }>): ReuseEligibility {
  const reasons = [
    ...(facts.fork ? ["a fork's run is never reused"] : []),
    ...(facts.generatorChanged ? ["the tree changes the pipeline's owner (the gate catalogue or its generator)"] : []),
    ...(facts.cold ? ["a cold run reuses nothing"] : []),
    ...(facts.failedBefore ? ["a failed verdict of this exact key stands until a new tree"] : []),
  ];
  return deepFreeze({ eligible: reasons.length === 0, reasons });
}

/** The object id `<commit>:<path>` names, or null when the commit holds no such path (the one reader; the door's ratchet uses it too). */
export function pathObjectId(repository: GitRepository, commit: string, path: string): string | null {
  const answer = gitOutput(repository, ["rev-parse", "--verify", "--quiet", `${commit}:${path}`], { allowed: [0, 1, 128] });
  const id = answer.stdout.toString("utf8").trim();
  return answer.status === 0 && /^[0-9a-f]{40}$/u.test(id) ? id : null;
}

/** Whether `commit` changes the pipeline's owner against `base` (each owner path's object id compared). */
export function pipelineChanged(repository: GitRepository, commit: string, base: string): boolean {
  return GENERATOR_SOURCES.some((path) => pathObjectId(repository, commit, path) !== pathObjectId(repository, base, path));
}

export type ReuseProof = Readonly<{ key: string; predicate: Readonly<Record<string, unknown>> }>;

/**
 * Judges `gh attestation verify keydoc.json --format json` (run with the
 * signer workflow, source ref, runner and predicate type bound) against K:
 * the key document hashes to K, and a verified statement for subject K
 * carries the door's predicate with verdict `success` for K. Anything else is
 * the typed `gate_reuse_unproven`, never a guessed pass.
 */
export function judgeReuseProof(key: string, keyDocumentBytes: string | Buffer, verified: unknown): ReuseProof {
  const refuse = (why: string): never => {
    throw new InputError(`reuse of ${key} is unproven: ${why}`, "gate_reuse_unproven");
  };
  if (sha256(keyDocumentBytes) !== key) refuse("the key document does not hash to the key");
  if (!Array.isArray(verified) || verified.length === 0) refuse("no verified attestation");
  for (const entry of verified as unknown[]) {
    const statement = ((entry as { verificationResult?: { statement?: unknown } } | null)?.verificationResult?.statement ?? null) as Readonly<Record<string, unknown>> | null;
    if (statement === null) continue;
    const subjects = Array.isArray(statement.subject) ? (statement.subject as Readonly<Record<string, unknown>>[]) : [];
    const names = subjects.some((subject) => (subject.digest as { sha256?: unknown } | undefined)?.sha256 === key);
    const predicate = statement.predicate as Readonly<Record<string, unknown>> | undefined;
    if (names && statement.predicateType === DOOR_PREDICATE_TYPE && predicate !== undefined && predicate.verdict === "success" && predicate.key === key) {
      return deepFreeze({ key, predicate });
    }
  }
  return refuse("no verified statement names this key with a successful door verdict");
}
