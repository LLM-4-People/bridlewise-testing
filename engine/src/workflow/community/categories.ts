/**
 * THE DISCUSSION CATEGORIES, AUDITED (github-only §10.5, runbook §U Session 1
 * item 6): the intake registry (`docs/community/intake.json`) declares every
 * category with its live or planned status; GitHub has no API that creates a
 * category, so the maintainer creates them in the UI, and this audit compares
 * the repository's live categories with the registry. It is how a category's
 * `live` receipt is proved, and how a planned one is noticed once it exists.
 *
 * What the API shows, and so what is compared: the slug, the name, whether
 * the category is answerable (format `question-answer`) and its description
 * (the registry's `use`). The other formats (announcement, open-ended, poll)
 * are not exposed by the API and are listed for the maintainer to check.
 */
import type { ForgeClient } from "../forge/port.ts";
import { isLive, type DiscussionCategory } from "./sources.ts";

/** A category as the repository answers it. */
export type LiveCategory = Readonly<{ slug: string; name: string; answerable: boolean; description: string }>;

/** One difference between the registry and the repository, with what to do about it. */
export type CategoryDrift = Readonly<{
  slug: string;
  kind: "missing" | "now-live" | "undeclared" | "name" | "answerable" | "description";
  detail: string;
}>;

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    discussionCategories(first: 50) { nodes { slug name isAnswerable description } }
  }
}`;

/** The repository's live categories (one GraphQL read; GitHub allows at most 25, so one page holds them). */
export async function liveCategories(client: ForgeClient, owner: string, repository: string): Promise<readonly LiveCategory[]> {
  const answer = await client.graphql<{ repository: { discussionCategories: { nodes: readonly { slug: string; name: string; isAnswerable: boolean; description: string | null }[] } } }>(QUERY, { owner, name: repository });
  return Object.freeze(answer.repository.discussionCategories.nodes.map((node) => Object.freeze({ slug: node.slug, name: node.name, answerable: node.isAnswerable, description: node.description ?? "" })));
}

/** Every difference between `declared` (the registry) and `live` (the repository), sorted by slug then kind. */
export function categoryDrift(declared: readonly DiscussionCategory[], live: readonly LiveCategory[]): readonly CategoryDrift[] {
  const drift: CategoryDrift[] = [];
  const bySlug = new Map(live.map((category) => [category.slug, category]));
  for (const category of declared) {
    const found = bySlug.get(category.slug);
    if (found === undefined) {
      if (isLive(category.status)) drift.push({ slug: category.slug, kind: "missing", detail: `declared live but the repository has no ${category.name} category: create it (format ${category.format}, description "${category.use}")` });
      continue;
    }
    if (!isLive(category.status)) drift.push({ slug: category.slug, kind: "now-live", detail: `declared planned, but the repository has it: make its status live, with this audit as the receipt` });
    if (found.name !== category.name) drift.push({ slug: category.slug, kind: "name", detail: `named "${found.name}" on GitHub, "${category.name}" in the registry` });
    if (found.answerable !== (category.format === "question-answer")) drift.push({ slug: category.slug, kind: "answerable", detail: `GitHub says ${found.answerable ? "answerable" : "not answerable"}, the registry's format is ${category.format}` });
    if (found.description !== category.use) drift.push({ slug: category.slug, kind: "description", detail: `GitHub's description "${found.description}" is not the registry's "${category.use}"` });
  }
  const slugs = new Set(declared.map((category) => category.slug));
  for (const category of live) {
    if (!slugs.has(category.slug)) drift.push({ slug: category.slug, kind: "undeclared", detail: `the repository has ${category.name}, which the registry does not declare: declare it, or delete it in the UI` });
  }
  return Object.freeze(drift.sort((left, right) => (left.slug === right.slug ? (left.kind < right.kind ? -1 : 1) : left.slug < right.slug ? -1 : 1)).map((entry) => Object.freeze(entry)));
}
