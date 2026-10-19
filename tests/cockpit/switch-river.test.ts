// @vitest-environment node
/**
 * THE SWITCH — recency-river helpers (spec §5.2).
 *
 * The river's laws, each pinned mechanically:
 *   - recency ordering with SESSION-STABLE cap positions (later activity
 *     never reorders caps; only a genuinely new project enters, at top);
 *   - latest 3 per project + "n more" expandable in place — never a
 *     90-row wall (asserted against a 90-project fixture, the real shape
 *     of the workspace under test);
 *   - type-to-filter across project AND conversation names, with every
 *     match visible (a filter may not hide its own hits);
 *   - relative times only from real recorded instants.
 */
import { describe, expect, test, vi } from "vitest";

import {
  REELS_PER_CAP,
  SwitchRiver,
  buildRiver,
  countReels,
  filterRiver,
  flattenVisible,
  partitionRiver,
  projectNameFromFolder,
  relativeTime,
  stableCapOrder,
  toMs,
  capPathHints,
  folderTail,
} from "../../src/cockpit/rooms/switch-data.ts";
import type { ProjectSummary } from "../../src/state/projects.ts";
import type { ChatSummary } from "../../src/state/chats.ts";

const T = Date.parse("2026-07-26T12:00:00Z");
const iso = (msAgo: number): string => new Date(T - msAgo).toISOString();

function project(id: string, name: string, updatedMsAgo: number): ProjectSummary {
  return { id, name, path: `/tmp/${id}`, createdAt: iso(updatedMsAgo + 1000), updatedAt: iso(updatedMsAgo) };
}

function chat(id: string, projectId: string, title: string, updatedMsAgo: number): ChatSummary {
  return {
    id,
    projectId,
    title,
    createdAt: iso(updatedMsAgo + 1000),
    updatedAt: iso(updatedMsAgo),
    modelId: null,
    pinned: false,
  };
}

const loaded = (): "loaded" => "loaded";

function group(chats: readonly ChatSummary[]): Record<string, readonly ChatSummary[]> {
  const out: Record<string, ChatSummary[]> = {};
  for (const c of chats) (out[c.projectId] ??= []).push(c);
  return out;
}

describe("stableCapOrder — recency first, then held for the session", () => {
  const p1 = project("p1", "alpha", 5_000);
  const p2 = project("p2", "beta", 1_000);
  const p3 = project("p3", "gamma", 9_000);

  test("first computation ranks by real recency (chats beat the project row)", () => {
    const chats = group([chat("c1", "p1", "old", 100_000), chat("c3", "p3", "fresh", 10)]);
    // p3's chat is the newest activity anywhere; p2 has no chats so its own
    // updatedAt (1s ago) ranks it over p1 (5s ago).
    expect(stableCapOrder([], [p1, p2, p3], chats)).toEqual(["p3", "p2", "p1"]);
  });

  test("held positions: new activity does NOT reorder existing caps", () => {
    const order = ["p3", "p2", "p1"];
    const chats = group([chat("c9", "p1", "now the newest", 1)]);
    expect(stableCapOrder(order, [p1, p2, p3], chats)).toEqual(order);
  });

  test("a project created during the session enters at the top", () => {
    const p4 = project("p4", "delta", 0);
    expect(stableCapOrder(["p3", "p2", "p1"], [p1, p2, p3, p4], {})).toEqual([
      "p4", "p3", "p2", "p1",
    ]);
  });

  test("a deleted project drops out without moving the others", () => {
    expect(stableCapOrder(["p3", "p2", "p1"], [p1, p3], {})).toEqual(["p3", "p1"]);
  });

  test("FIRST FILL == SETTLED ORDER when the wire serves the activity measure (the CLS invariant)", () => {
    // ONE ORDERING OWNER, pinned once here: /api/projects serves projects in
    // real-activity order with `updatedAt` carrying the activity instant
    // (db-client's listProjects arm pins the server half). This arm pins the
    // client half — the CLS mechanism the re-sort caused: while the chat
    // loads are still in flight the river's first fill ranks by the SERVED
    // updatedAt alone, and when the chats land the settled fill must produce
    // THE SAME order, so nothing on screen moves post-paint.
    //
    // The wire's order: an old-created project made most-recent by real
    // conversation FIRST — the exact user shape that red the CLS gate
    // (measured 0.1614 against the 0.1 budget).
    const wire = [
      { ...project("old", "old project", 10_000), updatedAt: iso(1) }, // chat 1ms ago
      project("mid", "middle project", 30_000), // no chats: row 30s ago
      project("newest", "newest project", 60_000), // no chats: row 60s ago
    ];
    // Chats land after the projects (the ~750ms window the re-sort lived in):
    // old's conversation is 1ms ago — the same instant the wire served.
    const chats = group([chat("c1", "old", "the recent work", 1)]);
    const firstFill = stableCapOrder([], wire, {});
    const settled = stableCapOrder([], wire, chats);
    expect(firstFill).toEqual(["old", "mid", "newest"]);
    expect(settled).toEqual(firstFill);
  });
});

describe("buildRiver — latest 3 + n more, expandable in place", () => {
  const p1 = project("p1", "alpha", 60_000); // older than every chat below
  const chats = group([
    chat("c1", "p1", "one", 4_000),
    chat("c2", "p1", "two", 1_000),
    chat("c3", "p1", "three", 3_000),
    chat("c4", "p1", "four", 2_000),
    chat("c5", "p1", "five", 5_000),
  ]);

  test("reels are recency-desc; a collapsed cap shows the latest 3", () => {
    const [cap] = buildRiver([p1], chats, ["p1"], new Set(), loaded);
    expect(cap!.reels.map((r) => r.chat.id)).toEqual(["c2", "c4", "c3", "c1", "c5"]);
    expect(cap!.visible.map((r) => r.chat.id)).toEqual(["c2", "c4", "c3"]);
    expect(cap!.moreCount).toBe(2);
    expect(cap!.expanded).toBe(false);
  });

  test("expanding shows everything in place; moreCount goes to zero", () => {
    const [cap] = buildRiver([p1], chats, ["p1"], new Set(["p1"]), loaded);
    expect(cap!.visible).toHaveLength(5);
    expect(cap!.moreCount).toBe(0);
    expect(cap!.expanded).toBe(true);
  });

  test("cap activity is the newest chat's real updatedAt", () => {
    const [cap] = buildRiver([p1], chats, ["p1"], new Set(), loaded);
    expect(cap!.lastActivityMs).toBe(toMs(chats["p1"]![1]!.updatedAt)); // c2, 1s ago
  });

  test("chats state passes through per project (absence is a state, not a guess)", () => {
    const [cap] = buildRiver([p1], {}, ["p1"], new Set(), () => "pending");
    expect(cap!.chatsState).toBe("pending");
    expect(cap!.reels).toHaveLength(0);
  });

  test("the ~90-project workspace never renders as a wall: visible reels are capped per project", () => {
    const projects = Array.from({ length: 90 }, (_, i) => project(`p${i}`, `proj ${i}`, i));
    const manyChats = group(
      projects.flatMap((p, i) =>
        Array.from({ length: 7 }, (_, j) => chat(`c${i}-${j}`, p.id, `conv ${j}`, j * 1000)),
      ),
    );
    const order = stableCapOrder([], projects, manyChats);
    const caps = buildRiver(projects, manyChats, order, new Set(), loaded);
    expect(caps).toHaveLength(90);
    expect(countReels(caps)).toBe(630);
    for (const cap of caps) {
      expect(cap.visible.length).toBeLessThanOrEqual(REELS_PER_CAP);
      expect(cap.moreCount).toBe(7 - REELS_PER_CAP);
    }
    expect(flattenVisible(caps)).toHaveLength(90 * REELS_PER_CAP);
  });
});

describe("filterRiver — instant, across both name spaces, hits never hidden", () => {
  const p1 = project("p1", "reader-refactor", 0);
  const p2 = project("p2", "billing", 0);
  const chats = group([
    chat("c1", "p1", "fix the parser", 1_000),
    chat("c2", "p1", "parser follow-up", 2_000),
    chat("c3", "p1", "unrelated", 3_000),
    chat("c4", "p1", "parser again", 4_000),
    chat("c5", "p1", "parser the fourth", 5_000),
    chat("c6", "p2", "invoices", 1_000),
  ]);
  const caps = buildRiver([p1, p2], chats, ["p1", "p2"], new Set(), loaded);

  test("empty query returns the river untouched", () => {
    expect(filterRiver(caps, "")).toBe(caps);
    expect(filterRiver(caps, "   ")).toBe(caps);
  });

  test("conversation-title matches show ALL matches, past the latest-3 cap", () => {
    const hit = filterRiver(caps, "PARSER");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.visible.map((r) => r.chat.id)).toEqual(["c1", "c2", "c4", "c5"]);
    expect(hit[0]!.moreCount).toBe(0); // a filter never hides its own hits
  });

  test("project-name matches keep the cap with normal visibility", () => {
    const hit = filterRiver(caps, "billing");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.project.id).toBe("p2");
    expect(hit[0]!.visible.map((r) => r.chat.id)).toEqual(["c6"]);
  });

  test("no match anywhere drops the cap", () => {
    expect(filterRiver(caps, "zzz-nothing")).toHaveLength(0);
  });
});

describe("partitionRiver — conversation-less projects are compact empty caps", () => {
  const withChats = project("p1", "alpha", 1_000);
  const empty = project("p2", "beta", 2_000);
  const loading = project("p3", "gamma", 3_000);
  const failed = project("p4", "delta", 4_000);
  const chats = group([chat("c1", "p1", "one", 500)]);
  const states: Record<string, "loaded" | "pending" | "failed"> = {
    p1: "loaded", p2: "loaded", p3: "pending", p4: "failed",
  };
  const caps = buildRiver(
    [withChats, empty, loading, failed], chats,
    ["p1", "p2", "p3", "p4"], new Set(), (id) => states[id]!,
  );

  test("only conversation-holding caps stay active; empty caps are listed; loading/failed are COUNTED", () => {
    const part = partitionRiver(caps);
    expect(part.active.map((c) => c.project.id)).toEqual(["p1"]);
    expect(part.empty.map((c) => c.project.id)).toEqual(["p2"]);
    expect(part.emptyCount).toBe(1);
    expect(part.loadingCount).toBe(1);
    expect(part.failedCount).toBe(1);
  });

  test("the live workspace shape (87 projects, 11 conversations) never walls", () => {
    const projects = Array.from({ length: 87 }, (_, i) => project(`p${i}`, `proj ${i}`, i));
    const few = group(
      Array.from({ length: 11 }, (_, j) => chat(`c${j}`, `p${j % 4}`, `conv ${j}`, j * 1000)),
    );
    const all = buildRiver(projects, few, projects.map((p) => p.id), new Set(), loaded);
    const part = partitionRiver(all);
    expect(part.active).toHaveLength(4);
    expect(part.emptyCount).toBe(83);
    expect(countReels(part.active)).toBe(11);
  });

  test("an empty project stays reachable through the filter, with its cap intact", () => {
    const hit = filterRiver(caps, "beta");
    expect(hit.map((c) => c.project.id)).toEqual(["p2"]);
    expect(hit[0]!.reels).toHaveLength(0);
  });
});

describe("relativeTime — plain words from real instants only", () => {
  test("the ladder", () => {
    expect(relativeTime(T - 10_000, T)).toBe("just now");
    expect(relativeTime(T - 5 * 60_000, T)).toBe("5m ago");
    expect(relativeTime(T - 3 * 3_600_000, T)).toBe("3h ago");
    expect(relativeTime(T - 2 * 86_400_000, T)).toBe("2d ago");
    expect(relativeTime(Date.parse("2026-06-12T10:00:00Z"), T)).toMatch(/^12 jun$/);
    expect(relativeTime(Date.parse("2025-06-12T10:00:00Z"), T)).toBe("12 jun 2025");
  });

  test("an unrecorded instant says so; a future instant never fabricates a negative age", () => {
    expect(relativeTime(0, T)).toBe("time not recorded");
    expect(relativeTime(T + 60_000, T)).toBe("just now");
  });
});

describe("responsive project rows, measurements and deliberate sorting", () => {
  const geometry = { columns: 2, reelHeight: 40, reelGap: 8, capGap: 13, headerEstimate: 44, contentWidth: 900 };
  const ps = [project('a', 'Zulu', 0), project('b', 'Alpha', 1), project('c', 'Alpha', 2)];
  const rows = group([chat('a0','a','work 0',0),chat('a1','a','work 1',1),chat('a2','a','work 2',2),
    chat('b0','b','work 3',3),chat('b1','b','work 4',4),chat('c0','c','work 5',5)]);
  const make = () => new SwitchRiver(ps, id => rows[id] ?? [], loaded, geometry, ['a','b','c']);

  test("arrows follow independent columns across unequal project populations", () => {
    const model = make();
    expect(model.moveVertical(0,1)).toBe(1);
    expect(model.moveVertical(1,1)).toBe(2);
    expect(model.moveVertical(2,1), 'next group in the same column').toBe(5);
    expect(model.moveVertical(5,-1)).toBe(2);
    expect(model.moveVertical(3,1)).toBe(4);
    expect(model.moveVertical(4,1)).toBeUndefined();
    expect(model.moveVertical(0,-1)).toBeUndefined();
    expect(model.moveHorizontal(0,1)).toBe(3);
    expect(model.moveHorizontal(2,1), 'closest real tile, not absent third tile').toBe(4);
    expect(model.moveHorizontal(4,-1)).toBe(1);
    model.setGeometry({...geometry,columns:1,contentWidth:320});
    for(let i=0;i<5;i++) expect(model.moveVertical(i,1)).toBe(i+1);
    expect(model.moveVertical(5,-1)).toBe(4);
    expect(model.moveHorizontal(4,1)).toBe(4);
  });

  test("few project groups fill equal conversation tracks with exact row indices, offsets and directional focus", () => {
    const population = [project('a','Alpha',0),project('b','Beta',1)];
    const data = new Map(population.map((p,i)=>[p.id,Array.from({length:i===0?8:5},(_,j)=>chat(p.id+j,p.id,'Work '+j,j))]));
    const model = new SwitchRiver(population,id=>data.get(id)!,loaded,{...geometry,columns:2,reelColumns:3},['a','b']);
    model.toggleExpanded('a');model.toggleExpanded('b');
    const groups=model.window(0,1000);
    expect(groups[0]!.rows.map(row=>({index:row.index,ids:row.reels.map(r=>r.chat.id)}))).toEqual([
      {index:0,ids:['a0','a1','a2']},{index:3,ids:['a3','a4','a5']},{index:6,ids:['a6','a7']},
    ]);
    expect(groups[0]!.gridHeight).toBe(136);
    expect(model.reelAt(3)!.offset).toBe(92);
    expect(model.reelAt(7)!.column).toBe(1);
    expect(model.reelAt(8)!.column).toBe(3);
    expect(model.moveVertical(2,1)).toBe(5);
    expect(model.moveVertical(5,1),'partial final row has a real destination').toBe(7);
    expect(model.moveVertical(7,-1)).toBe(4);
    expect(model.moveHorizontal(2,1),'cross-project neighbor on same visual row').toBe(8);
    expect(model.moveHorizontal(8,-1)).toBe(2);
    expect(model.window(93,133)[0]!.rows[0]!.index).toBe(3);
    model.setQuery('Alpha');
    model.setGeometry({...geometry,columns:1,reelColumns:3});
    expect(model.reelAt(3)!.reel.chat.id).toBe('a3');
    model.setGeometry({...geometry,columns:1,reelColumns:1});
    expect(model.reelAt(3)!.offset).toBe(188);
    expect(model.moveVertical(3,1)).toBe(4);
  });

  test("equal fixed tiles eliminate row measurement and keep wrapped headers scoped to their column", () => {
    const model=make(), cap=model.window(0,1000)[0]!.cap;
    expect(model.reelAt(0)!.offset).toBe(44);
    expect(model.reelAt(1)!.offset).toBe(92);
    expect(model.reelAt(3)!.offset).toBe(44);
    const nextColumnProject=model.reelAt(5)!.offset;
    expect(model.measureHeader(cap,110)).toBe(true);
    expect(model.reelAt(0)!.offset).toBe(110);
    expect(model.reelAt(3)!.offset, 'neighbor column does not inherit height').toBe(44);
    expect(model.reelAt(5)!.offset).toBe(nextColumnProject+66);
    expect(model.measureHeader(cap,110)).toBe(false);
    model.setGeometry({...geometry,contentWidth:850});
    expect(model.reelAt(0)!.offset, 'width changes retire header wrapping').toBe(44);
    model.setQuery('work 2');
    expect(model.measureHeader(cap,900), 'old projection cannot publish').toBe(false);
    expect(model.reelAt(0)!.reel.chat.id).toBe('a2');
    expect('measureRow' in model).toBe(false);
  });

  test("an expanded huge group does not leave neighboring sparse columns empty", () => {
    const population=Array.from({length:61},(_,i)=>project('p'+i,'Project '+i,i));
    const data=new Map(population.map((p,i)=>[p.id,Array.from({length:i===0?10000:1},(_,j)=>chat(p.id+'-'+j,p.id,'Title '+j,j))]));
    const model=new SwitchRiver(population,id=>data.get(id)!,loaded,{...geometry,columns:3},population.map(p=>p.id));
    model.toggleExpanded('p0');
    const visible=model.window(0,700);
    expect(visible.filter(x=>x.column===1).length).toBeGreaterThan(4);
    expect(visible.filter(x=>x.column===2).length).toBeGreaterThan(4);
    expect(visible.flatMap(x=>x.reels).length).toBeLessThan(40);
    const last=model.reelAt(9999)!;
    expect(last.reel.chat.id).toBe('p0-9999');
    expect(model.window(last.offset,last.offset+1).flatMap(x=>x.reels).map(x=>x.chat.id)).toContain('p0-9999');
    expect(model.reelAt(10000)!.offset).toBe(44);
    // Independent reference sums, including every project's exact header,
    // collapsed/expanded population and spacing, challenge tree rotations.
    const heights=[0,0,0];
    for(let i=0;i<population.length;i++){const count=i===0?10000:1;heights[i%3]!+=44+count*48-8+13;}
    expect(model.totalHeight).toBe(Math.max(...heights));
  });

  test("explicit sorting preserves counts, measured geometry, ties and focus identity, then holds order", () => {
    const model = make();
    const counts = model.counts;
    model.measureHeader(model.window(0,1000)[0]!.cap,100);

    model.sortBy('name');
    expect(model.order()).toEqual(['b','c','a']);
    expect(model.counts).toEqual(counts);
    expect(model.totalHeight).toBe(100 + 3*48-8+13 + 44+2*48-8+13);
    expect(model.indexOf('a1','a')).toBe(4);
    expect(model.reelAt(4)!.reel.chat.id).toBe('a1');
    const all = model.window(0,model.totalHeight).flatMap(cap=>cap.rows.flatMap(row=>row.reels.map(reel=>reel.chat.id)));
    expect(all).toEqual(['b0','b1','c0','a0','a1','a2']);
    model.updateProject('a'); expect(model.order()).toEqual(['b','c','a']);
    model.sortBy('recent'); expect(model.order()).toEqual(['a','b','c']);
    model.setQuery('work 5'); expect(model.indexOf('c0','c')).toBe(0);
    model.setQuery(''); expect(model.indexOf('c0','c')).toBe(5);
  });
});

describe("projectNameFromFolder — dir name + the day of the choice", () => {
  test("the last path segment plus the ISO day of the supplied instant", () => {
    expect(projectNameFromFolder("/home/ada/bridlewise-testing", Date.parse("2026-08-25T15:04:00Z"))).toBe(
      "bridlewise-testing 2026-08-25",
    );
  });

  test("a trailing slash does not empty the name", () => {
    expect(projectNameFromFolder("/work/app/", Date.parse("2026-01-02T00:00:00Z"))).toBe("app 2026-01-02");
  });
});

describe("caps with colliding names get a path hint", () => {
  test("opaque identifiers, root paths and a deep collision pair retain minimal disambiguators without rebuilding resolved suffixes", () => {
    const unique = Array.from({length:200}, (_, i) => ({ id: 'u'+i, name: 'same', path: '/independent/root/unique'+i }));
    const tail = Array.from({length:60},(_,i)=>'shared'+i).join('/');
    const input = [...unique,
      {id:'constructor',name:'same',path:'/left/'+tail}, {id:'toString',name:'same',path:'/right/'+tail},
      {id:'__proto__',name:'same',path:'/'}, {id:'root-copy',name:'same',path:'/'},
      {id:'short',name:'same',path:'/'+tail}, {id:'ordinary',name:'distinct',path:'/ordinary'}];
    const slice = vi.spyOn(Array.prototype, 'slice');
    let hints: ReturnType<typeof capPathHints>;
    let suffixCopies: number;
    try { hints = capPathHints(input); suffixCopies = slice.mock.calls.length; }
    finally { slice.mockRestore(); }
    expect(suffixCopies!, 'one final suffix allocation per colliding project, independent of depth').toBe(input.length-1);
    for(let i=0;i<unique.length;i++) expect(hints!['u'+i]).toBe('unique'+i);
    expect(hints!['constructor']).toBe('left/'+tail);
    expect(hints!['toString']).toBe('right/'+tail);
    expect(Object.hasOwn(hints!, '__proto__')).toBe(true);
    expect(hints!['__proto__']).toBe('');
    expect(hints!['short']).toBe(tail);
    expect(hints!['ordinary']).toBeUndefined();
    const baseline = capPathHints([{id:'constructor',name:'unique',path:'/unique'}]);
    expect(baseline['constructor']).toBeUndefined();
    expect(baseline['toString']).toBeUndefined();
  });
  test("the shortest distinguishing trailing path segments, per collider — unique names get none", () => {
    const hints = capPathHints([
      { id: "a", name: "harness", path: "/home/ada/main/harness" },
      { id: "b", name: "harness", path: "/home/ada/experiments/harness" },
      { id: "c", name: "harness", path: "/srv/checkouts/main/harness" },
      { id: "d", name: "other", path: "/home/ada/other" },
    ]);
    // "harness" alone distinguishes nobody; one more segment does for a and
    // b; c's "main/harness" collides with a's, so a and c both need the
    // segment above.
    expect(hints["b"]).toBe("experiments/harness");
    expect(hints["a"]).toContain("main/harness");
    expect(hints["c"]).toContain("main/harness");
    expect(hints["a"]).not.toBe(hints["c"]);
    // A unique name wears no hint — a hint nothing distinguishes is noise.
    expect(hints["d"]).toBeUndefined();
  });

  test("identical full paths fall through to the whole path — the honest dead end", () => {
    const hints = capPathHints([
      { id: "x", name: "twin", path: "/one/twin" },
      { id: "y", name: "twin", path: "/one/twin" },
    ]);
    expect(hints["x"]).toBe("one/twin");
    expect(hints["y"]).toBe("one/twin");
  });
});

describe("folderTail — last two segments of a project path", () => {
  test("two-or-more segments keep the last two", () => {
    expect(folderTail("/home/ada/main/harness")).toBe("main/harness");
    expect(folderTail("/tmp/p2")).toBe("tmp/p2");
  });

  test("a single segment is the whole name; empty stays the path", () => {
    expect(folderTail("harness")).toBe("harness");
    expect(folderTail("/")).toBe("/");
  });
});


describe("incremental completion ordering and window reachability", () => {
  const geometry = { columns: 2, reelHeight: 10, reelGap: 2, capGap: 5, headerEstimate: 20 };

  test.each(["forward", "reverse", "tied", "alternating"] as const)("true %s activity moves stay balanced and agree with independent order", mode => {
    const population = Array.from({ length: 256 }, (_, i) => project(`p${i}`, `project ${i}`, 10000 + i));
    const data = new Map<string, readonly ChatSummary[]>();
    const activity = new Map(population.map(p => [p.id, Date.parse(p.updatedAt)]));
    const states = new Map<string, "pending" | "loaded">();
    const model = new SwitchRiver(population, id => data.get(id) ?? [], id => states.get(id) ?? "pending", geometry);
    // The guard derives height from actual links; trusting the implementation's
    // stored height would let a broken augmentation certify itself.
    type Links = { left: Links | null; right: Links | null; height: number };
    const balanceViolations: { left: number; right: number; stored: number; derived: number }[] = [];
    const checkBalance = (node: Links | null): number => {
      if (node === null) return 0;
      const left = checkBalance(node.left), right = checkBalance(node.right);
      const derived = 1 + Math.max(left, right);
      if (Math.abs(left - right) > 1 || node.height !== derived) balanceViolations.push({ left, right, stored: node.height, derived });
      return derived;
    };
    const reference = (): string[] => population.map((p, index) => ({ id: p.id, index, at: activity.get(p.id)! }))
      .sort((a, b) => b.at - a.at || a.index - b.index).map(p => p.id);
    let work = 0;
    const parse = Date.parse;
    const parseSpy = vi.spyOn(Date, "parse").mockImplementation(value => { work++; return parse(value); });
    try {
      for (let step = 0; step < population.length * 3; step++) {
        const index = mode === "reverse" ? 255 - step % 256
          : mode === "alternating" ? (step % 2 === 0 ? step / 2 : 255 - (step - 1) / 2) & 255 : step % 256;
        const id = `p${index}`;
        const at = mode === "tied" ? T + Math.floor(step / 256) : T + step;
        const incoming = { ...chat(`c${index}`, id, `answer ${step}`, 0), updatedAt: new Date(at).toISOString() };
        data.set(id, [incoming]); activity.set(id, at);
        model.updateProject(id);
        if (step % 32 === 31) {
          expect(model.order()).toEqual(reference());
          const root = (model as unknown as { root: Links | null }).root;
          balanceViolations.length = 0;
          expect(checkBalance(root)).toBeLessThanOrEqual(12);
          expect(balanceViolations).toEqual([]);
        }
      }
    } finally { parseSpy.mockRestore(); }
    expect(work, "project completions must not parse dates for unrelated caps").toBeLessThanOrEqual(256 * 3 * 2);
    expect(model.counts.conversations).toBe(256);
    expect(model.counts.pending).toBe(256);
    expect(model.settle()).toBe(false);
    for (let index = 0; index < 255; index++) { states.set(`p${index}`, "loaded"); model.updateProject(`p${index}`); }
    const final = { ...data.get("p255")![0]!, updatedAt: new Date(T + 10000).toISOString() };
    data.set("p255", [final]); states.set("p255", "loaded");
    model.updateProject("p255");
    expect(model.settle()).toBe(true);
    const held = model.order();
    expect(held[0]).toBe("p255");
    data.set("p0", [{ ...data.get("p0")![0]!, title: "changed after settlement", updatedAt: new Date(T + 20000).toISOString() }]);
    model.updateProject("p0");
    expect(model.order()).toEqual(held);
    expect(model.counts.pending).toBe(0);
    expect(model.counts.conversations).toBe(256);
  });

  test("partition counters, zero-height prefixes, filtering and every reel remain reachable", () => {
    const population = [project("pending", "pending", 0), project("failed", "failed", 1), project("empty", "empty", 2), project("full", "full", 3)];
    const data = new Map<string, readonly ChatSummary[]>([["full", Array.from({ length: 1000 }, (_, i) => chat(`r${i}`, "full", `match ${i}`, i))]]);
    const states = new Map<string, "pending" | "failed" | "loaded">([["failed", "failed"], ["empty", "loaded"], ["full", "loaded"]]);
    const model = new SwitchRiver(population, id => data.get(id) ?? [], id => states.get(id) ?? "pending", geometry);
    expect(model.counts).toMatchObject({ loading: 1, failed: 1, pending: 1, unavailable: 1, conversations: 1000, reels: 3 });
    expect(model.window(0, 40)[0]!.cap.project.id).toBe("full");
    expect(model.measureHeader(model.window(0, 40)[0]!.cap, 40)).toBe(true);
    model.setQuery("match");
    expect(model.reelAt(0)!.offset, "matching queries retain the measured header extent").toBe(40);
    expect(model.setGeometry({ ...geometry, columns: 1, headerEstimate: 30 })).toBe(true);
    expect(model.reelAt(0)!.offset, "responsive columns retire the old wrapped header").toBe(30);
    model.setGeometry(geometry);
    expect(model.counts.reels).toBe(1000);
    const seen = new Set<string>();
    for (let offset = 0; offset < model.totalHeight; offset += 40) {
      const window = model.window(offset, offset + 40);
      const reels = window.flatMap(item => item.reels);
      expect(reels.length).toBeLessThanOrEqual(10);
      for (const reel of reels) seen.add(reel.chat.id);
    }
    expect(seen.size).toBe(1000);
    const last = model.reelAt(999)!;
    expect(last.reel.chat.id).toBe("r999");
    expect(model.window(last.offset, last.offset + 10).flatMap(item => item.reels).map(reel => reel.chat.id)).toContain("r999");
    expect(model.reelAt(1000)).toBeUndefined();
    model.setQuery("pending");
    expect(model.window(0, 100)[0]!.cap.chatsState).toBe("pending");
    model.setQuery("does not exist");
    expect(model.totalHeight).toBe(0);
    expect(model.window(0, 100)).toEqual([]);
    model.setQuery("");
    model.toggleExpanded("full");
    expect(model.counts.reels).toBe(1000);
    const before = model.window(0, 60)[0]!.cap;
    const iterate = vi.spyOn(before.visible, Symbol.iterator);
    try {
      states.set("full", "failed");
      model.updateProject("full");
      expect(model.counts.failed).toBe(1); // Cached reels remain visible; only the empty failed cap is absent.
      expect(model.counts.pending).toBe(1);
      expect(model.counts.unavailable).toBe(2);
      expect(model.window(0, 60)[0]!.cap.chatsState).toBe("failed");
      expect(model.window(0, 60)[0]!.cap.visible).toBe(before.visible);
      states.set("full", "loaded");
      model.updateProject("full");
      expect(iterate, "load-state changes must not rescan the unchanged visible project reels").not.toHaveBeenCalled();
    } finally { iterate.mockRestore(); }
    const measured = model.window(0, 60)[0]!.cap;
    expect(model.measureHeader(measured, 64)).toBe(true);
    expect(model.measureHeader(measured, 64)).toBe(false);
    expect(model.window(0, 60)[0]!.offset).toBe(0);
    data.set("full", [chat("replacement", "full", "replacement", 0)]);
    model.updateProject("full");
    expect(model.reelAt(0)!.offset, "project list changes retain measured header extent").toBe(64);
    expect(model.measureHeader(before, 1000)).toBe(false);
    expect(model.counts.conversations).toBe(1);
    model.replaceProjects(population);
    const replacement = model.window(0, 60)[0]!.cap;
    expect(model.measureHeader(replacement, geometry.headerEstimate)).toBe(false);
    model.setGeometry({ ...geometry, headerEstimate: 30 });
    expect(model.reelAt(0)!.offset, "new geometry retires the previous header measurement").toBe(30);
  });
});
