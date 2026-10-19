// @vitest-environment node
/**
 * CUSTODY blocks against a REAL repo and a REAL ledger (spec §7.3).
 *
 * A real temp git repository (real subprocess status/diff/log through the
 * git bridge) and a real SQLite timeline store feed the join — a fake port
 * would happily confirm join semantics the real store no longer satisfies,
 * and a faked git status would hide every porcelain-parsing mistake.
 *
 * Pinned properties, each with its mutation arm:
 *
 *   A. THE JOIN — a changed file's parcel is decided by the NEWEST decoded
 *      file-effect fact on its exact absolute path: newest wins (mutation:
 *      the older run must NOT attribute), unmatched files land in the
 *      outside bucket LAST, a foreign producer is a COUNT whose run id and
 *      title appear nowhere in the serialized read.
 *   B. MEASURED COUNTS — ±counts are git's own numstat of hand-written line
 *      edits, never invented; a new (untracked) file carries the honest
 *      absence reason instead of a fabricated count.
 *   C. HISTORY JOIN — a commit is attributed to the conversation whose
 *      recorded effects overlap its own files AT OR BEFORE the commit
 *      instant (mutation: an effect recorded after the commit must not
 *      attribute), and the empty join states its absence.
 *   D. DENY-BY-DEFAULT INPUT — traversal, flag-shaped and outside-the-repo
 *      paths are refused by the normaliser before any git invocation.
 *   E. PATH CAP — files beyond the store port's path bound are not silently
 *      dropped: they land in the outside bucket and the cap is counted.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTimelineStore } from "../../server/kernel/canonical.ts";
import { getGitStatus, getLog } from "../../server/intelligence/git-ops-bridge.ts";
import { gitRead, gitText, gitTextOrRefuse } from "../../server/intelligence/git-bridge.ts";
import {
  CUSTODY_MAX_FILES,
  attributionResolverFor,
  computeParcels,
  joinHistory,
  normalizeRepoFile,
  parseNumstat,
  workingCounts,
  type AttributionResolver,
  type CustodyPort,
  type StatusEntry,
} from "../../server/blocks/custody.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { jsonTimelineDocument } from "../helpers/timeline-documents.ts";

import { DatabaseSync } from "node:sqlite";
import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { methodKind } from "../../server/db/method-kinds.ts";

const LEDGER_ID = "ledger-custody-e2e";
const AT = (n: number): string => `2026-07-20T00:00:${String(n).padStart(2, "0")}.000Z`;

let repo: string;
let store: ReturnType<typeof createTimelineStore>;
const port = (): CustodyPort => store;

/** Fixture git — direct subprocess, NOT the bridge (setup is not the code
 * under test, and the bridge would classify these as recordable effects). */
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/**
 * A commit at an EXACT instant. Two commits made by a fast test land in the
 * same second most of the time and in different seconds occasionally, which
 * is precisely the variable the same-second tests are about — so it is
 * pinned rather than raced. Git takes both dates from the environment and
 * stores them at its own one-second resolution whatever we pass.
 */
function gitCommitAt(isoInstant: string, message: string): string {
  return execFileSync("git", ["commit", "-m", message], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoInstant, GIT_COMMITTER_DATE: isoInstant },
  }).trim();
}

function effectDoc(path: string, operation: string) {
  return jsonTimelineDocument("effect", { path, operation, preimageDigest: "d".repeat(64), postimageDigest: "e".repeat(64) });
}

/** The resolver the parcels tests share: run-1 → "fix flaky test" (turn 7,
 * with the request's words), run-old → the same chat, run-foreign → foreign,
 * anything else unknown. */
const RESOLVER: AttributionResolver = (runId) => {
  if (runId === "run-1" || runId === "run-old") {
    return {
      chatId: "c1",
      chatTitle: "fix flaky test",
      turn: 7,
      requestText: "refactor the reader path",
    };
  }
  if (runId === "run-foreign") return "foreign";
  return null;
};

beforeAll(() => {
  // ── The real repo, with hand-countable edits ─────────────────────────────
  repo = createTempDir("custody-repo-");
  git("init", "-b", "main");
  git("config", "user.name", "Custody Test");
  git("config", "user.email", "custody@test.local");
  writeFileSync(join(repo, "a.ts"), "line1\nline2\nline3\n");
  writeFileSync(join(repo, "b.ts"), "b1\nb2\n");
  writeFileSync(join(repo, "notes.md"), "note\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "deep.ts"), "d1\n");
  git("add", ".");
  git("commit", "-m", "base");

  // Hand-countable working-tree edits:
  //   a.ts: replace line2 → +1 −1
  writeFileSync(join(repo, "a.ts"), "line1\nline2changed\nline3\n");
  //   b.ts: append two lines → +2 −0
  writeFileSync(join(repo, "b.ts"), "b1\nb2\nb3\nb4\n");
  //   notes.md: outside edit → +1 −1 (no recorded effect anywhere)
  writeFileSync(join(repo, "notes.md"), "note-changed\n");
  //   fresh.md: brand-new, untracked → no counts vs the last save
  writeFileSync(join(repo, "fresh.md"), "hello\n");

  // ── The real ledger ──────────────────────────────────────────────────────
  const dir = createTempDir("custody-ledger-");
  store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: LEDGER_ID });
  const ev = (
    eventId: string,
    wallTime: string,
    runId: string | null,
    path: string,
  ) =>
    store.appendEvent({
      eventId,
      ledgerId: LEDGER_ID,
      eventType: "file-effect",
      actor: { kind: "user", id: "u-1" },
      description: `write ${path}`,
      wallTime,
      ...(runId !== null ? { correlation: { runId } } : {}),
      documents: [effectDoc(path, "write")],
    });

  // a.ts: an OLD run touched it first, run-1 touched it last → run-1 wins.
  ev("fx-a-old", AT(1), "run-old", resolve(repo, "a.ts"));
  ev("fx-a-new", AT(5), "run-1", resolve(repo, "a.ts"));
  // b.ts: run-1.
  ev("fx-b", AT(6), "run-1", resolve(repo, "b.ts"));
  // fresh.md: a FOREIGN run produced it — counted, never shown.
  ev("fx-fresh", AT(7), "run-foreign", resolve(repo, "fresh.md"));
  // notes.md: deliberately NO fact — the outside bucket.
  // An unattributed record on a.ts (no run) must not steal attribution.
  ev("fx-a-none", AT(8), null, resolve(repo, "a.ts"));
});

// ── A + B: the state join over the real repo ───────────────────────────────

describe("A/B. computeParcels — the real status × the real ledger", () => {
  function parcels() {
    const status = getGitStatus(repo);
    return computeParcels(port(), repo, status.entries, workingCounts(repo), RESOLVER);
  }

  test("files group under the producing conversation, newest fact wins", () => {
    const { parcels: p, join } = parcels();
    // Exactly two parcels: the run-1 conversation and the outside bucket.
    expect(p.map((x) => x.id)).toEqual(["run-1", "outside"]);
    const conv = p[0]!;
    expect(conv.attribution).toMatchObject({
      kind: "conversation",
      runId: "run-1",
      chatId: "c1",
      chatTitle: "fix flaky test",
      turn: 7,
      requestText: "refactor the reader path",
    });
    expect(conv.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    // MUTATION arm: had the older fact won, a.ts would carry run-old — the
    // grouping would be identical here, so pin the evidence instead: a.ts's
    // recorded touch is the NEWER instant.
    const a = conv.files.find((f) => f.path === "a.ts")!;
    expect(a.lastRecordedTouch).toBe(AT(5));
    expect(join.attributedFiles).toBe(2);
    expect(join.changedFiles).toBe(4);
  });

  test("±counts are git's own numbers for hand-written edits", () => {
    const conv = parcels().parcels[0]!;
    const a = conv.files.find((f) => f.path === "a.ts")!;
    const b = conv.files.find((f) => f.path === "b.ts")!;
    expect({ ins: a.insertions, del: a.deletions }).toEqual({ ins: 1, del: 1 });
    expect({ ins: b.insertions, del: b.deletions }).toEqual({ ins: 2, del: 0 });
    expect(conv.insertions).toBe(3);
    expect(conv.deletions).toBe(1);
  });

  test("the outside bucket is LAST, holds the unmatched + foreign files, and never leaks the foreign run", () => {
    const { parcels: p, join } = parcels();
    const outside = p[p.length - 1]!;
    expect(outside.id).toBe("outside");
    expect(outside.attribution.kind).toBe("outside");
    // notes.md (no fact at all) AND fresh.md (foreign producer).
    expect(outside.files.map((f) => f.path).sort()).toEqual(["fresh.md", "notes.md"]);
    // The foreign run is a COUNT; its id appears nowhere in the payload.
    expect(join.withheldRuns).toBe(1);
    expect(JSON.stringify(p)).not.toContain("run-foreign");
  });

  test("a new file carries the honest absence reason, not a fabricated count", () => {
    const outside = parcels().parcels.at(-1)!;
    const fresh = outside.files.find((f) => f.path === "fresh.md")!;
    expect(fresh.state).toBe("new");
    expect(fresh.insertions).toBeNull();
    expect(fresh.deletions).toBeNull();
    expect(fresh.countsAbsentReason).toMatch(/new file/);
    // …while the tracked outside edit is fully measured.
    const notes = outside.files.find((f) => f.path === "notes.md")!;
    expect({ ins: notes.insertions, del: notes.deletions }).toEqual({ ins: 1, del: 1 });
  });

  test("join denominators are the store's own, not invented", () => {
    const { join } = parcels();
    expect(join.fileEffectEventsExamined).toBeGreaterThanOrEqual(5);
    expect(join.undecodableEffects).toBe(0);
    expect(join.truncated).toBe(false);
    expect(join.filesBeyondPathCap).toBe(0);
  });
});

// ── C: the history join ────────────────────────────────────────────────────

describe("C. joinHistory — commits × recorded conversation, time-bounded", () => {
  test("a commit is attributed by at-or-before overlap; a later-dated effect must not attribute", () => {
    // Commit the a.ts change. The a.ts facts (AT(5), 2026-07-20) predate the
    // commit instant, so they are in-bound and attribute it.
    git("add", "a.ts");
    git("commit", "-m", "reader path refactor");
    // A second commit whose ONLY recorded effect is FUTURE-dated: the file
    // genuinely changed and a fact genuinely names it, but the fact's wall
    // time is after the commit instant — the time bound must refuse it.
    writeFileSync(join(repo, "src", "deep.ts"), "d1\nd2\n");
    git("add", "src/deep.ts");
    git("commit", "-m", "late-effect edit");
    store.appendEvent({
      eventId: "fx-late",
      ledgerId: LEDGER_ID,
      eventType: "file-effect",
      actor: { kind: "user", id: "u-1" },
      description: "write late",
      wallTime: "2099-01-01T00:00:00.000Z",
      correlation: { runId: "run-1" },
      documents: [effectDoc(resolve(repo, "src/deep.ts"), "write")],
    });

    const log = getLog(repo, 10);
    const withFiles = log.map((entry) => ({
      entry,
      files: parseNumstat(gitText(repo, ["show", "--numstat", "--format=", entry.hash]) ?? ""),
    }));
    const joined = joinHistory(port(), repo, withFiles, RESOLVER);
    expect(joined.length).toBe(3);

    // Newest first: the late-effect commit — its only fact is future-dated,
    // so the join is EMPTY and says so (the mutation arm of the time bound).
    const late = joined[0]!;
    expect(late.message).toBe("late-effect edit");
    expect(late.conversation).toBeNull();
    expect(late.derivation).toMatch(/no recorded conversation/);

    // The refactor commit: attributed by its in-bound a.ts facts, with git's
    // own measured counts.
    const refactor = joined[1]!;
    expect(refactor.message).toBe("reader path refactor");
    expect(refactor.files).toBe(1);
    expect(refactor.insertions).toBe(1);
    expect(refactor.deletions).toBe(1);
    expect(refactor.conversation).toMatchObject({ chatId: "c1", chatTitle: "fix flaky test" });
    expect(refactor.derivation).toMatch(/at or before/);

    // The base commit: the recorded a.ts/b.ts facts predate it, so the join
    // honestly attributes 2 of its files' worth of overlap to the chat.
    const base = joined[2]!;
    expect(base.message).toBe("base");
    expect(base.conversation).toMatchObject({ chatId: "c1", overlapFiles: 2 });
  });

  test("an effect recorded in the SAME SECOND as its commit attributes — the coarse clock's resolution decides the bound, and the next second is still refused", () => {
    // ── THE ORDINARY CASE, which was the broken one ──────────────────────
    //
    // Git stores a commit time as whole SECONDS; the ledger records
    // `wallTime` in MILLISECONDS. A save follows the edit that produced it by
    // milliseconds, so the ordinary shape is "effect at S.437, commit stamped
    // at S" — and comparing the two clocks directly asked "is the effect
    // after the START of the commit's second", which refused it.
    //
    // The failure was not a missing row. `joinHistory` rendered "no recorded
    // conversation … an absence, not a guess" for a save whose producing
    // conversation IS in the ledger: a FABRICATED ABSENCE emitted by the
    // honesty mechanism itself. This test is the one that fails when the
    // bound goes back to comparing at the fine clock's resolution.
    const file = "same-second.ts";
    writeFileSync(join(repo, file), "s1\ns2\n");
    git("add", file);
    git("commit", "-m", "same-second save");

    // The commit's OWN recorded instant, read back from git rather than
    // assumed — the whole point is that git's answer has no sub-second part.
    const entry = getLog(repo, 1)[0]!;
    const commitMs = Date.parse(entry.date);
    expect(entry.message).toBe("same-second save");
    expect(
      commitMs % 1000,
      "git commit times are whole seconds — if this ever has a remainder the bound below is derived from the wrong resolution",
    ).toBe(0);

    // WITHIN the commit's second: 437ms past its start. Recorded AFTER the
    // commit by the fine clock, INSIDE it by the coarse one.
    store.appendEvent({
      eventId: "fx-same-second",
      ledgerId: LEDGER_ID,
      eventType: "file-effect",
      actor: { kind: "user", id: "u-1" },
      description: `write ${file}`,
      wallTime: new Date(commitMs + 437).toISOString(),
      correlation: { runId: "run-1" },
      documents: [effectDoc(resolve(repo, file), "write")],
    });

    const joinedOf = (message: string) => {
      const log = getLog(repo, 10);
      const withFiles = log.map((e) => ({
        entry: e,
        files: parseNumstat(gitText(repo, ["show", "--numstat", "--format=", e.hash]) ?? ""),
      }));
      return joinHistory(port(), repo, withFiles, RESOLVER).find((s) => s.message === message)!;
    };

    const inSecond = joinedOf("same-second save");
    expect(
      inSecond.conversation,
      "an effect 437ms into the commit's own second is WITHIN it — reporting an absence here fabricates one",
    ).toMatchObject({ chatId: "c1", overlapFiles: 1 });
    expect(inSecond.derivation).toMatch(/at or before/);

    // ── THE MUTATION ARM: the window is not widened, only correctly placed.
    // A second commit, then an effect at EXACTLY one second past its stamp —
    // the first instant that is genuinely a LATER second — must still be
    // refused, or "at or before" would have become "at or before, plus a bit".
    const later = "next-second.ts";
    writeFileSync(join(repo, later), "n1\n");
    git("add", later);
    git("commit", "-m", "next-second save");
    const laterMs = Date.parse(getLog(repo, 1)[0]!.date);
    store.appendEvent({
      eventId: "fx-next-second",
      ledgerId: LEDGER_ID,
      eventType: "file-effect",
      actor: { kind: "user", id: "u-1" },
      description: `write ${later}`,
      wallTime: new Date(laterMs + 1000).toISOString(),
      correlation: { runId: "run-1" },
      documents: [effectDoc(resolve(repo, later), "write")],
    });

    const nextSecond = joinedOf("next-second save");
    expect(
      nextSecond.conversation,
      "one full second past the commit's stamp is a later second — attributing it would mean the bound was widened, not corrected",
    ).toBeNull();
    expect(nextSecond.derivation).toMatch(/no recorded conversation/);
  });

  test("inside the ambiguous second, the LATER commit touching the path takes the effect — an earlier save cannot claim work that did not exist when it ran", () => {
    // Two saves of the SAME file, pinned to the SAME second, with the effect
    // recorded inside that second. The clocks cannot order the three; ancestry
    // can, and this is the assertion that says which fact decides.
    //
    // Without it, taking the whole second as "before" lets the OLDER save
    // claim the conversation — the mirror-image error of the fabricated
    // absence, and just as untrue: that commit ran before the edit existed.
    const instant = "2026-06-15T12:30:44-00:00";
    const shared = "shared-second.ts";

    writeFileSync(join(repo, shared), "v1\n");
    git("add", shared);
    gitCommitAt(instant, "older save of shared");

    writeFileSync(join(repo, shared), "v2\n");
    git("add", shared);
    gitCommitAt(instant, "newer save of shared");

    const commitMs = Date.parse(instant);
    store.appendEvent({
      eventId: "fx-ambiguous-second",
      ledgerId: LEDGER_ID,
      eventType: "file-effect",
      actor: { kind: "user", id: "u-1" },
      description: `write ${shared}`,
      wallTime: new Date(commitMs + 437).toISOString(),
      correlation: { runId: "run-1" },
      documents: [effectDoc(resolve(repo, shared), "write")],
    });

    const log = getLog(repo, 20);
    const withFiles = log.map((e) => ({
      entry: e,
      files: parseNumstat(gitText(repo, ["show", "--numstat", "--format=", e.hash]) ?? ""),
    }));
    const joined = joinHistory(port(), repo, withFiles, RESOLVER);
    const older = joined.find((s) => s.message === "older save of shared")!;
    const newer = joined.find((s) => s.message === "newer save of shared")!;

    // Both really are stamped at the same second — if git ever stopped
    // truncating, this test would be measuring nothing.
    expect(Date.parse(older.when)).toBe(Date.parse(newer.when));

    expect(
      newer.conversation,
      "the newest save touching this path is the one that saved the effect",
    ).toMatchObject({ chatId: "c1", overlapFiles: 1 });
    expect(
      older.conversation,
      "a save made before the edit was recorded must not claim it — that is the fabricated absence's mirror image, not a fix for it",
    ).toBeNull();
  });
});

// ── D: deny-by-default path normalisation ──────────────────────────────────

describe("D. normalizeRepoFile refuses what could escape or inject", () => {
  test("traversal, flags, outside-absolute and root paths are refused", () => {
    for (const bad of ["../evil.ts", "a/../../evil.ts", "-o/tmp/x", "--output=/tmp/x", "/etc/passwd", "", "."]) {
      expect(() => normalizeRepoFile(repo, bad), `"${bad}" must be refused`).toThrow(
        /invalid file path|must not start with '-'|outside the project|names the project root/,
      );
    }
  });

  test("repo-relative and inside-absolute paths normalise to the same name", () => {
    expect(normalizeRepoFile(repo, "src/deep.ts")).toBe("src/deep.ts");
    expect(normalizeRepoFile(repo, join(repo, "src", "deep.ts"))).toBe("src/deep.ts");
  });
});

// ── E: the path cap is visible, never a silent drop ────────────────────────

describe("E. files beyond the path bound are counted into the outside bucket", () => {
  test("entry 201+ is not queried but still renders, counted", () => {
    const entries: StatusEntry[] = [];
    for (let i = 0; i < CUSTODY_MAX_FILES + 3; i++) {
      entries.push({ status: "modified", path: `f${String(i).padStart(3, "0")}.ts`, staged: false });
    }
    let queried: readonly string[] = [];
    const capturePort: CustodyPort = {
      fileEffectFacts: (filter) => {
        queried = filter.paths ?? [];
        return { facts: [], fileEffectEventsExamined: 0, undecodableEffects: 0, truncated: false };
      },
    };
    const { parcels: p, join } = computeParcels(capturePort, repo, entries, new Map(), RESOLVER);
    expect(queried.length).toBe(CUSTODY_MAX_FILES);
    expect(join.filesBeyondPathCap).toBe(3);
    expect(join.changedFiles).toBe(CUSTODY_MAX_FILES + 3);
    const outside = p.at(-1)!;
    expect(outside.files.length).toBe(CUSTODY_MAX_FILES + 3);
    expect(outside.derivation).toMatch(/beyond the 200-path bound/);
  });
});


test("async custody Git retains real status/counts and keeps the loop responsive", async () => {
  const directory = createTempDir("custody-async-git-");
  const fixtureGit = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  expect(await getGitStatus(directory, undefined, { async: true })).toEqual(getGitStatus(directory));
  fixtureGit("init", "-q", "-b", "main");
  writeFileSync(join(directory, "new 雪.txt"), "new\n");
  expect(await getGitStatus(directory, undefined, { async: true })).toEqual(getGitStatus(directory));
  expect(await workingCounts(directory, { async: true })).toEqual(workingCounts(directory));
  fixtureGit("config", "user.name", "Custody Test");
  fixtureGit("config", "user.email", "custody@example.invalid");
  fixtureGit("add", ".");
  fixtureGit("commit", "-qm", "base");
  writeFileSync(join(directory, "new 雪.txt"), "changed\n");
  fixtureGit("mv", "new 雪.txt", "renamed 雪.txt");
  const expectedStatus = getGitStatus(directory);
  const expectedCounts = workingCounts(directory);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const status = await getGitStatus(directory, undefined, { async: true });
    expect(ticks, "the request loop must advance while the actual Git reads run").toBeGreaterThan(0);
    expect(status.entries).toEqual(expectedStatus.entries);
    expect(status.head).toBe(expectedStatus.head);
    expect(status.branch).toBe(expectedStatus.branch);
    expect(await workingCounts(directory, { async: true })).toEqual(expectedCounts);
  } finally { clearInterval(timer); }
  writeFileSync(join(directory, "large.txt"), "x".repeat(2 * 1024 * 1024));
  fixtureGit("add", "large.txt");
  fixtureGit("commit", "-qm", "large capture fixture");
  const args = ["show", "HEAD:large.txt"];
  expect(gitRead(directory, args).kind).toBe("unavailable");
  expect((await gitRead(directory, args, [], { async: true })).kind).toBe("unavailable");
  expect(() => gitTextOrRefuse(directory, args, "saved contents")).toThrow(expect.objectContaining({ code: "git_read_unavailable" }));
  await expect(gitTextOrRefuse(directory, args, "saved contents", [], { async: true })).rejects.toMatchObject({ code: "git_read_unavailable" });
});

test("real custody resolver preserves canonical ownership and all user-turn ordinals through the threaded facade", async () => {
  const directory = createTempDir("custody-attribution-");
  const path = join(directory, "web.db");
  const seed = new DbClient({ path });
  const user = seed.createUser("owner", "fixture-unused").id;
  const foreign = seed.createUser("foreign", "fixture-unused").id;
  const project = seed.createProject({ name: "current", path: directory }, user);
  const other = seed.createProject({ name: "other", path: join(directory, "other") }, user);
  const foreignProject = seed.createProject({ name: "foreign", path: join(directory, "foreign") }, foreign);
  const chat = seed.createChat({ project_id: project.id, title: "first chat" }, user);
  const second = seed.createChat({ project_id: project.id, title: "second chat" }, user);
  const hiddenChat = seed.createChat({ project_id: project.id, title: "trashed chat" }, user);
  seed.createMessage({ chat_id: hiddenChat.id, role: "user", content: "hidden", run_id: "trashed-run" }, user);
  const otherChat = seed.createChat({ project_id: other.id, title: "other chat" }, user);
  const foreignChat = seed.createChat({ project_id: foreignProject.id, title: "foreign chat" }, foreign);
  const add = (role: "user" | "assistant", content: string, run_id?: string) => seed.createMessage({ chat_id: chat.id, role, content, ...(run_id === undefined ? {} : { run_id }) }, user);
  add("user", "prior user without run");
  add("assistant", "assistant-only owner", "assistant-run");
  add("user", "  " + "original task ".repeat(30) + "  ", "first-run");
  add("user", "same-time third turn", "second-run");
  add("user", "later steer must not replace the first request", "first-run");
  add("user", "   ", "blank-run");
  add("user", "shared first", "shared-run");
  seed.createMessage({ chat_id: second.id, role: "user", content: "shared second", run_id: "shared-run" }, user);
  seed.createMessage({ chat_id: otherChat.id, role: "user", content: "owned elsewhere", run_id: "other-run" }, user);
  seed.createMessage({ chat_id: foreignChat.id, role: "user", content: "foreign request", run_id: "foreign-run" }, foreign);
  seed.createMessage({ chat_id: chat.id, role: "event", content: "metadata is not ownership", metadata: { runId: "metadata-run" } }, user);
  seed.createTimelineRef({ chat_id: chat.id, event_id: "poison-event", event_type: "model", timestamp: AT(1), metadata: { runId: "foreign-run" } }, user);
  seed.close();
  // Real identical timestamps force listMessages' rowid tiebreaker. Chat
  // recency is explicit too, retaining the existing last-chat-wins join.
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE messages SET created_at = ?").run(AT(1));
  raw.prepare("UPDATE chats SET trashed_at = ? WHERE id = ?").run(AT(4), hiddenChat.id);
  raw.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(AT(3), chat.id);
  raw.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(AT(2), second.id);
  raw.close();
  const db = await AsyncDbClient.open({ path });
  try {
    expect(db.isOffThread).toBe(true);
    expect(methodKind("runAttributionsForProject")).toBe("read");
    const rows = await db.runAttributionsForProject(project.id, user);
    expect(rows.filter((row) => row.runId === "shared-run")).toEqual([
      { runId: "shared-run", chatId: chat.id, chatTitle: "first chat", turn: 6, requestContent: "shared first" },
      { runId: "shared-run", chatId: second.id, chatTitle: "second chat", turn: 1, requestContent: "shared second" },
    ]);
    const resolver = await attributionResolverFor(db, user, project.id);
    expect(resolver("first-run")).toEqual({ chatId: chat.id, chatTitle: "first chat", turn: 2, requestText: "original task ".repeat(30).trim().slice(0, 200) });
    expect(resolver("second-run")).toMatchObject({ chatId: chat.id, turn: 3, requestText: "same-time third turn" });
    expect(resolver("blank-run")).toMatchObject({ turn: 5, requestText: null });
    expect(resolver("assistant-run")).toMatchObject({ turn: null, requestText: null });
    expect(resolver("shared-run")).toEqual({ chatId: second.id, chatTitle: "second chat", turn: 1, requestText: "shared second" });
    expect(resolver("other-run")).toBeNull();
    expect(resolver("trashed-run")).toBeNull();
    for (const id of ["foreign-run", "metadata-run", "unknown-run"]) expect(resolver(id)).toBe("foreign");
    expect(await db.runAttributionsForProject(project.id, foreign)).toEqual([]);
    const foreignResolver = await attributionResolverFor(db, foreign, project.id);
    expect(foreignResolver("first-run")).toBe("foreign");
    expect(foreignResolver("foreign-run")).toBeNull();
    // Issue a write without awaiting it: the normal reader barrier must
    // make the new producing turn visible to the immediately issued read.
    const writing = db.createMessage({ chat_id: chat.id, role: "user", content: "new request", run_id: "new-run" }, user);
    const reading = attributionResolverFor(db, user, project.id);
    await writing;
    expect((await reading)("new-run")).toMatchObject({ chatId: chat.id, turn: 7, requestText: "new request" });
  } finally { await db.close(); }
});
