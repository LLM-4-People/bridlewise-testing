// @vitest-environment node
/**
 * CUSTODY feed — the session state machine behind the room and the reel
 * badge (§7.2). Absence-first honesty pinned at the unit:
 *
 *   - every project starts as explicit "pending" and only ever becomes
 *     measured from a real (injected) read;
 *   - a refused read becomes ABSENCE with plain words (MUTATION: an error
 *     wall or a fake zero fails here);
 *   - a malformed payload becomes absence, never a partial guess;
 *   - requests are idempotent per session; refresh re-reads;
 *   - the chat-count derivation feeds the reel badge from measured states
 *     only.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  custodyChatCounts,
  custodyHistories,
  custodyStates,
  refreshCustody,
  requestCustody,
  requestCustodyHistory,
  resetCustodyFeed,
  revalidateCustody,
  setCustodyReaders,
} from "../../src/cockpit/rooms/custody-feed.ts";
import { ClientError } from "../../src/data/errors.ts";

const STATE = {
  repository: true,
  branch: "main",
  parcels: [
    {
      id: "run-1",
      attribution: {
        kind: "conversation",
        runId: "run-1",
        chatId: "c1",
        chatTitle: "t",
        turn: 1,
        requestText: "r",
        lastTouchedAt: "2026-07-25T00:00:00Z",
      },
      files: [
        { path: "a.ts", state: "changed", insertions: 1, deletions: 0 },
        { path: "b.ts", state: "changed", insertions: 2, deletions: 1 },
      ],
      insertions: 3,
      deletions: 1,
      derivation: "t",
    },
  ],
  join: {
    changedFiles: 2,
    attributedFiles: 2,
    filesBeyondPathCap: 0,
    fileEffectEventsExamined: 4,
    undecodableEffects: 0,
    truncated: false,
    withheldRuns: 0,
  },
};

const HISTORY = { repository: true, commits: [], remoteConfigured: false };

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetCustodyFeed());
afterEach(() => resetCustodyFeed());

describe("absence-first states", () => {
  test("pending → measured from a real read; the badge derivation follows", async () => {
    let calls = 0;
    setCustodyReaders({
      state: async () => {
        calls += 1;
        return STATE;
      },
      history: async () => HISTORY,
    });
    requestCustody("p1");
    expect(custodyStates.get()["p1"]).toEqual({ kind: "pending" });
    await settle();
    const load = custodyStates.get()["p1"];
    expect(load?.kind).toBe("measured");
    expect(custodyChatCounts.get()).toEqual({ c1: 2 });
    // Idempotent: a second request does not re-read.
    requestCustody("p1");
    await settle();
    expect(calls).toBe(1);
  });

  test("a refused read is plain-words absence, never an error wall or a zero", async () => {
    setCustodyReaders({
      state: async () => {
        throw new ClientError("forbidden", "no", 403);
      },
    });
    requestCustody("p1");
    await settle();
    expect(custodyStates.get()["p1"]).toEqual({
      kind: "absent",
      reason: "not available to this session",
    });
    expect(custodyChatCounts.get()).toEqual({});
    // MUTATION arm: absence is retryable — the next request re-reads.
    setCustodyReaders({ state: async () => STATE });
    requestCustody("p1");
    await settle();
    expect(custodyStates.get()["p1"]?.kind).toBe("measured");
  });

  test("a malformed payload becomes absence, never a partial guess", async () => {
    setCustodyReaders({ state: async () => ({ repository: "??" }) });
    requestCustody("p1");
    await settle();
    const load = custodyStates.get()["p1"];
    expect(load?.kind).toBe("absent");
    expect((load as { reason: string }).reason).toMatch(/shape/);
  });

  test("history follows the same discipline", async () => {
    setCustodyReaders({ history: async () => HISTORY });
    requestCustodyHistory("p1");
    expect(custodyHistories.get()["p1"]).toEqual({ kind: "pending" });
    await settle();
    expect(custodyHistories.get()["p1"]?.kind).toBe("measured");
  });

  test("refresh forces both reads again", async () => {
    let stateCalls = 0;
    let historyCalls = 0;
    setCustodyReaders({
      state: async () => {
        stateCalls += 1;
        return STATE;
      },
      history: async () => {
        historyCalls += 1;
        return HISTORY;
      },
    });
    requestCustody("p1");
    requestCustodyHistory("p1");
    await settle();
    refreshCustody("p1");
    await settle();
    expect(stateCalls).toBe(2);
    expect(historyCalls).toBe(2);
  });
});

/**
 * ── THE PRINCIPLED REFUSAL IS ITS OWN STATE ────────────────────────────────
 *
 * A typed 503 is the server DECLINING with its own sentence (`git_not_run`:
 * "this server would not run git"). Two defects pinned here:
 *   - the sentence was dropped for the generic "not available right now"
 *     and the state rendered as a broken read (refused ≠ failed);
 *   - the refusal was re-polled on every request: 130+ identical 503s per
 *     session for an answer known in advance. A standing refusal does not
 *     requeue; a custody write (refresh) clears it.
 */
describe("principled refusals (typed 503)", () => {
  const GIT_NOT_RUN =
    "The unsaved change counts could not be read because this server would not run git: confinement is active";

  test("a typed 503 becomes REFUSED with the server's own sentence", async () => {
    setCustodyReaders({
      state: async () => {
        throw new ClientError("git_not_run", GIT_NOT_RUN, 503);
      },
      history: async () => {
        throw new ClientError("git_not_run", GIT_NOT_RUN, 503);
      },
    });
    requestCustody("p1");
    requestCustodyHistory("p1");
    await settle();
    expect(custodyStates.get()["p1"]).toEqual({ kind: "refused", reason: GIT_NOT_RUN });
    expect(custodyHistories.get()["p1"]).toEqual({ kind: "refused", reason: GIT_NOT_RUN });
  });

  test("a standing refusal is NOT re-polled by further requests", async () => {
    let calls = 0;
    setCustodyReaders({
      state: async () => {
        calls += 1;
        throw new ClientError("git_not_run", GIT_NOT_RUN, 503);
      },
    });
    requestCustody("p1");
    await settle();
    expect(calls).toBe(1);
    // N further requests (every reel render, every room open) — zero reads.
    for (let i = 0; i < 5; i += 1) requestCustody("p1");
    await settle();
    expect(calls).toBe(1);
    expect(custodyStates.get()["p1"]?.kind).toBe("refused");
  });

  test("a custody write (refresh) clears the refusal and re-reads", async () => {
    let refuse = true;
    let calls = 0;
    setCustodyReaders({
      state: async () => {
        calls += 1;
        if (refuse) throw new ClientError("git_not_run", GIT_NOT_RUN, 503);
        return STATE;
      },
      history: async () => HISTORY,
    });
    requestCustody("p1");
    await settle();
    expect(custodyStates.get()["p1"]?.kind).toBe("refused");
    // Something changed (keep/undo/init recorded through the write door).
    refuse = false;
    refreshCustody("p1");
    await settle();
    expect(calls).toBe(2);
    expect(custodyStates.get()["p1"]?.kind).toBe("measured");
  });

  test("a BARE 503 (no typed code, no server sentence) stays a retryable failure", async () => {
    setCustodyReaders({
      state: async () => {
        throw new ClientError("http_503", "HTTP 503", 503);
      },
    });
    requestCustody("p1");
    await settle();
    // A proxy's own 503 is transport, not a decision — absent, and retryable.
    expect(custodyStates.get()["p1"]?.kind).toBe("absent");
    setCustodyReaders({ state: async () => STATE });
    requestCustody("p1");
    await settle();
    expect(custodyStates.get()["p1"]?.kind).toBe("measured");
  });
});

/**
 * ── REVALIDATE ON SHOW ─────────────────────────────────────────────────────
 *
 * Custody changes under this client with no client act to invalidate on (a
 * `git init` in a terminal, a commit made outside). The room's open gesture
 * is the honest revalidation moment: measured states re-read FRESH without
 * blanking; nothing else moves.
 */
describe("revalidateCustody — the room-open re-read", () => {
  test("a measured state re-reads fresh, without flipping to pending", async () => {
    let stateCalls: Array<boolean | undefined> = [];
    setCustodyReaders({
      state: async (_id, fresh) => {
        stateCalls.push(fresh);
        return STATE;
      },
      history: async () => HISTORY,
    });
    requestCustody("p1");
    requestCustodyHistory("p1");
    await settle();
    expect(custodyStates.get()["p1"]?.kind).toBe("measured");

    let sawPending = false;
    const stop = custodyStates.subscribe((states) => {
      if (states["p1"]?.kind === "pending") sawPending = true;
    });
    revalidateCustody("p1");
    await settle();
    stop();
    // The re-read happened, FRESH (cache bypassed), and the screen never
    // blanked on the way.
    expect(stateCalls).toEqual([false, true]);
    expect(sawPending).toBe(false);
    expect(custodyStates.get()["p1"]?.kind).toBe("measured");
  });

  test("the measured 'not a repository' answer is re-measured — a git init is seen on reopen", async () => {
    let repo = false;
    setCustodyReaders({
      state: async () => ({ ...STATE, repository: repo, branch: repo ? "main" : null, parcels: repo ? STATE.parcels : [] }),
      history: async () => HISTORY,
    });
    requestCustody("p1");
    await settle();
    let load = custodyStates.get()["p1"];
    expect(load?.kind).toBe("measured");
    expect((load as { state: { repository: boolean } }).state.repository).toBe(false);
    // The world changed outside this client.
    repo = true;
    revalidateCustody("p1");
    await settle();
    load = custodyStates.get()["p1"];
    expect((load as { state: { repository: boolean } }).state.repository).toBe(true);
  });

  test("a standing REFUSAL does not revalidate — the identical read gets the identical refusal", async () => {
    let calls = 0;
    setCustodyReaders({
      state: async () => {
        calls += 1;
        throw new ClientError("git_not_run", "would not run git", 503);
      },
    });
    requestCustody("p1");
    await settle();
    expect(calls).toBe(1);
    revalidateCustody("p1");
    await settle();
    expect(calls).toBe(1);
  });

  test("nothing known → nothing to revalidate (the open's request* owns the first read)", async () => {
    let calls = 0;
    setCustodyReaders({
      state: async () => {
        calls += 1;
        return STATE;
      },
    });
    revalidateCustody("p1");
    await settle();
    expect(calls).toBe(0);
  });
});
