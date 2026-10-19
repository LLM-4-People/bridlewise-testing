// @vitest-environment node
/**
 * THE LLM NAVIGATION SURFACE CONTRACT — server tab enum ↔ cockpit surface.
 *
 * Three declarations describe where a `set_tab` lands, on two sides of a
 * wire the type system cannot see across:
 *
 *   shared/routes.ts::TAB_ROUTE_VALUES — the canonical tab list;
 *   server/ui-control.ts::UI_CONTROL_TABS — what the server validates
 *     (derived from the contract by z.enum — pinned here so a hand-written
 *     mirror cannot quietly return);
 *   src/state/ui-control.ts::TAB_SURFACE — where each tab lands in the
 *     cockpit (typed exhaustive over the tab union, so a MISSING entry is
 *     already a compile error; this file guards the halves the compiler
 *     cannot: the runtime enum agreement, and that every mapped room is a
 *     room that actually EXISTS in the tree).
 *
 * A drift here is an LLM tool that validates an action the client cannot
 * land, or navigates to a surface that is not built — a capability that
 * reports success while doing nothing, which is the exact failure the
 * control_interface pipeline was kept alive to avoid.
 */
import { describe, expect, test } from "vitest";

import { INSPECTOR_SECTION_ENTRIES, INSPECTOR_SECTION_IDS, TAB_ROUTE_VALUES } from "../../shared/routes.ts";
import { validateUiControlAction, UI_CONTROL_INSPECTOR_SECTION_NAMES, describeUiControlAction, UI_CONTROL_TABS } from "../../server/tools/ui-control.ts";
import { applyUiControlAction, TAB_SURFACE } from "../../src/state/ui-control.ts";
import {
  consumeShellViewRequest,
  pendingShellView,
} from "../../src/cockpit/shell/view-request.ts";
import { roomExists } from "../../src/cockpit/shell/outlets.ts";

describe("server tab enum ↔ contract", () => {
  test("UI_CONTROL_TABS resolves to exactly TAB_ROUTE_VALUES at runtime", () => {
    expect([...UI_CONTROL_TABS.options].sort()).toEqual([...TAB_ROUTE_VALUES].sort());
  });
});

describe("contract ↔ cockpit mapping", () => {
  test("TAB_SURFACE covers exactly the contract's tabs — nothing missing, nothing stale", () => {
    expect(Object.keys(TAB_SURFACE).sort()).toEqual([...TAB_ROUTE_VALUES].sort());
  });

  test("every mapped room is a room that exists in the tree (real glob, no stub)", () => {
    const mappedRooms = [
      ...new Set(
        Object.values(TAB_SURFACE).filter(
          (s): s is Exclude<typeof s, "flow" | "pane" | null> =>
            s !== null && s !== "flow" && s !== "pane",
        ),
      ),
    ];
    // Population floor: an empty mapped-room set would make the loop below
    // vacuous — the mapping must actually name rooms.
    expect(mappedRooms.length).toBeGreaterThan(0);
    for (const id of mappedRooms) {
      expect(roomExists(id), `TAB_SURFACE maps a tab to "${id}" but no such room exists`).toBe(
        true,
      );
    }
  });

  test("set_tab refuses an unknown tab at runtime (deny-by-default past the compiler)", () => {
    // The compile-time exhaustiveness of TAB_SURFACE cannot stop a value
    // that arrives over the wire with a bad tab — only the runtime
    // containment check in applyUiControlAction can. Drive a cast past tsc
    // the way a wire value would arrive: the action must answer with an
    // honest refusal AND request no shell view. (Removing the containment
    // check makes the unknown tab fall through to a room request whose id
    // is undefined — the pendingShellView assertion catches exactly that.)
    consumeShellViewRequest(); // clean slate
    const desc = applyUiControlAction({ action: "set_tab", tab: "nonexistent" as never });
    expect(desc, "unknown tab is an honest no-op").toBe("Unknown tab 'nonexistent' — no change.");
    expect(pendingShellView.get(), "unknown tab must request nothing").toBeNull();
  });

  test("every tab DRIVES the seam it is mapped to (discovered from the mapping, not a list)", () => {    for (const tab of TAB_ROUTE_VALUES) {
      consumeShellViewRequest(); // clean slate per tab
      const surface = TAB_SURFACE[tab];
      const desc = applyUiControlAction({ action: "set_tab", tab });
      if (surface === null) {
        expect(desc, `tab ${tab}`).toContain(`no ${tab} surface`);
        expect(pendingShellView.get(), `tab ${tab} must request nothing`).toBeNull();
      } else if (surface === "flow") {
        expect(consumeShellViewRequest(), `tab ${tab}`).toEqual({ kind: "flow" });
      } else if (surface === "pane") {
        expect(consumeShellViewRequest(), `tab ${tab}`).toEqual({ kind: "pane" });
      } else {
        expect(consumeShellViewRequest(), `tab ${tab}`).toEqual({ kind: "room", id: surface });
      }
    }
  });

  test("the agents tab is LIVE — it routes to the run pane (the agents surface exists now)", () => {
    // The agents surface exists (the run pane's agents section), so the tab
    // must land there — a regression to the honest-absent `null` (or to any
    // other surface) breaks the LLM's navigation to the agents view.
    expect(TAB_SURFACE.agents).toBe("pane");
    consumeShellViewRequest(); // clean slate
    const desc = applyUiControlAction({ action: "set_tab", tab: "agents" });
    expect(desc).toContain("run pane");
    expect(consumeShellViewRequest()).toEqual({ kind: "pane" });
  });
});


describe("inspector capability addresses", () => {
  test("every declared section validates and reaches the same shell address", () => {
    expect(INSPECTOR_SECTION_ENTRIES.length).toBeGreaterThanOrEqual(17);
    expect(UI_CONTROL_INSPECTOR_SECTION_NAMES).toEqual(INSPECTOR_SECTION_IDS);
    for (const section of INSPECTOR_SECTION_ENTRIES) {
      const request = { action: "inspect" as const, mode: "open" as const, group: section.group, section: section.id };
      expect(validateUiControlAction(request)).toEqual(request);
      consumeShellViewRequest();
      expect(applyUiControlAction(request)).toContain(section.label);
      expect(consumeShellViewRequest()).toEqual({ kind: "pane", mode: "open", group: section.group, section: section.id });
    }
  });
  test("discovery lists the full unmounted vocabulary without navigation", () => {
    consumeShellViewRequest();
    const server = describeUiControlAction({ action: "list_inspector" });
    const client = applyUiControlAction({ action: "list_inspector" });
    for (const section of INSPECTOR_SECTION_ENTRIES) {
      expect(server).toContain(section.id + ": " + section.label);
      expect(client).toContain(section.id + ": " + section.label);
    }
    expect(pendingShellView.get()).toBeNull();
  });
  test("unknown, missing, and contradictory addresses are refused on both sides", () => {
    for (const request of [
      { action: "inspect" },
      { action: "inspect", mode: "erase" },
      { action: "inspect", mode: "open", section: "missing" },
      { action: "inspect", mode: "open", group: "missing" },
      { action: "inspect", mode: "open", group: "run", section: "arm-sec-palette" },
    ]) {
      consumeShellViewRequest();
      expect(validateUiControlAction(request)).toBeNull();
      expect(applyUiControlAction(request as never)).toContain("no change");
      expect(pendingShellView.get()).toBeNull();
    }
  });
});
