/**
 * THE REPOSITORY'S COORDINATES — where the one repository lives and where its
 * site is served, derived from its one declaration: `package.json`
 * `repository.url`. The site builder, the community files and the public
 * words all read them here; no file spells the repository's own URL.
 *
 * A manifest with no GitHub `repository.url` has no coordinates: the answer
 * is `null`, and each caller refuses with its own typed code.
 */

const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/u;

export type RepositoryCoordinates = Readonly<{
  owner: string;
  name: string;
  /** `owner/name`. */
  repository: string;
  /** `https://github.com/<owner>/<name>`, no trailing slash. */
  repositoryUrl: string;
  defaultBranch: "main";
  /** `https://<owner>.github.io`. */
  siteOrigin: string;
  /** `/<name>`. */
  siteBaseurl: string;
  /** The site's root, with a trailing slash. */
  siteUrl: string;
}>;

/** The coordinates a `package.json` text declares, or `null` when it names no GitHub repository. */
export function repositoryCoordinates(manifestText: string): RepositoryCoordinates | null {
  const url = (JSON.parse(manifestText) as { repository?: { url?: unknown } } | null)?.repository?.url;
  const match = typeof url === "string" ? GITHUB_REPOSITORY_URL.exec(url) : null;
  if (match === null) return null;
  const [, owner, name] = match as unknown as [string, string, string];
  const siteOrigin = `https://${owner.toLowerCase()}.github.io`;
  return Object.freeze({
    owner,
    name,
    repository: `${owner}/${name}`,
    repositoryUrl: `https://github.com/${owner}/${name}`,
    defaultBranch: "main",
    siteOrigin,
    siteBaseurl: `/${name}`,
    siteUrl: `${siteOrigin}/${name}/`,
  });
}
