import { styleBlock as deskStyle } from "../helpers/control-floor.ts";
// @vitest-environment jsdom
/**
 * DESK verb owner + latency (§1.2 no verb, no pixels · §1.5 F2 budgets).
 *
 * STATIC — every interactive control in the desk surfaces (`<button>`,
 * `<select>`, `<input>`, and anything carrying an interactive `role`) names
 * the block action it drives, or the client primitive it performs, through
 * `data-verb-id`. The desk is not covered by the flow's Verb component, so
 * this scanner is the desk's equivalent guard. Mutation-tested: an
 * anonymous control of each element kind must be flagged; a named one and
 * a non-interactive element must not.
 *
 * RUNTIME — every control the panel actually renders resolves to either a
 * declared block action of the two live blocks, or an explicitly listed
 * client primitive; a control that is disabled carries its reason (title
 * or an adjacent note), never a dead label.
 *
 * LATENCY — the desk opens under 200ms (measured render of the real panel
 * over instant IO) and an act acknowledges under 100ms (measured from the
 * click to the pending mark).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { parse } from "svelte/compiler";

import { INSPECTOR_SECTION_ENTRIES } from "../../shared/routes.ts";
import DeskPanel from "../../src/cockpit/desk/DeskPanel.svelte";
import { pendingActs, resetDeskFeed, setDeskIo } from "../../src/cockpit/desk/desk-feed.ts";
import { resetDeskBus } from "../../src/cockpit/desk/desk-bus.ts";
import { currentChatId, resetChats, setChats } from "../../src/state/chats.ts";
import { clearMessages, setStreaming } from "../../src/state/chat-messages.ts";
import { resetModels, setModels } from "../../src/state/models.ts";
import { clearCache } from "../../src/data/broker.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";
import { ownerClearsFloor, sizesToFloor } from "../helpers/control-floor.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";

// ── STATIC: every desk control names its action or its primitive ────────────

const INTERACTIVE_TAGS = new Set(["button", "select", "textarea", "input"]);
const INTERACTIVE_ROLES = new Set(["slider", "switch", "checkbox", "button", "menuitem"]);

/** Actual markup only, using the same Svelte parser as the stray-terminator
 * owner. Script selectors and TypeScript generics cannot create controls.
 * Attribute nodes also keep an event expression's > or quoted attribute-like
 * text from truncating a tag or inventing an action name. */
function controlTags(source: string): { tag: string; named: boolean; className: string }[] {
  const out: { tag: string; named: boolean; className: string }[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string; name?: string;
      attributes?: { type: string; name?: string; value?: unknown }[];
      children?: unknown[]; else?: unknown; pending?: unknown; then?: unknown; catch?: unknown;
    };
    if (n.type === "Element" && n.name && n.attributes) {
      let role = "", classText = "", named = false;
      for (const attr of n.attributes) {
        if (attr.type !== "Attribute") continue;
        if (attr.name === "data-verb-id") named = true;
        else if (attr.name === "role" || attr.name === "class") {
          const value = attr.value;
          const text = Array.isArray(value) && value[0]?.type === "Text" ? value[0].data : "";
          if (attr.name === "role") role = text;
          else classText = text;
        }
      }
      const native = INTERACTIVE_TAGS.has(n.name);
      if (native || INTERACTIVE_ROLES.has(role)) {
        out.push({
          tag: native ? n.name : n.name + "[role]", named,
          className: classText,
        });
      }
    }
    // Legacy markup children cover elements, snippets, keys and block bodies;
    // these four branches cover if/each fallbacks and every await outcome.
    // Attribute and event-expression ASTs cannot contain template controls.
    n.children?.forEach(visit);
    visit(n.else);
    visit(n.pending);
    visit(n.then);
    visit(n.catch);
  };
  visit(parse(source).html);
  return out;
}

/** Controls in a desk source that do not name what they drive. */
export function scanDeskControls(raw: string, file: string): string[] {
  const out: string[] = [];
  for (const { tag, named } of controlTags(raw)) {
    if (!named) out.push(`${file}: <${tag}> without data-verb-id (§1.2 — name the action or the gap)`);
  }
  return out;
}

describe("static — every desk control names what it drives", () => {
  const files = walk("src/cockpit/desk", { exts: [".svelte"] });

  test("the desk surfaces exist", () => {
    const names = files.map(relpath);
    expect(names).toContain("src/cockpit/desk/DeskPanel.svelte");
    expect(names).toContain("src/cockpit/desk/ChannelStrip.svelte");
    expect(names).toContain("src/cockpit/desk/BreakerRow.svelte");
  });

  test("no anonymous control in any desk surface", () => {
    const all: string[] = [];
    for (const f of files) all.push(...scanDeskControls(read(f), relpath(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────
  const AT = "src/cockpit/desk/Example.svelte";
  test("mutation: an anonymous button is flagged", () => {
    expect(scanDeskControls(`<button onclick={f}>off</button>`, AT)).toHaveLength(1);
  });
  test("mutation: an anonymous select is flagged", () => {
    expect(scanDeskControls(`<select onchange={f}></select>`, AT)).toHaveLength(1);
  });
  test("mutation: an anonymous input is flagged", () => {
    expect(scanDeskControls(`<input type="number" bind:value={n} />`, AT)).toHaveLength(1);
  });
  test("mutation: an anonymous role=slider element is flagged", () => {
    expect(scanDeskControls(`<div role="slider" tabindex="0"></div>`, AT)).toHaveLength(1);
  });
  test("mutation: a control named only inside a COMMENT is not a control", () => {
    // Prose explaining a control must never be able to fail the scan. A
    // `//`-commented note only exists inside a script block — a bare `//`
    // line in MARKUP is prose Svelte renders, not a comment (the mode
    // machine follows the language), so the mutation carries its fence.
    expect(
      scanDeskControls(`<script>// the handle carries role="slider" because …</script>`, AT),
    ).toEqual([]);
    expect(
      scanDeskControls(`<!-- <button onclick={f}>off</button> -->`, AT),
    ).toEqual([]);
  });
  test("script selectors and TypeScript generics are not controls; real nested markup is", () => {
    const script = `<script lang="ts">
      const button = document.querySelector<HTMLButtonElement>('[role="switch"]');
      const example = '<button class="grip">example</button>';
    </script>
    <!-- <div role="slider" class="grip"></div> -->`;
    expect.soft(scanDeskControls(script, AT), "script strings must not create anonymous controls").toEqual([]);
    expect.soft(scanDeskHitFloor(script, AT), "script strings must not create undersized controls").toEqual([]);
    const fault = script + `{#if shown}{#each rows as row}
      <div role='switch' class='grip' tabindex="0">{row}</div>
    {/each}{/if}<style>.grip { min-height: var(--hit-min); }</style>`;
    expect(scanDeskControls(fault, AT)).toEqual([
      expect.stringContaining("<div[role]> without data-verb-id"),
    ]);
    expect(scanDeskHitFloor(fault, AT)).toEqual([
      expect.stringContaining(".grip does not set BOTH"),
    ]);
    const restored = fault.replace("tabindex=", 'data-verb-id="tools.breaker/set" tabindex=')
      .replace("min-height: var(--hit-min);", "min-height: var(--hit-min); min-width: var(--hit-min);");
    expect(scanDeskControls(restored, AT)).toEqual([]);
    expect(scanDeskHitFloor(restored, AT)).toEqual([]);
  });
  test("markup traversal covers conditional, fallback, await, key and snippet controls", () => {
    const button = '<button class="grip">action</button>';
    const branches = `
      {#if shown}${button}{:else if other}${button}{:else}${button}{/if}
      {#each rows as row}${button}{:else}${button}{/each}
      {#await result}${button}{:then value}${button}{:catch error}${button}{/await}
      {#key key}${button}{/key}
      {#snippet actions()}${button}{/snippet}
    `;
    expect(scanDeskControls(branches, AT)).toHaveLength(10);
    expect(scanDeskHitFloor(branches, AT)).toHaveLength(10);
    const restored = branches.replaceAll('class="grip"', 'class="verb" data-verb-id="tools.breaker/set"');
    expect(scanDeskControls(restored, AT)).toEqual([]);
    expect(scanDeskHitFloor(restored, AT)).toEqual([]);
  });
  test("event expressions cannot truncate attributes or supply a phantom action name", () => {
    const good = `<button onclick={() => n > 0} class='verb' data-verb-id="tools.breaker/set">off</button>`;
    expect(scanDeskControls(good, AT)).toEqual([]);
    expect(scanDeskHitFloor(good, AT)).toEqual([]);
    const bad = `<button onclick={() => log('data-verb-id="x"')}>off</button>`;
    expect(scanDeskControls(bad, AT)).toHaveLength(1);
    expect(scanDeskHitFloor(bad, AT)).toHaveLength(1);
  });
  test("mutation: named controls and plain markup are NOT flagged", () => {
    const good = [
      `<button data-verb-id="tools.breaker/set" onclick={f}>off</button>`,
      `<select data-verb-id="chats.model/set" onchange={f}></select>`,
      `<input data-verb-id="tools.breaker/arm" type="number" />`,
      `<div data-verb-id="run.compose/trim" role="slider" tabindex="0"></div>`,
      `<span class="chip">on</span>`,
    ].join("\n");
    expect(scanDeskControls(good, AT)).toEqual([]);
  });
});

// ── STATIC: every desk control meets the pointer-target floor ──────────────
//
// The MOUSE-FIRST law's 24px floor is enforced repo-wide only for controls
// naming a grammar target, which no desk control does — so the desk was the
// whole remaining cluster below the floor (75 controls at 17–20px). A list
// of 75 fixes is a list; the rule that keeps them fixed is this scanner.
// `--hit-min` (tokens.css) is the single owner of the number: a control that
// restates `24px` fails exactly as one that is too small does.
//
// This is DELIBERATELY STRICTER than the shell's grammar-target check, which
// also accepts tokens whose value is already over the floor (--row-h and
// friends). A desk row is a dense line of chips, and "this one is fine
// because --row-h happens to be 28px today" is a floor that moves when
// somebody re-tunes the density scale. Here the control consumes the floor
// token itself, in both axes, or it fails.

/** The `<style>` block of a Svelte source, CSS comments stripped. */


/** The body of the first `.cls { … }` rule (null when the class has none).
 * `.cls` must end at a selector boundary so `.verb` never matches
 * `.verbs` and `.row` never matches `.row-h`. */
function deskRuleBody(style: string, cls: string): string | null {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\.${escaped}(?![\\w-])[^{}]*\\{`).exec(style);
  if (m === null) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < style.length && depth > 0; i += 1) {
    if (style[i] === "{") depth += 1;
    else if (style[i] === "}") depth -= 1;
  }
  return style.slice(start, i - 1);
}

/** Desk controls whose own rule does not size them to the floor. */
export function scanDeskHitFloor(src: string, file: string): string[] {
  const out: string[] = [];
  const style = deskStyle(src);
  const axis = (body: string, name: string): boolean =>
    new RegExp(`(^|[;{\\s])min-${name}\\s*:\\s*var\\(\\s*--hit-min\\s*\\)`).test(body);
  for (const { tag, className } of controlTags(src)) {
    const classes = className.trim().split(/\s+/);
    const cls = classes[0]!;
    if (cls.length === 0) {
      out.push(`${file}: <${tag}> has no class, so no rule can size it to the pointer floor`);
      continue;
    }
    // The owned control recipe (`.cockpit .verb` in tokens.css) clears the
    // floor for every verb whether or not this file adds a local variant —
    // a desk control wearing the shared recipe is sized by the one owner,
    // which is the migration working, not a control left unsized.
    if (classes.some(ownerClearsFloor)) {
      for (const name of classes) {
        if (!sizesToFloor(style, name, true).ok) out.push(`${file}: .${name} overrides the shared pointer floor`);
      }
      continue;
    }
    const body = deskRuleBody(style, cls);
    if (body === null) {
      out.push(`${file}: <${tag} class="${cls}"> has no .${cls} rule in this file's style block`);
      continue;
    }
    if (!axis(body, "height") || !axis(body, "width")) {
      out.push(
        `${file}: .${cls} does not set BOTH min-height and min-width from var(--hit-min) — ` +
          `a control under the pointer floor (a restated 24px does not count; the token owns it)`,
      );
    }
  }
  return out;
}

describe("static — every desk control meets the pointer-target floor", () => {
  const files = walk("src/cockpit/desk", { exts: [".svelte"] });

  test("no desk control is below the floor in either axis", () => {
    const all: string[] = [];
    for (const f of files) all.push(...scanDeskHitFloor(read(f), relpath(f)));
    expect(all, all.join("\n")).toEqual([]);
  });

  test("the floor's number still has exactly one owner", () => {
    expect(read("src/cockpit/tokens.css")).toMatch(/--hit-min:\s*40px/);
  });

  // ── MUTATION SELF-CHECKS ────────────────────────────────────────────────
  const AT = "src/cockpit/desk/Example.svelte";
  // The mutations use a class the OWNER does not dress (`.grip`, not
  // `.verb`): the owner clears the floor for `.verb` by design now, so a
  // mutation planted on `.verb` would be caught by nothing — the class the
  // plant needs is one the shared recipe does not claim.
  const withStyle = (rule: string, markup = `<button class="grip" data-verb-id="x">off</button>`) =>
    `${markup}\n<style>\n${rule}\n</style>`;

  test("mutation: a control sized only in one axis is flagged", () => {
    const hits = scanDeskHitFloor(withStyle(`.grip { min-height: var(--hit-min); }`), AT);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("BOTH min-height and min-width");
  });

  test("mutation: a control restating the literal instead of the token is flagged", () => {
    const hits = scanDeskHitFloor(
      withStyle(`.grip { min-height: 24px; min-width: 24px; }`),
      AT,
    );
    expect(hits).toHaveLength(1);
  });

  test("mutation: a control with no rule at all is flagged", () => {
    expect(scanDeskHitFloor(withStyle(`.other { color: red; }`), AT)).toHaveLength(1);
  });

  test("mutation: a control with no class is flagged", () => {
    const hits = scanDeskHitFloor(
      withStyle(`.verb { min-height: var(--hit-min); }`, `<button data-verb-id="x">off</button>`),
      AT,
    );
    expect(hits.some((h) => h.includes("no class"))).toBe(true);
  });

  test("mutation: a role-bearing element under the floor is flagged", () => {
    const hits = scanDeskHitFloor(
      withStyle(
        `.track { height: var(--tick-h); }`,
        `<div class="track" role="slider" tabindex="0" data-verb-id="x"></div>`,
      ),
      AT,
    );
    expect(hits.some((h) => h.includes(".track"))).toBe(true);
  });

  test("mutation: a control at the floor in both axes, and plain markup, are NOT flagged", () => {
    const good =
      `<button class="verb" data-verb-id="x">off</button>\n` +
      `<span class="chip">on</span>\n` +
      `<div class="bar" role="img"></div>\n` +
      `<style>\n.verb { min-height: var(--hit-min); min-width: var(--hit-min); }\n</style>`;
    expect(scanDeskHitFloor(good, AT)).toEqual([]);
  });

  test("mutation: a token that merely HAPPENS to be over the floor does not pass", () => {
    // --row-h is 28px today. If that were accepted, re-tuning the density
    // scale would silently drop desk controls back under the floor.
    expect(
      scanDeskHitFloor(withStyle(`.grip { height: var(--row-h); width: var(--row-h); }`), AT),
    ).toHaveLength(1);
  });

  test("mutation: the scanner does not confuse a class with a longer neighbour", () => {
    // `.verbs` is the row's container, not the control: a rule on it must
    // not be read as the control's own.
    expect(
      scanDeskHitFloor(
        withStyle(`.grips { min-height: var(--hit-min); min-width: var(--hit-min); }`),
        AT,
      ),
    ).toHaveLength(1);
  });
});

// ── RUNTIME: rendered controls resolve to real actions ─────────────────────

/** Actions the two live blocks declare (server/blocks/{compose,breaker}.ts). */
const DECLARED_ACTIONS: readonly string[] = [
  "run.compose/pin",
  "run.compose/unpin",
  "run.compose/mute",
  "run.compose/unmute",
  "run.compose/trim",
  "tools.breaker/set",
  "tools.breaker/reset",
  "tools.breaker/arm",
  "tools.breaker/disarm",
];

/** Client navigation primitives — no block, but a real effect on screen. */
const CLIENT_PRIMITIVES: readonly string[] = [
  "desk.strip/expand", // expand a strip's items
  "desk.scope/view", // open the served items in the SCOPE
  "desk.scope/why", // open the recorded trip event in the SCOPE
  "desk.body/expand", // unfold the rest of a composed body ("N more lines")
  "desk.arm-sheet/open", // open the row's auto-trip sheet (`,`)
  "setup.providers", // canonical Settings room
  ...INSPECTOR_SECTION_ENTRIES.filter(section => section.group === "setup").map(section => `disclosure.${section.id}`),
  "chats.model/set", // the existing client path: PATCH the chat's model
];

const CHAT = "chat-1";

const COMPOSE = {
  channels: [
    { id: "system", tokens: 300, items: [{ id: "system-prompt", label: "system prompt", tokens: 300 }] },
    { id: "memories", tokens: 100, items: [{ id: "mem-1", label: "[insight] tabs", tokens: 100 }] },
    { id: "history", tokens: 600, items: [{ id: "turn-1", label: "turn 1: hi", tokens: 600 }] },
    { id: "toolResults", tokens: 0, items: [] },
  ],
  limit: 10_000,
  settings: { pinnedMemoryIds: [], mutedChannels: [], mutedMemoryIds: [] },
};

const ROWS = [
  { id: "edit_file", label: "edit file", state: "on", calls: 12, lastMs: 3200 },
  { id: "search", label: "search", state: "tripped", calls: 7, lastError: "failed", tripAfterFailures: 3 },
];

function shellStub(): ShellApi {
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: () => {},
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: () => {},
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
  };
}

beforeEach(() => {
  clearCache();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
  setChats([
    {
      id: CHAT,
      projectId: "p1",
      title: "reader",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-25T00:00:00Z",
      modelId: "claude-x",
      pinned: false,
    },
  ]);
  currentChatId.set(CHAT);
  setModels({
    providers: [{ id: "prov", baseUrl: "http://x", models: [{ id: "claude-x" }], hasApiKey: true }],
    defaultProvider: "prov",
    defaultModel: "claude-x",
    setupRequired: false,
    setupRemedy: "Open Settings and add a model provider.",
  });
});

afterEach(() => {
  cleanup();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  vi.restoreAllMocks();
});

describe("runtime — every rendered control is wired to a real action", () => {
  test("all verb ids resolve to a declared block action or a listed primitive", async () => {
    // The un-muted desk, then the muted one: a two-way verb (mute/unmute)
    // renders only one of its faces per state, so the union of BOTH renders
    // is what must resolve — and the union is also what the reverse check
    // below demands reach the surface.
    const MUTED = {
      ...COMPOSE,
      channels: COMPOSE.channels.map((c) =>
        c.id === "memories"
          ? { ...c, items: c.items.map((i) => (i.id === "mem-1" ? { ...i, tokens: 0 } : i)) }
          : c,
      ),
      settings: {
        ...COMPOSE.settings,
        // The desk agent's real end state, all of them: a memory pinned
        // and then muted (the mute suspends the standing pin — and the read
        // still LISTS it, struck at 0 tokens, carrying the way back), plus
        // the whole memories channel muted. This state renders unpin AND
        // unmute — the faces the un-muted render cannot show.
        pinnedMemoryIds: ["mem-1"],
        mutedChannels: ["memories"],
        mutedMemoryIds: ["mem-1"],
      },
    };
    const renderedUnion = new Set<string>();
    for (const composeWire of [COMPOSE, MUTED]) {
      setDeskIo({ compose: async () => composeWire, breaker: async () => ROWS, act: async () => ({}) });
      const { container, findByText } = render(DeskPanel, { shell: shellStub() });
      await findByText("edit file");
      // Open the folds so the item-level controls render too.
      for (const b of container.querySelectorAll<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')) {
        await fireEvent.click(b);
      }
      // EVERY row's arm sheet, not just the first's: the armed row (search,
      // tripAfterFailures 3) carries the disarm control the un-armed row
      // does not — a guard that only opened the first sheet once let a
      // whole verb ship without resolving to anything real.
      for (const b of container.querySelectorAll<HTMLButtonElement>('[data-verb-id="desk.arm-sheet/open"]')) {
        await fireEvent.click(b);
        await waitFor(() => expect(container.querySelector(".arm-sheet")).not.toBeNull());
      }

      const controls = [...container.querySelectorAll<HTMLElement>("[data-verb-id]")];
      expect(controls.length).toBeGreaterThan(8);
      for (const c of controls) renderedUnion.add(c.dataset.verbId!);
      const known = new Set([...DECLARED_ACTIONS, ...CLIENT_PRIMITIVES]);
      const unknown = controls
        .map((c) => c.dataset.verbId!)
        .filter((id) => !known.has(id));
      expect([...new Set(unknown)], "verb ids naming nothing real").toEqual([]);
      cleanup();
    }
    // And the mirror above stays honest in the other direction too: every
    // DECLARED action really renders somewhere on this desk, in some state.
    for (const id of DECLARED_ACTIONS) {
      expect(renderedUnion.has(id), `${id} is declared but never rendered — an inert verb`).toBe(true);
    }
  });

  test("a disabled control always carries its reason (never a dead label)", async () => {
    // No shell → the scope-opening primitives cannot deliver their effect.
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: null });
    await findByText("edit file");
    const disabled = [...container.querySelectorAll<HTMLElement>("[data-verb-id]")].filter(
      (c) => (c as HTMLButtonElement).disabled === true,
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const c of disabled) {
      expect(c.getAttribute("title"), `${c.dataset.verbId} disabled without a reason`).toBeTruthy();
    }
  });

  test("every breaker flip control states the next-boundary consequence ON it", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    for (const c of container.querySelectorAll<HTMLElement>('[data-verb-id="tools.breaker/set"]')) {
      expect(c.getAttribute("title")).toContain("next tool decision");
      expect(c.getAttribute("title")).toContain("already running finishes");
    }
  });
});

// ── LATENCY (§1.5 F2) ──────────────────────────────────────────────────────

describe("latency budget — the desk's two bounds", () => {
  const DESK_OPEN_BUDGET_MS = 200;
  const ACT_ACK_BUDGET_MS = 100;

  test("the open desk paints within 200ms over instant IO", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const t0 = performance.now();
    const { findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    expect(performance.now() - t0).toBeLessThan(DESK_OPEN_BUDGET_MS);
  });

  test("an act acknowledges within 100ms — even when the network never answers", async () => {
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => ROWS,
      // A post that never settles: the acknowledgement must not wait on it.
      act: () => new Promise<unknown>(() => {}),
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const row = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    const t0 = performance.now();
    await fireEvent.click(row.querySelector<HTMLButtonElement>('[data-verb-id="tools.breaker/set"]')!);
    const ackedAt = performance.now();
    expect(pendingActs.get()["breaker:edit_file"]).toBeDefined();
    expect(ackedAt - t0).toBeLessThan(ACT_ACK_BUDGET_MS);
    // …and the acknowledgement is visible on the row, with the consequence.
    await waitFor(() => expect(row.querySelector('[data-note="live"]')?.textContent).toContain(pendingActs.get()["breaker:edit_file"]));
    expect(row.querySelector('[data-verb-id="tools.breaker/set"]')!.getAttribute("aria-busy")).toBe("true");
    expect(row.textContent).toContain("takes effect at the next tool decision");
  });
});

test('shared floor follows actual class membership, while a local undersize remains a real fault',()=>{
  for(const classes of ['tool-label verb bare','verb bare tool-label']){
    const markup=`<button class="${classes}" data-verb-id="tools.breaker/set">Available</button>`;
    expect(scanDeskHitFloor(markup,'shared-floor-witness.svelte')).toEqual([]);
    expect(scanDeskHitFloor(markup+'<style>.tool-label { min-width: 0; }</style>','shared-floor-witness.svelte')).toEqual(['shared-floor-witness.svelte: .tool-label overrides the shared pointer floor']);
    expect(scanDeskHitFloor(markup+'<style>.tool-label { min-height: 12px; }</style>','shared-floor-witness.svelte')).toEqual(['shared-floor-witness.svelte: .tool-label overrides the shared pointer floor']);
  }
});
