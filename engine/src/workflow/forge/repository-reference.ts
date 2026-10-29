/**
 * THE REFERENCE TO AN ADDRESS OF THIS REPOSITORY: `repo:<path>`, the
 * repository's GitHub URL joined with `<path>` (`repo:actions/runs/123`,
 * `repo:issues/57`, `repo:` alone for the repository itself). A hand-written
 * record names this repository's addresses only through it, so a rename
 * changes one value (the repository identity) and no record. Markdown prose
 * writes it as a reference label (`[text][repo:<path>]`, whose definition
 * `harness sync` generates); a record field (a tracker item's `evidence:`)
 * writes it bare.
 *
 * Pure and import-free: the confined roadmap-feed program loads it.
 */

export const REPOSITORY_REFERENCE_PREFIX = "repo:";

/** The URL `reference` names under `repositoryUrl`, or `undefined` when it is not a `repo:` reference. */
export function repositoryReferenceUrl(reference: string, repositoryUrl: string): string | undefined {
  if (!reference.startsWith(REPOSITORY_REFERENCE_PREFIX)) return undefined;
  const path = reference.slice(REPOSITORY_REFERENCE_PREFIX.length);
  return path === "" ? repositoryUrl : `${repositoryUrl}/${path}`;
}
