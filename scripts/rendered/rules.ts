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
 *
 * Every page row runs in every RENDER STATE of its surface (the second table,
 * below): a mark hidden only at a narrow width, a family only in print, a
 * remote sheet only under reduced motion are each a state of their own. Each
 * state is judged once the page is READY (judge.ts `ready`): no request in
 * flight and every frame's fonts settled — events, never a sleep and never a
 * time limit. The rows are then judged once more with :hover, :active and
 * :focus forced by the browser (judge.ts `judgeForcedStates`). Before the
 * page is left the judge runs its FUTURE (FUTURE_MS of page time on the
 * page's clock, in STEP_MS steps, judging after each, then every finite
 * animation finished): every timeout, interval and animation frame the clock
 * fakes, due in that span, in every frame, has fired.
 *
 * What a page must show comes from the token owner (scripts/token-owner.ts,
 * src/cockpit/tokens.css), never from the page: the face stacks and the
 * mark's colours per theme are built in Node and passed in, so a token a page
 * redefines is judged by what it renders.
 *
 * A page row runs in every frame the page holds (outside FRAMES_NOT_JUDGED,
 * each declared with its reason) and sees open shadow roots; what the page
 * records as it runs (every canvas font and every Content-Security-Policy
 * violation, in any frame) reaches the rows through `record`; and whatever
 * the judgement cannot reach — a worker or worklet, a closed shadow root, a
 * window the page opens, a delayed scheduler.postTask — is refused by the
 * judgeable row,
 * never passed in silence. What a green judgement still does not claim is
 * declared in JUDGE_LIMITS, and every report prints it. The request rows stay
 * on for the whole session.
 */
import { BRAND_MARK } from "../../src/cockpit/shell/brand-mark.ts";
import { TOKEN_THEMES, tokenValues, type TokenTheme } from "../token-owner.ts";
import { vendoredFaces } from "../vendor-fonts.ts";

export type Surface = "cockpit" | "site";

/** What the page recorded as it ran (judge.ts keeps it in Node, so a frame or worker that is gone still counts). */
export type Recorded = Readonly<{
  /** Every font a canvas was given or drew text in, in any frame. */
  canvasFonts: readonly string[];
  /** Every Content-Security-Policy violation, in any frame. */
  cspViolations: readonly string[];
  /** Everything the judgement cannot reach, each in one sentence. */
  unjudgeable: readonly string[];
}>;

/**
 * The helpers every page row may use, passed in beside its arguments (a row's
 * `judge` runs in the page, so it can import nothing).
 */
export type Kit = Readonly<{
  /** Every element of the document's composed tree: the light DOM and, recursively, every open shadow root. */
  elements: (root: Document) => Element[];
  /** An element as a finding names it: tag, id and first classes. */
  describe: (element: Element) => string;
}>;

export type PageRule = Readonly<{
  kind: "page";
  id: string;
  /** What the rule guarantees, in one sentence. */
  holds: string;
  surfaces: readonly Surface[];
  /** Surfaces it does not hold on yet, each with the reason and who flips it. */
  pending?: Readonly<Partial<Record<Surface, string>>>;
  input: () => unknown;
  /**
   * Runs in every judged frame: `top` is the page's own document, and only
   * there is `record` given (it holds the whole page's, every frame's).
   */
  judge: (args: { input: never; surface: Surface; top: boolean; record: Recorded | null }, kit: Kit) => string[];
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

/**
 * WHAT THE PAGE MUST SHOW, from the token owner (scripts/token-owner.ts), never
 * from the page: the face stacks, and each theme's value of every token the
 * mark is painted with. A page that redefines a token renders something the
 * owner did not declare, and is judged by what it renders.
 */
const faceStacks = (): Readonly<Record<string, string>> => tokenValues("carbon", FACE_TOKENS);
const markThemes = (): readonly Readonly<{ selector: string; colors: Readonly<Record<string, string>> }>[] =>
  (Object.keys(TOKEN_THEMES) as TokenTheme[]).map((theme) => ({ selector: TOKEN_THEMES[theme], colors: tokenValues(theme, [...new Set(markParts().map((part) => part.token))]) }));

/** Where the brand mark renders: the cockpit's `Brand.svelte` and any page that includes the generated mark. */
const MARK_SELECTOR = ".brand > svg, svg[data-brand-mark]";

/** THE KIT (see `Kit`): each helper self-contained, as it runs in the page. */
export const KIT: Readonly<Record<keyof Kit, (...args: never[]) => unknown>> = {
  elements: (root: Document): Element[] => {
    const out: Element[] = [];
    const walk = (scope: Document | ShadowRoot): void => {
      for (const el of scope.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot !== null) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  },
  describe: (element: Element): string => {
    const cls = typeof element.className === "string" && element.className.trim() ? `.${element.className.trim().split(/\s+/u).slice(0, 2).join(".")}` : "";
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${cls}`;
  },
};

/**
 * The brand mark as rendered, wherever it is (any frame, any open shadow
 * root): the declared parts, each in the token owner's value of its token for
 * the theme the document wears, nothing hiding or recolouring it.
 */
function judgeMark(args: { input: { parts: readonly MarkPart[]; selector: string; themes: readonly { selector: string; colors: Readonly<Record<string, string>> }[] }; surface: Surface; top: boolean; record: Recorded | null }, kit: Kit): string[] {
  const findings: string[] = [];
  const { parts, selector, themes } = args.input;
  const describe = kit.describe;
  const marks = kit.elements(document).filter((el) => el.matches(selector));
  if (marks.length === 0 && args.top && args.surface === "cockpit") findings.push("no brand mark is rendered on this view");
  // The theme the document wears: the last of the owner's theme selectors its root matches (Carbon is :root).
  const theme = themes.filter((t) => document.documentElement.matches(t.selector)).at(-1);
  // The owner's literal value, as the browser computes a colour (never through the page's own var()).
  const ownerColor = (token: string): string => {
    const probe = document.createElement("span");
    probe.style.color = theme?.colors[token] ?? "";
    document.documentElement.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  // Up the composed tree: through a shadow root to its host.
  const parentOf = (node: Element): Element | null => node.parentElement ?? ((node.parentNode as ShadowRoot | null)?.host ?? null);
  const shown = (element: Element, where: string): void => {
    for (let node: Element | null = element; node !== null; node = parentOf(node)) {
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
      const want = ownerColor(part.token);
      const got = part.paint === "fill" ? s.fill : s.stroke;
      if (got !== want) findings.push(`${where}: ${part.paint} ${got}, not the owner's ${part.token} (${want})`);
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

/** A face the token owner vendors: its family, and the files (served paths) it may be loaded from. */
export type VendoredFace = Readonly<{ family: string; files: readonly string[] }>;


/**
 * Every element that renders text computes exactly a token stack; every face
 * the document declares or holds is a token family loaded from its vendored
 * files; every font a canvas is given or draws in is exactly a token stack.
 */
function judgeFonts(args: { input: { stacks: Readonly<Record<string, string>>; faces: readonly VendoredFace[] }; surface: Surface; top: boolean; record: Recorded | null }, kit: Kit): string[] {
  const findings: string[] = [];
  const { faces } = args.input;
  const normal = (family: string): string => family.split(",").map((f) => f.trim().replace(/^["']|["']$/gu, "")).filter((f) => f.length > 0).join(", ");
  // The owner's stacks (built in Node from tokens.css), never the page's own --face-* values.
  const owner = Object.entries(args.input.stacks).map(([token, stack]) => [token, normal(stack)] as const);
  const stacks = new Set(owner.map(([, stack]) => stack));
  if (args.top) {
    const rootStyle = getComputedStyle(document.documentElement);
    for (const [token, stack] of owner) {
      const declared = normal(rootStyle.getPropertyValue(token));
      if (declared !== stack) findings.push(`the page sets ${token} to "${declared}", not the token owner's "${stack}"`);
    }
  }
  const families = new Set([...stacks].flatMap((stack) => stack.split(", ")));
  const elements = kit.elements(document);
  // What renders text, in the light DOM and every open shadow root (a closed one is refused by the judgeable row):
  // each text node that has a box of its own (a Range over it, so text in a display:contents element counts),
  // a form control's value or placeholder, and generated ::before/::after content.
  const offStack = new Map<string, string[]>();
  const judge = (style: CSSStyleDeclaration, where: string): void => {
    const family = normal(style.fontFamily);
    if (stacks.has(family)) return;
    const seen = offStack.get(family) ?? [];
    if (seen.length < 3) seen.push(where);
    offStack.set(family, seen);
  };
  const range = document.createRange();
  for (const el of elements) {
    const own = [...el.childNodes, ...(el.shadowRoot?.childNodes ?? [])];
    const rendered = own.some((node) => {
      if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim().length === 0) return false;
      range.selectNodeContents(node);
      return range.getClientRects().length > 0;
    });
    if (rendered) judge(getComputedStyle(el), kit.describe(el));
    const control = el as Partial<HTMLInputElement>;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && `${control.value ?? ""}${control.placeholder ?? ""}`.trim().length > 0 && el.getClientRects().length > 0) judge(getComputedStyle(el), `${kit.describe(el)} (its value)`);
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (style.display === "none" || ["none", "normal", '""', "''"].includes(style.content)) continue;
      judge(style, `${kit.describe(el)}${pseudo}`);
    }
  }
  for (const [family, where] of offStack) findings.push(`text renders in "${family}", not a --face-* stack (${where.join(", ")})`);
  // Every face a stylesheet declares: a token family, from that family's vendored files only (no local(), no other file).
  const sheets: CSSStyleSheet[] = [...document.styleSheets, ...document.adoptedStyleSheets];
  for (const el of elements) if (el.shadowRoot !== null) sheets.push(...el.shadowRoot.styleSheets, ...el.shadowRoot.adoptedStyleSheets);
  const declared = new Map<string, number>();
  const visit = (sheet: CSSStyleSheet): void => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      findings.push(`a stylesheet the judgement cannot read (${sheet.href ?? "inline"})`);
      return;
    }
    const walk = (list: CSSRuleList): void => {
      for (const rule of list) {
        if (rule instanceof CSSImportRule) {
          if (rule.styleSheet !== null) visit(rule.styleSheet);
        } else if (rule instanceof CSSFontFaceRule) {
          const family = normal(rule.style.getPropertyValue("font-family"));
          declared.set(family, (declared.get(family) ?? 0) + 1);
          const allowed = new Set(faces.filter((face) => face.family === family).flatMap((face) => face.files.map((file) => new URL(file, location.origin).href)));
          if (!families.has(family)) findings.push(`a stylesheet declares the font face "${family}", not a token family`);
          const src = rule.style.getPropertyValue("src");
          const sources = src.split(/,(?![^(]*\))/u).map((item) => item.trim()).filter((item) => item.length > 0);
          for (const source of sources.length === 0 ? [""] : sources) {
            const url = /^url\(\s*["']?([^"')]*)["']?\s*\)(?:\s+(?:format|tech)\([^)]*\))*$/u.exec(source)?.[1];
            const at = url === undefined ? null : new URL(url, sheet.href ?? document.baseURI).href;
            if (at === null || !allowed.has(at)) findings.push(`the font face "${family}" is loaded from ${source || "nothing"}, not one of its vendored files`);
          }
        } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    walk(rules);
  };
  for (const sheet of sheets) visit(sheet);
  // Every face the document holds: a token family, and no more faces of a family than its stylesheets declare
  // (a face a script made — new FontFace — has a source no stylesheet states, so it cannot be bound).
  const held = new Map<string, number>();
  for (const face of document.fonts) {
    const family = normal(face.family);
    held.set(family, (held.get(family) ?? 0) + 1);
    if (!families.has(family)) findings.push(`the document holds the font face "${family}" (${face.status}), not a token family`);
  }
  for (const [family, count] of held) {
    if (count > (declared.get(family) ?? 0)) findings.push(`the document holds ${count} faces of "${family}" but its stylesheets declare ${declared.get(family) ?? 0}: a face made by script cannot be bound to a vendored file`);
  }
  // Every font a canvas was given or drew in, in any frame (recorded by judge.ts as it happened),
  // parsed by the browser itself: its family list must be exactly one token stack.
  for (const value of new Set(args.record?.canvasFonts ?? [])) {
    const probe = document.createElement("span");
    probe.style.font = value;
    const family = normal(probe.style.fontFamily);
    if (family === "") findings.push(`a canvas was given the font "${value}", which names no family the browser can read`);
    else if (!stacks.has(family)) findings.push(`a canvas draws in "${value}": "${family}" is not exactly a --face-* stack`);
  }
  return findings;
}

/**
 * THE CONTENT SECURITY POLICY every page carries as its meta tag, exactly:
 * the browser itself then refuses any font, stylesheet, script or image from
 * elsewhere, and any inline script or style. The page's owner writes it into
 * the page; this is the one statement of what it must say.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'";

/** The page carries exactly one CSP meta tag, and it says exactly the policy. */
function judgeCspMeta(args: { input: { policy: string }; surface: Surface; top: boolean; record: Recorded | null }): string[] {
  if (!args.top && location.protocol === "about:") return []; // a srcdoc or blank frame lives under its parent's policy
  const metas = [...document.querySelectorAll("meta")].filter((m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "content-security-policy");
  if (metas.length !== 1) return [`the page carries ${metas.length} Content-Security-Policy meta tags, not one`];
  const normal = (policy: string): string => policy.split(";").map((d) => d.trim().replace(/\s+/gu, " ")).filter((d) => d.length > 0).join("; ");
  const content = normal(metas[0]!.getAttribute("content") ?? "");
  return content === normal(args.input.policy) ? [] : [`the Content-Security-Policy is "${content}", not "${normal(args.input.policy)}"`];
}

/** No Content-Security-Policy violation happened in any frame of the page (recorded from the first byte by judge.ts). */
function judgeCspViolations(args: { input: Record<string, never>; surface: Surface; top: boolean; record: Recorded | null }): string[] {
  return (args.record?.cspViolations ?? []).map((v) => `a Content-Security-Policy violation: ${v}`);
}

/** Nothing the page runs is out of the judgement's reach (judge.ts records what is: a worker, a closed shadow root). */
function judgeJudgeable(args: { input: Record<string, never>; surface: Surface; top: boolean; record: Recorded | null }): string[] {
  return [...(args.record?.unjudgeable ?? [])];
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

/** One state a page is judged in: its media, its motion preference, and (on the site, where the judge owns the window) its viewport and colour scheme. */
export type RenderState = Readonly<{
  id: string;
  surfaces: readonly Surface[];
  media: "screen" | "print";
  reducedMotion: "reduce" | "no-preference";
  /**
   * Set by the judge on the site. On the cockpit the capture walk's surfaces
   * already span desktop and mobile, Carbon and Logbook, and its contexts are
   * dark: the cockpit themes by attribute, never by prefers-color-scheme, so a
   * light scheme state would judge nothing new (a media-query theme would
   * need one here).
   */
  viewport?: Readonly<{ width: number; height: number }>;
  colorScheme?: "light" | "dark";
}>;

const DESKTOP = { width: 1280, height: 900 } as const;
/** The narrow width a phone gives (the capture's mobile viewport). */
const NARROW = { width: 390, height: 844 } as const;

/**
 * THE STATES, in the order a page goes through them. Every page row of a
 * surface runs in each of that surface's states. A state without a viewport or
 * scheme keeps the one before it (the cockpit's come from the capture walk's
 * surfaces: desktop and mobile, Carbon and Logbook).
 */
export const RENDER_STATES: readonly RenderState[] = [
  { id: "desktop", surfaces: ["site"], media: "screen", reducedMotion: "no-preference", viewport: DESKTOP, colorScheme: "light" },
  { id: "desktop-dark", surfaces: ["site"], media: "screen", reducedMotion: "no-preference", viewport: DESKTOP, colorScheme: "dark" },
  { id: "screen", surfaces: ["cockpit"], media: "screen", reducedMotion: "no-preference" },
  { id: "reduced-motion", surfaces: ["cockpit", "site"], media: "screen", reducedMotion: "reduce" },
  { id: "print", surfaces: ["cockpit", "site"], media: "print", reducedMotion: "no-preference" },
  { id: "narrow", surfaces: ["site"], media: "screen", reducedMotion: "no-preference", viewport: NARROW, colorScheme: "light" },
];

/**
 * THE FUTURE a page is judged through before it is left, in page time on the
 * page's own clock (no wall time passes for it): every timeout, interval and
 * animation frame due in it fires, in every frame, and the rows are judged
 * after each STEP_MS. A change that lasts less than a step between two
 * judgements, or one scheduled later than this, is outside the claim.
 */
export const FUTURE_MS = 30_000;
export const STEP_MS = 1_000;

/**
 * THE JUDGE'S DECLARED LIMITS — what a green judgement does NOT claim, each
 * with the reason it is a limit. Every report the judge makes prints this
 * table (judge.ts `site`, proof.ts, the capture walk's --judge-only), so no
 * limit is a silent gap. What the judge can detect but cannot judge is not
 * listed here: the judgeable row refuses it (a worker or worklet, a closed
 * shadow root, a window the page opens, a delayed scheduler.postTask).
 *
 * The judgement is calibrated for OUR OWN pages making MISTAKES — a family
 * typed where a token belongs, a colour that misses a theme, a rule that only
 * bites on hover, in print or after a delay — not for a page built to hide
 * from it (the last row says so).
 */
export const JUDGE_LIMITS: readonly Readonly<{ id: string; limit: string; why: string }>[] = [
  { id: "between-steps", limit: `a change that appears and is undone within one step (${String(STEP_MS)} ms of page time) of a page's future is not seen`, why: "the future is judged after each step; a state that comes and goes between two judgements is never on screen when one is made" },
  { id: "past-the-future", limit: `work a page schedules later than ${String(FUTURE_MS)} ms of page time into its future is not run`, why: "the future must end for a judgement to end: a page that polls schedules work forever" },
  { id: "real-time-loops", limit: "work driven by the browser's own task queues in wall time — a MessageChannel or postMessage loop, a chain on network or idle callbacks the clock does not fake — is judged only as far as it got by each judgement", why: "the page clock fakes timers, intervals and animation frames, not the task queues; running those forward needs the browser's virtual time, which cannot be handed back to real time (the capture walk needs real time between views)" },
  { id: "infinite-animations", limit: "an infinite CSS or Web animation is judged where it stands at each judgement, not at every point of its cycle", why: "it has no end to finish to" },
  { id: "finite-animations-mid-run", limit: "a finite animation is judged where it stands at each judgement and at its end (each is finished before the last judgement); a keyframe off the tokens only between those moments is not seen", why: "a judgement samples the timeline; seeking every keyframe of every animation is not done" },
  { id: "forced-states-together", limit: "hover, active and focus are forced on every element at once (focus only where an element can take it), not one element at a time", why: "one forced pass shows any rule those states turn on; combinations that cannot occur together may also be judged" },
  { id: "hostile-pages", limit: "a page written to hide from the judgement — one that takes a removed frame's setters, or stops the Content-Security-Policy violation event before the judge's listener — can evade it", why: "the judge's threat model is our own pages making mistakes; it records in the page, where such a page can interfere" },
];

/**
 * THE FRAMES NOT JUDGED, each declared with its reason and the surfaces it
 * applies to. A frame is skipped, with everything inside it, only when its
 * element carries the attribute AND the browser gave it an opaque origin (it
 * is sandboxed without allow-same-origin): the attribute names which frame,
 * the browser enforces what it is. A same-origin frame claiming the attribute
 * is judged like any other.
 */
export const FRAMES_NOT_JUDGED: readonly Readonly<{ surfaces: readonly Surface[]; attribute: string; value: string; why: string }>[] = [
  { surfaces: ["cockpit"], attribute: "data-artifact", value: "frame", why: "a user artifact (ArtifactFrame.svelte): the user's own document, in an opaque-origin sandbox; its fonts and marks are the user's, not the cockpit's" },
];

/** THE TABLE. */
export const RENDERED_RULES: readonly RenderedRule[] = [
  {
    kind: "page",
    id: "brand-mark",
    holds: "Every rendered brand mark, in any frame or open shadow root, draws exactly the declared parts, each in the token owner's value of its token for the theme it wears, opaque, unfiltered, visible, unclipped and unmasked, and has a size.",
    surfaces: ["cockpit"],
    pending: { site: "the site's layout draws a mark of its own (another geometry, painted with currentColor) until DESIGN generates it from brand-mark.ts (#201); DESIGN adds \"site\" here when it does" },
    input: () => ({ parts: markParts(), selector: MARK_SELECTOR, themes: markThemes() }),
    judge: judgeMark as PageRule["judge"],
  },
  {
    kind: "page",
    id: "font-families",
    holds: "Every text that renders (a text node with a box, a form control's value, generated content; open shadow roots included) computes exactly one of the token owner's --face-* stacks, in every state including hover and focus; every font face is a token family loaded from its vendored files; every canvas font, in any frame, is exactly a --face-* stack.",
    surfaces: ["cockpit"],
    pending: { site: "the site declares its own --sans/--mono stacks until it wears the token owner (DESIGN, #201); DESIGN adds \"site\" here when it does" },
    // Each token family is bound to the files the font owner vendors for it (scripts/vendor-fonts.ts, its lock).
    input: () => ({ stacks: faceStacks(), faces: vendoredFaces() satisfies readonly VendoredFace[] }),
    judge: judgeFonts as PageRule["judge"],
  },
  {
    kind: "page",
    id: "csp-meta",
    holds: `Every page carries exactly one Content-Security-Policy meta tag, saying exactly "${CONTENT_SECURITY_POLICY}".`,
    surfaces: [],
    pending: {
      site: "DESIGN adds the meta tag to the site's one layout (#201); DESIGN adds \"site\" here when it does",
      cockpit: "the cockpit sends no Content-Security-Policy yet (#319); its owner adds \"cockpit\" here when it does",
    },
    input: () => ({ policy: CONTENT_SECURITY_POLICY }),
    judge: judgeCspMeta as PageRule["judge"],
  },
  {
    kind: "page",
    id: "csp-violations",
    holds: "No Content-Security-Policy violation happens, in any frame, while the page loads and runs.",
    surfaces: ["cockpit", "site"],
    input: () => ({}),
    judge: judgeCspViolations as PageRule["judge"],
  },
  {
    kind: "page",
    id: "judgeable",
    holds: "Everything the page runs is within the judgement's reach: no worker (dedicated or shared) or worklet, no closed shadow root, no window the page opens, no scheduler.postTask with a delay (the page's clock does not run it); every frame outside FRAMES_NOT_JUDGED is judged.",
    surfaces: ["cockpit", "site"],
    input: () => ({}),
    judge: judgeJudgeable as PageRule["judge"],
  },
  {
    kind: "request",
    id: "same-origin",
    holds: "No request leaves the page's origin: no font, stylesheet, script, image or beacon from anywhere else.",
    surfaces: ["cockpit", "site"],
    judge: judgeOrigin,
  },
];
