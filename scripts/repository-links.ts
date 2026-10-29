/**
 * REPOSITORY-OWNED LINKS — the one classifier for a hand-written absolute URL
 * that names a path this repository already owns.
 *
 * The process documents (the briefing, the contributor pages, the agent
 * process, the test map and the decisions) link another repository document
 * RELATIVELY: the target then resolves against the tree, and the two link
 * guards judge it (`scripts/check-docs-links.mjs` and
 * `tests/prevention/agent-docs-liveness.test.ts`). An absolute `github.com`
 * URL bypasses that resolution: the three standing decisions once labelled
 * ROLES.md / WORKFLOW.md / AGENTS.md while every one of them pointed at the
 * product repository's `CONTRIBUTING.md`, and both guards skipped `http(s)`
 * URLs, so nothing refused the drift. This module is that refusal's single
 * derivation, read by both guards.
 *
 * Not a general URL validator: only a GitHub blob/tree/raw URL into one of
 * this project's repositories is classified, and only a process document
 * written as one of those URLs is refused.
 */

// The one reader of the generated identity (plain JSON: the link check runs with no install).
// @ts-expect-error -- a .mjs module has no declaration file in the TS program.
import { generatedRepositoryIdentity } from "./floor/repository.mjs";

/** The path a GitHub blob/tree/raw URL into one of the organisation's Bridlewise repositories (the repository identity) names, or undefined. */
export function repositoryPathFromGithubUrl(target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const identity = generatedRepositoryIdentity() as Readonly<{ owner: string; organisationRepositories: readonly string[] }>;
  const [, owner, repository, kind, , ...rest] = url.pathname.split("/");
  const named = rest.join("/");
  if (owner !== identity.owner || repository === undefined || !identity.organisationRepositories.includes(repository)) return undefined;
  if ((kind !== "blob" && kind !== "tree" && kind !== "raw") || named === "") return undefined;
  let path = named;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape is still a path the caller asked about; judge it as written.
  }
  return path.replace(/\/+$/u, "");
}

/**
 * Whether `path` (repository-relative) is one of the repository's process
 * documents: the two root briefings, the agent process, the test map and the
 * decision record.
 */
export function isProcessDocument(path: string): boolean {
  return (
    path === "AGENTS.md" ||
    path === "CONTRIBUTING.md" ||
    path === "docs/testing.md" ||
    path.startsWith("docs/process/") ||
    path.startsWith("docs/decisions/")
  );
}

/**
 * Why a hand-written absolute URL in process document `document` is refused,
 * or undefined when the document may keep it. A URL that names a process
 * document is refused even when its target is in this repository: the
 * relative link is the one the liveness guards can resolve.
 */
export function absoluteProcessDocLinkReason(document: string, target: string): string | undefined {
  if (!isProcessDocument(document)) return undefined;
  const path = repositoryPathFromGithubUrl(target);
  if (path === undefined || !isProcessDocument(path)) return undefined;
  return `${target} (a hand-written absolute URL names the process document ${path}; link it relatively)`;
}
