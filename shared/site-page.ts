/**
 * WHAT EVERY PAGE OF THE PUBLIC SITE CARRIES, stated once for its two users:
 * - the builder writes it into the pages (`scripts/floor/site-design.mjs`);
 * - the rendered judge checks it on every built page
 *   (`scripts/rendered/rules.ts`).
 */
import { createHash } from "node:crypto";

/**
 * The only style attributes a page may carry: the table alignments kramdown
 * writes for a Markdown table's `:--`, `:-:` and `--:` columns. The policy
 * allows exactly these by hash; any other style attribute is blocked.
 */
export const MARKDOWN_STYLE_ATTRIBUTES: readonly string[] = Object.freeze(["text-align: left", "text-align: center", "text-align: right"]);

/** The style attributes' hashes the policies allow (with 'unsafe-hashes'), generated from the list above. */
function attributeHashes(): string {
  return MARKDOWN_STYLE_ATTRIBUTES.map((value) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`).join(" ");
}

/** A base path as the policies scope it: "" for a site at the root, otherwise "/x" with no trailing slash. */
export function scopeBase(baseurl: string): string {
  const trimmed = baseurl.replace(/\/+$/u, "");
  return trimmed === "" ? "" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * THE SITE'S CONTENT-SECURITY-POLICIES, the boundary the browser enforces on
 * every page whatever spelling produced it. A page carries both, and the
 * browser enforces their intersection:
 * - the ORIGIN policy: only the page's own origin (`'self'`) loads anything;
 *   no inline script, no event handler, no inline `<style>`, no style
 *   attribute beyond the table alignments above, no `<base>`, no plugin,
 *   no form posting elsewhere;
 * - the PATH policy: every source is scoped to the site's base path
 *   (`*:*<base>/`), because the Pages origin is shared by every site of the
 *   organisation (each repository is a path on it), and `'self'` alone would
 *   admit their files. Together: only files under this site's own path on
 *   its origin load.
 * What path scoping does not do: another site on the same origin can still
 * reach this one's pages by script (the same-origin policy knows no paths).
 * Only a dedicated origin closes that.
 * The builder writes both into `_includes/csp.html`, and every page includes
 * it right after its charset, before anything that loads.
 */
export function sitePolicies(baseurl: string): readonly [string, string] {
  const hashes = attributeHashes();
  const scope = `*:*${scopeBase(baseurl)}/`;
  return [
    [
      "default-src 'self'", "script-src 'self'", "style-src 'self'", `style-src-attr 'unsafe-hashes' ${hashes}`,
      "font-src 'self'", "img-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
    ].join("; "),
    [
      `default-src ${scope}`, `script-src ${scope}`, `style-src ${scope}`, `style-src-attr 'unsafe-hashes' ${hashes}`,
      `font-src ${scope}`, `img-src ${scope}`, `connect-src ${scope}`, "object-src 'none'", "base-uri 'none'", `form-action ${scope}`,
    ].join("; "),
  ];
}

/**
 * Where a reader's theme choice is remembered. Logbook leads, so no stored
 * value means Logbook; Carbon is the one stored choice. The site's scripts
 * (`docs/assets/js/theme.js`, `site.js`) read and write it, and a judge that
 * shows a page in Carbon stores it before the page loads.
 */
export const SITE_THEME_STORAGE = Object.freeze({ key: "bridlewise-theme", carbon: "carbon" });

/**
 * The pages whose stylesheets still carry a palette of their own, by sheet
 * (site-relative), each with the issue that removes it. The list only
 * shrinks. The static guard skips these sheets and the design test fails an
 * entry that is clean or gone; the rendered judge holds every other row on
 * their pages, but not the token rows.
 */
export const PALETTE_BURN_DOWN: ReadonlyMap<string, string> = new Map([
  ["run/run-demo.css", "#161: the run demo's own palette"],
  ["policy-lab/policy-lab.css", "#161: the policy lab's own palette"],
]);

/** The file extensions Pages serves as HTML (any case): every one is a page that must carry the policies. */
export const SERVED_HTML = /\.(?:x?html?)$/iu;
