// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("a published replay surrenders every client network entrance", () => {
  test("boot closes network before entering any deferred product graph", async () => {
    const gate = await import("../../src/data/network-access.ts");
    expect(gate.clientNetworkAccess()).toEqual({ allowed: true });
    const persistence = await import("../../src/state/persistence.ts");
    const observed: Array<{ root: string; access: ReturnType<typeof gate.clientNetworkAccess>; storageKey: string; rawKey: string }> = [];
    const enter = (root: string) => observed.push({ root, access: gate.clientNetworkAccess(), storageKey: persistence.storageKeyFor("boot-proof"), rawKey: persistence.rawStorageKeyFor("boot-proof") });
    const Demo = Symbol("Demo");
    const record = Object.freeze({ fixture: "boot sentinel" });
    const pageLinks = { workspaceHref: "../docs/quickstart/", homeHref: "../" } satisfies Omit<typeof import("virtual:bridlewise-public-replay"), "default">;
    const mount = vi.fn();
    const target = document.createElement("div");
    target.id = "demo";
    document.body.append(target);
    vi.doMock("svelte", () => { enter("svelte"); return { mount }; });
    vi.doMock("../../src/demo/Demo.svelte", () => { enter("Demo"); return { default: Demo }; });
    vi.doMock("virtual:bridlewise-public-replay", () => { enter("record"); return { default: record, ...pageLinks }; });
    try {
      await import("../../src/demo/main.ts");
      await vi.dynamicImportSettled();
      const { REPLAY_NETWORK_REASON } = await import("../../src/demo/replay.ts");
      expect(observed.map(({ root }) => root).sort()).toEqual(["Demo", "record", "svelte"]);
      for (const { access, storageKey, rawKey } of observed) {
        expect(access).toEqual({ allowed: false, reason: REPLAY_NETWORK_REASON });
        expect(storageKey).toBe("bridlewise:scope:public-fixture-v2:logical:boot-proof");
        expect(rawKey).toBe("bridlewise:scope:public-fixture-v2:raw:boot-proof");
      }
      expect(mount).toHaveBeenCalledExactlyOnceWith(Demo, { target, props: { record, ...pageLinks, embedded: false } });
      expect(persistence.storageKeyFor("boot-proof")).toBe("bridlewise:scope:public-fixture-v2:logical:boot-proof");
      expect(() => persistence.selectPersistenceNamespace("personal")).toThrowError(/already fixed/u);
    } finally {
      await vi.dynamicImportSettled();
      vi.doUnmock("svelte");
      vi.doUnmock("../../src/demo/Demo.svelte");
      vi.doUnmock("virtual:bridlewise-public-replay");
      target.remove();
    }
  });

  test("closing is explicit, permanent and keeps the first explanation", async () => {
    const gate = await import("../../src/data/network-access.ts");
    expect(gate.clientNetworkAccess()).toEqual({ allowed: true });
    expect(() => gate.closeClientNetwork("  ")).toThrow(/reason/u);
    gate.assertClientNetwork();
    gate.closeClientNetwork("Published fixture: no live session exists.");
    gate.closeClientNetwork("A later caller cannot replace the authority.");
    expect(gate.clientNetworkAccess()).toEqual({
      allowed: false,
      reason: "Published fixture: no live session exists.",
    });
    expect(() => gate.assertClientNetwork()).toThrowError(
      expect.objectContaining({ code: gate.CLIENT_NETWORK_CLOSED }),
    );
  });

  test("Broker reads and writes refuse before fetch or connection bookkeeping", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const { fetchJson } = await import("../../src/data/broker.ts");
    const fetchSpy = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    gate.closeClientNetwork("This published replay cannot contact an API.");
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      await expect(fetchJson("/planted-live-request", { method })).rejects.toMatchObject({
        code: gate.CLIENT_NETWORK_CLOSED,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("liveness stream, its probe, and run stream refuse at their native doors", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const client = await import("../../src/client.ts");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const eventSourceSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("EventSource", eventSourceSpy);
    gate.closeClientNetwork("No network is admitted for this published replay.");
    expect(() => client.openLivenessStream({ onAlive: () => {}, onDown: () => {} }))
      .toThrowError(expect.objectContaining({ code: gate.CLIENT_NETWORK_CLOSED }));
    await expect(client.diagnoseLivenessConnection()).rejects.toMatchObject({
      code: gate.CLIENT_NETWORK_CLOSED,
    });
    expect(() => client.openRunStream("planted-run", {}))
      .toThrowError(expect.objectContaining({ code: gate.CLIENT_NETWORK_CLOSED }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(eventSourceSpy).not.toHaveBeenCalled();
  });

  test("cached reads and actions refuse before provenance or invalidation", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const broker = await import("../../src/data/broker.ts");
    const ledger = await import("../../src/data/ledger.ts");
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { saved: true }, meta: { etag: "fixture-1", asOf: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(broker.read("fixture.public", { ttlMs: 60_000 })).resolves.toEqual({ saved: true });
    const readsBefore = ledger.provenanceLog().length;
    const actionsBefore = ledger.actionLog().length;
    fetchSpy.mockClear();
    gate.closeClientNetwork("The archived record has no live read or action authority.");
    await expect(broker.read("fixture.public", { ttlMs: 60_000 })).rejects.toMatchObject({ code: gate.CLIENT_NETWORK_CLOSED });
    await expect(broker.action("fixture.public", "planted-write", {})).rejects.toMatchObject({ code: gate.CLIENT_NETWORK_CLOSED });
    expect(ledger.provenanceLog()).toHaveLength(readsBefore);
    expect(ledger.actionLog()).toHaveLength(actionsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("telemetry cannot bypass the closed transport through its unload beacon", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const telemetry = await import("../../src/state/telemetry.ts");
    telemetry.resetTelemetry();
    const beaconSpy = vi.fn(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon: beaconSpy });
    vi.stubGlobal("fetch", fetchSpy);
    telemetry.captureError({ message: "Planted archive observation" });
    gate.closeClientNetwork("The public fixture has no telemetry server.");
    await expect(telemetry.flushViaBeacon()).resolves.toBe(false);
    await expect(telemetry.flushTelemetry()).resolves.toEqual({ sent: 0, refused: true });
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a CSRF retry cannot cross a network door closed after the first attempt", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const { fetchJson } = await import("../../src/data/broker.ts");
    const fetchSpy = vi.fn(async () => {
      gate.closeClientNetwork("The page surrendered its network capability.");
      return new Response(JSON.stringify({ error: "csrf_blocked", message: "Planted pre-dispatch refusal" }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchJson("/planted-retry", { method: "POST" })).rejects.toMatchObject({ code: gate.CLIENT_NETWORK_CLOSED });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a closed transport still drains bounded telemetry and accounts for every refused observation", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const telemetry = await import("../../src/state/telemetry.ts");
    const { TELEMETRY_FLUSH_MAX_EVENTS } = await import("../../src/client-config.ts");
    telemetry.resetTelemetry();
    const sink = vi.fn(async () => true);
    telemetry.installTelemetrySink(sink);
    gate.closeClientNetwork("This fixture has no telemetry transport.");
    const count = TELEMETRY_FLUSH_MAX_EVENTS * 4 + 3;
    for (let index = 0; index < count; index += 1) {
      telemetry.captureError({ message: "Planted bounded observation", index });
      expect(telemetry.telemetryVolume().buffered).toBeLessThan(TELEMETRY_FLUSH_MAX_EVENTS);
      await telemetry.flushTelemetry();
    }
    expect(telemetry.telemetryVolume()).toEqual({ buffered: 0, dropped: count });
    expect(sink).not.toHaveBeenCalled();
  });

  test("closed telemetry pressure stays bounded without a caller flushing each event", async () => {
    const gate = await import("../../src/data/network-access.ts");
    const telemetry = await import("../../src/state/telemetry.ts");
    const { TELEMETRY_FLUSH_MAX_EVENTS } = await import("../../src/client-config.ts");
    telemetry.resetTelemetry();
    const sink = vi.fn(async () => true);
    telemetry.installTelemetrySink(sink);
    gate.closeClientNetwork("No telemetry authority.");
    const count = TELEMETRY_FLUSH_MAX_EVENTS * 4 + 3;
    for (let index = 0; index < count; index += 1) {
      telemetry.captureError({ message: "Planted burst observation", index });
      expect(telemetry.telemetryVolume().buffered).toBeLessThan(TELEMETRY_FLUSH_MAX_EVENTS);
    }
    await telemetry.flushTelemetry();
    expect(telemetry.telemetryVolume()).toEqual({ buffered: 0, dropped: count });
    await telemetry.flushViaBeacon();
    expect(telemetry.telemetryVolume()).toEqual({ buffered: 0, dropped: count });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("public boot isolates private browser values before the real component graph", () => {
  test("private local, tab and legacy marks values remain unread and unchanged", async () => {
    localStorage.clear(); sessionStorage.clear();
    const local = { "bridlewise:cockpitTheme": "carbon", "bridlewise:projects:lastKnown": JSON.stringify([{ id: "private-project", name: "Private sentinel", path: "/private-sentinel", createdAt: "2026-01-01", updatedAt: "2026-01-01" }]), "bridlewise:currentProjectId": "private-project", "bridlewise:currentChatId": "private-chat", "cockpit.sweep.marks.v1": "private-marks", "cockpit.sweep.arms.v1": "private-arms" };
    const tab = { "bridlewise:currentProjectId": "private-project", "bridlewise:currentChatId": "private-chat", "bridlewise:workspaces": JSON.stringify([{ id: "private-workspace", projectId: "private-project", chatId: "private-chat", label: null }]), "bridlewise:workspaces:active": "private-workspace", "bridlewise:ws:private-workspace:flow:scroll": "123" };
    for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(tab)) sessionStorage.setItem(key, value);
    const privateKeys = new Set([...Object.keys(local), ...Object.keys(tab)]);
    const get = vi.spyOn(Storage.prototype, "getItem"), set = vi.spyOn(Storage.prototype, "setItem"), remove = vi.spyOn(Storage.prototype, "removeItem");
    try {
      const persistence = await import("../../src/state/persistence.ts");
      persistence.selectPersistenceNamespace("public-graph");
      const gate = await import("../../src/data/network-access.ts");
      gate.closeClientNetwork("The public graph has no execution capability.");
      await import("../../src/demo/Demo.svelte");
      const prefs = await import("../../src/cockpit/settings/local-prefs.ts");
      const defaultWrites = set.mock.calls.length;
      prefs.applyLocalPrefDefault(prefs.THEME_ID, "logbook");
      expect(prefs.cockpitTheme.get()).toBe("logbook");
      expect(set.mock.calls.length).toBe(defaultWrites);
      prefs.setLocalPref(prefs.THEME_ID, "carbon");
      const explicitWrites = set.mock.calls.length;
      prefs.applyLocalPrefDefault(prefs.THEME_ID, "logbook");
      expect(prefs.cockpitTheme.get()).toBe("carbon");
      expect(set.mock.calls.length).toBe(explicitWrites);
      const projects = await import("../../src/state/projects.ts");
      const chats = await import("../../src/state/chats.ts");
      expect(projects.projects.get()).toEqual([]);
      expect(projects.currentProjectId.get()).toBeNull();
      expect(chats.currentChatId.get()).toBeNull();
      expect([...get.mock.calls, ...set.mock.calls, ...remove.mock.calls].some(([key]) => privateKeys.has(key))).toBe(false);
    } finally {
      get.mockRestore(); set.mockRestore(); remove.mockRestore();
      for (const [key, value] of Object.entries(local)) expect(localStorage.getItem(key)).toBe(value);
      for (const [key, value] of Object.entries(tab)) expect(sessionStorage.getItem(key)).toBe(value);
      localStorage.clear(); sessionStorage.clear();
    }
  });
});
