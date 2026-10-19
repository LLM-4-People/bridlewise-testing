/**
 * WHAT THE FLOW LOOKS LIKE AT REST — measured in a real layout engine.
 *
 * Three reported defects, one fixture, one file, because all three are
 * claims about PIXELS AT REST and only a browser can settle them.
 *
 *   1. "tool call still shows as ultra collapsed, like this, until I click
 *      on them" — a resting tool call must state, without any gesture:
 *      which tool, on what target, whether it succeeded, how long it took,
 *      and something true about what came back. On ONE line ("either
 *      expanded in one line or fully expanded into multiple lines").
 *
 *   2. "enormous empty vertical space" — every beat's RESERVED height (what
 *      the Fenwick index gives it, read off the offsets the virtualizer
 *      positions rows at) must equal its RENDERED height, at every fisheye
 *      level, and must follow a level change.
 *
 *   3. "buttons beside the chat should show only when we have our mouse over
 *      the actual message" — no verb row is visible at rest on ANY beat
 *      kind; hover reveals it; keyboard focus reveals it; and revealing it
 *      shifts nothing.
 *
 * FIXTURE. The flow dev harness (`/cockpit-dev.html`) in SYNTHETIC mode:
 * clearly-labelled synthetic beats appended straight into the log with
 * ingestion off (synthetic.ts says so on every beat). The components under
 * measurement are the real Flow, Beat and ToolBeat, laid out by the real
 * engine at a real viewport.
 *
 * MUTATION NOTE. Each block below names the exact edit that breaks it, so a
 * future reader can check the guard bites rather than trusting that it does.
 */
import { expect, test, type Page } from "@playwright/test";

const HARNESS = "/cockpit-dev.html";

/** The two widths the surface is claimed to work at: wide, and below the
 *  1100px breakpoint where the shell reflows. */
const WIDE = { width: 1600, height: 900 };
const NARROW = { width: 1000, height: 900 };

/** A row is positioned by transform; a sub-pixel disagreement between the
 *  index and layout is rounding, not a defect. Anything above this is a
 *  visible gap. */
const GEOMETRY_TOLERANCE_PX = 1.5;

async function loadSynthetic(page: Page): Promise<void> {
  await page.goto(HARNESS);
  await page.getByRole("button", { name: "synthetic 500" }).click();
  await expect(page.locator(".beat").first()).toBeVisible();
}

/**
 * Give the flow a FOCUS, because with none it compresses nothing.
 *
 * That is deliberate and not this file's business: substituting the tail of
 * the log for a focus turned the three-term DOI into a pure age ramp and
 * compressed the whole conversation before the reader had touched anything
 * (see `flow-unfocused-fisheye.test.ts`). The consequence here is that a test
 * about the COMPRESSED levels has to do what a reader does — pick a beat —
 * or it is testing a surface that is entirely at `full` and quietly proving
 * nothing about the ladder.
 */
async function focusNearTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const flow = document.querySelector(".flow") as HTMLElement;
    flow.scrollTop = 0;
    flow.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(120);
  await page.locator(".beat").first().click();
  await page.waitForTimeout(120);
  await page.mouse.move(2, 2);
}

async function setTheme(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
  await page.waitForTimeout(50);
}

/**
 * Move the reading position and let the virtualizer settle.
 *
 * The scroll event is dispatched SYNCHRONOUSLY rather than waited for: the
 * flow follows the tail until a scroll tells it the reader has moved, and a
 * measurement landing before the browser's own async scroll event would snap
 * the view back to the end — where every beat is one turn from the focus and
 * therefore at `full`. Without this the whole fisheye is unreachable from a
 * test, which is a fact about the harness, not about the surface.
 */
async function scrollTo(page: Page, fraction: number, settleMs = 120): Promise<void> {
  await page.evaluate((f) => {
    const flow = document.querySelector(".flow") as HTMLElement;
    flow.scrollTop = flow.scrollHeight * f;
    flow.dispatchEvent(new Event("scroll"));
  }, fraction);
  await page.waitForTimeout(settleMs);
}

// ── The instrument: reserved vs rendered ───────────────────────────────────

type Slot = {
  /** The beat drawn in this slot, or null when the flow draws nothing. */
  id: string | null;
  level: string;
  kind: string;
  /** What the height index gives this slot: the distance to the next slot's
   *  top, which is exactly `heights.heightOf(i)`. */
  reserved: number;
  /** What the row actually paints. */
  rendered: number;
};

/**
 * Every mounted row, in index order, with its reservation and its render.
 *
 * `reserved` is derived from the OFFSETS rather than read out of the index
 * directly, on purpose: the offsets are what the virtualizer actually places
 * rows at, so a disagreement here is a disagreement the reader can see. The
 * last row has no successor and is dropped — its reservation is unobservable
 * from the outside.
 */
async function readSlots(page: Page): Promise<Slot[]> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".flow .item")].map((el) => {
      const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform);
      const beat = el.querySelector("[data-beat-id]");
      const cls = beat?.className ?? "";
      return {
        id: beat?.getAttribute("data-beat-id") ?? null,
        level: (/level-(\w+)/.exec(cls) ?? [])[1] ?? "none",
        kind: (/kind-([\w-]+)/.exec(cls) ?? [])[1] ?? "none",
        offset: m === null ? 0 : parseFloat(m[1]!),
        rendered: el.getBoundingClientRect().height,
      };
    });
    items.sort((a, b) => a.offset - b.offset);
    const out: {
      id: string | null;
      level: string;
      kind: string;
      reserved: number;
      rendered: number;
    }[] = [];
    for (let i = 0; i + 1 < items.length; i += 1) {
      out.push({
        id: items[i]!.id,
        level: items[i]!.level,
        kind: items[i]!.kind,
        reserved: items[i + 1]!.offset - items[i]!.offset,
        rendered: items[i]!.rendered,
      });
    }
    return out;
  });
}

// ── 2. The height index tells the truth about every level ─────────────────

test.describe("reserved height === rendered height, at every level", () => {
  for (const [name, size] of [
    ["wide", WIDE],
    ["narrow", NARROW],
  ] as const) {
    test(`${name}: no slot reserves a height it does not paint`, async ({ page }) => {
      // MUTATION: in Flow.svelte, stop declaring the `none` shape (or restore
      // the ResizeObserver's `h > 0` gate) and every hidden/undrawn row goes
      // back to reserving DEFAULT_ESTIMATE while painting 0 — which is the
      // 56px-per-row empty space the user photographed.
      await page.setViewportSize(size);
      await loadSynthetic(page);
      await focusNearTop(page);

      const offenders: Slot[] = [];
      const levels = new Set<string>();
      let undrawn = 0;
      // Sweep the log rather than sampling a few stops: the fisheye's bands
      // are narrow and a fixed handful of positions can miss a whole level.
      for (let i = 0; i <= 30; i += 1) {
        await scrollTo(page, i / 30, 60);
        for (const slot of await readSlots(page)) {
          levels.add(slot.level);
          if (slot.id === null) undrawn += 1;
          if (Math.abs(slot.reserved - slot.rendered) > GEOMETRY_TOLERANCE_PX) offenders.push(slot);
        }
      }

      expect([...levels].sort(), "the fixture must exercise every level").toEqual(
        expect.arrayContaining(["full", "ghost", "tick"]),
      );
      expect(
        undrawn,
        "the fixture must include beats the flow draws nothing for — they are the case that broke",
      ).toBeGreaterThan(0);
      expect(
        offenders.slice(0, 12),
        `${offenders.length} slots reserve a height they do not paint:\n` +
          offenders
            .slice(0, 12)
            .map(
              (o) =>
                `  ${o.id ?? "(undrawn)"} [${o.kind}/${o.level}] reserved ${o.reserved.toFixed(1)} ` +
                `rendered ${o.rendered.toFixed(1)}`,
            )
            .join("\n"),
      ).toEqual([]);
    });
  }

  test("the head row PAINTS the height the virtualizer reserves for it", async ({ page }) => {
    /**
     * THE ONE ROW THE HEIGHT INDEX DOES NOT KNOW ABOUT (DESIGN-PERFORMANCE
     * §4). The line above the oldest loaded beat — "older messages not loaded
     * yet" / "the beginning of this conversation" — is not a beat: it has no
     * index position and no measurement. The virtualizer adds its DECLARED
     * height (`HISTORY_HEAD_H`) to every beat offset instead.
     *
     * So a row that paints taller than it declares displaces every beat below
     * it, permanently and by a constant — the same class of defect a stale
     * height reservation causes, arriving from outside the index. jsdom
     * cannot see it (no layout engine); only a browser can.
     *
     * MUTATION: remove `white-space: nowrap` / `overflow: hidden` from
     * `.history-head` and a long sentence wraps the row to two lines.
     */
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    await scrollTo(page, 0, 200);

    const geometry = await page.evaluate(() => {
      const head = document.querySelector<HTMLElement>(".flow .history-head");
      const spacer = document.querySelector<HTMLElement>(".flow .spacer");
      if (head === null || spacer === null) return null;
      return {
        declared: parseFloat(head.style.height),
        painted: head.getBoundingClientRect().height,
        // The spacer must begin exactly where the head row ends: the row is
        // the scroller's first child and contributes its height in normal
        // flow, which is the whole basis of the constant.
        gap: spacer.getBoundingClientRect().top - head.getBoundingClientRect().bottom,
      };
    });
    expect(geometry, "the head row must exist above a non-empty flow").not.toBeNull();
    expect(
      Math.abs(geometry!.painted - geometry!.declared),
      `head row declares ${geometry!.declared}px and paints ${geometry!.painted}px`,
    ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
    expect(Math.abs(geometry!.gap), "nothing may sit between the head row and the spacer")
      .toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  });

  test("a level change is followed by the reservation, not left behind by it", async ({ page }) => {
    // MUTATION: remove the shape comparison from Flow.svelte's `measure`
    // action `update()` and the collapsed row keeps reserving the card's
    // height until an observer callback happens to land.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    await focusNearTop(page);
    // Stay near the focus: that is where FULL beats are, and `full → tick` is
    // the largest shape change the ladder can make — the one where a stale
    // reservation would be most visible.
    let target: Slot | undefined;
    for (const f of [0, 0.02, 0.05, 0.08, 0.12]) {
      await scrollTo(page, f, 150);
      target = (await readSlots(page)).find(
        (s) => s.kind === "tool" && s.level === "full" && s.id !== null,
      );
      if (target !== undefined) break;
    }
    expect(target, "need a full tool beat to collapse").toBeTruthy();

    // Through the beat's OWN collapse grip — the mouse path, which is also
    // the one the reader has. (Playwright hovers before it clicks, which is
    // what reveals the row: that is the behaviour under test in the block
    // below, exercised incidentally here.)
    const beat = page.locator(`[data-beat-id="${target!.id}"]`);
    await beat.hover();
    await beat.locator('[data-chord-target="collapse"]').click();
    await page.waitForTimeout(150);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(120);

    const after = (await readSlots(page)).find((s) => s.id === target!.id);
    expect(after, "the collapsed beat must still be mounted").toBeTruthy();
    expect(after!.level, "the collapse grip must actually have collapsed it").toBe("tick");
    expect(
      Math.abs(after!.reserved - after!.rendered),
      `after collapsing, reserved ${after!.reserved} vs rendered ${after!.rendered}`,
    ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
    expect(
      after!.reserved,
      "the collapsed row must not still be holding the taller shape's height",
    ).toBeLessThan(target!.rendered);
  });
});

// ── 1. A resting tool call is legible without a gesture ───────────────────

test.describe("a tool call states itself at rest", () => {
  test("every resting tool call carries tool, target, outcome, result and duration", async ({
    page,
  }) => {
    // MUTATION: drop `data-field="duration"` from the compressed row (or
    // restore the tick level for tool beats) and the fields below go missing.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);

    let checked = 0;
    const missing: string[] = [];
    for (let i = 0; i <= 30; i += 1) {
      await scrollTo(page, i / 30, 60);
      const rows = await page.evaluate(() => {
        return [...document.querySelectorAll(".beat.kind-tool")].map((b) => ({
          id: b.getAttribute("data-beat-id") ?? "",
          level: (/level-(\w+)/.exec(b.className) ?? [])[1] ?? "",
          fields: [...b.querySelectorAll("[data-field]")].map((e) =>
            e.getAttribute("data-field"),
          ),
          text: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
        }));
      });
      for (const row of rows) {
        checked += 1;
        for (const field of ["tool-name", "status", "input-hint", "output-hint", "duration"]) {
          // `duration` and the two hints are conditional on the RECORD; the
          // synthetic fixture always carries a duration and a path, so a
          // missing field here is the renderer's doing, not the data's.
          if (!row.fields.includes(field)) {
            missing.push(`${row.id} [${row.level}] has no ${field} — "${row.text.slice(0, 90)}"`);
          }
        }
      }
    }
    expect(checked, "the fixture must contain resting tool calls").toBeGreaterThan(10);
    expect(missing.slice(0, 10), missing.slice(0, 10).join("\n")).toEqual([]);
  });

  test("…on ONE line: a resting tool call never becomes a paragraph", async ({ page }) => {
    // The user's rule is two states and no third: one line, or fully
    // expanded. MUTATION: put the hints back on their own row under the head
    // and the resting card's height doubles here.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    const heights = await page.evaluate(() => {
      const out: number[] = [];
      for (const b of document.querySelectorAll(".beat.kind-tool.level-full")) {
        const head = b.querySelector(".head");
        const cells = b.querySelector(".cells");
        if (head !== null && cells === null) out.push(head.getBoundingClientRect().height);
      }
      return out;
    });
    expect(heights.length, "need resting full-level tool cards").toBeGreaterThan(0);
    // One line of --f-data-size plus its descenders. Two lines would be ~2×.
    for (const h of heights) expect(h).toBeLessThan(34);
  });

  test("a batch shows its cap AND its members' rows — never the cap alone", async ({ page }) => {
    // MUTATION: restore `foldedIntoGroup` in Beat.svelte and every member
    // after the first stops drawing, so the count below collapses to 1.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    await focusNearTop(page);
    let best = { members: 0, caps: 0 };
    for (let i = 0; i <= 30; i += 1) {
      await scrollTo(page, i / 30, 60);
      const seen = await page.evaluate(() => {
        const groups = new Map<string, number>();
        let caps = 0;
        for (const b of document.querySelectorAll(".beat.in-group")) {
          const level = (/level-(\w+)/.exec(b.className) ?? [])[1] ?? "";
          if (level === "full") continue; // the compressed case is the claim
          groups.set(level, (groups.get(level) ?? 0) + 1);
          if (b.querySelector('[data-field="group-cap"]') !== null) caps += 1;
        }
        return { members: Math.max(0, ...groups.values()), caps };
      });
      if (seen.members > best.members) best = seen;
    }
    expect(
      best.members,
      "a compressed batch must draw a row per member, not one row for the batch",
    ).toBeGreaterThan(1);
    expect(best.caps, "…and still draw the aggregate cap").toBeGreaterThan(0);
  });
});

// ── 3. The verb row is quiet until wanted ─────────────────────────────────

test.describe("the verb row is quiet until wanted", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [name, size] of [
      ["wide", WIDE],
      ["narrow", NARROW],
    ] as const) {
      test(`${theme}/${name}: nothing shows a verb row at rest`, async ({ page }) => {
        // MUTATION: re-add `.kind-tool .options { opacity: 1 }` to
        // Beat.svelte and this fails on the first tool beat it meets.
        await page.setViewportSize(size);
        await loadSynthetic(page);
        await setTheme(page, theme);
        // Park the pointer where no beat is, so nothing is hovered.
        await page.mouse.move(2, 2);
        await page.waitForTimeout(80);

        const visible: string[] = [];
        const kinds = new Set<string>();
        for (let i = 0; i <= 20; i += 1) {
          await scrollTo(page, i / 20, 60);
          await page.mouse.move(2, 2);
          const rows = await page.evaluate(() =>
            [...document.querySelectorAll(".beat")].map((b) => ({
              kind: (/kind-([\w-]+)/.exec(b.className) ?? [])[1] ?? "",
              id: b.getAttribute("data-beat-id") ?? "",
              focused: b.classList.contains("focused"),
              opacity: Number(
                getComputedStyle(b.querySelector(".options") as Element).opacity || "0",
              ),
            })),
          );
          for (const r of rows) {
            kinds.add(r.kind);
            // A FOCUSED beat is the flow's roving-listbox target: revealing
            // there IS the keyboard's half of the reveal, asserted below.
            if (!r.focused && r.opacity > 0.01) visible.push(`${r.kind} ${r.id} @${r.opacity}`);
          }
        }
        expect(kinds.size, "the fixture must cover several beat kinds").toBeGreaterThan(2);
        expect(visible.slice(0, 10), visible.slice(0, 10).join("\n")).toEqual([]);
      });
    }
  }

  test("hover reveals exactly the hovered beat's row, and shifts nothing", async ({ page }) => {
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    await scrollTo(page, 0.5, 200);

    const before = await readSlots(page);
    const target = before.find((s) => s.id !== null && s.level === "full");
    expect(target, "need a beat to hover").toBeTruthy();

    const box = await page.locator(`[data-beat-id="${target!.id}"]`).boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForTimeout(200);

    const shown = await page.evaluate(
      (id) =>
        [...document.querySelectorAll(".beat")]
          .filter((b) => Number(getComputedStyle(b.querySelector(".options")!).opacity) > 0.5)
          .map((b) => b.getAttribute("data-beat-id"))
          .filter((x) => x !== null && x !== id),
      target!.id,
    );
    const focused = await page.evaluate(() =>
      [...document.querySelectorAll(".beat.focused")].map((b) => b.getAttribute("data-beat-id")),
    );
    // Only the hovered beat, plus whatever the roving focus is already on.
    expect(shown.filter((id) => !focused.includes(id))).toEqual([]);

    // NO LAYOUT SHIFT (§3.8): the row is laid out at all times and only its
    // opacity moves, so the virtualizer must not have re-measured anything.
    const after = await readSlots(page);
    const shifted = after.filter((s, i) => {
      const b = before[i];
      return b !== undefined && b.id === s.id && Math.abs(b.rendered - s.rendered) > 0.5;
    });
    expect(
      shifted.map((s) => s.id),
      "revealing the row must not change any beat's height",
    ).toEqual([]);
  });

  test("keyboard focus reveals the row (a11y), without a pointer", async ({ page }) => {
    // MUTATION: drop `.beat.focused .options` and `:focus-within` from
    // Beat.svelte and the row becomes pointer-only, which is the a11y half
    // of the same defect.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    await page.mouse.move(2, 2);
    await scrollTo(page, 0.6, 200);

    await page.locator(".flow").focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(120);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(80);

    const focusedOpacity = await page.evaluate(() => {
      const b = document.querySelector(".beat.focused");
      if (b === null) return null;
      return Number(getComputedStyle(b.querySelector(".options") as Element).opacity);
    });
    expect(focusedOpacity, "the keyboard must have a focused beat").not.toBeNull();
    expect(
      focusedOpacity,
      "the beat the keyboard is on must show its verbs — a pointer-only reveal is not reachable",
    ).toBeGreaterThan(0.9);
  });

  test("no truncated refusal is printed on any row", async ({ page }) => {
    // THE REPORTED STRING, verbatim from the screenshot:
    //   "run again– no block declares a re-run action for a single …"
    // MUTATION: put unwired verbs back in `optionVerbs` and this finds them
    // again on every tool beat.
    await page.setViewportSize(WIDE);
    await loadSynthetic(page);
    const found: string[] = [];
    for (let i = 0; i <= 20; i += 1) {
      await scrollTo(page, i / 20, 60);
      found.push(
        ...(await page.evaluate(() =>
          [...document.querySelectorAll(".beat .options .verb-unwired")].map(
            (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim(),
          ),
        )),
      );
    }
    expect(
      [...new Set(found)],
      "a refusal belongs where the reader reaches for the verb — the SCOPE sheet and the open " +
        "card's inline depth still render every disabled verb with its whole reason",
    ).toEqual([]);
  });
});
