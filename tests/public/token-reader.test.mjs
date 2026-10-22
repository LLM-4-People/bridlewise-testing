// The one reader of the token owner (shared/token-reader.ts): parsing,
// theme maps, var() resolution, colour conversion and the generated sheet,
// each refusal planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { concreteColor, readNames, readTokenOwner, resolveToken, themeColor, themeTokens, tokenSheet, TokenOwnerError } from "../../shared/token-reader.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = readFileSync(join(ROOT, "src/cockpit/tokens.css"), "utf8");

const FIXTURE = `
/* a comment with :root { --fake: red; } inside */
@font-face {
  font-family: "Face";
  src: url("/fonts/face.woff2") format("woff2");
  font-style: normal;
}
:root {
  --ground: #101216;
  --ink: #e8ebef;
  --accent: var(--beam);
  --beam: #8fd3ff;
  --soft: color-mix(in srgb, var(--beam) 50%, transparent);
  --pad: calc(var(--unit) * 2);
  --unit: 4px;
}
.cockpit .x { color: var(--ink); --not-a-root-token: 1px; }
:root[data-cockpit-theme="light"] {
  --ground: #f6f4ef;
  --beam: #0f6fa8;
}
@media (prefers-reduced-motion: reduce) {
  :root { --t: 1ms; }
}
@media (max-width: 900px) {
  .cockpit .y { color: var(--ink); }
}
@property --share {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 0%;
}
:root { --t: 90ms; }
`;

const options = { themeAttribute: "data-theme", lead: "logbook", fontUrl: (url) => url.replace("/fonts/", "../fonts/"), banner: "GENERATED" };

test("the owner parses into a base, a Logbook re-derivation, remaps and faces", () => {
  const owner = readTokenOwner(FIXTURE);
  assert.equal(owner.base.get("--ground"), "#101216");
  assert.equal(owner.base.get("--t"), "90ms", "a later plain :root block joins the base");
  assert.equal(owner.base.has("--fake"), false, "a comment is not a declaration");
  assert.equal(owner.base.has("--not-a-root-token"), false, "a component rule is not the owner's :root");
  assert.deepEqual([...owner.logbook.keys()], ["--ground", "--beam"]);
  assert.deepEqual(owner.media.map((remap) => remap.query), ["(prefers-reduced-motion: reduce)"], "a remap with no :root is not a token remap");
  assert.equal(owner.fontFaces.length, 1);
  assert.equal(themeTokens(owner, "logbook").get("--ink"), "#e8ebef", "Logbook inherits what it does not re-derive");
});

test("the real owner parses, and both themes resolve every colour the site reads", () => {
  const owner = readTokenOwner(OWNER);
  assert.ok(owner.base.size > 150 && owner.logbook.size > 20, `base ${owner.base.size}, logbook ${owner.logbook.size}`);
  assert.equal(owner.fontFaces.length, 4);
  for (const theme of ["logbook", "carbon"]) {
    for (const name of ["--ground-0", "--ground-1", "--ground-2", "--ink-1", "--ink-2", "--accent", "--ok", "--warn", "--alarm", "--cat-turn"]) {
      assert.match(themeColor(owner, theme, name), /^#[0-9a-f]{6}$/u, `${theme} ${name}`);
    }
  }
  assert.notEqual(themeColor(owner, "logbook", "--ground-0"), themeColor(owner, "carbon", "--ground-0"));
});

test("var() is followed, through a fallback, and a cycle or an undeclared name is a typed refusal", () => {
  const owner = readTokenOwner(FIXTURE);
  const carbon = themeTokens(owner, "carbon");
  assert.equal(resolveToken(carbon, "--accent"), "#8fd3ff");
  assert.equal(resolveToken(themeTokens(owner, "logbook"), "--accent"), "#0f6fa8");
  assert.equal(resolveToken(carbon, "--pad"), "calc(4px * 2)");
  assert.equal(resolveToken(new Map([["--a", "var(--missing, #123456)"]]), "--a"), "#123456");
  assert.throws(() => resolveToken(carbon, "--absent"), (error) => error instanceof TokenOwnerError && error.code === "token_undeclared");
  assert.throws(() => resolveToken(new Map([["--a", "var(--b)"], ["--b", "var(--a)"]]), "--a"), (error) => error.code === "token_cycle");
  assert.throws(() => resolveToken(new Map([["--a", "var(--b)"]]), "--a"), (error) => error.code === "token_undeclared" && /--b/u.test(error.message));
});

test("colours become concrete: hex, rgb[a], oklch and color-mix", () => {
  assert.equal(concreteColor("#ABC"), "#aabbcc");
  assert.equal(concreteColor("#10121680"), "#10121680");
  assert.equal(concreteColor("rgba(25, 28, 32, 0.5)"), "#191c2080");
  assert.equal(concreteColor("rgb(100% 0% 0%)"), "#ff0000");
  assert.equal(concreteColor("oklch(1 0 0)"), "#ffffff");
  assert.equal(concreteColor("oklch(0 0 0)"), "#000000");
  // CSS Color 4's own sample: oklch(62.8% 0.2577 29.23) is sRGB red.
  assert.equal(concreteColor("oklch(62.8% 0.2577 29.23)"), "#ff0000");
  assert.equal(concreteColor("color-mix(in srgb, #000000 50%, #ffffff)"), "#808080");
  assert.equal(concreteColor("color-mix(in srgb, #8fd3ff 12%, transparent)"), "#8fd3ff1f");
  assert.equal(concreteColor("transparent"), "#00000000");
  assert.throws(() => concreteColor("hsl(0 100% 50%)"), (error) => error.code === "token_color_unsupported");
  assert.throws(() => concreteColor("color-mix(in oklab, red, blue)"), (error) => error.code === "token_color_unsupported");
});

test("the sheet holds only what is read, the lead theme on :root and the other's differences behind the attribute", () => {
  const owner = readTokenOwner(FIXTURE);
  const sheet = tokenSheet(owner, readNames(".a { color: var(--accent); padding: var(--pad); }"), options);
  assert.match(sheet, /^\/\* GENERATED \*\//u);
  assert.match(sheet, /url\("\.\.\/fonts\/face\.woff2"\)/u, "the face URL is mapped to where the surface serves it");
  const [lead, other] = sheet.split(':root[data-theme="carbon"]');
  assert.match(lead, /color-scheme: light;/u);
  assert.match(lead, /--accent: var\(--beam\);/u, "a token is emitted as authored, so it follows the theme");
  assert.match(lead, /--beam: #0f6fa8;/u, "the lead theme's value");
  assert.match(lead, /--unit: 4px;/u, "what a read token reads comes along");
  assert.doesNotMatch(sheet, /--ink:|--ground:|--soft:|--t:/u, "an unread token stays out");
  assert.match(other, /color-scheme: dark;\n {2}--beam: #8fd3ff;\n\}/u, "the other theme carries only its differences");
  const stamped = tokenSheet(owner, readNames(".bar { width: var(--share); }"), options);
  assert.match(stamped, /@property --share \{\n {2}syntax: "<percentage>";/u, "a read stamp ships its typed registration");
  assert.doesNotMatch(stamped, /--share:/u, "a stamp is registered, never declared by the surface");
  assert.equal(readTokenOwner(FIXTURE).properties.size, 1);
  const withMotion = tokenSheet(owner, ["--t"], options);
  assert.match(withMotion, /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{\n {4}--t: 1ms;/u, "a read token's remap comes along");
  assert.throws(() => tokenSheet(owner, ["--typo"], options), (error) => error.code === "token_undeclared" && /--typo/u.test(error.message));
});

test("an owner with no :root refuses; Logbook from an owner without it refuses, Carbon still reads", () => {
  assert.throws(() => readTokenOwner(".a { color: red; }"), (error) => error.code === "token_owner_unreadable");
  const carbonOnly = readTokenOwner(":root { --a: #000000; }");
  assert.equal(themeColor(carbonOnly, "carbon", "--a"), "#000000");
  assert.throws(() => themeColor(carbonOnly, "logbook", "--a"), (error) => error.code === "token_owner_unreadable" && /light/u.test(error.message));
  assert.throws(() => readTokenOwner(":root { --a: #000000; "), (error) => error.code === "token_owner_unreadable");
});
