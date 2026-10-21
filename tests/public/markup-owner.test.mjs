import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeHtmlEntities,
  escapeHtml,
  escapeMarkdownTableCell,
  htmlWithout,
  stripTags,
} from "../../shared/markup.ts";

/**
 * THE ONE MARKUP OWNER: `shared/markup.ts` does every HTML or Markdown
 * escape, entity decode and markup removal in the tree, and this file proves
 * both halves: the helper is complete against the shapes CodeQL flagged
 * (alerts 92 and 94-99: double unescaping, a removal that leaves a new
 * opener, `<SCRIPT>`, `</script >`, an unescaped backslash), and no tracked
 * source file outside it hand-rolls one of those chains again.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = "shared/markup.ts";
const SOURCE = /\.(?:[cm]?[jt]s|svelte)$/u;

const ENTITY = "&(?:amp|lt|gt|quot|apos|#39|#x27);";
/** The three hand-rolled shapes, each a `.replace(` / `.replaceAll(` call. */
const RULES = [
  {
    id: "entity-decode",
    pattern: new RegExp(String.raw`\.replace(?:All)?\(\s*\/[^/\n]*${ENTITY}`, "gu"),
    remedy: "decodeHtmlEntities",
  },
  {
    id: "entity-encode",
    pattern: new RegExp(String.raw`\.replace(?:All)?\(\s*\/(?:[^/\\\n]|\\.)+\/[a-z]*\s*,\s*["'\x60]${ENTITY}`, "gu"),
    remedy: "escapeHtml",
  },
  {
    id: "markup-removal",
    pattern: new RegExp(String.raw`\.replace(?:All)?\(\s*\/(?:<!--|<script|<style|<\[\^<?>\]\*>)`, "giu"),
    remedy: "htmlWithout / stripTags",
  },
];

/** The violations of one file's text, each as `path:line rule`. */
function violations(path, text) {
  if (path === OWNER) return [];
  const found = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    // A comment line may NAME a shape (a doc comment explaining a fix).
    if (/^\s*(?:\/\/|\/\*|\*)/u.test(line)) continue;
    // A call may wrap: read each line with the next one joined to it, and
    // count each call that STARTS on this line.
    const window = `${line}\n${lines[index + 1] ?? ""}`;
    for (const rule of RULES) {
      for (const match of window.matchAll(rule.pattern)) {
        if (match.index <= line.length) found.push(`${path}:${String(index + 1)} ${rule.id} (use ${rule.remedy})`);
      }
    }
  }
  return found;
}

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => SOURCE.test(path));
}

test("no tracked source file outside the owner hand-rolls an escape, decode or removal", () => {
  const files = trackedSources();
  assert.ok(files.length > 1000, `git ls-files found only ${String(files.length)} source files`);
  for (const folder of ["engine/src/", "server/", "src/", "scripts/", "tests/", "shared/"]) {
    assert.ok(files.some((path) => path.startsWith(folder)), `the scan reached nothing under ${folder}`);
  }
  assert.deepEqual(files.flatMap((path) => violations(path, readFileSync(join(ROOT, path), "utf8"))), []);
});

test("planted hand-rolled chains are refused in every shape and folder", () => {
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const planted = {
    "scripts/floor/a.mjs": `value\n    .replace(/${amp}/gu, "&")\n    .replace(/${lt}/gu, "<");\n`,
    "server/b.ts": `const safe = text.replace(/&/g, "${amp}").replace(/</g, '${lt}');\n`,
    "src/c.svelte": `<script>const plain = html.replace(/<!` + `--[\\s\\S]*?-->/g, "");</script>\n`,
    "engine/src/d.ts": `const body = html.replaceAll(/<SCR` + `IPT\\b[^]*?<\\/script>/gi, "");\n`,
    "tests/e.test.ts": `const slug = heading\n  .replace(\n/<[^>]*>/gu, "");\n`,
  };
  const found = Object.entries(planted).map(([path, text]) => violations(path, text));
  assert.deepEqual(found.map((list) => list.length), [2, 2, 1, 1, 1], JSON.stringify(found));
  assert.match(found[0][0], /scripts\/floor\/a\.mjs:2 entity-decode/u);
  assert.match(found[1][0], /server\/b\.ts:1 entity-encode/u);
  assert.match(found[2][0], /src\/c\.svelte:1 markup-removal/u);
});

test("near misses are not flagged", () => {
  const nearMisses = {
    "a.ts": `const body = wrapper.replace(/^<script>/, "").replace(/<\\/script>$/, "");\n`,
    "b.ts": `const text = "&" + "amp; stays prose";\nconst nav = html.replace(/<nav class="breadcrumb"[\\s\\S]*?<\\/nav>/u, "");\n`,
    "d.ts": `/**\n * Six scanners each grew their own \`.replace(/<!` + `--…/\` chain.\n */\n// x.replace(/${"&" + "amp;"}/g, "&")\n`,
    "c.ts": `const cell = value.replace(/\\|/gu, "\\\\|");\nconst lines = text.replace(/\\r\\n/gu, "\\n");\n`,
    [OWNER]: `x.replace(/${"&" + "amp;"}/g, "&");\n`,
  };
  assert.deepEqual(Object.entries(nearMisses).flatMap(([path, text]) => violations(path, text)), []);
});

test("escapeHtml escapes the five characters in one pass", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
  assert.equal(escapeHtml("plain"), "plain");
  assert.equal(decodeHtmlEntities(escapeHtml(`<&"'>&lt;`)), `<&"'>&lt;`, "decode inverts escape exactly once");
});

test("decodeHtmlEntities decodes once, never twice (alert 98)", () => {
  assert.equal(decodeHtmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(decodeHtmlEntities("a&amp;b &quot;q&quot; &#39;s&apos; &lt;&gt;"), `a&b "q" 's' <>`);
  assert.equal(decodeHtmlEntities("&#60;&#x3C;&#X3c;"), "<<<");
  assert.equal(decodeHtmlEntities("&nbsp; &unknown; &amp &#0; &#xD800; &#1114112;"), "&nbsp; &unknown; &amp &#0; &#xD800; &#1114112;");
});

test("escapeMarkdownTableCell escapes the backslash with the pipe (alert 97)", () => {
  assert.equal(escapeMarkdownTableCell("a|b"), "a\\|b");
  assert.equal(escapeMarkdownTableCell("a\\|b"), "a\\\\\\|b", "a backslash before a pipe can no longer cancel its escape");
  assert.equal(escapeMarkdownTableCell("C:\\path"), "C:\\\\path");
});

test("stripTags removes tags to a fixed point (alert 92)", () => {
  assert.equal(stripTags("Plan <em>one</em>"), "Plan one");
  assert.equal(stripTags("<<b>script>alert(1)<</b>/script>"), "alert(1)");
  assert.equal(stripTags("<scr<b>ipt>x"), "x");
  assert.equal(stripTags("a < b > c"), "a  c");
  assert.equal(stripTags("1 < 2"), "1 < 2");
});

test("htmlWithout removes comments and elements without joining their sides (alerts 94-96, 99)", () => {
  assert.equal(htmlWithout("a<!-- x -->b", { comments: true }), "a b");
  assert.equal(htmlWithout("<!<!-- x -->-- y -->", { comments: true }), "<! -- y -->", "no new comment opener forms");
  assert.equal(htmlWithout("<scr<!-- x -->ipt>z", { comments: true }), "<scr ipt>z", "no new script opener forms");
  assert.equal(htmlWithout("a<!-- unclosed", { comments: true }), "a ");
  const elements = { elements: ["script", "style", "pre", "code"] };
  assert.equal(htmlWithout("x<SCRIPT>bad()</SCRIPT >y", elements), "x y");
  assert.equal(htmlWithout("x<script type=module>bad()</script\n>y", elements), "x y");
  assert.equal(htmlWithout("x<style>.a{}</style>y<pre><b>t</b></pre>z<code>c</code>w", elements), "x y z w");
  assert.equal(htmlWithout("x<script>never closed", elements), "x ");
  assert.equal(htmlWithout("<codex>k</codex><prefix>p</prefix>", elements), "<codex>k</codex><prefix>p</prefix>", "a longer tag name is not the element");
  assert.equal(htmlWithout("<scr<script>x</script>ipt>bad()</script>", elements), "<scr ipt>bad()</script>");
  assert.equal(htmlWithout("a<!-- <script> -->b<script><!-- --></script>c", { comments: true, ...elements }), "a b c");
  assert.equal(htmlWithout("no markup", { comments: true }), "no markup");
});
