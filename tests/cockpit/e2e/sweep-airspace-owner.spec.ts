/**
 * THE BAND'S RESERVED AIRSPACE, measured in a real layout engine — the guard
 * for the reported defect "the messages from the harness are overlapping with
 * the timeline".
 *
 * THE DEFECT, precisely. The SWEEP's readouts lift ABOVE the band on purpose:
 * a ruler chip drawn on the density would cover the thing it is reading. But
 * the shell gave the band exactly `--sweep-h`, so the lift came out of
 * NOBODY'S budget — it rose into the FLOW, which fills its own box to the
 * last row. Whatever beat happened to be at the bottom of the stream and
 * whatever the band was saying ended up in the same pixels.
 *
 * THE BAND'S UPPER NEIGHBOUR CHANGED, so this guard did too. The FINDINGS ROW
 * (§4.3 — the computer's docked sentence, "At this rate, context fills in ~3
 * more messages — projection from …") used to sit BELOW the band on the
 * desk's top edge; the user asked for it above the timeline, and the shell
 * now declares it between the FLOW and the SWEEP. So the risers no longer
 * lift towards one surface, they lift towards two — the findings row when the
 * computer has something to say, the flow the rest of the time — and a guard
 * that still only knew about the flow would pass while a riser was drawn
 * straight through the finding. Both are measured here, and the row is
 * ADMITTED THROUGH THE APP'S OWN SEAM in every case so the check can never be
 * vacuously green for want of a finding.
 *
 * THE SHAPE OF THE PROOF. Sampling "the beats that happen to be on screen"
 * would only ever cover the beat kinds and fisheye levels this fixture
 * produced. So the guard proves the universal statement instead, in two
 * halves, and then checks the concrete one on top:
 *
 *   A. THE FLOW CLIPS. `.flow` has a clipping overflow, so NO beat — of any
 *      kind, at any fisheye level, at any scroll offset — can paint outside
 *      its box. This is what turns the second half into a statement about
 *      every beat rather than about the ones we made.
 *   B. THE RISERS ARE DISJOINT FROM BOTH NEIGHBOURS. Every readout that lifts
 *      above the band lives inside the reserved strip, and the strip
 *      intersects neither the flow's box nor the findings row's.
 *   C. …and concretely, no rendered beat's box and no finding's box
 *      intersects any riser's.
 *
 * A ∧ B ⇒ C for all beats, at every width and in either theme. C is measured
 * anyway, because a proof that never touches the real thing is a proof of
 * something else.
 *
 * THE ORDER ITSELF is asserted alongside — the findings row's box must be
 * ABOVE the band's, which is the user's actual request and the one thing a
 * disjointness test would happily accept upside down.
 *
 * AND THE TWO FIXES UNDER THE REORDER are re-measured rather than assumed:
 * the canvas stays inside the band's bezel (it used to bleed ~2px into the
 * row below), and the head line clears the band's border-top instead of
 * sitting on it.
 *
 * MUTATION PROOF, in the spec itself: the reservation is removed at runtime
 * (`.sweep-outlet` margin → 0, which is exactly the pre-fix geometry) and the
 * same predicate is asserted to FAIL — naming the FINDINGS ROW, the neighbour
 * the reorder created. A guard that cannot fail is worse than no guard, and a
 * guard that fails for the old reason would be one that never noticed the
 * column had changed underneath it.
 *
 * The API is route-mocked with real response SHAPES so this spec never plants
 * anything in the shared dev DB; the band's events and the flow's beats are
 * pushed through the app's OWN module seams (`ingestLiveSweepEvent`,
 * `appendBeat`) — the same functions the live stream and the ingest use — so
 * what is measured is the real components, really laid out.
 */
import { expect, test, type Page } from "@playwright/test";

const COCKPIT_URL = "/";

type Box = { top: number; bottom: number; left: number; right: number };

async function mockWarmSignedInApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/health")) return json({ status: "ok", harnessReady: false });
    if (url.includes("/api/auth/status"))
      return json({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
    if (url.includes("/api/schema/ui")) return json({ menus: [], panels: [], widgets: [] });
    if (url.includes("/api/projects")) return json([]);
    return json({});
  });
}

/**
 * Fill the band and the flow through the app's own seams. Vite serves the
 * source modules in dev, so these are the real singletons the mounted
 * components are already subscribed to.
 */
async function seed(page: Page): Promise<void> {
  // The empty-project fixture opens the switch room at boot. Close its
  // real mouse door before measuring pointer interactions in the flow.
  const room = page.locator('section.room[data-room-active="true"]');
  await room.locator('[data-verb-id="room.close"]').click();
  await expect(room).toHaveCount(0);
  await page.evaluate(async () => {
    /**
     * IMPORT THE INSTANCE THE APP IS ACTUALLY RUNNING. The dev server stamps
     * `?t=<ms>` on modules it has invalidated, so a clean specifier gets a
     * SECOND copy of the module — a second log, a second sweep buffer — and
     * the seeded data lands somewhere nothing is subscribed to. Resolving
     * through the document's own resource timeline gets the exact URL the
     * mounted components loaded, whatever Vite decided to call it.
     */
    const asLoaded = (path: string): string => {
      const hit = performance
        .getEntriesByType("resource")
        .sort((a, b) => a.startTime - b.startTime)
        .map((e) => e.name)
        .find((n) => n.includes(path));
      return hit ?? path;
    };
    const sweepData = await import(
      /* @vite-ignore */ asLoaded("/src/cockpit/sweep/sweep-data.ts")
    );
    const log = await import(/* @vite-ignore */ asLoaded("/src/cockpit/flow/log.ts"));
    const findings = await import(
      /* @vite-ignore */ asLoaded("/src/cockpit/computer/findings.ts")
    );
    const admission = await import(
      /* @vite-ignore */ asLoaded("/src/cockpit/computer/admission.ts")
    );
    const t0 = Date.now() - 10 * 60_000;

    /**
     * THE FINDINGS ROW — the band's new upper neighbour, put on screen the
     * way the app puts it there: real measured context points through the
     * REAL projection, then the real admission controller. Nothing is
     * hand-written, so the sentence under test carries the derivation the
     * product would have computed (the user's own line: "At this rate,
     * context fills in ~N more messages — projection from your last N runs'
     * measured context sizes").
     */
    const points = Array.from({ length: 10 }, (_, i) => ({
      contextTokens: 40_000 + i * 2_761,
      contextTokenLimit: 200_000,
      at: t0 + i * 20_000,
    }));
    const projection = findings.computeContextProjection(points);
    if (projection === null) throw new Error("the projection fixture measured nothing");
    admission.proposeDeskLine(findings.asFinding(projection, "context-projection"));

    for (let i = 0; i < 40; i += 1) {
      sweepData.ingestLiveSweepEvent({
        eventId: `guard-${i}`,
        eventType: i % 7 === 0 ? "error" : i % 3 === 0 ? "tool" : "message",
        wallTime: new Date(t0 + i * 15_000).toISOString(),
        outcome: i % 7 === 0 ? "failed" : null,
        runId: `guard-run-${Math.floor(i / 12)}`,
        turnId: `guard-turn-${Math.floor(i / 4)}`,
        parentEventId: null,
        description: "airspace guard fixture",
      });
    }

    // Several beat KINDS, so the concrete half of the proof is not a
    // statement about prose alone. The universal half (the flow clips) is
    // what extends it to the kinds not listed here.
    const base = (id: string, kind: string, turnIndex: number) => ({
      id,
      kind,
      parentId: null,
      turnIndex,
      at: t0 + turnIndex * 20_000,
      abnormal: false,
      bleed: kind !== "turn",
      verbs: [],
    });
    for (let turn = 0; turn < 12; turn += 1) {
      log.appendBeat({
        ...base(`g-turn-you-${turn}`, "turn", turn),
        turn: { who: "you", text: `guard fixture message ${turn}`, streaming: false },
      });
      log.appendBeat({
        ...base(`g-turn-model-${turn}`, "turn", turn),
        turn: { who: "model", text: `guard fixture reply ${turn}`, streaming: false },
      });
      log.appendBeat({
        ...base(`g-tool-${turn}`, "tool", turn),
        tool: {
          name: "read_file",
          label: "read file",
          status: "done",
          input: { path: "src/guard.ts" },
          output: "ok",
          startedAt: t0 + turn * 20_000,
          durationMs: 4,
        },
      });
      log.appendBeat({
        ...base(`g-event-${turn}`, "event", turn),
        event: { eventKind: "steering", text: `guard fixture harness note ${turn}` },
      });
      log.appendBeat({
        ...base(`g-act-${turn}`, "act", turn),
        act: {
          block: "run.compose",
          action: "pin",
          title: "Pin",
          consequence: "Always include this in what the model sees for this chat.",
          state: "done",
          input: { itemId: "m1" },
          latencyMs: 12,
        },
      });
    }
  });
  await page.waitForSelector(".flow .item");
  // The findings row must really be on screen before anything is measured
  // against it — a guard that measured an absent neighbour would be green for
  // the wrong reason.
  await page.waitForSelector(FINDINGS_ROW);
}

/** Every readout of the band that lifts above it, plus the strip itself. */
const RISERS = [".sweep .airspace", ".sweep .ruler", ".sweep .line"] as const;

/** The computer's docked sentence — the band's new upper neighbour. */
const FINDINGS_ROW = '[data-testid="desk-line-slot"]';

async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.$$eval(selector, (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }),
  );
}

function intersects(a: Box, b: Box): boolean {
  // Touching edges are not an overlap: the strip sits flush against the flow.
  return a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
}

/** Put a ruler on the band and plant a head, so BOTH readouts are rendered. */
async function raiseEveryRiser(page: Page): Promise<void> {
  const band = await page.locator(".sweep canvas").boundingBox();
  if (band === null) throw new Error("the band did not render");
  await page.mouse.click(band.x + band.width * 0.6, band.y + band.height / 2);
  await page.mouse.move(band.x + band.width * 0.35, band.y + band.height / 2);
  await expect(page.locator(".sweep .ruler")).toBeVisible();
  await expect(page.locator(".sweep .line .viewing")).toBeVisible();
}

/**
 * A beat's PAINTED box. The virtualizer positions every beat absolutely
 * inside the scroller, so a beat scrolled past the bottom still has a
 * rectangle far below the fold — one nobody can see, because the flow clips
 * (assertion A). What is on screen is the intersection with the clip, and
 * that is the only rectangle it is honest to test.
 */
function clipped(item: Box, clip: Box): Box | null {
  const box = {
    top: Math.max(item.top, clip.top),
    bottom: Math.min(item.bottom, clip.bottom),
    left: Math.max(item.left, clip.left),
    right: Math.min(item.right, clip.right),
  };
  return box.bottom > box.top && box.right > box.left ? box : null;
}

/**
 * Every collision a riser is currently in, named.
 *
 * TWO NEIGHBOURS, not one. The flow is above the band whenever the computer
 * has nothing to say; the findings row is above it whenever the computer
 * does. Both are checked, and both are required to be PRESENT — an absent
 * neighbour is an untested one, and the whole point of this pass is that the
 * column changed underneath a guard that only knew about the flow.
 */
async function collisions(page: Page): Promise<string[]> {
  const flow = (await boxes(page, ".flow"))[0];
  if (flow === undefined) throw new Error("the flow did not render");
  const findingsRow = (await boxes(page, FINDINGS_ROW))[0];
  if (findingsRow === undefined) {
    throw new Error("the findings row is not on screen — the guard would be vacuous");
  }
  const items = await boxes(page, ".flow .item");
  const painted = items.map((i) => clipped(i, flow)).filter((b): b is Box => b !== null);
  if (painted.length === 0) throw new Error("no beat is on screen — the guard would be vacuous");
  const found: string[] = [];
  for (const selector of RISERS) {
    for (const riser of await boxes(page, selector)) {
      if (intersects(riser, flow)) found.push(`${selector} × the flow's box`);
      if (intersects(riser, findingsRow)) found.push(`${selector} × the findings row`);
      for (const item of painted) {
        if (intersects(riser, item)) found.push(`${selector} × a beat`);
      }
    }
  }
  return found;
}

/**
 * THE ORDER, as a predicate rather than an inline assertion, so the reorder
 * itself can be mutation-tested: the computer's sentence between the
 * conversation and the timeline, which is what the user asked for and what a
 * pure disjointness check would accept upside down.
 */
async function orderProblems(page: Page): Promise<string[]> {
  const band = (await boxes(page, ".sweep"))[0];
  const row = (await boxes(page, FINDINGS_ROW))[0];
  const flowBox = (await boxes(page, ".flow"))[0];
  if (band === undefined || row === undefined || flowBox === undefined) {
    throw new Error("the band, the findings row and the flow must all be on screen");
  }
  const out: string[] = [];
  if (row.bottom > band.top + 0.5) out.push("the findings row is not above the band");
  if (row.top < flowBox.bottom - 0.5) out.push("the findings row is not below the flow");
  return out;
}

test.describe("sweep-airspace-owner (browser)", () => {
  test.beforeEach(async ({ page }) => {
    await mockWarmSignedInApi(page);
  });

  test("measured empty integrated timeline yields space, retains focus and running state, and reveals its first event", async ({ page }) => {
    await page.goto(COCKPIT_URL);
    await expect(page.locator('.cockpit[data-revealed="true"]')).toBeVisible();
    await page.locator('[data-room-active="true"] [data-verb-id="room.close"]').click();
    await expect(page.locator('.sweep canvas')).toBeVisible();
    await page.locator('.sweep canvas').focus();
    await page.evaluate(async()=>{
      const scope=await import('/src/cockpit/sweep/spectrum-load.ts');
      const data=await import('/src/cockpit/sweep/sweep-data.ts');
      data.resetLiveSweepBuffer();
      scope.spectrumScopeKind.set('chat');
      scope.spectrumWire.set({header:{categories:['tool'],errorRow:1,errorRowIsOverlay:true,rows:2,bins:0,binMs:0,t0:null,t1:null,events:0,unbinnable:0,attributedOnly:true,clamped:false},packed:''});
    });
    await page.keyboard.press('Escape');
    await expect(page.locator('.sweep canvas')).toBeFocused();
    await expect(page.locator('.sweep')).toHaveAttribute('data-quiet-empty','false');
    await page.keyboard.press('Tab');
    await expect(page.locator('.sweep')).toHaveAttribute('data-quiet-empty','true');
    await expect.poll(()=>page.locator('.sweep-outlet').evaluate(e=>e.getBoundingClientRect().height)).toBe(0);
    expect(await page.evaluate(()=>document.activeElement?.closest('[inert]')===null)).toBe(true);
    const fault=await page.addStyleTag({content:'.cockpit .sweep-outlet {height:48px !important;}'});
    expect(await page.locator('.sweep-outlet').evaluate(e=>e.getBoundingClientRect().height),'the retired empty band occupies measurable space').toBeGreaterThan(0);
    await fault.evaluate(e=>e.remove());
    await expect.poll(()=>page.locator('.sweep-outlet').evaluate(e=>e.getBoundingClientRect().height)).toBe(0);
    await page.evaluate(async()=>{
      const projects=await import('/src/state/projects.ts'), chats=await import('/src/state/chats.ts'), run=await import('/src/state/run-state.ts'), timeline=await import('/src/state/timeline-query.ts');
      projects.setProjects([{id:'empty-project',name:'Empty project',path:'/fixture/empty',createdAt:'t',updatedAt:'t'}]); projects.currentProjectId.set('empty-project');
      chats.currentChatId.set('empty-chat');
      timeline.setTimelineScope({kind:'chat',chatId:'empty-chat',label:'Empty chat',runIds:[]});
      run.setRun({runId:'before-first-event',status:'starting',projectId:'empty-project',startedAt:Date.now(),modelLabel:null});
    });
    await expect(page.locator('.sweep')).toHaveAttribute('data-quiet-empty','false');
    await expect(page.locator('.sweep canvas')).toBeVisible();
    await page.evaluate(async()=>{
      const run=await import('/src/state/run-state.ts'),data=await import('/src/cockpit/sweep/sweep-data.ts');
      run.currentRun.set(null);
      data.ingestLiveSweepEvent({eventId:'first-native-event',wallTime:new Date().toISOString(),eventType:'tool',outcome:'success',runId:'before-first-event',description:'First actual event'});
    });
    await expect(page.locator('.sweep')).toHaveAttribute('data-quiet-empty','false');
    await expect(page.locator('.sweep .line')).toContainText('1 event');
    await page.locator('.sweep canvas').focus();
    await expect(page.locator('.sweep canvas')).toBeFocused();
  });

  for (const width of [1500, 900] as const) {
    for (const theme of ["carbon", "logbook"] as const) {
      test(`no riser of the band can reach a beat — ${width}px, ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 820 });
        await page.goto(COCKPIT_URL);
        await page.waitForSelector('.cockpit[data-revealed="true"]');
        if (theme === "logbook") {
          await page.evaluate(() =>
            document.documentElement.setAttribute("data-cockpit-theme", "light"),
          );
        }
        await seed(page);
        await raiseEveryRiser(page);

        // A — the flow clips, so no beat of ANY kind can paint outside it.
        const overflowY = await page.$eval(".flow", (el) => getComputedStyle(el).overflowY);
        expect(["auto", "scroll", "hidden"]).toContain(overflowY);

        // B + C — measured.
        expect(await collisions(page)).toEqual([]);

        // …and the risers really are inside the strip the shell reserved,
        // rather than merely happening to miss its neighbours this once.
        const strip = (await boxes(page, ".sweep .airspace"))[0]!;
        for (const selector of [".sweep .ruler", ".sweep .line"] as const) {
          for (const r of await boxes(page, selector)) {
            expect(r.top, `${selector} rose above the reserved strip`).toBeGreaterThanOrEqual(
              strip.top - 0.5,
            );
            expect(r.bottom, `${selector} sank below the reserved strip`).toBeLessThanOrEqual(
              strip.bottom + 0.5,
            );
          }
        }

        // THE ORDER THE USER ASKED FOR — the computer's sentence sits ABOVE
        // the timeline. Disjointness alone would accept it below.
        expect(await orderProblems(page)).toEqual([]);
        const band = (await boxes(page, ".sweep"))[0]!;
        // …and it really says the projected sentence, with its derivation —
        // moving a finding must not quietly turn it into an unsourced claim.
        const rowText = await page.$eval(FINDINGS_ROW, (el) => el.textContent ?? "");
        expect(rowText).toContain("At this rate, context fills in");
        expect(rowText).toContain("projection from your last 10 runs' measured context sizes");

        // THE TWO FIXES THE REORDER HAD TO SURVIVE — re-measured, not assumed.
        //
        // 1. the canvas stays inside the band's own bezel (it used to bleed
        //    ~2px past the housing, over the band's bottom rule).
        const canvasBox = (await boxes(page, ".sweep canvas"))[0]!;
        expect(canvasBox.top, "the canvas rose out of its bezel").toBeGreaterThanOrEqual(
          band.top - 0.5,
        );
        expect(canvasBox.bottom, "the canvas bled past its bezel").toBeLessThanOrEqual(
          band.bottom + 0.5,
        );
        // 2. the head line clears the band's border-top rather than sitting
        //    ON it — the strip's bottom is the band's BORDER box top, so a
        //    strip that ended at the padding box would fail this by a
        //    hairline.
        expect(strip.bottom, "the airspace sits on the band's border-top").toBeLessThanOrEqual(
          band.top + 0.5,
        );
      });
    }
  }

  test("MUTATION — with the reservation removed, the guard goes red", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 820 });
    await page.goto(COCKPIT_URL);
    await page.waitForSelector('.cockpit[data-revealed="true"]');
    await seed(page);
    await raiseEveryRiser(page);
    expect(await collisions(page)).toEqual([]);

    // THE PRE-FIX GEOMETRY, exactly: the shell reserved nothing above the
    // band, so its upper neighbour grew back into the strip the readouts
    // lift into.
    await page.evaluate(() => {
      const slot = document.querySelector(".sweep-outlet") as HTMLElement | null;
      if (slot === null) throw new Error("no sweep slot");
      slot.style.marginTop = "0px";
    });
    await raiseEveryRiser(page);

    const broken = await collisions(page);
    expect(
      broken.length,
      "removing the reserved airspace must make the overlap detectable — a guard that stays green here is measuring nothing",
    ).toBeGreaterThan(0);
    // THE COLLISION THE REORDER CREATED, named. Without the reservation the
    // head line is drawn straight through the computer's sentence — the
    // neighbour that did not exist when this guard was written. Asserting the
    // flow alone here would let the guard pass for a stale reason.
    expect(broken).toContain(".sweep .line × the findings row");
  });

  /**
   * THE REORDER'S OWN MUTATION. Put the findings row back where it was — a
   * row of the shell's column BELOW the band, which is exactly what
   * Desk.svelte used to render — and the order predicate must go red. Without
   * this, "the row is above the band" would be an assertion nobody had ever
   * seen fail, and this project found three guards today that were narrower
   * than their names.
   */
  test("MUTATION — put the findings row back under the band and the order guard goes red", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 820 });
    await page.goto(COCKPIT_URL);
    await page.waitForSelector('.cockpit[data-revealed="true"]');
    await seed(page);
    expect(await orderProblems(page)).toEqual([]);

    await page.evaluate((sel) => {
      const row = document.querySelector(sel) as HTMLElement | null;
      const slot = document.querySelector(".sweep-outlet") as HTMLElement | null;
      if (row === null || slot === null) throw new Error("no findings row / sweep slot");
      // The pre-fix position: immediately after the band, on the desk's edge.
      slot.after(row);
    }, FINDINGS_ROW);

    expect(
      await orderProblems(page),
      "the order guard must SEE the findings row move back under the band — one that cannot is measuring nothing",
    ).toContain("the findings row is not above the band");
  });

  /**
   * THE SECOND MUTATION, for the second half of the arrangement: with NO
   * finding admitted the band's neighbour is the flow again, and the
   * reservation has to hold for that case too. Proving only the findings-row
   * collision would leave the original defect unguarded.
   */
  test("MUTATION — with no finding admitted, the reservation still stands between the risers and the FLOW", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 820 });
    await page.goto(COCKPIT_URL);
    await page.waitForSelector('.cockpit[data-revealed="true"]');
    await seed(page);

    // Dismiss the finding through the app's own verb, so the row leaves the
    // column exactly as it does for a user who dismissed it.
    await page.evaluate(async () => {
      const asLoaded = (path: string): string => {
        const hit = performance
          .getEntriesByType("resource")
          .sort((a, b) => a.startTime - b.startTime)
          .map((e) => e.name)
          .find((n) => n.includes(path));
        return hit ?? path;
      };
      const admission = await import(
        /* @vite-ignore */ asLoaded("/src/cockpit/computer/admission.ts")
      );
      admission.dismissDeskLine();
    });
    await page.waitForSelector(FINDINGS_ROW, { state: "detached" });
    await raiseEveryRiser(page);

    const flow = (await boxes(page, ".flow"))[0]!;
    const clean: string[] = [];
    for (const selector of RISERS) {
      for (const riser of await boxes(page, selector)) {
        if (intersects(riser, flow)) clean.push(`${selector} × the flow's box`);
      }
    }
    expect(clean).toEqual([]);

    await page.evaluate(() => {
      const slot = document.querySelector(".sweep-outlet") as HTMLElement | null;
      if (slot === null) throw new Error("no sweep slot");
      slot.style.marginTop = "0px";
    });
    await raiseEveryRiser(page);

    const broken: string[] = [];
    for (const riser of await boxes(page, ".sweep .line")) {
      if (intersects(riser, (await boxes(page, ".flow"))[0]!)) {
        broken.push(".sweep .line × the flow's box");
      }
    }
    expect(
      broken,
      "with no finding on screen the flow is the neighbour, and removing the reservation must be detectable there too",
    ).toContain(".sweep .line × the flow's box");
  });
});
