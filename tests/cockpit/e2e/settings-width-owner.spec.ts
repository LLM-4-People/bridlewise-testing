/**
 * THE SETTINGS INDEX'S USE OF THE WIDTH, measured in a real layout engine.
 *
 * The user's report, twice now and about two different surfaces: *"take
 * advantage of the width of the screen"*. A settings surface answers that
 * badly in two opposite ways — a 76ch column stranded in the middle of a
 * 2560px screen, or rows stretched to full width so a five-word label sits
 * alone on a 2400px line. Neither shows MORE AT ONCE, which is the only thing
 * width is good for.
 *
 * So the property under test is simultaneity, not size:
 *
 *   A. AT WIDTH, THE MAP AND THE CONTENT SHARE THE SCREEN. The category rail
 *      and the settings are both visible, side by side and disjoint — you can
 *      see what categories exist AND what is inside one without a gesture.
 *   B. EACH ROW SPENDS THE WIDTH ON FACTS, not on stretch: label, what it
 *      does, what it is now and where that value came from are all on screen
 *      for the same row, in four columns that do not overlap.
 *   C. NOTHING IS CLIPPED, at either width, in either theme — no row's text
 *      is cut by its own box, and the room never scrolls sideways.
 *   D. BELOW THE SPLIT WIDTH the map moves ABOVE the settings — the narrow
 *      arrangement — and every category is still listed.
 *
 * MUTATION PROOF, in the spec itself: the split is removed at runtime (the
 * `.split` class dropped, which is exactly the pre-fix arrangement) and the
 * side-by-side predicate is asserted to FAIL. A guard that cannot fail is
 * worse than no guard.
 *
 * The API is route-mocked with real response SHAPES so this spec never
 * touches the shared dev DB or depends on the dev server's health; the schema
 * it serves is the real wire shape, including the module DECLARATIONS the
 * categories are derived from.
 */
import { expect, test, type Page } from "@playwright/test";

// The device rows are the app's OWN declaration — imported, not restated,
// so a new local-preference row cannot silently break the row count here.
// (Module-load safe under node: every DOM/storage touch in that module is
// guarded.)
import { LOCAL_ROWS } from "../../../src/cockpit/settings/local-prefs.ts";
import { SETTINGS_SPLIT_MIN_PX } from "../../../src/cockpit/settings/settings-config.ts";

// Four boots in one body (the clipping sweep) plus a shared dev server that
// other suites are also using: the default 30s is a flake, not a budget.
test.describe.configure({ timeout: 120_000 });

const COCKPIT_URL = "/";
// The split boundary is the settings room's OWN number (where the row grid
// fits beside the rail), consumed from its owner — never the shell fold.
const SPLIT_MIN = SETTINGS_SPLIT_MIN_PX;

type Box = { top: number; bottom: number; left: number; right: number };

/** Three declared categories + one namespace that declares none. */
const EXPOSURE_MODULES = [
  {
    id: "search",
    title: "Code search",
    purpose: "How the assistant looks through your code, and how exact a match has to be.",
  },
  {
    id: "tools",
    title: "Running tools",
    purpose: "How many tool calls may run at once and how long each one may take.",
  },
  {
    id: "memory",
    title: "What the assistant remembers",
    purpose: "How much the assistant keeps at hand while it works before older material goes.",
  },
];

function setting(
  id: string,
  label: string,
  description: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    label,
    description,
    type: "number",
    default: 4,
    min: 1,
    max: 64,
    unit: "calls",
    customizationId: id,
    module: id.slice(0, id.indexOf(".")),
    order: 0,
    ...extra,
  };
}

const SETTINGS = [
  setting(
    "search.threshold",
    "Minimum match score",
    "Search results scoring below this are dropped. Higher = fewer, more exact results; lower = more results, including loose matches.",
    { effect: "immediate" },
  ),
  setting(
    "search.maxResults",
    "Most results per search",
    "A search stops after finding this many results. Higher = more complete lists that take longer to produce.",
  ),
  setting(
    "tools.parallelCap",
    "Tools running at once",
    "How many tool calls may run at the same time before the rest wait their turn. Higher = faster bursts, more load.",
    { effect: "next-run" },
  ),
  setting(
    "tools.callTimeout",
    "Time limit per tool call",
    "A single tool call is abandoned after this long. Higher = slow tools get more room to finish.",
  ),
  setting(
    "memory.windowSize",
    "Working-memory size",
    "How much recent material the assistant keeps immediately at hand before older items are trimmed away.",
  ),
  // The WORST CASE the real data holds, so the width sweeps measure the
  // rows that actually broke: a label at the longest real length and a
  // comma-joined mono value + a provenance sentence embedding a long
  // default — the exact cells that once painted over their neighbour.
  setting(
    "search.weights",
    "How heavily complexity hotspots are weighted",
    "How strongly complexity hotspots pull the score down. Higher = complexity dominates the verdict; lower = the other signals carry it.",
    { type: "string", default: "search.queryCount,memory.entryCount,editor.editCount" },
  ),
  // A namespace that declares NO category — the honest-fallback path, on
  // screen beside the declared ones.
  setting(
    "ghost.knob",
    "How many trial passes run",
    "How many trial passes run before a result is reported. Higher = slower, steadier answers.",
  ),
];

const VALUES = {
  signals: [],
  customizations: [
    { id: "search.threshold", value: 4 }, // at its declared default
    { id: "search.maxResults", value: 12 }, // CHANGED from the default
    { id: "tools.parallelCap", value: 4 },
    { id: "tools.callTimeout", value: 30 },
    { id: "memory.windowSize", value: 4 },
    { id: "search.weights", value: "search.queryCount,memory.entryCount,editor.editCount,dedup.blockSimilarity" }, // CHANGED, longest real shape
    { id: "ghost.knob", value: 4 },
  ],
};

async function mockWarmSignedInApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/health")) return json({ status: "ok", harnessReady: false });
    if (url.includes("/api/auth/status"))
      return json({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
    if (url.includes("/api/schema/ui/values")) return json(VALUES);
    if (url.includes("/api/schema/ui"))
      return json({
        version: "bridlewise-ui-schema/v2",
        modules: [],
        menus: [],
        panels: [],
        widgets: [],
        settings: SETTINGS,
        actions: [],
        signals: [],
        exposureModules: EXPOSURE_MODULES,
        blockActions: {
          "settings.customizations": [
            {
              name: "set",
              title: "Save",
              consequence:
                "Saves the new value for this setting; it is checked against the setting's declared bounds first.",
              invalidates: ["settings:changed"],
            },
          ],
        },
      });
    if (url.includes("/api/projects")) return json([]);
    return json({});
  });
}

async function openSettings(page: Page): Promise<void> {
  const failures: unknown[] = [];
  const pageError = (error: Error) => failures.push({kind: "pageerror", message: error.message, stack: error.stack});
  const requestFailed = (request: import("@playwright/test").Request) => failures.push({kind: "requestfailed", url: request.url(), failure: request.failure()});
  const responseFailed = (response: import("@playwright/test").Response) => { if (response.status() >= 400) failures.push({kind: "http", url: response.url(), status: response.status(), resourceType: response.request().resourceType()}); };
  const consoleError = (message: import("@playwright/test").ConsoleMessage) => { if (message.type() === "error") failures.push({kind: "console", text: message.text(), location: message.location()}); };
  page.on("pageerror", pageError);
  page.on("requestfailed", requestFailed);
  page.on("response", responseFailed);
  page.on("console", consoleError);
  // The room grips are inert until the ONE-REVEAL frame (§10.3), so wait for
  // the shell's own reveal flag rather than for a control to become clickable
  // — the latter reads as a 30s "element not enabled" with no cause named.
  // Five boots per theme now run in this body; under the full worker pool a
  // boot can outlast 30s, so the bounded wait is 60s, not unbounded.
  try {
    await page.goto(COCKPIT_URL);
    await page.locator('[data-revealed="true"]').waitFor({ state: "attached", timeout: 60_000 });
  } catch (error) {
    await test.info().attach("shell-bootstrap-failure", {body: JSON.stringify({failures, url: page.url(), body: await page.locator("body").innerText()}, null, 2), contentType: "application/json"});
    throw error;
  } finally {
    page.off("pageerror", pageError);
    page.off("requestfailed", requestFailed);
    page.off("response", responseFailed);
    page.off("console", consoleError);
  }
  // Below the §2.7 fold breakpoint the room rail folds behind the one
  // "rooms" control (tokens.css --rail-display / --rail-fold-display), so
  // the settings grip is reached through the folded menu there — the same
  // path a narrow-viewport reader takes.
  const grip = page.locator('[data-chord-target="settings"]').first();
  if (await grip.isVisible()) {
    await grip.click();
  } else {
    await page.locator(".rail-fold").click();
    await page.locator('.rail-list [data-chord-target="settings"]').click();
  }
  await page.locator(".index").waitFor({ state: "visible" });
  await page.locator("li.setting-row").first().waitFor({ state: "visible" });
}

const boxOf = async (page: Page, selector: string): Promise<Box> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element for ${sel}`);
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }, selector);

const disjointHorizontally = (a: Box, b: Box): boolean => a.right <= b.left + 0.5;
const disjointVertically = (a: Box, b: Box): boolean => a.bottom <= b.top + 0.5;

test('shared edit and close marks are centered inside their actual hit boxes', async ({page}) => {
  await mockWarmSignedInApi(page);
  await page.route('**/api/models', route => route.fulfill({json:{providers:[{id:'geometry-provider',baseUrl:'http://localhost/v1',models:[{id:'model'}],hasApiKey:false,headerNames:[]}],defaultProvider:'geometry-provider',defaultModel:'model',setupRequired:false,setupRemedy:''}}));
  const cdp = await page.context().newCDPSession(page);
  const geometry = async (selector: string) => {
    const {root} = await cdp.send('DOM.getDocument', {depth:0});
    const {nodeId} = await cdp.send('DOM.querySelector', {nodeId:root.nodeId,selector});
    const {node} = await cdp.send('DOM.describeNode', {nodeId});
    const mark = node.pseudoElements?.find(n => n.pseudoType === 'before');
    expect(mark, 'the actual shared mark exists').toBeDefined();
    const hostBox = (await cdp.send('DOM.getBoxModel', {nodeId})).model.border;
    const markBox = (await cdp.send('DOM.getBoxModel', {backendNodeId:mark!.backendNodeId})).model.border;
    return {dx:Math.abs((hostBox[0]!+hostBox[4]!-markBox[0]!-markBox[4]!)/2),dy:Math.abs((hostBox[1]!+hostBox[5]!-markBox[1]!-markBox[5]!)/2),width:hostBox[2]!-hostBox[0]!,height:hostBox[5]!-hostBox[1]!};
  };
  for (const width of [1680,390]) {
    await page.setViewportSize({width,height:900});
    await openSettings(page);
    for (const selector of ['[data-verb-id="room.close"]', '[data-verb-id="models.provider/edit"]']) {
      await page.locator(selector).first().scrollIntoViewIfNeeded();
      const rect = await geometry(selector);
      expect(rect.width).toBeGreaterThanOrEqual(40);expect(rect.height).toBeGreaterThanOrEqual(40);
      expect(rect.dx).toBeLessThan(0.1);expect(rect.dy).toBeLessThan(0.1);
    }
    const fault = await page.addStyleTag({content:'.cockpit .verb.edit{gap:8px}'});
    expect((await geometry('[data-verb-id="models.provider/edit"]')).dx).toBeGreaterThan(3);
    await fault.evaluate(el => el.remove());
    expect((await geometry('[data-verb-id="models.provider/edit"]')).dx).toBeLessThan(0.1);
    await page.locator('[data-verb-id="models.provider/edit"]').click();
    const limits = page.locator('.model-options summary').first();
    await expect(limits).toHaveText('Limits');
    expect((await limits.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect((await page.locator('.model-row').first().boundingBox())!.height).toBeLessThan(160);
    await limits.click();
    await expect(page.getByLabel('context window for model 1, in tokens', {exact:true})).toBeVisible();
    await page.locator('[data-verb-id="models.provider/cancel"]').click();
  }
  await cdp.detach();
});

test.describe("settings index — the width", () => {
for (const theme of ["carbon", "logbook"] as const) {
  test.describe(`in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await mockWarmSignedInApi(page);
      await page.addInitScript((t) => {
        window.localStorage.setItem("cockpitTheme", t as string);
      }, theme);
    });

    test("A+B: at width the map and the settings share the screen, and a row spends the width on facts", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openSettings(page);

      // A. Both halves on screen, at the same time, not overlapping.
      await expect(page.locator(".index.split")).toHaveCount(1);
      const rail = await boxOf(page, "[data-settings-rail]");
      const scroll = await boxOf(page, "[data-settings-scroll]");
      expect(rail.right).toBeGreaterThan(rail.left); // the rail has real width
      expect(
        disjointHorizontally(rail, scroll),
        "the category map and the settings must sit side by side, not on top of each other",
      ).toBe(true);
      // …and they genuinely share the vertical band (side by side, not stacked).
      expect(Math.min(rail.bottom, scroll.bottom) - Math.max(rail.top, scroll.top)).toBeGreaterThan(
        200,
      );

      // A. The category structure and its contents are readable together: the
      // rail names every category, and the first category's settings are
      // already rendered without pressing anything.
      const railTitles = await page.locator(".rail-entry .rail-title").allInnerTexts();
      expect(railTitles).toContain("Code search");
      expect(railTitles).toContain("Running tools");
      expect(railTitles).toContain("What the assistant remembers");
      // The undeclared namespace is listed too — spelled out, never dropped.
      expect(railTitles).toContain("Ghost");
      expect(await page.locator("li.setting-row").count()).toBe(SETTINGS.length + LOCAL_ROWS.length); // + the device rows

      // B. Four facts in name/description/read-back columns, none overlapping, all inside the row.
      const row = page.locator('li.setting-row[data-setting="search.maxResults"]');
      const parts = await row.evaluate((li) => {
        const g = (s: string) => {
          const el = li.querySelector(s);
          if (el === null) throw new Error(`row is missing ${s}`);
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? "").trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const face = li.querySelector(".row-face")!.getBoundingClientRect();
        return {
          label: g(".label"),
          description: g(".description"),
          value: g(".value"),
          provenance: g(".provenance"),
          face: { left: face.left, right: face.right, width: face.width },
        };
      });
      expect(parts.face.width).toBeGreaterThan(900); // the row really is wide
      for (const cell of [parts.label, parts.description, parts.value, parts.provenance]) {
        expect(cell.text.length).toBeGreaterThan(0);
        expect(cell.left).toBeGreaterThanOrEqual(parts.face.left - 0.5);
        expect(cell.right).toBeLessThanOrEqual(parts.face.right + 0.5);
      }
      // Name, description and read-back occupy separate columns; provenance sits below the value.
      expect(parts.label.right).toBeLessThanOrEqual(parts.description.left + 0.5);
      expect(parts.description.right).toBeLessThanOrEqual(parts.value.left + 0.5);
      expect(parts.value.bottom).toBeLessThanOrEqual(parts.provenance.top + 0.5);

      // A shared recipe still means shared alignment across short and long
      // rows. Measure the read-back boundary relative to each row's origin.
      const trackOffsets = () => page.locator('.setting-tracks .row-face').evaluateAll(rows => rows.map(row => {
        const face = row.getBoundingClientRect();
        return row.querySelector('.row-reading')!.getBoundingClientRect().left - face.left;
      }));
      const aligned = (offsets: number[]) => Math.max(...offsets) - Math.min(...offsets) <= 0.5;
      const offsets = await trackOffsets();
      expect(offsets.length).toBeGreaterThan(2);
      expect(aligned(offsets), 'all read-back columns share the same boundary').toBe(true);
      const trackFault = await page.addStyleTag({content: '.cockpit .setting-tracks li[data-setting="search.weights"] .row-face{grid-template-columns:minmax(0,2fr) minmax(0,2fr) minmax(0,1fr) auto}'});
      expect(aligned(await trackOffsets()), 'unequal one-row tracks must break alignment').toBe(false);
      await trackFault.evaluate(el => el.remove());
      expect(aligned(await trackOffsets()), 'exact style removal restores shared alignment').toBe(true);

      // …and the row says WHERE the value came from, honestly: this one was
      // changed away from its declared default, and the guard reads the
      // sentence rather than trusting the class.
      expect(parts.provenance.text).toBe("Custom");
      await expect(page.locator('li.setting-row[data-setting="search.threshold"] .provenance')).toHaveCount(0);
      await expect(page.locator('li.setting-row[data-setting="search.threshold"] .value')).toHaveAttribute('data-provenance', 'at-default');

      await page.locator('li[data-setting="search.threshold"] .row-face').click();
      const edit = await boxOf(page, '[data-setting-sheet] .edit-band');
      const context = await boxOf(page, '[data-setting-sheet] .setting-context');
      expect(disjointHorizontally(edit, context), 'wide context uses the space beside the editor').toBe(true);
      expect(context.right - context.left).toBeGreaterThan(300);
      const result = page.locator('[data-setting-sheet] [role="status"]');
      await expect(result).toHaveAttribute('aria-live', 'polite');
      expect((await result.boundingBox())!.height, 'an empty live region reserves no blank band').toBe(0);
      const paddingFault = await page.addStyleTag({content: '.cockpit .edit-result{padding:12px 0}'});
      expect((await result.boundingBox())!.height, 'whitespace does not protect an empty region from padding').toBeGreaterThan(20);
      await paddingFault.evaluate(el => el.remove());
      expect((await result.boundingBox())!.height).toBe(0);
    });

    test("A MUTANT: without the split, the map and the settings are no longer side by side", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openSettings(page);
      const before = {
        rail: await boxOf(page, "[data-settings-rail]"),
        scroll: await boxOf(page, "[data-settings-scroll]"),
      };
      expect(disjointHorizontally(before.rail, before.scroll)).toBe(true);

      // Break the fix: exactly the pre-split arrangement.
      await page.evaluate(() => document.querySelector(".index")!.classList.remove("split"));
      const after = {
        rail: await boxOf(page, "[data-settings-rail]"),
        scroll: await boxOf(page, "[data-settings-scroll]"),
      };
      expect(
        disjointHorizontally(after.rail, after.scroll),
        "the side-by-side predicate must FAIL once the split is removed, or it proves nothing",
      ).toBe(false);
      // …and what it becomes is the honest narrow arrangement, not a jumble.
      expect(disjointVertically(after.rail, after.scroll)).toBe(true);
    });

    test("C: nothing is clipped and the room never scrolls sideways, at either width", async ({
      page,
    }) => {
      for (const width of [1680, SPLIT_MIN, SPLIT_MIN - 120, 1000, 760, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await openSettings(page);

        const overflow = await page.evaluate(() => {
          const el = document.querySelector(".index") as HTMLElement;
          const scroll = document.querySelector("[data-settings-scroll]") as HTMLElement;
          return {
            room: el.scrollWidth - el.clientWidth,
            content: scroll.scrollWidth - scroll.clientWidth,
            body: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        expect(overflow.room, `the room scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
        expect(overflow.content, `the settings scroll sideways at ${width}px`).toBeLessThanOrEqual(1);
        expect(overflow.body, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);

        // No text is cut off by its own box, and no cell paints over its
        // neighbour: every row fact is measured, not just the two that
        // carry ellipsis — a nowrap mono value overflowing its track was
        // the overlap the room shipped once.
        const clipped = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              ".rail-title, .row-face .label, .row-face .description, .row-face .value, .row-face .provenance, .row-face .timing",
            ),
          ]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => (el.textContent ?? "").trim()),
        );
        expect(clipped, `clipped text at ${width}px: ${clipped.join(" · ")}`).toEqual([]);

        // And nothing that carries a fact is zero-height (a collapsed cell is
        // an invisible one).
        const collapsed = await page.evaluate(() =>
          [...document.querySelectorAll("li.setting-row .value, li.setting-row .provenance")]
            .filter((el) => el.getBoundingClientRect().height < 1)
            .length,
        );
        expect(collapsed, `collapsed fact cells at ${width}px`).toBe(0);

        // At the split width an OPEN sheet spans the whole row. Without the
        // explicit span it auto-placed into the label track and was squeezed
        // to one column's width — the editor for the setting unreadable.
        if (width >= SPLIT_MIN) {
          await page.locator('li.setting-row[data-setting="search.weights"] .row-face').click();
          const sheet = await page.evaluate(() => {
            const el = document.querySelector(".inline-sheet");
            const face = document
              .querySelector('li.setting-row[data-setting="search.weights"] .row-face')
              ?.getBoundingClientRect();
            if (!(el instanceof HTMLElement) || !face) throw new Error("no open sheet or row face");
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, faceLeft: face.left, faceRight: face.right };
          });
          expect(
            Math.abs(sheet.left - sheet.faceLeft),
            `the open sheet does not start at the row's edge at ${width}px`,
          ).toBeLessThanOrEqual(2);
          expect(
            Math.abs(sheet.right - sheet.faceRight),
            `the open sheet is squeezed to one column at ${width}px`,
          ).toBeLessThanOrEqual(2);
          await page
            .locator('li.setting-row[data-setting="search.weights"] .row-face')
            .click(); // close it again for the next width
        }
      }
    });

    test("E: the category rail keeps first glyphs, one title edge, one count column", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openSettings(page);

      const geometry = await page.evaluate(() => {
        const rail = document.querySelector("[data-settings-rail]");
        if (!(rail instanceof HTMLElement)) throw new Error("no settings rail");
        const railBox = rail.getBoundingClientRect();
        const cs = getComputedStyle(rail);
        const titles = [...rail.querySelectorAll(".rail-title")].map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            text: (el.textContent ?? "").trim(),
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            whiteSpace: style.whiteSpace,
            minWidth: style.minWidth,
          };
        });
        const counts = [...rail.querySelectorAll(".rail-count")].map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        });
        return {
          railLeft: railBox.left,
          railRight: railBox.right,
          overflowX: cs.overflowX,
          scrollOverflow: rail.scrollWidth - rail.clientWidth,
          titles,
          counts,
        };
      });

      expect(geometry.titles.length).toBeGreaterThan(0);
      expect(geometry.railLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.scrollOverflow, "the rail clips horizontally").toBeLessThanOrEqual(1);

      const titleLeft = Math.min(...geometry.titles.map((t) => t.left));
      for (const t of geometry.titles) {
        expect(Math.abs(t.left - titleLeft), `${t.text} does not share the title column`).toBeLessThanOrEqual(1);
        expect(t.left, `${t.text} first glyph is left of the rail`).toBeGreaterThanOrEqual(geometry.railLeft);
        expect(t.whiteSpace, t.text).toBe("nowrap");
        expect(t.bottom - t.top, `${t.text} wrapped onto another line`).toBeLessThan(40);
      }
      if (geometry.counts.length > 1) {
        const countRight = Math.max(...geometry.counts.map((c) => c.right));
        for (const [i, c] of geometry.counts.entries()) {
          expect(Math.abs(c.right - countRight), `count ${i} is not in the count column`).toBeLessThanOrEqual(1);
        }
      }
    });

    test("D: below the split width the map moves ABOVE the settings, and keeps every category", async ({
      page,
    }) => {
      await page.setViewportSize({ width: SPLIT_MIN - 100, height: 900 });
      await openSettings(page);
      await expect(page.locator(".index.split")).toHaveCount(0);
      const rail = await boxOf(page, "[data-settings-rail]");
      const scroll = await boxOf(page, "[data-settings-scroll]");
      expect(
        disjointVertically(rail, scroll),
        "below the split width the map takes a row above the settings (the narrow arrangement)",
      ).toBe(true);
      // Every category is still named, and every setting is still there — the
      // narrow answer loses the side-by-side reading, never a row.
      // 3 declared + ghost + this device + the model-providers section (the
      // one non-registry entry, added when the cutover-dropped provider
      // surface was rebuilt — the population changed, so the number is
      // re-stated rather than left bounding yesterday's rail).
      expect(await page.locator(".rail-entry").count()).toBe(6);
      expect(await page.locator("li.setting-row").count()).toBe(SETTINGS.length + LOCAL_ROWS.length);
    });

    test("every control in the room does something observable", async ({ page }) => {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openSettings(page);

      // 1. the category map moves the reading position.
      const scrollTopBefore = await page.locator("[data-settings-scroll]").evaluate((el) => el.scrollTop);
      await page.locator('[data-category-link="memory"]').click();
      await expect(page.locator('[data-category-link="memory"]')).toHaveClass(/focused/);
      const scrollTopAfter = await page.locator("[data-settings-scroll]").evaluate((el) => el.scrollTop);
      expect(scrollTopAfter).not.toBe(scrollTopBefore);

      // 2. a row opens its sheet — the same component, inline.
      await page.locator('li.setting-row[data-setting="tools.parallelCap"] .row-face').click();
      await expect(
        page.locator('[data-setting-sheet][data-setting="tools.parallelCap"]'),
      ).toHaveCount(1);
      // …which states the standing value's provenance and the declared timing.
      await expect(
        page.locator('[data-setting-sheet][data-setting="tools.parallelCap"] .effect-timing'),
      ).toContainText("takes effect on the next run");

      // 3. search narrows, and clear puts everything back.
      const all = await page.locator("li.setting-row").count();
      await page.getByLabel("search settings by behavior words").fill("trial passes");
      await expect(page.locator("li.setting-row")).toHaveCount(1);
      await page.getByText("Clear", { exact: true }).click();
      await expect(page.locator("li.setting-row")).toHaveCount(all);

      // 4. no control is a dead label: every button either acts or says why.
      const inert = await page.evaluate(() =>
        [...document.querySelectorAll(".index button")]
          .filter((b) => {
            const el = b as HTMLButtonElement;
            const named = el.getAttribute("data-verb-id");
            const reasoned = el.disabled && (el.title ?? "").length > 0;
            return named === null || (el.disabled && !reasoned);
          })
          .map((b) => (b.textContent ?? "").trim().slice(0, 40)),
      );
      expect(inert, `inert controls: ${inert.join(" · ")}`).toEqual([]);

      // 5. every control meets the pointer-target floor in BOTH axes.
      const floor = await page.evaluate(() =>
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue("--hit-min"),
        ),
      );
      expect(floor).toBeGreaterThan(0);
      const small = await page.evaluate((min) =>
        [...document.querySelectorAll(".index button")]
          .map((b) => ({ r: b.getBoundingClientRect(), t: (b.textContent ?? "").trim() }))
          .filter(({ r }) => r.width > 0 && (r.width < min - 0.5 || r.height < min - 0.5))
          .map(({ t, r }) => `${t}: ${Math.round(r.width)}×${Math.round(r.height)}`),
        floor,
      );
      expect(small, `under the pointer-target floor: ${small.join(" · ")}`).toEqual([]);
    });

    test("a namespace with no declared category renders, spelled out, and says so", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1680, height: 900 });
      await openSettings(page);
      const ghost = page.locator('[data-category="ghost"]');
      await expect(ghost).toHaveCount(1);
      await expect(ghost.locator(".cat-title")).toHaveText("Ghost");
      await expect(ghost.locator(".cat-purpose.undeclared")).toContainText(
        "has not declared what this area does",
      );
      // …and the gap is named once in the map rather than left to be inferred.
      await expect(page.locator(".rail-note.gap")).toContainText("not declared what they are");
    });
  });
}
});


/** Rasterize CSS colors over their actual ancestor backgrounds, including color-mix and alpha. */
async function savedFeedbackContrast(page: Page): Promise<number> {
  return page.locator('[data-setting-sheet] .commit').evaluate(el => {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,1,1);
    const ancestors: Element[]=[];for(let p: Element|null=el;p;p=p.parentElement)ancestors.push(p);
    for(const p of ancestors.reverse()){ctx.fillStyle=getComputedStyle(p).backgroundColor;ctx.fillRect(0,0,1,1);}
    const background=ctx.getImageData(0,0,1,1).data;
    ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);
    const foreground=ctx.getImageData(0,0,1,1).data;
    const luminance=(rgb:Uint8ClampedArray)=>[0,1,2].reduce((sum,i)=>{
      const v=rgb[i]!/255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i]!;
    },0);
    const a=luminance(foreground),b=luminance(background);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
}

for (const width of [1680, 390]) {
  test(`commit target stays fixed through draft, pending, saved and refusal at ${width}px`, async ({page}) => {
    await mockWarmSignedInApi(page);
    let stored = 4, hold = true, refusals = 0, release: (() => void) | undefined;
    await page.route("**/api/schema/ui/values", route => route.fulfill({json:{...VALUES, customizations: VALUES.customizations.map(c => c.id === "tools.parallelCap" ? {...c,value:stored} : c)}}));
    await page.route("**/api/b/settings.customizations/set", async route => {
      const body = route.request().postDataJSON() as {id:string;value:number};
      if (body.value > 64) { refusals++; await route.fulfill({json:{data:null,meta:{etag:'W/"1"',asOf:1},refusal:{code:"invalid_customization_value",message:"Value exceeds the declared maximum",status:428}}}); return; }
      if (hold) { hold = false; await new Promise<void>(resolve => {release = resolve;}); }
      stored = body.value;
      await route.fulfill({json:{data:{id:body.id,saved:true,value:stored},meta:{etag:'W/"1"',asOf:1}}});
    });
    await page.setViewportSize({width,height:900});
    await openSettings(page);
    await page.getByLabel("search settings by behavior words").fill("Tools running at once");
    await page.locator('li.setting-row[data-setting="tools.parallelCap"] > .row-face').click();
    const field=page.getByRole('textbox',{name:'Tools running at once',exact:true}),commit=page.locator('[data-setting-sheet] .commit');
    await field.fill('8');
    const baseline=await commit.boundingBox();
    expect(baseline).not.toBeNull();
    const stationary=async()=>{const next=await commit.boundingBox();expect(next).not.toBeNull();for(const k of ['x','y','width','height'] as const)expect(Math.abs(next![k]-baseline![k]),k).toBeLessThanOrEqual(1);};
    await commit.click();await expect(commit).toHaveAttribute('aria-busy','true');await expect(commit).toBeFocused();await stationary();
    await field.fill('12');await expect(page.locator('.pending-draft')).toContainText('This draft is not saved yet');
    await expect.poll(()=>typeof release).toBe('function');release!();
    await expect(commit).toHaveAttribute('aria-busy','false');await expect(field).toHaveValue('12');await stationary();
    await field.press('Enter');await expect(commit).toHaveAttribute('data-commit-state','saved');await stationary();
    // Feedback is legible while the no-op Saved action remains keyboard-focusable.
    // This enforces the product's readable confirmation, not a claim that inactive controls lack WCAG exceptions.
    for(const theme of ['dark','light']) {
      await page.evaluate(theme=>{document.documentElement.dataset.cockpitTheme=theme;},theme);
      await field.focus();await page.mouse.move(1,1);
      await expect.poll(()=>savedFeedbackContrast(page),theme+' resting Saved contrast').toBeGreaterThanOrEqual(4.5);
      await commit.hover();await expect.poll(()=>savedFeedbackContrast(page),theme+' hovered Saved contrast').toBeGreaterThanOrEqual(4.5);
      await commit.focus();await expect(commit).toBeFocused();await expect(commit).toHaveJSProperty('disabled',false);await expect(commit).toHaveAttribute('aria-disabled','true');
      await expect.poll(()=>savedFeedbackContrast(page),theme+' focused Saved contrast').toBeGreaterThanOrEqual(4.5);
    }
    const contrastFault=await page.addStyleTag({content:':root[data-cockpit-theme="light"]{--ok:#1c7a4c}.cockpit .verb.primary:hover:enabled{background:color-mix(in srgb,var(--accent) 82%,var(--ink-1))}'});
    await commit.hover();await expect.poll(()=>savedFeedbackContrast(page),'old active-hover cascade must fail the feedback contrast').toBeLessThan(4.5);
    await contrastFault.evaluate(el=>el.remove());await expect.poll(()=>savedFeedbackContrast(page),'removing only the fault restores legible feedback').toBeGreaterThanOrEqual(4.5);
    await page.evaluate(()=>{document.documentElement.dataset.cockpitTheme='dark';});

    await field.fill('99');await commit.focus();await commit.press('Space');
    await expect.poll(()=>refusals).toBe(1);
    await expect(commit).toHaveAttribute('data-commit-state','failed');
    await expect(commit).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid','true');await expect(page.locator('.input-correction')).toHaveText('Enter 64 or less.');await stationary();
    // A real layout fault must move the target. Restore the exact style afterward.
    const style=await page.addStyleTag({content:'.cockpit .edit-band{grid-template-columns:minmax(0,1fr) auto}.cockpit .edit-band .commit{min-width:0;width:auto}'});
    if(width>1000){const mutated=await commit.boundingBox();expect(Math.abs(mutated!.x-baseline!.x)).toBeGreaterThan(1);}
    else {const mutated=await commit.boundingBox();expect(Math.abs(mutated!.width-baseline!.width)).toBeGreaterThan(1);}
    await style.evaluate(el=>el.remove());await stationary();
  });
}
