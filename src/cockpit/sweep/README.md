# Sweep

The sweep: the flight recorder — one canvas band of time-binned event density, with causal ribbon, marks, and the focus seam that navigates the flow.

## What each file does

- `arm-fire.ts` — ARM FIRING — the vocabulary context, the grammar evaluation, and what a firing does (finding, verbs, labels).
- `arm-palette.ts` — ARM PALETTE — the derived vocabulary groups, operators, and ready row templates the record accepts.
- `arm-sync.ts` — ARM ↔ ledger wiring — the arm menu body's set/capture/clear.
- `band-request.ts` — A PLACE ON THE BAND, ASKED FOR FROM OUTSIDE THE SWEEP — the capture row's one-shot way back.
- `band-scope.ts` — WHAT YOU ARE LOOKING AT — the band's own sentence.
- `bin-source.ts` — The bin-source seam — the one interface the painter consumes.
- `bins.ts` — Time binning — pure functions turning recorded events into bins.
- `categories.ts` — Sweep categories — the event→category mapping.
- `causal.ts` — Causal structure from the recorded window.
- `focus-seam.ts` — THE FOCUS SEAM — how the SWEEP navigates the FLOW.
- `marks.ts` — Marks + ARM triggers.
- `now-edge.ts` — The now edge + band status — the honesty core of the flight recorder.
- `painter.ts` — The sweep canvas painter — one canvas, every zoom level.
- `ribbon.ts` — Causal ribbon path — pure functions.
- `spectrum-load.ts` — The full-history spectrum feed.
- `sweep-data.ts` — Sweep data adapter — maps the streamed window.
- `sweep-store.ts` — SWEEP shared state — nanostores, plain .ts.
- `types.ts` — SWEEP core types — the flight recorder's data vocabulary.
- `zoom.ts` — Semantic zoom mapping — pure time↔pixel math.
- `ArmMenu.svelte` — ARM menu, standalone host — the raised Popover over the band.
- `ArmMenuBody.svelte` — ARM menu body — the arm grammar, host-free (Popover or right-menu column).
- `CausalRibbon.svelte` — Causal ribbon — the SVG spine-path highlight.
- `Sweep.svelte` — THE SWEEP — flight recorder v1.
- `SweepHead.svelte` — THE HEAD — the band's readout.

The sweep's dev harness lives one level down:

- `dev/` — the synthetic sweep harness.

## Where it lives

The folder lives at `src/cockpit/sweep/`.
