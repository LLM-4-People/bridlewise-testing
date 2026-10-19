// @vitest-environment node
/**
 * Labelled index rail — one recipe so a nowrap map cannot clip its first
 * glyphs or wrap a declared title. The scanners are the instrument the
 * mutations drive; a copy beside the arm would keep passing if the arm
 * drifted.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripCssBlockComments, walk } from "../helpers/source-scan.ts";

const TOKENS = "src/cockpit/tokens.css";
const SETTINGS = "src/cockpit/rooms/SettingsRoom.svelte";
const HOST = "src/cockpit/shell/RoomHost.svelte";
const LOCAL_PREFS = "src/cockpit/settings/local-prefs.ts";
const EXPOSURE_REGS = "engine/src/shared/exposure/registrations";

export function cssRulesForClass(css: string, className: string): string[] {
  const stripped = stripCssBlockComments(css);
  const out: string[] = [];
  const re = new RegExp(`(^|})([^{}]*\\.${className}\\b[^{}]*)\\{`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(stripped.slice(start, i));
          break;
        }
      }
    }
  }
  return out;
}

export function cssRuleAt(css: string, selector: string): string {
  const stripped = stripCssBlockComments(css);
  const needle = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|})\\s*${needle}\\s*\\{`, "m");
  const m = re.exec(stripped);
  if (m === null) return "";
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i);
    }
  }
  return "";
}

export function indexRailMaxCh(css: string): number | null {
  const m = /--index-rail-max\s*:\s*(\d+(?:\.\d+)?)ch\s*;/.exec(stripCssBlockComments(css));
  return m === null ? null : Number(m[1]);
}

export function declaredCategoryTitles(): string[] {
  const out: string[] = [];
  const localBlock = /export const LOCAL_MODULES[\s\S]*?\];/.exec(read(LOCAL_PREFS))?.[0] ?? "";
  for (const m of localBlock.matchAll(/\btitle:\s*"([^"]+)"/g)) out.push(m[1]!);
  for (const f of walk(EXPOSURE_REGS, { exts: [".ts"] })) {
    const src = read(f);
    for (const block of src.matchAll(/registerExposureModule\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      const title = /\btitle:\s*"([^"]+)"/.exec(block[1] ?? "")?.[1];
      if (title !== undefined) out.push(title);
    }
  }
  for (const m of read(SETTINGS).matchAll(/<span class="rail-title">([^<{]+)<\/span>/g)) {
    const title = m[1]!.trim();
    if (title.length > 0) out.push(title);
  }
  return [...new Set(out)];
}

export function indexRailFindings(input: {
  tokens: string;
  settings: string;
  host: string;
  consumers: readonly { path: string; src: string }[];
  titles: readonly string[];
}): string[] {
  const out: string[] = [];
  const tokens = stripCssBlockComments(input.tokens);
  const rail = cssRuleAt(input.tokens, ".cockpit .index-rail");
  if (rail.length === 0) {
    out.push("tokens lost .cockpit .index-rail");
    return out;
  }
  if (!/width\s*:\s*max-content/.test(rail)) {
    out.push(".index-rail width is not max-content — the rail must follow the longest row");
  }
  if (!/max-width\s*:\s*min\(\s*100%\s*,\s*var\(--index-rail-max\)\s*\)/.test(rail)) {
    out.push(".index-rail max-width must be min(100%, var(--index-rail-max)) so a tight ch cap cannot clip the first glyphs");
  }

  const maxCh = indexRailMaxCh(input.tokens);
  const longest = input.titles.reduce((n, t) => Math.max(n, t.length), 0);
  if (maxCh === null) {
    out.push("--index-rail-max is not a ch ceiling the title-length ratchet can judge");
  } else if (longest === 0) {
    out.push("declared category titles were empty — the ceiling ratchet had no population");
  } else if (maxCh < longest) {
    out.push(
      `--index-rail-max: ${maxCh}ch is below the longest declared title (${longest} chars) — nowrap + overflow-y auto will clip glyphs`,
    );
  }

  const entryRules = cssRulesForClass(input.tokens, "rail-entry").concat(
    cssRulesForClass(input.tokens, "rail-empty"),
  );
  const gridOwned = entryRules.some(
    (body) => /display\s*:\s*grid/.test(body) && /grid-template-columns\s*:\s*1fr\s+auto/.test(body),
  );
  if (!gridOwned) {
    out.push("tokens must own title|count as display:grid; grid-template-columns: 1fr auto on .rail-entry / .rail-empty");
  }

  const titleRules = cssRulesForClass(input.tokens, "rail-title");
  if (!titleRules.some((body) => /white-space\s*:\s*nowrap/.test(body))) {
    out.push("tokens .rail-title must nowrap — a wrap is a second line, not a map");
  }
  if (titleRules.some((body) => /min-width\s*:\s*0/.test(body))) {
    out.push("tokens .rail-title min-width:0 is the wrap fight against nowrap");
  }
  if (!titleRules.some((body) => /min-width\s*:\s*max-content/.test(body))) {
    out.push("tokens .rail-title min-width must be max-content so the rail grows instead of shrinking the words");
  }

  const settingsStyle = input.settings.slice(input.settings.indexOf("<style"));
  for (const body of cssRulesForClass(settingsStyle, "rail-title")) {
    if (/min-width\s*:\s*0/.test(body)) {
      out.push("SettingsRoom .rail-title min-width:0 fights the token nowrap");
    }
    if (/white-space\s*:\s*(normal|pre-wrap|pre-line)/.test(body)) {
      out.push("SettingsRoom .rail-title restates wrapping against the token nowrap");
    }
  }
  for (const body of cssRulesForClass(settingsStyle, "rail-entry")) {
    if (/display\s*:\s*flex/.test(body)) {
      out.push("SettingsRoom .rail-entry display:flex restates the token grid");
    }
  }
  for (const body of cssRulesForClass(settingsStyle, "rail-count")) {
    if (/margin-left\s*:\s*auto/.test(body)) {
      out.push("SettingsRoom .rail-count margin-left:auto collides with a max-width clip; the token grid owns the count column");
    }
  }
  if (!/class="index-rail settings-rail"/.test(input.settings) && !/class="index-rail /.test(input.settings)) {
    out.push("SettingsRoom must consume .index-rail, not invent a second rail");
  }

  const hostStyle = input.host.slice(input.host.indexOf("<style"));
  const bodyRule = cssRuleAt(hostStyle, ".body");
  if (bodyRule.length === 0) {
    out.push("RoomHost lost .body");
  } else {
    if (/place-items\s*:\s*center/.test(bodyRule)) {
      out.push("RoomHost .body place-items:center center-clips an overflowing map's first glyphs");
    }
    if (!/justify-items\s*:\s*stretch/.test(bodyRule)) {
      out.push("RoomHost .body must justify-items:stretch so the index starts at the cell's left edge");
    }
  }

  for (const c of input.consumers) {
    if (!/\bindex-rail\b/.test(c.src)) continue;
    const style = c.src.slice(c.src.indexOf("<style"));
    for (const body of cssRulesForClass(style, "rail-title")) {
      if (/min-width\s*:\s*0/.test(body)) {
        out.push(`${c.path}: .rail-title min-width:0 fights the shared index-rail recipe`);
      }
    }
  }

  if (!tokens.includes(".cockpit .index-rail")) {
    out.push("tokens lost the .cockpit .index-rail owner");
  }
  return out;
}

function liveInput() {
  const consumers = walk("src/cockpit", { exts: [".svelte"] }).map((f) => ({
    path: relpath(f),
    src: read(f),
  }));
  return {
    tokens: read(TOKENS),
    settings: read(SETTINGS),
    host: read(HOST),
    consumers,
    titles: declaredCategoryTitles(),
  };
}

describe("labelled index rail — one recipe, no left clip", () => {
  test("declared titles exist and at least one is longer than the old 36ch cap", () => {
    const titles = declaredCategoryTitles();
    expect(titles.length, "exposure modules + local-prefs + Model providers").toBeGreaterThan(5);
    expect(
      titles.some((t) => t.length > 36),
      `need a title longer than 36ch so the 36ch plant is live; got ${titles.map((t) => `${t} (${t.length})`).join(" · ")}`,
    ).toBe(true);
  });

  test("the live tree satisfies the recipe", () => {
    const findings = indexRailFindings(liveInput());
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("MUTATION: --index-rail-max: 36ch reds against declared titles", () => {
    const live = liveInput();
    const original = indexRailFindings(live);
    expect(original).toEqual([]);
    const plantedTokens = live.tokens.replace(
      /--index-rail-max\s*:\s*\d+(?:\.\d+)?ch/,
      "--index-rail-max: 36ch",
    );
    expect(plantedTokens, "the 36ch plant must actually change tokens").not.toBe(live.tokens);
    const planted = indexRailFindings({ ...live, tokens: plantedTokens });
    expect(planted).not.toEqual(original);
    expect(planted.join("\n")).toMatch(/36ch is below the longest declared title/);
  });

  test("MUTATION: .rail-title { min-width: 0 } in Settings reds even when tokens nowrap", () => {
    const live = liveInput();
    const original = indexRailFindings(live);
    expect(original).toEqual([]);
    const plantedSettings = live.settings.replace(
      "</style>",
      ".rail-title { min-width: 0; }\n</style>",
    );
    expect(plantedSettings).not.toBe(live.settings);
    const planted = indexRailFindings({ ...live, settings: plantedSettings });
    expect(planted).not.toEqual(original);
    expect(planted.join("\n")).toMatch(/min-width:0 fights the token nowrap/);
  });

  test("MUTATION: tokens nowrap plus min-width:0 on the title (inert wrap fight) reds", () => {
    const live = liveInput();
    const original = indexRailFindings(live);
    expect(original).toEqual([]);
    const plantedTokens = live.tokens.replace(
      /min-width:\s*max-content;/,
      "min-width: 0;",
    );
    expect(plantedTokens).not.toBe(live.tokens);
    const planted = indexRailFindings({ ...live, tokens: plantedTokens });
    expect(planted).not.toEqual(original);
    expect(planted.join("\n")).toMatch(/min-width:0 is the wrap fight/);
  });

  test("MUTATION: RoomHost place-items:center reds", () => {
    const live = liveInput();
    const original = indexRailFindings(live);
    expect(original).toEqual([]);
    const plantedHost = live.host.replace(
      /justify-items:\s*stretch;\s*align-items:\s*stretch;/,
      "place-items: center;",
    );
    expect(plantedHost).not.toBe(live.host);
    const planted = indexRailFindings({ ...live, host: plantedHost });
    expect(planted).not.toEqual(original);
    expect(planted.join("\n")).toMatch(/place-items:center/);
  });

  test("MUTATION: flex + margin-left:auto instead of the token grid reds", () => {
    const live = liveInput();
    const original = indexRailFindings(live);
    expect(original).toEqual([]);
    const plantedTokens = live.tokens
      .replace(/display:\s*grid;/, "display: flex;")
      .replace(/grid-template-columns:\s*1fr\s+auto;/, "");
    const plantedSettings = live.settings.replace(
      ".rail-count {",
      ".rail-count {\n    margin-left: auto;",
    );
    expect(plantedTokens).not.toBe(live.tokens);
    const planted = indexRailFindings({ ...live, tokens: plantedTokens, settings: plantedSettings });
    expect(planted).not.toEqual(original);
    expect(planted.join("\n")).toMatch(/display:grid|margin-left:auto/);
  });

  test("Settings is the only .index-rail consumer; it does not invent a width token", () => {
    const hits: string[] = [];
    for (const f of walk("src/cockpit", { exts: [".svelte"] })) {
      const src = read(f);
      if (/\bindex-rail\b/.test(src)) hits.push(relpath(f));
    }
    expect(hits).toEqual(["src/cockpit/rooms/SettingsRoom.svelte"]);
    expect(read(SETTINGS)).not.toMatch(/--settings-rail-w/);
  });
});
