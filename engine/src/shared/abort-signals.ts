import { guarded } from "../process/fault-policy.ts";

/** Canonical pure abort composition. Inputs retain their own lifetime and first abort reason. */
export function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  return combineSignalArray([a, b]);
}

/** Undefined and single-input identities are preserved; native composition owns listener cleanup. */
export function combineSignalArray(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

/** Await an observer without retaining abort listeners after either side settles. */
export async function awaitWithSignal<T>(operation: PromiseLike<T> | T, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await operation;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = guarded("abort.await", () => rejectAborted(signal.reason));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([aborted, operation]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Wait `ms`, or reject with the signal's own reason when it aborts first; no listener outlives the wait. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = guarded("abort.delay.abort", (): void => { clearTimeout(timer); reject(signal?.reason); });
    const timer = setTimeout(guarded("abort.delay.elapsed", () => { signal?.removeEventListener("abort", onAbort); resolve(); }), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type Deadline = Readonly<{
  /** The caller's signal combined with the deadline. */
  signal: AbortSignal;
  /** True once the deadline (not the caller) aborted. */
  expired: () => boolean;
  /** Stop the timer; call when the bounded work (a body read included) is over. */
  clear: () => void;
}>;

/**
 * THE ONE BOUNDED LIFETIME: the caller's cancellation plus a REQUIRED
 * timeout; `reason` becomes the abort reason when the timeout fires. Every
 * outbound exchange (the provider client, the MCP transports, the reference
 * transport, the drift classifier) and every hand-rolled
 * `AbortController + setTimeout + AbortSignal.any` it replaced use this.
 */
export function deadline(parent: AbortSignal | undefined, timeoutMs: number, reason?: () => unknown): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(guarded("abort.deadline", () => controller.abort(reason?.())), timeoutMs);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  return Object.freeze({ signal, expired: () => controller.signal.aborted, clear: () => clearTimeout(timer) });
}

/** A lifetime bounded by PROGRESS: {@link Deadline}, plus the calls that say work moved. */
export type ProgressDeadline = Deadline & Readonly<{
  /** `bytes` moved (out or in): they count toward the current window's floor. */
  progress: (bytes: number) => void;
  /** The far end answered (a response arrived): the current window moved, and a wait for the answer ends. */
  answered: () => void;
  /**
   * Everything is handed over, and only the far end's answer is left, which
   * no byte count here can observe (the kernel's buffers draining, the far
   * end's own processing). The floor stops, and the answer must come within
   * `silenceMs` (`silent` is the abort reason): a declared silence bound of
   * its own, never mistaken for the floor.
   */
  awaitingAnswer: (silenceMs: number, silent: () => unknown) => void;
}>;

/**
 * THE ONE PROGRESS-BOUNDED LIFETIME, for work whose size has no fair wall
 * cap (a transfer of a large file, on a host that may be loaded). Time is
 * cut into fixed windows of `windowMs`. A window passes when at least
 * `minBytes` moved in it, or the far end answered in it. The first window
 * that does neither ends the work (`stalled` is the abort reason). There
 * is NO total wall cap: slow work that keeps moving past the floor runs as
 * long as it needs, and only a drip under the floor, or silence, is ended.
 */
export function progressDeadline(
  parent: AbortSignal | undefined,
  bounds: Readonly<{ windowMs: number; minBytes: number }>,
  stalled: () => unknown,
): ProgressDeadline {
  const controller = new AbortController();
  let moved = 0;
  let replied = false;
  let timer: ReturnType<typeof setTimeout>;
  let awaiting: ReturnType<typeof setTimeout> | undefined;
  // Fixed windows, one plain timer each (every clock, a test's mocked one too, honours them).
  const judge = guarded("abort.progress", () => {
    if (moved < bounds.minBytes && !replied) { controller.abort(stalled()); return; }
    moved = 0;
    replied = false;
    timer = setTimeout(judge, bounds.windowMs);
  });
  timer = setTimeout(judge, bounds.windowMs);
  const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
  return Object.freeze({
    signal,
    expired: () => controller.signal.aborted,
    progress: (bytes: number) => { moved += bytes; },
    answered: () => {
      replied = true;
      if (awaiting === undefined) return;
      // The answer came: its silence bound ends, and the floor judges reading it.
      clearTimeout(awaiting);
      awaiting = undefined;
      moved = 0;
      timer = setTimeout(judge, bounds.windowMs);
    },
    awaitingAnswer: (silenceMs: number, silent: () => unknown) => {
      if (signal.aborted || awaiting !== undefined) return;
      clearTimeout(timer);
      awaiting = setTimeout(guarded("abort.answer", () => controller.abort(silent())), silenceMs);
    },
    clear: () => { clearTimeout(timer); if (awaiting !== undefined) clearTimeout(awaiting); },
  });
}
