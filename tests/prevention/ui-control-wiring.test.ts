// @vitest-environment node
/**
 * Adversarial tests for the `control_interface` tool end-to-end wiring
 * (LLM control of the interface). Covers the full unified pipeline
 *:
 * server/ui-control.ts: validateUiControlAction (adversarial input) +
 * describeUiControlAction (readable result).
 * tools-bridge.ts: control_interface is in the manifest.
 * tool-executor.ts: control_interface has a handler + behaves (valid →
 * success with the action embedded; invalid → typed failure).
 * routes/run.ts: emits a `ui_control` SSE event on control_interface
 * success (source-string — the run route is not a pure function).
 * client.ts: listens for `ui_control` + applies via applyUiControlAction.
 * shared/types.ts: the UiControlAction type mirror exists.
 * src/state/ui-control.ts: applyUiControlAction maps each action to the
 * correct cockpit surface (shell view seam / device theme preference) +
 * returns a description (behavioral).
 *
 * never weaken/fake. hard, realistic input.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { validateUiControlAction, describeUiControlAction, UI_CONTROL_ACTION_NAMES, UI_CONTROL_PANEL_NAMES, UI_CONTROL_THEME_NAMES } from "../../server/tools/ui-control.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { isToolExecutable, executeToolCall } from "../../server/tools/tool-executor.ts";
import { applyUiControlAction, TAB_SURFACE } from "../../src/state/ui-control.ts";
import {
  consumeShellViewRequest,
  pendingShellView,
} from "../../src/cockpit/shell/view-request.ts";
import { localValue, setLocalPref } from "../../src/cockpit/settings/local-prefs.ts";
import { closeRightMenu, rightMenu } from "../../src/cockpit/shell/right-menu.ts";
import { TAB_ROUTE_VALUES } from "../../shared/routes.ts";
import { read } from "../helpers/source-scan.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const root = resolve(import.meta.dirname, "../..");
describe("control_interface — validation (server/ui-control.ts)", () => {
  it("set_tab with a valid tab validates", () => {
    expect(validateUiControlAction({ action: "set_tab", tab: "timeline" })).toEqual({ action: "set_tab", tab: "timeline" });
  });
  it("toggle_panel with a valid panel validates", () => {
    expect(validateUiControlAction({ action: "toggle_panel", panel: "left" })).toEqual({ action: "toggle_panel", panel: "left" });
  });
  it("set_theme with a valid theme validates", () => {
    expect(validateUiControlAction({ action: "set_theme", theme: "light" })).toEqual({ action: "set_theme", theme: "light" });
  });
  it("open_settings with no extra field validates", () => {
    expect(validateUiControlAction({ action: "open_settings" })).toEqual({ action: "open_settings" });
  });

  it("rejects an unknown action", () => {
    expect(validateUiControlAction({ action: "delete_everything" })).toBeNull();
  });
  it("rejects set_tab without the tab field", () => {
    expect(validateUiControlAction({ action: "set_tab" })).toBeNull();
  });
  it("rejects toggle_panel without the panel field", () => {
    expect(validateUiControlAction({ action: "toggle_panel" })).toBeNull();
  });
  it("rejects set_theme without the theme field", () => {
    expect(validateUiControlAction({ action: "set_theme" })).toBeNull();
  });
  it("rejects an invalid tab enum value", () => {
    expect(validateUiControlAction({ action: "set_tab", tab: "admin" })).toBeNull();
  });
  it("rejects extra/unknown fields (strict object)", () => {
    expect(validateUiControlAction({ action: "open_settings", sneaky: "x" })).toBeNull();
  });
  it("rejects a non-object payload", () => {
    expect(validateUiControlAction(null)).toBeNull();
    expect(validateUiControlAction("set_tab")).toBeNull();
    expect(validateUiControlAction(42)).toBeNull();
    expect(validateUiControlAction(undefined)).toBeNull();
  });
  it("rejects wrong-typed fields", () => {
    expect(validateUiControlAction({ action: "set_tab", tab: 5 })).toBeNull();
    expect(validateUiControlAction({ action: "toggle_panel", panel: "top" })).toBeNull();
    expect(validateUiControlAction({ action: "set_theme", theme: "rainbow" })).toBeNull();
  });
});

describe("control_interface — describeUiControlAction", () => {
  it("describes each action readably", () => {
    expect(describeUiControlAction({ action: "set_tab", tab: "timeline" })).toContain("timeline");
    expect(describeUiControlAction({ action: "toggle_panel", panel: "right" })).toContain("right");
    expect(describeUiControlAction({ action: "set_theme", theme: "light" })).toContain("light");
    expect(describeUiControlAction({ action: "open_settings" })).toContain("settings");
  });
});

describe("control_interface — manifest + executor (unified pipeline)", () => {
  it("the manifest exposes control_interface as a built-in tool", () => {
    const e = getToolManifest().find((t) => t.name === "control_interface");
    expect(e, "control_interface must be in the manifest").toBeDefined();
    expect(e!.category).toBe("built-in");
    expect(e!.kind).toBe("system");
    // The input schema requires the action field.
    const required = (e!.inputSchema as { required?: string[] }).required;
    expect(required).toContain("action");
  });

  it("the manifest input schema + the zod owner cannot drift (same enums)", () => {
    // prevention: the manifest (what the LLM sees) + the zod
    // UI_CONTROL_ACTION (what the executor validates) are two declarations
    // of the same contract. A drift would let the LLM call an action the
    // executor rejects (or advertise an action the LLM can never pass).
    // Pin them against each other: every manifest enum value must validate
    // through the zod owner, and every zod-accepted value must be in the
    // manifest enum.
    const e = getToolManifest().find((t) => t.name === "control_interface")!;
    const props = (e.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;

    // action: every manifest action validates via zod; a non-manifest action
    // is rejected by zod (so the two surfaces agree).
    const actionEnum = props.action?.enum ?? [];
    for (const a of actionEnum) {
      // open_settings needs no extra field; the others need their field.
      const sample = a === "open_settings" ? { action: a } : { action: a, tab: "chat", panel: "left", theme: "dark", mode: "open" };
      expect(validateUiControlAction(sample), `action ${a} must validate`).not.toBeNull();
    }
    expect(validateUiControlAction({ action: "not_a_real_action" })).toBeNull();
    // The manifest action enum must equal the canonical owner's action
    // list (derived dynamically — a new action added to the Zod schema is
    // auto-covered here, no hardcoded list that silently rots).
    expect(actionEnum.slice().sort()).toEqual([...UI_CONTROL_ACTION_NAMES].sort());

    // tab: manifest enum == the zod tabs (every manifest tab validates,
    // a non-manifest tab is rejected).
    const tabEnum = props.tab?.enum ?? [];
    for (const t of tabEnum) {
      expect(validateUiControlAction({ action: "set_tab", tab: t }), `tab ${t} must validate`).not.toBeNull();
    }
    expect(validateUiControlAction({ action: "set_tab", tab: "bogus" })).toBeNull();

    // panel + theme enums must equal the canonical owner's lists (dynamic).
    expect(props.panel?.enum?.slice().sort()).toEqual([...UI_CONTROL_PANEL_NAMES].sort());
    expect(props.theme?.enum?.slice().sort()).toEqual([...UI_CONTROL_THEME_NAMES].sort());
  });

  it("the executor has a handler for control_interface (1:1 match)", () => {
    expect(isToolExecutable("control_interface")).toBe(true);
  });

  it("the executor returns success + the validated action embedded on valid input", async () => {
    const res = await executeToolCall("control_interface", { action: "set_tab", tab: "metrics" }, { projectRoot: "/tmp" });
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output) as { ok: boolean; action: { action: string; tab?: string }; description: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.action.action).toBe("set_tab");
    expect(parsed.action.tab).toBe("metrics");
    expect(parsed.description).toContain("metrics");
  });

  it("the executor returns a typed failure on invalid input (no silent UI mutation)", async () => {
    const res = await executeToolCall("control_interface", { action: "set_tab" }, { projectRoot: "/tmp" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("Error");
  });
});

describe("control_interface — run route SSE emission", () => {
  it("run.ts forwards the validated action as a ui_control SSE event", () => {
    const src = runPathSource();
    // The control_interface guard + the ui_control SSE send must both be present.
    expect(src).toContain('toolName === "control_interface"');
    // SPO: the ui_control event is sent via the shared SSE_EVENT_TYPES
    // owner (no scattered string literal).
    // The run publishes to its own feed instead of writing into one HTTP
    // response — the frame is the same frame, through the run's door.
    expect(src).toContain("publishRunFrame(runId, SSE_EVENT_TYPES.uiControl");
    // The UiControlAction type is imported (typed forwarding, not any).
    expect(src).toContain("UiControlAction");
  });
});

describe("control_interface — client listener + apply", () => {
  it("client.ts listens for ui_control events and applies them", () => {
    const src = read(modulePathMatching("src/client.ts"));
    // SPO: the client listens via the shared SSE_EVENT_TYPES owner
    // (no scattered string literal). The listener references the
    // uiControl event type + applies the action.
    expect(src).toContain("addEventListener(SSE_EVENT_TYPES.uiControl");
    expect(src).toContain("applyUiControlAction");
    // The StreamHandlers type surfaces the action to consumers.
    expect(src).toContain("onUiControl");
  });

  it("shared/types.ts declares the UiControlAction mirror", () => {
    expect(read("shared/types.ts")).toContain("export type UiControlAction");
  });

  it("applyUiControlAction: set_tab lands on the mapped cockpit room via the shell view seam", () => {
    consumeShellViewRequest(); // start clean
    const desc = applyUiControlAction({ action: "set_tab", tab: "git" });
    expect(desc).toContain("git");
    expect(consumeShellViewRequest()).toEqual({ kind: "room", id: "custody" });
  });

  it("applyUiControlAction: a flow-mapped tab asks for the flow, not a room", () => {
    consumeShellViewRequest();
    const desc = applyUiControlAction({ action: "set_tab", tab: "chat" });
    expect(desc).toContain("flow");
    expect(consumeShellViewRequest()).toEqual({ kind: "flow" });
  });

  it("applyUiControlAction: a tab with NO cockpit surface says so and requests nothing", () => {
    consumeShellViewRequest();
    const desc = applyUiControlAction({ action: "set_tab", tab: "memory" });
    expect(desc).toContain("no memory surface");
    expect(pendingShellView.get()).toBeNull();
  });

  it("applyUiControlAction: open_settings asks the shell for the settings room", () => {
    consumeShellViewRequest();
    const desc = applyUiControlAction({ action: "open_settings" });
    expect(desc).toContain("Settings");
    expect(consumeShellViewRequest()).toEqual({ kind: "room", id: "settings" });
  });

  it("applyUiControlAction: right panel toggles the existing inspector while left stays unavailable", () => {
    // The collapsible side panels are gone — the action must say what is
    // true, and must not ask the shell for anything.
    consumeShellViewRequest();
    const desc = applyUiControlAction({ action: "toggle_panel", panel: "left" });
    expect(desc).toContain("left");
    expect(desc).toContain("field");
    closeRightMenu();
    const descRight = applyUiControlAction({ action: "toggle_panel", panel: "right" });
    expect(descRight).toBe("Opened the workspace inspector.");
    expect(rightMenu.get()).toBe("run");
    expect(applyUiControlAction({ action: "toggle_panel", panel: "right" })).toBe("Closed the workspace inspector.");
    expect(rightMenu.get()).toBeNull();
    expect(pendingShellView.get()).toBeNull();
  });

  it("applyUiControlAction: set_theme writes the device theme preference through the ONE local write path", () => {
    applyUiControlAction({ action: "set_theme", theme: "light" });
    expect(localValue("cockpit.theme")).toBe("logbook");
    applyUiControlAction({ action: "set_theme", theme: "dark" });
    expect(localValue("cockpit.theme")).toBe("carbon");
  });

  it("applyUiControlAction: a missing required field is an honest no-op + message (no crash, no wrong mutation)", () => {
    consumeShellViewRequest();
    const beforeTheme = localValue("cockpit.theme");
    const desc = applyUiControlAction({ action: "set_tab" } as { action: "set_tab" });
    expect(desc).toContain("no change");
    expect(pendingShellView.get()).toBeNull(); // nothing asked for
    expect(localValue("cockpit.theme")).toBe(beforeTheme); // unchanged
  });

  it("TAB_SURFACE is exhaustive over the server tab enum, and every mapped surface is real", () => {
    // The compile-time Record already refuses a MISSING tab; this guards the
    // runtime halves the type cannot see across the wire boundary: every
    // server tab has an entry, and no entry names a tab the server dropped.
    expect(Object.keys(TAB_SURFACE).sort()).toEqual([...TAB_ROUTE_VALUES].sort());
  });

  it("set_theme values round-trip the local preference contract (both refusable at the door)", () => {
    // The mapping targets must be values the ONE write path accepts — a
    // renamed theme token would otherwise turn every LLM set_theme into a
    // thrown refusal.
    expect(() => setLocalPref("cockpit.theme", "carbon")).not.toThrow();
    expect(() => setLocalPref("cockpit.theme", "logbook")).not.toThrow();
    setLocalPref("cockpit.theme", "carbon");
  });
});
