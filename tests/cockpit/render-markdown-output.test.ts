// @vitest-environment jsdom
/**
 * MARKDOWN TOOL OUTPUT — a tool's markdown DOCUMENT renders as
 * prose through the one prose owner, and everything else stays raw.
 *
 * The failure this file exists to prevent is MISCLASSIFICATION IN THE RAW
 * DIRECTION: command stdout dressed as prose would silently reflow the very
 * whitespace that IS the output. So the negative cases dominate — the
 * detection rule (shapes.ts::looksLikeMarkdown: at least two distinct
 * block-level constructs, judged only on the leftover `text` shape) is
 * driven in BOTH directions, and the command doctrine is proven unoverridable
 * by content.
 */
import { afterEach, describe, expect, test } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import { classifyOutput, looksLikeMarkdown } from "../../src/cockpit/render/shapes.ts";
import { linkifyStreamText } from "../../shared/markdown.ts";
import ToolOutput from "../../src/cockpit/render/ToolOutput.svelte";
import { setTools } from "../../src/state/tools.ts";
import type { WebToolEntry } from "../../shared/types.ts";

/**
 * The manifest entries the rendered ToolOutput reads its declared output
 * shape from. `execute_command` declares `command` (its streams are never
 * re-interpreted); the rest declare none and fall through to the value's own
 * structure. Seeded so the component under test reads the registry's answer.
 */
function manifestEntry(name: string, outputShape?: "file" | "command" | "search"): WebToolEntry {
  return {
    id: name,
    name,
    description: `${name} tool`,
    inputSchema: {},
    capabilities: Object.freeze(["read"]),
    bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 },
    adapterId: "adapter",
    category: "built-in",
    kind: "system",
    ...(outputShape !== undefined ? { outputShape } : {}),
  };
}
setTools([
  manifestEntry("execute_command", "command"),
  manifestEntry("read_file", "file"),
  manifestEntry("fetch_docs"),
]);

const README = [
  "# Getting started",
  "",
  "Install the thing:",
  "",
  "- clone the repository",
  "- run the installer",
  "",
  "## Notes",
  "",
  "See the guide.",
].join("\n");

describe("looksLikeMarkdown — two distinct block constructs, or nothing", () => {
  test("a heading plus a list is a document", () => {
    expect(looksLikeMarkdown(README)).toBe(true);
  });

  test("a heading plus a closed fence is a document", () => {
    expect(looksLikeMarkdown("# api\n\n```ts\nconst a = 1;\n```\n")).toBe(true);
  });

  test("a table with its separator plus a blockquote is a document", () => {
    expect(
      looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n> words\n"),
    ).toBe(true);
  });

  test("shell-style # comments alone are NOT markdown — one construct is refused", () => {
    expect(looksLikeMarkdown("# deploy config\nhost=prod\n# do not edit\nport=443\n")).toBe(false);
  });

  test("a lone closed fence is how logs quote code, not a document", () => {
    expect(looksLikeMarkdown("output follows\n```\nsome quoted text\n```\n")).toBe(false);
  });

  test("a bare list alone stays raw", () => {
    expect(looksLikeMarkdown("- item one\n- item two\n- item three\n")).toBe(false);
  });

  test("an UNCLOSED fence never counts as one", () => {
    expect(looksLikeMarkdown("# title\n```ts\ntruncated mid-stream")).toBe(false);
  });

  test("build-log prose with dashes and columns stays raw", () => {
    expect(
      looksLikeMarkdown("PASS src/a.test.ts\nPASS src/b.test.ts\n  - 12 assertions\nDone in 3.2s\n"),
    ).toBe(false);
  });
});

describe("classifyOutput — where the markdown shape may and may not appear", () => {
  test("leftover text that is a document classifies as markdown, carrying the string verbatim", () => {
    const s = classifyOutput({}, README);
    expect(s).toMatchObject({ kind: "markdown", text: README });
  });

  test("command stdout is NEVER markdown, however document-shaped", () => {
    expect(classifyOutput({ command: "cat README.md" }, README, "command").kind).toBe(
      "command",
    );
    const structured = classifyOutput({ command: "cat README.md" },
      { stdout: README, exitCode: 0 },
      "command",
    );
    expect(structured.kind).toBe("command");
  });

  test("a file reader's content stays the file shape — a read shows the file", () => {
    expect(classifyOutput({ path: "README.md" }, README, "file").kind).toBe("file");
  });

  test("non-document text stays the text shape", () => {
    expect(classifyOutput({}, "plain sentence with no structure").kind).toBe("text");
  });
});

describe("ToolOutput — rendered both directions", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  function render(name: string, output: unknown): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(ToolOutput, { target: host, props: { name, input: {}, output, maxLines: 16 } });
    flushSync();
    return host;
  }

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  test("a markdown document renders through Prose — a real heading, no raw pre", () => {
    const el = render("fetch_docs", README);
    expect(el.querySelector(".prose")).not.toBeNull();
    // MdBlocks renders headings as role="heading" (untrusted content must not
    // enter the app's real outline) — that is the evidence of a parsed tree.
    const heading = el.querySelector('[role="heading"]');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe("Getting started");
    expect(el.querySelector("pre.stream")).toBeNull();
  });

  test("the same document as command stdout stays a raw pre — whitespace is the output", () => {
    const el = render("execute_command", { stdout: README, exitCode: 0 });
    expect(el.querySelector(".prose")).toBeNull();
    const pre = el.querySelector("pre.stream");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain("# Getting started");
  });
});


// ── STREAM LINKIFY (merged: the other half of the rendered-output contract) —
// bare URLs in a tool's plain streams become walkable links, through the ONE
// allowlist, without the stream's text changing by a single byte. The raw-
// text law: segments reassemble to the input exactly, so selection-copy and
// the copy button stay verbatim; code blocks are NOT linkified.

describe("linkifyStreamText — the judgement", () => {
  test("http and https URLs become link segments with the raw words", () => {
    const got = linkifyStreamText("see https://example.com/a?b=1 and http://other.io");
    expect(got).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/a?b=1", text: "https://example.com/a?b=1" },
      { kind: "text", text: " and " },
      { kind: "link", href: "http://other.io", text: "http://other.io" },
    ]);
  });

  test("trailing sentence punctuation stays text, not URL", () => {
    const got = linkifyStreamText("failed: https://ci.example/run/9.");
    expect(got.at(-1)).toEqual({ kind: "text", text: "." });
    expect(got[1]).toMatchObject({ kind: "link", href: "https://ci.example/run/9" });
  });

  test("only http(s): mailto, ftp and scheme smuggling stay plain text", () => {
    for (const s of [
      "write mailto:a@b.example please",
      "get ftp://files.example/x",
      "run javascript:alert(1) now",
      "xhttps://not-a-boundary.example",
    ]) {
      expect(
        linkifyStreamText(s).every((seg) => seg.kind === "text"),
        `${s} must produce no link`,
      ).toBe(true);
    }
  });

  test("THE RAW-TEXT LAW: segments reassemble to the input byte-for-byte", () => {
    for (const s of [
      "plain words, no urls",
      "see https://example.com/a?b=1 and http://other.io.",
      "(https://a.example) [https://b.example]…\nnext line http://c.example",
      "curl https://x.example | tee log\n\ttab\u0000nul",
      "",
    ]) {
      expect(
        linkifyStreamText(s)
          .map((seg) => seg.text)
          .join(""),
      ).toBe(s);
    }
  });
});

describe("the rendered streams", () => {
  let slHost: HTMLElement | null = null;
  let slApp: object | null = null;

  function render(name: string, input: unknown, output: unknown): HTMLElement {
    slHost = document.createElement("div");
    document.body.appendChild(slHost);
    slApp = mount(ToolOutput, { target: slHost, props: { name, input, output, maxLines: 16 } });
    flushSync();
    return slHost!;
  }

  afterEach(() => {
    if (slApp !== null) unmount(slApp);
    slApp = null;
    slHost?.remove();
    slHost = null;
  });

  test("a URL in command stdout is an anchor with the hardened rel, inside an unchanged stream", () => {
    const stdout = "deployed to https://preview.example/build-42\ndone.";
    const el = render("execute_command", { command: "deploy" }, { stdout, exitCode: 0 });
    const a = el.querySelector<HTMLAnchorElement>("pre.stream a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://preview.example/build-42");
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer");
    // The stream's TEXT did not move: what a selection copies is the output.
    expect(el.querySelector("pre.stream")!.textContent).toBe(stdout);
  });

  test("stderr linkifies too, in its own alarm stream", () => {
    const el = render("execute_command", {}, { stdout: "", stderr: "see https://logs.example/x" });
    expect(el.querySelector("pre.stream.alarm-ink a")).not.toBeNull();
  });

  test("leftover text linkifies; an unsafe scheme in it does NOT", () => {
    const el = render("fetch_docs", {}, "docs at https://d.example — never javascript:alert(1)");
    const anchors = [...el.querySelectorAll("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe("https://d.example");
  });

  test("a FILE's code rendering is not linkified — copyable text semantics untouched", () => {
    const el = render(
      "read_file",
      { path: "README.md" },
      "docs: https://example.com/readme\nmore text\nthird line",
    );
    expect(el.querySelector("pre.code")).not.toBeNull();
    expect(el.querySelectorAll("pre.code a")).toHaveLength(0);
  });
});
