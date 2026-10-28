// @vitest-environment jsdom
/**
 * THE ANNUNCIATORS MUST LIGHT (§2.4) — the wire, not just the surface.
 *
 * The defect this file exists to make impossible again: `setAnnunciators`
 * was declared, rendered, capped at three — and had ZERO callers, so the
 * §2.4 surface was permanently dark while a live `check: … → failed`
 * transition played out under it. "Correct and unplugged", on the
 * instrument whose job is abnormality.
 *
 * Two halves:
 *   1. the DERIVATION (shell/annunciator-data.ts): which abnormal facts
 *      light a slot, from the real stores, with operable verbs;
 *   2. the PLUG-PROOF: a REAL Cockpit mount in which a driven failed check
 *      produces a lit annunciator button in the HORIZON. This half fails
 *      if the feed loses its consumer — an unconsumed `setAnnunciators`
 *      cannot pass it, whatever the derivation says.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

// The broker is mocked so verb.run is observable without a network; the
// mock also keeps the full-cockpit half free of unstubbed block reads.
vi.mock("../../src/data/broker.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/data/broker.ts")>();
  return {
    ...real,
    action: vi.fn(async () => ({})),
    read: vi.fn(async () => {
      throw new Error("no block reads in this harness");
    }),
  };
});
vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  loadRoom: async () => null,
  roomExists: () => false,
}));

import { action } from "../../src/data/broker.ts";
import Cockpit from "../../src/cockpit/Cockpit.svelte";
import { horizonAnnunciators } from "../../src/cockpit/shell/annunciator-data.ts";
import {
  resetAutoChecks,
  upsertAutoChecks,
  type AutoCheck,
} from "../../src/state/auto-checks.ts";
import {
  resetProjects,
  selectProject,
  setProjects,
} from "../../src/state/projects.ts";
import { selectChat } from "../../src/state/chats.ts";
import {
  breakerLoads,
  resetDeskFeed,
  setDeskIo,
} from "../../src/cockpit/desk/desk-feed.ts";
import { resetUiSchema } from "../../src/state/schema-store.ts";
import { armedTriggers } from "../../src/cockpit/sweep/sweep-store.ts";
import { pendingBandGo } from "../../src/cockpit/sweep/band-request.ts";
import { until } from "../helpers/until.ts";

const actionMock = vi.mocked(action);

function check(
  id: string,
  name: string,
  status: AutoCheck["status"],
  createdAt: string,
  projectId = "p1",
): AutoCheck {
  return {
    id,
    projectId,
    chatId: null,
    checkName: name,
    status,
    output: { errorCount: 3 },
    createdAt,
  };
}

const PROJECT = {
  id: "p1",
  name: "harness",
  path: "/tmp/harness",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  resetAutoChecks();
  resetProjects();
  resetDeskFeed();
  selectChat(null);
  armedTriggers.set([]);
  actionMock.mockClear();
});
afterEach(() => {
  resetAutoChecks();
  resetProjects();
  resetDeskFeed();
  selectChat(null);
  armedTriggers.set([]);
});

describe("the derivation — what lights a slot", () => {
  test("a failing latest check lights `1 check failing` with an operable rerun verb", () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([
      check("k1", "lint", "passed", "2026-07-30T10:00:00Z"),
      check("k2", "lint", "failed", "2026-07-30T11:00:00Z"),
    ]);
    const lit = horizonAnnunciators.get();
    expect(lit).toHaveLength(1);
    expect(lit[0]!.label).toBe("1 check failing");
    expect(lit[0]!.verb.label).toBe("run again");
    expect(lit[0]!.reason).toContain("lint");
    lit[0]!.verb.run();
    expect(actionMock).toHaveBeenCalledWith(
      "checks.auto",
      "rerun",
      { projectId: "p1" },
      { invalidates: ["check:complete"] },
    );
  });

  test("a newer PASSED result puts the slot out — the latest settled row decides", () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([
      check("k1", "lint", "failed", "2026-07-30T10:00:00Z"),
      check("k2", "lint", "passed", "2026-07-30T11:00:00Z"),
    ]);
    expect(horizonAnnunciators.get()).toEqual([]);
  });

  test("a RUNNING re-measure neither fails nor clears — the last settled result stands", () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([
      check("k1", "typecheck", "failed", "2026-07-30T10:00:00Z"),
      check("k2", "typecheck", "running", "2026-07-30T11:00:00Z"),
    ]);
    const lit = horizonAnnunciators.get();
    expect(lit).toHaveLength(1);
    expect(lit[0]!.label).toBe("1 check failing");
  });

  test("another project's failures do not light this project's slots", () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([check("k1", "lint", "failed", "2026-07-30T10:00:00Z", "p-other")]);
    expect(horizonAnnunciators.get()).toEqual([]);
  });

  test("a tripped breaker lights a slot whose reset verb drives the real act", async () => {
    const act = vi.fn(async () => ({}));
    setDeskIo({
      act,
      breaker: vi.fn(async () => []),
    });
    selectChat("c1");
    breakerLoads.set({
      c1: {
        kind: "measured",
        asOf: Date.now(),
        rows: [
          { id: "execute_command", label: "run a command", state: "tripped", calls: 4 },
          { id: "read_file", label: "read a file", state: "on", calls: 9 },
        ],
      },
    });
    const lit = horizonAnnunciators.get();
    expect(lit).toHaveLength(1);
    expect(lit[0]!.label).toBe("1 breaker tripped");
    expect(lit[0]!.verb.label).toBe("reset");
    expect(lit[0]!.reason).toContain("run a command");
    lit[0]!.verb.run();
    await Promise.resolve();
    expect(act).toHaveBeenCalledWith(
      "tools.breaker",
      "reset",
      { tool: "execute_command" },
      ["tools:changed"],
    );
  });

  test("healthy everything = dark everything", () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([check("k1", "lint", "passed", "2026-07-30T10:00:00Z")]);
    expect(horizonAnnunciators.get()).toEqual([]);
  });

  // ── THE FIRED-TRIGGER FAMILY — the third abnormal family, in the ONE
  // derivation. Aerospace annunciator semantics: the lamp lit when its
  // condition occurred and stays lit until acknowledged (the arm menu's
  // clear or re-arm); priority below checks and breakers; the reason names
  // WHAT fired and when (§1.5); the verb is the way there.
  test("a fired trigger lights `1 trigger fired` with a go verb that plants the band at the instant", () => {
    armedTriggers.set([
      Object.freeze({
        id: "arm-1",
        kind: "custom",
        param: "tool.name == 'edit' && tool.failed",
        predicate: "tool.name == 'edit' && tool.failed",
        scope: "chat",
        armedAtMs: 1,
        firedAtMs: 1_777_000_000_000,
        storage: "ledger",
      }),
    ]);
    const lit = horizonAnnunciators.get();
    expect(lit).toHaveLength(1);
    expect(lit[0]!.id).toBe("arm-fired");
    expect(lit[0]!.label).toBe("1 trigger fired");
    expect(lit[0]!.verb.label).toBe("go");
    // The reason names what fired (§1.5 F1).
    expect(lit[0]!.reason).toContain("edit");
    expect(lit[0]!.reason).toContain("go plants the band");
    // The verb is the band seam: the request lands, one-shot.
    lit[0]!.verb.run();
    expect(pendingBandGo.get()).toBe(1_777_000_000_000);
  });

  test("the fired light counts every fired row and goes to the LATEST firing", () => {
    armedTriggers.set([
      Object.freeze({
        id: "arm-1", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: 1_000, storage: "local",
      }),
      Object.freeze({
        id: "arm-2", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: 9_000, storage: "local",
      }),
      Object.freeze({
        id: "arm-3", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: null, storage: "local",
      }),
    ]);
    const lit = horizonAnnunciators.get();
    expect(lit).toHaveLength(1);
    expect(lit[0]!.label).toBe("2 triggers fired");
    lit[0]!.verb.run();
    expect(pendingBandGo.get()).toBe(9_000);
  });

  test("a COCKED trigger lights nothing — only a firing is a fact to tell", () => {
    armedTriggers.set([
      Object.freeze({
        id: "arm-1", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: null, storage: "local",
      }),
    ]);
    expect(horizonAnnunciators.get()).toEqual([]);
  });

  test("clearing the fired row (or re-arming) acknowledges the light — nothing clears on its own", () => {
    const row = Object.freeze({
      id: "arm-1", kind: "tool-errors", param: null, predicate: null, scope: "chat",
      armedAtMs: 1, firedAtMs: 1_000, storage: "local",
    });
    armedTriggers.set([row]);
    expect(horizonAnnunciators.get()).toHaveLength(1);
    // Re-armed: cocked again, the lamp is out.
    armedTriggers.set([Object.freeze({ ...row, firedAtMs: null })]);
    expect(horizonAnnunciators.get()).toEqual([]);
    // Fired again: the lamp is back.
    armedTriggers.set([Object.freeze({ ...row, firedAtMs: 2_000 })]);
    expect(horizonAnnunciators.get()).toHaveLength(1);
  });

  test("PRIORITY: with checks failing, a breaker tripped and a trigger fired, all three fit — the fired family sits LAST", async () => {
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([check("k1", "lint", "failed", new Date().toISOString())]);
    setDeskIo({ act: vi.fn(async () => ({})), breaker: vi.fn(async () => []) });
    selectChat("c1");
    breakerLoads.set({
      c1: {
        kind: "measured",
        asOf: Date.now(),
        rows: [{ id: "execute_command", label: "run a command", state: "tripped", calls: 4 }],
      },
    });
    armedTriggers.set([
      Object.freeze({
        id: "arm-1", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: 1_000, storage: "local",
      }),
    ]);
    const lit = horizonAnnunciators.get();
    expect(lit.map((s) => s.id)).toEqual(["checks-failing", "breakers-tripped", "arm-fired"]);
    // ≤3 cap: exactly the three families, priority-ordered.
    expect(lit).toHaveLength(3);
  });
});

// ── The PLUG-PROOF half: a real Cockpit, a driven failed check, lit pixels ──

type Json = Record<string, unknown> | unknown[];

function jsonResponse(body: Json): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return jsonResponse({ status: "ok", harnessReady: false });
      if (url.includes("/api/auth/status"))
        return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
      if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
      if (url.includes("/api/projects")) return jsonResponse([]);
      throw new Error(`unstubbed fetch in annunciator harness: ${url}`);
    }),
  );
}


describe("plug-proof — a driven failed check lights the real HORIZON", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    resetUiSchema();
    vi.unstubAllGlobals();
  });

  test("an unconsumed setAnnunciators cannot pass this: the lit slot reaches the pixels", async () => {
    app = mount(Cockpit, { target: host });
    await until(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
    // Dark when healthy.
    expect(host.querySelector(".annunciator")).toBeNull();

    // The abnormal fact arrives — a live event, exactly the class the
    // one-reveal law exempts.
    setProjects([PROJECT]);
    selectProject("p1");
    upsertAutoChecks([check("k9", "lint", "failed", new Date().toISOString())]);
    await until(() => host.querySelector(".annunciator") !== null);

    const slot = host.querySelector(".annunciator")!;
    expect(slot.textContent).toContain("1 check failing");
    expect(slot.textContent).toContain("run again");
    // The reason rides the control (§1.5 F1 — unexplained salience is a bug).
    expect(slot.getAttribute("title")).toContain("lint");
  });
});
