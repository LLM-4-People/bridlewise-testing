// @vitest-environment node
/**
 * THE DIAGNOSTIC-MODES ARRAY DOOR — the settings room's write path for
 * `performance.diagnosticModes.excludedModes` (the settings.diagnosticModes
 * block), live against a real HTTP server and a test-scoped config file.
 *
 * The served-row grammar holds scalars and JSON objects (the sheet refuses
 * array JSON by design), so the array-valued leaf gets its own block door:
 * a read that serves the engine's own mode vocabulary plus what the file
 * excludes, and one set action that lands the whole list through the ONE
 * config write gate. What this file holds down, each arm a real contract:
 *
 *  1. READ. The vocabulary is the engine's own DIAGNOSTIC_MODE_IDS (derived,
 *     never restated here) and the excluded list is what the file says.
 *     User-level: a session is required (the values-read posture).
 *  2. SET. An admin write lands in the config file at the exact leaf path,
 *     through the gate, and the next read is the server's own read-back.
 *  3. VALUE REFUSALS travel the GUIDED family's envelope (200 + the typed
 *     428 refusal, the sheet's discipline): an undeclared mode names the
 *     offender and the whole legal vocabulary; a list longer than the mode
 *     count says why; a mode named twice is refused by the CONFIG GATE with
 *     the section checker's own round-41 sentence (code beside words). Every
 *     refused write leaves the file byte-identical.
 *  4. AUTH. The write is global harness state: a non-admin session is
 *     refused, the customizations' rule.
 *  5. FRESH INSTALL. A config file with no performance section at all still
 *     serves the read (the declared default) and the write materializes the
 *     section from the performance contract's own defaults.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "../helpers/temp-dir.ts";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";
// Type-only imports are erased at runtime, so they do not disturb the
// config-path env that must be in place before the first server module
// import below.
import type { HttpTestServer } from "../helpers/http-server.ts";

// ── a test-scoped config copy, BEFORE any server module resolves it ────────
// The write path lands in the REAL config path by design — so the test must
// point the whole server at a scratch copy first (the mcp-servers-route
// scoping). The real config is never touched by these arms.
const REAL_CONFIG = fileURLToPath(new URL("../../engine/bridlewise.config.json", import.meta.url));
const scratch = createTempDir("settings-diagnostic-modes-block-");
const configPath = join(scratch, "bridlewise.config.json");

function seedConfig(withPerformanceSection: boolean): void {
  const base = JSON.parse(readFileSync(REAL_CONFIG, "utf8")) as Record<string, unknown>;
  if (!withPerformanceSection) delete base["performance"];
  plantSettingsDocument(configPath, JSON.stringify(base));
}

function configBytes(): string {
  return readFileSync(configPath, "utf8");
}

/** The excluded list as the scratch FILE holds it, read straight from disk. */
function fileExcluded(): unknown {
  const doc = JSON.parse(configBytes()) as {
    performance?: { diagnosticModes?: { excludedModes?: unknown } };
  };
  return doc.performance?.diagnosticModes?.excludedModes;
}

process.env["HARNESS_CONFIG_PATH"] = configPath;

let startHttpTestServer: (typeof import("../helpers/http-server.ts"))["startHttpTestServer"];
let defineSettingsBlocks: (typeof import("../../server/blocks/settings.ts"))["defineSettingsBlocks"];
let DIAGNOSTIC_MODES_CONFIG_PATH: (typeof import("../../server/blocks/settings.ts"))["DIAGNOSTIC_MODES_CONFIG_PATH"];
let mountBlockRoutes: (typeof import("../../server/blocks/define.ts"))["mountBlockRoutes"];
let DIAGNOSTIC_MODE_IDS: (typeof import("../../engine/src/performance/performance-config.ts"))["DIAGNOSTIC_MODE_IDS"];
let registerAuthRoutes: (typeof import("../../server/routes/auth.ts"))["registerAuthRoutes"];
let createTestUser: (typeof import("../helpers/multi-user.ts"))["createTestUser"];
let jsonRequest: (typeof import("../helpers/json-request.ts"))["jsonRequest"];

let srv: HttpTestServer;
let adminCookie: string;
let plainCookie: string;

// The block paths — derived by the same shared owner the client consumes,
// never restated strings.
let READ_PATH: string;
let SET_PATH: string;

async function req(
  method: string,
  path: string,
  body?: unknown,
  cookie = adminCookie,
): Promise<{ status: number; json: unknown }> {
  const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, body, cookie });
  return { status, json };
}

beforeAll(async () => {
  ({ startHttpTestServer } = await import("../helpers/http-server.ts"));
  ({ defineSettingsBlocks, DIAGNOSTIC_MODES_CONFIG_PATH } = await import("../../server/blocks/settings.ts"));
  ({ mountBlockRoutes } = await import("../../server/blocks/define.ts"));
  ({ DIAGNOSTIC_MODE_IDS } = await import("../../engine/src/performance/performance-config.ts"));
  ({ registerAuthRoutes } = await import("../../server/routes/auth.ts"));
  ({ createTestUser } = await import("../helpers/multi-user.ts"));
  ({ jsonRequest } = await import("../helpers/json-request.ts"));
  const { blockReadPath, blockActionPath } = await import("../../shared/block-contract.ts");
  READ_PATH = blockReadPath("settings.diagnosticModes");
  SET_PATH = blockActionPath("settings.diagnosticModes", "set");

  seedConfig(true);
  srv = await startHttpTestServer({
    prefix: "settings-diagnostic-modes-block-",
    register: (router, _db, adb) => {
      registerAuthRoutes(router, adb);
      defineSettingsBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  // The FIRST user on the fresh DB is the admin; the second is a regular
  // user — production's own rule, so the privilege arm is real.
  const admin = createTestUser(srv.db, "diag-admin");
  adminCookie = admin.cookie;
  const plain = createTestUser(srv.db, "diag-plain");
  plainCookie = plain.cookie;
});

afterAll(async () => {
  if (srv) await srv.stop();
});

beforeEach(() => {
  // Every arm starts from the same seeded config — no order dependence.
  seedConfig(true);
});

/** The typed refusal an arm expects to find in the 200 envelope. */
function refusalOf(json: unknown): { code?: unknown; message?: unknown; status?: unknown } {
  const body = json as { refusal?: { code?: unknown; message?: unknown; status?: unknown } };
  return body?.refusal ?? {};
}

describe("the settings.diagnosticModes block — the array leaf's own door", () => {
  test("the config path the census reads is the leaf the schema declares", async () => {
    // The block's exported declaration and the engine's own schema must name
    // the SAME leaf — the door cannot serve a path the contract does not own.
    const { PERFORMANCE_CONFIG_SCHEMA } = await import("../../engine/src/performance/performance-config.ts");
    expect(PERFORMANCE_CONFIG_SCHEMA.shape.diagnosticModes.shape.excludedModes).toBeDefined();
    expect(DIAGNOSTIC_MODES_CONFIG_PATH).toBe("performance.diagnosticModes.excludedModes");
  });

  test("no session → 401 (the values-read posture)", async () => {
    const res = await req("GET", READ_PATH, undefined, "");
    expect(res.status).toBe(401);
  });

  test("the read serves the engine's own vocabulary and what the file excludes", async () => {
    const res = await req("GET", READ_PATH);
    expect(res.status).toBe(200);
    const data = (res.json as { data?: { modes?: unknown; excluded?: unknown } }).data ?? {};
    expect(data.modes).toEqual([...DIAGNOSTIC_MODE_IDS]);
    // The seeded real config carries the default: nothing excluded.
    expect(data.excluded).toEqual([]);
  });

  test("an admin write lands in the config file at the exact leaf, and the read reads it back", async () => {
    const before = configBytes();
    const excluded = [DIAGNOSTIC_MODE_IDS[0], DIAGNOSTIC_MODE_IDS[3]];
    const res = await req("POST", SET_PATH, { excludedModes: excluded });
    expect(res.status).toBe(200);
    expect((res.json as { data?: { excludedModes?: unknown } }).data?.excludedModes).toEqual(excluded);
    // The FILE carries the list at the leaf path — the write went through
    // the one config gate, not a parallel store.
    expect(fileExcluded()).toEqual(excluded);
    expect(configBytes()).not.toBe(before);
    // And the read-back is the server's own answer.
    const readBack = await req("GET", READ_PATH);
    const data = (readBack.json as { data?: { excluded?: unknown } }).data ?? {};
    expect(data.excluded).toEqual(excluded);
    // Restore: the default list (empty) writes back and the file returns to
    // its seeded shape at the leaf.
    const restore = await req("POST", SET_PATH, { excludedModes: [] });
    expect(restore.status).toBe(200);
    expect(fileExcluded()).toEqual([]);
  });

  test("a same-value write leaves the file byte-identical (no door reorders a no-op)", async () => {
    // The byte-identity rule the whole apparatus leans on: a write that
    // changes no value must change no byte. The baseline is taken AFTER one
    // canonical write (the gate's own serialization — a first write also
    // normalizes a non-canonical seed, which is the gate reformatting, not
    // a reorder); re-sending the list the file already holds must then
    // leave the bytes identical (the drive-16 reorder class: a
    // value-identical write that was not byte-identical).
    const mode = DIAGNOSTIC_MODE_IDS[0];
    const first = await req("POST", SET_PATH, { excludedModes: [mode] });
    expect(first.status).toBe(200);
    const afterFirst = configBytes();
    expect(fileExcluded()).toEqual([mode]);
    const again = await req("POST", SET_PATH, { excludedModes: [mode] });
    expect(again.status).toBe(200);
    expect(configBytes()).toBe(afterFirst);

    const toEmpty = await req("POST", SET_PATH, { excludedModes: [] });
    expect(toEmpty.status).toBe(200);
    const afterEmpty = configBytes();
    expect(fileExcluded()).toEqual([]);
    const emptyAgain = await req("POST", SET_PATH, { excludedModes: [] });
    expect(emptyAgain.status).toBe(200);
    expect(configBytes()).toBe(afterEmpty);
  });

  test("an undeclared mode is a guided refusal naming the offender and the vocabulary — and nothing lands", async () => {
    const before = configBytes();
    const res = await req("POST", SET_PATH, { excludedModes: ["cpu", "kernel-panic"] }, adminCookie);
    // The guided family: the refusal travels in the 200 envelope.
    expect(res.status).toBe(200);
    const refusal = refusalOf(res.json);
    expect(refusal.code).toBe("invalid_customization_value");
    expect(refusal.status).toBe(428);
    expect(refusal.message).toContain('"kernel-panic" is not one of the declared diagnostic modes');
    expect(refusal.message).toContain(DIAGNOSTIC_MODE_IDS.join(", "));
    expect(fileExcluded()).toEqual([]);
    expect(configBytes()).toBe(before);
  });

  test("a mode named twice is refused by the CONFIG GATE with the section checker's own sentence", async () => {
    const before = configBytes();
    const res = await req("POST", SET_PATH, { excludedModes: ["cpu", "cpu"] });
    expect(res.status).toBe(200);
    const refusal = refusalOf(res.json);
    expect(refusal.code).toBe("invalid_customization_value");
    // The machine identity rides beside the sentence (the round-41 contract).
    expect(refusal.message).toContain("performance_config_diagnostic_modes_not_unique");
    expect(refusal.message).toContain("names the same mode more than once");
    expect(refusal.message).toContain("each mode may be excluded only once");
    expect(configBytes()).toBe(before);
  });

  test("a list longer than the mode count is a guided refusal that says why", async () => {
    const before = configBytes();
    const res = await req("POST", SET_PATH, {
      excludedModes: [...DIAGNOSTIC_MODE_IDS, DIAGNOSTIC_MODE_IDS[0]],
    });
    expect(res.status).toBe(200);
    const refusal = refusalOf(res.json);
    expect(refusal.message).toContain(`the list holds ${DIAGNOSTIC_MODE_IDS.length + 1} modes`);
    expect(configBytes()).toBe(before);
  });

  test("a non-admin session is refused on the write — global harness state, the customizations' rule", async () => {
    const before = configBytes();
    const res = await req("POST", SET_PATH, { excludedModes: ["cpu"] }, plainCookie);
    expect(res.status).toBe(403);
    expect(configBytes()).toBe(before);
  });

  test("a fresh install — no performance section — reads the declared default and the write materializes the section from the contract's own defaults", async () => {
    seedConfig(false);
    const readBefore = await req("GET", READ_PATH);
    const data = (readBefore.json as { data?: { excluded?: unknown } }).data ?? {};
    expect(data.excluded).toEqual([]);

    const res = await req("POST", SET_PATH, { excludedModes: ["memory"] });
    expect(res.status).toBe(200);
    // The materialized section carries the leaf AND its section siblings
    // from the performance contract's declared defaults — the write gate
    // demands a complete section, so the door builds one, never a stub.
    const doc = JSON.parse(configBytes()) as {
      performance?: { schemaVersion?: unknown; diagnosticModes?: Record<string, unknown> };
    };
    expect(doc.performance?.diagnosticModes?.excludedModes).toEqual(["memory"]);
    expect(typeof doc.performance?.schemaVersion).toBe("string");
    expect(doc.performance?.diagnosticModes?.modeTimeoutMs).toBe(30000);
  });
});

test('the served descriptor agrees with positive inclusion switches and next-run timing',async()=>{
  const {listBlocks,blockActionsManifest}=await import('../../server/blocks/define.ts');
  const descriptor=listBlocks().find(b=>b.descriptor.id==='settings.diagnosticModes')!.descriptor;
  expect(descriptor.description).toContain('Enabled modes are included');
  expect(descriptor.description).toContain('disabled modes are excluded');
  const save=blockActionsManifest()['settings.diagnosticModes']!.find(a=>a.name==='set')!;
  expect(save.consequence).toContain('next diagnostic run');
  expect(save.consequence).toContain('Enabled modes are included');
  expect(save.consequence).toContain('disabled modes are excluded');
  expect(`${descriptor.description} ${save.consequence}`).not.toMatch(/unchecked|checked modes|checked entries/);
});
