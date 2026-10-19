// @vitest-environment jsdom
/**
 * A DEPLOY WHILE THE PAGE IS OPEN IS NOT SILENT.
 *
 * `public/sw.js` does skipWaiting + clients.claim, so a new worker activates
 * under a running page whose modules are still the old bundle. What is
 * locked here:
 *
 *   A. THE WATCH — every evidence class sets the one-shot seam exactly once
 *      (controller replaced · incoming worker installed · update already
 *      waiting), and the FIRST INSTALL sets nothing: deny-by-default, the
 *      chip must never greet a fresh visitor.
 *   B. THE CHIP — renders only when the seam holds evidence, wears the
 *      grammar's outcome axis (`data-outcome` from OUTCOME_STATE_IDS), rises
 *      on an ARRIVAL cause through the motion owner, and its click — and
 *      only its click — performs the soft reload.
 *   C. THE WIRING — the registration path in main.ts really consumes the
 *      watch (a seam nothing calls is the correct-and-unplugged failure).
 *      This arm is a source consumption check, stated as the floor it is:
 *      the full lifecycle (register → new worker → chip → reload) is a
 *      browser fact and is driven in the browser, not in jsdom.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearSwUpdateForTests,
  swUpdateReady,
  watchServiceWorkerUpdate,
  type SwContainerLike,
  type SwRegistrationLike,
  type SwWorkerLike,
} from "../../src/cockpit/shell/sw-update.ts";
import { OUTCOME_STATE_IDS } from "../../src/cockpit/response/grammar.ts";
import UpdateChip from "../../src/cockpit/shell/UpdateChip.svelte";

// ── Fakes: the narrow slices the watch declares ────────────────────────────

type Handler = () => void;

function fakeContainer(controlled: boolean) {
  const listeners = new Map<string, Handler[]>();
  const container = {
    controller: controlled ? {} : null,
    addEventListener: (type: string, fn: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: Handler) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  return {
    container: container as unknown as SwContainerLike,
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function fakeWorker(state: string) {
  const listeners: Handler[] = [];
  const worker = {
    state,
    addEventListener: (_: string, fn: Handler) => listeners.push(fn),
  };
  return {
    worker: worker as unknown as SwWorkerLike,
    setState: (next: string) => {
      (worker as { state: string }).state = next;
      for (const fn of listeners) fn();
    },
  };
}

function fakeRegistration(waiting: SwWorkerLike | null = null) {
  const listeners = new Map<string, Handler[]>();
  const unregister = vi.fn(() => Promise.resolve(true));
  const registration = {
    waiting,
    installing: null as SwWorkerLike | null,
    addEventListener: (type: string, fn: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: Handler) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    unregister,
  };
  return {
    registration: registration as unknown as SwRegistrationLike,
    unregister,
    setInstalling: (w: SwWorkerLike | null) => {
      (registration as { installing: SwWorkerLike | null }).installing = w;
    },
    setWaiting: (w: SwWorkerLike | null) => {
      (registration as { waiting: SwWorkerLike | null }).waiting = w;
    },
    fire: (type: string) => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

beforeEach(() => clearSwUpdateForTests());
afterEach(() => clearSwUpdateForTests());

describe("A. the watch — evidence in, one-shot seam out", () => {
  test("a controller REPLACED on a controlled page is an update", () => {
    const reload = vi.fn();
    const c = fakeContainer(true);
    const r = fakeRegistration();
    watchServiceWorkerUpdate(c.container, r.registration, reload);
    expect(swUpdateReady.get()).toBeNull();
    c.fire("controllerchange");
    expect(swUpdateReady.get()).not.toBeNull();
    swUpdateReady.get()!.apply();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("FIRST INSTALL — an uncontrolled page gaining its first controller is NOT an update", () => {
    const c = fakeContainer(false);
    const r = fakeRegistration();
    watchServiceWorkerUpdate(c.container, r.registration, vi.fn());
    c.fire("controllerchange");
    expect(swUpdateReady.get()).toBeNull();
    // …but the NEXT change, now that the page is controlled, is one.
    c.fire("controllerchange");
    expect(swUpdateReady.get()).not.toBeNull();
  });

  test("an incoming worker reaching `installed` on a controlled page is an update", () => {
    const c = fakeContainer(true);
    const r = fakeRegistration();
    watchServiceWorkerUpdate(c.container, r.registration, vi.fn());
    const w = fakeWorker("installing");
    r.setInstalling(w.worker);
    r.fire("updatefound");
    expect(swUpdateReady.get()).toBeNull();
    w.setState("installed");
    expect(swUpdateReady.get()).not.toBeNull();
  });

  test("a worker already WAITING at watch time on a controlled page is an update", () => {
    const c = fakeContainer(true);
    const r = fakeRegistration(fakeWorker("installed").worker);
    watchServiceWorkerUpdate(c.container, r.registration, vi.fn());
    expect(swUpdateReady.get()).not.toBeNull();
  });

  test("a worker STILL WAITING at click time takes the escape hatch — unregister, then reload", async () => {
    // THE PINNED-CONTROLLER CLASS: a pre-exemption controller can never be
    // superseded (its infinite stream put pins it), and its page's plain
    // reload re-opens the stream and re-pins it. The evidence is the waiting
    // seat itself: with skipWaiting, a post-exemption controller drains it
    // within milliseconds of the chip rising, so a worker still waiting when
    // the human click arrives is one that cannot activate.
    const reload = vi.fn();
    const c = fakeContainer(true);
    const r = fakeRegistration(fakeWorker("installed").worker);
    watchServiceWorkerUpdate(c.container, r.registration, reload);
    expect(swUpdateReady.get()).not.toBeNull();
    swUpdateReady.get()!.apply();
    expect(r.unregister).toHaveBeenCalledTimes(1);
    // The reload waits for the unregister — reloading first would navigate
    // back under the very controller being escaped.
    expect(reload).not.toHaveBeenCalled();
    await Promise.resolve().then(() => undefined).then(() => undefined);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a waiting seat DRAINED by click time takes the plain reload — no unregister", async () => {
    // The decision is made at CLICK time, on the freshest evidence: the chip
    // rose while a worker was staged, activation then completed (the normal
    // post-exemption life), so the plain soft reload adopts the new bundle
    // and the registration — with its offline caches — is left standing.
    const reload = vi.fn();
    const c = fakeContainer(true);
    const w = fakeWorker("installed");
    const r = fakeRegistration(w.worker);
    watchServiceWorkerUpdate(c.container, r.registration, reload);
    expect(swUpdateReady.get()).not.toBeNull();
    r.setWaiting(null); // activation happened between the rise and the click
    swUpdateReady.get()!.apply();
    expect(r.unregister).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a FAILED unregister still reloads — the escape must not eat the click", async () => {
    const reload = vi.fn();
    const c = fakeContainer(true);
    const r = fakeRegistration(fakeWorker("installed").worker);
    r.unregister.mockImplementation(() => Promise.reject(new Error("registration store busy")));
    watchServiceWorkerUpdate(c.container, r.registration, reload);
    swUpdateReady.get()!.apply();
    await Promise.resolve().then(() => undefined).then(() => undefined);
    expect(r.unregister).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("many confirming signals produce ONE seam value — never a second chip", () => {
    const c = fakeContainer(true);
    const r = fakeRegistration();
    watchServiceWorkerUpdate(c.container, r.registration, vi.fn());
    c.fire("controllerchange");
    const first = swUpdateReady.get();
    c.fire("controllerchange");
    expect(swUpdateReady.get()).toBe(first);
  });
});

describe("B. the chip — the rendered contract", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  function mountChip(): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(UpdateChip, { target: host });
    flushSync();
    return host;
  }

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  test("no evidence, no pixels; evidence, one keyboard-reachable button that restarts on click", () => {
    const el = mountChip();
    expect(el.querySelector(".update-chip")).toBeNull();

    const reload = vi.fn();
    const c = fakeContainer(true);
    const r = fakeRegistration();
    watchServiceWorkerUpdate(c.container, r.registration, reload);
    c.fire("controllerchange");
    flushSync();

    const chip = el.querySelector<HTMLButtonElement>("button.update-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("New version");
    // The grammar's outcome axis, never a bespoke vocabulary.
    expect(OUTCOME_STATE_IDS).toContain(chip!.getAttribute("data-outcome"));
    // The rise is bound to an ARRIVAL cause through the motion owner.
    expect(chip!.getAttribute("data-motion")).toBe("rise");
    expect(chip!.getAttribute("data-motion-cause")).toBe("arrival");
    // A <button> is keyboard-activatable by construction; the click is the
    // one and only thing that reloads.
    expect(reload).not.toHaveBeenCalled();
    chip!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("C. the wiring — main.ts consumes the watch (source floor)", () => {
  test("registration hands its result to watchServiceWorkerUpdate with the real container", () => {
    // A rung-5 floor, said plainly: jsdom has no service worker lifecycle to
    // drive, so this arm pins the CONSUMPTION — the browser check drives the
    // rest. The two assertions are conjunctive on purpose: importing the
    // watch without calling it, or calling it off a different container,
    // both fail.
    const src = readFileSync(join(process.cwd(), "src/cockpit/main.ts"), "utf8");
    expect(src).toMatch(/watchServiceWorkerUpdate\(\s*navigator\.serviceWorker\s*,/);
    expect(src).toMatch(/from "\.\/shell\/sw-update\.ts"/);
  });
});
