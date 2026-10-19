// @vitest-environment jsdom
/**
 * UNTRUSTED CONTENT, RENDERED FOR REAL — the runtime half of the render
 * sanitization guard (the static half is render-sanitization-owner.test.ts).
 *
 * A source scan proves no injection SINK exists. This proves the outcome:
 * hostile model output and hostile tool output go through the actual
 * components, and nothing becomes an element. Both halves are needed —
 * the scan would miss a sink introduced through an alias, and this would
 * miss a sink on a code path no fixture happens to hit.
 *
 * The payloads are the ones that actually ship in the wild: raw tags,
 * event-handler attributes, and every scheme trick that beats a naive
 * `startsWith("javascript:")` check — case games, tab/newline obfuscation,
 * `data:` documents, and protocol-relative hosts.
 *
 * ALSO asserted here, because it is the other half of "honest": the
 * dangerous input is not merely defused, it is still SHOWN. A renderer that
 * silently dropped hostile text would pass an XSS test while lying to the
 * reader about what the model said.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import CodeBlock from "../../src/cockpit/render/CodeBlock.svelte";
import JsonNode from "../../src/cockpit/render/JsonNode.svelte";
import MdInline from "../../src/cockpit/render/MdInline.svelte";
import Prose from "../../src/cockpit/render/Prose.svelte";
import ToolOutput from "../../src/cockpit/render/ToolOutput.svelte";
import UnifiedDiff from "../../src/cockpit/render/UnifiedDiff.svelte";
import { parseUnifiedDiff } from "../../src/cockpit/render/diff.ts";

afterEach(cleanup);

/** Element kinds that must NEVER appear from rendered content. */
const FORBIDDEN = "script, iframe, object, embed, svg, img, link, style, form, base, meta";

function assertInert(root: HTMLElement, label: string): void {
  const bad = root.querySelectorAll(FORBIDDEN);
  expect(
    Array.from(bad).map((e) => e.tagName),
    `${label}: content became live elements`,
  ).toEqual([]);
  // No inline event handler survived onto any element.
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.toLowerCase().startsWith("on"), `${label}: ${attr.name} attribute`).toBe(
        false,
      );
    }
  }
}

/** Every href actually present in the rendered output. */
function hrefs(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("model prose: raw markup is text, never structure", () => {
  const PAYLOADS: readonly (readonly [string, string])[] = [
    ["a script tag", "<script>alert(1)</script>"],
    ["an image with an error handler", '<img src=x onerror="alert(1)">'],
    ["an iframe", '<iframe src="https://evil.example"></iframe>'],
    ["an svg handler", "<svg/onload=alert(1)>"],
    ["a style tag", "<style>body{display:none}</style>"],
    ["a broken-out span", "</span><script>alert(1)</" + "script>"],
    ["an html comment", "<!-- <script>alert(1)</script> -->"],
  ];

  for (const [label, payload] of PAYLOADS) {
    test(`${label} renders as characters`, () => {
      const { container } = render(Prose, { props: { text: payload } });
      assertInert(container, label);
      // And it is still visible, VERBATIM — defused, not disappeared. A
      // renderer that stripped hostile text would pass the inertness check
      // while lying to the reader about what the model actually wrote.
      expect(container.textContent ?? "").toContain(payload);
    });
  }

  test("a script tag inside a fenced code block stays text", () => {
    const text = "here:\n\n```html\n<script>alert(1)</" + "script>\n```\n";
    const { container } = render(Prose, { props: { text } });
    assertInert(container, "fenced html");
    expect(container.textContent ?? "").toContain("alert(1)");
  });

  test("hostile content inside a table cell stays text", () => {
    const text = "| a | b |\n| --- | --- |\n| <script>alert(1)</" + "script> | x |\n";
    const { container } = render(Prose, { props: { text } });
    assertInert(container, "table cell");
    expect(container.querySelectorAll("td").length).toBeGreaterThan(0);
  });
});

describe("links: the scheme allowlist holds against every obfuscation", () => {
  const UNSAFE: readonly (readonly [string, string])[] = [
    ["javascript:", "javascript:alert(1)"],
    ["mixed case", "JaVaScRiPt:alert(1)"],
    ["tab-obfuscated", "java\tscript:alert(1)"],
    ["newline-obfuscated", "java\nscript:alert(1)"],
    ["leading whitespace", "   javascript:alert(1)"],
    ["a data document", "data:text/html,<script>alert(1)</" + "script>"],
    ["vbscript", "vbscript:msgbox(1)"],
    ["protocol-relative", "//evil.example/x"],
    ["a bare file path", "file:///etc/passwd"],
  ];

  for (const [label, href] of UNSAFE) {
    test(`${label} never reaches an anchor (via markdown)`, () => {
      const { container } = render(Prose, { props: { text: `[click me](${href})` } });
      expect(hrefs(container), `${label} produced a live link`).toEqual([]);
      // The words survive — the reader still sees what the model wrote.
      expect(container.textContent ?? "").toContain("click me");
    });

    test(`${label} never reaches an anchor (node injected straight into the renderer)`, () => {
      // DEFENCE IN DEPTH: bypass the parser entirely and hand the renderer a
      // link node it should refuse. This is the mutation that proves the
      // render-time half of the allowlist is real and not decorative — if
      // MdInline stopped calling isSafeUrl, only THIS test would catch it.
      const { container } = render(MdInline, {
        props: { nodes: [{ type: "link", href, children: [{ type: "text", text: "click me" }] }] },
      });
      expect(hrefs(container), `${label} produced a live link`).toEqual([]);
      expect(container.textContent ?? "").toContain("click me");
    });
  }

  test("a real https link IS rendered, and carries noopener/noreferrer", () => {
    const { container } = render(Prose, {
      props: { text: "[docs](https://example.com/a?b=1#c)" },
    });
    const a = container.querySelector("a");
    expect(a, "an http(s) link must render").not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com/a?b=1#c");
    const rel = a!.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  test("a mailto link IS rendered", () => {
    const { container } = render(Prose, { props: { text: "[mail](mailto:a@b.example)" } });
    expect(hrefs(container)).toEqual(["mailto:a@b.example"]);
  });
});

describe("tool output: every shape defuses its content", () => {
  test("a command's stdout containing markup stays text", () => {
    const { container } = render(ToolOutput, {
      props: {
        name: "execute_command",
        input: { command: "cat x.html" },
        output: { stdout: "<script>alert(1)</" + "script>", exitCode: 0 },
        maxLines: 50,
      },
    });
    assertInert(container, "command stdout");
    expect(container.textContent ?? "").toContain("alert(1)");
  });

  test("file content containing markup stays text and is highlighted as tokens", () => {
    const { container } = render(ToolOutput, {
      props: {
        name: "read_file",
        input: { path: "index.html" },
        output: "<script>alert(1)</" + "script>",
        maxLines: 50,
      },
    });
    assertInert(container, "file content");
    expect(container.textContent ?? "").toContain("alert(1)");
  });

  test("a JSON value with markup in a key AND a value stays text", () => {
    const { container } = render(JsonNode, {
      props: { value: { "<img src=x onerror=alert(1)>": "</script><iframe>" } },
    });
    assertInert(container, "json tree");
    expect(container.textContent ?? "").toContain("onerror");
  });

  test("search results with markup in the path stay text", () => {
    const { container } = render(ToolOutput, {
      props: {
        name: "search_code",
        input: { query: "x" },
        output: "<script>a.ts:1:hit one\n<img>b.ts:2:hit two\n",
        maxLines: 50,
      },
    });
    assertInert(container, "search results");
  });
});

describe("diffs: patch content is data, not markup", () => {
  test("a patch whose lines contain tags renders them as text", () => {
    const patch = [
      "diff --git a/x.html b/x.html",
      "--- a/x.html",
      "+++ b/x.html",
      "@@ -1,2 +1,2 @@",
      "-<div>old</div>",
      '+<script>alert(1)</' + "script>",
      " <p>context</p>",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiff(patch);
    const { container } = render(UnifiedDiff, { props: { parsed, patch } });
    assertInert(container, "diff body");
    expect(container.textContent ?? "").toContain("alert(1)");
    expect(container.textContent ?? "").toContain("context");
  });
});

describe("code blocks: the highlighter cannot introduce structure", () => {
  test("source that looks like our own token markup renders as characters", () => {
    // If highlighting were string concatenation, this input would close our
    // span and open a real one. Because it is tokens, it is just source.
    const code = '</span><span class="x" onclick="alert(1)">pwned</span>';
    const { container } = render(CodeBlock, { props: { code, lang: "html" } });
    assertInert(container, "code block");
    expect(container.textContent ?? "").toContain("pwned");
  });

  test("highlighting preserves the source exactly (no character is lost)", () => {
    const code = 'const a = "x < y && z > w"; // <b>note</b>\nreturn a;';
    const { container } = render(CodeBlock, { props: { code, lang: "ts" } });
    const rendered = container.querySelector("code")?.textContent ?? "";
    // The rendered code text is the source, verbatim (plus the trailing
    // newline each row carries).
    expect(rendered.replace(/\n+$/, "")).toBe(code);
  });
});
