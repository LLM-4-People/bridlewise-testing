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

/**
 * THE SITE'S CONTENT-SECURITY-POLICY, the boundary the browser enforces on
 * every page whatever spelling produced it. Only the site's own files load:
 * - no inline script and no event handler;
 * - no inline `<style>`, and no style attribute beyond the table
 *   alignments above;
 * - no remote sheet, font, image or connection;
 * - no `<base>`, no plugin, no form posting elsewhere.
 * The builder writes it into `_includes/csp.html`. Every page includes it
 * right after its charset, before anything that loads.
 */
export function sitePolicy(): string {
  const hashes = MARKDOWN_STYLE_ATTRIBUTES.map((value) => `'sha256-${createHash("sha256").update(value).digest("base64")}'`);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `style-src-attr 'unsafe-hashes' ${hashes.join(" ")}`,
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
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
