/**
 * RECORD PROSE ON A SITE PAGE (src/workflow/site-prose.ts): a record's
 * Markdown is parsed by the one parser and written back through the markup
 * owner's site escape, so whatever a record spells, the page shows it as text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodeSiteText, escapeSiteHtml, escapeSiteText } from "../../../shared/markup.ts";
import { siteDestination, siteProse, siteProseLine, type ProseTarget } from "../../src/workflow/site-prose.ts";

const href = (target: ProseTarget): string => (target.kind === "relative" ? `../${target.path}${target.fragment}` : target.url);

test("text, code, emphasis, lists, quotes and tables are written back; every leaf is escaped", () => {
  const out = siteProse("**Bold** *it* ~~gone~~ and `a {{ b }} | c`.\n\n- one\n- two\n\n> quoted\n\n| h | i |\n|---|---|\n| x | y |\n\n# Top", "docs/items", href, 3);
  assert.equal(out, [
    `**Bold** *it* ~~gone~~ and <code>${escapeSiteHtml("a {{ b }} | c")}</code>\\.`,
    "- one\n- two",
    "> quoted",
    "| h | i |\n|---|---|\n| x | y |",
    "### Top",
  ].join("\n\n"));
});

test("a relative link is handed to the page's href from the record's folder; an absolute one as written; an unsafe scheme is text", () => {
  const out = siteProseLine("see [a](../floor/x.md#h), [b](https://e.org/(y) \"t\"), [c](javascript:alert(1)) and [d](mailto:a@b.c)", "docs/items", href);
  assert.equal(out, "see [a](../docs/floor/x.md#h), [b](https://e.org/%28y%29), c and [d](mailto:a@b.c)");
});

test("a destination is percent-encoded outside a URL's own set; the page's own Liquid prefix is kept", () => {
  assert.equal(siteDestination("https://e.org/{{x}} y'(z)"), "https://e.org/%7B%7Bx%7D%7D%20y%27%28z%29");
  assert.equal(siteDestination("{{ site.repository_url }}/issues/{1}"), "{{ site.repository_url }}/issues/%7B1%7D");
});

test("the site escape neutralises Liquid and HTML in ONE pass, and reads back to the same text", () => {
  const planted = "{% include x %} {{ y }} {: z} <a href=\"q\">x</a> a_b *c* `d` [e](f) 1. # g";
  const escaped = escapeSiteText(planted);
  for (const raw of ["{%", "{{", "{:", "<a"]) assert.ok(!escaped.includes(raw), `${raw} in ${escaped}`);
  assert.equal(decodeSiteText(escaped), planted);
  assert.equal(decodeSiteText(escapeSiteHtml(escapeSiteHtml(planted))), escapeSiteHtml(planted), "a reference is decoded once, never twice");
  assert.equal(escapeSiteText("line one\nline two"), "line one line two");
});
