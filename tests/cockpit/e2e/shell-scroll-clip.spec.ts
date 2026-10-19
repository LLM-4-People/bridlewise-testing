/**
 * THE SHELL CANNOT BE SCROLLED BY FOCUS — measured in a real layout engine.
 *
 * The defect: the shell wore `overflow: hidden`, which still creates a
 * SCROLLABLE overflow box; the browser scrolls such a box to bring a focused
 * element into view. Focusing anything partially out of the viewport shifted
 * the entire fixed chrome to a stuck offset (~22px observed) with no
 * scrollbar and no gesture to undo it. `overflow: clip` removes the
 * scrollable box entirely, so scroll-by-focus has nothing to move — the
 * strength-ladder fix (the engine refuses), not a scroll-reset listener.
 *
 * The probe asserts the PROPERTY, not the spelling: a shell whose scrollTop
 * can be made non-zero is scrollable, whatever its CSS says. Mutation:
 * revert `.shell` to `overflow: hidden` → the programmatic-scroll assertion
 * goes red (assigning scrollTop sticks on a hidden-overflow box whose
 * content overflows, and the focus probe displaces the chrome).
 */
import { expect, test, type Page } from "@playwright/test";

const COCKPIT_URL = "/";

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

test.describe("shell-scroll-clip", () => {
  test("instrument content and actions fit at compact enlarged sizes and reject the old fixed-height clipping", async ({ page }) => {
    await mockWarmSignedInApi(page);
    await page.route('**/api/schema/ui/values', route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({signals:[{id:'guard.long',value:'a-long-measured-value-with-meaningful-final-characters'},{id:'guard.bool',value:true}],customizations:[]})}));
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible();
    await page.evaluate(async () => {
      const state = await import('/src/state/schema-store.ts');
      const feed = await import('/src/cockpit/rooms/instruments-feed.ts');
      const schema = {version:'bridlewise-ui-schema/v2',menus:[],panels:[],widgets:[],settings:[],actions:[],modules:[],signals:[
        {id:'guard.long',module:'guard',name:'A complete long instrument name remains available',description:'Fixture reading',type:'gauge',unit:''},
        {id:'guard.bool',module:'guard',name:'Feature enabled',description:'Fixture boolean',type:'gauge',unit:''},
        {id:'guard.unread',module:'guard',name:'Unread signal',description:'Fixture unknown',type:'gauge',unit:''}]};
      feed.resetInstrumentsFeed();
      state.setUiSchema(schema);
    });
    await page.locator('[data-chord-target="instruments"]').click();
    await expect(page.locator('.cell')).toHaveCount(3);
    const fits = () => page.locator('.cell').evaluateAll(cells=>cells.every(cell=>{
      const r=cell.getBoundingClientRect();
      return [...cell.querySelectorAll('.name,.value,.asof,button')].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top-1&&b.bottom<=r.bottom+1&&e.scrollWidth<=e.clientWidth+1;});
    }));
    for(const [width,font] of [[1440,16],[390,16],[340,24]]) {
      await page.setViewportSize({width:width!,height:900});
      await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
      await expect.poll(fits).toBe(true);
      await expect(page.locator('.cell').first().locator('.name')).toHaveText('A complete long instrument name remains available');
      await expect(page.locator('.cell').first().locator('.value')).toHaveText('a-long-measured-value-with-meaningful-final-characters');
      for(const button of await page.locator('.cell').first().locator('button').all()) {
        const r=await button.boundingBox();expect(r!.width).toBeGreaterThanOrEqual(39.9);expect(r!.height).toBeGreaterThanOrEqual(39.9);
      }
    }
    const fault=await page.addStyleTag({content:'.cockpit .cell {height:96px !important;min-height:0 !important;overflow:hidden !important;}'});
    expect(await fits(),'fixed-height clipping must be detected even when document bounds fit').toBe(false);
    await fault.evaluate(e=>e.remove());
    expect(await fits(),'removing the exact fault restores every content/control box').toBe(true);
  });

  test("the shell has no scrollable overflow box: programmatic and focus scrolls both leave it at 0", async ({
    page,
  }) => {
    await mockWarmSignedInApi(page);
    await page.goto(COCKPIT_URL);
    await expect(page.locator(".cockpit[data-revealed='true']")).toBeVisible();

    const outcome = await page.evaluate(() => {
      const shell = document.querySelector(".shell") as HTMLElement | null;
      if (shell === null) return { found: false } as const;
      // 1. Force content past the shell's box so a scrollable-overflow shell
      //    WOULD have somewhere to go — the fixture must keep the condition
      //    under test possible.
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      spacer.style.flex = "none";
      shell.appendChild(spacer);
      // 2. A focusable element inside the overflowing region: focusing it is
      //    exactly the gesture that displaced the chrome.
      const probe = document.createElement("button");
      probe.textContent = "focus probe";
      spacer.appendChild(probe);

      const before = shell.scrollTop;
      // The programmatic half: a clipped box refuses the assignment.
      shell.scrollTop = 100;
      const afterAssign = shell.scrollTop;
      // The focus half: the browser's own scroll-into-view against the shell.
      probe.focus();
      const afterFocus = shell.scrollTop;

      spacer.remove();
      return { found: true, before, afterAssign, afterFocus } as const;
    });

    expect(outcome.found).toBe(true);
    if (outcome.found) {
      expect(outcome.before).toBe(0);
      expect(outcome.afterAssign, "assigning scrollTop must not stick — the box is clipped").toBe(0);
      expect(outcome.afterFocus, "focusing an out-of-view element must not displace the shell").toBe(0);
    }
  });
});

test('project rows share measured responsive geometry, contextual actions and exact creation destination', async ({page}) => {
  await mockWarmSignedInApi(page);
  await page.goto('/');
  await expect(page.locator('.cockpit[data-revealed="true"]')).toBeVisible();
  await page.evaluate(async()=>{
    const ps=await import('/src/state/projects.ts'),cs=await import('/src/state/chats.ts'),feed=await import('/src/cockpit/rooms/switch-feed.ts');
    const stamp=new Date().toISOString();
    const projects=Array.from({length:1000},(_,i)=>({id:'row-proof-'+i,name:i===0?'Alpha project with a complete long meaningful name':i===1?'Beta project':'Project '+String(i).padStart(4,'0'),path:'/tmp/row-proof/'+i,createdAt:stamp,updatedAt:new Date(Date.now()-i*1000).toISOString()}));
    const groups=new Map<string, import('/src/state/chats.ts').ChatSummary[]>();
    const chats=projects.flatMap((p,i)=>{const rows=Array.from({length:i===0?5:i===1?2:1},(_,j)=>({id:p.id+'-c'+j,projectId:p.id,title:i===0?'Alpha conversation '+j+' with a complete long meaningful title':'Conversation '+i+'-'+j,createdAt:stamp,updatedAt:new Date(Date.now()-i*1000-j).toISOString(),modelId:null,pinned:false}));groups.set(p.id,rows);return rows;});
    feed.resetSwitchFeed();feed.setSwitchReaders({chats:async id=>groups.get(id)??[],pulse:async()=>({runs:{known:0,withEvents:0}}),spectrum:async()=>({header:{categories:['tool'],errorRow:1,errorRowIsOverlay:true,rows:2,bins:0,binMs:0,t0:null,t1:null,events:0,unbinnable:0,attributedOnly:true,clamped:false},packed:''})});
    ps.setProjects(projects);cs.setChats(chats);feed.capOrder.set(projects.map(p=>p.id));
  });
  if (!await page.locator('[data-room-active="true"][aria-label="switch room"]').count()) await page.locator('[data-chord-target="switch"]').click();
  const room=page.locator('[data-room-active="true"] .switch'),river=room.locator('.river');
  await expect(room.locator('.reel')).not.toHaveCount(0);
  await room.locator('[data-verb-id="switch.expand"]').first().click();
  const fits=()=>room.evaluate(root=>{
    const rows=[...root.querySelectorAll<HTMLElement>('.conversation-row')],groups=[...root.querySelectorAll<HTMLElement>('.group')];
    return rows.length>0&&rows.every(row=>{
      const r=row.getBoundingClientRect(),columns=getComputedStyle(row).gridTemplateColumns.split(' ').length;
      return columns===Number(row.style.getPropertyValue('--cap-columns'))&&[...row.querySelectorAll<HTMLElement>('.reel,.name,.when,button')].every(e=>{const b=e.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top-1&&b.bottom<=r.bottom+1&&e.scrollWidth<=e.clientWidth+1});
    })&&groups.every((group,index)=>index===0||group.getBoundingClientRect().top>=groups[index-1]!.getBoundingClientRect().bottom-1);
  });
  for(const [width,font] of [[1440,16],[390,16],[340,24]]){
    await page.setViewportSize({width:width!,height:900});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    await expect.poll(fits).toBe(true);
    expect(await room.locator('.reel').count(),'1000 projects stay windowed').toBeLessThan(60);
    const sort=await room.getByLabel('Sort projects').boundingBox(),bar=await room.locator('.bar').boundingBox();
    expect(sort!.x+sort!.width).toBeGreaterThan(bar!.x+bar!.width-32);
    expect(await room.locator('.cap [data-verb-id="switch.cap-new-conversation"]').count()).toBe(0);
    expect(await room.locator('.cap [data-verb-id="switch.cap-trash"]').count()).toBe(0);
  }
  const fault=await page.addStyleTag({content:'.cockpit .conversation-row{grid-template-columns:repeat(5,minmax(0,1fr)) !important}'});
  expect(await fits(),'CSS-only columns must not certify the virtual model').toBe(false);
  await fault.evaluate(e=>e.remove());await expect.poll(fits).toBe(true);
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));await expect.poll(fits).toBe(true);
  await room.locator('[data-reel-index="3"]').focus();await page.keyboard.press('ArrowDown');
  await expect(room.locator('[data-reel-index="5"]')).toBeFocused();
  await room.locator('[data-verb-id="switch.create-menu"]').click();
  const create=page.getByRole('menuitem',{name:'New conversation in Beta project'});
  await expect(create).toBeFocused();await expect(create).toHaveAttribute('data-room-chord','switch.new-conversation');
  await page.keyboard.press('End');await expect(page.getByRole('menuitem',{name:'New project',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(room.locator('[data-verb-id="switch.create-menu"]')).toBeFocused();
  await room.locator('[data-reel-index="0"]').focus();await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem',{name:'Open conversation',exact:true})).toBeFocused();
  await river.evaluate(e=>{e.scrollTop=10000});
  await expect(page.getByRole('menu')).toHaveCount(0);await expect(room.locator('.filter')).toBeFocused();
  await river.evaluate(e=>{e.scrollTop=0});await expect(room.locator('[data-reel-index="0"]')).toBeVisible();
  await room.locator('.cap-menu').first().click();await expect(page.getByRole('menu')).toBeVisible();
  await river.evaluate(e=>{e.scrollTop=10000});
  await expect(room.locator('.group[aria-label="Alpha project with a complete long meaningful name"]')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveAccessibleName('Alpha project with a complete long meaningful name');
  await page.keyboard.press('Escape');await expect(room.locator('.filter')).toBeFocused();
  await room.getByLabel('Sort projects').selectOption('name');
  await room.locator('.filter').fill('Alpha conversation 4');await expect(room.locator('.reel')).toHaveCount(1);
  await expect(room.locator('.reel .name')).toHaveText('Alpha conversation 4 with a complete long meaningful title');
  await room.locator('.filter').fill('');await expect.poll(fits).toBe(true);
});
