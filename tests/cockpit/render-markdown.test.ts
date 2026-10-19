// @vitest-environment node
/**
 * The markdown parser (src/cockpit/render/markdown.ts) — the safe subset.
 *
 * Two properties matter more than any individual construct:
 *
 *   HONESTY — the parser reports only structure the source actually has. It
 *   never promotes a line to a heading, a list, or a table on a guess, and
 *   over the size cap it says so instead of quietly degrading.
 *
 *   STREAMING SAFETY — every unclosed marker must render as literal text.
 *   The turn body is re-parsed on every token, so a half-arrived `**` or a
 *   fence with no closer must never produce broken or shifting structure.
 */
import { describe, expect, test } from "vitest";

import {
  isSafeLinkTarget,
  parseProse,
  extractMarkdown,
  parseProseBounded,
  type InlineNode,
  type MdBlock,
} from "../../shared/markdown.ts";
import { MAX_MARKDOWN_CHARS } from "../../src/cockpit/render/render-config.ts";

/** Flatten a block tree back to its text, for round-trip style assertions. */
function textOf(nodes: readonly InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return n.text;
        case "code":
          return n.code;
        default:
          return textOf(n.children);
      }
    })
    .join("");
}

function kinds(blocks: readonly MdBlock[]): string[] {
  return blocks.map((b) => b.type);
}

describe("blocks", () => {
  test("headings carry their real level and text", () => {
    const blocks = parseProse("# One\n\n### Three");
    expect(kinds(blocks)).toEqual(["heading", "heading"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 3 });
    expect(textOf((blocks[1] as { children: readonly InlineNode[] }).children)).toBe("Three");
  });

  test("a hash with no space is NOT a heading (no invented structure)", () => {
    expect(kinds(parseProse("#nothashtag"))).toEqual(["paragraph"]);
  });

  test("fenced code keeps its language and its body byte-for-byte", () => {
    const blocks = parseProse("```ts\nconst a = 1;\n  indented\n```");
    expect(blocks[0]).toEqual({ type: "code", lang: "ts", code: "const a = 1;\n  indented" });
  });

  test("a tilde fence works and is not closed by a backtick fence", () => {
    const blocks = parseProse("~~~py\n```\nstill code\n~~~");
    expect(blocks[0]).toEqual({ type: "code", lang: "py", code: "```\nstill code" });
  });

  test("unordered and ordered lists, with nesting", () => {
    const blocks = parseProse("- one\n- two\n  - nested\n");
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as { type: "list"; ordered: boolean; items: readonly { subBlocks: readonly MdBlock[] }[] };
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[1]!.subBlocks)).toEqual(["list"]);
  });

  test("blockquotes re-parse their contents as blocks", () => {
    const blocks = parseProse("> # quoted heading\n> body\n");
    const quote = blocks[0] as { type: "blockquote"; children: readonly MdBlock[] };
    expect(quote.type).toBe("blockquote");
    expect(kinds(quote.children)).toEqual(["heading", "paragraph"]);
  });

  test("a horizontal rule is a rule, but a list item is a list", () => {
    expect(kinds(parseProse("---"))).toEqual(["hr"]);
    expect(kinds(parseProse("- x"))).toEqual(["list"]);
  });
});

describe("tables — only when the delimiter row really makes one", () => {
  test("a header + delimiter row becomes a table with real alignment", () => {
    const blocks = parseProse("| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n");
    const t = blocks[0] as {
      type: "table";
      align: readonly string[];
      header: readonly (readonly InlineNode[])[];
      rows: readonly (readonly (readonly InlineNode[])[])[];
    };
    expect(t.type).toBe("table");
    expect(t.align).toEqual(["left", "center", "right"]);
    expect(t.header.map(textOf)).toEqual(["a", "b", "c"]);
    expect(t.rows.map((r) => r.map(textOf))).toEqual([["1", "2", "3"]]);
  });

  test("pipes WITHOUT a delimiter row stay a paragraph (no invented table)", () => {
    expect(kinds(parseProse("a | b | c\nd | e | f"))).toEqual(["paragraph"]);
  });

  test("a delimiter row whose column count disagrees is not a table", () => {
    expect(kinds(parseProse("| a | b |\n| --- |\n| 1 | 2 |"))).toEqual(["paragraph"]);
  });

  test("an escaped pipe stays inside its cell", () => {
    const blocks = parseProse("| a | b |\n| --- | --- |\n| x \\| y | z |\n");
    const t = blocks[0] as { rows: readonly (readonly (readonly InlineNode[])[])[] };
    expect(t.rows[0]!.map(textOf)).toEqual(["x | y", "z"]);
  });
});

describe("inline", () => {
  test("bold, italic, strikethrough and inline code", () => {
    const p = parseProse("**b** *i* ~~s~~ `c`")[0] as { children: readonly InlineNode[] };
    expect(p.children.map((n) => n.type)).toEqual([
      "bold", "text", "italic", "text", "strike", "text", "code",
    ]);
  });

  test("markers inside inline code are literal", () => {
    const p = parseProse("`**not bold**`")[0] as { children: readonly InlineNode[] };
    expect(p.children).toEqual([{ type: "code", code: "**not bold**" }]);
  });

  test("a backslash escapes a marker", () => {
    const p = parseProse("\\*not italic\\*")[0] as { children: readonly InlineNode[] };
    expect(textOf(p.children)).toBe("*not italic*");
    expect(p.children.every((n) => n.type === "text")).toBe(true);
  });

  test("a bare URL becomes a link, without its trailing sentence punctuation", () => {
    const p = parseProse("see https://example.com/a.")[0] as { children: readonly InlineNode[] };
    const link = p.children.find((n) => n.type === "link");
    expect(link).toMatchObject({ type: "link", href: "https://example.com/a" });
    expect(textOf(p.children)).toBe("see https://example.com/a.");
  });

  test("a URL-looking string mid-word is NOT autolinked", () => {
    const p = parseProse("xhttps://example.com")[0] as { children: readonly InlineNode[] };
    expect(p.children.some((n) => n.type === "link")).toBe(false);
  });
});

describe("link safety — an allowlist, not a denylist", () => {
  test("http, https and mailto pass", () => {
    expect(isSafeLinkTarget("https://a.example")).toBe(true);
    expect(isSafeLinkTarget("http://a.example")).toBe(true);
    expect(isSafeLinkTarget("mailto:a@b.example")).toBe(true);
  });

  test("every obfuscation of a dangerous scheme is refused", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "  javascript:alert(1)",
      "\u0000javascript:alert(1)",
      "java​script:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "file:///etc/passwd",
      "//evil.example",
      "/relative/path",
    ]) {
      expect(isSafeLinkTarget(href), `${JSON.stringify(href)} must be refused`).toBe(false);
    }
  });

  test("an unsafe link keeps its WORDS and loses only its target", () => {
    const p = parseProse("[click me](javascript:alert(1))")[0] as {
      children: readonly InlineNode[];
    };
    expect(p.children.some((n) => n.type === "link")).toBe(false);
    expect(textOf(p.children)).toContain("click me");
  });
});

describe("raw HTML is never structure", () => {
  test("tags in the source stay text nodes", () => {
    const p = parseProse("<script>alert(1)</script>")[0] as {
      children: readonly InlineNode[];
    };
    expect(p.children.every((n) => n.type === "text")).toBe(true);
    expect(textOf(p.children)).toBe("<script>alert(1)</script>");
  });
});

describe("streaming: an unfinished marker never breaks structure", () => {
  const FULL = "Here is **bold** and `code` and a [link](https://a.example) plus:\n\n```ts\nx\n```";

  test("every prefix of a streaming message parses without throwing", () => {
    for (let i = 0; i <= FULL.length; i += 1) {
      expect(() => parseProse(FULL.slice(0, i))).not.toThrow();
    }
  });

  test("an unclosed bold marker is literal text", () => {
    const p = parseProse("half **bol")[0] as { children: readonly InlineNode[] };
    expect(p.children.some((n) => n.type === "bold")).toBe(false);
    expect(textOf(p.children)).toBe("half **bol");
  });

  test("an unclosed fence yields a code block running to the end", () => {
    const blocks = parseProse("```ts\nconst a = 1;");
    expect(blocks).toEqual([{ type: "code", lang: "ts", code: "const a = 1;" }]);
  });

  test("an unclosed link bracket is literal text", () => {
    const p = parseProse("see [docs")[0] as { children: readonly InlineNode[] };
    expect(textOf(p.children)).toBe("see [docs");
  });
});

describe("the size cap is reported, never silent", () => {
  test("under the cap, the document is parsed", () => {
    const r = parseProseBounded("# hi", MAX_MARKDOWN_CHARS);
    expect(r.overLimit).toBe(false);
    expect(kinds(r.blocks)).toEqual(["heading"]);
  });

  test("over the cap, the caller is TOLD and the text is kept whole", () => {
    const huge = "# hi\n".repeat(Math.ceil(MAX_MARKDOWN_CHARS / 5) + 10);
    const r = parseProseBounded(huge, MAX_MARKDOWN_CHARS);
    expect(r.overLimit).toBe(true);
    expect(kinds(r.blocks)).toEqual(["paragraph"]);
    // Nothing was dropped — the whole source is still there to read.
    expect(textOf((r.blocks[0] as { children: readonly InlineNode[] }).children)).toBe(huge);
  });
});

describe("one grammar for reading and for checking: titles, angle brackets, references, code spans (the dead-link scan's parser)", () => {
  const targets = (src: string): readonly string[] => extractMarkdown(src).links.map((link) => link.target);

  test("a title, an angle-bracket destination and balanced parentheses are part of the link syntax, never of the destination", () => {
    expect(targets('[a](x.md "Title") [b](<y z.md>) [c](file(1).md) [d](w.md \'t\') [e](v.md (t))')).toEqual(["x.md", "y z.md", "file(1).md", "w.md", "v.md"]);
    const p = parseProse('[home](https://example.com "Home")')[0] as { children: readonly InlineNode[] };
    expect(p.children).toEqual([{ type: "link", href: "https://example.com", children: [{ type: "text", text: "home" }] }]);
  });

  test("a reference definition is a link, and a full, collapsed or shortcut reference resolves through it", () => {
    const src = "See [the plan][p], [P][] and [p].\n\n[p]: https://example.com/plan\n[local]: docs/local.md \"t\"";
    expect(targets(src), "each definition is one destination, collected where it is defined").toEqual(["https://example.com/plan", "docs/local.md"]);
    const blocks = parseProse(src);
    expect(blocks).toHaveLength(1);
    expect(textOf((blocks[0] as { children: readonly InlineNode[] }).children)).toBe("See the plan, P and p.");
    expect(targets("- [ ] a task box is not a reference\n- [x] neither")).toEqual([]);
  });

  test("code is never a link: inline spans (any backtick run) and fenced blocks are skipped, and code spans are collected with their line", () => {
    const src = "`REGISTRY[name](n)` and ``a `x[y](z)` b``\n\n```ts\nconst f = [a](b);\n```\n\nreal [r](r.md)";
    expect(targets(src)).toEqual(["r.md"]);
    expect(extractMarkdown(src).codeSpans.map((span) => [span.text, span.line])).toEqual([["REGISTRY[name](n)", 1], ["a `x[y](z)` b", 1]]);
  });

  test("every destination carries the line it starts on, through paragraphs, lists, quotes, tables and emphasis", () => {
    const src = "# [h](h.md)\n\npara\nline [p](p.md)\n\n- item [l](l.md)\n  - nested **[n](n.md)**\n\n> quote [q](q.md)\n\n| a | b |\n|---|---|\n| [t](t.md) | x |";
    expect(extractMarkdown(src).links.map((link) => [link.target, link.line])).toEqual([["h.md", 1], ["p.md", 4], ["l.md", 6], ["n.md", 7], ["q.md", 9], ["t.md", 13]]);
  });

  test("near-misses are not links: unclosed syntax, a bare bracket, a space in an unbracketed destination", () => {
    expect(targets("[a](unclosed and [b] and [c] (d) and [e](x y.md)")).toEqual([]);
  });
});
