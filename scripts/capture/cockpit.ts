#!/usr/bin/env node
/**
 * THE COCKPIT CAPTURE — deterministic screenshots and one GIF of the real
 * cockpit, in one command:
 *
 *   node --experimental-strip-types scripts/capture/cockpit.ts [--out <dir>] [--demo-root <dir>] [--keep-scratch]
 *
 * What it does, in order (the WHAT is data in `cockpit-plan.ts`):
 *
 *  1. Refuses, by name, before it touches anything: a listener on 5173/5174
 *     (it never stops a process it did not start), a missing guardian build,
 *     a missing Playwright ffmpeg, an existing output or demo folder.
 *  2. Copies the committed tree (`git archive HEAD`) into a scratch folder
 *     under TMPDIR, hard-links the installed dependencies (minus Vite's
 *     rewritable dep cache), and puts every byte of state — XDG homes, key
 *     home, evidence home, both databases — under that scratch folder.
 *  3. Writes the scripted "Tidewater" repository under a neutral path
 *     (default /tmp/bridlewise-capture/tidewater): the editor prints the
 *     project's absolute path, so a home folder would publish the user name.
 *  4. Starts the app through the project's own launcher (`scripts/sd.mjs
 *     start`, run inside the copy) with HARNESS_WEB_LLM_FIXTURES=1 — the
 *     product's fixture model stream: no request leaves the machine.
 *  5. Drives headless Chromium (no GPU process: refused if one appears) through
 *     the fixed sequence in both themes at 1440×900 and 390×844, with the
 *     browser clock fixed, motion off, the server's volatile values masked
 *     by explicit labels and every run capture labelled "fixture replay".
 *     Every page's text is checked before its image is kept: a home path,
 *     the host user name, or an unmasked volatile value fails the run.
 *  6. Records the fixture run as a WebM and turns it into a palette GIF.
 *  7. Writes manifest.json: the recipe hash, each image's sha256, the
 *     Chromium and Playwright versions and the captured commit.
 *  8. Stops ONLY what it started (`sd.mjs stop` in the copy, which stops the
 *     processes its own spawn records name) and removes its own scratch.
 *
 * Output: `.bridlewise/capture/<commit>/` (ignored; raw images never enter git).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { allProcessIds, ancestorsOf, commandLineOf } from "../../engine/src/process/process-facts.ts";
import { portAnswers, portListeners } from "../dev-processes.ts";
import {
  ACCOUNT_USERNAME,
  API_PORT,
  APP_ORIGIN,
  badgeText,
  maskedLabels,
  buildManifest,
  captureFileName,
  CHROMIUM_ARGS,
  DEFAULT_DEMO_ROOT,
  DEMO_REPOSITORY,
  DEVICE_SCALE_FACTOR,
  FIXED_INSTANT_ISO,
  hostLeaks,
  PROVIDER_PLACEHOLDER,
  recipeHash,
  REGION_MASKS,
  RUN_PROMPT,
  SEQUENCE,
  sha256,
  STILLNESS_CSS,
  TEXT_MASKS,
  THEME_STORAGE_KEY,
  THEMES,
  unmaskedValues,
  VIEWPORT_IDS,
  VIEWPORTS,
  WEB_PORT,
  type CapturedImage,
  type CaptureManifest,
  type ShotStage,
  type StateAction,
  type Theme,
  type ViewAction,
  type ViewportId,
} from "./cockpit-plan.ts";
import { decodePngRgb, encodeGif } from "./gif.ts";
import { judgePage, watchRequests } from "../rendered/judge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRATCH_MARKER = ".bridlewise-capture-scratch";
/** How long after a capture the same view is shot again for the stillness proof. */
const STILLNESS_RECHECK_MS = 1000;
/** How many trailing lines of a failed command's stderr its refusal quotes. */
const REFUSAL_STDERR_LINES = 15;
/** How many lines of new text an unstill view's violation quotes. */
const UNSTILL_TEXT_LINES = 5;
const DEMO_MARKER = ".bridlewise-capture-demo";

/** A typed refusal: the run stops and says why, by code. */
class CaptureRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function log(message: string): void {
  console.log(`[capture] ${message}`);
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: Buffer }): string {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, timeout: options.timeoutMs, input: options.input, maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = result.stderr?.toString().trim().split("\n").slice(-REFUSAL_STDERR_LINES).join("\n") ?? "";
    throw new CaptureRefusal("command_failed", `${command} ${args.join(" ")} (exit ${String(result.status)}${result.error ? `, ${result.error.message}` : ""})\n${stderr}`);
  }
  return result.stdout.toString();
}

// ── Arguments ──

interface Options {
  readonly out: string | null;
  readonly demoRoot: string;
  readonly keepScratch: boolean;
  /** Judge every view as rendered (scripts/rendered/) without writing images, video or a manifest: the CI check. */
  readonly judgeOnly: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let out: string | null = null;
  let demoRoot = DEFAULT_DEMO_ROOT;
  let keepScratch = false;
  let judgeOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = resolve(argv[++i] ?? "");
    else if (arg === "--demo-root") demoRoot = resolve(argv[++i] ?? "");
    else if (arg === "--keep-scratch") keepScratch = true;
    else if (arg === "--judge-only") judgeOnly = true;
    else throw new CaptureRefusal("argument_unknown", `${String(arg)} (known: --out <dir>, --demo-root <dir>, --keep-scratch, --judge-only)`);
  }
  return { out, demoRoot, keepScratch, judgeOnly };
}

// ── Preflight ──

async function refuseBusyPorts(): Promise<void> {
  const ports = [WEB_PORT, API_PORT];
  const listeners = portListeners(ports);
  const answering = (await Promise.all(ports.map(async (port) => ((await portAnswers(port)) ? port : null)))).filter((port) => port !== null);
  if (listeners.length > 0 || answering.length > 0) {
    const named = listeners.map((l) => `pid ${l.pid} on ${l.port}`).join(", ");
    throw new CaptureRefusal("ports_busy", `the app's ports ${ports.join("/")} are in use (${named || `answering: ${answering.join(", ")}`}). This capture starts its own app and never stops a process it did not start; stop that server yourself, then run again.`);
  }
}

function playwrightFfmpeg(): string {
  const browsers = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "playwright-core", "browsers.json"), "utf8")) as { browsers: { name: string; revision: string }[] };
  const revision = browsers.browsers.find((b) => b.name === "ffmpeg")?.revision;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright");
  const path = join(root, `ffmpeg-${String(revision)}`, "ffmpeg-linux");
  if (revision === undefined || !existsSync(path)) throw new CaptureRefusal("ffmpeg_missing", `${path} is absent; install it with: npx playwright install chromium ffmpeg`);
  return path;
}

// ── The isolated copy, its state and the demo repository ──

/** Hard-links a dependency tree, leaving out Vite's dep cache (Vite rewrites it in place, which would write through a hard link into the source checkout). */
function linkDependencies(from: string, to: string): void {
  if (!existsSync(from)) throw new CaptureRefusal("dependencies_missing", `${from} is absent; run npm ci first`);
  mkdirSync(to, { recursive: true });
  const entries = readdirSync(from).filter((name) => ![".vite", ".vite-temp", ".cache"].includes(name)).map((name) => join(from, name));
  for (let i = 0; i < entries.length; i += 500) run("cp", ["-al", ...entries.slice(i, i + 500), to], { timeoutMs: 600_000 });
}

function prepareApp(scratch: string, commit: string): string {
  const app = join(scratch, "app");
  mkdirSync(app);
  const archive = spawnSync("git", ["-C", REPO_ROOT, "archive", commit], { maxBuffer: 2 * 1024 * 1024 * 1024, timeout: 300_000 });
  if (archive.status !== 0) throw new CaptureRefusal("archive_failed", archive.stderr.toString());
  run("tar", ["-x", "-C", app], { input: archive.stdout, timeoutMs: 300_000 });
  linkDependencies(join(REPO_ROOT, "node_modules"), join(app, "node_modules"));
  linkDependencies(join(REPO_ROOT, "engine", "node_modules"), join(app, "engine", "node_modules"));
  // The confinement binary is an ignored build output; without it Custody's git and the checks are refused.
  const guardian = join(REPO_ROOT, "engine", "guardian", "build");
  if (!existsSync(join(guardian, "harness-landlock-guardian"))) throw new CaptureRefusal("guardian_missing", `${guardian}/harness-landlock-guardian is absent; build it with: make -C engine/guardian all`);
  run("cp", ["-a", guardian, join(app, "engine", "guardian", "build")], { timeoutMs: 60_000 });
  chmodSync(join(app, "engine", "bridlewise.config.json"), 0o600);
  return app;
}

function stateEnvironment(scratch: string): NodeJS.ProcessEnv {
  const state = join(scratch, "state");
  const dirs = { config: "xdg-config", data: "xdg-data", cache: "xdg-cache", state: "xdg-state", keys: "keys", evidence: "evidence", db: "db", tmp: "tmp" };
  for (const dir of Object.values(dirs)) mkdirSync(join(state, dir), { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    TMPDIR: join(state, dirs.tmp),
    XDG_CONFIG_HOME: join(state, dirs.config),
    XDG_DATA_HOME: join(state, dirs.data),
    XDG_CACHE_HOME: join(state, dirs.cache),
    XDG_STATE_HOME: join(state, dirs.state),
    HARNESS_KEY_HOME: join(state, dirs.keys),
    HARNESS_EVIDENCE_HOME: join(state, dirs.evidence),
    HARNESS_WEB_DB_PATH: join(state, dirs.db, "web.db"),
    HARNESS_WEB_TIMELINE_DB_PATH: join(state, dirs.db, "timeline.db"),
    HARNESS_WEB_LLM_FIXTURES: "1",
  };
}

function writeDemoRepository(demoRoot: string): string {
  if (existsSync(demoRoot)) throw new CaptureRefusal("demo_root_exists", `${demoRoot} already exists (another capture running, or a stopped one's leftovers); remove it yourself and run again`);
  mkdirSync(demoRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(demoRoot, DEMO_MARKER), "");
  const repo = join(demoRoot, DEMO_REPOSITORY.folder);
  mkdirSync(repo);
  // No global or system git configuration: the commits depend on this plan alone.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]): string => run("git", ["-C", repo, ...args], { env, timeoutMs: 30_000 });
  git("init", "-q", "-b", DEMO_REPOSITORY.branch);
  if (!existsSync(join(repo, ".git"))) throw new CaptureRefusal("demo_init_failed", `${repo}/.git was not created`);
  for (const commit of DEMO_REPOSITORY.commits) {
    for (const [path, content] of Object.entries(commit.files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
      git("add", "--", path);
    }
    run("git", ["-C", repo, "-c", `user.name=${DEMO_REPOSITORY.identity.name}`, "-c", `user.email=${DEMO_REPOSITORY.identity.email}`, "commit", "-q", "-m", commit.message], {
      env: { ...env, GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date },
      timeoutMs: 30_000,
    });
  }
  return repo;
}

function sd(app: string, env: NodeJS.ProcessEnv, verb: "start" | "stop"): void {
  log(`sd.mjs ${verb}`);
  const result = spawnSync(process.execPath, ["scripts/sd.mjs", verb], { cwd: app, env, timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] });
  const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
  if (result.status !== 0) throw new CaptureRefusal(`server_${verb}_failed`, `sd.mjs ${verb} exited ${String(result.status)}\n${output.split("\n").slice(-25).join("\n")}`);
}

// ── BL-GPU: the browser must not have spawned a GPU process ──

/** The command lines of every live descendant of `root`, through the one procfs owner (process-facts.ts). */
function descendantCommandLines(root: number): string[] {
  return allProcessIds().filter((pid) => ancestorsOf(pid).includes(root)).flatMap((pid) => {
    const command = commandLineOf(pid);
    return command === undefined ? [] : [command.join(" ")];
  });
}

// ── The page layer: stillness, masks, the label ──

interface LayerConfig {
  readonly css: string;
  readonly theme: string;
  readonly themeKey: string;
  readonly textMasks: readonly { id: string; label: string; source: string }[];
  readonly regionMasks: readonly { id: string; label: string; selector: string }[];
  readonly badge: string | null;
}

/**
 * Runs inside every page before its own scripts (an init script). It seeds
 * the theme, removes motion, and keeps every volatile value masked from the
 * first paint on: a MutationObserver re-masks a value the app re-renders
 * (observer callbacks run before the next paint, so no frame shows it).
 */
function captureLayer(config: LayerConfig): void {
  try { localStorage.setItem(config.themeKey, config.theme); } catch { /* storage refused: the page shows its default theme, and the capture's text check still runs */ }
  const rules = config.textMasks.map((mask) => ({ label: mask.label, re: new RegExp(mask.source, "gu") }));
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"]);
  const maskText = (node: Node): void => {
    const parent = node.parentElement;
    if (parent === null || skip.has(parent.tagName) || parent.closest("[data-capture-layer]") !== null) return;
    const before = node.nodeValue ?? "";
    let after = before;
    for (const rule of rules) after = after.replace(rule.re, `[${rule.label}]`);
    if (after !== before) node.nodeValue = after;
  };
  const maskTree = (root: Node): void => {
    if (root.nodeType === Node.TEXT_NODE) { maskText(root); return; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) maskText(n);
  };
  /** The colour the region sits on: the nearest ancestor that paints a background. */
  const paintedBackground = (el: Element): string => {
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const bg = getComputedStyle(at).backgroundColor;
      if (bg !== "transparent" && !/^rgba\(.*,\s*0\)$/u.test(bg)) return bg;
    }
    return "Canvas";
  };
  const maskRegions = (): void => {
    for (const mask of config.regionMasks) {
      for (const el of document.querySelectorAll<HTMLElement>(mask.selector)) {
        if (el.dataset["captureMask"] === mask.label) continue;
        el.style.setProperty("--capture-mask-color", getComputedStyle(el).color);
        el.style.setProperty("--capture-mask-bg", paintedBackground(el));
        el.dataset["captureMask"] = mask.label;
      }
    }
  };
  const style = document.createElement("style");
  style.setAttribute("data-capture-layer", "");
  // A region mask is an opaque overlay ABOVE the reading (the reading stays in place and hit-testable, so the layout and the Lens are unchanged).
  style.textContent = `${config.css}
[data-capture-mask]{position:relative!important}
[data-capture-mask]::after{content:"[" attr(data-capture-mask) "]";position:absolute;inset:0;z-index:1;pointer-events:none;display:flex;align-items:center;font:11px/1 ui-monospace,monospace;color:var(--capture-mask-color);background:var(--capture-mask-bg)}
[data-capture-badge]{position:fixed;right:0;bottom:0;z-index:2147483647;pointer-events:none;font:11px/1.3 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.72);padding:3px 7px;border-top-left-radius:4px}`;
  let badge: HTMLElement | null = null;
  const setBadge = (text: string | null): void => {
    if (text === null) { badge?.remove(); badge = null; return; }
    if (badge === null) { badge = document.createElement("div"); badge.setAttribute("data-capture-layer", ""); badge.setAttribute("data-capture-badge", ""); }
    badge.textContent = text;
    ensure();
  };
  // The document element can be absent while a navigation commits; the observer re-attaches both once it exists.
  function ensure(): void {
    const root = document.documentElement;
    if (root === null) return;
    if (!style.isConnected) root.append(style);
    if (badge !== null && !badge.isConnected) root.append(badge);
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") maskText(record.target);
      else for (const node of record.addedNodes) maskTree(node);
    }
    maskRegions();
    ensure();
  }).observe(document, { subtree: true, childList: true, characterData: true });
  ensure();
  if (document.documentElement !== null) maskTree(document.documentElement);
  if (config.badge !== null) setBadge(config.badge);
  (window as unknown as { __capture: unknown }).__capture = {
    setBadge,
    /** The text the IMAGE holds (visible and inside the viewport): a masked region reads as its label, an input as its value. */
    pageText: (): string => {
      maskTree(document.body);
      maskRegions();
      const out: string[] = [document.title];
      const walk = (el: Element): void => {
        if (el.matches("[data-capture-layer],script,style,noscript,template") || !el.checkVisibility({ visibilityProperty: true })) return;
        const mask = el instanceof HTMLElement ? el.dataset["captureMask"] : undefined;
        if (mask !== undefined) { out.push(`[${mask}]`); return; }
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.length > 0) {
          const r = el.getBoundingClientRect();
          if (r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) out.push(el.value);
        }
        for (const child of el.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE) walk(child as Element);
          else if (child.nodeType === Node.TEXT_NODE) {
            const text = child.nodeValue?.trim() ?? "";
            if (text.length === 0) continue;
            // Only what the image holds: text scrolled out of the viewport is not in the capture.
            const range = document.createRange();
            range.selectNodeContents(child);
            const inView = [...range.getClientRects()].some((r) => r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth);
            if (inView) out.push(text);
          }
        }
      };
      walk(document.body);
      return out.join("\n");
    },
    /** Resolves once the DOM has been quiet for `quietMs` (or `maxMs` passed), then two frames. */
    settle: (quietMs: number, maxMs: number): Promise<boolean> => new Promise((done) => {
      const start = performance.now();
      let last = performance.now();
      const watcher = new MutationObserver(() => { last = performance.now(); });
      watcher.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      const tick = (): void => {
        const now = performance.now();
        if (now - last >= quietMs || now - start >= maxMs) {
          watcher.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => done(now - last >= quietMs)));
        } else setTimeout(tick, 50);
      };
      void document.fonts.ready.then(tick);
    }),
  };
}

// ── Driving ──

interface Surface {
  readonly theme: Theme;
  readonly viewport: ViewportId;
  readonly context: BrowserContext;
  readonly page: Page;
}

/** Every request finding of the rendered rules (scripts/rendered/), in every context the run opens. */
const offOrigin = new Set<string>();

async function newSurface(browser: Browser, theme: Theme, viewport: ViewportId, badge: string | null, video?: string): Promise<Surface> {
  const spec = VIEWPORTS[viewport];
  const context = await browser.newContext({
    viewport: { width: spec.width, height: spec.height },
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    isMobile: spec.isMobile,
    hasTouch: spec.isMobile,
    reducedMotion: "reduce",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    serviceWorkers: "block",
    ...(video !== undefined ? { recordVideo: { dir: video, size: { width: spec.width, height: spec.height } } } : {}),
  });
  await context.clock.setFixedTime(new Date(FIXED_INSTANT_ISO));
  watchRequests(context, "cockpit", APP_ORIGIN, (finding) => offOrigin.add(`[${theme}/${viewport}] ${finding}`));
  const config: LayerConfig = { css: STILLNESS_CSS, theme, themeKey: THEME_STORAGE_KEY, textMasks: TEXT_MASKS, regionMasks: REGION_MASKS, badge };
  await context.addInitScript(captureLayer, config);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => log(`[${theme}/${viewport}] page error: ${error.message.slice(0, 300)}`));
  return { theme, viewport, context, page };
}

async function settle(page: Page, quietMs = 600, maxMs = 6000): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __capture?: unknown }).__capture !== undefined);
  await page.evaluate(([q, m]) => (window as unknown as { __capture: { settle: (q: number, m: number) => Promise<boolean> } }).__capture.settle(q, m), [quietMs, maxMs] as const);
}

async function openRoot(page: Page): Promise<void> {
  await page.goto(`${APP_ORIGIN}/`);
  await page.locator("input[name=username], header.horizon").first().waitFor();
  await settle(page);
}

async function openRoom(page: Page, room: string): Promise<void> {
  const grip = page.locator(`header.horizon [data-chord-target=${room}]:visible`);
  if ((await grip.count()) === 0) {
    await page.locator("header.horizon button.rail-fold").click();
    await page.locator(`[data-chord-target=${room}]:visible`).first().click();
  } else await grip.first().click();
  await settle(page);
}

async function switchOpen(page: Page): Promise<boolean> {
  return page.locator("[name=filter]").isVisible();
}

async function openSwitch(page: Page): Promise<void> {
  if (!(await switchOpen(page))) await openRoom(page, "switch");
  if (!(await switchOpen(page))) throw new CaptureRefusal("view_unreached", "the Switch did not open");
  await settle(page);
}

async function closeRaised(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await settle(page, 300, 2000);
}

async function scrollAllToTop(page: Page): Promise<void> {
  await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollTop > 0) el.scrollTop = 0; });
}

async function signIn(page: Page, password: string): Promise<void> {
  await page.fill("input[name=username]", ACCOUNT_USERNAME);
  await page.fill("input[name=passphrase]", password);
  await page.click("button[type=submit]");
  await page.locator("header.horizon").waitFor({ timeout: 30_000 });
  await settle(page);
}

/** Opens the run's conversation from the Switch (it is the project's only one). */
async function openRunConversation(page: Page): Promise<void> {
  await openSwitch(page);
  await page.getByText("new conversation", { exact: true }).last().click();
  await settle(page);
  if (await switchOpen(page)) await closeRaised(page);
  await scrollAllToTop(page);
  await settle(page);
}

type ViewHandler = (surface: Surface) => Promise<(() => Promise<void>) | void>;

const VIEW: Record<ViewAction, ViewHandler> = {
  openRoot: async ({ page }) => openRoot(page),
  openSwitch: async ({ page }) => {
    await openSwitch(page);
    return async () => closeRaised(page);
  },
  openChat: async ({ page }) => {
    if (await switchOpen(page)) await closeRaised(page);
    await openRoom(page, "chat");
  },
  openAddProvider: async ({ page }) => {
    await openRoom(page, "settings");
    await page.getByRole("button", { name: "+ Add provider" }).click();
    await page.locator("input[name=provider-name]").waitFor();
    await page.locator("[name=settings-search]").blur();
    await settle(page);
    return async () => { await page.reload(); await settle(page); };
  },
  openRunConversation: async ({ page }) => openRunConversation(page),
  expandToolOutput: async ({ page }) => {
    const beat = page.getByText("read file", { exact: false }).first();
    await beat.click();
    await settle(page);
    await scrollAllToTop(page);
    await settle(page);
  },
  openContextAndTools: async ({ page }) => {
    await page.click('[data-verb-id="desk.toggle"]');
    await page.getByText("measuring the next turn's composition").waitFor({ state: "hidden", timeout: 30_000 });
    await settle(page);
    return async () => { await page.click('[data-verb-id="desk.toggle"]'); await settle(page); };
  },
  openInstruments: async ({ page }) => openRoom(page, "instruments"),
  openLensCallout: async ({ page }) => {
    await page.click("header.horizon [data-chord-target=lens]");
    await settle(page, 300, 2000);
    // The Lens answers what the pointer is over: a still instrument's name, whose callout names the signal's source.
    await page.locator('.cell[data-signal="awareness.signalCount"] .head .name').hover();
    // The "LENS armed" hint retires itself after a moment; shooting while it shows would race that timer.
    await page.getByText("LENS armed").waitFor({ state: "hidden", timeout: 30_000 });
    await settle(page);
    return async () => closeRaised(page);
  },
  openCustody: async ({ page }) => {
    await openRoom(page, "custody");
    await page.getByText("reading the saved history").waitFor({ state: "hidden", timeout: 30_000 });
    // The saved history is loaded once its oldest commit is in the DOM (the narrow layout truncates it out of sight).
    await page.getByText(DEMO_REPOSITORY.commits[0]!.message).first().waitFor({ state: "attached" });
    await settle(page);
  },
  openCustodyDiff: async ({ page }) => {
    await page.getByRole("button", { name: /^see$/iu }).first().click();
    await settle(page);
    return async () => closeRaised(page);
  },
  openEditorFile: async ({ page }) => {
    await openRoom(page, "editor");
    await page.getByText("src", { exact: true }).first().click();
    await settle(page, 300, 3000);
    await page.getByText("tides.ts", { exact: true }).first().click();
    await settle(page);
  },
  openSettings: async ({ page }) => {
    await openRoom(page, "settings");
    await page.locator("[name=settings-search]").blur();
    await settle(page);
  },
};

interface Run {
  readonly options: Options;
  readonly commit: string;
  readonly out: string;
  readonly repo: string;
  readonly password: string;
  readonly hostUser: string;
  readonly ffmpeg: string;
  readonly scratch: string;
  setup: Surface | null;
  surfaces: Surface[];
  animation: CaptureManifest["animation"];
  readonly images: CapturedImage[];
  readonly violations: string[];
}

/** Views whose subject is what the pointer is over: the capture leaves the pointer where the view put it. */
const POINTER_HELD: ReadonlySet<ViewAction> = new Set(["openLensCallout"]);

async function capture(state: Run, surface: Surface, stage: ShotStage, parkPointer: boolean): Promise<void> {
  const { page } = surface;
  const file = captureFileName(stage, surface.theme, surface.viewport);
  const spec = VIEWPORTS[surface.viewport];
  if (parkPointer) await page.mouse.move(1, spec.height - 1);
  await settle(page, 400, 4000);
  // THE RENDERED JUDGEMENT: the mark and the fonts, as the browser computed them on this view.
  for (const finding of await judgePage(page, "cockpit")) state.violations.push(`${file}: ${finding}`);
  if (state.options.judgeOnly) {
    log(`judged ${file}`);
    return;
  }
  const readText = (): Promise<string> => page.evaluate(() => (window as unknown as { __capture: { pageText: () => string } }).__capture.pageText());
  const regionsMasked = await page.locator("[data-capture-mask]:visible").count();
  const masked = maskedLabels(await readText());
  if (regionsMasked > 0) masked["live reading"] = Math.max(masked["live reading"] ?? 0, regionsMasked);
  await page.evaluate((badge) => (window as unknown as { __capture: { setBadge: (t: string | null) => void } }).__capture.setBadge(badge), badgeText(stage.fixtureRun, Object.keys(masked).length > 0));
  await settle(page, 300, 2000);
  const text = await readText();
  const shoot = (): Promise<Buffer> => page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  const png = await shoot();
  // THE STILLNESS PROOF: the same view, shot again a moment later, must be the same bytes. A value that
  // changes under the camera is a volatile value no mask names yet — said here, never published silently.
  await page.waitForTimeout(STILLNESS_RECHECK_MS);
  const again = await shoot();
  if (!again.equals(png)) {
    const later = await readText();
    const before = new Set(text.split("\n"));
    const changed = later.split("\n").filter((line) => !before.has(line)).slice(0, UNSTILL_TEXT_LINES);
    mkdirSync(join(state.out, "unstill"), { recursive: true });
    writeFileSync(join(state.out, "unstill", file), again);
    state.violations.push(`${file}: the view changed within ${STILLNESS_RECHECK_MS} ms (the later shot: unstill/${file})${changed.length > 0 ? ` (new text: ${changed.join(" | ")})` : " (pixels only)"}`);
  }
  const leaks = hostLeaks(text, state.hostUser);
  const loose = unmaskedValues(text);
  if (leaks.length > 0) state.violations.push(`${file}: host identity in the page text: ${leaks.join(", ")}`);
  if (loose.length > 0) state.violations.push(`${file}: unmasked volatile value(s): ${loose.join(", ")}`);
  writeFileSync(join(state.out, file), png);
  mkdirSync(join(state.out, "text"), { recursive: true });
  writeFileSync(join(state.out, "text", file.replace(/\.png$/u, ".txt")), text);
  state.images.push({
    file,
    sha256: sha256(png),
    bytes: png.length,
    theme: surface.theme,
    viewport: surface.viewport,
    stage: stage.id,
    fixtureReplay: stage.fixtureRun,
    masked,
    textSha256: sha256(text),
  });
  log(`shot ${file}`);
}

/** The fixture run, recorded: a fresh signed-in desktop page with video on. */
async function fixtureRun(state: Run, browser: Browser): Promise<void> {
  const videoDir = join(state.scratch, "video");
  const surface = await newSurface(browser, "carbon", "desktop", badgeText(true, true), state.options.judgeOnly ? undefined : videoDir);
  const { page } = surface;
  const recordStart = Date.now();
  await openRoot(page);
  await signIn(page, state.password);
  await openSwitch(page);
  await page.getByRole("button", { name: "+ New" }).click();
  await page.getByText(`New conversation in ${DEMO_REPOSITORY.projectName}`).click();
  await settle(page);
  if (await switchOpen(page)) await closeRaised(page);
  await page.mouse.move(1, VIEWPORTS.desktop.height - 1);
  await settle(page);
  const clipStart = Date.now() - recordStart;
  await page.locator("[name=composer]").pressSequentially(RUN_PROMPT, { delay: 25 });
  await page.getByRole("button", { name: /Send/u }).click();
  await page.getByText(/stream closed/u).first().waitFor({ timeout: 60_000 });
  await settle(page, 800, 8000);
  await page.waitForTimeout(1500);
  const clipEnd = Date.now() - recordStart;
  if (state.options.judgeOnly) {
    // The run's own page, judged as rendered, with no recording.
    for (const finding of await judgePage(page, "cockpit")) state.violations.push(`fixture run: ${finding}`);
    await surface.context.close();
    log("judged the fixture run");
    return;
  }
  const video = page.video();
  await surface.context.close();
  if (video === null) throw new CaptureRefusal("video_missing", "the run page recorded no video");
  const webm = join(state.out, "fixture-run.webm");
  await video.saveAs(webm);
  // WebM → PNG frames (Playwright's ffmpeg: decode + scale only) → one palette GIF.
  const frames = join(state.scratch, "frames");
  mkdirSync(frames);
  const fps = 8;
  run(state.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", webm, "-ss", (clipStart / 1000).toFixed(2), "-t", ((clipEnd - clipStart) / 1000).toFixed(2), "-vf", "scale=720:450:flags=lanczos", "-r", String(fps), "-pix_fmt", "rgb24", join(frames, "%04d.png")], { timeoutMs: 300_000 });
  const pngs = readdirSync(frames).filter((f) => f.endsWith(".png")).toSorted();
  const rgb = pngs.map((f) => decodePngRgb(readFileSync(join(frames, f))));
  const gif = encodeGif(rgb, Math.round(100 / fps), 300);
  writeFileSync(join(state.out, "fixture-run.gif"), gif);
  state.animation = {
    webm: { file: "fixture-run.webm", sha256: sha256(readFileSync(webm)) },
    gif: { file: "fixture-run.gif", sha256: sha256(gif), frames: rgb.length, width: rgb[0]?.width ?? 0, height: rgb[0]?.height ?? 0 },
  };
  log(`gif ${rgb.length} frames, ${gif.length} bytes`);
}

async function stateAction(state: Run, browser: Browser, action: StateAction, surfaces: readonly Surface[]): Promise<void> {
  const setup = state.setup!.page;
  switch (action) {
    case "signUp":
      await openRoot(setup);
      await signIn(setup, state.password);
      return;
    case "signIn":
      for (const { page } of surfaces) await signIn(page, state.password);
      return;
    case "reload":
      for (const { page } of surfaces) { await page.reload(); await page.locator("input[name=username], header.horizon").first().waitFor(); await settle(page); }
      return;
    case "createProject": {
      const [status, body] = await setup.evaluate(async ([name, path]) => {
        const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, path }) });
        return [res.status, await res.text()] as const;
      }, [DEMO_REPOSITORY.projectName, state.repo] as const);
      if (status !== 201) throw new CaptureRefusal("project_refused", `POST /api/projects answered ${status}: ${body.slice(0, 400)}`);
      await setup.reload();
      await settle(setup);
      return;
    }
    case "saveProvider":
      await openRoom(setup, "settings");
      await setup.getByRole("button", { name: "+ Add provider" }).click();
      await setup.fill("input[name=provider-name]", PROVIDER_PLACEHOLDER.name);
      await setup.fill("input[name=provider-base-url]", PROVIDER_PLACEHOLDER.baseUrl);
      await setup.fill("input[name=provider-api-key]", PROVIDER_PLACEHOLDER.apiKey);
      await setup.fill("input[name=provider-model-id]", PROVIDER_PLACEHOLDER.modelId);
      await setup.getByRole("button", { name: /Save provider/u }).click();
      await setup.getByText(PROVIDER_PLACEHOLDER.name, { exact: true }).first().waitFor();
      await settle(setup);
      return;
    case "fixtureRun":
      await fixtureRun(state, browser);
      return;
    case "dirtyWorkingTree":
      writeFileSync(join(state.repo, DEMO_REPOSITORY.uncommitted.path), DEMO_REPOSITORY.uncommitted.content);
      return;
  }
}

async function drive(state: Run, browser: Browser): Promise<void> {
  state.setup = await newSurface(browser, "carbon", "desktop", null);
  for (const viewport of VIEWPORT_IDS) for (const theme of THEMES) state.surfaces.push(await newSurface(browser, theme, viewport, null));
  const gpu = descendantCommandLines(process.pid).filter((line) => line.includes("--type=gpu-process"));
  if (gpu.length > 0) throw new CaptureRefusal("gpu_process_spawned", `Chromium spawned a GPU process despite ${CHROMIUM_ARGS.join(" ")} (BL-GPU)`);
  for (const stage of SEQUENCE) {
    if (stage.kind === "once") await stateAction(state, browser, stage.action, []);
    else if (stage.kind === "each") await stateAction(state, browser, stage.action, state.surfaces);
    else {
      for (const surface of state.surfaces) {
        if (!stage.viewports.includes(surface.viewport)) continue;
        const file = captureFileName(stage, surface.theme, surface.viewport);
        try {
          const leave = await VIEW[stage.action](surface);
          await capture(state, surface, stage, !POINTER_HELD.has(stage.action));
          if (leave) await leave();
        } catch (error) {
          throw new CaptureRefusal("view_failed", `${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  const started = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const commit = run("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { timeoutMs: 10_000 }).trim();
  const out = options.out ?? join(REPO_ROOT, ".bridlewise", "capture", commit);
  // A judgement writes nothing to keep: no output folder, no encoder.
  if (!options.judgeOnly && existsSync(out) && readdirSync(out).length > 0) throw new CaptureRefusal("output_exists", `${out} is not empty; choose another --out or remove it`);
  await refuseBusyPorts();
  const ffmpeg = options.judgeOnly ? "" : playwrightFfmpeg();
  if (!options.judgeOnly) mkdirSync(out, { recursive: true });

  const scratch = mkdtempSync(join(tmpdir(), "bridlewise-capture-"));
  writeFileSync(join(scratch, SCRATCH_MARKER), "");
  let app: string | null = null;
  let env: NodeJS.ProcessEnv | null = null;
  let demoCreated = false;
  let browser: Browser | null = null;
  try {
    log(`commit ${commit}; scratch ${scratch}`);
    app = prepareApp(scratch, commit);
    env = stateEnvironment(scratch);
    const repo = writeDemoRepository(options.demoRoot);
    demoCreated = true;
    sd(app, env, "start");
    browser = await chromium.launch({ channel: "chromium", headless: true, args: [...CHROMIUM_ARGS] });
    const state: Run = {
      options, commit, out, repo, ffmpeg, scratch,
      password: (await import("node:crypto")).randomBytes(18).toString("base64url"),
      hostUser: userInfo().username,
      setup: null, surfaces: [], animation: null, images: [], violations: [],
    };
    await drive(state, browser);
    const chromiumVersion = browser.version();
    state.violations.push(...[...offOrigin].sort());
    if (state.violations.length > 0) throw new CaptureRefusal(options.judgeOnly ? "rendered_judgement_failed" : "capture_unpublishable", `\n  ${state.violations.join("\n  ")}`);
    if (options.judgeOnly) {
      log(`judged every view as rendered: the mark, the fonts and the network hold (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      return;
    }
    const scripts: Record<string, Uint8Array> = {};
    for (const name of readdirSync(HERE).filter((f) => f.endsWith(".ts")).toSorted()) scripts[`scripts/capture/${name}`] = readFileSync(join(HERE, name));
    const playwrightVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "playwright-core", "package.json"), "utf8")) as { version: string }).version;
    const vendored = existsSync(join(app, "public", "fonts"));
    const manifest = buildManifest({
      commit,
      recipeHash: recipeHash(scripts),
      chromium: chromiumVersion,
      playwright: playwrightVersion,
      fonts: { vendored, note: vendored ? "IBM Plex served from public/fonts" : "public/fonts is absent at this commit: text renders in the host's fallback font, so images compare only on one host" },
      images: state.images,
      animation: state.animation,
    });
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`done: ${state.images.length} images + GIF in ${out} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  } finally {
    if (browser !== null) await browser.close().catch((error: unknown) => log(`browser close: ${String(error)}`));
    if (app !== null && env !== null) {
      try { sd(app, env, "stop"); } catch (error) { console.error(`[capture] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    }
    if (demoCreated && existsSync(join(options.demoRoot, DEMO_MARKER))) rmSync(options.demoRoot, { recursive: true });
    if (options.keepScratch) log(`scratch kept: ${scratch}`);
    else if (existsSync(join(scratch, SCRATCH_MARKER)) && statSync(scratch).isDirectory()) rmSync(scratch, { recursive: true });
  }
}

main().catch((error: unknown) => {
  console.error(`[capture] REFUSED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
