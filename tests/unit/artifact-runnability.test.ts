// @vitest-environment node
/**
 * THE ARTIFACT MUST BE ABLE TO RUN, AND THE TOOL MUST SAY SO HONESTLY.
 *
 * WHAT THIS FILE EXISTS BECAUSE OF. Twelve artifacts were driven end-to-end
 * through a real model and rendered in a real sandboxed frame. Three came
 * back dead on a JavaScript syntax error — including the largest, a 55,096-
 * byte Tetris — and all three had been answered by `create_artifact` with
 * `{"ok":true … "It renders live in the chat below."}`. The user got a dead
 * rectangle; the model got a success and therefore never retried, because a
 * tool result IS the retry protocol and this one said everything was fine.
 *
 * The three real failures are reproduced verbatim below, from the artifacts
 * the model actually emitted:
 *   - an unescaped apostrophe closing a single-quoted string early,
 *   - a Python-style `#` comment banner inside a JavaScript block,
 *   - a missing comma in an object literal.
 * Each one is a fixture, so a regression that stops catching them is a red
 * test rather than a quiet return to shipping dead artifacts.
 *
 * WHAT IS NOT TESTED HERE, deliberately: that a well-formed artifact WORKS.
 * The check parses; it does not execute. A document that compiles and then
 * throws on its first line still passes, and the tests below assert only what
 * the check actually measures.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  ALLOWED_CAPABILITIES,
  DENIED_CAPABILITIES,
  checkArtifactHtml,
  extractScripts,
  sandboxContractSentence,
} from "../../server/safety/artifact-check.ts";
import { executeToolCall, type ToolExecutionContext } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { htmlWithout } from "../../shared/markup.ts";

let ctx: ToolExecutionContext;
beforeEach(() => {
  ctx = { projectRoot: createTempDir("ch-artifact-run-") };
});

function doc(script: string, markup = "<div id=x></div>"): string {
  return `<!DOCTYPE html>\n<html>\n<head><style>body{margin:0}</style></head>\n<body>\n${markup}\n<script>\n${script}\n</script>\n</body>\n</html>\n`;
}

// ── The three real failures, verbatim ────────────────────────────────────

describe("the artifacts that really shipped broken are caught", () => {
  test("an unescaped apostrophe inside a single-quoted string (the 'reachout' artifact)", () => {
    const html = doc(
      "  const nm = window.name || '';\n" +
        "  row('window.name channel', nm ? 'na' : 'blocked',\n" +
        "      nm ? 'Contains data.' : 'Empty — host didn't seed it with conversation data.');",
    );
    const check = checkArtifactHtml(html);
    expect(check.faults.length, "a string closed early is a syntax error").toBe(1);
    expect(check.faults[0]!.kind).toBe("script_syntax");
    expect(check.faults[0]!.message).toContain("syntax error");
  });

  test("a Python-style comment banner in a JavaScript block (the 55KB 'Tetris' artifact)", () => {
    const html = doc(
      '"use strict";\n' +
        "#==========================================================================#\n" +
        "#  TETRIS — complete clone                                                 #\n" +
        "#==========================================================================#\n" +
        "let board = [];",
    );
    const check = checkArtifactHtml(html);
    expect(check.faults.length).toBe(1);
    expect(check.faults[0]!.message).toContain("Invalid or unexpected token");
  });

  test("a missing comma in an object literal (the 'countdown timer' artifact)", () => {
    const html = doc("  const cfg = {\n    initialMinutes: 5,\n    initialSeconds: 0\n    updateIntervalMs: 1000\n  };");
    const check = checkArtifactHtml(html);
    expect(check.faults.length).toBe(1);
    expect(check.faults[0]!.message).toContain("updateIntervalMs");
  });
});

// ── The error must be worth a retry ──────────────────────────────────────

describe("the failure the MODEL receives is actionable, because it is the retry", () => {
  test("the tool FAILS on an unrunnable artifact rather than reporting success", async () => {
    const res = await executeToolCall(
      "create_artifact",
      { type: "html", title: "Broken", content: doc("const a = {b: 1 c: 2};") },
      ctx,
    );
    expect(res.success, "a document that cannot run must not be reported as created").toBe(false);
  });

  test("…and never claims the artifact is rendering", async () => {
    const res = await executeToolCall(
      "create_artifact",
      { type: "html", title: "Broken", content: doc("const a = {b: 1 c: 2};") },
      ctx,
    );
    expect(res.output).not.toContain("renders live");
    expect(res.output).toContain("NOT created");
    expect(res.output, "the user must not be told something was shown to them").toContain(
      "Nothing was shown to the user",
    );
  });

  test("the message carries the parser's own words, the line, and the source line", async () => {
    const res = await executeToolCall(
      "create_artifact",
      { type: "html", title: "Broken", content: doc("const cfg = {\n  a: 1\n  b: 2\n};") },
      ctx,
    );
    // The script begins on line 7 of the fixture document, so the offending
    // `b: 2` is line 9 — reported against the DOCUMENT, which is the only
    // numbering the model can act on.
    expect(res.output).toMatch(/line \d+ of the document/);
    expect(res.output, "the offending source must be quoted back").toContain("b: 2");
    expect(res.output, "and it must ask for the corrected document").toContain("call create_artifact again");
  });

  test("the reported line really is the artifact's line, not the script's", () => {
    const before = "x".repeat(10);
    const html = `<!DOCTYPE html>\n<p>${before}</p>\n<p>filler</p>\n<p>filler</p>\n<script>\nlet ok = 1;\nlet bad = {a: 1 b: 2};\n</script>`;
    const check = checkArtifactHtml(html);
    expect(check.faults.length).toBe(1);
    // `<script>` is on line 5, its body starts on line 6, `let ok` is line 6,
    // the bad line is line 7.
    expect(check.faults[0]!.message).toContain("line 7 of the document");
  });
});

// ── No false positives: the working artifacts stay working ───────────────

describe("nothing that runs is refused", () => {
  const REAL_SHAPES: readonly (readonly [string, string])[] = [
    ["a canvas animation loop", "const c=document.createElement('canvas');const x=c.getContext('2d');(function f(){x.clearRect(0,0,10,10);requestAnimationFrame(f);})();"],
    ["template literals with nested quotes", "const t = `a ${'b'} c ${`d ${1+1}`}`; document.title = t;"],
    ["a regex containing a slash and a quote", "const re = /['\\/]+/g; console.log('x'.replace(re,''));"],
    ["async/await and optional chaining", "async function go(){ const o = {a:{b:1}}; return o?.a?.b ?? 0; } go();"],
    ["classes, getters and private fields", "class P { #n=1; get n(){return this.#n;} } new P().n;"],
    ["an HTML-like comment, which is legal in a classic script", "<!-- a comment\nlet z = 1;"],
    ["emoji and non-ASCII in strings", "const s = '🎮 — Neon Striker · ünïcøde'; document.title = s;"],
  ];
  for (const [name, script] of REAL_SHAPES) {
    test(`${name} compiles clean`, () => {
      const check = checkArtifactHtml(doc(script));
      expect(check.faults, `${name} must not be refused`).toEqual([]);
      expect(check.scriptsChecked).toBe(1);
    });
  }

  test("a document with no script at all is fine and reports zero checked", () => {
    const check = checkArtifactHtml("<!DOCTYPE html><table><tr><td>1</td></tr></table>");
    expect(check.faults).toEqual([]);
    expect(check.scriptsChecked).toBe(0);
  });

  test("the executor accepts every shape above", async () => {
    for (const [name, script] of REAL_SHAPES) {
      const res = await executeToolCall("create_artifact", { type: "html", title: name, content: doc(script) }, ctx);
      expect(res.success, `${name} must be accepted`).toBe(true);
    }
  });
});

// ── What is skipped is REPORTED as skipped, never as checked ─────────────

describe("nothing is claimed that was not measured", () => {
  test("a type=module script is not compiled, and is counted as skipped", () => {
    const html = '<script type="module">import x from "./x.js"; export const y = x;</script>';
    const check = checkArtifactHtml(html);
    expect(check.faults, "a module must not be judged by a script parser").toEqual([]);
    expect(check.scriptsChecked).toBe(0);
    expect(check.scriptsSkipped).toBe(1);
  });

  test("a non-JavaScript script block (JSON data) is skipped, not parsed", () => {
    const html = '<script type="application/json">{"a": 1}</script>';
    const check = checkArtifactHtml(html);
    expect(check.faults).toEqual([]);
    expect(check.scriptsSkipped).toBe(1);
  });

  test("the success message states how many were checked AND how many were not", async () => {
    const html = '<script type="module">export const a = 1;</script><script>var b = 1;</script>';
    const res = await executeToolCall("create_artifact", { type: "html", title: "mixed", content: html }, ctx);
    expect(res.success).toBe(true);
    const out = JSON.parse(res.output) as { scriptsChecked: number; scriptsSkipped: number; message: string };
    expect(out.scriptsChecked).toBe(1);
    expect(out.scriptsSkipped).toBe(1);
    expect(out.message, "a skipped block must not hide behind the word clean").toContain("1 not checked");
  });

  test("a document cut off mid-script is refused as cut off, not mis-parsed", async () => {
    const html = "<!DOCTYPE html><body><script>\nfunction go(){\n  const a = 1;";
    const check = checkArtifactHtml(html);
    expect(check.faults.some((f) => f.kind === "unterminated_script")).toBe(true);
    const res = await executeToolCall("create_artifact", { type: "html", title: "cut", content: html }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain("cut off");
  });
});

// ── The sandbox contract: one owner, told and measured the same ──────────

describe("the sandbox contract the model is TOLD is the one it is MEASURED against", () => {
  test("every denied capability named in the tool description is one the checker warns about", () => {
    const entry = getToolManifest().find((e) => e.name === "create_artifact")!;
    const description = entry.description;
    for (const cap of DENIED_CAPABILITIES) {
      expect(
        description,
        `the model must be told '${cap.name}' is unavailable, since it is warned about after the fact`,
      ).toContain(cap.name);
    }
  });

  test("every allowed capability named in the table reaches the description", () => {
    const entry = getToolManifest().find((e) => e.name === "create_artifact")!;
    for (const allowed of ALLOWED_CAPABILITIES) {
      expect(entry.description).toContain(allowed);
    }
  });

  test("the description is GENERATED, not a second copy that can drift", () => {
    const entry = getToolManifest().find((e) => e.name === "create_artifact")!;
    expect(entry.description).toContain(sandboxContractSentence());
  });

  test("reaching for localStorage warns — the failure that killed a real game", async () => {
    // "Neon Striker": `let best = +(localStorage.getItem('neonstriker_best')||0);`
    // at the top of the script. It throws SecurityError, the throw kills the
    // rest of the script, and the user gets a perfect title screen attached
    // to a dead engine with nothing anywhere saying why.
    const res = await executeToolCall(
      "create_artifact",
      { type: "game", title: "Neon Striker", content: doc("let best = +(localStorage.getItem('best')||0);") },
      ctx,
    );
    expect(res.success, "it still runs — the warning is not a refusal").toBe(true);
    const out = JSON.parse(res.output) as { warnings?: string[] };
    expect(out.warnings, "the model must be told what it reached for").toBeDefined();
    expect(out.warnings!.join(" ")).toContain("localStorage");
    expect(out.warnings!.join(" "), "and what actually happens").toContain("SecurityError");
  });

  test("reaching for the network warns", async () => {
    const res = await executeToolCall(
      "create_artifact",
      { type: "html", title: "weather", content: doc("fetch('https://api.example.com/x').then(r=>r.json());") },
      ctx,
    );
    const out = JSON.parse(res.output) as { warnings?: string[] };
    expect(out.warnings!.join(" ")).toContain("connect-src 'none'");
  });

  test("a clean artifact carries no warnings key at all (absence is absence)", async () => {
    const res = await executeToolCall("create_artifact", { type: "html", title: "clean", content: doc("var a = 1;") }, ctx);
    const out = JSON.parse(res.output) as Record<string, unknown>;
    expect("warnings" in out).toBe(false);
  });

  test("the capability scan reads SCRIPT source, not prose in the markup", () => {
    const html = doc("var a = 1;", "<p>This widget does not use localStorage or fetch.</p>");
    const check = checkArtifactHtml(html);
    expect(check.warnings, "a word in a paragraph is not a use of the API").toEqual([]);
  });
});

// ── The size bound, measured against what artifacts really need ──────────

describe("the size bound says something true and actionable", () => {
  test("the refusal states both numbers and does not suggest splitting (an artifact is one document)", async () => {
    const res = await executeToolCall(
      "create_artifact",
      { type: "html", title: "big", content: "a".repeat(600_000) },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("600000");
    expect(res.output).toContain("exceeds");
    expect(res.output, "there is no second call to continue into").toContain("cannot be continued across calls");
    expect(res.output).not.toContain("Split");
  });
});

// ── Mutation self-checks: the guards bite ────────────────────────────────

describe("mutation self-checks — each guard fails when its subject is broken", () => {
  test("removing the syntax check would let the three real failures through", () => {
    // The instrument is `checkArtifactHtml`. Prove it is the thing deciding,
    // by feeding it the mutation's input (a document with no scripts at all,
    // which is what "skip the check" degenerates to) and seeing the fault
    // disappear.
    const broken = doc("const a = {b: 1 c: 2};");
    expect(checkArtifactHtml(broken).faults.length).toBe(1);
    const withoutScripts = htmlWithout(broken, { elements: ["script"] });
    expect(
      checkArtifactHtml(withoutScripts).faults.length,
      "if the checker stopped reading scripts, this is what it would see — and the guard above would go green wrongly",
    ).toBe(0);
  });

  test("a checker that treated modules as classic scripts would report a false fault", () => {
    const moduleSrc = 'import x from "./x.js"; export const y = x;';
    // Compiled as a CLASSIC script this is a syntax error; the extractor's
    // skip is what prevents the false accusation, so the skip must be real.
    const blocks = extractScripts(`<script type="module">${moduleSrc}</script>`);
    expect(blocks[0]!.skipReason, "the skip must be recorded, not implicit").not.toBeNull();
    expect(checkArtifactHtml(`<script type="module">${moduleSrc}</script>`).faults).toEqual([]);
    // …and the same source WITHOUT the module type is genuinely a fault, so
    // the skip is doing work rather than hiding everything.
    expect(checkArtifactHtml(`<script>${moduleSrc}</script>`).faults.length).toBe(1);
  });

  test("a warning promoted to a fault would refuse artifacts that really run", async () => {
    // localStorage guarded by try/catch is legitimate — one battle-test
    // artifact did exactly this and worked. If the warning ever became a
    // fault, this artifact would stop being created.
    const guarded = doc("try { localStorage.setItem('k','v'); } catch (e) { /* in-memory */ }");
    const check = checkArtifactHtml(guarded);
    expect(check.faults).toEqual([]);
    expect(check.warnings.length).toBe(1);
    expect((await executeToolCall("create_artifact", { type: "html", title: "g", content: guarded }, ctx)).success).toBe(true);
  });
});
