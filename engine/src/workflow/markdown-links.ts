/**
 * MARKDOWN LINK TARGETS — the one rewrite of a Markdown text's relative link
 * targets. WHAT is a link is the one Markdown parser's answer
 * (`shared/markdown.ts` `extractMarkdown`: inline, image and reference
 * links, never code); this module only replaces the destinations it found.
 * Pure (no I/O, no clock, imports only the parser, itself pure): the tracker's
 * board render (src/workflow/failure-owners.ts) and the GitHub projector's
 * sealed realm (src/workflow/forge/projector/) both load it, so a link is
 * resolved one way whether it lands on the board or in a projected issue.
 * Its path helpers are the realm's (no `node:path` exists there).
 */
import { extractMarkdown } from "../../../shared/markdown.ts";

/** Where a destination is written: after `](`, `](<` or a definition's `]: `. */
const DESTINATION = /(\]\(<?|\]:[ \t]+<?)([^\s)>]+)/gu;
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu;

/** `path` with `.` and `..` segments resolved, `/`-separated (a `..` above the root is kept, so it stays visibly outside). */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/** `to` (repository-relative) as a relative path from the folder `from`. */
export function relativePath(from: string, to: string): string {
  const base = normalizePath(from).split("/").filter((segment) => segment.length > 0);
  const target = normalizePath(to).split("/").filter((segment) => segment.length > 0);
  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared += 1;
  return [...base.slice(shared).map(() => ".."), ...target.slice(shared)].join("/") || ".";
}

/**
 * `markdown` with every RELATIVE link target written from the folder
 * `fromDirectory` (repository-relative) replaced by `replace(path, fragment)`,
 * where `path` is the target's repository-relative path and `fragment` its
 * `#…` part (or ""). An absolute URL, a site-absolute path and a bare
 * fragment are left as written.
 */
export function rewriteRelativeLinks(markdown: string, fromDirectory: string, replace: (path: string, fragment: string) => string): string {
  const relative = new Set(extractMarkdown(markdown).links.map((link) => link.target).filter((target) => !NOT_RELATIVE.test(target)));
  if (relative.size === 0) return markdown;
  return markdown.replace(DESTINATION, (whole, open: string, target: string) => {
    if (!relative.has(target)) return whole;
    const hash = target.indexOf("#");
    const path = hash < 0 ? target : target.slice(0, hash);
    return `${open}${replace(normalizePath(`${fromDirectory}/${path}`), hash < 0 ? "" : target.slice(hash))}`;
  });
}
