// @vitest-environment node
/**
 * CUSTODY READ FAILURES, AT THE HANDLER — never rendered as measured zeros.
 *
 * Two round-5 findings, both reproduced through the real block read route
 * against a real git repository:
 *
 *  4. `custody.state` answered "clean" when `git status` RAN AND FAILED. The
 *     failed read fell through to the decode of "no porcelain" and published
 *     `repository: true, dirtyFiles: 0, entries: []` — a dirty tree served as
 *     clean. The bridge now raises a typed `git_read_failed` (503) once the
 *     repository probe confirms a work tree, and the block read serves that
 *     designed refusal instead of zeros.
 *
 *  5. `custody.history` rendered a failed `git log --no-walk --numstat` scan
 *     as files:0/insertions:0/deletions:0 plus "…an absence, not a guess".
 *     The scan now reports its own failure; the page omits the counts with a
 *     stated reason instead of fabricating a measured zero.
 *
 * The status failure is REAL, not mocked: a corrupt `.git/index` makes
 * `git status` exit 128 while `git rev-parse --is-inside-work-tree` still
 * answers true. The numstat failure is injected at the spawn door for exactly
 * `log --no-walk --numstat`, so every other git read in the file stays real.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const numstatPlant = vi.hoisted(() => ({ failNumstat: false }));

vi.mock("../../server/safety/landlock-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/safety/landlock-runner.ts")>();
  return {
    ...actual,
    spawnPlannedSync: (
      plan: Parameters<typeof actual.spawnPlannedSync>[0],
      options: Parameters<typeof actual.spawnPlannedSync>[1],
    ) => {
      const args = plan.args ?? [];
      if (numstatPlant.failNumstat && args.includes("--no-walk") && args.includes("--numstat")) {
        return { status: 1, stdout: "", stderr: "fatal: unable to read change counts" };
      }
      return actual.spawnPlannedSync(plan, options);
    },
  };
});

import { registerProjectRoutes } from "../../server/routes/projects.ts";
import { defineCustodyBlocks } from "../../server/blocks/custody.ts";
import { mountBlockRoutes } from "../../server/blocks/define.ts";
import { createTestUser, type TestUser } from "../helpers/multi-user.ts";
import { startHttpTestServer, type HttpTestServer } from "../helpers/http-server.ts";
import { jsonRequest } from "../helpers/json-request.ts";
import { createTempGitRepo } from "../helpers/temp-git-repo.ts";

let srv: HttpTestServer;
let user: TestUser;

beforeAll(async () => {
  srv = await startHttpTestServer({
    prefix: "ch-custody-http-",
    register: (router, _db, adb) => {
      registerProjectRoutes(router, adb);
      defineCustodyBlocks(adb);
      mountBlockRoutes(router);
    },
  });
  user = createTestUser(srv.db, "custody-http-user");
});

afterAll(async () => {
  if (srv) await srv.stop();
});

/** A real repository with one commit, registered as this user's project. */
function repoProject(prefix: string): { dir: string; projectId: string } {
  const repo = createTempGitRepo(prefix, { initialBranch: "main" });
  writeFileSync(join(repo.dir, "tracked.ts"), "one\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "base");
  const project = srv.db.createProject({ name: prefix, path: repo.dir }, user.userId);
  return { dir: repo.dir, projectId: project.id };
}

describe("custody block failure arms over real HTTP", () => {
  test("custody.state refuses with git_read_failed when the status read ran and failed", async () => {
    const { dir, projectId } = repoProject("ch-custody-broken-status-");
    // A REAL failure: git status cannot read this index, while the work-tree
    // probe still answers true. This is the tree a dirty status would have
    // described; serving zeros here is the defect.
    writeFileSync(join(dir, ".git", "index"), "not an index file\n");

    const res = await jsonRequest(srv.baseUrl, `/api/b/custody.state?projectId=${encodeURIComponent(projectId)}`, {
      cookie: user.cookie,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown; refusal?: { code: string; status: number } };
    expect(
      body.refusal,
      "a failed status read is a designed 503 refusal, not a fabricated clean tree",
    ).toMatchObject({ code: "git_read_failed", status: 503 });
    expect(body.data).toBeNull();
  });

  test("custody.history omits per-commit counts with a reason when the numstat scan fails", async () => {
    const { projectId } = repoProject("ch-custody-broken-numstat-");

    numstatPlant.failNumstat = true;
    try {
      const res = await jsonRequest(
        srv.baseUrl,
        `/api/b/custody.history?projectId=${encodeURIComponent(projectId)}`,
        { cookie: user.cookie },
      );
      expect(res.status).toBe(200);
      const data = (res.body as { data: { commits: Record<string, unknown>[]; repository: boolean } }).data;
      expect(data.repository).toBe(true);
      expect(data.commits).toHaveLength(1);
      const commit = data.commits[0]!;
      expect(commit["files"], "an unmeasured page must not report 0 files").toBeNull();
      expect(commit["insertions"], "an unmeasured page must not report 0 insertions").toBeNull();
      expect(commit["deletions"], "an unmeasured page must not report 0 deletions").toBeNull();
      expect(typeof commit["countsAbsentReason"], "the absence carries its reason").toBe("string");
      expect(String(commit["derivation"])).not.toContain("an absence, not a guess");
      expect(String(commit["derivation"])).toMatch(/could not read/i);
    } finally {
      numstatPlant.failNumstat = false;
    }
  });
});
