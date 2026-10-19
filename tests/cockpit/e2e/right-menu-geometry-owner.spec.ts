/**
 * THE RIGHT MENU'S GEOMETRY — no horizontal scrolling, anywhere, measured
 * in the real layout engine at the dock/overlay ladder's exact widths.
 *
 * The user's defect report, verbatim: "we have some side scrolling and
 * incoherent design decision for the right menu." Two mechanisms were
 * measured live before this spec existed:
 *
 *   1. THE INNER OVERFLOW — long unbreakable content (a run id, a
 *      when-eval predicate holding snake_case tokens, a JSON key) inside a
 *      flex child whose `min-width` defaults to `auto` becomes its whole
 *      column's minimum width: the menu BODY grew a horizontal scrollbar
 *      (734px of content in a 551px column at the docked widths; 369px in
 *      a 157px overlay at 375px).
 *   2. THE OVERLAY WIDTH — the overlay column is `--scope-w` = 42vw, which
 *      at phone widths is a 157px inspector no fact row can hold; the arm
 *      rows were designed inside the arm menu's own 340px floor.
 *
 * This spec plants the worst-case rows through the REAL render path (the
 * record's own arm.flags read, served by the route mock) and asserts, at
 * every width of the ladder:
 *
 *   - the PAGE never scrolls sideways (documentElement.scrollWidth ≤ its
 *     clientWidth — a section's own vertical scroll is fine; sideways never
 *     is);
 *   - the menu's BODY holds its worst-case rows with NO horizontal
 *     scrollbar (scrollWidth ≤ clientWidth);
 *   - the dock/overlay split lands where the arithmetic says: the flow's
 *     readability floor (720px) holds beside the docked menu AND the side
 *     rail from the dock point up (1289 = the last overlay width, 1290 = the
 *     first docked one — the value pins, asserted as literals so a
 *     regressed constant cannot re-import itself green);
 *   - the overlay column never falls below its own smallest usable width.
 *
 * The API is route-mocked with real response SHAPES (the arm.flags read is
 * the body's own mount read — the flags arrive through the same adoption
 * the live app performs).
 */
import { expect, test, type Page } from "@playwright/test";

const COCKPIT_URL = "/";

/** A when-eval predicate whose value is one unbreakable snake_case token —
 * the width class a short label never reaches. */
const LONG_PREDICATE =
  "event.errorCode == 'very_long_snake_case_error_code_for_the_geometry_arm_1234567890'";
/** A capture label in the same class. */
const LONG_CAPTURE_LABEL =
  "a-capture-label-with-a-very-long-unbreakable-stretch-name-for-the-geometry-arm";

async function mockWarmSignedInApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.includes("/api/health")) return json({ status: "ok", harnessReady: false });
    if (url.includes("/api/auth/status"))
      return json({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
    if (url.includes("/api/schema/ui/values")) return json({ signals: [], customizations: [] });
    if (url.includes("/api/schema/ui")) return json({ menus: [], panels: [], widgets: [] });
    if (url.includes("/api/projects")) return json([]);
    // THE ARM DOOR'S WRITE ANSWER: arming the long predicate through the
    // custom entry posts to the record's own set action, and the row this
    // spec then measures renders from the flag the answer carries — the
    // same pushLedgerTrigger path a live arm takes. The broker unwraps the
    // { data, meta } envelope at its own door.
    if (url.includes("/api/b/arm.flags/set"))
      return json({
        data: {
          id: "flag-geom-1",
          kind: "trigger",
          predicate: LONG_PREDICATE,
          recordedAt: "2026-09-05T00:00:00Z",
        },
        meta: { etag: "arm-geom-1", asOf: 1_788_000_000_000 },
      });
    // THE WORST-CASE CAPTURE ROW, served by the record's own read: a
    // captured stretch whose label is one long unbreakable token. The
    // body's mount-ask drives this read; the row renders through the same
    // list the live app performs.
    if (url.includes("/api/b/arm.flags"))
      return json({
        data: {
          flags: [
            {
              id: "flag-geom-2",
              kind: "range",
              t0: 1_788_000_000_000,
              t1: 1_788_000_120_000,
              label: LONG_CAPTURE_LABEL,
              recordedAt: "2026-09-05T00:00:00Z",
            },
          ],
          serverSideFiring: false,
        },
        meta: { etag: "arm-geom-read", asOf: 1_788_000_000_000 },
      });
    if(url.includes('/api/b/sweep.spectrum'))return json({data:{header:{categories:['tool'],errorRow:1,errorRowIsOverlay:true,rows:2,bins:0,binMs:0,t0:null,t1:null,events:0,unbinnable:0,attributedOnly:true,clamped:false},packed:''},meta:{etag:'empty-layout-spectrum',asOf:1}});
    return json({});
  });
}

type Geometry = Readonly<{
  vw: number;
  docScrollable: boolean;
  region: Readonly<{ sw: number; cw: number }>;
  menu: Readonly<{ w: number; docked: boolean; sw: number; cw: number }>;
  menuBody: Readonly<{ sw: number; cw: number }>;
  outletW: number;
}>;

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const region = document.querySelector(".flow-region") as HTMLElement | null;
    const outlet = document.querySelector(".flow-outlet") as HTMLElement | null;
    const menu = document.querySelector(".right-menu") as HTMLElement | null;
    const body = menu?.querySelector(".body") as HTMLElement | null;
    return {
      vw: window.innerWidth,
      docScrollable: de.scrollWidth > de.clientWidth,
      region: { sw: region?.scrollWidth ?? 0, cw: region?.clientWidth ?? 0 },
      menu: {
        w: menu ? Math.round(menu.getBoundingClientRect().width) : 0,
        docked: menu?.classList.contains("docked") ?? false,
        sw: menu?.scrollWidth ?? 0,
        cw: menu?.clientWidth ?? 0,
      },
      menuBody: { sw: body?.scrollWidth ?? 0, cw: body?.clientWidth ?? 0 },
      outletW: outlet ? Math.round(outlet.getBoundingClientRect().width) : 0,
    };
  });
}

/** Boot to the revealed shell, open the right menu at the arm group, and
 * plant the worst-case rows through their real doors: the long predicate
 * armed through the custom entry (the record's own set action), the long
 * capture label listed by the body's mount read. */
async function openMenuAtArmGroup(page: Page): Promise<void> {
  await mockWarmSignedInApi(page);
  await page.goto(COCKPIT_URL);
  await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible({ timeout: 10_000 });
  // A boot with no projects opens the switch room (the reader's next move);
  // the ladder is judged on the bare flow region, so close it first.
  for (let i = 0; i < 3; i += 1) {
    if ((await page.$("[data-room-active='true']")) === null) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.click(".side-rail .rail-grip");
  await expect(page.locator(".right-menu")).toBeVisible({ timeout: 5_000 });
  // Land at the arm group through its own cap (the ⌘⇧A landing's mouse path).
  await page.click('[data-group="arm"] .group-cap');
  // THE LONG PREDICATE, armed through the custom entry — the real door the
  // live reader uses, answered by the mocked record.
  await page.fill("[name='arm-custom-expression']", LONG_PREDICATE);
  await page.click(".row:has([name='arm-custom-expression']) [data-action='arm.flags/set']");
  await expect(page.locator('[data-disclosure="arm-sec-cocked"]')).toBeVisible();
  await expect(page.locator('[data-disclosure="arm-sec-captured"]')).toBeVisible();
  await expect(page.locator(".right-menu .body")).toContainText(LONG_PREDICATE);
  await expect(page.locator(".right-menu .body")).toContainText(LONG_CAPTURE_LABEL);
}

test.describe("right-menu-geometry-owner", () => {
  test("the dock/overlay ladder lands where the arithmetic says and the flow floor holds beside the docked column", async ({ page }) => {
    await openMenuAtArmGroup(page);

    // ── BELOW the dock point: OVERLAY. 1289 is the LAST overlay width (the
    // value pin — the old 1280 constant docked here and squeezed the flow
    // to 719px, under the floor this ladder exists to hold).
    await page.setViewportSize({ width: 1289, height: 900 });
    await page.waitForTimeout(200);
    const at1289 = await readGeometry(page);
    expect(at1289.menu.docked, "1289 is below the dock point — the menu overlays").toBe(false);
    expect(at1289.docScrollable, "the page never scrolls sideways").toBe(false);

    // ── AT the dock point: DOCKED, and the flow's floor holds beside the
    // menu AND the rail (720 + 28 + 42vw·1290 = 1290 exact).
    await page.setViewportSize({ width: 1290, height: 900 });
    await page.waitForTimeout(200);
    const at1290 = await readGeometry(page);
    expect(at1290.menu.docked, "1290 is the first docked width").toBe(true);
    expect(
      at1290.outletW,
      "the flow's readability floor holds beside the docked menu and the rail",
    ).toBeGreaterThanOrEqual(720);
    expect(at1290.docScrollable).toBe(false);

    // ── The wider rungs: still docked, floor still holding, and the menu
    // body holds its worst-case rows with no horizontal scrollbar.
    for (const width of [1300, 1307, 1334, 1532]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const g = await readGeometry(page);
      expect(g.menu.docked, `docked at ${width}`).toBe(true);
      expect(g.outletW, `the flow floor holds at ${width}`).toBeGreaterThanOrEqual(720);
      expect(g.docScrollable, `the page never scrolls sideways at ${width}`).toBe(false);
      expect(
        g.menuBody.sw <= g.menuBody.cw,
        `the menu body holds its worst-case rows without a horizontal scrollbar at ${width}`,
      ).toBe(true);
    }
  });

  test("the overlay column keeps its smallest usable width and its worst-case rows never scroll it sideways", async ({ page }) => {
    await openMenuAtArmGroup(page);

    // The worst-case rows must be ON the surface the geometry is judged
    // against — an empty menu certifies nothing about the rows' containment.
    const bodyText = await page.locator(".right-menu .body").textContent();
    expect(bodyText).toContain(LONG_PREDICATE);
    expect(bodyText).toContain(LONG_CAPTURE_LABEL);

    for (const width of [1280, 1150, 1001, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const g = await readGeometry(page);
      expect(g.menu.docked, `overlay at ${width}`).toBe(false);
      expect(g.docScrollable, `the page never scrolls sideways at ${width}`).toBe(false);
      expect(
        g.menu.w,
        `the overlay column keeps its smallest usable width at ${width}`,
      ).toBeGreaterThanOrEqual(340);
      expect(
        g.menuBody.sw <= g.menuBody.cw,
        `the planted worst-case rows never scroll the menu body sideways at ${width}`,
      ).toBe(true);
      // The menu never grows past its own host either — the floor cannot
      // push the column off the region's left edge.
      expect(g.menu.w, `the overlay column never passes its region at ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

// Current header/switch composition. The older dock-ladder population above
// remains independently owned; this task does not certify those legacy selectors.
test('current inspector heading keeps its actions together and graphical switches distinguish checked state', async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.stack??String(error)));

  await mockWarmSignedInApi(page);
  await page.goto(COCKPIT_URL);
  await expect(page.locator('[data-revealed="true"]')).toBeVisible();
  await page.evaluate(async () => {
    const p = '/src/state/projects.ts', c = '/src/state/chats.ts', d = '/src/cockpit/desk/desk-feed.ts';
    const projects = await import(p), chats = await import(c), desk = await import(d);
    projects.setProjects([{id:'header-project',name:'Header project',path:'/fixture/header',createdAt:'t',updatedAt:'t'}]);
    projects.currentProjectId.set('header-project');
    chats.setChats([{id:'header-chat',projectId:'header-project',title:'Header conversation',createdAt:'t',updatedAt:'t',modelId:null,pinned:false}]);
    chats.selectChat('header-chat');
    desk.resetDeskFeed();
    desk.setDeskIo({breaker:async()=>[
      {id:'header-on',label:'First tool',description:'Explains the first capability.',state:'on',calls:0},
      {id:'header-off',label:'Second tool',description:'Explains the second capability.',state:'off',calls:0}],
      act:async()=>{throw Error('This layout fixture does not execute actions');}});
  });
  for (let i=0; i<3 && await page.locator('[data-room-active="true"]').count(); i++) await page.keyboard.press('Escape');
  await page.locator('[data-verb-id="desk.toggle"]').click();
  const tools = page.locator('[data-disclosure="setup-sec-tools"]');
  await expect(tools).toBeVisible();
  if (!await page.locator('.breaker-row').first().isVisible()) await tools.locator('.disc-grip').click();
  await expect(page.locator('.breaker-row')).toHaveCount(2);
  const geometry = () => page.locator('.inspector-heading').evaluate(h => {
    const box = (e: Element) => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
    return {heading:box(h.querySelector('h2')!), actions:[...h.querySelectorAll('button')].map(box),overflow:h.scrollWidth-h.clientWidth};
  });
  const sameLine = (g: Awaited<ReturnType<typeof geometry>>) => g.actions.every(a => a.y < g.heading.bottom && a.bottom > g.heading.y);
  for (const [width,font] of [[1440,16],[390,16],[390,24],[340,24]]) {
    await page.setViewportSize({width:width!,height:900});
    await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    const g=await geometry();
    expect(g.actions).toHaveLength(3);
    expect(g.overflow).toBeLessThanOrEqual(1);
    expect(g.actions.every(a=>a.w>=39.9&&a.h>=39.9)).toBe(true);
    expect(Math.max(...g.actions.map(a=>a.y+a.h/2))-Math.min(...g.actions.map(a=>a.y+a.h/2)), 'differently sized targets share one center line').toBeLessThan(1);
    if(font===16)expect(sameLine(g),`${width}px normal text keeps title and all actions together`).toBe(true);
    else if(!sameLine(g))expect(g.actions[0]!.y, 'enlarged actions wrap as one group below the complete title').toBeGreaterThanOrEqual(g.heading.bottom);
  }
  await page.setViewportSize({width:390,height:900});
  await page.evaluate(()=>document.documentElement.style.fontSize='16px');
  const fault=await page.addStyleTag({content:'.inspector-heading .context-actions { flex-basis:100% !important; }'});
  expect(sameLine(await geometry()),'forced separate action row breaks the owned invariant').toBe(false);
  await fault.evaluate(e=>e.remove());
  expect(sameLine(await geometry()),'exact style removal restores the single row').toBe(true);
  const switches=page.locator('.breaker-row [role="switch"]');
  const readSwitches=()=>switches.evaluateAll(es=>es.map(e=>{const path=e.querySelector('.state-path')!,r=e.getBoundingClientRect(),p=path.getBoundingClientRect(),thumb=getComputedStyle(path,'::after');return{name:e.getAttribute('aria-label'),checked:e.getAttribute('aria-checked'),text:e.textContent?.trim(),width:r.width,height:r.height,center:Math.abs(r.x+r.width/2-p.x-p.width/2),left:thumb.left,right:thumb.right};}));
  const states=await readSwitches();
  expect(states.map(s=>[s.name,s.checked,s.text])).toEqual([['Allow First tool to run','true',''],['Allow Second tool to run','false','']]);
  for(const s of states){expect(s.width).toBeGreaterThanOrEqual(39.9);expect(s.height).toBeGreaterThanOrEqual(39.9);expect(s.width).toBeLessThan(45);expect(s.center).toBeLessThan(.1);}
  expect(states[0]!.left).not.toBe(states[1]!.left);
  const positionFault=await page.addStyleTag({content:'.cockpit [aria-checked="true"] > .state-path::after {left:var(--sp-0) !important;right:auto !important;}'});
  const broken=await readSwitches();expect(broken[0]!.left,'same thumb position removes the non-color state distinction').toBe(broken[1]!.left);
  await positionFault.evaluate(e=>e.remove());
  expect((await readSwitches())[0]!.left).not.toBe(states[1]!.left);
  await expect(page.locator('.inspector-heading')).not.toContainText('settings & activity');
  expect(pageErrors, 'valid layout fixture must not interrupt updates before Close').toEqual([]);
  await page.getByRole('button',{name:'close workspace inspector',exact:true}).click();
  await expect.poll(async()=>({errors:pageErrors,remaining:await page.locator('.right-menu').count()}), 'Close removes the inspector without an interrupted update').toEqual({errors:[],remaining:0});
  await expect(page.locator('[data-verb-id="desk.toggle"]')).toBeFocused();
});
