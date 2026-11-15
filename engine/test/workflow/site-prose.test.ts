/**
 * RECORD PROSE ON A SITE PAGE (src/workflow/site-prose.ts): a record's
 * Markdown is parsed by the one parser and written back through the markup
 * owner's site escape, so whatever a record spells, the page shows it as text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodeSiteText, escapeSiteHtml, escapeSiteText } from "../../../shared/markup.ts";
import { REPOSITORY_IDENTITY_BLOCKS } from "../../src/workflow/forge/repository-identity-protocol.ts";
import { productRenamedSettings, repositoryIdentity, withIdentityLinks } from "../../src/workflow/forge/repository-identity.ts";
import { SETTINGS } from "../forge/forge-settings.ts";
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


test("generated identity references keep their links and expose no metadata before or after the rename", () => {
  for (const settings of [SETTINGS, productRenamedSettings(SETTINGS)]) {
    const identity = repositoryIdentity(settings);
    const source = withIdentityLinks("An [original release][preview:releases/tag/v0.0.3-preview].\n", identity);
    const expected = `An [original release](${identity.preview!.webUrl}/releases/tag/v0.0.3-preview)\\.`;
    assert.equal(siteProse(source, "docs/items", href, 3), expected);
    assert.equal(siteProseLine(source, "docs/items", href), expected);
  }
});

test("metadata boundaries never hide their contents or ordinary comments, and torn boundaries stay visible", () => {
  const payload = "payload <script>x</script> {{ site.x }}";
  const ordinary = "<!-- an ordinary comment -->";
  for (const markers of Object.values(REPOSITORY_IDENTITY_BLOCKS)) {
    const source = `${markers.begin}\n\n${payload}\n\n${markers.end}\n\n${ordinary}`;
    assert.equal(siteProse(source, "docs/items", href, 3), `${escapeSiteText(payload)}\n\n${escapeSiteText(ordinary)}`);
    const torn = `${markers.begin}\n\n${payload}`;
    assert.equal(siteProse(torn, "docs/items", href, 3), `${escapeSiteText(markers.begin)}\n\n${escapeSiteText(payload)}`);
  }
});

test("identity boundary examples in code and quotes remain content", () => {
  const markers = REPOSITORY_IDENTITY_BLOCKS.links;
  const example = `${markers.begin}\nexample\n${markers.end}`;
  assert.equal(siteProse(`\`\`\`\n${example}\n\`\`\``, "docs/items", href, 3), `<pre><code>${escapeSiteHtml(example)}</code></pre>`);
  assert.equal(siteProse(`\`${markers.begin}\` and \`${markers.end}\``, "docs/items", href, 3), `<code>${escapeSiteHtml(markers.begin)}</code> and <code>${escapeSiteHtml(markers.end)}</code>`);
  const quoted = `> ${markers.begin}\n> example\n> ${markers.end}`;
  const rendered = siteProse(quoted, "docs/items", href, 3);
  assert.ok(rendered.includes(escapeSiteText(markers.begin)));
  assert.ok(rendered.includes(escapeSiteText(markers.end)));
});


test("escaped identity boundary spellings are prose, never generated metadata", () => {
  const markers = REPOSITORY_IDENTITY_BLOCKS.links;
  const source = markers.begin.replace("<!--", "<\\!--") + "\n\n" + markers.end.replace("<!--", "<\\!--");
  assert.equal(siteProse(source, "docs/items", href, 3), `${escapeSiteText(markers.begin)}\n\n${escapeSiteText(markers.end)}`);
});
