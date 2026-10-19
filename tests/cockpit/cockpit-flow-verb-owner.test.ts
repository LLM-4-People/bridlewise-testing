// @vitest-environment node
/**
 * Flow verb owner (spec §1.2 — no verb, no pixels; a disabled verb needs
 * the reason ON it).
 *
 * RUNTIME — every BeatVerb the wiring factory produces is either wired with
 * a real `run`, or disabled with a non-empty reason. Exercised across every
 * beat kind and both context shapes (with/without project·chat).
 *
 * STATIC — interactive elements in the flow/computer surfaces render only
 * through the Verb component or carry an explicit `data-verb-id` (so every
 * control names its action or its gap). The scanner is mutation-tested.
 */
import { describe, expect, test } from "vitest";

import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import { ClientError } from "../../src/data/errors.ts";
import {
  breakerRowFocus,
  resetDeskBus,
} from "../../src/cockpit/desk/desk-bus.ts";
import { closeRightMenu, rightMenu, pendingInspectorSection } from "../../src/cockpit/shell/right-menu.ts";
import { read, relpath, stripTemplateComments, walk } from "../helpers/source-scan.ts";

function beatOf(kind: Beat["kind"], extra: Partial<Beat> = {}): Beat {
  const base: Beat = {
    id: "b-db-1",
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
    default:
      return { ...base, ...extra };
  }
}

const fullCtx: VerbContext = {
  chatId: "c1",
  projectId: "p1",
  toggleExpand: () => {},
  prefillComposer: () => {},
  hint: null,
  userPromptBefore: () => "the prompt",
};

const bareCtx: VerbContext = {
  chatId: null,
  projectId: null,
  toggleExpand: () => {},
  prefillComposer: null,
  hint: null,
  userPromptBefore: () => null,
};

describe("runtime — every produced verb is wired-or-reasoned", () => {
  const kinds: Beat["kind"][] = ["turn", "tool", "effect", "check-delta", "event", "finding", "seam"];

  for (const ctxName of ["full", "bare"] as const) {
    const ctx = ctxName === "full" ? fullCtx : bareCtx;
    const factory = makeVerbsFor(ctx);
    for (const kind of kinds) {
      test(`${ctxName} context · ${kind} beats`, () => {
        const variants: Beat[] = [beatOf(kind)];
        if (kind === "turn") {
          variants.push(beatOf("turn", { turn: { who: "model", text: "m", streaming: false } }));
          // A live (non-persisted) user turn — rollback must go honest-disabled.
          variants.push({ ...beatOf("turn"), id: "b-msg-3-abc" });
        }
        for (const beat of variants) {
          for (const verb of factory(beat)) {
            expect(verb.label.length).toBeGreaterThan(0);
            if (verb.wired) {
              expect(typeof verb.run, `${verb.id} wired without run`).toBe("function");
            } else {
              expect(verb.reason, `${verb.id} disabled without reason`).toBeTruthy();
              expect(verb.reason!.length).toBeGreaterThan(10);
              expect(verb.run).toBeUndefined();
            }
          }
        }
      });
    }
  }

  test("custody verbs wire to the block actions with a project — honest-disabled without one", () => {
    const verbs = makeVerbsFor(fullCtx)(beatOf("effect"));
    const undo = verbs.find((v) => v.id === "custody.state/undo")!;
    const keep = verbs.find((v) => v.id === "custody.state/keep")!;
    expect(undo.wired).toBe(true);
    expect(keep.wired).toBe(true);
    const see = verbs.find((v) => v.id === "git.diff-patch")!;
    expect(see.wired).toBe(true);
    // Without an owning project the verbs are honest-disabled with the gap.
    const bare = makeVerbsFor(bareCtx)(beatOf("effect"));
    const bareUndo = bare.find((v) => v.id === "custody.state/undo")!;
    expect(bareUndo.wired).toBe(false);
    expect(bareUndo.reason).toMatch(/project/);
    expect(bare.find((v) => v.id === "custody.state/keep")!.wired).toBe(false);
  });

  test("`see what changed` follows the measured truth — it answers on a non-git project, folds on a repository", async () => {
    // On a project the beat's own diff read measured as having NO
    // repository, the press used to do NOTHING: no surface, no call, no
    // hint — a silent dead verb. The honest behavior: the press states the
    // wire's own sentence for that measured fact, in the same inline
    // answer face the two-press undo confirm uses.
    const toggled: string[] = [];
    const recording: VerbContext = { ...fullCtx, toggleExpand: (id: string) => toggled.push(id) };
    const nonGit = makeVerbsFor(recording)(
      beatOf("effect", {
        effect: {
          path: "summary.md",
          producedBy: "t",
          noRepositoryReason: "this project's folder is not under version control, so there is no earlier version to show changes against",
        },
      }),
    ).find((v) => v.id === "git.diff-patch")!;
    let caught: unknown = null;
    try {
      await nonGit.run!();
    } catch (err) {
      caught = err;
    }
    expect(caught, "the press must not be silent").toBeInstanceOf(ClientError);
    expect((caught as ClientError).code).toBe("git_diff_no_repository");
    expect((caught as ClientError).message).toContain("not under version control");
    expect(toggled, "there is nothing to fold open — the press must not pretend to act").toEqual([]);

    // The repository-backed path is untouched: the same verb on a beat with
    // no no-repository fact folds the beat open, exactly as before.
    const gitBacked = makeVerbsFor(recording)(beatOf("effect")).find((v) => v.id === "git.diff-patch")!;
    await gitBacked.run!();
    expect(toggled).toEqual(["b-db-1"]);
  });

  test("the flow's undo is two-press: the FIRST press states the measured loss and performs nothing", async () => {
    const verbs = makeVerbsFor(fullCtx)(
      beatOf("effect", { effect: { path: "x.ts", producedBy: "t", added: 4, removed: 2 } }),
    );
    const undo = verbs.find((v) => v.id === "custody.state/undo")!;
    expect(undo.wired).toBe(true);
    // First press: arms and states the exact counted loss — no network, no
    // state change (the thrown sentence renders on the verb, not a modal).
    await expect(undo.run!()).rejects.toThrow(
      /discards \+4 −2 in x\.ts.*press undo again to confirm/,
    );
    // A beat whose diff is not yet counted states the absence, not a number.
    const uncounted = makeVerbsFor(fullCtx)({ ...beatOf("effect"), id: "b-db-uncounted" }).find(
      (v) => v.id === "custody.state/undo",
    )!;
    await expect(uncounted.run!()).rejects.toThrow(/± not counted yet/);
  });

  test("the tool beat's `breaker` verb jumps to the row — honest-disabled without a tool name", () => {
    const named = makeVerbsFor(fullCtx)(beatOf("tool"));
    const breaker = named.find((v) => v.id === "tools.breaker/row")!;
    expect(breaker.label).toBe("Breaker");
    expect(breaker.wired).toBe(true);
    // The verb is a client navigation primitive (it opens the desk's row);
    // running it must move the desk bus, not post anything.
    closeRightMenu();
    breaker.run!();
    expect(rightMenu.get()).toBe("setup");
    expect(pendingInspectorSection.get()).toBe("setup-sec-tools");
    closeRightMenu();
    expect(breakerRowFocus.get()?.tool).toBe("read_file");
    resetDeskBus();

    const nameless = makeVerbsFor(fullCtx)(
      beatOf("tool", { tool: undefined }),
    ).find((v) => v.id === "tools.breaker/row")!;
    expect(nameless.wired).toBe(false);
    expect(nameless.reason).toMatch(/no tool name/);
  });

  test("rewind wires only to persisted ids; live turns get the reason", () => {
    const persisted = makeVerbsFor(fullCtx)(beatOf("turn"));
    expect(persisted.find((v) => v.id === "run.compose/rewind")!.wired).toBe(true);
    const live = makeVerbsFor(fullCtx)({ ...beatOf("turn"), id: "b-msg-1-x" });
    const rewind = live.find((v) => v.id === "run.compose/rewind")!;
    expect(rewind.wired).toBe(false);
    expect(rewind.reason).toMatch(/saved/);
  });

  test("retry, edit & resend and rewind here are ONE operation at ONE door", () => {
    // The user reported all three as the same defect ("creating new entries,
    // instead of modifying/rerunning the target one"), and they were: three
    // implementations, none of which rewound. This asserts they share the
    // door — a fourth implementation would show up here as a fourth id.
    const yours = makeVerbsFor(fullCtx)(beatOf("turn"));
    const model = makeVerbsFor(fullCtx)(
      beatOf("turn", { turn: { who: "model", text: "m", streaming: false } }),
    );
    const editAndResend = yours.find((v) => v.label === "Edit & resend")!;
    const rewindHere = yours.find((v) => v.id === "run.compose/rewind")!;
    const retry = model.find((v) => v.id === "run.compose/rewind")!;

    expect(rewindHere.id).toBe("run.compose/rewind");
    expect(retry.id).toBe("run.compose/rewind");
    // `edit & resend` keeps its own id because it is the composer half of the
    // gesture; what matters is that it ARMS a rewind rather than appending.
    expect(editAndResend.writes).toBe(true);
    expect(retry.writes).toBe(true);
    expect(rewindHere.writes).toBe(true);

    // And the source has exactly one owner for it.
    const verbs = read("src/cockpit/flow/verbs.ts");
    expect(verbs).toContain('from "./rewind.ts"');
    // The old append path is gone: `retry` must not start a run directly.
    expect(verbs).not.toContain("beginCockpitRun");
    // And the old destructive path is gone with it.
    expect(verbs).not.toContain("rollbackChat");
  });

  test("retry does NOT depend on the causing prompt being loaded", () => {
    // History arrives in pages. A model turn at the top of the loaded window
    // has its causing prompt in a page the browser never fetched, and the old
    // implementation read that prompt out of the in-memory beat log — so the
    // verb rendered "none is recorded before this turn", which was false
    // about the record. `userPromptBefore` returning null must no longer
    // disable retry.
    const noPrompt: VerbContext = { ...fullCtx, userPromptBefore: () => null };
    const model = makeVerbsFor(noPrompt)(
      beatOf("turn", { turn: { who: "model", text: "m", streaming: false } }),
    );
    const retry = model.find((v) => v.id === "run.compose/rewind")!;
    expect(retry.wired).toBe(true);
  });
});

// ── Static scan ──────────────────────────────────────────────────────────────

/**
 * In flow/computer/desk sources (except Verb.svelte itself and the dev
 * harness), every `<button` must carry `data-verb-id` — controls name their
 * action or their gap; anonymous buttons are forbidden.
 */
export function scanButtons(src: string, file: string): string[] {
  const violations: string[] = [];
  const re = /<button\b([^>]*?)>/gs;
  let m: RegExpExecArray | null;
  // Read the template with its comments removed — a comment SPELLING a
  // `<button>` is not a rendered control, and a scan over raw text reds on
  // a button that does not exist.
  while ((m = re.exec(stripTemplateComments(src))) !== null) {
    if (!/\bdata-verb-id\s*=/.test(m[1]!)) {
      violations.push(`${file}: <button> without data-verb-id (§1.2 — name the action or the gap)`);
    }
  }
  return violations;
}

describe("static — flow controls name their action", () => {
  const files = [
    ...walk("src/cockpit/flow", { exts: [".svelte"] }),
    ...walk("src/cockpit/computer", { exts: [".svelte"] }),
    ...walk("src/cockpit/desk", { exts: [".svelte"] }),
  ].filter((f) => {
    const rel = relpath(f);
    return !rel.endsWith("/Verb.svelte") && !rel.includes("/dev/");
  });

  test("no anonymous <button> in flow/computer/desk surfaces", () => {
    const all: string[] = [];
    for (const f of files) all.push(...scanButtons(read(f), relpath(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  test("mutation: an anonymous button is flagged", () => {
    expect(scanButtons(`<button class="x" onclick={f}>go</button>`, "X.svelte")).toHaveLength(1);
  });

  test("mutation: a named button is NOT flagged", () => {
    expect(scanButtons(`<button data-verb-id="a.b" onclick={f}>go</button>`, "X.svelte")).toEqual([]);
  });

  test("mutation: a multi-line button without the attribute is flagged", () => {
    const bad = `<button\n  class="fold"\n  onclick={toggle}\n>x</button>`;
    expect(scanButtons(bad, "X.svelte")).toHaveLength(1);
  });

  test("mutation: a button named only inside an HTML comment is NOT a button", () => {
    expect(scanButtons(`<!-- <button class="x">planned</button> -->`, "X.svelte")).toEqual([]);
    // …but a live anonymous button beside such a comment still reds.
    expect(
      scanButtons(`<!-- <button data-verb-id="a.b">old</button> -->\n<button onclick={f}>go</button>`, "X.svelte"),
    ).toHaveLength(1);
  });
});
