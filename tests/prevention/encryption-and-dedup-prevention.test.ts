// @vitest-environment node
/**
 * Proactive security prevention: the persisted DB encryption key file is
 * NEVER committed to git. The key file (`.bridlewise/db-key`) is the
 * secret that protects all encrypted DB content at rest — if it were
 * committed, the encryption would be worthless.
 *
 * ── THIS GUARD WAS BLIND INSIDE ITS OWN SUBJECT ───────────────────────────
 *
 * The describe block below has said "the persisted encryption key is never
 * committed" since it was written. It stayed green while a `db-key` — and
 * `web.db`, `timeline.db` and its WAL beside it — sat in this repository's
 * index for several commits.
 *
 * IT WAS THE WRONG POPULATION, and that is the whole account. The assertion
 * read the TEXT of `.gitignore` and required it to CONTAIN the substring
 * `.bridlewise/`. The substring was there. It always was, and it always
 * will be — but the defect could not be in that file, because the defect was
 * a directory named `.bridlewise.fresh-evidence-<epoch>/`, which that
 * pattern does not match, and a set of blobs in the git INDEX, which a rules
 * file cannot report. A guard reading the rule instead of the thing the rule
 * governs certifies its author's intention, never the outcome.
 *
 * So both halves now ask an instrument that could actually disagree:
 *
 *   1. the git INDEX, at EVERY depth — the state the defect was in;
 *   2. `git check-ignore`, i.e. git's own matcher — driven against the live
 *      key's path AND against a suffixed sibling, which is the spelling that
 *      got through.
 *
 * ── AND THE ABSENCE ASSERTION CARRIES A WITNESS ───────────────────────────
 *
 * "No tracked path is a key" is indistinguishable from "the instrument was
 * pointed at the wrong tree" — both return zero. So the same `git ls-files`
 * output that must NOT hold a key is required to hold `server/db-crypto.ts`,
 * the module that writes the key. Zero findings plus a present witness is
 * evidence; zero findings plus an absent witness is a broken instrument, and
 * is refused.
 *
 * Depth is the point of this file's half. `tests/prevention/
 * declared-root-inventory.test.ts` covers the same class at this root and
 * only at this root: it is a depth-1 walk, so it would see
 * `.bridlewise.fresh-evidence-<epoch>/` and would NOT see a key committed
 * under, say, `engine/fixtures/`. This one is depth-unbounded and
 * secret-specific. Neither subsumes the other.
 *
 * Also: prevention — the auto-checks list endpoints are mechanically
 * non-overlapping (project list = chat_id IS NULL; chat list = chat_id =?)
 * and createAutoCheck is an upsert (dedup). A regression that drops the
 * `chat_id IS NULL` filter or the dedup lookup fails this test loudly.
 */
import { describe, test, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DbClient } from "../../server/db/client.ts";
import { databaseKeyFile } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { createKeyHome, createTempDir } from "../helpers/temp-dir.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const CLIENT = modulePathMatching("server/db/client.ts");

/** The witness: tracked, and the module whose key admission decides where every database key goes. */
const WITNESS = modulePath("db-crypto.ts");

/** Every path the index holds, read as bytes rather than counted by grep. */
function trackedPaths(): readonly string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

describe("proactive: the persisted encryption key is never committed", () => {
  test("no tracked path is a key file or sits under a harness state directory", () => {
    const tracked = trackedPaths();

    // WITNESS FIRST (§ absence needs a witness): if this is missing, the scan
    // below is looking somewhere that contains nothing and its zero means
    // nothing. Asserted before the finding, so a broken instrument cannot be
    // read as a clean tree.
    expect(
      tracked,
      `the tracked-path scan did not find ${WITNESS}, so it is not reading this repository's index — ` +
        "its empty answer below would be about the instrument, not about the tree",
    ).toContain(WITNESS);

    // THE FINDING, at every depth and on both spellings: the key file by its
    // own name, and anything under a harness state directory however that
    // directory happens to be suffixed. The committed instance was
    // `.bridlewise.fresh-evidence-<epoch>/`, so an exact-name match here
    // would reproduce the original blindness.
    const committedSecrets = tracked.filter((path) => {
      const segments = path.split("/");
      const basename = segments[segments.length - 1] ?? "";
      if (basename === "db-key") return true;
      return segments.slice(0, -1).some((segment) => /^\.bridlewise(\..*)?$/u.test(segment));
    });
    expect(
      committedSecrets,
      `these paths are in the git index and must not be: ${committedSecrets.join(", ")}. ` +
        "A committed db-key makes the at-rest encryption of every database beside it worthless. " +
        "Remove them with `git rm -r --cached <path>` and make sure an ignore rule names them.",
    ).toEqual([]);
  });

  test("git itself ignores the key's home AND any suffixed sibling of it", () => {
    // ASKING GIT, NOT THE RULES FILE. A substring of `.gitignore` proves the
    // author's intention; `check-ignore` is the matcher that actually decides,
    // and it is the only thing that can say whether the SUFFIXED spelling —
    // the one that got through — is covered now.
    // `check-ignore -q` exits 0 when the path IS ignored and 1 when it is not.
    // BOTH ARE VERDICTS; EVERYTHING ELSE IS A BROKEN INSTRUMENT, AND THE
    // DIFFERENCE IS LOAD-BEARING HERE. This read `execFileSync` inside
    // `try { … } catch { return false }`, which is fail-safe for the five
    // expectations below — they all require `true` — and fail-OPEN for the
    // CONTROL, which requires `false`. Any exception at all (git absent, a cwd
    // that is not a repository, exit 128) made the control pass while proving
    // nothing, so the one assertion that keeps the loop honest was the one an
    // error could satisfy. `spawnSync` returns the status as DATA and it is
    // judged, the way `tracked-source-owner.test.ts` and `staged-move-loss.ts`
    // already do it.
    const ignored = (path: string): boolean => {
      const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", path], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(
          `git check-ignore could not answer for ${path} (status ${String(result.status)}): ` +
            `${result.stderr}. A crashed matcher is not "the path is not ignored".`,
        );
      }
      return result.status === 0;
    };

    for (const path of [
      ".bridlewise/db-key",
      ".bridlewise/web.db",
      // The exact shape that was committed, and a shape nobody has created
      // yet — a rule that only covers the instance is not covering the class.
      ".bridlewise.fresh-evidence-1785461259/db-key",
      ".bridlewise.some-suffix-nobody-has-written-yet/timeline.db",
      ".bridlewise.archived.tar",
    ]) {
      expect(ignored(path), `git does not ignore ${path}, so a run that writes it can commit it`).toBe(
        true,
      );
    }

    // CONTROL, so the loop above is not passing because everything is ignored:
    // a tracked file whose name is deliberately adjacent must NOT be ignored.
    expect(
      ignored("engine/bridlewise.config.json"),
      "engine/bridlewise.config.json is tracked and must not be ignored — if it is, the " +
        "harness-state rules have reached past the place they name",
    ).toBe(false);
  });

  test("a database's key lives in the key home, 0600, never beside the database (nothing there to commit)", () => {
    // BEHAVIOUR, NOT SPELLING: the key owner (persisted-key.ts, via db-crypto's
    // one admission) decides where the key goes; a source grep for a path
    // expression outlived the key's move out of the state folder (SEC-d).
    const dir = createTempDir("key-location-"), dbPath = join(dir, "web.db"), keyHome = createKeyHome("key-location-keys-");
    new DbClient({ path: dbPath, keyHome }).close();
    const keyFile = databaseKeyFile(keyHome, dbPath);
    expect(statSync(keyFile).mode & 0o777, "the key is owner-only").toBe(0o600);
    expect(relative(keyHome, keyFile).startsWith(".."), "the key is inside the key home").toBe(false);
    expect(readdirSync(dir).filter((name) => !name.startsWith("web.db")), "nothing but the database's own files beside it").toEqual([]);
  });
});

describe("prevention: auto-checks are dedup'd + chat/project lists are non-overlapping", () => {
  const src = readFileSync(CLIENT, "utf8");

  test("listAutoChecksByProject returns ONLY project-level checks (chat_id IS NULL)", () => {
    // The fix for "lint/checks show under both chat AND project": the project
    // list must filter chat_id IS NULL so chat-scoped checks don't leak in.
    expect(src, "project list must filter chat_id IS NULL").toContain(
      "WHERE project_id = ? AND chat_id IS NULL",
    );
  });

  test("listAutoChecksByChat returns ONLY chat-scoped checks (chat_id =?)", () => {
    expect(src, "chat list must filter chat_id = ?").toContain("WHERE chat_id = ?");
  });

  test("createAutoCheck is an upsert (dedup on check_name + project_id + chat_id)", () => {
    // The fix for "the same tool shows twice under the same thing": re-running
    // a check must UPDATE the existing row, not INSERT a duplicate.
    expect(src, "dedup lookup must key on check_name + project_id + chat_id").toContain(
      "WHERE check_name = ? AND project_id IS ? AND chat_id IS ?",
    );
    expect(src, "dedup must UPDATE the existing row").toContain("UPDATE auto_checks SET");
  });
});
