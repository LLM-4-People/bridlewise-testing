/**
 * THE SOCIAL CARDS — the picture a link to the site shows, and the one the
 * repository's social preview carries: the site's own card page
 * (`docs/social/card.html`, drawn from the judged register in the one design
 * system), shot by the browser in both themes after Jekyll builds the site.
 *
 *   node scripts/visual/social.ts --site <built site> --baseurl <base path>
 *
 * It writes `assets/social.png` (Logbook, the lead theme, every page's
 * og:image) and `assets/social-dark.png` (Carbon) into the built site. A card
 * page that is missing, or a card that overflows its 1280x640 frame, refuses
 * (`visual_*`).
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { BROWSER_ARGS, FREEZE_CSS } from "./plan.ts";
import { serve, VisualRefusal } from "./screens.ts";

/** The card: its page, its frame (the size every preview crops to), and the file each theme becomes. */
export const SOCIAL_CARD = Object.freeze({
  page: "/social/card/",
  width: 1280,
  height: 640,
  files: Object.freeze({ logbook: "assets/social.png", carbon: "assets/social-dark.png" }),
});

/** Shoots the card in each theme into the built site at `site`. */
export async function shootSocialCards({ site, baseurl }: { site: string; baseurl: string }): Promise<readonly string[]> {
  const root = resolve(site);
  if (!existsSync(join(root, ...SOCIAL_CARD.page.split("/").filter(Boolean), "index.html"))) {
    throw new VisualRefusal("visual_page_missing", `${SOCIAL_CARD.page} is not in the built site at ${root}: build it with scripts/build-site.mjs and Jekyll first`);
  }
  const { server, origin } = await serve(root, baseurl);
  const browser = await chromium.launch({ args: [...BROWSER_ARGS] });
  const written: string[] = [];
  try {
    for (const [theme, file] of Object.entries(SOCIAL_CARD.files)) {
      const page = await browser.newPage({ viewport: { width: SOCIAL_CARD.width, height: SOCIAL_CARD.height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const url = `${origin}${baseurl.replace(/\/+$/u, "")}${SOCIAL_CARD.page}${theme === "carbon" ? "?theme=carbon" : ""}`;
      const response = await page.goto(url, { waitUntil: "networkidle" });
      if (response === null || !response.ok()) throw new VisualRefusal("visual_page_missing", `${url} answered ${String(response?.status() ?? "nothing")}`);
      await page.addStyleTag({ content: FREEZE_CSS });
      await page.evaluate(async () => { await document.fonts.ready; });
      const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
      if (size.width > SOCIAL_CARD.width || size.height > SOCIAL_CARD.height) {
        throw new VisualRefusal("visual_card_overflow", `the ${theme} card is ${String(size.width)}x${String(size.height)}, past its ${String(SOCIAL_CARD.width)}x${String(SOCIAL_CARD.height)} frame: a preview would crop it`);
      }
      writeFileSync(join(root, ...file.split("/")), await page.screenshot({ clip: { x: 0, y: 0, width: SOCIAL_CARD.width, height: SOCIAL_CARD.height }, animations: "disabled" }));
      written.push(file);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { site: { type: "string" }, baseurl: { type: "string" } } });
  if (values.site === undefined || values.baseurl === undefined) {
    process.stderr.write("visual_usage: social.ts --site <built site> --baseurl <base path>\n");
    process.exitCode = 1;
  } else {
    shootSocialCards({ site: values.site, baseurl: values.baseurl }).then(
      (files) => { process.stdout.write(`social cards: ${files.join(", ")}\n`); },
      (error: unknown) => { process.stderr.write(`social cards failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
    );
  }
}
