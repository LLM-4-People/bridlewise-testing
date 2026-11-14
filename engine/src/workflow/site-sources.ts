/**
 * The site's source contract: route/catalog records, captured URL history,
 * front matter and the one discovery walk. Readers perform no work at import.
 * The builder and generator-copy admission consume this same observed input
 * footprint, including candidate reads and declared source existence.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVED_HTML } from "../../../shared/markup.ts";

export const DOCS_ROOT = "docs";
export const PAGE_ROUTES = "docs/_data/page-routes.json";
export const SITE_URL_HISTORY = "docs/_data/site-url-history.json";
/** Builder-only delimiters identify authored content after the configured Markdown renderer runs. */
export const PAGE_CONTENT = Object.freeze({ start: "site-page-content:start", end: "site-page-content:end" });
/** Deferred builder globals are projected in actual rendered attributes, never granted by source-token presence. */
export const SITE_LINK_PREFIX = "urn:site-publish-plan:";
export const SITE_LINKS = Object.freeze({ versions: `${SITE_LINK_PREFIX}versions` });
/** One rendered URL carries its generated source identity, never page-wide permission. */
export const SITE_SOURCE_ATTRIBUTE = "data-site-source";
const SITE_SOURCE_PREFIX = `${SITE_LINK_PREFIX}source:`;

export function siteSourceReference(sourceId: string): string {
  if (!relativePageKey(sourceId)) throw new Error("builder source reference has an invalid source identity");
  return `${SITE_SOURCE_PREFIX}${encodeURIComponent(sourceId)}`;
}

/** Only the source owner's canonical encoding is accepted. */
export function readSiteSourceReference(reference: string): string {
  if (typeof reference !== "string" || !reference.startsWith(SITE_SOURCE_PREFIX)) throw new Error("unsupported builder source reference");
  let sourceId: string;
  try { sourceId = decodeURIComponent(reference.slice(SITE_SOURCE_PREFIX.length)); }
  catch (error) {
    if (error instanceof URIError) throw new Error("unsupported builder source reference encoding");
    throw error;
  }
  if (siteSourceReference(sourceId) !== reference) throw new Error("builder source reference is not canonical");
  return sourceId;
}

/** An HTML attribute's URL path is decoded once; query and fragment stay verbatim. */
export function siteLinkPath(target: string): Readonly<{ path: string; suffix: string }> {
  const at = target.search(/[?#]/u);
  const path = at === -1 ? target : target.slice(0, at);
  const suffix = at === -1 ? "" : target.slice(at);
  try {
    return { path: decodeURIComponent(path), suffix };
  } catch (error) {
    if (error instanceof URIError) return { path, suffix };
    throw error;
  }
}

export type SiteArtifact = Readonly<{
  sourceEntry: string;
  outputPath: string;
  connections: "site" | "none";
  surface: "site" | "cockpit";
}>;
export type SiteRoutes = Readonly<{
  docsHome: string | null;
  livePages: Readonly<Record<string, string>>;
  artifacts: readonly SiteArtifact[];
  configured: boolean;
}>;
export type SiteUrlHistory = Readonly<{
  pages: Readonly<Record<string, string>>;
  aliases: Readonly<Record<string, string>>;
}>;
/** The generated artifact projection returned by the one site-page reader. */
export type SitePlanProjectionRecord = Readonly<{
  schemaVersion: string;
  phase: "source" | "links-resolved";
  baseurl: string;
  release: string | null;
  /** Known coordinate fields are checked by the JS owner; extra fields are not narrowed. */
  coordinates: Readonly<Record<string, unknown>>;
  pages: Readonly<Record<string, Readonly<{ permalink: string; artifact: boolean; sourceSha256: string }>>>;
  previousPages: Readonly<Record<string, string>>;
}>;
export type SitePlanProjectionOptions = Readonly<{
  site: string;
  phase?: "source" | "links-resolved" | null;
  root?: string | null;
  baseurl?: string | null;
  release?: string | null;
  coordinates?: Readonly<Record<string, string>>;
}>;
/** One projected source's observed output; null is unresolved or deferred before artifact assembly. */
export type SitePlannedDocument = SitePlanProjectionRecord["pages"][string] & Readonly<{
  sourceId: string;
  file: string | null;
}>;
/** The one file owner's failure classification; adapters preserve it without parsing diagnostic text. */
export type SiteDocumentProblem = Readonly<{
  kind: "output" | "collision";
  sourceId: string;
  permalink: string;
  message: string;
}>;
/** Transient file facts of one built artifact; no policy capability comes from this projection. */
export type SiteDocumentFiles = Readonly<{
  projection: SitePlanProjectionRecord;
  planned: readonly SitePlannedDocument[];
  documentFiles: readonly string[];
  problems: readonly SiteDocumentProblem[];
  errors: readonly string[];
}>;
/** Typed capability of the existing JS owner; its implementation remains runtime-tested. */
export type SitePlanProjectionOwner = Readonly<{
  SITE_PLAN_FILE: string;
  readSitePlanProjection(options: SitePlanProjectionOptions): SitePlanProjectionRecord;
  readSiteDocumentFiles(options: SitePlanProjectionOptions): SiteDocumentFiles;
  siteUrlForPermalink(permalink: string, baseurl?: string): string;
}>;
export type BuiltSiteFilesOwner = Readonly<{
  existingSiteFiles(siteRoot: string, sitePath: string): readonly string[];
}>;

export type SitePageSource = Readonly<{
  docsPath: string;
  file: string;
  text: string;
  data: Readonly<Record<string, string>>;
  frontMatter: boolean;
}>;

export function relativePageKey(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function pagePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("//") || /[?#\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    // This is root-relative path canonicalization, independent of deployment.
    return new URL(value, "https://site.invalid").pathname === encodeURI(value);
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError) return false;
    throw error;
  }
}

export function siteRecord(root: string, name: string): unknown {
  let text: string;
  try {
    text = readFileSync(resolve(root, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${name} is not readable JSON`);
    throw error;
  }
}

/** Read and validate the authored route/catalog contract without a page walk. */
export function readSiteRoutes(root: string): SiteRoutes {
  const value = siteRecord(root, PAGE_ROUTES);
  if (value === undefined) return { docsHome: null, livePages: {}, artifacts: [], configured: false };
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${PAGE_ROUTES} is not a site-page route declaration`);
  const routes = value as Record<string, unknown>;
  const artifacts = routes.artifacts ?? [];
  if (routes.schemaVersion !== "bridlewise-site-page-routes/v1" || !relativePageKey(routes.docsHome)
    || Object.keys(routes).some((name) => !["schemaVersion", "docsHome", "livePages", "artifacts"].includes(name))
    || routes.livePages === null || typeof routes.livePages !== "object" || Array.isArray(routes.livePages)
    || !Object.entries(routes.livePages).every(([name, path]) => relativePageKey(name) && pagePath(path))
    || !Array.isArray(artifacts) || !artifacts.every((value: unknown) => {
      if (value === null || typeof value !== "object") return false;
      const artifact = value as Record<string, unknown>;
      return Object.keys(artifact).every((name) => ["sourceEntry", "outputPath", "connections", "surface"].includes(name))
        && relativePageKey(artifact.sourceEntry) && pagePath(artifact.outputPath) && artifact.outputPath.endsWith("/") && artifact.outputPath !== "/"
        && (artifact.connections === "site" || artifact.connections === "none") && (artifact.surface === "site" || artifact.surface === "cockpit");
    })) {
    throw new Error(`${PAGE_ROUTES} is not a site-page route declaration`);
  }
  const livePages = routes.livePages as Record<string, string>;
  const accepted = artifacts as SiteArtifact[];
  if (Object.hasOwn(livePages, routes.docsHome)) throw new Error(`${PAGE_ROUTES}: the documentation home cannot be a live-only page`);
  const seen: SiteArtifact[] = [];
  for (const artifact of accepted) {
    if (lstatSync(resolve(root, artifact.sourceEntry), { throwIfNoEntry: false })?.isFile() !== true) throw new Error(`${PAGE_ROUTES}: artifact source ${artifact.sourceEntry} is not a file`);
    if (seen.some((other) => artifact.sourceEntry === other.sourceEntry || artifact.outputPath.startsWith(other.outputPath) || other.outputPath.startsWith(artifact.outputPath))) throw new Error(`${PAGE_ROUTES}: artifact identities or output namespaces overlap`);
    seen.push(artifact);
  }
  return { ...routes, docsHome: routes.docsHome, livePages, artifacts: accepted, configured: true };
}

function previousUrls(root: string, required: boolean): SiteUrlHistory {
  const value = siteRecord(root, SITE_URL_HISTORY);
  if (value === undefined) {
    if (required) throw new Error(`${SITE_URL_HISTORY} is missing: the configured site's captured URL history must be preserved`);
    return { pages: {}, aliases: {} };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${SITE_URL_HISTORY} is not a captured publish plan`);
  const history = value as Record<string, unknown>;
  const paths = (item: unknown, key: (candidate: unknown) => candidate is string): item is Record<string, string> => item !== null && typeof item === "object" && !Array.isArray(item)
    && Object.entries(item).every(([name, path]) => key(name) && pagePath(path));
  if (history.schemaVersion !== "bridlewise-site-url-history/v1" || !paths(history.pages, relativePageKey) || !paths(history.aliases, pagePath)) {
    throw new Error(`${SITE_URL_HISTORY} is not a captured publish plan`);
  }
  const canonical = new Set(Object.values(history.pages));
  if (canonical.size !== Object.keys(history.pages).length) throw new Error(`${SITE_URL_HISTORY} holds duplicate captured page URLs`);
  if (!Object.values(history.aliases).every((target) => canonical.has(target))) throw new Error(`${SITE_URL_HISTORY} holds an alias that does not land on a captured page`);
  return history as SiteUrlHistory;
}

/** Whether text opens with YAML front matter; the same grammar every site source reader uses. */
export function hasFrontMatter(text: string): boolean {
  return text.startsWith("---\n") || text.startsWith("---\r\n");
}

function pageFromText(text: string): Readonly<{ text: string; data: Readonly<Record<string, string>> }> {
  const data: Record<string, string> = {};
  if (hasFrontMatter(text)) {
    const opening = text.startsWith("---\r\n") ? 4 : 3;
    const end = text.indexOf("\n---", opening);
    if (end !== -1) {
      for (const line of text.slice(opening, end).split(/\r?\n/u)) {
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
        if (match === null) continue;
        let value = match[2]!.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        data[match[1]!] = value;
      }
    }
  }
  return { text, data };
}

/** Read a page once and parse its front matter through the shared source grammar. */
export function readPage(file: string): ReturnType<typeof pageFromText> {
  return pageFromText(readFileSync(file, "utf8"));
}

/** The actual source reads and existence probes needed by the publish plan, collected in its one walk. */
export function readSiteSources(root: string): Readonly<{
  routes: SiteRoutes;
  history: SiteUrlHistory;
  sources: readonly SitePageSource[];
  inputs: ReadonlySet<string>;
}> {
  const inputs = new Set([PAGE_ROUTES, SITE_URL_HISTORY]);
  const routes = readSiteRoutes(root);
  const history = previousUrls(root, routes.configured);
  for (const key of [routes.docsHome, ...Object.keys(routes.livePages)]) if (key !== null) inputs.add(`${DOCS_ROOT}/${key}`);
  for (const key of Object.keys(history.pages)) inputs.add(key);
  for (const artifact of routes.artifacts) inputs.add(artifact.sourceEntry);
  const sources: SitePageSource[] = [];
  const visit = (relative: string): void => {
    const directory = resolve(root, ...relative.split("/"));
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const markdown = /\.md$/iu.test(entry.name);
        const html = SERVED_HTML.test(entry.name) && !child.split("/").some((part) => part.startsWith("_"));
        if (markdown || html) {
          inputs.add(child);
          const file = resolve(root, child);
          const page = readPage(file);
          const frontMatter = hasFrontMatter(page.text);
          if (markdown || frontMatter) sources.push({ docsPath: child, file, ...page, frontMatter });
        }
      }
    }
  };
  visit(DOCS_ROOT);
  return { routes, history, sources, inputs };
}
