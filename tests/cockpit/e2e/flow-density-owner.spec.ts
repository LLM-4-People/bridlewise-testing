/**
 * FLOW DENSITY OWNER, real browser (DESIGN-COCKPIT-V2 §2.1, §3.2, §3.8) —
 * the Chromium half of `tests/cockpit/flow-density-owner.test.ts`.
 *
 * The source-level half proves the RULES are written down (the budget
 * tokens, `height: 0` on the controls column, the rail instead of `1fr`).
 * Only a real layout engine can prove the PIXELS, and the pixels are what
 * the finding was about:
 *
 *   - a `.beat.level-ghost` measured 88px to render 23px of text, so the
 *     fisheye's collapsed form cost nearly as much as the full beat it
 *     replaced and an 800px viewport held about three beats;
 *   - a ghost tool beat's `open` verb rendered at x≈1937 while its content
 *     sat at x≈70, so the verb read as belonging to nothing.
 *
 * FIXTURE. The flow dev harness (`/cockpit-dev.html`) in SYNTHETIC mode:
 * clearly-labelled synthetic beats appended straight into the log with
 * ingestion off. Nothing here is a recorded fact and nothing here can leak
 * onto a product surface — synthetic.ts says so on every beat — but the
 * components under measurement are the real Flow, Beat, and render layer,
 * laid out by the real engine at a real viewport.
 */
import { expect, test, type Page } from "@playwright/test";

const HARNESS = "/cockpit-dev.html";

/** §3.2 calls the middle representation a ONE-LINE ghost. This is the pixel
 * ceiling at which that word stops being true; the source-level guard owns
 * the same number as ONE_LINE_BUDGET_PX. */
const ONE_LINE_BUDGET_PX = 32;

/** The batch cap's own ceiling: an engraved micro label plus its rule, drawn
 *  ONCE per batch by the batch's first member. Separate from the one-line
 *  budget because it belongs to the group, not to the beat. */
const CAP_BUDGET_PX = 26;

/** The rail (tokens.css --rail) and the gutter (--gutter-beat). The beat's
 * content column ends at gutter + rail; a control may never BEGIN past it. */
const RAIL_PX = 860;
const GUTTER_PX = 32;

/** WCAG 2.2 SC 2.5.8 / tokens.css --hit-min. */
const HIT_MIN_PX = 24;

/** tokens.css --verbs-max-w — the collapsed options row's own cap. */
const VERBS_MAX_W_PX = 320;

/** tokens.css --gutter-bleed at ≥1440px — the flow's normal page gutter. */
const GUTTER_BLEED_PX = 24;

type Row = {
  level: string;
  kind: string;
  height: number;
  /** x of the beat's own left edge. */
  beatLeft: number;
  /** x of the content column's right edge. */
  contentRight: number;
  /** x of the controls column's left edge — the FIRST control after the
   * content, which is the one whose distance from its subject the finding
   * was about. */
  controlsLeft: number;
  /** x of the options row's right edge. */
  controlsRight: number;
  /** y of the options row's top — it must sit UNDER the content. */
  controlsTop: number;
  /** y of the content's bottom edge. */
  contentBottom: number;
  /** Stable identity, so a comparison across two reads is per-beat. */
  id: string;
  /** True when this beat also draws its batch's cap. */
  capped: boolean;
};

async function loadSynthetic(page: Page, n: 500 | 5000 = 500): Promise<void> {
  await page.goto(HARNESS);
  await page.getByRole("button", { name: `synthetic ${n === 5000 ? "5k" : "500"}` }).click();
  await expect(page.locator(".beat").first()).toBeVisible();
  // FOCUS A BEAT — the fisheye compresses AROUND a focus, and until the
  // reader has one there is nothing to compress around, so the flow now
  // opens with every beat full (fisheye.ts, and the defect it names:
  // "they show ultra collapsed until we click on them"). These tests are
  // about the collapsed levels' cost, so they must first reach the state
  // those levels exist in. One arrow press is the keyboard's way of saying
  // "I am reading this one", and it has no other side effect.
  await page.locator(".flow").focus();
  await page.keyboard.press("ArrowDown");
}

async function readRows(page: Page): Promise<Row[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll(".beat")].map((b) => {
      const r = b.getBoundingClientRect();
      const content = b.querySelector(".ghost-row, .tick-row, .body");
      const controls = b.querySelector(".options");
      const cr = content?.getBoundingClientRect();
      const or = controls?.getBoundingClientRect();
      return {
        level: (b.className.match(/level-(\w+)/) ?? [])[1] ?? "",
        kind: (b.className.match(/kind-([\w-]+)/) ?? [])[1] ?? "",
        height: r.height,
        beatLeft: r.left,
        contentRight: cr?.right ?? r.left,
        controlsLeft: or?.left ?? r.left,
        controlsRight: or?.right ?? r.left,
        controlsTop: or?.top ?? r.top,
        contentBottom: cr?.bottom ?? r.top,
        id: b.getAttribute("data-beat-id") ?? "",
        /** True when this beat also draws its BATCH's cap — one extra
         *  engraved label, drawn once per batch, not once per beat. */
        capped: b.querySelector('[data-field="group-cap"]') !== null,
      };
    });
  });
}

/** Scroll to a fraction of the flow and let the virtualizer settle. */
async function scrollTo(page: Page, fraction: number, settleMs = 250): Promise<void> {
  await page.evaluate((f) => {
    const flow = document.querySelector(".flow") as HTMLElement;
    flow.scrollTop = flow.scrollHeight * f;
  }, fraction);
  await page.waitForTimeout(settleMs);
}

test.describe("flow-density-owner (browser)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
  });

  test("a collapsed beat costs about one line, and a tick costs less", async ({ page }) => {
    await loadSynthetic(page);
    const seen = new Map<string, number[]>();
    // Sweep the whole log rather than five fixed stops. The GHOST band is
    // narrow by design (compression starts two turns from the focus and
    // reaches tick at four), so a handful of samples can miss it entirely
    // and fail for a reason that has nothing to do with the budget.
    for (let i = 0; i <= 40; i += 1) {
      const f = i / 40;
      await scrollTo(page, f, 60);
      for (const row of await readRows(page)) {
        // A BATCH CAP IS NOT PART OF THE ONE-LINE BUDGET, and separating it
        // is the honest bookkeeping rather than a loophole. The budget asks
        // "does a collapsed BEAT cost about one line"; the cap is the
        // BATCH's row, drawn once for the whole run of calls by its first
        // member, and it is exactly what makes a compressed batch readable
        // as a batch. Its own budget is asserted below, so it cannot grow
        // unwatched.
        const key = row.capped ? `${row.level}+cap` : row.level;
        const bucket = seen.get(key) ?? [];
        bucket.push(row.height);
        seen.set(key, bucket);
      }
    }

    const ghosts = seen.get("ghost") ?? [];
    const ticks = seen.get("tick") ?? [];
    const fulls = seen.get("full") ?? [];
    expect(ghosts.length, "the fixture must produce ghost rows").toBeGreaterThan(0);
    expect(ticks.length, "the fixture must produce tick rows").toBeGreaterThan(0);
    expect(fulls.length, "the fixture must produce full rows").toBeGreaterThan(0);

    const maxGhost = Math.max(...ghosts);
    const maxTick = Math.max(...ticks);
    // eslint-disable-next-line no-console -- the measured numbers are the point of the test
    console.log(
      `[density] ghost ${Math.min(...ghosts)}–${maxGhost}px · tick ${Math.min(...ticks)}–${maxTick}px · ` +
        `full ${Math.min(...fulls)}–${Math.max(...fulls)}px`,
    );

    expect(maxGhost, `a one-line ghost may not exceed ${ONE_LINE_BUDGET_PX}px`).toBeLessThanOrEqual(
      ONE_LINE_BUDGET_PX,
    );
    expect(maxTick, "a tick must cost less than a ghost — the ramp must actually ramp").toBeLessThan(
      Math.min(...ghosts),
    );

    // The capped rows, on their own budget: one line PLUS one cap.
    const capped = [...(seen.get("ghost+cap") ?? []), ...(seen.get("tick+cap") ?? [])];
    if (capped.length > 0) {
      expect(
        Math.max(...capped),
        `a compressed batch's FIRST member carries the cap as well as its own line, so its ` +
          `budget is one line plus one cap (${ONE_LINE_BUDGET_PX + CAP_BUDGET_PX}px) — and no more`,
      ).toBeLessThanOrEqual(ONE_LINE_BUDGET_PX + CAP_BUDGET_PX);
    }
    // FULL beats keep their comfortable rhythm: this is about the collapsed
    // levels, not about compressing prose.
    expect(Math.max(...fulls), "full beats must stay comfortably taller than a ghost").toBeGreaterThan(
      ONE_LINE_BUDGET_PX * 2,
    );
  });

  test("the fisheye earns its keep — an 800px viewport holds many more beats", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 800 });
    await loadSynthetic(page);
    await scrollTo(page, 0.5);
    const rows = await readRows(page);
    const flowH = await page.evaluate(() => (document.querySelector(".flow") as HTMLElement).clientHeight);
    // How many of the rendered rows fit, in order, inside the flow's height.
    let used = 0;
    let fit = 0;
    for (const r of rows) {
      if (used + r.height > flowH) break;
      used += r.height;
      fit += 1;
    }
    // eslint-disable-next-line no-console -- the measured number is the point
    console.log(`[density] ${fit} beats fit in a ${flowH}px flow (mean row ${Math.round(used / fit)}px)`);
    expect(fit, "a collapsed flow must hold far more than the ~3 beats the 88px ghost allowed").toBeGreaterThan(6);
  });

  test("the options sit UNDER their own content, for every kind", async ({ page }) => {
    await loadSynthetic(page);
    for (const f of [0.1, 0.5, 0.9]) {
      await scrollTo(page, f);
      for (const r of await readRows(page)) {
        if (r.level === "full") {
          // BELOW the content — the user's own correction ("options below
          // each message/tool call/error/status should be similar"). The old
          // form put them in a right-hand column ~1900px from their subject.
          expect(
            r.controlsTop,
            `${r.kind}: the options row must start at or below the content's bottom edge`,
          ).toBeGreaterThanOrEqual(r.contentBottom - 1);
        } else {
          // A collapsed beat has no second line to give: the row shares the
          // content's line and contributes no height.
          expect(
            r.controlsLeft - r.contentRight,
            `${r.kind}/${r.level}: a collapsed beat's options must be adjacent to its content`,
          ).toBeLessThanOrEqual(HIT_MIN_PX);
        }
      }
    }
  });

  test("the user's own message reaches the flow's right edge", async ({ page }) => {
    await loadSynthetic(page);
    const gap = await page.evaluate(() => {
      const flow = document.querySelector(".flow") as HTMLElement;
      const flowRight = flow.getBoundingClientRect().right;
      const mine = [...document.querySelectorAll(".beat.mine .bubble")];
      if (mine.length === 0) return null;
      return Math.min(...mine.map((b) => flowRight - b.getBoundingClientRect().right));
    });
    expect(gap, "the fixture must render at least one of your own turns").not.toBeNull();
    // eslint-disable-next-line no-console -- the measured number is the point
    console.log(`[align] user bubble stops ${Math.round(gap!)}px from the flow's right edge`);
    // Only the page gutter may stand between the bubble and the edge. It
    // used to be ~187px, because the reserved controls column held width on
    // the right whether or not it held anything.
    expect(
      gap!,
      "a right-aligned message that stops short of the edge reads as misaligned, not as a margin",
    ).toBeLessThanOrEqual(GUTTER_BLEED_PX + 2);
  });

  test("every revealed grip still clears the pointer target floor", async ({ page }) => {
    await loadSynthetic(page);
    await scrollTo(page, 0.5);
    // Focus a beat so its full options row (stepper included) renders.
    await page.locator(".beat").nth(3).click();
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll(".beat .options .beat-grip, .beat .options .verb")].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, cls: el.className };
      }),
    );
    expect(boxes.length).toBeGreaterThan(3);
    for (const b of boxes) {
      expect(b.h, `${b.cls}: hit height`).toBeGreaterThanOrEqual(HIT_MIN_PX);
      if (b.cls.includes("beat-grip")) {
        expect(b.w, `${b.cls}: hit width`).toBeGreaterThanOrEqual(HIT_MIN_PX);
      }
    }
  });

  test("hovering a beat does NOT change its height (the virtualizer never re-measures)", async ({ page }) => {
    await loadSynthetic(page);
    await scrollTo(page, 0.5);
    const before = new Map((await readRows(page)).map((r) => [r.id, r.height]));
    // Hover each rendered row in turn; the options are revealed on hover and
    // must not push the row open — the height index would go stale and every
    // beat below would jump. Playwright scrolls a row into view before
    // hovering it, so the WINDOW changes: compare per beat id, over the beats
    // present in both reads, rather than by position.
    // Move the POINTER over each row's centre rather than calling .hover():
    // Playwright scrolls a located element into view first, which would
    // change the virtualizer's window and defeat the comparison.
    const centres = await page.evaluate(() =>
      [...document.querySelectorAll(".beat")].map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left + 40, y: r.top + r.height / 2 };
      }),
    );
    for (const c of centres) {
      if (c.y < 0 || c.y > 900) continue;
      await page.mouse.move(c.x, c.y);
      await page.waitForTimeout(30);
    }
    const after = await readRows(page);
    const compared = after.filter((r) => before.has(r.id));
    expect(compared.length, "the two reads must overlap on some beats").toBeGreaterThan(0);
    for (const r of compared) {
      expect(r.height, `beat ${r.id} (${r.kind}/${r.level}) changed height under the pointer`).toBe(
        before.get(r.id),
      );
    }
  });

  test("prose reads at the measure; instruments bleed wider (§2.1)", async ({ page }) => {
    await loadSynthetic(page);
    const widths = await page.evaluate(() => {
      const root = document.querySelector(".cockpit") as HTMLElement;
      const probe = (width: string, fontSize: string, fontFamily: string): number => {
        const d = document.createElement("div");
        d.style.cssText = `position:absolute;visibility:hidden;width:${width};font-size:${fontSize};font-family:${fontFamily}`;
        root.appendChild(d);
        const w = d.getBoundingClientRect().width;
        d.remove();
        return w;
      };
      const cs = getComputedStyle(document.documentElement);
      const sans = cs.getPropertyValue("--face-sans");
      return {
        // The measure, resolved in the font prose is actually READ in.
        measureAtProse: probe(cs.getPropertyValue("--measure"), cs.getPropertyValue("--f-prose-size"), sans),
        rail: probe(cs.getPropertyValue("--rail"), cs.getPropertyValue("--f-prose-size"), sans),
        // A rendered paragraph must land on the measure, not on some
        // narrower number a bubble-level cap resolved to.
        paragraph: (() => {
          const p = document.querySelector(".prose p");
          return p === null ? null : parseFloat(getComputedStyle(p).maxWidth);
        })(),
      };
    });
    // eslint-disable-next-line no-console -- the measured numbers are the point
    console.log(`[width] measure ${widths.measureAtProse}px · rail ${widths.rail}px · p max-width ${widths.paragraph}px`);

    // The rail must clear the measure with real room in whatever font the
    // fallback stack lands on — a rail that merely ties would narrow prose
    // instead of letting instruments bleed, which inverts the rule.
    expect(
      widths.rail / widths.measureAtProse,
      `--rail (${widths.rail}px) must bleed meaningfully past the measure (${widths.measureAtProse}px)`,
    ).toBeGreaterThan(1.05);
    expect(widths.paragraph, "a rendered paragraph must be capped at the measure").not.toBeNull();
    expect(Math.abs(widths.paragraph! - widths.measureAtProse)).toBeLessThan(2);
  });
});
