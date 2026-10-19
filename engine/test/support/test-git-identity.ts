/**
 * THE ONE GIT IDENTITY TEST FIXTURES COMMIT AS — engine and web alike.
 *
 * A leaf module (no `node:test` hooks, no side effects) so both suites import
 * it: the engine's git fixtures (`git-fixtures.ts`, `workspace-test-support.ts`)
 * and the web's throwaway repositories (`tests/helpers/temp-git-repo.ts`). The
 * domain is a reserved `.invalid` one, so no commit a fixture makes can name a
 * real mailbox.
 */
import type { GitIdentity } from "../../src/git/git-port.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";

export const TEST_GIT_IDENTITY: GitIdentity = deepFreeze({ name: "Bridlewise Test", email: "test@example.invalid" });

/** The author and committer variables naming {@link TEST_GIT_IDENTITY}, for a git step that must not depend on any config. */
export function testGitIdentityEnvironment(): Readonly<Record<"GIT_AUTHOR_NAME" | "GIT_AUTHOR_EMAIL" | "GIT_COMMITTER_NAME" | "GIT_COMMITTER_EMAIL", string>> {
  return {
    GIT_AUTHOR_NAME: TEST_GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: TEST_GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: TEST_GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: TEST_GIT_IDENTITY.email,
  };
}
