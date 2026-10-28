// @vitest-environment node
/**
 * THIS REPOSITORY'S COMMIT HOOK IS INSTALLED, NOT MERELY SHIPPED.
 *
 * The rule, the wording and the program all live in one owner in the harness
 * tree, and the proofs that it actually refuses a losing move live beside it —
 * driven on throwaway repositories, at `git commit` itself. None of that is
 * repeated here.
 *
 * What is here is the half only this repository can answer. `core.hooksPath`
 * is per-clone LOCAL config: git will not let a repository ship it, because a
 * tree that could point your git at its own executable files would run code on
 * `git clone`. So the hook is tracked, the pointer is not, and nothing in the
 * tree can tell you whether the pointer was ever set. This repository is a
 * SIBLING of the harness tree rather than a submodule of it — nothing in git
 * records the relationship — so the harness side's own check cannot reach here
 * and this file is the only thing standing between a fresh clone and a commit
 * that silently drops a tracked file.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  HOOKS_DIRECTORY,
  HOOK_NAME,
  hookInstallationFailure,
  readHookInstallations,
  SHIPPED_HOOKS,
} from "../../engine/scripts/verification/staged-move-loss.ts";

/**
 * The way out of the unconfigured state, in the words the person reading a red
 * suite can type. The script itself points at the sibling tree — the same
 * relative literal this repository already uses in `package.json`, in
 * `server/config.ts` and in the `.gitignore` guard next door.
 */
const BOOTSTRAP = `npm run bootstrap:hooks  (from ${process.cwd()})`;

describe("a move cannot silently drop a tracked file from this repository", () => {
  test("git here is pointed at the tracked hook, and the hook can run", () => {
    const root = process.cwd();
    const installations = readHookInstallations(root);
    expect(installations.map((installation) => installation.hook)).toEqual([...SHIPPED_HOOKS]);
    const failure = hookInstallationFailure(installations, BOOTSTRAP);
    expect(failure, failure ?? "").toBeNull();
    const installation = installations[0]!;

    // PLANT, from outside: the same rule over an installation with the pointer
    // missing must refuse and must print the way out, so the green verdict
    // above is about this clone rather than about a rule that stopped ruling.
    const unset = hookInstallationFailure([{ ...installation, hooksPath: null }], BOOTSTRAP);
    expect(unset ?? "").toContain("core.hooksPath is not set");
    expect(unset ?? "").toContain("npm run bootstrap:hooks");
    expect(hookInstallationFailure([], BOOTSTRAP) ?? "").toContain("broken discovery");
  });

  test("the shim resolves the shared program across the repository boundary", () => {
    // The one repository-specific part is the relative path to the sibling
    // tree, and a path is exactly what goes stale. Running the shim where it
    // lives proves the resolution; reading it could not. The status may
    // legitimately be either value on a live tree — what may not happen is the
    // program failing to load, which is neither answer.
    //
    // The explicit timeout: loading the shared program through the shim
    // costs ~18s on an idle box, and the default 30s test deadline leaves
    // under 2× headroom — under this suite's own parallel load the spawn
    // crossed 30s and reded a test whose subject (does the program load?)
    // was never in doubt. The judgment is unchanged: 90s still bounds a
    // hang, it only stops mistaking suite contention for a broken shim.
    const root = process.cwd();
    const result = spawnSync("sh", [join(root, HOOKS_DIRECTORY, HOOK_NAME)], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    const judged = result.status === 0 || /COMMIT REFUSED/u.test(result.stderr);
    expect(judged, `the hook neither passed nor refused — it failed to run:\n${result.stderr}`).toBe(
      true,
    );
  });
});
