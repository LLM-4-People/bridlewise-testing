/**
 * MODERATION (github-only §10.7): the modes, from ONE source
 * (`docs/community/moderation.json`), and what follows from them.
 *
 * - **Interaction limits** (`interactionLimit.mode`: `off`, `manual` or
 *   `approval`): the spam signal ({@link spamSignal}) counts issues, pull
 *   requests and comments by accounts younger than `newAccountDays` within
 *   `windowHours`; at `threshold` it is raised (reported in `manual`, and
 *   proposed to the maintainer in `approval`). A limit is NEVER applied
 *   automatically, because a wrong limit silences real contributors: the
 *   maintainer applies one with {@link applyInteractionLimit} (it needs the
 *   repository's administration permission, which no App holds).
 * - **Locking** (`lockClosedAfterDays`): {@link lockDue} says when an issue
 *   closed as completed or not planned is due to be locked (reason
 *   `resolved`). The projector, the one writer of issue state, does the
 *   locking.
 * - **Agent replies** (`agentReplySlaHours`): an unanswered human comment on
 *   an agent pull request older than this is a dashboard signal.
 *
 * Pure but for the one maintainer action; no clock is read: the caller states
 * the time the judgement is made at (`asOf`).
 */
import { z } from "zod";

import { InputError } from "../../kernel/errors.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import type { ForgeClient } from "../forge/port.ts";
import { readCommunitySource } from "./sources.ts";

export const MODERATION_PATH = "docs/community/moderation.json";

const MODERATION = z.strictObject({
  schema: z.literal(schemaId("community-moderation", 1)),
  interactionLimit: z.strictObject({
    mode: z.enum(["off", "manual", "approval"]),
    spamSignal: z.strictObject({
      windowHours: z.number().int().positive(),
      newAccountDays: z.number().int().positive(),
      threshold: z.number().int().positive(),
    }),
  }),
  lockClosedAfterDays: z.number().int().positive(),
  agentReplySlaHours: z.number().int().positive(),
});

export type ModerationSettings = z.infer<typeof MODERATION>;

/** The moderation modes, validated (`community_source_invalid` otherwise). */
export function readModeration(repositoryRoot: string): ModerationSettings {
  return readCommunitySource(repositoryRoot, MODERATION_PATH, MODERATION);
}

/** One public interaction, as the audit read it: when it happened and when its author's account was created (ISO times). */
export type Interaction = Readonly<{ kind: "issue" | "pull_request" | "comment"; author: string; at: string; authorCreatedAt: string }>;

export type SpamSignal = Readonly<{
  /** Whether the signal is raised (never in mode `off`). */
  raised: boolean;
  /** What the mode asks for when raised: report it, or propose a limit to the maintainer. */
  action: "none" | "report" | "propose-limit";
  /** Interactions by new accounts within the window. */
  count: number;
  /** Their distinct authors, sorted. */
  authors: readonly string[];
}>;

function epoch(iso: string, what: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new InputError(`${what} is not an ISO time: ${iso}`, "community_moderation_input_invalid");
  return ms;
}

const HOUR = 3_600_000;

/** The spam signal over `interactions` at `asOf` (see the header). */
export function spamSignal(settings: ModerationSettings, interactions: readonly Interaction[], asOf: string): SpamSignal {
  const { mode, spamSignal: rule } = settings.interactionLimit;
  const now = epoch(asOf, "asOf");
  const recent = interactions.filter((interaction) => {
    const at = epoch(interaction.at, "an interaction's time");
    return at <= now && now - at <= rule.windowHours * HOUR && at - epoch(interaction.authorCreatedAt, "an author's creation time") <= rule.newAccountDays * 24 * HOUR;
  });
  const raised = mode !== "off" && recent.length >= rule.threshold;
  return Object.freeze({
    raised,
    action: !raised ? "none" : mode === "approval" ? "propose-limit" : "report",
    count: recent.length,
    authors: Object.freeze([...new Set(recent.map((interaction) => interaction.author))].sort()),
  });
}

/** Whether an issue closed at `closedAt` with `stateReason` is due to be locked at `asOf` (the projector locks it, reason `resolved`). */
export function lockDue(settings: ModerationSettings, issue: Readonly<{ closedAt: string | null; stateReason: string | null; locked: boolean }>, asOf: string): boolean {
  if (issue.locked || issue.closedAt === null || (issue.stateReason !== "completed" && issue.stateReason !== "not_planned")) return false;
  return epoch(asOf, "asOf") - epoch(issue.closedAt, "closedAt") >= settings.lockClosedAfterDays * 24 * HOUR;
}

/** GitHub's interaction-limit levels and expiries (`PUT /repos/{o}/{r}/interaction-limits`). */
export const INTERACTION_LIMITS = Object.freeze(["existing_users", "contributors_only", "collaborators_only"] as const);
export const INTERACTION_EXPIRIES = Object.freeze(["one_day", "three_days", "one_week", "one_month", "six_months"] as const);
export type InteractionLimit = (typeof INTERACTION_LIMITS)[number];
export type InteractionExpiry = (typeof INTERACTION_EXPIRIES)[number];

/**
 * The maintainer's action: apply `limit` for `expiry` to the repository, or
 * remove it (`null`). `client` must run as the maintainer (administration
 * permission); a refusal is the forge's typed error.
 */
export async function applyInteractionLimit(client: ForgeClient, owner: string, repository: string, request: Readonly<{ limit: InteractionLimit; expiry: InteractionExpiry }> | null): Promise<void> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/interaction-limits`;
  if (request === null) {
    await client.rest({ method: "DELETE", path });
    return;
  }
  if (!INTERACTION_LIMITS.includes(request.limit) || !INTERACTION_EXPIRIES.includes(request.expiry)) {
    throw new InputError(`an interaction limit is one of ${INTERACTION_LIMITS.join(", ")} for one of ${INTERACTION_EXPIRIES.join(", ")}`, "community_moderation_input_invalid");
  }
  await client.rest({ method: "PUT", path, body: { limit: request.limit, expiry: request.expiry } });
}
