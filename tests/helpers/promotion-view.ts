/**
 * WHAT THIS BRANCH SHIPS, AS ITS PROMOTION PROFILES DECLARE IT — the one
 * answer the repository's guards ask about "product" now that the two-tree
 * floor model is gone (PROMO-4, merge-door-final §16): the working tree (what
 * `git add -A` would commit) classified by every profile under the profile
 * directory (read from disk, validated against the ONE command registry,
 * the same pure projection a promotion runs). Memoized per root for the
 * process.
 *
 * - A path SHIPS when some profile projects it ({@link PromotionView.ships}).
 * - A folder or a root entry is PRODUCT when a shipped path lies under it
 *   (`shippedFolders`, `shippedRootEntries`): derived, never declared.
 * - Everything else is the development superset this branch alone carries;
 *   `excluded` names what a profile excludes outright (its declared
 *   development trees), as opposed to what merely nothing reaches.
 *
 * The configuration is the engine's document validated by the production
 * schema, never the pinned loader: the loader fingerprints the engine root
 * around its read, and a sibling test file's fixture appearing there
 * meanwhile refuses the load (measured in a cold full run).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigDocumentSchema, type ConfigDocument } from "../../engine/src/kernel/config-contracts.ts";
import { workingTreeReader, type TreeReader } from "../../engine/src/git/tree-reader.ts";
import { excludedBy, loadPromotionProfiles, type LoadedPromotionProfile } from "../../engine/src/workflow/promotion/profile.ts";
import { classifyTree, type Classification } from "../../engine/src/workflow/promotion/projection.ts";

export type PromotionView = Readonly<{
  /** The engine's configuration document (the command registry, the profile directory). */
  document: ConfigDocument;
  /** The working tree the view classified. */
  tree: TreeReader;
  /** Every profile the working tree declares, validated. */
  profiles: readonly LoadedPromotionProfile[];
  /** Each profile's classification of the working tree, by profile name. */
  classifications: ReadonlyMap<string, Classification>;
  /** Every path some profile projects. */
  shipped: ReadonlySet<string>;
  /** Every folder holding a shipped path, at any depth (`a`, `a/b`; never the root itself). */
  shippedFolders: ReadonlySet<string>;
  /** Every root entry holding (or being) a shipped path. */
  shippedRootEntries: ReadonlySet<string>;
  /** Whether `path` ships. */
  ships: (path: string) => boolean;
  /** Whether every profile excludes `path` outright (a declared development tree or file). */
  excluded: (path: string) => boolean;
}>;

const views = new Map<string, PromotionView>();

/** The promotion view of the checkout at `root` (see the header). */
export function promotionView(root: string = process.cwd()): PromotionView {
  const known = views.get(root);
  if (known !== undefined) return known;
  const document = getConfigDocumentSchema().parse(JSON.parse(readFileSync(join(root, "engine", "bridlewise.config.json"), "utf8")));
  const commandNames = new Set(Object.keys(document.workspaceIsolation?.commands ?? {}));
  const tree = workingTreeReader(root);
  const profiles = loadPromotionProfiles(tree, document.promotion!.profileDirectory, commandNames);
  if (profiles.length === 0) throw new Error(`no promotion profile under ${document.promotion!.profileDirectory}/ in ${root}: nothing says what ships, so no guard can ask it`);
  const classifications = new Map(profiles.map((loaded) => [loaded.profile.name, classifyTree(tree, loaded.profile)] as const));
  const shipped = new Set([...classifications.values()].flatMap((classification) => [...classification.projected.keys()]));
  const shippedFolders = new Set<string>();
  for (const path of shipped) {
    for (let slash = path.indexOf("/"); slash > 0; slash = path.indexOf("/", slash + 1)) shippedFolders.add(path.slice(0, slash));
  }
  const view: PromotionView = Object.freeze({
    document,
    tree,
    profiles,
    classifications,
    shipped,
    shippedFolders,
    shippedRootEntries: new Set([...shipped].map((path) => path.split("/")[0]!)),
    ships: (path: string) => shipped.has(path),
    excluded: (path: string) => profiles.every((loaded) => excludedBy(loaded.profile, path) !== null),
  });
  views.set(root, view);
  return view;
}
