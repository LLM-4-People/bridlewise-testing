/**
 * A served ui-schema + values snapshot for the settings suites (spec §9).
 *
 * Shaped exactly like the wire: customization-backed settings carrying their
 * served label/description/bounds, two signals (one identical-id linked, one
 * namespace-only), and the settings block's declared save action with the
 * server's own consequence sentence. Shared so the data, sheet, room and
 * lens suites all speak about the SAME served language.
 */
import type { UiSchema, UiSchemaValues } from "../../../shared/ui-schema.ts";

export const SCHEMA = {
  version: "bridlewise-ui-schema/v2",
  modules: [],
  menus: [],
  panels: [],
  widgets: [],
  settings: [
    {
      id: "tools.parallelCap",
      label: "Parallel tool calls",
      description: "How many tool calls may run at the same time before the rest queue.",
      type: "number",
      default: 4,
      min: 1,
      max: 16,
      unit: "calls",
      customizationId: "tools.parallelCap",
      module: "tools",
      // The DECLARED measurement linkage — a different id from the setting's,
      // which is the shape only `measuredBy` can express.
      measuredBy: "tools.activeCalls",
      effect: "immediate",
      order: 0,
    },
    {
      id: "context.compactStrategy",
      label: "Compaction strategy",
      description: "How the conversation folds itself down when it grows past the trim threshold.",
      type: "enum",
      default: "summarize",
      // `drop-oldest` is here ON PURPOSE: a hyphenated member is the shape
      // the real registry is full of (`round-robin`, `next-run`, `short-term`)
      // and the one where the token and the words visibly differ. A fixture of
      // single-word members would let a surface render the raw token and still
      // look correct.
      enum: ["summarize", "truncate", "drop-oldest"],
      customizationId: "context.compactStrategy",
      module: "context",
      order: 1,
    },
    {
      id: "editor.atomicWriteEnabled",
      label: "Atomic writes",
      description:
        "Write files through a temp-file swap so a crash can never leave a half-written file.",
      type: "boolean",
      default: true,
      customizationId: "editor.atomicWriteEnabled",
      // DELIBERATELY declared by no module below — the fixture exercises the
      // undeclared-category path as well as the declared one.
      module: "editor",
      order: 2,
    },
    // A FREE-FORM STRING row — the shape a credential-shaped value can be
    // pasted into (the masked-read-back class). Served words mirror the real
    // registry's watched-readings row.
    {
      id: "awareness.enabledSignals",
      label: "Only watch these readings",
      description:
        "A comma-separated list of reading names to watch. Leave empty to watch none of them.",
      type: "string",
      default: "search.queryCount,memory.entryCount,editor.editCount",
      customizationId: "awareness.enabledSignals",
      module: "awareness",
      effect: "immediate",
      order: 3,
    },
    // A UI-declared setting WITHOUT a customization id — not a served row.
    {
      id: "ui-only",
      label: "Ui only",
      description: "not registry-backed",
      type: "boolean",
      default: false,
      order: 4,
    },
  ],
  actions: [],
  signals: [
    {
      id: "editor.atomicWriteEnabled",
      module: "editor",
      name: "Atomic writes",
      description: "whether atomic writes are on",
      type: "boolean",
    },
    {
      id: "tools.activeCalls",
      module: "tools",
      name: "Active calls",
      description: "tool calls running now",
      type: "gauge",
    },
    // One of the real webPerformance ceilings, verbatim from the
    // registration — the signal that makes the readings-only class
    // derivable (its module's readings render in the instruments room).
    // The fixture-freshness arm in settings-data.test.ts binds this
    // member and the module declaration below byte-equal to the served
    // registration, so a registration-side edit cannot leave the room
    // suites green against a silently-rotted wire.
    {
      id: "webPerformance.typingMeanMaxMs",
      module: "webPerformance",
      name: "Mean typing latency allowed per key",
      description:
        "Averaged over the keystrokes the profile types, one key must settle within this many milliseconds — the settle includes the rendered frame the user waits for. Shown read-only: this ceiling is the performance gate's own verdict budget — the profile compares the measured mean against it, and a settings write that loosened it would silently weaken what the gate's green means.",
      type: "gauge",
      unit: "ms",
    },
  ],
  // The module DECLARATIONS — the category vocabulary, exactly as the server
  // forwards it from the registry. "editor" is deliberately absent so the
  // honest-fallback path is exercised by the same fixture.
  exposureModules: [
    {
      id: "tools",
      title: "Running tools",
      purpose: "How many tool calls may run at once and how long each one may take.",
    },
    {
      id: "context",
      title: "What the model is told",
      purpose: "How much of the conversation travels with each message, what is dropped first, and what is always kept.",
    },
    {
      id: "memory",
      title: "What the assistant remembers",
      purpose: "How much the assistant keeps at hand while it works, when older material starts being dropped, and where a new memory is filed.",
    },
    {
      id: "awareness",
      title: "Watching the system itself",
      purpose:
        "How closely the system watches its own live readings, how often it refreshes them, and how much of that it reports back to you.",
    },
    // THE READINGS-ONLY CLASS — the real registry's `webPerformance` shape:
    // a declared module whose settings side is signals only, no
    // customizations. In the settings room it renders as the greyed
    // "nothing to adjust" rail tile; the fixture carries it so every suite
    // speaks about a wire that serves the class, with `memory` remaining
    // the no-signals empty case beside it.
    {
      id: "webPerformance",
      title: "How fast the web app must stay",
      purpose:
        "The speed ceilings the profiled web app is held to: how fast pages, screens, typing and long sessions must stay before the performance gate calls it a regression.",
    },
  ],
  blockActions: {
    "settings.customizations": [
      {
        name: "set",
        title: "Save",
        consequence:
          "Saves the new value for this setting; it is checked against the setting's declared bounds first, and once saved it applies to everyone using this install. When the change starts mattering is the setting's own declared timing (immediately, on the next run, or after a restart) — not always immediately.",
        invalidates: ["settings:changed"],
      },
    ],
  },
} as unknown as UiSchema;

export const VALUES = {
  signals: [
    { id: "editor.atomicWriteEnabled", value: true },
    { id: "tools.activeCalls", value: 2 },
  ],
  customizations: [
    { id: "tools.parallelCap", value: 4 },
    { id: "context.compactStrategy", value: "summarize" },
    { id: "editor.atomicWriteEnabled", value: true },
    { id: "awareness.enabledSignals", value: "search.queryCount,memory.entryCount,editor.editCount" },
  ],
} as unknown as UiSchemaValues;
