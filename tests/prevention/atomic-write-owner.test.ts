// @vitest-environment node
/**
 * ATOMIC FILE REPLACEMENT HAS ONE OWNER, AND IT DOES NOT RELAX PERMISSIONS.
 *
 * ── THE DEFECT, AND WHY IT IS HERE TWICE ──────────────────────────────────
 *
 * `write a temp file, rename it over the target` is the standard way to
 * replace a file without ever leaving a half-written one on disk. It also
 * replaces the target's INODE, and a fresh inode takes its permissions from
 * the umask rather than from the file being replaced — so the atomic write
 * silently WIDENS access. Measured with the exact two calls: a `0600` file
 * came back `0664` under umask `0002`.
 *
 * That was found in the config writer, where it was loud: the harness refuses
 * to start against a config other accounts can read, so a single edit through
 * the web UI bricked it. The identical two calls sat one file away in the
 * editor bridge and were not looked for. There the consequence is quiet and
 * worse — every file edited through the bridge, including a `.env`, a private
 * key or a `known_hosts`, was made group and world readable, and nothing
 * anywhere would have said so.
 *
 * ── SO THE TEST IS ABOUT THE OWNER, NOT ABOUT THE TWO CALL SITES ──────────
 *
 * Asserting the fix at each site is the shape that produced the bug: the
 * second site is the one nobody remembers. The population is scanned instead,
 * so a THIRD site fails here the day it is written, and the behaviour is
 * driven against the owner itself.
 *
 * GUARD SUBJECT: atomic file replacement preserves the replaced file's exact permission bits, and every atomic-write call site routes through the one owner
 * GUARD OWNS: engine/src/filesystem/atomic-write.ts (`atomicWriteFile`) — the single owner of temp-write-then-rename, for the engine AND the server (the server's second copy, `server/filesystem/atomic-write.ts`, is deleted)
 * GUARD PLANT: strip the permission-preserving `chmodSync` from the owner's rename path so the fresh inode inherits the umask; a 0600 file must come back 0664 under umask 0002
 * GUARD DRIVEN: atomicWriteFile against real files at five permission modes (0600/0640/0644/0755/0400), plus a source scan refusing a second owner in the server
 * GUARD LIVENESS: the fixture file is asserted to hold the mode under test BEFORE the write, and the write is asserted to have happened — a no-op owner cannot satisfy the mode assertion
 */
import { describe, expect, test } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, symlinkSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { read, relpath, sourceFiles, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { readConfigRaw, writeConfigRaw, restoreConfigFileBytes } from "../../server/kernel/harness-config.ts";
import { resetServerConfig } from "../../server/kernel/config.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { ownedTemporaryOwnerOf } from "../../engine/src/filesystem/private-state.ts";
const MOVE_OWNER = modulePathMatching("engine/src/filesystem/move-path.ts");

/** The permission bits of `path`, as an octal string, measured. */
function bits(path: string): string {
  return (statSync(path).mode & 0o7777).toString(8);
}

describe("the atomic-write owner preserves what it replaces", () => {
  test("an existing file keeps its EXACT permissions across a replacement", () => {
    const dir = createTempDir("atomic-write-perms-");
    // DRIVEN OVER A RANGE, not over one lucky value: the defect is "the umask
    // decides", and a umask can coincide with any single mode you pick.
    const modes = [0o600, 0o640, 0o644, 0o755, 0o400];
    expect(modes.length, `permission modes driven: ${modes.length}`).toBeGreaterThanOrEqual(5);
    for (const mode of modes) {
      const target = join(dir, `file-${mode.toString(8)}`);
      writeFileSync(target, "before\n");
      chmodSync(target, mode);
      expect(bits(target), "the fixture itself must have the mode under test").toBe(mode.toString(8));
      expect(atomicWriteFile(target, "after\n").success).toBe(true);
      expect(bits(target), `a ${mode.toString(8)} file must still be ${mode.toString(8)} after an atomic write`)
        .toBe(mode.toString(8));
      // LIVENESS: the write really happened. Without this the permission
      // assertion is satisfied by a function that does nothing at all.
      expect(readFileSync(target, "utf8")).toBe("after\n");
    }
  });

  test("an existing file's own mode WINS over the caller's createMode", () => {
    // The config writer asks for 0600 on creation. If that opinion also
    // applied to an existing file, a config an operator had deliberately
    // opened to a group would be narrowed behind their back — the same class
    // of silent permission change, in the other direction.
    const dir = createTempDir("atomic-write-existing-wins-");
    const target = join(dir, "config.json");
    writeFileSync(target, "{}\n");
    chmodSync(target, 0o640);
    expect(atomicWriteFile(target, "{\"a\":1}\n", { createMode: 0o600 }).success).toBe(true);
    expect(bits(target)).toBe("640");
    expect(readFileSync(target, "utf8")).toBe("{\"a\":1}\n");
  });

  test("a NEW file takes the caller's createMode (0o666 = exactly a plain write), and the private mode when there is none", () => {
    const dir = createTempDir("atomic-write-create-");
    const strict = join(dir, "secret.json");
    expect(atomicWriteFile(strict, "{}\n", { createMode: 0o600 }).success).toBe(true);
    expect(bits(strict)).toBe("600");

    // The user's own files (the editor bridge): exactly what a plain write
    // would have produced, measured against a plain write rather than
    // against a guessed umask.
    const plain = join(dir, "plain-reference.txt");
    writeFileSync(plain, "x");
    const viaOwner = join(dir, "via-owner.txt");
    expect(atomicWriteFile(viaOwner, "x", { createMode: 0o666 }).success).toBe(true);
    expect(bits(viaOwner)).toBe(bits(plain));

    // No opinion: deny by default.
    const unspecified = join(dir, "unspecified.txt");
    expect(atomicWriteFile(unspecified, "x").success).toBe(true);
    expect(bits(unspecified)).toBe("600");
  });

  test("a failed write leaves no temp file behind, and carries the errno", () => {
    const dir = createTempDir("atomic-write-cleanup-");
    // A target inside a directory that does not exist, with parents NOT
    // created (the editor's contract): the write fails, and the temp file
    // must not survive it.
    const result = atomicWriteFile(join(dir, "no-such-dir", "x.txt"), "x", { createParentDirectories: false });
    expect(result.success).toBe(false);
    // The SPECIFIC failure, not merely "it failed": a bare failure assertion
    // would pass against a function that failed for the wrong reason.
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    expect(readdirSync(dir).filter((n) => ownedTemporaryOwnerOf(n) !== undefined)).toEqual([]);
  });

  test("a requiredMode TIGHTENS a too-open existing file to the floor (the chmod cascade)", () => {
    // The defect this arm pins: the config must be 0600, and a write that
    // PRESERVED an operator-accidental 0664 left the next read refusing the
    // file (config_mode_insecure) — the recurring "chmod it by hand" cascade.
    // With requiredMode the write corrects the mode instead of preserving the
    // permissive one. Driven across modes so a coincidence cannot pass it.
    const dir = createTempDir("atomic-write-required-");
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      // [existing mode, requiredMode, expected result mode]
      [0o664, 0o600, "600"], // too open -> tightened to the floor
      [0o640, 0o600, "600"], // group-readable -> tightened
      [0o600, 0o600, "600"], // already at the floor -> unchanged
      [0o400, 0o600, "400"], // stricter than the floor -> kept (tighten, never loosen)
    ];
    expect(cases.length, "requiredMode cases driven").toBeGreaterThanOrEqual(4);
    for (const [existing, required, expected] of cases) {
      const target = join(dir, `f-${existing.toString(8)}`);
      writeFileSync(target, "before\n");
      chmodSync(target, existing);
      expect(bits(target), "the fixture holds the pre-write mode").toBe(existing.toString(8));
      expect(atomicWriteFile(target, "after\n", { requiredMode: required }).success).toBe(true);
      expect(bits(target), `0664-ish ${existing.toString(8)} tightened by required ${required.toString(8)}`)
        .toBe(expected);
      expect(readFileSync(target, "utf8")).toBe("after\n");
    }
    // A NEW file with only requiredMode takes the floor.
    const fresh = join(dir, "fresh.json");
    expect(atomicWriteFile(fresh, "{}\n", { requiredMode: 0o600 }).success).toBe(true);
    expect(bits(fresh)).toBe("600");

    // A config no-op may skip replacement only when the required mode is
    // already satisfied. Drive both shared-byte callers on private files.
    const bytes = JSON.stringify(readConfigRaw(), null, 2) + "\n";
    try {
      for (const writer of [
        { name: "restore", write: () => restoreConfigFileBytes(bytes) },
        { name: "gate", write: () => writeConfigRaw(JSON.parse(bytes) as Record<string, unknown>) },
      ]) {
        for (const [existing, _required, expected] of cases) {
          const target = join(dir, `${writer.name}-${existing.toString(8)}.json`);
          expect(atomicWriteFile(target, bytes, { createMode: 0o600 }).success).toBe(true);
          chmodSync(target, existing);
          resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: target });
          const before = statSync(target, { bigint: true });
          writer.write();
          const after = statSync(target, { bigint: true });
          expect(readFileSync(target, "utf8")).toBe(bytes);
          expect(bits(target), `${writer.name} tightens permissions even when bytes match`).toBe(expected);
          if (existing.toString(8) === expected) {
            expect(after.ino, `${writer.name} preserves an already secure identical file`).toBe(before.ino);
            expect(after.mtimeNs).toBe(before.mtimeNs);
          } else {
            expect(after.ino, `${writer.name} performs the required restrictive replacement`).not.toBe(before.ino);
          }
        }
      }
      const empty = join(dir, "missing-empty.json");
      resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: empty });
      restoreConfigFileBytes("");
      expect(existsSync(empty), "missing bytes are not mistaken for an existing empty file").toBe(true);
      expect(readFileSync(empty, "utf8")).toBe("");
      expect(bits(empty)).toBe("600");
      expect(atomicWriteFile(empty, '{"partial":', { createMode: 0o600 }).success).toBe(true);
      restoreConfigFileBytes(bytes);
      expect(readFileSync(empty, "utf8"), "partial writes are restored exactly").toBe(bytes);
      const candidate = JSON.parse(bytes);
      candidate.runtime.systemPrompt = "byte-boundary-witness-\ufffd";
      const expected = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
      const outcomes: unknown[] = [];
      for (const shape of ["short-invalid", "same-length-invalid", "symlink", "hardlink"]) {
        for (const verb of ["gate", "restore"] as const) {
          const target = join(dir, `${shape}-${verb}.json`);
          const backing = target + ".backing";
          writeFileSync(backing, expected, { mode: 0o600 });
          if (shape === "symlink") symlinkSync(backing, target);
          else if (shape === "hardlink") linkSync(backing, target);
          else {
            const offset = expected.indexOf(Buffer.from("\ufffd"));
            expect(offset).toBeGreaterThanOrEqual(0);
            const replacement = shape === "short-invalid" ? Buffer.from([255]) : Buffer.from([240, 144, 128]);
            const malformed = Buffer.concat([expected.subarray(0, offset), replacement, expected.subarray(offset + 3)]);
            expect(malformed.equals(expected), "the planted bytes must really differ").toBe(false);
            expect(malformed.toString("utf8"), "decoded text collides with requested valid bytes").toBe(expected.toString("utf8"));
            writeFileSync(target, malformed, { mode: 0o600 });
          }
          resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: target });
          if (verb === "gate" && shape.endsWith("-invalid")) {
            // A document that is not valid UTF-8 is REFUSED by the gate (the
            // one config read/refusal door) and left for the operator; only
            // the exact-bytes restore door replaces it.
            const planted = readFileSync(target);
            expect(() => writeConfigRaw(candidate)).toThrowError(expect.objectContaining({ code: "config_unreadable" }));
            expect(readFileSync(target).equals(planted), "a refused write leaves the planted bytes").toBe(true);
            continue;
          }
          if (verb === "gate") writeConfigRaw(candidate);
          else restoreConfigFileBytes(expected.toString("utf8"));
          const observed = lstatSync(target);
          outcomes.push({ shape, verb, exactBytes: readFileSync(target).equals(expected), regular: observed.isFile(), independentBacking: observed.ino !== statSync(backing).ino });
        }
      }
      expect(outcomes, "a skipped config replacement must preserve exact bytes, a symlink's link, and regular single-link ownership otherwise").toEqual(
        ["short-invalid", "same-length-invalid", "symlink", "hardlink"].flatMap(shape => ["gate", "restore"]
          .filter(verb => !(verb === "gate" && shape.endsWith("-invalid")))
          // A symlinked config is written THROUGH its link and stays a link
          // (wf1a-correctness §1: a no-op save once replaced the link).
          .map(verb => ({ shape, verb, exactBytes: true, regular: shape !== "symlink", independentBacking: true }))),
      );

    } finally { resetServerConfig(); }
  });
});

describe("there is exactly one write-then-rename, and the server holds no copy of it", () => {
  const files = sourceFiles("server").map((f) => relpath(f));

  test("no server module performs its own atomic replacement — the only rename is the move owner's", () => {
    // POPULATION AS A RUNTIME NUMBER first: a scanner over an empty file list
    // reports no violations for the wrong reason.
    expect(files.length, `server source files scanned: ${files.length}`).toBeGreaterThanOrEqual(50);
    const renamers = files.filter((f) => f !== MOVE_OWNER && /\brenameSync\s*\(/.test(stripCommentsAndStringsFor(read(f), f)));
    expect(
      renamers,
      "write-then-rename has one owner (engine/src/filesystem/atomic-write.ts) — a second copy is where the permission bug came back last time, and where the checkout write door did not reach",
    ).toEqual([]);
    // LIVENESS: the move owner really holds its rename.
    expect(/\brenameSync\s*\(/.test(stripCommentsAndStringsFor(read(MOVE_OWNER), MOVE_OWNER))).toBe(true);
    expect(existsSync(join("server", "filesystem", "atomic-write.ts")), "the server's second writer is deleted, not kept beside the owner").toBe(false);
  });

  test("the two known callers go through the owner", () => {
    // NAMED, because "no violations" says nothing about whether the rule is
    // being used. These are the two sites the defect was measured in — plus
    // the engine's own config writer, which writes the SAME shared config
    // file from the other tree and must not grow a second write shape.
    for (const caller of [modulePath("harness-config.ts"), modulePath("editor-bridge.ts")]) {
      expect(read(caller), `${caller} must use the shared atomic writer`).toContain("atomicWriteFile");
    }
    expect(read(modulePathMatching("engine/src/shared/exposure/config-binding.ts")))
      .toContain("atomicWriteFile");
  });
});
