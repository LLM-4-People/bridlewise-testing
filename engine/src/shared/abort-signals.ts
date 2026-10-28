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

/** A lifetime bounded by PROGRESS: {@link Deadline}, plus the call that says work moved. */
export type ProgressDeadline = Deadline & Readonly<{
  /** Work moved (bytes went out or came in): the stall bound starts over. */
  progress: () => void;
}>;

/**
 * THE ONE PROGRESS-BOUNDED LIFETIME, for work whose size has no fair wall
 * cap (a transfer of a large file, on a host that may be loaded). It ends
 * when NOTHING MOVES for `stallMs` (`stalled` is the abort reason), or at
 * `hangBackstopMs` (`hung`), the one wall bound left. That bound is very
 * large and ends a hang, never slow work. Slow work that keeps moving is
 * never cut. Built on {@link deadline}, which is the backstop.
 */
export function progressDeadline(
  parent: AbortSignal | undefined,
  bounds: Readonly<{ stallMs: number; hangBackstopMs: number }>,
  reasons: Readonly<{ stalled: () => unknown; hung: () => unknown }>,
): ProgressDeadline {
  const backstop = deadline(parent, bounds.hangBackstopMs, reasons.hung);
  const stall = new AbortController();
  const stalled = guarded("abort.stall", () => stall.abort(reasons.stalled()));
  // Re-armed, not `refresh()`ed: one plain timer per arming, which every clock (a test's mocked one too) honours.
  let timer = setTimeout(stalled, bounds.stallMs);
  const signal = AbortSignal.any([backstop.signal, stall.signal]);
  return Object.freeze({
    signal,
    expired: () => backstop.expired() || stall.signal.aborted,
    progress: () => { if (signal.aborted) return; clearTimeout(timer); timer = setTimeout(stalled, bounds.stallMs); },
    clear: () => { clearTimeout(timer); backstop.clear(); },
  });
}
