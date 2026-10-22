/**
 * THE LICENCE BOUNDARY OVER THE TREE: no GPL-licensed bytes are committed.
 *
 * This repository is AGPL-3.0. GPL-licensed sources it needs (git's
 * GPL-2.0-only `path.c`, its t0060 test, its COPYING) are FETCHED FOR TESTING
 * into the corpus outside the tree, pinned by the path-policy manifest, and
 * never redistributed (`scripts/verification/corpus.ts`, `REFERENCE_ONLY_LICENSES`).
 * That boundary used to be assumed: nothing refused a GPL file committed into
 * the tree. The repository scan (`scripts/check-secrets.mjs`, the one walker
 * of the tracked tree) now asks this module about every line it reads.
 *
 * What counts as GPL-licensed text: an SPDX identifier of the GPL family
 * (`GPL-*`, `LGPL-*`, never the project's own `AGPL-*`), a GPL or LGPL
 * licence title, or the GPL's standard notice ("… under the terms of the GNU
 * (Lesser) General Public License as published by the Free Software
 * Foundation"). A mention in prose (`GPL-2.0-only` in a sentence or a
 * manifest's `spdx` field) is not licence text and passes.
 *
 * A file that carries such text is refused unless it is in the REVIEWED
 * allowlist below, each entry with its reason. There is no manifest
 * exemption: a manifest-referenced GPL source lives in the corpus, outside
 * the tree, so an in-tree copy is exactly what the boundary refuses. An entry
 * whose file no longer carries the text is reported stale.
 */

/** One finding: which marker a line carries. */
export type GplMarker = Readonly<{ marker: "spdx" | "title" | "notice"; text: string }>;

const SPDX_GPL = /SPDX-License-Identifier:\s*\(?\s*((?:L?GPL)-[0-9][0-9.]*(?:-only|-or-later|\+)?)/u;
// The title of a GPL or LGPL licence text (the AGPL's title says AFFERO).
const GPL_TITLE = /^\s*GNU (?:LESSER |LIBRARY )?GENERAL PUBLIC LICENSE\s*$/u;
const GPL_NOTICE = /under the terms of the GNU (?:Lesser |Library )?General Public License(?:,)? as published by/iu;

/** The GPL-licence markers a line carries (empty for almost every line). */
export function gplMarkers(line: string): readonly GplMarker[] {
  if (!/GPL|GENERAL PUBLIC LICENSE|General Public License/u.test(line)) return [];
  const found: GplMarker[] = [];
  const spdx = SPDX_GPL.exec(line);
  if (spdx !== null) found.push({ marker: "spdx", text: spdx[1]! });
  if (GPL_TITLE.test(line)) found.push({ marker: "title", text: line.trim() });
  if (GPL_NOTICE.test(line)) found.push({ marker: "notice", text: "the GNU General Public License notice" });
  return found;
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
