/**
 * THE REPOSITORY IDENTITY: the one place every reference to this
 * repository's GitHub address is derived from. That covers its
 * `owner/name`, its web, clone and issue URLs, its project Pages address
 * and base path, and the names of the organisation's other Bridlewise
 * repositories. The source is the `forge` section: the organisation, the
 * web origin, and the repository of kind `trunk`.
 *
 * Renaming the repository (runbook P1.10)
 * is then one value in `bridlewise.config.json`, landed together with the
 * GitHub-side rename. Code reads it here, and generated files are
 * regenerated from it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { workingTreeReader } from "../../git/tree-reader.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { ForgeError } from "./codes.ts";
import { configuredForge } from "./configured-forge.ts";
import { trunkRepository, type ForgeSettings } from "./forge-config.ts";
import { repositoryReferenceUrl } from "./repository-reference.ts";

export type RepositoryIdentity = Readonly<{
  /** The organisation (`LLM-4-People`). */
  owner: string;
  /** The repository's name (the trunk's, in the forge section). */
  name: string;
  /** `owner/name`, as the API and `actions/checkout` name it. */
  fullName: string;
  /** `https://github.com/owner/name`. */
  webUrl: string;
  /** The clone URL (`…/name.git`). */
  gitUrl: string;
  /** The issue tracker (`…/name/issues`). */
  issuesUrl: string;
  /** The project Pages site's base path (`/name`). */
  pagesBasePath: string;
  /** The project Pages site (`<scheme>://<owner>.<pagesDomain>/name/`, the owner lower-cased as the forge serves it). */
  pagesUrl: string;
  /** Every repository of the organisation the forge declares (this one included), by name. */
  organisationRepositories: readonly string[];
}>;

/** The trunk repository's identity under `settings`. */
export function repositoryIdentity(settings: ForgeSettings): RepositoryIdentity {
  const web = new URL(settings.webUrl);
  const owner = settings.organization;
  const { name } = trunkRepository(settings);
  const webUrl = `${web.origin}/${owner}/${name}`;
  // The project Pages site: the web origin's scheme, on `<owner>.<pagesDomain>` (the owner lower-cased, as the forge serves it).
  const pages = new URL(web.origin);
  pages.hostname = `${owner.toLowerCase()}.${settings.pagesDomain}`;
  pages.pathname = `/${name}/`;
  return deepFreeze({
    owner,
    name,
    fullName: `${owner}/${name}`,
    webUrl,
    gitUrl: `${webUrl}.git`,
    issuesUrl: `${webUrl}/issues`,
    pagesBasePath: `/${name}`,
    pagesUrl: pages.href,
    organisationRepositories: settings.repositories.map((repository) => repository.name),
  });
}

/** This checkout's repository identity, from its configured `forge` section (`forge_not_configured` without one). */
export function configuredRepositoryIdentity(): RepositoryIdentity {
  return repositoryIdentity(configuredForge());
}

/** A Markdown reference to an identity link: `[text][repo:<path>]` (on GitHub) or `[text][site:<path>]` (on the Pages site). */
const IDENTITY_LABEL = /\]\[((?:repo|site):[^\]\s<>`]*)\]/gu;

/** `text` with its code (fenced blocks and inline spans) blanked: a label quoted in code is an example, never a use. */
function proseOf(text: string): string {
  let prose = "";
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      prose += "\n";
      continue;
    }
    if (marker !== undefined) { fence = marker; prose += "\n"; continue; }
    let kept = "";
    let open: number | undefined;
    for (let at = 0; at < line.length; at += 1) {
      if (line[at] !== "`") { if (open === undefined) kept += line[at]; continue; }
      let run = 1;
      while (line[at + run] === "`") run += 1;
      if (open === undefined) { open = run; } else if (run === open) { open = undefined; }
      at += run - 1;
    }
    prose += `${kept}\n`;
  }
  return prose;
}
const LINKS_BEGIN = "<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->";
const LINKS_END = "<!-- END GENERATED: repository links -->";
const CLONE_BEGIN = "<!-- BEGIN GENERATED: clone command, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->";
const CLONE_END = "<!-- END GENERATED: clone command -->";
const HEADING_BEGIN = "<!-- BEGIN GENERATED: repository name heading, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->";
const HEADING_END = "<!-- END GENERATED: repository name heading -->";

/** `text` with every block between `begin` and `end` holding `content` (a block without its end marker is refused). */
function withBlockContent(text: string, begin: string, end: string, content: string, field: string): string {
  let body = text;
  for (let at = body.indexOf(begin); at !== -1; at = body.indexOf(begin, at + 1)) {
    const close = body.indexOf(end, at);
    if (close === -1) throw new ForgeError("forge_identity_copy_invalid", `A ${field} block has no end marker.`, { field });
    body = `${body.slice(0, at + begin.length)}\n${content}\n${body.slice(close)}`;
  }
  return body;
}

/** The address an identity label names: `repo:<path>` under the repository's GitHub URL, `site:<path>` under its Pages site. */
function identityLinkTarget(label: string, identity: RepositoryIdentity): string {
  const [kind, ...rest] = label.split(":");
  const path = rest.join(":");
  if (kind === "site") return `${identity.pagesUrl}${path}`;
  return repositoryReferenceUrl(label, identity.webUrl)!;
}

/**
 * A hand-written Markdown document with its identity links generated. The
 * prose names an address only by a reference label (`[text][repo:issues/57]`,
 * `[text][site:floor/help/]`). One block at the end defines exactly the
 * labels the text uses; a clone block holds the clone command, and a heading
 * block the repository's name as a heading. All are written from the
 * identity. A document that uses no label carries no block.
 */
export function withIdentityLinks(text: string, identity: RepositoryIdentity): string {
  let body = text;
  const begin = body.indexOf(LINKS_BEGIN);
  if (begin !== -1) {
    const end = body.indexOf(LINKS_END, begin);
    if (end === -1) throw new ForgeError("forge_identity_copy_invalid", "A repository-links block has no end marker.", { field: "repository links" });
    body = `${body.slice(0, begin).replace(/\n+$/u, "\n")}${body.slice(end + LINKS_END.length).replace(/^\n+/u, "")}`;
  }
  body = withBlockContent(body, CLONE_BEGIN, CLONE_END, ["```bash", `git clone ${identity.gitUrl}`, `cd ${identity.name}`, "```"].join("\n"), "clone command");
  body = withBlockContent(body, HEADING_BEGIN, HEADING_END, `# ${identity.name}`, "repository name heading");
  const labels = [...new Set([...proseOf(body).matchAll(IDENTITY_LABEL)].map((match) => match[1]!))].sort();
  if (labels.length === 0) return body;
  const definitions = labels.map((label) => `[${label}]: ${identityLinkTarget(label, identity)}`);
  return `${body.replace(/\n*$/u, "\n")}\n${LINKS_BEGIN}\n${definitions.join("\n")}\n${LINKS_END}\n`;
}

/**
 * THE COPIES of the identity that other formats insist on carrying as text,
 * each GENERATED from it (a field, never the whole file):
 * - `package.json`: `repository.url`, `homepage`, `bugs.url`;
 * - `CITATION.cff`: `repository-code`;
 * - every owned Markdown document's identity links and clone command
 *   ({@link withIdentityLinks}).
 * Each answer is the file's full new text, for the forge-files arm of
 * `harness sync` to compare and write. A file the tree does not hold carries
 * no copy; a file that holds the copy in another shape is refused
 * (`forge_identity_copy_invalid`), never guessed.
 */
export function repositoryIdentityCopies(top: string, identity: RepositoryIdentity): ReadonlyMap<string, string> {
  const copies = new Map<string, string>();
  const manifestPath = join(top, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const record = (field: string): Record<string, unknown> => {
      const value = manifest[field];
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ForgeError("forge_identity_copy_invalid", `package.json \`${field}\` is not an object with a url.`, { path: "package.json", field });
      return value as Record<string, unknown>;
    };
    const updated = { ...manifest, repository: { ...record("repository"), url: identity.gitUrl }, homepage: identity.webUrl, bugs: { ...record("bugs"), url: identity.issuesUrl } };
    // Key order is kept: the spread keeps each field where the file has it.
    copies.set("package.json", `${JSON.stringify(updated, null, 2)}\n`);
  }
  const citationPath = join(top, "CITATION.cff");
  if (existsSync(citationPath)) {
    const lines = readFileSync(citationPath, "utf8").split("\n");
    const at = lines.flatMap((line, index) => (line.startsWith("repository-code:") ? [index] : []));
    if (at.length !== 1) throw new ForgeError("forge_identity_copy_invalid", `CITATION.cff must hold exactly one top-level repository-code line; it holds ${String(at.length)}.`, { path: "CITATION.cff", field: "repository-code" });
    lines[at[0]!] = `repository-code: "${identity.webUrl}"`;
    copies.set("CITATION.cff", lines.join("\n"));
  }
  const tree = workingTreeReader(top);
  const documents = tree.paths().filter((path) => path.endsWith(".md"));
  tree.prefetch(documents);
  for (const path of documents) {
    const text = tree.text(path);
    if (text === null) continue;
    const linked = withIdentityLinks(text, identity);
    if (linked !== text) copies.set(path, linked);
  }
  return copies;
}
