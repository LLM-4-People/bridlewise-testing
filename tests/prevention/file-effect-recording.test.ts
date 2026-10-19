// @vitest-environment node
/**
 * Mechanical enforcement: a file effect CANNOT happen unrecorded.
 *
 * THE MEASURED DEFECT
 *
 * `recordFileEffect` — the ledger's purpose-built API for "this path changed,
 * here is the before digest and the after digest" — existed, was fully
 * designed, and had ZERO production callers. The ledger could say which tools
 * ran and could not say what any of them did to the user's code. The file lane
 * of the timeline was structurally empty, not sparsely populated.
 *
 * WHY RECORDING AT THE BRIDGE IS THE WHOLE FIX
 *
 * `server/editor-bridge.ts` is the single in-process owner of file
 * write/mkdir/delete — proven separately by `editor-bridge-owner.test.ts`,
 * which is what makes three call sites sufficient. Every save from the editor,
 * every create and delete from the file tab, and every write an agent makes
 * through the tool executor's editor tools funnels through `writeFileRaw`,
 * `createDirectory` and `deleteFile`. No upstream call site was changed and
 * none has to remember anything.
 *
 * Assurance classes:
 *   A. Discovery is live.
 *   B. DENY-BY-DEFAULT, DYNAMIC — every function in the bridge that calls a
 *      MUTATING fs primitive also records a file effect. A new write path in
 *      the bridge is caught the moment it is written.
 *   C. DENY-BY-DEFAULT, DYNAMIC — the single-writer claim the fix rests on: no
 *      other module under `server/` mutates the filesystem except the
 *      documented non-project writers, each with a reason. If a second writer
 *      of project files appears, recording at the bridge stops being
 *      sufficient and this fails.
 *   D. Behavioural — a real write, mkdir and delete each land in the real
 *      ledger as a `file-effect` event with the right operation.
 *   E. Behavioural — the digests are REAL: the postimage digest is the digest
 *      of the bytes actually written, and the preimage digest is the digest of
 *      the bytes actually replaced. A recorded digest that does not match is
 *      worse than no ledger at all.
 *
 * Mutation-verified — see the report accompanying this change: removing the
 * `recordFileEffect` call from `writeFileRaw` fails B and D; recording the new
 * content as the preimage fails E.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { read, walk, relpath, stripCommentsOnly } from "../helpers/source-scan.ts";
import { bodyCalls, functionsCalling, type SourceScope } from "../helpers/function-scope.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { writeFileRaw, createDirectory, deleteFile, createFile } from "../../server/filesystem/editor-bridge.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { withRecordingContext } from "../../server/kernel/canonical.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const BRIDGE = modulePath("editor-bridge.ts");

/** The fs primitives that CHANGE the filesystem (reads are not effects). */
// `atomicWriteFile` is in this list and is not an `fs` primitive: it is the
// shared owner of "write a temp file and rename it over the target", and a
// module that calls it changes the filesystem exactly as much as one that
// calls `writeFileSync`. Leaving it out would have quietly removed the
// bridge's own write path from class B the moment it started using the owner
// — the scan would have reported no unrecorded mutators because it had
// stopped recognising the mutation.
const MUTATING_FS = ["writeFileSync", "renameSync", "mkdirSync", "rmSync", "unlinkSync", "appendFileSync", "copyFileSync", "rmdirSync", "truncateSync", "atomicWriteFile"];
const MUTATING_FS_RE = new RegExp(`\\b(${MUTATING_FS.join("|")})\\s*\\(`);

/**
 * Modules that mutate the filesystem WITHOUT going through the editor bridge,
 * each with the reason it is not a project-file write. This list is the
 * single-writer claim, written down: recording at the bridge covers every file
 * effect precisely because nothing else writes the user's project.
 *
 * A new entry here is a deliberate statement that the write is not a project
 * file. A new writer that is NOT listed fails the test.
 */
const NON_PROJECT_WRITERS: Readonly<Record<string, string>> = Object.freeze({
  "server/filesystem/editor-bridge.ts": "the owner — this is the choke point that records",
  "server/observability/timeline-bridge.ts": "creates the ledger directory + the ledger-id sidecar under .bridlewise (harness state, not user code)",
  "server/db/db-files.ts": "creates and removes the database's own pre-migration copies beside it (harness state, not user code); the key file is written by the engine key owner",
  "server/db/client.ts": "creates the database directory (harness state, not user code)",
  "server/kernel/harness-config.ts": "writes the harness config file itself; edits arrive through the config route, which is its own owner",
  "server/routes/filesystem.ts": "the folder picker creates a directory BEFORE a project exists, so there is no project to attribute it to; guarded by assertWithinAllowedRoots",
  "server/safety/landlock-runner.ts": "writes the guardian's rules into a private scratch directory it creates per command and removes when the command ends; the file never leaves that directory and is not user code",
  "server/db/conversation-archive.ts": "the conversation archive (`npm run db-archive`, server stopped): writes one archive file into the database's own archive folder beside it (harness state, never user code; UD-S15)",
  "server/db/key-rotation.ts": "the database key tool (`npm run db-key`): publishes and removes key and salt files in the key home and beside legacy databases, and moves a staged key into place through the move owner; harness state, never user code",
});

// ── Source parsing ──
//
// THIS FILE USED TO CARRY ITS OWN BODY FINDER — an `indexOf("{", …)` plus a
// depth counter, and a `/^(?:export\s+)?function\s+(\w+)\s*\(/gm` to find the
// declarations. Both halves have measured failure modes this workspace has
// already paid for: the declaration pattern cannot see `export async function`,
// and the brace walk returns the RETURN TYPE for anything typed `Readonly<{ … }>`
// and TWO BYTES for anything with `options: Options = {}`. A two-byte body makes
// every `.test(f.body)` false, so `MUTATORS` — the population class B iterates —
// would be silently EMPTY and the run would be green.
//
// The shared owner answers both questions with a parser that is differentiated
// against a SECOND parser over every named function in both production trees,
// every run. `functionsCalling` is the exact door for "which functions here
// call one of these", so the mutator population is a call-graph fact rather
// than a text match: a `writeFileSync` named in a comment no longer counts.

const BRIDGE_SOURCE = read(BRIDGE);

/** Every named function in the bridge — the population class A proves is live. */
const BRIDGE_FUNCTIONS = [...new Set(
  MUTATING_FS.concat(["readFileSync", "existsSync", "statSync", "recordFileEffect"])
    .flatMap((callee) => {
      try {
        return functionsCalling(BRIDGE_SOURCE, callee, BRIDGE).map((scope) => scope.name);
      } catch {
        return [];
      }
    }),
)];

/** Bridge functions that change the filesystem, from the CALL GRAPH. */
const MUTATORS: readonly SourceScope[] = (() => {
  const byName = new Map<string, SourceScope>();
  for (const callee of MUTATING_FS) {
    for (const scope of functionsCalling(BRIDGE_SOURCE, callee, BRIDGE)) byName.set(scope.name, scope);
  }
  return [...byName.values()];
})();

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Behavioural fixture ──

type FileEffect = Readonly<{
  path: string;
  operation: string;
  preimageDigest: string;
  postimageDigest: string;
}>;

/**
 * The file effects the real ledger holds for `path`. Reads back through the
 * public query, so this exercises the whole chain — recorder, store, query —
 * rather than a captured call argument.
 */
function recordedEffectsFor(path: string): FileEffect[] {
  const result = getTimelineQuery().byEventType("file-effect", { limit: 500, ascending: false });
  const out: FileEffect[] = [];
  for (const event of result.events) {
    for (const doc of event.documents ?? []) {
      if (doc.name !== "effect" || typeof doc.contentJson !== "string") continue;
      const parsed = JSON.parse(doc.contentJson) as FileEffect;
      if (parsed.path === path) out.push(parsed);
    }
  }
  return out;
}

let projectDir: string;

beforeAll(() => {
  projectDir = createTempDir("ch-file-effect-");
});

// ── A. discovery is live ──

describe("A. file-effect discovery is live (nothing below can pass vacuously)", () => {
  test("the bridge parsed into functions, some of which mutate the filesystem", () => {
    expect(BRIDGE_FUNCTIONS.length, `no functions parsed from ${BRIDGE} — the scan is broken: ${BRIDGE_FUNCTIONS.join(", ")}`).toBeGreaterThan(5);
    expect(
      MUTATORS.map((f) => f.name),
      "no filesystem-mutating function found in the bridge — class B would be vacuous",
    ).not.toEqual([]);
    expect(MUTATORS.length, `filesystem-mutating bridge functions: ${MUTATORS.map((f) => f.name).join(", ")}`).toBeGreaterThanOrEqual(3);
  });
});

// ── B. every write path in the bridge records ──

describe("B. no filesystem mutation in the bridge is unrecorded", () => {
  test("every bridge function that mutates the filesystem also records a file effect", () => {
    const offenders = MUTATORS.filter((f) => !bodyCalls(f, "recordFileEffect")).map(
      (f) => `${BRIDGE}::${f.name} changes the filesystem without recording a file effect`,
    );
    expect(
      offenders,
      "recording must be a property of performing the work, not a call somebody remembered to add:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  test("the recorder is reached through the timeline bridge (one ledger owner)", () => {
    const src = stripCommentsOnly(read(BRIDGE));
    expect(src, "the bridge must take its recorder from the single timeline owner").toMatch(
      /from\s+["']\.\.\/observability\/timeline-bridge\.ts["']/,
    );
  });
});

// ── C. the single-writer claim the fix rests on ──

describe("C. nothing outside the bridge writes the user's project", () => {
  test("every server module that mutates the filesystem is the bridge or a documented non-project writer", () => {
    const offenders: string[] = [];
    for (const file of walk("server", { exts: [".ts"] })) {
      const rel = relpath(file);
      if (NON_PROJECT_WRITERS[rel] !== undefined) continue;
      const code = stripCommentsOnly(read(rel));
      const used = MUTATING_FS.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(code));
      if (used.length > 0) offenders.push(`${rel} calls ${used.join(", ")} — a second writer means recording at the bridge no longer covers every file effect`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("every documented non-project writer still exists and still carries a reason", () => {
    const stale: string[] = [];
    for (const [rel, reason] of Object.entries(NON_PROJECT_WRITERS)) {
      const code = stripCommentsOnly(read(rel));
      const mutates = MUTATING_FS.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(code));
      if (!mutates) stale.push(`${rel} — listed as a writer but no longer writes`);
      if (reason.trim().length === 0) stale.push(`${rel} — exemption has no reason`);
    }
    expect(stale, "a stale exemption silently excuses a writer that is not there, and hides one that is").toEqual([]);
  });
});

// ── D + E. behavioural: the effects land, and the digests are real ──

describe("D. every kind of file effect reaches the ledger", () => {
  test("a write is recorded with its real before/after digests", () => {
    const path = join(projectDir, "written.ts");
    writeFileSync(path, "before\n");
    writeFileRaw(path, "after\n", projectDir);

    const effects = recordedEffectsFor(path).filter((e) => e.operation === "write");
    expect(effects.length, "a file write must appear in the ledger's file lane").toBeGreaterThan(0);
    const latest = effects[0]!;
    expect(latest.postimageDigest, "the postimage digest must be the digest of the bytes actually written").toBe(sha256("after\n"));
    expect(latest.preimageDigest, "the preimage digest must be the digest of the bytes actually replaced").toBe(sha256("before\n"));
    expect(readFileSync(path, "utf8"), "the write itself must still have happened").toBe("after\n");
  });

  test("creating a file records an EMPTY preimage, not a fabricated one", () => {
    const path = join(projectDir, "created.ts");
    createFile(path, "fresh\n", projectDir);

    const effects = recordedEffectsFor(path).filter((e) => e.operation === "write");
    expect(effects.length).toBeGreaterThan(0);
    expect(
      effects[0]!.preimageDigest,
      "nothing was there, so the preimage is the digest of no bytes — a true statement, not a placeholder",
    ).toBe(sha256(""));
    expect(effects[0]!.postimageDigest).toBe(sha256("fresh\n"));
  });

  test("a mkdir is recorded", () => {
    const path = join(projectDir, "new-folder");
    createDirectory(path, projectDir);
    const effects = recordedEffectsFor(path).filter((e) => e.operation === "mkdir");
    expect(effects.length, "a created directory must appear in the ledger").toBeGreaterThan(0);
  });

  test("a delete is recorded with the digest of what was removed", () => {
    const path = join(projectDir, "doomed.ts");
    writeFileSync(path, "content to remove\n");
    deleteFile(path, projectDir);

    const effects = recordedEffectsFor(path).filter((e) => e.operation === "delete");
    expect(effects.length, "a deleted file must appear in the ledger").toBeGreaterThan(0);
    expect(
      effects[0]!.preimageDigest,
      "the ledger must be able to attest what was destroyed",
    ).toBe(sha256("content to remove\n"));
    expect(effects[0]!.postimageDigest, "nothing is at the path afterwards").toBe(sha256(""));
  });
});

/**
 * F. Run attribution of the LIVE write path.
 *
 * Measured against the live ledger: run_id was NULL on every file-effect row
 * (0/2,456), which starved synthesis.echoes, custody parcel grouping and
 * hot-paths of their join key. The verified root cause was that every historic
 * row was written OUTSIDE any recording boundary (pre-boundary saves + test
 * processes) — the recorder's ambient merge itself works, and these tests pin
 * that end-to-end through the REAL editor bridge against the REAL ledger:
 *
 *  - a write inside `withRecordingContext({runId})` (what the run route
 *    enters around the whole run — server/routes/run.ts) lands attributed;
 *  - a write outside any boundary stays honestly unattributed — a human save
 *    with no run must never inherit a fabricated one.
 *
 * MUTATION-VERIFIED: stripping the ambient block from the harness recorder's
 * `mergeCorrelation` fails the first test; the harness-side twin lives in
 * integration/test/timeline/timeline-recorder.test.ts.
 */
describe("F. tool-driven writes carry their run; human saves stay unattributed", () => {
  /** The ledger EVENT (with its correlation) whose effect document names `path`. */
  function fileEffectEventFor(path: string) {
    const result = getTimelineQuery().byEventType("file-effect", { limit: 500, ascending: false });
    for (const event of result.events) {
      for (const doc of event.documents ?? []) {
        if (doc.name !== "effect" || typeof doc.contentJson !== "string") continue;
        if ((JSON.parse(doc.contentJson) as FileEffect).path === path) return event;
      }
    }
    return undefined;
  }

  test("a write inside a run boundary inherits the ambient run id (empty correlation at the call site)", () => {
    const path = join(projectDir, "attributed.ts");
    const runId = `run-test-${Date.now().toString(36)}`;
    withRecordingContext({ actor: { kind: "agent", id: "llm-test" }, runId, turnId: "turn-9" }, () => {
      writeFileRaw(path, "attributed\n", projectDir);
    });
    const event = fileEffectEventFor(path);
    expect(event, "the write must be in the ledger").toBeDefined();
    expect(event!.runId, "a tool-driven write inside a run MUST carry the run id").toBe(runId);
    expect(event!.turnId).toBe("turn-9");
    expect(event!.actorKind, "the ambient actor, not the construction fallback").toBe("agent");
    expect(event!.actorId).toBe("llm-test");
  });

  test("a write outside any boundary stays honestly unattributed", () => {
    const path = join(projectDir, "unattributed.ts");
    writeFileRaw(path, "no run here\n", projectDir);
    const event = fileEffectEventFor(path);
    expect(event).toBeDefined();
    expect(event!.runId, "no boundary → no run id; a fabricated one would be worse than NULL").toBe(null);
    expect(event!.turnId).toBe(null);
  });
});
