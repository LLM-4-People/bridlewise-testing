// @vitest-environment node
/**
 * A SETTINGS FILE THAT GOES BAD WHILE THE REAL SERVER RUNS: NO CRASH, NO HANG.
 *
 * ── The defect (reproduced, wf1c-correctness §2, HIGH) ──
 * Every accessor of the config owner read the file per call and threw
 * `config_unreadable` on a corrupt one. Two consequences in the real server:
 *   - with ONE `/api/live` stream open (every browser tab has one), the
 *     liveness beat's SSE send redacted through the privacy policy, which read
 *     the file: the throw escaped a timer and the process exited;
 *   - with no stream, EVERY request hung (`/api/health` included): the error
 *     mapper redacted its own error body through the same policy, threw, and
 *     no response was ever written; the log filled with
 *     "[debug] diagnostic unavailable" (435 lines in ~5 minutes).
 *
 * ── The rule ──
 * The server resolves ONE settings snapshot (at boot, once per request, and
 * on its own saves); redaction, timers and handlers read the snapshot, never
 * the file. A store that goes bad keeps the last good snapshot in force,
 * refuses saves (`config_unreadable`, 503) and reports the state. The error
 * mapper and the SSE egress door cannot throw.
 *
 * Driven against the REAL server process (`server/index.ts`, its own fatal
 * handlers), with an open `/api/live` stream and concurrent requests.
 */
import { afterAll, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { CSRF_CUSTOM_HEADER } from "../../shared/constants.ts";

const REPO = join(import.meta.dirname, "..", "..");
const SHIPPED_CONFIG = join(REPO, "engine", "bridlewise.config.json");
const KEEPALIVE_MS = 1_000;
const REQUEST_DEADLINE_MS = 15_000;

type Reply = Readonly<{ status: number; body: string; setCookie: readonly string[] }>;

function send(base: string, method: string, path: string, options: { cookie?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(`${base}${path}`, {
      method,
      headers: {
        [CSRF_CUSTOM_HEADER]: "test",
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      timeout: REQUEST_DEADLINE_MS,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers["set-cookie"] ?? [] }));
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path}: no response within ${String(REQUEST_DEADLINE_MS)} ms (a hung request)`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A GET whose Host header the caller spells (the client library would refuse a malformed one). */
function sendWithHost(base: string, path: string, host: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { headers: { host }, timeout: REQUEST_DEADLINE_MS }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: [] }));
    });
    req.on("timeout", () => req.destroy(new Error(`${path} with Host ${host}: no response within ${String(REQUEST_DEADLINE_MS)} ms (a hung request)`)));
    req.on("error", reject);
    req.end();
  });
}

/** An open `/api/live` stream counting the frames it receives. */
function openLive(base: string, cookie: string): { pings: () => number; close: () => void } {
  let pings = 0;
  const req = request(`${base}/api/live`, { headers: { cookie, accept: "text/event-stream" } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { pings += chunk.split("event: ping").length - 1; });
  });
  req.on("error", () => undefined);
  req.end();
  return { pings: () => pings, close: () => req.destroy() };
}

/** One signal's value from `/api/schema/ui/values`. */
function signalValue(body: string, id: string): unknown {
  return (JSON.parse(body) as { signals: Array<{ id: string; value: unknown }> }).signals.find((signal) => signal.id === id)?.value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const children: ChildProcess[] = [];
afterAll(() => { for (const started of children) started.kill("SIGKILL"); });

/**
 * The REAL server (`server/index.ts`, its own fatal handlers) on a private
 * copy of the shipped settings (`adjust` edits the copy first), registered
 * with an admin; the settings file, the base URL, the session cookie and the
 * process's logs so far.
 */
async function startServer(adjust: (document: Record<string, unknown>) => void = () => undefined): Promise<Readonly<{
  root: string; configPath: string; base: string; cookie: string;
  logs: () => Readonly<{ stdout: string; stderr: string }>; exitCode: () => number | null | undefined;
}>> {
  const root = createTempDir("ch-config-server-");
  const configPath = join(root, "bridlewise.config.json");
  const document = JSON.parse(readFileSync(SHIPPED_CONFIG, "utf8")) as Record<string, unknown>;
  adjust(document);
  expect(atomicWriteFile(configPath, `${JSON.stringify(document, null, 2)}\n`, { createMode: 0o600 }).success).toBe(true);
  let stdout = "";
  let stderr = "";
  let exited: number | null | undefined;
  const started = spawn(process.execPath, [join(REPO, "server", "index.ts")], {
    cwd: root,
    env: {
      ...process.env,
      HARNESS_CONFIG_PATH: configPath, HARNESS_WEB_PORT: "0", HARNESS_WEB_SSE_KEEPALIVE_MS: String(KEEPALIVE_MS),
      HARNESS_WEB_DB_PATH: join(root, "web.db"), HARNESS_WEB_TIMELINE_DB_PATH: join(root, "timeline.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(started);
  started.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  started.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  started.on("exit", (code) => { exited = code; });
  for (let i = 0; i < 600 && !/server on http:\/\/\S+/u.test(stdout) && exited === undefined; i += 1) await sleep(100);
  const base = /server on (http:\/\/\S+)/u.exec(stdout)?.[1];
  expect(base, `the server did not start:\n${stderr.slice(-3000)}`).toBeDefined();
  const registered = await send(base!, "POST", "/api/auth/register", { body: { username: "admin", password: "correct-horse-battery" } });
  expect(registered.status, registered.body).toBe(200);
  const cookie = registered.setCookie.map((line) => line.split(";")[0]).join("; ");
  return { root, configPath, base: base!, cookie, logs: () => ({ stdout, stderr }), exitCode: () => exited };
}



describe("the real server with a settings file that goes bad at runtime", () => {
  test("an open /api/live stream and concurrent requests: the server stays up, every request is answered, saves are refused, recovery is seen", async () => {
    const { configPath, base, cookie, logs, exitCode } = await startServer();
    const live = openLive(base, cookie);
    await sleep(KEEPALIVE_MS * 1.5);
    expect(live.pings(), "the stream beats before the file goes bad").toBeGreaterThanOrEqual(1);

    // A half-saved write lands while the stream is open.
    expect(atomicWriteFile(configPath, "{ \"half\": ", { createMode: 0o600 }).success).toBe(true);
    const replies = await Promise.all([
      send(base, "GET", "/api/health"),
      send(base, "GET", "/api/health", { cookie }),
      send(base, "GET", "/api/projects", { cookie }),
      send(base, "GET", "/api/schema/ui/values", { cookie }),
      send(base, "GET", "/api/config", { cookie }),
      send(base, "PUT", "/api/config", { cookie, body: { path: "codeIntelligence.indexWatchDebounceMs", value: 401 } }),
      send(base, "GET", "/api/does-not-exist", { cookie }),
    ]);
    const [health, healthAuthed, projects, values, config, save, missing] = replies;
    expect(health!.status).toBe(200);
    expect(healthAuthed!.status).toBe(200);
    expect(projects!.status, "an ordinary read answers from the last good snapshot").toBe(200);
    expect(values!.status).toBe(200);
    expect(signalValue(values!.body, "settings.storeState"), "the state is published").toBe("unreadable");
    expect(String(signalValue(values!.body, "settings.storeRefusal"))).toContain("config_json_invalid");
    // The settings IN FORCE are shown (the last good), with the store's state and no edit offered.
    const shownWhileCorrupt = JSON.parse(config!.body) as { config: Record<string, unknown>; editable: boolean; storeState: { state: string; reason?: string } };
    expect(config!.status).toBe(200);
    expect(shownWhileCorrupt.storeState.state).toBe("unreadable");
    expect(shownWhileCorrupt.storeState.reason ?? "").toContain("config_json_invalid");
    expect(shownWhileCorrupt.editable).toBe(false);
    expect(Object.keys(shownWhileCorrupt.config).length, "the last good document is shown, not an empty one").toBeGreaterThan(0);
    expect([save!.status, JSON.parse(save!.body).error]).toEqual([503, "config_unreadable"]);
    expect(missing!.status).toBe(404);

    const beforeWait = live.pings();
    await sleep(KEEPALIVE_MS * 3.5);
    expect(exitCode(), `the server exited:\n${logs().stderr.slice(-3000)}`).toBeUndefined();
    expect(live.pings() - beforeWait, "the liveness beat keeps going with the file refused").toBeGreaterThanOrEqual(2);

    // Recovery: the next request sees the repaired file.
    expect(atomicWriteFile(configPath, readFileSync(SHIPPED_CONFIG), { createMode: 0o600 }).success).toBe(true);
    const recovered = await send(base, "GET", "/api/schema/ui/values", { cookie });
    expect(signalValue(recovered.body, "settings.storeState")).toBe("ok");
    live.close();

    const { stdout, stderr } = logs();
    expect(stderr, "no uncaught exception or unhandled rejection").not.toMatch(/uncaught exception|unhandled rejection/iu);
    expect(stderr.split("\n").filter((line) => line.includes("config_unreadable: the settings file")), "the refusal is logged once").toHaveLength(1);
    expect(stderr, "no fallback flood").not.toContain("[debug] diagnostic unavailable");
    expect(stdout).toContain("is ok (was unreadable)");
  });

  test("the dispatch boundary, a store removed or privacy-refused after boot, and the store watch", async () => {
    const refused = createTempDir("ch-config-server-refused-");
    const { root, configPath, base, cookie, logs, exitCode } = await startServer((document) => {
      document["selfProtection"] = { ...(document["selfProtection"] as Record<string, unknown>), additionalProtectedSubtrees: [refused] };
    });
    const good = readFileSync(configPath);
    const storeState = async (): Promise<Readonly<{ state: unknown; refusal: string }>> => {
      const values = await send(base, "GET", "/api/schema/ui/values", { cookie });
      return { state: signalValue(values.body, "settings.storeState"), refusal: String(signalValue(values.body, "settings.storeRefusal")) };
    };

    // ── THE ONE BOUNDARY (wf1b-design H1): no request shape escapes it. ──
    const escape = await send(base, "GET", "/api/chats/%E0%A4%A", { cookie });
    expect([escape.status, JSON.parse(escape.body).error]).toEqual([400, "request_path_malformed"]);
    const badHost = await sendWithHost(base, "/api/health", "127.0.0.1:abc");
    expect([badHost.status, JSON.parse(badHost.body).error], "an UNAUTHENTICATED malformed Host hung the socket").toEqual([400, "request_host_invalid"]);

    // ── REMOVED AFTER BOOT (wf1b-correctness §1e): the last good stays in force. ──
    const refusedProject = { path: refused, name: "refused" };
    expect((await send(base, "POST", "/api/projects", { cookie, body: refusedProject })).status).toBe(400);
    rmSync(configPath);
    const removed = await send(base, "POST", "/api/projects", { cookie, body: refusedProject });
    expect(removed.status, `a deleted store dropped the operator's keep-out: ${removed.body}`).toBe(400);
    const whileRemoved = await storeState();
    expect(whileRemoved.state).toBe("unreadable");
    expect(whileRemoved.refusal).toContain("config_document_removed");
    const saveWhileRemoved = await send(base, "PUT", "/api/config", { cookie, body: { path: "codeIntelligence.indexWatchDebounceMs", value: 402 } });
    expect([saveWhileRemoved.status, JSON.parse(saveWhileRemoved.body).error], "a save would write a near-empty document").toEqual([503, "config_unreadable"]);
    expect(atomicWriteFile(configPath, good, { createMode: 0o600 }).success).toBe(true);
    expect((await storeState()).state).toBe("ok");

    // ── PRIVACY-REFUSED HAND EDIT (wf1b-correctness §1d), seen by the WATCH with no request in between. ──
    const live = openLive(base, cookie);
    await sleep(KEEPALIVE_MS * 1.5);
    const document = JSON.parse(good.toString("utf8")) as Record<string, unknown>;
    document["privacy"] = { ...(document["privacy"] as Record<string, unknown>), enabledCategories: ["secret"] };
    expect(atomicWriteFile(configPath, `${JSON.stringify(document, null, 2)}\n`, { createMode: 0o600 }).success).toBe(true);
    // The refusal line: what still holds first, then the path and the reason (the always-on line is bounded).
    const refusedByWatch = /the settings file is refused;[^\n]*privacy_section_refused/u;
    for (let i = 0; i < 50 && !refusedByWatch.test(logs().stderr); i += 1) await sleep(100);
    expect(logs().stderr, "the store watch did not refresh the snapshot without a request").toMatch(refusedByWatch);
    const [health, projects] = await Promise.all([send(base, "GET", "/api/health"), send(base, "GET", "/api/projects", { cookie })]);
    expect(health.status, "one weakened leaf answered 503 on every route").toBe(200);
    expect(projects.status).toBe(200);
    const whileRefused = await storeState();
    expect(whileRefused.state).toBe("refused");
    expect(whileRefused.refusal).toContain("privacy_section_refused");
    // The settings shown are the ones IN FORCE (the last good), beside the store's state — never the refused bytes.
    const shown = JSON.parse((await send(base, "GET", "/api/config", { cookie })).body) as { config: { privacy?: { enabledCategories?: unknown } }; storeState: { state: string; reason?: string } };
    expect(shown.storeState.state).toBe("refused");
    expect(shown.storeState.reason ?? "").toContain("privacy_section_refused");
    expect(shown.config.privacy?.enabledCategories, "the refused weakening was shown as if in force").not.toEqual(["secret"]);
    const pingsBefore = live.pings();
    await sleep(KEEPALIVE_MS * 2.5);
    expect(live.pings() - pingsBefore, "the live stream closed (the reconnect storm)").toBeGreaterThanOrEqual(2);
    live.close();
    expect(atomicWriteFile(configPath, good, { createMode: 0o600 }).success).toBe(true);
    expect((await storeState()).state).toBe("ok");

    expect(exitCode(), `the server exited:\n${logs().stderr.slice(-3000)}`).toBeUndefined();
    expect(logs().stderr, "no uncaught exception or unhandled rejection").not.toMatch(/uncaught exception|unhandled rejection/iu);
    expect(root.length).toBeGreaterThan(0);
  });
});
