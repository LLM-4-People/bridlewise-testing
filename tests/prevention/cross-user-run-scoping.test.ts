// @vitest-environment node
/**
 * Mechanical enforcement: cross-user run-scoping (Part C).
 *
 * The agent-state store + the timeline ledger are GLOBAL (keyed by runId,
 * no user_id column). Without a run→user gate, User B could see User A's
 * running agents (`/api/agents`) and fetch A's timeline event detail
 * (`/api/timeline/events/:eventId`) by guessing/leaking the id — a
 * cross-user leak. closes it deny-by-default:
 * - `DbClient.allRunIdsForUser(userId)` / `runBelongsToUser(runId, userId)`
 * are the authoritative run→user mapping (messages.run_id → chat →
 * project → user_id) — the single DB-layer gate.
 * - `agents-bridge.getAgentStatesForUser(runIdSet)` filters the global
 * agent-state list to the caller's owned runs.
 * - the agents route + the timeline event-detail route call these gates.
 *
 * This test pins (a) the DB gate behavior (B does not own A's run), (b) the
 * route + bridge wiring (source-grep), and (c) the bridge filter logic.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

import { DatabaseSync } from "node:sqlite";

import { CHAT_RUN_IDS_SQL, DbClient } from "../../server/db/client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { modulePath } from "../helpers/module-resolver.ts";
import { valueReferencesModule } from "../helpers/source-scan.ts";

const AGENTS_ROUTE_PATH = join(process.cwd(), "server", "routes", "agents.ts");
const AGENTS_BRIDGE_PATH = join(process.cwd(), "server", "agent", "agents-bridge.ts");
const TIMELINE_ROUTE_PATH = join(process.cwd(), "server", "routes", "timeline.ts");
const DB_CLIENT_PATH = join(process.cwd(), "server", "db", "client.ts");

describe("Cross-user run scoping — the DB-layer run→user gate (allRunIdsForUser / runBelongsToUser)", () => {
  let tmpRoot: string;
  let db: DbClient;
  let userA: { userId: string };
  let userB: { userId: string };
  const runA = "run-owner-A-1234";
  const runB = "run-owner-B-5678";

  beforeAll(() => {
    tmpRoot = createTempDir("ch-run-scope-");
    db = new DbClient({ path: join(tmpRoot, "web.db") });
    userA = createTestUser(db, "run-owner-A");
    userB = createTestUser(db, "run-owner-B");
    // Seed A's run: A's project → A's chat → a message carrying run_id=runA.
    const projA = db.createProject({ name: "A-proj", path: join(tmpRoot, "A") }, userA.userId);
    const chatA = db.createChat({ project_id: projA.id, title: "A-chat" }, userA.userId);
    db.createMessage(
      { chat_id: chatA.id, role: "user", content: "seed", run_id: runA },
      userA.userId,
    );
    // Seed B's run similarly.
    const projB = db.createProject({ name: "B-proj", path: join(tmpRoot, "B") }, userB.userId);
    const chatB = db.createChat({ project_id: projB.id, title: "B-chat" }, userB.userId);
    db.createMessage(
      { chat_id: chatB.id, role: "user", content: "seed", run_id: runB },
      userB.userId,
    );
  });

  afterAll(() => {
    if (db) db.close();
  });

  test("allRunIdsForUser(A) includes A's run and NOT B's run (and vice versa)", () => {
    const aRuns = new Set(db.allRunIdsForUser(userA.userId));
    expect(aRuns.has(runA)).toBe(true);
    expect(aRuns.has(runB)).toBe(false);
    const bRuns = new Set(db.allRunIdsForUser(userB.userId));
    expect(bRuns.has(runB)).toBe(true);
    expect(bRuns.has(runA)).toBe(false);
  });

  test("runBelongsToUser(A's run, A) is true; runBelongsToUser(A's run, B) is false (deny-by-default)", () => {
    expect(db.runBelongsToUser(runA, userA.userId)).toBe(true);
    expect(db.runBelongsToUser(runA, userB.userId)).toBe(false);
    expect(db.runBelongsToUser(runB, userB.userId)).toBe(true);
    expect(db.runBelongsToUser(runB, userA.userId)).toBe(false);
  });

  test("runBelongsToUser rejects empty/missing run ids (no accidental match)", () => {
    expect(db.runBelongsToUser("", userA.userId)).toBe(false);
    expect(db.runBelongsToUser("run-does-not-exist", userA.userId)).toBe(false);
  });
  test("runIdsForChat(A's chat, B) resolves to [] — the user gate is behavioral, not just composed (deny-by-default)", () => {
    // The gate must hold at BEHAVIOR, not only at source shape: B asking
    // for A's chat resolves to the honest empty list, never A's runs. An
    // ungated prepare of the owned statement (the exact shape the
    // method-body arm forbids) answers A's runs to B here.
    const projA = db.listProjects(userA.userId)[0]!;
    const chatA = db.listChats(projA.id, userA.userId)[0]!;
    const projB = db.listProjects(userB.userId)[0]!;
    const chatB = db.listChats(projB.id, userB.userId)[0]!;
    expect(db.runIdsForChat(chatA.id, userB.userId)).toEqual([]);
    expect(db.runIdsForChat(chatB.id, userA.userId)).toEqual([]);
    // And the owner's own chat still resolves — the gate denies the
    // cross-user ask, not the read itself.
    expect(db.runIdsForChat(chatB.id, userB.userId)).toEqual([runB]);
  });

  test("the exported CHAT_RUN_IDS_SQL answers the same core set runIdsForChat scopes for an owned chat (the no-drift contract)", () => {
    // The constant is the mapping; runIdsForChat is the constant plus the
    // user gate. Preparing the constant DIRECTLY on the fixture db must
    // yield exactly the owned chat's runs — duplicates collapsed, NULLs and
    // empty strings never returned — proving the composition changed no
    // semantics and that the CLI's unscoped read resolves the same ids the
    // server route would scope.
    const projA = db.listProjects(userA.userId)[0]!;
    const chatA = db.listChats(projA.id, userA.userId)[0]!;
    expect(db.runIdsForChat(chatA.id, userA.userId)).toEqual([runA]);
    const web = new DatabaseSync(join(tmpRoot, "web.db"), { readOnly: true });
    try {
      const rows = web.prepare(CHAT_RUN_IDS_SQL).all(chatA.id) as ReadonlyArray<Record<string, unknown>>;
      expect(rows.map((r) => r["run_id"])).toEqual([runA]);
      // A chat no message carries a run for resolves to NOTHING — the CLI's
      // --chat seam reads that as the honest absent, never "all runs".
      expect((web.prepare(CHAT_RUN_IDS_SQL).all("chat-without-runs") as unknown[]).length).toBe(0);
    } finally {
      web.close();
    }
  });
});

describe("Cross-user run scoping — the routes + bridge call the gate (source-grep, no bypass)", () => {
  test("DbClient declares allRunIdsForUser + runBelongsToUser (the single run→user gate)", () => {
    const src = readFileSync(DB_CLIENT_PATH, "utf8");
    expect(src).toMatch(/allRunIdsForUser\s*\(/);
    expect(src).toMatch(/runBelongsToUser\s*\(/);
  });

  test("agents route uses getAgentStatesForUser with the user's owned runId set (NOT the unscoped getAllAgentStates)", () => {
    const src = readFileSync(AGENTS_ROUTE_PATH, "utf8");
    expect(src).toMatch(/import\s+\{\s*getAgentStatesForUser\s*\}/);
    // The agent-states routes build the user's runId set + filter through it.
    expect(src).toMatch(/db\.allRunIdsForUser\(/);
    expect(src).toMatch(/getAgentStatesForUser\(/);
    // The route must NOT call the unscoped getAllAgentStates (that would
    // leak every user's agents).
    expect(src).not.toMatch(/\bgetAllAgentStates\s*\(/);
  });

  test("NO route file imports or calls the unscoped getAllAgentStates / getActiveAgents (deny-by-default, dynamic discovery)", () => {
    // The agent-state store is GLOBAL (no user_id column). The unscoped
    // accessors were removed from the bridge exports; this test guarantees
    // NO route re-introduces a direct call. Dynamic discovery: scan EVERY
    // .ts file under server/routes/ so a NEW route that calls the unscoped
    // accessor is auto-caught (no hardcoded list — rule: dynamic discovery).
    // This closes the gap that let run.ts:1469 call getAllAgentStates() for
    // 6+ rounds undetected (the prior test only checked agents.ts).
    const ROUTES_DIR = join(process.cwd(), "server", "routes");
    const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
    expect(routeFiles.length, "must discover route files").toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of routeFiles) {
      const src = readFileSync(join(ROUTES_DIR, f), "utf8");
      // A route must not import OR call the unscoped accessors. The scoped
      // accessors (getAgentStatesForUser / getAgentStatesForRun) are allowed.
      if (/\bgetAllAgentStates\s*\(/.test(src) || /\bgetActiveAgents\s*\(/.test(src)) {
        offenders.push(f);
      }
      if (/import\s+\{[^}]*\b(getAllAgentStates|getActiveAgents)\b[^}]*\}/.test(src)) {
        offenders.push(`${f} (import)`);
      }
    }
    expect(
      offenders,
      `routes calling/importing the unscoped agent-state accessors (cross-user leak):\n${offenders.map((o) => `  - ${o}`).join("\n")}`,
    ).toEqual([]);
  });

  test("agents-bridge exports ONLY the scoped accessors (getAgentStatesForUser / getAgentStatesForRun) — the unscoped accessors are not exported", () => {
    const src = readFileSync(AGENTS_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/export\s+function\s+getAgentStatesForUser\s*\(/);
    expect(src).toMatch(/export\s+function\s+getAgentStatesForRun\s*\(/);
    // The unscoped accessors must NOT be exported (deny-by-default: a
    // consumer cannot accidentally call the global list).
    expect(src).not.toMatch(/export\s+function\s+getAllAgentStates\s*\(/);
    expect(src).not.toMatch(/export\s+function\s+getActiveAgents\s*\(/);
  });

  test("agents-bridge.getAgentStatesForUser filters by the supplied runId set (deny-by-default)", () => {
    const src = readFileSync(AGENTS_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/export\s+function\s+getAgentStatesForUser\s*\(/);
    // The filter must keep only states whose runId is in the user's set.
    expect(src).toMatch(/userRunIds\.has\(s\.runId\)/);
  });

  test("agents-bridge.getAgentStatesForRun filters to the supplied runId (deny-by-default)", () => {
    const src = readFileSync(AGENTS_BRIDGE_PATH, "utf8");
    expect(src).toMatch(/export\s+function\s+getAgentStatesForRun\s*\(/);
    // The filter must keep only states whose runId equals the supplied run.
    expect(src).toMatch(/s\.runId\s*===\s*runId/);
  });

  test("timeline event-detail route calls runBelongsToUser + denies events with a null runId (deny-by-default)", () => {
    const src = readFileSync(TIMELINE_ROUTE_PATH, "utf8");
    expect(src).toMatch(/db\.runBelongsToUser\(/);
    // A null runId (no user provenance) must be denied, not allowed.
    expect(src).toMatch(/event\.runId\s*===\s*null/);
  });

  test("timeline list and spectrum share mandatory owned-run scope before reads", () => {
    const scope = readFileSync(join(process.cwd(), modulePath("timeline-scope.ts")), "utf8");
    expect(scope).toMatch(/db\.allRunIdsForUser\(/);
    expect(scope).toContain("selected.filter((runId) => ownedRuns.has(runId))");
    expect(scope).toContain("selection.runId !== undefined || selection.runIds !== undefined");
    for (const file of [TIMELINE_ROUTE_PATH, join(process.cwd(), modulePath("spectrum.ts"))]) {
      const src = readFileSync(file, "utf8");
      // The value import is parsed from the import clause (the call below pins the binding).
      expect(valueReferencesModule(src, "timeline-scope")).toBe(true);
      expect(src).toMatch(/await resolveTimelineScope\(db, user,/);
      expect(src).toMatch(/\.\.\.scope|runIds: scope\.runIds/);
    }
  });
});

describe("Cross-user run scoping — client-supplied run ids cannot poison the run→user mapping", () => {
  test("the public POST /api/chats/:id/messages schema does NOT accept a client-supplied runId", () => {
    // messages.run_id is the authoritative run→user mapping key. Accepting
    // a client run_id on the public message-create endpoint would let a
    // caller poison their own chat with another user's run id, then read
    // that run's timeline events + agent states (cross-user leak). Only the
    // run route (server-generated run id) sets run_id, via the internal
    // db.createMessage.
    const CHATS_ROUTE_PATH = join(process.cwd(), "server", "routes", "chats.ts");
    const src = readFileSync(CHATS_ROUTE_PATH, "utf8");
    const schemaMatch = src.match(/const\s+MESSAGE_CREATE_SCHEMA\s*=\s*z\.strictObject\(\{([^}]*)\}\)/);
    expect(schemaMatch, "MESSAGE_CREATE_SCHEMA must be defined").not.toBeNull();
    const schemaBody = schemaMatch![1]!;
    expect(
      schemaBody,
      "MESSAGE_CREATE_SCHEMA must NOT accept a runId field (client run-id injection)",
    ).not.toMatch(/\brunId\b/);
  });

  test("DbClient.runIdsForChat resolves run ids ONLY from messages.run_id, NOT from timeline_refs.metadata.runId (untrusted client blob)", () => {
    // timeline_refs.metadata is client-writable (POST /api/chats/:id/
    // timeline accepts metadata: z.unknown()). Trusting its `runId` would
    // let a caller poison their own runId set with another user's run id —
    // a cross-user timeline leak via the chat-scoped query. The
    // authoritative source is messages.run_id (server-written by the run
    // route, which generates the run id).
    //
    // The mapping's SQL is OWNED by the exported CHAT_RUN_IDS_SQL constant
    // (the db owner composes the user gate after it; the dev trace CLI
    // prepares the same bytes for `--chat`), so the ownership pins are
    // stated against the constant and the method TOGETHER: the constant
    // reads messages.run_id only, the method composes the constant (never
    // restates it), and neither trusts the metadata blob.
    const src = readFileSync(DB_CLIENT_PATH, "utf8");
    const constMatch = src.match(/export const CHAT_RUN_IDS_SQL =\s*"([^"]+)"/);
    expect(constMatch, "CHAT_RUN_IDS_SQL must be exported — the chat→runs mapping's one owner").not.toBeNull();
    expect(constMatch![1]!, "the owned mapping reads messages.run_id only").toMatch(
      /^SELECT DISTINCT run_id FROM messages WHERE chat_id = \? AND run_id IS NOT NULL AND run_id != ''$/,
    );
    const methodMatch = src.match(/runIdsForChat\([\s\S]*?\n  \}/);
    expect(methodMatch, "runIdsForChat must be defined").not.toBeNull();
    const methodBody = methodMatch![0]!;
    expect(methodBody, "runIdsForChat must compose the owned statement, never restate it").toMatch(/\$\{CHAT_RUN_IDS_SQL\}/);
    expect(methodBody, "no SQL mirror may drift beside the owner").not.toMatch(/SELECT DISTINCT run_id/);
    // The USER GATE must be pinned in the method body too: the
    // composition pin above is satisfied by an UNGATED prepare of the
    // owned statement (`${CHAT_RUN_IDS_SQL}` alone), which would hand
    // every caller every chat's runs. The gate has two halves, both
    // owned here — the ownership check BEFORE the query, and the SQL
    // composition that scopes the prepared statement to the caller's own
    // chats. Together with the behavioral arm (user B asking for A's
    // chat resolves to []), an ungated prepare can pass neither.
    expect(methodBody, "runIdsForChat must gate on chatBelongsToUser before the mapping").toMatch(/chatBelongsToUser\s*\(/);
    expect(methodBody, "the prepared statement must be scoped to the caller's chats (the USER_CHATS composition)").toMatch(/AND chat_id IN \(\$\{USER_CHATS\}\)/);
    // The method must NOT consult timeline_refs.metadata for the run id.
    expect(methodBody, "runIdsForChat must NOT trust timeline_refs.metadata.runId").not.toMatch(/metadata\s*\[[\s"']*runId[\s"']*\]|meta\s*\.[\s"']*runId/);
    // And the CLI consumes the SAME bytes — no hand-copied SQL beside the
    // ledger dig (the dev tool resolves --chat through the owner).
    const cli = readFileSync(join(process.cwd(), "scripts", "trace.ts"), "utf8");
    expect(cli, "the trace CLI must prepare the owner's CHAT_RUN_IDS_SQL").toMatch(
      /prepare\(CHAT_RUN_IDS_SQL\)/,
    );
  });

});
