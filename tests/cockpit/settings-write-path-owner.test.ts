// @vitest-environment node
/**
 * SETTINGS WRITE-PATH OWNER (spec §9 — "every control through the validated
 * action; never a second write path").
 *
 * Static, deny-by-default over the settings + lens surfaces:
 *   A. only `settings/settings-feed.ts` may name the settings block or call
 *      the broker `action(...)` for it — a sheet or row that posts around
 *      the feed is a second write path;
 *   B. no settings/lens source may call the LEGACY customization writer
 *      (`setSchemaCustomization` / the old `saveCustomization` store) — the
 *      cockpit writes through the block, once;
 *   C. no raw `fetch(`/`fetchJson(` in the settings or lens surfaces — the
 *      Broker is the only door;
 *   D. every `<button>` in these surfaces carries `data-verb-id` (§1.2 —
 *      name the action or the gap), matching the flow's verb-owner rule.
 *
 * Every scanner is a pure function and MUTATION-TESTED: a synthetic bypass
 * must be flagged and the real, clean sources must pass.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripCommentsAndStringsFor, stripCommentsOnlyFor, walk } from "../helpers/source-scan.ts";

const SETTINGS_DIR = "src/cockpit/settings";
const LENS_DIR = "src/cockpit/lens";
const ROOM = "src/cockpit/rooms/SettingsRoom.svelte";
const FEED = "src/cockpit/settings/settings-feed.ts";
/** The one module allowed to NAME the block id (the data owner spells it as
 * a constant the feed consumes). */
const BLOCK_ID_OWNERS = new Set([FEED, "src/cockpit/settings/settings-data.ts"]);
/** Every settings write door's block id — the literal scan below refuses the
 * id anywhere outside the owners, so a second write path cannot be named
 * into a sheet or section quietly. */
const SETTINGS_BLOCK_IDS = ["settings.customizations", "settings.diagnosticModes"] as const;

/** A: a settings/lens source other than the feed performing the block write. */
export function scanWritePath(file: string, src: string): string[] {
  const code = stripCommentsAndStringsFor(src, file);
  const out: string[] = [];
  // Broker action() invocation — the write door. Only the feed may hold it.
  if (/\baction\s*\(/.test(code) && file !== FEED) {
    out.push(`${file}: calls broker action() directly — the ONE settings write path is settings-feed.saveSetting (§9.1)`);
  }
  // A settings block id (strings survive only in the raw source).
  for (const blockId of SETTINGS_BLOCK_IDS) {
    if (src.includes(blockId) && !BLOCK_ID_OWNERS.has(file)) {
      // data-verb-id attributes name the action for the verb guard; those are
      // labels, not call sites.
      const withoutVerbIds = src.replace(/data-verb-id\s*=\s*\{?["'][^"']*["']\}?/g, "");
      const inTemplateExpr = new RegExp(
        `data-verb-id=\\{[^}]*${blockId.replaceAll(".", "\\.")}[^}]*\\}`,
      ).test(src);
      if (withoutVerbIds.includes(blockId) && !inTemplateExpr) {
        out.push(`${file}: names the settings block id "${blockId}" — only the feed + data owner may (§9.1)`);
      }
    }
  }
  return out;
}

/** B: the legacy customization write path. */
export function scanLegacyWrite(file: string, src: string): string[] {
  const code = stripCommentsAndStringsFor(src, file);
  const out: string[] = [];
  for (const legacy of ["setSchemaCustomization", "saveCustomization", "custSaving", "custErrors"]) {
    if (new RegExp(`\\b${legacy}\\b`).test(code)) {
      out.push(`${file}: uses the legacy customization writer "${legacy}" — the cockpit writes through the block (§9.1)`);
    }
  }
  return out;
}

/** C: raw network calls outside the Broker. */
export function scanRawFetch(file: string, src: string): string[] {
  const code = stripCommentsAndStringsFor(src, file);
  const out: string[] = [];
  if (/(^|[^.\w])fetch\s*\(/.test(code)) {
    out.push(`${file}: calls fetch() directly — the Broker is the only client I/O door`);
  }
  if (/\bfetchJson\s*\(/.test(code)) {
    out.push(`${file}: calls fetchJson() directly — settings reads go through the feed`);
  }
  return out;
}

/** D: anonymous buttons. */
export function scanButtons(file: string, src: string): string[] {
  const out: string[] = [];
  const re = /<button\b([^>]*?)>/gs;
  let m: RegExpExecArray | null;
  // Read the file in its own mode with its comments removed — a comment
  // SPELLING a `<button>` is not a rendered control, and a scan over raw
  // text reds on a button that does not exist.
  while ((m = re.exec(stripCommentsOnlyFor(src, file))) !== null) {
    if (!/\bdata-verb-id\s*=/.test(m[1]!)) {
      out.push(`${file}: <button> without data-verb-id (§1.2 — name the action or the gap)`);
    }
  }
  return out;
}

const FILES = [
  ...walk(SETTINGS_DIR, { exts: [".ts", ".svelte"] }),
  ...walk(LENS_DIR, { exts: [".ts", ".svelte"] }),
  ROOM,
].map((f) => relpath(f));

describe("settings write-path owner — one validated action, no second door", () => {
  test("the surfaces exist and are scanned", () => {
    expect(FILES).toContain(FEED);
    expect(FILES).toContain(ROOM);
    expect(FILES).toContain("src/cockpit/settings/SettingSheet.svelte");
    expect(FILES).toContain("src/cockpit/lens/LensCallout.svelte");
  });

  test("A: only the feed performs the block write", () => {
    const all: string[] = [];
    for (const f of FILES) all.push(...scanWritePath(f, read(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  test("B: no legacy customization writer anywhere in the settings/lens tree", () => {
    const all: string[] = [];
    for (const f of FILES) all.push(...scanLegacyWrite(f, read(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  test("C: no raw fetch — the Broker is the only door", () => {
    const all: string[] = [];
    for (const f of FILES) all.push(...scanRawFetch(f, read(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  test("D: every control names its action", () => {
    const all: string[] = [];
    for (const f of FILES.filter((f) => f.endsWith(".svelte"))) {
      all.push(...scanButtons(f, read(f)));
    }
    expect(all, all.join("\n")).toEqual([]);
  });

  test("the feed's save really targets the declared block action", () => {
    const feed = read(FEED);
    expect(feed).toMatch(/SETTINGS_BLOCK/);
    expect(feed).toMatch(/SETTINGS_SET_ACTION/);
    expect(feed).toMatch(/invalidates:\s*\[SETTINGS_CHANGED_EVENT\]/);
    const data = read("src/cockpit/settings/settings-data.ts");
    expect(data).toMatch(/SETTINGS_BLOCK\s*=\s*"settings\.customizations"/);
    expect(data).toMatch(/SETTINGS_SET_ACTION\s*=\s*"set"/);
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────

  test("mutation: a sheet posting the action itself is flagged", () => {
    const bad = `const r = await action("settings.customizations", "set", { id, value });`;
    expect(scanWritePath("src/cockpit/settings/SettingSheet.svelte", bad).length).toBeGreaterThan(0);
  });

  test("mutation: a row calling the legacy writer is flagged", () => {
    const bad = `await setSchemaCustomization(id, value);`;
    expect(scanLegacyWrite(ROOM, bad).length).toBeGreaterThan(0);
  });

  test("mutation: a raw fetch in a settings source is flagged", () => {
    expect(
      scanRawFetch(ROOM, `const res = await fetch("/api/schema/ui/customizations/x");`).length,
    ).toBeGreaterThan(0);
  });

  test("mutation: an anonymous button is flagged", () => {
    expect(scanButtons(ROOM, `<button onclick={go}>save</button>`).length).toBeGreaterThan(0);
  });

  test("mutation: a button named only inside an HTML comment is NOT a button", () => {
    // A comment SPELLING a `<button>` is not a rendered control; the scan
    // reads the template through the comment-stripping owner.
    expect(scanButtons(ROOM, `<!-- <button onclick={go}>planned</button> -->`)).toEqual([]);
    // …but a live anonymous button beside such a comment still reds.
    expect(
      scanButtons(ROOM, `<!-- <button data-verb-id="settings.x/y">old</button> -->\n<button onclick={go}>go</button>`),
    ).toHaveLength(1);
  });

  test("mutation: clean shapes are NOT false positives", () => {
    expect(scanWritePath(ROOM, `import { saveSetting } from "../settings/settings-feed.ts";`)).toEqual([]);
    expect(scanRawFetch(ROOM, `const rows = servedRows(schema);`)).toEqual([]);
    expect(scanButtons(ROOM, `<button data-verb-id="settings.index/adjust">x</button>`)).toEqual([]);
  });
});
