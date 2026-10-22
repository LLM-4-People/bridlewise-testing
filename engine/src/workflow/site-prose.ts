/**
 * RECORD PROSE ON A SITE PAGE — a record's Markdown (a tracker item's body)
 * published on a page the site's Liquid and kramdown render (the roadmap,
 * the task board), with NO spelling of the record able to reach the page as
 * markup.
 *
 * The record is PARSED by the one Markdown parser (`shared/markdown.ts`,
 * which reads raw HTML as text and keeps only http, https and mailto links)
 * and the page's Markdown is WRITTEN from that tree: every text leaf through
 * the markup owner's site escape (`escapeSiteText`: Markdown syntax
 * backslash-escaped, HTML specials and Liquid's braces as character
 * references), every code leaf as an HTML `<code>` element through
 * `escapeSiteHtml`. Only the structure the parser recognised is written back:
 * paragraphs, headings, lists, quotes, rules, tables, emphasis and links. So
 * an unclosed fence, raw HTML, a kramdown attribute list `{: …}` or a Liquid
 * `{% … %}` / `{{ … }}` in a record is shown as text, never run, whatever its
 * spelling; there is no detector to get past.
 *
 * Links: a relative link (a repository path, written from the record's
 * folder) and an absolute one are each handed to the page's `href`, which
 * answers the destination the page publishes (a page-relative path, or a
 * Liquid spelling of the repository's own URL). Every character of a
 * destination outside a URL's own set is percent-encoded, braces included,
 * except a leading `{{ site.repository_url }}` the page itself wrote.
 */
import { parseProse, type InlineNode, type MdBlock } from "../../../shared/markdown.ts";
import { escapeSiteHtml, escapeSiteText } from "../../../shared/markup.ts";
import { rewriteRelativeLinks } from "./markdown-links.ts";

/** A link's destination as the record wrote it: a repository path with its fragment (a relative link), or an absolute URL. */
export type ProseTarget =
  | Readonly<{ kind: "relative"; path: string; fragment: string }>
  | Readonly<{ kind: "absolute"; url: string }>;

/** The destination a page publishes for a record's link. */
export type ProseHref = (target: ProseTarget) => string;

/** A relative link survives the parser's scheme allowlist as this marker; the page's `href` replaces it. */
const RELATIVE_MARK = "https://relative.invalid/";
/** The one Liquid spelling a page may lead a destination with. */
const SITE_REPOSITORY = "{{ site.repository_url }}";

/** `url` with every character outside a URL's own set percent-encoded (braces, quotes, spaces, angle brackets, and the parentheses that would end a Markdown destination). */
function urlSafe(url: string): string {
  return url.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&*+,;=%]/gu, (character) => (character === "'" || character === "(" || character === ")" ? `%${character.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(character)));
}

/** A destination a page publishes: percent-encoded outside a URL's own set, a leading `{{ site.repository_url }}` the page wrote kept as written. */
export function siteDestination(href: string): string {
  return href.startsWith(SITE_REPOSITORY) ? `${SITE_REPOSITORY}${urlSafe(href.slice(SITE_REPOSITORY.length))}` : urlSafe(href);
}

function inline(nodes: readonly InlineNode[], href: ProseHref): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return escapeSiteText(node.text);
      case "code": return `<code>${escapeSiteHtml(node.code)}</code>`;
      case "bold": return `**${inline(node.children, href)}**`;
      case "italic": return `*${inline(node.children, href)}*`;
      case "strike": return `~~${inline(node.children, href)}~~`;
      case "link": {
        const target: ProseTarget = node.href.startsWith(RELATIVE_MARK)
          ? (([path, fragment]) => ({ kind: "relative" as const, path: path!, fragment: fragment ?? "" }))(decodeURIComponent(node.href.slice(RELATIVE_MARK.length)).split("\n"))
          : { kind: "absolute", url: node.href };
        return `[${inline(node.children, href)}](${siteDestination(href(target))})`;
      }
    }
  }).join("");
}

function blocks(list: readonly MdBlock[], href: ProseHref, headingFloor: number): string[] {
  return list.map((block) => {
    switch (block.type) {
      case "paragraph": return inline(block.children, href);
      case "heading": return `${"#".repeat(Math.min(6, Math.max(block.level, headingFloor)))} ${inline(block.children, href)}`;
      case "code": return `<pre><code>${escapeSiteHtml(block.code)}</code></pre>`;
      case "hr": return "---";
      case "blockquote": return blocks(block.children, href, headingFloor).join("\n\n").split("\n").map((line) => (line.length === 0 ? ">" : `> ${line}`)).join("\n");
      case "list": return block.items.map((item, index) => {
        const marker = block.ordered ? `${String(index + 1)}.` : "-";
        const nested = blocks(item.subBlocks, href, headingFloor).join("\n\n").split("\n").filter((line) => line.length > 0).map((line) => `${" ".repeat(marker.length + 1)}${line}`);
        return [`${marker} ${inline(item.children, href)}`, ...nested].join("\n");
      }).join("\n");
      case "table": {
        const row = (cells: readonly (readonly InlineNode[])[]): string => `| ${cells.map((cell) => inline(cell, href)).join(" | ")} |`;
        return [row(block.header), `|${block.header.map(() => "---").join("|")}|`, ...block.rows.map(row)].join("\n");
      }
    }
  });
}

/** `markdown`'s relative links (written from `fromDirectory`) marked so the parser keeps them as links. */
function marked(markdown: string, fromDirectory: string): string {
  return rewriteRelativeLinks(markdown, fromDirectory, (path, fragment) => `${RELATIVE_MARK}${encodeURIComponent(`${path}\n${fragment}`)}`);
}

/** A record's prose (written in `fromDirectory`) as site-page Markdown: every block, headings at least `headingFloor` deep. */
export function siteProse(markdown: string, fromDirectory: string, href: ProseHref, headingFloor: number): string {
  return blocks(parseProse(marked(markdown, fromDirectory)), href, headingFloor).join("\n\n");
}

/** A record's FIRST paragraph (or first block's text) as one line of site-page Markdown: a table cell, a list row's head. */
export function siteProseLine(markdown: string, fromDirectory: string, href: ProseHref): string {
  const first = parseProse(marked(markdown, fromDirectory))[0];
  if (first === undefined) return "";
  if (first.type === "paragraph" || first.type === "heading") return inline(first.children, href);
  if (first.type === "list") return first.items.map((item) => inline(item.children, href)).join(" · ");
  return blocks([first], href, 6).join(" ").replace(/\n/gu, " ");
}
