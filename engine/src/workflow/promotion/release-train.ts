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
 *   - `release.minIntervalHours` have passed since the newest release
 *     RECORD's own `published_at` (the forge's answer, whatever the tag type).
 *     The previous release must have its own published record in the list
 *     (records not read, or none for that tag — an empty list, another
 *     tag's, a draft —: the `releases_unread` reason, never "due"); a
 *     pre-projection preview's record stays in the archived repository;
 *   - the mode allows it: `auto` departs, `manual` departs only when asked
 *     (`--manual`, a person's dispatch), `approval` departs and says the run
 *     needs an approving reviewer (the release environment's).
 *   - at least one public record (a tracker item, `failure-owners.ts`) closed
 *     between the previous release's source and S (`no_record_closed`; the
 *     first projected release has no range, so the condition does not apply);
 * A release before the projection (the product branch keeps the previews
 * it was seeded with) is a previous release like any other; it has no
 * source (`previous.source` is null), so the notes compare nothing across it.
 * A condition that does not hold is a REASON in a `promotion_release_not_due` answer
 * (each named, so the dashboard can say what the next release waits for),
 * never an error. A product with no `Projected-From`, a version that is not
 * semver or does not grow, a lightweight release tag on the product's line,
 * and a missing product ref are typed refusals.
 *
 * No clock is read here: `now` is an input (the command door passes the
 * time it was invoked), so the same inputs give the same plan.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import type { ConfigDocument, ReleaseTrainMode } from "../../kernel/config-contracts.ts";
import { commitTreeReader, resolveRevision } from "../../git/tree-reader.ts";
import { gitOutput, type GitRepository } from "../../git/git-door.ts";
import { compareSemver, isValidSemver, parseSemver } from "../../extensions/semver.ts";
import { PromotionError } from "./codes.ts";
import { loadPromotionProfiles, selectPromotionProfile } from "./profile.ts";
import { promotionTrailersOf } from "./trailers.ts";
import { trackerItemsOf, type TrackerItem } from "../failure-owners.ts";

/** The declared release settings (`promotion.release` in the configuration document; the schema owns each field's meaning). */
export type ReleaseSettings = NonNullable<NonNullable<ConfigDocument["promotion"]>["release"]>;

/** Why the train does not depart now (each a condition that does not hold). */
export type ReleaseWaitReason = "version_released" | "product_unchanged" | "no_record_closed" | "releases_unread" | "interval" | "manual_mode";

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
  /** The last release tag on the product's line (by version). */
  previous: Readonly<{ tag: string; version: string; commit: string; source: string | null }> | null;
  /** The newest release record's publication time (the interval's origin), or `null` when none was published or the records were not read. */
  lastPublishedAt: string | null;
  productChanged: boolean;
  /** The public records closed since the previous release's source (`null` for the first projected release: no range). */
  closedRecords: readonly ClosedRecord[] | null;
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
 * Every release tag is annotated (or signed: a tag object either way) — the
 * train creates no other, and the tags ruleset requires it. A LIGHTWEIGHT
 * release tag on the product's line is something else's (`gh release create
 * --target` makes one), so it is refused (`promotion_release_tag_lightweight`),
 * never read as a release.
 */
function previousRelease(repository: GitRepository, commit: string, settings: ReleaseSettings): ReleasePlan["previous"] {
  const line = new Set(gitOutput(repository, ["rev-list", "--first-parent", commit]).stdout.toString("utf8").split("\n").filter((id) => id.length > 0));
  const lines = gitOutput(repository, ["for-each-ref", "--merged", commit, "--format=%(refname:strip=2)%00%(objecttype)%00%(*objectname)%00%(objectname)", `refs/tags/${settings.tagPrefix}*`]).stdout.toString("utf8").split("\n").filter((entry) => entry.length > 0);
  let best: { tag: string; version: string } | null = null;
  for (const entry of lines) {
    const [tag, type, peeled, object] = entry.split("\0") as [string, string, string, string];
    if (!line.has(type === "tag" ? peeled : object)) continue;
    const version = tag.slice(settings.tagPrefix.length);
    if (!isValidSemver(version) || version !== version.trim()) continue;
    if (type !== "tag") throw new PromotionError("promotion_release_tag_lightweight", `the release tag ${tag} on the product's line is lightweight: a release tag is annotated (or signed), so something other than the train made it`, { tag });
    if (best === null || compareSemver(version, best.version) > 0) best = { tag, version };
  }
  if (best === null) return null;
  const tagged = resolveRevision(repository, `refs/tags/${best.tag}`)!;
  return deepFreeze({ tag: best.tag, version: best.version, commit: tagged, source: promotionTrailersOf(repository, tagged).projectedFrom });
}

/** One release record as the forge lists it (`GET /repos/{owner}/{repo}/releases`): its tag, whether it is a draft, and when it was published. */
export type ReleaseRecord = Readonly<{ tag: string; draft: boolean; publishedAt: string | null }>;

/** A tracker item that closed between two sources: its id, type and title. */
export type ClosedRecord = Readonly<{ id: string; type: TrackerItem["type"]; title: string; resolution: TrackerItem["resolution"] }>;

/**
 * The public records (the tracker items, one owner: `failure-owners.ts`) that
 * are closed at `to` and were not closed at `from` (open, or absent): what
 * closed between two releases' sources. A record closed and reopened in
 * between is open at `to`, so it does not count.
 */
export function closedRecords(repository: GitRepository, from: string, to: string): readonly ClosedRecord[] {
  const before = new Map(trackerItemsOf(commitTreeReader(repository, from)).map((item) => [item.id, item]));
  return deepFreeze(trackerItemsOf(commitTreeReader(repository, to))
    .filter((item) => item.state === "closed" && before.get(item.id)?.state !== "closed")
    .map((item) => ({ id: item.id, type: item.type, title: item.title ?? item.id, resolution: item.resolution })));
}

/** The newest publication time among the published (non-draft) records, or `null` when none was published. */
function lastPublishedAt(records: readonly ReleaseRecord[]): string | null {
  let newest: number | null = null;
  for (const record of records) {
    if (record.draft || record.publishedAt === null) continue;
    const at = Date.parse(record.publishedAt);
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest).toISOString();
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
  /** The repository's release records (the interval runs from the newest one's `published_at`), or `null` when they were not read. */
  releases: readonly ReleaseRecord[] | null;
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
  // The interval needs the previous release's own published record: a list
  // with no published record for that tag (empty, another tag's, a draft)
  // cannot measure it, so the train waits. A preview from before the
  // projection (no Projected-From: the product branch was seeded with it)
  // has its record in the archived repository, so no interval runs from it.
  const recordsRead = input.releases !== null && (previous === null || previous.source === null || input.releases.some((record) => record.tag === previous.tag && !record.draft && record.publishedAt !== null));
  const publishedAt = input.releases === null || !recordsRead ? null : lastPublishedAt(input.releases);
  const hoursSincePrevious = publishedAt === null ? null : Math.floor((input.now.getTime() - Date.parse(publishedAt)) / 36_000) / 100;
  const reasons: ReleaseWaitReason[] = [];
  if (resolveRevision(repository, `refs/tags/${tag}`, "object") !== null) reasons.push("version_released");
  if (!productChanged) reasons.push("product_unchanged");
  // The first projected release (no previous release, or a pre-projection
  // preview with no source) has no range to read closed records from.
  const closed = previous === null || previous.source === null ? null : closedRecords(repository, previous.source, source);
  if (closed !== null && closed.length === 0) reasons.push("no_record_closed");
  if (!recordsRead) reasons.push("releases_unread");
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
    closedRecords: closed,
    lastPublishedAt: publishedAt,
    hoursSincePrevious,
    discussionCategory: settings.discussionCategory,
  });
}

/** What each wait reason asks of a person (the dashboard's line). */
export const RELEASE_WAIT_REMEDIES: Readonly<Record<ReleaseWaitReason, string>> = deepFreeze({
  version_released: "the product's declared version is already released: declare the next version in package.json on main",
  product_unchanged: "the product has not changed since the last release",
  no_record_closed: "no public record (a tracker item) has closed since the last release",
  releases_unread: "the previous release's published record was not read (no records, or none published for its tag), so the interval since it is unmeasured (the release job reads the records from the forge)",
  interval: "the minimum interval since the last release was published (release.minIntervalHours) has not passed",
  manual_mode: "the train is manual (release.train): a person dispatches the release",
});
