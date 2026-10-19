// @vitest-environment node
/**
 * THE SWITCH — verb owner for the rooms tree (spec §1.2: no verb, no
 * pixels; every control names its action). Sibling guard to
 * `cockpit-flow-verb-owner` (which walks flow/computer/desk): every
 * interactive element in `src/cockpit/rooms/**` — `<button>` and any
 * element given `role="button"` — must carry a `data-verb-id`. The scanner
 * is a pure function, MUTATION-TESTED below.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripTemplateComments, walk } from "../helpers/source-scan.ts";

const ROOMS = "src/cockpit/rooms";

/**
 * Every interactive opening tag missing its data-verb-id. The template is
 * read through `stripTemplateComments` — a comment that SPELLS a tag
 * (`<!-- rides the real <button> rows -->`) is not a rendered control, and
 * scanning raw text reds on controls that do not exist.
 */
export function findUnownedControls(src: string): string[] {
  const out: string[] = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?>/gs;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(stripTemplateComments(src))) !== null) {
    const tag = m[0];
    const name = m[1]!;
    const interactive = name === "button" || /role\s*=\s*["']button["']/.test(tag);
    if (!interactive) continue;
    if (!/data-verb-id\s*=/.test(tag)) {
      out.push(tag.split("\n")[0]!.slice(0, 80));
    }
  }
  return out;
}

describe("switch-verb-owner — every rooms control names its verb", () => {
  const files = walk(ROOMS, { exts: [".svelte"] });

  test("the rooms tree exists (the Switch is real)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no interactive element without a data-verb-id", () => {
    const all: string[] = [];
    for (const f of files) {
      for (const hit of findUnownedControls(read(f))) {
        all.push(`${relpath(f)}: ${hit}`);
      }
    }
    expect(all, all.join("\n")).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS ──

  test("mutation: a bare <button> is flagged", () => {
    expect(findUnownedControls(`<button onclick={x}>go</button>`)).toHaveLength(1);
  });

  test("mutation: a role=button div without a verb id is flagged", () => {
    expect(findUnownedControls(`<div role="button" tabindex="0">go</div>`)).toHaveLength(1);
  });

  test("mutation: a multi-line attribute tag is still seen", () => {
    const src = `<button\n  class="x"\n  onclick={y}\n>go</button>`;
    expect(findUnownedControls(src)).toHaveLength(1);
  });

  test("owned controls are NOT flagged (no false positives)", () => {
    const good = [
      `<button data-verb-id="switch.resume" onclick={x}>resume</button>`,
      `<div role="button" tabindex="0" data-verb-id="switch.resume">r</div>`,
      `<div class="plain">not interactive</div>`,
    ].join("\n");
    expect(findUnownedControls(good)).toEqual([]);
  });

  test("a control named only inside an HTML comment is NOT a control", () => {
    // The defect class: a comment SPELLING a tag must not red the scan, and
    // must not supply the id a live sibling is missing either.
    expect(
      findUnownedControls(`<!-- rides the real <button> rows -->`),
    ).toEqual([]);
    expect(
      findUnownedControls(
        `<!-- <button onclick={x}>planned</button> -->\n<button data-verb-id="switch.resume">r</button>`,
      ),
    ).toEqual([]);
  });

  test("a live control beside a comment-naming-a-tag IS still flagged", () => {
    expect(
      findUnownedControls(`<!-- <button data-verb-id="x.y">old</button> -->\n<button onclick={x}>go</button>`),
    ).toHaveLength(1);
  });
});
