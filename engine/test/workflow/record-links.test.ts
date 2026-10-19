/**
 * RECORD LINKS, DRIVEN (`src/workflow/record-links.ts`): every Markdown link
 * names a file or folder of the tree, or a path an evidence manifest records
 * (`evidence:<path>`); a relative link into stored evidence is dead and says
 * how to link it; schemes and bare anchors are not judged. Planted
 * repositories, through the scan the `dead-markdown-links` ratchet and
 * `harness check` run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { EVIDENCE_MANIFEST_SCHEMA } from "../../src/workflow/evidence-store.ts";
import { acceptFrozenRecords, deadLinkReason, deadMarkdownLinks, frozenRecordsMessage, syncFrozenRecords, type LinkHoldings } from "../../src/workflow/record-links.ts";

const ENGINE_ROOT_FOR_GUARD = fileURLToPath(new URL("../../", import.meta.url));
import { createTempDir } from "../support/temp-dir.ts";
import { createWorkingCopy } from "../../src/git/working-copy.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const POLICY = ROOT_POLICY.workflow.evidenceStore;

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Links Test", "-c", "user.email=links@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

test("deadLinkReason: the tree, a folder, an anchor, a scheme, a recorded path, a percent-encoded name — and a relative link into stored evidence", () => {
  const holdings: LinkHoldings = {
    holds: (path) => ["docs", "docs/a.md", "docs/sub", "docs/sub/b c.md"].includes(path),
    recorded: (path) => path === "docs/evidence" || path === "docs/evidence/run.log.txt",
  };
  const document = "docs/sub/b c.md";
  for (const target of ["../a.md", "../a.md#part", "..", "#here", "https://example.invalid", "mailto:x@example.invalid", "b%20c.md",
    `${POLICY.linkScheme}docs/evidence/run.log.txt`, `${POLICY.linkScheme}docs/evidence`]) {
    assert.equal(deadLinkReason(document, target, holdings), undefined, target);
  }
  assert.match(deadLinkReason(document, "../gone.md", holdings)!, /docs\/gone\.md, which the tree does not hold/u);
  assert.match(deadLinkReason(document, `${POLICY.linkScheme}docs/evidence/other.txt`, holdings)!, /no evidence manifest records/u);
  assert.match(deadLinkReason(document, "../evidence/run.log.txt", holdings)!, new RegExp(`link it as ${POLICY.linkScheme}docs/evidence/run\\.log\\.txt`, "u"));
  assert.match(deadLinkReason(document, "%E0%A4%A.md", holdings)!, /which the tree does not hold/u, "a malformed escape is just dead");
  assert.equal(deadLinkReason(document, "/docs/a.md", holdings), undefined, "a root-relative link resolves from the repository's top");
  assert.match(deadLinkReason(document, "/a.md", holdings)!, /names a\.md, which the tree does not hold/u, "…never from the document's folder");
});

test("deadMarkdownLinks: the repository's owned Markdown documents, keyed for the ratchet; an ignored file and an unrecorded evidence path never resolve a link", () => {
  const root = realpathSync(createTempDir("record-links-"));
  git(root, "init", "-q");
  write(root, ".gitignore", "/docs/evidence/\n");
  write(root, `docs/${POLICY.manifestName}`, JSON.stringify({ schema: EVIDENCE_MANIFEST_SCHEMA, entries: [{ path: "docs/evidence/run.log.txt", sha256: sha256("run\n"), size: 4, mode: "0644" }] }));
  write(root, "docs/evidence/run.log.txt", "run\n");
  write(root, "docs/report.md", [
    "[stored](evidence:docs/evidence/run.log.txt)",
    "[materialized copy](evidence/run.log.txt)",
    "[unrecorded](evidence:docs/evidence/gone.txt)",
    "[sibling](notes.md) [draft](draft.md)",
  ].join("\n"));
  write(root, "docs/notes.md", "[back](report.md)\n");
  write(root, "docs/draft.md", "untracked but not ignored: owned\n");
  git(root, "add", "--", ".gitignore", `docs/${POLICY.manifestName}`, "docs/report.md", "docs/notes.md");
  const dead = deadMarkdownLinks(root);
  assert.deepEqual(dead.map((link) => link.key), ["docs/report.md: evidence/run.log.txt", "docs/report.md: evidence:docs/evidence/gone.txt"]);
  assert.deepEqual(dead.map((link) => link.where), [
    "docs/report.md:2: evidence/run.log.txt names docs/evidence/run.log.txt, which is held in the evidence store, not the tree: link it as evidence:docs/evidence/run.log.txt",
    "docs/report.md:3: evidence:docs/evidence/gone.txt names docs/evidence/gone.txt, which no evidence manifest records",
  ]);
});

test("deadMarkdownLinks reads links with the one Markdown parser: titled, angle-bracket and reference links are judged; code is never a link; a frozen record's links are history (correctness N6, design H4)", () => {
  const root = realpathSync(createTempDir("record-links-grammar-"));
  git(root, "init", "-q");
  write(root, "docs/real.md", "# real\n");
  write(root, "docs/live.md", [
    "[titled](gone-titled.md \"A title\") [angled](<gone angled.md>) [ok](real.md \"fine\")",
    "[ref][r] and [kept][k]",
    "`REGISTRY[name](n)` and ``a [x](gone-in-code.md) b``",
    "```",
    "[fenced](gone-fenced.md)",
    "```",
    "[root](/docs/real.md) [rootless](/real.md)",
    "",
    "[r]: gone-ref.md",
    "[k]: real.md",
  ].join("\n"));
  const frozenRoot = ROOT_POLICY.verification.frozenRecordRoots[0]!;
  write(root, `${frozenRoot}old.md`, "[history](gone-forever.md)\n");
  write(root, "docs/history-link.md", `[into the archive](/${frozenRoot}old.md) [missing archive file](/${frozenRoot}never.md)\n`);
  git(root, "add", "-A");
  assert.deepEqual(deadMarkdownLinks(root).map((link) => link.key), [
    `docs/history-link.md: /${frozenRoot}never.md`,
    "docs/live.md: gone-titled.md",
    "docs/live.md: gone angled.md",
    "docs/live.md: /real.md",
    "docs/live.md: gone-ref.md",
  ]);
});

function frozenRepository(prefix: string): Readonly<{ repo: string; git: (...args: string[]) => string; frozenRoot: string }> {
  const frozenRoot = ROOT_POLICY.verification.frozenRecordRoots[0]!;
  const repo = realpathSync(createTempDir(prefix));
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } });
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, frozenRoot), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, frozenRoot, "x.md"), "history\n");
  writeFileSync(join(repo, frozenRoot, "gone.md"), "history\n");
  writeFileSync(join(repo, "live.md"), "live\n");
  assert.equal(syncFrozenRecords(repo, true).status, "regenerated");
  git("add", "-A");
  git("commit", "-q", "-m", "history");
  return { repo, git, frozenRoot };
}

test("THE FROZEN ROOTS' CONTENT IS PINNED, APPEND-ONLY: an edit, an addition, a type change and a removal each make the manifest stale, by path; a live path never does; sync ADDS a new record but never re-pins an edited or removed one, which only `harness frozen accept --reason` does, recorded (design NH-A, security MF-8, round 13 item 11)", () => {
  const { repo, frozenRoot } = frozenRepository("frozen-content-");
  const manifest = ROOT_POLICY.verification.frozenRecordManifest;
  assert.deepEqual(syncFrozenRecords(repo, false), { status: "current", converged: true, changed: [], altered: [] });
  writeFileSync(join(repo, "live.md"), "edited live\n");
  assert.equal(syncFrozenRecords(repo, false).status, "current", "a live document is not frozen");
  writeFileSync(join(repo, frozenRoot, "x.md"), "history, rewritten\n");
  writeFileSync(join(repo, frozenRoot, "new.md"), "a new record\n");
  rmSync(join(repo, frozenRoot, "gone.md"));
  const altered = [`${frozenRoot}gone.md`, `${frozenRoot}x.md`];
  assert.deepEqual(syncFrozenRecords(repo, false), { status: "stale", converged: false, changed: [`${frozenRoot}gone.md`, `${frozenRoot}new.md`, `${frozenRoot}x.md`], altered });
  const before = readFileSync(join(repo, manifest), "utf8");
  // Sync pins the NEW record and leaves the edited and removed ones as drift: it never re-blesses history.
  assert.deepEqual(syncFrozenRecords(repo, true), { status: "stale", converged: false, changed: altered, altered });
  const afterSync = readFileSync(join(repo, manifest), "utf8");
  assert.ok(afterSync.includes(`"${frozenRoot}new.md": "${sha256("a new record\n")}"`), "one reviewable line per pinned record");
  assert.ok(afterSync.includes(`"${frozenRoot}x.md": "${sha256("history\n")}"`) && afterSync.includes("gone.md"), "the pinned digests are untouched");
  assert.notEqual(afterSync, before);
  // The explicit door: a reason is required, only a pinned and changed record is accepted, and each acceptance is recorded.
  assert.throws(() => acceptFrozenRecords(repo, [`${frozenRoot}x.md`], " "), (error: unknown) => (error as { code?: string }).code === "frozen_accept_reason_missing");
  assert.throws(() => acceptFrozenRecords(repo, [`${frozenRoot}new.md`], "why"), (error: unknown) => (error as { code?: string }).code === "frozen_accept_unchanged");
  assert.throws(() => acceptFrozenRecords(repo, ["docs/live.md"], "why"), (error: unknown) => (error as { code?: string }).code === "frozen_accept_not_pinned");
  const accepted = acceptFrozenRecords(repo, altered, "the imported record was corrected by its author", new Date("2026-10-11T00:00:00.000Z"));
  assert.deepEqual(accepted, { status: "current", converged: true, changed: [], altered: [] });
  const afterAccept = JSON.parse(readFileSync(join(repo, manifest), "utf8")) as { files: Record<string, string>; acceptances: unknown[] };
  assert.equal(afterAccept.files[`${frozenRoot}x.md`], sha256("history, rewritten\n"));
  assert.equal(afterAccept.files[`${frozenRoot}gone.md`], undefined, "a removal leaves the manifest by its acceptance");
  assert.deepEqual(afterAccept.acceptances, [
    { path: `${frozenRoot}gone.md`, from: sha256("history\n"), to: null, reason: "the imported record was corrected by its author", acceptedAt: "2026-10-11T00:00:00.000Z" },
    { path: `${frozenRoot}x.md`, from: sha256("history\n"), to: sha256("history, rewritten\n"), reason: "the imported record was corrected by its author", acceptedAt: "2026-10-11T00:00:00.000Z" },
  ]);
  rmSync(join(repo, frozenRoot, "x.md"));
  symlinkSync("../../live.md", join(repo, frozenRoot, "x.md"));
  assert.deepEqual(syncFrozenRecords(repo, false).changed, [`${frozenRoot}x.md`], "a record replaced by a link is a change");
  writeFileSync(join(repo, manifest), "{}\n");
  assert.throws(() => syncFrozenRecords(repo, false), /not a frozen-records manifest/u, "a hand-broken manifest is refused by name");
});

test("a frozen record's MODE is part of what is pinned (correctness FR-L1): turning the execute bit on is a change, by path, and turning it back is current again", () => {
  const { repo, frozenRoot } = frozenRepository("frozen-mode-");
  const record = join(repo, frozenRoot, "x.md");
  chmodSync(record, 0o755);
  assert.deepEqual(syncFrozenRecords(repo, false).changed, [`${frozenRoot}x.md`], "the execute bit is a change");
  assert.deepEqual(syncFrozenRecords(repo, true).altered, [`${frozenRoot}x.md`], "sync never re-pins it");
  chmodSync(record, 0o644);
  assert.deepEqual(syncFrozenRecords(repo, false), { status: "current", converged: true, changed: [], altered: [] });
});

test("A HAND EDIT of the manifest that re-pins or drops a frozen record is refused by name; the same change through `harness frozen accept --reason` passes (design MED-3, the reviewer's hand edit)", () => {
  const { repo, git, frozenRoot } = frozenRepository("frozen-hand-edit-");
  const manifestPath = join(repo, ROOT_POLICY.verification.frozenRecordManifest);
  const committed = readFileSync(manifestPath, "utf8");
  // The reviewer's edit: rewrite a pinned record and set its digest by hand; delete a second record with its pin.
  writeFileSync(join(repo, frozenRoot, "x.md"), "history, rewritten\n");
  rmSync(join(repo, frozenRoot, "gone.md"));
  const hand = JSON.parse(committed) as { files: Record<string, string> };
  hand.files[`${frozenRoot}x.md`] = sha256("history, rewritten\n");
  delete hand.files[`${frozenRoot}gone.md`];
  writeFileSync(manifestPath, `${JSON.stringify(hand, null, 2)}\n`);
  const refused = syncFrozenRecords(repo, false);
  assert.equal(refused.converged, false);
  assert.deepEqual(refused.unaccepted, [`${frozenRoot}gone.md`, `${frozenRoot}x.md`]);
  assert.match(frozenRecordsMessage(refused), /re-pins or drops a record with no acceptance/u);
  assert.equal(syncFrozenRecords(repo, true).converged, false, "sync never blesses it");
  // The same change, through the door: restored pins, then accepted with a reason.
  writeFileSync(manifestPath, committed);
  assert.deepEqual(acceptFrozenRecords(repo, [`${frozenRoot}gone.md`, `${frozenRoot}x.md`], "corrected by its author"), { status: "current", converged: true, changed: [], altered: [] });
  // Committed, the next change is judged against the new HEAD; and a rewritten earlier acceptance is refused.
  git("add", "-A");
  git("commit", "-q", "-m", "accepted");
  const accepted = JSON.parse(readFileSync(manifestPath, "utf8")) as { acceptances: { reason: string }[] };
  accepted.acceptances[0]!.reason = "a reason rewritten later";
  writeFileSync(manifestPath, `${JSON.stringify(accepted, null, 2)}\n`);
  assert.deepEqual(syncFrozenRecords(repo, false).unaccepted, [`${ROOT_POLICY.verification.frozenRecordManifest} (an earlier acceptance was rewritten or removed)`]);
});

test("a DELETED manifest cannot launder an edit (sync would write a fresh one that pins the edited bytes: refused against HEAD's pins); a narrowed copy that leaves the manifest out judges nothing (round 14)", () => {
  const { repo, git, frozenRoot } = frozenRepository("frozen-launder-");
  const manifestPath = join(repo, ROOT_POLICY.verification.frozenRecordManifest);
  writeFileSync(join(repo, frozenRoot, "x.md"), "history, rewritten\n");
  rmSync(manifestPath);
  const laundered = syncFrozenRecords(repo, true);
  assert.equal(laundered.converged, false, "a fresh manifest that re-pins an edited record is refused");
  assert.deepEqual(laundered.unaccepted, [`${frozenRoot}x.md`]);
  // A narrowed copy (the manifest and a record marked skip-worktree and absent, as working-copy `include` leaves
  // them) is judged by git's view: current against its pins, and nothing is written.
  git("checkout", "--", ".");
  rmSync(manifestPath, { force: true });
  rmSync(join(repo, frozenRoot, "gone.md"), { force: true });
  git("update-index", "--skip-worktree", "--", ROOT_POLICY.verification.frozenRecordManifest, `${frozenRoot}gone.md`);
  assert.deepEqual(syncFrozenRecords(repo, true), { status: "current", converged: true, changed: [], altered: [] });
  assert.equal(existsSync(manifestPath), false, "and writes none");
});

test("A FLAG NEVER SWITCHES THE FROZEN CHECK OFF (the round-14 check's reproduction): an edited record with the manifest marked skip-worktree and removed is refused against the manifest the index holds; a flagged path whose disk copy is populated, and an assume-unchanged one, are refused naming the flag; the commit hook's staged copy is refused alike", () => {
  const { repo, git, frozenRoot } = frozenRepository("frozen-flags-");
  const manifest = ROOT_POLICY.verification.frozenRecordManifest;
  // The reviewer's case, through the real check.
  writeFileSync(join(repo, frozenRoot, "x.md"), "history, rewritten\n");
  git("update-index", "--skip-worktree", "--", manifest);
  rmSync(join(repo, manifest));
  const refused = syncFrozenRecords(repo, false);
  assert.equal(refused.converged, false, "the edit is still seen: the pins come from the index");
  assert.deepEqual(refused.altered, [`${frozenRoot}x.md`]);
  // The hook's path: the staged tree is materialized from the index, as `materializeStagedTree` does.
  git("add", "--", `${frozenRoot}x.md`);
  const staged = join(createTempDir("frozen-flags-staged-"), "copy");
  createWorkingCopy({ sourceRoot: repo, targetRoot: staged, git: "staged" });
  assert.equal(syncFrozenRecords(staged, false).converged, false, "the hook's staged copy refuses the edit too");
  // A flagged path whose disk copy is there: an edit git would not see, refused by its flag.
  writeFileSync(join(repo, manifest), git("show", `HEAD:${manifest}`));
  const hidden = syncFrozenRecords(repo, false);
  assert.deepEqual(hidden.hidden, [`${manifest} (skip-worktree)`]);
  assert.match(frozenRecordsMessage(hidden), /flagged so that git does not look at its disk bytes/u);
  git("update-index", "--no-skip-worktree", "--", manifest);
  git("update-index", "--assume-unchanged", "--", `${frozenRoot}gone.md`);
  assert.deepEqual(syncFrozenRecords(repo, false).hidden, [`${frozenRoot}gone.md (assume-unchanged)`]);
  assert.throws(() => acceptFrozenRecords(repo, [`${frozenRoot}x.md`], "why"), (error: unknown) => (error as { code?: string }).code === "frozen_accept_flagged");
});

test("A MERGE carries frozen records with their pinned manifest and passes; one that adds a record without its manifest change is stale at the merge's check (the merge-shaped staged probe NH-A named)", () => {
  const { repo, git, frozenRoot } = frozenRepository("frozen-merge-");
  git("checkout", "-q", "-b", "round");
  writeFileSync(join(repo, frozenRoot, "closed-round.md"), "a closed round's record\n");
  syncFrozenRecords(repo, true);
  git("add", "-A");
  git("commit", "-q", "-m", "records");
  git("checkout", "-q", "-b", "unpinned", "main");
  writeFileSync(join(repo, frozenRoot, "unpinned.md"), "slipped in\n");
  git("add", "-A");
  git("commit", "-q", "-m", "unpinned");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "--no-commit", "round");
  assert.deepEqual(syncFrozenRecords(repo, false), { status: "current", converged: true, changed: [], altered: [] }, "a reviewed addition merges");
  git("commit", "-q", "-m", "merge round");
  git("merge", "-q", "--no-ff", "--no-commit", "unpinned");
  assert.deepEqual(syncFrozenRecords(repo, false).changed, [`${frozenRoot}unpinned.md`], "an unpinned addition is named at the merge");
});

test("the commit and merge hooks judge frozen content by the ONE check over the STAGED tree on every commit (harness check's step, or the same check alone when the engine leg does not run), never by a commit-time list of their own", () => {
  const guard = readFileSync(join(ENGINE_ROOT_FOR_GUARD, "scripts", "commit-guard.ts"), "utf8");
  assert.doesNotMatch(guard, /frozenRecordRoots|frozenRecordManifest|frozenRecordDigests/u, "no second frozen-root rule in the hook");
  assert.match(guard, /syncFrozenRecords\(stagedTree, false\)/u, "the one check, over the staged tree, when harness check does not run");
  assert.match(guard, /index: indexFilePath\(repositoryRoot, "inherited"\)/u, "the staged tree is materialized from the index being committed");
  assert.match(guard, /"harness", "check", "--skip-typecheck"/u, "the staged tree's check runs the frozen-records step");
  const commands = readFileSync(join(ENGINE_ROOT_FOR_GUARD, "src", "workflow", "harness-commands.ts"), "utf8");
  assert.match(commands, /syncFrozenRecords\(trackedTop\(root\), false\)/u, "harness check verifies the pinned content");
  assert.match(commands, /syncFrozenRecords\(trackedTop\(root\), write\)/u, "harness regenerate (sync) writes it");
});
