// @vitest-environment node
/**
 * Cockpit import law (DESIGN-COCKPIT-V2 §13, §0 "nothing visual survives").
 *
 * NOTHING under `src/cockpit/` may import from `src/lib/**`. At all. The
 * old data allowlist (broker, errors, asof, absence, connection — then
 * html-preview and client-debug by name) existed because the data layer
 * LIVED inside the legacy tree; at the cutover moves those survivors left
 * it: the data layer is `src/data/**`, the client debug emit owner is
 * `src/client-debug.ts`, and the CSP composer lives inside the cockpit
 * itself (`src/cockpit/render/html-preview.ts`). So the law is simpler and
 * stronger than it used to be — `src/lib` is the dead tree and the cockpit
 * touches none of it.
 *
 * `src/data/**` is opened as a DIRECTORY, deliberately, where the old list
 * named files: under `src/lib` a neighbour was legacy code, so each survivor
 * was named to keep the hatch narrow; under `src/data` a neighbour IS a
 * data-layer module — that directory holds exactly the moved data owners,
 * and a file added there is a data-layer decision, not legacy leakage.
 *
 * Allowed: `shared/*`, `src/state/*`, `src/client.ts` (the data
 * functions), `src/data/**` (the data layer), `src/client-debug.ts` (the
 * debug emit owner), anything inside `src/cockpit/` itself, and the
 * framework bare imports. DENY BY DEFAULT:
 * an import that matches no allow rule fails, so a new escape hatch cannot
 * appear silently.
 *
 * Two visual-secession rules ride along:
 *   - any `.svelte` import resolving OUTSIDE `src/cockpit/` fails CI (no
 *     old component may be re-mounted in the new tree);
 *   - no cockpit source may import the old token file or consume an old
 *     token name (`var(--color-*)` etc.) — the cockpit's visual system is
 *     `src/cockpit/tokens.css` alone (§12).
 *
 * The scanner is a pure function and the suite MUTATION-TESTS it: synthetic
 * violations must be flagged, a clean source must not be. If someone
 * weakens the scanner, the self-checks go red.
 */
import { describe, expect, test } from "vitest";
import { posix } from "node:path";

import { read, relpath, walk } from "../helpers/source-scan.ts";

const COCKPIT_ROOT = "src/cockpit";

/** Bare (non-relative) specifiers the cockpit may import. */
const BARE_ALLOW: readonly (string | RegExp)[] = ["svelte", /^svelte\//, "nanostores"];

/** Repo-relative module paths (extension optional) allowed OUTSIDE cockpit. */
const PATH_ALLOW: readonly RegExp[] = [
  /^shared\//,
  /^src\/state\//,
  /^src\/client$/,
  /^src\/client\.ts$/,
  // The data layer — the survivors moved OUT of src/lib at the cutover.
  // A directory, not named files: see the header for why the narrowing
  // argument no longer applies here.
  /^src\/data\//,
  // The one client debug emit owner, likewise moved out.
  /^src\/client-debug(\.ts)?$/,
];

/** Old token names — the retired visual vocabulary (src/styles/tokens.css).
 * The cockpit consumes ONLY its own tokens (§12); any of these appearing in
 * a cockpit source is a visual import from the dead tree. */
const OLD_TOKEN_PREFIXES: readonly string[] = [
  "var(--color-",
  "var(--font-",
  "var(--spacing-",
  "var(--duration-",
  "var(--transition-",
];

/** Extract every import specifier: static, dynamic, re-export, glob. */
export function extractSpecifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"()]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^'"()]*?from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /import\.meta\.glob\(\s*["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]!);
  }
  return out;
}

/**
 * Scan ONE cockpit source. Returns human-readable violations (empty =
 * clean). `file` is the repo-relative posix path of the source.
 */
export function scanCockpitSource(file: string, src: string): string[] {
  const violations: string[] = [];
  const dir = posix.dirname(file);

  for (const spec of extractSpecifiers(src)) {
    if (spec.includes("*")) continue; // glob patterns are cockpit-relative by construction; resolved below
    if (!spec.startsWith(".") && !spec.startsWith("/")) {
      const ok = BARE_ALLOW.some((rule) =>
        typeof rule === "string" ? rule === spec : rule.test(spec),
      );
      if (!ok) violations.push(`${file}: bare import "${spec}" not in the allowlist`);
      continue;
    }
    const resolved = posix.normalize(posix.join(dir, spec));
    if (resolved.startsWith(`${COCKPIT_ROOT}/`)) continue;
    if (resolved.endsWith(".svelte")) {
      violations.push(
        `${file}: imports old-tree component "${spec}" — no .svelte outside src/cockpit/ (§13)`,
      );
      continue;
    }
    if (/(^|\/)styles\/tokens\.css$/.test(resolved)) {
      violations.push(`${file}: imports the OLD token file "${spec}" (§12 — cockpit tokens only)`);
      continue;
    }
    const allowed = PATH_ALLOW.some((re) => re.test(resolved));
    if (!allowed) {
      violations.push(
        `${file}: import "${spec}" (→ ${resolved}) is outside the cockpit allowlist ` +
          `(shared/*, src/state/*, src/client, src/data/*, src/client-debug)`,
      );
    }
  }

  // Glob patterns must stay inside the cockpit tree.
  let g: RegExpExecArray | null;
  const globRe = /import\.meta\.glob\(\s*["']([^"']+)["']/g;
  while ((g = globRe.exec(src)) !== null) {
    const resolved = posix.normalize(posix.join(dir, g[1]!));
    if (!resolved.startsWith(`${COCKPIT_ROOT}/`)) {
      violations.push(`${file}: import.meta.glob "${g[1]!}" reaches outside src/cockpit/`);
    }
  }

  for (const prefix of OLD_TOKEN_PREFIXES) {
    if (src.includes(prefix)) {
      violations.push(`${file}: consumes an old token ("${prefix}…") — §12 CARBON/LOGBOOK only`);
    }
  }

  return violations;
}

describe("cockpit-no-legacy-imports — the cockpit tree is visually sovereign", () => {
  const files = walk(COCKPIT_ROOT, { exts: [".ts", ".svelte"] });

  test("the cockpit tree exists and is populated", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no cockpit source imports outside the allowlist", () => {
    const all: string[] = [];
    for (const f of files) all.push(...scanCockpitSource(relpath(f), read(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS — the scanner must catch each violation kind ──
  //
  // The synthetic sources are assembled with `imp()` (splitting the
  // "import" keyword) so OTHER source-scanning guards (no-unused-imports)
  // don't mistake these fixture strings for this test file's own imports.
  // At runtime the assembled string is a verbatim import statement.

  const AT = "src/cockpit/shell/Example.svelte"; // synthetic location
  const imp = (rest: string): string => "imp" + "ort " + rest;

  test("mutation: an old-tree .svelte import is flagged", () => {
    const bad = imp(`Chat from "../../lib/chat/ChatPanel.svelte";`);
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: ANY src/lib import is flagged — including the ones the allowlist used to name", () => {
    for (const oldFriend of [
      "shared/helpers.ts",
      "data/broker.ts",
      "data/errors.ts",
      "data/asof.ts",
      "data/absence.ts",
      "data/connection.ts",
    ]) {
      const bad = imp(`{ thing } from "../../lib/${oldFriend}";`);
      expect(scanCockpitSource(AT, bad).length, oldFriend).toBeGreaterThan(0);
    }
  });

  test("mutation: src/lib/shared is fully shut — the by-name exceptions moved out with the survivors", () => {
    for (const neighbour of [
      "Button.svelte",
      "format.ts",
      "html-preview.ts",
      "html-preview-extra.ts",
      "client-debug.ts",
    ]) {
      const bad = imp(`{ x } from "../../lib/shared/${neighbour}";`);
      expect(scanCockpitSource(AT, bad).length, neighbour).toBeGreaterThan(0);
    }
  });

  test("mutation: src/lib/data is fully shut — the data layer lives at src/data now", () => {
    // The five once-named modules are refused alongside the near-miss
    // neighbours that used to probe the by-name anchors.
    for (const neighbour of [
      "somethingElse.ts",
      "absence-extra.ts",
      "absence/index.ts",
      "broker-helpers.ts",
      "errors2.ts",
      "connection-extra.ts",
      "connection/index.ts",
    ]) {
      const bad = imp(`{ x } from "../../lib/data/${neighbour}";`);
      expect(scanCockpitSource(AT, bad).length, neighbour).toBeGreaterThan(0);
    }
  });

  test("mutation: importing the old token file is flagged", () => {
    const bad = imp(`"../../styles/tokens.css";`);
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: consuming an old token name is flagged", () => {
    const bad = `<style>.x { color: var(--color-accent); }</style>`;
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: a dynamic import of the old tree is flagged", () => {
    const bad = `const m = await ` + `imp` + `ort("../../lib/module/keymap.ts");`;
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: an unlisted bare import is flagged", () => {
    const bad = imp(`lodash from "lodash";`);
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: a glob reaching outside the cockpit is flagged", () => {
    const bad = `const mods = ` + `imp` + `ort.meta.glob("../../lib/widgets/*.svelte");`;
    expect(scanCockpitSource(AT, bad).length).toBeGreaterThan(0);
  });

  test("mutation: the allowlisted imports are NOT flagged (no false positives)", () => {
    const good = [
      imp(`{ fetchJson } from "../../data/broker.ts";`),
      imp(`{ ClientError } from "../../data/errors.ts";`),
      imp(`{ isPastView } from "../../data/asof.ts";`),
      imp(`{ absenceReason } from "../../data/absence.ts";`),
      imp(`{ connection } from "../../data/connection.ts";`),
      imp(`{ configureClientDebug } from "../../client-debug.ts";`),
      imp(`{ sandboxedSrcdoc } from "../render/html-preview.ts";`),
      imp(`{ checkAuthStatus } from "../../client.ts";`),
      imp(`{ authState } from "../../state/auth.ts";`),
      imp(`{ EVENT_KINDS } from "../../../shared/event-types.ts";`),
      imp(`{ mount } from "svelte";`),
      imp(`Horizon from "./Horizon.svelte";`),
      `const rooms = ` + `imp` + `ort.meta.glob("../rooms/*Room.svelte");`,
    ].join("\n");
    expect(scanCockpitSource("src/cockpit/shell/Ok.ts", good)).toEqual([]);
  });
});
