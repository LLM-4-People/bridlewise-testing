// @vitest-environment node
/**
 * Mechanical enforcement: a check-status change CANNOT be destroyed at write
 * time.
 *
 * THE MEASURED DEFECT
 *
 * The auto-checks store upserts each check's latest status —
 * `createAutoCheck`'s UPDATE overwrites `status` in place — so a flip
 * (passing → failing) was underivable from anything recorded anywhere.
 * `synthesis.conversationPulse` refused `checksFlipped` for exactly this
 * reason.
 *
 * THE FIX, PINNED HERE
 *
 * The upsert STAYS (the "latest" read stays one cheap row). Beside it, the
 * write choke point (`server/db/client.ts::createAutoCheck` — every caller
 * lands there: the run route's lint, the auto-checks route, the checks block
 * action) records an append-only `quality` event with a `check-status`
 * document carrying `{checkId, checkName, fromStatus, toStatus, projectId,
 * chatId}`. Run correlation comes from the ambient recording context — a
 * check upserted inside a run boundary carries that run id; a panel-run check
 * outside any run honestly carries none and stays reachable via its chat id.
 *
 * Assurance classes:
 *   A. Behavioural — two upserts of the same check produce ONE auto_checks
 *      row (dedup intact — deny nothing existing) and TWO ledger events with
 *      the true from→to chain (null→passed, passed→failed).
 *   B. Attribution — an upsert inside `withRecordingContext({runId})`
 *      carries the run id; one outside carries none.
 *   C. Derivability — `checksFlipped` is computable from the recorded events
 *      through the real store port (`checkStatusFacts`) and the real
 *      derivation (`computeConversationPulse`): the exact refusal the
 *      synthesis block used to return is now a measured fact.
 *
 * MUTATION-VERIFIED: removing the `recordCheckStatusEvent` call from
 * `createAutoCheck` fails A (one event instead of two) and C (unavailable);
 * recording `toStatus` as the from-status fails A's chain assertion.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { join } from "node:path";

import { DbClient } from "../../server/db/client.ts";
import { withRecordingContext, TIMELINE_CHECK_STATUS_DOCUMENT } from "../../server/kernel/canonical.ts";
import { getTimelineStore } from "../../server/observability/timeline-bridge.ts";
import { computeConversationPulse } from "../../server/blocks/synthesis.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let db: DbClient;
let userId: string;
let projectId: string;
let chatId: string;

beforeAll(() => {
  const dir = createTempDir("ch-check-history-");
  db = new DbClient({ path: join(dir, "web.db") });
  userId = createTestUser(db, "owner").userId;
  projectId = db.createProject({ name: "checks", path: dir }, userId).id;
  chatId = db.createChat({ project_id: projectId, title: "t" }, userId).id;
});

/** This chat's decoded check-status facts from the REAL ledger. */
function factsForChat() {
  return getTimelineStore().checkStatusFacts({ chatIds: [chatId] }).facts;
}

describe("A. the upsert keeps the latest row AND the ledger keeps the history", () => {
  test("two writes → one auto_checks row, two append-only events with the true from→to chain", () => {
    db.createAutoCheck({ project_id: projectId, chat_id: chatId, check_name: "typecheck", status: "passed", output: {} }, userId);
    db.createAutoCheck({ project_id: projectId, chat_id: chatId, check_name: "typecheck", status: "failed", output: { errors: 2 } }, userId);

    // The existing behaviour is denied nothing: still one row, latest status.
    const rows = db.listAutoChecksByChat(chatId, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");

    // The history stream holds BOTH writes, with the real transition chain.
    const typecheck = factsForChat().filter((f) => f.checkName === "typecheck");
    expect(typecheck.map((f) => [f.fromStatus, f.toStatus])).toEqual([
      [null, "passed"],
      ["passed", "failed"],
    ]);
    expect(typecheck[0]!.chatId).toBe(chatId);
  });
});

describe("B. run attribution comes from the ambient context, never from a call site", () => {
  test("a check upserted inside a run boundary carries the run id; outside, honestly none", () => {
    const runId = `run-chk-${Date.now().toString(36)}`;
    withRecordingContext({ actor: { kind: "agent", id: "llm" }, runId }, () => {
      db.createAutoCheck({ project_id: projectId, chat_id: chatId, check_name: "lint", status: "warning", output: {} }, userId);
    });
    db.createAutoCheck({ project_id: projectId, chat_id: chatId, check_name: "lint", status: "passed", output: {} }, userId);

    const lint = factsForChat().filter((f) => f.checkName === "lint");
    expect(lint).toHaveLength(2);
    expect(lint[0]!.runId, "inside the boundary → the run's own id").toBe(runId);
    expect(lint[1]!.runId, "outside any boundary → no fabricated run").toBe(null);

    // Run-scoped read (what a conversation's runs resolve to) finds it too.
    const byRun = getTimelineStore().checkStatusFacts({ runIds: [runId] }).facts;
    expect(byRun.map((f) => f.checkName)).toEqual(["lint"]);
  });
});

describe("C. checksFlipped is now derivable — the synthesis refusal is lifted for recorded history", () => {
  test("the real derivation over the real ledger measures the flips these writes produced", () => {
    const pulse = computeConversationPulse(getTimelineStore(), [], chatId);
    expect(pulse.checksFlipped.status).toBe("measured");
    if (pulse.checksFlipped.status !== "measured") return;
    const v = pulse.checksFlipped.value;
    // typecheck: passed→failed = 1 flip; lint: warning→passed = 1 flip.
    expect(v.byCheck["typecheck"]).toBe(1);
    expect(v.byCheck["lint"]).toBe(1);
    expect(v.flips).toBe(2);
    expect(pulse.checksFlipped.derivation).toContain("check-status records");
  });

  test("the document name is the canonical constant (the read joins on it)", () => {
    expect(TIMELINE_CHECK_STATUS_DOCUMENT).toBe("check-status");
  });
});
