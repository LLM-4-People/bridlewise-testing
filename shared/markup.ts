/**
 * THE ONE MARKUP OWNER: every HTML or Markdown escape, entity decode, tag
 * strip and markup removal in the tree goes through this file
 * (`tests/public/markup-owner.test.mjs` refuses a hand-rolled copy).
 *
 * ── THE BOUNDARY WITH THE SOURCE VIEW ─────────────────────────────────────
 *
 * This file owns HTML TEXT: a built page, a rendered string, a table cell.
 * It does not own SOURCE FILES. Which spans of a `.ts` or `.svelte` file are
 * comments, strings or markup comments is a lexing question about program
 * text, and `engine/scripts/verification/source-view.ts` is its one owner
 * (the source-scan views, `stripHtmlComments` included, render its spans). A
 * markup helper here must never be used to read source, and the source view
 * is never used to rewrite HTML.
 *
 * Each copy these replace was a per-file regex chain, and each had the hole
 * CodeQL names for that shape:
 * - a decode chain that turned `&amp;` into `&` before decoding `&lt;`, so
 *   `&amp;lt;` decoded twice into `<` (double unescaping);
 * - a single `replace(/<!--…-->/)` or `replace(/<script…<\/script>/)` pass,
 *   which can leave a new `<!--` or `<script` once the inner match is gone,
 *   and which missed `<SCRIPT>` and `</script >`;
 * - a Markdown table cell that escaped `|` but not the backslash before it.
 *
 * The rules here:
 * - escapes and decodes are ONE pass over the input with one alternation, so
 *   no step's output is read by a later step;
 * - removal never concatenates the text on both sides of a removed region:
 *   the region becomes one space, so no new token can form across it; and
 *   tag stripping repeats to a fixed point;
 * - element names and closing tags match case-insensitively, with optional
 *   whitespace before `>`.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // An address's own punctuation (the history importer's address gate reads an address however it is written).
  commat: "@",
  period: ".",
  lowbar: "_",
});

/** Text made safe for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Decode the character references an attribute value or an address may carry:
 * the five markup names, an address's punctuation (`commat`, `period`,
 * `lowbar`), and decimal and hexadecimal numeric references, in ONE pass.
 * Anything else (an unknown name, a reference without `;`) stays as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/gu, (whole, decimal, hex, name) => referenceValue(whole, decimal, hex, name));
}

/**
 * Every character reference token AS A READER MAY WRITE IT, for a search (never for rendering): a numeric
 * reference (`&#NN`, `&#xNN`) with or without its `;` is its character; a named one this owner knows is its
 * character; any other name (`&shy;`, a name no table holds) is REMOVED, since a reader skips what it does
 * not show. ONE pass.
 */
export function looseCharacterReferences(text: string): string {
  return text.replace(/&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{0,31});)/gu, (whole, decimal, hex, name) => {
    const value = referenceValue(whole, decimal, hex, name);
    return value === whole && name !== undefined ? "" : value;
  });
}

/** One character reference's character, or the reference as written when it names none. */
function referenceValue(whole: string, decimal: string | undefined, hex: string | undefined, name: string | undefined): string {
  if (decimal !== undefined || hex !== undefined) {
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  }
  return NAMED_ENTITIES[name!] ?? whole;
}

/**
 * Plain text placed in Markdown prose (a list item, a heading): nothing in it
 * is read as syntax. In ONE pass, the HTML specials become entities (no tag,
 * no comment, no entity forms) and every ASCII punctuation character Markdown
 * can read as syntax is backslash-escaped (no link, image, emphasis, code
 * span, heading or list marker forms); a line break becomes a space, so the
 * text stays in its one block.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[&<>"']|[\\`*_{}[\]()#+\-.!|~:]|\r\n|[\r\n]/gu, (match) => HTML_ESCAPES[match] ?? (match.endsWith("\n") || match === "\r" ? " " : `\\${match}`));
}

/**
 * Liquid's delimiters as character references. Every site page with front
 * matter is rendered by Liquid before Markdown, and kramdown reads `{: …}` as
 * an attribute list: a brace written as a reference is shown, never run.
 */
const LIQUID_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "{": "&#123;",
  "}": "&#125;",
});

/**
 * Plain text placed in a SITE page's Markdown (a page the site's Liquid and
 * kramdown render): {@link escapeMarkdownText}, with Liquid's braces written
 * as character references, so no `{{ … }}`, `{% … %}` or `{: … }` survives.
 * ONE pass; a line break becomes a space.
 */
export function escapeSiteText(text: string): string {
  return text.replace(/[&<>"'{}]|[\\`*_[\]()#+\-.!|~:]|\r\n|[\r\n]/gu, (match) => HTML_ESCAPES[match] ?? LIQUID_ESCAPES[match] ?? (match.endsWith("\n") || match === "\r" ? " " : `\\${match}`));
}

/**
 * Text placed inside an HTML element of a site page (code): {@link escapeHtml},
 * with Liquid's braces and the table-cell pipe as character references (so
 * the element can stand in a Markdown table cell). ONE pass.
 */
export function escapeSiteHtml(text: string): string {
  return text.replace(/[&<>"'{}|]/gu, (character) => HTML_ESCAPES[character] ?? LIQUID_ESCAPES[character] ?? (character === "|" ? "&#124;" : character));
}

/**
 * The text {@link escapeSiteText} or {@link escapeSiteHtml} wrote, read back
 * (a reader of a generated page, such as the task board's owner names): a
 * backslash escape of ASCII punctuation and a character reference each become
 * their character, in ONE pass, so no reference is decoded twice.
 */
export function decodeSiteText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])|&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/gu, (whole, escaped, decimal, hex, name) => escaped ?? referenceValue(whole, decimal, hex, name));
}

/**
 * Plain text placed in a GitHub issue or comment: {@link escapeMarkdownText},
 * and an `@` followed by a word joiner (U+2060), so no `@name` or
 * `@org/team` in the text mentions anyone. ONE pass; a line break becomes a
 * space.
 */
export function escapeGithubText(text: string): string {
  return text.replace(/[&<>"']|[\\`*_{}[\]()#+\-.!|~:]|@|\r\n|[\r\n]/gu, (match) => HTML_ESCAPES[match] ?? (match === "@" ? "@\u2060" : match.endsWith("\n") || match === "\r" ? " " : `\\${match}`));
}

/** One Markdown table cell: a backslash and a pipe are escaped, in one pass. */
export function escapeMarkdownTableCell(text: string): string {
  return text.replace(/[\\|]/gu, (character) => `\\${character}`);
}

/**
 * Text with every markup tag removed, to a fixed point: removing `<b>` from
 * `<<b>x>` leaves `<x>`, which the next round removes. A lone `<` or `>` that
 * opens no tag stays.
 */
export function stripTags(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/<[^<>]*>/gu, "");
    if (next === current) return current;
    current = next;
  }
}

/**
 * The HTML with comments and the named elements (with everything inside
 * them) removed, each removed region replaced by ONE space so the text on
 * its two sides can never join into a new tag or comment opener.
 *
 * One left-to-right walk: at each `<`, a comment runs to the next `-->` (or
 * to the end of the input when unclosed), and an opening tag of a named
 * element (any case) runs to its closing tag (`</name` + optional
 * whitespace + `>`, any case) or to the end of the input when unclosed.
 */
export function htmlWithout(html: string, options: Readonly<{ comments?: boolean; elements?: readonly string[] }>): string {
  const elements = (options.elements ?? []).map((name) => name.toLowerCase());
  const lower = html.toLowerCase();
  let out = "";
  let kept = 0;
  let index = lower.indexOf("<");
  while (index !== -1) {
    let end = -1;
    if (options.comments === true && lower.startsWith("<!--", index)) {
      const close = lower.indexOf("-->", index + 4);
      end = close === -1 ? html.length : close + 3;
    } else {
      const element = elements.find((name) => lower.startsWith(name, index + 1) && /[\s/>]/u.test(lower[index + 1 + name.length] ?? ">"));
      if (element !== undefined) {
        const closing = new RegExp(`</${element}\\s*>`, "gu");
        closing.lastIndex = index + 1 + element.length;
        const match = closing.exec(lower);
        end = match === null ? html.length : match.index + match[0].length;
      }
    }
    if (end === -1) {
      index = lower.indexOf("<", index + 1);
      continue;
    }
    out += `${html.slice(kept, index)} `;
    kept = end;
    index = lower.indexOf("<", end);
  }
  return out + html.slice(kept);
}
