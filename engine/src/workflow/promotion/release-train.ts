/**
 * THE RELEASE TRAIN — whether the product departs as a release now, and as
 * which version, computed purely from the repository and the declared
 * settings (`promotion.release` in the configuration; github-only §9.4).
 *
 * The product is the target of a promotion profile (`release.profile`, read
 * from the checkout's HEAD: its `target.ref`); its tip P carries the
 * `Projected-From` trailer naming the `main` commit S it was computed from. The
 * train is EVENT-DRIVEN: the publish workflow asks it after every land, and
 * it departs when every condition holds —
 *   - the product changed since the last release (P's tree differs from the
 *     tree the last release tag names);
 *   - the version P declares (its root `package.json`, the ONE version source
 *     until per-module versioning generates it, decision Q6: issue #101) has
 *     no tag yet;
 *   - `release.minIntervalHours` have passed since the last release;
 *   - the mode allows it: `auto` departs, `manual` departs only when asked
 *     (`--manual`, a person's dispatch), `approval` departs and says the run
 *     needs an approving reviewer (the release environment's).
 * ("At least one public record closed since the last release" joins these
 * once the structured tracker exists: issue #102.)
 * A release before the projection (the product branch keeps the previews
 * it was seeded with) is a previous release like any other; it has no
 * source (`previous.source` is null), so the notes compare nothing across it.
 * A condition that does not hold is a REASON in a `promotion_release_not_due` answer
 * (each named, so the dashboard can say what the next release waits for),
 * never an error. A product with no `Projected-From`, a version that is not
 * semver or does not grow, and a missing product ref are typed refusals.
 *
 * No clock is read here: `now` is an input (the command door passes the
 * time it was invoked), so the same inputs give the same plan.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import type { ConfigDocument, ReleaseTrainMode } from "../../kernel/config-contracts.ts";
import { commitTreeReader, gitOutput, resolveRevision, type GitRepository } from "../../git/tree-reader.ts";
import { compareSemver, isValidSemver, parseSemver } from "../../extensions/semver.ts";
import { PromotionError } from "./codes.ts";
import { loadPromotionProfiles, selectPromotionProfile } from "./profile.ts";
import { promotionTrailersOf } from "./trailers.ts";

/** The declared release settings (`promotion.release` in the configuration document; the schema owns each field's meaning). */
export type ReleaseSettings = NonNullable<NonNullable<ConfigDocument["promotion"]>["release"]>;

/** Why the train does not depart now (each a condition that does not hold). */
export type ReleaseWaitReason = "version_released" | "product_unchanged" | "interval" | "manual_mode";

export type ReleasePlan = Readonly<{
  due: boolean;
  /** Empty when due. */
  reasons: readonly ReleaseWaitReason[];
  mode: ReleaseTrainMode;
  /** The run must pass an approving reviewer (`approval` mode). */
  approval: boolean;
  version: string;
  tag: string;
  /** Below 1.0, or a version with a pre-release part: published as a pre-release. */
  prerelease: boolean;
  product: Readonly<{ ref: string; commit: string; tree: string; source: string }>;
  /** The last release; `at` is its annotated tag's time, `null` for a lightweight (seeded) tag. */
  previous: Readonly<{ tag: string; version: string; commit: string; source: string | null; at: string | null }> | null;
  productChanged: boolean;
  hoursSincePrevious: number | null;
  discussionCategory: string;
}>;

/** The version the product commit declares: its root `package.json`'s `version`, which must be semver. */
function declaredVersion(repository: GitRepository, commit: string): string {
  const manifest = commitTreeReader(repository, commit).text("package.json");
  let version: unknown;
  try {
    version = (JSON.parse(manifest ?? "null") as { version?: unknown } | null)?.version;
  } catch (error) {
    throw new PromotionError("promotion_release_version_invalid", `the product ${commit}'s package.json is not JSON: ${error instanceof Error ? error.message : String(error)}`, { commit });
  }
  if (typeof version !== "string" || version !== version.trim() || !isValidSemver(version)) {
    throw new PromotionError("promotion_release_version_invalid", `the product ${commit} declares no semantic version in package.json (found ${JSON.stringify(version ?? null)})`, { commit, version: version ?? null });
  }
  return version;
}

/**
 * The newest release tag of `settings` on the product's own line (`commit`'s
 * first-parent history: a tag on a `main` commit the product carries as a
 * second parent is no release), by version precedence, or `null`.
 *
 * A release's time is its ANNOTATED tag's tagger date: the train creates
 * every release tag annotated (and the release immutable), so the tag is the
 * release record git holds. A lightweight tag (a preview the product branch
 * was seeded with) has no release time here — `at` is `null` and the
 * interval is not measured from it; a commit's date is never taken for a
 * release's.
 */
function previousRelease(repository: GitRepository, commit: string, settings: ReleaseSettings): ReleasePlan["previous"] {
  const line = new Set(gitOutput(repository, ["rev-list", "--first-parent", commit]).stdout.toString("utf8").split("\n").filter((id) => id.length > 0));
  const lines = gitOutput(repository, ["for-each-ref", "--merged", commit, "--format=%(refname:strip=2)%00%(objecttype)%00%(taggerdate:iso-strict)%00%(*objectname)%00%(objectname)", `refs/tags/${settings.tagPrefix}*`]).stdout.toString("utf8").split("\n").filter((entry) => entry.length > 0);
  let best: { tag: string; version: string; at: string | null } | null = null;
  for (const entry of lines) {
    const [tag, type, taggerDate, peeled, object] = entry.split("\0") as [string, string, string, string, string];
    if (!line.has(type === "tag" ? peeled : object)) continue;
    const version = tag.slice(settings.tagPrefix.length);
    if (!isValidSemver(version) || version !== version.trim()) continue;
    if (best === null || compareSemver(version, best.version) > 0) best = { tag, version, at: type === "tag" && taggerDate !== "" ? new Date(taggerDate).toISOString() : null };
  }
  if (best === null) return null;
  const tagged = resolveRevision(repository, `refs/tags/${best.tag}`)!;
  return deepFreeze({ tag: best.tag, version: best.version, commit: tagged, source: promotionTrailersOf(repository, tagged).projectedFrom, at: best.at });
}

export type ReleasePlanInput = Readonly<{
  repository: GitRepository;
  settings: ReleaseSettings;
  /** The configured promotion profile directory (where the product's profile is read from HEAD). */
  profileDirectory: string;
  commandNames: ReadonlySet<string>;
  /** The time the train is asked (the command door's clock). */
  now: Date;
  /** A person asked for this departure (`manual` mode departs only so). */
  manual: boolean;
}>;

/** THE PLAN (see the header). Reads refs and objects; writes nothing. */
export function planRelease(input: ReleasePlanInput): ReleasePlan {
  const { repository, settings } = input;
  const head = resolveRevision(repository, "HEAD");
  if (head === null) throw new PromotionError("promotion_release_product_missing", "the checkout has no HEAD commit to read the product's profile from", {});
  const { profile } = selectPromotionProfile(loadPromotionProfiles(commitTreeReader(repository, head), input.profileDirectory, input.commandNames), settings.profile, `HEAD:${input.profileDirectory}`);
  const productRef = profile.target.ref;
  const commit = resolveRevision(repository, productRef);
  if (commit === null) throw new PromotionError("promotion_release_product_missing", `the product ref ${productRef} (the target of ${profile.name}) does not exist here: promote first, or fetch it`, { ref: productRef });
  const source = promotionTrailersOf(repository, commit).projectedFrom;
  if (source === null) throw new PromotionError("promotion_release_source_unproven", `the product tip ${commit} carries no Projected-From trailer: only a projection of a main commit is released`, { commit });
  const version = declaredVersion(repository, commit);
  const previous = previousRelease(repository, commit, settings);
  if (previous !== null && compareSemver(version, previous.version) < 0) {
    throw new PromotionError("promotion_release_version_invalid", `the product declares ${version}, below the last release ${previous.tag}: a version never goes back`, { version, previous: previous.tag });
  }
  const tag = `${settings.tagPrefix}${version}`;
  const tree = resolveRevision(repository, commit, "tree")!;
  const productChanged = previous === null || resolveRevision(repository, previous.commit, "tree") !== tree;
  const hoursSincePrevious = previous === null || previous.at === null ? null : Math.floor((input.now.getTime() - Date.parse(previous.at)) / 36_000) / 100;
  const reasons: ReleaseWaitReason[] = [];
  if (resolveRevision(repository, `refs/tags/${tag}`, "object") !== null) reasons.push("version_released");
  if (!productChanged) reasons.push("product_unchanged");
  if (hoursSincePrevious !== null && hoursSincePrevious < settings.minIntervalHours) reasons.push("interval");
  if (settings.train === "manual" && !input.manual) reasons.push("manual_mode");
  return deepFreeze({
    due: reasons.length === 0,
    reasons,
    mode: settings.train,
    approval: settings.train === "approval",
    version,
    tag,
    prerelease: parseSemver(version).major === 0 || parseSemver(version).prerelease !== null,
    product: { ref: productRef, commit, tree, source },
    previous,
    productChanged,
    hoursSincePrevious,
    discussionCategory: settings.discussionCategory,
  });
}

/** What each wait reason asks of a person (the dashboard's line). */
export const RELEASE_WAIT_REMEDIES: Readonly<Record<ReleaseWaitReason, string>> = deepFreeze({
  version_released: "the product's declared version is already released: declare the next version in package.json on main",
  product_unchanged: "the product has not changed since the last release",
  interval: "the minimum interval since the last release (release.minIntervalHours) has not passed",
  manual_mode: "the train is manual (release.train): a person dispatches the release",
});
