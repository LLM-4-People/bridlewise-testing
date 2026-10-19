// @vitest-environment node
/**
 * FLOW PAST-VIEW OWNER (DESIGN-COCKPIT-V2 §6.2, §6.3).
 *
 * A planted head means three things, and the flow was honouring none of
 * them:
 *
 *   A. THE FLOW RENDERS ITS STATE AT THAT INSTANT. Measured before this
 *      guard existed: with a head planted, the flow's rendered text was
 *      byte-identical to live (1619 chars, 12 beats, scrollTop 0) —
 *      nothing under `flow/` read the head at all. A banner that says
 *      "viewing 10:14:21" over a picture of now is the same class of
 *      fabrication as inventing a number.
 *
 *   B. A PAST VIEW IS READ-ONLY — and the guarantee cannot live only in
 *      `broker.action()`. Two verbs (`chat.rollback`, `auto-checks.run`)
 *      called `client.ts` directly, so they never passed the Broker's write
 *      door: a rewind fired from a view of 10:14:21 would have run against
 *      the LIVE conversation. A third (`run.start`) starts a real run the
 *      same way. This suite fires every writing verb with a head planted
 *      and requires each to refuse.
 *
 *   C. READS CARRY THE AMBIENT `until` OR REFUSE. Two cockpit joins reached
 *      around the Broker with a raw `fetchJson(blockRequestPath(…))` to
 *      keep the envelope's `asOf`; during a past view they answered from
 *      live data with no banner correction and wrote no provenance.
 *
 * Every scanner here is pure and mutation-tested at the bottom.
 */
import { afterAll, beforeEach, afterEach, describe, expect, test } from "vitest";

import {
  asOfHead,
  plantHead,
  returnToLive,
  PAST_VIEW_READ_ONLY_CODE,
  PAST_VIEW_ACT_REASON,
} from "../../src/data/asof.ts";
import { ClientError } from "../../src/data/errors.ts";
import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import {
  appendBeat,
  beatsAtOrBefore,
  beatCount,
  clearLog,
} from "../../src/cockpit/flow/log.ts";
import type { Beat, BeatVerb } from "../../src/cockpit/flow/types.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";
import { bodySays, functionBody } from "../helpers/function-scope.ts";
import {
  CLIENT_WRITES,
  clientImports,
  writesWithoutAssertion,
} from "../helpers/client-writes.ts";

/**
 * SHARED-MODULE HYGIENE. `vitest.config.ts` sets `isolate: false`, so every
 * test file in a worker shares one module registry — and this suite writes
 * to two pieces of global state that other suites read: the planted head
 * (`src/data/asof.ts`) and the flow log. A head left standing would make
 * every later `broker.read()` in the worker throw `past_view_unsupported`,
 * which is a spectacular way to fail somebody else's test for a reason that
 * has nothing to do with them. Cleaned up per-test AND once at the end.
 */
afterAll(() => {
  returnToLive();
  clearLog();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

function beatOf(kind: Beat["kind"], extra: Partial<Beat> = {}): Beat {
  const base: Beat = {
    id: `b-${kind}-1`,
    kind,
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: true,
    verbs: [],
  };
  switch (kind) {
    case "turn":
      return { ...base, turn: { who: "you", text: "t", streaming: false }, ...extra };
    case "tool":
      return {
        ...base,
        tool: { name: "read_file", label: "read file", status: "done", input: {}, output: "", startedAt: 1 },
        ...extra,
      };
    case "effect":
      return { ...base, effect: { path: "x.ts", producedBy: "t" }, ...extra };
    case "check-delta":
      return {
        ...base,
        checkDelta: { checkId: "c", checkName: "lint", from: "passed", to: "failed" },
        ...extra,
      };
    case "event":
      return {
        ...base,
        event: { eventKind: "rewind", text: "2 messages taken back", eventId: "evt-1" },
        ...extra,
      };
    default:
      return { ...base, ...extra };
  }
}

const ctx: VerbContext = {
  chatId: "c1",
  projectId: "p1",
  toggleExpand: () => {},
  prefillComposer: () => {},
  hint: null,
  userPromptBefore: () => "the causing prompt",
};

/** Every verb the factory produces, across every beat kind. */
function allVerbs(): BeatVerb[] {
  const make = makeVerbsFor(ctx);
  const out: BeatVerb[] = [];
  for (const kind of ["turn", "tool", "effect", "check-delta", "event"] as const) {
    out.push(...make(beatOf(kind)));
    if (kind === "turn") {
      out.push(...make(beatOf("turn", { turn: { who: "model", text: "m", streaming: false } })));
    }
  }
  return out;
}

// ── Scanners ───────────────────────────────────────────────────────────────

/**
 * Sources that read a BLOCK by reaching around the Broker's read door.
 * `fetchJson` itself is fine — it is the transport, and REST routes
 * (`/health`, `/git/diff-patch`) have no block to route through. What is
 * never fine is composing it with `blockRequestPath`: that is a block read
 * with the `until` and the refusal stripped off.
 */
export function blockDoorBypasses(sources: readonly { file: string; src: string }[]): string[] {
  const out: string[] = [];
  for (const { file, src } of sources) {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
    // The type argument may itself contain `>` (`fetchJson<BlockResponse<X>>`),
    // so the generic is matched permissively up to the opening paren.
    if (/fetchJson\s*(<[^(]*>)?\s*\(\s*blockRequestPath\s*\(/.test(code.replace(/\s+/g, " "))) {
      out.push(`${file}: fetchJson(blockRequestPath(…)) bypasses the Broker's read door`);
    }
  }
  return out;
}

/**
 * The write set and the two scanners now have ONE owner
 * (`tests/helpers/client-writes.ts`), shared with the rooms/desk/settings
 * guard. They were declared here first, scoped to `flow/` + `computer/`; a
 * second copy for the second tree would have been two opinions about what a
 * write IS, and the day they disagreed the tree with the shorter list would go
 * quietly green over a real bypass.
 */

// ── A. The flow renders its state at the planted instant ───────────────────

describe("flow-past-view-owner — A. the flow honours the planted head", () => {
  beforeEach(() => {
    clearLog();
    returnToLive();
  });
  afterEach(() => {
    clearLog();
    returnToLive();
  });

  function seed(times: readonly number[]): void {
    times.forEach((at, i) => {
      appendBeat({ ...beatOf("turn"), id: `b-${i}`, at });
    });
  }

  test("the beat prefix at an instant is the beats whose facts had happened", () => {
    seed([100, 200, 300, 400]);
    expect(beatCount()).toBe(4);
    expect(beatsAtOrBefore(0)).toBe(0);
    expect(beatsAtOrBefore(100)).toBe(1); // inclusive — the fact AT the instant is in
    expect(beatsAtOrBefore(250)).toBe(2);
    expect(beatsAtOrBefore(400)).toBe(4);
    expect(beatsAtOrBefore(999)).toBe(4);
  });

  test("a planted head genuinely CHANGES what the flow would render", () => {
    // The measured defect: with a head planted the flow rendered the same
    // beats it rendered live. The bound must actually bind.
    seed([100, 200, 300, 400]);
    const live = beatCount();
    plantHead(250);
    const past = beatsAtOrBefore(asOfHead.get()!);
    expect(past, "a head in the middle of the log must hide the later beats").toBeLessThan(live);
    expect(past).toBe(2);
  });

  test("the prefix stops at the first later fact — never a sieve", () => {
    // A doctored transcript (holes punched in the middle) would be worse
    // than showing nothing: it would present a record that never existed.
    seed([100, 500, 200]);
    expect(beatsAtOrBefore(300), "scanning stops at the first beat past the instant").toBe(1);
  });

  test("the FLOW reads the head — not just the banner", () => {
    const flow = read("src/cockpit/flow/Flow.svelte");
    expect(flow, "Flow.svelte must consume the global asOf").toContain("asOfHead");
    expect(flow, "the window must be bounded by the head, not by beatCount()").toMatch(
      /beatsAtOrBefore\(/,
    );
    // §6.2: plant the head → scroll to the containing beat.
    expect(flow).toMatch(/revealIndex\(/);
  });

  test("the scroll height is bounded too (offsetOf, not totalHeight)", () => {
    // Leaving the spacer at the FULL height would keep a scrollbar for beats
    // the view says have not happened — the banner contradicted by the
    // scrollbar.
    const flow = read("src/cockpit/flow/Flow.svelte");
    expect(flow).toMatch(/total:\s*heights\.offsetOf\(n\)/);
  });
});

// ── B. A past view is read-only, at every door ─────────────────────────────

describe("flow-past-view-owner — B. no flow verb can write during a past view", () => {
  afterEach(() => returnToLive());

  test("the writing verbs are DECLARED, so a guard can see them", () => {
    returnToLive();
    const writing = allVerbs().filter((v) => v.writes === true).map((v) => v.id);
    // Exactly the verbs that change the world. A new writing verb that
    // forgets the flag fails the runtime test below; a non-writing verb that
    // gains the flag fails here.
    expect([...new Set(writing)].sort()).toEqual([
      "auto-checks.run",
      // `edit & resend`. It ARMS a rewind that the next send performs, so it
      // is a write even though nothing leaves the browser when it is pressed
      // — a past view that let it arm would have aimed a withdrawal at the
      // live conversation from a view of some earlier instant.
      "composer.prefill",
      "custody.state/keep",
      "custody.state/undo",
      // ONE id for `retry` AND `rewind here`: they are the same operation
      // through the same door (src/cockpit/flow/rewind.ts). Two ids here
      // would mean two paths, which is the defect this replaced.
      "run.compose/rewind",
      // The rewind's mirror (UIE-039): it re-serves withdrawn turns, which
      // changes the transcript the live conversation is, from any view.
      "run.compose/restore",
    ].sort());
  });

  test("EVERY declared writing verb REFUSES while a head is planted", async () => {
    returnToLive();
    const writing = allVerbs().filter((v) => v.writes === true && v.wired);
    expect(writing.length, "the fixture must produce wired writing verbs").toBeGreaterThan(3);
    plantHead(1_700_000_000_000);
    for (const verb of writing) {
      let code: string | null = null;
      try {
        await verb.run!();
      } catch (err) {
        code = err instanceof ClientError ? err.code : `unexpected:${String(err)}`;
      }
      expect(code, `verb "${verb.id}" must refuse during a past view`).toBe(
        PAST_VIEW_READ_ONLY_CODE,
      );
    }
  });

  test("the same verbs do NOT refuse when live (the gate is the head, not the verb)", async () => {
    returnToLive();
    // `run.compose/rewind` reaches the network when live, so this asserts the
    // refusal is specifically absent — any other failure is fine here.
    const verb = allVerbs().find((v) => v.id === "run.compose/rewind" && v.wired);
    expect(verb).toBeDefined();
    let code: string | null = null;
    try {
      await verb!.run!();
    } catch (err) {
      code = err instanceof ClientError ? err.code : "network-or-other";
    }
    expect(code).not.toBe(PAST_VIEW_READ_ONLY_CODE);
  });

  test("the write set is REAL — every name is exported by client.ts", () => {
    // A renamed export would otherwise empty the set and make the scan pass
    // by checking nothing.
    const client = read("src/client.ts");
    for (const name of CLIENT_WRITES) {
      expect(client, `client.ts must export ${name}`).toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`),
      );
    }
  });

  test("no FLOW or COMPUTER module imports a client-side write without the assertion", () => {
    // Scoped to the surfaces this agent owns. The same rule applies to the
    // rooms/desk/settings feeds, which import their own client writes — that
    // is a live finding for their owners, not a silent pass here.
    const offenders: string[] = [];
    for (const dir of ["src/cockpit/flow", "src/cockpit/computer"]) {
      for (const f of walk(dir, { exts: [".ts", ".svelte"] })) {
        offenders.push(...writesWithoutAssertion(relpath(f), read(f)));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the CONTROL says why before the click, from the one owned sentence", () => {
    const verbSrc = read("src/cockpit/flow/Verb.svelte");
    expect(verbSrc, "Verb.svelte must render a writing verb disabled during a past view").toContain(
      "isPastView",
    );
    expect(verbSrc).toContain("PAST_VIEW_ACT_REASON");
    // …and the sentence has ONE owner, so twelve controls cannot invent
    // twelve stories about the same refusal.
    expect(PAST_VIEW_ACT_REASON.length).toBeGreaterThan(10);
    expect(verbSrc).not.toMatch(/"this is a past view/);
  });
});

// ── C. Reads go through the door ───────────────────────────────────────────

describe("flow-past-view-owner — C. block reads carry the ambient until", () => {
  test("no cockpit source reads a block around the Broker's door", () => {
    const sources = walk("src/cockpit", { exts: [".ts", ".svelte"] }).map((f) => ({
      file: relpath(f),
      src: read(f),
    }));
    const bypasses = blockDoorBypasses(sources);
    expect(
      bypasses,
      `a raw fetchJson(blockRequestPath(…)) strips the ambient \`until\` AND the honest ` +
        `refusal — during a past view it serves live data with no banner correction:\n${bypasses.join("\n")}`,
    ).toEqual([]);
  });

  test("the two joins that bypassed it now use read() and the recorded asOf", () => {
    for (const f of ["src/cockpit/flow/effect-findings.ts", "src/cockpit/computer/ask.ts"]) {
      const src = read(f);
      expect(src, `${f} must read through the Broker`).toMatch(/\bread<|\bread\(/);
      expect(src, `${f} must take asOf from the recorded provenance, not the wall clock`).toContain(
        "serverAsOfFor",
      );
      expect(src, `${f} must not stamp Date.now() as a measurement time`).not.toMatch(
        /asOf:\s*Date\.now\(\)/,
      );
    }
  });
});

// ── D. The sweep's beat handoff has a listener ─────────────────────────────

describe("flow-past-view-owner — D. the sweep's deepest zoom hands off (§6.3)", () => {
  test("the flow LISTENS for the sweep's focusBeat event", () => {
    const flow = read("src/cockpit/flow/Flow.svelte");
    expect(flow, "the bubbling focusBeat CustomEvent must have a listener").toContain(
      'addEventListener("focusBeat"',
    );
    expect(flow, "and it must be removed with the effect").toContain(
      'removeEventListener("focusBeat"',
    );
  });

  test("an unresolvable event id is REPORTED, never silently approximated", () => {
    // Beat ids and ledger event ids are different id spaces. Jumping to the
    // nearest plausible beat would be indistinguishable, to the reader, from
    // the jump working.
    const flow = read("src/cockpit/flow/Flow.svelte");
    // THE HANDLER'S OWN BODY. The window form extracted 200 bytes after the
    // registration and then asserted the explanation existed ANYWHERE in the
    // file — two claims that never met. Scoping the second to the handler is
    // what makes it a claim about this code path.
    expect(flow, "the flow must still register a focusBeat listener").toContain('addEventListener("focusBeat"');
    expect(
      // The words the handler EMITS, not words near it: `bodySays` reads the
      // string literals the parser found inside this body, so a comment
      // claiming the handler explains itself does not satisfy it.
      bodySays(functionBody(flow, "onFocusBeat"), "beats do not carry"),
      "an unresolvable event id must be reported by the handler that could not resolve it",
    ).toBe(true);
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the past-view scanners catch what they claim to", () => {
  test("a raw block read is flagged", () => {
    expect(
      blockDoorBypasses([
        { file: "a.ts", src: `const r = await fetchJson<X>(blockRequestPath("code.impact", p));` },
      ]),
    ).toHaveLength(1);
  });

  test("a multi-line raw block read is still flagged", () => {
    expect(
      blockDoorBypasses([
        { file: "a.ts", src: `await fetchJson<BlockResponse<X>>(\n  blockRequestPath("code.impact", p),\n);` },
      ]),
    ).toHaveLength(1);
  });

  test("a REST fetchJson is NOT flagged (there is no block to route through)", () => {
    expect(
      blockDoorBypasses([{ file: "a.ts", src: `await fetchJson<{patch:string}>("/git/diff-patch?x=1");` }]),
    ).toEqual([]);
  });

  test("a bypass mentioned only in a COMMENT is not flagged", () => {
    expect(
      blockDoorBypasses([
        { file: "a.ts", src: `/* it used to be fetchJson(blockRequestPath(…)) */\nawait read("x");` },
      ]),
    ).toEqual([]);
  });

  // The example write is TAKEN FROM the inventory rather than spelled here.
  // These self-checks used `rollbackChat`, and when that dead door was
  // removed from `client.ts` the checks did not start failing for a reason
  // anyone could read — they started passing vacuously, because the synthetic
  // source named a write the scanner no longer recognises. A name copied out
  // of a list is a name that rots.
  const SOME_WRITE = CLIENT_WRITES[0]!;

  test("a client write with no assertion is flagged", () => {
    const src = `import { ${SOME_WRITE} } from "../../client.ts";\nawait ${SOME_WRITE}(c, m);`;
    expect(writesWithoutAssertion("v.ts", src)).toHaveLength(1);
  });

  test("a client write WITH the assertion passes", () => {
    const src =
      `import { ${SOME_WRITE} } from "../../client.ts";\nassertLiveForWrite();\nawait ${SOME_WRITE}(c, m);`;
    expect(writesWithoutAssertion("v.ts", src)).toEqual([]);
  });

  test("the inventory the self-checks borrow from is not empty", () => {
    // Without this, an emptied inventory would make every check above pass
    // by describing nothing at all.
    expect(CLIENT_WRITES.length).toBeGreaterThan(10);
  });

  test("a module that imports only READS from client.ts is not flagged", () => {
    const src = `import { listProjects, loadChatHistory } from "../../client.ts";`;
    // The specifiers ARE seen — the module is simply not asked for an
    // assertion, because none of them changes anything.
    expect(clientImports(src)).toEqual(["listProjects", "loadChatHistory"]);
    expect(writesWithoutAssertion("v.ts", src)).toEqual([]);
  });

  test("a module that names a write only in prose is not flagged", () => {
    expect(writesWithoutAssertion("v.ts", `// ${SOME_WRITE}( is described here\nconst x = 1;`)).toEqual([]);
  });

  test("the import scan reads renamed and type-only specifiers correctly", () => {
    expect(
      clientImports(`import { startRun as go, type StreamController } from "../../client.ts";`).sort(),
    ).toEqual(["StreamController", "startRun"]);
  });

  test("the prefix scan is inclusive at the instant and exclusive after it", () => {
    returnToLive();
    clearLog();
    appendBeat({ ...beatOf("turn"), id: "b-a", at: 10 });
    appendBeat({ ...beatOf("turn"), id: "b-b", at: 11 });
    expect(beatsAtOrBefore(10)).toBe(1);
    expect(beatsAtOrBefore(9)).toBe(0);
    clearLog();
  });
});
