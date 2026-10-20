// @vitest-environment node
/**
 * The WSL host arm of the project-door keep-out tests.
 *
 * These two tests assert a HOST REQUIREMENT: the runner must be WSL with a
 * mounted Windows profile, including a credential store with an 8.3 short
 * name. They refuse on a host that does not provide it rather than skipping.
 * The shard manifest names this file as excluded; it runs on a WSL host.
 */
import { describe, expect, test } from "vitest";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { projectRootRefusals, resolveWithinProject } from "../../server/filesystem/fs-gate.ts";
import { hostHomes } from "../../engine/src/filesystem/self-protection/keep-out.ts";
import { requireHost } from "../../engine/test/support/host-requirement.ts";

const landlockProjectRefusal = (path: string): string | null => projectRootRefusals()(path);

describe("the ONE keep-out list on a WSL host", () => {
  test("WSL: a Windows profile is refused as a project and its stores never serve, whatever the case spelling", () => {
    const profile = hostHomes().find((entry) => entry.windowsDrive);
    // A HOST REQUIREMENT: this repository's host is WSL with a Windows drive mounted (the Windows-profile arm needs one).
    requireHost(profile !== undefined, "a WSL host with a Windows drive and a Windows profile mounted");
    expect(landlockProjectRefusal(profile.path)).toMatch(/credentials or keys/i);
    expect(() => resolveWithinProject(".CODEX/auth.json", profile.path)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    expect(() => resolveWithinProject(".codex/auth.json", profile.path)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    // The machine-wide store (the OpenSSH server's host keys) is in no profile: refused through its drive and through `All Users` (a link to ProgramData).
    const drive = dirname(dirname(profile.path));
    expect(landlockProjectRefusal(join(drive, "ProgramData"))).toMatch(/credentials or keys/i);
    expect(() => resolveWithinProject("ssh/ssh_host_ed25519_key", join(drive, "ProgramData"))).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    expect(() => resolveWithinProject("SSH/ssh_host_ed25519_key", join(drive, "ProgramData"))).toThrow(expect.objectContaining({ code: "path_credential_store" }));
  });

  test("WSL: a Windows SHORT (8.3) name is the long one (secd-security 1b): CODEX~1 is .codex, PROGRA~3 is ProgramData", () => {
    // Only where this host HAS such a pair (stat only: the same identity under both spellings).
    const pairs = hostHomes().filter((entry) => entry.windowsDrive).flatMap((profile) => {
      const long = join(profile.path, ".codex"), short = join(profile.path, "CODEX~1");
      return existsSync(long) && existsSync(short) && statSync(long).ino === statSync(short).ino ? [{ profile: profile.path, short }] : [];
    });
    requireHost(pairs.length > 0, "a WSL host whose Windows profile holds a credential store with its 8.3 short name (CODEX~1 for .codex)");
    for (const { profile, short } of pairs) {
      expect(landlockProjectRefusal(short)).toMatch(/credentials or keys/i);
      expect(() => resolveWithinProject("CODEX~1/auth.json", profile)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
      expect(() => resolveWithinProject("auth.json", short)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    }
    const drive = dirname(dirname(pairs[0]!.profile));
    const programData = join(drive, "PROGRA~3");
    if (existsSync(programData) && existsSync(join(drive, "ProgramData")) && statSync(programData).ino === statSync(join(drive, "ProgramData")).ino) {
      expect(landlockProjectRefusal(programData)).toMatch(/credentials or keys/i);
      expect(() => resolveWithinProject("ssh/ssh_host_ed25519_key", programData)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    }
  });
});
