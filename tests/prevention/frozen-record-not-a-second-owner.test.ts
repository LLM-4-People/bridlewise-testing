// @vitest-environment node
/**
 * A COPY IN A FROZEN ARCHIVE IS A RECORD. WHAT MAKES A COPY A SECOND **OWNER**
 * IS A CONSUMER — AND AN OWNERSHIP DECLARATION THAT LIVES ONLY THERE.
 *
 * ── THE DEFECT, MEASURED ──────────────────────────────────────────────────
 *
 * `docs/history/src-shared-workflow/manifest-schema.mjs` is 91% identical to
 * `engine/src/shared/workflow/manifest-schema.mjs` (170 of 186 lines, the
 * whole divergence in the header). It opens with
 *
 *     // This is the SINGLE canonical owner of the merge-manifest format.
 *     // … do NOT duplicate this validator.
 *
 * and its first line names `src/shared/workflow/manifest-schema.mjs`, a path
 * that is not its own. It is imported by NOTHING — measured below — while the
 * live file, which `scripts/harness-root/merge-round.mjs` imports and which is
 * executed on every suite run, declared no ownership at all.
 *
 * So the marker sat on the copy nobody can reach and was missing from the copy
 * everybody reaches. A reader grepping for "canonical owner" lands in a frozen
 * archive and edits a record; a reader opening the live file finds nothing
 * saying it may not be forked. `e2e-runner.mjs` is the same pair, same
 * directory, same shape.
 *
 * ── WHY THE ANSWER IS NOT TO DELETE THE ARCHIVED COPY ─────────────────────
 *
 * `docs/history/README.md` is explicit: everything there except nine named
 * files is a record, read as evidence of what happened and never as
 * instruction, and its paths are part of the measurement rather than stale
 * references waiting to be fixed. Seven files there carry SHA-256 digests over
 * exact bytes at exact paths. Editing a record to tidy it falsifies it while
 * leaving it looking like proof, which is worse than a broken link because a
 * broken link announces itself. `engine/experiments/` used to be the second
 * such root; it left the index with the clean-root work, and the records now
 * live under `experiments/engine/` on the testing floor (tracked there,
 * ignored on master) — so it is no longer a population this guard can
 * measure, and an archive no clone receives cannot become a second
 * owner of anything the suite builds.
 *
 * ── SO THE DISCRIMINATOR IS DRIVEN, NOT ASSERTED ──────────────────────────
 *
 * "It is a record, not a second owner" is a claim about REACHABILITY, and a
 * claim about reachability is measurable. Byte similarity is not the
 * discriminator and cannot be: a metric that ranks by identical lines selects
 * records above forks, because a record is a perfect copy of what a file once
 * was. Two arms, one per half of the claim:
 *
 *   1. nothing outside a frozen-record root references a file inside one;
 *   2. an ownership declaration inside one has a live counterpart carrying it.
 *
 * Arm 1 is what makes the archive harmless. Arm 2 is what stops the marker
 * drifting back onto the unreachable copy.
 *
 * ── §41 — WHERE THIS WAS SEARCHED FOR BEFORE IT WAS WRITTEN ───────────────
 *
 * Nothing owned this. `tests/prevention/tasks-no-stale-duplicates.test.ts` is
 * the only test in the suite that names `docs/history/` and its subject is
 * checkbox drift inside one Markdown file. `no-rule-refs.test.ts` walks
 * `src`, `server`, `tests`, `shared` and `scripts` and never reaches either
 * archive root. `declared-root-inventory.test.ts` classifies the root's
 * immediate children and says nothing about what is inside `docs/`. The
 * `*-owner.test.ts` family each owns one runtime capability, none of them
 * this. Neither §41 question answered yes, so this is a new file.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { stripCommentsOnly } from "../helpers/source-scan.ts";
import { presentTrackedFiles } from "../../engine/src/git/repository-ownership.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const ROOT = process.cwd();

/**
 * The roots whose tracked files are RECORDS of closed work: the ONE
 * declaration (`ROOT_POLICY.verification.frozenRecordRoots`), shared with the
 * dead-link scan and the frozen-records manifest — where closed rounds'
 * records are kept and never edited (`docs/history/README.md` says everything
 * in it but nine named files is a record). Nothing in this file trusts the
 * list: every claim below is a measurement over what the roots contain.
 */
const FROZEN_ROOTS: readonly string[] = ROOT_POLICY.verification.frozenRecordRoots;

/** The commit the frozen archives are read at: this checkout's own (the records are tracked beside the work; what ships is the promotion profile's answer, and it never ships them). */
const FLOOR_BRANCH = "HEAD";

/** Extensions a reference could be an import of, rather than prose about one. */
const SOURCE_EXTS: readonly string[] = [".mjs", ".cjs", ".js", ".ts", ".svelte"];

function gitArgs(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Every path tracked on THIS worktree's branch that is present on disk. The
 * live counterpart of a frozen record is READ from disk, so a tracked file
 * deleted in the working tree (an unstaged deletion) is not one: the shared
 * ownership reader answers that (a raw `ls-files` crashed this scan with
 * ENOENT on the first unstaged deletion — wf1a-correctness §6).
 */
function trackedPaths(): readonly string[] {
  const present = presentTrackedFiles(ROOT);
  if (present === undefined) throw new Error(`${ROOT} is not a git working tree`);
  return present;
}

/**
 * Every path TRACKED on the floor under a frozen root, repo-relative. The
 * archive itself is the subject — and master no longer tracks it, so the
 * scan has to read the floor's tree rather than the worktree's index.
 */
function frozenTrackedPaths(): readonly string[] {
  return gitArgs(["ls-tree", "-r", "--name-only", FLOOR_BRANCH, "--", ...FROZEN_ROOTS], ROOT)
    .split("\n")
    .filter((entry) => entry.length > 0);
}

/**
 * One frozen record's bytes, read from the floor's ref. A record's content is
 * the thing a live file could duplicate — the disk underneath master no
 * longer holds it, by design.
 */
function readFrozen(path: string): string {
  return gitArgs(["show", `${FLOOR_BRANCH}:${path}`], ROOT);
}

function isFrozen(path: string): boolean {
  return FROZEN_ROOTS.some((root) => path.startsWith(root));
}

describe("a copy in a frozen archive is a record, and a record has no consumers", () => {
  // The LIVE half is this worktree's tracked source (master). The FROZEN half
  // is the floor's tracked source under the archive roots — the archive
  // itself, read from `testing`, because master deliberately tracks none of
  // it. Reading the archive from the floor is what lets the two halves be
  // non-empty on BOTH branches: a fresh clone of either side has its own
  // branch ref, and the floor's tree travels with every clone.
  const tracked = trackedPaths();
  const frozenTracked = frozenTrackedPaths();
  const frozenSources = frozenTracked.filter((p) => SOURCE_EXTS.some((e) => p.endsWith(e)));

  test("both halves of the population are non-empty, or every verdict below is free", () => {
    // §36: "nothing references the archive" and "the scan looked at nothing"
    // are the same empty set. Each root must contribute, so a root that was
    // renamed or emptied reds here rather than certifying itself.
    expect(tracked.length, "git ls-files returned nothing").toBeGreaterThan(0);
    expect(
      frozenSources.length,
      `source files under the frozen roots on ${FLOOR_BRANCH}: ${frozenSources.length} (${frozenSources.join(", ")})`,
    ).toBeGreaterThan(0);
    for (const root of FROZEN_ROOTS) {
      expect(
        frozenTracked.some((p) => p.startsWith(root)),
        `${root} holds no tracked path on ${FLOOR_BRANCH}, so it is not the record root this guard was written for`,
      ).toBe(true);
    }
  });

  test("nothing OUTSIDE a frozen root reaches a source file inside one", () => {
    // THE ARM THAT MAKES THE DUPLICATE HARMLESS. A record that something
    // imports has stopped being a record: it is a second owner that happens to
    // sit in an archive, and it will drift from the live one in the direction
    // nobody is watching.
    //
    // Searched by BASENAME as well as by path, because an importer writes
    // `./manifest-schema.mjs` and never the archive's full path — the exact
    // pattern-shape error that once reported zero importers where there were
    // ten. A basename hit outside the frozen roots is only a finding when the
    // reference RESOLVES into one, so the two are separated below.
    const outside = tracked.filter(
      (p) => !isFrozen(p) && SOURCE_EXTS.some((e) => p.endsWith(e)),
    );
    expect(outside.length, "no source file outside the frozen roots was scanned").toBeGreaterThan(0);

    // ── COMMENTS OUT, STRINGS IN, AND THE VIEW IS WITNESSED ────────────────
    //
    // A MENTION IS NOT A REFERENCE, and the first version of this arm could
    // not tell them apart: it reported the two live owners as consumers of
    // their own archived copies, because their headers NAME those copies while
    // explaining why they are records. Prose about a path is the opposite of a
    // dependency on it.
    //
    // So comments go and STRINGS STAY — the shared `stripCommentsOnly`, not
    // `stripCommentsAndStringsFor`, because a module specifier and a path literal
    // ARE string literals and a scan run over the string-blanking view sees an
    // empty import list and passes vacuously. That view is the reason two
    // mutations escaped a round here once, so the view is asserted rather than
    // assumed: a real importer's specifier must survive the strip.
    const witnessFile = "scripts/harness-root/merge-round.mjs";
    const witnessSpecifier = modulePath("manifest-schema.mjs");
    const witnessView = stripCommentsOnly(readFileSync(join(ROOT, witnessFile), "utf8"));
    expect(
      witnessView.includes(witnessSpecifier),
      `${witnessFile} imports ${witnessSpecifier} and the stripped view no longer contains it, ` +
        `so this scan is reading a view with its subject blanked out and every "no reference" ` +
        `answer below would be about the stripper`,
    ).toBe(true);

    const offenders: string[] = [];
    let scanned = 0;
    for (const consumer of outside) {
      // Bytes, not `grep`: a NUL in a source file makes GNU grep print nothing
      // and exit cleanly, which is a silently smaller universe.
      const source = stripCommentsOnly(readFileSync(join(ROOT, consumer), "utf8"));
      scanned += 1;
      for (const record of frozenSources) {
        if (!source.includes(record)) continue;
        offenders.push(`${consumer} names the frozen record ${record}`);
      }
    }
    expect(scanned, `files scanned for a reference into an archive: ${scanned}`).toBeGreaterThan(0);
    expect(
      offenders,
      `${offenders.length} reference(s) reach into a frozen record root. A record that something ` +
        `reads is a second owner of whatever it copies, and it drifts in the direction nobody ` +
        `watches. Point the consumer at the live owner:\n` +
        offenders.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);
  });

  test("an ownership declaration inside a frozen root has a LIVE counterpart carrying it", () => {
    // THE ARM THAT KEEPS THE MARKER ON THE REACHABLE FILE. Discovered from the
    // archive's own text rather than from a list of the two known files, so a
    // third one gets the same treatment the day it lands.
    const CLAIM = /SINGLE canonical owner|canonical owner|do NOT duplicate/iu;
    // The declaration is discovered from the ARCHIVE's own text, read off the
    // floor — master deliberately no longer holds the archive's bytes.
    const claiming = frozenSources.filter((p) => CLAIM.test(readFrozen(p)));
    // LIVENESS: the detector must have found something, or the loop below is a
    // pass over an empty set wearing a verdict.
    expect(
      claiming.length,
      `frozen records declaring ownership: ${claiming.join(", ") || "none"}`,
    ).toBeGreaterThan(0);

    const live = tracked.filter((p) => !isFrozen(p) && SOURCE_EXTS.some((e) => p.endsWith(e)));
    const orphaned: string[] = [];
    for (const record of claiming) {
      const counterparts = live.filter((p) => basename(p) === basename(record));
      if (counterparts.length === 0) {
        orphaned.push(`${record} declares ownership and no live file shares its name`);
        continue;
      }
      const declaring = counterparts.filter((p) => CLAIM.test(readFileSync(join(ROOT, p), "utf8")));
      if (declaring.length === 0) {
        orphaned.push(
          `${record} declares ownership; its live counterpart(s) ${counterparts.join(", ")} declare none`,
        );
      }
    }
    expect(
      orphaned,
      `${orphaned.length} ownership declaration(s) live only in a frozen archive. The marker ` +
        `belongs on the file the consumers reach — a reader grepping for it lands in a record ` +
        `and edits history. Copy the declaration onto the live owner; do NOT edit the record, ` +
        `whose bytes at that path are the evidence:\n` +
        orphaned.map((o) => `  - ${o}`).join("\n"),
    ).toEqual([]);
  });
});
