// @vitest-environment jsdom
/**
 * THE SETTING SHEET — live in jsdom (spec §9.1).
 *
 * What must hold on screen:
 *   - served label + served consequence description render; the raw-key law
 *     throws at the render boundary (mutation);
 *   - every save goes through the ONE validated action —
 *     POST /api/b/settings.customizations/set with { id, value } (the real
 *     Broker choke point over a stubbed fetch, no bypass);
 *   - optimistic paint + honest read-back: the value shown after a save is
 *     the server's re-read snapshot;
 *   - an out-of-contract value is a DESIGNED refusal: it answers 200 with
 *     the typed refusal in the envelope, the fetch door reconstructs the
 *     typed error, and the sheet renders the server's sentence plainly
 *     while the standing value stands (a raw 400 would log a browser
 *     console line on every honest wrong value);
 *   - the measured-effect line renders only for the genuinely linked signal;
 *   - cockpit-local preferences save device-side (no network) and apply to
 *     the document root immediately.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import SettingSheet from "../../src/cockpit/settings/SettingSheet.svelte";
import {
  resetSettingsFeed,
  setSettingsReaders,
  bindSettingsReadback,
  saveSetting,
  settingsLoadState,
  settingsWrites,
} from "../../src/cockpit/settings/settings-feed.ts";
import {
  applyStoredCockpitPrefs,
  localValue,
  setLocalPref,
} from "../../src/cockpit/settings/local-prefs.ts";
import { clientWarn, isClientDebugEnabled } from "../../src/client-debug.ts";
import {
  resetUiSchema,
  setUiSchema,
  setUiSchemaValues,
  uiSchemaValues,
} from "../../src/state/schema-store.ts";
import { clearCache, fireInvalidation } from "../../src/data/broker.ts";
import { ClientError } from "../../src/data/errors.ts";
import { getUiSchemaValues } from "../../src/client.ts";
import { resetAllStores } from "../../src/state/store-registry.ts";
import { SCHEMA, VALUES } from "./fixtures/settings-schema.ts";
import type { UiSchema, UiSchemaValues } from "../../shared/ui-schema.ts";
import { read } from "../helpers/source-scan.ts";

type Posted = { url: string; body: unknown };

/** Server-side value state the stub "persists" so read-back is real. */
let serverValues: UiSchemaValues;
let posted: Posted[];
let failNextSave: { code: string; message: string; status: number } | null;
/**
 * When set, the next save's value is "hidden by the display egress": the
 * stub answers the way the real server does — the read-back form MASKED,
 * `masked: true` beside it — and the persisted entry carries the flag, so
 * the sheet's reconciliation faces exactly the wire shape a credential-
 * shaped value produces.
 */
let maskNextSave: boolean;
let saveBarrier: Promise<void> | null;

/** The masked form the stub's egress would serve for a token-shaped value. */
const MASKED_FORM = "[REDACTED:token]";

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && /\/api\/b\/settings\.customizations\/set$/.test(url)) {
        const body = JSON.parse(String(init.body ?? "{}")) as { id: string; value: unknown };
        posted.push({ url, body });
        if (saveBarrier !== null) await saveBarrier;
        if (failNextSave !== null) {
          const failure = failNextSave;
          failNextSave = null;
          // A DESIGNED refusal travels in the 200 envelope — the wire shape
          // the block action door now answers with, reconstructed by the
          // real fetch door this stub sits under (blockRefusalOf).
          return new Response(
            JSON.stringify({
              data: null,
              meta: { etag: 'W/"1"', asOf: 1 },
              refusal: { code: failure.code, message: failure.message, status: failure.status },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (maskNextSave) {
          maskNextSave = false;
          serverValues = {
            ...serverValues,
            customizations: serverValues.customizations.map((c) =>
              c.id === body.id ? { id: c.id, value: MASKED_FORM, masked: true } : c,
            ),
          } as UiSchemaValues;
          return new Response(
            JSON.stringify({
              data: { id: body.id, saved: true, value: MASKED_FORM, masked: true },
              meta: { etag: 'W/"1"', asOf: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        serverValues = {
          ...serverValues,
          customizations: serverValues.customizations.map((c) =>
            c.id === body.id ? { id: c.id, value: body.value as never } : c,
          ),
        } as UiSchemaValues;
        return new Response(
          JSON.stringify({
            data: { id: body.id, saved: true, value: body.value },
            meta: { etag: 'W/"1"', asOf: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/schema/ui/values")) {
        return new Response(JSON.stringify(serverValues), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  cleanup();
  posted = [];
  failNextSave = null;
  maskNextSave = false;
  saveBarrier = null;
  serverValues = VALUES;
  clearCache();
  resetSettingsFeed();
  resetUiSchema();
  stubFetch();
  setUiSchema(SCHEMA);
  setUiSchemaValues(VALUES);
  // The read-back reader answers from the stub's "server state".
  setSettingsReaders({
    schema: async () => setUiSchema(SCHEMA),
    values: async () => setUiSchemaValues(serverValues),
  });
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-cockpit-theme");
  applyStoredCockpitPrefs();
});

function barrier() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

describe("shared customization authority across editor lifetimes", () => {

  /** Delay delivery only after the fixture has accepted and read back the write. */
  function holdAcceptedSave() {
    const accepted = barrier(), delivery = barrier(), wire = globalThis.fetch;
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const hold = first && init?.method === "POST" && String(input).endsWith("/settings.customizations/set");
      if (hold) first = false;
      const response = await wire(input, init);
      if (hold) { accepted.release(); await delivery.promise; }
      return response;
    }));
    return { accepted: accepted.promise, release: delivery.release, wire };
  }

  function standing(id = "tools.parallelCap") {
    return uiSchemaValues.get()?.customizations.find(c => c.id === id)?.value;
  }

  test.each([false, true])("an accepted response held across remount retains same-key ownership and the newer draft; reset: %s", async reset => {
    const held = holdAcceptedSave();
    const first = render(SettingSheet, { settingId: "tools.parallelCap" });
    try {
      await fireEvent.input(first.getByLabelText("Parallel tool calls"), { target: { value: "8" } });
      await fireEvent.keyDown(first.getByLabelText("Parallel tool calls"), { key: "Enter" });
      await held.accepted;
      expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
      first.unmount();
      const next = render(SettingSheet, { settingId: "tools.parallelCap" });
      const field = next.getByLabelText("Parallel tool calls") as HTMLInputElement;
      await waitFor(() => expect(field.value).toBe("8"));
      await fireEvent.input(field, { target: { value: "12" } });
      expect(next.container.querySelector(".commit")?.getAttribute("aria-busy")).toBe("true");
      if (reset) await fireEvent.click(await next.findByText(/Return to default/));
      else await fireEvent.keyDown(field, { key: "Enter" });
      expect(posted).toHaveLength(1);
      await expect(saveSetting("tools.parallelCap", 14)).rejects.toMatchObject({ name: "ClientError", code: "setting_save_pending" });
      // A different key has no dependency on the held response.
      await expect(saveSetting("awareness.enabledSignals", "memory.entryCount")).resolves.toMatchObject({ saved: true, value: "memory.entryCount" });
      expect(posted).toHaveLength(2);
      held.release();
      await waitFor(() => expect(settingsWrites.get().has("tools.parallelCap")).toBe(false));
      expect(standing()).toBe(8);
      expect(field.value).toBe("12");
      expect(next.container.querySelector(".saved-line")).toBeNull();
      failNextSave = { status: 428, code: "invalid_customization_value", message: "Newer change refused" };
      await fireEvent.keyDown(field, { key: "Enter" });
      await next.findByText("Newer change refused");
      expect(standing()).toBe(8);
      expect(field.value).toBe("12");
      await fireEvent.keyDown(field, { key: "Enter" });
      await next.findByText(/^(Saved|Updated)$/ , {selector:".saved-announcement, .saved-line"});
      expect(standing()).toBe(12);
      expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(12);
    } finally { held.release(); }
  });

  test("an older action answer reconciles a later external acceptance instead of publishing its historical value", async () => {
    const held = holdAcceptedSave();
    const save = saveSetting("tools.parallelCap", 8);
    try {
      await held.accepted;
      await held.wire("/api/b/settings.customizations/set", { method: "POST", body: JSON.stringify({ id: "tools.parallelCap", value: 12 }) });
      expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(12);
      held.release();
      await expect(save).resolves.toMatchObject({ saved: true, value: 12 });
      expect(standing()).toBe(12);
    } finally { held.release(); await save; }
  });

  test("reconciliation follows actual acceptance when another writer's earlier request is accepted last", async () => {
    const acceptExternal = barrier();
    const wire = globalThis.fetch;
    // Initiated first, but not accepted until after this client's write.
    const earlierRequest = acceptExternal.promise.then(() => wire("/api/b/settings.customizations/set", {
      method: "POST", body: JSON.stringify({ id: "tools.parallelCap", value: 8 }),
    }));
    const held = holdAcceptedSave();
    const save = saveSetting("tools.parallelCap", 12);
    try {
      await held.accepted;
      expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(12);
      acceptExternal.release();
      await earlierRequest;
      expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
      held.release();
      await expect(save).resolves.toMatchObject({ saved: true, value: 8 });
      expect(standing()).toBe(8);
    } finally { acceptExternal.release(); held.release(); await Promise.all([earlierRequest, save]); }
  });

  test("a pre-acceptance values request cannot stand in for the one post-action confirmation", async () => {
    const delivery = barrier(), started = barrier(), wire = globalThis.fetch;
    let firstRead = true, valuesReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const isRead = String(input).endsWith("/schema/ui/values");
      const hold = isRead && firstRead;
      if (isRead) { firstRead = false; valuesReads += 1; }
      const response = await wire(input, init);
      if (hold) { started.release(); await delivery.promise; }
      return response;
    }));
    setSettingsReaders({ values: getUiSchemaValues });
    const oldRead = getUiSchemaValues();
    try {
      await started.promise;
      await expect(saveSetting("tools.parallelCap", 8)).resolves.toMatchObject({ saved: true, value: 8 });
      expect(valuesReads).toBe(2);
      delivery.release();
      await oldRead;
      expect(standing()).toBe(8);
    } finally { delivery.release(); await oldRead; }
  });

  test.each(["transport", "confirmation", "transport-and-confirmation"] as const)("%s failure preserves truthful uncertainty and a same-value retry", async failure => {
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = view.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await view.findByText("Parallel tool calls");
    const wire = globalThis.fetch;
    let fail = true;
    if (failure !== "confirmation") {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await wire(input, init);
        if (fail && init?.method === "POST") { fail = false; throw new TypeError("Response connection lost"); }
        return response;
      }));
    }
    if (failure !== "transport") {
      let failConfirmation = true;
      setSettingsReaders({ values: async () => {
        if (failConfirmation) { failConfirmation = false; throw new ClientError("network", "Confirmation connection lost"); }
        setUiSchemaValues(serverValues);
      } });
    }
    await fireEvent.input(field, { target: { value: "8" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    const uncertainty = await view.findByText(/This change may be stored, but it could not be confirmed/);
    if (failure === "transport-and-confirmation") {
      expect(uncertainty.textContent).toContain("Response connection lost");
      expect(uncertainty.textContent).toContain("The confirmation request also failed.");
    }
    expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
    expect(view.container.querySelector(".saved-line")).toBeNull();
    expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("uncertain");
    expect(field.value).toBe("8");
    // A real later read settles known acceptance. Unknown transport acceptance
    // remains retryable even when the currently served value happens to match.
    setSettingsReaders({ values: getUiSchemaValues });
    view.unmount();
    const reopened = render(SettingSheet, { settingId: "tools.parallelCap" });
    await waitFor(() => expect((reopened.getByLabelText("Parallel tool calls") as HTMLInputElement).value).toBe("8"));
    if (failure === "confirmation") {
      await waitFor(() => expect(settingsWrites.get().has("tools.parallelCap")).toBe(false));
      expect(reopened.queryByText(/A previous change could not be confirmed/)).toBeNull();
      await fireEvent.keyDown(reopened.getByLabelText("Parallel tool calls"), { key: "Enter" });
      expect(posted).toHaveLength(1);
      return;
    }
    await reopened.findByText(/A previous change could not be confirmed/);
    await fireEvent.click(await reopened.findByText("Save"));
    await reopened.findByText(/^(Saved|Updated)$/ , {selector:".saved-announcement, .saved-line"});
    expect(posted).toHaveLength(2);
    expect(standing()).toBe(8);
    expect(settingsWrites.get().has("tools.parallelCap")).toBe(false);
  });

  test("a typed refusal after an uncertain write retains the need to confirm storage", async () => {
    const wire = globalThis.fetch;
    let first = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wire(input, init);
      if (first && init?.method === "POST") { first = false; throw new TypeError("Response lost after acceptance"); }
      return response;
    }));
    await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
    failNextSave = { status: 428, code: "invalid_customization_value", message: "New attempt refused" };
    await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "invalid_customization_value", message: "New attempt refused" });
    expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("uncertain");
    await expect(saveSetting("tools.parallelCap", 8)).resolves.toMatchObject({ saved: true, value: 8 });
    expect(posted).toHaveLength(3);
  });

  test("the readback supplies normalization and masking even when the action answer differs", async () => {
    const wire = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wire(input, init);
      if (init?.method === "POST") {
        serverValues = { ...serverValues, customizations: serverValues.customizations.map(c => c.id === "awareness.enabledSignals" ? { id: c.id, value: MASKED_FORM, masked: true } : c) };
      }
      return response;
    }));
    await expect(saveSetting("awareness.enabledSignals", "value-normalized-and-hidden")).resolves.toEqual({ id: "awareness.enabledSignals", saved: true, value: MASKED_FORM, masked: true });
    expect(uiSchemaValues.get()?.customizations.find(c => c.id === "awareness.enabledSignals")).toEqual({ id: "awareness.enabledSignals", value: MASKED_FORM, masked: true });
  });

  test("an old scope completion cannot publish its value or release the new same-key claim", async () => {
    const old = holdAcceptedSave();
    const oldSave = saveSetting("tools.parallelCap", 8).catch(err => err);
    await old.accepted;
    resetAllStores();
    serverValues = VALUES;
    setUiSchema(SCHEMA); setUiSchemaValues(VALUES);
    setSettingsReaders({ values: async () => setUiSchemaValues(serverValues) });
    const next = holdAcceptedSave();
    const nextSave = saveSetting("tools.parallelCap", 12);
    try {
      await next.accepted;
      const newClaim = settingsWrites.get().get("tools.parallelCap");
      old.release();
      expect(await oldSave).toMatchObject({ name: "ClientError", code: "setting_scope_changed" });
      expect(settingsWrites.get().get("tools.parallelCap")).toBe(newClaim);
      expect(standing()).not.toBe(8);
      next.release();
      await expect(nextSave).resolves.toMatchObject({ saved: true, value: 12 });
      expect(standing()).toBe(12);
      expect(settingsWrites.get().has("tools.parallelCap")).toBe(false);
    } finally { old.release(); next.release(); await Promise.all([oldSave, nextSave]); }
  });

  test("unchanged served values avoid both the action and invalidation while normalized drafts become clean", async () => {
    const refresh = vi.fn(async () => setUiSchemaValues(serverValues));
    setSettingsReaders({ values: refresh });
    for (const entry of VALUES.customizations) {
      await expect(saveSetting(entry.id, entry.value)).resolves.toMatchObject({ saved: false, value: entry.value });
    }
    expect(posted).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = view.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "4.0" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(field.value).toBe("4"));
    expect(view.container.querySelector(".saved-line")).toBeNull();
    expect(posted).toHaveLength(0);
  });

  test("the masked display cannot be written even by a direct caller", async () => {
    setUiSchemaValues({ ...VALUES, customizations: [{ id: "awareness.enabledSignals", value: MASKED_FORM, masked: true }] });
    await expect(saveSetting("awareness.enabledSignals", MASKED_FORM)).rejects.toMatchObject({ name: "ClientError", code: "masked_setting_value" });
    expect(posted).toHaveLength(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSettingsFeed();
  resetUiSchema();
});

describe("accepted write recovery and newer masked drafts", () => {
  test("recovery indexes the actual published population once without a mapped array", async () => {
    setSettingsReaders({ values: async () => { throw new ClientError("network", "Confirmation response lost"); } });
    for (const [id, value] of [["tools.parallelCap", 8], ["awareness.enabledSignals", "index-recovery"]] as const) {
      await expect(saveSetting(id, value)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
    }
    expect(settingsWrites.get().size).toBe(2);
    const originalSet = uiSchemaValues.set;
    const work: Array<{ population: number; passes: number; visited: number; mapCalls: () => number }> = [];
    const releases: Array<() => void> = [];
    const publication = vi.spyOn(uiSchemaValues, "set").mockImplementation(values => {
      if (values) {
        // Response.json may create this array in another realm. Observe the
        // exact published object, not the test realm's Array.prototype.
        const entries = values.customizations;
        const mapping = vi.spyOn(entries, "map");
        const counts = { population: entries.length, passes: 0, visited: 0, mapCalls: () => mapping.mock.calls.length };
        const iterate = entries[Symbol.iterator];
        const walking = vi.spyOn(entries, Symbol.iterator).mockImplementation(function* () {
          counts.passes += 1;
          for (const entry of iterate.call(entries)) { counts.visited += 1; yield entry; }
          return undefined;
        });
        work.push(counts);
        releases.push(() => { walking.mockRestore(); mapping.mockRestore(); });
      }
      originalSet(values);
    });
    const statuses = vi.spyOn(settingsWrites, "set");
    try {
      await getUiSchemaValues();
      expect(work).toHaveLength(1);
      expect(work[0]!.population).toBe(serverValues.customizations.length);
      expect(work[0]!.population).toBeGreaterThan(settingsWrites.get().size);
      expect(settingsWrites.get().size).toBe(0);
      expect(uiSchemaValues.get()?.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
      expect(uiSchemaValues.get()?.customizations.find(c => c.id === "awareness.enabledSignals")?.value).toBe("index-recovery");
      expect(work[0]!.mapCalls()).toBe(0);
      expect({ passes: work[0]!.passes, visited: work[0]!.visited }).toEqual({ passes: 1, visited: work[0]!.population });
      expect(statuses).toHaveBeenCalledTimes(1);
      // A second real read with no writes cannot allocate/traverse the index
      // or publish another status map; the new snapshot still really arrives.
      await getUiSchemaValues();
      expect(work).toHaveLength(2);
      expect({ maps: work[1]!.mapCalls(), passes: work[1]!.passes, visited: work[1]!.visited }).toEqual({ maps: 0, passes: 0, visited: 0 });
      expect(statuses).toHaveBeenCalledTimes(1);
    } finally {
      for (const release of releases) release();
      publication.mockRestore(); statuses.mockRestore();
    }
  });

  test.each([false, true].flatMap(masked => [false, true].map(newer => ({ masked, newer }))))("a later read clears mounted feedback and only the submitted draft: %o", async ({ masked, newer }) => {
    const id = masked ? "awareness.enabledSignals" : "tools.parallelCap";
    const label = masked ? "Only watch these readings" : "Parallel tool calls";
    const submitted = masked ? "first-secret-draft" : "8", next = masked ? "new-secret-draft" : "12";
    const view = render(SettingSheet, { settingId: id });
    const field = view.getByLabelText(label) as HTMLInputElement;
    setSettingsReaders({ values: async () => { throw new ClientError("network", "Confirmation response lost"); } });
    maskNextSave = masked;
    await fireEvent.input(field, { target: { value: submitted } });
    await fireEvent.click(view.container.querySelector(".commit")!);
    await view.findByText(/This change may be stored/);
    if (newer) await fireEvent.input(field, { target: { value: next } });
    if (masked) expect(JSON.stringify([...settingsWrites.get()])).not.toContain(submitted);
    await getUiSchemaValues();
    await waitFor(() => expect(view.queryByText(/This change may be stored/)).toBeNull());
    expect(field.value).toBe(newer ? next : masked ? "" : "8");
    expect(view.container.querySelector(".commit")?.getAttribute("data-commit-state")).toBe(newer ? "draft" : "unchanged");
    expect(settingsWrites.get().has(id)).toBe(false);
    if (!masked && !newer) await fireEvent.keyDown(field, { key: "Enter" });
    expect(posted).toHaveLength(1);
  });

  test("a pre-acceptance GET delivered after failed confirmation cannot settle known acceptance", async () => {
    const wire = globalThis.fetch;
    const started = barrier(), delivery = barrier();
    let hold = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wire(input, init);
      if (hold && String(input).endsWith("/schema/ui/values")) { hold = false; started.release(); await delivery.promise; }
      return response;
    }));
    const stale = getUiSchemaValues();
    try {
      await started.promise;
      setSettingsReaders({ values: async () => { throw new ClientError("network", "Confirmation response lost"); } });
      await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
      delivery.release(); await stale;
      expect(uiSchemaValues.get()?.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(4);
      expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("uncertain");
      await getUiSchemaValues();
      expect(settingsWrites.get().has("tools.parallelCap")).toBe(false);
      expect(posted).toHaveLength(1);
    } finally { delivery.release(); await stale; }
  });

  test("a later snapshot missing the entry cannot confirm its accepted write", async () => {
    setSettingsReaders({ values: async () => { throw new ClientError("network", "Confirmation response lost"); } });
    await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
    const stored = serverValues;
    serverValues = { ...stored, customizations: stored.customizations.filter(c => c.id !== "tools.parallelCap") };
    await getUiSchemaValues();
    expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("uncertain");
    serverValues = stored;
    await getUiSchemaValues();
    expect(settingsWrites.get().has("tools.parallelCap")).toBe(false);
  });

  test("a refused newer save cannot restore uncertainty already confirmed while it was pending", async () => {
    setSettingsReaders({ values: async () => { throw new ClientError("network", "Confirmation response lost"); } });
    await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
    const wire = globalThis.fetch, refused = barrier(), delivery = barrier();
    failNextSave = { status: 428, code: "invalid_customization_value", message: "Newer change refused" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wire(input, init);
      if (init?.method === "POST") { refused.release(); await delivery.promise; }
      return response;
    }));
    const attempt = saveSetting("tools.parallelCap", 12);
    const result = expect(attempt).rejects.toMatchObject({ code: "invalid_customization_value", message: "Newer change refused" });
    try {
      await refused.promise;
      await getUiSchemaValues();
      expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("pending");
      delivery.release(); await result;
      expect(settingsWrites.get().has("tools.parallelCap")).toBe(false);
      await expect(saveSetting("tools.parallelCap", 8)).resolves.toMatchObject({ saved: false, value: 8 });
      expect(posted).toHaveLength(2);
    } finally { delivery.release(); await result; }
  });

  test("transport rejection can precede server acceptance; neither equal read may suppress retry", async () => {
    const wire = globalThis.fetch, accept = barrier();
    let first = true, late: Promise<Response> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first && init?.method === "POST") {
        first = false;
        late = accept.promise.then(() => wire(input, init));
        throw new TypeError("Transport closed before acceptance was known");
      }
      return wire(input, init);
    }));
    setSettingsReaders({ values: getUiSchemaValues });
    try {
      await expect(saveSetting("tools.parallelCap", 8)).rejects.toMatchObject({ code: "setting_save_unconfirmed" });
      await getUiSchemaValues();
      expect(settingsWrites.get().get("tools.parallelCap")).toEqual({ kind: "uncertain" });
      accept.release(); await late;
      await getUiSchemaValues();
      expect(uiSchemaValues.get()?.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
      expect(settingsWrites.get().get("tools.parallelCap")).toEqual({ kind: "uncertain" });
      await expect(saveSetting("tools.parallelCap", 8)).resolves.toMatchObject({ saved: true, value: 8 });
      expect(posted).toHaveLength(2);
    } finally { accept.release(); await late; }
  });

  test("a later successful values read settles a known accepted write without repeating the write", async () => {
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = view.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("4"));
    let failConfirmation = true;
    setSettingsReaders({ values: async () => {
      if (failConfirmation) { failConfirmation = false; throw new ClientError("network", "Confirmation response lost"); }
      return getUiSchemaValues();
    } });
    await fireEvent.input(field, { target: { value: "8" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    await view.findByText(/This change may be stored, but it could not be confirmed/);
    expect(posted).toHaveLength(1);
    expect(serverValues.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
    expect(uiSchemaValues.get()?.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(4);
    view.unmount();
    const reopened = render(SettingSheet, { settingId: "tools.parallelCap" });
    const freshField = reopened.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await waitFor(() => expect(freshField.value).toBe("8"));
    expect(uiSchemaValues.get()?.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
    // This GET was started by the new editor after the accepted POST settled.
    const before = posted.length;
    await fireEvent.keyDown(freshField, { key: "Enter" });
    await waitFor(() => expect(settingsWrites.get().has("tools.parallelCap")).toBe(false));
    expect(posted.length - before).toBe(0);
  });

  test("masked confirmation preserves a newer typed draft across pending settlement", async () => {
    const view = render(SettingSheet, { settingId: "awareness.enabledSignals" });
    const field = view.getByLabelText("Only watch these readings") as HTMLInputElement;
    await waitFor(() => expect(field.value).not.toBe(""));
    const wire = globalThis.fetch;
    let accepted!: () => void, release!: () => void;
    const didAccept = new Promise<void>(resolve => { accepted = resolve; });
    const delivery = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await wire(input, init);
      if (hold && init?.method === "POST") { hold = false; accepted(); await delivery; }
      return response;
    }));
    maskNextSave = true;
    try {
      await fireEvent.input(field, { target: { value: "first-secret-draft" } });
      await fireEvent.click(view.container.querySelector(".commit")!);
      await didAccept;
      await fireEvent.input(field, { target: { value: "second-distinct-draft" } });
      release();
      await waitFor(() => expect(settingsWrites.get().has("awareness.enabledSignals")).toBe(false));
      expect(field.value).toBe("second-distinct-draft");
      expect(uiSchemaValues.get()?.customizations.find(c => c.id === "awareness.enabledSignals")).toEqual({id: "awareness.enabledSignals", value: MASKED_FORM, masked: true});
      expect(JSON.stringify([...settingsWrites.get()])).not.toContain("first-secret-draft");
      await fireEvent.click(view.container.querySelector(".commit")!);
      await waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[1]!.body).toEqual({id: "awareness.enabledSignals", value: "second-distinct-draft"});
    } finally { release(); }
  });
});

describe("served words on the sheet", () => {
  test("label, description, current value, bounds and the declared consequence render", async () => {
    const { findByText, getByLabelText, container } = render(SettingSheet, {
      settingId: "tools.parallelCap",
    });
    expect(await findByText("Parallel tool calls")).toBeTruthy();
    expect(
      await findByText("How many tool calls may run at the same time before the rest queue."),
    ).toBeTruthy();
    expect((getByLabelText("Parallel tool calls") as HTMLInputElement).value).toBe("4");
    expect(await findByText("1–16 calls")).toBeTruthy();
    const help = await findByText(/applies to everyone using this install/);
    expect(container.querySelector('.commit')?.getAttribute('aria-describedby')).toBe(help.id);
    expect(container.querySelector('.setting-details')?.textContent).not.toContain(help.textContent);
    expect(container.textContent?.match(/This install/g)).toHaveLength(1);
  });

  test("an id nothing serves states the absence — nothing to adjust", async () => {
    const { findByText } = render(SettingSheet, { settingId: "never.served" });
    expect(await findByText(/no setting named “never.served” is served/)).toBeTruthy();
  });

  test("a failed fresh read renders an UNREADABLE state with Retry — never the previous value or a Save door", async () => {
    // The store holds the boot snapshot; this sheet's OWN fresh read fails.
    // Painting the boot value under a header that claims a live read would let
    // the reader save from a cache this mount never verified. The value is
    // absent, and the only offered action is another read.
    setSettingsReaders({
      schema: async () => setUiSchema(SCHEMA),
      values: async () => {
        throw new ClientError("network", "the values route refused");
      },
    });
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    expect(await view.findByText(/settings not readable: the values route refused/)).toBeTruthy();
    expect(view.queryByLabelText("Parallel tool calls"), "a stale value must not paint as a measured one").toBeNull();
    expect(view.container.querySelector(".commit"), "no write path may be offered from an unreadable read").toBeNull();
    expect(view.container.querySelector('[data-setting-unreadable]')).not.toBeNull();
    expect(view.container.querySelector('[data-verb-id="settings.sheet/retry"]')).not.toBeNull();

    // Retry is the one way forward, and a successful retry serves the value.
    setSettingsReaders({ schema: async () => setUiSchema(SCHEMA), values: async () => setUiSchemaValues(serverValues) });
    await fireEvent.click(view.getByText("Retry"));
    const field = await view.findByLabelText("Parallel tool calls");
    expect((field as HTMLInputElement).value).toBe("4");
    expect(view.container.querySelector(".commit")).not.toBeNull();
  });

  test("a fresh read still PENDING paints the cache but offers no save from it", async () => {
    // The values read never lands. The boot snapshot still paints (the
    // surface is not blank), but nothing on screen has been measured by this
    // mount yet, so no write may be offered — pending is not ready either.
    setSettingsReaders({
      schema: async () => setUiSchema(SCHEMA),
      values: () => new Promise(() => {}),
    });
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    await waitFor(() => expect(settingsLoadState.get().kind).toBe("pending"));
    const field = (await view.findByLabelText("Parallel tool calls")) as HTMLInputElement;
    expect(field.value).toBe("4");
    const commit = view.container.querySelector(".commit") as HTMLButtonElement | null;
    expect(commit, "the save control may render, but it must not be usable").not.toBeNull();
    expect(commit!.disabled, "a pending read's value is not saveable").toBe(true);
    expect(commit!.getAttribute("aria-disabled")).toBe("true");

    // Even a drafted change and a click cannot send: the gate is the read's
    // state, not the control's disabled attribute alone.
    await fireEvent.input(field, { target: { value: "8" } });
    await fireEvent.click(commit!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posted, "no write may leave the sheet from a pending read").toHaveLength(0);
  });

  test("mutation: a raw-key label refuses to render (§9.3 raw-key law)", () => {
    const rawSchema = {
      ...SCHEMA,
      settings: [
        {
          id: "context.maxContext",
          label: "context.maxContext",
          description: "d",
          type: "number",
          default: 1,
          customizationId: "context.maxContext",
          order: 0,
        },
      ],
    } as unknown as UiSchema;
    setUiSchema(rawSchema);
    expect(() => render(SettingSheet, { settingId: "context.maxContext" })).toThrow(
      /raw key|behavior words/,
    );
  });

  test("the sheet states WHERE the standing value came from, and WHEN a change bites", async () => {
    // `tools.parallelCap`'s served value equals its declared default, and the
    // registration declares `effect: "immediate"`.
    const atDefault = render(SettingSheet, { settingId: "tools.parallelCap" });
    expect((atDefault.getByLabelText("Parallel tool calls") as HTMLInputElement).value).toBe("4");
    expect(atDefault.container.querySelector('.setting-context')?.textContent).not.toMatch(/Source|Default|Built-in default/);
    expect(atDefault.container.querySelector(".setting-context")?.textContent).toContain("AppliesImmediately");
    expect(atDefault.container.querySelector(".edit-result .effect-timing")).toBeNull();
    // NEVER "you set this": the values snapshot carries a value, not a history,
    // so a value equal to the default cannot prove nobody chose it.
    expect(atDefault.container.textContent).not.toMatch(/you set|nobody/i);
    cleanup();

    // A value the server answers with that DIFFERS from the default is proof a
    // change happened — nothing else could have moved it.
    // Through the STUB'S OWN server state, so the sheet's re-read on mount
    // answers with it rather than putting the fixture back.
    serverValues = {
      ...VALUES,
      customizations: [
        { id: "tools.parallelCap", value: 9 },
        ...VALUES.customizations.filter((c) => c.id !== "tools.parallelCap"),
      ],
    } as never;
    setUiSchemaValues(serverValues);
    const changed = render(SettingSheet, { settingId: "tools.parallelCap" });
    expect((changed.getByLabelText("Parallel tool calls") as HTMLInputElement).value).toBe("9");
    const defaultFact = await changed.findByText("Default");
    expect(defaultFact.nextElementSibling?.textContent).toBe("4 calls");
    cleanup();

    // MUTANT: a registration that declares NO timing says so, rather than
    // being promoted to "immediately".
    const undeclared = render(SettingSheet, { settingId: "context.compactStrategy" });
    expect(
      undeclared.container.querySelector(".effect-timing")?.textContent,
    ).toMatch(/when this takes effect is not declared/);
  });

  test("the measured-effect line renders ONLY for a DECLARED linkage", async () => {
    // (a) the identical-id registration — one knob registered as both.
    const sameId = render(SettingSheet, { settingId: "editor.atomicWriteEnabled" });
    expect(await sameId.findByText("measured now · on")).toBeTruthy();
    cleanup();
    // (b) the EXPLICIT claim — `measuredBy` naming a different signal id. This
    // is the form the backend validates at registration, and the one the sheet
    // used to ignore entirely.
    const declared = render(SettingSheet, { settingId: "tools.parallelCap" });
    expect(await declared.findByText("measured now · 2")).toBeTruthy();
    cleanup();
    // (c) MUTANT: no declared linkage of either kind → no line at all. Nothing
    // in the same namespace is pressed into service as a stand-in.
    const unlinked = render(SettingSheet, { settingId: "context.compactStrategy" });
    expect(unlinked.queryByText(/measured now/)).toBeNull();
  });
});

describe("the ONE write path — broker action, optimistic, read back", () => {
  test("a save awaits the single post-action refresh before claiming confirmed storage", async () => {
    const { getByLabelText, findByText } = render(SettingSheet, { settingId: "tools.parallelCap" });
    let release: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>(resolve => { release = () => { setUiSchemaValues(serverValues); resolve(); }; }));
    setSettingsReaders({ values: refresh });
    try {
      await fireEvent.input(getByLabelText("Parallel tool calls"), { target: { value: "8" } });
      await fireEvent.click(await findByText("Save"));
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(settingsWrites.get().get("tools.parallelCap")?.kind).toBe("pending");
      expect(uiSchemaValues.get()!.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(4);
      expect(document.querySelector(".saved-line")).toBeNull();
      release!();
      await findByText(/^(Saved|Updated)$/ , {selector:".saved-announcement, .saved-line"});
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(uiSchemaValues.get()!.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(8);
    } finally { release?.(); }
  });

  test("mounted readback consumers share one refresh and release the last listener", () => {
    const refresh = vi.fn(async () => undefined);
    setSettingsReaders({ values: refresh });
    const first = bindSettingsReadback(), second = bindSettingsReadback();
    try {
      fireInvalidation("settings:changed");
      expect(refresh).toHaveBeenCalledTimes(1);
      first();
      fireInvalidation("settings:changed");
      expect(refresh).toHaveBeenCalledTimes(2);
      second();
      fireInvalidation("settings:changed");
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally { first(); second(); }
  });
  test("a number saves through POST /api/b/settings.customizations/set and reads back", async () => {
    const { getByLabelText, findByText } = render(SettingSheet, {
      settingId: "tools.parallelCap",
    });
    const field = getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "8" } });
    await fireEvent.click(await findByText("Save"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.url).toMatch(/\/api\/b\/settings\.customizations\/set$/);
    expect(posted[0]!.body).toEqual({ id: "tools.parallelCap", value: 8 });
    // Read-back: the shown value is the server's re-read snapshot.
    expect(await findByText(/^(Saved|Updated)$/ , {selector:".saved-announcement, .saved-line"})).toBeTruthy();
    expect(field.value).toBe("8");
    expect(field.closest(".numeral-row")?.querySelector(".unit")?.textContent).toBe("calls");
  });

  test("a CLEARED number field is refused, not committed as 0 and reported Saved", async () => {
    // `Number("")` is 0: the sheet used to POST the number zero for a blank
    // field, then announce the save. Nobody entered a value, so nothing may
    // travel; the standing value stays and the field says what is missing.
    const { container, getByLabelText, queryByText } = render(SettingSheet, {
      settingId: "tools.parallelCap",
    });
    const field = getByLabelText("Parallel tool calls") as HTMLInputElement;
    for (const blank of ["", "   "]) {
      posted.length = 0;
      await fireEvent.input(field, { target: { value: blank } });
      await fireEvent.click(container.querySelector(".commit")!);
      await waitFor(() => expect(container.querySelector(".failure")).not.toBeNull());
      expect(posted, `blank ${JSON.stringify(blank)} must not be posted`).toEqual([]);
      expect(queryByText("Saved"), "a refused blank must never read Saved").toBeNull();
      expect(container.querySelector(".failure")?.textContent).toMatch(/number/i);
      // The standing value must not move to 0.
      expect(uiSchemaValues.get()!.customizations.find(c => c.id === "tools.parallelCap")?.value).toBe(4);
      expect(field.getAttribute("aria-invalid")).toBe("true");
    }
    // A typed zero is a real answer and still saves.
    posted.length = 0;
    await fireEvent.input(field, { target: { value: "0" } });
    await fireEvent.click(container.querySelector(".commit")!);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.body).toEqual({ id: "tools.parallelCap", value: 0 });
  });

  test("a segmented enum saves the served value on press", async () => {
    const { findByText } = render(SettingSheet, { settingId: "context.compactStrategy" });
    // The button reads WORDS; the wire still carries the served token. Both
    // halves are asserted here because either alone is satisfiable by a bug:
    // pressing a words-labelled button that posts the words would be a 400,
    // and posting the token from a token-labelled button is the defect.
    await fireEvent.click(await findByText("Truncate"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.body).toEqual({ id: "context.compactStrategy", value: "truncate" });
  });

  test("enum choices are offered in WORDS, and the raw token is nowhere a reader can mistake for one", async () => {
    const { container } = render(SettingSheet, { settingId: "context.compactStrategy" });
    const segments = [...container.querySelectorAll<HTMLButtonElement>(".segment")];

    // THE WITNESS (§36). An absence assertion over a DOM that failed to render
    // is indistinguishable from one over a DOM that renders correctly, and
    // this component throws at its render boundary for several reasons — so
    // the token must be FOUND somewhere before "the token is not the label"
    // means anything. It is found in the button's own title, where it belongs:
    // someone reading a request log still needs to connect the two.
    const titles = segments.map((b) => b.title);
    expect(titles, "the witness: every choice still names the token it sends").toEqual([
      "sends \u201Csummarize\u201D",
      "sends \u201Ctruncate\u201D",
      "sends \u201Cdrop-oldest\u201D",
    ]);

    // And now the claim. Per BUTTON, not over the file: a `toEqual` on the
    // whole list is the assertion that cannot be satisfied by one surviving
    // conversion while another site still paints a token.
    const labels = segments.map((b) => b.textContent!.trim());
    expect(labels, "every choice is spelled").toEqual([
      "Summarize",
      "Truncate",
      "Drop oldest",
    ]);
    for (const label of labels) {
      expect(
        /^[a-z]/.test(label) || label.includes("-"),
        `"${label}" is a server token, not words a person chooses between`,
      ).toBe(false);
    }
  });

  test("a switch saves the flipped value on press", async () => {
    const { getByRole, container } = render(SettingSheet, {
      settingId: "editor.atomicWriteEnabled",
    });
    const control = getByRole("switch");
    // The write is armed by the sheet's OWN landed read: while the fresh read
    // is pending the switch is disabled, so press only once it is ready.
    await waitFor(() => expect(control.getAttribute("aria-disabled")).not.toBe("true"));
    await fireEvent.click(control);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.body).toEqual({ id: "editor.atomicWriteEnabled", value: false });
    // §1.4 — one manifestation per fact: the switch prints the state, so the
    // footer does NOT reprint the same value beside it.
    await waitFor(() =>
      expect(container.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false"),
    );
    const reading = container.querySelector(".reading");
    expect(reading === null || reading.textContent!.trim() === "saving").toBe(true);
  });

  test("the refused write's sentence renders plainly and the standing value stands", async () => {
    // The bounds refusal answers 200 with the typed refusal in the envelope;
    // the real fetch door (over this stub) reconstructs the typed ClientError
    // from the family status, so the sheet answers the Save press with the
    // server's own sentence and the standing value never moved. MUTATION:
    // answer a raw 400 instead (the old wire) and the reconstruction is
    // bypassed — and on the live wire the browser would also log the status
    // line the envelope exists to silence.
    failNextSave = {
      status: 428,
      code: "invalid_customization_value",
      message: 'the setting "tools.parallelCap" allows values up to 16 — 999 is above its maximum',
    };
    const { getByLabelText, findByText, container } = render(SettingSheet, {
      settingId: "tools.parallelCap",
    });
    const field = getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "999" } });
    await fireEvent.click(await findByText("Save"));
    expect(
      await findByText('the setting "tools.parallelCap" allows values up to 16 — 999 is above its maximum'),
    ).toBeTruthy();
    expect(await findByText('Enter 16 or less.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toBe('Enter 16 or less.');
    expect(container.querySelector('.refusal-details')?.textContent).toContain('999 is above its maximum');
    // The value the server holds is still the value shown.
    expect(await findByText("4 calls")).toBeTruthy();
    expect(field.value).toBe("999");
    await fireEvent.input(field, { target: { value: "8" } });
    expect(field.getAttribute("aria-invalid")).toBe("false");
    expect(container.querySelector(".input-correction")).toBeNull();
    await fireEvent.click(await findByText("Save"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toEqual({ id: "tools.parallelCap", value: 8 });
    await waitFor(() => expect(field.value).toBe("8"));
  });

  test("a completed save preserves newer typing and repeated Enter sends once", async () => {
    let release!: () => void;
    saveBarrier = new Promise<void>(resolve => { release = resolve; });
    const { getByLabelText, findByText } = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "8" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(posted).toHaveLength(1));
    await fireEvent.input(field, { target: { value: "garbage" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    await fireEvent.input(field, { target: { value: "12" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    expect(posted, "invalid input cannot unlock an unresolved write").toHaveLength(1);
    expect(await findByText("Saving the earlier edit. This draft is not saved yet.")).toBeTruthy();
    release();
    await findByText("8 calls");
    expect(field.value).toBe("12");
    expect(await findByText(/Earlier change saved; this draft is unsaved/)).toBeTruthy();
    await fireEvent.click(await findByText("Save"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toEqual({ id: "tools.parallelCap", value: 12 });
  });

  test.each([false, true])("reset preserves an existing or newer draft on refusal; newer edit: %s", async (newer) => {
    serverValues = { ...VALUES, customizations: VALUES.customizations.map(c => c.id === "tools.parallelCap" ? { id: c.id, value: 9 } : c) } as UiSchemaValues;
    setUiSchemaValues(serverValues);
    let release!: () => void;
    saveBarrier = new Promise<void>(resolve => { release = resolve; });
    failNextSave = { status: 428, code: "invalid_customization_value", message: "Reset refused" };
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = view.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "12" } });
    await fireEvent.click(await view.findByText(/Return to default/));
    await waitFor(() => expect(posted).toHaveLength(1));
    if (newer) await fireEvent.input(field, { target: { value: "14" } });
    release();
    await view.findByText("Reset refused");
    expect(field.value, "refusal keeps the user's unsaved work").toBe(newer ? "14" : "12");
    expect(posted[0]!.body).toEqual({ id: "tools.parallelCap", value: 4 });
  });

  test.each([false, true])("successful reset clears only its unchanged draft; newer edit: %s", async (newer) => {
    serverValues = { ...VALUES, customizations: VALUES.customizations.map(c => c.id === "tools.parallelCap" ? { id: c.id, value: 9 } : c) } as UiSchemaValues;
    setUiSchemaValues(serverValues);
    let release!: () => void;
    saveBarrier = new Promise<void>(resolve => { release = resolve; });
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    const field = view.getByLabelText("Parallel tool calls") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "12" } });
    await fireEvent.click(await view.findByText(/Return to default/));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(field.value, "reset is pending and has not discarded its draft").toBe("12");
    if (newer) await fireEvent.input(field, { target: { value: "14" } });
    release();
    await view.findByText("4 calls");
    await waitFor(() => expect(field.value).toBe(newer ? "14" : "4"));
  });

  test("a late refusal cannot clear or report against a newly selected setting", async () => {
    let release!: () => void;
    saveBarrier = new Promise<void>(resolve => { release = resolve; });
    failNextSave = { status: 428, code: "invalid_customization_value", message: "Original setting refused" };
    const view = render(SettingSheet, { settingId: "tools.parallelCap" });
    await fireEvent.input(view.getByLabelText("Parallel tool calls"), { target: { value: "8" } });
    await fireEvent.click(await view.findByText("Save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    await view.rerender({ settingId: "awareness.enabledSignals" });
    const field = view.getByLabelText("Only watch these readings") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "memory.entryCount" } });
    release();
    await waitFor(() => expect(failNextSave).toBeNull());
    expect(field.value).toBe("memory.entryCount");
    expect(view.queryByText("Original setting refused")).toBeNull();
    await fireEvent.click(await view.findByText("Save"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toEqual({ id: "awareness.enabledSignals", value: "memory.entryCount" });
  });

  test("garbage in the numeral is refused client-side as non-numeric, nothing posted", async () => {
    const { getByLabelText, findByText } = render(SettingSheet, {
      settingId: "tools.parallelCap",
    });
    await fireEvent.input(getByLabelText("Parallel tool calls"), {
      target: { value: "plenty" },
    });
    await fireEvent.click(await findByText("Save"));
    expect(await findByText(/"plenty" is not a number: nothing saved/)).toBeTruthy();
    expect(posted.length).toBe(0);
  });

  test("return to default writes the declared default through the same action", async () => {
    // The SERVER holds 9 — the sheet's open re-read must show it, and the
    // default verb then offers the declared 4.
    serverValues = {
      ...VALUES,
      customizations: VALUES.customizations.map((c) =>
        c.id === "tools.parallelCap" ? { id: c.id, value: 9 } : c,
      ),
    } as UiSchemaValues;
    setUiSchemaValues(serverValues);
    const { findByText } = render(SettingSheet, { settingId: "tools.parallelCap" });
    await fireEvent.click(await findByText(/Return to default/));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.body).toEqual({ id: "tools.parallelCap", value: 4 });
  });
});

describe("cockpit-local preferences — device-side, applied immediately", () => {
  test("density saves to the root attribute with NO network", async () => {
    const { findByText } = render(SettingSheet, { settingId: "cockpit.density" });
    expect(await findByText("Density")).toBeTruthy();
    expect(await findByText(/Kept on this device/)).toBeTruthy();
    // The choice reads in words; the device still stores the served token.
    await fireEvent.click(await findByText("Scan"));
    expect(document.documentElement.dataset.density).toBe("scan");
    expect(posted.length).toBe(0);
  });

  test("a storage write the device refuses is surfaced; the previous value stands", async () => {
    // `persistSet` reports a refused write to the log and returns normally.
    // The local setter used to apply the atom + root attribute first and
    // never read back, so the sheet said "Saved" over a value that was only
    // in memory and would vanish on reload. The write path now confirms the
    // read-back, reverts on refusal, and hands the sheet a typed failure.
    const { findByText, container } = render(SettingSheet, { settingId: "cockpit.density" });
    expect(await findByText("Density")).toBeTruthy();
    expect(localValue("cockpit.density")).toBe("work");
    const refused = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("the bucket is full", "QuotaExceededError");
    });
    try {
      await fireEvent.click(await findByText("Scan"));
      await waitFor(() =>
        expect(container.querySelector(".failure")?.textContent).toMatch(/refused to store|could not be stored/u),
      );
      expect(localValue("cockpit.density")).toBe("work");
      expect(document.documentElement.dataset.density).toBe("work");
      expect(container.querySelector(".saved-line")).toBeNull();
    } finally {
      refused.mockRestore();
    }
  });

  test("a local number saves through the same door and remaps the token, no network", async () => {
    const { getByLabelText, findByText } = render(SettingSheet, { settingId: "cockpit.spacing" });
    expect(await findByText("Spacing step")).toBeTruthy();
    const field = getByLabelText("Spacing step") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "6" } });
    await fireEvent.click(await findByText("Save"));
    expect(document.documentElement.style.getPropertyValue("--sp-unit")).toBe("6px");
    expect(localValue("cockpit.spacing")).toBe(6);
    expect(posted.length).toBe(0);
    await fireEvent.input(field, { target: { value: "4" } });
    await fireEvent.click(await findByText("Save"));
    expect(document.documentElement.style.getPropertyValue("--sp-unit")).toBe("");
  });

  test("Enter on a local number commits through the same door, no network", async () => {
    const { getByLabelText } = render(SettingSheet, { settingId: "cockpit.spacing" });
    const field = getByLabelText("Spacing step") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "6" } });
    await fireEvent.keyDown(field, { key: "Enter" });
    expect(document.documentElement.style.getPropertyValue("--sp-unit")).toBe("6px");
    expect(localValue("cockpit.spacing")).toBe(6);
    expect(posted.length).toBe(0);
  });

  test("the numeral scrub step is the settings-config constant, not a local 6", () => {
    const src = read("src/cockpit/settings/SettingSheet.svelte");
    expect(src).toMatch(/NUMERAL_SCRUB_PX_PER_STEP/);
    expect(src).not.toMatch(/const PX_PER_STEP\s*=\s*6/);
  });

  test("theme flips the cockpit theme attribute both ways", async () => {
    const { findByRole, container } = render(SettingSheet, { settingId: "cockpit.theme" });
    expect(container.querySelector('.setting-details')).toBeNull();
    await fireEvent.click(await findByRole("radio", { name: "Logbook" }));
    expect(document.documentElement.getAttribute("data-cockpit-theme")).toBe("light");
    await fireEvent.click(await findByRole("radio", { name: "Carbon" }));
    expect(document.documentElement.getAttribute("data-cockpit-theme")).toBeNull();
  });

  test("an out-of-contract local value is refused unchanged (plain sentence)", () => {
    expect(() => setLocalPref("cockpit.density", "ultradense")).toThrow(/refused unchanged/);
    expect(document.documentElement.dataset.density).not.toBe("ultradense");
  });

  test("debug logging drives the ONE client emit owner both ways, with NO network", async () => {
    // The evidence is the emission itself, not the row: clientWarn writes the
    // console only when the emit owner was actually configured on.
    const warned: unknown[][] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    try {
      expect(isClientDebugEnabled()).toBe(false); // off by default, zero overhead
      clientWarn("test", "silent while off");
      expect(warned.length).toBe(0);

      const { findByText, findByRole } = render(SettingSheet, { settingId: "cockpit.debug" });
      expect(await findByText("Debug logging")).toBeTruthy();
      await fireEvent.click(await findByRole("radio", { name: "On" }));
      expect(isClientDebugEnabled()).toBe(true);
      clientWarn("test", "emits while on");
      expect(warned.length).toBe(1);
      expect(warned[0]).toEqual(["[test]", "emits while on"]);

      await fireEvent.click(await findByRole("radio", { name: "Off" }));
      expect(isClientDebugEnabled()).toBe(false);
      clientWarn("test", "silent again");
      expect(warned.length).toBe(1);
      expect(posted.length).toBe(0); // device-side: nothing travels
    } finally {
      spy.mockRestore();
    }
  });

  test("a kept debug choice is restored at boot; garbage restores OFF (deny by default)", () => {
    window.localStorage.setItem("bridlewise:cockpitDebug", "on");
    applyStoredCockpitPrefs();
    expect(isClientDebugEnabled()).toBe(true);
    expect(localValue("cockpit.debug")).toBe("on");

    window.localStorage.setItem("bridlewise:cockpitDebug", "definitely-not-a-choice");
    applyStoredCockpitPrefs();
    expect(isClientDebugEnabled()).toBe(false);
    expect(localValue("cockpit.debug")).toBe("off");
  });

  test("an out-of-contract debug value is refused unchanged and the emit owner stays put", () => {
    setLocalPref("cockpit.debug", "on");
    expect(() => setLocalPref("cockpit.debug", "verbose")).toThrow(/refused unchanged/);
    expect(isClientDebugEnabled()).toBe(true);
    setLocalPref("cockpit.debug", "off");
  });
});

describe("an OBJECT setting — the standing value is readable, the draft stays raw", () => {
  /** A schema with one object-typed setting, local to this describe so the
   * shared fixture's row counts (which other suites assert) do not move. */
  function objectSchema(): { schema: UiSchema; values: UiSchemaValues } {
    const schema = {
      ...SCHEMA,
      settings: [
        {
          id: "tools.retryPolicy",
          label: "Retry policy",
          description: "How a failed tool call is retried.",
          type: "object",
          default: { attempts: 1 },
          customizationId: "tools.retryPolicy",
          module: "tools",
        },
      ],
    } as unknown as UiSchema;
    const values = {
      ...VALUES,
      customizations: [
        { id: "tools.retryPolicy", value: { attempts: 3, backoff: { baseMs: 200, factor: 2 } } },
      ],
    } as unknown as UiSchemaValues;
    return { schema, values };
  }

  test("the READ view is the shared JSON tree over the standing value; the DRAFT is the raw textarea", async () => {
    const { schema, values } = objectSchema();
    setUiSchema(schema);
    setUiSchemaValues(values);
    // The sheet re-reads on mount; the readers must serve THIS schema or
    // the row vanishes mid-test.
    setSettingsReaders({
      schema: async () => setUiSchema(schema),
      values: async () => setUiSchemaValues(values),
    });
    const { findByText, container } = render(SettingSheet, { settingId: "tools.retryPolicy" });
    await findByText("Retry policy");

    // The read view renders through JsonNode — recorded key order, real
    // child counts — not a second bespoke printer.
    const read = container.querySelector(".object-read");
    expect(read).not.toBeNull();
    expect(read!.querySelector(".node")).not.toBeNull();
    expect(read!.textContent).toContain("attempts");
    expect(read!.textContent).toContain("3");

    // The editable draft stays a raw textarea carrying the same value as
    // JSON text — the two answer different questions and BOTH render.
    const field = container.querySelector<HTMLTextAreaElement>("textarea.object-field");
    expect(field).not.toBeNull();
    expect(JSON.parse(field!.value)).toEqual({
      attempts: 3,
      backoff: { baseMs: 200, factor: 2 },
    });
  });

  test("a refused object draft stays editable and a corrected retry saves the object", async () => {
    const { schema, values } = objectSchema();
    serverValues = values;
    setUiSchema(schema); setUiSchemaValues(values);
    setSettingsReaders({ schema: async () => setUiSchema(schema), values: async () => setUiSchemaValues(serverValues) });
    failNextSave = { status: 428, code: "invalid_customization_value", message: "Retry limit refused" };
    const view = render(SettingSheet, { settingId: "tools.retryPolicy" });
    const field = view.getByLabelText("Retry policy") as HTMLTextAreaElement;
    await fireEvent.input(field, { target: { value: '{"attempts":999}' } });
    await fireEvent.click(await view.findByText("Save"));
    await view.findByText("Retry limit refused");
    expect(field.value).toBe('{"attempts":999}');
    await fireEvent.input(field, { target: { value: '{"attempts":2}' } });
    await fireEvent.click(await view.findByText("Save"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]!.body).toEqual({ id: "tools.retryPolicy", value: { attempts: 2 } });
  });

  test("invalid object drafts cannot unlock a pending save through the action handler", async () => {
    const { schema, values } = objectSchema();
    serverValues = values;
    setUiSchema(schema); setUiSchemaValues(values);
    setSettingsReaders({ schema: async () => setUiSchema(schema), values: async () => setUiSchemaValues(serverValues) });
    let release!: () => void;
    saveBarrier = new Promise<void>(resolve => { release = resolve; });
    const view = render(SettingSheet, { settingId: "tools.retryPolicy" });
    const field = view.getByLabelText("Retry policy") as HTMLTextAreaElement;
    const saveButton = await view.findByText("Save");
    await fireEvent.input(field, { target: { value: '{"attempts":5}' } });
    await fireEvent.click(saveButton);
    await waitFor(() => expect(posted).toHaveLength(1));
    for (const value of ['{', '[]', '{"attempts":7}']) {
      await fireEvent.input(field, { target: { value } });
      // Dispatch reaches the handler even when native pointer activation is disabled.
      await fireEvent.click(saveButton);
    }
    expect(posted, "JSON validation must not release pending ownership").toHaveLength(1);
    release();
    await waitFor(() => expect(view.container.querySelector('.saved-line')).not.toBeNull());
    expect(field.value).toBe('{"attempts":7}');
  });

  test("no standing value → no read view, and the absence is already worded by the footer", async () => {
    const { schema } = objectSchema();
    const bare = { ...VALUES, customizations: [] } as unknown as UiSchemaValues;
    setUiSchema(schema);
    setUiSchemaValues(bare);
    setSettingsReaders({
      schema: async () => setUiSchema(schema),
      values: async () => setUiSchemaValues(bare),
    });
    const { findByText, container } = render(SettingSheet, { settingId: "tools.retryPolicy" });
    await findByText("Retry policy");
    expect(container.querySelector(".object-read")).toBeNull();
    expect(await findByText("Value not read yet")).toBeTruthy();
    expect(container.querySelector('.reading')?.textContent?.match(/not read yet/gi)).toHaveLength(1);
    expect(container.querySelector('.reading strong')).toBeNull();
  });

  test("a raw ARRAY through the object draft is refused locally — the dead-on-save class stays prevented", async () => {
    // The row grammar holds scalars and JSON objects; an array is the shape
    // the sheet refuses BY DESIGN, and the array-valued leaves are served by
    // their own section doors instead (the diagnostic-modes list). This arm
    // pins the refusal at the sheet: an array pasted into the object draft
    // never reaches the wire, and the sentence says what the setting holds.
    const { schema, values } = objectSchema();
    setUiSchema(schema);
    setUiSchemaValues(values);
    setSettingsReaders({
      schema: async () => setUiSchema(schema),
      values: async () => setUiSchemaValues(values),
    });
    const { findByText, container } = render(SettingSheet, { settingId: "tools.retryPolicy" });
    await findByText("Retry policy");
    const field = container.querySelector<HTMLTextAreaElement>("textarea.object-field")!;
    await fireEvent.input(field, { target: { value: '["cpu", "memory"]' } });
    await fireEvent.click(await findByText("Save"));
    expect(await findByText("this setting holds a JSON object: nothing saved")).toBeTruthy();
    expect(posted.length).toBe(0);
  });
});

describe("a value the display egress masks — the read-back is the proof, never a prefill", () => {
  /** A credential-shaped value, the class the free-form string rows accept. */
  const RAW = ("sk" + "-live-r48-sheet-proof-7742a1c9");

  test("the save lands and the sheet shows the server's masked read-back — the raw never stays on screen", async () => {
    maskNextSave = true;
    const { findByText, queryByText, getByLabelText, container } = render(SettingSheet, {
      settingId: "awareness.enabledSignals",
    });
    await findByText("Only watch these readings");
    const field = getByLabelText("Only watch these readings") as HTMLInputElement;
    await fireEvent.input(field, { target: { value: RAW } });
    await fireEvent.click(await findByText("Save"));
    await waitFor(() => expect(posted.length).toBe(1));
    // The POST carried the RAW — the client's own action, what was sent.
    expect(posted[0]!.body).toEqual({ id: "awareness.enabledSignals", value: RAW });
    // The paint became the server's masked read-back; the raw is gone from
    // the sheet — the server hid it, and it has no business staying on screen.
    expect(await findByText(MASKED_FORM)).toBeTruthy();
    await waitFor(() => expect(queryByText(RAW)).toBeNull());
    // The note's claim is now literally true: what is shown IS the read-back.
    expect(await findByText(/^(Saved|Updated)$/ , {selector:".saved-announcement, .saved-line"})).toBeTruthy();
    expect(container.querySelector('.reading strong')?.textContent).toBe(MASKED_FORM);
    // The editable field carries the masked form as a PLACEHOLDER, never as
    // its value.
    await waitFor(() => {
      expect((field as HTMLInputElement).value).toBe("");
      expect((field as HTMLInputElement).placeholder).toBe(MASKED_FORM);
    });
    // The read-back re-read reconciled: the store's masked entry answered
    // equal to the painted answer, so the choice retired and the standing
    // display is the server's entry.
    await waitFor(() => expect(container.querySelector(".reading")!.textContent).toContain(MASKED_FORM));
  });

  test("a fresh open never prefills the masked literal — the placeholder shows it, an edit starts empty, and the save cannot carry the mask", async () => {
    // The standing value is already masked (a credential saved earlier).
    serverValues = {
      ...VALUES,
      customizations: VALUES.customizations.map((c) =>
        c.id === "awareness.enabledSignals" ? { id: c.id, value: MASKED_FORM, masked: true } : c,
      ),
    } as UiSchemaValues;
    const { findByText, getByLabelText, container } = render(SettingSheet, {
      settingId: "awareness.enabledSignals",
    });
    await findByText("Only watch these readings");
    const field = getByLabelText("Only watch these readings") as HTMLInputElement;
    await waitFor(() => {
      // Never the mask as the input's value; the mask is the placeholder —
      // the read-only display of what stands.
      expect(field.value).toBe("");
      expect(field.placeholder).toBe(MASKED_FORM);
    });
    // The reading names what stands, in its served (masked) form.
    expect(container.querySelector(".reading")!.textContent).toContain(MASKED_FORM);
    // Nothing typed — the save verb is disabled: the prefill→edit→save arc
    // that wrote the mask back as data is structurally dead.
    const saveVerb = [...container.querySelectorAll<HTMLButtonElement>("button.save")].find((b) =>
      /Save/.test(b.textContent ?? ""),
    )!;
    expect(saveVerb.getAttribute("aria-disabled")).toBe("true");
    await fireEvent.click(saveVerb);
    expect(posted).toHaveLength(0);
    // Retyping the exact masked literal is NO CHANGE to send — the verb
    // stays disabled, so even a deliberate copy of the placeholder cannot
    // be posted back as the value.
    await fireEvent.input(field, { target: { value: MASKED_FORM } });
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button.save")].find((b) => /Save/.test(b.textContent ?? ""))!
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await fireEvent.click(saveVerb);
    expect(posted).toHaveLength(0);
    // A real edit posts the TYPED value, never the mask.
    await fireEvent.input(field, { target: { value: "search.queryCount" } });
    const enabled = [...container.querySelectorAll<HTMLButtonElement>("button.save")].find((b) =>
      /Save/.test(b.textContent ?? ""),
    )!;
    expect(enabled.getAttribute("aria-disabled")).toBe("false");
    await fireEvent.keyDown(field, {key: "Enter"});
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.body).toEqual({ id: "awareness.enabledSignals", value: "search.queryCount" });
    expect(JSON.stringify(posted[0]!.body)).not.toContain(MASKED_FORM);
  });
});


test.each(["next-run", "restart"] as const)("%s timing stays visible beside the saved value", async (effect) => {
  setUiSchema({...SCHEMA, settings: SCHEMA.settings.map(s => s.customizationId === "tools.parallelCap" ? {...s, effect} : s)});
  const {container} = render(SettingSheet, {settingId:"tools.parallelCap"});
  const timing = container.querySelector('.effect-timing');
  expect(timing?.textContent).toBe(effect === 'restart' ? 'takes effect after a restart' : 'takes effect on the next run');
  expect(timing?.closest('details')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[name]')?.value).toBe('4');
  expect(container.querySelector('.unit')?.textContent).toBe('calls');
});

test.each([
  ['tools.parallelCap','12',true,13], ['tools.parallelCap','12',false,229],
  ['awareness.enabledSignals','search.queryCount',true,13], ['awareness.enabledSignals','search.queryCount',false,229],
] as const)('composition Enter preserves %s draft %s (isComposing=%s, keyCode=%s)', async (settingId, value, isComposing, keyCode) => {
  const {container} = render(SettingSheet, {settingId});
  const input = container.querySelector<HTMLInputElement>('input[name]')!;
  await fireEvent.compositionStart(input);
  await fireEvent.input(input, {target:{value}, isComposing:true});
  await fireEvent.keyDown(input, {key:'Enter',code:'Enter',isComposing,keyCode});
  expect(posted, 'composition confirmation is not setting submission').toHaveLength(0);
  expect(input.value).toBe(value);
  await fireEvent.compositionEnd(input);
  await fireEvent.keyDown(input, {key:'Enter',code:'Enter',isComposing:false,keyCode:13});
  await waitFor(() => expect(posted).toHaveLength(1));
});

test('ordinary Enter announces confirmed success in the local polite status while focus stays in the editor',async()=>{
  const {container,getByLabelText}=render(SettingSheet,{settingId:'tools.parallelCap'});
  const input=getByLabelText('Parallel tool calls') as HTMLInputElement;input.focus();
  await fireEvent.input(input,{target:{value:'8'}});await fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(container.querySelector('[data-setting-sheet]')?.getAttribute('data-edit-state')).toBe('saved'));
  const status=container.querySelector('[role="status"][aria-live="polite"]');
  expect(status?.textContent?.trim()).toBe('Saved');expect(status?.querySelector('[hidden],[aria-hidden="true"]')).toBeNull();
  expect(document.activeElement).toBe(input);expect(input.value).toBe('8');expect(posted).toHaveLength(1);
  await fireEvent.input(input,{target:{value:'12'}});
  expect(status?.querySelector('.saved-announcement')).toBeNull();
});
