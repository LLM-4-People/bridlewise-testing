// @vitest-environment node
/**
 * BOOT IS WAVES, NOT A QUEUE. (DESIGN-PERFORMANCE §1 L4 / §6 item 6.)
 *
 * ── The defect ──
 *
 * Boot was measured as SEVEN strictly serial legs:
 *
 *     health → auth → schema → projects → map → chats → history
 *
 * Every one waited for the previous response before its own request left, and
 * only two of those waits were real dependencies. Two of the legs were not
 * dependencies at all:
 *
 *   - `/api/health` gated one thing, "is the server reachable", which the
 *     very next request answers anyway — `checkAuthStatus` returns
 *     `{ offline: true }` on the identical network failure. Its response was
 *     never read.
 *   - `/api/intelligence/map` wrote no store, filled no cache and gated
 *     nothing. It was on the critical path of every boot to print a file
 *     count, and on a cold index it pays the latency and then answers
 *     "not measured yet".
 *
 * And the last two legs are keyed on ids that are ALREADY PERSISTED and
 * restored into the atoms at module load — so they never needed the lists
 * that validate them to have arrived first. Validation can happen when the
 * list lands, in parallel.
 *
 * ── What is verified ──
 *
 * A1 `/api/health` is never requested.
 * A2 `/api/intelligence/map` is never requested during boot.
 * A3 with the ids persisted, schema, projects, chats and history are ALL in
 *    flight together — the wave, asserted by counting requests issued before
 *    any of them has answered.
 * A4 without persisted ids nothing is speculated: only the reads whose key
 *    is known are fired.
 * A5 a stale persisted chat id does not restore a conversation the real list
 *    does not contain — firing early must not weaken the validation.
 * A6 the whole boot is 2 waves: nothing is issued after the wave except what
 *    the wave's own answers required.
 * A7 a speculative answer about an id that turned out to be stale is
 *    DISCARDED — the read for the id we landed on is still issued.
 *
 * ── Mutation-verified ──
 * Putting the `/api/health` leg back makes A1, A3, A4, A5 and A6 FAIL.
 * Awaiting schema before issuing projects (the old serial shape) makes A3,
 * A4, A5 and A6 FAIL. Using the ahead chat list without checking the key it
 * asked about makes A7 FAIL. Each was applied and run.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRegistration, type ProbeLine } from "../../src/cockpit/boot/probes.ts";
import { currentProjectId, resetProjects } from "../../src/state/projects.ts";
import { currentChatId, resetChats } from "../../src/state/chats.ts";
import { resetAuth } from "../../src/state/auth.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";

const realFetch = globalThis.fetch;

type Pending = { url: string; answer: (body: unknown) => void; fail: (err: unknown) => void };

/** A transport that RECORDS every request and answers only when told, so the
 * test can look at what is in flight at one instant — which is the only way
 * to tell a wave from a queue. */
function heldTransport(): { pending: Pending[]; urls: () => string[] } {
  const pending: Pending[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return new Promise((resolve, reject) => {
      pending.push({
        url,
        answer: (body) =>
          resolve({ ok: true, status: 200, json: async () => body } as Response),
        fail: reject,
      });
    });
  }) as unknown as typeof fetch;
  return { pending, urls: () => pending.map((p) => p.url) };
}

const AUTH = { setupRequired: false, authenticated: true, username: "ada", isAdmin: true };
/**
 * Ids are PER TEST, deliberately. `loadChatHistory` deduplicates by chat id
 * through a module-level map of in-flight reads (the fix for the measured
 * double-fire), and a test that leaves a request unanswered leaves an entry
 * in it — a later test reusing the same id would JOIN that abandoned read and
 * hang. Distinct ids keep each case's speculation its own.
 */
function projectsOf(projectId: string): unknown[] {
  return [{ id: projectId, name: "one", path: `/${projectId}`, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-02T00:00:00.000Z" }];
}
function chatsOf(projectId: string, chatId: string): unknown[] {
  return [{ id: chatId, projectId, title: "kept", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", modelId: null, pinned: false }];
}
function historyFor(chatId: string, projectId = "p1"): unknown {
  return {
    chat: { id: chatId, projectId, title: "kept", modelId: null, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
    messages: [],
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page: wholeConversationPage(0),
  };
}

/** Answer whatever is pending that matches, as many times as it appears. */
function answerAll(pending: Pending[], match: string, body: unknown): number {
  let n = 0;
  for (const p of pending) {
    if (p.url.includes(match) && !answered.has(p)) {
      answered.add(p);
      p.answer(body);
      n += 1;
    }
  }
  return n;
}
let answered = new WeakSet<Pending>();

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let lines: ProbeLine[] = [];
let completed = false;
let gate: string | null = null;

function boot(): ReturnType<typeof createRegistration> {
  lines = [];
  completed = false;
  gate = null;
  return createRegistration({
    onLine: (l) => lines.push(l),
    onAuthGate: (g) => { gate = g; },
    onComplete: () => { completed = true; },
  });
}

beforeEach(() => {
  answered = new WeakSet<Pending>();
  resetProjects();
  resetChats();
  // Each test is ONE boot from a signed-out page. Without this, the AUTH
  // answered in an earlier test leaves `authenticated: true` in the shared
  // store, and the auth-gated wave-2 reads (the standing check load) fire
  // the moment the persisted project id is planted — putting a request into
  // a wave-1 assertion about a boot that has not authenticated yet.
  resetAuth();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("boot waves — the round trips are budgeted", () => {
  test("A1/A2 no /api/health leg, and no /api/intelligence/map on the boot path", async () => {
    const t = heldTransport();
    currentProjectId.set("pA");
    currentChatId.set("cA");
    const reg = boot();
    const done = reg.start();

    // Answer everything the boot asks for, as it asks.
    for (let i = 0; i < 6 && !completed; i += 1) {
      answerAll(t.pending, "/api/auth/status", AUTH);
      answerAll(t.pending, "/api/schema/ui", { menus: [], panels: [], widgets: [] });
      answerAll(t.pending, "/api/projects/pA/chats", chatsOf("pA", "cA"));
      answerAll(t.pending, "/api/chats/cA/history", historyFor("cA", "pA"));
      answerAll(t.pending, "/api/projects", projectsOf("pA"));
      await settle();
    }
    await done;

    expect(completed, "a warm signed-in boot must complete").toBe(true);
    expect(gate).toBeNull();
    expect(
      t.urls().filter((u) => u.includes("/api/health")),
      "the health leg asks a question the very next request answers anyway",
    ).toEqual([]);
    expect(
      t.urls().filter((u) => u.includes("/api/intelligence/map")),
      "the repository map gates nothing and writes nothing — it was a decorative " +
        "line on the critical path of every boot",
    ).toEqual([]);
  });

  test("A3 with the ids persisted, five reads are in flight AT ONCE", async () => {
    const t = heldTransport();
    currentProjectId.set("pB");
    currentChatId.set("cB");
    const reg = boot();
    void reg.start();
    await settle();

    // Wave 1: auth alone — it is the one thing everything else is gated on.
    expect(t.urls()).toHaveLength(1);
    expect(t.urls()[0]).toContain("/api/auth/status");

    // Wave 2: everything the session cookie alone can ask for, together.
    answerAll(t.pending, "/api/auth/status", AUTH);
    await settle();
    const wave2 = t.urls().slice(1);
    // SEVEN members. Two populations changed under this pin, each by a
    // deliberate act, and the number is re-stated here rather than left
    // bounding a wave that no longer exists (§20b): the standing check
    // state joined when the annunciator gained its boot fill, and the TOOL
    // MANIFEST joined when its feed was wired (the auth-gated
    // loadToolManifestForSession — the manifest store had NO writer at all,
    // so every consumer that derived from it, the flow's file-effect fold
    // first among them, answered from absence all session). Cookie-only
    // reads, every one, held out of wave 1 by the auth gate.
    expect(
      wave2.length,
      `the second wave must issue every cookie-only read together, not one per ` +
        `round trip — issued: ${wave2.join(", ")}`,
    ).toBe(7);
    for (const expected of [
      "/api/schema/ui",
      "/api/projects",
      "/api/projects/pB/chats",
      "/api/chats/cB/history",
      "/api/projects/pB/auto-checks",
      "/api/tools",
    ]) {
      expect(wave2.some((u) => u.includes(expected)), `${expected} must be in the wave`).toBe(true);
    }
    expect(
      wave2.some((u) => /\/api\/projects\/pB$/.test(u)),
      "opening the selected project must be in the wave (starts the map)",
    ).toBe(true);
  });

  test("A6 the whole boot is TWO waves — nothing trails after the second", async () => {
    const t = heldTransport();
    currentProjectId.set("pC");
    currentChatId.set("cC");
    const reg = boot();
    const done = reg.start();
    await settle();
    answerAll(t.pending, "/api/auth/status", AUTH);
    await settle();
    const afterWave2 = t.pending.length;

    answerAll(t.pending, "/api/schema/ui", { menus: [], panels: [], widgets: [] });
    answerAll(t.pending, "/api/projects/pC/chats", chatsOf("pC", "cC"));
    answerAll(t.pending, "/api/chats/cC/history", historyFor("cC", "pC"));
    answerAll(t.pending, "/api/projects", projectsOf("pC"));

    // Answer NOTHING further, and let the boot run as long as it likes. If it
    // finishes, the wave's answers were all it needed — two waves. If it is
    // still waiting, it is waiting on a request it issued AFTER the wave,
    // which is a third round trip and the whole point of this test.
    for (let i = 0; i < 50 && !completed; i += 1) await settle();

    expect(
      completed,
      `boot did not finish on the wave's answers alone — a third wave is open: ` +
        `${t.urls().slice(afterWave2).join(", ")}`,
    ).toBe(true);
    expect(
      t.pending.length,
      `late requests: ${t.urls().slice(afterWave2).join(", ")}`,
    ).toBe(afterWave2);
    await done;
    expect(lines.map((l) => l.id)).toEqual(["session", "schema", "index", "conversation"]);
  });

  test("A7 a speculative answer about the WRONG project is discarded, not used", async () => {
    // The persisted project no longer exists, so the boot falls back to the
    // newest one — and the chat list it fired ahead asked about the stale id.
    // That answer is about a different question. Using it would restore a
    // conversation from a project the user does not have open: a fabrication
    // built out of a real response, which is the worst kind. The ahead read
    // carries the key it asked about precisely so this can be checked.
    const t = heldTransport();
    currentProjectId.set("stale");
    currentChatId.set(null);
    const reg = boot();
    const done = reg.start();
    await settle();
    answerAll(t.pending, "/api/auth/status", AUTH);
    await settle();

    expect(
      t.urls().some((u) => u.includes("/api/projects/stale/chats")),
      "the speculation IS fired — it is keyed on what was persisted",
    ).toBe(true);

    answerAll(t.pending, "/api/schema/ui", { menus: [], panels: [], widgets: [] });
    // The stale project's chat list answers with a conversation that must
    // never be restored, because that project is not the one we land on.
    answerAll(t.pending, "/api/projects/stale/chats", chatsOf("stale", "ghost"));
    answerAll(t.pending, "/api/projects", projectsOf("pE"));
    for (let i = 0; i < 20 && !completed; i += 1) {
      answerAll(t.pending, "/api/projects/pE/chats", chatsOf("pE", "cE"));
      await settle();
    }
    await done;

    expect(currentProjectId.get(), "the boot lands on the real project").toBe("pE");
    expect(
      t.urls().some((u) => u.includes("/api/projects/pE/chats")),
      "the answer about the stale project cannot stand in for the real one — the " +
        "read for the project we landed on must actually be issued",
    ).toBe(true);
  });

  test("A4 nothing is speculated when there is no persisted id to speculate on", async () => {
    const t = heldTransport();
    currentProjectId.set(null);
    currentChatId.set(null);
    const reg = boot();
    void reg.start();
    await settle();
    answerAll(t.pending, "/api/auth/status", AUTH);
    await settle();

    const wave2 = t.urls().slice(1);
    expect(
      wave2.length,
      "warming a read whose key is unknown would be warming the WRONG row and " +
        "caching it under the right one. The three members are the two unkeyed " +
        "session reads (schema, projects) plus the tool manifest — also unkeyed, " +
        "so it belongs in the wave rather than behind it",
    ).toBe(3);
    expect(wave2.some((u) => u.includes("/api/schema/ui"))).toBe(true);
    expect(wave2.some((u) => u.endsWith("/api/projects"))).toBe(true);
    expect(wave2.some((u) => u.endsWith("/api/tools"))).toBe(true);
  });

  test("A5 a stale kept chat id still CLEARS — firing early does not weaken validation", async () => {
    const t = heldTransport();
    currentProjectId.set("pD");
    currentChatId.set("gone");
    const reg = boot();
    const done = reg.start();
    await settle();
    answerAll(t.pending, "/api/auth/status", AUTH);
    await settle();

    answerAll(t.pending, "/api/schema/ui", { menus: [], panels: [], widgets: [] });
    answerAll(t.pending, "/api/projects/pD/chats", chatsOf("pD", "cD"));
    // The optimistic history read for the stale id answers 404, exactly as
    // the server would — the speculation is refused, not believed.
    for (const p of t.pending) {
      if (p.url.includes("/api/chats/gone/history") && !answered.has(p)) {
        answered.add(p);
        p.fail(new TypeError("not found"));
      }
    }
    answerAll(t.pending, "/api/projects", projectsOf("pD"));
    for (let i = 0; i < 50 && !completed; i += 1) await settle();
    await done;

    expect(currentChatId.get(), "a pointer the real list does not contain must clear").toBeNull();
    const conversation = lines.find((l) => l.id === "conversation");
    expect(conversation?.detail).toBe("kept conversation no longer exists");
    expect(conversation?.state).toBe("absent");
  });
});
