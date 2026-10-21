// @vitest-environment node
/**
 * A RUN THAT STOPS SAYS SO — ONCE — AND LEAVES NOTHING BEHIND IF IT NEVER
 * STARTED.
 *
 * ── THE DEFECT, AND WHY IT WAS WORSE THAN THE ONE IT REPLACED ──────────────
 *
 * Every publish on the executor's way out is guarded by "has this run been
 * stopped?", and cancelling is exactly what makes that true. So a CANCELLED
 * run published no terminal frame at all: the feed ended, the server closed
 * the socket, and — per the EventSource protocol — a server-closed stream is
 * an instruction to RECONNECT. The client closed only on `done`. The feed is
 * retained for a reconnect window, so every reconnect within it was served
 * the run's `model` `start` again, and each one appended another empty
 * assistant message.
 *
 * Before the feed existed, cancelling deleted the run and the first reconnect
 * met a 404, which stopped the loop. The replacement was wrong AND repeating,
 * which is the shape a retention window turns a missing terminal frame into.
 *
 * ── WHAT THIS FILE ASSERTS, AND WHY EACH ASSERTION IS THE ONE IT IS ────────
 *
 * The verdict for the loop is what a RECONNECT RECEIVES, not what the live
 * connection received. A live subscriber sees the terminal frame either way
 * once it is published; the loop lives entirely in what the retained feed
 * hands the NEXT connection, so that is what is measured.
 *
 * Liveness comes first everywhere: a run that never started publishes no
 * frames, and every assertion below would pass on it.
 *
 * ── THE SYMBOLS THIS FILE EXISTS TO COVER ─────────────────────────────────
 *
 * Measured from bytes across `tests/`, each of these appeared ZERO times
 * before this file: `finalizeRunningToolCallsForRun` (the server half of the
 * stranded-tool fix), `replay_gap`, `runFeedMaxFrames`, `runFeedRetentionMs`,
 * `subscribeToRunFeed`, `endRunFeed`, `resolveRunOwner`, `runFeedOwner`.
 * They are driven here, not named.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { responseEvents, type ResponsesFixture } from "../../engine/test/support/mock-provider.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

// ── The bound is made REACHABLE, and the fixture is derived from it ────────
//
// `runFeedMaxFrames` defaults to 4 000, which an ordinary test run never
// approaches — so a guard about what happens AT the bound would never reach
// it and would certify nothing. The bound is lowered here instead of the
// fixture being inflated to meet it: a performance fixture derived from the
// limit that bounds it is cheap and exact, and 400 text deltas to provoke a
// drop is neither.
//
// AT MODULE SCOPE, NOT IN A HOOK. `serverConfig` is re-resolved from the
// environment by the shared setup's `beforeAll`, which runs after this
// module's initialisation and before any test — so an env write here lands,
// and one inside a hook would be too late.
const RUN_FEED_MAX_FRAMES = 6;
process.env["HARNESS_WEB_RUN_FEED_MAX_FRAMES"] = String(RUN_FEED_MAX_FRAMES);


/** A prompt carrying this streams slowly, so a cancel has somewhere to land.
 *  A fixture that answers instantly deletes the condition under test: the run
 *  would be over before the cancel arrived, and "no terminal frame on cancel"
 *  could not happen for the guard to catch. */
const SLOW_MARKER = "stream-slowly-so-a-cancel-has-somewhere-to-land";

/** A prompt carrying this makes the provider call a REAL tool (read_file on a
 *  path that does not exist — a genuine error result) before finishing. The
 *  run-end read-back arm needs a tool call whose result the DB holds while
 *  the feed has already evicted the frames around it. */
const TOOL_MARKER = "call-a-tool-so-the-ledger-holds-a-result";
/** The callId the tool branch announces — the identity the DB row must carry
 *  (v17) and the read-back must serve, because it is what a live client card
 *  joins on. */
const TOOL_CALL_ID = "call-run-ends-tool-1";

// ── The merge branch (UIE-040's exact live sequence, end to end) ──────────
//
// A blocked create_artifact call whose valid fields the gate retains
// ({content, title} — the required 'type' missing), then the model's pure
// delta ({"type":"html"}) which the gate MERGES onto the retained half —
// the executor dispatches the whole. The recorded arguments must be the
// whole, not the delta.
const MERGE_MARKER = "repair-a-blocked-artifact-call";
const MERGE_PARTIAL_ARGS = JSON.stringify({
  content: "<p>the retained half</p>",
  title: "the drive title",
});
const MERGE_DELTA_ARGS = JSON.stringify({ type: "html" });
const MERGE_WHOLE = {
  content: "<p>the retained half</p>",
  title: "the drive title",
  type: "html",
} as const;

// ── The trip branch (UIE-041) — the identical invalid call, six times ──────
//
// A complete create_artifact call whose 'type' is outside the declared enum:
// blocked as a schema mismatch, six identical times — the gate escalates at
// the third and auto-trips at the sixth, and the run's ending must carry the
// revert that restores the row.
const TRIP_MARKER = "keep-calling-the-artifact-tool-identically";
const TRIP_ARGS = JSON.stringify({ type: "movie", title: "t", content: "<p>x</p>" });

// ── The switch branch — the live-reveal wire's scenario ───────────────────
//
// Turn 1's read_file fails (a consequential tool), turn 2 switches to
// list_files (a DIFFERENT tool that succeeds) — the workaround detector's
// exact firing shape, so the run's safety report carries a REAL finding
// whose own ledger address the persist-first publish must carry on the frame.
const SWITCH_MARKER = "switch-tools-so-the-workaround-fires";
/** Which request of the switch sequence this is. */
let switchBranchStep = 0;

// ── The fail branch — a mid-call provider failure ──────────────────────────
//
// A prompt carrying this marker makes the provider hold the request briefly
// (the window the steer arm needs to queue an instruction while the call is
// provably in flight) and then refuse it 401 — an auth-class, non-retryable
// failure the shared client fails fast on. The bridge has already yielded the
// call's "start" before the request, so the refusal dies MID-CALL: the model
// `error` event follows, and the run's own ending is what these arms judge.
// Keyed off the LAST user message for the same reason every branch here is:
// the follow-up turn of a steered run still carries the marked prompt in its
// history, and a whole-body key would fail that turn too.
const FAIL_MARKER = "fail-mid-call-so-the-run-ends-in-failure";
const POLICY_MARKER = "policy-refusal-must-not-drain-the-queued-steer";
const POLICY_EDIT_MARKER = "explicit-reviewed-edit-after-policy";
const policyEditArgs = { path: "policy-destination.txt", oldString: "original policy bytes", newString: "explicitly reviewed bytes" };
let policyEditArmed = false;
let failPolicyProjection = false;
let steerPersistence: { ready(): void; released: Promise<void> } | undefined;
let mappingObserver: ((id: string, ids: readonly string[]) => Promise<void>) | undefined;
let policyPersistence: { ready(): void; released: Promise<void> } | undefined;
let policyBarrier: { ready(): void; released: Promise<void>; native: boolean; empty?: boolean } | undefined;

/** How many text deltas the provider emits for an ordinary prompt. Enough
 *  that the feed's bound is crossed and frames are genuinely dropped. */
const DELTA_COUNT = RUN_FEED_MAX_FRAMES * 3;

let providerHits = 0;
/** Tool-branch state: the FIRST request carrying the marker emits the tool
 *  call (finish reason "tool_calls"); every later request for the same
 *  conversation (the follow-up turn after the tool executed, whose history
 *  now contains the tool result) answers with a plain stop — otherwise the
 *  provider would loop the same call forever. */
let toolBranchArmed = false;
/** Merge-branch step: which request of the repair sequence this is. */
let mergeBranchStep = 0;
/** Trip-branch counter: how many identical blocked calls have been issued. */
let tripBranchCalls = 0;

const provider: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    providerRequests.push({ url: req.url, body: JSON.parse(body || "{}") });
    if ((req.url ?? "").includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    providerHits += 1;
    // THE FAIL BRANCH — hoisted ABOVE the stream head, because a refusal is
    // not a stream: the request is held briefly (the window the steer arm
    // needs to queue an instruction while the call is provably in flight)
    // and then refused 401, an auth-class failure the shared client fails
    // fast on. The bridge has already yielded the call's "start" before the
    // request, so the refusal dies MID-CALL and the model `error` event
    // follows. The branch is keyed off the LAST user message for the same
    // reason every branch here is: the drain turn of a steered run still
    // carries the marked prompt in its history, and a whole-body key would
    // fail that turn too. The timer is dropped if the socket goes first.
    const failUser = body.lastIndexOf("\"role\":\"user\"");
    if (failUser >= 0 && body.slice(failUser).includes(POLICY_MARKER)) {
      providerBranches.push("policy");
      const barrier = policyBarrier;
      if (!barrier) throw new Error("Policy fixture requires an explicit release barrier");
      barrier.ready();
      void barrier.released.then(() => {
        const error = { code: "misalignment_policy_violation", message: "Review this conversation before continuing" };
        if (barrier.native) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const events = responseEvents({ id: "resp_policy", status: "failed", toolCalls: barrier.empty ? [] : [{ id: "policy-forbidden-tool", type: "function", function: { name: "edit", arguments: JSON.stringify(policyEditArgs) } }] });
          for (const event of events) res.write(`data: ${JSON.stringify(event.type === "response.failed" ? { ...event, response: { ...event.response as Record<string, unknown>, error } } : event)}\n\n`);
          res.end();
        } else {
          res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error }));
        }
      });
      return;
    }
    const wantsFail = failUser >= 0 && body.slice(failUser).includes(FAIL_MARKER);
    if (wantsFail) {
      providerBranches.push("fail");
      const timer = setTimeout(() => {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "the provider refused this call on purpose", code: "provider_refused" },
          }),
        );
      }, 400);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const textChunks = Array.from({ length: DELTA_COUNT }, (_, i) => `piece-${i} `);
    const wireEvents = (options: ResponsesFixture) => responseEvents({ id: `resp_run_${providerHits}`, model: "gemma-4-31b", ...options })
      .map(event => `data: ${JSON.stringify(event)}\n\n`);
    const finish = (): void => { for (const event of wireEvents({ chunks: textChunks })) res.write(event); res.end(); };
    // THE FIXTURE REPORTS THE BRANCH IT TOOK. A provider that chooses a
    // behaviour from prompt content and does not say which one it chose can
    // run the wrong scenario and produce a perfectly coherent wrong result —
    // and the branch is keyed off the LAST user message rather than the whole
    // body, because retrieved memories carry an earlier scenario's marker
    // into a later request and a fresh chat is not enough to stop that.
    const lastUser = body.lastIndexOf("\"role\":\"user\"");
    const slow = lastUser >= 0 && body.slice(lastUser).includes(SLOW_MARKER);
    const wantsEdit = policyEditArmed && lastUser >= 0 && body.slice(lastUser).includes(POLICY_EDIT_MARKER);
    const wantsTool = toolBranchArmed && lastUser >= 0 && body.slice(lastUser).includes(TOOL_MARKER);
    const wantsMerge = lastUser >= 0 && body.slice(lastUser).includes(MERGE_MARKER);
    const wantsTrip = lastUser >= 0 && body.slice(lastUser).includes(TRIP_MARKER);
    const wantsSwitch = lastUser >= 0 && body.slice(lastUser).includes(SWITCH_MARKER);
    providerBranches.push(wantsEdit ? "policy-edit" : slow ? "slow" : wantsTool ? "tool" : wantsMerge ? "merge" : wantsTrip ? "trip" : wantsSwitch ? "switch" : "fast");
    // One tool call, announced in one chunk, finished with reason
    // tool_calls — the minimal turn shape for driving the executor's
    // tool path through a real provider conversation.
    const toolCall = (id: string, args: string): void => {
      namedToolCall("create_artifact", id, args);
    };
    const namedToolCall = (toolName: string, id: string, args: string): void => {
      for (const event of wireEvents({ chunks: textChunks, toolCalls: [{ id, type: "function", function: { name: toolName, arguments: args } }] })) res.write(event);
      res.end();
    };
    if (wantsEdit) { policyEditArmed = false; namedToolCall("edit", "explicit-policy-edit", JSON.stringify(policyEditArgs)); return; }
    // THE MERGE BRANCH (UIE-040's exact live sequence): turn 1 sends the
    // partial the gate blocks and retains; turn 2 sends the pure delta the
    // gate merges onto the retained half — the executor dispatches the
    // whole; turn 3+ stops. Stepped by request count, because the
    // follow-up turns re-send the same last user turn.
    if (wantsMerge) {
      const step = mergeBranchStep;
      mergeBranchStep += 1;
      if (step === 0) {
        toolCall("call-merge-partial-1", MERGE_PARTIAL_ARGS);
        return;
      }
      if (step === 1) {
        toolCall("call-merge-delta-2", MERGE_DELTA_ARGS);
        return;
      }
      finish();
      return;
    }
    // THE TRIP BRANCH (UIE-041): the identical invalid-enum call, six
    // times — the gate's escalation at 3 and auto-trip at 6 — then a
    // plain stop. A unique callId per turn, the way a real provider
    // issues retries.
    if (wantsTrip) {
      const call = tripBranchCalls;
      tripBranchCalls += 1;
      if (call < 6) {
        toolCall(`call-trip-${String(call)}`, TRIP_ARGS);
        return;
      }
      finish();
      return;
    }
    // THE SWITCH BRANCH: turn 1 fails a consequential read, turn 2 switches
    // to a DIFFERENT tool that succeeds, turn 3+ stops — the workaround
    // detector's firing shape, producing a REAL safety finding whose
    // ledger address the frame must carry (the persist-first order).
    if (wantsSwitch) {
      const step = switchBranchStep;
      switchBranchStep += 1;
      if (step === 0) {
        namedToolCall("read_file", "call-switch-read-1", "{\"path\":\"no-such-file-for-the-switch.txt\"}");
        return;
      }
      if (step === 1) {
        namedToolCall("list_files", "call-switch-list-2", "{}");
        return;
      }
      finish();
      return;
    }
    if (wantsTool) {
      // Emit enough text deltas to cross the feed's bound first — the run's
      // frames evict exactly like the fast scenario — then the tool call.
      toolBranchArmed = false;
      namedToolCall("read_file", TOOL_CALL_ID, "{\"path\":\"no-such-file-for-read-back.txt\"}");
      return;
    }
    if (!slow) {
      finish();
      return;
    }
    const slowEvents = wireEvents({ chunks: textChunks });
    let i = 0;
    const tick = setInterval(() => {
      if (i < slowEvents.length) { res.write(slowEvents[i++]!); return; }
      clearInterval(tick); res.end();
    }, 200);
    res.on("close", () => clearInterval(tick));
  });
});
const providerBranches: string[] = [];
const providerRequests: { url: string | undefined; body: Record<string, unknown> }[] = [];

await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
const PROVIDER_PORT = (provider.address() as { port: number }).port;
// NO LLM CONFIG FILE. The provider the run uses comes from the caller's
// saved database record — see the `seedProvider` call below, which points it
// at the provider server this file just stood up.
delete process.env["HARNESS_WEB_LLM_FIXTURES"];

let app: Server;
let baseUrl = "";
let db: import("../../server/db/client.ts").DbClient;
let adb: import("../../server/db/async-client.ts").AsyncDbClient;
let authHeaders: Record<string, string>;
let projectId = "";
let chatId = "";
let ownerUserId = "";
let tmpRoot = "";
// The project folder is SEPARATE from the state folder: a project that
// contains the harness's own database key is refused by the keep-out rule.
let projectRoot = "";

/** Claim failures injected at the facade, and the run ids they refused. The
 *  count is the PLANT'S LIVENESS: a leak assertion that passes because the
 *  refusal never happened is measuring nothing. */
let refuseClaims = false;
const refusedRunIds: string[] = [];

/** Setup-window read failures injected at the same facade, one door deeper
 * than the claim: the claim was written, so the run was ADMITTED, and the
 * throw lands INSIDE the executor's callback — in the stretch between the
 * claim and the first turn (the setup window: tool settings, the safety
 * gate, the safety runtime, prompt assembly) whose ending section 3b drives.
 * The two reads are the window's own awaited facade calls — its first
 * statement (the per-user tool settings) and its mid-window prompt-prefs
 * read — and neither is reached by the start route, so a 201 from an armed
 * door proves the failure was the executor's, not the route's refusal. */
let failSetupRead: "toolSettings" | "promptPrefs" | null = null;
const setupReadsFailed: string[] = [];

beforeAll(async () => {
  tmpRoot = createTempDir("ch-run-ends-");
  projectRoot = join(tmpRoot, "project");
  mkdirSync(projectRoot, { recursive: true });

  const { createRouter } = await import("../../server/router/router.ts");
  const { isPublicPath } = await import("../../server/routes/registry.ts");
  const { DbClient } = await import("../../server/db/client.ts");
  const { AsyncDbClient } = await import("../../server/db/async-client.ts");
  const { registerRunRoutes } = await import("../../server/routes/run.ts");
  const { registerRunStreamRoutes } = await import("../../server/routes/run-stream.ts");
  const { registerProjectRoutes } = await import("../../server/routes/projects.ts");
  const { registerChatRoutes } = await import("../../server/routes/chats.ts");
  const { createTestUser, seedProvider } = await import("../helpers/multi-user.ts");

  db = new DbClient({ path: join(tmpRoot, "web.db") });
  const user = createTestUser(db, "run-ends-tester");
  // The run path resolves its provider from the caller's saved record and
  // REFUSES when there is none, so a run test's subject must be a configured
  // account. Pointed at this file's own provider server, so the run reaches a
  // real endpoint under this test's control rather than a stub of the client.
  seedProvider(db, user.userId, { baseUrl: `http://127.0.0.1:${String(PROVIDER_PORT)}/v1` });
  adb = AsyncDbClient.inline(db);
  const realRunIdsForChat = adb.runIdsForChat.bind(adb);
  adb.runIdsForChat = async (id, userId) => { const ids = await realRunIdsForChat(id, userId); await mappingObserver?.(id, ids); return ids; };
  const realCreateMessage = adb.createMessage.bind(adb);
  adb.createMessage = async (...args: Parameters<typeof realCreateMessage>) => {
    if (args[0].role === "error" && (args[0].metadata as { errorCode?: string } | undefined)?.errorCode === "llm_misalignment_policy_violation" && failPolicyProjection) throw new Error("policy projection fixture failure");
    if (args[0].role === "user" && args[0].content === "held steer persistence" && steerPersistence) { const held = steerPersistence; held.ready(); await held.released; }
    if (args[0].role === "error" && (args[0].metadata as { errorCode?: string } | undefined)?.errorCode === "llm_misalignment_policy_violation" && policyPersistence) {
      const held = policyPersistence;
      held.ready(); await held.released;
    }
    return realCreateMessage(...args);
  };

  // THE REFUSAL IS INJECTED AT THE DATA FACADE, not simulated further down.
  // `claimRunExecution` re-throws anything that is not a uniqueness violation
  // — correctly — so a genuine failure (a disk error, a locked database) is
  // reachable at exactly this point, which is AFTER the start route has
  // written its registry entry and BEFORE the executor's `finally` exists to
  // clean anything up. That window is where five feeds and five registry
  // entries used to be stranded, so that window is what is driven.
  const realClaim = adb.claimRunExecution.bind(adb);
  adb.claimRunExecution = async (runId: string, userId: string): Promise<void> => {
    if (!refuseClaims) return realClaim(runId, userId);
    refusedRunIds.push(runId);
    throw new Error("injected: the claim could not be written");
  };

  // The setup-window seam (section 3b) — the same facade, the same
  // injection shape, installed for the same reason: the throw must be the
  // data layer's own, not a stub of the executor. One-shot per arming (the
  // flag clears as it fires) so a run that somehow survives the plant
  // cannot fail a LATER read for a reason the test never armed.
  const realListToolSettings = adb.listToolSettings.bind(adb);
  adb.listToolSettings = async (
    userId: string,
  ): Promise<readonly import("../../server/db/schema.ts").ToolSettingRow[]> => {
    if (failSetupRead !== "toolSettings") return realListToolSettings(userId);
    failSetupRead = null;
    setupReadsFailed.push("injected: the tool settings read could not happen");
    throw new Error("injected: the tool settings read could not happen");
  };
  const realGetUserPromptPrefs = adb.getUserPromptPrefs.bind(adb);
  adb.getUserPromptPrefs = async (userId: string): Promise<unknown | null> => {
    if (failSetupRead !== "promptPrefs") return realGetUserPromptPrefs(userId);
    failSetupRead = null;
    setupReadsFailed.push("injected: the prompt prefs read could not happen");
    throw new Error("injected: the prompt prefs read could not happen");
  };

  const router = createRouter({ db: adb, isPublicPath });
  registerProjectRoutes(router, adb);
  registerChatRoutes(router, adb);
  registerRunRoutes(router, adb);
  registerRunStreamRoutes(router, adb);

  app = createServer((req, res) => router.dispatch(req, res));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${String((app.address() as { port: number }).port)}`;
  authHeaders = {
    Cookie: `${user.cookie}; harness_session=run-ends`,
    "Content-Type": "application/json",
    "X-Requested-With": "test",
  };
  const project = db.createProject({ name: "run-ends", path: projectRoot }, user.userId);
  const chat = db.createChat({ project_id: project.id, title: "run-ends" }, user.userId);
  projectId = project.id;
  chatId = chat.id;
  ownerUserId = user.userId;
}, 60_000);

afterAll(async () => {
  const { releaseAllRunFeeds } = await import("../../server/run/run-feed.ts");
  releaseAllRunFeeds();
  if (app) await new Promise<void>((r) => app.close(() => r()));
  if (provider) await new Promise<void>((r) => provider.close(() => r()));
  if (db) db.close();
});

// ── Wire helpers ──

type Frame = { id: number | null; event: string; data: string };

/** Read an SSE response for `ms`, returning its status and frames. */
async function drain(
  path: string,
  extraHeaders: Record<string, string>,
  ms: number,
): Promise<{ status: number; frames: Frame[] }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { ...authHeaders, ...extraHeaders } });
  const frames: Frame[] = [];
  if (res.status !== 200 || res.body === null) {
    // Drain the body so the socket closes rather than lingering.
    await res.text().catch(() => "");
    return { status: res.status, frames };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const idMatch = /^id: (\d+)$/m.exec(block);
        const eventMatch = /^event: (\S+)$/m.exec(block);
        const dataMatch = /^data: (.*)$/m.exec(block);
        if (eventMatch) {
          frames.push({
            id: idMatch ? Number(idMatch[1]) : null,
            event: eventMatch[1]!,
            data: dataMatch?.[1] ?? "",
          });
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } catch {
    // the stream ended under us; whatever was parsed is what arrived
  }
  try {
    await reader.cancel();
  } catch {
    // already gone
  }
  return { status: res.status, frames };
}

async function startRun(prompt: string): Promise<{ status: number; runId: string; refusalCode?: string | undefined }> {
  const res = await fetch(`${baseUrl}/api/run/start`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId, prompt, chatId }),
  });
  const body = (await res.json()) as { runId?: string; refusal?: { code?: string } };
  return { status: res.status, runId: body.runId ?? "", refusalCode: body.refusal?.code };
}

async function cancelRun(runId: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/run/${runId}/cancel`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });
  await res.text();
  return res.status;
}

/** Queue a steering instruction on a live run — the drain arm's act. */
async function steerRun(runId: string, prompt: string): Promise<{ status: number; queued: number | null; refusalCode?: string | undefined }> {
  const res = await fetch(`${baseUrl}/api/run/${runId}/steer`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ prompt }),
  });
  const body = (await res.json().catch(() => ({}))) as { queued?: number; refusal?: { code?: string } };
  return { status: res.status, queued: typeof body.queued === "number" ? body.queued : null, refusalCode: body.refusal?.code };
}

/** Wait for a condition, failing with what was being waited for. The timeout
 *  is a failure rather than a fallback: continuing past an unmet precondition
 *  makes every assertion after it a statement about something that did not
 *  happen. */
async function waitUntil(ok: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (ok()) return;
    if (Date.now() > deadline) throw new Error(`${what} (waited ${String(timeoutMs)}ms)`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Wait until the run has published at least `count` frames. The timeout is a
 *  failure, not a fallback: a run that publishes nothing is a run there is
 *  nothing to interrupt, and every assertion about interrupting it would be
 *  measuring a run that never started. */
async function waitForFrames(runId: string, count: number, timeoutMs = 5_000): Promise<void> {
  const { runFeedState } = await import("../../server/run/run-feed.ts");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((runFeedState(runId)?.frames ?? 0) >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} published fewer than ${String(count)} frames within ${String(timeoutMs)}ms — ` +
          `there is nothing in flight to cancel, so the case under test cannot happen`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Poll the feed's own terminal flag rather than sleeping a constant. A fixed
 *  sleep is a budget, not a wait; the timeout is a failure because a run that
 *  never ends makes every assertion after it a measurement of nothing. */
async function runToCompletion(runId: string, timeoutMs = 10_000): Promise<void> {
  const { runFeedState } = await import("../../server/run/run-feed.ts");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (runFeedState(runId)?.ended === true) {
      await new Promise((r) => setTimeout(r, 60));
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach a terminal state within ${String(timeoutMs)}ms — ` +
          `every assertion after this point would be measuring a run that never finished`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── 1. A cancelled run announces itself, and the reconnect loop is over ────

describe("a run that stops publishes a terminal frame, on every path", () => {
  test(
    "a CANCELLED run publishes a terminal frame, and a reconnect is told rather than replayed forever",
    async () => {
      const before = providerBranches.length;
      const { status, runId } = await startRun(`cancel me ${SLOW_MARKER}`);
      expect(status).toBe(201);

      // Attach a live subscriber and let the run genuinely begin, so the
      // cancel lands mid-stream rather than before anything happened.
      //
      // POLLED, NOT SLEPT. A fixed sleep is a budget: it pays for the slowest
      // case on every run, and this file's whole cost lands on a suite
      // wall-clock gate. Waiting for the condition itself — the run has
      // published something, so there is something to interrupt — is both
      // faster and a stronger precondition than a constant that happens to be
      // long enough today.
      const live = drain(`/api/run/${runId}/stream`, {}, 3_000);
      // The condition is the PROVIDER having been reached and having reported
      // which branch it took — not a frame count, because the run publishes
      // its context frame before it calls anyone, so "two frames" is true
      // while nothing is yet in flight.
      await waitUntil(
        () => providerBranches.length > before,
        "the provider was never reached, so there was no turn in flight to cancel",
      );
      await waitForFrames(runId, 2);

      // LIVENESS OF THE FIXTURE: the provider took the SLOW branch, so there
      // was a run in flight to cancel. Without this the whole test can pass
      // against a run that had already finished.
      expect(providerBranches.slice(before), "the slow branch must have been taken").toContain("slow");

      expect(await cancelRun(runId)).toBe(200);
      await runToCompletion(runId);

      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const state = runFeedState(runId);
      expect(state, "the feed is retained after the run ends").toBeDefined();

      // LIVENESS: the run really published something before it was stopped.
      expect(state!.frames).toBeGreaterThan(0);

      // THE VERDICT — the feed says the run said it was over.
      expect(
        state!.terminalPublished,
        "a cancelled run published no terminal frame: every reconnect for the whole " +
          "retention window replays the run and appends another empty assistant message",
      ).toBe(true);

      const liveFrames = await live;
      expect(liveFrames.frames.map((f) => f.event)).toContain("cancelled");

      // THE VERDICT THAT MATTERS: what the NEXT connection is handed. The
      // loop lived here — a reconnect that receives no terminal frame does
      // not close, and comes back again.
      const reconnect = await drain(`/api/run/${runId}/stream`, {}, 1_200);
      expect(reconnect.status).toBe(200);
      expect(reconnect.frames.length).toBeGreaterThan(0);
      expect(
        reconnect.frames.map((f) => f.event),
        "a reconnect within the retention window is replayed the run and must be replayed " +
          "its ending too, or it will reconnect again and re-append what it already showed",
      ).toContain("cancelled");

      // …and exactly one ending, not one per exit path that felt like adding
      // its own. A second terminal frame would be a second answer.
      const terminals = reconnect.frames.filter((f) =>
        ["done", "cancelled", "error"].includes(f.event),
      );
      expect(terminals.length).toBe(1);
      expect(terminals[0]!.event).toBe("cancelled");
    },
    40_000,
  );

  test(
    "a run that completes still ends with exactly one `done`, and is not also 'cancelled'",
    async () => {
      // THE CONTROL. Without it, "always publish a terminal frame" is
      // satisfied by publishing one on every path including the ones that
      // already had one — two endings, or the wrong ending on a healthy run.
      const { runId } = await startRun("complete normally");
      await runToCompletion(runId);

      const replay = await drain(`/api/run/${runId}/stream`, {}, 1_200);
      const terminals = replay.frames.filter((f) =>
        ["done", "cancelled", "error"].includes(f.event),
      );
      expect(terminals.length).toBe(1);
      expect(terminals[0]!.event).toBe("done");

      // …AND NOTHING THE RUN COMPUTED IS PUBLISHED BEHIND IT.
      //
      // `done` means "the client closes the stream", so a frame published
      // after it is delivered to an audience that was told to leave. It was:
      // `done` went out BEFORE the run's timeline events, so every one of
      // them was written to closed sockets. The tell is not that `done` is
      // last — evicting or refusing the later frames also leaves it last —
      // it is that the later frames ARE THERE, in front of it.
      const trailing = replay.frames.filter((f) => ["timeline", "agent"].includes(f.event));
      expect(
        trailing.length,
        "the run's timeline frames never reached the record: they were published after the " +
          "terminal frame, to a client that had been told the run was over",
      ).toBeGreaterThan(0);
      const ids = replay.frames.filter((f) => f.id !== null).map((f) => f.id as number);
      expect(terminals[0]!.id, "the ending must be the last thing in the record").toBe(
        Math.max(...ids),
      );
      for (const f of trailing) expect(f.id).toBeLessThan(terminals[0]!.id!);
    },
    40_000,
  );

  test("the terminal vocabulary is one owner, and it is what the feed demands", async () => {
    const { TERMINAL_SSE_EVENT_TYPES, isTerminalSseEventType, SSE_EVENT_TYPES } = await import(
      "../../shared/constants.ts"
    );
    // Stated as a runtime population rather than assumed non-empty.
    expect(TERMINAL_SSE_EVENT_TYPES.length).toBeGreaterThanOrEqual(3);
    for (const t of TERMINAL_SSE_EVENT_TYPES) expect(isTerminalSseEventType(t)).toBe(true);
    // A frame that reports something ABOUT a run still in flight is NOT
    // terminal — closing on one would end a healthy run.
    expect(isTerminalSseEventType(SSE_EVENT_TYPES.replayGap)).toBe(false);
    expect(isTerminalSseEventType(SSE_EVENT_TYPES.steered)).toBe(false);
    expect(isTerminalSseEventType(SSE_EVENT_TYPES.quality)).toBe(false);
    expect(isTerminalSseEventType("bogus")).toBe(false);
  });
});

// ── 2. The server half of the stranded-tool fix ────────────────────────────

describe("no tool call outlives its run — the SERVER half", () => {
  test(
    "a tool call left `running` by a cancelled run is finalised by the executor's exit",
    async () => {
      // `finalizeRunningToolCallsForRun` had ZERO test occurrences. The
      // similarly-named CLIENT function was covered; the server one, which is
      // the half that survives a page reload, was not — so an INERT mutation
      // of it (scope the update by the wrong user id, finalise nothing,
      // return 0, throw nothing) would have escaped everything.
      const { runId } = await startRun(`hold a tool open ${SLOW_MARKER}`);

      // Plant a `running` row the way the executor creates them: a tool
      // message carrying this run's id, and a tool_calls row against it.
      const toolMessage = db.createMessage(
        { chat_id: chatId, role: "tool", content: "read_file", run_id: runId },
        ownerUserId,
      );
      const planted = db.createToolCall(
        { message_id: toolMessage.id, tool_name: "read_file", input: { path: "x" }, status: "running" },
        ownerUserId,
      );

      // LIVENESS OF THE PLANT: it really is `running` before the run ends.
      expect(
        db.listToolCallsByMessage(toolMessage.id, ownerUserId).find((t) => t.id === planted.id)?.status,
      ).toBe("running");

      expect(await cancelRun(runId)).toBe(200);
      await runToCompletion(runId);

      const after = db
        .listToolCallsByMessage(toolMessage.id, ownerUserId)
        .find((t) => t.id === planted.id);
      expect(after, "the planted row must still exist — finalising is not deleting").toBeDefined();
      expect(
        after!.status,
        "a tool call left running by a run that ended is served back as 'running' on every " +
          "later reload, forever: there is no sweeper and no startup pass",
      ).toBe("error");
      // And the output stays EMPTY — what is KNOWN is the status, and writing
      // the harness's own sentence where a tool result belongs was a
      // fabricated tool answer fed back through the history rebuild. An
      // empty output is also the fact the client's run-end read-back heals
      // on: status without output is an honest absence, never dressed up as
      // a result.
      expect(after!.output, "no synthesised sentence may sit where a tool result belongs").toBeNull();
    },
    40_000,
  );
});

// ── 2b. The run-end read-back — the ledger serves what the feed evicted ────

describe("a run whose frames were evicted still has its tool results in the read-back", () => {
  test(
    "the /tool-calls route serves the call's real result, joined by the persisted callId",
    async () => {
      // THE INCIDENT'S SHAPE, END TO END. A real run, long enough to cross the
      // feed's frame bound (the eviction), executes a real tool call whose
      // result frame the feed no longer holds for anyone reconnecting from
      // the start. The DB row — written by the executor BEFORE the run ended
      // — is the authority, and the route the client reads back at run end
      // must serve status + output + the callId the live card joins on, or
      // the stranded card cannot heal and its placeholder is a lie.
      toolBranchArmed = true;
      const { runId } = await startRun(`read a file for me ${TOOL_MARKER}`);
      await runToCompletion(runId);

      // LIVENESS OF THE SCENARIO: the tool branch actually fired (the fixture
      // reports it), and the feed actually evicted — a run that never crossed
      // its bound would make every "despite the eviction" claim vacuous.
      expect(providerBranches, "the tool branch must have fired").toContain("tool");
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const feed = runFeedState(runId);
      expect(feed, "the feed must still be inspectable within its retention window").toBeDefined();
      expect(
        feed!.droppedBefore,
        "the run must have evicted frames — a run under the bound certifies nothing about eviction",
      ).toBeGreaterThan(0);

      // THE LEDGER HALF: the row exists, carries the provider's stable callId
      // (the identity a live client card holds), and holds the call's REAL
      // result — an error result from the read of a file that does not exist.
      const row = db
        .listToolCallsByChat(chatId, ownerUserId)
        .find((t) => t.call_id === TOOL_CALL_ID);
      expect(row, "the tool_calls row must exist, keyed by the persisted callId").toBeDefined();
      expect(row!.status).toBe("error");
      expect(
        String(row!.output ?? ""),
        "the ledger holds the call's real result — the typed read refusal, not a synthesized sentence",
      ).toMatch(/file_not_found|no longer exists/i);

      // THE SERVED HALF: over HTTP, through the view mappers and their
      // redaction owner — the exact bytes the client's run-end read-back
      // receives.
      const res = await fetch(`${baseUrl}/api/chats/${chatId}/tool-calls`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const served = (await res.json()) as ReadonlyArray<{
        callId: string | null;
        status: string;
        output: unknown;
      }>;
      const servedRow = served.find((t) => t.callId === TOOL_CALL_ID);
      expect(servedRow, "the read-back route must serve the evicted call's row").toBeDefined();
      expect(servedRow!.status).toBe("error");
      expect(String(servedRow!.output ?? "")).toMatch(/file_not_found|no longer exists/i);
    },
    40_000,
  );
});

// ── 2b+. The safety-findings frame carries each finding's own address ──────

describe("the safety-findings frame carries each finding's own ledger address (the live reveal wire)", () => {
  test(
    "persist first, publish second — every finding the frame announces carries the event id the record holds",
    async () => {
      // THE DRIVE-18 ASYMMETRY, CLOSED AT ITS OWNER: the live frame used to
      // publish before the persist, so its findings arrived with no ledger
      // address and the client appended them anonymous — a live finding's
      // ledger row had no reveal affordance until a reload re-read the ids
      // (the round-75 TC's finding 4/5). The steer door's own order (persist,
      // then publish with the id the persist returned) is now the findings
      // door's too. MUTATION: revert the reorder (publish the bare string
      // messages before the persist loop) → the frame's findings carry no
      // eventId and the wire-shape assertion below reds naming the absence.
      switchBranchStep = 0;
      const { runId } = await startRun(`read a file then switch tools ${SWITCH_MARKER}`);
      await runToCompletion(runId);
      expect(providerBranches.slice(-3), "the switch branch must have fired").toContain("switch");

      const { frames } = await drain(`/api/run/${runId}/stream`, {}, 1_500);
      const safetyFrame = frames.find((f) => f.event === "safety_findings");
      expect(safetyFrame, "the run must publish its safety verdict").toBeDefined();
      const data = JSON.parse(safetyFrame!.data) as {
        runId: string;
        messages?: { message?: string; eventId?: string }[];
      };
      // LIVENESS OF THE SCENARIO: the fixture's failed read_file followed by
      // the model's plain text answer is exactly the workaround shape, so
      // the report holds a REAL finding — an empty report would certify
      // nothing about the per-finding shape.
      const findings = Array.isArray(data.messages) ? data.messages : [];
      expect(
        findings.length,
        "the fixture must produce a real finding — a failed read the model then answered around",
      ).toBeGreaterThan(0);

      // THE WIRE: every finding carries its own ledger address, and that
      // address IS one of the record's timeline refs for this chat — the
      // frame and the row name the same event, which is the whole join the
      // client's reveal map consumes.
      const refIds = new Set(db.listTimelineRefs(chatId, ownerUserId).map((r) => r.event_id));
      for (const finding of findings) {
        expect(typeof finding.message, "the finding's words ride the frame").toBe("string");
        expect(typeof finding.eventId, "the finding carries its own ledger address").toBe("string");
        expect(
          refIds.has(finding.eventId!),
          "the frame's address is the record's address — one event, one id, both faces",
        ).toBe(true);
      }
    },
    40_000,
  );
});

// ── 2c. The merged-artifact record (UIE-040, the whole pipeline) ───────────

describe("a gate-repaired artifact call records what RAN, end to end", () => {
  test(
    "the persisted row's input is the merged whole after the done frame lands — the 34ms clobber class",
    async () => {
      // THE DRIVE'S EXACT LIVE SEQUENCE, through the REAL executor: a
      // blocked create_artifact call whose valid fields the gate retains,
      // then the model's pure delta which the gate merges onto them, then
      // the follow-up turn. The earlier dispatched-arguments fix covered
      // each HALF in isolation — the executor's stamp (behavioral) and
      // the frame + row reads (source pins) — and the live pipeline still
      // failed, because the write ORDER was the defect: within one turn
      // iteration the done-event persist ran AFTER persistToolResult and
      // rewrote the row's input with the raw delta (measured: a 25-byte
      // patch landing 34ms after a 430-byte patch). This arm walks the
      // whole sequence — provider, gate, executor, both row writers, run
      // end — and asserts the record a reload renders from.
      //
      // MUTATION: reinstate the done-case `{ input: event.arguments }` row
      // write → the repaired row's input reads the bare delta and this
      // fails.
      const before = providerBranches.length;
      mergeBranchStep = 0;
      const { runId } = await startRun(`make an artifact ${MERGE_MARKER}`);
      await runToCompletion(runId);

      // LIVENESS OF THE SCENARIO: the provider took the merge branch for
      // the partial, the delta AND the settle — three turns really ran.
      expect(
        providerBranches.slice(before).filter((b) => b === "merge").length,
        "the merge branch must have fired for the partial, the delta and the settle",
      ).toBeGreaterThanOrEqual(3);

      const blockedRow = db
        .listToolCallsByChat(chatId, ownerUserId)
        .find((t) => t.call_id === "call-merge-partial-1");
      const repairedRow = db
        .listToolCallsByChat(chatId, ownerUserId)
        .find((t) => t.call_id === "call-merge-delta-2");
      expect(blockedRow, "the blocked attempt's row must exist").toBeDefined();
      expect(repairedRow, "the repairing delta's row must exist").toBeDefined();

      // THE BLOCKED CALL records what the model sent — the honest delta,
      // nothing was dispatched — and the gate's refusal.
      expect(blockedRow!.status).toBe("error");
      expect(String(blockedRow!.output ?? "")).toContain("missing required field 'type'");
      expect(blockedRow!.input).toEqual({
        content: "<p>the retained half</p>",
        title: "the drive title",
      });

      // THE REPAIRED CALL: the row's input IS the merged whole after both
      // writers ran — the dispatched arguments, never the bare delta. This
      // is the exact assertion the live drive made against the ledger.
      expect(repairedRow!.status).toBe("done");
      expect(String(repairedRow!.output ?? "")).toContain("\"ok\":true");
      expect(
        repairedRow!.input,
        "the persisted row's input must be what was DISPATCHED — the gate's merged whole, not the raw delta",
      ).toEqual(MERGE_WHOLE);

      // And the SERVED read-back — the exact bytes a reload's hydration and
      // the client's heal consume — carries the same whole.
      const res = await fetch(`${baseUrl}/api/chats/${chatId}/tool-calls`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const served = (await res.json()) as ReadonlyArray<{
        callId: string | null;
        status: string;
        input: unknown;
      }>;
      const servedRepaired = served.find((t) => t.callId === "call-merge-delta-2");
      expect(servedRepaired, "the read-back must serve the repaired call's row").toBeDefined();
      expect(
        servedRepaired!.input,
        "the reloaded view renders the artifact from THIS row — it must carry the merged whole",
      ).toEqual(MERGE_WHOLE);
    },
    40_000,
  );
});

// ── 2d. The ending carries the auto-trip revert (UIE-041, end to end) ──────

describe("the run's ending carries the gate auto-trip revert it performed", () => {
  test(
    "a tripped tool reverts at run end and the terminal frame says so; an ordinary run's says nothing",
    async () => {
      // The trip's own arrival was fixed by the earlier round (the
      // hallucination frame's autoTripped flag → the client fires
      // tools:changed); the DEPARTURE never arrived: the revert is a
      // server-side write no panel verb fired, so the panel's cached rows
      // kept the ▲ TRIPPED face for minutes after the wire read "on". The
      // revert rides the ONE publish every ending crosses, the same door
      // the trip rode its frame.
      //
      // MUTATION: drop the flag from the terminal frame (or the revert
      // itself) → the done-frame assertion below fails.
      const before = providerBranches.length;
      tripBranchCalls = 0;
      const { runId } = await startRun(`block create_artifact identically ${TRIP_MARKER}`);
      const live = drain(`/api/run/${runId}/stream`, {}, 10_000);
      await runToCompletion(runId);
      const gateFrames = (await live).frames.filter((frame) => frame.event === "hallucination")
        .map((frame) => JSON.parse(frame.data) as { eventId?: string; message: string });
      expect(gateFrames, "the live capture must include every actual blocked call").toHaveLength(tripBranchCalls - 1);
      const gateRows = db.listMessages(chatId, ownerUserId).filter((message) => message.run_id === runId && message.role === "event");
      const refs = new Set(db.listTimelineRefs(chatId, ownerUserId).map((ref) => ref.event_id));
      expect(new Set(gateFrames.map((frame) => frame.eventId)).size, "same-word blocks retain distinct recorded identities").toBe(gateFrames.length);
      for (const frame of gateFrames) {
        expect(typeof frame.eventId, "each persisted live block carries its canonical identity").toBe("string");
        expect(refs.has(frame.eventId!), "the live identity names a persisted timeline ref").toBe(true);
        const primary = gateRows.filter((message) => (message.metadata as { timelineEventId?: string } | null)?.timelineEventId === frame.eventId);
        expect(primary, "the live block names exactly its own primary message").toHaveLength(1);
        expect(primary[0]!.content).toBe(frame.message);
      }

      // LIVENESS OF THE SCENARIO: six identical blocked calls actually
      // happened (the gate auto-trips at the sixth), then the settle —
      // and the row the panel reads is back ON.
      expect(
        tripBranchCalls,
        "the provider must have issued six identical calls plus the settle",
      ).toBe(7);
      expect(
        providerBranches.slice(before).filter((b) => b === "trip").length,
      ).toBeGreaterThanOrEqual(7);
      const settings = db.listToolSettings(ownerUserId);
      expect(
        settings.find((s) => s.tool_name === "create_artifact")?.enabled,
        "the run-end revert restored the auto-tripped tool — the wire reads on",
      ).toBe(true);

      // THE VERDICT IS WHAT A RECONNECT RECEIVES (this file's own doctrine):
      // the retained feed's replay carries the done frame, and its data
      // carries the revert fact the client turns into the panel's
      // re-read.
      const replay = await drain(`/api/run/${runId}/stream`, {}, 1_500);
      const doneFrame = replay.frames.filter((f) => f.event === "done").at(-1);
      expect(doneFrame, "the run's done frame must be in the retained replay").toBeDefined();
      const doneData = JSON.parse(doneFrame!.data) as { runId?: string; autoTripsReverted?: boolean };
      expect(
        doneData.autoTripsReverted,
        "the ending must carry the auto-trip revert — without it the panel's tripped face outlives the trip by minutes",
      ).toBe(true);

      // THE CONTROL: an ordinary run that tripped nothing says nothing —
      // an invalidation nobody's data changed is the cry-wolf shape.
      const plainBefore = providerBranches.length;
      const plain = await startRun("a plain turn with no tools in it");
      await runToCompletion(plain.runId);
      expect(providerBranches.slice(plainBefore)).toContain("fast");
      const plainReplay = await drain(`/api/run/${plain.runId}/stream`, {}, 1_200);
      const plainDone = plainReplay.frames.filter((f) => f.event === "done").at(-1);
      expect(plainDone, "the ordinary run's done frame must be in the replay").toBeDefined();
      const plainData = JSON.parse(plainDone!.data) as { autoTripsReverted?: boolean };
      expect(
        "autoTripsReverted" in plainData,
        "a run that reverted nothing must not announce a revert",
      ).toBe(false);
    },
    60_000,
  );
});

// ── 2e. The run's own ending when its last call failed ─────────────────────

describe("a run whose last call failed ends by saying so", () => {
  test(
    "the terminal frame a reconnect receives is `error` carrying the failed call's own code — never `done`",
    async () => {
      // THE FINDING THIS ROUND CLOSES: an error model event recorded no
      // terminal frame, the turn loop broke with the finish reason still
      // at its initialized "stop", and `terminalFrame ??= done` stood — so
      // a run whose last call FAILED ended labeled `done`. The failure
      // reached the reader through its own records (the error row, the
      // ledger event), but the run's OWN ending was a lie a reconnect was
      // handed: the verdict for this loop is what a reconnect RECEIVES,
      // and the reconnect could not tell a failed run from a finished one.
      const before = providerBranches.length;
      const { runId } = await startRun(`fail this call ${FAIL_MARKER}`);
      // A LIVE subscriber attaches before the failure lands, so the call's
      // own error event is captured as published — the bounded buffer
      // evicts early frames by the time a reconnect reads the record, so
      // the live capture is the one honest witness of what the call said.
      const live = drain(`/api/run/${runId}/stream`, {}, 4_000);
      await runToCompletion(runId);

      // LIVENESS OF THE SCENARIO: the provider really took the fail branch
      // (a real request, a real refusal), and the run's own record holds
      // the failure where the design says — the error row the reader sees.
      expect(
        providerBranches.slice(before),
        "the fail branch must have been taken — a run that never failed certifies nothing about failed endings",
      ).toContain("fail");
      const errorRows = db
        .listMessages(chatId, ownerUserId)
        .filter((m) => m.run_id === runId && m.role === "error");
      expect(errorRows.length, "the failed call's own error row must exist").toBe(1);

      // THE VERDICT — the ending a reconnect is handed within the
      // retention window.
      const reconnect = await drain(`/api/run/${runId}/stream`, {}, 1_500);
      const terminals = reconnect.frames.filter((f) =>
        ["done", "cancelled", "error"].includes(f.event),
      );
      expect(terminals.length, "exactly one ending, never one per exit path").toBe(1);
      expect(
        terminals[0]!.event,
        "a run that ended in failure ends `error`, never `done` — the terminal frame alone must tell a failed run from a finished one",
      ).toBe("error");
      const terminalData = JSON.parse(terminals[0]!.data) as { code?: string; message?: string; eventId?: string };

      // THE ENDING CARRIES THE FAILING CALL'S OWN FACTS, derived from the
      // live-captured model error event — never restated as literals: the
      // ending is the same failure the call reported, whatever code the
      // stream's failure path minted. Cross-checked against the durable
      // record: the ending, the live event and the DB row all carry the
      // same failure's words.
      const liveFrames = await live;
      const modelError = liveFrames.frames
        .map((f) =>
          f.event === "model"
            ? (JSON.parse(f.data) as { type?: string; eventId?: string; error?: { code?: string; message?: string } })
            : null,
        )
        .find((d) => d?.type === "error");
      expect(modelError, "the failed call's error event must have been published").toBeDefined();
      const recordedId = (errorRows[0]!.metadata as { timelineEventId?: string } | null)?.timelineEventId;
      expect(typeof recordedId, "the persisted failure carries its canonical identity").toBe("string");
      expect(modelError!.eventId, "the model frame names the persisted incident").toBe(recordedId);
      expect(terminalData.eventId, "the terminal copy names the same incident").toBe(recordedId);
      expect(db.listTimelineRefs(chatId, ownerUserId).some((ref) => ref.event_id === recordedId), "the failure identity names a real timeline ref").toBe(true);
      expect(terminalData.code, "the ending's code is the failing call's own code").toBe(
        modelError!.error!.code,
      );
      expect(terminalData.message, "the ending's message is the failing call's own message").toBe(
        modelError!.error!.message,
      );
      expect(terminalData.code, "the ending carries a real code, never an empty one").toBeTruthy();
      expect(
        terminalData.message,
        "the ending's message is the failure's own record — the same words the error row holds",
      ).toBe(errorRows[0]!.content);
    },
    40_000,
  );

  test(
    "a run that CONTINUED past a failed call and finished ends `done` — the ending names the LAST call's fate",
    async () => {
      // THE OTHER HALF OF THE SEMANTICS, and the reason the frame recorded
      // at a failure is cleared at the top of every further turn: a steer
      // that arrived while the failed call streamed drives a drain turn,
      // that turn finishes, and the run genuinely finished — its own ending
      // is `done`. The earlier call's failure keeps its own records (the
      // error row, the ledger event); it must not overwrite the ending of
      // a run that went on. The failure-before-success shape without a
      // steer cannot exist: an error ends the call's stream, and with an
      // empty queue the loop breaks — the steer is the only continuation.
      const before = providerBranches.length;
      const { runId } = await startRun(`fail then take my steer ${FAIL_MARKER}`);
      // The instruction is queued while the failing call is provably in
      // flight (the branch is taken; the refusal lands 400 ms later), and
      // the live subscriber captures the drain's own `steered` frame —
      // the bounded buffer will have evicted it by the reconnect.
      const live = drain(`/api/run/${runId}/stream`, {}, 4_000);
      await waitUntil(
        () => providerBranches.slice(before).includes("fail"),
        "the failing call never reached the provider, so there was no in-flight call to steer",
      );
      const steered = await steerRun(runId, "answer plainly after the refusal");
      expect(steered.status, "a steer on a live mid-call run is accepted").toBe(200);
      expect(steered.queued, "the steer is queued for the drain turn").toBe(1);
      await runToCompletion(runId);
      const liveFrames = await live;

      // LIVENESS OF THE CONTINUATION: the drain turn really ran — a second
      // provider request answered by the plain branch — and the drain's
      // own frame was published.
      expect(
        providerBranches.slice(before).filter((b) => b === "fail").length,
        "the failing call must have happened exactly once",
      ).toBe(1);
      expect(
        providerBranches.slice(before).filter((b) => b === "fast").length,
        "the drain turn must have reached the provider and finished",
      ).toBe(1);
      expect(
        liveFrames.frames.some((f) => f.event === "steered"),
        "the drain's steered frame must have been published — the continuation is the scenario, not an assumption",
      ).toBe(true);

      // The failed call's own record still exists — the failure is never
      // lost by the run continuing past it.
      const errorRows = db
        .listMessages(chatId, ownerUserId)
        .filter((m) => m.run_id === runId && m.role === "error");
      expect(errorRows.length, "the failed call's error row survives the continuation").toBe(1);

      // THE VERDICT — the run's own ending is its LAST call's fate.
      const reconnect = await drain(`/api/run/${runId}/stream`, {}, 1_500);
      const terminals = reconnect.frames.filter((f) =>
        ["done", "cancelled", "error"].includes(f.event),
      );
      expect(terminals.length, "exactly one ending").toBe(1);
      expect(
        terminals[0]!.event,
        "a run that continued past a failure and finished ends `done` — the ending names the last call's fate, never an earlier call's",
      ).toBe("done");
    },
    40_000,
  );
});

test.each([false, true])("policy refusal stops queued continuation and permits a fresh unrelated conversation (native=%s)", async (native) => {
  chatId = db.createChat({ project_id: projectId, title: "policy scenario" }, ownerUserId).id;
  const ready = Promise.withResolvers<void>(); const released = Promise.withResolvers<void>();
  policyBarrier = { ready: ready.resolve, released: released.promise, native };
  writeFileSync(join(projectRoot, policyEditArgs.path), policyEditArgs.oldString);
  const before = providerBranches.length; const wireBefore = providerRequests.length; const toolsBefore = db.listToolCallsByChat(chatId, ownerUserId).length;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const { runId } = await startRun(POLICY_MARKER);
    const live = drain(`/api/run/${runId}/stream`, {}, 4_000);
    await Promise.race([ready.promise, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("policy request did not reach provider")), 5_000); })]);
    clearTimeout(watchdog);
    const steered = await steerRun(runId, "queued instruction must remain undispatched");
    expect(steered.status).toBe(200); expect(steered.queued).toBe(1);
    released.resolve(); await runToCompletion(runId);
    const frames = (await live).frames;
    expect(providerBranches.slice(before)).toEqual(["policy"]);
    const wire = providerRequests.slice(wireBefore); expect(wire).toHaveLength(1);
    expect(wire[0]!.url).toBe("/v1/responses"); expect(wire[0]!.body.stream).toBe(true);
    expect(JSON.stringify(wire[0]!.body.input)).toContain(POLICY_MARKER);
    expect(readFileSync(join(projectRoot, policyEditArgs.path), "utf8")).toBe(policyEditArgs.oldString);
    const toolRows = db.listToolCallsByChat(chatId, ownerUserId).slice(toolsBefore);
    expect(toolRows).toHaveLength(native ? 1 : 0);
    for (const row of toolRows) {
      expect(row.call_id).toBe("policy-forbidden-tool"); expect(row.status).toBe("error");
      expect(row.output).toBeNull(); expect(row.duration_ms).toBeNull();
    }
    expect(frames.some(frame => frame.event === "tool_result" || frame.event === "model" && JSON.parse(frame.data).type === "tool_call_done")).toBe(false);
    expect(frames.some(frame => frame.event === "steered" && JSON.parse(frame.data).delivery === "drain")).toBe(false);
    const ending = (await drain(`/api/run/${runId}/stream`, {}, 1_500)).frames.filter(frame => ["done", "cancelled", "error"].includes(frame.event));
    expect(ending).toHaveLength(1); expect(ending[0]!.event).toBe("error");
    expect(JSON.parse(ending[0]!.data).code).toBe("llm_misalignment_policy_violation");
    const refused = await startRun("operator review words do not resume this conversation");
    if (refused.runId) await runToCompletion(refused.runId);
    expect(refused.refusalCode).toBe("llm_misalignment_policy_violation"); expect(refused.runId).toBe("");
    expect(providerBranches.slice(before)).toEqual(["policy"]);
    chatId = db.createChat({ project_id: projectId, title: "fresh unrelated policy control" }, ownerUserId).id;
    policyEditArmed = native;
    const explicit = await startRun(native ? POLICY_EDIT_MARKER : "new explicit request after operator review"); await runToCompletion(explicit.runId);
    expect(providerBranches.slice(before)).toEqual(native ? ["policy", "policy-edit", "fast"] : ["policy", "fast"]);
    expect(readFileSync(join(projectRoot, policyEditArgs.path), "utf8")).toBe(native ? policyEditArgs.newString : policyEditArgs.oldString);
  } finally { clearTimeout(watchdog); released.resolve(); policyBarrier = undefined; chatId = db.createChat({ project_id: projectId, title: "unrelated after policy" }, ownerUserId).id; }
}, 40_000);

test.each([false, true])("observed policy closes steering before persistence and survives an explicit cancellation record (cancel=%s)", async (cancel) => {
  chatId = db.createChat({ project_id: projectId, title: "policy persistence scenario" }, ownerUserId).id;
  const reached = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  policyPersistence = { ready: reached.resolve, released: released.promise };
  policyBarrier = { ready() {}, released: Promise.resolve(), native: false };
  const before = providerBranches.length; let timer: ReturnType<typeof setTimeout> | undefined; let heldRunId: string | undefined;
  try {
    const { runId } = await startRun(POLICY_MARKER); heldRunId = runId;
    await Promise.race([reached.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("policy persistence not reached")), 5_000); })]);
    clearTimeout(timer);
    const steer = await steerRun(runId, "must refuse during policy persistence");
    expect(steer.status).toBe(200); expect(steer.queued).toBeNull(); expect(steer.refusalCode).toBe("llm_misalignment_policy_violation");
    if (cancel) expect(await cancelRun(runId)).toBe(200);
    released.resolve(); await runToCompletion(runId);
    expect(providerBranches.slice(before)).toEqual(["policy"]);
    const recorded = db.listMessages(chatId, ownerUserId).filter(row => row.run_id === runId && row.role === "error");
    expect(recorded).toHaveLength(1); expect((recorded[0]!.metadata as {errorCode?: string}).errorCode).toBe("llm_misalignment_policy_violation");
    const ending = (await drain(`/api/run/${runId}/stream`, {}, 1_500)).frames.filter(frame => ["done", "cancelled", "error"].includes(frame.event));
    expect(ending).toHaveLength(1); expect(ending[0]!.event).toBe(cancel ? "cancelled" : "error");
    if (!cancel) expect(JSON.parse(ending[0]!.data).code).toBe("llm_misalignment_policy_violation");
  } finally { clearTimeout(timer); released.resolve(); if (heldRunId) await runToCompletion(heldRunId); policyPersistence = undefined; policyBarrier = undefined; chatId = db.createChat({ project_id: projectId, title: "unrelated after policy persistence" }, ownerUserId).id; }
}, 40_000);

// ── 3. A refused start leaves nothing behind ──────────────────────────────

describe("a start refused at the door leaves no feed and no registry entry", () => {
  test(
    "five refused starts leak zero feeds and zero registry entries, and a subscriber to one is a 404",
    async () => {
      const { runFeedCount, runFeedState } = await import("../../server/run/run-feed.ts");
      const { activeRunCount, resolveRunOwner } = await import("../../server/run/run-registry.ts");

      const feedsBefore = runFeedCount();
      const runsBefore = activeRunCount();
      const refusedBefore = refusedRunIds.length;

      refuseClaims = true;
      const statuses: number[] = [];
      try {
        for (let i = 0; i < 5; i += 1) statuses.push((await startRun(`refused ${String(i)}`)).status);
      } finally {
        refuseClaims = false;
      }

      // LIVENESS OF THE PLANT FIRST. "Nothing leaked" is true and meaningless
      // if nothing was refused — the count of refusals is the precondition,
      // and it comes from the injection point itself rather than from the
      // status codes, which a route could produce for another reason.
      const refused = refusedRunIds.slice(refusedBefore);
      expect(refused.length, "the injected claim failure never fired").toBe(5);
      expect(statuses.every((s) => s >= 400)).toBe(true);

      // THE VERDICT — the process-global populations, stated as numbers.
      expect(
        runFeedCount() - feedsBefore,
        "a refused start used to strand a feed that nothing would ever end: five refusals, " +
          "five feeds, retained for the life of the process",
      ).toBe(0);
      expect(activeRunCount() - runsBefore).toBe(0);

      // …and per-run, so a coincidental balance elsewhere cannot supply the
      // answer.
      for (const runId of refused) {
        expect(runFeedState(runId)).toBeUndefined();
        expect(resolveRunOwner(runId)).toBeUndefined();
      }

      // A SUBSCRIBER TO THE CORPSE. This was accepted — 200, one `connected`
      // frame, and the socket held open forever on a run that would never
      // publish, consuming one of the eight per-user stream slots.
      const corpse = await drain(`/api/run/${refused[0]!}/stream`, {}, 1_000);
      expect(corpse.status).toBe(404);
      expect(corpse.frames.length).toBe(0);
    },
    40_000,
  );
});

// ── 3b. The window between admission and the first turn ────────────────────
//
// The executor's callback is not born inside its ending guarantee — it
// ENTERS it. The feed is opened before the callback begins, the
// launch-catch below the callback owns the never-began case, and the turn
// loop's own try owns the turns; the stretch of callback between the claim
// and the first turn (the setup window: tool settings, the safety gate,
// the safety runtime, prompt assembly) was the one region of the callback
// whose ending no arm in this file had ever driven — and an undriven
// guarantee reads as an absent one: a reader tracing the callback by eye
// can conclude the window sits outside every guard, and only a driven path
// can answer. The answer, pinned here: the window is INSIDE the try whose
// catch records the run's own terminal frame and whose finally publishes
// it, so a run that dies before its first turn ends exactly as a run that
// dies mid-call does — by its own honest ending, with the feed closed and
// the registry emptied, and the subscriber that stayed open is TOLD rather
// than left watching a dead pane.

describe("a run that dies in the executor's setup window ends by its own terminal frame", () => {
  test(
    "a throw at the window's first read ends the feed with the run's own `error` ending — the subscriber is told, never left hanging",
    async () => {
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const { getActiveRun, activeRunCount } = await import("../../server/run/run-registry.ts");

      const runsBefore = activeRunCount();
      const failedBefore = setupReadsFailed.length;
      failSetupRead = "toolSettings";
      try {
        const admitted = await startRun("die in setup at the window's first read");
        // The 201 is half the scenario: the claim was written, so this run
        // was ADMITTED, and the failure that follows is the executor's own.
        // A route-level refusal (section 3's face) answers before the
        // callback begins and certifies nothing about the window.
        expect(admitted.status).toBe(201);
        // A subscriber attaches and STAYS OPEN — the round's own liveness
        // contract: whatever ends this run must reach the reader that is
        // watching, not strand it on a pane that never settles.
        const live = drain(`/api/run/${admitted.runId}/stream`, {}, 4_000);
        await runToCompletion(admitted.runId);
        const liveFrames = await live;

        // LIVENESS OF THE PLANT, from the injection point itself: the
        // window's first read really threw, or every assertion below
        // measures a run that never died.
        expect(
          setupReadsFailed.slice(failedBefore),
          "the injected setup failure never fired",
        ).toEqual(["injected: the tool settings read could not happen"]);

        // THE FEED ENDED, AND SAID SO. `runToCompletion` above is the hang
        // witness: a run whose ending is skipped stays open forever, and
        // its poll is the assertion that would time out on that face.
        const state = runFeedState(admitted.runId)!;
        expect(state.ended, "the feed must end on a setup failure").toBe(true);
        expect(state.terminalPublished, "the ending must be published, not just the socket closed").toBe(true);

        // THE REGISTRY IS EMPTIED — the same settle a mid-call failure
        // leaves: no window in which the run is visible-live yet
        // unanswerable, and no entry stranded for a run that will never
        // publish again.
        expect(getActiveRun(admitted.runId)).toBeUndefined();
        expect(activeRunCount() - runsBefore).toBe(0);

        // THE LIVE SUBSCRIBER WAS TOLD. Whether the terminal arrived as a
        // live publish or as the immediate replay an open stream serves,
        // the reader that stayed open received the run's own ending and
        // the stream closed on it.
        const liveTerminals = liveFrames.frames.filter((f) =>
          ["done", "cancelled", "error"].includes(f.event),
        );
        expect(
          liveTerminals.length,
          "a subscriber that stayed open through a setup failure must receive the run's ending",
        ).toBe(1);
        expect(liveTerminals[0]!.event).toBe("error");

        // THE VERDICT — the ending a reconnect is handed within the
        // retention window.
        const reconnect = await drain(`/api/run/${admitted.runId}/stream`, {}, 1_500);
        const terminals = reconnect.frames.filter((f) =>
          ["done", "cancelled", "error"].includes(f.event),
        );
        expect(terminals.length, "exactly one ending, never one per exit path").toBe(1);
        expect(
          terminals[0]!.event,
          "a run that died in setup ends `error`, never `done` — the ending alone must tell a failed run from a finished one",
        ).toBe("error");
        const terminalData = JSON.parse(terminals[0]!.data) as {
          runId?: string;
          code?: string;
          message?: string;
        };
        expect(terminalData.runId).toBe(admitted.runId);
        expect(
          terminalData.code,
          "an untyped throw carries no code, so the honest code is the catch's own `run_failed`",
        ).toBe("run_failed");
        expect(
          terminalData.message,
          "the ending carries the thrower's own words — the same failure the setup read reported",
        ).toBe("injected: the tool settings read could not happen");

        // NO FABRICATED SAFETY VERDICT. The throw predates the window's
        // safety-runtime creation, so the finally has no runtime to dispose
        // and no verdict to publish — an absent verdict is the honest answer
        // for a run that never had one, the same honesty the disarmed
        // families report.
        expect(
          reconnect.frames.some((f) => f.event === "safety_findings"),
          "a run that died before its safety runtime existed must not be handed a fabricated safety verdict",
        ).toBe(false);

        // THE RECORD KEEPS THE RUN'S OWN FACTS. The admitted run's prompt
        // row exists — the run genuinely began — and its ending is
        // feed-side only: no model call ever happened, so no error row is
        // fabricated for one, the same feed-only ending shape a cancelled
        // run's record keeps.
        const userRows = db
          .listMessages(chatId, ownerUserId)
          .filter((m) => m.run_id === admitted.runId && m.role === "user");
        expect(userRows.length, "the admitted run's own prompt row must exist").toBe(1);
        const errorRows = db
          .listMessages(chatId, ownerUserId)
          .filter((m) => m.run_id === admitted.runId && m.role === "error");
        expect(errorRows.length).toBe(0);
      } finally {
        failSetupRead = null;
      }
    },
    40_000,
  );

  test(
    "a throw at the window's mid read ends the same way, with the finally's own bookkeeping published before the ending",
    async () => {
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const { getActiveRun } = await import("../../server/run/run-registry.ts");

      const failedBefore = setupReadsFailed.length;
      failSetupRead = "promptPrefs";
      try {
        const admitted = await startRun("die in setup at the window's mid read");
        expect(admitted.status).toBe(201);
        await runToCompletion(admitted.runId);
        expect(
          setupReadsFailed.slice(failedBefore),
          "the injected setup failure never fired",
        ).toEqual(["injected: the prompt prefs read could not happen"]);

        // This throw lands MID-window: the safety runtime already exists,
        // so the finally must dispose it and publish its verdict — and the
        // verdict must PRECEDE the ending, because nothing follows the
        // ending. Both halves of that ordering are asserted: the verdict
        // exists, and the terminal is the run's last word.
        const reconnect = await drain(`/api/run/${admitted.runId}/stream`, {}, 1_500);
        const safetyIdx = reconnect.frames.findIndex((f) => f.event === "safety_findings");
        const terminalIdx = reconnect.frames.findIndex((f) =>
          ["done", "cancelled", "error"].includes(f.event),
        );
        expect(
          safetyIdx,
          "a run whose safety runtime existed must have its verdict published by the exit every path crosses",
        ).toBeGreaterThanOrEqual(0);
        expect(
          safetyIdx < terminalIdx,
          "the finally's own bookkeeping must precede the ending — the ending is the run's last word",
        ).toBe(true);
        expect(terminalIdx, "exactly one ending, and nothing follows it").toBe(
          reconnect.frames.length - 1,
        );

        const terminals = reconnect.frames.filter((f) =>
          ["done", "cancelled", "error"].includes(f.event),
        );
        expect(terminals.length).toBe(1);
        expect(terminals[0]!.event).toBe("error");
        const terminalData = JSON.parse(terminals[0]!.data) as {
          runId?: string;
          code?: string;
          message?: string;
        };
        expect(terminalData.code).toBe("run_failed");
        expect(terminalData.message).toBe("injected: the prompt prefs read could not happen");

        expect(runFeedState(admitted.runId)!.ended).toBe(true);
        expect(runFeedState(admitted.runId)!.terminalPublished).toBe(true);
        expect(getActiveRun(admitted.runId)).toBeUndefined();
      } finally {
        failSetupRead = null;
      }
    },
    40_000,
  );
});

// ── 4. The replay reports every disagreement, in both directions ──────────

describe("a replay that cannot be continuous says so", () => {
  test(
    "resuming from below the bounded buffer reports the gap it actually has",
    async () => {
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const { serverConfig } = await import("../../server/kernel/config.ts");
      // The fixture is derived from the bound rather than guessed at.
      expect(serverConfig.runFeedMaxFrames).toBe(RUN_FEED_MAX_FRAMES);

      const { runId } = await startRun("drop my early frames");
      await runToCompletion(runId);

      const state = runFeedState(runId)!;
      // LIVENESS: frames were genuinely evicted, so there is a gap to report.
      expect(
        state.droppedBefore,
        "the buffer never overflowed, so this test is asserting about a gap that does not exist",
      ).toBeGreaterThan(0);
      expect(state.frames).toBeLessThanOrEqual(serverConfig.runFeedMaxFrames);
      // The buffer's arithmetic, at the bound.
      expect(state.nextSequence).toBe(state.frames + state.droppedBefore + 1);

      const resumed = await drain(`/api/run/${runId}/stream`, { "Last-Event-ID": "1" }, 1_200);
      const gap = resumed.frames.find((f) => f.event === "replay_gap");
      expect(gap, "a subscriber resuming below the buffer must be TOLD, not silently skipped").toBeDefined();
      const payload = JSON.parse(gap!.data) as {
        droppedThroughSequence: number;
        resumedFrom: number;
        reason: string;
      };
      // Judged against the feed's own number, not a literal: a guard that
      // hardcodes the boundary stops testing the boundary the moment the
      // bound moves.
      expect(payload.droppedThroughSequence).toBe(state.droppedBefore);
      expect(payload.resumedFrom).toBe(1);
      expect(payload.reason).toBe("frames_dropped");
    },
    40_000,
  );

  test(
    "resuming from AHEAD of everything the run published is refused as a fabricated position",
    async () => {
      const { runFeedState } = await import("../../server/run/run-feed.ts");
      const { runId } = await startRun("nothing is past my end");
      await runToCompletion(runId);
      const state = runFeedState(runId)!;

      const ahead = String(state.nextSequence + 1_000);
      const res = await drain(`/api/run/${runId}/stream`, { "Last-Event-ID": ahead }, 1_200);
      expect(res.status).toBe(200);
      const gap = res.frames.find((f) => f.event === "replay_gap");
      expect(
        gap,
        "a resume point past the run's own position returned 200, zero frames and NO report — " +
          "which reads as 'you are up to date' and hides every frame in between",
      ).toBeDefined();
      const payload = JSON.parse(gap!.data) as { reason: string; highestSequence: number };
      expect(payload.reason).toBe("resume_point_ahead_of_run");
      expect(payload.highestSequence).toBe(state.nextSequence - 1);

      // THE CONTROL: resuming from the run's LAST sequence is a legitimate
      // "nothing new" and must NOT be reported as a disagreement.
      const atEnd = await drain(
        `/api/run/${runId}/stream`,
        { "Last-Event-ID": String(state.nextSequence - 1) },
        1_200,
      );
      expect(atEnd.frames.some((f) => f.event === "replay_gap")).toBe(false);
    },
    40_000,
  );
});

// ── 5. A resume point this server could not have minted is refused ────────

describe("Last-Event-ID is read by the grammar this server writes", () => {
  test(
    "values `Number()` accepts but this server never emits are refused, not guessed at",
    async () => {
      const { runId } = await startRun("resume point grammar");
      await runToCompletion(runId);

      // `1e3` and a 17-digit integer were the live defect: both parsed to a
      // number, both resolved to a resume point past the feed, and both
      // produced a SILENT empty replay. `0x10`, `3.7`, a signed value, a
      // leading zero and a thousands separator are the same class.
      for (const bad of ["1e3", "9007199254740993", "0x10", "3.7", "-5", "0", "007", "1,2", "abc", "+4", " 4 2"]) {
        const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, {
          headers: { ...authHeaders, "Last-Event-ID": bad },
        });
        const body = (await res.json()) as { error?: string };
        expect(res.status, `Last-Event-ID: ${bad} was accepted`).toBe(400);
        expect(body.error).toBe("invalid_resume_point");
      }
    },
    40_000,
  );

  test("an absent or empty header is not a refusal — it is the ordinary first connection", async () => {
    const { parseResumePoint } = await import("../../server/router/sse.ts");
    expect(parseResumePoint(undefined)).toBe(0);
    expect(parseResumePoint("")).toBe(0);
    expect(parseResumePoint("   ")).toBe(0);
    // …and every id this server can actually write round-trips.
    expect(parseResumePoint("1")).toBe(1);
    expect(parseResumePoint("415")).toBe(415);
    expect(parseResumePoint(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    // The accepted set is the emitted set: whatever `send` would write for a
    // sequence is accepted back, derived rather than listed.
    for (const seq of [1, 2, 9, 10, 4_000, 123_456]) {
      expect(parseResumePoint(String(Math.floor(seq)))).toBe(seq);
    }
  });
});

// ── 6. The feed's own door, driven ────────────────────────────────────────

describe("the feed's subscribe/end/owner surface", () => {
  test("subscribeToRunFeed replays, unsubscribes exactly, and never reaches the run", async () => {
    const {
      openRunFeed,
      publishRunFrame,
      subscribeToRunFeed,
      endRunFeed,
      runFeedOwner,
      runFeedState,
      releaseRunFeed,
    } = await import("../../server/run/run-feed.ts");
    const { SSE_EVENT_TYPES } = await import("../../shared/constants.ts");

    const runId = `run-feed-door-${String(Date.now())}`;
    openRunFeed(runId, { userId: ownerUserId, chatId });
    expect(publishRunFrame(runId, SSE_EVENT_TYPES.model, { type: "start" })).toBe(1);
    expect(publishRunFrame(runId, SSE_EVENT_TYPES.model, { type: "text_delta", delta: "a" })).toBe(2);

    // The owner survives independently of the registry — this is what lets a
    // reconnect answer 403 rather than 404 after a run has finished.
    expect(runFeedOwner(runId)).toEqual({ userId: ownerUserId, chatId });

    const received: number[] = [];
    let ended = 0;
    const sub = subscribeToRunFeed(runId, 1, (f) => received.push(f.sequence), () => { ended += 1; });
    expect(sub, "a feed that exists must accept a subscriber").toBeDefined();
    // Replay is the exact suffix past the requested sequence.
    expect(sub!.replay.frames.map((f) => f.sequence)).toEqual([2]);
    expect(sub!.replay.droppedBefore).toBe(0);
    expect(sub!.replay.resumeAhead).toBe(false);
    expect(sub!.replay.highestSequence).toBe(2);
    expect(sub!.replay.ended).toBe(false);
    expect(runFeedState(runId)!.subscribers).toBe(1);

    publishRunFrame(runId, SSE_EVENT_TYPES.model, { type: "text_delta", delta: "b" });
    expect(received).toEqual([3]);

    // LEAVING IS ONLY LEAVING: the run is not told, and the feed keeps going.
    sub!.unsubscribe();
    expect(runFeedState(runId)!.subscribers).toBe(0);
    publishRunFrame(runId, SSE_EVENT_TYPES.model, { type: "text_delta", delta: "c" });
    expect(received, "an unsubscribed reader must receive nothing further").toEqual([3]);
    expect(runFeedState(runId)!.frames).toBe(4);

    // A second subscriber, so the end notification has somewhere to land.
    const watcher = subscribeToRunFeed(runId, 4, () => undefined, () => { ended += 1; });
    expect(watcher).toBeDefined();
    endRunFeed(runId, { event: SSE_EVENT_TYPES.done, data: { runId } });
    expect(ended, "ending a feed tells its live subscribers exactly once").toBe(1);

    const after = runFeedState(runId)!;
    expect(after.ended).toBe(true);
    expect(after.terminalPublished).toBe(true);
    // The terminal frame is IN the record, so a reconnect is replayed it.
    expect(after.frames).toBe(5);

    // Idempotent: ending twice does not publish a second ending.
    endRunFeed(runId, { event: SSE_EVENT_TYPES.done, data: { runId } });
    expect(runFeedState(runId)!.frames).toBe(5);

    releaseRunFeed(runId);
    expect(runFeedState(runId)).toBeUndefined();
    expect(runFeedOwner(runId)).toBeUndefined();
  });

  test("endRunFeed publishes the ending only when the run has not already given one", async () => {
    const { openRunFeed, publishRunFrame, endRunFeed, runFeedState, releaseRunFeed } = await import(
      "../../server/run/run-feed.ts"
    );
    const { SSE_EVENT_TYPES } = await import("../../shared/constants.ts");

    // A run that said `done` itself keeps its own ending.
    const said = `run-said-done-${String(Date.now())}`;
    openRunFeed(said, { userId: ownerUserId, chatId });
    publishRunFrame(said, SSE_EVENT_TYPES.done, { runId: said });
    endRunFeed(said, { event: SSE_EVENT_TYPES.cancelled, data: { runId: said } });
    expect(runFeedState(said)!.frames).toBe(1);

    // A run that said NOTHING gets the ending its caller supplied — which is
    // the cancel path, and the whole defect.
    const silent = `run-said-nothing-${String(Date.now())}`;
    openRunFeed(silent, { userId: ownerUserId, chatId });
    publishRunFrame(silent, SSE_EVENT_TYPES.model, { type: "start" });
    expect(runFeedState(silent)!.terminalPublished).toBe(false);
    endRunFeed(silent, { event: SSE_EVENT_TYPES.cancelled, data: { runId: silent } });
    const state = runFeedState(silent)!;
    expect(state.terminalPublished).toBe(true);
    expect(state.frames).toBe(2);

    releaseRunFeed(said);
    releaseRunFeed(silent);
  });

  test("resolveRunOwner answers from the registry AND from the feed that outlives it", async () => {
    const { openRunFeed, releaseRunFeed } = await import("../../server/run/run-feed.ts");
    const { resolveRunOwner, setActiveRun, deleteActiveRun } = await import(
      "../../server/run/run-registry.ts"
    );

    const runId = `run-owner-${String(Date.now())}`;
    expect(resolveRunOwner(runId), "an unknown run is the only honest 404").toBeUndefined();

    openRunFeed(runId, { userId: ownerUserId, chatId });
    // The feed alone answers — this is the lookup that stops a FINISHED run
    // from silently converting every foreign 403 into a 404.
    expect(resolveRunOwner(runId)).toBe(ownerUserId);

    setActiveRun(runId, { userId: "someone-else", chatId } as never);
    // The registry wins while the run is live.
    expect(resolveRunOwner(runId)).toBe("someone-else");
    deleteActiveRun(runId);
    expect(resolveRunOwner(runId)).toBe(ownerUserId);

    releaseRunFeed(runId);
    expect(resolveRunOwner(runId)).toBeUndefined();
  });
});

// ── 7. The window that makes a reconnect possible cannot be configured away ─

describe("the retention window has a floor tied to what it must outlast", () => {
  test("a retention of 0 — the previously declared minimum — is raised, not honoured", async () => {
    const { resolveServerConfig } = await import("../../server/kernel/config.ts");

    // The declared minimum used to be 0, and 0 released the feed the instant
    // the run ended: the reconnect met a 404 and a foreign user's 403 became
    // a 404 with it. One environment variable, set to a value the config
    // itself advertised as legal, re-opened the defect the window exists to
    // close.
    const zero = resolveServerConfig({
      HARNESS_WEB_RUN_FEED_RETENTION_MS: "0",
    } as unknown as NodeJS.ProcessEnv);
    expect(zero.runFeedRetentionMs).toBeGreaterThan(0);
    // The floor is DERIVED from the cadence the server itself writes, so it
    // is judged against that rather than against a literal copied here.
    expect(zero.runFeedRetentionMs).toBeGreaterThanOrEqual(zero.runStreamRetryMs * 2);

    // The floor MOVES with the cadence — which is the property a bare literal
    // could not have, and the reason this is not just a bigger number.
    const slowReconnect = resolveServerConfig({
      HARNESS_WEB_RUN_FEED_RETENTION_MS: "0",
      HARNESS_WEB_RUN_STREAM_RETRY_MS: "9000",
    } as unknown as NodeJS.ProcessEnv);
    expect(slowReconnect.runStreamRetryMs).toBe(9_000);
    expect(slowReconnect.runFeedRetentionMs).toBeGreaterThanOrEqual(18_000);
    expect(slowReconnect.runFeedRetentionMs).toBeGreaterThan(zero.runFeedRetentionMs);

    // A value ABOVE the floor is still the operator's to choose — a floor
    // that ignored the setting would be a different defect.
    const chosen = resolveServerConfig({
      HARNESS_WEB_RUN_FEED_RETENTION_MS: "300000",
    } as unknown as NodeJS.ProcessEnv);
    expect(chosen.runFeedRetentionMs).toBe(300_000);
  });

  test("the run stream writes the reconnect cadence it is floored against", async () => {
    // A floor derived from a cadence nobody states is a threshold resting on
    // whatever the browser happens to default to. The server writes it.
    const { runId } = await startRun("state your cadence");
    await runToCompletion(runId);
    const res = await fetch(`${baseUrl}/api/run/${runId}/stream`, { headers: authHeaders });
    const text = await res.text();
    const { serverConfig } = await import("../../server/kernel/config.ts");
    expect(text).toContain(`retry: ${String(serverConfig.runStreamRetryMs)}`);
  }, 40_000);
});

// ── 8. The provider was really driven ─────────────────────────────────────

describe("the instrument itself", () => {
  test("every scenario above reached the real provider", () => {
    // The last line of defence against a file of assertions about runs that
    // never happened. Stated as a number so a change is visible.
    expect(providerHits).toBeGreaterThan(0);
    expect(providerBranches.length).toBeGreaterThan(0);
    expect(providerBranches).toContain("slow");
    expect(providerBranches).toContain("fast");
    expect(providerBranches).toContain("fail");
  });
});

test("canonical policy stop survives projection failure, rewind, trash, copied history and a fresh native route process", async () => {
  chatId = db.createChat({ project_id: projectId, title: "durable policy" }, ownerUserId).id;
  const affectedChat = chatId, before = providerBranches.length;
  policyBarrier = { ready() {}, released: Promise.resolve(), native: false }; failPolicyProjection = true;
  try {
    const { runId } = await startRun(POLICY_MARKER); await runToCompletion(runId); failPolicyProjection = false;
    expect(providerBranches.slice(before)).toEqual(["policy"]);
    expect(db.listMessages(chatId, ownerUserId).filter(row => row.role === "error")).toHaveLength(0);
    const { getTimelineStore, getTimelineLedgerId } = await import("../../server/observability/timeline-bridge.ts");
    expect(getTimelineStore().querySummaries({ runIds: db.runIdsForChat(chatId, ownerUserId), errorCode: "llm_misalignment_policy_violation", limit: 1 })).toHaveLength(1);
    const assertStopped = async () => { const value = await startRun("try again"); expect(value.runId).toBe(""); expect(value.refusalCode).toBe("llm_misalignment_policy_violation"); expect(providerBranches.slice(before)).toEqual(["policy"]); };
    await assertStopped();
    const { recordRewind, planRewind, discardedMessageIdsForChat } = await import("../../server/run/rewind.ts");
    const messages = db.listMessages(chatId, ownerUserId), plan = planRewind(messages, messages[0]!.id, "at")!;
    recordRewind({ chatId, userId: ownerUserId, mode: "at", ...plan });
    expect(discardedMessageIdsForChat(chatId, ownerUserId).size).toBeGreaterThan(0); await assertStopped();
    expect(db.deleteChat(chatId, ownerUserId)).toBe(true); expect(db.restoreChat(chatId, ownerUserId)?.id).toBe(chatId); await assertStopped();
    const copied = db.duplicateChat(chatId, ownerUserId)!; chatId = copied.id; await assertStopped();
    const { DbClient } = await import("../../server/db/client.ts");
    const reopened = new DbClient({ path: join(tmpRoot, "web.db") });
    const { createTimelineStore } = await import("../../engine/src/timeline/timeline-store.ts");
    const { serverConfig } = await import("../../server/kernel/config.ts");
    const ledger = createTimelineStore({ path: serverConfig.timelineDbPath, ledgerId: getTimelineLedgerId() });
    try { expect(ledger.querySummaries({ runIds: reopened.runIdsForChat(affectedChat, ownerUserId), errorCode: "llm_misalignment_policy_violation", limit: 1 })).toHaveLength(1); }
    finally { ledger.close(); reopened.close(); }
    const restart = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {createServer} from 'node:http';
      const root = process.env.RESTART_ROOT, fixture = JSON.parse(process.env.RESTART_FIXTURE);
      const {DbClient} = await import(root+'server/db/client.ts'); const {AsyncDbClient} = await import(root+'server/db/async-client.ts');
      const {createRouter} = await import(root+'server/router/router.ts');
      const {registerRunRoutes} = await import(root+'server/routes/run.ts'); const {getTimelineStore} = await import(root+'server/observability/timeline-bridge.ts');
      const db = new DbClient({path:fixture.db}), adb = AsyncDbClient.inline(db), router = createRouter({db:adb,isPublicPath:()=>false}); registerRunRoutes(router,adb);
      const app = createServer((req,res)=>router.dispatch(req,res)); await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
      // The outbound door owns node:http (not fetch): every request it starts is published on this
      // channel, and this child's only node:http client requests would be provider dispatches.
      const {subscribe} = await import('node:diagnostics_channel');
      let unexpectedDispatches = 0; const url = 'http://127.0.0.1:'+app.address().port;
      subscribe('http.client.request.start', ({request}) => { unexpectedDispatches++; request.destroy(new Error('unexpected provider dispatch')); });
      try { const response = await fetch(url+'/api/run/start',{method:'POST',headers:fixture.headers,body:JSON.stringify({projectId:fixture.projectId,chatId:fixture.chatId,prompt:'restart is not review authority'})});
        console.log(JSON.stringify({status:response.status,body:await response.json(),unexpectedDispatches}));
      } finally { app.closeAllConnections(); await new Promise(resolve=>app.close(resolve)); getTimelineStore().close(); db.close(); }
    `], { env: { ...process.env, HARNESS_WEB_TIMELINE_DB_PATH: serverConfig.timelineDbPath, RESTART_ROOT: pathToFileURL(process.cwd()+"/").href,
      RESTART_FIXTURE: JSON.stringify({ db: join(tmpRoot, "web.db"), headers: authHeaders, projectId, chatId: affectedChat }) }, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
    expect(restart.error, restart.stdout + restart.stderr).toBeUndefined(); expect(restart.status, restart.stderr).toBe(0);
    const restarted = JSON.parse(restart.stdout.trim().split("\n").at(-1)!);
    expect(restarted.body.refusal?.code).toBe("llm_misalignment_policy_violation"); expect(restarted.body.runId).toBeUndefined(); expect(restarted.unexpectedDispatches).toBe(0);
    chatId = db.createChat({ project_id: projectId, title: "unrelated forged projection" }, ownerUserId).id;
    db.createMessage({ chat_id: chatId, role: "error", content: "not policy authority", metadata: { errorCode: "llm_misalignment_policy_violation", runId } }, ownerUserId);
    const independent = await startRun("unrelated ordinary context"); expect(independent.runId).not.toBe(""); await runToCompletion(independent.runId);
    expect(providerBranches.slice(before)).toEqual(["policy", "fast"]);
  } finally { failPolicyProjection = false; policyBarrier = undefined; chatId = db.createChat({ project_id: projectId, title: "after durable policy" }, ownerUserId).id; }
}, 40_000);

test("reserved policy admission sees a stop appended while its run mapping was awaited", async () => {
  chatId = db.createChat({ project_id: projectId, title: "policy reservation race" }, ownerUserId).id;
  const target = chatId, runId = "policy-race-seed", before = providerBranches.length;
  db.createMessage({ chat_id: chatId, role: "user", content: "seed", run_id: runId }, ownerUserId);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let calls = 0;
  mappingObserver = async id => { if (id === target && ++calls === 2) { ready.resolve(); await release.promise; } };
  let pending: ReturnType<typeof startRun> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pending = startRun("race admission");
    await Promise.race([ready.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reserved mapping not reached")), 5_000); })]); clearTimeout(timer);
    const { activeRunForChat } = await import("../../server/run/run-registry.ts");
    expect(activeRunForChat(chatId, ownerUserId)).toBeDefined();
    const { getTimelineRecorder } = await import("../../server/observability/timeline-bridge.ts");
    getTimelineRecorder().recordEvent({ eventType: "provider", description: "recorded policy", correlation: { runId }, error: { category: "provider", code: "llm_misalignment_policy_violation", message: "review", retryable: false } });
    release.resolve(); const result = await pending;
    expect(result.runId).toBe(""); expect(result.refusalCode).toBe("llm_misalignment_policy_violation");
    expect(activeRunForChat(chatId, ownerUserId)).toBeUndefined(); expect(providerBranches.slice(before)).toEqual([]);
  } finally { clearTimeout(timer); release.resolve(); await pending; mappingObserver = undefined; chatId = db.createChat({ project_id: projectId, title: "after policy race" }, ownerUserId).id; }
}, 40_000);

test("a steer admitted before policy cannot queue after its message persistence completes", async () => {
  chatId = db.createChat({ project_id: projectId, title: "policy steer race" }, ownerUserId).id;
  const providerReady = Promise.withResolvers<void>(), providerRelease = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  policyBarrier = { ready: providerReady.resolve, released: providerRelease.promise, native: false }; steerPersistence = { ready: ready.resolve, released: release.promise };
  const before = providerBranches.length; let pending: ReturnType<typeof steerRun> | undefined, heldRunId: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await startRun(POLICY_MARKER); heldRunId = started.runId;
    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("steer race barrier not reached")), 5_000); });
    await Promise.race([providerReady.promise, watchdog]); pending = steerRun(started.runId, "held steer persistence"); await Promise.race([ready.promise, watchdog]); clearTimeout(timer);
    providerRelease.resolve(); await runToCompletion(started.runId); release.resolve();
    const steered = await pending; expect(steered.queued).toBeNull(); expect(steered.refusalCode).toBe("llm_misalignment_policy_violation");
    expect(providerBranches.slice(before)).toEqual(["policy"]);
  } finally { clearTimeout(timer); providerRelease.resolve(); release.resolve(); await pending; if (heldRunId) await runToCompletion(heldRunId); policyBarrier = undefined; steerPersistence = undefined; chatId = db.createChat({ project_id: projectId, title: "after steer race" }, ownerUserId).id; }
}, 40_000);

test("a cancellation before forwarding an actual native policy error retains the durable stop", async () => {
  const { SharedLLMClient } = await import("../../engine/src/shared/llm/client.ts");
  const { getActiveRun } = await import("../../server/run/run-registry.ts");
  const { getTimelineStore } = await import("../../server/observability/timeline-bridge.ts");
  const original = SharedLLMClient.prototype.stream;
  let runId = "", cancelled = 0;
  const spy = vi.spyOn(SharedLLMClient.prototype, "stream").mockImplementation(async function* (this: InstanceType<typeof SharedLLMClient>, ...args: Parameters<typeof original>) {
    for await (const chunk of original.apply(this, args)) {
      if (chunk.type === "error" && chunk.error.code === "llm_misalignment_policy_violation") {
        expect(chunk.error.status).toBeUndefined(); cancelled++; const active = getActiveRun(runId)!; active.abortController.abort(); expect(active.abortController.signal.aborted).toBe(true);
      }
      yield chunk;
    }
  });
  chatId = db.createChat({ project_id: projectId, title: "policy delivery cancel" }, ownerUserId).id;
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  policyBarrier = { ready: ready.resolve, released: release.promise, native: true, empty: true };
  const before = providerBranches.length; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    runId = (await startRun(POLICY_MARKER)).runId;
    await Promise.race([ready.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("policy delivery barrier not reached")), 5_000); })]); clearTimeout(timer);
    release.resolve(); await runToCompletion(runId); expect(cancelled).toBe(1);
    expect(getTimelineStore().querySummaries({ runIds: [runId], errorCode: "llm_misalignment_policy_violation", limit: 1 })).toHaveLength(1);
    const refused = await startRun("operator review is not authority"); expect(refused.refusalCode).toBe("llm_misalignment_policy_violation"); expect(refused.runId).toBe("");
    expect(providerBranches.slice(before)).toEqual(["policy"]); expect(db.listToolCallsByChat(chatId, ownerUserId)).toHaveLength(0);
  } finally { clearTimeout(timer); release.resolve(); if (runId) await runToCompletion(runId); spy.mockRestore(); policyBarrier = undefined; chatId = db.createChat({ project_id: projectId, title: "after delivery cancel" }, ownerUserId).id; }
}, 30_000);
