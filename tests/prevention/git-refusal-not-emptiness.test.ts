// @vitest-environment node
/**
 * A REFUSED GIT READ MUST NOT RENDER AS AN EMPTY RESULT.
 *
 * WHAT WAS MEASURED, AND WHY THIS FILE EXISTS
 *
 * Against a folder the confinement guardian correctly refuses, and at a
 * moment when that folder genuinely had uncommitted work, the live routes
 * answered:
 *
 *     GET /api/git/status   → HTTP 200  {"dirtyFiles":0,…,"entries":[]}
 *     GET /api/git/log      → HTTP 200  {"count":0,"log":[]}
 *     GET /api/git/branches → HTTP 200  {"count":0,"branches":[]}
 *
 * git never ran. The guardian's refusal message — already written for a
 * reader, already carrying the way out — existed and was discarded. A person
 * reading that screen cannot tell "your tree is clean" from "we could not
 * look", and the first is a claim they act on before committing or switching
 * branches. Absence rendered as a measurement is the one thing a read path
 * may never do.
 *
 * THE WIRE CONTRACT, UPDATED (the UIE-001 envelope, extended to this family):
 * the refusal now travels INSIDE a 200 body as `{ refusal: { code, message,
 * status } }` — the same principled-refusal envelope the block routes serve —
 * because the browser logs every non-2xx STATUS itself and the run pane's
 * working-tree probe printed a standing console error on every open of the
 * self-protected project. The INVARIANT this file pins is unchanged and is
 * the thing that matters: a refused read is STATED, in the guardian's own
 * words, and is never answerable as an empty collection. The body carries the
 * refusal ALONE — no `count`, no `branches`, no `dirtyFiles` — because an
 * envelope that also carried an empty data shape would hand a conflating
 * reader back the exact lie this file exists to prevent. The client's fetch
 * choke point (src/data/broker.ts::fetchJson) reconstructs the typed error
 * from the envelope, so consumers see the refusal they always saw.
 *
 * WHERE THE HOLE WAS, WHICH IS THE INTERESTING PART
 *
 * The read paths already HAD a refusal-aware helper that raises. It could
 * never fire. Every one of these routes begins `if (!isGitRepo(path)) return
 * <empty>`, and `isGitRepo` was built on the nullable `gitText`, which
 * answers `null` both for "git ran and said nothing" and for "the guardian
 * refused". The probe collapsed the refusal into `false` and returned the
 * empty shape ABOVE the helper that would have spoken. So the guard existed,
 * the fix existed, and the first line of every caller stepped over both.
 *
 * That is why this guard drives the ROUTE and not the helper: driving the
 * helper proves the helper works, which was never in doubt.
 *
 * HOW THE PLANT WORKS
 *
 * The refusal is planted at `prepareConfinedSpawn` — the exact place a real
 * refusal enters — and nowhere else. Everything downstream is the real
 * router, the real auth gate, the real ownership gate, the real bridge and
 * the real route handlers. The plant is a flag this file flips, not a
 * literal the production code could ever recognise.
 *
 * LIVENESS, BEFORE ANY VERDICT (a guard about a refusal must first prove a
 * refusal was reached):
 *   - the planted door must actually be CALLED — a route that short-circuits
 *     before asking for git would otherwise pass this file while proving
 *     nothing;
 *   - with the plant OFF the same routes must answer 200 with real data, so
 *     "everything refuses" cannot masquerade as a pass;
 *   - the covered population is read from `registerGitOpsRoutes`'s OWN
 *     registration, never from a list written here, and every registered
 *     route must be driven.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempGitRepo } from "../helpers/temp-git-repo.ts";

// The planted refusal. `vi.hoisted` so the mock factory (hoisted above the
// imports) and the tests below share one switch.
const plant = vi.hoisted(() => ({
  refusing: false,
  /**
   * REFUSE EVERYTHING EXCEPT THE "IS THIS A REPOSITORY" PROBE.
   *
   * `refusing` alone cannot see past `isGitRepo`: that probe raises first, so
   * every route answers 503 whether the readers BELOW it are refusal-aware or
   * still conflating a refusal with "git said nothing". A source pin was
   * holding that binding instead, and it was defeated three times — by
   * shadowing the reader, by moving the pinned literals into string
   * literals, and by leaving the binding intact while switching every reader
   * off it. Each of those is a spelling; none of them is the claim.
   *
   * So this mode lets the repository probe through and refuses the reads that
   * follow. A conflating reader answers 200 with an empty shape, which is the
   * filed defect exactly; a refusal-aware one states the refusal. The verdict
   * is behaviour, and there is nothing to spell around.
   */
  refuseAfterRepoProbe: false,
  calls: 0,
  refusalsIssued: 0,
  probesAllowed: 0,
  /** The guardian's real wording for the one refusal a person actually hits. */
  sentence:
    "This folder holds the harness's own program code, so commands cannot be run against it — the sandbox is not allowed to give anything write access to the code that enforces the sandbox. Choose a different project folder.",
}));

// A second plant, for the resource half: make the spawn THROW the way a full
// temp filesystem makes it throw, and count whether the confinement
// directory was released.
const leak = vi.hoisted(() => ({ throwing: false, prepared: 0, released: 0 }));

vi.mock("../../server/safety/landlock-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/safety/landlock-runner.ts")>();
  return {
    ...actual,
    prepareConfinedSpawn: (request: Parameters<typeof actual.prepareConfinedSpawn>[0]) => {
      plant.calls += 1;
      if (plant.refusing) {
        return { kind: "refused", code: "project_is_harness_source", message: plant.sentence } as const;
      }
      if (plant.refuseAfterRepoProbe) {
        // The probe `isGitRepo` makes, and nothing else, is let through.
        // Matched on the arguments the request CARRIES, not on a position:
        // the bridge prefixes its own `GIT_ARGS`, so `args[0]` is not the
        // subcommand and keying on it silently allowed nothing through.
        const args = request.args ?? [];
        const isRepoProbe = args.includes("rev-parse") && args.includes("--is-inside-work-tree");
        if (!isRepoProbe) {
          plant.refusalsIssued += 1;
          return { kind: "refused", code: "project_is_harness_source", message: plant.sentence } as const;
        }
        plant.probesAllowed += 1;
      }
      const plan = actual.prepareConfinedSpawn(request);
      if (!leak.throwing || plan.kind === "refused") return plan;
      // Wrap the real plan so `release()` is observable. The plan is
      // otherwise untouched — this counts, it does not substitute.
      leak.prepared += 1;
      if (plan.kind !== "confined") return plan;
      const inner = plan.release;
      return {
        ...plan,
        release: () => {
          leak.released += 1;
          inner();
        },
      };
    },
    spawnPlanned: (
      plan: Parameters<typeof actual.spawnPlanned>[0],
      opts: Parameters<typeof actual.spawnPlanned>[1],
    ) => {
      if (leak.throwing) throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" });
      return actual.spawnPlanned(plan, opts);
    },
    spawnPlannedSync: (
      plan: Parameters<typeof actual.spawnPlannedSync>[0],
      opts: Parameters<typeof actual.spawnPlannedSync>[1],
    ) => {
      if (leak.throwing) {
        // The shape a full temp filesystem produces: the spawn never returns.
        throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), { code: "ENOSPC" });
      }
      return actual.spawnPlannedSync(plan, opts);
    },
  };
});

// Static imports: vitest hoists the `vi.mock` factory above them, so the
// planted door is in place before the route module is evaluated.
import { getGitStatus } from "../../server/intelligence/git-ops-bridge.ts";
import { registerGitOpsRoutes } from "../../server/routes/git-ops.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";

let srv: HttpTestServer;
let cookie: string;
let repo: string;

/** Every path `registerGitOpsRoutes` registers, from its OWN registration. */
function registeredGitPaths(): readonly string[] {
  const paths: string[] = [];
  const recorder = {
    get: (p: string) => { paths.push(p); },
    post: (p: string) => { paths.push(p); },
    put: (p: string) => { paths.push(p); },
    delete: (p: string) => { paths.push(p); },
  };
  registerGitOpsRoutes(
    recorder as unknown as Parameters<typeof registerGitOpsRoutes>[0],
    undefined as unknown as Parameters<typeof registerGitOpsRoutes>[1],
  );
  return paths;
}

/** A real repository with a real uncommitted change — so "empty" would be a lie. */
function makeDirtyRepo(): string {
  const { dir, git } = createTempGitRepo("ch-git-refusal-");
  writeFileSync(join(dir, "kept.txt"), "one\n");
  git("add", "kept.txt");
  git("commit", "-qm", "first");
  // The uncommitted work that makes `dirtyFiles: 0` a false statement.
  writeFileSync(join(dir, "kept.txt"), "one\ntwo\n");
  return dir;
}

beforeAll(async () => {
  repo = makeDirtyRepo();
  srv = await startHttpTestServer({
    prefix: "ch-git-refusal-srv-",
    register: (router, _db, adb) => {
      registerGitOpsRoutes(router, adb);
    },
  });
  const user = createTestUser(srv.db, "git-refusal-tester");
  cookie = user.cookie;
  // Ownership must PASS, so a 403 can never be mistaken for the refusal.
  srv.db.createProject({ name: "refusal-fixture", path: repo }, user.userId);
});

afterAll(async () => {
  if (srv) await srv.stop();
});

const req = async (path: string): Promise<{ status: number; body: unknown }> =>
  await jsonRequest(srv.baseUrl, path, { method: "GET", cookie });

/** Drive every registered git route against the fixture repository. */
async function driveAll(): Promise<readonly { path: string; status: number; body: unknown }[]> {
  const out: { path: string; status: number; body: unknown }[] = [];
  for (const p of registeredGitPaths()) {
    const { status, body } = await req(`${p}?path=${encodeURIComponent(repo)}`);
    out.push({ path: p, status, body });
  }
  return out;
}

describe("a refused git read is stated, never rendered as emptiness", () => {
  test("LIVENESS: the population comes from the registration, and it is not empty", () => {
    const paths = registeredGitPaths();
    // A registration that stops registering must FAIL here rather than
    // quietly shrinking the population this file claims to cover.
    expect(paths.length, `registered git routes: ${paths.join(", ")}`).toBeGreaterThanOrEqual(5);
    for (const p of paths) expect(p.startsWith("/api/git/")).toBe(true);
  });

  test("LIVENESS: with the plant OFF the same routes answer with real data", async () => {
    plant.refusing = false;
    plant.calls = 0;
    const results = await driveAll();
    for (const r of results) {
      expect(r.status, `${r.path} answered ${r.status} with the plant off: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
    }
    // git was really asked for — otherwise the refusal case below would be
    // measuring a route that never reaches confinement at all.
    expect(plant.calls, "the confinement door was never asked").toBeGreaterThan(0);
    // And the fixture is genuinely dirty, so `dirtyFiles: 0` really would be
    // a false statement rather than a true one that happens to look wrong.
    const status = results.find((r) => r.path === "/api/git/status");
    expect((status?.body as { dirtyFiles?: number } | undefined)?.dirtyFiles, "fixture must have uncommitted work").toBeGreaterThan(0);
  });

  test("EVERY registered git route states the refusal instead of answering empty", async () => {
    plant.refusing = true;
    plant.calls = 0;
    try {
      const results = await driveAll();
      expect(plant.calls, "the confinement door was never asked").toBeGreaterThan(0);
      for (const r of results) {
        const text = JSON.stringify(r.body);
        // The envelope contract: a 200 carrying the refusal as data, so the
        // browser's own status log cannot turn a designed refusal into a
        // standing console error (UIE-001's treatment, joined by this
        // family). The status is checked to be 200 AND the refusal to be
        // inside: a route that answered 200 with a plain empty shape — the
        // filed defect — fails every assertion below.
        expect(r.status, `${r.path} answered ${r.status}: ${text.slice(0, 240)}`).toBe(200);
        const refusal = (r.body as { refusal?: unknown } | null)?.refusal;
        expect(refusal, `${r.path} lost the refusal envelope`).not.toBeUndefined();
        const typed = refusal as { code?: unknown; message?: unknown; status?: unknown };
        // Evidence only the refusal path can produce — the guardian's own
        // sentence and the typed code. Asserted rather than a shape or a
        // count, because the old path reproduced shapes and counts by
        // accident and they therefore prove nothing.
        expect(String(typed.code), `${r.path} lost the refusal code`).toContain("git_not_run");
        expect(String(typed.message), `${r.path} lost the guardian's words`).toContain("Choose a different project folder");
        expect(typed.status, `${r.path} lost the refusal's declared status`).toBe(503);
        // The specific fabrications that were measured live. The envelope
        // must carry the refusal ALONE — a `count` or a `dirtyFiles` beside
        // it is the emptiness lie wearing the envelope's clothes.
        expect(text, `${r.path} still reports a fabricated count`).not.toContain('"count":0');
        expect(text, `${r.path} still reports a fabricated clean tree`).not.toContain('"dirtyFiles":0');
      }
    } finally {
      plant.refusing = false;
    }
  });

  /**
   * THE READERS BELOW `isGitRepo`, WHICH THE TEST ABOVE CANNOT SEE.
   *
   * The test above refuses everything, so `isGitRepo` raises first and every
   * route is 503 no matter what the readers underneath it do. That made the
   * honesty of those readers rest on a SOURCE PIN — two literal regexes over
   * `git-ops-bridge.ts` — and a source pin is a claim about a spelling.
   * Three separate rewrites walked past it while the defect returned:
   * shadowing the reader with a conflating local, moving both pinned literals
   * into string literals (the stripper keeps strings), and leaving the pinned
   * binding in place while switching every reader off it.
   *
   * Refusing only what comes AFTER the repository probe puts those readers on
   * the path. There is no spelling that satisfies this: a reader that turns a
   * refusal into `null` produces `{"count":0,"branches":[]}` at HTTP 200 —
   * the filed defect, verbatim — and one that raises produces the guardian's
   * sentence.
   */
  test("readers BELOW the repository probe also state the refusal", async () => {
    plant.refuseAfterRepoProbe = true;
    plant.calls = 0;
    plant.refusalsIssued = 0;
    plant.probesAllowed = 0;
    try {
      const results = await driveAll();
      // LIVENESS, both halves: the probe really was allowed through (so the
      // routes got PAST `isGitRepo`), and reads after it really were refused
      // (so this is not just the previous test again).
      expect(
        plant.probesAllowed,
        "the repository probe never ran — every route died above the readers and this test proved nothing",
      ).toBeGreaterThan(0);
      expect(
        plant.refusalsIssued,
        "no read was refused after the probe — the readers were never reached",
      ).toBeGreaterThan(0);

      for (const r of results) {
        const text = JSON.stringify(r.body);
        // Same envelope contract as the full-refusal arm above, proven here
        // on the reads BELOW the probe: a 200 whose body is the refusal
        // alone. A reader that turned a refusal into `null` produces
        // `{"count":0,"branches":[]}` at HTTP 200 — the filed defect,
        // verbatim — and one that raises produces the guardian's sentence.
        expect(
          r.status,
          `${r.path} answered ${r.status} for a read that never ran: ${text.slice(0, 240)}`,
        ).toBe(200);
        const refusal = (r.body as { refusal?: unknown } | null)?.refusal;
        expect(refusal, `${r.path} lost the refusal envelope below the probe`).not.toBeUndefined();
        expect(
          String((refusal as { code?: unknown }).code),
          `${r.path} lost the refusal code below the probe`,
        ).toContain("git_not_run");
        // The exact fabrications measured on the live server.
        expect(text, `${r.path} rendered a refusal as an empty list`).not.toContain('"count":0');
        expect(text, `${r.path} rendered a refusal as a clean tree`).not.toContain('"dirtyFiles":0');
      }
    } finally {
      plant.refuseAfterRepoProbe = false;
    }
  });

  /**
   * THE CONFINEMENT DIRECTORY IS RELEASED ON EVERY ENDING.
   *
   * `prepareConfinedSpawn` mkdtemps a directory before the spawn. The release
   * sat on the straight-line path after it, so every non-happy ending walked
   * past it. That is a positive feedback loop rather than a slow drip: the
   * fuller the temp filesystem gets, the more likely the spawn throws, and
   * every throw leaks another entry. The temp filesystem here is RAM-backed
   * with a fixed inode table, so exhaustion arrives through INODES long
   * before bytes — measured at 99% of inodes against 31% of bytes — and when
   * it arrives, running a command, verifying anything, and freeing the space
   * all fail together.
   *
   * The liveness precondition matters more than usual here: if the spawn is
   * never prepared, "nothing leaked" is true and meaningless.
   */
  test("a git read whose spawn THROWS still releases the confinement directory", async () => {
    leak.throwing = true;
    leak.prepared = 0;
    leak.released = 0;
    try {
      const { status } = await req(`/api/git/status?path=${encodeURIComponent(repo)}`);
      // The throw is classified, not propagated as a crash — but that is not
      // what this test is about.
      expect(typeof status).toBe("number");
      await expect(getGitStatus(repo, undefined, { async: true })).rejects.toMatchObject({ name: "ServiceUnavailableError", code: "git_read_unavailable" });
      // LIVENESS: a directory was really allocated, so "0 leaked" is a fact
      // about a real allocation and not about an absent one.
      expect(leak.prepared, "no confinement directory was ever prepared — this test proved nothing").toBeGreaterThan(0);
      expect(
        leak.released,
        `${leak.prepared} confinement directories were prepared and ${leak.released} released — the rest leaked on the throw path`,
      ).toBe(leak.prepared);
    } finally {
      leak.throwing = false;
    }
  });

  test("async status retains the same explicit pre-execution refusal", async () => {
    plant.refusing = true;
    try {
      await expect(getGitStatus(repo, undefined, { async: true })).rejects.toMatchObject({
        name: "ServiceUnavailableError", code: "git_not_run", message: expect.stringContaining(plant.sentence),
      });
    } finally { plant.refusing = false; }
  });

  test("the refusal reaches a reader in plain words, with the way out", async () => {
    plant.refusing = true;
    try {
      const { status, body } = await req(`/api/git/status?path=${encodeURIComponent(repo)}`);
      expect(status).toBe(200);
      const refusal = (body as { refusal?: { message?: unknown } } | null)?.refusal;
      const message = typeof refusal?.message === "string" ? refusal.message : "";
      // Zero required knowledge: no file path, no schema key, no exit code.
      expect(message, `message was: ${message}`).toContain("would not run git");
      expect(message).toContain("Choose a different project folder");
      expect(message).not.toMatch(/spawnSync|landlock|ENOENT|exit code|\.ts:/);
    } finally {
      plant.refusing = false;
    }
  });
});
