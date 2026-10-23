/**
 * THE COMMUNITY LABELS AS CODE (github-only §9.2, §10.3): the labels the
 * community surface relies on are declared once in
 * `docs/community/labels.json` — `good first issue` and `help wanted` (the
 * contributor pages link them, and GitHub's `/contribute` page lists them),
 * and the labels Dependabot applies (`dependencies`, `javascript`) — each
 * with its colour and description. Issue forms set no label: a label is
 * written by the projector from a registry, never typed by a form.
 *
 * {@link labelDrift} compares the registry with the repository's labels: a
 * declared label that is missing or differs in colour or description is
 * drift; a label the registry does not declare is listed (`others`), not
 * judged, because other owners write labels too (the tracker's lanes through
 * the projector, the coordination lanes).
 */
import { z } from "zod";

import { schemaId } from "../../kernel/product-identity.ts";
import type { ForgeClient } from "../forge/port.ts";
import { readCommunitySource } from "./sources.ts";

export const LABELS_PATH = "docs/community/labels.json";

const LABEL = z.strictObject({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^[0-9a-f]{6}$/u, "a six-digit lower-case hex colour, as GitHub stores it"),
  description: z.string().max(100),
});
const LABELS = z.strictObject({
  schema: z.literal(schemaId("community-labels", 1)),
  labels: z.array(LABEL).min(1).refine((labels) => new Set(labels.map((label) => label.name.toLowerCase())).size === labels.length, "a label is declared once (GitHub compares names without case)"),
});

export type CommunityLabel = z.infer<typeof LABEL>;

/** The declared labels, validated (`community_source_invalid` otherwise). */
export function readLabels(repositoryRoot: string): readonly CommunityLabel[] {
  return readCommunitySource(repositoryRoot, LABELS_PATH, LABELS).labels;
}

/** The repository's labels (paginated on the forge port). */
export async function liveLabels(client: ForgeClient, owner: string, repository: string, maxPages: number): Promise<readonly CommunityLabel[]> {
  const labels = await client.paginate<{ name: string; color: string; description: string | null }>({ path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels` }, { maxPages, perPage: 100 });
  return Object.freeze(labels.map((label) => Object.freeze({ name: label.name, color: label.color.toLowerCase(), description: label.description ?? "" })));
}

export type LabelDrift = Readonly<{ name: string; kind: "missing" | "color" | "description"; detail: string }>;

/** The drift of `declared` against `live`, and the live labels the registry does not declare. */
export function labelDrift(declared: readonly CommunityLabel[], live: readonly CommunityLabel[]): Readonly<{ drift: readonly LabelDrift[]; others: readonly string[] }> {
  const byName = new Map(live.map((label) => [label.name.toLowerCase(), label]));
  const drift: LabelDrift[] = [];
  for (const label of declared) {
    const found = byName.get(label.name.toLowerCase());
    if (found === undefined) drift.push({ name: label.name, kind: "missing", detail: `create it: colour ${label.color}, "${label.description}"` });
    else {
      if (found.color !== label.color) drift.push({ name: label.name, kind: "color", detail: `colour ${found.color} on GitHub, ${label.color} in the registry` });
      if (found.description !== label.description) drift.push({ name: label.name, kind: "description", detail: `"${found.description}" on GitHub, "${label.description}" in the registry` });
    }
  }
  const declaredNames = new Set(declared.map((label) => label.name.toLowerCase()));
  return Object.freeze({
    drift: Object.freeze(drift.map((entry) => Object.freeze(entry))),
    others: Object.freeze(live.filter((label) => !declaredNames.has(label.name.toLowerCase())).map((label) => label.name).sort()),
  });
}
