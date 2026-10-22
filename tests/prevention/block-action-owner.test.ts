// @vitest-environment node
/**
 * BLOCK ACTIONS — the guard for the action fabric.
 *
 * A declared action is three promises at once: the words on the control are
 * true (LANGUAGE), pressing it does the thing (LIVENESS), and the system can
 * afterwards say who did it (RECORDING). Each promise has a failure mode
 * that renders fine and lies:
 *
 *   - a verb whose consequence sentence is jargon or overstatement — the
 *     control reads as capability the handler does not have;
 *   - a declared-but-inert action — the button of a handler that cannot do
 *     the thing, the inert-control rule now applied to verbs;
 *   - an action that runs unrecorded — a state change the ledger cannot
 *     explain, invisible exactly when someone asks "what changed this?".
 *
 * DISCOVERY IS DYNAMIC: actions are enumerated from the live block registry
 * (`listBlocks()` after `registerAllRoutes`), never from a list here. The
 * LIVENESS class is the one place a per-action proof is required, and the
 * COVERED-set equality at the bottom is the ratchet that forces every newly
 * declared action to bring its proof: declaring a verb without one fails
 * this file, by design.
 *
 * Everything runs over REAL HTTP against the production router + block
 * mounts, so attribution comes from the router's recording boundary (the
 * authenticated user), not from a test-supplied context — the same shape the
 * effect-kind suite uses for the filesystem kind.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Set the project root BEFORE config resolves, so the timeline ledger and
// any root-gated config land in this test's temp world. The CONFIG FILE is
// scoped too: the settings family's array door writes through `writeConfigRaw`
// (the one config gate), which lands in the real config path by design — the
// diagnostic-modes liveness proof below round-trips that write, so the whole
// server must point at a scratch copy before the first server module import
// (the mcp-servers-route scoping). The scratch copy lives outside the tree,
// where the confinement guardian's binary does not exist; a config that
// demands confinement there would fail CLOSED and refuse every check
// subprocess (measured: the typecheck arm answered binary_missing), so the
// scratch seeds selfProtection off — this suite's arms assert the verbs'
// own behavior, never confinement, which has its own owner.
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  process.env.HARNESS_WEB_PROJECT_ROOT = createTempDir("ch-block-actions-root-");
  const scratch = createTempDir("ch-block-actions-config-");
  const real = fileURLToPath(new URL("../../engine/bridlewise.config.json", import.meta.url));
  const configPath = join(scratch, "bridlewise.config.json");
  const base = JSON.parse(readFileSync(real, "utf8")) as Record<string, unknown>;
  base["selfProtection"] = { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false };
  // The seed write goes through the atomic-rename owner (mode 0600 carried
  // across the rename) so even a scratch copy is never a truncating write.
  const { atomicWriteFile } = await import("../../engine/src/filesystem/atomic-write.ts");
  expect(atomicWriteFile(configPath, JSON.stringify(base), { createMode: 0o600 }).success).toBe(true);
  process.env.HARNESS_CONFIG_PATH = configPath;
  // This suite is ONE heavy scripted client: ~60 mutating POSTs as the same
  // admin user inside a few seconds, against a product limiter budgeted for
  // a human (60/minute). At that margin the LAST tests red with 429s
  // depending on how much proportional refill accrued — a timing flake
  // measured on a clean tree (the "failed effect" arm red with 429 twice in
  // a row on unmodified bytes). The env override is the sanctioned test-
  // server pattern (async-db-orderings boots its child with
  // HARNESS_WEB_RATE_LIMIT=10000 for the same reason): the limiter's own
  // contract has its own owner suite (rate-limit-security.test.ts); this
  // suite's subject is the ACTION contract, and its server gets a budget a
  // scripted client can actually live under. The mechanism still runs —
  // every POST is still charged.
  process.env.HARNESS_WEB_RATE_LIMIT = "1000";
});

import { randomUUID } from "node:crypto";
import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { createTempGitRepo } from "../helpers/temp-git-repo.ts";
import { getTimelineQuery, getTimelineRecorder } from "../../server/observability/timeline-bridge.ts";
// COCKPIT block proofs (run.compose / tools.breaker / arm.flags): the
// boundary function is the run loop's own import, and the memory write is
// the memory owner's single entry point — the proofs exercise the REAL
// paths, not mirrors.
import { honorToolBoundary, tripToolBreaker, revertGateAutoTrips, breakerConfigOf } from "../../server/blocks/breaker.ts";
import { storeInteraction } from "../../server/context/memory-bridge.ts";
import {
  registerAllExposure,
  listCustomizations,
  getCustomization,
} from "../../server/kernel/canonical.ts";
import { listBlocks } from "../../server/blocks/define.ts";
import { registerAllRoutes } from "../../server/routes/registry.ts";
import { servedSettingsIdsTheRawDetectorWouldCorrupt } from "../helpers/egress-id-corpus.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { SEL_KEYS } from "../../shared/module-contract.ts";

import { modulePath } from "../helpers/module-resolver.ts";
let srv: HttpTestServer;
let admin: TestUser;
let projectId: string;
let projectPath: string;

beforeAll(async () => {
  // The sink installs on first open; production opens the timeline at boot.
  getTimelineQuery();
  srv = await startHttpTestServer({
    prefix: "ch-block-actions-",
    register: (router, _db, adb) => registerAllRoutes(router, adb),
  });
  // First user on a fresh DB is the admin — mirrors production.
  admin = createTestUser(srv.db, "action-admin");
  // A real, tiny, type-correct project for the check rerun to measure.
  projectPath = createTempDir("ch-block-actions-proj-");
  writeFileSync(
    join(projectPath, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["main.ts"] }),
  );
  writeFileSync(join(projectPath, "main.ts"), "export const answer: number = 42;\n");
  mkdirSync(join(projectPath, "src"), { recursive: true });
  const project = srv.db.createProject({ name: "action-proof", path: projectPath }, admin.userId);
  projectId = project.id;
});

afterAll(async () => {
  await srv.stop();
});

/** Every declared action across the live registry, with its block id. */
function declaredActions() {
  const out: { id: string; name: string; title: string; consequence: string; params?: Readonly<Record<string, string>> }[] = [];
  for (const { descriptor } of listBlocks()) {
    for (const d of descriptor.actionDescriptors ?? []) {
      out.push({ id: descriptor.id, name: d.name, title: d.title, consequence: d.consequence, ...(d.params !== undefined ? { params: d.params } : {}) });
    }
  }
  return out;
}

/** "task"-lane ledger events for one actor, newest first. */
function taskEventsFor(actorId: string) {
  return getTimelineQuery()
    .byEventType("task", { ascending: false, limit: 500 })
    .events.filter((e) => e.actorId === actorId);
}

describe("A. action discovery is live", () => {
  test("the registry declares actions, including the four first verbs", () => {
    const actions = declaredActions();
    expect(actions.length, "no declared actions found — the fabric is unwired").toBeGreaterThanOrEqual(4);
    const keys = actions.map((a) => `${a.id}/${a.name}`);
    expect(keys).toContain("checks.auto/rerun");
    expect(keys).toContain("code.map/reindex");
    expect(keys).toContain("tools.enabled/toggle");
    expect(keys).toContain("settings.customizations/set");
  });
});

describe("B. language — the words on the control", () => {
  // The rendered-string rules the plain-language guard applies elsewhere,
  // applied here to the declaration the surfaces render verbatim.
  const JARGON = [
    /(?<![\w-])exposure(?![\w-])/i,
    /(?<![\w-])customizations?(?![\w-])/i,
    /(?<![\w-])dedup(?![\w-])/i,
    /(?<![\w-])preimage(?![\w-])/i,
    /(?<![\w-])projection(?![\w-])/i,
    /(?<![\w-])determinis(?:m|tic)(?![\w-])/i,
    /(?<![\w-])harness(?![\w-])/i,
    /(?<![\w-])LLM(?![\w-])/i,
    /(?<![\w-])stub(?![\w-])/i,
    /(?<![\w-])ledger(?![\w-])/i,
    /\b(?:sys|legacy)\.[A-Za-z]/,
    /\b[a-z0-9]+_[a-z0-9]+(?:_[a-z0-9]+)*\b/, // snake_case internal keys
    /\breporting\b/i, // the liveness-claim word
  ];

  test("every action declares a short verb title and a full consequence sentence", () => {
    for (const a of declaredActions()) {
      const where = `${a.id}/${a.name}`;
      expect(a.title.trim().length, `${where}: empty title`).toBeGreaterThan(1);
      expect(a.title.length, `${where}: title is a sentence, not a verb`).toBeLessThanOrEqual(40);
      expect(a.consequence.trim().length, `${where}: consequence too short to state what happens and when`).toBeGreaterThanOrEqual(30);
    }
  });

  test("no jargon, no internal keys, no liveness claims in rendered words", () => {
    for (const a of declaredActions()) {
      const where = `${a.id}/${a.name}`;
      for (const pattern of JARGON) {
        expect(a.title, `${where} title matches ${pattern}`).not.toMatch(pattern);
        expect(a.consequence, `${where} consequence matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test("declared input templates reference only real selection keys", () => {
    const keys = new Set<string>(SEL_KEYS);
    for (const a of declaredActions()) {
      for (const value of Object.values(a.params ?? {})) {
        if (!value.startsWith("$sel.")) continue;
        expect(
          keys.has(value.slice("$sel.".length)),
          `${a.id}/${a.name}: params template "${value}" names an unknown selection key`,
        ).toBe(true);
      }
    }
  });
});

describe("C. deny-by-default at the door", () => {
  test("garbage input is a typed 400, not a handler crash", async () => {
    const res = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/rerun", {
      method: "POST",
      cookie: admin.cookie,
      body: { nonsense: true },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toBe("invalid_block_input");
  });

  test("an undeclared action name is a 404 — no route exists to reach", async () => {
    const res = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/nonexistent", {
      method: "POST",
      cookie: admin.cookie,
      body: {},
    });
    expect(res.status).toBe(404);
  });

  test("an unauthenticated action is refused", async () => {
    const res = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/rerun", {
      method: "POST",
      body: { projectId: "p" },
    });
    expect(res.status).toBe(401);
  });
});

// ── D. LIVENESS — every declared action provably does the thing ──────────

/** Actions proven live below. The equality test at the bottom makes this a
 *  ratchet: declaring a new action without adding its proof fails. */
const COVERED = new Set<string>();

describe("D. liveness — the handler really does the thing", () => {
  test("checks.auto/rerun runs the real check and persists a completed row", async () => {
    COVERED.add("checks.auto/rerun");
    const before = srv.db.listAutoChecksByProject(projectId, admin.userId).length;

    const ok = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/rerun", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId, checkName: "typecheck" },
    });
    expect(ok.status).toBe(200);
    const env = ok.body as { data: { checks: { status: string; output: { exitCode?: number } }[] }; meta: { actor?: string; traceId?: string } };
    expect(env.data.checks).toHaveLength(1);
    // A REAL run on a type-correct file: measured pass, real exit code.
    expect(env.data.checks[0]!.status).toBe("passed");
    expect(env.data.checks[0]!.output.exitCode).toBe(0);
    // The envelope explains itself: who asked, under which trace.
    expect(env.meta.actor).toBe(`user:${admin.userId}`);
    expect(env.meta.traceId).toBeTruthy();

    // MUTATION: break the code, rerun — the check must MEASURE, not replay.
    writeFileSync(join(projectPath, "main.ts"), "export const answer: number = \"not a number\";\n");
    const broken = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/rerun", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId, checkName: "typecheck" },
    });
    expect(broken.status).toBe(200);
    const brokenEnv = broken.body as { data: { checks: { status: string; output: { errorCount?: number } }[] } };
    expect(brokenEnv.data.checks[0]!.status).toBe("failed");
    expect(brokenEnv.data.checks[0]!.output.errorCount).toBeGreaterThanOrEqual(1);
    writeFileSync(join(projectPath, "main.ts"), "export const answer: number = 42;\n");

    // Persisted as a COMPLETED row — never a "running" stub — and deduped:
    // `createAutoCheck` upserts per (check_name, scope), so the rerun
    // REPLACED the prior result, and the stored row is the latest run's.
    const rows = srv.db.listAutoChecksByProject(projectId, admin.userId);
    expect(rows.length).toBe(before + 1);
    const stored = rows.find((r) => r.check_name === "typecheck");
    expect(stored?.status).toBe("failed"); // the broken-code run, i.e. the latest
    for (const row of rows) expect(row.status).not.toBe("running");
  });

  test("code.map/reindex genuinely discards the stored reading", async () => {
    COVERED.add("code.map/reindex");
    // Warm: poll the block read until the map is ready (202 while building).
    let ready = await jsonRequest(srv.baseUrl, `/api/b/code.map?path=${encodeURIComponent(projectPath)}`, { cookie: admin.cookie });
    const deadline = Date.now() + 60_000;
    while (ready.status === 202 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      ready = await jsonRequest(srv.baseUrl, `/api/b/code.map?path=${encodeURIComponent(projectPath)}`, { cookie: admin.cookie });
    }
    expect(ready.status).toBe(200);

    const res = await jsonRequest(srv.baseUrl, "/api/b/code.map/reindex", {
      method: "POST",
      cookie: admin.cookie,
      body: { path: projectPath },
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { cleared: boolean; rebuilding: boolean } }).data).toEqual({
      cleared: true,
      rebuilding: true,
    });

    // The drop is synchronous inside the handler; the rebuild is a worker
    // round-trip. The immediate re-read must therefore find the reading
    // gone (202 building) — a handler that skipped the invalidation would
    // answer 200 from the warm entry it never dropped.
    const after = await jsonRequest(srv.baseUrl, `/api/b/code.map?path=${encodeURIComponent(projectPath)}`, { cookie: admin.cookie });
    expect(after.status).toBe(202);

    // And the rebuild it kicked genuinely completes.
    let rebuilt = after;
    const rebuildDeadline = Date.now() + 60_000;
    while (rebuilt.status === 202 && Date.now() < rebuildDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      rebuilt = await jsonRequest(srv.baseUrl, `/api/b/code.map?path=${encodeURIComponent(projectPath)}`, { cookie: admin.cookie });
    }
    expect(rebuilt.status).toBe(200);
  });

  test("tools.enabled/toggle flips the per-user override the runs consult", async () => {
    COVERED.add("tools.enabled/toggle");
    const list = await jsonRequest(srv.baseUrl, "/api/b/tools.enabled", { cookie: admin.cookie });
    expect(list.status).toBe(200);
    const tools = (list.body as { data: { tools: { name: string; enabled: boolean; source: string }[] } }).data.tools;
    expect(tools.length).toBeGreaterThan(0);
    const target = tools.find((t) => t.enabled && t.source === "default");
    expect(target, "no default-enabled built-in tool to prove the toggle on").toBeDefined();

    const off = await jsonRequest(srv.baseUrl, "/api/b/tools.enabled/toggle", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool: target!.name, enabled: false },
    });
    expect(off.status).toBe(200);
    const offState = (off.body as { data: { tools: { name: string; enabled: boolean; source: string }[] } }).data.tools.find((t) => t.name === target!.name);
    expect(offState).toMatchObject({ enabled: false, source: "you" });

    // The override row is exactly what the run route and the per-run safety
    // gate read (db.listToolSettings) — this is the store, not a mirror.
    const row = srv.db.listToolSettings(admin.userId).find((r) => r.tool_name === target!.name);
    expect(row?.enabled).toBe(false);

    // Restore: the override remains a per-user row, now enabled.
    const on = await jsonRequest(srv.baseUrl, "/api/b/tools.enabled/toggle", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool: target!.name, enabled: true },
    });
    expect(on.status).toBe(200);
    const onRow = srv.db.listToolSettings(admin.userId).find((r) => r.tool_name === target!.name);
    expect(onRow?.enabled).toBe(true);
  });

  test("client.telemetry/ingest records the browser's facts into the client lanes, attributed", async () => {
    COVERED.add("client.telemetry/ingest");
    const before = getTimelineQuery().byEventType("client-error", { ascending: false, limit: 50 })
      .events.filter((e) => e.actorId === admin.userId).length;
    const res = await jsonRequest(srv.baseUrl, "/api/b/client.telemetry/ingest", {
      method: "POST",
      cookie: admin.cookie,
      body: {
        events: [
          { kind: "client-error", clientTimestamp: Date.now(), facts: { message: "Uncaught ReferenceError: gone is not defined", source: "app.js", line: 7 } },
          { kind: "client-metric", clientTimestamp: Date.now(), facts: { longTaskMs: 91, longTaskCount: 1 } },
        ],
        droppedCount: 2,
      },
    });
    expect(res.status).toBe(200);
    const env = res.body as { data: { recorded: number; correlation: string; droppedRecorded: number }; meta: { actor?: string; traceId?: string } };
    // The whole batch landed: two events plus the dropped-count fact.
    expect(env.data).toEqual({ recorded: 3, correlation: "none", droppedRecorded: 1 });

    // LIVENESS — the ledger really holds them, attributed to the caller:
    const errors = getTimelineQuery().byEventType("client-error", { ascending: false, limit: 50 })
      .events.filter((e) => e.actorId === admin.userId);
    expect(errors.length).toBe(before + 1);
    expect(errors[0]!.outcome).toBe("failed");
    expect(errors[0]!.errorCode).toBe("client_error");
    const drop = getTimelineQuery().byEventType("client-metric", { ascending: false, limit: 50 })
      .events.find((e) => e.actorId === admin.userId && e.description.includes("droppedClientEvents"));
    expect(drop, "the stated drop count landed as its own fact").toBeDefined();
  });

  test("editor.preview/preview resolves a real preimage and reports the postimage hash, writing nothing", async () => {
    COVERED.add("editor.preview/preview");
    registerAllExposure();
    // The project already holds main.ts ("export const answer: number = 42;").
    const before = readFileSync(join(projectPath, "main.ts"), "utf8");
    const res = await jsonRequest(srv.baseUrl, "/api/b/editor.preview/preview", {
      method: "POST",
      cookie: admin.cookie,
      body: { path: projectPath, file: "main.ts", oldString: "answer: number = 42", newString: "answer: number = 43" },
    });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { ok: boolean; strategy: string | null; expectedPostimageHash: string | null } }).data;
    expect(data.ok).toBe(true);
    expect(data.strategy).toBe("exact");
    expect(typeof data.expectedPostimageHash).toBe("string");
    // A preview must leave the file byte-for-byte unchanged.
    expect(readFileSync(join(projectPath, "main.ts"), "utf8")).toBe(before);
    // And a refused preview surfaces a structured reason, not a stack.
    const refused = await jsonRequest(srv.baseUrl, "/api/b/editor.preview/preview", {
      method: "POST",
      cookie: admin.cookie,
      body: { path: projectPath, file: "main.ts", oldString: "not present anywhere", newString: "x" },
    });
    expect(refused.status).toBe(200);
    expect((refused.body as { data: { ok: boolean; reason: string | null } }).data).toMatchObject({ ok: false, reason: "old_content_not_found" });
  });

  test("editor.preview/rollback honestly reports when no snapshot is retained", async () => {
    COVERED.add("editor.preview/rollback");
    registerAllExposure();
    const res = await jsonRequest(srv.baseUrl, "/api/b/editor.preview/rollback", {
      method: "POST",
      cookie: admin.cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { rolledBack: boolean } }).data;
    // Whatever the retained-history state, the verb ANSWERS with a real
    // boolean and never throws — the handler really ran.
    expect(typeof data.rolledBack).toBe("boolean");
  });

  test("settings.customizations/set writes through the validated choke point", async () => {
    COVERED.add("settings.customizations/set");
    registerAllExposure();
    const boolCust = listCustomizations().find((c) => c.type === "boolean");
    expect(boolCust, "no boolean customization to prove the write on").toBeDefined();
    const id = boolCust!.id;
    const original = getCustomization(id)!.current() as boolean;

    // The client's whole reality is what the wire served: source the id
    // from GET /api/schema/ui — through the egress redaction walk — rather
    // than from the in-process registry. Measured (the masked-id settings
    // row, drive 13): the walk masked one registry id as a credential on
    // its way out, so the row's Save verb posted the masked id and 404'd
    // against the server's own registry; a liveness proof that starts from
    // the registry id cannot see that break.
    const wire = await jsonRequest(srv.baseUrl, "/api/schema/ui", { method: "GET", cookie: admin.cookie });
    expect(wire.status).toBe(200);
    const served = ((wire.body as { settings: { id: string }[] }).settings).find(
      (s) => s.id === boolCust!.id,
    );
    expect(served, `${id}: the registry id must be served on the schema wire, byte-identical`).toBeDefined();

    const res = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { id: served!.id, value: !original },
    });
    expect(res.status).toBe(200);
    expect(getCustomization(id)!.current()).toBe(!original);

    // THE MASKED READ-BACK ANSWER — a save whose value the display egress
    // hides is answered in the form the wire serves: `value` arrives
    // MASKED (the egress walk masks the answer like any other response
    // body), `masked: true` rides beside it, and the RAW the request sent
    // never appears in the answer. The settings sheet paints this answer
    // as the post-save display, so the read-back note is true and the raw
    // leaves the screen with the save. Proven through a real free-form
    // string row (the class every free-form field belongs to), with the
    // store checked directly for what actually landed.
    const stringCust = listCustomizations().find(
      (c) => c.type === "string" && c.current() === "" && c.id === "awareness.monitoredModules",
    );
    expect(stringCust, "no free-form string row standing at its empty default to prove the masked answer on").toBeDefined();
    const rawCredential = "sk-live-r48-readback-proof-7742a1c9";
    const maskedSave = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { id: stringCust!.id, value: rawCredential },
    });
    expect(maskedSave.status).toBe(200);
    const maskedAnswer = (maskedSave.body as { data?: { value?: unknown; masked?: true } }).data;
    expect(maskedAnswer, "the accepted save must answer with the read-back").toBeDefined();
    expect(maskedAnswer!.masked).toBe(true);
    expect(maskedAnswer!.value).toBe("[REDACTED:token]");
    expect(JSON.stringify(maskedSave.body)).not.toContain(rawCredential);
    expect(getCustomization(stringCust!.id)!.current()).toBe(rawCredential);
    const maskedRestore = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { id: stringCust!.id, value: "" },
    });
    expect(maskedRestore.status).toBe(200);
    const maskedRestoreAnswer = (maskedRestore.body as { data?: { value?: unknown; masked?: true } }).data;
    expect(maskedRestoreAnswer!.masked).toBeUndefined();
    expect(maskedRestoreAnswer!.value).toBe("");
    expect(getCustomization(stringCust!.id)!.current()).toBe("");

    // THE MASKED-ID CORPUS through THIS door — the door the settings
    // sheet's Save verb actually posts to. The corpus is discovered from
    // the served wire (served settings ids the raw detector would corrupt),
    // never listed; each member must save + restore through the block with
    // its SERVED id. Today the corpus is one numeric row; a non-numeric id
    // joining it fails the type ratchet below until this loop is extended.
    const corpus = servedSettingsIdsTheRawDetectorWouldCorrupt(wire.body);
    expect(
      corpus.length,
      "no served settings id trips the raw detector — the corpus is empty; the oracle or the exemption changed",
    ).toBeGreaterThan(0);
    for (const servedId of corpus) {
      const cust = getCustomization(servedId)!;
      expect(cust.type, `${servedId}: extend the block-door corpus loop when a non-numeric id joins`).toBe(
        "number",
      );
      const before = cust.current() as number;
      const min = cust.min ?? before - 1;
      const max = cust.max ?? before + 1;
      const alternative = before === max ? min : max;
      const saved = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { id: servedId, value: alternative },
      });
      expect(saved.status, `${servedId}: the save with the served id must be accepted`).toBe(200);
      expect(cust.current(), `${servedId}: the saved value must take effect`).toBe(alternative);
      const restored = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { id: servedId, value: before },
      });
      expect(restored.status).toBe(200);
      expect(cust.current(), `${servedId}: must restore to its original value`).toBe(before);
    }

    // MUTATION: an out-of-contract value is refused AND changes nothing —
    // the choke point's validation is in force through this door too.
    // The refusal is DESIGNED (the sheet renders its sentence as the Save
    // press's answer), so it travels in the 200 envelope as data with the
    // guided family's status — a raw 400/428 would log as a browser console
    // error on every honest wrong value.
    const numCust = listCustomizations().find((c) => c.type === "number" && c.max !== undefined);
    if (numCust !== undefined) {
      const before = getCustomization(numCust.id)!.current();
      const bad = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { id: numCust.id, value: (numCust.max as number) + 1 },
      });
      expect(bad.status).toBe(200);
      const refusal = (bad.body as { refusal?: { code?: string; status?: number; message?: string } })
        .refusal;
      expect(refusal, "the refused write must carry the typed refusal in the envelope").toMatchObject(
        { code: "invalid_customization_value", status: 428 },
      );
      expect(refusal!.message).toMatch(/^the setting "/);
      expect(getCustomization(numCust.id)!.current()).toStrictEqual(before);
    }

    // An unknown id is a 404, never a silent no-op.
    const missing = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { id: "no.such.setting", value: 1 },
    });
    expect(missing.status).toBe(404);

    // The gate matches the legacy door: a non-admin cannot write shared state.
    const regular = createTestUser(srv.db, "action-regular");
    const denied = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: regular.cookie,
      body: { id, value: original },
    });
    expect(denied.status).toBe(403);

    // Restore.
    const restore = await jsonRequest(srv.baseUrl, "/api/b/settings.customizations/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { id, value: original },
    });
    expect(restore.status).toBe(200);
    expect(getCustomization(id)!.current()).toBe(original);
  });

  test("settings.diagnosticModes/set lands the array through the one config gate", async () => {
    COVERED.add("settings.diagnosticModes/set");
    // The mode vocabulary is the engine's own — never restated here.
    const { DIAGNOSTIC_MODE_IDS } = await import("../../engine/src/performance/performance-config.ts");
    const excluded = [DIAGNOSTIC_MODE_IDS[1]!, DIAGNOSTIC_MODE_IDS[4]!];
    const before = JSON.parse(
      readFileSync(process.env["HARNESS_CONFIG_PATH"]!, "utf8"),
    ) as { performance?: { diagnosticModes?: { excludedModes?: readonly string[] } } };
    const original = before.performance?.diagnosticModes?.excludedModes ?? [];

    const res = await jsonRequest(srv.baseUrl, "/api/b/settings.diagnosticModes/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { excludedModes: excluded },
    });
    expect(res.status).toBe(200);
    // The write really landed: the scratch config FILE carries the list at
    // the exact leaf, and the block's own read serves it back.
    const after = JSON.parse(
      readFileSync(process.env["HARNESS_CONFIG_PATH"]!, "utf8"),
    ) as { performance?: { diagnosticModes?: { excludedModes?: readonly string[] } } };
    expect(after.performance?.diagnosticModes?.excludedModes).toEqual(excluded);
    const readBack = await jsonRequest(srv.baseUrl, "/api/b/settings.diagnosticModes", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(((readBack.body as { data?: { excluded?: readonly string[] } }).data)?.excluded).toEqual(excluded);

    // The gate is in force through this door too: a duplicate mode is the
    // config document's own cross-field refusal (the section checker's
    // sentence, in the guided envelope), and nothing lands.
    const dup = await jsonRequest(srv.baseUrl, "/api/b/settings.diagnosticModes/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { excludedModes: [DIAGNOSTIC_MODE_IDS[0]!, DIAGNOSTIC_MODE_IDS[0]!] },
    });
    expect(dup.status).toBe(200);
    const refusal = (dup.body as { refusal?: { code?: string; message?: string } }).refusal;
    expect(refusal?.code).toBe("invalid_customization_value");
    expect(refusal?.message).toContain("performance_config_diagnostic_modes_not_unique");

    // Restore: the original list writes back through the same door.
    const restore = await jsonRequest(srv.baseUrl, "/api/b/settings.diagnosticModes/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { excludedModes: [...original] },
    });
    expect(restore.status).toBe(200);
    const restored = JSON.parse(
      readFileSync(process.env["HARNESS_CONFIG_PATH"]!, "utf8"),
    ) as { performance?: { diagnosticModes?: { excludedModes?: readonly string[] } } };
    expect(restored.performance?.diagnosticModes?.excludedModes).toEqual([...original]);
  });

  // ── COCKPIT: run.compose (pin / mute / trim) ─────────────────────────────

  test("run.compose pin/mute/trim change the NEXT composition the run path assembles", async () => {
    COVERED.add("run.compose/pin");
    COVERED.add("run.compose/unpin");
    COVERED.add("run.compose/mute");
    COVERED.add("run.compose/trim");
    const chat = srv.db.createChat({ project_id: projectId, title: "compose-proof" }, admin.userId);
    // Two persisted turns, run-attributed like the run route persists them.
    srv.db.createMessage({ chat_id: chat.id, role: "user", content: "first question about apples", run_id: "run-cp-1" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "first answer", run_id: "run-cp-1" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "user", content: "second question about oranges", run_id: "run-cp-2" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "second answer", run_id: "run-cp-2" }, admin.userId);
    // One memory the pin can force in — content unrelated to the last prompt.
    const memoryId = storeInteraction("zebra quantum flotilla — unrelated recall target", {
      chatId: chat.id,
      topic: "compose-proof",
      userId: admin.userId,
    });

    const composeUrl = `/api/b/run.compose?chatId=${encodeURIComponent(chat.id)}`;
    type Compose = { data: { channels: { id: string; tokens: number; items: { id: string; tokens?: number }[] }[]; limit: number } };
    type Settings = { data: { settings: { mutedChannels: string[]; mutedMemoryIds: string[] } } };
    const channelOf = (body: unknown, id: string) =>
      (body as Compose).data.channels.find((c) => c.id === id)!;

    const before = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(before.status).toBe(200);
    // The read serves the run-path shape: measured channels + a real limit.
    expect(channelOf(before.body, "history").items.length).toBe(2);
    expect((before.body as Compose).data.limit).toBeGreaterThan(0);

    // PIN → the memory is in the next composition's memories strip.
    const pin = await jsonRequest(srv.baseUrl, "/api/b/run.compose/pin", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    expect(pin.status).toBe(200);
    const afterPin = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(channelOf(afterPin.body, "memories").items.map((i) => i.id)).toContain(memoryId);

    // MUTE the item → held out of the SERVED composition even though it was
    // pinned a moment ago (an item mute outweighs the pin — the later verb
    // wins) — but NOT silently: the read still LISTS the memory, struck at
    // 0 tokens, as a stated absence carrying its way back (§1.1 + §3.4).
    const muteItem = await jsonRequest(srv.baseUrl, "/api/b/run.compose/mute", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    expect(muteItem.status).toBe(200);
    const afterMute = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    const mutedItem = channelOf(afterMute.body, "memories").items.find((i) => i.id === memoryId);
    expect(mutedItem, "a muted memory vanished silently — a mute is a stated absence, not a cut").toBeDefined();
    expect(mutedItem!.tokens).toBe(0);
    expect((afterMute.body as Settings).data.settings.mutedMemoryIds).toContain(memoryId);

    // MUTE EXPIRY (the restore is behavioral, not a second verb): the mute
    // was for 1 turn; a new run starting in the chat consumes it, and the
    // STANDING pin resumes. The short wait keeps the run's first-message
    // timestamp strictly after the mute's recorded instant.
    await new Promise((r) => setTimeout(r, 15));
    srv.db.createMessage({ chat_id: chat.id, role: "user", content: "third question", run_id: "run-cp-3" }, admin.userId);
    const afterRun = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    // The muted memory returns via the pin now that the mute expired —
    // back on the wire, so back to a MEASURED cost (no longer 0)…
    const resumedItem = channelOf(afterRun.body, "memories").items.find((i) => i.id === memoryId);
    expect(resumedItem!.tokens ?? 0).toBeGreaterThan(0);
    expect((afterRun.body as Settings).data.settings.mutedMemoryIds).not.toContain(memoryId);
    // …and the new user message is a third history turn.
    expect(channelOf(afterRun.body, "history").items.length).toBe(3);

    // TRIM → history before turn 3 leaves the next composition.
    const trim = await jsonRequest(srv.baseUrl, "/api/b/run.compose/trim", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, beforeTurn: 3 },
    });
    expect(trim.status).toBe(200);
    const afterTrim = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(channelOf(afterTrim.body, "history").items.length).toBe(1);
    expect(channelOf(afterTrim.body, "history").tokens).toBeLessThan(channelOf(afterRun.body, "history").tokens);

    // RESTORE: trim back to turn 1 — the full history returns.
    const untrim = await jsonRequest(srv.baseUrl, "/api/b/run.compose/trim", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, beforeTurn: 1 },
    });
    expect(untrim.status).toBe(200);
    const restored = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(channelOf(restored.body, "history").items.length).toBe(3);

    // UNPIN → the standing include is taken back. The memory is unrelated to
    // the last prompt, so with no pin forcing it in, recall does not reach
    // it and it leaves the strip — the pin was the ONLY reason it was there,
    // which is what makes this a proof the verb did something.
    expect(channelOf(restored.body, "memories").items.map((i) => i.id)).toContain(memoryId);
    const unpin = await jsonRequest(srv.baseUrl, "/api/b/run.compose/unpin", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    expect(unpin.status).toBe(200);
    const afterUnpin = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(channelOf(afterUnpin.body, "memories").items.map((i) => i.id)).not.toContain(memoryId);

    // …and it is re-pinnable: unpin drops the standing include, it does not
    // burn the item.
    const repin = await jsonRequest(srv.baseUrl, "/api/b/run.compose/pin", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    expect(repin.status).toBe(200);
    const afterRepin = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(channelOf(afterRepin.body, "memories").items.map((i) => i.id)).toContain(memoryId);

    // UNMUTE (UIE-009 — the mute was a one-way verb): the way back does not
    // need a run to have started, and it takes the ACTIVE mute back on both
    // planes the mute writes — the item and the whole channel. Item first:
    // mute it again (the pin suspends), then unmute, and the item is back in
    // the strip with NO new run in between — the fold's later-verb-wins,
    // not the expiry.
    const remute = await jsonRequest(srv.baseUrl, "/api/b/run.compose/mute", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    expect(remute.status).toBe(200);
    const afterRemute = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    const remutedItem = channelOf(afterRemute.body, "memories").items.find((i) => i.id === memoryId);
    expect(remutedItem!.tokens).toBe(0); // held out — but still listed, struck
    const unmuteItem = await jsonRequest(srv.baseUrl, "/api/b/run.compose/unmute", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories", itemId: memoryId },
    });
    COVERED.add("run.compose/unmute");
    expect(unmuteItem.status).toBe(200);
    const afterUnmute = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    const restoredItem = channelOf(afterUnmute.body, "memories").items.find((i) => i.id === memoryId);
    expect(restoredItem!.tokens ?? 0).toBeGreaterThan(0);
    expect((afterUnmute.body as Settings).data.settings.mutedMemoryIds).not.toContain(memoryId);
    // Channel plane: mute the whole memories channel, then unmute it — the
    // settings read is the honest contract (the strip itself empties either
    // way once the channel mute is honored, which is the mute's own proof).
    const muteChannel = await jsonRequest(srv.baseUrl, "/api/b/run.compose/mute", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories" },
    });
    expect(muteChannel.status).toBe(200);
    const afterChannelMute = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect((afterChannelMute.body as Settings).data.settings.mutedChannels).toContain("memories");
    const unmuteChannel = await jsonRequest(srv.baseUrl, "/api/b/run.compose/unmute", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, channel: "memories" },
    });
    expect(unmuteChannel.status).toBe(200);
    const afterChannelUnmute = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect((afterChannelUnmute.body as Settings).data.settings.mutedChannels).not.toContain("memories");
    // The channel unmute lifted the channel mute only: the standing pin
    // kept the memory in the strip the whole time.
    expect(channelOf(afterChannelUnmute.body, "memories").items.map((i) => i.id)).toContain(memoryId);
  });

  test("run.compose/rewind withdraws the turns from the NEXT composition, and records that it did", async () => {
    COVERED.add("run.compose/rewind");
    const chat = srv.db.createChat({ project_id: projectId, title: "rewind-proof" }, admin.userId);
    const first = srv.db.createMessage({ chat_id: chat.id, role: "user", content: "kept question", run_id: "run-rw-1" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "kept answer", run_id: "run-rw-1" }, admin.userId);
    const doomed = srv.db.createMessage({ chat_id: chat.id, role: "user", content: "withdrawn question", run_id: "run-rw-2" }, admin.userId);
    const doomedReply = srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "withdrawn answer", run_id: "run-rw-2" }, admin.userId);
    // Inline-event timeline refs for both runs — the shape the run executor
    // persists (server-written metadata carrying the run id). The withdrawn
    // run's ref must stop REPLAYING INLINE into the live transcript when the
    // region withdraws, while the record keeps it (UIE-013: an orphaned
    // error beat is a run the conversation no longer holds, rendered).
    srv.db.createTimelineRef(
      {
        chat_id: chat.id,
        event_id: "evt-rewind-proof-kept",
        event_type: "error",
        timestamp: "2026-09-01T00:00:01.000Z",
        metadata: { eventKind: "error", outcome: "failed", runId: "run-rw-1", description: "kept run's error" },
      },
      admin.userId,
    );
    srv.db.createTimelineRef(
      {
        chat_id: chat.id,
        event_id: "evt-rewind-proof-doomed",
        event_type: "error",
        timestamp: "2026-09-01T00:00:02.000Z",
        metadata: { eventKind: "error", outcome: "failed", runId: "run-rw-2", description: "doomed run's error" },
      },
      admin.userId,
    );

    const composeUrl = `/api/b/run.compose?chatId=${encodeURIComponent(chat.id)}`;
    type Compose = { data: { channels: { id: string; items: { id: string }[] }[] } };
    // The history channel's items are TURNS (a user message opens one), so
    // the four messages above are two exchanges.
    const historyTurns = (body: unknown) =>
      (body as Compose).data.channels.find((c) => c.id === "history")!.items.length;

    const before = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(historyTurns(before.body)).toBe(2);

    // THE VERB — named against the MODEL turn, the way `retry` names it.
    const rewound = await jsonRequest(srv.baseUrl, "/api/b/run.compose/rewind", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, toMessageId: doomedReply.id, mode: "causing-prompt" },
    });
    expect(rewound.status).toBe(200);
    const env = rewound.body as {
      data: { anchorMessageId: string; discardedMessageIds: string[]; promptForRerun: string; eventId: string };
    };
    // The anchor resolved to the PROMPT, not the reply the caller named.
    expect(env.data.anchorMessageId).toBe(doomed.id);
    expect(env.data.discardedMessageIds).toEqual([doomed.id, doomedReply.id]);
    expect(env.data.promptForRerun).toBe("withdrawn question");

    // THE THING IT CLAIMS TO DO: the next composition — the same assembly the
    // run path performs — no longer carries them.
    const after = await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie });
    expect(historyTurns(after.body)).toBe(1);

    // …and the messages were NOT destroyed. A rewind is a recorded event.
    expect(srv.db.getMessage(doomedReply.id, admin.userId)!.content).toBe("withdrawn answer");
    expect(srv.db.getMessage(first.id, admin.userId)).not.toBeNull();

    // The record of the withdrawal is in the ledger, in the `rollback` lane.
    const recorded = getTimelineQuery()
      .byEventType("rollback", { limit: 200 })
      .events.find((e) => e.eventId === env.data.eventId);
    expect(recorded).toBeDefined();
    expect(recorded!.documents.some((d) => d.name === "rewind")).toBe(true);

    // THE WITHDRAWN RUN'S REFS DO NOT REPLAY INLINE (UIE-013): the live
    // transcript's tail page omits the withdrawn run's ref alongside its
    // withdrawn message rows — one withdrawal, both projections — while the
    // surviving run's ref still replays.
    const history = await jsonRequest(srv.baseUrl, `/api/chats/${encodeURIComponent(chat.id)}/history`, { cookie: admin.cookie });
    expect(history.status).toBe(200);
    type HistoryView = { timelineRefs: { eventId: string }[]; messages: { id: string }[] };
    // (The ref's row id is a fresh uuid — the EVENT id is the stable handle
    // the client replays by, so that is what the contract asserts on.)
    const servedRefs = (history.body as HistoryView).timelineRefs.map((r) => r.eventId);
    expect(servedRefs).toContain("evt-rewind-proof-kept");
    expect(servedRefs, "a withdrawn run's ref replayed inline — the region withdrew, its beat did not").not.toContain("evt-rewind-proof-doomed");
    // …and the RECORD keeps it: the timeline route serves every ref of the
    // chat, withdrawn or not (withdrawn is flagged, never deleted).
    const record = await jsonRequest(srv.baseUrl, `/api/chats/${encodeURIComponent(chat.id)}/timeline?limit=50`, { cookie: admin.cookie });
    expect(record.status).toBe(200);
    const recordIds = ((Array.isArray(record.body) ? record.body : (record.body as { data?: unknown[] }).data ?? []) as { eventId?: string }[])
      .map((r) => r.eventId);
    expect(recordIds).toContain("evt-rewind-proof-doomed");
    expect(recordIds).toContain("evt-rewind-proof-kept");
  });

  test("run.compose/restore brings the withdrawn turns back into the NEXT composition", async () => {
    COVERED.add("run.compose/restore");
    // The product rule the rewind rests on is that a destructive action must
    // be undoable AND its record inspectable. The rewind proof above shows
    // the turns leaving; this shows them coming back, through the declared
    // verb, and the record surviving both.
    const chat = srv.db.createChat({ project_id: projectId, title: "restore-proof" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "user", content: "kept question", run_id: "run-rs-1" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "kept answer", run_id: "run-rs-1" }, admin.userId);
    const doomed = srv.db.createMessage({ chat_id: chat.id, role: "user", content: "taken back", run_id: "run-rs-2" }, admin.userId);
    srv.db.createMessage({ chat_id: chat.id, role: "assistant", content: "taken back answer", run_id: "run-rs-2" }, admin.userId);

    const composeUrl = `/api/b/run.compose?chatId=${encodeURIComponent(chat.id)}`;
    type Compose = { data: { channels: { id: string; items: { id: string }[] }[] } };
    const historyTurns = (body: unknown) =>
      (body as Compose).data.channels.find((c) => c.id === "history")!.items.length;

    expect(historyTurns((await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie })).body)).toBe(2);
    const rewound = await jsonRequest(srv.baseUrl, "/api/b/run.compose/rewind", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, toMessageId: doomed.id, mode: "at" },
    });
    expect(rewound.status).toBe(200);
    const withdrawnEventId = (rewound.body as { data: { eventId: string } }).data.eventId;
    expect(historyTurns((await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie })).body)).toBe(1);

    // THE RECORD IS REACHABLE — the read that makes the withdrawal
    // inspectable rather than merely recoverable in principle.
    const listUrl = `/api/b/run.withdrawn?chatId=${encodeURIComponent(chat.id)}`;
    const listed = (await jsonRequest(srv.baseUrl, listUrl, { cookie: admin.cookie })).body as {
      data: { stretches: Array<{ eventId: string; restored: boolean; messageIds: string[] }> };
    };
    expect(listed.data.stretches.map((x) => x.eventId)).toEqual([withdrawnEventId]);
    expect(listed.data.stretches[0]!.restored).toBe(false);

    // THE VERB.
    const restored = await jsonRequest(srv.baseUrl, "/api/b/run.compose/restore", {
      method: "POST",
      cookie: admin.cookie,
      body: { chatId: chat.id, eventId: withdrawnEventId },
    });
    expect(restored.status).toBe(200);
    expect((restored.body as { data: { restored: number } }).data.restored).toBe(2);

    // THE THING IT CLAIMS TO DO: the same assembly the run path performs
    // carries the turns again.
    expect(historyTurns((await jsonRequest(srv.baseUrl, composeUrl, { cookie: admin.cookie })).body)).toBe(2);

    // …and the withdrawal is still in the record, marked as taken back — an
    // undo that erased its own trace would be the erasure this design refuses.
    const after = (await jsonRequest(srv.baseUrl, listUrl, { cookie: admin.cookie })).body as {
      data: { stretches: Array<{ eventId: string; restored: boolean }> };
    };
    expect(after.data.stretches.map((x) => x.eventId)).toEqual([withdrawnEventId]);
    expect(after.data.stretches[0]!.restored).toBe(true);
  });

  // ── COCKPIT: tools.breaker (set / arm / reset) ───────────────────────────

  test("tools.breaker set/arm/reset drive the store the run boundary consults — and the boundary sees the flip, trips once per streak", async () => {
    COVERED.add("tools.breaker/set");
    COVERED.add("tools.breaker/arm");
    COVERED.add("tools.breaker/reset");
    const chat = srv.db.createChat({ project_id: projectId, title: "breaker-proof" }, admin.userId);
    const breakerUrl = `/api/b/tools.breaker?chatId=${encodeURIComponent(chat.id)}`;
    type Rows = { data: { id: string; description: string; state: string; calls: number; tripAfterFailures?: number }[] };
    const rowOf = (body: unknown, id: string) => (body as Rows).data.find((r) => r.id === id)!;

    const list = await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie });
    expect(list.status).toBe(200);
    const target = (list.body as Rows).data.find((r) => r.state === "on");
    expect(target, "no enabled built-in tool to prove the breaker on").toBeDefined();
    const tool = target!.id;
    const boundaryArgs = () => ({
      db: srv.adb,
      userId: admin.userId,
      consecutiveFailures: new Map<string, number>(),
      tripsFired: new Map<string, number>(),
    });
    // The run loop's own boundary function currently offers the tool.
    const offered = (await honorToolBoundary(boundaryArgs())).definitions;
    expect(offered.map((d) => d.function.name)).toContain(tool);
    expect(target!.description.length).toBeGreaterThan(0);
    expect(target!.description).toBe(offered.find((d) => d.function.name === tool)!.function.description);

    // SET off (next-boundary) → the row flips in the SAME store the gate and
    // the loop read, and the next boundary no longer offers the tool.
    const off = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool, on: false, at: "next-boundary" },
    });
    expect(off.status).toBe(200);
    expect((off.body as { data: { effectiveAt: string } }).data.effectiveAt).toBe("next-boundary");
    expect(srv.db.listToolSettings(admin.userId).find((r) => r.tool_name === tool)?.enabled).toBe(false);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("off");
    expect((await honorToolBoundary(boundaryArgs())).definitions.map((d) => d.function.name)).not.toContain(tool);

    // SET on → restored at the next boundary.
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool, on: true, at: "next-boundary" },
    });
    expect((await honorToolBoundary(boundaryArgs())).definitions.map((d) => d.function.name)).toContain(tool);
    // A rejected landing point is refused at the door (only next-boundary exists).
    const badAt = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool, on: false, at: "now" },
    });
    expect(badAt.status).toBe(400);

    // ARM at 2 failures → the read shows the threshold.
    const arm = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/arm", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool, tripAfterFailures: 2 },
    });
    expect(arm.status).toBe(200);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).tripAfterFailures).toBe(2);

    // ONE failure: below threshold — the boundary must NOT trip.
    const tripsFired = new Map<string, number>();
    const one = await honorToolBoundary({ db: srv.adb, userId: admin.userId, consecutiveFailures: new Map([[tool, 1]]), tripsFired });
    expect(one.trips).toEqual([]);
    // TWO consecutive failures: the boundary trips the breaker off, records
    // it, and the read now says "tripped".
    const two = await honorToolBoundary({ db: srv.adb, userId: admin.userId, consecutiveFailures: new Map([[tool, 2]]), tripsFired });
    expect(two.trips).toEqual([{ tool, failures: 2, threshold: 2 }]);
    expect(two.definitions.map((d) => d.function.name)).not.toContain(tool);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");
    // The trip is a recorded, denied event with the real actor's boundary.
    const tripEvents = getTimelineQuery()
      .byEventType("permission", { ascending: false, limit: 50 })
      .events.filter((e) => e.description.startsWith(`breaker:tripped:${tool}`));
    expect(tripEvents.length).toBeGreaterThanOrEqual(1);
    expect(tripEvents[0]!.outcome).toBe("denied");
    // The SAME streak does not trip twice (idempotent per failure count)…
    const again = await honorToolBoundary({ db: srv.adb, userId: admin.userId, consecutiveFailures: new Map([[tool, 2]]), tripsFired });
    expect(again.trips).toEqual([]);

    // RESET → back on at the next boundary, threshold retained, and the same
    // streak count does not instantly re-trip after an explicit reset.
    const reset = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool },
    });
    expect(reset.status).toBe(200);
    const afterReset = rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool);
    expect(afterReset.state).toBe("on");
    expect(afterReset.tripAfterFailures).toBe(2);
    const postReset = await honorToolBoundary({ db: srv.adb, userId: admin.userId, consecutiveFailures: new Map([[tool, 2]]), tripsFired });
    expect(postReset.trips).toEqual([]);
    expect(postReset.definitions.map((d) => d.function.name)).toContain(tool);
    // …but a NEW failure (count 3) trips again.
    const three = await honorToolBoundary({ db: srv.adb, userId: admin.userId, consecutiveFailures: new Map([[tool, 3]]), tripsFired });
    expect(three.trips).toEqual([{ tool, failures: 3, threshold: 2 }]);

    // DISARM — the way back from `arm` (UIE-008: the threshold used to be
    // write-only; reset and the flip both preserve it on purpose, so nothing
    // could ever remove it). Disarm removes the threshold and nothing else:
    // the on/off state stands, and the boundary stops tripping no matter how
    // many failures stack up.
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", { method: "POST", cookie: admin.cookie, body: { tool } });
    const disarm = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/disarm", {
      method: "POST",
      cookie: admin.cookie,
      body: { tool },
    });
    COVERED.add("tools.breaker/disarm");
    expect(disarm.status).toBe(200);
    const afterDisarm = rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool);
    expect(afterDisarm.state).toBe("on");
    expect(afterDisarm.tripAfterFailures).toBeUndefined();
    const noTrip = await honorToolBoundary({
      db: srv.adb,
      userId: admin.userId,
      consecutiveFailures: new Map([[tool, 99]]),
      tripsFired: new Map<string, number>(),
    });
    expect(noTrip.trips).toEqual([]);
    expect(noTrip.definitions.map((d) => d.function.name)).toContain(tool);

    // Restore for later suites: reset clears the trip and re-enables.
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", { method: "POST", cookie: admin.cookie, body: { tool } });
  });

  test("the breaker read serves a row for EVERY manifest tool — deny-by-default over the registry, both categories", async () => {
    // The gate auto-trips MCP tools exactly as it trips built-ins (the live
    // drive tripped mcp__filesystem__read_text_file at 6 identical blocks),
    // and the trip's sentence promises "the user can re-enable it from the
    // breaker panel" — a row source that stops at the built-in boundary
    // makes that exit a dead door for the whole MCP family. The panel's rows
    // derive from the account states over the manifest, so EVERY manifest
    // entry must appear as a row, whatever its category (dynamic over the
    // registry — a new tool family added tomorrow is covered the day it
    // registers, never by a hand list).
    const { getToolManifest, invalidateToolManifestCache } = await import("../../server/tools/tools-bridge.ts");
    invalidateToolManifestCache();
    const manifest = getToolManifest();
    expect(manifest.length).toBeGreaterThan(0);
    const chat = srv.db.createChat({ project_id: projectId, title: "breaker-rows-proof" }, admin.userId);
    const breakerUrl = `/api/b/tools.breaker?chatId=${encodeURIComponent(chat.id)}`;
    type Rows = { data: { id: string; state: string }[] };
    const read = await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie });
    expect(read.status).toBe(200);
    const rows = new Set((read.body as Rows).data.map((r) => r.id));
    const missing = manifest.filter((t) => !rows.has(t.name)).map((t) => `${t.name} (${t.category})`);
    expect(
      missing,
      "every gated tool is a row the gate's own refusal can point back to — these have none",
    ).toEqual([]);
    // And the verbs' door agrees: the category refusal is gone, so a
    // non-built-in entry flips through the SAME next-boundary contract.
    const mcpEntry = manifest.find((t) => t.category === "mcp");
    if (mcpEntry !== undefined) {
      const off = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { tool: mcpEntry.name, on: false, at: "next-boundary" },
      });
      expect(off.status, "the same verbs, the same contract, whatever the category").toBe(200);
      const back = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { tool: mcpEntry.name, on: true, at: "next-boundary" },
      });
      expect(back.status).toBe(200);
    }
  });

  test("a GATE auto-trip routes through the breaker owner — the panel shows it, the run end reverts it, the panel re-arm beats the revert", async () => {
    // The safety gate trips a tool after a streak of identical blocked
    // calls (the run loop calls tripToolBreaker with the gate's count).
    // The SAME owner as the boundary's armed trip answers: the row flip the
    // panel reads, the permission event, the reset action's re-arm — no
    // parallel breaker. The trip's lifetime is the run: revertGateAutoTrips
    // restores the row at run end, keyed on the marker's own runId.
    const chat = srv.db.createChat({ project_id: projectId, title: "gate-auto-trip-proof" }, admin.userId);
    const breakerUrl = `/api/b/tools.breaker?chatId=${encodeURIComponent(chat.id)}`;
    type Rows = { data: { id: string; state: string; tripAfterFailures?: number }[] };
    const rowOf = (body: unknown, id: string) => (body as Rows).data.find((r) => r.id === id)!;
    const list = await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie });
    const target = (list.body as Rows).data.find((r) => r.state === "on");
    expect(target, "no enabled built-in tool to trip").toBeDefined();
    const tool = target!.id;
    const runId = `gate-trip-run-${randomUUID().slice(0, 8)}`;

    // ARM the user threshold too, so the arm survives both the trip and the
    // revert (the user's own policy is not collateral of either).
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/arm", {
      method: "POST", cookie: admin.cookie, body: { tool, tripAfterFailures: 9 },
    });

    // THE TRIP: the run loop's call shape — the gate's count, the run's id.
    const tripped = await tripToolBreaker({
      db: srv.adb, userId: admin.userId, tool, failures: 6, autoRunId: runId,
    });
    expect(tripped, "a manifest tool that was on must trip").not.toBeNull();
    // The PANEL read shows the tool tripped — the same state the UI reads.
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");
    // The trip is a recorded, denied permission event with the gate's words.
    const tripEvents = getTimelineQuery()
      .byEventType("permission", { ascending: false, limit: 20 })
      .events.filter((e) => e.description === `breaker:tripped:${tool} — 6 consecutive identical blocked calls (gate auto-trip)`);
    expect(tripEvents.length).toBeGreaterThanOrEqual(1);
    expect(tripEvents[0]!.outcome).toBe("denied");
    // The boundary no longer offers the tripped tool.
    expect((await honorToolBoundary({
      db: srv.adb, userId: admin.userId,
      consecutiveFailures: new Map<string, number>(), tripsFired: new Map<string, number>(),
    })).definitions.map((d) => d.function.name)).not.toContain(tool);

    // THE RUN-END REVERT: keyed on the marker's OWN runId — the row comes
    // back on, the user's ARM survives, and the panel agrees.
    const reverted = await revertGateAutoTrips(srv.adb, admin.userId, runId);
    expect(reverted).toEqual([tool]);
    const afterRevert = rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool);
    expect(afterRevert.state).toBe("on");
    expect(afterRevert.tripAfterFailures).toBe(9);
    // A SECOND revert for the same run is a no-op (the marker is gone).
    expect(await revertGateAutoTrips(srv.adb, admin.userId, runId)).toEqual([]);

    // THE MANUAL RE-ARM BEATS THE REVERT: trip again, then the user resets
    // from the panel (the re-arm the terminal message promises), then the
    // run-end revert finds no auto marker and leaves the user's state on.
    await tripToolBreaker({ db: srv.adb, userId: admin.userId, tool, failures: 6, autoRunId: runId });
    const reset = await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", {
      method: "POST", cookie: admin.cookie, body: { tool },
    });
    expect(reset.status).toBe(200);
    expect(await revertGateAutoTrips(srv.adb, admin.userId, runId)).toEqual([]);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("on");

    // A USER-ARMED TRIP IS NOT REVERTED: the boundary's own trip stamps no
    // auto marker, so a gate revert for any run leaves it standing until
    // the panel's reset (the user's policy keeps its until-reset lifetime).
    const tripsFired = new Map<string, number>();
    await honorToolBoundary({
      db: srv.adb, userId: admin.userId,
      consecutiveFailures: new Map([[tool, 9]]), tripsFired,
    });
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");
    expect(await revertGateAutoTrips(srv.adb, admin.userId, runId)).toEqual([]);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");

    // A HALLUCINATED name has no breaker row to flip — the gate's refusal
    // is the whole remedy there, and the owner says so (null, no row).
    expect(await tripToolBreaker({
      db: srv.adb, userId: admin.userId, tool: `no_such_tool_${randomUUID().slice(0, 6)}`,
      failures: 6, autoRunId: runId,
    })).toBeNull();

    // Restore for later suites.
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", { method: "POST", cookie: admin.cookie, body: { tool } });
  });

  test("a GATE auto-trip must NOT re-stamp a USER-ARMED trip — no auto marker, no trip event, and the run-end revert no-ops (the user's until-reset trip persists)", async () => {
    // THE MARKER RE-STAMP. The user armed a threshold and the
    // boundary tripped it: the marker carries the user's facts and an
    // until-manual-reset lifetime. A gate auto-trip of the SAME tool
    // within a run used to re-stamp the marker with `auto` + `runId` —
    // handing the run-end revert a trip it now considered its own, which
    // flipped the tool back on and ended the user's trip early. The
    // marker rule: the user's trip is the stronger state (it already
    // refuses everything; the gate's streak work is moot), so the gate
    // auto-trip must not write at all.
    const chat = srv.db.createChat({ project_id: projectId, title: "user-trip-beats-gate" }, admin.userId);
    const breakerUrl = `/api/b/tools.breaker?chatId=${encodeURIComponent(chat.id)}`;
    type Rows = { data: { id: string; state: string; tripAfterFailures?: number }[] };
    const rowOf = (body: unknown, id: string) => (body as Rows).data.find((r) => r.id === id)!;
    const list = await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie });
    const target = (list.body as Rows).data.find((r) => r.state === "on");
    expect(target, "no enabled built-in tool to prove the marker rule on").toBeDefined();
    const tool = target!.id;
    const runId = `gate-over-user-${randomUUID().slice(0, 8)}`;
    const storedMarker = () =>
      breakerConfigOf(srv.db.listToolSettings(admin.userId).find((r) => r.tool_name === tool)).tripped;
    const gateTripEvents = () =>
      getTimelineQuery()
        .byEventType("permission", { ascending: false, limit: 50 })
        .events.filter((e) => e.description === `breaker:tripped:${tool} — 6 consecutive identical blocked calls (gate auto-trip)`);

    // The USER-ARMED trip: arm at 2, then let the boundary's armed check
    // fire at 2 — the marker is the user's own (no auto provenance).
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/arm", {
      method: "POST", cookie: admin.cookie, body: { tool, tripAfterFailures: 2 },
    });
    const tripsFired = new Map<string, number>();
    const userTrip = await honorToolBoundary({
      db: srv.adb, userId: admin.userId,
      consecutiveFailures: new Map([[tool, 2]]), tripsFired,
    });
    expect(userTrip.trips).toEqual([{ tool, failures: 2, threshold: 2 }]);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");
    const userMarker = storedMarker();
    expect(userMarker, "the boundary's trip stamps the marker").toBeDefined();
    expect(userMarker!.auto, "a user-armed trip carries no auto provenance").toBeUndefined();
    expect(userMarker!.failures).toBe(2);
    const eventsBeforeGate = gateTripEvents().length;

    // THE GATE AUTO-TRIP of the same tool within the run: it must be
    // REFUSED — no re-stamp (the marker keeps the user's facts), no auto
    // marker, and no gate-trip ledger event.
    expect(await tripToolBreaker({
      db: srv.adb, userId: admin.userId, tool, failures: 6, autoRunId: runId,
    }), "the gate auto-trip must not adopt a user-armed trip").toBeNull();
    const afterGate = storedMarker();
    expect(afterGate, "the user's marker survives the gate auto-trip").toBeDefined();
    expect(afterGate!.auto, "the marker must not gain the auto provenance").toBeUndefined();
    expect(afterGate!.runId, "the marker must not gain the gate's runId").toBeUndefined();
    expect(afterGate!.failures, "the marker must keep the user's trip facts, not the gate's count").toBe(2);
    expect(afterGate!.atMs, "the marker must not be re-stamped").toBe(userMarker!.atMs);
    expect(gateTripEvents().length, "a refused gate auto-trip records no trip event").toBe(eventsBeforeGate);

    // THE RUN-END REVERT no-ops: the marker is not the run's to revert, so
    // the user's until-reset trip keeps standing (the early-end bug).
    expect(await revertGateAutoTrips(srv.adb, admin.userId, runId)).toEqual([]);
    expect(rowOf((await jsonRequest(srv.baseUrl, breakerUrl, { cookie: admin.cookie })).body, tool).state).toBe("tripped");

    // Restore for later suites.
    await jsonRequest(srv.baseUrl, "/api/b/tools.breaker/reset", { method: "POST", cookie: admin.cookie, body: { tool } });
  });

  // ── COCKPIT: arm.flags (set / capture / clear) ───────────────────────────

  test("arm.flags set/capture/clear store, list and tombstone real flags — bad predicates are refused at the door", async () => {
    COVERED.add("arm.flags/set");
    COVERED.add("arm.flags/capture");
    COVERED.add("arm.flags/clear");
    const readUrl = "/api/b/arm.flags";
    type Flags = { data: { flags: { id: string; kind: string; label?: string }[]; serverSideFiring: boolean } };
    const idsOf = (body: unknown) => (body as Flags).data.flags.map((f) => f.id);

    // SET a trigger over the declared vocabulary.
    const set = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/set", {
      method: "POST",
      cookie: admin.cookie,
      body: { predicate: "event.type == 'tool' && tool.failed", label: "any tool errors" },
    });
    expect(set.status).toBe(200);
    const triggerId = (set.body as { data: { id: string } }).data.id;
    // CAPTURE a range.
    const capture = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/capture", {
      method: "POST",
      cookie: admin.cookie,
      body: { t0: 1_000_000, t1: 2_000_000, label: "the interesting minute" },
    });
    expect(capture.status).toBe(200);
    const rangeId = (capture.body as { data: { id: string } }).data.id;

    const listed = await jsonRequest(srv.baseUrl, readUrl, { cookie: admin.cookie });
    expect(listed.status).toBe(200);
    expect(idsOf(listed.body)).toEqual(expect.arrayContaining([triggerId, rangeId]));
    // The read never claims the server watches these.
    expect((listed.body as Flags).data.serverSideFiring).toBe(false);

    // DENY-BY-DEFAULT, and refusal changes nothing. A predicate outside the
    // ambient vocabulary and one that will not parse are both DESIGNED
    // value refusals (UIE-085): the body parsed and the block schema passed —
    // the expression is the user's answer the contract declines — so they
    // answer 200 with the refusal envelope (typed code + the server's own
    // sentence + the guided 428 status), never a raw 4xx the browser would
    // log as a console error on a designed path.
    for (const predicate of ["database.rows > 0", "event.type =="]) {
      const bad = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/set", {
        method: "POST",
        cookie: admin.cookie,
        body: { predicate },
      });
      expect(bad.status, `predicate "${predicate}" must be refused in the 200 envelope`).toBe(200);
      const refusal = (bad.body as { refusal?: { code?: string; message?: string; status?: number } }).refusal;
      expect(refusal?.code).toBe("invalid_arm_predicate");
      expect(refusal?.status).toBe(428);
      expect(typeof refusal?.message).toBe("string");
      expect(refusal?.message!.length).toBeGreaterThan(0);
    }
    const inverted = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/capture", {
      method: "POST",
      cookie: admin.cookie,
      body: { t0: 5, t1: 4, label: "backwards" },
    });
    // The malformed-BODY line keeps its raw 400: a request the block's own
    // schema refuses never performed work and is a real failure, not a
    // designed answer.
    expect(inverted.status).toBe(400);
    expect(idsOf((await jsonRequest(srv.baseUrl, readUrl, { cookie: admin.cookie })).body)).toHaveLength(2);

    // Another user sees NOTHING and cannot clear the admin's flag (404 hides
    // existence); the flag survives the attempt.
    const rival = createTestUser(srv.db, "arm-rival");
    expect(idsOf((await jsonRequest(srv.baseUrl, readUrl, { cookie: rival.cookie })).body)).toHaveLength(0);
    const stolen = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/clear", {
      method: "POST",
      cookie: rival.cookie,
      body: { id: triggerId },
    });
    expect(stolen.status).toBe(404);
    expect(idsOf((await jsonRequest(srv.baseUrl, readUrl, { cookie: admin.cookie })).body)).toContain(triggerId);

    // CLEAR both (the restore) — the list is empty again, by tombstone.
    const beforeClear = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    for (const id of [triggerId, rangeId]) {
      const cleared = await jsonRequest(srv.baseUrl, "/api/b/arm.flags/clear", {
        method: "POST",
        cookie: admin.cookie,
        body: { id },
      });
      expect(cleared.status).toBe(200);
    }
    expect(idsOf((await jsonRequest(srv.baseUrl, readUrl, { cookie: admin.cookie })).body)).toHaveLength(0);
    // The `until` bound (the planted-head convention): read AS OF the instant
    // before the clears and both flags are visible again — the tombstones lie
    // beyond the bound, and nothing was ever deleted.
    const asOf = await jsonRequest(srv.baseUrl, `${readUrl}?until=${beforeClear}`, { cookie: admin.cookie });
    expect(asOf.status).toBe(200);
    expect(idsOf(asOf.body)).toEqual(expect.arrayContaining([triggerId, rangeId]));
  });

  // ── COCKPIT: custody.state (keep / undo) — §7 git as verbs ───────────────

  test("custody.state keep really commits and undo really restores — measured, recorded, denied by default", async () => {
    COVERED.add("custody.state/keep");
    COVERED.add("custody.state/undo");
    // A REAL repository project with hand-countable edits.
    const repo = createTempGitRepo("ch-block-actions-custody-", { initialBranch: "main" });
    const repoPath = repo.dir;
    const g = (...args: string[]) => repo.git(...args).trim();
    writeFileSync(join(repoPath, "kept.ts"), "a\nb\n");
    writeFileSync(join(repoPath, "undone.ts"), "one\ntwo\n");
    g("add", ".");
    g("commit", "-m", "base");
    const custProject = srv.db.createProject({ name: "custody-proof", path: repoPath }, admin.userId);
    const chat = srv.db.createChat({ project_id: custProject.id, title: "custody proof chat" }, admin.userId);
    srv.db.createMessage(
      { chat_id: chat.id, role: "user", content: "refactor the kept module", run_id: "run-cust-1" },
      admin.userId,
    );

    // The producing edit: change both files; record the attributed effect for
    // kept.ts exactly the way the editor bridge records one (absolute path +
    // run correlation). undone.ts gets NO record — the outside bucket.
    writeFileSync(join(repoPath, "kept.ts"), "a\nb2\nc\n"); // +2 −1 vs base
    writeFileSync(join(repoPath, "undone.ts"), "one\nCHANGED\ntwo\nthree\n"); // +2 −0
    getTimelineRecorder().recordFileEffect({
      effectId: "cust-proof-1",
      path: join(repoPath, "kept.ts"),
      operation: "write",
      preimageDigest: "0".repeat(64),
      postimageDigest: "1".repeat(64),
      description: `write ${join(repoPath, "kept.ts")}`,
      correlation: { runId: "run-cust-1" },
    });

    // READ — the join: kept.ts under the producing conversation with the
    // request's own words; undone.ts in the honest outside bucket, LAST.
    const stateUrl = `/api/b/custody.state?projectId=${encodeURIComponent(custProject.id)}`;
    type State = {
      data: {
        repository: boolean;
        parcels: {
          id: string;
          attribution: Record<string, unknown>;
          files: { path: string; insertions: number | null; deletions: number | null }[];
        }[];
      };
    };
    const state = await jsonRequest(srv.baseUrl, stateUrl, { cookie: admin.cookie });
    expect(state.status).toBe(200);
    const parcels = (state.body as State).data.parcels;
    const conv = parcels.find((p) => p.id === "run-cust-1");
    expect(conv, "the producing run's parcel is missing — the ledger join is dead").toBeDefined();
    expect(conv!.attribution).toMatchObject({
      kind: "conversation",
      chatId: chat.id,
      chatTitle: "custody proof chat",
      turn: 1,
      requestText: "refactor the kept module",
    });
    expect(conv!.files.map((f) => f.path)).toEqual(["kept.ts"]);
    const bucket = parcels[parcels.length - 1]!;
    expect(bucket.id).toBe("outside");
    expect(bucket.files.map((f) => f.path)).toContain("undone.ts");

    // KEEP — a real commit of exactly kept.ts, proven against the repo itself.
    const headBefore = g("rev-parse", "HEAD");
    const keep = await jsonRequest(srv.baseUrl, "/api/b/custody.state/keep", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: custProject.id, files: ["kept.ts"], message: "keep the kept module" },
    });
    expect(keep.status).toBe(200);
    const kept = (keep.body as {
      data: { kept: boolean; hash: string; files: string[]; insertions: number; deletions: number; stillChanged: string[] };
    }).data;
    expect(kept.kept).toBe(true);
    expect(kept.files).toEqual(["kept.ts"]);
    expect({ ins: kept.insertions, del: kept.deletions }).toEqual({ ins: 2, del: 1 });
    expect(kept.stillChanged).toEqual([]);
    expect(g("rev-parse", "HEAD")).toBe(kept.hash);
    expect(kept.hash).not.toBe(headBefore);
    expect(g("log", "-1", "--pretty=%s")).toBe("keep the kept module");
    // Surgical: undone.ts was NOT swept into the save.
    expect(g("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean)).toEqual(["kept.ts"]);

    // The mutating git operations are recorded `git` effects with the actor.
    const gitEvents = () =>
      getTimelineQuery()
        .byEventType("git", { ascending: false, limit: 100 })
        .events.filter((e) => e.actorId === admin.userId);
    expect(gitEvents().some((e) => e.description === "git:add" && e.outcome === "succeeded")).toBe(true);
    expect(gitEvents().some((e) => e.description === "git:commit" && e.outcome === "succeeded")).toBe(true);

    // HISTORY — the fresh save joins to its producing conversation (the
    // recorded effect predates the commit instant); `base` states absence.
    const hist = await jsonRequest(
      srv.baseUrl,
      `/api/b/custody.history?projectId=${encodeURIComponent(custProject.id)}`,
      { cookie: admin.cookie },
    );
    expect(hist.status).toBe(200);
    type Hist = { data: { commits: { hash: string; message: string; conversation: { chatId: string } | null }[] } };
    const commits = (hist.body as Hist).data.commits;
    expect(commits[0]!.hash).toBe(kept.hash);
    expect(commits[0]!.conversation).toMatchObject({ chatId: chat.id });
    expect(commits.find((c) => c.message === "base")!.conversation).toBeNull();

    // UNDO — measured loss returned, file genuinely restored on disk.
    const undo = await jsonRequest(srv.baseUrl, "/api/b/custody.state/undo", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: custProject.id, files: ["undone.ts"] },
    });
    expect(undo.status).toBe(200);
    const undone = (undo.body as { data: { undone: boolean; discarded: { insertions: number; deletions: number } } }).data;
    expect(undone.undone).toBe(true);
    expect(undone.discarded).toEqual({ insertions: 2, deletions: 0 });
    expect(readFileSync(join(repoPath, "undone.ts"), "utf8")).toBe("one\ntwo\n");
    expect(g("status", "--porcelain")).toBe("");
    expect(gitEvents().some((e) => e.description === "git:checkout" && e.outcome === "succeeded")).toBe(true);

    // MUTATION arms — refusal changes nothing:
    // an unchanged file cannot be kept (and the tip does not move)…
    const nothing = await jsonRequest(srv.baseUrl, "/api/b/custody.state/keep", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: custProject.id, files: ["kept.ts"], message: "no-op" },
    });
    expect(nothing.status).toBe(400);
    expect((nothing.body as { error?: string }).error).toBe("custody_file_unchanged");
    expect(g("rev-parse", "HEAD")).toBe(kept.hash);
    // …a NEW file cannot be "undone" into deletion…
    writeFileSync(join(repoPath, "brand-new.ts"), "fresh\n");
    const newUndo = await jsonRequest(srv.baseUrl, "/api/b/custody.state/undo", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: custProject.id, files: ["brand-new.ts"] },
    });
    expect(newUndo.status).toBe(400);
    expect((newUndo.body as { error?: string }).error).toBe("custody_file_new");
    expect(existsSync(join(repoPath, "brand-new.ts"))).toBe(true);
    // …a traversal path is refused at the door…
    const traversal = await jsonRequest(srv.baseUrl, "/api/b/custody.state/undo", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: custProject.id, files: ["../outside.ts"] },
    });
    expect(traversal.status).toBe(400);
    expect((traversal.body as { error?: string }).error).toBe("invalid_custody_file");
    // …and another user cannot even see the project exists.
    const rival = createTestUser(srv.db, "custody-rival");
    const stolen = await jsonRequest(srv.baseUrl, "/api/b/custody.state/keep", {
      method: "POST",
      cookie: rival.cookie,
      body: { projectId: custProject.id, files: ["brand-new.ts"], message: "steal" },
    });
    expect(stolen.status).toBe(404);
    expect(g("rev-parse", "HEAD")).toBe(kept.hash);
  });

  test("ratchet — every declared action has a liveness proof in this file", () => {
    const declared = declaredActions().map((a) => `${a.id}/${a.name}`).sort();
    expect(
      declared,
      "A declared action has no liveness proof. Add a round-trip above that " +
        "shows the handler really does the thing (and add its key to COVERED), " +
        "or do not declare the action — an inert verb is prohibited capability-lying.",
    ).toEqual([...COVERED].sort());
  });
});

describe("E. recording — performing the verb IS recording it", () => {
  test("a successful action lands in the task lane with the real actor and a trace", async () => {
    const events = taskEventsFor(admin.userId).filter(
      (e) => e.description === "action:checks.auto/rerun",
    );
    expect(events.length, "the rerun in class D recorded no task event").toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(e.outcome).toBe("succeeded");
      expect(e.actorKind).toBe("user");
      expect(e.traceId, "an action event without a trace cannot be joined to its work").toBeTruthy();
    }
  });

  test("a failed handler records a failed effect with its error", async () => {
    const res = await jsonRequest(srv.baseUrl, "/api/b/checks.auto/rerun", {
      method: "POST",
      cookie: admin.cookie,
      body: { projectId: "not-a-real-project" },
    });
    expect(res.status).toBe(404);
    await new Promise((r) => setImmediate(r));
    const failed = taskEventsFor(admin.userId).filter(
      (e) => e.description === "action:checks.auto/rerun" && e.outcome === "failed",
    );
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  test("choke point: the action mount wraps handlers in the effect recorder", () => {
    const src = stripCommentsOnly(read(modulePath("define.ts")));
    const mountAt = src.indexOf("export function mountBlockRoutes");
    expect(mountAt).toBeGreaterThan(-1);
    const actionRegion = src.slice(src.indexOf("blockActionPath(", mountAt));
    expect(
      /\brecordEffectAsync\s*\(\s*["']action["']/.test(actionRegion),
      "mountBlockRoutes no longer records actions — unwrapping the recorder " +
        "makes every verb an unexplainable state change",
    ).toBe(true);
  });
});

// (Class F died with FieldCard — the cockpit's verb surfaces carry their
// own declared-words guards in tests/cockpit/desk-verb-owner.test.ts.)
