# Flow

The cockpit flow: the full-bleed causal block stream — beats, seams, and the run's live data projected as a stream the reader navigates, not a log they scroll.

Run ownership lasts until an actual transport ending. Output finishing can mark the band ending while the EventSource remains parkable through tool gaps and the epilogue. Run starts capture their workspace before awaiting the server; a late response or older terminal cannot overwrite the foreground band or wait state. The client stream owner scopes screen writes and callbacks, while session-wide inspector history retains its original scope.

Per-turn clocks retain their first ending. The stream's replay projection identifies retained model frames, so receipt activity still reaches Sweep while clocks measure only newly produced output. Missing starts remain unmeasured through subsequent deltas; history supplies the saved timing independently of when replay arrives.

## What each file does

- `beat-request.ts` — A BEAT, ASKED FOR FROM OUTSIDE THE FLOW — the one-shot seam the right menu's row paths travel through.
- `beat-state.ts` — COCKPIT FLOW — the beat state vocabulary (one owner).
- `composer-router.ts` — COCKPIT FLOW — composer submission routing.
- `dock.ts` — COCKPIT FLOW — docking findings into the stream.
- `effect-findings.ts` — COCKPIT FLOW — effect-seam findings.
- `elapsed-clock.ts` — THE ELAPSED CLOCK — one timer for wait-row and live tool duration.
- `fisheye.ts` — COCKPIT FLOW — causal fisheye.
- `flow-config.ts` — FLOW (the multi-workspace memory budget).
- `flow-view.ts` — PER-WORKSPACE FLOW VIEW — where each tab was reading.
- `grouping.ts` — COCKPIT FLOW — consecutive tool calls read as one act.
- `heights.ts` — COCKPIT FLOW — the height index.
- `ingest.ts` — COCKPIT FLOW — ingestion: the surviving data layer into the stream.
- `log.ts` — COCKPIT FLOW — the beat log.
- `rewind.ts` — REWIND — the cockpit's one owner for retry / edit & resend.
- `run-ownership.ts` — WHICH WORKSPACE A LIVE RUN BELONGS TO.
- `run-stream.ts` — COCKPIT run stream — one stream, two consumers.
- `thinking-fold.ts` — THE THINKING BLOCK'S OPEN/CLOSED STATE — one owner.
- `turn-timing.ts` — WHEN THE MODEL'S OUTPUT ACTUALLY BEGAN — observed, per model.
- `types.ts` — COCKPIT FLOW — beat model.
- `verbs.ts` — COCKPIT FLOW — verb wiring (no verb, no pixels).
- `wait-stage.ts` — THE WAIT — what is actually known between "send" and the answer.
- `ActBeat.svelte` — An operator intervention, rendered.
- `Bead.svelte` — The BEAD — a beam-colored pulse that travels the rail.
- `Beat.svelte` — The uniform beat anatomy.
- `BeatDepth.svelte` — THE INLINE DEPTH.
- `BeatScope.svelte` — THE SCOPE SHEET for a beat.
- `CheckDeltaBeat.svelte` — A check's state change, rendered.
- `DeskLine.svelte` — The desk-line content — what the FLOW docks into.
- `EffectBeat.svelte` — An effect beat: a file changed.
- `EventBeat.svelte` — An inline event beat: kind glyph + plain sentence.
- `Flow.svelte` — THE FLOW — full-bleed causal block stream.
- `PathChip.svelte` — FILE PATH IS A DOOR, NOT DEAD TEXT.
- `RunPane.svelte` — THE RUN PANE — the conversation's right-side inspector.
- `Seam.svelte` — The turn seam — a full-bleed hairline.
- `StreamPulse.svelte` — THE RAIL — one instrument for the whole of "waiting".
- `ThinkingFold.svelte` — THE THINKING BLOCK — open while the model thinks.
- `ToolBeat.svelte` — A tool beat — live elapsed, rail, tokens while in flight.
- `TurnBeat.svelte` — BUBBLE — the web-native shape for a message.
- `Verb.svelte` — The only way an interactive control renders.
- `WaitLine.svelte` — THE WAIT ROW — the element between pressing send and the answer.

The flow's dev harness lives one level down:

- `dev/` — the synthetic flow harness.

## Where it lives

The folder lives at `src/cockpit/flow/`.
