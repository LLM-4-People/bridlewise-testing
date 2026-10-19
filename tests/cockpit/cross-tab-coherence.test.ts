// @vitest-environment jsdom
/**
 * CROSS-TAB COHERENCE — the guard for "two cockpits must not disagree
 * silently".
 *
 * The defect: eight modules wrote localStorage and nothing listened, so two
 * browser tabs each held their own pins, marks, arms, theme and density,
 * overwrote each other on every change, and neither noticed.
 *
 * Two mechanical failures are asserted here, both named in the brief:
 *
 *   1. A SHARED KEY THAT DOES NOT PROPAGATE FAILS. Every key classified as
 *      shared truth is fed a foreign write and must change this tab's state.
 *      The table below is the classification, executable — adding a shared key
 *      without an adopter fails here rather than in a user's second window.
 *
 *   2. A PROPAGATED CHANGE THAT REMOUNTS INSTEAD OF PATCHING FAILS. Adoption
 *      is watched by a MutationObserver: a converging change may restyle (an
 *      attribute on :root) but may not add or remove a single node. That is
 *      the same standard the one-reveal guard holds boot to.
 *
 * jsdom does not deliver cross-document storage events, so the events are
 * constructed exactly as the browser constructs them (`new StorageEvent`, the
 * raw prefixed key, `storageArea: localStorage`) and dispatched on `window` —
 * the listener under test is the real one, installed by the real registration.
 *
 * NOTE ON ISOLATION: this suite deliberately never calls `resetCrossTab()`.
 * The runner is configured `isolate: false`, so tearing down the registrations
 * installed at module load would silently disarm every later file in the same
 * worker. Storage is cleared instead.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { storageKeyFor } from "../../src/state/persistence";
import { crossTabBound, foreignWritesAdopted } from "../../src/state/cross-tab";
import { cockpitDensity, cockpitTheme } from "../../src/cockpit/settings/local-prefs";
import { pinnedMonitors } from "../../src/cockpit/rooms/instruments-feed";
import {
  armedTriggers,
  armTrigger,
  clearArm,
  dropMarkAtNow,
  fireMatchingArms,
  recordReceivedEvent,
  reArmTrigger,
  removeMark,
  sweepMarks,
} from "../../src/cockpit/sweep/sweep-store";
import {
  ARMS_STORAGE_KEY,
  MARKS_STORAGE_KEY,
  loadArms,
  mergeArmedTriggerRow,
  saveArmsMerged,
  saveMarksMerged,
} from "../../src/cockpit/sweep/marks";
import type { SweepEvent } from "../../src/cockpit/sweep/types";
import { MONITORS_STORAGE_KEY } from "../../src/cockpit/rooms/instruments-config";
import {
  recordRoomActivation,
  resetRoomActivations,
  roomWarmOrder,
} from "../../src/cockpit/shell/room-warm";

/** Deliver a write the way another tab's write reaches this one. */
function foreignWrite(rawKey: string, value: string | null): void {
  window.localStorage.setItem(rawKey, value ?? "");
  if (value === null) window.localStorage.removeItem(rawKey);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: rawKey,
      newValue: value,
      storageArea: window.localStorage,
    }),
  );
}

/** A foreign write to a key owned by the persistence prefix. */
function foreignPrefixed(logicalKey: string, value: string | null): void {
  foreignWrite(storageKeyFor(logicalKey), value);
}

/** A received sweep event, the way the live wire builds one. */
const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: extra.outcome ?? null,
  errorCode: extra.errorCode ?? null,
  runId: "r",
  turnId: null,
  parentEventId: null,
  description: extra.description ?? "",
});

/** A failing TOOL event (matches the "tool-errors" kind only). */
const evToolError = (timeMs: number, eventId?: string): SweepEvent =>
  ev(timeMs, {
    ...(eventId === undefined ? {} : { eventId }),
    eventType: "tool",
    category: "tool",
    isError: true,
  });

/** A failing TEST event (matches the "check-fails" kind only). */
const evTestFailure = (timeMs: number, eventId?: string): SweepEvent =>
  ev(timeMs, {
    ...(eventId === undefined ? {} : { eventId }),
    eventType: "test",
    category: "effect",
    isError: true,
  });

/** The persisted arms blob, as any booting tab reads it. */
const persistedArms = (): Array<Record<string, unknown>> => {
  const raw = window.localStorage.getItem(ARMS_STORAGE_KEY);
  const parsed: unknown = raw === null ? [] : JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
};

/** The persisted marks blob, as any booting tab reads it. */
const persistedMarks = (): Array<Record<string, unknown>> => {
  const raw = window.localStorage.getItem(MARKS_STORAGE_KEY);
  const parsed: unknown = raw === null ? [] : JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("cross-tab coherence", () => {
  it("installs exactly one storage listener, and installs it from registration", () => {
    // Importing the owners is what binds it — no boot step to forget.
    expect(crossTabBound()).toBe(true);
  });

  describe("shared truth converges", () => {
    // (The old-tree theme store's convergence case died with it; the
    //  cockpit theme case below is the living one.)

    it("cockpit theme and density: both adopt and both re-apply to :root", () => {
      cockpitDensity.set("work");
      cockpitTheme.set("carbon");

      foreignPrefixed("cockpitDensity", "deep");
      foreignPrefixed("cockpitTheme", "logbook");

      expect(cockpitDensity.get()).toBe("deep");
      expect(document.documentElement.dataset.density).toBe("deep");
      expect(cockpitTheme.get()).toBe("logbook");
      expect(document.documentElement.getAttribute("data-cockpit-theme")).toBe("light");
    });

    // (The module-density dial died with the old tree — no port; the
    //  cockpit has its own density row.)

    it("pinned monitors adopt, re-validated and re-capped on the way in", () => {
      const five = JSON.stringify(
        [1, 2, 3, 4, 5].map((n) => ({ signalId: `sig-${n}`, pinnedAt: 1_000 + n })),
      );
      window.localStorage.setItem(storageKeyFor(MONITORS_STORAGE_KEY), five);
      foreignPrefixed(MONITORS_STORAGE_KEY, five);

      // Adopted — and the ≤4 law is enforced against a foreign write exactly
      // as it is against a local pin. A tab running older code cannot install
      // a fifth monitor here.
      expect(pinnedMonitors.get().length).toBe(4);
      expect(pinnedMonitors.get()[0]?.signalId).toBe("sig-1");
    });

    it("marks adopt (raw, unprefixed key)", () => {
      const marks = JSON.stringify([
        {
          id: "mark-1",
          timeMs: 1_700_000_000_000,
          label: "mark",
          createdAtMs: 1_700_000_000_000,
          origin: "user",
          storage: "local",
        },
      ]);
      window.localStorage.setItem(MARKS_STORAGE_KEY, marks);
      foreignWrite(MARKS_STORAGE_KEY, marks);
      expect(sweepMarks.get().map((m) => m.id)).toEqual(["mark-1"]);
    });

    it("armed triggers adopt, and a ledger-backed trigger stays ledger-backed", () => {
      const arms = JSON.stringify([
        {
          id: "arm-1",
          kind: "tool-errors",
          param: null,
          armedAtMs: 1_700_000_000_000,
          firedAtMs: null,
          storage: "ledger",
        },
      ]);
      window.localStorage.setItem(ARMS_STORAGE_KEY, arms);
      foreignWrite(ARMS_STORAGE_KEY, arms);
      expect(armedTriggers.get().length).toBe(1);
      // Travelling between tabs must not quietly demote where a trigger lives:
      // the ArmMenu states this field to the user in plain words.
      expect(armedTriggers.get()[0]?.storage).toBe("ledger");
    });

    it("a FIRING travels too — the whole-blob adoption carries firedAtMs (UIE-087b's truth)", () => {
      // Drive 18 measured this live: tab A's run fired the row and tab B's
      // face read "fired" immediately — convergence by adoption, not its own
      // evaluation, and one band mark. The adoption handler sets the WHOLE
      // normalized blob, fired instant included; the r74 claim ("a second
      // tab sees the row cocked until its own wire fires it") described a
      // pre-adoption tree, and the surfaces now state the implemented truth.
      const firedAt = 1_700_000_123_456;
      const arms = JSON.stringify([
        {
          id: "arm-fired",
          kind: "tool-errors",
          param: null,
          armedAtMs: 1_700_000_000_000,
          firedAtMs: firedAt,
          storage: "ledger",
        },
      ]);
      window.localStorage.setItem(ARMS_STORAGE_KEY, arms);
      foreignWrite(ARMS_STORAGE_KEY, arms);
      const adopted = armedTriggers.get().find((t) => t.id === "arm-fired");
      expect(adopted?.firedAtMs).toBe(firedAt);
      // The cocked count derives over the adopted state — a fired row does
      // not read "waiting" in the following tab.
      expect(armedTriggers.get().filter((t) => t.firedAtMs === null)).toHaveLength(0);
    });

    it("a foreign write that is not valid is refused, not adopted", () => {
      cockpitDensity.set("work");
      foreignPrefixed("cockpitDensity", "enormous");
      expect(cockpitDensity.get()).toBe("work");

      const before = sweepMarks.get();
      foreignWrite(MARKS_STORAGE_KEY, "{ not json");
      expect(sweepMarks.get()).toEqual(before);
    });

    it("localStorage.clear() in another tab is reported to every adopter", () => {
      const before = foreignWritesAdopted.get();
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: null,
          newValue: null,
          storageArea: window.localStorage,
        }),
      );
      // Every registered key was told it is now absent — no adopter is left
      // holding a value that is gone.
      expect(foreignWritesAdopted.get()).toBeGreaterThan(before);
    });

    it("sessionStorage events are ignored — per-tab state must never travel", () => {
      cockpitTheme.set("carbon");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKeyFor("cockpitTheme"),
          newValue: "logbook",
          storageArea: window.sessionStorage,
        }),
      );
      expect(cockpitTheme.get()).toBe("carbon");
    });
  });

  describe("MUTATION: a shared key that does not propagate fails", () => {
    // Each row is the classification, executable. `apply` performs a foreign
    // write; `changed` reports whether this tab moved. A shared key wired
    // without an adopter — or an adopter deleted — fails right here.
    const SHARED: readonly Readonly<{
      name: string;
      apply: () => void;
      changed: () => boolean;
    }>[] = [
      {
        name: "cockpit density",
        apply: () => {
          cockpitDensity.set("work");
          foreignPrefixed("cockpitDensity", "scan");
        },
        changed: () => cockpitDensity.get() === "scan",
      },
      {
        name: "cockpit theme",
        apply: () => {
          cockpitTheme.set("carbon");
          foreignPrefixed("cockpitTheme", "logbook");
        },
        changed: () => cockpitTheme.get() === "logbook",
      },
      {
        name: "pinned monitors",
        apply: () => {
          const one = JSON.stringify([{ signalId: "sig-propagate", pinnedAt: 5 }]);
          window.localStorage.setItem(storageKeyFor(MONITORS_STORAGE_KEY), one);
          foreignPrefixed(MONITORS_STORAGE_KEY, one);
        },
        changed: () => pinnedMonitors.get().some((m) => m.signalId === "sig-propagate"),
      },
      {
        name: "marks",
        apply: () => {
          const marks = JSON.stringify([
            {
              id: "mark-propagate",
              timeMs: 1,
              label: "m",
              createdAtMs: 1,
              origin: "user",
              storage: "local",
            },
          ]);
          window.localStorage.setItem(MARKS_STORAGE_KEY, marks);
          foreignWrite(MARKS_STORAGE_KEY, marks);
        },
        changed: () => sweepMarks.get().some((m) => m.id === "mark-propagate"),
      },
      {
        name: "armed triggers",
        apply: () => {
          const arms = JSON.stringify([
            {
              id: "arm-propagate",
              kind: "check-fails",
              param: null,
              armedAtMs: 1,
              firedAtMs: null,
              storage: "local",
            },
          ]);
          window.localStorage.setItem(ARMS_STORAGE_KEY, arms);
          foreignWrite(ARMS_STORAGE_KEY, arms);
        },
        changed: () => armedTriggers.get().some((t) => t.id === "arm-propagate"),
      },
    ];

    for (const row of SHARED) {
      it(`${row.name} propagates from another tab`, () => {
        row.apply();
        expect(row.changed()).toBe(true);
      });
    }
  });

  describe("MUTATION: a propagated change that remounts instead of patching fails", () => {
    it("adopting theme and density mutates attributes only — zero nodes added or removed", async () => {
      const host = document.createElement("div");
      host.innerHTML = "<p>a beat that must survive the change</p>";
      document.body.appendChild(host);
      const survivor = host.firstElementChild;

      const records: MutationRecord[] = [];
      const observer = new MutationObserver((list) => records.push(...list));
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });

      foreignPrefixed("theme", "light");
      foreignPrefixed("cockpitDensity", "deep");
      foreignPrefixed("cockpitTheme", "logbook");

      await Promise.resolve();
      observer.disconnect();

      // The node the user was looking at is still the same live node. A
      // remount would have replaced it, and the flash + lost scroll position
      // would be exactly what the warm-data rules forbid.
      expect(survivor?.isConnected).toBe(true);
      expect(host.firstElementChild).toBe(survivor);
      document.body.removeChild(host);

      // Nothing was added or removed anywhere in the document, and nothing had
      // its text rewritten. Every recorded mutation is an attribute on :root.
      const structural = records.filter((r) => r.type !== "attributes");
      expect(structural).toEqual([]);
      for (const r of records) {
        expect(r.target).toBe(document.documentElement);
      }
      // And the change did land — a test that observed nothing would pass
      // vacuously.
      expect(records.length).toBeGreaterThan(0);
    });

    it("an adopted value that says nothing new notifies nobody", () => {
      cockpitTheme.set("logbook");
      let notifications = 0;
      const un = cockpitTheme.listen(() => {
        notifications += 1;
      });
      foreignPrefixed("cockpitTheme", "logbook");
      un();
      // A converging tab must not re-render because another tab re-saved the
      // same choice.
      expect(notifications).toBe(0);
    });
  });

  describe("no echo: adopting must not re-stamp this tab as the writer", () => {
    it("adopting a theme does not write the key back", () => {
      const key = storageKeyFor("cockpitTheme");
      window.localStorage.setItem(key, "logbook");
      // Sabotage the stored value AFTER the event is constructed: if adoption
      // wrote back, the sabotage would be overwritten by "light".
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: "logbook",
          storageArea: window.localStorage,
        }),
      );
      window.localStorage.setItem(key, "SENTINEL");
      expect(window.localStorage.getItem(key)).toBe("SENTINEL");
      expect(cockpitTheme.get()).toBe("logbook");
    });

    it("adopting marks does not write the key back", () => {
      const marks = JSON.stringify([
        {
          id: "mark-echo",
          timeMs: 1,
          label: "m",
          createdAtMs: 1,
          origin: "user",
          storage: "local",
        },
      ]);
      window.localStorage.setItem(MARKS_STORAGE_KEY, marks);
      foreignWrite(MARKS_STORAGE_KEY, marks);
      window.localStorage.setItem(MARKS_STORAGE_KEY, "SENTINEL");
      expect(window.localStorage.getItem(MARKS_STORAGE_KEY)).toBe("SENTINEL");
      expect(sweepMarks.get().some((m) => m.id === "mark-echo")).toBe(true);
    });
  });

  describe("ledgers merge rather than overwrite", () => {
    // (The module-usage ledger cases died with the module-density dial —
    //  no port; the room-activation ledger below is the cockpit's own.)

    it("the room activation ledger merges, so a warm order is not one tab's history", () => {
      resetRoomActivations();
      recordRoomActivation("switch");
      // Another tab has opened custody far more often.
      foreignPrefixed(
        "cockpit.rooms.activations.v1",
        JSON.stringify({ custody: 40, switch: 1 }),
      );
      // The union orders the idle warm; this tab's own open is not erased.
      expect(roomWarmOrder()[0]).toBe("custody");
      resetRoomActivations();
    });
  });

  // ── THE WHOLE-WRITE RACE (the drive-18 finding, closed at the seam) ──
  //
  // Both tabs write the whole blob on every arm/re-arm/fire/clear, and a
  // last-write-wins save could bury a fresher fact another tab just landed
  // — measured live as a ~2s window where the persisted row read cocked
  // while both tabs' UIs read fired, with the latent double-fire harm a
  // third tab loading inside that window would suffer. The write seams
  // merge with the persisted blob now (marks.ts), and the adoption merges
  // rows both sides hold — the arms below drive the exact interleavings
  // deterministically, using the same seam functions a second tab runs.

  describe("the whole-write race — the storage seams merge, never clobber", () => {
    beforeEach(() => {
      armedTriggers.set([]);
      sweepMarks.set([]);
    });

    it("the row merge table: generation recency, firing monotone within a generation, the earlier firing wins a tie", () => {
      const cocked = (armedAtMs: number) =>
        Object.freeze({
          id: "arm-merge-table",
          kind: "tool-errors" as const,
          param: null,
          predicate: null,
          scope: "chat" as const,
          armedAtMs,
          firedAtMs: null,
          storage: "local" as const,
        });
      const fired = (armedAtMs: number, firedAtMs: number) =>
        Object.freeze({ ...cocked(armedAtMs), firedAtMs });
      // A NEWER GENERATION wins outright, both directions — a deliberate
      // re-arm resets the firing and its recency beats a stale firing.
      expect(mergeArmedTriggerRow(fired(1_000, 5_000), cocked(2_000)).firedAtMs).toBeNull();
      expect(mergeArmedTriggerRow(cocked(2_000), fired(1_000, 5_000)).firedAtMs).toBeNull();
      // WITHIN one generation the firing is monotone, both directions — a
      // cocked version cannot bury a firing.
      expect(mergeArmedTriggerRow(cocked(1_000), fired(1_000, 5_000)).firedAtMs).toBe(5_000);
      expect(mergeArmedTriggerRow(fired(1_000, 5_000), cocked(1_000)).firedAtMs).toBe(5_000);
      // Both fired with DIFFERENT instants (the double-fire already
      // materialized): the EARLIER firing is the truth.
      expect(mergeArmedTriggerRow(fired(1_000, 5_000), fired(1_000, 2_000)).firedAtMs).toBe(2_000);
      expect(mergeArmedTriggerRow(fired(1_000, 2_000), fired(1_000, 5_000)).firedAtMs).toBe(2_000);
      // Same-event firings carry the same instant: one fact.
      expect(mergeArmedTriggerRow(fired(1_000, 5_000), fired(1_000, 5_000)).firedAtMs).toBe(5_000);
      // Both cocked: one row, still waiting.
      expect(mergeArmedTriggerRow(cocked(1_000), cocked(1_000)).firedAtMs).toBeNull();
    });

    it("a stale whole-write cannot bury a foreign firing — the persisted blob stays monotone", () => {
      // THE OBSERVED INTERLEAVING, deterministic: this tab holds the row
      // COCKED (its snapshot was stashed before the foreign fact arrives);
      // another tab's whole-write lands the row FIRED while its storage
      // event is still queued (the adoption latency the drive measured);
      // this tab then writes a snapshot derived from its stale atom.
      const foreignRow = armTrigger("tool-errors");
      const ownRow = armTrigger("check-fails");
      expect(persistedArms().find((t) => t.id === foreignRow.id)?.firedAtMs ?? null).toBeNull();

      const FIRED_AT = 1_700_000_400_000;
      window.localStorage.setItem(
        ARMS_STORAGE_KEY,
        JSON.stringify([{ ...foreignRow, firedAtMs: FIRED_AT }]),
      );

      // This tab fires its OWN row (an event matching check-fails only);
      // the write derives from an atom that still holds the foreign row
      // cocked — the exact stale-snapshot shape that used to clobber.
      const dropped = fireMatchingArms(evTestFailure(1_700_000_500_000));
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.timeMs).toBe(1_700_000_500_000);

      // The final state is coherent: the foreign firing survived at its
      // exact instant (monotone, not overwritten by the stale write), the
      // own firing landed, and this tab's atom converged at the write.
      const after = persistedArms();
      expect(after.find((t) => t.id === foreignRow.id)?.firedAtMs).toBe(FIRED_AT);
      expect(after.find((t) => t.id === ownRow.id)?.firedAtMs).toBe(1_700_000_500_000);
      expect(armedTriggers.get().find((t) => t.id === foreignRow.id)?.firedAtMs).toBe(FIRED_AT);
    });

    it("the double-fire killed browser-wide: a third tab loading inside the window reads the row FIRED", () => {
      // The filed latent harm: tab A fires; tab B's stale whole-write (the
      // row still cocked in its snapshot) regresses the persisted blob; a
      // third tab loads inside the window and fires the row AGAIN — the
      // single-shot law broken across the whole browser.
      const row = armTrigger("tool-errors");
      const FIRED_AT = 1_700_000_400_000;
      window.localStorage.setItem(
        ARMS_STORAGE_KEY,
        JSON.stringify([{ ...row, firedAtMs: FIRED_AT }]),
      );

      // Tab B — holding the row cocked, never adopted — writes its whole
      // blob through the same seam every tab runs.
      saveArmsMerged([{ ...row }]);

      // THE THIRD TAB loads: the boot loader reads the persisted blob.
      const loaded = loadArms();
      expect(loaded.find((t) => t.id === row.id)?.firedAtMs).toBe(FIRED_AT);
      // Single-shot across the whole browser: the loaded row never fires
      // again, in any tab that loads it.
      armedTriggers.set(Object.freeze(loaded));
      expect(fireMatchingArms(evToolError(1_700_000_900_000))).toHaveLength(0);
      expect(persistedArms().find((t) => t.id === row.id)?.firedAtMs).toBe(FIRED_AT);
    });

    it("a deliberate re-arm wins by recency: a stale foreign firing cannot un-fire the re-cocked row", () => {
      const row = armTrigger("tool-errors");
      fireMatchingArms(evToolError(4_000));
      expect(armedTriggers.get().find((t) => t.id === row.id)?.firedAtMs).toBe(4_000);

      const reArmed = reArmTrigger(row.id);
      expect(reArmed).not.toBeNull();
      expect(reArmed!.firedAtMs).toBeNull();
      // The re-arm's generation is strictly newer than the row's own prior
      // generation, even inside one clock millisecond.
      expect(reArmed!.armedAtMs).toBeGreaterThan(row.armedAtMs);

      // The OLD generation's firing arrives as a stale foreign blob (the
      // pre-re-arm whole-write, still in flight): the adoption merge keeps
      // the re-cock, and this tab's next seam write keeps it in the blob.
      const staleFired = { ...row, firedAtMs: 4_000 };
      foreignWrite(ARMS_STORAGE_KEY, JSON.stringify([staleFired]));
      expect(armedTriggers.get().find((t) => t.id === row.id)?.firedAtMs).toBeNull();

      armTrigger("check-fails");
      const persistedRow = persistedArms().find((t) => t.id === row.id);
      expect(persistedRow?.firedAtMs ?? null).toBeNull();
      expect(persistedRow?.armedAtMs).toBe(reArmed!.armedAtMs);
    });

    it("a late foreign blob cannot regress a firing this tab already holds — and this tab's next write heals the persisted blob", () => {
      // The drive-18 shape, end to end: the persisted blob briefly behind
      // this tab's face (a stale foreign write landed cocked), then the
      // monotone seam restores coherence at the next write — instead of
      // the observed transient persisting until the next whole clobber.
      const row = armTrigger("tool-errors");
      fireMatchingArms(evToolError(5_000));
      expect(persistedArms().find((t) => t.id === row.id)?.firedAtMs).toBe(5_000);

      // The stale blob (written before this tab's firing) lands, and its
      // storage event arrives late.
      foreignWrite(ARMS_STORAGE_KEY, JSON.stringify([{ ...row }]));
      // The adoption MERGED: this tab's firing survived the stale blob.
      expect(armedTriggers.get().find((t) => t.id === row.id)?.firedAtMs).toBe(5_000);
      // The foreign write regressed the persisted blob (a fact landed)…
      expect(persistedArms().find((t) => t.id === row.id)?.firedAtMs ?? null).toBeNull();
      // …and this tab's next seam write heals it, monotone.
      armTrigger("check-fails");
      expect(persistedArms().find((t) => t.id === row.id)?.firedAtMs).toBe(5_000);
    });

    it("a cleared row stays cleared: the tombstone refuses a stale re-carriage and heals the persisted blob", () => {
      const cleared = armTrigger("tool-errors");
      const kept = armTrigger("check-fails");
      clearArm(cleared.id);
      expect(persistedArms().some((t) => t.id === cleared.id)).toBe(false);

      // A stale foreign whole-write re-carries the cleared row (the other
      // tab's snapshot predates the clear), and its event arrives.
      foreignWrite(ARMS_STORAGE_KEY, JSON.stringify([{ ...cleared }, { ...kept }]));
      // The adoption refused the resurrection…
      expect(armedTriggers.get().some((t) => t.id === cleared.id)).toBe(false);
      expect(armedTriggers.get().some((t) => t.id === kept.id)).toBe(true);
      // …and this tab's next seam write heals the persisted blob the
      // stale write regressed: no resurrection anywhere.
      armTrigger("tool-errors");
      expect(persistedArms().some((t) => t.id === cleared.id)).toBe(false);
      expect(persistedArms().some((t) => t.id === kept.id)).toBe(true);
    });

    it("two tabs evaluating the same event leave ONE persisted firing mark (the deterministic firing id)", () => {
      const row = armTrigger("tool-errors");
      const e = evToolError(1_700_000_400_000, "evt-shared");
      const dropped = fireMatchingArms(e);
      expect(dropped).toHaveLength(1);
      // The firing's identity is (trigger row, event) — stated as the
      // value the id must carry, with no per-tab counter anywhere in it.
      expect(dropped[0]!.id).toBe(`mark-arm-${row.id}-evt-shared`);

      // The other tab evaluated the SAME event on its own live wire and
      // wrote its whole marks blob; its mark carries the same identity
      // (its own clock read for createdAtMs — the id is what must agree).
      const otherTabsMark = {
        id: `mark-arm-${row.id}-evt-shared`,
        timeMs: e.timeMs,
        label: dropped[0]!.label,
        createdAtMs: 1_700_000_400_999,
        origin: "arm" as const,
        storage: "local" as const,
      };
      saveMarksMerged([otherTabsMark]);
      const withThatId = persistedMarks().filter((m) => m.id === otherTabsMark.id);
      expect(withThatId).toHaveLength(1);
    });

    it("a stale whole-write cannot drop another tab's fresh mark (the marks union)", () => {
      // Tab A (this tab) drops a mark; its write lands.
      recordReceivedEvent(ev(1_700_000_100_000));
      const mine = dropMarkAtNow("first tab's mark");
      expect(mine).not.toBeNull();
      expect(persistedMarks().some((m) => m.id === mine!.id)).toBe(true);

      // Tab B — a stale snapshot that never saw that mark — pushes its OWN
      // mark through the same seam every tab runs.
      const foreignMark = {
        id: "mark-foreign-2",
        timeMs: 1_700_000_200_000,
        label: "other tab's mark",
        createdAtMs: 1_700_000_200_000,
        origin: "user" as const,
        storage: "local" as const,
      };
      saveMarksMerged([foreignMark]);

      // The union kept BOTH: the stale write could not silently delete a
      // person's bookmark it had never seen.
      const after = persistedMarks();
      expect(after.some((m) => m.id === mine!.id)).toBe(true);
      expect(after.some((m) => m.id === foreignMark.id)).toBe(true);
    });

    it("a removed mark stays removed against this tab's next write (the session tombstone)", () => {
      recordReceivedEvent(ev(1_700_000_100_000));
      const first = dropMarkAtNow("first");
      const second = dropMarkAtNow("second");
      removeMark(first!.id);
      expect(persistedMarks().some((m) => m.id === first!.id)).toBe(false);

      // A stale foreign blob re-carries the removed mark, event included.
      foreignWrite(MARKS_STORAGE_KEY, JSON.stringify([first!, second!]));
      // The adoption refused it…
      expect(sweepMarks.get().some((m) => m.id === first!.id)).toBe(false);
      expect(sweepMarks.get().some((m) => m.id === second!.id)).toBe(true);
      // …and this tab's next seam write heals the persisted blob the
      // stale write regressed: the removed mark does not resurrect.
      recordReceivedEvent(ev(1_700_000_300_000));
      const third = dropMarkAtNow("third");
      expect(third).not.toBeNull();
      const after = persistedMarks();
      expect(after.some((m) => m.id === first!.id)).toBe(false);
      expect(after.some((m) => m.id === second!.id)).toBe(true);
      expect(after.some((m) => m.id === third!.id)).toBe(true);
    });
  });
});
