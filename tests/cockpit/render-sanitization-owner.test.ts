// @vitest-environment node
/**
 * RENDER SANITIZATION OWNER — a renderer that can emit unsanitized HTML
 * fails CI.
 *
 * The cockpit's rich renderers (src/cockpit/render/**) exist to make model
 * output and tool output read well. Both are UNTRUSTED: the model writes
 * whatever it writes, and a tool's output is whatever a file or a command
 * happened to contain. The single invariant that keeps that safe is
 * structural, not incidental:
 *
 *   NOTHING in the cockpit may hand a string to an HTML parser.
 *
 * Every renderer emits DATA (markdown nodes, highlight tokens, diff pieces)
 * and Svelte interpolates it with `{value}`, producing text nodes. There is
 * no `{@html}`, no `innerHTML`, no `insertAdjacentHTML`, no
 * `Range.createContextualFragment` — so a `<script>` in a model's answer is
 * five characters of text and cannot become an element no matter what.
 *
 * ── THE ONE EXCEPTION, AND WHERE ITS FENCE IS ─────────────────────────────
 *
 * An ARTIFACT is a whole HTML document the model wrote in order to be RUN;
 * refusing to parse it would be refusing the feature. It is the single place
 * in the cockpit where a string is handed to an HTML parser, and the parser
 * it is handed to is not this document's: it goes into an `<iframe srcdoc>`
 * whose sandbox has no `allow-same-origin`, so it is parsed into an opaque
 * origin that cannot see this page.
 *
 * The exception is BOUNDED rather than trusted, and the fence is next door in
 * tests/cockpit/artifact-containment.test.ts: `srcdoc` and `<iframe>` may
 * appear in exactly one cockpit file, the sandbox may not widen, the document
 * may not reach this page's DOM, and nothing here listens to the frame. This
 * file's sink list is unchanged and still deny-by-default — `srcdoc` is not
 * an entry in it because it is not a sink INTO THIS DOCUMENT.
 *
 * This file guards that mechanically, in three layers:
 *
 *   A. INJECTION SINKS — a scanner over every cockpit source, catching each
 *      way a string could reach the HTML parser. Deny by default: the sink
 *      list is explicit and every entry is MUTATION-TESTED below, so a
 *      weakened scanner turns its own self-checks red.
 *   B. LINK ALLOWLIST OWNERSHIP — the only component that emits an anchor
 *      must consult the scheme allowlist. A renderer that starts emitting
 *      `href` without `isSafeLinkTarget` fails here.
 *   C. SINGLE-RENDERER OWNERSHIP — the parsers have exactly one consumer
 *      each, and the render layer's internals cannot be mounted from
 *      outside it. This is what stops an "ad-hoc markdown" path appearing
 *      later that bypasses the safe one.
 *
 * The runtime half — actually feeding hostile input through the real
 * components and asserting no element is created — lives in
 * tests/cockpit/render-untrusted.test.ts (jsdom).
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripCommentsAndStringsFor, walk } from "../helpers/source-scan.ts";

const COCKPIT_ROOT = "src/cockpit";
const RENDER_ROOT = "src/cockpit/render";

/**
 * Every way a string can become parsed markup in a browser. Each entry is a
 * SINK: the danger is not the name, it is that the argument is parsed as
 * HTML. Deny-by-default — adding a renderer that needs one of these is not
 * a matter of editing the list, it is a design change.
 */
const SINKS: readonly Readonly<{ re: RegExp; why: string }>[] = [
  { re: /\{@html\b/, why: "{@html} injects raw markup — untrusted content must interpolate as {value}" },
  { re: /\.innerHTML\s*=/, why: "innerHTML assignment parses its string as HTML" },
  { re: /\.outerHTML\s*=/, why: "outerHTML assignment parses its string as HTML" },
  { re: /\binsertAdjacentHTML\s*\(/, why: "insertAdjacentHTML parses its string as HTML" },
  { re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/, why: "document.write parses its string as HTML" },
  { re: /\bcreateContextualFragment\s*\(/, why: "createContextualFragment parses its string as HTML" },
  { re: /\.setHTML\s*\(/, why: "setHTML parses its string as HTML" },
  { re: /\bnew\s+Function\s*\(/, why: "new Function compiles a string as code" },
  { re: /(?<![\w.])eval\s*\(/, why: "eval compiles a string as code" },
  { re: /\bdangerouslySetInnerHTML\b/, why: "a raw-markup escape hatch" },
];

/**
 * Scan ONE cockpit source for injection sinks. Pure — the mutation tests
 * below drive it directly with synthetic sources.
 *
 * Comments AND string literals are stripped first: a doc comment that
 * *names* `{@html}` (this codebase has several, explaining why it is
 * forbidden) must not read as a use of it, and neither must a test fixture
 * string. That is why the scanner works on stripped code, not raw text.
 */
export function findInjectionSinks(file: string, src: string): string[] {
  // The mode is the FILE's: `.svelte` sources lex as templates, code files
  // as code — a `//` comment is prose in markup and comment material in
  // code, and reading one as the other manufactures or hides offenders.
  const code = stripCommentsAndStringsFor(src, file);
  const out: string[] = [];
  for (const sink of SINKS) {
    if (sink.re.test(code)) out.push(`${file}: ${sink.why}`);
  }
  return out;
}

/**
 * Scan a render-layer source for an UNGATED anchor: a component that emits
 * an `href` attribute must reference the scheme allowlist (`isSafeLinkTarget`).
 * Rendering a model-supplied href without it is how `javascript:` ships.
 */
export function findUngatedAnchors(file: string, src: string): string[] {
  const code = stripCommentsAndStringsFor(src, file);
  // `href=` survives stripping (the VALUE is stripped, the attribute is not).
  if (!/\bhref\s*=/.test(code)) return [];
  if (/\bisSafeLinkTarget\b/.test(code)) return [];
  return [`${file}: emits an href without consulting the isSafeLinkTarget allowlist`];
}

/** Files whose raw source imports `spec` (substring match on the specifier). */
function importersOf(spec: string, files: readonly string[]): string[] {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`from\\s+["'][^"']*${escaped}["']`);
  return files.filter((f) => re.test(read(f)));
}

/**
 * Dev harnesses (`src/cockpit/**\/dev/**`) are standalone pages with their
 * own entry points, used to drive a component against SYNTHETIC data. They
 * are not product surfaces and never render recorded content, so they are
 * out of scope for the injection scan — a dev page building its own static
 * chrome with a template literal is not an untrusted-content path.
 *
 * This exclusion is deliberately narrow AND is itself guarded: the test
 * "a dev harness is never reachable from a product surface" below proves
 * nothing in the shipped tree imports a dev module. Without that second
 * test, `dev/` would be a place to hide a sink.
 */
const DEV_PATH = /(^|\/)dev\//;

describe("A. no injection sink exists anywhere in the cockpit", () => {
  const allFiles = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);
  const shipped = allFiles.filter((f) => !DEV_PATH.test(f));

  test("the cockpit tree is populated (the scan is not vacuous)", () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  test("no cockpit source can hand a string to the HTML parser", () => {
    const findings: string[] = [];
    for (const f of shipped) findings.push(...findInjectionSinks(f, read(f)));
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("a dev harness is never reachable from a product surface", () => {
    // Keeps the dev/ exclusion above from becoming a hiding place: if a
    // shipped component ever imports a dev module, the excluded code is
    // suddenly on a product path and this fails.
    const violations: string[] = [];
    for (const f of shipped) {
      for (const m of read(f).matchAll(/from\s+["']([^"']*\/dev\/[^"']*)["']/g)) {
        violations.push(`${f} imports the dev module "${m[1]!}"`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("every render-layer source IS scanned (the exclusion never covers it)", () => {
    const rendered = shipped.filter((f) => f.startsWith(`${RENDER_ROOT}/`));
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.filter((f) => DEV_PATH.test(f))).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS: every sink must be caught ────────────────────
  // The synthetic sources are assembled so this file's own scanners cannot
  // be fooled into passing by a weakened regex.

  const AT = "src/cockpit/render/Example.svelte";

  test("mutation: {@html} is caught", () => {
    expect(findInjectionSinks(AT, "<div>{@html body}</div>")).toHaveLength(1);
  });

  test("mutation: innerHTML assignment is caught", () => {
    expect(findInjectionSinks(AT, "<script>node.innerHTML = body;</" + "script>")).toHaveLength(1);
  });

  test("mutation: outerHTML assignment is caught", () => {
    expect(findInjectionSinks(AT, "el.outerHTML = markup;")).toHaveLength(1);
  });

  test("mutation: insertAdjacentHTML is caught", () => {
    expect(findInjectionSinks(AT, "el.insertAdjacentHTML('beforeend', s);")).toHaveLength(1);
  });

  test("mutation: document.write is caught", () => {
    expect(findInjectionSinks(AT, "document.write(s);")).toHaveLength(1);
    expect(findInjectionSinks(AT, "document . writeln( s );")).toHaveLength(1);
  });

  test("mutation: createContextualFragment is caught", () => {
    expect(findInjectionSinks(AT, "range.createContextualFragment(s);")).toHaveLength(1);
  });

  test("mutation: setHTML is caught", () => {
    expect(findInjectionSinks(AT, "el.setHTML(s);")).toHaveLength(1);
  });

  test("mutation: new Function and eval are caught", () => {
    expect(findInjectionSinks(AT, "const f = new Function(src);")).toHaveLength(1);
    expect(findInjectionSinks(AT, "const v = eval(src);")).toHaveLength(1);
  });

  test("mutation: dangerouslySetInnerHTML is caught", () => {
    expect(findInjectionSinks(AT, "dangerouslySetInnerHTML")).toHaveLength(1);
  });

  test("mutation: a sink hidden inside a comment or string is NOT a false positive", () => {
    // This is exactly how the real render sources document the rule. The
    // mixed fragment names its parts: the markup lines ride a `.svelte`
    // probe (its `<!-- -->` comment is markup-comment material), and the
    // code lines ride a `.ts` probe (its `//` comment and string literal
    // are code material) — the mode is named, never guessed from bytes.
    expect(
      findInjectionSinks(AT, "<!-- never use {@html} on model output -->"),
    ).toEqual([]);
    expect(
      findInjectionSinks("probe.ts", [
        "/* innerHTML is forbidden here */",
        "// eval( ) would be a sink",
        'const doc = "insertAdjacentHTML is banned";',
      ].join("\n")),
    ).toEqual([]);
  });

  test("mutation: ordinary safe rendering is NOT a false positive", () => {
    const clean = "<span class={tok.kind}>{tok.text}</span>";
    expect(findInjectionSinks(AT, clean)).toEqual([]);
  });

  test("mutation: `.eval(` as a method name is NOT a false positive", () => {
    // The sink is the global `eval`, not any member called eval.
    expect(findInjectionSinks(AT, "grammar.eval(node);")).toEqual([]);
  });
});

describe("B. every anchor the render layer emits passes the scheme allowlist", () => {
  const renderFiles = walk(RENDER_ROOT, { exts: [".ts", ".svelte"] });

  test("the render layer exists", () => {
    expect(renderFiles.length).toBeGreaterThan(0);
  });

  test("no render component emits an href without isSafeLinkTarget", () => {
    const findings: string[] = [];
    for (const f of renderFiles) findings.push(...findUngatedAnchors(relpath(f), read(f)));
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("markdown.ts owns the allowlist and it is an ALLOWLIST (not a denylist)", () => {
    const src = read("shared/markdown.ts");
    expect(src, "isSafeLinkTarget must be exported from the parser").toMatch(
      /export\s+function\s+isSafeLinkTarget\b/,
    );
    // An anchored allowlist regex. A denylist (matching "javascript") would
    // be the classic bypassable form; assert we are not doing that.
    expect(src, "the scheme test must be anchored at the start of the URL").toMatch(
      /SAFE_URL\s*=\s*\/\^/,
    );
    expect(src, "no javascript: denylist — the test is an allowlist").not.toMatch(
      /!\s*\/javascript/i,
    );
  });

  // ── MUTATION SELF-CHECKS ───────────────────────────────────────────────

  test("mutation: an href emitted without isSafeLinkTarget is caught", () => {
    const bad = '<a href={node.href} target="_blank">text</a>';
    expect(findUngatedAnchors("src/cockpit/render/Bad.svelte", bad)).toHaveLength(1);
  });

  test("mutation: an href gated by isSafeLinkTarget is NOT flagged", () => {
    const good = [
      "<" + "script>",
      "  import { isSafeLinkTarget } from './markdown.ts';",
      "  const safe = (h) => (isSafeLinkTarget(h) ? h : undefined);",
      "</" + "script>",
      "<a href={safe(node.href)}>text</a>",
    ].join("\n");
    expect(findUngatedAnchors("src/cockpit/render/Ok.svelte", good)).toEqual([]);
  });

  test("mutation: a component with no anchor at all is NOT flagged", () => {
    expect(findUngatedAnchors("src/cockpit/render/None.svelte", "<pre>{code}</pre>")).toEqual([]);
  });
});

describe("C. one renderer per concern — no ad-hoc path can bypass the safe one", () => {
  const cockpitFiles = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] }).map(relpath);

  test("the markdown parser has exactly ONE consumer: Prose.svelte", () => {
    const importers = importersOf("markdown.ts", cockpitFiles).filter(
      (f) => f !== "src/cockpit/render/markdown.ts",
    );
    // MdInline imports the allowlist (isSafeLinkTarget) from the same module — that
    // is the defence-in-depth check, not a second markdown renderer, so it
    // is named explicitly rather than silently tolerated.
    const parserConsumers = importers.filter((f) => /\bparseProse/.test(read(f)));
    expect(parserConsumers, `parseProse must be called from Prose.svelte only:\n${parserConsumers.join("\n")}`).toEqual([
      "src/cockpit/render/Prose.svelte",
    ]);
  });

  test("the highlighter is consumed only by the code renderer and the diff module", () => {
    const importers = importersOf("highlight.ts", cockpitFiles)
      .filter((f) => f !== "src/cockpit/render/highlight.ts")
      .sort();
    expect(importers, `unexpected highlighter consumers:\n${importers.join("\n")}`).toEqual([
      "src/cockpit/render/CodeBlock.svelte",
      "src/cockpit/render/ToolInput.svelte",
      "src/cockpit/render/UnifiedDiff.svelte",
      "src/cockpit/render/diff.ts",
      // grammarForPath only — the shape classifier names a file's language
      // from the path the tool's own input recorded.
      "src/cockpit/render/shapes.ts",
    ]);
  });

  test("the render layer's INTERNAL components are never mounted from outside it", () => {
    // The INTERNAL components: the recursive DOM builders whose props only
    // their own recursion should set (MdInline/MdBlocks) and the JSON tree
    // node (JsonNode — the public door for it is JsonView). Everything else
    // in the layer — including CopyButton, the public copy affordance a
    // cockpit surface may mount on any trusted chrome it renders (the run
    // pane's trace id row) — is the layer's public surface: mounting it
    // from outside is the sanctioned path, and it interpolates its `text`
    // prop as a text node, so it cannot become an injection sink.
    const internals = ["MdInline.svelte", "MdBlocks.svelte", "JsonNode.svelte"];
    const violations: string[] = [];
    for (const internal of internals) {
      for (const importer of importersOf(internal, cockpitFiles)) {
        if (!importer.startsWith(`${RENDER_ROOT}/`)) {
          violations.push(`${importer} mounts the render internal ${internal}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  test("the beats render through the shared layer (no ad-hoc bodies)", () => {
    // Positive ownership: each beat kind's body must come from the render
    // layer. If someone re-inlines a <pre>{output}</pre>, these fail.
    const cases: readonly (readonly [string, readonly string[]])[] = [
      ["src/cockpit/flow/TurnBeat.svelte", ["render/Prose.svelte"]],
      ["src/cockpit/flow/ToolBeat.svelte", ["render/ToolInput.svelte", "render/ToolOutput.svelte"]],
      ["src/cockpit/flow/EffectBeat.svelte", ["render/UnifiedDiff.svelte"]],
      ["src/cockpit/rooms/DiffSheet.svelte", ["render/UnifiedDiff.svelte"]],
    ];
    const missing: string[] = [];
    for (const [file, needs] of cases) {
      const src = read(file);
      for (const need of needs) {
        if (!src.includes(need)) missing.push(`${file} must render through ${need}`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  test("no beat body still dumps JSON.stringify into the template", () => {
    // The pre-v2.1 tool cells did `JSON.stringify(value, null, 1)` straight
    // into a <pre>. That is the shape this pass replaced; a re-introduction
    // is a regression to the "terminal poverty" the user called out.
    const beats = [
      "src/cockpit/flow/ToolBeat.svelte",
      "src/cockpit/flow/EffectBeat.svelte",
      "src/cockpit/flow/TurnBeat.svelte",
    ];
    const violations = beats.filter((f) => /JSON\.stringify/.test(stripCommentsAndStringsFor(read(f), f)));
    expect(violations, `${violations.join(", ")} still stringify-dumps a value`).toEqual([]);
  });
});
