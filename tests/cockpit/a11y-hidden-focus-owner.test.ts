// @vitest-environment jsdom
/**
 * HIDDEN MEANS INERT, AND EVERY FIELD HAS A NAME.
 *
 * Two findings from the same accessibility sweep:
 *
 *   1. aria-hidden OVER FOCUS. Kept-alive rooms were hidden with BOTH
 *      `inert` and `aria-hidden`. Closing a room while focus sat inside it
 *      left `aria-hidden="true"` over a focused descendant — the exact
 *      state Chrome flags (a hidden-but-focused element still talks to the
 *      screen reader), and `inert` is the browser's own prescription: it
 *      removes the subtree from focus, the tab order and the accessibility
 *      tree in one declaration, with the focus problem handled by the
 *      engine. So: `inert` alone; `aria-hidden` never rides a container
 *      that can hold focus.
 *
 *   2. NAMELESS FORM FIELDS. Every `<input>`/`<textarea>` must carry a
 *      `name` (or `id`) — autofill, form participation and the devtools
 *      audit all key on it. The scan discovers the population from the
 *      cockpit source tree; a new field is covered because nobody had to
 *      remember it.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

// THE SANCTIONED SOURCE READER: comments arrive blanked, so a doc comment
// mentioning `<textarea>` by name can never enter the tag universe, while
// attribute strings (where `name="…"` lives) stay matchable.
import {
  readSourceView,
  sourceViewOf,
} from "../../engine/scripts/verification/source-view.ts";
import RoomHost from "../../src/cockpit/shell/RoomHost.svelte";
import * as popoverModule from "../../src/cockpit/shell/Popover.svelte";
import ConnectionBlock from "../../src/cockpit/shell/ConnectionBlock.svelte";
import { noteAnswered, noteNotReached, resetConnectionForTest } from "../../src/data/connection.ts";
import { tick } from "svelte";
import type { ShellApi, VisitedRoom } from "../../src/cockpit/shell/contract.ts";

const COCKPIT_ROOT = join(__dirname, "../../src/cockpit");
// The test-program wildcard types Svelte's default component only. Read the
// actual compiled module export; no copied selector or focus implementation.
const focusSurface = Reflect.get(popoverModule, "focusSurface") as (node: HTMLElement, contain: boolean) => () => void;

describe("shared focus eligibility and containment", () => {
  test("connection blocking focuses recovery and returns to the same retained editor", async () => {
    resetConnectionForTest();
    const opener = document.createElement("input");
    opener.value = "my unsaved draft";
    document.body.append(opener);
    render(ConnectionBlock);
    opener.focus();
    try {
      noteNotReached("refused", 1);
      await tick();
      const retry = document.querySelector<HTMLButtonElement>('[data-field="connection-error"] button')!;
      expect(document.activeElement).toBe(retry);
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      retry.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(retry);
      noteAnswered();
      await tick();
      await Promise.resolve();
      expect(document.activeElement).toBe(opener);
      expect(opener.value).toBe("my unsaved draft");
    } finally { resetConnectionForTest(); cleanup(); opener.remove(); }
  });
  test.each([
    '<button disabled tabindex="0">disabled</button>',
    '<fieldset disabled><input tabindex="0" /></fieldset>',
    '<button tabindex="-2">negative</button>',
    '<a href="#" tabindex="-1">negative link</a>',
    '<input type="hidden" tabindex="0" />',
    '<div hidden><button>hidden</button></div>',
    '<div inert><button>inert</button></div>',
    '<div style="display:none"><button>not displayed</button></div>',
    '<div style="visibility:hidden"><button>not visible</button></div>',
    '<details><summary>summary</summary><button>closed detail</button></details>',
  ])("excluded candidates never capture entry or the wrap: %s", async (markup) => {
    const opener = document.createElement("button");
    const host = document.createElement("div"); host.tabIndex = -1;
    // The summary is itself eligible; give it negative tabindex so this arm
    // isolates the closed details descendant rather than excluding summary.
    host.innerHTML = markup.replace('<summary>', '<summary tabindex="-1">') + '<button id="first">First</button><button id="last">Last</button>' + markup.replace('<summary>', '<summary tabindex="-1">');
    document.body.append(opener, host); opener.focus();
    const release = focusSurface(host, true);
    try {
      const first = host.querySelector<HTMLElement>("#first")!;
      const last = host.querySelector<HTMLElement>("#last")!;
      expect(document.activeElement).toBe(first);
      const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      first.dispatchEvent(backwards);
      expect(backwards.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      expect(document.activeElement).toBe(first);
      release(); await Promise.resolve();
      expect(document.activeElement).toBe(opener);
    } finally { release(); host.remove(); opener.remove(); }
  });

  test("a nonmodal surface leaves Tab available to its visible siblings", () => {
    const host = document.createElement("div"); host.innerHTML = '<button>Only</button>';
    document.body.append(host);
    const release = focusSurface(host, false);
    try {
      const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      host.firstElementChild!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    } finally { release(); host.remove(); }
  });
});

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...svelteFiles(full));
    else if (entry.endsWith(".svelte")) out.push(full);
  }
  return out;
}

/**
 * Extract each `<input …>` / `<textarea …>` OPENING TAG from a Svelte
 * source VIEW. The view has already blanked comments (so a doc comment
 * mentioning `<textarea>` by name never enters the universe) and kept
 * strings and templates (so `name="…"` is matchable). The walk is
 * brace-aware, because attribute expressions legitimately contain `>`
 * (`oninput={(ev) => …}`) and a naive slice-to-`>` would truncate the tag
 * before its `name=` — a wrong region that looks structural (§8b #5). The
 * extractor is itself proven on a fixture below before its verdict counts.
 */
function fieldTags(source: string): string[] {
  const tags: string[] = [];
  const re = /<(?:input|textarea)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 0;
    for (let i = m.index; i < source.length; i += 1) {
      const ch = source[i]!;
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (ch === ">" && depth === 0) {
        tags.push(source.slice(m.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

/** The comment-blanked, strings-kept view of one component. */
function tagView(path: string): string {
  return readSourceView(path).codeWithStringsAndTemplates();
}

const named = (tag: string): boolean => /\s(?:name|id)\s*=/.test(tag);

describe("the extractor is proven before it judges", () => {
  test("it survives arrow attributes, flags a nameless field, and never judges prose", () => {
    const fixture = `<script lang="ts">
  /** A plain <textarea> on purpose — this mention is prose, not markup. */
  const x = 1;
</script>
<input class="a" oninput={(ev) => (draft = ev.currentTarget.value)} name="ok" />
<textarea rows="6" value={draftShown} oninput={(ev) => (x = ev.currentTarget.value)}></textarea>
`;
    const tags = fieldTags(sourceViewOf(fixture, "fixture.svelte").codeWithStringsAndTemplates());
    // Two real tags — the comment's <textarea> mention was blanked by the
    // view and never entered the universe.
    expect(tags).toHaveLength(2);
    // The arrow's `>` did not truncate the first tag before its name.
    expect(named(tags[0]!)).toBe(true);
    // The planted violation is caught.
    expect(named(tags[1]!)).toBe(false);
  });
});

describe("every cockpit form field carries a name", () => {
  test("no <input>/<textarea> in the cockpit tree is nameless", () => {
    const files = svelteFiles(COCKPIT_ROOT);
    expect(files.length).toBeGreaterThan(40); // the universe is alive
    const offenders: string[] = [];
    let fields = 0;
    for (const file of files) {
      const source = tagView(file);
      for (const tag of fieldTags(source)) {
        fields += 1;
        if (!named(tag)) offenders.push(`${file}:\n${tag}`);
      }
    }
    // The population floor: this tree holds real fields; a scan that found
    // none would be a broken universe, not a clean bill.
    expect(fields).toBeGreaterThanOrEqual(15);
    expect(offenders, offenders.join("\n\n")).toEqual([]);
  });
});

describe("kept-alive rooms are inert, never aria-hidden over focus", () => {
  afterEach(() => cleanup());

  const shell = {
    revealAt: () => 0,
  } as unknown as ShellApi;

  test("a hidden room wears inert and NOT aria-hidden — focus left behind cannot sit under aria-hidden", async () => {
    const visited: VisitedRoom[] = [
      { id: "custody", comp: null },
      { id: "settings", comp: null },
    ];
    const { container, rerender } = render(RoomHost, {
      props: { shell, roomId: "custody", visited, onClose: () => {} },
    });
    // Focus lands inside the active room — the state that used to trip
    // aria-hidden-over-focus at the switch.
    const close = container.querySelector<HTMLButtonElement>(
      '[data-room-active="true"] .close',
    );
    expect(close).not.toBeNull();
    close!.focus();
    expect(document.activeElement).toBe(close);

    // The room is hidden (another opens over it) while focus is still inside.
    await rerender({ shell, roomId: "settings", visited, onClose: () => {} });
    const hidden = container.querySelector('section[data-room-active="false"]');
    expect(hidden).not.toBeNull();
    // `inert` is a boolean IDL attribute the compiler sets as a property —
    // the property is what carries the truth in every engine.
    expect((hidden as HTMLElement & { inert: boolean }).inert).toBe(true);
    // The prescription: inert ALONE. aria-hidden must not ride the container.
    expect(hidden!.hasAttribute("aria-hidden")).toBe(false);
    // And nothing focused sits under an aria-hidden ancestor anywhere.
    let node: Element | null = document.activeElement;
    while (node !== null) {
      expect(node.getAttribute("aria-hidden")).not.toBe("true");
      node = node.parentElement;
    }
  });
});
