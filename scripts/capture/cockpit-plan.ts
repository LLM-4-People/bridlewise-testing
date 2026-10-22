/**
 * THE COCKPIT CAPTURE'S PLAN — every pure decision of `cockpit.ts`, as data.
 *
 * The runner (`scripts/capture/cockpit.ts`) is the impure half: it copies the
 * tree, starts the app, drives Chromium and writes files. Everything that
 * decides WHAT is captured and HOW it is made stable lives here so it is one
 * reviewable value and a unit test can hold it (`tests/unit/capture-cockpit-plan.test.ts`):
 *
 * - the fixed sequence (account → project → provider placeholder → one
 *   fixture run → each room), per theme and per viewport;
 * - the demo repository, byte for byte, with fixed commit dates so its
 *   commit ids are the same on every run;
 * - the masks: the volatile values the server stamps with the real clock
 *   (it honours no fixed-clock variable) or measures live (ttft, tok/s,
 *   token counts, instrument readings) are replaced by an explicit
 *   bracketed label, never blanked silently;
 * - the labels: every capture of the fixture run says "fixture replay";
 * - the manifest and the recipe hash.
 */
import { createHash } from "node:crypto";

export const CAPTURE_MANIFEST_SCHEMA = "bridlewise.cockpit-capture/1";

/** The app's ports. The web port is Vite's strictPort (fixed); the API port is the server default. */
export const WEB_PORT = 5173;
export const API_PORT = 5174;
export const APP_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

export const THEMES = ["carbon", "logbook"] as const;
export type Theme = (typeof THEMES)[number];
/** The cockpit's own preference key (`src/cockpit/settings/local-prefs.ts`, prefixed by its store). */
export const THEME_STORAGE_KEY = "bridlewise:cockpitTheme";

export interface ViewportSpec {
  readonly width: number;
  readonly height: number;
  readonly isMobile: boolean;
}
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900, isMobile: false },
  mobile: { width: 390, height: 844, isMobile: true },
} as const satisfies Record<string, ViewportSpec>;
export type ViewportId = keyof typeof VIEWPORTS;
export const VIEWPORT_IDS = Object.keys(VIEWPORTS) as ViewportId[];

/** Device pixel ratio 1 everywhere: one CSS pixel is one image pixel. */
export const DEVICE_SCALE_FACTOR = 1;

/**
 * The browser clock's fixed instant (Playwright `clock.setFixedTime`): every
 * `Date.now()` in the page answers this. The SERVER has no fixed-clock
 * variable, so a value it stamps is masked instead (see TEXT_MASKS).
 */
export const FIXED_INSTANT_ISO = "2026-01-15T09:30:00.000Z";

/**
 * Chromium with no GPU process at all (user rule BL-GPU): plain
 * `--disable-gpu` still spawns one; these three together keep the GPU work
 * in-process and software-composited. The runner refuses a launch that
 * spawned a `--type=gpu-process` child anyway.
 */
export const CHROMIUM_ARGS = ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu"] as const;

/** Injected into every page: no motion, no caret blink, nothing that moves between two frames. */
export const STILLNESS_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";

// ── The demo repository ──

export interface DemoCommit {
  readonly message: string;
  /** Author AND committer date: a fixed date makes the commit id reproducible. */
  readonly date: string;
  readonly files: Readonly<Record<string, string>>;
}

const TIDES_HIGH = [
  "export interface Reading { at: Date; heightMeters: number }",
  "",
  "/** The highest reading in a day of readings. */",
  "export function highWater(readings: Reading[]): Reading | undefined {",
  "  return readings.reduce<Reading | undefined>((best, r) => (best === undefined || r.heightMeters > best.heightMeters ? r : best), undefined);",
  "}",
  "",
].join("\n");

const TIDES_LOW = [
  "",
  "/** The lowest reading in a day of readings. */",
  "export function lowWater(readings: Reading[]): Reading | undefined {",
  "  return readings.reduce<Reading | undefined>((best, r) => (best === undefined || r.heightMeters < best.heightMeters ? r : best), undefined);",
  "}",
  "",
].join("\n");

const SERVER_INDEX = [
  'import { highWater, type Reading } from "../src/tides.ts";',
  "",
  "/** Parses a request body into readings at the trust boundary. */",
  "export function parseReadings(body: unknown): Reading[] {",
  '  if (!Array.isArray(body)) throw new TypeError("readings must be an array");',
  "  return body.map((r) => ({ at: new Date(String(r.at)), heightMeters: Number(r.heightMeters) }));",
  "}",
  "",
  "export function answer(body: unknown): string {",
  "  const top = highWater(parseReadings(body));",
  '  return top === undefined ? "no readings" : `high water ${top.heightMeters} m at ${top.at.toISOString()}`;',
  "}",
  "",
].join("\n");

/**
 * "Tidewater": a scripted two-commit repository, plus one uncommitted change
 * made after the run so Custody has a diff to show. `server/index.ts` exists
 * before the run because the fixture stream reads it.
 */
export const DEMO_REPOSITORY = {
  projectName: "Tidewater",
  folder: "tidewater",
  branch: "main",
  identity: { name: "Tidewater demo", email: "demo@example.invalid" },
  commits: [
    {
      message: "Initial tide calculator",
      date: "2026-01-14T10:00:00Z",
      files: {
        "README.md": "# Tidewater\n\nA small tide-table calculator used as a demo project.\n",
        "package.json": '{ "name": "tidewater", "version": "0.1.0", "type": "module" }\n',
        "src/tides.ts": TIDES_HIGH,
      },
    },
    {
      message: "Add the request boundary",
      date: "2026-01-14T11:00:00Z",
      files: { "server/index.ts": SERVER_INDEX },
    },
  ] satisfies readonly DemoCommit[],
  uncommitted: { path: "src/tides.ts", content: TIDES_HIGH + TIDES_LOW },
} as const;

/**
 * The demo repository's parent folder. Its absolute path is printed by the
 * editor header, so it must name no host user: a folder under `/home/<user>`
 * would publish the user name in every editor capture.
 */
export const DEFAULT_DEMO_ROOT = "/tmp/bridlewise-capture";

/**
 * The saved provider the fixture stream still requires. With
 * HARNESS_WEB_LLM_FIXTURES=1 no request leaves the server: the base URL is a
 * reserved `.invalid` name and the key is a literal placeholder, not a key.
 */
export const PROVIDER_PLACEHOLDER = {
  name: "Fixture replay",
  baseUrl: "https://fixture.invalid/v1",
  apiKey: "placeholder-not-a-key",
  modelId: "fixture-model",
} as const;

export const ACCOUNT_USERNAME = "demo";
export const RUN_PROMPT = "Where does the server check its input? Read server/index.ts.";

// ── The fixed sequence ──

/** A view the runner prepares before a capture (the runner holds one handler per id). */
export const VIEW_ACTIONS = [
  "openRoot",
  "openSwitch",
  "openChat",
  "openAddProvider",
  "openRunConversation",
  "expandToolOutput",
  "openContextAndTools",
  "openInstruments",
  "openLensCallout",
  "openCustody",
  "openCustodyDiff",
  "openEditorFile",
  "openSettings",
] as const;
export type ViewAction = (typeof VIEW_ACTIONS)[number];

/** A state change: `once` runs in the setup page, `each` in every capture page. */
export const STATE_ACTIONS = [
  "signUp",
  "signIn",
  "createProject",
  "saveProvider",
  "fixtureRun",
  "dirtyWorkingTree",
  "reload",
] as const;
export type StateAction = (typeof STATE_ACTIONS)[number];

export type Stage =
  | { readonly kind: "once"; readonly action: StateAction }
  | { readonly kind: "each"; readonly action: StateAction }
  | {
      readonly kind: "shot";
      readonly id: string;
      readonly slug: string;
      readonly action: ViewAction;
      readonly viewports: readonly ViewportId[];
      /** True for every view of the fixture run: the capture wears the "fixture replay" label. */
      readonly fixtureRun: boolean;
    };

const BOTH: readonly ViewportId[] = ["desktop", "mobile"];
const DESKTOP: readonly ViewportId[] = ["desktop"];

export const SEQUENCE: readonly Stage[] = [
  { kind: "shot", id: "00", slug: "create-account", action: "openRoot", viewports: BOTH, fixtureRun: false },
  { kind: "once", action: "signUp" },
  { kind: "each", action: "reload" },
  { kind: "shot", id: "01", slug: "sign-in", action: "openRoot", viewports: BOTH, fixtureRun: false },
  { kind: "each", action: "signIn" },
  { kind: "shot", id: "02", slug: "switch-empty", action: "openSwitch", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "03", slug: "chat-no-project", action: "openChat", viewports: BOTH, fixtureRun: false },
  { kind: "once", action: "createProject" },
  { kind: "each", action: "reload" },
  { kind: "shot", id: "04", slug: "add-provider", action: "openAddProvider", viewports: BOTH, fixtureRun: false },
  { kind: "once", action: "saveProvider" },
  { kind: "once", action: "fixtureRun" },
  { kind: "once", action: "dirtyWorkingTree" },
  { kind: "each", action: "reload" },
  { kind: "shot", id: "10", slug: "switch-project", action: "openSwitch", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "20", slug: "chat-fixture-run", action: "openRunConversation", viewports: BOTH, fixtureRun: true },
  { kind: "shot", id: "21", slug: "chat-tool-output", action: "expandToolOutput", viewports: BOTH, fixtureRun: true },
  { kind: "shot", id: "22", slug: "chat-context-and-tools", action: "openContextAndTools", viewports: DESKTOP, fixtureRun: true },
  { kind: "shot", id: "30", slug: "instruments", action: "openInstruments", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "31", slug: "lens-callout", action: "openLensCallout", viewports: DESKTOP, fixtureRun: false },
  { kind: "shot", id: "40", slug: "custody", action: "openCustody", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "41", slug: "custody-diff", action: "openCustodyDiff", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "50", slug: "editor-file", action: "openEditorFile", viewports: BOTH, fixtureRun: false },
  { kind: "shot", id: "60", slug: "settings", action: "openSettings", viewports: BOTH, fixtureRun: false },
];

export type ShotStage = Extract<Stage, { kind: "shot" }>;

export function captureFileName(stage: ShotStage, theme: Theme, viewport: ViewportId): string {
  return `${stage.id}-${stage.slug}-${theme}-${viewport}.png`;
}

/** Every image one complete run writes, in sequence order. */
export function plannedCaptures(sequence: readonly Stage[] = SEQUENCE): readonly { file: string; stage: ShotStage; theme: Theme; viewport: ViewportId }[] {
  const out: { file: string; stage: ShotStage; theme: Theme; viewport: ViewportId }[] = [];
  for (const stage of sequence) {
    if (stage.kind !== "shot") continue;
    for (const viewport of VIEWPORT_IDS) {
      if (!stage.viewports.includes(viewport)) continue;
      for (const theme of THEMES) out.push({ file: captureFileName(stage, theme, viewport), stage, theme, viewport });
    }
  }
  return out;
}

// ── Masks and labels ──

/**
 * A volatile value inside text: the whole match is replaced by `[label]`.
 * The server stamps times with its real clock and measures throughput live,
 * so these differ on every run; a masked value is SAID to be masked.
 * Order matters: the more specific rule runs first.
 */
export interface TextMask {
  readonly id: string;
  readonly label: string;
  /** A JavaScript regular expression source, applied with the `gu` flags. */
  readonly source: string;
}
export const TEXT_MASKS: readonly TextMask[] = [
  { id: "run-id", label: "run id", source: String.raw`\brun-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b` },
  { id: "uuid", label: "id", source: String.raw`\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b` },
  { id: "iso-date", label: "date", source: String.raw`\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b` },
  { id: "clock-time", label: "time", source: String.raw`\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b` },
  { id: "relative-age", label: "age", source: String.raw`\b\d+\s?(?:s|sec|m|min|h|hr|d|w|mo|y)\s+ago\b` },
  { id: "ttft", label: "ttft", source: String.raw`\bttft\s+\d[\d.,]*\s?(?:ms|s)\b` },
  { id: "throughput", label: "tok/s", source: String.raw`\b\d[\d.,]*\s?tok/s\b` },
  { id: "token-ratio", label: "tokens", source: String.raw`\b\d[\d,]*\s?/\s?\d[\d,]*\s?tok\b` },
  { id: "token-arrow", label: "tokens", source: String.raw`[↑↓]\s?\d[\d,]*(?:\s?tok\b)?` },
  // "tok" is the run's measured unit; a setting's "tokens" is configuration and stays.
  { id: "token-count", label: "tokens", source: String.raw`\b\d[\d,]*\s?tok\b` },
  // A measured duration is printed unspaced ("44ms"); a setting's value is spaced ("30 ms") and stays.
  { id: "duration", label: "duration", source: String.raw`\b\d+(?:\.\d+)?ms\b` },
  { id: "event-count", label: "events", source: String.raw`\b\d[\d,]*\sevents?\b` },
  { id: "rate", label: "rate", source: String.raw`\b\d[\d.,]*\s?updates/s\b` },
  { id: "point-count", label: "points", source: String.raw`\b\d+ measured points?\b` },
  { id: "record-span", label: "span", source: String.raw`\b\d+(?:\.\d+)?\s?(?:ms|s|m|h) of the record\b` },
];

/**
 * A region whose whole content is a live reading (a value AND its drawing):
 * its children are hidden in place (the layout keeps its size) and the
 * region shows `[label]` instead.
 */
export interface RegionMask {
  readonly id: string;
  readonly label: string;
  readonly selector: string;
}
/**
 * The instruments whose reading moves while the harness runs (measured: two
 * runs of this capture differ only in these, and in the values the text masks
 * name). A new moving reading fails the run's stillness proof; it is added here.
 */
export const VOLATILE_SIGNALS = ["awareness.computationTime", "awareness.updateRate", "awareness.lastUpdate", "awareness.refreshCount"] as const;

export const REGION_MASKS: readonly RegionMask[] = [
  { id: "instrument-reading", label: "live reading", selector: VOLATILE_SIGNALS.map((id) => `.cell[data-signal="${id}"] .readout`).join(",") },
  { id: "header-monitor", label: "live reading", selector: "header.horizon button.monitor" },
];

export const FIXTURE_REPLAY_LABEL = "fixture replay — no model was called";
export const MASK_LEGEND = "[bracketed] = volatile value masked";

/**
 * The badge a capture wears: the fixture label on every run capture, the
 * mask legend on every capture that shows a mask; none on a capture with neither.
 */
export function badgeText(fixtureRun: boolean, masked: boolean): string | null {
  const parts = [...(fixtureRun ? [FIXTURE_REPLAY_LABEL] : []), ...(masked ? [MASK_LEGEND] : [])];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The mask labels shown in a page's text, counted (`[time]` → { time: 1 }). */
export function maskedLabels(text: string, masks: readonly TextMask[] = TEXT_MASKS, regions: readonly RegionMask[] = REGION_MASKS): Record<string, number> {
  const labels = new Set([...masks, ...regions].map((mask) => mask.label));
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(/\[([^\[\]\n]{1,24})\]/gu)) {
    const label = match[1]!;
    if (labels.has(label)) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** Applies the text masks to one string; answers the masked text and the count per rule. */
export function maskText(text: string, masks: readonly TextMask[] = TEXT_MASKS): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const mask of masks) {
    out = out.replace(new RegExp(mask.source, "gu"), () => {
      counts[mask.id] = (counts[mask.id] ?? 0) + 1;
      return `[${mask.label}]`;
    });
  }
  return { text: out, counts };
}

/** The volatile values still present in a page's text (the after-mask proof: must be empty). */
export function unmaskedValues(text: string, masks: readonly TextMask[] = TEXT_MASKS): readonly string[] {
  const found: string[] = [];
  for (const mask of masks) for (const match of text.matchAll(new RegExp(mask.source, "gu"))) found.push(`${mask.id}: ${match[0]}`);
  return found;
}

/**
 * Host identity in a page's text: any home path, and the host user name
 * itself. A capture that would publish either is refused.
 */
export function hostLeaks(text: string, hostUser: string): readonly string[] {
  const leaks: string[] = [];
  for (const match of text.matchAll(/\/(?:home|Users)\/[^\s/]*/gu)) leaks.push(match[0]);
  if (hostUser.length >= 3 && text.includes(hostUser)) leaks.push(`user name "${hostUser}"`);
  return leaks;
}

// ── The recipe hash and the manifest ──

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with sorted keys: the same value always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Every input that decides a capture's pixels, besides the scripts' bytes and the captured commit. */
export function planInputs(): unknown {
  return {
    schema: CAPTURE_MANIFEST_SCHEMA,
    themes: THEMES,
    viewports: VIEWPORTS,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    fixedInstant: FIXED_INSTANT_ISO,
    chromiumArgs: CHROMIUM_ARGS,
    stillnessCss: STILLNESS_CSS,
    demoRepository: DEMO_REPOSITORY,
    provider: PROVIDER_PLACEHOLDER,
    username: ACCOUNT_USERNAME,
    prompt: RUN_PROMPT,
    sequence: SEQUENCE,
    textMasks: TEXT_MASKS,
    regionMasks: REGION_MASKS,
    labels: { fixture: FIXTURE_REPLAY_LABEL, legend: MASK_LEGEND },
  };
}

/** sha256 over the recipe's script files (path-sorted) and the plan's inputs. */
export function recipeHash(scripts: Readonly<Record<string, string | Uint8Array>>, inputs: unknown = planInputs()): string {
  const files = Object.keys(scripts)
    .toSorted()
    .map((path) => [path, sha256(scripts[path] ?? "")]);
  return sha256(canonicalJson({ files, inputs }));
}

export interface CapturedImage {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly theme: Theme;
  readonly viewport: ViewportId;
  readonly stage: string;
  readonly fixtureReplay: boolean;
  readonly masked: Readonly<Record<string, number>>;
  /** sha256 of the page text at capture time (after masking). */
  readonly textSha256: string;
}

export interface CaptureManifest {
  readonly schema: typeof CAPTURE_MANIFEST_SCHEMA;
  readonly commit: string;
  readonly recipeHash: string;
  readonly chromium: string;
  readonly playwright: string;
  readonly fonts: { readonly vendored: boolean; readonly note: string };
  readonly clock: { readonly browser: string; readonly server: string };
  readonly images: readonly CapturedImage[];
  readonly animation: { readonly webm: { file: string; sha256: string }; readonly gif: { file: string; sha256: string; frames: number; width: number; height: number } } | null;
}

/**
 * The manifest of one run. Refuses an image set that is not exactly the
 * planned set: a capture that silently went missing is not a smaller success.
 */
export function buildManifest(input: Omit<CaptureManifest, "schema" | "clock" | "images"> & { readonly images: readonly CapturedImage[] }): CaptureManifest {
  const planned = plannedCaptures().map((capture) => capture.file);
  const got = input.images.map((image) => image.file);
  const missing = planned.filter((file) => !got.includes(file));
  const extra = got.filter((file) => !planned.includes(file));
  if (missing.length > 0 || extra.length > 0 || new Set(got).size !== got.length) {
    throw new Error(`capture_set_mismatch: missing [${missing.join(", ")}], unplanned [${extra.join(", ")}], ${got.length - new Set(got).size} duplicate(s)`);
  }
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new Error(`capture_commit_invalid: "${input.commit}" is not a full commit id`);
  const order = new Map(planned.map((file, index) => [file, index]));
  return {
    schema: CAPTURE_MANIFEST_SCHEMA,
    commit: input.commit,
    recipeHash: input.recipeHash,
    chromium: input.chromium,
    playwright: input.playwright,
    fonts: input.fonts,
    clock: {
      browser: `fixed at ${FIXED_INSTANT_ISO} (Playwright clock.setFixedTime)`,
      server: "real clock (the server honours no fixed-clock variable); its stamped values are masked and labelled",
    },
    images: input.images.toSorted((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0)),
    animation: input.animation,
  };
}
