/**
 * THE THROWAWAY MARKER, set by a fixture helper (scripts/verification/added-content.ts, `throwawayReading`).
 *
 * A test's throwaway repository whose hooks name this harness's guard by its absolute path (it has no
 * `engine/scripts/` of its own), or whose fixture names its own root, says so in its own `.git/config`,
 * never in a committed file. Only then may its commits name exactly those two things of the host; the
 * commit door refuses the marker in a project, a workspace or a candidate.
 */
import { execFileSync } from "node:child_process";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

/** Mark `root` (an initialized repository) as a test's throwaway repository. */
export function markThrowawayRepository(root: string): void {
  execFileSync("git", ["config", "--local", ROOT_POLICY.verification.addedContent.throwawayRepositoryKey, "true"], { cwd: root, stdio: "pipe" });
}
