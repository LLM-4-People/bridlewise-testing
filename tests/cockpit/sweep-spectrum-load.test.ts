// @vitest-environment node
/**
 * The full-history spectrum feed (§6.6) — `sweep.spectrum` through
 * `broker.read`, scope-following, with the honest fallback:
 *   - no chat/project/trace scope → NO read (this is also what keeps the mocked
 *     warm boot perfectly still for the one-reveal guard);
 *   - chat scope → read with the block's declared params;
 *   - trace scope (the run-pane trace filter) → read with scope=trace + the
 *     trace id — and its 404 absence lands in the fallback reason;
 *   - a failed read → null wire + a plain fallback reason (never fabricated
 *     bins);
 *   - a LYING payload (validated at the door by decodeSpectrumRead) → the
 *     fallback, loudly reasoned — it never reaches the render derivations.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// Only the two I/O doors are faked. `cacheKey` (which the feed uses to
// record the LENS stamp for the read it just made) keeps its REAL
// implementation on purpose: a stubbed key would let the stamp and the
// Broker's ledger disagree without any test noticing, which is exactly the
// drift the stamp exists to prevent.
vi.mock("../../src/data/broker.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/data/broker.ts")>()),
  read: vi.fn(),
  onInvalidation: vi.fn(() => () => {}),
}));

import { onInvalidation, read } from "../../src/data/broker.ts";
import { encodeSpectrumPacked, type SpectrumReadWire } from "../../src/cockpit/sweep/bin-source";
import {
  refreshSpectrum,
  resetSpectrumFeed,
  spectrumFallbackReason,
  spectrumWire,
  startSpectrumFeed,
} from "../../src/cockpit/sweep/spectrum-load";
import { currentChatId } from "../../src/state/chats";
import { resetProjects } from "../../src/state/projects";
import { timelineScope } from "../../src/state/timeline-query";

const readMock = vi.mocked(read);

function validWire(): SpectrumReadWire {
  return {
    header: {
      categories: ["tool"],
      errorRow: 1,
      errorRowIsOverlay: true,
      rows: 2,
      bins: 2,
      binMs: 1000,
      t0: 0,
      t1: 2000,
      events: 3,
      unbinnable: 0,
      attributedOnly: true,
      clamped: false,
    },
    packed: encodeSpectrumPacked([[2, 1]], [0, 0]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSpectrumFeed();
  timelineScope.set({ kind: "global", label: "All events", runIds: [] });
  currentChatId.set(null);
  // isolate:false — a project selected by ANOTHER test file in this worker
  // would otherwise give `currentParams()` a phantom project scope and
  // break the global-scope honesty assertions below.
  resetProjects();
});

describe("scope honesty — the feed reads only a real scope", () => {
  test("global scope: NO read is issued and the reason says so", async () => {
    await refreshSpectrum();
    expect(readMock).not.toHaveBeenCalled();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("no conversation or project scope");
  });

  test("chat scope reads sweep.spectrum with the declared params", async () => {
    readMock.mockResolvedValue(validWire());
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-9" });
    await refreshSpectrum();
    expect(readMock).toHaveBeenCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "chat", chatId: "chat-9" } }),
    );
    expect(spectrumWire.get()).not.toBeNull();
    expect(spectrumFallbackReason.get()).toBeNull();
  });

  test("a restored OPEN conversation scopes the read even before the timeline re-scopes", async () => {
    readMock.mockResolvedValue(validWire());
    currentChatId.set("restored-chat");
    await refreshSpectrum();
    expect(readMock).toHaveBeenCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "chat", chatId: "restored-chat" } }),
    );
  });

  test("project scope reads with projectId", async () => {
    readMock.mockResolvedValue(validWire());
    timelineScope.set({ kind: "project", label: "p", runIds: [], projectId: "proj-1" });
    await refreshSpectrum();
    expect(readMock).toHaveBeenCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "project", projectId: "proj-1" } }),
    );
  });

  test("trace scope reads with scope=trace + traceId (the run-pane filter's read)", async () => {
    readMock.mockResolvedValue(validWire());
    timelineScope.set({
      kind: "trace", label: "one request's trace", runIds: [], traceId: "t-7f9a",
    });
    await refreshSpectrum();
    expect(readMock).toHaveBeenCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "trace", traceId: "t-7f9a" } }),
    );
    expect(spectrumWire.get()).not.toBeNull();
    expect(spectrumFallbackReason.get()).toBeNull();
  });

  test("a trace scope's failed read is an honest fallback — the 404 absence of a foreign trace", async () => {
    readMock.mockRejectedValue(new Error("Trace t-foreign not found"));
    timelineScope.set({
      kind: "trace", label: "one request's trace", runIds: [], traceId: "t-foreign",
    });
    await refreshSpectrum();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("Trace t-foreign not found");
  });
});

describe("fallback honesty — absence is stated, never fabricated", () => {
  test("a failed read leaves the wire null with the failure as the reason", async () => {
    readMock.mockRejectedValue(new Error("boom 503"));
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-9" });
    await refreshSpectrum();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("boom 503");
  });

  test("MUTATION: a lying payload is refused at the door — the fallback stands", async () => {
    const lying = validWire();
    readMock.mockResolvedValue({
      ...lying,
      header: { ...lying.header, events: 999 }, // cells cannot support this
    });
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-9" });
    await refreshSpectrum();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("999");
  });
});

describe("the live feed follows the scope", () => {
  test("startSpectrumFeed fetches now, refetches on scope change, and stops cleanly", async () => {
    readMock.mockResolvedValue(validWire());
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-1" });
    const stop = startSpectrumFeed();
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(1);

    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-2" });
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(2);
    expect(readMock).toHaveBeenLastCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "chat", chatId: "chat-2" } }),
    );

    // The trace filter is a scope like any other: setting it refetches with
    // the trace params, and clearing it (back to the displaced chat) does
    // the same — the band never shows one scope's bins under another's.
    timelineScope.set({ kind: "trace", label: "one request's trace", runIds: [], traceId: "t-1" });
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(3);
    expect(readMock).toHaveBeenLastCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "trace", traceId: "t-1" } }),
    );
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-2" });
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(4);
    expect(readMock).toHaveBeenLastCalledWith(
      "sweep.spectrum",
      expect.objectContaining({ params: { scope: "chat", chatId: "chat-2" } }),
    );

    stop();
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-3" });
    await Promise.resolve();
    expect(readMock).toHaveBeenCalledTimes(4); // stopped — no further reads
  });

  test("the feed subscribes to the block's declared run:done invalidation", () => {
    timelineScope.set({ kind: "global", label: "All events", runIds: [] });
    const stop = startSpectrumFeed();
    expect(vi.mocked(onInvalidation)).toHaveBeenCalledWith("run:done", expect.any(Function));
    stop();
  });
});

/**
 * NEVER BLANK THE BAND FOR A HICCUP.
 *
 * Two things can go wrong with a spectrum read and they deserve OPPOSITE
 * answers, which is the whole reason this feed tracks the key its payload
 * came from:
 *
 *   - the QUESTION changed (another conversation, another project, no scope):
 *     the bins on screen answer something nobody is asking, so they go;
 *   - the SAME question failed to be re-answered: the bins on screen are the
 *     last true answer to the question still being asked, so they stay.
 *
 * Blanking in the second case is what made the band flash empty on a dropped
 * request — the "everything reloads" the user reported, at the sweep.
 */
describe("warm bins — a failed refresh keeps them; a changed scope clears them", () => {
  // MUTATION (required): clearing the wire on ANY failure must fail here.
  test("mutation — a failed refresh of the SAME scope keeps the bins and the stamp", async () => {
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-9" });
    readMock.mockResolvedValue(validWire());
    await refreshSpectrum();
    const held = spectrumWire.get();
    expect(held).not.toBeNull();
    expect(spectrumFallbackReason.get()).toBeNull();

    readMock.mockRejectedValueOnce(new Error("network down"));
    await refreshSpectrum(true);
    expect(spectrumWire.get()).toBe(held);
    // Still stamped: the pixels came from a real record, and that record now
    // also carries the Broker's `failed` entry for the attempt.
    expect(spectrumFallbackReason.get()).toBeNull();
  });

  test("a CHANGED scope clears them — those bins answer a question nobody asked", async () => {
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-9" });
    readMock.mockResolvedValue(validWire());
    await refreshSpectrum();
    expect(spectrumWire.get()).not.toBeNull();

    timelineScope.set({ kind: "global", label: "All events", runIds: [] });
    currentChatId.set(null);
    await refreshSpectrum();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("no conversation or project scope");
  });

  test("a scope whose FIRST read fails still falls back honestly — nothing was ever known", async () => {
    timelineScope.set({ kind: "chat", label: "c", runIds: [], chatId: "chat-cold" });
    readMock.mockRejectedValue(new Error("network down"));
    await refreshSpectrum();
    expect(spectrumWire.get()).toBeNull();
    expect(spectrumFallbackReason.get()).toContain("the full-history read failed");
  });
});
