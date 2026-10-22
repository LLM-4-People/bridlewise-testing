/**
 * THE PRODUCT PUBLICATION — the publisher writes the `product` branch
 * (github-only §2.2, §9.4; decision PROMO-GH). A promotion built in this
 * job (`harness promote apply --no-publish`: the projection of a `main`
 * commit S onto the product tip T, certified by its phases and pinned at the
 * profile's pending ref) is carried to the forge:
 *   - its trailers must name its source (`Projected-From`) and its profile;
 *   - the forge's product branch must still be T, the commit's first parent
 *     (`promotion_forge_target_moved` otherwise: another publication landed);
 *   - the commit is re-made on the forge with parents `[T, S]` through the
 *     Git Data API ({@link remakeCommit}): GitHub signs it as the publisher
 *     App, and its tree must be the locally built tree — the projection was
 *     recomputed from S in this job, so the published tree IS the recomputed
 *     one;
 *   - the branch moves forward only ({@link advanceBranch}), and is re-read.
 * The answer is the PROJECTION RECEIPT (`bridlewise-product-projection/v1`):
 * what was published, from which source, by which profile blob, onto which
 * head. The publish job attests it (its digest is the attestation's
 * subject), so anyone can check that a product commit is the projection of a
 * named `main` commit.
 *
 * The token is the publisher App's installation token, minted by the job and
 * handed in {@link PUBLISHER_TOKEN_VARIABLE}; it is read at call time and
 * never stored.
 */
import { canonicalJson, deepFreeze } from "../../../kernel/integrity.ts";
import { schemaId } from "../../../kernel/product-identity.ts";
import { gitOutput, type GitRepository } from "../../../git/tree-reader.ts";
import { ForgeError } from "../codes.ts";
import type { ForgeClient } from "../port.ts";
import { promotionTrailersOf } from "../../promotion/trailers.ts";
import { PromotionError } from "../../promotion/codes.ts";
import { advanceBranch, branchHead, remakeCommit } from "./git-data.ts";
import { atomicWriteFile } from "../../../filesystem/atomic-write.ts";
import { resolveRevision } from "../../../git/tree-reader.ts";
import { answer, type PromotionAnswer } from "../../promotion/codes.ts";
import { branchOf, type LoadedPromotionProfile } from "../../promotion/profile.ts";
import { promotionRefs } from "../../promotion/promotion-run.ts";
import { configuredForge, configuredForgeClient } from "../configured-forge.ts";
import { environmentCredential } from "../credentials.ts";
import { FORGE_APPS } from "../app-registry.ts";
import { trunkRepository } from "../forge-config.ts";

/** The environment variable the publish job hands the publisher App's installation token in. */
export const PUBLISHER_TOKEN_VARIABLE = "BRIDLEWISE_PUBLISHER_TOKEN";

const PROJECTION_RECEIPT_SCHEMA = schemaId("product-projection", 1);

export type ProjectionReceipt = Readonly<{
  schema: typeof PROJECTION_RECEIPT_SCHEMA;
  repository: string;
  branch: string;
  /** The product commit as the forge holds it (signed by the publisher). */
  commit: string;
  /** The commit this job built and certified (the same tree, a local identity). */
  built: string;
  tree: string;
  /** The `main` commit it is the projection of (`Projected-From`). */
  source: string;
  /** `Promotion-Profile`: the profile's name and the blob it was projected by. */
  profile: string;
  /** The product head it was published onto. */
  target: string;
}>;

/** The receipt's canonical bytes (what the attestation's subject digest is taken over). */
export function receiptBytes(receipt: ProjectionReceipt): string {
  return `${canonicalJson(receipt)}\n`;
}

function forgeRefusal(error: unknown): never {
  if (error instanceof ForgeError) {
    const code = error.forgeCode === "forge_publication_mismatch"
      ? "promotion_forge_mismatch"
      : error.forgeClass === "budget" || error.forgeClass === "errored" ? "promotion_forge_errored" : "promotion_forge_refused";
    throw new PromotionError(code, `${error.forgeCode}: ${error.message}`, { forgeCode: error.forgeCode, ...error.facts });
  }
  throw error;
}

/** Publishes the built promotion `commit` to `branch` of `repository` on the forge (see the header); answers the projection receipt. */
export async function publishProduct(input: Readonly<{ client: ForgeClient; repository: string; branch: string; local: GitRepository; commit: string }>): Promise<ProjectionReceipt> {
  const { client, repository, branch, local, commit } = input;
  const trailers = promotionTrailersOf(local, commit);
  if (trailers.projectedFrom === null || trailers.profile === null) {
    throw new PromotionError("promotion_source_unproven_commit", `${commit} carries no Projected-From or Promotion-Profile trailer: only a promotion commit is published to the product`, { commit });
  }
  const parents = gitOutput(local, ["rev-list", "--parents", "-n", "1", commit]).stdout.toString("utf8").trim().split(" ").slice(1);
  if (parents.length !== 2 || parents[1] !== trailers.projectedFrom) {
    throw new PromotionError("promotion_source_unproven_commit", `${commit} has the parents ${parents.join(", ")}: a promotion commit's parents are [the product tip, its Projected-From source]`, { commit, parents });
  }
  const [target, source] = parents as [string, string];
  try {
    const head = await branchHead(client, repository, branch);
    if (head !== target) throw new PromotionError("promotion_forge_target_moved", `${branch} on ${repository} is ${String(head)}, but the promotion was built on ${target}: another publication landed meanwhile`, { branch, expected: target, found: head });
    const made = await remakeCommit({ client, repository, local, commit, parents: [target, source] });
    await advanceBranch(client, repository, branch, target, made.sha);
    return deepFreeze({ schema: PROJECTION_RECEIPT_SCHEMA, repository, branch, commit: made.sha, built: commit, tree: made.tree, source, profile: trailers.profile, target });
  } catch (error) {
    if (error instanceof PromotionError) throw error;
    return forgeRefusal(error);
  }
}

/** Where the product is published: the forge client (as the publisher App) and the trunk repository (`owner/name`). */
export type ProductForge = Readonly<{ client: ForgeClient; repository: string }>;

/** The configured forge, as the publisher App (its token from {@link PUBLISHER_TOKEN_VARIABLE}): the trunk repository the configuration names. */
export function configuredProductForge(): ProductForge {
  const settings = configuredForge();
  return deepFreeze({
    client: configuredForgeClient(environmentCredential(`app:${FORGE_APPS.publisher.name}`, PUBLISHER_TOKEN_VARIABLE)),
    repository: `${settings.organization}/${trunkRepository(settings).name}`,
  });
}

/**
 * `harness promote forge-publish --out <file>`: the profile's pending
 * promotion (built and pinned by `apply --no-publish` in this job) published
 * to the forge (see {@link publishProduct}); the projection receipt written
 * to `out` for the job to attest.
 */
export async function forgePublishVerb(input: Readonly<{ local: GitRepository; loaded: LoadedPromotionProfile; out: string; forge: ProductForge }>): Promise<PromotionAnswer> {
  const { profile } = input.loaded;
  const pending = resolveRevision(input.local, promotionRefs(profile.name).pending);
  if (pending === null) throw new PromotionError("promotion_forge_nothing_pending", `the profile ${profile.name} has no pending promotion here: build it in this job first (\`harness promote apply --no-publish\`)`, { profile: profile.name });
  const receipt = await publishProduct({ client: input.forge.client, repository: input.forge.repository, branch: branchOf(profile.target.ref), local: input.local, commit: pending });
  const written = atomicWriteFile(input.out, receiptBytes(receipt));
  if (!written.success) throw written.error;
  return answer("promotion_forge_published", `${receipt.branch} on ${receipt.repository} is ${receipt.commit}, the projection of ${receipt.source} (receipt: ${input.out})`, receipt);
}
