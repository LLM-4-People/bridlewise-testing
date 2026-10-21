// @vitest-environment node
/**
 * Prevention test: there is ONE error-code vocabulary, and the client's
 * user-facing message table is a PROJECTION of it — not a second table.
 *
 * ── The defect ──
 *
 * `src/data/error-messages.ts` hand-maintained ~25 codes with no
 * link of any kind to `shared/errors.ts`. Eight of them
 * (`csrf_blocked`, `auth_failed`, `forbidden`, `rate_limited`, …) were not
 * in the taxonomy at all. Two independent lists of the same vocabulary
 * drift silently in both directions: a code added to the taxonomy shows
 * the user a raw technical string, and a code deleted from the server
 * keeps a message here forever. Neither drift is visible until a user
 * reads the wrong sentence.
 *
 * ── What is verified ──
 *
 * A. Direction: the projection depends on the taxonomy owner (a real
 *    import), and EVERY key it declares is a code that owner declares.
 * B. Completeness by DERIVATION, not by hand: a taxonomy code with no
 *    bespoke sentence still yields a message appropriate to its resolved
 *    status — so the table never has to grow just to avoid a raw string,
 *    which is what made the old table sprawl in the first place.
 * C. No SECOND table, by DYNAMIC DISCOVERY: no file under `src/` or
 *    `server/` other than the taxonomy owner and this one projection maps
 *    a set of taxonomy codes as object keys. No allowlist of file names
 *    beyond the two owners; a third table anywhere is caught the moment
 *    it appears. The scan runs over comment-stripped source (the shared
 *    `stripCommentsOnly` owner) so documentation that MENTIONS codes is
 *    not mistaken for a table — and, conversely, a table cannot hide by
 *    being described in a comment.
 * D. The projection still behaves (it is not "fixed" by being emptied).
 *
 * ── Mutation-verified ──
 * Adding a key to `MESSAGE_FOR_CODE` that the taxonomy does not declare
 * makes A FAIL. Removing the `shared/errors` import makes A FAIL.
 * Deleting the derived-status branch makes B FAIL. Pasting a second
 * code→text table into another module makes C FAIL.
 */
import { describe, test, expect } from "vitest";

import {
  MESSAGE_FOR_CODE,
  formatErrorMessage,
} from "../../src/data/error-messages.ts";
import {
  CODE_STATUS_MAP,
  KNOWN_ERROR_CODES,
  isKnownErrorCode,
  statusForCode,
} from "../../shared/errors.ts";
import { walk, relpath, read, stripCommentsOnly } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const PROJECTION_FILE = modulePath("error-messages.ts");
const TAXONOMY_FILE = "shared/errors.ts";

describe("A. the message table is a projection of the taxonomy, not an independent list", () => {
  test("the projection imports the taxonomy owner (the dependency is real, not aspirational)", () => {
    const src = stripCommentsOnly(read(PROJECTION_FILE));
    expect(
      src,
      "error-messages.ts must import from shared/errors — without it the two " +
        "vocabularies are unrelated and free to drift",
    ).toMatch(/from\s+["'][^"']*shared\/errors["']/);
  });

  test("the taxonomy is non-empty (a broken import must not make this guard vacuous)", () => {
    expect(KNOWN_ERROR_CODES.length).toBeGreaterThan(20);
    expect(Object.keys(MESSAGE_FOR_CODE).length).toBeGreaterThan(10);
  });

  test("every code the projection names is declared by shared/errors.ts", () => {
    const undeclared = Object.keys(MESSAGE_FOR_CODE).filter((c) => !isKnownErrorCode(c));
    expect(
      undeclared,
      "these codes have a user-facing message but no place in the taxonomy — the " +
        "message is either dead or the code belongs in shared/errors.ts",
    ).toEqual([]);
  });

  test("the config write lock timeout declares its status value and its sentence (503, not a silent 500)", () => {
    // A designed, retryable refusal: the server would not perform an
    // unlocked config write while another process held the cross-process
    // lock. The map entry IS the declaration, so both ends are pinned as
    // VALUES through the owners' own resolutions — a silently dropped or
    // renumbered entry cannot fall back to the undocumented 500, and a
    // deleted sentence cannot collapse the refusal into the generic
    // server-error text that misnames it.
    expect(statusForCode("config_write_lock_timeout")).toBe(503);
    const out = formatErrorMessage({
      code: "config_write_lock_timeout",
      message: "could not acquire the config write lock",
      statusCode: undefined,
    });
    expect(out).toContain("was not saved");
    expect(out).toContain("Try again");
  });
});

describe("B. codes with no bespoke sentence are DERIVED, never left raw", () => {
  test("every taxonomy code produces a message that is not just the technical string", () => {
    // Pick codes the projection deliberately does NOT name — the ones that
    // would previously have fallen through to the raw message.
    const unnamed = Object.keys(CODE_STATUS_MAP).filter(
      (c) => MESSAGE_FOR_CODE[c] === undefined,
    );
    expect(unnamed.length, "there must be codes exercising the derived path").toBeGreaterThan(0);

    const raw = "ENOENT: no such file or directory, open '/etc/shadow'";
    const notDerived = unnamed.filter(
      (code) => formatErrorMessage({ code, message: raw, statusCode: undefined }) === raw,
    );
    expect(
      notDerived,
      "a taxonomy code must resolve to a human sentence via its status, not fall " +
        "through to the raw technical message",
    ).toEqual([]);
    // The 202 wait contract is a status sentence too (quick_view_not_ready
    // has no bespoke entry, but must never show the raw technical text).
    expect(
      formatErrorMessage({ code: "quick_view_not_ready", message: "not ready yet", statusCode: undefined }),
    ).toMatch(/still working|fill in/i);
  });

  test("a code the taxonomy does NOT declare still degrades honestly to its raw message", () => {
    // Deny-by-default cuts both ways: an unknown code is not silently given
    // a comforting sentence, and the error is never hidden.
    const out = formatErrorMessage({
      code: "not_a_real_code_at_all",
      message: "Something unexpected happened",
      statusCode: undefined,
    });
    expect(out).toBe("Something unexpected happened");
  });
});

describe("C. no second error-code table can exist (dynamic discovery)", () => {
  /**
   * A file "declares a code table" when it uses several DISTINCT taxonomy
   * codes as object keys (`some_code: ...`). One or two are incidental (a
   * single typed throw, a test fixture); a handful is a table.
   */
  const TABLE_THRESHOLD = 4;

  function codeKeysIn(src: string): string[] {
    const stripped = stripCommentsOnly(src);
    const hits = new Set<string>();
    const keyRe = /(?:^|[{,\s])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/gm;
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(stripped)) !== null) {
      if (isKnownErrorCode(m[1]!)) hits.add(m[1]!);
    }
    return [...hits];
  }

  const offenders: { file: string; codes: string[] }[] = [];
  for (const root of ["src", "server"]) {
    for (const file of walk(root, { exts: [".ts", ".svelte"] })) {
      const rel = relpath(file);
      if (rel === PROJECTION_FILE || rel === TAXONOMY_FILE) continue;
      const codes = codeKeysIn(read(file));
      if (codes.length >= TABLE_THRESHOLD) offenders.push({ file: rel, codes: codes.sort() });
    }
  }

  test("the scan actually detects tables (anchor: the two known owners are found)", () => {
    // If the detector were broken, C would pass trivially. Point it at the
    // two files that ARE tables and require it to see them.
    expect(codeKeysIn(read(PROJECTION_FILE)).length).toBeGreaterThanOrEqual(TABLE_THRESHOLD);
    expect(codeKeysIn(read(TAXONOMY_FILE)).length).toBeGreaterThanOrEqual(TABLE_THRESHOLD);
  });

  test("only shared/errors.ts and the single projection map error codes as keys", () => {
    expect(
      offenders.map((o) => `${o.file} [${o.codes.join(", ")}]`),
      `a second error-code table. The taxonomy lives in ${TAXONOMY_FILE}; the ONE ` +
        `user-facing projection lives in ${PROJECTION_FILE}. Derive from those instead ` +
        "of restating the vocabulary",
    ).toEqual([]);
  });
});

describe("D. the projection still does its job", () => {
  test("a typed code beats the generic status text", () => {
    const typed = formatErrorMessage({
      code: "preimage_mismatch",
      message: "preimage mismatch",
      statusCode: 409,
    });
    expect(typed).toContain("changed on disk");
    expect(typed).not.toContain("preimage");
  });

  test("an offline transport is never reported as a rate limit", () => {
    const out = formatErrorMessage({
      code: "network",
      message: "Failed to fetch",
      statusCode: undefined,
    });
    expect(out).toContain("Server offline");
    expect(out).not.toContain("Too many requests");
  });
});
