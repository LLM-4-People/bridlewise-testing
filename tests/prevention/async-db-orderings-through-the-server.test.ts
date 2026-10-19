// @vitest-environment node
/**
 * Prevention test: THE THREE ORDERINGS, END TO END, THROUGH A REAL SERVER.
 *
 * `async-db-ordering.test.ts` proves W1/W2/W3 against a threaded
 * `AsyncDbClient` constructed directly. That is the right place to prove the
 * MECHANISM, and it is not enough to claim the PRODUCT has them, for a reason
 * the facade's own header states: an inline backend satisfies all three
 * trivially. Every route test in this repository runs on an inline facade, so
 * the entire HTTP surface could be re-established on a backend with none of
 * these properties and every one of those tests would stay green.
 *
 * So this file spawns `server/index.ts` as a real child process, over a real
 * file, on a real port, and asks the same three questions through HTTP:
 *
 * The port is the OS's choice, never a probe. The child binds port 0 — the
 * kernel assigns a free port atomically at listen time, inside the bind — and
 * this parent learns the assigned port by parsing it back out of the server's
 * own readiness line (`server on http://…`). The shape this replaces (bind a
 * throwaway socket to 0, close it, re-read the number, then have the child
 * listen on that number) is a probe-and-race: between the probe's close and
 * the child's bind the port is unowned, and a concurrent process that claims
 * it first fails the run with EADDRINUSE on a machine that had a free port
 * all along. Binding 0 in the child removes the window instead of retrying
 * around it.
 *
 *   W1  write ordering      — N messages issued back to back come back in
 *                             issue order, and the run's message sequence is
 *                             the sequence the caller wrote.
 *   W2  read-your-writes    — a read issued immediately after a write, on a
 *                             DIFFERENT connection, observes it.
 *   W3  ledger monotonicity — the ledger's recorded events for the run are
 *                             strictly ordered, and every one carries the
 *                             causality the DB workers cannot see. A worker
 *                             that opened the ledger would not crash the
 *                             request; it would record with no correlation at
 *                             all, so the assertion is on the CAUSALITY, not
 *                             on the absence of an error.
 *
 * The server is asserted to be running the THREADED backend before any of it
 * counts — a run against an inline server would pass and mean nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { DbClient } from "../../server/db/client.ts";
import { createSessionToken, hashSessionToken } from "../../server/auth/auth.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const REPO_ROOT = process.cwd();

let child: ChildProcess | undefined;
let baseUrl = "";
let cookie = "";
let projectId = "";
let userId = "";
let chatId = "";
let stagingDir = "";

type Res = Readonly<{ status: number; body: unknown }>;

async function req(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    cookie,
    "x-requested-with": "XMLHttpRequest",
    ...extraHeaders,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-JSON body is reported as the raw text */
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  stagingDir = createTempDir("ch-e2e-orderings-");
  const dbPath = join(stagingDir, "web.db");

  // Seed BEFORE the server starts: the fixture users carry a literal password
  // hash, so a login can never succeed for them. The session row is inserted
  // with the product's own helpers — exactly what `establishSession` does,
  // minus the HTTP — so the cookie is indistinguishable to the server.
  const seed = new DbClient({ path: dbPath });
  const user = seed.createUser("e2e-orderings", "not-a-real-hash");
  const token = createSessionToken();
  seed.createAuthSession(hashSessionToken(token), user.id, "e2e-session");
  const project = seed.createProject({ name: "e2e", path: stagingDir }, user.id);
  const chat = seed.createChat({ project_id: project.id, title: "orderings" }, user.id);
  userId = user.id;
  projectId = project.id;
  chatId = chat.id;
  cookie = `harness_auth=${token}`;
  seed.close();

  // The child binds port 0: the kernel assigns a free ephemeral port
  // atomically at listen time, so there is no probe and no window for a
  // concurrent process to claim a port this parent picked. The assigned port
  // is learned from the server's readiness line below.
  child = spawn("node", ["--experimental-strip-types", modulePathMatching("server/index.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HARNESS_WEB_PORT: "0",
      HARNESS_WEB_HOST: "127.0.0.1",
      HARNESS_WEB_DB_PATH: dbPath,
      HARNESS_WEB_TIMELINE_DB_PATH: join(stagingDir, "timeline.db"),
      HARNESS_WEB_PROJECT_ROOT: stagingDir,
      HARNESS_WEB_RATE_LIMIT: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));

  // Readiness from the server's OWN log line, never by racing the socket: on
  // this box a SYN to an unbound port is silently dropped, so a connect issued
  // before `listen` only completes on the ~1s kernel retransmit — which would
  // be measured as the server being slow to start. The same line carries the
  // OS-assigned port, parsed back out here.
  const deadline = Date.now() + 60_000;
  const READY = /server on http:\/\/[\d.]+:(\d+)/;
  let port = 0;
  while (Date.now() < deadline) {
    const match = logs.join("").match(READY);
    if (match) {
      port = Number(match[1]);
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited (${child.exitCode}) before listening:\n${logs.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (port === 0) {
    throw new Error(`server never listened within 60s:\n${logs.join("")}`);
  }
  baseUrl = `http://127.0.0.1:${port}`;
  // One real request, so a failure here is a failure to serve rather than a
  // failure inside the first assertion.
  const health = await req("GET", "/api/health");
  expect(health.status, `server did not serve /api/health:\n${logs.join("")}`).toBe(200);
}, 90_000);

afterAll(async () => {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
    const deadline = Date.now() + 8_000;
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

describe("the live server runs the threaded backend, which is what makes the rest mean anything", () => {
  test("the process facade this server booted is off-thread", () => {
    // Asserted from the SOURCE the server actually runs, because the running
    // process has no endpoint that reports it. If `getOrCreateAsyncDb` were
    // inline, every ordering below would hold trivially and this whole file
    // would be theatre.
    const src = readFileSync(join(REPO_ROOT, "server", "db", "index.ts"), "utf8");
    expect(
      /asyncInstance\s*=\s*AsyncDbClient\.deferred\(/.test(src),
      "the process facade is not the threaded backend — the orderings below would " +
        "hold trivially on an inline one and would prove nothing about this server",
    ).toBe(true);
    const boot = readFileSync(join(REPO_ROOT, "server", "index.ts"), "utf8");
    expect(
      boot.indexOf("await warmAsyncDb()"),
      "the pool must be warmed before the socket listens",
    ).toBeGreaterThan(-1);
    expect(boot.indexOf("await warmAsyncDb()")).toBeLessThan(boot.indexOf("server.listen("));
  });
});

describe("W1 through the server — the writer is one, so nothing is lost, duplicated or unstable", () => {
  /**
   * WHAT "ISSUE ORDER" MEANS OVER HTTP, said before it is measured.
   *
   * At the facade, W1 is "writes execute in the order the caller ISSUED
   * them", and `async-db-ordering.test.ts` proves exactly that by issuing
   * without awaiting on one thread. Over the wire the caller is N sockets and
   * the order they reach the server is the network's, not the caller's — so
   * asserting a global issue order here would be asserting something HTTP
   * does not promise, and the test would flake for a reason that is not the
   * property. It did, on the first run.
   *
   * What IS end-to-end observable, and what a broken writer destroys:
   *   · sequential issue on ONE connection comes back in exactly that order;
   *   · concurrent issue loses nothing and duplicates nothing;
   *   · the server's order is TOTAL and STABLE — two reads agree.
   * Two writers on one file break the second and third of those.
   */
  test("sequential writes on one connection come back in exactly that order", async () => {
    const contents = Array.from({ length: 25 }, (_, i) => `w1s-${String(i).padStart(3, "0")}`);
    for (const content of contents) {
      const r = await req("POST", `/api/chats/${chatId}/messages`, { role: "user", content });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const history = await req("GET", `/api/chats/${chatId}/history`);
    expect(history.status).toBe(200);
    const rows = (history.body as { messages: ReadonlyArray<{ content: string }> }).messages;
    expect(rows.map((m) => m.content).filter((c) => c.startsWith("w1s-"))).toEqual(contents);
  }, 60_000);

  test("60 concurrent writes lose nothing, duplicate nothing, and settle into ONE stable order", async () => {
    const contents = Array.from({ length: 60 }, (_, i) => `w1c-${String(i).padStart(3, "0")}`);
    const posted = await Promise.all(
      contents.map((content) =>
        req("POST", `/api/chats/${chatId}/messages`, { role: "user", content }),
      ),
    );
    for (const p of posted) expect(p.status, JSON.stringify(p.body)).toBe(201);

    const readOnce = async (): Promise<readonly string[]> => {
      const h = await req("GET", `/api/chats/${chatId}/history`);
      expect(h.status).toBe(200);
      const rows = (h.body as { messages: ReadonlyArray<{ content: string }> }).messages;
      return rows.map((m) => m.content).filter((c) => c.startsWith("w1c-"));
    };

    const first = await readOnce();
    // Nothing lost, nothing duplicated: 60 issued, 60 distinct, all present.
    expect(new Set(first).size).toBe(60);
    expect([...first].sort()).toEqual([...contents].sort());
    // And ONE order, not a different one each time it is asked.
    expect(await readOnce()).toEqual(first);
  }, 90_000);
});

describe("W2 through the server — a read observes every write issued before it", () => {
  /**
   * WHAT THIS TEST DOES AND DOES NOT PROVE, because the difference is real.
   *
   * The W2 barrier exists for writes that were issued and NOT awaited: a read
   * captures the write frontier at issue time and waits for it to commit. Over
   * HTTP a client awaits its own response, and the response is sent after the
   * write commits — so this case would pass even with the barrier removed, and
   * mutation testing confirmed exactly that (removing `awaitWrites` leaves
   * this file green while `async-db-ordering.test.ts` fails two assertions).
   *
   * Two unawaited HTTP requests have no ordering to preserve — the wire
   * promises none — so there is no honest end-to-end form of the un-awaited
   * case. What this DOES prove, which the facade test cannot, is that nothing
   * BETWEEN the facade and the socket loses it: not the reader-thread routing,
   * not the redaction pass, not the view mapping, not the response buffer.
   * The barrier itself is proved where a caller can express the case, and that
   * proof is mutation-checked.
   */
  test("a write on one connection is visible to a read on another, issued immediately after", async () => {
    for (let i = 0; i < 12; i += 1) {
      const marker = `w2-${i}-${Date.now()}`;
      const wrote = await req("POST", `/api/chats/${chatId}/messages`, {
        role: "user",
        content: marker,
      });
      expect(wrote.status, JSON.stringify(wrote.body)).toBe(201);
      const read = await req("GET", `/api/chats/${chatId}/history`);
      const rows = (read.body as { messages: ReadonlyArray<{ content: string }> }).messages;
      expect(
        rows.some((m) => m.content === marker),
        `the read that followed write ${i} did not observe it — read-your-writes is broken ` +
          "across the request boundary",
      ).toBe(true);
    }
  }, 90_000);
});

describe("W3 through the server — the ledger keeps one writer and its causality", () => {
  test("effects recorded while serving are strictly ordered and carry the request's causality", async () => {
    // A DB worker opening the ledger is the failure that does NOT announce
    // itself. `timeline-bridge.ts` throws on a worker, so the loud half is
    // covered; the quiet half is an event recorded with NO ambient context,
    // because AsyncLocalStorage does not cross a thread. So the assertion is
    // that the events this server recorded WHILE SERVING carry the request's
    // causality — which only a main-thread recorder inside the router's
    // recording context can produce.
    //
    // An editor write is used because the editor bridge is the mechanically
    // proven single owner of in-process file writes and records every one, so
    // this exercises a real recorded effect rather than a synthetic append.
    const write = await req("PUT", "/api/editor/write", {
      path: "ledger-probe.txt",
      content: `recorded at ${Date.now()}\n`,
      root: stagingDir,
    });
    expect(write.status, JSON.stringify(write.body)).toBe(200);

    const ledgerPath = join(stagingDir, "timeline.db");
    expect(existsSync(ledgerPath), "the server never opened a ledger").toBe(true);

    // The ledger is a file, which is the whole point of keeping SQLite. Give
    // the time-bounded durability window room to checkpoint before reading.
    await new Promise((r) => setTimeout(r, 1_500));
    const { DatabaseSync } = await import("node:sqlite");
    const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const rows = ledger
        .prepare(
          `SELECT sequence, actor_kind, actor_id, trace_id FROM event_log ORDER BY sequence ASC LIMIT 1000`,
        )
        .all() as ReadonlyArray<Record<string, unknown>>;
      expect(
        rows.length,
        "the server recorded nothing while serving real requests — recording is " +
          "supposed to be structurally unavoidable",
      ).toBeGreaterThan(0);

      // Strictly increasing with no repeats: one writer, one chain. A second
      // writer on the same file is exactly what makes "the entry before this
      // one" stop being well defined.
      const seqs = rows.map((r) => Number(r["sequence"]));
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]! > seqs[i - 1]!, `sequence went backwards at row ${i}`).toBe(true);
      }
      expect(new Set(seqs).size, "a duplicated sequence means two writers").toBe(seqs.length);

      // And the causality a worker could not have supplied.
      //
      // The marker is the ACTOR, not the trace. A REST request enters
      // `withRecordingContext({actor, sessionId})`; a trace id is established
      // by `withSpan`, which the block surface uses and a plain route does
      // not — so asserting a trace here would assert something this path never
      // promised, and the assertion would be measuring the harness rather than
      // the product. (It was written that way first, and failed for exactly
      // that reason.)
      //
      // The actor IS the ambient fact that cannot cross a thread. A ledger
      // append on a DB worker would find no AsyncLocalStorage store and record
      // `unattributed`/`unknown` — a real row, with a real sequence, in the
      // real chain, describing nobody. `actor_kind` being a single constant
      // across every event is precisely the symptom this product was built to
      // refuse.
      const byThisUser = rows.filter(
        (r) => r["actor_kind"] === "user" && r["actor_id"] === userId,
      );
      expect(
        byThisUser.length,
        "no recorded event is attributed to the user whose request produced it — " +
          "the recorder ran with no ambient context, which is what a ledger append " +
          "on a DB worker would produce: not a failure, an event describing nobody",
      ).toBeGreaterThan(0);
      expect(
        rows.some((r) => r["actor_kind"] === "unattributed"),
        "an effect recorded while serving a request came back unattributed",
      ).toBe(false);
    } finally {
      ledger.close();
    }
  }, 60_000);
});
