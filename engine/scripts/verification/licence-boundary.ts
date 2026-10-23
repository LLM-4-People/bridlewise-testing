/**
 * THE LICENCE BOUNDARY OVER THE TREE: no GPL-licensed bytes are committed.
 *
 * This repository is AGPL-3.0. GPL-licensed sources it needs (git's
 * GPL-2.0-only `path.c`, its t0060 test, its COPYING) are FETCHED FOR TESTING
 * into the corpus outside the tree, pinned by the path-policy manifest, and
 * never redistributed (`scripts/verification/corpus.ts`, `REFERENCE_ONLY_LICENSES`).
 * That boundary used to be assumed: nothing refused a GPL file committed into
 * the tree. The repository scan (`scripts/check-secrets.mjs`, the one walker
 * of the tracked tree) now reads every file's lines through a GPL reader.
 *
 * What counts as GPL-licensed text, matched case-insensitively:
 *
 * - an SPDX expression (`SPDX-License-Identifier: …`, parsed: split on `AND`,
 *   `OR`, `WITH` and parentheses, the `WITH` exception skipped) naming a
 *   GPL-family licence (`GPL-*`, `LGPL-*`, the deprecated `GPL-2.0+` forms;
 *   never the project's own `AGPL-*`);
 * - a GPL or LGPL licence title line, whatever its comment or heading leader
 *   (`#`, `*`, `//`, …) and with or without its version on the same line;
 * - the GPL's standard notice ("… under the terms of the GNU (Lesser|Library)
 *   General Public License as published by …" or "… version …"), matched on
 *   the WORDS of a window of the last lines (lower-cased, punctuation and
 *   comment leaders dropped), so a notice split across lines (the canonical
 *   LGPL-2.1 notice is) is still one notice.
 *
 * A mention in prose (`GPL-2.0-only` in a sentence, a manifest's `spdx`
 * field) is not licence text and passes. The reading is one linear pass: the
 * window is read only when the line carries a keyword (any case) a title,
 * notice or SPDX line must carry.
 *
 * A file that carries such text is refused unless it is in the REVIEWED
 * allowlist below, each entry with its reason. There is no manifest
 * exemption: a manifest-referenced GPL source lives in the corpus, outside
 * the tree, so an in-tree copy is exactly what the boundary refuses. An entry
 * whose file no longer carries the text is reported stale.
 */

/** One finding: which marker a line carries. */
export type GplMarker = Readonly<{ marker: "spdx" | "title" | "notice"; text: string }>;

// A line must carry one of these (any case) to be part of a GPL title, notice or SPDX line.
const KEYWORD = /gpl|gnu|general|public|licen[cs]e|spdx/iu;
// Title and notice are matched on the line's WORDS: lower-cased, every run of
// other characters (comment and heading leaders, punctuation, line breaks)
// one space — so `# GNU …`, ` * GNU …` and a notice split across lines read
// the same.
const TITLE = /^gnu (?:lesser |library )?general public licen[cs]e(?: (?:version|v) ?[0-9].*)?$/u;
const NOTICE = /under the terms of the gnu (?:lesser |library )?general public licen[cs]e (?:as published by|version)/u;
const SPDX = /spdx-license-identifier\s*:\s*(.*)$/iu;
// The notice spans at most this many lines in every canonical GPL/LGPL header.
const NOTICE_WINDOW_LINES = 4;

function words(line: string): string {
  return line.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

/** The licence ids of an SPDX expression: operators, parentheses and `WITH` exceptions removed. */
export function spdxLicences(expression: string): readonly string[] {
  // Comment trailers (`*/`, `-->`) and parentheses are not licence ids.
  const tokens = expression.replace(/[()]/gu, " ").trim().split(/\s+/u)
    .filter((token) => token.length > 0 && /[A-Za-z0-9]/u.test(token));
  const licences: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const word = tokens[at]!;
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR") continue;
    if (upper === "WITH") {
      at += 1; // the exception after WITH is not a licence
      continue;
    }
    licences.push(word);
  }
  return licences;
}

/** Whether an SPDX licence id is GPL-family (GPL or LGPL, any version or suffix; never AGPL). */
export function isGplFamily(licence: string): boolean {
  return /^(?:l?gpl)-?[0-9]/iu.test(licence) || /^l?gpl$/iu.test(licence);
}

/**
 * A reader over ONE file's lines, in order: `push` answers the GPL markers
 * the line completes. A notice is reported once, at the line that completes
 * it.
 */
export function createGplReader(): Readonly<{ push: (line: string) => readonly GplMarker[] }> {
  const window: string[] = [];
  let noticeOpenFor = 0;
  return Object.freeze({
    push(line: string): readonly GplMarker[] {
      window.push(line);
      if (window.length > NOTICE_WINDOW_LINES) window.shift();
      if (noticeOpenFor > 0) noticeOpenFor -= 1;
      if (!KEYWORD.test(line)) return [];
      const found: GplMarker[] = [];
      const spdx = SPDX.exec(line);
      if (spdx !== null) {
        for (const licence of spdxLicences(spdx[1]!)) {
          if (isGplFamily(licence)) found.push({ marker: "spdx", text: licence });
        }
      }
      if (TITLE.test(words(line))) found.push({ marker: "title", text: line.trim() });
      if (noticeOpenFor === 0 && NOTICE.test(window.map(words).join(" "))) {
        found.push({ marker: "notice", text: "the GNU General Public License notice" });
        noticeOpenFor = NOTICE_WINDOW_LINES;
      }
      return found;
    },
  });
}

/**
 * THE REVIEWED ALLOWLIST: tracked files that may carry GPL-licence text, each
 * with why. Empty: the tree carries none. The project's own LICENSE is AGPL
 * text, whose title and §13 reference the GPL by name but are neither a GPL
 * title line nor the GPL's notice, so it needs no entry.
 */
export const REVIEWED_GPL_TEXT: ReadonlyMap<string, string> = new Map([]);

/** Reviewed entries whose file carried no GPL-licence text in this scan: stale, to be removed. */
export function staleReviewedEntries(
  carriers: ReadonlySet<string>,
  reviewed: ReadonlyMap<string, string> = REVIEWED_GPL_TEXT,
): readonly string[] {
  return [...reviewed.keys()].filter((path) => !carriers.has(path)).toSorted();
}
