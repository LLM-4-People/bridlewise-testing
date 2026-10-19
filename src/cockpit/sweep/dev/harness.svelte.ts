/**
 * SWEEP dev harness — SYNTHETIC DATA ONLY, clearly labeled on the page.
 *
 * Exercises the band in a real browser: live ticking (events on a timer →
 * `ingestLiveSweepEvent`, the same path a real stream uses), reconnect /
 * closed states, error bursts, a 30k-event history load (the perf-budget
 * shape), semantic zoom, the head, marks, ARM, and a CausalRibbon demo over
 * a fake flow gutter. Dev-only: not linked from any product surface.
 */
import { mount } from "svelte";

import Sweep from "../Sweep.svelte";
import CausalRibbon from "../CausalRibbon.svelte";
import { ingestLiveSweepEvent, resetLiveSweepBuffer } from "../sweep-data";
import { setStreamStatus, resetSweep } from "../sweep-store";
import { toSweepEvent, type SweepSourceRecord } from "../categories";
import type { FocusBeatDetail } from "../focus-seam";
import type { SweepEvent } from "../types";
import "../../tokens.css";

// ── Synthetic ledger generator (labeled; parentage is realistic) ──

let seq = 0;
let runSeq = 0;
let currentRunId: string | null = null;
let currentTurnId: string | null = null;
let lastToolEventId: string | null = null;
let eventsInTurn = 0;

const TOOL_TYPES = ["tool", "tool-input", "tool-output"] as const;

function synthRecord(timeMs: number): SweepSourceRecord {
  seq += 1;
  // Start a new run every ~40 events; a new turn every ~12.
  if (currentRunId === null || seq % 40 === 0) {
    runSeq += 1;
    currentRunId = `synth-run-${runSeq}`;
    currentTurnId = null;
    return {
      eventId: `synth-${seq}`,
      eventType: "run",
      wallTime: new Date(timeMs).toISOString(),
      outcome: null,
      runId: currentRunId,
      turnId: null,
      parentEventId: null,
      description: `SYNTHETIC run ${runSeq} started`,
    };
  }
  if (currentTurnId === null || eventsInTurn > 12) {
    currentTurnId = `synth-turn-${seq}`;
    eventsInTurn = 0;
    return {
      eventId: `synth-${seq}`,
      eventType: seq % 2 === 0 ? "turn" : "message",
      wallTime: new Date(timeMs).toISOString(),
      outcome: null,
      runId: currentRunId,
      turnId: currentTurnId,
      parentEventId: null,
      description: "SYNTHETIC turn",
    };
  }
  eventsInTurn += 1;
  const roll = seq % 11;
  const eventType =
    roll < 4 ? TOOL_TYPES[seq % 3]!
    : roll < 6 ? "file-effect"
    : roll < 8 ? "token"
    : roll === 8 ? "context"
    : roll === 9 ? "quality"
    : "cost";
  const failed = seq % 23 === 0;
  const rec: SweepSourceRecord = {
    eventId: `synth-${seq}`,
    eventType,
    wallTime: new Date(timeMs).toISOString(),
    outcome: failed ? "failed" : "succeeded",
    runId: currentRunId,
    turnId: currentTurnId,
    parentEventId: eventType === "file-effect" ? lastToolEventId : null,
    description: `SYNTHETIC ${eventType}${failed ? " (failed)" : ""} src/lib/data/reader.ts`,
  };
  if (eventType === "tool") lastToolEventId = rec.eventId;
  return rec;
}

// ── Harness state ──

const state = $state({
  events: [] as SweepEvent[],
  headLog: "—",
  focusLog: "—",
  running: false,
  count: 0,
});

let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const rec = synthRecord(Date.now());
  const e = ingestLiveSweepEvent(rec);
  if (e !== null) {
    state.events = [...state.events, e];
    state.count = state.events.length;
  }
}

function start(): void {
  if (timer !== null) return;
  state.running = true;
  timer = setInterval(tick, 600);
}

function pauseReconnecting(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  state.running = false;
  setStreamStatus("reconnecting");
}

function closeStream(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  state.running = false;
  setStreamStatus("closed");
}

function burstErrors(): void {
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    const rec = synthRecord(now + i * 40);
    const failing: SweepSourceRecord = { ...rec, outcome: "failed", eventType: i % 2 === 0 ? "test" : rec.eventType };
    const e = ingestLiveSweepEvent(failing);
    if (e !== null) state.events = [...state.events, e];
  }
  state.count = state.events.length;
}

/** 30k synthetic history spanning 6h — the perf-budget shape (rebin <100ms). */
function load30k(): void {
  const t1 = Date.now();
  const t0 = t1 - 6 * 3600_000;
  const out: SweepEvent[] = [];
  for (let i = 0; i < 30_000; i++) {
    // Cluster into bursts with real gaps between them (gaps must render).
    const burst = Math.floor(i / 300);
    const at = t0 + burst * 60_000 + (i % 300) * 90;
    const e = toSweepEvent(synthRecord(at));
    if (e !== null) out.push(e);
  }
  state.events = [...out, ...state.events];
  state.count = state.events.length;
}

function resetAll(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  state.running = false;
  state.events = [];
  state.count = 0;
  resetLiveSweepBuffer();
  resetSweep();
}

// ── Page scaffold (plain DOM — dev-only chrome, not a product surface) ──

const found = document.querySelector("#harness");
const root: HTMLElement = found instanceof HTMLElement ? found : document.body;
root.className = "cockpit";
root.innerHTML = `
  <div style="max-width:1100px;margin:24px auto;font-family:var(--face-sans);color:var(--ink-1)">
    <h1 style="font-size:15px">SWEEP dev harness — <span style="color:var(--warn)">SYNTHETIC DATA</span></h1>
    <p style="color:var(--ink-3);font-size:12px">
      band interactions: hover = ruler · click = plant head · click now edge / Esc = live ·
      wheel = zoom (shift = pan, drag = pan) · [ ] scrub · m mark · a arm menu · Enter = focus beat
    </p>
    <div id="controls" style="display:flex;gap:8px;margin:12px 0"></div>
    <div id="sweep-slot" style="position:relative"></div>
    <p id="emit-log" style="font-family:var(--face-mono);font-size:12px;color:var(--ink-2)"></p>
    <h2 style="font-size:13px;margin-top:24px">CausalRibbon demo (synthetic chain over a fake gutter)</h2>
    <div id="ribbon-slot" style="position:relative;height:220px;background:var(--ground-1);border:1px solid var(--line-1)"></div>
  </div>`;

const controls = root.querySelector("#controls") as HTMLElement;
const mkBtn = (label: string, fn: () => void): void => {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "font-size:12px;padding:2px 10px;background:var(--ground-2);color:var(--ink-1);border:1px solid var(--line-2);border-radius:2px;cursor:pointer";
  b.addEventListener("click", fn);
  controls.appendChild(b);
};
mkBtn("start stream", start);
mkBtn("pause → reconnecting", pauseReconnecting);
mkBtn("close stream", closeStream);
mkBtn("burst 12 errors", burstErrors);
mkBtn("load 30k history", load30k);
mkBtn("reset", resetAll);

const emitLog = root.querySelector("#emit-log") as HTMLElement;

const sweepSlot = root.querySelector("#sweep-slot") as HTMLElement;
mount(Sweep, {
  target: sweepSlot,
  props: {
    get events() {
      return state.events;
    },
    onHeadChange: (asOf: number | null) => {
      state.headLog = asOf === null ? "live" : new Date(asOf).toISOString();
      renderLog();
    },
    onFocusBeat: (detail: FocusBeatDetail) => {
      state.focusLog =
        `${detail.via}${detail.preview ? " (preview)" : ""} · ` +
        `${new Date(detail.timeMs).toISOString()} · ` +
        `${detail.eventId ?? "no event id at or before this instant"}`;
      renderLog();
    },
  },
});

function renderLog(): void {
  emitLog.textContent =
    `events out — headChange: ${state.headLog} · focusBeat: ${state.focusLog} · events on band: ${state.count}`;
}
renderLog();
setInterval(renderLog, 1000);

// ── Ribbon demo: a synthetic recorded chain over fixed gutter anchors ──

const chainRecords: SweepSourceRecord[] = [
  { eventId: "rb-run", eventType: "run", wallTime: new Date().toISOString(), outcome: null, runId: "rb", turnId: null, parentEventId: null, description: "SYNTHETIC run" },
  { eventId: "rb-turn", eventType: "turn", wallTime: new Date().toISOString(), outcome: null, runId: "rb", turnId: "t1", parentEventId: "rb-run", description: "SYNTHETIC turn" },
  { eventId: "rb-tool", eventType: "tool", wallTime: new Date().toISOString(), outcome: "succeeded", runId: "rb", turnId: "t1", parentEventId: "rb-turn", description: "SYNTHETIC tool" },
  { eventId: "rb-effect", eventType: "file-effect", wallTime: new Date().toISOString(), outcome: "succeeded", runId: "rb", turnId: "t1", parentEventId: "rb-tool", description: "SYNTHETIC effect" },
];
const chainEvents = chainRecords
  .map(toSweepEvent)
  .filter((e): e is SweepEvent => e !== null);

const anchors: Record<string, { x: number; y: number }> = {
  "rb-run": { x: 40, y: 30 },
  "rb-turn": { x: 40, y: 80 },
  "rb-tool": { x: 120, y: 130 },
  "rb-effect": { x: 120, y: 185 },
};

const ribbonSlot = root.querySelector("#ribbon-slot") as HTMLElement;
for (const [id, p] of Object.entries(anchors)) {
  const dot = document.createElement("div");
  dot.style.cssText =
    `position:absolute;left:${p.x - 4}px;top:${p.y - 4}px;width:8px;height:8px;` +
    "background:var(--ground-3);border:1px solid var(--line-2);border-radius:0";
  dot.title = id;
  ribbonSlot.appendChild(dot);
  const label = document.createElement("span");
  label.textContent = id;
  label.style.cssText =
    `position:absolute;left:${p.x + 10}px;top:${p.y - 8}px;font-family:var(--face-mono);` +
    "font-size:11px;color:var(--ink-3)";
  ribbonSlot.appendChild(label);
}
mount(CausalRibbon, {
  target: ribbonSlot,
  props: {
    focusedEventId: "rb-effect",
    events: chainEvents,
    place: (id: string) => anchors[id] ?? null,
    width: 400,
    height: 220,
  },
});
