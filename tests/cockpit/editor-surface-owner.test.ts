import { styleBlock, sizesToFloor } from "../helpers/control-floor.ts";
// @vitest-environment node
/**
 * EDITOR SURFACE OWNER — every control in the room names its action, says what
 * it does in plain words, and is big enough to hit.
 *
 * Three standing laws of the cockpit, applied to this surface and enforced
 * rather than described:
 *
 *   §1.2 NO VERB, NO PIXELS — an interactive element must reference the action
 *        it performs (`data-verb-id`). A button with no named action is either
 *        dead or undocumented, and both have shipped here before.
 *   v2.1 MOUSE-FIRST / WCAG 2.2 SC 2.5.8 — every control clears the pointer
 *        target floor in BOTH axes, from the token that owns the number.
 *   ZERO REQUIRED KNOWLEDGE — every control carries a `title` in plain words.
 *        The user should never have to already know what a control does.
 *
 * Every scanner here is a pure function and is MUTATION-TESTED at the foot of
 * the file: a control with no verb id, one with no tooltip, one sized below
 * the floor, and one that is only in a comment must each be caught, and a
 * clean source must not be. Three guards in this project were found to be
 * narrower than their names, so each of these is shown failing.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, stripTemplateComments, walk } from "../helpers/source-scan.ts";

const SURFACE = ["src/cockpit/editor", "src/cockpit/rooms/EditorRoom.svelte"];

/** The one token that owns the pointer target floor (tokens.css §12.5). */
const HIT_TOKEN = "var(--hit-min)";

// ── Scanners (pure) ───────────────────────────────────────────────────────

/**
 * Drop Svelte-template HTML comments and JS/TS comments. A commented-out
 * control is not a rendered control. The implementation is the one owner in
 * `tests/helpers/source-scan.ts`; this file's long-standing name is kept as
 * the import alias.
 */
const stripAllComments = stripTemplateComments;

export type Control = Readonly<{
  file: string;
  tag: string;
  verbId: string | null;
  teaches: boolean;
  cls: string | null;
}>;

/** Tags that are interactive whether or not they carry a handler. */
const INTERACTIVE = new Set(["button", "input", "select", "textarea", "a"]);

/**
 * Every INTERACTIVE element in one Svelte source.
 *
 * A `<textarea>` and a labelled `<input>` are fields, not verbs: they carry an
 * `aria-label` (their accessible name) rather than a `data-verb-id`, and they
 * are collected separately so the verb rule does not have to lie about them.
 */
export function findControls(file: string, src: string): Control[] {
  const out: Control[] = [];
  for (const m of stripAllComments(src).matchAll(
    /<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
  )) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2]!;
    if (!INTERACTIVE.has(tag) && !/\bonclick[\s=]/.test(attrs)) continue;
    const verb = /\bdata-verb-id\s*=\s*["{]([^"}]*)/.exec(attrs);
    const clsAttr = /\bclass\s*=\s*"([^"{]*)/.exec(attrs);
    out.push({
      file,
      tag,
      verbId: verb?.[1]?.trim() ?? null,
      teaches: /\btitle\s*=/.test(attrs) || /\baria-label\s*=/.test(attrs),
      cls: clsAttr?.[1]?.trim().split(/\s+/)[0] ?? null,
    });
  }
  return out;
}

/** The `<style>` block of a Svelte source (css comments stripped). */


/** The body of the FIRST `.cls { … }` rule in a style block (null if none). */


/**
 * Whether a `.class` rule sizes its control to the pointer target floor in
 * BOTH axes. A LITERAL never passes: the number has one owner, and a restated
 * `24px` is exactly the drift the token exists to prevent.
 */


// ── The suite ─────────────────────────────────────────────────────────────

const files = SURFACE.flatMap((p) =>
  p.endsWith(".svelte") ? [p] : walk(p, { exts: [".svelte"] }).map(relpath),
);
const controls: Control[] = [];
for (const f of files) controls.push(...findControls(f, read(f)));

describe("the editor surface", () => {
  test("the scan found the room's controls (it is not vacuous)", () => {
    expect(files).toContain("src/cockpit/rooms/EditorRoom.svelte");
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(controls.length, "a surface with no controls is a scan that missed").toBeGreaterThan(10);
  });

  test("§1.2 — every BUTTON names the action it performs", () => {
    const nameless = controls
      .filter((c) => c.tag === "button" && c.verbId === null)
      .map((c) => `${c.file}: a <button> with no data-verb-id — it names no action`);
    expect(nameless, nameless.join("\n")).toEqual([]);
  });

  test("every verb id is scoped to this room (no collisions with another surface)", () => {
    const ids = controls.filter((c) => c.verbId !== null).map((c) => c.verbId!);
    const foreign = ids.filter((id) => !id.startsWith("editor."));
    expect(foreign, `verb ids must be namespaced: ${foreign.join(", ")}`).toEqual([]);
    expect(new Set(ids).size, "…and each names ONE control").toBe(ids.length);
  });

  test("ZERO REQUIRED KNOWLEDGE — every control says what it does", () => {
    const mute = controls
      .filter((c) => !c.teaches)
      .map((c) => `${c.file}: <${c.tag}> (${c.verbId ?? "no id"}) has neither a title nor a label`);
    expect(mute, mute.join("\n")).toEqual([]);
  });

  test("MOUSE-FIRST — every control clears the pointer target floor in both axes", () => {
    const small: string[] = [];
    for (const c of controls) {
      // A textarea is a text field sized by its container, not a chip; it is
      // far past the floor by construction and has no fixed box to pin.
      if (c.tag === "textarea") continue;
      if (c.cls === null) {
        small.push(`${c.file}: <${c.tag}> has no class — nothing sizes its hit area`);
        continue;
      }
      const style = styleBlock(read(c.file));
      const { found, ok } = sizesToFloor(style, c.cls);
      if (!found) small.push(`${c.file}: .${c.cls} has no CSS rule to size it`);
      else if (!ok) small.push(`${c.file}: .${c.cls} does not clear ${HIT_TOKEN} in both axes`);
    }
    expect(small, small.join("\n")).toEqual([]);
  });
});

describe("honest states — every failure the room can meet has a sentence", () => {
  const pane = read("src/cockpit/editor/FilePane.svelte");
  const tree = read("src/cockpit/editor/FileTree.svelte");

  test("a file that cannot be read says why (the reason is rendered, not swallowed)", () => {
    // Through the response grammar now: a load-level failure carries its
    // caught reason into failed(), and the shared element renders the words.
    // The claim is unchanged — the reason reaches the reader, in a sentence
    // about a file — only the spelling moved from Svelte interpolation to a
    // grammar factory.
    expect(pane).toMatch(/failed\(`this file — \$\{probeLoad\.reason\}`\)/);
    expect(pane).toMatch(/failed\(`this file — \$\{textLoad\.reason\}`\)/);
  });

  test("a BINARY file states that it is binary, and never renders its bytes", () => {
    expect(pane).toContain("binarySentence(probe)");
    const kind = read("src/cockpit/editor/file-kind.ts");
    expect(kind).toMatch(/export function binarySentence/);
  });

  test("an EMPTY folder says it is empty, and says what it does not list", () => {
    expect(tree).toContain("EMPTY_DIR_SENTENCE");
    const sentence = read("src/cockpit/editor/tree.ts");
    expect(sentence).toContain("hidden entries and build folders");
  });

  test("a LARGE file states its size and what will happen BEFORE it is loaded", () => {
    expect(pane).toContain("largeReadSentence(probe)");
    // …and the room does not read it until asked.
    const room = read("src/cockpit/rooms/EditorRoom.svelte");
    expect(room).toMatch(/if \(isLargeRead\(probed\.probe\)\) return;/);
  });

  test("a folder that cannot be read says why, per folder", () => {
    // Same claim as the file pane's: the caught reason reaches the reader,
    // now through the grammar's failed() rather than bare interpolation.
    expect(tree).toMatch(/failed\(`\$\{entry\.name\} — \$\{row\.load\.reason\}`\)/);
  });

  test("nothing anywhere is a bare spinner with no answer behind it", () => {
    // Comments go first: both files EXPLAIN that a spinner is not an honest
    // state, and a scan that read the explanation as the offence would be a
    // guard that can never pass.
    for (const src of [pane, tree]) {
      expect(stripAllComments(src), "a spinner is not an honest state").not.toMatch(
        /spinner|Spinner/,
      );
    }
  });
});

// ── MUTATION SELF-CHECKS ──────────────────────────────────────────────────

const AT = "src/cockpit/editor/Example.svelte";

describe("mutation — the editor surface scanners catch what they claim to", () => {
  test("a button with no verb id is caught", () => {
    const found = findControls(AT, `<button class="verb" title="t" onclick={f}>go</button>`);
    expect(found).toHaveLength(1);
    expect(found[0]!.verbId).toBeNull();
  });

  test("a control with no tooltip or label is caught", () => {
    const found = findControls(AT, `<button class="verb" data-verb-id="editor.x" onclick={f}>x</button>`);
    expect(found[0]!.teaches).toBe(false);
  });

  test("an aria-label counts as saying what it is (a field, not a verb)", () => {
    const found = findControls(AT, `<input class="name" aria-label="the file's name" />`);
    expect(found[0]!.teaches).toBe(true);
  });

  test("a div WITH onclick is scanned too (the escape hatch is not a hiding place)", () => {
    const found = findControls(AT, `<div class="row" onclick={f}>x</div>`);
    expect(found).toHaveLength(1);
    expect(found[0]!.verbId).toBeNull();
  });

  test("a commented-out control is NOT a control", () => {
    expect(findControls(AT, `<!-- <button data-verb-id="editor.x" title="t">x</button> -->`)).toEqual([]);
    // A `//`-commented control only exists inside a script block — a bare
    // `//` line in MARKUP is prose Svelte renders, not a comment (the mode
    // machine follows the language), so the mutation carries its fence.
    expect(
      findControls(AT, `<script>// const note = '<button data-verb-id="editor.x" title="t">x</button>';</script>`),
    ).toEqual([]);
  });

  test("a control sized below the floor is caught", () => {
    expect(sizesToFloor(`<style>.tiny { padding: 2px; }</style>`, "tiny")).toEqual({
      found: true,
      ok: false,
    });
  });

  test("one axis at the floor is not enough", () => {
    expect(sizesToFloor(`<style>.half { min-height: var(--hit-min); }</style>`, "half").ok).toBe(
      false,
    );
  });

  test("a literal 24px does NOT satisfy the floor (the number has one owner)", () => {
    const style = `<style>.lit { min-height: 24px; min-width: 24px; }</style>`;
    expect(sizesToFloor(style, "lit").ok).toBe(false);
  });

  test("both axes from the token pass", () => {
    const style = `<style>.ok { min-height: var(--hit-min); min-width: var(--hit-min); }</style>`;
    expect(sizesToFloor(style, "ok")).toEqual({ found: true, ok: true });
  });

  test("a class with no rule at all is REPORTED, not assumed fine", () => {
    expect(sizesToFloor(`<style>.other { min-height: var(--hit-min); }</style>`, "gone")).toEqual({
      found: false,
      ok: false,
    });
  });

  test("a rule for a LONGER class name is not mistaken for this one", () => {
    // The plant's class must be one the token owner does NOT dress (`.verb`
    // is the owned control recipe now, so a `.verb` plant would be cleared
    // by the owner and prove nothing about the matcher). `.grip-strong` vs
    // `.grip` is the same shape on an unowned class.
    const style = `<style>.grip-strong { min-height: var(--hit-min); min-width: var(--hit-min); }</style>`;
    expect(sizesToFloor(style, "grip").found, "`.grip` must not match `.grip-strong`").toBe(false);
  });

  test("a clean control produces no findings", () => {
    const found = findControls(
      AT,
      `<button class="verb" data-verb-id="editor.save" title="Writes your changes." onclick={f}>save</button>`,
    );
    expect(found).toMatchObject([{ tag: "button", verbId: "editor.save", teaches: true, cls: "verb" }]);
  });
});
