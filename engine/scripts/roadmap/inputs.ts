/**
 * THE ROADMAP'S INPUTS — read from their one owner each, validated at the
 * boundary, refused (typed) when malformed. Nothing here substitutes a value:
 * an absent live snapshot is reported as absent, never invented.
 *
 * - tracker items: the tracker's one parser (`readTrackerItems` /
 *   `trackerItems`, engine/src/workflow/failure-owners.ts);
 * - decision records: the decision format's owner
 *   (scripts/verification/tracker-entries.ts) and the shared front-matter
 *   reader;
 * - the claims register (`docs/brand/claims.json`): its owner
 *   (scripts/brand/claims.ts);
 * - the checks snapshot: the floor status document
 *   (`bridlewise-floor-status/v1`, scripts/floor/status.mjs) — only its
 *   `checks[]`;
 * - the live snapshot (`bridlewise-roadmap-live/v1`), written by the
 *   projector's read side at publish.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../src/kernel/errors.ts";
import { parseFrontMatter, readEntries, type TrackerItem } from "../../src/workflow/failure-owners.ts";
import { DECISIONS_DIRECTORY } from "../verification/tracker-entries.ts";
import { ROADMAP_LIVE_SCHEMA, type DecisionRef } from "./types.ts";

/** One check as the floor status snapshot reports it. */
export type CheckResult = Readonly<{ id: string; status: string; headSha: string | null; runUrl: string | null }>;

/** The live snapshot (see specs: S4). */
export type LiveSnapshot = Readonly<{
  generatedAt: string;
  commit: string;
  pulls: readonly Readonly<{
    number: number; url: string; title: string; branch: string; lane: string | null; author: string | null;
    draft: boolean; items: readonly string[]; headSha: string;
    checks: Readonly<{ conclusion: "success" | "failure" | "pending" | "none"; failed: readonly string[]; pending: readonly string[] }>;
  }>[];
  issues: Readonly<Record<string, Readonly<{ number: number; url: string; reactions: Readonly<Record<string, number>> }>>>;
  discussions: Readonly<Record<string, Readonly<{ number: number; url: string; upvotes: number; comments: number }>>>;
}>;

function refuse(message: string): never {
  throw new InputError(message, "roadmap_input_invalid");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, where: string): string => (typeof value === "string" ? value : refuse(`${where} must be a string`));
const optStr = (value: unknown, where: string): string | null => (value === null || value === undefined ? null : str(value, where));
const int = (value: unknown, where: string): number => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : refuse(`${where} must be a non-negative integer`));
const list = (value: unknown, where: string): readonly unknown[] => (Array.isArray(value) ? value : refuse(`${where} must be a list`));

/**
 * The decision records under `root` as the roadmap reads them: id, title,
 * group, status, implementation, author, and the first paragraph after the
 * title (the plain-language why). The format itself is judged by the
 * decision guard; a record the roadmap cannot read is refused here by name.
 */
export function readDecisions(root: string): readonly DecisionRef[] {
  return readEntries(root, DECISIONS_DIRECTORY).map(({ name, text }) => decisionRef(`${DECISIONS_DIRECTORY}/${name}`, text));
}

/** One decision record's roadmap view, from its file text. */
export function decisionRef(path: string, text: string): DecisionRef {
  const parsed = parseFrontMatter(text) ?? refuse(`${path}: no front matter`);
  const field = (name: string): string => parsed.fields.get(name) ?? refuse(`${path}: ${name} is missing`);
  const lines = parsed.body.replace(/^\n+/u, "").split("\n");
  const title = /^# (.+)$/u.exec(lines[0] ?? "")?.[1] ?? refuse(`${path}: the body does not open with a # title`);
  const paragraphs = lines.slice(1).join("\n").split(/\n\s*\n/u).map((p) => p.trim()).filter((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("```"));
  return {
    id: field("id"),
    title,
    group: field("group"),
    status: field("status") as DecisionRef["status"],
    implementation: field("implementation") as DecisionRef["implementation"],
    by: field("by") as DecisionRef["by"],
    why: (paragraphs[0] ?? "").replace(/\s*\n\s*/gu, " "),
    path,
  };
}

/** The `checks[]` of a floor status document (`bridlewise-floor-status/v1`). */
export function readChecks(path: string): readonly CheckResult[] {
  const document: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(document) || document.schemaVersion !== "bridlewise-floor-status/v1") refuse(`${path} is not a bridlewise-floor-status/v1 document`);
  return list(document.checks, `${path}: checks`).map((entry, index) => {
    const where = `${path}: checks[${index}]`;
    if (!isRecord(entry)) refuse(`${where} must be an object`);
    return { id: str(entry.id, `${where}.id`), status: str(entry.status, `${where}.status`), headSha: optStr(entry.headSha, `${where}.headSha`), runUrl: optStr(entry.runUrl, `${where}.runUrl`) };
  });
}

/** A live snapshot, validated whole; a malformed one is refused, never partly used. */
export function readLive(path: string): LiveSnapshot {
  const document: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(document) || document.schema !== ROADMAP_LIVE_SCHEMA) refuse(`${path} is not a ${ROADMAP_LIVE_SCHEMA} document`);
  const conclusions = ["success", "failure", "pending", "none"] as const;
  const pulls = list(document.pulls, `${path}: pulls`).map((entry, index) => {
    const where = `${path}: pulls[${index}]`;
    if (!isRecord(entry) || !isRecord(entry.checks)) refuse(`${where} must be an object with checks`);
    const conclusion = str(entry.checks.conclusion, `${where}.checks.conclusion`);
    if (!(conclusions as readonly string[]).includes(conclusion)) refuse(`${where}.checks.conclusion must be one of ${conclusions.join(", ")}`);
    return {
      number: int(entry.number, `${where}.number`), url: str(entry.url, `${where}.url`), title: str(entry.title, `${where}.title`),
      branch: str(entry.branch, `${where}.branch`), lane: optStr(entry.lane, `${where}.lane`), author: optStr(entry.author, `${where}.author`),
      draft: entry.draft === true, items: list(entry.items, `${where}.items`).map((id, i) => str(id, `${where}.items[${i}]`)),
      headSha: str(entry.headSha, `${where}.headSha`),
      checks: {
        conclusion: conclusion as (typeof conclusions)[number],
        failed: list(entry.checks.failed, `${where}.checks.failed`).map((n, i) => str(n, `${where}.checks.failed[${i}]`)),
        pending: list(entry.checks.pending, `${where}.checks.pending`).map((n, i) => str(n, `${where}.checks.pending[${i}]`)),
      },
    };
  });
  const keyed = <T>(value: unknown, where: string, read: (entry: Record<string, unknown>, at: string) => T): Record<string, T> => {
    if (!isRecord(value)) refuse(`${where} must be an object keyed by item id`);
    return Object.fromEntries(Object.entries(value).map(([id, entry]) => {
      if (!isRecord(entry)) refuse(`${where}.${id} must be an object`);
      return [id, read(entry, `${where}.${id}`)];
    }));
  };
  const issues = keyed(document.issues, `${path}: issues`, (entry, at) => ({
    number: int(entry.number, `${at}.number`), url: str(entry.url, `${at}.url`),
    reactions: isRecord(entry.reactions) ? Object.fromEntries(Object.entries(entry.reactions).map(([k, v]) => [k, int(v, `${at}.reactions.${k}`)])) : refuse(`${at}.reactions must be an object`),
  }));
  const discussions = keyed(document.discussions, `${path}: discussions`, (entry, at) => ({
    number: int(entry.number, `${at}.number`), url: str(entry.url, `${at}.url`), upvotes: int(entry.upvotes, `${at}.upvotes`), comments: int(entry.comments, `${at}.comments`),
  }));
  return { generatedAt: str(document.generatedAt, `${path}: generatedAt`), commit: str(document.commit, `${path}: commit`), pulls, issues, discussions };
}

/** Every link an item makes to something outside the tracker that does not resolve: refused by the roadmap, by name. */
export function unresolvedLinks(root: string, items: readonly TrackerItem[], decisions: readonly DecisionRef[], fileExists: (path: string) => boolean): readonly string[] {
  const decisionIds = new Set(decisions.map((d) => d.id));
  const problems: string[] = [];
  for (const item of items) {
    for (const id of item.decisions) if (!decisionIds.has(id)) problems.push(`${item.id}: decisions names ${id}, which is no decision record`);
    for (const path of item.tests) if (!fileExists(join(root, path))) problems.push(`${item.id}: tests names ${path}, which does not exist`);
  }
  return problems;
}
