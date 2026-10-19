// @vitest-environment node
/**
 * projectRootRefusals — the write-door for "this path cannot be a project":
 * Landlock cannot confine a run here (the harness), it is a system folder, or
 * it overlaps the ONE keep-out list (CRED-F11): a home (it holds credential
 * stores), another checkout's registered database, the key home.
 *
 * The HTTP tests in project-folder.test.ts already POST the harness root
 * and a folder inside it. This file names the function and drives the
 * direction the HTTP suite did not: a PARENT of the harness (Home, on
 * this machine), and a sibling that must NOT collide by prefix.
 */
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { projectRootRefusals, resolveWithinProject } from "../../server/filesystem/fs-gate.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { serverKeyHome } from "../../server/db/bootstrap-key.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { registerHarnessStore } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { hostHomes } from "../../engine/src/filesystem/self-protection/keep-out.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";
import { requireHost } from "../../engine/test/support/host-requirement.ts";

const landlockProjectRefusal = (path: string): string | null => projectRootRefusals()(path);

/** A real SQLite database file (a table written, so the file carries its header). */
function sqliteDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE rows (value TEXT)");
  db.close();
}

const harness = serverConfig.projectRoot;

describe("projectRootRefusals — overlap with the harness", () => {
  test("the harness root is refused", () => {
    expect(landlockProjectRefusal(harness)).toMatch(/harness/i);
  });

  test("a folder inside the harness is refused the same way", () => {
    expect(landlockProjectRefusal(join(harness, "src"))).toMatch(/harness/i);
  });

  test("a parent that CONTAINS the harness is refused", () => {
    const parent = dirname(harness);
    expect(landlockProjectRefusal(parent)).toMatch(/contains/i);
  });

  test("Home is refused by where it is, whatever label a picker gives it", () => {
    const home = homedir();
    expect(landlockProjectRefusal(home)).toMatch(/contains|harness|home/i);
  });

  test("a sibling of the harness is not refused by prefix collision", () => {
    const sibling = join(dirname(harness), "bridlewise-ds6-sibling-probe");
    expect(landlockProjectRefusal(sibling)).toBeNull();
  });
});

describe("the ONE keep-out list at the project door and the file choke point (CRED-F11)", () => {
  test("another checkout's registered database — at any depth — cannot be in a project, and is never project content", () => {
    // Registered by IDENTITY in the run's key home (every harness process that
    // opens a store records it; the relocation tool records old installs).
    const parent = createTempDir("other-checkout-parent-");
    const checkout = join(parent, "work", "checkout");
    mkdirSync(join(checkout, ".bridlewise"), { recursive: true });
    writeFileSync(join(checkout, ".bridlewise", "web.db"), "rows");
    writeFileSync(join(checkout, "README.md"), "source");
    registerHarnessStore(serverKeyHome(), join(checkout, ".bridlewise", "web.db"));
    // Two levels ABOVE the checkout too (the old one-level rule missed this).
    for (const folder of [checkout, join(parent, "work"), parent, join(checkout, ".bridlewise")]) {
      expect(landlockProjectRefusal(folder), folder).toMatch(/harness's own state/i);
    }
    // A project registered before this door (or through a link) still cannot read or write it.
    expect(resolveWithinProject("README.md", checkout)).toBe(join(checkout, "README.md"));
    for (const path of [".bridlewise/web.db", ".bridlewise/web.db-wal", join(checkout, ".bridlewise", "web.db")]) {
      expect(() => resolveWithinProject(path, checkout)).toThrow(expect.objectContaining({ code: "path_harness_state" }));
    }
    // The key home itself is never a project, nor inside one.
    expect(landlockProjectRefusal(serverKeyHome())).toMatch(/harness's own state/i);
  });

  test("an install STILL KEEPING ITS KEY BESIDE ITS DATABASE is refused with NO registration (secd-security 1a): by shape and location", () => {
    // Nothing registered: a key-sized `db-key` beside a SQLite database, the
    // layout every install had before the key home (the master checkout's).
    const parent = createTempDir("unregistered-install-parent-");
    const checkout = join(parent, "work", "checkout");
    const state = join(checkout, ".bridlewise");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "db-key"), randomBytes(32), { mode: 0o600 });
    sqliteDatabase(join(state, "web.db"));
    writeFileSync(join(checkout, "README.md"), "source");
    for (const folder of [state, checkout, join(parent, "work"), parent]) {
      expect(landlockProjectRefusal(folder), folder).toMatch(/harness's own state/i);
    }
    expect(resolveWithinProject("README.md", checkout)).toBe(join(checkout, "README.md"));
    for (const path of [".bridlewise/db-key", ".bridlewise/web.db", ".bridlewise/web.db-wal", ".bridlewise"]) {
      expect(() => resolveWithinProject(path, checkout), path).toThrow(expect.objectContaining({ code: "path_harness_state" }));
    }
    // Not an install: a key-sized file beside no database, or a database beside a file that is not key-sized.
    const stray = createTempDir("unregistered-stray-");
    writeFileSync(join(stray, "db-key"), randomBytes(32));
    expect(landlockProjectRefusal(stray)).toBeNull();
    const odd = createTempDir("unregistered-odd-");
    writeFileSync(join(odd, "db-key"), "not a key");
    sqliteDatabase(join(odd, "app.db"));
    expect(landlockProjectRefusal(odd)).toBeNull();
    expect(resolveWithinProject("db-key", odd)).toBe(join(odd, "db-key"));
  });

  test("a folder over the server's own database is refused; a plain folder is not", () => {
    const plain = createTempDir("plain-project-");
    expect(landlockProjectRefusal(plain)).toBeNull();
    if (serverConfig.dbPath !== ":memory:") {
      expect(landlockProjectRefusal(dirname(serverConfig.dbPath))).toMatch(/harness/i);
    }
  });

  test("a home is refused because it holds credential stores (not by a name rule), and an old project AT a home never serves them", () => {
    const home = createTempDir("fake-home-");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519"), "private");
    writeFileSync(join(home, "notes.md"), "mine");
    const previous = process.env.HOME;
    // The evidence store's DEFAULT place follows HOME (it is kept out wherever it
    // is): this test is about a home's credential stores, so the store is pinned
    // outside the fake home, the way an operator's HARNESS_EVIDENCE_HOME would.
    const previousEvidence = process.env[ROOT_POLICY.workflow.evidenceStore.environmentVariable];
    process.env[ROOT_POLICY.workflow.evidenceStore.environmentVariable] = join(createTempDir("evidence-home-"), "store");
    process.env.HOME = home;
    try {
      expect(landlockProjectRefusal(home)).toMatch(/credentials or keys/i);
      expect(landlockProjectRefusal(join(home, ".ssh"))).toMatch(/credentials or keys/i);
      // A project row inserted at the home before the door refused it (secc-design M3).
      expect(resolveWithinProject("notes.md", home)).toBe(join(home, "notes.md"));
      expect(() => resolveWithinProject(".ssh/id_ed25519", home)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
      // …a store CREATED after the list was measured is recognised by name.
      mkdirSync(join(home, ".aws"));
      writeFileSync(join(home, ".aws", "credentials"), "k");
      expect(() => resolveWithinProject(".aws/credentials", home)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
      // …and a store of ANOTHER home (a copied or mounted one: `<…>/home/<u>/`) by the name arm.
      const copy = join(home, "backup", "home", "other-user");
      mkdirSync(join(copy, ".config", "gh"), { recursive: true });
      writeFileSync(join(copy, ".config", "gh", "hosts.yml"), "token");
      expect(() => resolveWithinProject("backup/home/other-user/.config/gh/hosts.yml", home)).toThrow(expect.objectContaining({ code: "path_credential_store" }));
    } finally {
      process.env.HOME = previous;
      if (previousEvidence === undefined) delete process.env[ROOT_POLICY.workflow.evidenceStore.environmentVariable];
      else process.env[ROOT_POLICY.workflow.evidenceStore.environmentVariable] = previousEvidence;
    }
  });

  test("the same store NAMES inside a project are project content (secd-design H1): .claude/, .npmrc, .cursor/, .docker/, .codex/, .gemini/, .kube/", () => {
    const project = createTempDir("dot-folders-project-");
    const files = [".claude/settings.json", ".npmrc", ".cursor/rules/a.md", ".docker/compose.yml", ".codex/config.toml", ".gemini/styleguide.md", ".kube/dev.yaml", ".ssh/known_hosts.example"];
    for (const file of files) {
      mkdirSync(dirname(join(project, file)), { recursive: true });
      writeFileSync(join(project, file), "x");
    }
    expect(landlockProjectRefusal(project)).toBeNull();
    for (const file of files) expect(resolveWithinProject(file, project), file).toBe(join(project, file));
  });

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

  test("system folders are never a project, whatever they are spelled as", () => {
    const link = join(createTempDir("etc-link-"), "etc");
    symlinkSync("/etc", link);
    expect(landlockProjectRefusal(link)).toMatch(/system folder/i);
    expect(landlockProjectRefusal("/proc/self")).toMatch(/system folder/i);
  });
});
