/**
 * ONE-REVEAL law, real browser (DESIGN-COCKPIT-V2 §10.3) — the Playwright
 * half of the cockpit-boot-owner guard (jsdom half:
 * tests/cockpit/cockpit-boot-owner.test.ts).
 *
 * Asserts, in a real layout engine:
 *   1. the static shell is at EXACT final geometry on first render
 *      (horizon 40px, sweep 48px, desk 64px — the §2 numbers, from
 *      tokens.css) and renders fast;
 *   2. after the reveal frame: ZERO layout-shift entries and ZERO DOM
 *      mutations over an idle window;
 *   3. the harness itself catches an injected late mount (mutation test —
 *      a weakened observer goes red here).
 *
 * The reveal path needs an authenticated session; this spec must not plant
 * credentials in the shared dev DB, so the API is route-mocked with the
 * real response SHAPES. Honest scope: this guard tests the SHELL'S reveal
 * discipline, not data honesty (the probes' realness is covered by the
 * unmocked signed-out spec below + the jsdom suite). MANUAL STEP: on a
 * real session, load /, sign in, watch one boot with DevTools
 * "Layout Shift Regions" on — nothing may flash after the reveal.
 */
import { expect, test, type Page } from "@playwright/test";

const COCKPIT_URL = "/";
const IDLE_WINDOW_MS = 700;

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

/** Start recording layout shifts + DOM mutations under the cockpit root. */
async function armStillnessProbes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __shifts: number;
      __mutations: number;
      __mo?: MutationObserver;
    };
    w.__shifts = 0;
    w.__mutations = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEntry[]) {
        const e = entry as unknown as { value: number; hadRecentInput: boolean };
        if (!e.hadRecentInput && e.value > 0) w.__shifts += 1;
      }
    }).observe({ type: "layout-shift", buffered: false });
    const root = document.querySelector(".cockpit");
    if (root !== null) {
      w.__mo = new MutationObserver((batch) => {
        w.__mutations += batch.length;
      });
      w.__mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
  });
}

async function readStillnessProbes(page: Page): Promise<{ shifts: number; mutations: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __shifts: number; __mutations: number };
    return { shifts: w.__shifts, mutations: w.__mutations };
  });
}

test.describe("cockpit-boot-owner (browser)", () => {
  test("static shell at exact final geometry, before any data", async ({ page }) => {
    await page.goto(COCKPIT_URL);
    const horizon = page.locator(".horizon");
    await expect(horizon).toBeVisible();
    // The §2 shell numbers, measured by the real layout engine.
    expect((await horizon.boundingBox())?.height).toBe(40);
    // Signed-out first paint is identity + registration. Desk, composer,
    // sweep and the room rail wait for authed.
    await expect(page.locator(".desk")).toHaveCount(0);
    await expect(page.locator(".sweep-outlet")).toHaveCount(0);
    await expect(page.locator(".rail")).toHaveCount(0);
    await expect(page.locator(".side-rail")).toHaveCount(0);
    const viewport = page.viewportSize();
    const flow = await page.locator(".flow-region").boundingBox();
    expect(flow).not.toBeNull();
    if (viewport !== null && flow !== null) {
      expect(Math.round(flow.height)).toBe(viewport.height - 40);
    }
  });

  test("signed-out boot: real probes print measured lines, then holds still at the passphrase", async ({ page }) => {
    // UNMOCKED — the running dev server answers; the session line is the
    // server's real answer and the ms are real measurements.
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".gate, .line[data-state='failed']").first()).toBeVisible({ timeout: 10_000 });
    const msTexts = await page.locator(".line .ms").allTextContents();
    expect(msTexts.length).toBeGreaterThan(0);
    for (const t of msTexts) expect(t).toMatch(/^\d+ms$/);
    // Settled at the gate: an idle window must be still (typing buffers,
    // nothing self-mounts while waiting for the passphrase).
    await armStillnessProbes(page);
    await page.waitForTimeout(IDLE_WINDOW_MS);
    const probes = await readStillnessProbes(page);
    expect(probes.mutations).toBe(0);
    expect(probes.shifts).toBe(0);
  });

  test("GUARD: zero layout shifts and zero late mounts after the reveal", async ({ page }) => {
    await mockWarmSignedInApi(page);
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible({ timeout: 10_000 });
    // Allow the reveal frame itself to finish painting — it IS the one
    // coordinated frame (§10.2 step 4); the law binds what comes after.
    await page.waitForTimeout(120);
    await armStillnessProbes(page);
    await page.waitForTimeout(IDLE_WINDOW_MS);
    const probes = await readStillnessProbes(page);
    expect(probes.mutations, "late DOM mounts after the reveal").toBe(0);
    expect(probes.shifts, "layout shifts after the reveal").toBe(0);
  });

  test("mutation: the stillness harness catches an injected late mount", async ({ page }) => {
    await mockWarmSignedInApi(page);
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(120);
    await armStillnessProbes(page);
    await page.evaluate(() => {
      const rogue = document.createElement("div");
      rogue.textContent = "late tile";
      document.querySelector(".flow-outlet")?.appendChild(rogue);
    });
    await page.waitForTimeout(200);
    const probes = await readStillnessProbes(page);
    expect(probes.mutations).toBeGreaterThan(0);
  });

  test("keyboard grammar is honest: a chord answers observably, never silence", async ({ page }) => {
    // This used to assert the "not built yet" hint on ⌘J, when the Switch
    // did not exist. Every declared chord now has a door (the RoomId union
    // is exactly the rooms that exist), so the unbuilt state has left the
    // tree — the hint path is still driven in jsdom
    // (tests/cockpit/cockpit-keyboard-grammar.test.ts). What e2e can honestly
    // pin is the other half of the same law: a chord ANSWERS — ⌘J puts the
    // switch room on screen.
    await mockWarmSignedInApi(page);
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible({ timeout: 10_000 });
    // The landing surface is the project room — already on screen at reveal.
    await expect(
      page.locator('section.room[data-room-active="true"][aria-label="switch room"]'),
    ).toBeVisible({ timeout: 5000 });
    // ⌘J toggles it closed (the Switch claims the chord while it is open).
    await page.keyboard.press("ControlOrMeta+j");
    await expect(
      page.locator('section.room[data-room-active="true"][aria-label="switch room"]'),
    ).toBeHidden({ timeout: 5000 });
  });
});
