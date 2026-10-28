/**
 * THE INTAKE RECORD, LANDED: what a triage command (`/accept`, `/decline`,
 * `/duplicate`) decided becomes a tracker item (`bridlewise-tracker-item/v1`,
 * judged by the tracker's own reader before anything is written) and reaches
 * `main` the way every change does — a pull request through the door. The
 * commit is re-made on the forge by the ONE publisher of commits
 * (`publishBranch`, `../workspace-forge.ts`: a signed twin, Verified), so no
 * second path to GitHub's git objects exists.
 *
 * Nothing here touches the issue: when the record lands, the projector (the
 * one writer of issue state) adopts the issue named by its `gh:` field, and
 * closes it when the record closes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import type { WorktreeGitPort } from "../../git/worktree-port.ts";
import { HarnessError } from "../../kernel/errors.ts";
import { TRACKER_BOARD } from "../../kernel/verification-paths.ts";
import { isTrackerDate, readEntries, syncTrackerBoard, trackerItemSchema, trackerItems } from "../failure-owners.ts";
import { publishBranch, type ForgePullRequest, type ForgeTarget, type WorkspaceForge } from "../workspace-forge.ts";
import type { IntakeRecord } from "./issue-ops.ts";

/** The lane every intake record joins: the public floor's open work. */
const INTAKE_LANE = "floor";

function refuse(code: string, message: string, details: Readonly<Record<string, string | number | boolean>> = {}): never {
  throw new HarnessError(message, code, false, details);
}


/** `text` inside a fence no line of it can close, so a person's Markdown is kept verbatim and never read as links. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The item file's text for `record`, opened (and, closed, closed) on the given `YYYY-MM-DD` dates. */
export function intakeItemText(record: IntakeRecord, dates: Readonly<{ opened: string; closed: string }>): string {
  if (!isTrackerDate(dates.opened) || !isTrackerDate(dates.closed)) refuse("community_record_invalid", "the record's dates must be YYYY-MM-DD");
  const fields: [string, string | null][] = [
    ["schema", trackerItemSchema()],
    // A record, never a site page: its text reaches the site only through the tracker's escaping renderers.
    ["published", "false"],
    ["id", record.id],
    ["type", record.type],
    ["title", record.title],
    ["state", record.state],
    ["resolution", record.state === "closed" ? (record.resolution ?? "completed") : null],
    ["lane", INTAKE_LANE],
    ["milestone", record.milestone],
    ["parent", record.parent],
    ["severity", record.severity],
    ["gh", record.gh],
    ["opened", dates.opened],
    ["closed", record.state === "closed" ? dates.closed : null],
  ];
  const body = record.body.replace(/\s+/gu, " ").trim();
  return `---\n${fields.filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value!}`).join("\n")}\n---\n\n${body}\n`;
}

/** The path of `id`'s item file, repository-relative. */
export function itemPath(id: string): string {
  return `${TRACKER_BOARD.items}/${id}.md`;
}

/**
 * Writes `record`'s item into the checkout at `root` and regenerates the task
 * board from the items: the new item is judged with every other one by the
 * tracker's reader first (`tracker_item_invalid`), and an id that already has
 * a file is `community_record_exists`. Answers the paths written.
 */
export function writeIntakeRecord(root: string, record: IntakeRecord, dates: Readonly<{ opened: string; closed: string }>): readonly string[] {
  const path = itemPath(record.id);
  if (existsSync(join(root, path))) refuse("community_record_exists", `${path} exists: the issue was already triaged`, { id: record.id });
  const text = intakeItemText(record, dates);
  trackerItems([...readEntries(root, TRACKER_BOARD.items), { name: `${record.id}.md`, text }]);
  const written = atomicWriteFile(join(root, path), text);
  if (!written.success) refuse("community_record_write_failed", `Failed to write ${path}: ${written.reason ?? "unknown error"}`);
  const board = syncTrackerBoard(root, true);
  if (!board.converged) refuse("community_record_board_invalid", `the task board cannot take the record: ${board.problems.join("; ")}`);
  return [path, ...board.changed];
}

export type RecordLanding = Readonly<{
  forge: WorkspaceForge;
  /** The checkout of the trunk's tip (the workflow's checkout of `main`), clean. */
  repository: GitRepository;
  git: WorktreeGitPort;
  target: ForgeTarget;
  fetchMs: number;
  /** Who the local commit names before the forge re-makes it (the publisher's bot identity). */
  author: Readonly<{ name: string; email: string }>;
}>;

/** The issue number a record's `gh` field names (`issue-<n>`). */
function issueNumberOf(record: IntakeRecord): string {
  const number = /^issue-([1-9]\d*)$/u.exec(record.gh)?.[1];
  if (number === undefined) refuse("community_record_invalid", `the record's gh field must name an issue (issue-<n>), not ${record.gh}`);
  return number;
}

/** The branch a record's pull request comes from. */
export function recordBranch(id: string): string {
  return `intake/${id.toLowerCase()}`;
}

/**
 * Lands `record` as a pull request: the item and the regenerated board
 * committed on `intake/<id>` from the checkout's HEAD, published as a signed
 * twin, and the pull request opened (or found, on a re-run) and marked ready.
 */
export async function landIntakeRecord(landing: RecordLanding, record: IntakeRecord, dates: Readonly<{ opened: string; closed: string }>, command: string): Promise<ForgePullRequest> {
  const { repository } = landing;
  const status = gitOutput(repository, ["status", "--porcelain", "--untracked-files=normal"]).stdout.toString("utf8");
  if (status.trim().length > 0) refuse("community_checkout_dirty", "the checkout a record lands from must be clean");
  const branch = recordBranch(record.id);
  gitOutput(repository, ["switch", "--create", branch]);
  const paths = writeIntakeRecord(repository.root, record, dates);
  gitOutput(repository, ["add", "--", ...paths]);
  const issue = issueNumberOf(record);
  const message = `tracker: ${record.id} from #${issue} (${command})\n\nThe ${command} command on #${issue} adds this record; when it lands, the\nprojector adopts the issue from the record's gh field.\n`;
  gitOutput(repository, ["commit", "--quiet", "--file=-"], {
    input: Buffer.from(message, "utf8"),
    environment: { GIT_AUTHOR_NAME: landing.author.name, GIT_AUTHOR_EMAIL: landing.author.email, GIT_COMMITTER_NAME: landing.author.name, GIT_COMMITTER_EMAIL: landing.author.email },
  });
  // A record branch is the publisher's alone and is made fresh on every run, so this run left it nowhere
  // (`expectedHead: null`): an earlier run's twin of the same commit is adopted, anything else is refused.
  await publishBranch({ forge: landing.forge, repository, git: landing.git, target: landing.target, branch, expectedHead: null, stackBase: null, fetchMs: landing.fetchMs });
  const title = `tracker: ${record.id} (${command} on #${issue})`;
  const body = `Adds the record **${record.id}** that \`${command}\` decided on #${issue}.\n\nWhen this lands, the projector adopts #${issue} as the record's face${record.state === "closed" ? " and closes it" : ""}. Nothing else changes.\n\n${fenced(readFileSync(join(repository.root, itemPath(record.id)), "utf8").trimEnd())}\n`;
  const pull = (await landing.forge.findPullRequest(branch)) ?? (await landing.forge.openDraftPullRequest({ head: branch, base: landing.target.trunk, title, body }));
  if (pull.draft) await landing.forge.markReadyForReview(pull.number);
  return landing.forge.pullRequest(pull.number);
}
