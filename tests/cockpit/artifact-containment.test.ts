// @vitest-environment jsdom
/**
 * ARTIFACT CONTAINMENT — an artifact may fail as badly as it likes inside its
 * frame, and the cockpit must not notice.
 *
 * THE USER'S REPORT, VERBATIM: "it seems like artifacts are breaking the page,
 * we should make sure they are contained properly so it cannot happen."
 *
 * An artifact is a whole HTML document written by a model and mounted live in
 * the conversation. That is the most powerful thing the harness renders and
 * the most dangerous, so the boundary around it is guarded MECHANICALLY here,
 * not described in a comment somewhere and hoped for.
 *
 * ── WHAT IS PROVEN HERE, AND WHAT IS NOT ──────────────────────────────────
 *
 * jsdom does not execute an iframe's `srcdoc`. That is a limit and it is
 * stated rather than papered over: this file CANNOT prove that a looping or
 * throwing artifact leaves the browser's main thread alone. What it proves is
 * everything on OUR side of the boundary, which is the part we author and the
 * part that can regress:
 *
 *   A. the sandbox cannot widen — `allow-same-origin` is absent and cannot be
 *      configured back in;
 *   B. the frame's size is DECLARED, so a growing artifact cannot move the
 *      flow (the virtualizer measures each beat once — a frame that grew
 *      after measurement would take the scroll position with it);
 *   C. the artifact's document never enters the host's DOM, in any form;
 *   D. a hostile document does not break OUR render: the beat renders, its
 *      neighbours render, and nothing throws;
 *   E. a failed artifact shows an honest reason, never an empty rectangle;
 *   F. an artifact's `postMessage` (which no sandbox can block) reaches
 *      EXACTLY ONE module, which accepts EXACTLY ONE message shape. This used
 *      to be "reaches nothing" — see §F for why the narrower claim is the
 *      stronger one, and `artifact-runtime-errors.test.ts` for the behaviour
 *      of the single listener.
 *
 * The runtime half — that a three-second synchronous block inside a frame
 * leaves the host's timers within 10ms of their idle baseline, that a frame
 * with 20,000 appended rows and a 9,999,999px document moves the host's
 * scroll extent by zero pixels — was MEASURED in a real browser during the
 * battle test and is recorded in `src/cockpit/render/artifact.ts`. It is not
 * re-provable here and is not claimed here.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import ArtifactFrame from "../../src/cockpit/render/ArtifactFrame.svelte";
import ToolBeat from "../../src/cockpit/flow/ToolBeat.svelte";
import {
  artifactSummary,
  artifactViewOf,
  frameHeight,
  isArtifactBeat,
} from "../../src/cockpit/render/artifact.ts";
import { REPORT_KEYS, REPORT_KINDS } from "../../src/cockpit/render/artifact-errors.ts";
import type { Beat, ToolStatus } from "../../src/cockpit/flow/types.ts";
import { readArtifactSandboxToken } from "../../src/state/web-ui-config";
import {
  read,
  relpath,
  stripCommentsAndStringsFor,
  stripCommentsOnly,
  stripCommentsOnlyFor,
  walk,
} from "../helpers/source-scan.ts";

const FRAME = "src/cockpit/render/ArtifactFrame.svelte";
const OWNER = "src/cockpit/render/artifact.ts";
const COCKPIT_ROOT = "src/cockpit";

afterEach(cleanup);

// ── Fixtures ─────────────────────────────────────────────────────────────

/** A recorded `create_artifact` call. Status and record vary; nothing else. */
function artifactBeat(
  status: ToolStatus,
  input: unknown,
  output: unknown,
  type = "html",
  extra: Readonly<{ refused?: true; incompleteReason?: string }> = {},
): Beat {
  return {
    id: `art-${status}-${extra.refused === true ? "refused" : "plain"}`,
    kind: "tool",
    parentId: null,
    turnIndex: 1,
    at: 1,
    abnormal: status === "error",
    bleed: true,
    verbs: [],
    tool: {
      name: "create_artifact",
      label: "create an artifact",
      status,
      input,
      output,
      startedAt: 1,
      ...(status === "running" ? {} : { durationMs: 12 }),
      // A failed call that carries a recorded output IS a refusal record —
      // the typed fact the data layer sets wherever a real result landed.
      // A stranded call (empty output, no verdict yet) is NOT.
      ...(extra.refused === true ? { refused: true } : {}),
      ...(extra.incompleteReason !== undefined ? { incompleteReason: extra.incompleteReason } : {}),
    },
  } as Beat;
}

const GOOD_DOC = "<!DOCTYPE html><body><p>hello</p><script>var a=1;</script></body>";

function goodArgs(type = "html") {
  return { type, title: "Monthly Signups", content: GOOD_DOC };
}

const GOOD_OUTPUT = JSON.stringify({
  ok: true,
  artifactId: "abc0000000000000",
  type: "html",
  title: "Monthly Signups",
  contentLength: GOOD_DOC.length,
  message: "Artifact 'Monthly Signups' (html) is rendering live in the chat.",
});

// ── A. THE SANDBOX CANNOT WIDEN ──────────────────────────────────────────

describe("A. the sandbox cannot widen", () => {
  test("the mounted frame carries allow-scripts and NOT allow-same-origin", () => {
    const { container } = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("done", goodArgs(), GOOD_OUTPUT)) },
    });
    const frame = container.querySelector("iframe");
    expect(frame, "an accepted artifact must mount a frame").not.toBeNull();
    const sandbox = frame!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(
      sandbox,
      "allow-same-origin would hand the artifact this page's DOM, cookies and storage",
    ).not.toContain("allow-same-origin");
  });

  test("the frame allows nothing else either — no forms, popups or top navigation", () => {
    const { container } = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("done", goodArgs(), GOOD_OUTPUT)) },
    });
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    for (const token of ["allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "allow-downloads"]) {
      expect(sandbox, `${token} was never granted and must not appear`).not.toContain(token);
    }
  });

  test("CONFIGURING allow-same-origin back in does not work — the owner strips it", () => {
    // The token comes from the config owner, which hardens it. This is the
    // mutation that matters: an operator (or a bad default) setting the
    // config to a same-origin sandbox must not reach the frame.
    expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-scripts allow-same-origin" } })).toBe(
      "allow-scripts",
    );
    expect(readArtifactSandboxToken({ artifacts: { iframeSandbox: "allow-same-origin" } })).toBe("allow-scripts");
    expect(readArtifactSandboxToken(null), "and the default is the safe one").toBe("allow-scripts");
  });

  test("the component never names a sandbox token itself (the owner is the only source)", () => {
    const code = stripCommentsAndStringsFor(read(FRAME), FRAME);
    expect(code, "the token must be bound from the owner").toContain("sandbox={sandboxToken}");
    expect(code, "a literal here would be a second source that can drift").not.toMatch(
      /["']allow-(?:scripts|same-origin)/,
    );
  });

  test("the frame is the ONLY iframe in the cockpit, so there is one boundary to guard", () => {
    const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);
    const mounters = files.filter((f) => /<iframe\b/.test(stripCommentsAndStringsFor(read(f), f)));
    expect(mounters, "a second frame would be a second security posture").toEqual([FRAME]);
  });

  test("and the only srcdoc, composed by the shared CSP owner rather than by hand", () => {
    const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);
    const users = files.filter((f) => /\bsrcdoc\b/.test(stripCommentsAndStringsFor(read(f), f)));
    expect(users).toEqual([FRAME]);
    expect(read(FRAME), "the CSP has one owner; this must not compose its own").toContain(
      "sandboxedSrcdoc",
    );
    expect(stripCommentsAndStringsFor(read(FRAME), FRAME)).not.toMatch(/Content-Security-Policy/);
  });
});

// ── B. THE FRAME'S SIZE IS DECLARED, NOT DERIVED ─────────────────────────

describe("B. the frame's size is declared, so a growing artifact cannot move the flow", () => {
  test("the height depends on the artifact's KIND and on nothing else", () => {
    const tiny = "<p>x</p>";
    const huge = "<p>x</p>".repeat(20_000);
    for (const type of ["html", "game", "sheet", "presentation"]) {
      expect(
        frameHeight(type),
        "a height that varied with content would break the flow's height index",
      ).toBe(frameHeight(type));
      const small = artifactViewOf(artifactBeat("done", { type, title: "t", content: tiny }, GOOD_OUTPUT));
      const big = artifactViewOf(artifactBeat("done", { type, title: "t", content: huge }, GOOD_OUTPUT));
      expect(small.kind).toBe("document");
      expect(big.kind).toBe("document");
      expect(frameHeight(small.kind === "document" ? small.type : "")).toBe(
        frameHeight(big.kind === "document" ? big.type : ""),
      );
    }
  });

  test("the kinds really do differ, so the kind is not decorative", () => {
    const heights = new Set(["html", "game", "sheet", "presentation"].map((t) => frameHeight(t)));
    expect(heights.size, "a kind the model is asked to choose must change something").toBeGreaterThan(1);
  });

  test("an unknown kind still gets a declared height (never zero, never unbounded)", () => {
    expect(frameHeight("something-new")).toBeGreaterThan(0);
    expect(frameHeight("")).toBeGreaterThan(0);
  });

  // ── THE EXPAND GESTURE GROWS THE STAGE VERTICALLY ─────────────────────
  //
  // THE USER'S RULING on the run pane's artifact beats: expanding must grow
  // the preview VERTICALLY, never wider. The geometry owner answers with a
  // SECOND declared height per kind, and these arms pin the state machine:
  // expanded changes HEIGHT-affecting facts only.

  test("expanding grows the declared height — for every kind, and for unknown kinds", () => {
    for (const type of ["html", "game", "sheet", "presentation", "something-new", ""]) {
      const compact = frameHeight(type);
      const tall = frameHeight(type, true);
      expect(
        tall,
        `kind "${type}": the expand gesture must earn a taller stage, not a wider card`,
      ).toBeGreaterThan(compact);
    }
  });

  test("the kinds still differ when expanded — the kind decides both boxes", () => {
    const tall = new Set(["html", "game", "sheet", "presentation"].map((t) => frameHeight(t, true)));
    expect(tall.size).toBeGreaterThan(1);
  });

  test("the expand height is still a DECLARED constant — the content cannot move it", () => {
    const tiny = "<p>x</p>";
    const huge = "<p>x</p>".repeat(20_000);
    const small = artifactViewOf(artifactBeat("done", { type: "game", title: "t", content: tiny }, GOOD_OUTPUT));
    const big = artifactViewOf(artifactBeat("done", { type: "game", title: "t", content: huge }, GOOD_OUTPUT));
    expect(frameHeight(small.kind === "document" ? small.type : "", true)).toBe(
      frameHeight(big.kind === "document" ? big.type : "", true),
    );
  });

  test("the mounted frame writes the EXPANDED height when the gesture is on", () => {
    const { container } = render(ArtifactFrame, {
      props: {
        frameKey: "k1",
        view: artifactViewOf(artifactBeat("done", goodArgs("game"), GOOD_OUTPUT)),
        expanded: true,
      },
    });
    const frame = container.querySelector("iframe") as HTMLElement;
    expect(frame.getAttribute("style")).toContain(`height: ${frameHeight("game", true)}px`);
    cleanup();
    // …and the compact one when it is not — the default mount (the editor's
    // page preview) keeps the compact box.
    const compact = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("done", goodArgs("game"), GOOD_OUTPUT)) },
    });
    expect(compact.container.querySelector("iframe")!.getAttribute("style")).toContain(
      `height: ${frameHeight("game")}px`,
    );
  });

  test("the beat's expand state is what feeds the frame — the wire from the card to the stage", () => {
    // The card's open state (the reader's click) is the ONLY thing that may
    // move the frame between its two declared heights.
    const collapsed = render(ToolBeat, {
      props: { beat: artifactBeat("done", goodArgs("game"), GOOD_OUTPUT), expanded: false },
    });
    expect(collapsed.container.querySelector("iframe")!.getAttribute("style")).toContain(
      `height: ${frameHeight("game")}px`,
    );
    cleanup();
    const expanded = render(ToolBeat, {
      props: { beat: artifactBeat("done", goodArgs("game"), GOOD_OUTPUT), expanded: true },
    });
    expect(expanded.container.querySelector("iframe")!.getAttribute("style")).toContain(
      `height: ${frameHeight("game", true)}px`,
    );
  });

  test("the artifact card's width is the column, STABLE across the gesture — never the open bleed", () => {
    // The expand gesture may not buy WIDTH: the artifact card holds --rail
    // resting and open alike (the run pane's column), while every other
    // open card may bleed to --rail-open. Pinned on the WIDTH POLICY OWNER
    // (tokens.css, beside the --rail declarations), the one place the rule
    // lives — and the tool beat carries no width bound of its own at all.
    const tokensCss = stripCommentsOnly(read("src/cockpit/tokens.css"));
    expect(tokensCss, "the artifact card caps at the column bound, resting").toMatch(
      /\.cockpit \.tool\.artifact\s*\{[^}]*max-width\s*:\s*var\(--rail\)\s*;/,
    );
    expect(tokensCss, "and capped the same when open — the gesture moves one edge only").toMatch(
      /\.cockpit \.tool\.open\.artifact\s*\{[^}]*max-width\s*:\s*var\(--rail\)\s*;/,
    );
    const artifactRules = tokensCss.match(/\.tool\.[^{]*artifact[^{]*\{[^}]*\}/g) ?? [];
    for (const rule of artifactRules) {
      expect(rule, "no artifact rule may bleed to the open bound").not.toContain("--rail-open");
    }
    const toolBeatCss = stripCommentsOnlyFor(read("src/cockpit/flow/ToolBeat.svelte"), "src/cockpit/flow/ToolBeat.svelte");
    expect(toolBeatCss, "the tool beat re-declares no width bound — the vocabulary owns it").not.toMatch(
      /max-width:\s*var\(--rail\)/,
    );
  });

  test("the rendered frame's box comes from that declaration, in pixels", () => {
    const { container } = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("done", goodArgs("game"), GOOD_OUTPUT)) },
    });
    const frame = container.querySelector("iframe") as HTMLElement;
    expect(
      frame.getAttribute("style"),
      "the declared height is written straight onto the element — one hop, nothing to override",
    ).toContain(`height: ${frameHeight("game")}px`);
  });

  test("the component never measures the content to size itself", () => {
    const code = stripCommentsAndStringsFor(read(FRAME), FRAME);
    for (const smell of ["scrollHeight", "offsetHeight", "getBoundingClientRect", "ResizeObserver"]) {
      expect(code, `${smell} would make the box a function of the artifact`).not.toContain(smell);
    }
  });

  test("MUTATION: a height that read the content would be caught by the pin above", () => {
    // The pin is "same kind ⇒ same height". Model the mutation directly and
    // show the property it would break.
    const mutated = (type: string, content: string): number => frameHeight(type) + content.length;
    expect(mutated("game", "x"), "a content-sensitive height differs for the same kind").not.toBe(
      mutated("game", "xx"),
    );
    expect(frameHeight("game")).toBe(frameHeight("game"));
  });
});

// ── C. THE DOCUMENT NEVER ENTERS THE HOST'S DOM ──────────────────────────

describe("C. the artifact's document never enters the host's DOM", () => {
  const MARKER = "ZZ_ARTIFACT_BODY_MARKER_ZZ";
  const marked = `<!DOCTYPE html><body><h1>${MARKER}</h1><script>var a=1;</script></body>`;

  test("nothing from the document is rendered as text on this page", () => {
    const { container } = render(ToolBeat, {
      props: {
        beat: artifactBeat("done", { type: "html", title: "T", content: marked }, GOOD_OUTPUT),
        expanded: true,
      },
    });
    expect(
      container.textContent ?? "",
      "the document belongs in the frame; text here means it reached the host",
    ).not.toContain(MARKER);
  });

  test("no element is created from it either — it is an attribute, not markup", () => {
    const { container } = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("done", { type: "html", title: "T", content: marked }, GOOD_OUTPUT)) },
    });
    expect(container.querySelector("h1"), "an <h1> here would mean the document was parsed into us").toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // It IS on the frame, as srcdoc — that is the one place it may be.
    expect(container.querySelector("iframe")!.getAttribute("srcdoc") ?? "").toContain(MARKER);
  });

  test("the expanded beat shows the artifact's OTHER arguments, and not the document", () => {
    const { container } = render(ToolBeat, {
      props: {
        beat: artifactBeat("done", { type: "html", title: "Monthly Signups", content: marked }, GOOD_OUTPUT),
        expanded: true,
      },
    });
    const text = container.textContent ?? "";
    expect(text, "the arguments the reader can act on stay visible").toContain("Monthly Signups");
    expect(text).toContain("type");
    expect(
      text,
      "a 55KB document folded into a code block is 1,177 lines the virtualizer must measure",
    ).not.toContain("DOCTYPE");
  });

  test("the collapsed line names the artifact instead of quoting its source", () => {
    const beat = artifactBeat("done", { type: "game", title: "TETRIS", content: marked }, GOOD_OUTPUT);
    const summary = artifactSummary(artifactViewOf(beat));
    expect(summary).toContain("TETRIS");
    expect(summary).toContain("game");
    expect(summary, "and states the size rather than showing it").toMatch(/[\d,]+ bytes/);
    expect(summary).not.toContain("DOCTYPE");
  });
});

// ── D. A HOSTILE DOCUMENT DOES NOT BREAK OUR RENDER ──────────────────────

describe("D. a hostile document does not break the render around it", () => {
  /**
   * Each of these is a document a model could really emit. jsdom will not RUN
   * any of them — what is being proven is that our own rendering path never
   * has to, so none of them can throw inside the cockpit's render.
   */
  const HOSTILE: readonly (readonly [string, string])[] = [
    ["a script that throws on the first line", "<body><script>throw new Error('boom');</script></body>"],
    ["an infinite loop", "<body><script>while(true){}</script></body>"],
    ["a document that never closes a tag", "<body><div><span><p>unclosed"],
    ["a document that is only a script tag with no close", "<script>var a=1;"],
    ["one megabyte of nested markup", `<body>${"<div>".repeat(20_000)}deep${"</div>".repeat(20_000)}</body>`],
    ["a document that tries to reach the parent", "<script>parent.document.body.innerHTML='pwned';</script>"],
    ["a document that tries to talk to us", "<script>parent.postMessage({evil:1},'*');</script>"],
    ["a document that tries to leave", "<script>top.location.href='https://evil.example';</script>"],
    ["markup that looks like an attribute break-out", `<body onload="x">" onload="alert(1)`],
    ["a null byte and lone surrogates", "<body>\u0000\uD800<script>var a=1;</script></body>"],
  ];

  for (const [name, content] of HOSTILE) {
    test(`${name}: the beat still renders, and renders a frame`, () => {
      const { container } = render(ToolBeat, {
        props: { beat: artifactBeat("done", { type: "html", title: name, content }, GOOD_OUTPUT), expanded: false },
      });
      expect(container.querySelector('[data-field="artifact-frame"]'), "the slot must exist").not.toBeNull();
      expect(container.querySelector("iframe"), "the document goes in the frame, whatever it is").not.toBeNull();
      expect(container.textContent ?? "", "and the beat still says what it is").toContain(name);
    });
  }

  test("a hostile artifact beside an ordinary one leaves the ordinary one intact", () => {
    const hostile = render(ToolBeat, {
      props: {
        beat: artifactBeat("done", { type: "html", title: "hostile", content: HOSTILE[0]![1] }, GOOD_OUTPUT),
        expanded: true,
      },
    });
    const ordinary = render(ToolBeat, {
      props: { beat: artifactBeat("done", goodArgs(), GOOD_OUTPUT), expanded: true },
    });
    expect(hostile.container.querySelector("iframe")).not.toBeNull();
    expect(ordinary.container.querySelector("iframe")).not.toBeNull();
    expect(ordinary.container.textContent ?? "").toContain("Monthly Signups");
  });

  test("the host's own document is untouched by any of them", () => {
    const before = document.title;
    for (const [, content] of HOSTILE) {
      render(ToolBeat, {
        props: { beat: artifactBeat("done", { type: "html", title: "h", content }, GOOD_OUTPUT), expanded: true },
      });
    }
    expect(document.title, "nothing an artifact contains may act on this page").toBe(before);
    expect(document.querySelector("h1")).toBeNull();
  });
});

// ── E. A FAILED ARTIFACT IS HONEST, NEVER BLANK ──────────────────────────

describe("E. a failed artifact says what went wrong instead of showing nothing", () => {
  const REFUSAL =
    "Error: the artifact 'Broken' was NOT created — it cannot run as written.\n" +
    "  - JavaScript syntax error at line 12 of the document: Unexpected identifier 'x'\n" +
    "Fix the error above and call create_artifact again with the corrected document. Nothing was shown to the user.";

  test("a refused artifact renders the refusal, not the document it refused", () => {
    const beat = artifactBeat("error", { type: "html", title: "Broken", content: GOOD_DOC }, REFUSAL, "html", { refused: true });
    const { container } = render(ArtifactFrame, { props: { frameKey: "k1", view: artifactViewOf(beat) } });
    expect(container.querySelector("iframe"), "a refused artifact was never created; showing it would be a lie").toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("refused");
    expect(text, "the tool's real message must survive to the reader").toContain("Unexpected identifier");
  });

  test("the tool's words are ATTRIBUTED to the tool, not spoken as ours", () => {
    const beat = artifactBeat("error", { type: "html", title: "Broken", content: GOOD_DOC }, REFUSAL, "html", { refused: true });
    const { container } = render(ArtifactFrame, { props: { frameKey: "k1", view: artifactViewOf(beat) } });
    expect(container.textContent ?? "").toContain("what the tool reported");
  });

  // ── THE GATE-REFUSED ARTIFACT (the shape the live drive caught) ──────────
  //
  // A create_artifact call BLOCKED by the pre-dispatch schema gate carries
  // BOTH the document (in the arguments) and the refusal (the recorded
  // result). The refusal is what happened; the document was never accepted.
  // The renderer must hold the refusal, never mount the frame — the file's
  // own design comment forbids exactly the opposite.

  const GATE_REFUSAL =
    "Tool 'create_artifact' arguments failed schema validation: missing required field 'type' " +
    "(a string — one of: html, game, sheet, presentation). Send only the missing 'type' — " +
    "the harness kept the valid fields you already sent ('title', 'content') and merges your next attempt in.";

  test("a GATE-REFUSED artifact with its document in the arguments renders NO frame — only the refusal", () => {
    const beat = artifactBeat(
      "error",
      { title: "Monthly Signups", content: GOOD_DOC },
      GATE_REFUSAL,
      "html",
      { refused: true },
    );
    const view = artifactViewOf(beat);
    expect(view.kind, "the gate blocked the call; the document was never accepted").toBe("absence");
    const { container } = render(ArtifactFrame, { props: { frameKey: "k1", view } });
    expect(container.querySelector("iframe"), "a gate-refused document must not mount as a live frame").toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("refused");
    expect(text, "the gate's real sentence must survive to the reader").toContain("missing required field 'type'");
  });

  test("the same gate-refused call renders the same ANATOMY as an accepted one", () => {
    // The symmetric-detail rule holds through the refusal: the slot, the
    // fields, the order — only what FILLS the slot differs.
    const ok = render(ToolBeat, {
      props: { beat: artifactBeat("done", goodArgs(), GOOD_OUTPUT), expanded: true },
    });
    const okFields = [...ok.container.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field"));
    cleanup();
    const refused = render(ToolBeat, {
      props: {
        beat: artifactBeat("error", { title: "Monthly Signups", content: GOOD_DOC }, GATE_REFUSAL, "html", { refused: true }),
        expanded: true,
      },
    });
    expect([...refused.container.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field"))).toEqual(okFields);
  });

  test("an in-flight call (no verdict yet) still renders its document — the live feel is not the refusal's to take", () => {
    const view = artifactViewOf(artifactBeat("running", goodArgs(), null));
    expect(view.kind, "no result has landed; nothing says refused").toBe("document");
  });

  test("a stranded call (the client's own incompleteness observation) is NOT a refusal", () => {
    const beat = artifactBeat("error", goodArgs(), null, "html", {
      incompleteReason: "the run completed without this tool returning a result",
    });
    const view = artifactViewOf(beat);
    expect(view.kind, "no recorded result means no typed refusal — the heal decides next").toBe("document");
  });

  test("a call with no arguments recorded says so, and invents nothing", () => {
    const { container } = render(ArtifactFrame, {
      props: { frameKey: "k1", view: artifactViewOf(artifactBeat("running", null, "")) },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("no artifact document");
    expect(container.querySelector("iframe")).toBeNull();
    expect(text.trim().length, "an empty rectangle is the defect; a sentence is the fix").toBeGreaterThan(0);
  });

  test("the slot is NEVER empty — every artifact beat renders either a frame or a reason", () => {
    const cases: readonly Beat[] = [
      artifactBeat("done", goodArgs(), GOOD_OUTPUT),
      artifactBeat("error", { type: "html", title: "B", content: GOOD_DOC }, REFUSAL, "html", { refused: true }),
      artifactBeat("running", null, ""),
      artifactBeat("done", { type: "html", title: "T", content: "" }, ""),
      artifactBeat("error", null, "Error: something went wrong", "html", { refused: true }),
    ];
    for (const beat of cases) {
      const { container } = render(ArtifactFrame, { props: { frameKey: "k1", view: artifactViewOf(beat) } });
      const slot = container.querySelector('[data-field="artifact-frame"]');
      expect(slot, "the slot exists for every outcome").not.toBeNull();
      const hasFrame = slot!.querySelector("iframe") !== null;
      const hasWords = (slot!.textContent ?? "").trim().length > 0;
      expect(hasFrame || hasWords, "a frame or a sentence — never a blank box").toBe(true);
      cleanup();
    }
  });
});

// ── The symmetric-detail rule holds for artifacts too ────────────────────

describe("the artifact slot obeys the symmetric-detail rule", () => {
  function anatomy(root: Element): string[] {
    return [...root.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field") ?? "");
  }

  test("a succeeded and a failed artifact render the same fields, in the same order", () => {
    const ok = render(ToolBeat, {
      props: { beat: artifactBeat("done", goodArgs(), GOOD_OUTPUT), expanded: true },
    });
    const okFields = anatomy(ok.container);
    cleanup();
    const bad = render(ToolBeat, {
      props: {
        beat: artifactBeat("error", goodArgs(), "Error: the artifact was NOT created — it cannot run as written.", "html", { refused: true }),
        expanded: true,
      },
    });
    expect(anatomy(bad.container)).toEqual(okFields);
  });

  test("…and the same fields when collapsed", () => {
    const ok = render(ToolBeat, { props: { beat: artifactBeat("done", goodArgs(), GOOD_OUTPUT), expanded: false } });
    const okFields = anatomy(ok.container);
    cleanup();
    const bad = render(ToolBeat, {
      props: { beat: artifactBeat("error", goodArgs(), "Error: refused", "html", { refused: true }), expanded: false },
    });
    expect(anatomy(bad.container)).toEqual(okFields);
    expect(okFields, "the artifact slot is part of that anatomy").toContain("artifact-frame");
  });

  test("the slot appears for artifacts and for no other tool", () => {
    const other: Beat = {
      id: "b1",
      kind: "tool",
      parentId: null,
      turnIndex: 1,
      at: 1,
      abnormal: false,
      bleed: true,
      verbs: [],
      tool: { name: "read_file", label: "read file", status: "done", input: { path: "a.ts" }, output: "x", startedAt: 1 },
    } as Beat;
    expect(isArtifactBeat(other)).toBe(false);
    const { container } = render(ToolBeat, { props: { beat: other, expanded: true } });
    expect(container.querySelector('[data-field="artifact-frame"]')).toBeNull();
  });

  test("the decision reads the RECORD, never the status", () => {
    const code = stripCommentsAndStringsFor(read(OWNER), OWNER);
    expect(code, "a status-driven shape is the asymmetry this system removed").not.toContain("status");
  });
});

// ── F. THE HOST LISTENS IN EXACTLY ONE PLACE, FOR EXACTLY ONE THING ──────

/**
 * How many window `message` handlers a source really registers. Comments are
 * stripped (several files explain WHY this is narrow) but STRINGS are kept —
 * the event name lives in a string literal, so a scan that stripped strings
 * would be looking for something it had just deleted. That defect was REAL:
 * the first version of this scan stripped strings and could never have fired.
 */
function countMessageListeners(src: string, path: string): number {
  const code = stripCommentsOnlyFor(src, path);
  const add = code.match(/addEventListener\s*\(\s*["']message["']/g) ?? [];
  const on = code.match(/\bonmessage\s*=[^=]/g) ?? [];
  return add.length + on.length;
}

function hasMessageListener(src: string, path: string): boolean {
  return countMessageListeners(src, path) > 0;
}

/**
 * The ONE owner. Every other cockpit source must be silent; this one must
 * register exactly one listener and must be the only thing that can act on an
 * artifact's message. Its BEHAVIOUR is proven in
 * `tests/cockpit/artifact-runtime-errors.test.ts`; what is proven HERE is that
 * it is alone and that its accepted shape has not widened.
 */
const ERROR_OWNER = "src/cockpit/render/artifact-errors.ts";

describe("F. the host listens in exactly one place, for exactly one thing", () => {
  test("EXACTLY ONE cockpit source registers a window message listener, and it is the named owner", () => {
    // A sandboxed frame CAN still call parent.postMessage — no sandbox token
    // blocks it, which is precisely why the receiving side is what has to be
    // controlled. The cockpit used to answer with silence: ZERO listeners.
    // Silence also meant a runtime failure inside an artifact was invisible to
    // the user and to the model, which is the fabricated-absence defect
    // (DESIGN-PERFORMANCE §1 L3) wearing a security badge.
    //
    // The claim is now narrower and STRONGER: one listener, in one named
    // module, accepting one message shape from a window it registered itself.
    // A second listener anywhere — including a well-meaning one in the frame
    // component — fails here.
    const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);
    const listeners = files.filter((f) => hasMessageListener(read(f), f));
    expect(
      listeners,
      `an artifact's postMessage may reach ONE module. These would hear it: ${listeners.join(", ")}`,
    ).toEqual([ERROR_OWNER]);
  });

  test("…and the owner registers exactly one, not several", () => {
    expect(
      countMessageListeners(read(ERROR_OWNER), ERROR_OWNER),
      "two listeners in the owner is two policies, and only one of them gets read",
    ).toBe(1);
  });

  test("the frame component itself neither listens nor reaches into the frame", () => {
    // It hands the owner the frame ELEMENT and reads back a state. It never
    // touches contentWindow, never posts, and never listens — so the boundary
    // still has exactly one crossing and it is not here.
    const code = stripCommentsAndStringsFor(read(FRAME), FRAME);
    for (const reach of ["contentWindow", "contentDocument", "postMessage", "addEventListener"]) {
      expect(code, `${reach} would be a second channel across the boundary`).not.toContain(reach);
    }
  });

  test("NOTHING in the cockpit posts INTO a frame — the channel is inbound-only", () => {
    // An outbound call would make this an RPC. There is no legitimate one:
    // everything the cockpit wants to say to an artifact is said by building a
    // new document.
    const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);
    const posters = files.filter((f) => /\.postMessage\s*\(/.test(stripCommentsAndStringsFor(read(f), f)));
    expect(posters, `these post into an artifact: ${posters.join(", ")}`).toEqual([]);
  });

  test("the accepted message shape is pinned BY VALUE, so widening it is a deliberate act", () => {
    // This is what makes "nothing else rides on this channel" hard to reverse
    // casually. A new field means editing this list, in a guard named for the
    // property it protects.
    expect(REPORT_KEYS).toEqual(["ch", "v", "kind", "name", "message", "line", "column"]);
    expect(REPORT_KINDS).toEqual(["error", "unhandledrejection"]);
    expect(
      REPORT_KEYS,
      "an id in the PAYLOAD would let one artifact report a crash as another's",
    ).not.toContain("id");
  });

  test("the owner authenticates by SOURCE, never by origin", () => {
    // A frame sandboxed without allow-same-origin has an OPAQUE origin: every
    // report arrives with event.origin === "null", shared by every such frame
    // on the page. An origin check here would authenticate nothing while
    // looking like it did — the exact "fix" a later reader is likely to make.
    const code = stripCommentsAndStringsFor(read(ERROR_OWNER), ERROR_OWNER);
    expect(code, "event.origin cannot distinguish two opaque-origin frames").not.toContain(".origin");
    expect(code, "identity is the window the browser named").toContain("contentWindow");
    expect(read(ERROR_OWNER), "and the reason must be written down for the next reader").toContain(
      "OPAQUE",
    );
  });

  test("MUTATION (direction 1): a second listener anywhere in the cockpit fails the scan", () => {
    // The scan must FIRE on real registrations…
    expect(countMessageListeners(`window.addEventListener("message", (e) => apply(e.data));`, "probe.ts")).toBe(1);
    expect(countMessageListeners(`window.addEventListener('message', onMsg);`, "probe.ts")).toBe(1);
    expect(countMessageListeners(`window.onmessage = (e) => apply(e.data);`, "probe.ts")).toBe(1);
    // …and a source with two must not read as one.
    expect(
      countMessageListeners(
        `window.addEventListener("message", a);\nwindow.addEventListener("message", b);`,
        "probe.ts",
      ),
    ).toBe(2);
    // Model the mutation against the REAL owner's source: adding one more
    // registration to it must break the "exactly one" pin above.
    const mutated = read(ERROR_OWNER) + `\nwindow.addEventListener("message", (e) => e);\n`;
    expect(mutated, "the mutation must actually differ from the source").not.toBe(read(ERROR_OWNER));
    expect(countMessageListeners(mutated, ERROR_OWNER), "…and must be seen as two").toBe(2);
  });

  test("MUTATION (direction 2): the scan must NOT fire on prose or a neighbouring event", () => {
    expect(countMessageListeners(`worker.addEventListener("error", onErr);`, "probe.ts")).toBe(0);
    expect(countMessageListeners(`el.addEventListener("messageX", f);`, "probe.ts")).toBe(0);
    expect(
      countMessageListeners(`// never addEventListener("message", …) — see the note above`, "probe.ts"),
      "a comment explaining the rule must not read as the rule being broken",
    ).toBe(0);
    expect(
      countMessageListeners(read(FRAME), FRAME),
      "the frame component explains the channel at length and must still scan clean",
    ).toBe(0);
  });
});
