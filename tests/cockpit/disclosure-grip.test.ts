// @vitest-environment jsdom
/**
 * THE DISCLOSURE GRIP — the shared collapsible-section primitive's own
 * contracts (shell/Disclosure.svelte).
 *
 * Every section of the single right menu is this one component, so its
 * grammar is pinned here once, directly against the mounted component —
 * the surfaces' suites (run-pane, run-pane-shell) prove their CONTENT;
 * this file proves the CHROME:
 *
 *   - the APG disclosure contract: a real button carrying `aria-expanded`
 *     whose value flips with the state, and `aria-controls` pointing at
 *     the content element (the recorded two-grammar PENDING row's stricter reading,
 *     adopted for this surface);
 *   - collapsed content is REMOVED FROM THE DOM, not hidden (the perf
 *     judgment: a collapsed section's rows do not render);
 *   - the FIXED-LABEL law: the section's accessible name never changes
 *     with its state — the chevron is aria-hidden and carries no name;
 *   - the COUNT is the accordion pattern's "visually persistent snippet":
 *     it stays visible when the body is collapsed;
 *   - `defaultOpen` is CAPTURED AT MOUNT — a later change to the prop must
 *     not reorganize a menu the reader is reading.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import Disclosure from "../../src/cockpit/shell/Disclosure.svelte";
import DisclosureMetaProbe from "./fixtures/DisclosureMetaProbe.svelte";
import DisclosureDefaultProbe from "./fixtures/DisclosureDefaultProbe.svelte";
import { openWorkspace, activateWorkspace, resetWorkspaces } from "../../src/state/workspaces.ts";

beforeEach(() => { resetWorkspaces(); });

afterEach(() => cleanup());

describe("the disclosure grip", () => {
  test("manual choices survive remounts and workspace switches and restored bodies acquire once", async () => {
    const a = openWorkspace();
    const acquired = vi.fn();
    const first = render(Disclosure, { props: { id: "remembered", label: "history", onOpenChange: acquired } });
    first.getByRole("button", { name: "history" }).click(); await tick();
    expect(acquired.mock.calls.map(call => call[0])).toEqual([false, true]);
    first.unmount();
    const second = render(Disclosure, { props: { id: "remembered", label: "history", onOpenChange: acquired } });
    await tick();
    expect(second.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(acquired.mock.calls.map(call => call[0])).toEqual([false, true, true]);
    const b = openWorkspace(); await tick();
    expect(second.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    activateWorkspace(a.id); await tick();
    expect(second.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    second.getByRole("button").click(); await tick();
    activateWorkspace(b.id); await tick(); activateWorkspace(a.id); await tick();
    expect(second.getByRole("button").getAttribute("aria-expanded")).toBe("false");
    resetWorkspaces(); await tick();
    expect(second.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  test("reactive reads inside acquisition callbacks never subscribe disclosure restoration to live updates", async () => {
    const view = render(DisclosureDefaultProbe, {});
    const probe = view.component as unknown as { flip(): void; readCallbacks(): number };
    view.getByRole("button").click(); await tick();
    const calls = probe.readCallbacks();
    probe.flip(); await tick();
    expect(view.getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(probe.readCallbacks()).toBe(calls);
  });
  test("carries the APG contract: aria-expanded flips, aria-controls points at the body", async () => {
    const { container } = render(Disclosure, {
      props: { id: "sec-apg", label: "agents", defaultOpen: false },
    });
    const grip = container.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.sec-apg"]')!;
    expect(grip.getAttribute("aria-expanded")).toBe("false");
    expect(grip.getAttribute("aria-controls")).toBe("sec-apg");
    grip.click();
    await tick();
    expect(grip.getAttribute("aria-expanded")).toBe("true");
    // The body exists under exactly the id the grip controls.
    expect(container.querySelector("#sec-apg") !== null).toBe(true);
  });

  test("collapsed content is REMOVED from the DOM, not hidden", async () => {
    const { container } = render(Disclosure, {
      props: { id: "sec-dom", label: "calls", defaultOpen: true },
    });
    expect(container.querySelector("#sec-dom") !== null).toBe(true);
    const grip = container.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.sec-dom"]')!;
    grip.click();
    await tick();
    expect(container.querySelector("#sec-dom"), "collapsed → the body is gone").toBeNull();
  });

  test("the FIXED-LABEL law: the accessible name never changes with the state", async () => {
    const { container } = render(Disclosure, {
      props: { id: "sec-label", label: "preparation", defaultOpen: false },
    });
    const grip = container.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.sec-label"]')!;
    // The chevron is aria-hidden: the name is the label word, alone.
    expect(grip.querySelector(".disc-mark")!.getAttribute("aria-hidden")).toBe("true");
    expect(grip.textContent!.replace(/[▸▾]/g, "").trim()).toBe("preparation");
    grip.click();
    await tick();
    // Same name, different state — the law the APG states for toggles and
    // this surface honors for disclosures.
    expect(grip.textContent!.replace(/[▸▾]/g, "").trim()).toBe("preparation");
  });

  test("the COUNT is the persistent snippet — visible when the body is collapsed", () => {
    const { container } = render(Disclosure, {
      props: { id: "sec-count", label: "turns", count: 4, defaultOpen: false },
    });
    expect(container.querySelector("#sec-count")).toBeNull();
    const count = container.querySelector(".disc-count")!;
    expect(count.textContent).toBe("4");
  });

  test("a null count renders no count slot (a section without a population says nothing)", () => {
    const { container } = render(Disclosure, {
      props: { id: "sec-nocount", label: "progress" },
    });
    expect(container.querySelector(".disc-count")).toBeNull();
  });

  test("defaultOpen is captured at MOUNT — a later prop change does not reorganize the reader's menu", async () => {
    // Rows arrive while the menu is open: the probe flips the prop after
    // mount, and the section must stay the way the reader's mount found it.
    const { container, component } = render(DisclosureDefaultProbe, {});
    expect(container.querySelector("#sec-mount")).toBeNull();
    (component as unknown as { flip: () => void }).flip();
    await tick();
    expect(container.querySelector("#sec-mount"), "the mount-time default stands").toBeNull();
  });

  test("the meta snippet renders beside the grip, visible whether open or collapsed", async () => {
    // The progress section's stop verb and the codebase section's re-read
    // ride this slot — always-visible adjacent controls, the accordion
    // pattern's own expectation.
    const { container, getByText } = render(DisclosureMetaProbe, {});
    expect(getByText("stop this run").textContent).toBe("stop this run");
    const grip = container.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.sec-meta"]')!;
    grip.click();
    await tick();
    // Still rendered after collapse — the verb never disappears with the
    // body it acts on.
    expect(getByText("stop this run").textContent).toBe("stop this run");
  });
});
