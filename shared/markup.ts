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
});

/** Text made safe for an HTML text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Decode the character references an attribute value may carry: the five
 * named ones plus decimal and hexadecimal numeric references, in ONE pass.
 * Anything else (an unknown name, a reference without `;`) stays as written.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/gu, (whole, decimal, hex, name) => {
    if (decimal !== undefined || hex !== undefined) {
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name] ?? whole;
  });
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
