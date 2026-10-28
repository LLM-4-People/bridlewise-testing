/**
 * THE PROVING GROUND'S API RULES, on any forge client: the repository's
 * identity (the one `provingGround` repository of the forge section, never
 * the trunk), its seed, the read-only configuration check, the reads a
 * scenario judges by (a deleted branch, a commit's verification), and the
 * VERDICT RULES of the workspace's scenarios (V-6, V-14, V-15) and of the
 * projector's (V-25, V-28). The proving scenarios (`proving/`, real GitHub as
 * the agent App, or as the publisher App for the projection) and their offline
 * tests (`proving-ground-api.test.ts`, the fake GitHub) both use this module;
 * no offline test reaches `proving/` itself (`proving-isolation.test.ts`).
 */
import { HarnessError } from "../../src/kernel/errors.ts";
import { ForgeError, isForgeError } from "../../src/workflow/forge/codes.ts";
import { trunkRepository, type ForgeSettings } from "../../src/workflow/forge/forge-config.ts";
import type { ForgeClient } from "../../src/workflow/forge/port.ts";
import { projectionFailure, type ProjectionReceipt } from "../../src/workflow/forge/projector/apply.ts";

export type ProvingGround = Readonly<{ owner: string; name: string; webUrl: string; client: ForgeClient }>;

/**
 * THE PROVING GROUND'S NAME, from the one repository identity (the `forge`
 * section's repositories): exactly one is declared `provingGround`, and it is
 * never the trunk — a scenario writes, lands and deletes branches, so it runs
 * only where the configuration says it may (`proving_ground_undeclared`,
 * `proving_ground_is_trunk`).
 */
export function provingGroundRepository(settings: ForgeSettings): string {
  const declared = settings.repositories.filter((repository) => repository.provingGround === true);
  if (declared.length !== 1) {
    throw new HarnessError(`the forge section declares ${String(declared.length)} proving grounds (${declared.map((repository) => repository.name).join(", ") || "none"}), not exactly one: the scenarios run nowhere else`, "proving_ground_undeclared");
  }
  const ground = declared[0]!;
  // The section holds exactly one trunk, so "is the trunk" is one name comparison (whatever kind the entry claims).
  if (ground.name.toLowerCase() === trunkRepository(settings).name.toLowerCase()) {
    throw new HarnessError(`${ground.name} is the trunk: the scenarios never run on it`, "proving_ground_is_trunk");
  }
  return ground.name;
}

export function provingGroundPath(ground: ProvingGround, rest = ""): string {
  return `/repos/${encodeURIComponent(ground.owner)}/${encodeURIComponent(ground.name)}${rest}`;
}

/** `main`'s head, or null while the repository is empty (GitHub answers 409) or has no `main`. */
export async function mainHead(ground: ProvingGround): Promise<string | null> {
  try {
    const answer = await ground.client.rest<{ object?: { sha?: unknown } }>({ method: "GET", path: provingGroundPath(ground, "/git/ref/heads/main") });
    return typeof answer.data?.object?.sha === "string" ? answer.data.object.sha : null;
  } catch (error) {
    if (isForgeError(error, "github_conflict", "github_not_found")) return null;
    throw error;
  }
}

/**
 * THE SEED: the repository's first commit on `main` (a README), made by the
 * agent through the contents API, only while the repository is empty.
 * Answers `main`'s head and whether this call made it.
 */
export async function seedMain(ground: ProvingGround): Promise<Readonly<{ head: string; created: boolean }>> {
  const existing = await mainHead(ground);
  if (existing !== null) return Object.freeze({ head: existing, created: false });
  const readme = "# forge-proving-ground\n\nThe proving ground of the Bridlewise forge (runbook P1.11, P3.8): scenarios run here against real GitHub; nothing here is product code.\n";
  const answer = await ground.client.rest<{ commit?: { sha?: unknown } }>({
    method: "PUT", path: provingGroundPath(ground, "/contents/README.md"),
    body: { message: "Seed the proving ground", content: Buffer.from(readme, "utf8").toString("base64"), branch: "main" },
  });
  const head = answer.data?.commit?.sha;
  if (typeof head !== "string") throw new ForgeError("github_response_invalid", "GitHub's answer to the seed commit names no commit.", { path: provingGroundPath(ground, "/contents/README.md") });
  return Object.freeze({ head, created: true });
}

/** What the scenarios need of the repository's configuration (see the header). */
export const REQUIRED_RULES = Object.freeze(["merge_queue", "required_signatures"] as const);

/**
 * Refuses (`proving_ground_unconfigured`) unless the proving ground is
 * configured as the scenarios need: `main` exists, the rules in force on it
 * include {@link REQUIRED_RULES}, and the repository deletes a merged head
 * branch. Read as the agent (`GET …/rules/branches/main` answers the rules in
 * force to any reader).
 */
export async function requireConfigured(ground: ProvingGround): Promise<void> {
  const missing: string[] = [];
  if (await mainHead(ground) === null) missing.push("a main branch (run `seed`)");
  const repository = await ground.client.rest<{ delete_branch_on_merge?: unknown }>({ method: "GET", path: provingGroundPath(ground) });
  if (repository.data?.delete_branch_on_merge !== true) missing.push("delete_branch_on_merge: true");
  const rules = missing.length > 0 && missing[0]!.startsWith("a main") ? [] : (await ground.client.rest<readonly { type?: unknown }[]>({ method: "GET", path: provingGroundPath(ground, "/rules/branches/main") })).data ?? [];
  const types = new Set(rules.map((rule) => rule.type));
  for (const rule of REQUIRED_RULES) if (!types.has(rule)) missing.push(`the ${rule} rule on main`);
  if (missing.length > 0) {
    throw new HarnessError(
      `${ground.owner}/${ground.name} is not configured for the scenarios: missing ${missing.join(", ")} — its configuration is declared in the forge's settings-as-code and applied by \`harness forge apply\`, never by hand`,
      "proving_ground_unconfigured",
    );
  }
}

/** Whether `branch` is gone from the proving ground: GitHub answers 404 for it. Any other refusal is the forge's error, never "gone". */
export async function branchGone(ground: ProvingGround, branch: string): Promise<boolean> {
  try {
    await ground.client.rest({ method: "GET", path: provingGroundPath(ground, `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`) });
    return false;
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return true;
    throw error;
  }
}

/** The commit's signature verification as GitHub reports it. */
export async function commitVerification(ground: ProvingGround, sha: string): Promise<Readonly<{ verified: boolean; reason: string }>> {
  const answer = await ground.client.rest<{ verification?: { verified?: unknown; reason?: unknown } }>({ method: "GET", path: provingGroundPath(ground, `/git/commits/${sha}`) });
  return Object.freeze({ verified: answer.data?.verification?.verified === true, reason: String(answer.data?.verification?.reason ?? "unknown") });
}

/**
 * A PRECONDITION OF THE PROJECTOR'S SCENARIOS: each label in `names` exists
 * on the proving ground (GitHub compares label names without case). The
 * projector is not a label's owner, and GitHub would create a missing label
 * an issue write names, so a scenario verifies its labels before its first
 * write and refuses typed (`proving_ground_label_missing`, naming each
 * missing one) — a read only, never a write.
 */
export async function requireLabels(ground: ProvingGround, names: readonly string[], maxPages: number): Promise<void> {
  const live = new Set((await ground.client.paginate<{ name: string }>({ path: provingGroundPath(ground, "/labels") }, { maxPages, perPage: 100 })).map((label) => label.name.toLowerCase()));
  const missing = names.filter((name) => !live.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new HarnessError(`${ground.owner}/${ground.name} has no label ${missing.join(", ")}: the projector's scenarios need it there before their first write (declare it and apply it on the proving ground; the projector never creates one)`, "proving_ground_label_missing", false, { labels: missing.join(",") });
  }
}

export type Verdict = Readonly<{ v: string; status: "pass" | "fail"; detail: string; evidence: readonly string[] }>;

/** A verdict from named checks: pass only when every one held (the failed ones are named). */
export function verdictOf(v: string, checks: Readonly<Record<string, boolean>>, evidence: readonly string[]): Verdict {
  const failed = Object.entries(checks).filter(([, held]) => !held).map(([name]) => name);
  return { v, status: failed.length === 0 ? "pass" : "fail", evidence, detail: failed.length === 0 ? `held: ${Object.keys(checks).join("; ")}` : `failed: ${failed.join("; ")}` };
}

/** V-6's rule: every API commit the agent published is Verified, and so is the queue's merge commit of them. */
export function v6Verdict(input: Readonly<{ commits: readonly Readonly<{ sha: string; verified: boolean }>[]; merge: Readonly<{ verified: boolean }> }>, evidence: readonly string[]): Verdict {
  return verdictOf("V-6", {
    "the round published at least one API commit": input.commits.length > 0,
    "every API commit by the agent App is Verified": input.commits.every((commit) => commit.verified),
    "the queue's merge commit is Verified (required_signatures)": input.merge.verified,
  }, evidence);
}

/** V-15's rule: `ws land` was seen in the required queue, and the land reports the merge at exactly the published head. */
export function v15Verdict(input: Readonly<{ seenQueued: boolean; publishedHead: string; landedHead: string }>, evidence: readonly string[]): Verdict {
  return verdictOf("V-15", {
    "the pull request was seen in the merge queue": input.seenQueued,
    "the outcome names the merge at exactly the published head": input.landedHead === input.publishedHead,
  }, evidence);
}

/** V-14's rule (a two-part stack through the real queue with delete_branch_on_merge). */
export function v14Verdict(input: Readonly<{
  childBase: unknown; refusedBeforeParent: boolean; parentBranchGone: boolean; childStateAfterParent: unknown;
  childHead: string; childLandedHead: string; childChangedPaths: readonly string[]; childPath: string;
}>, evidence: readonly string[]): Verdict {
  return verdictOf("V-14", {
    "the child's pull request is against main": input.childBase === "main",
    "the child was refused before its parent landed": input.refusedBeforeParent,
    "the parent's branch was deleted on merge": input.parentBranchGone,
    "the child's pull request stayed open after its parent landed": input.childStateAfterParent === "open",
    "the child landed at its own published head": input.childLandedHead === input.childHead,
    "the child landed only its own change": input.childChangedPaths.length === 1 && input.childChangedPaths[0] === input.childPath,
  }, evidence);
}

/**
 * V-25's rule (idempotent): the first run left the proving ground verified at
 * D, and a second run of the SAME D wrote nothing and is verified too.
 */
export function v25Verdict(input: Readonly<{ first: ProjectionReceipt; second: ProjectionReceipt }>, evidence: readonly string[]): Verdict {
  const { first, second } = input;
  return verdictOf("V-25", {
    "the first run is verified at D": first.verified,
    "both runs projected the same D": first.digest === second.digest,
    "the second run made zero writes": second.writes.length === 0,
    "the second run is verified": second.verified,
  }, evidence);
}

/**
 * V-28's rule (a silent drop is caught): GitHub accepted a write of
 * `candidate` (`<class>/<key>.<field>`) and did not keep it, and the run's
 * re-read caught exactly that: it wrote the field, is not verified, fails
 * `projection_unverified`, names the candidate, and names nothing it did not
 * write. A run where GitHub KEPT the candidate fails, saying so: the candidate
 * is then no silent drop, and V-28 needs another.
 */
export function v28Verdict(input: Readonly<{ receipt: ProjectionReceipt; candidate: string }>, evidence: readonly string[]): Verdict {
  const { receipt, candidate } = input;
  const cut = candidate.lastIndexOf(".");
  const [object, field] = [candidate.slice(0, cut), candidate.slice(cut + 1)];
  const written = new Set(receipt.writes.flatMap((write) => write.fields.map((name) => `${write.class}/${write.key}.${name}`)));
  const unverified = receipt.unverified.map((entry) => `${entry.class}/${entry.key}.${entry.field}`);
  return verdictOf("V-28", {
    [`the run wrote ${candidate}`]: receipt.writes.some((write) => `${write.class}/${write.key}` === object && write.fields.includes(field)),
    "the run is not verified": !receipt.verified,
    "its failure is projection_unverified": projectionFailure(receipt)?.code === "projection_unverified",
    [`GitHub did not keep ${candidate}, and the re-read names it`]: unverified.includes(candidate),
    "every unverified field is one the run wrote": unverified.every((entry) => written.has(entry)),
  }, evidence);
}
