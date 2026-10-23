/**
 * THE RENDERED RULES — ONE TABLE. Each row is a property of what the browser
 * actually shows, judged after the cascade, the scripts and the network have
 * had their say (judge.ts runs the table). A static guard reads source and must
 * name every spelling of a mistake; a rule here asks the page.
 *
 * Adding a rule is adding a row:
 *   - `page` rules run inside the page (`page.evaluate`): `judge` must be
 *     self-contained (no closure, no import), takes the row's `input` (built
 *     here, in Node, from the one owner of what the rule checks) and returns
 *     one sentence per finding;
 *   - `request` rules see every request the page makes: `judge` takes the URL,
 *     its resource type and the page's origin, and returns a finding or null.
 *
 * `surfaces` names where a row applies: the cockpit (every view the capture
 * walk reaches, scripts/capture/cockpit.ts) and the site (every built page,
 * judge.ts `site`). A row that does not hold on a surface YET says why in
 * `pending`, and is not run there until the owner of that surface flips it.
 */
import { readFileSync } from "node:fs";

import { PALETTE_BURN_DOWN, sitePolicy } from "../../shared/site-page.ts";
import { readTokenOwner } from "../../shared/token-reader.ts";
import { BRAND_MARK } from "../../src/cockpit/shell/brand-mark.ts";

export type Surface = "cockpit" | "site";

export type PageRule = Readonly<{
  kind: "page";
  id: string;
  /** What the rule guarantees, in one sentence. */
  holds: string;
  surfaces: readonly Surface[];
  /** Surfaces it does not hold on yet, each with the reason and who flips it. */
  pending?: Readonly<Partial<Record<Surface, string>>>;
  input: () => unknown;
  judge: (args: { input: never; surface: Surface }) => string[];
}>;

export type RequestRule = Readonly<{
  kind: "request";
  id: string;
  holds: string;
  surfaces: readonly Surface[];
  pending?: Readonly<Partial<Record<Surface, string>>>;
  judge: (url: string, resourceType: string, origin: string) => string | null;
}>;

export type RenderedRule = PageRule | RequestRule;

/** One drawn part of the mark, in paint order: its element, the paint that carries its ink, and its token. */
export type MarkPart = Readonly<{ tag: string; paint: "fill" | "stroke"; token: string }>;

/** The declared parts, from the one geometry: the tile, the rein, each record line, the beam. */
function markParts(): readonly MarkPart[] {
  return [
    { tag: "rect", paint: "fill", token: BRAND_MARK.tile },
    { tag: "path", paint: "stroke", token: BRAND_MARK.rein.ink },
    ...BRAND_MARK.lines.map((line) => ({ tag: "path", paint: "stroke" as const, token: line.ink })),
    { tag: "circle", paint: "fill", token: BRAND_MARK.beam.ink },
  ];
}

/** The tokens that name a family stack (the token owner's `--face-*`). */
const FACE_TOKENS: readonly string[] = ["--face-sans", "--face-mono"];

/** Where the brand mark renders: the cockpit's `Brand.svelte` and any page that includes the generated mark. */
const MARK_SELECTOR = ".brand > svg, svg[data-brand-mark]";

/** The brand mark as rendered: the declared parts, each in its token's value, nothing hiding or recolouring it. */
function judgeMark(args: { input: { parts: readonly MarkPart[]; selector: string }; surface: Surface }): string[] {
  const findings: string[] = [];
  const { parts, selector } = args.input;
  const describe = (element: Element): string => {
    const cls = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${cls}`;
  };
  const marks = [...document.querySelectorAll(selector)];
  if (marks.length === 0 && args.surface === "cockpit") findings.push("no brand mark is rendered on this view");
  const resolveToken = (scope: Element, token: string): string => {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    scope.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  const shown = (element: Element, where: string): void => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const s = getComputedStyle(node);
      const at = node === element ? where : `${where} (its ancestor ${describe(node)})`;
      if (s.display === "none") findings.push(`${at}: display none`);
      if (s.visibility !== "visible") findings.push(`${at}: visibility ${s.visibility}`);
      if (s.opacity !== "1") findings.push(`${at}: opacity ${s.opacity}`);
      if (s.filter !== "none") findings.push(`${at}: filter ${s.filter}`);
      if (s.mixBlendMode !== "normal") findings.push(`${at}: mix-blend-mode ${s.mixBlendMode}`);
      if (s.clipPath !== "none") findings.push(`${at}: clip-path ${s.clipPath}`);
      if (s.maskImage !== "none" && s.maskImage !== "") findings.push(`${at}: mask ${s.maskImage}`);
    }
  };
  marks.forEach((svg, m) => {
    const name = `brand mark ${m + 1}`;
    const box = svg.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) findings.push(`${name}: renders at ${box.width}×${box.height}`);
    const drawn = [...svg.querySelectorAll("*")].filter((el) => !["title", "desc"].includes(el.tagName.toLowerCase()));
    if (drawn.length !== parts.length) findings.push(`${name}: draws ${drawn.length} elements, not the declaration's ${parts.length}`);
    parts.forEach((part, i) => {
      const el = drawn[i];
      const where = `${name} part ${i + 1} (${part.tag})`;
      if (el === undefined || el.tagName.toLowerCase() !== part.tag) {
        findings.push(`${where}: found ${el === undefined ? "nothing" : el.tagName.toLowerCase()}`);
        return;
      }
      const s = getComputedStyle(el);
      const want = resolveToken(svg.parentElement ?? svg, part.token);
      const got = part.paint === "fill" ? s.fill : s.stroke;
      if (got !== want) findings.push(`${where}: ${part.paint} ${got}, not ${part.token} (${want})`);
      const other = part.paint === "fill" ? s.stroke : s.fill;
      if (other !== "none") findings.push(`${where}: ${part.paint === "fill" ? "stroke" : "fill"} ${other}, not none`);
      const paintOpacity = part.paint === "fill" ? s.fillOpacity : s.strokeOpacity;
      if (paintOpacity !== "1") findings.push(`${where}: ${part.paint}-opacity ${paintOpacity}`);
      if (s.transform !== "none") findings.push(`${where}: transform ${s.transform}`);
      shown(el, where);
    });
  });
  return findings;
}

/** Every element that renders text computes exactly a token stack, and every face the document loaded is a token family. */
function judgeFonts(args: { input: { faceTokens: readonly string[] }; surface: Surface }): string[] {
  const findings: string[] = [];
  const { faceTokens } = args.input;
  const normal = (family: string): string => family.split(",").map((f) => f.trim().replace(/^["']|["']$/gu, "")).filter((f) => f.length > 0).join(", ");
  const describe = (element: Element): string => {
    const cls = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${cls}`;
  };
  const rootStyle = getComputedStyle(document.documentElement);
  const stacks = new Set(faceTokens.map((token) => normal(rootStyle.getPropertyValue(token))).filter((stack) => stack.length > 0));
  if (stacks.size !== faceTokens.length) findings.push(`the page declares ${stacks.size} of the ${faceTokens.length} face tokens (${faceTokens.join(", ")})`);
  const families = new Set([...stacks].flatMap((stack) => stack.split(", ")));
  const offStack = new Map<string, string[]>();
  for (const el of document.body.querySelectorAll("*")) {
    const text = [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
    if (!text || el.getClientRects().length === 0) continue;
    const family = normal(getComputedStyle(el).fontFamily);
    if (stacks.has(family)) continue;
    const seen = offStack.get(family) ?? [];
    if (seen.length < 3) seen.push(describe(el));
    offStack.set(family, seen);
  }
  for (const [family, where] of offStack) findings.push(`text renders in "${family}", not a --face-* stack (${where.join(", ")})`);
  for (const face of document.fonts) {
    const family = face.family.replace(/^["']|["']$/gu, "");
    if (face.status === "loaded" && !families.has(family)) findings.push(`the document loaded the font face "${family}", not a token family`);
  }
  return findings;
}

/**
 * THE CONTENT SECURITY POLICY every page carries as its meta tag, exactly:
 * the browser itself then refuses any font, stylesheet, script or image from
 * elsewhere, and any inline script or style. Its one statement is
 * `shared/site-page.ts` `sitePolicy()`, which the site's builder writes into
 * every page; the cockpit adopts it when it sends one (#319).
 */
export const CONTENT_SECURITY_POLICY = sitePolicy();

/** The page carries exactly one CSP meta tag, first in its head after the charset, saying exactly the policy. */
function judgeCspMeta(args: { input: { policy: string }; surface: Surface }): string[] {
  const metas = [...document.querySelectorAll("meta")].filter((m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy");
  if (metas.length !== 1) return [`the page carries ${metas.length} Content-Security-Policy meta tags, not one`];
  const findings: string[] = [];
  const head = [...document.head.children];
  if (!(head[0]?.tagName === "META" && head[0].hasAttribute("charset") && head[1] === metas[0])) {
    findings.push("the Content-Security-Policy meta tag is not the head's first element after <meta charset>: what loads before it is not under it");
  }
  const normal = (policy: string): string => policy.split(";").map((d) => d.trim().replace(/\s+/gu, " ")).filter((d) => d.length > 0).join("; ");
  const content = normal(metas[0]!.getAttribute("content") ?? "");
  if (content !== normal(args.input.policy)) findings.push(`the Content-Security-Policy is "${content}", not "${normal(args.input.policy)}"`);
  return findings;
}

/** Every token name the owner declares: what a page's colours and durations may compute to. */
function ownerTokens(): readonly string[] {
  const owner = readTokenOwner(readFileSync(new URL("../../src/cockpit/tokens.css", import.meta.url), "utf8"));
  return [...new Set([...owner.base.keys(), ...owner.logbook.keys()])].sort();
}

/** The colour and duration values the page's own tokens compute to, probed in the page through the CSSOM (the policy allows a script's own style writes). */
type TokenInput = Readonly<{ tokens: readonly string[]; ownPalette: readonly string[] }>;

/**
 * Every colour the page shows computes to a token's value: text, grounds,
 * drawn borders and outlines, decorations, and SVG paint. A page whose sheet
 * still carries its own palette (the burn-down list) is not judged here.
 */
function judgeTokenColours(args: { input: TokenInput; surface: Surface }): string[] {
  const { tokens, ownPalette } = args.input;
  if ([...document.styleSheets].some((sheet) => ownPalette.some((name) => (sheet.href ?? "").endsWith(`/${name}`)))) return [];
  const host = document.createElement("div");
  host.style.setProperty("color", "rgb(1, 2, 3)");
  document.body.append(host);
  const allowed = new Set<string>(["rgba(0, 0, 0, 0)"]);
  for (const token of tokens) {
    const probe = document.createElement("span");
    host.append(probe);
    probe.style.setProperty("color", `var(${token})`);
    const value = getComputedStyle(probe).color;
    if (value !== "rgb(1, 2, 3)") allowed.add(value);
    probe.remove();
  }
  host.remove();
  const describe = (element: Element): string => {
    const cls = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${cls}`;
  };
  const shapes = new Set(["rect", "circle", "ellipse", "line", "path", "polygon", "polyline", "text", "tspan"]);
  const off = new Map<string, string[]>();
  const note = (what: string, value: string, element: Element): void => {
    if (allowed.has(value)) return;
    const key = `${what} ${value}`;
    const seen = off.get(key) ?? [];
    if (seen.length < 3) seen.push(describe(element));
    off.set(key, seen);
  };
  for (const element of [document.body, ...document.body.querySelectorAll("*")]) {
    if (element.getClientRects().length === 0) continue;
    const s = getComputedStyle(element);
    const text = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
    if (text) note("color", s.color, element);
    note("background-color", s.backgroundColor, element);
    for (const side of ["top", "right", "bottom", "left"]) {
      if (s.getPropertyValue(`border-${side}-style`) !== "none" && s.getPropertyValue(`border-${side}-width`) !== "0px") note(`border-${side}-color`, s.getPropertyValue(`border-${side}-color`), element);
    }
    if (s.outlineStyle !== "none" && s.outlineWidth !== "0px") note("outline-color", s.outlineColor, element);
    if (text && s.textDecorationLine !== "none") note("text-decoration-color", s.textDecorationColor, element);
    if (element instanceof SVGElement && shapes.has(element.tagName.toLowerCase())) {
      if (s.fill !== "none" && !s.fill.startsWith("url(")) note("fill", s.fill, element);
      if (s.stroke !== "none" && !s.stroke.startsWith("url(")) note("stroke", s.stroke, element);
    }
  }
  return [...off].map(([key, where]) => `${key} is no token's value (${where.join(", ")})`);
}

/** Every transition and animation the page runs lasts a token's duration (or none). */
function judgeTokenDurations(args: { input: TokenInput; surface: Surface }): string[] {
  const { tokens, ownPalette } = args.input;
  if ([...document.styleSheets].some((sheet) => ownPalette.some((name) => (sheet.href ?? "").endsWith(`/${name}`)))) return [];
  const probe = document.createElement("span");
  document.body.append(probe);
  const allowed = new Set<string>(["0s"]);
  for (const token of tokens) {
    probe.style.setProperty("transition-duration", `var(${token})`);
    allowed.add(getComputedStyle(probe).transitionDuration);
  }
  probe.remove();
  const off = new Map<string, string[]>();
  for (const element of [document.body, ...document.body.querySelectorAll("*")]) {
    const s = getComputedStyle(element);
    for (const [property, values] of [["transition-duration", s.transitionDuration], ["animation-duration", s.animationDuration]] as const) {
      for (const value of values.split(",").map((part) => part.trim())) {
        if (allowed.has(value)) continue;
        const key = `${property} ${value}`;
        const seen = off.get(key) ?? [];
        if (seen.length < 3) seen.push(element.tagName.toLowerCase());
        off.set(key, seen);
      }
    }
  }
  return [...off].map(([key, where]) => `${key} is no token's duration (${where.join(", ")})`);
}

/** No Content-Security-Policy violation happened on the page (recorded from the first byte by judge.ts's context instrument). */
function judgeCspViolations(args: { input: Record<string, never>; surface: Surface }): string[] {
  void args;
  const seen = (window as unknown as { __renderedCspViolations?: { directive: string; blocked: string }[] }).__renderedCspViolations;
  if (seen === undefined) return ["the page was not instrumented for Content-Security-Policy violations"];
  return seen.map((v) => `a Content-Security-Policy violation: ${v.directive} blocked ${v.blocked || "an inline resource"}`);
}

/** A request that leaves the page's origin (data:, blob: and about: URLs are the page's own). */
function judgeOrigin(url: string, resourceType: string, origin: string): string | null {
  if (/^(?:data|blob|about):/u.test(url)) return null;
  let at: string;
  try {
    at = new URL(url).origin;
  } catch {
    return `a ${resourceType} request to an unparseable URL: ${url}`;
  }
  return at === origin ? null : `a ${resourceType} request left the origin: ${url}`;
}

/** THE TABLE. */
export const RENDERED_RULES: readonly RenderedRule[] = [
  {
    kind: "page",
    id: "brand-mark",
    holds: "Every rendered brand mark draws exactly the declared parts, each in its token's value, opaque, unfiltered, visible, unclipped and unmasked, and has a size.",
    surfaces: ["cockpit", "site"],
    input: () => ({ parts: markParts(), selector: MARK_SELECTOR }),
    judge: judgeMark as PageRule["judge"],
  },
  {
    kind: "page",
    id: "font-families",
    holds: "Every element that renders text computes exactly a --face-* token stack, and the document loads only token families.",
    surfaces: ["cockpit", "site"],
    input: () => ({ faceTokens: FACE_TOKENS }),
    judge: judgeFonts as PageRule["judge"],
  },
  {
    kind: "page",
    id: "csp-meta",
    holds: "Every page carries exactly one Content-Security-Policy meta tag, first in its head after the charset, saying exactly sitePolicy() (shared/site-page.ts).",
    surfaces: ["site"],
    pending: {
      cockpit: "the cockpit sends no Content-Security-Policy yet (#319); its owner adds \"cockpit\" here when it does",
    },
    input: () => ({ policy: CONTENT_SECURITY_POLICY }),
    judge: judgeCspMeta as PageRule["judge"],
  },
  {
    kind: "page",
    id: "token-colours",
    holds: "Every colour the page shows (text, grounds, drawn borders and outlines, decorations, SVG paint) computes to a token's value; a page on the palette burn-down list is exempt until #161.",
    surfaces: ["site"],
    pending: { cockpit: "the cockpit's components are not yet judged by computed colour; its owner adds \"cockpit\" here when they are" },
    input: () => ({ tokens: ownerTokens(), ownPalette: [...PALETTE_BURN_DOWN.keys()] }),
    judge: judgeTokenColours as PageRule["judge"],
  },
  {
    kind: "page",
    id: "token-durations",
    holds: "Every transition and animation the page runs lasts 0s or a token's duration; a page on the palette burn-down list is exempt until #161.",
    surfaces: ["site"],
    pending: { cockpit: "the cockpit's motion is not yet judged by computed duration; its owner adds \"cockpit\" here when it is" },
    input: () => ({ tokens: ownerTokens(), ownPalette: [...PALETTE_BURN_DOWN.keys()] }),
    judge: judgeTokenDurations as PageRule["judge"],
  },
  {
    kind: "page",
    id: "csp-violations",
    holds: "No Content-Security-Policy violation happens while the page loads and runs.",
    surfaces: ["cockpit", "site"],
    input: () => ({}),
    judge: judgeCspViolations as PageRule["judge"],
  },
  {
    kind: "request",
    id: "same-origin",
    holds: "No request leaves the page's origin: no font, stylesheet, script, image or beacon from anywhere else.",
    surfaces: ["cockpit", "site"],
    judge: judgeOrigin,
  },
];
