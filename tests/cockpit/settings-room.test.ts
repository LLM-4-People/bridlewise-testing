// @vitest-environment jsdom
/**
 * THE SETTINGS INDEX (⌘,) — live in jsdom (spec §9.3).
 *
 * What must hold on screen:
 *   - CATEGORIES ARE DERIVED. Every category's words trace to a declaration
 *     (the served `exposureModules`, or `local-prefs.ts::LOCAL_MODULES` for
 *     the device rows). A namespace that declares none still renders, spelled
 *     out, and says so — rows are never unreachable because words are missing.
 *     Mutation-tested: strip the declarations and the fallback path is taken,
 *     and no hand-authored namespace→name table may exist in the tree.
 *   - NOTHING IS BEHIND A DOOR. Categories are a map of ONE scroll, not pages:
 *     every setting is reachable by browsing AND by search, and pressing a
 *     category never removes a row from the room.
 *   - each row states its current value, WHERE that value came from (a change,
 *     or the built-in default) and WHEN a change takes effect;
 *   - opening a row renders the SAME SettingSheet component inline, and its
 *     save posts the same one validated action;
 *   - every control produces an observable outcome (each is exercised here);
 *   - the surface link is a per-CATEGORY fact and only where a room is BUILT;
 *   - a row whose served label is a raw registry key refuses to render.
 *
 * The WIDE/NARROW arrangement is asserted in the browser
 * (tests/cockpit/e2e/settings-width.spec.ts) where boxes have real geometry;
 * jsdom reports zero for every box, so the room falls to its narrow
 * arrangement here unless a width is stubbed in.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import SettingsRoom from "../../src/cockpit/rooms/SettingsRoom.svelte";
import {
  requestIndexQuery,
  resetSettingsFeed,
  setSettingsReaders,
} from "../../src/cockpit/settings/settings-feed.ts";
import { applyStoredCockpitPrefs, LOCAL_MODULES, LOCAL_ROWS } from "../../src/cockpit/settings/local-prefs.ts";
import {
  CATEGORY_FOLD_MIN_ROWS,
  SETTINGS_SPLIT_MIN_PX,
} from "../../src/cockpit/settings/settings-config.ts";
import {
  resetUiSchema,
  setUiSchema,
  setUiSchemaValues,
} from "../../src/state/schema-store.ts";
import { clearCache } from "../../src/data/broker.ts";
import { SCHEMA, VALUES } from "./fixtures/settings-schema.ts";
import type { RoomId, ShellApi } from "../../src/cockpit/shell/contract.ts";
import type { UiSchema } from "../../shared/ui-schema.ts";

// Row counts are DERIVED (fixture's served customizations + the real device
// rows) so a new local preference lands here with no edit — a hardcoded 5
// went stale the day a third device row was added.
const SERVED_ROW_COUNT = SCHEMA.settings.filter((s) => s.customizationId !== undefined).length;
const ALL_ROW_COUNT = SERVED_ROW_COUNT + LOCAL_ROWS.length;

// The room asks the shell's outlet registry which rooms are BUILT. In this
// harness the real registry answers for the real tree; mocking it pins the
// "honest link only" assertions to a known set regardless of sibling files.
// The set is MUTABLE so one arm can build the instruments room (the
// readings-only tile's destination) without loosening the default set the
// honest-absence arms judge against.
const builtRooms = vi.hoisted(() => new Set<string>(["tools", "settings"]));
vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  loadRoom: async () => null,
  roomExists: (id: string) => builtRooms.has(id),
}));

type Posted = { url: string; body: unknown };
let posted: Posted[];

/**
 * Svelte's `bind:clientWidth` rides ResizeObserver, which jsdom lacks. An
 * inert observer is the honest stand-in: jsdom boxes report zero geometry
 * anyway, so the room measures 0 and falls to its NARROW arrangement — which
 * is what most of these tests want, and the split arrangement is measured live
 * in the browser where widths are real.
 */
type ROEntry = { cb: ResizeObserverCallback; el: Element };
const observed: ROEntry[] = [];
class InertResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb;
  }
  observe(el: Element): void {
    observed.push({ cb: this.#cb, el });
  }
  unobserve(): void {}
  disconnect(): void {}
}
function setRoomWidth(px: number): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  for (const o of observed) {
    o.cb(
      [{ target: o.el, contentRect: { width: px } } as unknown as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  }
}

function makeShell(): ShellApi & { closed: () => number; opened: () => readonly RoomId[] } {
  let closed = 0;
  const opened: RoomId[] = [];
  return {
    revealAt: () => 0,
    openRoom: (id) => opened.push(id),
    closeRoom: () => {
      closed += 1;
    },
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
    closed: () => closed,
    opened: () => opened,
  };
}

beforeEach(() => {
  cleanup();
  observed.length = 0;
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  // jsdom's own zero-width boxes: the narrow arrangement, unless a test says
  // otherwise.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 0,
  });
  posted = [];
  clearCache();
  resetSettingsFeed();
  resetUiSchema();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push({ url: String(input), body: JSON.parse(String(init.body ?? "{}")) });
        return new Response(
          JSON.stringify({ data: { saved: true }, meta: { etag: 'W/"1"', asOf: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  setUiSchema(SCHEMA);
  setUiSchemaValues(VALUES);
  setSettingsReaders({
    schema: async () => setUiSchema(SCHEMA),
    values: async () => setUiSchemaValues(VALUES),
  });
  window.localStorage.clear();
  applyStoredCockpitPrefs();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettingsFeed();
  resetUiSchema();
});

// ── The property that makes this surface unclonable ───────────────────────

describe("categories are DERIVED from declarations, never authored here", () => {
  // ── THE ROOM FOCUS GRAMMAR (UIE-051) — the with-input half ────────────────
  //
  // Settings has a primary input (the behavior-word search IS the room's
  // way in), so opening it lands focus there — the same half of the
  // convention the Switch's suite pins; custody's and instruments' suites
  // pin the without-input half.
  test("opening the room lands focus in its primary input — the search", async () => {
    const { findByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const field = document.querySelector<HTMLInputElement>('input[name="settings-search"]')!;
    expect(document.activeElement).toBe(field);
  });

  test("each category's title is the declared one, joined by the setting's declared module", async () => {
    const { findAllByText, container } = render(SettingsRoom, { shell: makeShell() });
    // The served declarations' own words — not "Tools", not "tools". TWICE
    // each, deliberately: the map and the heading are on screen together,
    // which is the whole point of the wide arrangement.
    expect((await findAllByText("Running tools")).length).toBe(2);
    expect((await findAllByText("What the model is told")).length).toBe(2);
    // The device rows' category, declared beside those rows.
    expect((await findAllByText(LOCAL_MODULES[0]!.title)).length).toBe(2);
    // Every rendered category section carries the namespace it grouped by, so
    // the join is inspectable rather than asserted.
    const ids = [...container.querySelectorAll("[data-category]")].map((n) =>
      n.getAttribute("data-category"),
    );
    expect(ids).toContain("tools");
    expect(ids).toContain("context");
    expect(ids).toContain("cockpit");
  });

  test("a namespace that declares NO category still renders, spelled out, and says so", async () => {
    // The fixture deliberately declares no module for `editor`.
    const { findByText, findAllByText } = render(SettingsRoom, { shell: makeShell() });
    // Its rows are present…
    expect(await findByText("Atomic writes")).toBeTruthy();
    // …under the honest fallback, which is the namespace spelled out…
    expect((await findAllByText("Editor")).length).toBe(2);
    // …and which SAYS the words are missing rather than looking authored.
    expect(await findByText(/has not declared what this area does/)).toBeTruthy();
  });

  test("MUTATION: strip the declarations and EVERY category falls back — nothing vanishes", async () => {
    setUiSchema({ ...SCHEMA, exposureModules: [] } as unknown as UiSchema);
    const { findByText, findAllByText, container, queryByText } = render(SettingsRoom, {
      shell: makeShell(),
    });
    await findByText("Parallel tool calls");
    // The declared words are gone…
    expect(queryByText("Running tools")).toBeNull();
    // …every namespace is spelled out instead…
    expect((await findAllByText("Tools")).length).toBe(2);
    expect((await findAllByText("Context")).length).toBe(2);
    // …and not one setting was lost with the words.
    expect(container.querySelectorAll("li.setting-row").length).toBe(ALL_ROW_COUNT);
  });

  test("MUTATION: a category name may not be hand-authored in the settings tree", () => {
    // THE GUARD THAT MAKES THE ABOVE STRUCTURAL. `MODULE_NAMES` in the old
    // tree was exactly this: `{ search: "Code search", memory: … }` written in
    // a consumer. If one reappears here, the twelfth registered module gets no
    // category and nothing fails — so the shape itself is banned.
    const files = [
      "src/cockpit/rooms/SettingsRoom.svelte",
      "src/cockpit/settings/settings-data.ts",
      "src/cockpit/settings/settings-config.ts",
    ];
    // A map literal from a known exposure namespace to a quoted name.
    const authoredMap =
      /\b(search|memory|awareness|editor|quality|safety|learning|context|tools|hallucination|bias|privacy)\s*:\s*["'`]/;
    for (const f of files) {
      const src = readFileSync(resolve(process.cwd(), f), "utf8");
      // Strip comments — the ban is on code, and the doc comments name the
      // namespaces on purpose.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join("\n");
      expect(authoredMap.test(code), `${f} authors a namespace→name map`).toBe(false);
    }
    // …and the mutation proof: the banned shape IS caught when present.
    expect(authoredMap.test('const M = { search: "Code search" };')).toBe(true);
  });
});

// ── Nothing behind a door ─────────────────────────────────────────────────

describe("categories are a map of one scroll, never pages (§9.3)", () => {
  test("every setting is reachable by BROWSING — each row sits in a rendered category", async () => {
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const rows = [...container.querySelectorAll("li.setting-row")];
    expect(rows.length).toBe(ALL_ROW_COUNT);
    for (const row of rows) {
      const section = row.closest("[data-category]");
      expect(section, `${row.getAttribute("data-setting")} sits in no category`).toBeTruthy();
    }
  });

  test("every setting is reachable by SEARCH — its own label finds it", async () => {
    const { findByText, getByLabelText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const field = getByLabelText("search settings by behavior words");
    // Collected BEFORE the first search narrows the list.
    const pairs = [...container.querySelectorAll("li.setting-row")].map((n) => ({
      id: n.getAttribute("data-setting")!,
      label: n.querySelector(".label")!.textContent!.trim(),
    }));
    expect(pairs.length).toBe(ALL_ROW_COUNT);
    for (const { id, label } of pairs) {
      await fireEvent.input(field, { target: { value: label } });
      await waitFor(() =>
        expect(
          container.querySelector(`li.setting-row[data-setting="${id}"]`),
          `"${label}" does not find its own setting`,
        ).toBeTruthy(),
      );
    }
  });

  test("pressing a category MOVES the reading position — it never removes a row", async () => {
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const before = container.querySelectorAll("li.setting-row").length;
    const entry = container.querySelector<HTMLButtonElement>('[data-category-link="context"]')!;
    // OBSERVABLE OUTCOME: the entry becomes the focused one, and the scroll is
    // asked to move — with every row still in the room.
    const scrolled: string[] = [];
    for (const el of container.querySelectorAll("[data-category]")) {
      (el as HTMLElement).scrollIntoView = () => scrolled.push(el.getAttribute("data-category")!);
    }
    await fireEvent.click(entry);
    expect(scrolled).toEqual(["context"]);
    expect(entry.className).toMatch(/focused/);
    expect(container.querySelectorAll("li.setting-row").length).toBe(before);
  });

  test("a search that passes a category over DIMS it in the rail — it is never dropped", async () => {
    const { findByText, getByLabelText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    await fireEvent.input(getByLabelText("search settings by behavior words"), {
      target: { value: "half-written" },
    });
    await waitFor(() => expect(container.querySelectorAll("li.setting-row").length).toBe(1));
    // Every category is still LISTED in the rail — a reader can see what the
    // search passed over rather than wondering what disappeared.
    expect(container.querySelector('[data-category-link="tools"]')).toBeTruthy();
    expect(container.querySelector('[data-category-link="tools"]')!.className).toMatch(/passed/);
    expect(container.querySelector('[data-category-link="editor"]')!.className).not.toMatch(
      /passed/,
    );
  });
});

// ── The rows themselves ───────────────────────────────────────────────────

describe("what a row states", () => {
  test("every served customization + the local preferences are all present", async () => {
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    expect(await findByText("Parallel tool calls")).toBeTruthy();
    expect(await findByText("Compaction strategy")).toBeTruthy();
    expect(await findByText("Atomic writes")).toBeTruthy();
    expect(await findByText("Density")).toBeTruthy();
    expect(await findByText("Theme")).toBeTruthy();
    expect(await findByText("Debug logging")).toBeTruthy();
    expect(container.querySelectorAll("li.setting-row").length).toBe(ALL_ROW_COUNT);
  });

  test("each row shows its current value read from the served snapshot", async () => {
    const { findByText } = render(SettingsRoom, { shell: makeShell() });
    expect(await findByText("4 calls")).toBeTruthy();
    // The INDEX's reading, in this row's own words — the most-seen of the
    // four places a server token used to reach the screen, because it renders
    // once per row rather than once per opened sheet.
    expect(await findByText("Summarize")).toBeTruthy();
    expect(await findByText("on")).toBeTruthy();
  });

  test("PROVENANCE: a value equal to the default says so, and a changed one says THAT", async () => {
    // The fixture's values all equal their declared defaults except
    // `context.compactStrategy`, whose default is "summarize"… and whose value
    // IS "summarize". So change one on the wire to exercise both branches.
    const changed = {
      signals: VALUES.signals,
      customizations: [
        { id: "tools.parallelCap", value: 9 },
        { id: "context.compactStrategy", value: "summarize" },
        { id: "editor.atomicWriteEnabled", value: true },
      ],
    } as never;
    setUiSchemaValues(changed);
    // The room re-reads on every open (§9.3 honest read-back), so the reader
    // must answer with the same snapshot or the read would put the fixture back.
    setSettingsReaders({ schema: async () => setUiSchema(SCHEMA), values: async () => setUiSchemaValues(changed) });
    const { container, findByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const cap = container.querySelector('li.setting-row[data-setting="tools.parallelCap"]')!;
    expect(cap.querySelector(".provenance")!.textContent).toBe("Custom");
    // The one fact on the row that says a decision was made reads at full ink.
    expect(cap.querySelector(".value")!.getAttribute("data-provenance")).toBe("changed");

    const strat = container.querySelector('li.setting-row[data-setting="context.compactStrategy"]')!;
    expect(strat.querySelector(".provenance")).toBeNull();
    expect(strat.querySelector(".value")!.getAttribute("data-provenance")).toBe("at-default");
    // NEVER "nobody set this": the snapshot carries a value, not a history.
    expect(strat.textContent).not.toMatch(/you set|nobody/i);
  });

  test("TIMING is declared-only — an undeclared one says it is undeclared", async () => {
    const { container, findByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    // The fixture declares `effect: "immediate"` for the cap and nothing for
    // the strategy.
    expect(container.querySelector('li.setting-row[data-setting="tools.parallelCap"] .timing')).toBeNull();
    await fireEvent.click(container.querySelector('li.setting-row[data-setting="tools.parallelCap"] .row-face')!);
    expect(container.querySelector('[data-setting-sheet] .setting-context')?.textContent).toContain("AppliesImmediately");
    expect(
      container.querySelector('li.setting-row[data-setting="context.compactStrategy"] .timing')!
        .textContent,
    ).toMatch(/when this takes effect is not declared/);
  });

  test("a value the snapshot has not answered for reads as absent, never as zero", async () => {
    const empty = { signals: [], customizations: [] } as never;
    setUiSchemaValues(empty);
    setSettingsReaders({ schema: async () => setUiSchema(SCHEMA), values: async () => setUiSchemaValues(empty) });
    const { container, findByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const cap = container.querySelector('li.setting-row[data-setting="tools.parallelCap"]')!;
    expect(cap.querySelector(".value")!.textContent).toMatch(/not read yet/);
    expect(cap.querySelector(".value")!.getAttribute("data-provenance")).toBe("unread");
    expect(cap.querySelector(".provenance")).toBeNull();
    expect(cap.textContent?.match(/not read yet/gi)).toHaveLength(1);
  });

  test("the count line states served vs device-kept, and how many categories", async () => {
    const { findByTitle, findByText } = render(SettingsRoom, { shell: makeShell() });
    const counts = await findByTitle(`${LOCAL_ROWS.length} kept on this device · ${SERVED_ROW_COUNT} served by this install`);
    expect(counts.textContent).toContain(`${LOCAL_ROWS.length + SERVED_ROW_COUNT} settings`);
    expect(await findByText(/5 categories/)).toBeTruthy();
  });
});

describe("search by behavior words", () => {
  test("a word from the served description filters the list", async () => {
    const { findByText, getByLabelText, container } = render(SettingsRoom, {
      shell: makeShell(),
    });
    await findByText("Parallel tool calls");
    await fireEvent.input(getByLabelText("search settings by behavior words"), {
      target: { value: "half-written" },
    });
    await waitFor(() => expect(container.querySelectorAll("li.setting-row").length).toBe(1));
    expect(await findByText("Atomic writes")).toBeTruthy();
  });

  test("no behavior match states it plainly, with the way back", async () => {
    const { findByText, getByLabelText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    await fireEvent.input(getByLabelText("search settings by behavior words"), {
      target: { value: "zzzz" },
    });
    expect(await findByText(/no setting's behavior matches “zzzz”/)).toBeTruthy();
    expect(await findByText(new RegExp(`clear the search to see all ${ALL_ROW_COUNT}`))).toBeTruthy();
  });

  test("CONTROL: clear puts every setting back", async () => {
    const { findByText, getByLabelText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    await fireEvent.input(getByLabelText("search settings by behavior words"), {
      target: { value: "half-written" },
    });
    await waitFor(() => expect(container.querySelectorAll("li.setting-row").length).toBe(1));
    await fireEvent.click(await findByText("Clear"));
    await waitFor(() => expect(container.querySelectorAll("li.setting-row").length).toBe(ALL_ROW_COUNT));
    expect((getByLabelText("search settings by behavior words") as HTMLInputElement).value).toBe("");
  });

  test("a handed-over query (from the LENS callout) pre-searches the index once", async () => {
    requestIndexQuery("tools");
    const { getByLabelText, container } = render(SettingsRoom, { shell: makeShell() });
    await waitFor(() =>
      expect((getByLabelText("search settings by behavior words") as HTMLInputElement).value).toBe(
        "tools",
      ),
    );
    expect(container.querySelectorAll("li.setting-row").length).toBe(1);
  });
});

describe("every control produces an observable outcome (§1.2)", () => {
  /** A schema whose `tools` category is big enough to be worth folding. */
  function bigToolsSchema(): UiSchema {
    const extra = [2, 3, 4].map((n) => ({
      id: `tools.knob${n}`,
      label: `Tool knob ${n}`,
      description: `A tool behaviour this install can turn, number ${n} of them.`,
      type: "number",
      default: n,
      customizationId: `tools.knob${n}`,
      module: "tools",
      order: 10 + n,
    }));
    return { ...SCHEMA, settings: [...SCHEMA.settings, ...extra] } as unknown as UiSchema;
  }

  test("CONTROL: fold hides a category's rows and says how many it is holding", async () => {
    const schema = bigToolsSchema();
    setUiSchema(schema);
    setSettingsReaders({
      schema: async () => setUiSchema(schema),
      values: async () => setUiSchemaValues(VALUES),
    });
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    const section = container.querySelector('[data-category="tools"]')!;
    expect(section.querySelectorAll("li.setting-row").length).toBe(4);
    await fireEvent.click(section.querySelector<HTMLButtonElement>(".fold")!);
    await waitFor(() => expect(section.querySelectorAll("li.setting-row").length).toBe(0));
    // Folding hides ROWS, never their existence.
    expect(section.querySelector(".cat-count")!.textContent!.replace(/\s+/g, " ").trim()).toMatch(
      /^4 settings$/,
    );
    await fireEvent.click(section.querySelector<HTMLButtonElement>(".fold")!);
    await waitFor(() => expect(section.querySelectorAll("li.setting-row").length).toBe(4));
  });

  test("the fold grip exists exactly where a category is big enough to be worth it", async () => {
    // The grip costs more pixels than the rows it could hide below the bound —
    // and a control that is not worth pressing is a control that should not be
    // on screen (§1.2). Judged per section against the bound rather than
    // against a transcribed population: the device category crossed the bound
    // when the splitter pair landed, and a count written here would have gone
    // stale exactly then. Both branches must occur, or this test is vacuous.
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    let small = 0;
    let big = 0;
    for (const section of container.querySelectorAll("[data-category]")) {
      const rows = section.querySelectorAll("li.setting-row").length;
      if (rows >= CATEGORY_FOLD_MIN_ROWS) {
        big += 1;
        expect(section.querySelector(".fold"), "a big category must offer the grip").not.toBeNull();
      } else {
        small += 1;
        expect(section.querySelector(".fold"), "a small category must not").toBeNull();
      }
    }
    expect(small, "no small category in the fixture — the no-grip branch proved nothing").toBeGreaterThan(0);
    expect(big, "no big category in the fixture — the grip branch proved nothing").toBeGreaterThan(0);
  });

  test("CONTROL: every button in the room is exercised or has its outcome named here", async () => {
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    // No control may exist without naming its action (§1.2). The static
    // scanner in settings-write-path-owner enforces presence; this asserts the
    // rendered set is exactly the five verbs this room claims, so a new inert
    // control cannot slip in unnamed OR under a sixth invented name.
    const verbs = new Set(
      [...container.querySelectorAll("button")].map((b) => b.getAttribute("data-verb-id")),
    );
    expect([...verbs].sort()).toEqual([
      "settings.index/adjust",
      "settings.index/fold-category",
      "settings.index/go-to-category",
      "settings.index/go-to-surface",
    ]);
    // (`clear-search` renders only while a search stands — proven above, in
    // the test that presses it. `fold-category` renders here because the
    // device category grew past the fold bound with the splitter pair.)
    for (const b of container.querySelectorAll("button")) {
      expect(b.getAttribute("data-verb-id")).toBeTruthy();
      // Nothing in this room is a dead label: no control renders disabled.
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe("the row IS the sheet (§9.3 — one component, one action)", () => {
  test("opening a row renders the same SettingSheet inline and saves through the one action", async () => {
    const { findByText, findAllByText, container } = render(SettingsRoom, { shell: makeShell() });
    await fireEvent.click(await findByText("Compaction strategy"));
    await waitFor(() => expect(container.querySelector("[data-setting-sheet]")).toBeTruthy());
    expect(container.querySelector("[data-setting-sheet]")!.getAttribute("data-setting")).toBe(
      "context.compactStrategy",
    );
    // Expansion retains one explanation, inside the actual editor.
    expect((await findAllByText(/folds itself down when it grows past/)).length).toBe(1);
    await fireEvent.click(await findByText("Truncate"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.url).toMatch(/\/api\/b\/settings\.customizations\/set$/);
    expect(posted[0]!.body).toEqual({ id: "context.compactStrategy", value: "truncate" });
  });

  test("a local row's inline sheet applies device-side with no network", async () => {
    const { findByText } = render(SettingsRoom, { shell: makeShell() });
    await fireEvent.click(await findByText("Density"));
    await fireEvent.click(await findByText("Deep"));
    expect(document.documentElement.dataset.density).toBe("deep");
    expect(posted.length).toBe(0);
  });
});

describe("surface links — a per-CATEGORY fact (and, for readings-only areas, a per-DECLARATION one), and only where built", () => {
  test("a built namespace room links once for the category; the link closes and opens", async () => {
    const shell = makeShell();
    const { findAllByText, container } = render(SettingsRoom, { shell });
    const links = await findAllByText("manifests in the tools room →");
    // ONE per category, not one per row: the mapping reads only the module.
    expect(links.length).toBe(1);
    expect(links[0]!.closest("[data-category]")!.getAttribute("data-category")).toBe("tools");
    await fireEvent.click(links[0]!);
    expect(shell.closed()).toBe(1);
    expect(shell.opened()).toEqual(["tools"]);
    void container;
  });

  test("a module with no built surface offers NO link", async () => {
    // Matched against the LINK's own words, not any prose containing a room's
    // name — a row description may honestly mention "the editor room" without
    // being a door to it.
    const { findByText, queryByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Atomic writes");
    expect(queryByText(/manifests in the editor room/)).toBeNull();
    expect(queryByText(/manifests in the instruments room/)).toBeNull();
  });

  test("a readings-only area's greyed tile carries the cross-room pointer, and it lands", async () => {
    // UIE-083. The tile is a readings-only module's ONLY settings-side
    // surface — no rows means no category section, so nothing else in the
    // room ever names the area or its readings' home. The pointer is the
    // room's own cross-link grammar (the same verb, the same words), and
    // the tile itself stays a non-link: it is information, and a greyed
    // span that looked clickable would promise a verb it does not have.
    builtRooms.add("instruments");
    try {
      const shell = makeShell();
      const { findAllByText, container } = render(SettingsRoom, { shell });
      await findAllByText("nothing to adjust");
      const link = container.querySelector<HTMLButtonElement>(".rail-empty .surface-link")!;
      expect(link, "the readings-only tile renders the pointer").toBeTruthy();
      expect(link.getAttribute("data-verb-id")).toBe("settings.index/go-to-surface");
      expect(link.textContent!.trim()).toBe("measured in the instruments room →");
      const tile = link.closest(".rail-empty")!;
      expect(tile.querySelector(".rail-title")!.textContent).toBe("How fast the web app must stay");
      // The tile itself carries no jump and no adjust verb — only the link
      // leaves the room.
      expect(tile.querySelector("button:not(.surface-link)")).toBeNull();
      // OBSERVABLE OUTCOME: the click closes settings and opens the room
      // the readings render in.
      await fireEvent.click(link);
      expect(shell.closed()).toBe(1);
      expect(shell.opened()).toEqual(["instruments"]);
    } finally {
      builtRooms.delete("instruments");
    }
  });

  test("an empty area with NO readings gets NO pointer — never a link to nowhere", async () => {
    // `memory` declares a category, owns no settings, registers no signals:
    // its tile honestly says "nothing to adjust" and there is nothing
    // measured to point at. The pointer is DERIVED from the module's own
    // signals, not assumed for every greyed tile.
    builtRooms.add("instruments");
    try {
      const { findAllByText, container } = render(SettingsRoom, { shell: makeShell() });
      await findAllByText("nothing to adjust");
      const byTitle = new Map(
        [...container.querySelectorAll(".rail-empty")].map((t) => [
          t.querySelector(".rail-title")!.textContent,
          t,
        ]),
      );
      expect(byTitle.get("How fast the web app must stay")!.querySelector(".surface-link"))
        .toBeTruthy();
      expect(byTitle.get("What the assistant remembers")!.querySelector(".surface-link"))
        .toBeNull();
    } finally {
      builtRooms.delete("instruments");
    }
  });
});

describe("empty and unreadable states say what is true", () => {
  // Every declaration that owns no row — derived from the fixture, so a
  // third readings-only module added to the wire lands here with no edit
  // (the class, not a member list).
  const DECLARED_EMPTY = (SCHEMA.exposureModules ?? []).filter(
    (d) => !SCHEMA.settings.some((s) => s.customizationId !== undefined && s.module === d.id),
  );

  test("a declared category holding nothing to adjust is NAMED, not omitted", async () => {
    // The fixture declares `memory` (no rows, no signals) and
    // `webPerformance` (no rows, readings-only — the real class): both
    // render as named greyed tiles, never as absent areas.
    expect(DECLARED_EMPTY.length).toBeGreaterThanOrEqual(2);
    const { findAllByText } = render(SettingsRoom, { shell: makeShell() });
    const tiles = await findAllByText("nothing to adjust");
    expect(tiles.length).toBe(DECLARED_EMPTY.length);
    expect(await findAllByText("What the assistant remembers")).toBeTruthy();
    expect(await findAllByText("How fast the web app must stay")).toBeTruthy();
  });

  test("an unreadable served schema still lists this device's settings, and says why", async () => {
    resetUiSchema();
    setSettingsReaders({
      schema: async () => {
        throw new Error("schema route refused");
      },
      values: async () => {
        throw new Error("schema route refused");
      },
    });
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    expect(await findByText(/served settings not readable: schema route refused/)).toBeTruthy();
    // The device rows do not depend on the wire, so the rail still offers them.
    expect(await findByText(/only this device's are listed/)).toBeTruthy();
    void container;
  });

  test("a read that fails AFTER a good one keeps the old values and labels them stale", async () => {
    const { findByText } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    setSettingsReaders({
      schema: async () => undefined,
      values: async () => {
        throw new Error("values route refused");
      },
    });
    const second = render(SettingsRoom, { shell: makeShell() });
    await waitFor(() =>
      expect(second.container.querySelector(".stale-note")!.textContent).toMatch(
        /the last read of the install's settings failed: values route refused/,
      ),
    );
    // …and the previous answer still stands, never a blank or a zero.
    expect(
      second.container.querySelector('li.setting-row[data-setting="tools.parallelCap"] .value')!.textContent,
    ).toMatch(/4 calls/);
  });
});

describe("the split arrangement is decided by the room's own box", () => {
  test("at the split width the map and the settings are both mounted", async () => {
    setRoomWidth(SETTINGS_SPLIT_MIN_PX);
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    setRoomWidth(SETTINGS_SPLIT_MIN_PX);
    await waitFor(() => expect(container.querySelector(".index.split")).toBeTruthy());
    // Both halves present in the same frame — the geometry is asserted in the
    // browser suite; this pins the arrangement flag to the measured box.
    expect(container.querySelector(".settings-rail")).toBeTruthy();
    expect(container.querySelector(".settings-scroll")).toBeTruthy();
  });

  test("MUTANT: one pixel under the split width, the room is not split", async () => {
    setRoomWidth(SETTINGS_SPLIT_MIN_PX - 1);
    const { findByText, container } = render(SettingsRoom, { shell: makeShell() });
    await findByText("Parallel tool calls");
    setRoomWidth(SETTINGS_SPLIT_MIN_PX - 1);
    await waitFor(() => expect(container.querySelector(".index.split")).toBeNull());
    // …and the map is still there, above the settings rather than beside them.
    expect(container.querySelector(".settings-rail")).toBeTruthy();
    expect(container.querySelectorAll("li.setting-row").length).toBe(ALL_ROW_COUNT);
  });
});

describe("mutation: a raw-key row refuses to render", () => {
  test("a served label that IS the registry key throws at the boundary", () => {
    setUiSchema({
      ...SCHEMA,
      settings: [
        {
          id: "context.maxContext",
          label: "context.maxContext",
          description: "raw",
          type: "number",
          default: 1,
          customizationId: "context.maxContext",
          module: "context",
          order: 0,
        },
      ],
    } as unknown as UiSchema);
    expect(() => render(SettingsRoom, { shell: makeShell() })).toThrow(/raw key|behavior words/);
  });
});


test("search removes provider controls from the active surface without discarding a draft", async () => {
  const { setModels, resetModels } = await import("../../src/state/models.ts");
  setModels({providers:[{id:"draft-provider",baseUrl:"http://127.0.0.1:9/v1",hasApiKey:false,models:[{id:"draft-model"}]}],defaultProvider:"draft-provider",defaultModel:"draft-model",setupRequired:false,setupRemedy:""} as never);
  try {
    const { container } = render(SettingsRoom, {shell: makeShell()});
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const input = container.querySelector<HTMLInputElement>('[name="provider-base-url"]')!;
    await fireEvent.input(input, {target:{value:"http://127.0.0.1:9/keep-this-draft"}});
    (container.querySelector(".providers") as HTMLElement).scrollIntoView = vi.fn();
    const search = container.querySelector<HTMLInputElement>('[name="settings-search"]')!;
    await fireEvent.input(search, {target:{value:"Parallel tool calls"}});
    expect(container.querySelector<HTMLElement>('.provider-group')?.hidden).toBe(true);
    expect(container.querySelector('[name="provider-base-url"]')).toBe(input);
    await fireEvent.change(container.querySelector('.category-picker')!, {target:{value:"category:model-providers"}});
    await waitFor(() => expect(container.querySelector<HTMLElement>('.provider-group')?.hidden).toBe(false));
    expect(search.value).toBe("");
    expect(container.querySelector('[name="provider-base-url"]')).toBe(input);
    expect(input.value).toBe("http://127.0.0.1:9/keep-this-draft");
    expect((container.querySelector('.category-picker') as HTMLSelectElement).value).toBe("category:model-providers");
    await fireEvent.input(search, {target:{value:"Monitoring"}});
    expect((container.querySelector('.category-picker') as HTMLSelectElement).value).toBe("");
    await fireEvent.click(container.querySelector('[data-verb-id="settings.index/clear-search"]')!);
    expect((container.querySelector('.category-picker') as HTMLSelectElement).value).toBe("");
    await fireEvent.change(container.querySelector('.category-picker')!, {target:{value:"category:model-providers"}});
    expect((container.querySelector('.category-picker') as HTMLSelectElement).value).toBe("category:model-providers");
    expect(container.querySelector('[name="provider-base-url"]')).toBe(input);
  } finally { cleanup(); resetModels(); }
});
